#!/usr/bin/env python3
"""
ABCD Pattern Scanner — Twelve Data API
Detecta patrones harmónicos ABCD en índices financieros (velas 5min)
con retrocesos de Fibonacci 38.2 / 61.8 / 78.6 % y alertas Telegram.
"""

import os
import time
import logging
import requests
import pandas as pd
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Tuple
from dotenv import load_dotenv
from twelvedata import TDClient

load_dotenv()

# ================================================================
#  CONFIGURACIÓN
# ================================================================

API_KEY            = os.getenv("TWELVEDATA_API_KEY", "")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID   = os.getenv("TELEGRAM_CHAT_ID", "")

SYMBOLS: Dict[str, str] = {
    "SPX":  "S&P 500",
    "NDX":  "Nasdaq 100",
    "DJI":  "Dow Jones",
    "DAX":  "DAX 40",
}

INTERVAL         = "5min"
CANDLES_TO_FETCH = 50
PIVOT_LOOKBACK   = 5      # velas a cada lado para confirmar pivote

# Niveles Fibonacci válidos para el retroceso B→C (con tolerancia ±2 %)
FIB_LEVELS: List[Tuple[float, str]] = [
    (0.382, "38.2%"),
    (0.618, "61.8%"),
    (0.786, "78.6%"),
]
FIB_TOLERANCE      = 0.02   # ±2 % sobre el ratio
C_PROXIMITY        = 0.005  # 0.5 % para "precio cerca de C"
ALERT_COOLDOWN_MIN = 15     # minutos entre alertas repetidas del mismo patrón

# ================================================================
#  LOGGING
# ================================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("abcd_scanner.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger(__name__)


# ================================================================
#  1. OBTENCIÓN DE DATOS
# ================================================================

def get_data(symbol: str, td: TDClient) -> Optional[pd.DataFrame]:
    """
    Descarga las últimas CANDLES_TO_FETCH velas de 5min para symbol.
    Devuelve DataFrame (open/high/low/close/volume) ordenado de más
    antigua (fila 0) a más reciente (fila -1). Retorna None si falla.
    """
    try:
        ts = td.time_series(
            symbol=symbol,
            interval=INTERVAL,
            outputsize=CANDLES_TO_FETCH,
            timezone="America/New_York",
        )
        df: pd.DataFrame = ts.as_pandas()

        if df is None or df.empty:
            logger.warning("[%s] La API no devolvió datos.", symbol)
            return None

        df = df[["open", "high", "low", "close", "volume"]].astype(float)
        df.index = pd.to_datetime(df.index)
        df.sort_index(inplace=True)

        logger.info("[%s] %d velas (última: %s  close: %.2f)",
                    symbol, len(df),
                    df.index[-1].strftime("%H:%M"),
                    df["close"].iloc[-1])
        return df

    except Exception as exc:
        logger.error("[%s] Error al obtener datos: %s", symbol, exc)
        return None


# ================================================================
#  2. DETECCIÓN DE PIVOTES (ZigZag simétrico)
# ================================================================

def find_pivots(df: pd.DataFrame, lookback: int = PIVOT_LOOKBACK) -> List[Dict]:
    """
    Identifica máximos (H) y mínimos (L) locales.
    Condición H en i: high[i] > todos los high en [i-n, i) y (i, i+n]
    Condición L en i: low[i]  < todos los low  en [i-n, i) y (i, i+n]
    Aplica deduplicación: si dos pivotes del mismo tipo son consecutivos
    conserva sólo el más extremo.
    """
    highs  = df["high"].values
    lows   = df["low"].values
    raw: List[Dict] = []

    for i in range(lookback, len(df) - lookback):
        lh, rh = highs[i - lookback:i], highs[i + 1:i + lookback + 1]
        ll, rl = lows[i - lookback:i],  lows[i + 1:i + lookback + 1]

        if highs[i] > max(lh) and highs[i] > max(rh):
            raw.append({"index": i, "price": highs[i],
                        "type": "H", "datetime": df.index[i]})
        if lows[i] < min(ll) and lows[i] < min(rl):
            raw.append({"index": i, "price": lows[i],
                        "type": "L", "datetime": df.index[i]})

    raw.sort(key=lambda x: x["index"])

    # Deduplica: mismos tipos consecutivos → queda el más extremo
    pivots: List[Dict] = []
    for p in raw:
        if not pivots or pivots[-1]["type"] != p["type"]:
            pivots.append(p)
        else:
            prev = pivots[-1]
            if (p["type"] == "H" and p["price"] > prev["price"]) or \
               (p["type"] == "L" and p["price"] < prev["price"]):
                pivots[-1] = p

    return pivots


