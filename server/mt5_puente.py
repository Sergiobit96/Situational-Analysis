# Puente entre el servidor (server/mt5.js) y el terminal de MetaTrader 5 de este ordenador.
#
# El paquete MetaTrader5 solo existe para Python en Windows, así que el servidor arranca este
# proceso y le habla por líneas JSON: una petición por línea en stdin, una respuesta por
# línea en stdout, con el mismo `id`. El terminal tiene que estar instalado y con la cuenta
# iniciada (o MT5_LOGIN, MT5_PASSWORD y MT5_SERVER en server/.env).
#
# La hora de las velas de MT5 es la del servidor del bróker escrita como si fuera UTC. En
# MetaQuotes-Demo es la de Europa del Este con el horario de verano europeo (UTC+2 en
# invierno, UTC+3 en verano: comprobado el 19-oct-2026 contra el DAX de contado, también en
# las semanas en que Europa y EE. UU. cambian la hora en fechas distintas). Aquí se pasa a
# UTC de verdad en los dos sentidos, para que el servidor no tenga que saberlo.
import datetime as dt
import json
import os
import sys
from zoneinfo import ZoneInfo

import MetaTrader5 as mt5
import numpy as np

UTC = dt.timezone.utc
ZONA = ZoneInfo(os.environ.get('MT5_ZONA') or 'Europe/Athens')
TERMINAL = os.environ.get('MT5_TERMINAL') or r'C:\Program Files\MetaTrader\terminal64.exe'
TF = {
    'm1': mt5.TIMEFRAME_M1, 'm5': mt5.TIMEFRAME_M5, 'm15': mt5.TIMEFRAME_M15,
    'm30': mt5.TIMEFRAME_M30, 'h1': mt5.TIMEFRAME_H1, 'h4': mt5.TIMEFRAME_H4, 'd1': mt5.TIMEFRAME_D1,
}


def a_servidor(ts):
    """Instante UTC (epoch) → hora del servidor de MT5, como datetime "UTC" para sus funciones."""
    return dt.datetime.fromtimestamp(ts, UTC).astimezone(ZONA).replace(tzinfo=UTC)


def de_servidor(t):
    """Hora de una vela de MT5 → instante UTC (epoch)."""
    return int(dt.datetime.fromtimestamp(int(t), UTC).replace(tzinfo=ZONA).timestamp())


def conectar():
    if mt5.terminal_info() is not None and mt5.account_info() is not None:
        return
    args = {'path': TERMINAL, 'timeout': 60000}
    if os.environ.get('MT5_LOGIN'):
        args.update(login=int(os.environ['MT5_LOGIN']), password=os.environ.get('MT5_PASSWORD', ''),
                    server=os.environ.get('MT5_SERVER', ''))
    if not mt5.initialize(**args):
        raise RuntimeError(f'MetaTrader 5 no arranca: {mt5.last_error()}')


def simbolo_listo(simbolo):
    if not mt5.symbol_select(simbolo, True):
        raise RuntimeError(f'MetaTrader 5 no tiene {simbolo} en esta cuenta')


# Velas mínimas de un día (del servidor) para que cuente, ~15 % de un día normal de 23 h.
# MetaQuotes-Demo tiene una sola vela al día de 2012 a 2015 en todas las temporalidades
# intradía, 24 al día en 2016 (resolución horaria, también en la de 5 min) y una o dos
# sueltas en el hueco del 16-jul al 5-sep-2025. El intradía de verdad empieza en 2017 (2018
# en el Russell, 2019 en el Nikkei, 2022 en el Nasdaq) y la horaria, en 2016.
UMBRAL_DIA = {'m1': 200, 'm5': 40, 'm15': 14, 'm30': 7, 'h1': 8}
DIA = 86400
TRAMO_PREVIA = 120 * DIA     # lo que se mira hacia atrás de cada vez buscando la vela anterior
TRAMOS_PREVIA = 15           # ~5 años: sin un día bueno en ese rato, se da por acabado el histórico


def rango(simbolo, marco, desde, hasta):
    r = mt5.copy_rates_range(simbolo, marco, a_servidor(desde), a_servidor(hasta))
    if r is None:
        raise RuntimeError(f'MetaTrader 5: {mt5.last_error()}')
    return r


