import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { getHistoricalRates } from 'dukascopy-node'
import { instalarTransporteDukascopy, estadoTransporteDukascopy } from './dukascopy-transport.js'
import { getEventIndex, getEventosEnFecha } from './eventos.js'
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, copyFileSync } from 'fs'
import { join, dirname, relative, resolve, sep, basename, extname } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import PptxGenJS from 'pptxgenjs'
import multer from 'multer'
import { GoogleAuth } from 'google-auth-library'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Debe ejecutarse antes de la primera descarga: elige HTTPS o HTTP para el datafeed
// según lo que deje pasar la red (ver server/dukascopy-transport.js)
instalarTransporteDukascopy()

// Cache en disco para datos Dukascopy (usa /tmp en producción, local en dev)
const DISK_CACHE_DIR = process.env.NODE_ENV === 'production'
  ? '/tmp/.duka-cache'
  : join(__dirname, '.duka-cache')
try { mkdirSync(DISK_CACHE_DIR, { recursive: true }) } catch { /* non-critical */ }

// Caché de los .bi5 tal cual los sirve Dukascopy. Es distinta de la de velas ya
// parseadas: un mismo fichero de día (BID_candles_min_1.bi5) es el origen de m1, m5,
// m15 y m30 —la librería agrega en local—, así que guardarlo evita bajar cuatro veces
// lo mismo. Y como el histórico es inmutable, un día descargado ya no vuelve a pedirse
// nunca: es lo que permite que las fechas antiguas dejen de depender del feed.
const DUKA_RAW_CACHE_DIR = join(DISK_CACHE_DIR, 'bi5')
try { mkdirSync(DUKA_RAW_CACHE_DIR, { recursive: true }) } catch { /* non-critical */ }

function diskCacheGet(key) {
  const file = join(DISK_CACHE_DIR, key.replace(/[^a-z0-9_-]/gi, '_') + '.json')
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}
function diskCacheSet(key, data) {
  const file = join(DISK_CACHE_DIR, key.replace(/[^a-z0-9_-]/gi, '_') + '.json')
  try { writeFileSync(file, JSON.stringify(data)) } catch { /* no crítico */ }
}

// Tickers para velas 15m
const YF_TO_DUKASCOPY = {
  '^GSPC':  'usa500idxusd',
  '^NDX':   'usatechidxusd',
  '^DJI':   'usa30idxusd',
  '^GDAXI': 'deuidxeur',
  '^FTSE':  'gbridxgbp',
  '^RUT':   'ussc2000idxusd',
  '^N225':  'jpnidxjpy',
  'XAUUSD': 'xauusd',
  'XAGUSD': 'xagusd',
  'USOIL':  'usoususd',
}

// Yahoo Finance bloquea IPs de datacenter → usar Dukascopy M30 para todos los instrumentos
const DUKASCOPY_DAILY = {
  '^FTSE':  'gbridxgbp',
  '^GDAXI': 'deuidxeur',
  '^GSPC':  'usa500idxusd',
  '^NDX':   'usatechidxusd',
  '^DJI':   'usa30idxusd',
  '^RUT':   'ussc2000idxusd',
  '^N225':  'jpnidxjpy',
  'XAUUSD': 'xauusd',
  'XAGUSD': 'xagusd',
  'USOIL':  'usoususd',
}

// Horas de sesión regular en minutos Londres por instrumento Dukascopy
// Con M30: open = primer bar en sessionOpen, close = bar que termina en sessionClose
const DUKA_SESSION_LONDON = {
  'gbridxgbp':     [8*60,      16*60+30],  // FTSE   08:00–16:30 Londres
  'deuidxeur':     [8*60,      16*60+30],  // DAX    08:00–16:30 Londres
  'usa500idxusd':  [14*60+30,  21*60],     // S&P    14:30–21:00 Londres
  'usatechidxusd': [14*60+30,  21*60],     // Nasdaq 14:30–21:00 Londres
  'usa30idxusd':   [14*60+30,  21*60],     // DJ     14:30–21:00 Londres
  'ussc2000idxusd':[14*60+30,  21*60],     // Russell 2000 14:30–21:00 Londres
  'jpnidxjpy':      [0,        7*60],      // Nikkei 225 09:00–15:00 JST ≈ 00:00–07:00 Londres (Japón no cambia de horario, rango ampliado para cubrir GMT/BST)
  'xauusd':        [0,         23*60+30],  // Oro    día completo
  'xagusd':        [0,         23*60+30],  // Plata  día completo
  'usoususd':      [0,         23*60+30],  // Petróleo día completo
}

const app  = express()
const PORT = process.env.PORT || 3001
app.use(cors())
// Límite ampliado: /api/export-ppt recibe un PNG en base64 por cada coincidencia exportada
app.use(express.json({ limit: '50mb' }))

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }))

const YF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
const YF_HEADERS = {
  'User-Agent':      YF_UA,
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://finance.yahoo.com/',
}

// ── Stooq: fuente principal para acciones individuales (no bloquea Railway) ──

// Convierte ticker Yahoo → ticker Stooq
function toStooqTicker(yahooTicker) {
  if (yahooTicker.endsWith('.DE')) return yahooTicker
  if (yahooTicker.endsWith('.L'))  return yahooTicker.slice(0, -2) + '.UK'
  if (yahooTicker.startsWith('^')) return yahooTicker
  if (!yahooTicker.includes('.'))  return yahooTicker + '.US'
  return yahooTicker
}

// Datos diarios para gap filter (CSV Stooq: Date,Open,High,Low,Close,Volume)
async function obtenerVelasDiariasStooq(ticker) {
  const cached = fromCache(`stooq1d_${ticker}`)
  if (cached) return cached

  const stooqTicker = toStooqTicker(ticker)
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqTicker)}&i=d`
  console.log(`[Stooq] Descargando diarios ${stooqTicker}…`)
  const resp = await fetch(url, { headers: { 'User-Agent': YF_UA } })
  if (!resp.ok) throw new Error(`Stooq HTTP ${resp.status} para ${stooqTicker}`)
  const text = await resp.text()

  const lines = text.trim().split('\n').slice(1)  // omitir cabecera
  const velas = []
  for (const line of lines) {
    const [date, open, high, low, close] = line.split(',')
    if (!date || !open || isNaN(parseFloat(open))) continue
    velas.push({
      time:  Math.floor(new Date(date + 'T12:00:00Z').getTime() / 1000),
      open:  parseFloat(open),
      high:  parseFloat(high),
      low:   parseFloat(low),
      close: parseFloat(close),
    })
  }
  // Stooq devuelve descendente → ordenar ascendente
  velas.sort((a, b) => a.time - b.time)

  if (velas.length === 0) throw new Error(`Sin datos en Stooq para ${stooqTicker}`)
  toCache(`stooq1d_${ticker}`, velas, 4 * 60 * 60_000)
  console.log(`[Stooq] ${stooqTicker}: ${velas.length} días`)
  return velas
}

// Barras intraday de un día (intenta varios intervalos: 5m → 60m → barra diaria)
// Stooq tiene cobertura intraday excelente para US, buena para DE, limitada para UK
async function obtenerVelasIntradayStooq(ticker, date) {
  const stooqTicker = toStooqTicker(ticker)
  const d           = date.replace(/-/g, '')

  // Parsea CSV intraday (Date,Time,Open,High,Low,Close,Volume)
  async function fetchIntraday(interval) {
    const cacheKey = `stooq${interval}_${ticker}_${date}`
    const cached = fromCache(cacheKey)
    if (cached) return cached

    const url  = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqTicker)}&d1=${d}&d2=${d}&i=${interval}`
    const resp = await fetch(url, { headers: { 'User-Agent': YF_UA } })
    if (!resp.ok) throw new Error(`Stooq HTTP ${resp.status}`)
    const text = await resp.text()

    const velas = []
    for (const line of text.trim().split('\n').slice(1)) {
      const parts = line.split(',')
      if (parts.length < 6) continue
      const [csvDate, time, open, high, low, close, volume = '0'] = parts
      if (!csvDate || !time || isNaN(parseFloat(open))) continue
      velas.push({
        time:   Math.floor(new Date(`${csvDate}T${time}Z`).getTime() / 1000),
        open:   parseFloat(open),
        high:   parseFloat(high),
        low:    parseFloat(low),
        close:  parseFloat(close),
        volume: parseInt(volume) || 0,
      })
    }
    velas.sort((a, b) => a.time - b.time)
    if (velas.length > 0) toCache(cacheKey, velas, 6 * 60 * 60_000)
    return velas
  }

  // 1. Intenta 5-min
  console.log(`[Stooq] Descargando intraday 5m ${stooqTicker} ${date}…`)
  const v5 = await fetchIntraday(5)
  if (v5.length > 0) return { velas: v5, fuente: 'Stooq 5m' }

  // 2. Intenta 60-min (algunos mercados no publican 5m pero sí H1)
  console.log(`[Stooq] 5m vacío, intentando 60m para ${stooqTicker}…`)
  const v60 = await fetchIntraday(60)
  if (v60.length > 0) return { velas: v60, fuente: 'Stooq 1h' }

  // 3. Fallback: barra diaria como único candlestick del día
  console.log(`[Stooq] Sin intraday para ${stooqTicker}, usando barra diaria…`)
  const diarias = await obtenerVelasDiariasStooq(ticker)
  const barra   = diarias.find(v => {
    const d = new Date(v.time * 1000).toISOString().slice(0, 10)
    return d === date
  })
  if (barra) return { velas: [barra], fuente: 'Stooq 1d' }

  throw new Error(`Sin datos en Stooq para ${stooqTicker} en ${date}`)
}

// ── Yahoo Finance: crumb auth (necesario desde 2024 para evitar bloqueo) ────
let _yfAuth = null, _yfAuthTs = 0
async function getYFAuth() {
  if (_yfAuth && Date.now() - _yfAuthTs < 3_600_000) return _yfAuth
  try {
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': YF_UA },
      redirect: 'follow',
    })
    const raw    = r1.headers.get('set-cookie') ?? ''
    const cookie = raw.split(',').map(c => c.split(';')[0].trim()).filter(Boolean).join('; ')

    const r2    = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': YF_UA, 'Cookie': cookie },
    })
    const crumb = (await r2.text()).trim()
    if (crumb && crumb.length < 60 && !crumb.startsWith('<')) {
      _yfAuth  = { cookie, crumb }
      _yfAuthTs = Date.now()
      console.log('[YF] crumb ok:', crumb.slice(0, 8) + '…')
    }
  } catch (e) {
    console.error('[YF crumb]', e.message)
  }
  return _yfAuth
}

// ── Cache ─────────────────────────────────────────────────────────────────
const cache     = new Map()
const CACHE_TTL = 15 * 60_000

function fromCache(key) {
  const c = cache.get(key)
  return c && Date.now() - c.ts < (c.ttl ?? CACHE_TTL) ? c.data : null
}
function toCache(key, data, ttl = CACHE_TTL) {
  cache.set(key, { ts: Date.now(), data, ttl })
}

// fetch() de Node solo da "fetch failed"; la causa real (ECONNRESET, ETIMEDOUT…) va en err.cause
const errDetalle = err => err.cause?.code ?? err.cause?.message ?? err.message