# ================================================================
#  3. VALIDACIÓN FIBONACCI
# ================================================================

def classify_fib(a: float, b: float, c: float) -> Optional[Tuple[float, str]]:
    """
    Determina si el retroceso B→C corresponde a algún nivel Fibonacci
    definido en FIB_LEVELS (tolerancia ±FIB_TOLERANCE).
    Devuelve (ratio, etiqueta) del primer nivel coincidente, o None.
    """
    ab = abs(b - a)
    if ab == 0:
        return None
    ratio = abs(b - c) / ab
    for level, label in FIB_LEVELS:
        if abs(ratio - level) <= FIB_TOLERANCE:
            return (ratio, label)
    return None


# ================================================================
#  4. DETECCIÓN ABCD
# ================================================================

def detect_abcd(df: pd.DataFrame, symbol: str, name: str) -> List[Dict]:
    """
    Escanea los pivotes más recientes en busca de patrones ABCD.

    ALCISTA  (L → H → L):
        A = mínimo local
        B = máximo local, B > A
        C = mínimo local, C > A
        Retroceso AB→C en niveles Fib 38.2 / 61.8 / 78.6 % (±2 %)
        Alerta: precio cerca de C (rebote) o por encima de B (ruptura)

    BAJISTA  (H → L → H):
        A = máximo local
        B = mínimo local, B < A
        C = máximo local, C < A
        Retroceso AB→C en niveles Fib 38.2 / 61.8 / 78.6 % (±2 %)
        Alerta: precio cerca de C (rechazo) o por debajo de B (ruptura)

    Proyección D (objetivo): D = C ± (B − A)  →  CD ≈ AB
    """
    alerts: List[Dict] = []
    pivots = find_pivots(df)

    if len(pivots) < 3:
        logger.debug("[%s] Pivotes insuficientes (%d).", symbol, len(pivots))
        return alerts

    current_price = float(df["close"].iloc[-1])
    current_dt    = df.index[-1]

    # Iteramos todos los tripletes pero sólo generamos alerta en el último
    for i in range(len(pivots) - 2):
        pt_a = pivots[i]
        pt_b = pivots[i + 1]
        pt_c = pivots[i + 2]
        is_latest = (i == len(pivots) - 3)

        # ── ALCISTA  L → H → L ──────────────────────────────────
        if (
            pt_a["type"] == "L"
            and pt_b["type"] == "H"
            and pt_c["type"] == "L"
            and pt_b["price"] > pt_a["price"]
            and pt_c["price"] > pt_a["price"]
        ):
            fib_hit = classify_fib(pt_a["price"], pt_b["price"], pt_c["price"])
            if fib_hit and is_latest:
                ab        = pt_b["price"] - pt_a["price"]
                d_target  = round(pt_c["price"] + ab, 4)
                stop_loss = round(pt_c["price"] * (1 - 0.005), 4)
                near_c    = abs(current_price - pt_c["price"]) / pt_c["price"] <= C_PROXIMITY
                broke_b   = current_price > pt_b["price"]

                if near_c or broke_b:
                    alerts.append(_build_alert(
                        symbol, name, "ABCD Alcista",
                        "Rebote en zona C" if near_c else "Ruptura de máximo B",
                        current_price, stop_loss, d_target,
                        fib_hit, pt_a, pt_b, pt_c, current_dt,
                    ))

        # ── BAJISTA  H → L → H ──────────────────────────────────
        elif (
            pt_a["type"] == "H"
            and pt_b["type"] == "L"
            and pt_c["type"] == "H"
            and pt_b["price"] < pt_a["price"]
            and pt_c["price"] < pt_a["price"]
        ):
            fib_hit = classify_fib(pt_a["price"], pt_b["price"], pt_c["price"])
            if fib_hit and is_latest:
                ab        = pt_a["price"] - pt_b["price"]
                d_target  = round(pt_c["price"] - ab, 4)
                stop_loss = round(pt_c["price"] * (1 + 0.005), 4)
                near_c    = abs(current_price - pt_c["price"]) / pt_c["price"] <= C_PROXIMITY
                broke_b   = current_price < pt_b["price"]

                if near_c or broke_b:
                    alerts.append(_build_alert(
                        symbol, name, "ABCD Bajista",
                        "Rechazo en zona C" if near_c else "Ruptura de mínimo B",
                        current_price, stop_loss, d_target,
                        fib_hit, pt_a, pt_b, pt_c, current_dt,
                    ))

    return alerts