# Y días congelados: el feed se quedó parado y repite el mismo precio vela tras vela (el DAX,
# casi entero del 4-oct-2024 al 6-ene-2025, con un 0-2 % de cierres distintos; los índices
# americanos, a ratos en esas fechas; el Nikkei, en 2019-2020). Un día normal pasa del 10 %.
DISTINTOS_MIN = 0.05


def dias_buenos(crudas, tf):
    """Días (del servidor, epoch // 86400 de su hora) con bastantes velas y que no estén
    congelados. El de hoy cuenta siempre, que aún se está haciendo."""
    umbral = UMBRAL_DIA.get(tf)
    if umbral is None or not len(crudas):
        return None
    dias = crudas['time'] // DIA
    unicos, inicios, cuantas = np.unique(dias, return_index=True, return_counts=True)
    buenos = set()
    for d, i, n in zip(unicos.tolist(), inicios.tolist(), cuantas.tolist()):
        if n >= umbral and len(np.unique(crudas['close'][i:i + n])) >= max(5, DISTINTOS_MIN * n):
            buenos.add(d)
    buenos.add(int(a_servidor(dt.datetime.now(UTC).timestamp()).timestamp()) // DIA)
    return buenos


def previa(simbolo, marco, tf, desde):
    """Hora (UTC) de la última vela buena anterior a `desde`, o None si no hay más histórico."""
    fin = desde
    for i in range(TRAMOS_PREVIA):
        # casi siempre está justo detrás: primero una semana, y luego tramos largos
        ini = fin - (7 * DIA if i == 0 else TRAMO_PREVIA)
        # un día más por cada lado, para contar enteros los días en que caen `ini` y `fin`
        crudas = rango(simbolo, marco, ini - DIA, fin + DIA)
        buenos = dias_buenos(crudas, tf)
        for x in crudas[::-1]:
            t = de_servidor(x['time'])
            if t < fin and t >= ini and (buenos is None or int(x['time']) // DIA in buenos):
                return t
        # ¿queda algo más atrás? Sin nada antes de `ini`, MT5 devuelve su primera vela (posterior)
        antes = mt5.copy_rates_from(simbolo, marco, a_servidor(ini - 1), 1)
        if antes is None or not len(antes) or de_servidor(antes[-1]['time']) >= ini:
            return None
        fin = ini
    return None


def pagina(simbolo, tf, desde, hasta):
    """Velas con hora en [desde, hasta) y la hora de la última buena anterior a `desde` (None:
    no hay más): con ella el servidor salta de una vez los huecos de semanas."""
    conectar()
    simbolo_listo(simbolo)
    marco = TF[tf]
    crudas = rango(simbolo, marco, desde - DIA, hasta + DIA)
    buenos = dias_buenos(crudas, tf)
    velas = []
    for x in crudas:
        t = de_servidor(x['time'])
        if desde <= t < hasta and (buenos is None or int(x['time']) // DIA in buenos):
            velas.append({'time': t, 'open': float(x['open']), 'high': float(x['high']),
                          'low': float(x['low']), 'close': float(x['close'])})
    return {'velas': velas, 'previa': previa(simbolo, marco, tf, desde)}


def estado():
    conectar()
    ti, ai = mt5.terminal_info(), mt5.account_info()
    return {'conectado': bool(ti.connected), 'servidor': ai.server, 'cuenta': ai.login,
            'maxBarras': ti.maxbars, 'version': list(mt5.version())}


def main():
    for linea in sys.stdin:
        if not linea.strip():
            continue
        pet = {}
        try:
            pet = json.loads(linea)
            if pet['op'] == 'pagina':
                r = pagina(pet['simbolo'], pet['tf'], int(pet['desde']), int(pet['hasta']))
            elif pet['op'] == 'estado':
                r = estado()
            else:
                raise ValueError(f"Operación desconocida: {pet['op']}")
            sys.stdout.write(json.dumps({'id': pet.get('id'), 'ok': True, **r}) + '\n')
        except Exception as err:  # noqa: BLE001 — cualquier fallo vuelve al servidor como error
            sys.stdout.write(json.dumps({'id': pet.get('id'), 'ok': False, 'error': str(err)}) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