// dukascopy-node descarga en tandas de 10 conexiones en paralelo con ~10s de connect-timeout
// cada una; sin límite propio, una caída del feed encadena tanda tras tanda y la petición
// se queda "colgada" varios minutos antes de fallar. Cortamos a los 10s (una sola tanda) para
// que el fallback (Yahoo Finance / disco) entre en juego enseguida en vez de hacer esperar.
// Margen para una consulta de un día: la descarga en sí va en segundos, pero si el feed
// responde 429 el transporte espera y reintenta antes de darla por perdida.
const DUKA_TIMEOUT_MS = 30_000

// Las descargas de histórico largo (años de H1/D1) son decenas de ficheros y no caben en
// el presupuesto de una consulta de un solo día, así que llevan el suyo propio.
const DUKA_TIMEOUT_HISTORICO_MS = 3 * 60_000

// Por defecto dukascopy-node no reintenta (retryCount: 0) y descarga en tandas de 10
// conexiones: con el feed limitando peticiones eso se traduce en ficheros vacíos y, por
// tanto, en velas que faltan sin ningún error. Tandas más cortas y reintentos con pausa
// reducen el throttling, y failAfterRetryCount hace que un fallo persistente lance error
// en vez de devolver un hueco silencioso.
const DUKA_OPCIONES_DESCARGA = {
  batchSize:             5,
  pauseBetweenBatchesMs: 1_500,
  retryCount:            2,
  pauseBetweenRetriesMs: 1_000,
  failAfterRetryCount:   true,
}

// Un histórico largo son decenas de ficheros seguidos, y ahí el feed corta con 429 mucho
// antes que con la consulta de un solo día. Menos conexiones en paralelo y más pausa:
// tarda más, pero llega hasta el final en vez de volver a medias.
const DUKA_OPCIONES_HISTORICO = {
  ...DUKA_OPCIONES_DESCARGA,
  batchSize:             2,
  pauseBetweenBatchesMs: 3_000,
}

function dukaFetch(params, timeoutMs = DUKA_TIMEOUT_MS, opciones = DUKA_OPCIONES_DESCARGA) {
  let temporizador
  return Promise.race([
    getHistoricalRates({ ...opciones, ...params }),
    new Promise((_, reject) => {
      temporizador = setTimeout(
        () => reject(new Error(`Dukascopy: sin respuesta en ${timeoutMs / 1000}s`)),
        timeoutMs
      )
    }),
  ]).finally(() => clearTimeout(temporizador))
}

// Circuito de corte: en redes donde datafeed.dukascopy.com no es accesible (bloqueo de
// ISP, habitual en local) cada peticion gastaba los 10 s de DUKA_TIMEOUT_MS antes de
// rendirse, y el multi-chart son 10 s por instrumento. Tras un fallo de conexion se marca
// la fuente como caida unos minutos y se salta directo al fallback intradia de Yahoo.
const DUKA_CIRCUITO_MS = 5 * 60_000
let dukaCaidaTs = 0
const dukaCaido = () => Date.now() - dukaCaidaTs < DUKA_CIRCUITO_MS
function marcarDukaCaido(err) {
  dukaCaidaTs = Date.now()
  console.warn(`[Dukascopy] inaccesible (${errDetalle(err)}) -> fallback intradia durante ${DUKA_CIRCUITO_MS / 60_000} min`)
}

// Timezone helpers
const getMadridDate = ts =>
  new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' })

const getMadridDay = ts => {
  const dow = new Date(
    new Date(ts * 1000).toLocaleString('en-US', { timeZone: 'Europe/Madrid' })
  ).getDay()
  return dow === 0 ? 7 : dow   // 1=lun … 5=vie, 7=dom
}

// Helpers para timezone Londres (maneja GMT/BST automáticamente)
function getLondonMinutes(tsMs) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/London', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date(tsMs))
  const h = parseInt(parts.find(p => p.type === 'hour').value,  10)
  const m = parseInt(parts.find(p => p.type === 'minute').value, 10)
  return h * 60 + m
}
function getLondonDateStr(tsMs) {
  return new Date(tsMs).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
}

// ── Dukascopy M30 → barras diarias con open/close preciso de sesión ──────────
// Con M30 cada barra es exactamente de 30 min → el open/close de sesión cae
// en el límite exacto de barra (ej. FTSE cierra 16:30 → último bar 16:00–16:30)
// Primera descarga ~30 s para 5 años; queda en caché 4 h
// H1 ofrece open exacto de sesión; el close es el cierre de la última barra H1
// (para FTSE/DAX el cierre oficial 16:30 cae dentro de la barra 16:00–17:00 → diferencia mínima)
function agregarVelasH1ADiarias(bars, sessionOpenMin, sessionCloseMin) {
  const dayMap = new Map()
  for (const [ts, open, high, low, close] of bars) {
    const lm = getLondonMinutes(ts)
    if (lm < sessionOpenMin || lm >= sessionCloseMin) continue
    const date = getLondonDateStr(ts)
    if (!dayMap.has(date)) {
      dayMap.set(date, { time: Math.floor(ts / 1000), open, high, low, close })
    } else {
      const d = dayMap.get(date)
      d.high  = Math.max(d.high, high)
      d.low   = Math.min(d.low, low)
      d.close = close
    }
  }
  return [...dayMap.values()].filter(v => v.open && v.close)
}

// ── Yahoo Finance: fallback diario cuando Dukascopy no responde ──────────
// Solo se usa si la petición a Dukascopy falla. Para materias primas se usa
// el futuro correspondiente (GC=F, SI=F, CL=F) ya que Yahoo no publica los
// tickers spot XAUUSD/XAGUSD/USOIL; el precio difiere unos puntos del CFD
// de Dukascopy pero sirve para no dejar la caché completamente congelada.
const DUKA_TO_YF_FALLBACK = {
  'usa500idxusd':   '^GSPC',
  'usatechidxusd':  '^NDX',
  'usa30idxusd':    '^DJI',
  'deuidxeur':      '^GDAXI',
  'gbridxgbp':      '^FTSE',
  'ussc2000idxusd': '^RUT',
  'jpnidxjpy':      '^N225',
  'xauusd':         'GC=F',
  'xagusd':         'SI=F',
  'usoususd':       'CL=F',
}

async function obtenerVelasDiariasYF(yfTicker, from) {
  const auth  = await getYFAuth()
  const p1    = Math.floor(from.getTime() / 1000)
  const sym   = encodeURIComponent(yfTicker)
  const crumb = auth ? `&crumb=${encodeURIComponent(auth.crumb)}` : ''
  const hdrs  = auth ? { ...YF_HEADERS, 'Cookie': auth.cookie } : YF_HEADERS
  const url   = `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&period1=${p1}&period2=${Math.floor(Date.now() / 1000)}${crumb}`
  const resp  = await fetch(url, { headers: hdrs })
  const json  = await resp.json()
  const r     = json.chart?.result?.[0]
  if (!r) throw new Error(json.chart?.error?.description ?? `Sin datos Yahoo para ${yfTicker}`)

  const ts    = r.timestamp ?? []
  const q     = r.indicators.quote[0]
  const velas = []
  for (let i = 0; i < ts.length; i++) {
    if (q.open[i] == null || q.close[i] == null) continue
    velas.push({ time: ts[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i] })
  }
  return velas
}

// Años de histórico diario que se guardan por instrumento. Va dentro de la clave de la
// caché a propósito: si se cambia, la serie corta que hubiera en disco deja de valer y se
// reconstruye sola, en vez de quedarse para siempre con la profundidad antigua.
const ANIOS_DIARIAS = 10

async function obtenerVelasDiariasDesde30m(instrument) {
  const [sessionOpenMin, sessionCloseMin] = DUKA_SESSION_LONDON[instrument] ?? [8*60, 16*60+30]
  const cacheKey = `h1daily${ANIOS_DIARIAS}_${instrument}`
  const cached   = fromCache(cacheKey)
  if (cached) return cached

  const hoy  = getLondonDateStr(Date.now())
  const ayer = getLondonDateStr(Date.now() - 86400_000)

  // Disk cache: arranque rápido tras un reinicio del contenedor
  const disk        = diskCacheGet(cacheKey)
  const ultimaDisco  = disk?.length ? getLondonDateStr(disk[disk.length - 1].time * 1000) : null

  // Si el disco ya llega hasta la sesión de ayer, está al día → usarlo tal cual
  if (disk && ultimaDisco >= ayer) {
    toCache(cacheKey, disk, 4 * 60 * 60_000)
    console.log(`[Dukascopy H1→Diario] ${instrument}: ${disk.length} días (disco, al día)`)
    return disk
  }

  // Sin disco (primera vez) o desactualizado: descargar solo lo que falta desde la base en disco
  const from = ultimaDisco
    ? new Date(new Date(ultimaDisco).getTime() - 2 * 86400_000)  // margen de solape
    : (() => { const d = new Date(); d.setFullYear(d.getFullYear() - ANIOS_DIARIAS); return d })()

  console.log(`[Dukascopy H1→Diario] Descargando ${instrument} desde ${from.toISOString().slice(0, 10)}…`)
  let bars
  try {
    bars = await dukaFetch({
      instrument,
      dates:     { from, to: new Date() },
      timeframe: 'h1',
    }, DUKA_TIMEOUT_HISTORICO_MS, DUKA_OPCIONES_HISTORICO)
  } catch (err) {
    console.warn(`[Dukascopy H1→Diario] ${instrument}: fetch falló (${errDetalle(err)}), probando Yahoo Finance…`)

    // Dukascopy caído/inaccesible: probar Yahoo Finance antes de rendirse al disco desactualizado
    const yfTicker = DUKA_TO_YF_FALLBACK[instrument]
    if (yfTicker) {
      try {
        const yfVelas  = await obtenerVelasDiariasYF(yfTicker, from)
        const porFecha = new Map()
        for (const v of (disk ?? [])) porFecha.set(getLondonDateStr(v.time * 1000), v)
        for (const v of yfVelas)      porFecha.set(getLondonDateStr(v.time * 1000), v)
        const velas = [...porFecha.values()].sort((a, b) => a.time - b.time)

        // TTL corto: es un fallback, reintentar Dukascopy pronto en vez de esperar 4h
        toCache(cacheKey, velas, 30 * 60_000)
        const velasDisco = velas.filter(v => getLondonDateStr(v.time * 1000) < hoy)
        if (velasDisco.length > 0) diskCacheSet(cacheKey, velasDisco)

        console.log(`[Dukascopy H1→Diario] ${instrument}: ${velas.length} días (Yahoo fallback)`)
        return velas
      } catch (yfErr) {
        console.warn(`[Dukascopy H1→Diario] ${instrument}: Yahoo fallback también falló (${yfErr.message})`)
      }
    }

    // Último recurso: mejor servir el disco desactualizado que romper la petición.
    // TTL corto para reintentar pronto en vez de esperar las 4h normales.
    if (disk) {
      console.warn(`[Dukascopy H1→Diario] ${instrument}: usando disco desactualizado (${disk.length} días, hasta ${ultimaDisco})`)
      toCache(cacheKey, disk, 10 * 60_000)
      return disk
    }
    throw err
  }

  // Combinar con la base de disco (si la había) y deduplicar por fecha
  const nuevas   = agregarVelasH1ADiarias(bars, sessionOpenMin, sessionCloseMin)
  const porFecha = new Map()
  for (const v of (disk ?? [])) porFecha.set(getLondonDateStr(v.time * 1000), v)
  for (const v of nuevas)       porFecha.set(getLondonDateStr(v.time * 1000), v)
  const velas = [...porFecha.values()].sort((a, b) => a.time - b.time)

  toCache(cacheKey, velas, 4 * 60 * 60_000)

  // Al disco solo van sesiones cerradas: excluir hoy (candle incompleto si mercado abierto)
  const velasDisco = velas.filter(v => getLondonDateStr(v.time * 1000) < hoy)
  if (velasDisco.length > 0) diskCacheSet(cacheKey, velasDisco)

  console.log(`[Dukascopy H1→Diario] ${instrument}: ${velas.length} días`)
  return velas
}