def _build_alert(
    symbol: str, name: str, pattern: str, trigger: str,
    entry: float, stop_loss: float, target_d: float,
    fib_hit: Tuple[float, str],
    pt_a: Dict, pt_b: Dict, pt_c: Dict,
    dt: pd.Timestamp,
) -> Dict:
    return {
        "symbol":    symbol,
        "name":      name,
        "pattern":   pattern,
        "trigger":   trigger,
        "entry":     entry,
        "stop_loss": stop_loss,
        "target_d":  target_d,
        "fib_ratio": fib_hit[0],
        "fib_label": fib_hit[1],
        "point_a":   pt_a,
        "point_b":   pt_b,
        "point_c":   pt_c,
        "datetime":  dt,
    }


# ================================================================
#  5. ALERTAS TELEGRAM
# ================================================================

def send_telegram_alert(alert: Dict) -> bool:
    """
    Envía mensaje Markdown formateado al chat de Telegram configurado.
    Incluye entrada, stop loss, objetivo D y ratio R:R calculado.
    """
    is_bull   = "Alcista" in alert["pattern"]
    flag      = "🟢" if is_bull else "🔴"
    direction = "📈 COMPRA" if is_bull else "📉 VENTA"

    pnl_pct  = abs(alert["target_d"] - alert["entry"]) / alert["entry"] * 100
    rr_sl    = abs(alert["entry"]   - alert["stop_loss"])
    rr_tp    = abs(alert["target_d"] - alert["entry"])
    rr_ratio = f"{rr_tp / rr_sl:.1f}:1" if rr_sl > 0 else "N/A"

    a, b, c  = alert["point_a"], alert["point_b"], alert["point_c"]

    message = (
        f"{flag} *PATRÓN ABCD DETECTADO* {flag}\n"
        f"━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        f"📊 *Índice:*   {alert['name']} `({alert['symbol']})`\n"
        f"🔍 *Patrón:*   {alert['pattern']}\n"
        f"⚡ *Señal:*    {alert['trigger']}\n"
        f"📐 *Fib C:*    {alert['fib_label']}  "
        f"(ratio real: {alert['fib_ratio']:.3f})\n"
        f"━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        f"{direction}\n"
        f"🎯 *Entrada:*     `{alert['entry']:.2f}`\n"
        f"🛑 *Stop Loss:*  `{alert['stop_loss']:.2f}`\n"
        f"🏆 *Objetivo D:*  `{alert['target_d']:.2f}` "
        f"(+{pnl_pct:.1f}%)\n"
        f"⚖️ *Ratio R:R:*   {rr_ratio}\n"
        f"━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        f"📍 *Estructura:*\n"
        f"  A → `{a['price']:.2f}`  ({a['datetime'].strftime('%H:%M')})\n"
        f"  B → `{b['price']:.2f}`  ({b['datetime'].strftime('%H:%M')})\n"
        f"  C → `{c['price']:.2f}`  ({c['datetime'].strftime('%H:%M')})\n"
        f"  D → `{alert['target_d']:.2f}`  (proyección)\n"
        f"━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        f"🕐 {alert['datetime'].strftime('%Y-%m-%d %H:%M')} ET"
    )

    url     = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {"chat_id": TELEGRAM_CHAT_ID, "text": message, "parse_mode": "Markdown"}

    try:
        resp = requests.post(url, json=payload, timeout=10)
        resp.raise_for_status()
        logger.info("[TELEGRAM] ✓ %s  %s", alert["symbol"], alert["pattern"])
        return True
    except requests.exceptions.Timeout:
        logger.error("[TELEGRAM] Timeout.")
    except requests.exceptions.HTTPError as exc:
        logger.error("[TELEGRAM] HTTP %s: %s", exc.response.status_code, exc)
    except requests.exceptions.RequestException as exc:
        logger.error("[TELEGRAM] Conexión: %s", exc)
    return False


# ================================================================
#  UTILIDADES
# ================================================================

def seconds_until_next_5min() -> float:
    """Segundos hasta el siguiente múltiplo de 5 minutos en el reloj."""
    now       = datetime.now()
    next_mark = now.replace(second=0, microsecond=0) + timedelta(
        minutes=(5 - now.minute % 5) % 5 or 5
    )
    return max((next_mark - now).total_seconds(), 1.0)


class AlertDeduplicator:
    """
    Suprime alertas idénticas (symbol + pattern + trigger) dentro de
    una ventana de cooldown para evitar spam en Telegram.
    """

    def __init__(self, cooldown_minutes: int = ALERT_COOLDOWN_MIN):
        self._seen: Dict[str, datetime] = {}
        self._ttl  = timedelta(minutes=cooldown_minutes)

    def is_new(self, alert: Dict) -> bool:
        key  = f"{alert['symbol']}|{alert['pattern']}|{alert['trigger']}"
        last = self._seen.get(key)
        if last and (datetime.now() - last) < self._ttl:
            return False
        self._seen[key] = datetime.now()
        return True


# ================================================================
#  MAIN LOOP
# ================================================================

def main() -> None:
    logger.info("=" * 62)
    logger.info("  ABCD Scanner  |  Twelve Data  |  5-min  |  Fib 38/61/78")
    logger.info("=" * 62)

    td         = TDClient(apikey=API_KEY)
    dedup      = AlertDeduplicator()
    scan_count = 0

    logger.info("Símbolos: %s", ", ".join(SYMBOLS.keys()))
    logger.info("Niveles Fib activos: %s", ", ".join(l for _, l in FIB_LEVELS))
    logger.info("Esperando al próximo cierre de vela de 5min...")

    while True:
        # ── Dormir hasta el siguiente múltiplo de 5 minutos ──────
        wait = seconds_until_next_5min()
        next_time = (datetime.now() + timedelta(seconds=wait)).strftime("%H:%M:%S")
        logger.info("Próximo escaneo en %.0fs  →  %s", wait, next_time)
        time.sleep(wait)

        scan_count += 1
        t0 = datetime.now()
        logger.info("─── Escaneo #%d  [%s] ─────────────────────────────────",
                    scan_count, t0.strftime("%H:%M:%S"))

        for symbol, name in SYMBOLS.items():
            try:
                df = get_data(symbol, td)
                if df is None:
                    continue

                min_candles = PIVOT_LOOKBACK * 2 + 5
                if len(df) < min_candles:
                    logger.warning("[%s] Solo %d velas (mínimo %d).",
                                   symbol, len(df), min_candles)
                    continue

                alerts = detect_abcd(df, symbol, name)

                if not alerts:
                    logger.info("[%s] Sin patrón ABCD activo.", symbol)
                else:
                    for alert in alerts:
                        logger.info(
                            "[%s] %s  |  Fib %s  |  Entrada %.2f  "
                            "SL %.2f  Target %.2f",
                            symbol, alert["pattern"], alert["fib_label"],
                            alert["entry"], alert["stop_loss"], alert["target_d"],
                        )
                        if dedup.is_new(alert):
                            send_telegram_alert(alert)
                        else:
                            logger.debug("[%s] Alerta en cooldown, omitida.", symbol)

            except KeyboardInterrupt:
                raise
            except Exception as exc:
                logger.error("[%s] Error inesperado: %s", symbol, exc, exc_info=True)

            time.sleep(1.2)   # respeta el rate-limit de la API (8 req/min free)

        elapsed = (datetime.now() - t0).total_seconds()
        logger.info("─── Completado en %.1fs ──────────────────────────────────",
                    elapsed)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        logger.info("Scanner detenido por el usuario (Ctrl+C).")