// Últimas velas diarias para la cotización del buscador: barra d1 nativa de
// Dukascopy en vez de agregar H1 (~200ms-1s frente a ~4s de una consulta H1,
// una consulta H1 de un solo día vacío puede colgarse más de un minuto).
// A cambio el open/close puede diferir unos puntos del cierre de sesión exacto
// que usa el histórico completo — aceptable para una cotización de referencia.
async function obtenerUltimasVelasDiarias(instrument) {
  const cacheKey = `quoteRecent_${instrument}`
  const cached   = fromCache(cacheKey)
  if (cached) return cached

  const from = new Date(Date.now() - 15 * 86400_000)
  let bars
  try {
    bars = await dukaFetch({
      instrument,
      dates:     { from, to: new Date() },
      timeframe: 'd1',
    })
  } catch (err) {
    // Dukascopy caído/inaccesible: probar Yahoo Finance antes de recurrir al disco h1daily
    const yfTicker = DUKA_TO_YF_FALLBACK[instrument]
    if (yfTicker) {
      try {
        const velas = await obtenerVelasDiariasYF(yfTicker, from)
        if (velas.length > 0) {
          toCache(cacheKey, velas, 2 * 60_000)
          console.log(`[quoteRecent] ${instrument}: Yahoo fallback ok (${velas.length} días)`)
          return velas
        }
      } catch (yfErr) {
        console.warn(`[quoteRecent] ${instrument}: Yahoo fallback también falló (${yfErr.message})`)
      }
    }

    // Último recurso: reutilizar la caché diaria en disco (h1daily)
    const disk = diskCacheGet(`h1daily_${instrument}`)
    if (disk?.length) {
      console.warn(`[quoteRecent] ${instrument}: fetch falló (${errDetalle(err)}), usando disco h1daily`)
      const velas = disk.slice(-15)
      toCache(cacheKey, velas, 2 * 60_000)
      return velas
    }
    throw err
  }

  // Las barras son UTC 00:00; algunos instrumentos operan la noche del domingo
  // y generan una barra "domingo" espuria que no es un día de negociación real.
  const velas = bars
    .filter(([ts]) => { const dow = new Date(ts).getUTCDay(); return dow >= 1 && dow <= 5 })
    .map(([ts, open, , , close]) => ({ time: Math.floor(ts / 1000), open, close }))

  toCache(cacheKey, velas, 5 * 60_000)   // TTL corto: la cotización debe refrescarse pronto
  return velas
}

// ── Datos diarios para gap detection (hasta 5 años) ──────────────────────
async function obtenerVelasDiarias(ticker) {
  // Índices y materias primas: Dukascopy (datos más precisos)
  const dukaInstrument = DUKASCOPY_DAILY[ticker]
  if (dukaInstrument) return obtenerVelasDiariasDesde30m(dukaInstrument)

  // Acciones individuales: Stooq primero (funciona en Railway)
  try {
    return await obtenerVelasDiariasStooq(ticker)
  } catch (stooqErr) {
    console.warn(`[Stooq daily] falló para ${ticker}:`, stooqErr.message)
  }

  // Fallback: Yahoo Finance con crumb auth
  const cached = fromCache(`1d_${ticker}`)
  if (cached) return cached

  const auth   = await getYFAuth()
  const sym    = encodeURIComponent(ticker)
  const crumb  = auth ? `&crumb=${encodeURIComponent(auth.crumb)}` : ''
  const hdrs   = auth ? { ...YF_HEADERS, 'Cookie': auth.cookie } : YF_HEADERS
  const url    = `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5y${crumb}`
  const resp   = await fetch(url, { headers: hdrs })
  const json   = await resp.json()
  const r      = json.chart?.result?.[0]
  if (!r) throw new Error(json.chart?.error?.description ?? `Sin datos para ${ticker}`)

  const ts    = r.timestamp ?? []
  const q     = r.indicators.quote[0]
  const velas = []
  for (let i = 0; i < ts.length; i++) {
    if (q.open[i] == null || q.close[i] == null) continue
    velas.push({ time: ts[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i] })
  }

  toCache(`1d_${ticker}`, velas)
  return velas
}

// ── Yahoo Finance: velas intradía para un día concreto ────────────────────
// Intervalos de Yahoo equivalentes a cada timeframe de Dukascopy
const DUKA_TF_TO_YF = { m1: '1m', m5: '5m', m15: '15m', m30: '30m', h1: '60m' }

// Yahoo limita el histórico según el intervalo (1m ≈ 30 días, 5m/15m/30m ≈ 60 días,
// 60m ≈ 2 años), así que si el intervalo pedido viene vacío se prueban los más amplios
// antes de darse por vencido. Usado como fallback cuando Dukascopy no responde.
async function obtenerIntradayYF(yfTicker, date, timeframe = 'm15') {
  const pedido = DUKA_TF_TO_YF[timeframe] ?? '15m'
  for (const interval of [...new Set([pedido, '15m', '60m'])]) {
    const velas = await obtenerVelasIntradayYF(yfTicker, date, interval).catch(() => [])
    if (velas.length > 0) return { velas, fuente: `Yahoo ${interval}` }
  }
  return { velas: [], fuente: null }
}

async function obtenerVelasIntradayYF(ticker, date, interval = '15m') {
  const cached = fromCache(`yf${interval}_${ticker}_${date}`)
  if (cached) return cached

  const auth  = await getYFAuth()
  const p1    = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000)
  const p2    = p1 + 2 * 86400
  const sym   = encodeURIComponent(ticker)
  const crumb = auth ? `&crumb=${encodeURIComponent(auth.crumb)}` : ''
  const hdrs  = auth ? { ...YF_HEADERS, 'Cookie': auth.cookie } : YF_HEADERS
  const url   = `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&period1=${p1}&period2=${p2}${crumb}`
  const resp  = await fetch(url, { headers: hdrs })
  const json  = await resp.json()
  const r = json.chart?.result?.[0]
  if (!r) return []

  const ts    = r.timestamp ?? []
  const q     = r.indicators.quote[0]
  const velas = []
  for (let i = 0; i < ts.length; i++) {
    if (q.open[i] == null || q.close[i] == null) continue
    if (getMadridDate(ts[i]) !== date) continue   // solo el día pedido
    velas.push({
      time: ts[i], open: q.open[i], high: q.high[i],
      low:  q.low[i], close: q.close[i], volume: q.volume[i] ?? 0,
    })
  }

  toCache(`yf${interval}_${ticker}_${date}`, velas)
  return velas
}

// ── Dukascopy: velas intraday ──────────────────────────────────────────────
// Cache en dos niveles: memoria (req. repetidas en la misma sesión) + disco (sobrevive reinicios)
// Datos históricos son inmutables → disco no caduca. Solo hoy y ayer pueden actualizarse.
const DUKA_TIMEFRAMES = new Set(['m1', 'm5', 'm15', 'm30', 'h1'])

async function obtenerVelasDukascopy(instrument, date, timeframe = 'm15') {
  const tf       = DUKA_TIMEFRAMES.has(timeframe) ? timeframe : 'm15'
  const cacheKey = `duka_${instrument}_${date}_${tf}`

  // 1. Cache en memoria
  const cached = fromCache(cacheKey)
  if (cached) return cached

  // 2. Cache en disco: ayer y antes (sesión cerrada → datos inmutables)
  const ayer    = new Date(Date.now() - 86400_000).toISOString().slice(0, 10)
  const useDisk = date <= ayer

  if (useDisk) {
    const disk = diskCacheGet(cacheKey)
    if (disk) {
      toCache(cacheKey, disk, 6 * 60 * 60_000)
      return disk
    }
  }

  // 3. Sin caché: si la fuente está marcada como caída, no gastar otro timeout de 10 s
  if (dukaCaido()) return []

  console.log(`[Dukascopy] Descargando ${instrument} ${date} (${tf})…`)
  const from = new Date(date + 'T00:00:00Z')
  const to   = new Date(date + 'T23:59:00Z')

  const data = await dukaFetch({
    instrument,
    dates:     { from, to },
    timeframe: tf,
    // Solo para sesiones cerradas: el fichero de hoy sigue creciendo y cachearlo
    // congelaría el día a medias.
    useCache:        useDisk,
    cacheFolderPath: DUKA_RAW_CACHE_DIR,
  })

  const velas = data.map(([ts, open, high, low, close, volume]) => ({
    time:   Math.floor(ts / 1000),
    open, high, low, close,
    volume: volume ?? 0,
  }))

  if (velas.length > 0) {
    toCache(cacheKey, velas, 6 * 60 * 60_000)
    if (useDisk) diskCacheSet(cacheKey, velas)
  }
  return velas
}

// ── Última cotización de un ticker (para mostrar junto al buscador) ──────
app.get('/api/ultima-cotizacion', async (req, res) => {
  try {
    const ticker = req.query.ticker?.trim()
    if (!ticker) return res.status(400).json({ error: 'ticker requerido' })

    // Índices/materias primas: ventana corta (rápida) en vez del histórico de 5 años
    const dukaInstrument = DUKASCOPY_DAILY[ticker]
    const diarias = dukaInstrument
      ? await obtenerUltimasVelasDiarias(dukaInstrument)
      : await obtenerVelasDiarias(ticker)
    if (diarias.length === 0) return res.status(404).json({ error: 'Sin datos' })

    const ultima   = diarias[diarias.length - 1]
    const anterior = diarias[diarias.length - 2]
    const changePts = anterior ? ultima.close - anterior.close : null
    const changePct = anterior ? changePts / anterior.close * 100 : null

    res.json({
      ticker,
      price:     ultima.close,
      date:      getMadridDate(ultima.time),
      prevClose: anterior ? anterior.close : null,
      changePts: changePts != null ? parseFloat(changePts.toFixed(3)) : null,
      changePct: changePct != null ? parseFloat(changePct.toFixed(3)) : null,
    })
  } catch (err) {
    console.error('[ultima-cotizacion]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Cierre del día de negociación anterior a una fecha concreta (para el gráfico
// de operaciones, que puede mirar cualquier fecha histórica, no solo la más reciente) ──
app.get('/api/cierre-anterior', async (req, res) => {
  try {
    const ticker = req.query.ticker?.trim()
    const date   = req.query.date?.trim()
    if (!ticker || !date) return res.status(400).json({ error: 'ticker y date requeridos' })

    const diarias = await obtenerVelasDiarias(ticker)
    const idx = diarias.findIndex(v => getMadridDate(v.time) === date)
    if (idx <= 0) return res.status(404).json({ error: 'Sin cierre anterior disponible' })

    res.json({ ticker, date, prevClose: diarias[idx - 1].close })
  } catch (err) {
    console.error('[cierre-anterior]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Gap Filter ─────────────────────────────────────────────────────────────
app.get('/api/gap-filter', async (req, res) => {
  try {
    const ticker  = req.query.ticker ?? '^GDAXI'
    const dias    = req.query.dias ? req.query.dias.split(',').map(Number) : [1,2,3,4,5]
    const dir     = req.query.dir  ?? 'both'
    const gapMin  = parseFloat(req.query.gapMin ?? 0)
    const gapModo = req.query.gapModo === 'pts' ? 'pts' : 'pct'
    const meses   = Math.min(12 * ANIOS_DIARIAS, Math.max(1, parseInt(req.query.meses ?? 12, 10)))
    const diasEsp = req.query.diasEsp ? new Set(req.query.diasEsp.split(',')) : null

    const diarias = await obtenerVelasDiarias(ticker)

    // Filtrar al periodo solicitado
    const cutoff  = Date.now() / 1000 - meses * 31 * 86400
    const periodo = diarias.filter(v => v.time >= cutoff)

    const evIdx    = await getEventIndex()
    const sesiones = []

    for (let i = 1; i < periodo.length; i++) {
      const curr = periodo[i]
      const prev = periodo[i - 1]

      const gapPts    = curr.open - prev.close
      const gapPct    = gapPts / prev.close * 100
      const gapDir    = gapPct >= 0 ? 'up' : 'down'
      const date      = getMadridDate(curr.time)
      const dayOfWeek = getMadridDay(curr.time)
      const gapMedido = gapModo === 'pts' ? gapPts : gapPct

      // Festivo de mercado: hueco de días naturales entre velas mayor que un
      // fin de semana normal ⇒ se saltó al menos un día hábil por festivo.
      // Se detecta por instrumento a partir de sus propias velas (sin depender
      // de un calendario de festivos por país), así vale para cualquier ticker.
      const gapDiasCal   = Math.round((curr.time - prev.time) / 86400)
      const gapEsperado  = dayOfWeek === 1 ? 3 : 1
      const esPostFestivo = gapDiasCal > gapEsperado

      const eventos = [...getEventosEnFecha(evIdx, date)]
      if (esPostFestivo) eventos.push('FESTIVO')

      if (!dias.includes(dayOfWeek))            continue
      if (dir !== 'both' && gapDir !== dir)      continue
      if (Math.abs(gapMedido) < gapMin - 0.001) continue

      sesiones.push({
        date, dayOfWeek,
        gapPct:    parseFloat(gapPct.toFixed(3)),
        gapDir,
        prevClose: prev.close,
        openPrice: curr.open,
        eventos,
      })
    }

    // Filtro días especiales (primer/último día de negociación del mes o trimestre)
    let sesionesFiltradas = sesiones
    if (diasEsp && diasEsp.size > 0) {
      // Construir conjuntos de fechas especiales a partir del periodo completo
      const byMes = {}
      for (const v of periodo) {
        const date = getMadridDate(v.time)
        const key  = date.slice(0, 7)
        if (!byMes[key]) byMes[key] = []
        byMes[key].push(date)
      }
      const primerMes  = new Set()
      const ultimoMes  = new Set()
      const primerTrim = new Set()
      const ultimoTrim = new Set()
      const inicioTrim = new Set(['01','04','07','10'])
      const finTrim    = new Set(['03','06','09','12'])
      for (const [key, fechas] of Object.entries(byMes)) {
        const ord = [...fechas].sort()
        const mes = key.slice(5, 7)
        primerMes.add(ord[0])
        ultimoMes.add(ord[ord.length - 1])
        if (inicioTrim.has(mes)) primerTrim.add(ord[0])
        if (finTrim.has(mes))    ultimoTrim.add(ord[ord.length - 1])
      }
      sesionesFiltradas = sesiones.filter(s =>
        (diasEsp.has('primerMes')  && primerMes.has(s.date))  ||
        (diasEsp.has('ultimoMes')  && ultimoMes.has(s.date))  ||
        (diasEsp.has('primerTrim') && primerTrim.has(s.date)) ||
        (diasEsp.has('ultimoTrim') && ultimoTrim.has(s.date)) ||
        (diasEsp.has('festivo')   && s.eventos.includes('FESTIVO'))
      )
    }

    const fechaInicio  = periodo[0] ? getMadridDate(periodo[0].time) : null
    const periodoLabel = meses >= 12 ? `${meses / 12}a` : `${meses}m`
    const fuenteDiaria = DUKASCOPY_DAILY[ticker]
      ? `Dukascopy · ${periodoLabel}`
      : `Stooq 1d · ${periodoLabel}`
    res.json({ ticker, sesiones: sesionesFiltradas, total: sesionesFiltradas.length, fuente: fuenteDiaria, fechaInicio })
  } catch (err) {
    console.error('[gap-filter]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Exportar coincidencias del Gap Filter a PowerPoint ────────────────────
// Agrupa todas las sesiones que coinciden con el filtro actual (recibidas ya
// filtradas desde el cliente, cada una con su gráfico de velas ya capturado
// en PNG) en un único .pptx: portada, resumen estadístico agrupado y un
// slide por coincidencia con su gráfico intradía.
const DIA_NOMBRE_PPT = { 1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves', 5: 'Viernes' }

app.post('/api/export-ppt', async (req, res) => {
  try {
    const { ticker, sesiones, filtros } = req.body
    if (!Array.isArray(sesiones) || sesiones.length === 0)
      return res.status(400).json({ error: 'Sin coincidencias que exportar' })

    const arriba = sesiones.filter(s => s.gapDir === 'up').length
    const abajo  = sesiones.length - arriba
    const avgGap = sesiones.reduce((a, s) => a + Math.abs(s.gapPct ?? 0), 0) / sesiones.length
    const porDia = {}
    for (const s of sesiones) porDia[s.dayOfWeek] = (porDia[s.dayOfWeek] ?? 0) + 1

    const pptx = new PptxGenJS()
    pptx.defineLayout({ name: 'WIDE', width: 13.33, height: 7.5 })
    pptx.layout = 'WIDE'

    // ── Portada ──
    const portada = pptx.addSlide()
    portada.background = { color: '0F172A' }
    portada.addText('Situational Analysis', { x: 0.6, y: 0.7, fontSize: 32, bold: true, color: 'FFFFFF' })
    portada.addText(`${ticker} · ${sesiones.length} coincidencias`, { x: 0.6, y: 1.5, fontSize: 20, color: '93C5FD' })
    if (filtros) {
      const resumenFiltros = [
        filtros.dias            && `Días: ${filtros.dias}`,
        filtros.dir              && `Dirección: ${filtros.dir}`,
        filtros.gapMin != null   && `Gap mínimo: ${filtros.gapMin === 0 ? 'cualquiera' : filtros.gapMin + (filtros.gapModo === 'pts' ? ' pts' : '%')}`,
        filtros.periodo          && `Periodo: ${filtros.periodo}`,
      ].filter(Boolean).join('   ·   ')
      if (resumenFiltros) portada.addText(resumenFiltros, { x: 0.6, y: 2.3, fontSize: 13, color: 'CBD5E1' })
    }

    // ── Resumen agrupado ──
    const resumenSlide = pptx.addSlide()
    resumenSlide.addText('Resumen agrupado', { x: 0.5, y: 0.4, fontSize: 24, bold: true, color: '0F172A' })
    resumenSlide.addText(
      `Total coincidencias: ${sesiones.length}\n` +
      `Gaps al alza: ${arriba}   ·   Gaps a la baja: ${abajo}\n` +
      `Gap medio (valor absoluto): ${avgGap.toFixed(3)}%`,
      { x: 0.5, y: 1.2, fontSize: 15, color: '334155', lineSpacingMultiple: 1.4 }
    )
    const filasDia = [
      [{ text: 'Día', options: { bold: true } }, { text: 'Nº coincidencias', options: { bold: true } }],
      ...Object.entries(porDia)
        .sort(([a], [b]) => a - b)
        .map(([d, n]) => [DIA_NOMBRE_PPT[d] ?? d, String(n)]),
    ]
    resumenSlide.addTable(filasDia, {
      x: 0.5, y: 2.9, w: 5, fontSize: 13,
      border: { type: 'solid', color: 'CBD5E1', pt: 0.5 },
      autoPage: false,
    })

    // ── Detalle: un slide por coincidencia con su gráfico intradía ──
    for (const s of sesiones) {
      const slide    = pptx.addSlide()
      const gapColor = s.gapDir === 'up' ? '3FB950' : 'F85149'
      const gapPts   = s.prevClose != null && s.openPrice != null ? s.openPrice - s.prevClose : null
      const gapText  = s.gapPct != null
        ? `${s.gapPct > 0 ? '+' : ''}${s.gapPct.toFixed(3)}%` + (gapPts != null ? `  (${gapPts > 0 ? '+' : ''}${gapPts.toFixed(2)} pts)` : '')
        : ''

      slide.addText([
        { text: `${s.date ?? ''}   `,                      options: { bold: true, color: '0F172A', fontSize: 16 } },
        { text: `${DIA_NOMBRE_PPT[s.dayOfWeek] ?? ''}   `, options: { color: '64748B', fontSize: 14 } },
        { text: gapText,                                    options: { bold: true, color: gapColor, fontSize: 16 } },
        { text: `   Cierre ant. ${s.prevClose != null ? s.prevClose.toFixed(2) : '–'} → Apertura ${s.openPrice != null ? s.openPrice.toFixed(2) : '–'}`, options: { color: '64748B', fontSize: 13 } },
        ...(s.eventos?.length ? [{ text: `   ${s.eventos.join(', ')}`, options: { color: '7C3AED', fontSize: 13, bold: true } }] : []),
      ], { x: 0.5, y: 0.3, w: 12.3, h: 0.6 })

      if (s.imagen) {
        slide.addImage({ data: s.imagen, x: 1.0, y: 1.05, w: 11.33, h: 6.375 })
      } else {
        slide.addText('Sin datos intraday disponibles para esta sesión', {
          x: 1.0, y: 3.7, w: 11.33, h: 0.6, align: 'center', color: '94A3B8', fontSize: 16, italic: true,
        })
      }
    }

    const buffer = await pptx.write({ outputType: 'nodebuffer' })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
    res.setHeader('Content-Disposition', `attachment; filename="situational-analysis-${ticker}.pptx"`)
    res.send(buffer)
  } catch (err) {
    console.error('[export-ppt]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── ForexFactory Calendar ─────────────────────────────────────────────────
// Proxy server-side para evitar CORS; combina semana pasada + actual + próxima
app.get('/api/ff-calendar', async (req, res) => {
  try {
    const cached = fromCache('ff_calendar')
    if (cached) return res.json(cached)

    const slugs  = ['lastweek', 'thisweek', 'nextweek']
    const events = (await Promise.all(
      slugs.map(slug =>
        fetch(`https://nfs.faireconomy.media/ff_calendar_${slug}.json`, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        }).then(r => r.ok ? r.json() : []).catch(() => [])
      )
    )).flat()

    toCache('ff_calendar', events, 60 * 60_000)  // 1 hora
    res.json(events)
  } catch (err) {
    console.error('[ff-calendar]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Yahoo Finance intraday proxy (espejo del Vercel serverless function) ──
// En producción: manejado por Vercel (api/yf-intraday.js) antes del rewrite a Railway.
// En local: manejado aquí directamente (Yahoo Finance no bloquea IPs domésticas).
app.get('/api/yf-intraday', async (req, res) => {
  try {
    const { ticker, date, timeframe = 'm15' } = req.query
    if (!ticker || !date) return res.status(400).json({ error: 'ticker y date requeridos' })
    const { velas, fuente } = await obtenerIntradayYF(ticker, date, timeframe)
    res.json({ ticker, date, velas, fuente: fuente ?? 'Yahoo 15m' })
  } catch (err) {
    console.error('[yf-intraday]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Velas intraday para una sesión concreta (carga bajo demanda) ──────────
// Usa Dukascopy siempre (fuente única, sin límite de 60 días de Yahoo Finance)
app.get('/api/velas15m', async (req, res) => {
  try {
    const { ticker, date, timeframe = 'm15' } = req.query
    if (!ticker || !date) return res.status(400).json({ error: 'ticker y date requeridos' })

    const instrument = YF_TO_DUKASCOPY[ticker]
    let velas = [], fuente

    if (instrument) {
      // Dukascopy puede estar inaccesible (p. ej. bloqueado por el ISP en local): si la
      // conexión falla se anota en el circuito de corte y se pasa al fallback sin esperar
      // los 10 s del timeout en cada petición posterior.
      try {
        velas  = await obtenerVelasDukascopy(instrument, date, timeframe)
        fuente = `Dukascopy ${timeframe}`

        // Fallback si el timeframe pedido no tiene datos para esa fecha antigua
        if (velas.length === 0 && timeframe !== 'h1') {
          console.log(`[velas15m] ${instrument} ${date} vacío en ${timeframe}, intentando h1…`)
          velas  = await obtenerVelasDukascopy(instrument, date, 'h1')
          if (velas.length > 0) fuente = 'Dukascopy h1'
        }
      } catch (dukaErr) {
        marcarDukaCaido(dukaErr)
        velas = []
      }

      // Sin Dukascopy: intradía de Yahoo antes de rendirse a la barra diaria
      if (velas.length === 0) {
        const yfTicker = DUKA_TO_YF_FALLBACK[instrument]
        if (yfTicker) {
          console.log(`[velas15m] ${instrument} ${date} sin Dukascopy, probando intradía Yahoo (${yfTicker})…`)
          const yf = await obtenerIntradayYF(yfTicker, date, timeframe)
          if (yf.velas.length > 0) { velas = yf.velas; fuente = yf.fuente }
        }
      }

      // Último recurso: barra diaria del caché H1 ya calculado
      if (velas.length === 0) {
        console.log(`[velas15m] ${instrument} ${date} sin intraday, usando barra diaria…`)
        const diarias = await obtenerVelasDiariasDesde30m(instrument)
        const barra   = diarias.find(v => getLondonDateStr(v.time * 1000) === date)
        if (barra) { velas = [barra]; fuente = 'Dukascopy 1d' }
      }
    } else {
      // Acciones individuales: Stooq (5m → 60m → 1d), Yahoo como último recurso
      try {
        const result = await obtenerVelasIntradayStooq(ticker, date)
        velas  = result.velas
        fuente = result.fuente
      } catch (stooqErr) {
        console.warn(`[Stooq intraday] falló para ${ticker}:`, stooqErr.message)
        const yf = await obtenerIntradayYF(ticker, date, timeframe)
        velas  = yf.velas
        fuente = yf.fuente ?? 'Yahoo Finance 15m'
      }

      // Stooq ya no publica intradía para muchos símbolos y devuelve la barra diaria:
      // preferir el intradía de Yahoo antes que un único candle de día completo.
      if (fuente === 'Stooq 1d') {
        const yf = await obtenerIntradayYF(ticker, date, timeframe)
        if (yf.velas.length > 0) { velas = yf.velas; fuente = yf.fuente }
      }
    }

    res.json({ ticker, date, velas, fuente })
  } catch (err) {
    console.error('[velas15m]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Fotos de trades (solo local — lee las carpetas Trading<año> de Google Drive) ──
const PHOTOS_ROOT = process.env.PHOTOS_DIR || 'G:\\Mi unidad'
const IMG_EXT      = /\.(jpe?g|png)$/i

// Cada año guarda las capturas en una carpeta distinta con convenciones distintas;
// 2026 prioriza la subcarpeta "Separados" (recorte por instrumento) y usa la captura
// del día completo como respaldo solo para los días que aún no se han separado a mano
const PHOTO_YEARS = [
  { year: 2022, dir: 'Trading 2022\\Trades 2022' },
  { year: 2023, dir: 'Trading 2023\\DAY' },
  { year: 2024, dir: 'Trading 2024\\Trades' },
  { year: 2025, dir: 'Trading 2025\\Trades' },
  { year: 2026, dir: 'Trading 2026\\Trades', separadosConRespaldo: true },
]

function walkImages(dir, excludeDirNamed) {
  let out = []
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (excludeDirNamed && e.name.toLowerCase() === excludeDirNamed.toLowerCase()) continue
      out = out.concat(walkImages(full, excludeDirNamed))
    } else if (IMG_EXT.test(e.name)) {
      out.push(full)
    }
  }
  return out
}

// La subcarpeta "collage" duplica exactamente las capturas sueltas del día completo,
// así que se ignora. De las sueltas restantes, solo se cuelan las de días que no
// tengan ya su versión separada por instrumento (para no contar el mismo día 2 veces).
function walkImages2026(dir) {
  const todas = walkImages(dir, 'collage')
  const separadas = todas.filter(p => basename(dirname(p)).toLowerCase() === 'separados')
  const sueltas    = todas.filter(p => basename(dirname(p)).toLowerCase() !== 'separados')
  const fechasSeparadas = new Set(
    separadas.map(p => parseFotoInfo({ year: 2026, path: p }).fecha).filter(Boolean)
  )
  const sueltasSinSeparar = sueltas.filter(p => {
    const { fecha } = parseFotoInfo({ year: 2026, path: p })
    return !fecha || !fechasSeparadas.has(fecha)
  })
  return [...separadas, ...sueltasSinSeparar]
}

let _photoIndex   = null
let _photoIndexTs = 0
function getPhotoIndex() {
  if (_photoIndex && Date.now() - _photoIndexTs < 10 * 60_000) return _photoIndex
  const all = []
  for (const { year, dir, separadosConRespaldo } of PHOTO_YEARS) {
    const full  = join(PHOTOS_ROOT, dir)
    const files = separadosConRespaldo ? walkImages2026(full) : walkImages(full)
    for (const path of files) all.push({ year, path })
  }
  _photoIndex   = all
  _photoIndexTs = Date.now()
  console.log(`[fotos] índice construido: ${all.length} imágenes`)
  return _photoIndex
}

// Erratas conocidas en los nombres de archivo de origen (carpetas "Separados")
const INSTRUMENTO_ALIAS = { NADSAQ: 'NASDAQ' }

// Extrae fecha/instrumento del nombre de archivo: "DD-M-YY.ext" o "DD-M-YY_INSTRUMENTO.ext"
// (2022/2023 usan numeración secuencial sin fecha, ej. "0001.png")
function parseFotoInfo({ year, path }) {
  const stem = basename(path).replace(/\.[^.]+$/, '')
  const m = stem.match(/^(\d{1,2})-(\d{1,2})-(\d{2})(?:_(.+))?$/)
  if (m) {
    const [, d, mo, yy] = m
    const instrumentoRaw = m[4]?.toUpperCase() ?? null
    const instrumento = instrumentoRaw ? (INSTRUMENTO_ALIAS[instrumentoRaw] ?? instrumentoRaw) : null
    return { year, fecha: `20${yy}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`, instrumento, numero: null }
  }
  return { year, fecha: null, instrumento: null, numero: stem }
}

function photoToDTO(pick) {
  const rel  = relative(PHOTOS_ROOT, pick.path)
  const info = parseFotoInfo(pick)
  const anio = info.fecha ? info.fecha.slice(0, 4) : String(pick.year)
  return {
    id: Buffer.from(rel).toString('base64url'),
    ...info,
    // La misma clave que usa Trades comentados: así la pestaña Fotos comparte comentario,
    // etiquetas y revisado con el resto de la app en vez de llevar los suyos aparte.
    clave: claveTrade({ rel, fecha: info.fecha, instrumento: info.instrumento, anio, numero: info.numero }),
  }
}

app.get('/api/fotos/aleatoria', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  try {
    const idx = getPhotoIndex()
    if (idx.length === 0) return res.status(404).json({ error: 'Sin fotos disponibles' })
    const pick = idx[Math.floor(Math.random() * idx.length)]
    res.json({ total: idx.length, ...photoToDTO(pick) })
  } catch (err) {
    console.error('[fotos/aleatoria]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Catálogo completo (sin bytes de imagen) para que el cliente filtre por fecha/instrumento/resultado
app.get('/api/fotos/lista', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  try {
    const idx = getPhotoIndex()
    res.json({ total: idx.length, fotos: idx.map(photoToDTO) })
  } catch (err) {
    console.error('[fotos/lista]', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/fotos/archivo', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).end()
  try {
    const rel  = Buffer.from(req.query.id ?? '', 'base64url').toString('utf8')
    const abs  = resolve(join(PHOTOS_ROOT, rel))
    const root = resolve(PHOTOS_ROOT) + sep
    if (!abs.startsWith(root)) return res.status(400).end()
    res.sendFile(abs)
  } catch {
    res.status(400).end()
  }
})

// ── Books de trades (solo local): el Book of Horror de los errores y el Book of Glory
// de los trades bien hechos. Los dos son la misma carpeta de archivos sueltos y comparten
// endpoints; ?book= elige cuál, y sin parámetro se entiende el de Horror.
const HORROR_DIR     = process.env.HORROR_DIR || join(PHOTOS_ROOT, 'Book of Horror')
const GLORY_DIR      = process.env.GLORY_DIR  || join(PHOTOS_ROOT, 'Book of Glory')
const HORROR_IMG_EXT = /\.(jpe?g|png|gif|webp)$/i
const PAPELERA       = 'papelera'

const BOOKS = {
  horror: { id: 'horror', nombre: 'Book of Horror', dir: HORROR_DIR },
  glory:  { id: 'glory',  nombre: 'Book of Glory',  dir: GLORY_DIR },
}

function bookDe(req) {
  return BOOKS[String(req.query.book ?? 'horror').toLowerCase()] ?? null
}

// De qué trade del archivo es un archivo del book, para poder mostrar su comentario. No basta
// con la convención de nombres: al book se han ido copiando capturas con el nombre puesto a
// mano ("Gold_11-8-2026.jpg" es el GOLD del 11-8-26), así que si el nombre lleva la fecha y el
// instrumento se busca el trade que cuadre, en el orden que sea y con el año de 2 o 4 cifras.
// Devuelve null solo cuando de verdad no hay un trade del archivo detrás.
function claveDesdeNombre(nombre) {
  const stem   = basename(nombre).replace(/\.[^.]+$/, '')
  const claves = clavesDelArchivo()

  // 1) convención del archivo: DD-M-YY[_INSTRUMENTO]
  const { fecha, instrumento } = parseFotoInfo({ year: null, path: nombre })
  if (fecha) {
    const clave = claveTrade({ rel: nombre, fecha, instrumento })
    if (claves.has(clave)) return clave
  }

  // 2) numeradas de 2022-2023, que la propia app copia como AAAA_NNNN
  const num = stem.match(/^(\d{4})_(\d+)$/)
  if (num && claves.has(`${num[1]}#${num[2]}`)) return `${num[1]}#${num[2]}`

  // 3) nombre puesto a mano: la fecha en cualquier posición y el instrumento suelto
  const m = stem.match(/(\d{1,2})[-_. ](\d{1,2})[-_. ](\d{4}|\d{2})(?!\d)/)
  if (m) {
    const [, d, mo, y] = m
    const dia        = `${y.length === 4 ? y : `20${y}`}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
    const enMayuscula = stem.toUpperCase()
    const candidatas = [...claves].filter(c => c.startsWith(`${dia}_`))
    const acertada   = candidatas.find(c => {
      const inst = c.slice(dia.length + 1)
      return inst && enMayuscula.includes(inst)
    })
    if (acertada) return acertada
    // un solo trade ese día: no hay con qué confundirlo aunque el nombre no diga el instrumento
    if (candidatas.length === 1) return candidatas[0]
  }

  return null
}

// Qué trades están ya en cada book, para que el botón de un clic aparezca marcado
function clavesEnBooks() {
  const mapa = {}
  for (const [id, book] of Object.entries(BOOKS)) {
    const claves = new Set()
    try {
      for (const e of readdirSync(book.dir, { withFileTypes: true })) {
        if (!e.isFile()) continue
        const clave = claveDesdeNombre(e.name)
        if (clave) claves.add(clave)
      }
    } catch { /* ese book todavía no existe */ }
    mapa[id] = claves
  }
  return mapa
}

const bookUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const book = bookDe(req)
      if (!book) return cb(new Error('Book desconocido'))
      try { mkdirSync(book.dir, { recursive: true }); cb(null, book.dir) }
      catch (err) { cb(err) }
    },
    filename: (req, file, cb) => {
      const book = bookDe(req)
      if (!book) return cb(new Error('Book desconocido'))
      // basename ya descarta cualquier componente de ruta del nombre original
      const limpio = basename(file.originalname).replace(/[<>:"/|?*]/g, '_').trim() || 'archivo'
      cb(null, existsSync(join(book.dir, limpio)) ? `${Date.now()}_${limpio}` : limpio)
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024, files: 20 },
}).array('archivos', 20)

app.post('/api/books/subir', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  if (!bookDe(req)) return res.status(400).json({ error: 'Book desconocido' })
  bookUpload(req, res, err => {
    if (err) {
      console.error('[books/subir]', err.message)
      return res.status(400).json({ error: err.message })
    }
    res.json({ subidos: (req.files ?? []).map(f => f.filename) })
  })
})

app.get('/api/books/lista', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  const book = bookDe(req)
  if (!book) return res.status(400).json({ error: 'Book desconocido' })
  try {
    mkdirSync(book.dir, { recursive: true })
    const comentarios = leerComentariosTrades()
    const archivos = readdirSync(book.dir, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => {
        const { size, mtimeMs } = statSync(join(book.dir, e.name))
        const clave = claveDesdeNombre(e.name)
        return {
          id:         Buffer.from(e.name).toString('base64url'),
          nombre:     e.name,
          bytes:      size,
          modificado: mtimeMs,
          esImagen:   HORROR_IMG_EXT.test(e.name),
          // comentario y etiquetas son los del trade, los mismos de Trades comentados
          clave,
          comentario: clave ? anotacionDe(comentarios, clave).texto : '',
          cats:       clave ? anotacionDe(comentarios, clave).cats  : [],
        }
      })
      .sort((a, b) => b.modificado - a.modificado)
    res.json({ book: book.id, nombre: book.nombre, carpeta: book.dir, total: archivos.length, archivos })
  } catch (err) {
    console.error('[books/lista]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// La captura que se manda a un book. Normalmente es un trade del archivo, pero desde
// Operaciones se manda la que se está mirando, que puede ser la del día completo (sin
// recorte por instrumento) y por tanto no estar en el archivo de trades comentados: en ese
// caso vale con que sea una foto del catálogo, el mismo que alimenta la pestaña Fotos.
function capturaParaBook(rel) {
  const delArchivo = getTradesIndex().find(c => relative(PHOTOS_ROOT, c.path) === rel)
  if (delArchivo) return delArchivo
  const delCatalogo = getPhotoIndex().find(p => relative(PHOTOS_ROOT, p.path) === rel)
  return delCatalogo ? { path: delCatalogo.path, year: delCatalogo.year, mesCarpeta: null } : null
}

// Añadir a un book con un solo clic desde Trades comentados: se copia la captura, la
// original se queda donde estaba. El nombre conserva la identidad del trade para que el
// book pueda mostrar su comentario.
app.post('/api/books/copiar', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  const book = bookDe(req)
  if (!book) return res.status(400).json({ error: 'Book desconocido' })
  try {
    const rel     = Buffer.from(String(req.query.id ?? ''), 'base64url').toString('utf8')
    const captura = capturaParaBook(rel)
    if (!captura) return res.status(404).json({ error: 'Esa captura no está en las carpetas de trading' })

    const comentarios = leerComentariosTrades()
    const trade  = tradeDTO(captura, comentarios, clavesEnBooks())
    const nombre = trade.fecha ? trade.nombre : `${trade.anio}_${trade.numero}${extname(trade.nombre)}`
    mkdirSync(book.dir, { recursive: true })
    const destino  = join(book.dir, nombre)
    const yaEstaba = existsSync(destino)
    if (!yaEstaba) copyFileSync(captura.path, destino)

    res.json({
      book:   book.id,
      nombre: book.nombre,
      archivo: nombre,
      yaEstaba,
      trade:  tradeDTO(captura, comentarios, clavesEnBooks()),
    })
  } catch (err) {
    console.error('[books/copiar]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Borrado: el archivo no se elimina, se mueve a la subcarpeta "papelera" para poder
// recuperarlo a mano si el clic fue un accidente
app.delete('/api/books/archivo', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  const book = bookDe(req)
  if (!book) return res.status(400).json({ error: 'Book desconocido' })
  try {
    const nombre = Buffer.from(req.query.id ?? '', 'base64url').toString('utf8')
    const abs    = resolve(join(book.dir, nombre))
    if (dirname(abs) !== resolve(book.dir)) return res.status(400).json({ error: 'Ruta no permitida' })
    if (!existsSync(abs)) return res.status(404).json({ error: 'El archivo ya no existe' })

    const papelera = join(book.dir, PAPELERA)
    mkdirSync(papelera, { recursive: true })
    const destino = join(papelera, existsSync(join(papelera, nombre)) ? `${Date.now()}_${nombre}` : nombre)
    renameSync(abs, destino)
    res.json({ borrado: nombre, papelera: destino })
  } catch (err) {
    console.error('[books/borrar]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Renombrar: si el nombre nuevo llega sin extensión se conserva la del original
app.patch('/api/books/archivo', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  const book = bookDe(req)
  if (!book) return res.status(400).json({ error: 'Book desconocido' })
  try {
    const nombre = Buffer.from(req.query.id ?? '', 'base64url').toString('utf8')
    const abs    = resolve(join(book.dir, nombre))
    if (dirname(abs) !== resolve(book.dir)) return res.status(400).json({ error: 'Ruta no permitida' })
    if (!existsSync(abs)) return res.status(404).json({ error: 'El archivo ya no existe' })

    let limpio = basename(String(req.body?.nombre ?? '')).replace(/[<>:"/\\|?*]/g, '_').trim()
    if (!limpio || limpio === '.' || limpio === '..') return res.status(400).json({ error: 'Nombre no válido' })
    const ext = extname(nombre)
    if (ext && !extname(limpio)) limpio += ext

    const destino = resolve(join(book.dir, limpio))
    if (dirname(destino) !== resolve(book.dir)) return res.status(400).json({ error: 'Ruta no permitida' })
    if (destino === abs) return res.json({ nombre: limpio, id: Buffer.from(limpio).toString('base64url') })
    // en Windows el disco no distingue mayúsculas: cambiar solo la caja no es una colisión
    if (destino.toLowerCase() !== abs.toLowerCase() && existsSync(destino)) {
      return res.status(409).json({ error: `Ya existe un archivo llamado "${limpio}"` })
    }

    renameSync(abs, destino)
    // el nombre nuevo puede apuntar a otro trade (o a ninguno): se devuelve la anotación
    // que le corresponde ahora, para que la tarjeta no siga enseñando la anterior
    const clave     = claveDesdeNombre(limpio)
    const anotacion = clave ? anotacionDe(leerComentariosTrades(), clave) : null
    res.json({
      nombre:     limpio,
      id:         Buffer.from(limpio).toString('base64url'),
      clave,
      comentario: anotacion?.texto ?? '',
      cats:       anotacion?.cats ?? [],
    })
  } catch (err) {
    console.error('[books/renombrar]', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/books/archivo', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).end()
  const book = bookDe(req)
  if (!book) return res.status(400).end()
  try {
    const nombre = Buffer.from(req.query.id ?? '', 'base64url').toString('utf8')
    const abs    = resolve(join(book.dir, nombre))
    if (dirname(abs) !== resolve(book.dir)) return res.status(400).end()
    if (req.query.descargar === '1') return res.download(abs)
    res.sendFile(abs)
  } catch {
    res.status(400).end()
  }
})

// ── Trades comentados: las capturas que ya están en Drive (solo local) ──
// Aquí no se sube nada: se recorre el archivo de cada año y a cada trade se le engancha un
// comentario. Los comentarios viven en su propio JSON junto a las fotos, así que respaldar
// la carpeta de Drive respalda también lo escrito.
const TRADES_COMENTARIOS_PATH = process.env.TRADES_COMENTARIOS || join(PHOTOS_ROOT, 'Comentarios trades.json')

function leerComentariosTrades() {
  try {
    const data = JSON.parse(readFileSync(TRADES_COMENTARIOS_PATH, 'utf8'))
    return data?.comentarios && typeof data.comentarios === 'object' ? data.comentarios : {}
  } catch {
    return {}   // todavía no existe, o quedó ilegible: se parte de cero
  }
}

// Escritura atómica (tmp + rename): un corte a medias dejaría todos los comentarios
// en un JSON truncado. Las capturas no se tocan nunca.
function guardarComentariosTrades(comentarios) {
  const tmp = `${TRADES_COMENTARIOS_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify({ comentarios }, null, 2))
  renameSync(tmp, TRADES_COMENTARIOS_PATH)
}

// Lo que hay escrito sobre un trade: su comentario, sus etiquetas (las 12 categorías del
// Book of Horror, por número) y si ya está revisado. Todo en la misma anotación, para que
// respaldar ese JSON respalde el trabajo entero.
const CATEGORIAS_BOH = 12

function normalizaCats(v) {
  if (!Array.isArray(v)) return []
  const nums = v.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= CATEGORIAS_BOH)
  return [...new Set(nums)].sort((a, b) => a - b)
}

function anotacionDe(comentarios, clave) {
  const a = comentarios[clave]
  return {
    texto:       typeof a?.texto === 'string' ? a.texto : '',
    cats:        normalizaCats(a?.cats),
    revisado:    a?.revisado === true,
    actualizado: Number.isFinite(a?.actualizado) ? a.actualizado : null,
  }
}

// Una anotación que se queda sin comentario, sin etiquetas y sin revisar se borra del
// JSON en lugar de dejar una entrada vacía
function guardarAnotacion(comentarios, clave, anotacion) {
  const limpia = {
    texto:    String(anotacion.texto ?? '').trim(),
    cats:     normalizaCats(anotacion.cats),
    revisado: anotacion.revisado === true,
  }
  if (!limpia.texto && limpia.cats.length === 0 && !limpia.revisado) delete comentarios[clave]
  else comentarios[clave] = { ...limpia, actualizado: Date.now() }
  guardarComentariosTrades(comentarios)
  return anotacionDe(comentarios, clave)
}

// El comentario se guarda por trade, no por ruta: de 2024 en adelante la captura se llama
// por su fecha e instrumento, y en 2022-2023 por el número de operación. Eso identifica al
// trade aunque el archivo se reexporte con otra extensión o cambie de carpeta.
function claveTrade({ rel, fecha, instrumento, anio, numero }) {
  if (fecha)  return `${fecha}_${instrumento ?? ''}`
  if (numero) return `${anio}#${numero}`
  return rel.split(sep).join('/')
}

// Las capturas de un año. Si tiene subcarpetas "Separados" (2024 en adelante) mandan ellas,
// que es el recorte por instrumento; si no las tiene (2022 y 2023, numeradas), entra todo.
// 2023 guarda la misma captura en la carpeta de su mes y en TODOS: se cuenta una sola vez,
// y la carpeta del mes es lo único que le pone mes a un nombre que no lleva fecha.
function capturasDelAnio(base, year) {
  const todas     = walkImages(base, 'collage')
  const separadas = todas.filter(p => basename(dirname(p)).toLowerCase() === 'separados')

  const mesPorNombre = new Map()
  for (const p of todas) {
    const m = basename(dirname(p)).match(/^(\d{1,2})-/)
    if (m) mesPorNombre.set(basename(p), m[1].padStart(2, '0'))
  }

  const vistos = new Set()
  const out    = []
  for (const path of (separadas.length > 0 ? separadas : todas)) {
    const nombre = basename(path)
    if (vistos.has(nombre)) continue   // el mismo número en la carpeta del mes y en TODOS
    vistos.add(nombre)
    out.push({ path, year, mesCarpeta: mesPorNombre.get(nombre) ?? null })
  }
  return out
}

// PHOTO_YEARS ya sabe dónde vive el archivo de cada año (lo usa la pestaña Fotos). Cualquier
// otro "Trading <año>" entra solo si tiene carpetas Separados, para no arrastrar las capturas
// de Revision, Scenarios o SWING, que no son trades del diario.
function capturasTrades() {
  const out    = []
  const vistos = new Set()
  for (const { year, dir } of PHOTO_YEARS) {
    vistos.add(year)
    out.push(...capturasDelAnio(join(PHOTOS_ROOT, dir), year))
  }

  let entradas
  try { entradas = readdirSync(PHOTOS_ROOT, { withFileTypes: true }) } catch { entradas = [] }
  for (const e of entradas) {
    const m = e.isDirectory() ? e.name.match(/^Trading\s*(\d{4})$/i) : null
    if (!m || vistos.has(Number(m[1]))) continue
    const base = join(PHOTOS_ROOT, e.name)
    const tieneSeparados = walkImages(base, 'collage')
      .some(p => basename(dirname(p)).toLowerCase() === 'separados')
    if (tieneSeparados) out.push(...capturasDelAnio(base, Number(m[1])))
  }
  return out
}

// El recorrido de Drive es lo caro (cientos de carpetas), no los comentarios: se cachea la
// lista de archivos y el JSON de comentarios se relee en cada petición, que es un solo fichero.
let _tradesIndex   = null
let _tradesIndexTs = 0
function getTradesIndex(refrescar = false) {
  if (!refrescar && _tradesIndex && Date.now() - _tradesIndexTs < 10 * 60_000) return _tradesIndex
  _tradesIndex   = capturasTrades()
  _tradesIndexTs = Date.now()
  console.log(`[trades-comentados] índice construido: ${_tradesIndex.length} capturas`)
  return _tradesIndex
}

// Las claves de todos los trades del archivo. Es lo que permite decir si un archivo de un
// book es de un trade conocido o vino de fuera. Se cachea con el mismo índice de capturas.
let _clavesArchivo   = null
let _clavesArchivoTs = 0
function clavesDelArchivo() {
  const capturas = getTradesIndex()
  if (_clavesArchivo && _clavesArchivoTs === _tradesIndexTs) return _clavesArchivo
  _clavesArchivo   = new Set(capturas.map(c => tradeDTO(c, {}).clave))
  _clavesArchivoTs = _tradesIndexTs
  return _clavesArchivo
}

function tradeDTO(captura, comentarios, enBooks) {
  const rel = relative(PHOTOS_ROOT, captura.path)
  const { fecha, instrumento, numero } = parseFotoInfo({ year: captura.year, path: captura.path })
  const anio       = fecha ? fecha.slice(0, 4) : String(captura.year)
  const mes        = fecha ? fecha.slice(5, 7) : captura.mesCarpeta
  const clave      = claveTrade({ rel, fecha, instrumento, anio, numero })
  const anotacion  = anotacionDe(comentarios, clave)
  return {
    // mismo id que sirve /api/fotos/archivo, que ya sabe entregar cualquier foto de Drive
    id:          Buffer.from(rel).toString('base64url'),
    clave,
    nombre:      basename(captura.path),
    anio,
    mes,
    fecha,
    instrumento,
    numero,
    comentario:  anotacion.texto,
    cats:        anotacion.cats,
    revisado:    anotacion.revisado,
    actualizado: anotacion.actualizado,
    // en qué books ya está esta captura, para el botón de un clic
    books:       Object.entries(enBooks ?? {}).filter(([, claves]) => claves.has(clave)).map(([id]) => id),
  }
}

// Lo más reciente primero; dentro de un mes, por fecha e instrumento, y las capturas
// numeradas (2022-2023) por su número, que es su orden real.
function ordenTrades(a, b) {
  return b.anio.localeCompare(a.anio)
    || (b.mes ?? '00').localeCompare(a.mes ?? '00')
    || (b.fecha ?? '').localeCompare(a.fecha ?? '')
    || (a.instrumento ?? '').localeCompare(b.instrumento ?? '')
    || (a.numero ?? '').localeCompare(b.numero ?? '')
}

app.get('/api/trades-comentados/lista', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  try {
    const comentarios = leerComentariosTrades()
    const enBooks     = clavesEnBooks()
    const trades = getTradesIndex(req.query.refrescar === '1')
      .map(c => tradeDTO(c, comentarios, enBooks))
      .sort(ordenTrades)
    res.json({
      carpeta:    PHOTOS_ROOT,
      archivo:    TRADES_COMENTARIOS_PATH,
      total:      trades.length,
      comentados: trades.filter(t => t.comentario).length,
      trades,
    })
  } catch (err) {
    console.error('[trades-comentados/lista]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Comentar un trade. Un comentario vacío borra la entrada del JSON en lugar de dejar basura.
app.put('/api/trades-comentados/comentario', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  try {
    const rel = Buffer.from(String(req.query.id ?? ''), 'base64url').toString('utf8')
    // solo se comenta lo que está en el índice, así un id no puede apuntar fuera del archivo
    const captura = getTradesIndex().find(c => relative(PHOTOS_ROOT, c.path) === rel)
    if (!captura) return res.status(404).json({ error: 'Esa captura no está en el archivo de trades' })

    const texto       = String(req.body?.comentario ?? '').trim()
    const comentarios = leerComentariosTrades()
    const { clave }   = tradeDTO(captura, comentarios, clavesEnBooks())
    // se conservan las etiquetas: el comentario es solo una parte de la anotación
    guardarAnotacion(comentarios, clave, { ...anotacionDe(comentarios, clave), texto })

    res.json({ trade: tradeDTO(captura, comentarios, clavesEnBooks()) })
  } catch (err) {
    console.error('[trades-comentados/comentario]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Etiquetas de los trades, para pintarlas en Operaciones sin pedir la lista entera
app.get('/api/trades-comentados/etiquetas', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  try {
    const comentarios = leerComentariosTrades()
    const anotaciones = {}
    for (const clave of Object.keys(comentarios)) {
      const { texto, cats, revisado } = anotacionDe(comentarios, clave)
      if (texto || cats.length || revisado) anotaciones[clave] = { texto, cats, revisado }
    }
    res.json({ archivo: TRADES_COMENTARIOS_PATH, anotaciones })
  } catch (err) {
    console.error('[trades-comentados/etiquetas]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Anotar un trade desde Operaciones: comentario, etiquetas y revisado. Va por clave de
// trade y no por captura, para poder anotarlo aunque ese día no tenga captura en Drive.
// Lo que no venga en el cuerpo se queda como estaba.
app.put('/api/trades-comentados/etiquetas', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  try {
    const clave = String(req.query.clave ?? '').trim()
    if (!clave || clave.length > 100) return res.status(400).json({ error: 'Clave de trade no válida' })

    const comentarios = leerComentariosTrades()
    const anterior    = anotacionDe(comentarios, clave)
    const anotacion   = guardarAnotacion(comentarios, clave, {
      texto:    req.body?.comentario ?? anterior.texto,
      cats:     req.body?.cats ?? anterior.cats,
      revisado: req.body?.revisado ?? anterior.revisado,
    })
    res.json({ clave, ...anotacion })
  } catch (err) {
    console.error('[trades-comentados/etiquetas]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Diario "DAY <año>" directo desde Google Sheets (solo local) ──
// Evita tener que exportar y subir el .xlsx a mano cada día: lee la misma hoja que
// ya usa TradeNation_sync.py, con la cuenta de servicio ya compartida en esas hojas.
const SHEETS_CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH || 'G:\\Mi unidad\\codigos\\credentials.json'
const DAY_SHEETS = {
  2025: '1UJO0JU0wWXK6AtOp_pdh5YWjHi4b2v98Pp64uZNjwMw',
  2026: '13yrRd9_SGm_T53Gq2OSb_Omt4_T9eFU5FBpthdC_UJk',
}

let _sheetsAuth = null
function getSheetsAuth() {
  if (!_sheetsAuth) {
    _sheetsAuth = new GoogleAuth({
      keyFile: SHEETS_CREDENTIALS_PATH,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    })
  }
  return _sheetsAuth
}

// values.get con valueRenderOption=UNFORMATTED_VALUE + dateTimeRenderOption=SERIAL_NUMBER
// devuelve fechas y números tal cual los guarda Sheets internamente (número de serie estilo
// Excel), exactamente lo mismo que produce la librería xlsx al leer un .xlsx con raw:true —
// así el mismo parser del frontend (parseTrades.js) sirve para ambas fuentes sin cambios.
async function fetchSheetRange(spreadsheetId, sheetName) {
  const auth   = getSheetsAuth()
  const client = await auth.getClient()
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}` +
    '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER'
  const res = await client.request({ url })
  const filas = res.data.values ?? []
  const anchoCabecera = filas[0]?.length ?? 0
  // Sheets recorta las celdas vacías al final de cada fila; se rellena con null para que
  // el índice de columna coincida siempre con el de la cabecera (igual que defval:null).
  return filas.map(fila => {
    if (fila.length >= anchoCabecera) return fila
    return [...fila, ...Array(anchoCabecera - fila.length).fill(null)]
  })
}

// ── Histórico del DAX cash desde el CSV de 5 min (solo local) ──
// El usuario mantiene un CSV de DAX cash a 5 minutos desde 2009 ("el Excel"): sirve para
// probar las estrategias sobre 17 años en vez de sobre las últimas sesiones del feed, que
// además limita por IP. Aquí se agrega a velas de 15 min de sesión (09:00-17:30 Berlín) y
// se cachea en disco, porque parsear 453.000 filas en cada arranque no tiene sentido.
const DAX_CSV   = process.env.DAX_CSV || 'C:\\Users\\Sergio\\Downloads\\DAX CASH MARKET DATA 5min from Feb 2009.csv'
const DAX_CACHE = join(DISK_CACHE_DIR, 'dax15m.json')

// Hora de Berlín -> epoch UTC. El desfase se calcula por día (no fijo) porque marzo y
// octubre cambian la hora, y la app trabaja siempre con timestamps UTC.
function epochBerlin(anio, mes, dia, minutos) {
  const tentativo = Date.UTC(anio, mes - 1, dia, Math.floor(minutos / 60), minutos % 60) / 1000
  const d     = new Date(tentativo * 1000)
  const local = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }))
  const utc   = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }))
  return tentativo - Math.round((local - utc) / 1000)
}

function construirSesionesDax() {
  const crudo = readFileSync(DAX_CSV, 'utf8')
  const porDia = new Map()
  // las de 5 min se guardan aparte: solo se sirven cuando hacen falta para deshacer el
  // empate de una vela de 15 que toca los dos extremos del bracket
  const finasPorDia = new Map()
  for (const linea of crudo.split(/\r?\n/)) {
    if (!linea || linea.startsWith('Date;') || linea.startsWith(';')) continue
    const [fecha, hora, o, h, l, c] = linea.split(';')
    if (!fecha || !hora) continue
    const [hh, mm] = hora.split(':').map(Number)
    const minuto = hh * 60 + mm
    if (minuto < 9 * 60 || minuto >= 17 * 60 + 30) continue   // solo sesión regular
    const open = Number(o), high = Number(h), low = Number(l), close = Number(c)
    if (!Number.isFinite(open) || !Number.isFinite(close)) continue

    if (!porDia.has(fecha)) porDia.set(fecha, new Map())
    if (!finasPorDia.has(fecha)) finasPorDia.set(fecha, [])
    finasPorDia.get(fecha).push({ min: minuto, open, high, low, close })
    const cubos = porDia.get(fecha)
    const ini   = minuto - (minuto % 15)
    const v     = cubos.get(ini)
    if (!v) cubos.set(ini, { min: ini, open, high, low, close })
    else {
      v.high  = Math.max(v.high, high)
      v.low   = Math.min(v.low, low)
      v.close = close
    }
  }

  const sesiones = []
  for (const [fecha, cubos] of porDia) {
    if (cubos.size < 3) continue   // sin dos velas de bracket más una de rotura no hay nada
    const [anio, mes, dia] = fecha.split('-').map(Number)
    const velas = [...cubos.values()]
      .sort((a, b) => a.min - b.min)
      .map(v => ({ time: epochBerlin(anio, mes, dia, v.min), open: v.open, high: v.high, low: v.low, close: v.close }))
    const finas = (finasPorDia.get(fecha) ?? [])
      .sort((a, b) => a.min - b.min)
      .map(v => ({ time: epochBerlin(anio, mes, dia, v.min), open: v.open, high: v.high, low: v.low, close: v.close }))
    sesiones.push({ date: fecha, velas, finas })
  }
  sesiones.sort((a, b) => a.date.localeCompare(b.date))
  return sesiones
}

let _daxSesiones = null
function getSesionesDax() {
  if (_daxSesiones) return _daxSesiones
  const st    = statSync(DAX_CSV)
  const firma = `${st.size}-${Math.round(st.mtimeMs)}`
  try {
    const cache = JSON.parse(readFileSync(DAX_CACHE, 'utf8'))
    if (cache.firma === firma) {
      _daxSesiones = cache.sesiones
      console.log(`[dax] ${_daxSesiones.length} sesiones desde la caché`)
      return _daxSesiones
    }
  } catch { /* sin caché válida: se reconstruye */ }

  const t0 = Date.now()
  _daxSesiones = construirSesionesDax()
  console.log(`[dax] ${_daxSesiones.length} sesiones construidas del CSV en ${Date.now() - t0} ms`)
  try { writeFileSync(DAX_CACHE, JSON.stringify({ firma, sesiones: _daxSesiones })) } catch { /* no crítico */ }
  return _daxSesiones
}

app.get('/api/dax-historico', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  try {
    if (!existsSync(DAX_CSV)) return res.status(404).json({ error: `No se encuentra el CSV: ${DAX_CSV}` })
    const todas = getSesionesDax()
    const desde = String(req.query.desde ?? '')
    const hasta = String(req.query.hasta ?? '')
    const conFinas = req.query.finas === '1'
    const soloEstas = String(req.query.dias ?? '').split(',').filter(Boolean)
    const filtro = new Set(soloEstas)
    const sesiones = todas
      .filter(s => (!desde || s.date >= desde) && (!hasta || s.date <= hasta))
      .filter(s => filtro.size === 0 || filtro.has(s.date))
      // las de 5 min pesan el triple: solo van si se piden, y normalmente para unos días
      .map(s => (conFinas ? s : { date: s.date, velas: s.velas }))
    res.json({
      archivo: DAX_CSV,
      primera: todas[0]?.date ?? null,
      ultima:  todas[todas.length - 1]?.date ?? null,
      total:   sesiones.length,
      sesiones,
    })
  } catch (err) {
    console.error('[dax-historico]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Historial de la cuenta: una sola hoja con TODOS los años (solo local) ──
// El diario "DAY <año>" solo existe para algunos años; esta hoja arranca en 2021 y tiene el
// formato de historial de transacciones del bróker (Transaction.Date / Open.Period), que el
// frontend ya sabe parsear. Sirve para rellenar los años que no tienen diario conectado.
const HISTORIAL_ID      = process.env.HISTORIAL_SHEET_ID  || '123I2L-OQ_uMosVv9oQv991b-bS7Pugqe-g0GBvjav58'
const HISTORIAL_PESTANA = process.env.HISTORIAL_SHEET_TAB || 'Historial Total'

app.get('/api/historial-trades', async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  try {
    const filas = await fetchSheetRange(HISTORIAL_ID, HISTORIAL_PESTANA)
    res.json({ hoja: HISTORIAL_PESTANA, filas })
  } catch (err) {
    console.error('[historial-trades]', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/day-trades/anios', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  res.json({ anios: Object.keys(DAY_SHEETS).map(Number).sort() })
})

app.get('/api/day-trades', async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  const year = Number(req.query.year)
  const spreadsheetId = DAY_SHEETS[year]
  if (!spreadsheetId) return res.status(404).json({ error: `Año ${req.query.year} no conectado a Google Sheets` })

  try {
    const log = await fetchSheetRange(spreadsheetId, String(year))
    let scenarios = []
    try {
      scenarios = await fetchSheetRange(spreadsheetId, 'Scenarios')
    } catch (err) {
      console.warn(`[day-trades] sin hoja "Scenarios" en DAY ${year}:`, err.message)
    }
    res.json({ year, log, scenarios })
  } catch (err) {
    console.error('[day-trades]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Pipeline trading (solo local — en producción lo gestionan GitHub Actions) ──
const TRADING_DIR = process.env.TRADING_DIR || 'G:\\Mi unidad\\codigos\\Server'
const PIPELINE = [
  { id: 'sync',       label: 'TradeNation Sync',  file: 'TradeNation_sync.py' },
  { id: 'historial',  label: 'Historial Total',    file: 'actualizar_historial_total.py' },
  { id: 'charts',     label: 'Chart Capture',      file: 'chart_capture.py' },
  { id: 'collage',    label: 'Collage',            file: 'collage.py' },
  { id: 'separador',  label: 'Separador Gráficos', file: 'separador_graficos.py' },
]

// Construye los args extra para cada script según los params recibidos
function buildArgs(scriptId, params) {
  const extra = []
  if (scriptId === 'collage' || scriptId === 'separador' || scriptId === 'all') {
    if (params.month !== undefined) extra.push('--month', String(params.month))
  }
  if (scriptId === 'charts' || scriptId === 'all') {
    if (params.year)  extra.push('--year', String(params.year))
    if (params.yes)   extra.push('--yes')
  }
  return extra
}

app.get('/api/pipeline/run', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()
    res.write(`event: error\ndata: ${JSON.stringify({ msg: 'Pipeline no disponible en producción — los scripts se ejecutan automáticamente vía GitHub Actions' })}\n\n`)
    res.end()
    return
  }
  const scriptId = req.query.script ?? 'all'
  const params   = {
    month: req.query.month !== undefined ? Number(req.query.month) : undefined,
    year:  req.query.year  ? Number(req.query.year)  : undefined,
    yes:   req.query.yes === '1',
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)

  const toRun = scriptId === 'all' ? PIPELINE : PIPELINE.filter(s => s.id === scriptId)
  if (toRun.length === 0) { send('error', { msg: `Script '${scriptId}' no encontrado` }); res.end(); return }

  let aborted = false
  let currentProc = null
  req.on('close', () => { aborted = true; currentProc?.kill() })

  let idx = 0
  function runNext() {
    if (aborted || idx >= toRun.length) {
      if (!aborted) send('done', { msg: 'Pipeline completado' })
      res.end()
      return
    }
    const { label, file, id } = toRun[idx++]
    send('start', { label })

    const extraArgs = buildArgs(scriptId === 'all' ? id : scriptId, params)
    const extraEnv  = {}
    if (id === 'collage' && params.month !== undefined) extraEnv.COLLAGE_MONTH = String(params.month)
    const proc = spawn('python', ['-X', 'utf8', '-u', file, ...extraArgs], { cwd: TRADING_DIR, env: { ...process.env, ...extraEnv }, shell: true })
    currentProc = proc

    proc.stdout.on('data', chunk => send('line', { text: chunk.toString() }))
    proc.stderr.on('data', chunk => send('line', { text: chunk.toString() }))
    proc.on('close', code => {
      if (code !== 0 && scriptId === 'all') {
        send('error', { msg: `${label} falló (código ${code}) — pipeline detenido` })
        res.end()
        return
      }
      send('end', { label, code })
      runNext()
    })
    proc.on('error', err => { send('error', { msg: `Error al lanzar ${label}: ${err.message}` }); res.end() })
  }

  runNext()
})

// Sin dirección: Node escucha en :: y en 0.0.0.0 a la vez. Atando solo a IPv4, Windows
// resuelve `localhost` primero a ::1, no encuentra a nadie y cada cliente nuevo pagaba
// ~200 ms de reintento antes de caer a 127.0.0.1.
app.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}`)
  // Pre-calentar caché Dukascopy H1 en segundo plano para evitar timeouts en primera petición
  ;(async () => {
    for (const instrument of Object.values(DUKASCOPY_DAILY)) {
      try { await obtenerVelasDiariasDesde30m(instrument) }
      catch (e) { console.warn(`[warmup] ${instrument}:`, e.message) }
    }
    console.log(`[warmup] Caché Dukascopy H1 lista (transporte ${estadoTransporteDukascopy().modo.toUpperCase()})`)
  })().catch(() => {})
})
