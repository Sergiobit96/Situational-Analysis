import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { getHistoricalRates } from 'dukascopy-node'
import { instalarTransporteDukascopy, estadoTransporteDukascopy, dukascopyLimitando, revalidarTransporteDukascopy } from './dukascopy-transport.js'
import { getEventIndex, getEventosEnFecha } from './eventos.js'
import {
  TEMPORALIDADES, YAHOO, agruparVelas, agruparPorSesion, paginaAnteriorA, inicioDiaMadrid, ventanaYahoo,
} from './velas-grafico.js'
import { limpiarDibujos, claveValida } from './dibujos.js'
import { crearIG, IG_RESOLUCION, epicDeMercadoIg, intervalosPendientes } from './ig.js'
import { crearGrabacion, inicioCubo, tramosEnteros } from './grabacion-directo.js'
import { crearMt5, simbolosDeEnv } from './mt5.js'
import { limpiarDiario, totalDiario } from './diario-fortalezas.js'
import { suscribir, resumenTiempoReal, escucharFuente } from './tiempo-real.js'
import { crearBot, RULE_OF_4 } from './bot-srs.js'
import { crearCalendarioFomc } from './calendario-fomc.js'
import { crearBotTortugas, MERCADOS_TORTUGAS, diariasDeSesiones, sesionesQueFaltan } from './bot-tortugas.js'
import { fechaEnZona } from './zonas.js'
import { crearClaveBot } from './clave-bot.js'
import { crearVigilancia, crearAvisoErrores, medirBucle } from './vigilancia.js'
import { crearTelegram } from './telegram.js'
import { VERSION_EXCURSION, claveExcursion, tramoDe, calcularExcursion, ladoDe, aUtc } from './excursiones.js'
import { INDICE_YAHOO, parsearCsvYahoo, velasYahooDeOperacion } from './velas-yahoo.js'
import { crearAccionesEeuu, MAX_POR_PETICION as MAX_ACCIONES_PETICION } from './acciones-eeuu.js'
import { crearFuturosTortugas } from './futuros-tortugas.js'
import { gzipSync } from 'zlib'
import Anthropic from '@anthropic-ai/sdk'
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
const PRODUCCION = process.env.NODE_ENV === 'production'

// Quién puede llamar al servidor desde otra web: solo las páginas de este PC (en local, las
// pestañas hablan con localhost:3001 directamente desde :5173). En producción no hace falta
// nadie más: el navegador llega por el dominio de Vercel, que reenvía /api aquí. CORS_ORIGENES
// añade otros orígenes, separados por comas.
const ORIGENES_EXTRA = (process.env.CORS_ORIGENES || '').split(',').map(s => s.trim()).filter(Boolean)
const origenPermitido = origen => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origen) || ORIGENES_EXTRA.includes(origen)
const origenDe = url => { try { return new URL(url).origin } catch { return '' } }
app.use(cors({ origin: (origen, cb) => cb(null, !origen || origenPermitido(origen)) }))
// CORS solo impide leer la respuesta: una web cualquiera abierta en el navegador aún podría
// lanzar peticiones a localhost:3001 con un <img> o un formulario (y arrancar el pipeline).
// Los navegadores marcan esas peticiones con Sec-Fetch-Site: cross-site.
app.use((req, res, next) => {
  if (req.get('sec-fetch-site') !== 'cross-site' || origenPermitido(req.get('origin') || origenDe(req.get('referer')))) return next()
  res.status(403).json({ error: 'Petición desde otra web' })
})

// Todo lo del bot y de IG pide la clave del bot en producción (ver server/clave-bot.js), y
// antes de leer el cuerpo: sin clave no se llega a leer nada
const claveBot = crearClaveBot({ token: process.env.BOT_TOKEN || '', produccion: PRODUCCION })
const claveBotValida = claveBot.valida
app.use(['/api/bot', '/api/ig', '/api/tiempo-real'], claveBot.middleware)

// En producción, cuerpos de 1 MB como mucho: uno de 50 MB que cualquiera mande ocupa cientos
// de MB al leerlo, y quedarse sin memoria tumba también a los bots. /api/export-ppt lee el suyo
// (un PNG en base64 por coincidencia) con su propio límite, después de pedir la clave.
const leerJson = express.json({ limit: PRODUCCION ? '1mb' : '50mb' })
app.use((req, res, next) => (req.path === '/api/export-ppt' ? next() : leerJson(req, res, next)))

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
        // rango del día anterior: con él se puede mirar si la sesión abre fuera de lo que
        // hizo ayer, que es otro de los filtros de Estrategias
        prevHigh:  prev.high,
        prevLow:   prev.low,
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

// En producción pide la clave del bot: es la única ruta abierta que acepta 50 MB
app.post('/api/export-ppt', claveBot.middleware, express.json({ limit: '50mb' }), async (req, res) => {
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

// Cada año guarda las capturas en una carpeta distinta con convenciones distintas. En todos
// manda la subcarpeta "Separados" (el recorte por instrumento) cuando existe, y la captura
// del día completo solo entra para los días que aún no se han separado a mano
const PHOTO_YEARS = [
  { year: 2022, dir: 'Trading 2022\\Trades 2022' },
  { year: 2023, dir: 'Trading 2023\\DAY' },
  { year: 2024, dir: 'Trading 2024\\Trades' },
  { year: 2025, dir: 'Trading 2025\\Trades' },
  { year: 2026, dir: 'Trading 2026\\Trades' },
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

// Las capturas de un año para la pestaña Fotos, contando cada trade una sola vez. Hay tres
// formas de acabar con el mismo trade dos veces en Drive y las tres se descartan aquí:
//   · la subcarpeta "collage", que es copia exacta de las capturas del día completo;
//   · el día completo de un día que ya está recortado por instrumento en "Separados";
//   · el mismo archivo guardado en dos carpetas: 2023 lo tiene en TODOS y en su mes, y 2025
//     en "Trades/<mes>" y otra vez en "Trades/2025/<mes>". Se queda el primero que aparece.
// Esto solo se hacía con 2026, así que 2023, 2024 y 2025 salían repetidos en el catálogo
// (y con ellos el trade aleatorio, sus filtros y sus recuentos).
function capturasFotos(dir, year) {
  const todas      = walkImages(dir, 'collage')
  const esSeparada = p => basename(dirname(p)).toLowerCase() === 'separados'
  const fechasSeparadas = new Set(
    todas.filter(esSeparada).map(p => parseFotoInfo({ year, path: p }).fecha).filter(Boolean)
  )

  const vistos = new Set()
  const out    = []
  for (const path of todas) {
    const { fecha, instrumento, numero } = parseFotoInfo({ year, path })
    if (!esSeparada(path) && fecha && fechasSeparadas.has(fecha)) continue
    const clave = fecha ? `${fecha}|${instrumento ?? ''}` : `${year}#${numero}`
    if (vistos.has(clave)) continue
    vistos.add(clave)
    out.push(path)
  }
  return out
}

let _photoIndex   = null
let _photoIndexTs = 0
function getPhotoIndex() {
  if (_photoIndex && Date.now() - _photoIndexTs < 10 * 60_000) return _photoIndex
  const all = []
  for (const { year, dir } of PHOTO_YEARS) {
    for (const path of capturasFotos(join(PHOTOS_ROOT, dir), year)) all.push({ year, path })
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

  // 1) convención del archivo: DD-M-YY[_INSTRUMENTO]. El nombre ya identifica el trade,
  // así que vale aunque no haya captura suya en Separados: puede ser el gráfico que la app
  // guardó desde Operaciones para un día que todavía no se ha exportado.
  const { fecha, instrumento } = parseFotoInfo({ year: null, path: nombre })
  if (fecha) return claveTrade({ rel: nombre, fecha, instrumento })

  // 2) numeradas de 2022-2023, que la propia app copia como AAAA_NNNN
  const num = stem.match(/^(\d{4})_(\d+)$/)
  if (num) return `${num[1]}#${num[2]}`

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

// Nombre de archivo para un trade, en la convención del archivo de capturas, para que el
// book pueda seguir sabiendo de qué trade es: '2026-09-25_SILVER' -> '25-9-26_SILVER.png'
// y '2023#0408' -> '2023_0408.png'.
function nombreDesdeClave(clave) {
  const numerado = clave.match(/^(\d{4})#(\d+)$/)
  if (numerado) return `${numerado[1]}_${numerado[2]}.png`
  const m = clave.match(/^(\d{4})-(\d{2})-(\d{2})_(.*)$/)
  if (!m) return null
  const [, anio, mes, dia, instrumento] = m
  const base = `${dia}-${Number(mes)}-${anio.slice(2)}`
  return instrumento ? `${base}_${instrumento}.png` : `${base}.png`
}

// Mandar un trade al book cuando no hay captura suya en Drive: se guarda el gráfico que
// pinta la propia app, con marcas de entrada y salida incluidas.
app.post('/api/books/grafico', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  const book = bookDe(req)
  if (!book) return res.status(400).json({ error: 'Book desconocido' })
  try {
    const clave  = String(req.query.clave ?? '').trim()
    const nombre = clave && clave.length <= 100 ? nombreDesdeClave(clave) : null
    if (!nombre) return res.status(400).json({ error: 'Clave de trade no válida' })

    const m = String(req.body?.imagen ?? '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/)
    if (!m) return res.status(400).json({ error: 'La imagen no llegó en PNG' })
    const bytes = Buffer.from(m[1], 'base64')
    if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) {
      return res.status(400).json({ error: 'Imagen vacía o demasiado grande' })
    }

    mkdirSync(book.dir, { recursive: true })
    const destino  = join(book.dir, nombre)
    const yaEstaba = existsSync(destino)
    if (!yaEstaba) writeFileSync(destino, bytes)
    res.json({ book: book.id, nombre: book.nombre, archivo: nombre, yaEstaba, clave })
  } catch (err) {
    console.error('[books/grafico]', err.message)
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

// ── El diario de operaciones (solo local) ──
// Hasta ahora las operaciones vivían solo en localStorage del navegador: limpiar los datos
// del sitio, o cambiar de navegador, era perderlas. Aquí se guardan junto a los comentarios,
// con la misma escritura atómica (fichero temporal y rename) para que un corte a media
// escritura no deje el JSON a medias. El navegador sigue teniendo su copia como caché.
const TRADES_PATH = process.env.TRADES_DIARIO || join(PHOTOS_ROOT, 'Diario operaciones.json')

function leerTradesDiario() {
  try {
    const d = JSON.parse(readFileSync(TRADES_PATH, 'utf8'))
    return Array.isArray(d?.trades) ? d.trades : []
  } catch { return [] }
}

app.get('/api/trades', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  try {
    const trades = leerTradesDiario()
    res.json({ archivo: TRADES_PATH, total: trades.length, trades })
  } catch (err) {
    console.error('[trades]', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.put('/api/trades', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  try {
    const trades = req.body?.trades
    if (!Array.isArray(trades)) return res.status(400).json({ error: 'Se esperaba { trades: [...] }' })
    // Una lista vacía casi siempre es un error del cliente (un render antes de cargar), y
    // sobreescribiría años de diario: se rechaza salvo que se pida vaciar a propósito.
    const previas = leerTradesDiario()
    if (trades.length === 0 && previas.length > 0 && req.query.vaciar !== '1') {
      return res.status(409).json({ error: `Hay ${previas.length} operaciones guardadas; para borrarlas, vaciar=1` })
    }
    const tmp = `${TRADES_PATH}.tmp`
    writeFileSync(tmp, JSON.stringify({ actualizado: Date.now(), trades }))
    renameSync(tmp, TRADES_PATH)
    res.json({ archivo: TRADES_PATH, total: trades.length })
  } catch (err) {
    console.error('[trades]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Diario de fortalezas y debilidades (pestaña Diario, solo local) ──
// Como el de operaciones: vivía solo en el navegador y limpiar los datos del sitio lo
// borraba. Ahora va a un JSON en Drive y el navegador se queda la copia como caché.
const DIARIO_FD_PATH = process.env.DIARIO_FORTALEZAS || join(PHOTOS_ROOT, 'Diario fortalezas.json')

function leerDiarioFd() {
  try { return limpiarDiario(JSON.parse(readFileSync(DIARIO_FD_PATH, 'utf8'))) }
  catch { return { fortalezas: [], debilidades: [] } }
}

app.get('/api/diario-fortalezas', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  res.json({ archivo: DIARIO_FD_PATH, ...leerDiarioFd() })
})

app.put('/api/diario-fortalezas', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  try {
    let diario
    try { diario = limpiarDiario(req.body) } catch (err) { return res.status(400).json({ error: err.message }) }
    // Vaciarlo entero casi siempre es un cliente que aún no había cargado: se rechaza salvo
    // que se pida a propósito (al borrar la última entrada)
    const previas = totalDiario(leerDiarioFd())
    if (totalDiario(diario) === 0 && previas > 0 && req.query.vaciar !== '1') {
      return res.status(409).json({ error: `Hay ${previas} entradas guardadas; para borrarlas todas, vaciar=1` })
    }
    const tmp = `${DIARIO_FD_PATH}.tmp`
    writeFileSync(tmp, JSON.stringify({ actualizado: Date.now(), ...diario }, null, 2))
    renameSync(tmp, DIARIO_FD_PATH)
    res.json({ archivo: DIARIO_FD_PATH, total: totalDiario(diario) })
  } catch (err) {
    console.error('[diario-fortalezas]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── MFE / MAE de las operaciones del diario (solo local) ──
// Se calculan una vez con las velas de Dukascopy y se guardan junto al diario: la primera
// pasada son ~1.900 días de velas de 1 min y, con el feed limitando por IP, tarda un rato.
// Después solo se calculan las operaciones nuevas. La medida está en server/excursiones.js.
const EXCURSIONES_PATH = process.env.EXCURSIONES_TRADES || join(PHOTOS_ROOT, 'Excursiones trades.json')

let excursiones = null   // clave de operación → resultado; el cálculo escribe sobre este mismo objeto
function excursionesActuales() {
  if (excursiones) return excursiones
  try {
    const d = JSON.parse(readFileSync(EXCURSIONES_PATH, 'utf8'))
    // lo de versiones anteriores se tira: con otra clave nunca volvería a encontrarse
    excursiones = Object.fromEntries(Object.entries(d?.resultados ?? {})
      .filter(([, r]) => r?.v === VERSION_EXCURSION))
  } catch {
    excursiones = {}
  }
  return excursiones
}

function guardarExcursiones() {
  const tmp = `${EXCURSIONES_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify({ actualizado: Date.now(), resultados: excursionesActuales() }))
  renameSync(tmp, EXCURSIONES_PATH)
}

// Lo que falta: operaciones de un instrumento con velas sin resultado de esta versión, y las
// que se quedaron sin lado si ahora se sabe (el del Amount del historial, oct 2026). Con
// `reintentar`, también las que se quedaron sin velas y las medidas con Yahoo, por si
// Dukascopy ya las sirve.
function excursionesPendientes(reintentar = false) {
  const hechas = excursionesActuales()
  return leerTradesDiario().filter(t => {
    if (!YF_TO_DUKASCOPY[t.ticker]) return false
    const r = hechas[claveExcursion(t)]
    if (r?.v !== VERSION_EXCURSION) return true
    if (r.sinDatos === 'sin dirección') return ladoDe(t) != null
    return reintentar && (r.sinDatos === 'sin velas en el tramo' || r.fuente === 'yahoo')
  })
}

// Las velas de 1 y 5 min de Yahoo que deja cada mañana recoger_yahoo.py: la reserva cuando
// Dukascopy no sirve un día que no tiene en caché (ver server/velas-yahoo.js) y, en el
// gráfico de IG, para lo que IG no da. En el servidor online están en el volumen, adonde las
// sube scripts/subir-yahoo.mjs (PUT /api/yahoo/:fichero).
const YAHOO_DIR = process.env.YAHOO_DIR || process.env.YAHOO_1MIN_DIR
  || (process.env.NODE_ENV === 'production' ? (existsSync('/data') ? '/data/yahoo' : join(DISK_CACHE_DIR, 'yahoo')) : 'C:\\Users\\Sergio\\Documents\\Yahoo')
const velasYahooCache = new Map()   // `${ticker}|${intervalo}` → { mtime, velas }
function velasYahooLocales(ticker, intervalo = '1min') {
  const indice = INDICE_YAHOO[ticker]
  if (!indice) return null
  const file = join(YAHOO_DIR, `${indice}_${intervalo}.csv`)
  const clave = `${ticker}|${intervalo}`
  try {
    const mtime = statSync(file).mtimeMs
    const visto = velasYahooCache.get(clave)
    if (visto?.mtime === mtime) return visto.velas
    const velas = parsearCsvYahoo(readFileSync(file, 'utf8'))
    velasYahooCache.set(clave, { mtime, velas })
    return velas
  } catch {
    return null
  }
}

// Si el fichero de 1 min de Dukascopy de ese día ya está en la caché de disco, se lee de ahí
// aunque el feed esté cortado. Es el nombre que le pone dukascopy-node (el mes en base 0).
function diaEnCacheDukascopy(instrument, ts) {
  const d = new Date(ts * 1000)
  const dos = n => String(n).padStart(2, '0')
  const nombre = `${instrument.toUpperCase()}-${d.getUTCFullYear()}-${dos(d.getUTCMonth())}-${dos(d.getUTCDate())}-BID_candles_min_1.bi5`
  return existsSync(join(DUKA_RAW_CACHE_DIR, nombre))
}

const excursionesEstado = {
  activo: false, total: 0, hechas: 0, sinDatos: 0, yahoo: 0, sinFuente: 0, error: null, inicio: null, fin: null,
}

// Cuando el feed corta (429 o caída) se espera y se reintenta la misma operación. Si sigue
// cortado, en esa pasada ya no se le pide nada que no esté en caché: sale de Yahoo, y lo
// que Yahoo no cubre queda pendiente para otra vez.
const ESPERAS_EXCURSION_MS = [15_000, 60_000]

async function calcularExcursiones(reintentar) {
  const resultados = excursionesActuales()
  const diario = leerTradesDiario()
  // de la más reciente a la más antigua: lo último que se ha operado es lo primero que se mira
  const pendientes = excursionesPendientes(reintentar).sort((a, b) => b.openTime - a.openTime)
  Object.assign(excursionesEstado, {
    activo: true, total: pendientes.length, hechas: 0, sinDatos: 0, yahoo: 0, sinFuente: 0,
    error: null, inicio: Date.now(), fin: null,
  })

  // Ejecuciones (entradas y salidas, en UTC) de cada día e instrumento, para medir el
  // desfase del CFD frente al contado de Yahoo. Las horas del diario van en hora de Madrid.
  const ejecuciones = new Map()
  for (const o of diario) {
    const clave = `${o.ticker}|${Math.floor(o.openTime / 86400)}`
    if (!ejecuciones.has(clave)) ejecuciones.set(clave, [])
    ejecuciones.get(clave).push(
      { time: aUtc(o.openTime), precio: o.openPrice },
      { time: aUtc(o.closeTime), precio: o.closePrice },
    )
  }
  const ejecucionesDe = t => ejecuciones.get(`${t.ticker}|${Math.floor(t.openTime / 86400)}`) ?? []

  // Las operaciones de un mismo día comparten fichero de Dukascopy: se lee una vez por
  // instrumento y día en vez de una vez por operación. Un día vacío no se guarda, para que
  // el reintento tras un 429 vuelva a pedirlo.
  let enMemoria = { clave: null, velas: [] }
  const velasDe = async (instrument, tramo) => {
    if (tramo.tf !== 'm1') return obtenerTramoDukascopy(instrument, tramo.tf, tramo.desde, tramo.hasta)
    const dia    = Math.floor(tramo.desde / 86400) * 86400
    // un segundo antes de medianoche: con la medianoche justa se bajaría también el día siguiente
    const finDia = Math.ceil(tramo.hasta / 86400) * 86400 - 1
    const clave  = `${instrument}|${dia}|${finDia}`
    if (enMemoria.clave === clave) return enMemoria.velas
    // un día de 1 min es uno o dos ficheros: el presupuesto de una consulta de un día basta
    const velas = await obtenerTramoDukascopy(instrument, 'm1', dia, finDia, DUKA_TIMEOUT_MS)
    if (velas.length > 0) enMemoria = { clave, velas }
    return velas
  }

  const velasDukascopy = async (instrument, tramo) => {
    for (let intento = 0; ; intento++) {
      try {
        const velas = await velasDe(instrument, tramo)
        // con el feed limitando, un tramo vacío no es "no hay datos" sino un fichero perdido
        if (velas.length === 0 && dukascopyLimitando()) throw new Error('Dukascopy está limitando las peticiones de esta IP (429)')
        return velas
      } catch (err) {
        if (intento >= ESPERAS_EXCURSION_MS.length) throw err
        // si el 443 se ha caído a media tarea, el reintento ya irá por HTTP
        revalidarTransporteDukascopy()
        console.warn(`[excursiones] ${errDetalle(err)}; reintento en ${ESPERAS_EXCURSION_MS[intento] / 1000} s`)
        await new Promise(r => setTimeout(r, ESPERAS_EXCURSION_MS[intento]))
      }
    }
  }

  let dukaCortado = null   // el error con el que Dukascopy dejó de servir en esta pasada
  let sinGuardar = 0
  try {
    for (const t of pendientes) {
      const instrument = YF_TO_DUKASCOPY[t.ticker]
      const tramo = tramoDe(t)
      const enCache = tramo.tf === 'm1' &&
        diaEnCacheDukascopy(instrument, tramo.desde) && diaEnCacheDukascopy(instrument, tramo.hasta - 1)
      excursionesEstado.hechas++

      let velas = null, fuente = 'dukascopy'
      if (enCache || !dukaCortado) {
        try {
          velas = await velasDukascopy(instrument, tramo)
        } catch (err) {
          dukaCortado = err
          console.warn(`[excursiones] Dukascopy no responde (${errDetalle(err)}); lo que no esté en caché sale de Yahoo`)
        }
      }
      // sin Dukascopy, o sin sus velas en ese tramo: las de Yahoo, si cubren la operación entera
      if (!velas?.length) {
        const yahoo = velasYahooDeOperacion(velasYahooLocales(t.ticker), t, ejecucionesDe(t))
        if (yahoo) { velas = yahoo; fuente = 'yahoo' }
      }
      // ni una ni otra: no se guarda nada y queda pendiente para otra pasada
      if (!velas) { excursionesEstado.sinFuente++; continue }

      const r = calcularExcursion(t, velas)
      const deYahoo = fuente === 'yahoo' && !r.sinDatos
      resultados[claveExcursion(t)] = { v: VERSION_EXCURSION, ...r, ...(deYahoo ? { fuente } : {}) }
      if (r.sinDatos) excursionesEstado.sinDatos++
      if (deYahoo) excursionesEstado.yahoo++
      if (++sinGuardar >= 50) { guardarExcursiones(); sinGuardar = 0 }
    }
    if (dukaCortado) {
      const quedan = excursionesEstado.sinFuente
      excursionesEstado.error = `Dukascopy no responde (${errDetalle(dukaCortado)})` +
        (quedan ? `; ${quedan} operaciones que Yahoo no cubre quedan pendientes` : '')
    }
  } catch (err) {
    excursionesEstado.error = errDetalle(err)
    console.error('[excursiones]', excursionesEstado.error)
  } finally {
    try { if (sinGuardar > 0) guardarExcursiones() } catch (err) { excursionesEstado.error = err.message }
    excursionesEstado.activo = false
    excursionesEstado.fin = Date.now()
    console.log(`[excursiones] ${excursionesEstado.hechas} de ${excursionesEstado.total} calculadas`)
  }
}

app.get('/api/excursiones', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  res.json({ resultados: excursionesActuales(), estado: excursionesEstado })
})

app.get('/api/excursiones/estado', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  const pendientes = excursionesEstado.activo
    ? excursionesEstado.total - excursionesEstado.hechas
    : excursionesPendientes().length
  res.json({ ...excursionesEstado, pendientes })
})

// Arranca el cálculo y responde al momento: el progreso se sigue con /api/excursiones/estado
app.post('/api/excursiones/calcular', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  if (!excursionesEstado.activo) {
    calcularExcursiones(req.query.reintentar === '1').catch(err => console.error('[excursiones]', err))
  }
  res.json({ ...excursionesEstado, pendientes: excursionesEstado.total - excursionesEstado.hechas })
})

// ── Revisión del día con Claude (solo local) ──
// El navegador arma el expediente del día (expedienteDelDia en src/estadisticas.js: las
// operaciones con su MFE/MAE, los comentarios, las etiquetas del Book of Horror y lo
// habitual del historial) y aquí solo se le pasa a Claude y se guarda lo que escribe, para no
// pagar dos veces la misma revisión. La clave va en ANTHROPIC_API_KEY de server/.env.
const REVISIONES_PATH = process.env.REVISIONES_DIA || join(PHOTOS_ROOT, 'Revisiones dia.json')
const MODELO_REVISION = 'claude-opus-5-5'

// $ por millón de tokens (entrada, salida), para enseñar lo que costó cada revisión. La de
// respaldo solo entra si Claude Opus 5.5 rechaza la petición.
const PRECIO_POR_MTOK = { 'claude-opus-5-5': [4, 20], 'claude-opus-4-8': [5, 25] }

const PROMPT_REVISION = `Eres quien revisa el diario de un trader discrecional de CFD de índices (DAX, FTSE, Dow, Nasdaq, S&P) y metales, que opera en TradeNation desde Madrid. Te paso el expediente de un día: sus operaciones con la hora de entrada y de salida (hora de Madrid), el resultado en puntos y en euros, el MFE y el MAE de cada una (lo más que llegó a ir ganando y perdiendo mientras estuvo abierta, en puntos), sus comentarios, los errores de proceso que él mismo etiquetó (las categorías de su "Book of Horror") y sus cifras habituales de todo el historial.

Escribe una revisión breve del día, en español y de tú, para leerla al acabar la sesión:
- Juzga el proceso, no el resultado: un día en verde puede estar mal operado y uno en rojo bien operado.
- Compara con lo habitual solo cuando la diferencia sea clara, y da la cifra.
- Cita las operaciones por instrumento y hora.
- No inventes nada que no esté en el expediente. Si falta algo para opinar (por ejemplo, no hay comentarios), dilo en una línea.
- El MFE y el MAE salen de otra fuente de precios y tienen 1-3 puntos de margen, más si vienen de Yahoo: no saques conclusiones de diferencias menores que eso.

Texto plano, sin títulos ni negritas, en cuatro bloques cortos separados por una línea en blanco: qué pasó; qué fue distinto de lo habitual; lo mejor y lo peor del proceso, con la operación concreta; y una sola cosa a vigilar en la próxima sesión. Como mucho 220 palabras.`

let clienteClaude = null
// Se crea al primer uso: sin clave, el constructor lanza, y el resto del servidor no la necesita
const claude = () => (clienteClaude ??= new Anthropic())

function leerRevisiones() {
  try {
    const d = JSON.parse(readFileSync(REVISIONES_PATH, 'utf8'))
    return d?.revisiones && typeof d.revisiones === 'object' ? d.revisiones : {}
  } catch {
    return {}
  }
}

function guardarRevision(fecha, revision) {
  const revisiones = { ...leerRevisiones(), [fecha]: revision }
  const tmp = `${REVISIONES_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify({ revisiones }, null, 2))
  renameSync(tmp, REVISIONES_PATH)
}

const FECHA_VALIDA = /^\d{4}-\d{2}-\d{2}$/

app.get('/api/revision-dia', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  const fecha = String(req.query.fecha ?? '')
  if (!FECHA_VALIDA.test(fecha)) return res.status(400).json({ error: 'fecha con formato AAAA-MM-DD' })
  res.json({ revision: leerRevisiones()[fecha] ?? null })
})

app.post('/api/revision-dia', async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  const { fecha, expediente } = req.body ?? {}
  if (!FECHA_VALIDA.test(String(fecha ?? ''))) return res.status(400).json({ error: 'fecha con formato AAAA-MM-DD' })
  if (!expediente || !Array.isArray(expediente.operaciones) || expediente.operaciones.length === 0) {
    return res.status(400).json({ error: 'Ese día no tiene operaciones que revisar' })
  }

  try {
    const respuesta = await claude().beta.messages.create({
      model: MODELO_REVISION,
      max_tokens: 16000,
      // el pensamiento adaptativo va siempre activo en este modelo; el esfuerzo por defecto es
      // medium, y para juzgar un día de operaciones compensa uno más
      output_config: { effort: 'high' },
      // si Claude Opus 5.5 rechaza la petición, la repite Claude Opus 4.8 en la misma llamada
      betas: ['server-side-fallback-2026-06-01'],
      fallbacks: [{ model: 'claude-opus-4-8' }],
      system: PROMPT_REVISION,
      messages: [{ role: 'user', content: `Expediente del día:\n\n${JSON.stringify(expediente, null, 2)}` }],
    })

    if (respuesta.stop_reason === 'refusal') {
      return res.status(502).json({ error: 'Claude no ha querido hacer esta revisión' })
    }
    const texto = respuesta.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
    if (!texto || respuesta.stop_reason === 'max_tokens') {
      return res.status(502).json({ error: 'La revisión llegó vacía o cortada; prueba otra vez' })
    }

    const { input_tokens: entrada = 0, output_tokens: salida = 0 } = respuesta.usage ?? {}
    const [pe, ps] = PRECIO_POR_MTOK[respuesta.model] ?? PRECIO_POR_MTOK[MODELO_REVISION]
    const revision = {
      texto,
      modelo: respuesta.model,
      generada: new Date().toISOString(),
      tokens: { entrada, salida },
      usd: Math.round((entrada * pe + salida * ps) / 1e6 * 10000) / 10000,
    }
    guardarRevision(fecha, revision)
    res.json({ revision })
  } catch (err) {
    console.error('[revision-dia]', err.message)
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(401).json({ error: 'La clave de Anthropic de server/.env no es válida' })
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Anthropic está limitando las peticiones; prueba en un minuto' })
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return res.status(502).json({ error: 'No se pudo conectar con Anthropic' })
    }
    if (err instanceof Anthropic.APIError) {
      return res.status(502).json({ error: `Anthropic respondió ${err.status}: ${err.message}` })
    }
    // sin ANTHROPIC_API_KEY el SDK lanza al crear el cliente
    res.status(500).json({ error: process.env.ANTHROPIC_API_KEY ? err.message : 'Falta ANTHROPIC_API_KEY en server/.env' })
  }
})

// Lo que hay escrito sobre un trade: su comentario, sus etiquetas (las 13 categorías del
// Book of Horror, por número) y si ya está revisado. Todo en la misma anotación, para que
// respaldar ese JSON respalde el trabajo entero.
const CATEGORIAS_BOH = 13

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

// ── Pestaña Gráfico: velas por páginas, de la más reciente hacia atrás ──
// El gráfico pide la última página al abrirse y la anterior a su vela más antigua cada vez
// que el usuario se acerca al borde izquierdo. Dos fuentes:
//   · duka: el CFD de Dukascopy, 24 h y con años de histórico, para todos los instrumentos;
//   · csv:  el CSV del DAX cash a 5 min (solo local), solo sesión y sin velas de 1 min.

// Velas del CSV del DAX por temporalidad, agrupadas una vez: son 450.000 de 5 min y cada
// página del gráfico es solo un trozo
const VELAS_POR_PAGINA_CSV = 1500
const APERTURA_DAX_MIN     = 9 * 60
const _daxPorTf = new Map()
function velasCsvDax(tf) {
  const sesiones = getSesionesDax()
  const hecho = _daxPorTf.get(tf)
  if (hecho?.sesiones === sesiones) return hecho.velas
  const finas   = sesiones.flatMap(s => s.finas ?? [])
  const minutos = TEMPORALIDADES[tf].minutos
  // la diaria va de medianoche a medianoche, como la de Dukascopy, para que lleve la fecha sin hora
  const velas   = agruparVelas(finas, minutos, minutos >= 1440 ? 0 : APERTURA_DAX_MIN)
  _daxPorTf.set(tf, { sesiones, velas })
  return velas
}

// Un tramo de Dukascopy entre dos instantes. Lo cerrado (antes de hoy UTC) va a la caché
// de .bi5; lo de hoy se baja siempre, porque el fichero del día sigue creciendo y
// cachearlo congelaría la sesión a medias.
async function obtenerTramoDukascopy(instrument, timeframe, desde, hasta, timeoutMs = DUKA_TIMEOUT_HISTORICO_MS) {
  const hoy    = Math.floor(Date.now() / 86400_000) * 86400
  // Del sábado al domingo por la tarde (UTC) no cotiza nada de lo que hay aquí: índices,
  // metales y petróleo abren el domingo a partir de las 21:00-23:00 UTC. Lo de hoy serían
  // hasta una veintena de ficheros horarios vacíos, y cada petición de más acerca el 429.
  const ahora   = new Date()
  const cerrado = ahora.getUTCDay() === 6 || (ahora.getUTCDay() === 0 && ahora.getUTCHours() < 20)
  const tramos  = []
  if (desde < Math.min(hasta, hoy)) tramos.push({ desde, hasta: Math.min(hasta, hoy), useCache: true })
  if (hasta > hoy && !cerrado) tramos.push({ desde: Math.max(desde, hoy), hasta, useCache: false })

  const velas = []
  for (const t of tramos) {
    const data = await dukaFetch({
      instrument, timeframe,
      dates: { from: new Date(t.desde * 1000), to: new Date(t.hasta * 1000) },
      useCache: t.useCache,
      cacheFolderPath: DUKA_RAW_CACHE_DIR,
    }, timeoutMs)
    for (const [ms, open, high, low, close] of data) {
      const time = Math.floor(ms / 1000)
      if (time >= t.desde && time < t.hasta) velas.push({ time, open, high, low, close })
    }
  }
  return velas
}

// Páginas vacías seguidas antes de dar el histórico por terminado: un fin de semana largo
// deja vacía una página de 1 min, pero cuatro seguidas ya es que no hay más datos
const PAGINAS_VACIAS_MAX = 4

// MetaTrader 5 (server/mt5.js): solo en local y en Windows, que es donde están el terminal y
// el paquete de Python. Python y el terminal arrancan con la primera petición, no aquí.
const mt5 = process.env.NODE_ENV !== 'production' && process.platform === 'win32' && process.env.MT5 !== '0'
  ? crearMt5({ python: process.env.MT5_PYTHON || 'python', simbolos: simbolosDeEnv(process.env.MT5_SIMBOLOS) })
  : null

// Una página del gráfico de IG. Lo grabado del directo (ver la grabación, más abajo) sale de
// disco sin gastar cupo; los ratos sin grabar, del histórico de IG, y si IG no lo da (sin
// cupo, casi siempre), de Dukascopy y de Yahoo (ver respaldo).
//
// IG se deja de pedir media hora si dice que no queda cupo, y un minuto si va muy deprisa:
// cada petición, aunque falle, cuenta en el límite por minuto que comparten los bots.
// El gráfico no gasta los últimos RESERVA_CUPO_TORTUGAS puntos del cupo semanal: son para el
// bot de las tortugas, que saca de ahí los niveles de las materias primas (unas 160 velas por
// mercado la primera vez y una al día después; el 18-oct-2026 el gráfico agotó el cupo y las
// doce se quedaron sin plan).
let igHistoricoParado = { hasta: 0, error: null }
const RESERVA_CUPO_TORTUGAS = 2500

// Un mercado suelto de IG (ig:EPIC) que es uno de los fijos, o la misma divisa con otro
// tamaño de contrato (CS.D.EURUSD.CFD.IP y CS.D.EURUSD.CECM.IP cotizan igual), tira de lo
// grabado y del respaldo de ese fijo. No los que IG da en otra unidad (`escala`: la plata y
// el crudo, en centavos): su histórico de IG de suelto va sin pasar a dólares. Devuelve el
// ticker fijo, o null si es un suelto sin equivalente.
function fijoDeIg(ticker) {
  const epic = epicDeMercadoIg(ticker)
  if (!epic) return ticker
  const epics = ig?.estado().epics ?? {}
  const sinEscala = t => epics[t] && !(epics[t].escala && epics[t].escala !== 1)
  const mismo = Object.keys(epics).find(t => epics[t].epic === epic)
  if (mismo) return sinEscala(mismo) ? mismo : null
  const divisa = epic.match(/^CS\.D\.([A-Z]{6})\.[A-Z0-9]+\.IP$/)?.[1]
  return divisa && sinEscala(divisa) && epics[divisa].epic.startsWith(`CS.D.${divisa}.`) ? divisa : null
}

async function velasIg(tickerPedido, tf, inicio, fin) {
  const { minutos } = TEMPORALIDADES[tf]
  const { res: resolucion } = IG_RESOLUCION[tf]
  // lo de IG va con el ticker pedido (su epic); lo grabado y el respaldo, con el del fijo
  const ticker = fijoDeIg(tickerPedido)
  const trozos = []
  const partes = new Set()
  let aviso = null
  let error = null
  let sinIg = false
  let conDuka = false

  const grabados = []
  if (grabacion && ticker) {
    for (const [a, b] of tramosEnteros(grabacion.cubiertos(ticker), minutos)) {
      const x = Math.max(a, inicio), y = Math.min(b, fin)
      if (x < y) grabados.push([x, y])
    }
  }
  for (const [a, b] of grabados) {
    const velas = grabacion.velas(ticker, minutos, a, b)
    if (velas.length) { trozos.push(velas); partes.add('directo grabado') }
  }

  for (const [a, b] of intervalosPendientes(grabados, inicio, fin)) {
    try {
      if (Date.now() < igHistoricoParado.hasta) throw igHistoricoParado.error
      const velas = await ig.velasEntre(tickerPedido, tf, a, b, { reservar: RESERVA_CUPO_TORTUGAS })
      if (velas.length) { trozos.push(velas); partes.add(`histórico ${resolucion}`) }
    } catch (err) {
      if (Date.now() >= igHistoricoParado.hasta) {
        if (/cupo semanal/.test(err.message)) igHistoricoParado = { hasta: Date.now() + 30 * 60_000, error: err }
        else if (/limita las peticiones/.test(err.message)) igHistoricoParado = { hasta: Date.now() + 60_000, error: err }
      }
      sinIg = true
      const r = ticker ? await respaldo(ticker, tf, a, b) : { velas: [], partes: [], conDuka: false }
      conDuka ||= r.conDuka
      if (!r.velas.length) { error = err; aviso ??= err.message; continue }
      trozos.push(r.velas)
      for (const p of r.partes) partes.add(p)
      const otras = r.partes.filter(p => p !== 'directo grabado')
      aviso = otras.length
        ? `${err.message}: lo no grabado sale de ${otras.join(' y ')}${otras.includes('contado de Yahoo') ? ' (solo la sesión)' : ''}`
        : err.message
    }
  }

  const porHora = new Map()
  for (const v of trozos.flat()) if (!porHora.has(v.time)) porHora.set(v.time, v)
  const velas = [...porHora.values()].sort((a, b) => a.time - b.time)
  return {
    velas, aviso, error,
    fuente: `IG (${[...partes].join(' + ') || `histórico ${resolucion}`})`,
    // sin IG ni Dukascopy, una página vacía (un fin de semana, con Yahoo, que solo trae la
    // sesión) se salta de una vez hasta lo último que haya antes. Dukascopy va 24 h: con él,
    // saltar se comería lo que tiene fuera de la sesión.
    previa: ticker && sinIg && !conDuka && !velas.length ? previaSinIg(ticker, inicio) : null,
  }
}

// La hora de lo último grabado o de Yahoo antes de `t`, o null si no hay nada
function previaSinIg(ticker, t) {
  const candidatas = []
  for (const intervalo of ['1min', '5min']) {
    const velas = velasYahooLocales(ticker, intervalo) ?? []
    let lo = 0, hi = velas.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (velas[m].time < t) lo = m + 1; else hi = m }
    if (lo > 0) candidatas.push(velas[lo - 1].time)
  }
  if (grabacion) {
    const tramo = grabacion.cubiertos(ticker).filter(([a]) => a < t).at(-1)
    if (tramo) candidatas.push(Math.min(tramo[1], t) - 60)
  }
  return candidatas.length ? Math.max(...candidatas) : null
}

// Segundos por vela de cada serie de Dukascopy (TEMPORALIDADES[tf].duka)
const SEGUNDOS_SERIE = { m1: 60, m5: 300, m15: 900, m30: 1800, h1: 3600 }

// Lo que hay en Dukascopy para el respaldo del gráfico de IG: los índices y metales de
// YF_TO_DUKASCOPY, sin el crudo, que es otro contrato (60 dólares por debajo), y las divisas,
// a menos de un pip de IG (medido el 19-oct-2026; es medio diferencial: IG da el precio
// medio y Dukascopy el de compra). Las materias primas no: cada una lleva su propio desfase
// fijo, de otro vencimiento (del −2,5 % del café al +6,3 % del gas), y el azúcar va en otra
// unidad.
const DUKA_RESPALDO_IG = {
  ...Object.fromEntries(Object.entries(YF_TO_DUKASCOPY).filter(([t]) => t !== 'USOIL')),
  EURUSD: 'eurusd', GBPUSD: 'gbpusd', USDJPY: 'usdjpy', AUDUSD: 'audusd', USDCAD: 'usdcad', USDCHF: 'usdchf',
}

// Lo que IG no da de [a, b), agrupado con la rejilla del gráfico, de la mejor fuente a la
// peor, cada una desde donde se acaba la anterior:
//   · el CFD de Dukascopy (DUKA_RESPALDO_IG): 24 h y años de histórico, a la par del de IG
//     (medido a 5 min en oct-2026: DAX +1,0 de media, S&P +0,3, Nasdaq −0,6, FTSE +0,3,
//     Russell +0,2, oro +0,3) salvo en el Dow (+8) y el Nikkei (+38). Va una hora por detrás;
//   · el contado de Yahoo de la carpeta de recoger_yahoo.py: solo la sesión (Dow +4, sin
//     Nikkei), de 1 min y, más atrás, de 5;
//   · y lo grabado del directo, desde su primera vela.
// `conDuka`: Dukascopy contestó (un 429 llega como velas vacías y no cuenta).
async function respaldo(ticker, tf, a, b) {
  const conf = TEMPORALIDADES[tf]
  const partes = []
  let crudas = []
  let conDuka = false
  const instrument = DUKA_RESPALDO_IG[ticker]
  if (instrument && !dukaCaido()) {
    try {
      crudas = await obtenerTramoDukascopy(instrument, conf.duka, a, b)
      conDuka = crudas.length > 0 || !dukascopyLimitando(DUKA_CIRCUITO_MS)
    } catch (err) { marcarDukaCaido(err) }
    if (crudas.length) partes.push('Dukascopy')
  }
  const desde = crudas.length ? crudas[crudas.length - 1].time + SEGUNDOS_SERIE[conf.duka] : a
  const grabadas = grabacion ? grabacion.m1Entre(ticker, desde, b) : []
  const hastaGrabadas = grabadas[0]?.time ?? b
  const entre = velas => (velas ?? []).filter(v => v.time >= desde && v.time < hastaGrabadas)
  const de1 = entre(velasYahooLocales(ticker, '1min'))
  const de5 = conf.minutos >= 5 ? entre(velasYahooLocales(ticker, '5min')).filter(v => v.time < (de1[0]?.time ?? hastaGrabadas)) : []
  if (de1.length + de5.length) partes.push('contado de Yahoo')
  if (grabadas.length) partes.push('directo grabado')
  return { velas: agruparVelas([...crudas, ...de5, ...de1, ...grabadas], conf.minutos), partes, conDuka }
}

app.get('/api/grafico/velas', async (req, res) => {
  const { ticker, tf = 'm15', fuente = 'duka' } = req.query
  const conf = TEMPORALIDADES[tf]
  if (!conf) return res.status(400).json({ error: `Temporalidad desconocida: ${tf}` })
  const ahora = Math.floor(Date.now() / 1000)
  const hasta = Math.min(Number(req.query.hasta) || ahora, ahora)

  try {
    if (fuente === 'csv') {
      if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'El CSV del DAX solo está en local' })
      if (ticker !== '^GDAXI') return res.status(400).json({ error: 'El CSV solo tiene el DAX' })
      if (tf === 'm1') return res.status(400).json({ error: 'El CSV del DAX va a 5 minutos: no hay velas de 1 min' })
      if (!existsSync(DAX_CSV)) return res.status(404).json({ error: `No se encuentra el CSV: ${DAX_CSV}` })
      const { velas, hayMas } = paginaAnteriorA(velasCsvDax(tf), hasta, VELAS_POR_PAGINA_CSV)
      return res.json({ ticker, tf, fuente: 'CSV DAX cash 5m', velas, hayMas })
    }

    if (fuente === 'ig') {
      // el histórico de IG gasta su cupo semanal: en producción, solo con la clave del bot
      if (!claveBotValida(req)) return res.status(401).json({ error: 'Clave del bot incorrecta', necesitaClave: true })
      if (!ig) return res.status(404).json({ error: `IG no está configurado: faltan ${IG_FALTAN.join(', ')} en server/.env` })
      const { diasPagina, res: resolucion } = IG_RESOLUCION[tf]
      let fin = hasta
      let error = null
      // las páginas de IG son cortas para no quemar su cupo; sin IG, las de Dukascopy
      const dias = Date.now() < igHistoricoParado.hasta ? Math.max(diasPagina, conf.diasPagina) : diasPagina
      for (let i = 0; i < PAGINAS_VACIAS_MAX; i++) {
        // en velas enteras: lo grabado se agrupa aquí, y una vela partida entre dos páginas
        // se quedaría con la mitad
        const inicio = inicioCubo(Math.floor(fin - dias * 86400), conf.minutos)
        const r = await velasIg(ticker, tf, inicio, fin)
        if (r.velas.length > 0) {
          const { cupo } = ig.estado()
          const avisoCupo = cupo && cupo.remainingAllowance < 1000 ? `quedan ${cupo.remainingAllowance} puntos de histórico de IG esta semana` : null
          return res.json({ ticker, tf, fuente: r.fuente, velas: r.velas, hayMas: true, aviso: r.aviso ?? avisoCupo, directo: true })
        }
        error = r.error ?? error
        fin = r.previa != null && r.previa < inicio ? r.previa + 60 : inicio
      }
      // al ir hacia atrás, el gráfico ya tiene velas: mejor decirle dónde se acaba que un error
      if (error && !req.query.hasta) throw error
      return res.json({ ticker, tf, fuente: `IG ${resolucion}`, velas: [], hayMas: false, aviso: error?.message ?? null, directo: true })
    }

    if (fuente === 'mt5') {
      if (!mt5) return res.status(404).json({ error: 'MetaTrader 5 solo está en local, con el terminal instalado' })
      const simbolo = mt5.simboloDe(ticker)
      if (!simbolo) return res.status(400).json({ error: `MetaTrader 5 no tiene ${ticker}` })
      // de MT5 se pide la misma serie que de Dukascopy (la de 4 h y la diaria, la horaria) y se
      // agrupa en hora de Madrid: las suyas de 4 h y diarias van con la hora del bróker
      let fin = hasta
      for (let i = 0; i < PAGINAS_VACIAS_MAX; i++) {
        const inicio = inicioDiaMadrid(fin - conf.diasPagina * 86400)
        const { velas: crudas, previa } = await mt5.pagina(ticker, conf.duka, inicio, fin)
        if (crudas.length > 0) {
          const velas = agruparVelas(crudas, conf.minutos)
          return res.json({ ticker, tf, fuente: `MT5 ${simbolo} ${conf.duka}`, velas, hayMas: previa != null, directo: true })
        }
        // un hueco de semanas (le faltan del 16-jul al 5-sep-2025) se salta de una vez hasta
        // la última vela que haya antes
        if (previa == null) break
        fin = previa + 1
      }
      return res.json({ ticker, tf, fuente: `MT5 ${simbolo} ${conf.duka}`, velas: [], hayMas: false, directo: true })
    }

    if (fuente === 'yahoo') {
      // los índices son el contado; oro, plata y petróleo, el futuro (Yahoo no da el spot)
      const simbolo  = DUKA_TO_YF_FALLBACK[YF_TO_DUKASCOPY[ticker]] ?? ticker
      const etiqueta = v => `Yahoo ${v.intervalo}${simbolo !== ticker ? ` (${simbolo})` : ''}`
      let fin = hasta
      for (let i = 0; i < PAGINAS_VACIAS_MAX; i++) {
        const v = ventanaYahoo(tf, fin, ahora)
        if (!v) break
        const crudas = await obtenerRangoYahoo(simbolo, v.intervalo, v.desde, v.hasta)
        if (crudas.length > 0 || v.alLimite) {
          const velas = tf === 'd1' ? agruparVelas(crudas, 1440) : agruparPorSesion(crudas, conf.minutos)
          return res.json({ ticker, tf, fuente: etiqueta(v), velas, hayMas: !v.alLimite, aviso: v.aviso })
        }
        fin = v.desde
      }
      return res.json({ ticker, tf, fuente: `Yahoo ${YAHOO[tf].intervalo}`, velas: [], hayMas: false, aviso: YAHOO[tf].aviso })
    }

    const instrument = YF_TO_DUKASCOPY[ticker]
    if (!instrument) return res.status(400).json({ error: `Sin datos de Dukascopy para ${ticker}` })
    if (dukaCaido()) {
      const error = dukascopyLimitando(DUKA_CIRCUITO_MS)
        ? 'Dukascopy está limitando las peticiones de esta IP (429); prueba en unos minutos'
        : 'Dukascopy no responde ahora mismo; prueba en unos minutos'
      return res.status(503).json({ error })
    }

    // Las páginas se cortan en la medianoche de Madrid para no partir una vela de 4 h o diaria
    let fin = hasta
    for (let i = 0; i < PAGINAS_VACIAS_MAX; i++) {
      const inicio = inicioDiaMadrid(fin - conf.diasPagina * 86400)
      const crudas = await obtenerTramoDukascopy(instrument, conf.duka, inicio, fin)
      if (crudas.length > 0) {
        const velas = agruparVelas(crudas, conf.minutos)
        return res.json({ ticker, tf, fuente: `Dukascopy ${conf.duka}`, velas, hayMas: true })
      }
      fin = inicio
    }
    res.json({ ticker, tf, fuente: `Dukascopy ${conf.duka}`, velas: [], hayMas: false })
  } catch (err) {
    const esDuka = fuente === 'duka'
    if (esDuka) marcarDukaCaido(err)
    console.error('[grafico/velas]', errDetalle(err))
    const error = esDuka && dukascopyLimitando()
      ? 'Dukascopy está limitando las peticiones de esta IP (429); prueba en unos minutos'
      : errDetalle(err)
    res.status(500).json({ error })
  }
})

// Velas de Yahoo entre dos instantes, en el intervalo que se pida. Las páginas antiguas se
// repiten al ir y volver por el gráfico: se guardan en la caché de memoria (15 min).
async function obtenerRangoYahoo(simbolo, intervalo, desde, hasta) {
  const clave  = `yfg_${simbolo}_${intervalo}_${desde}_${hasta}`
  const cached = fromCache(clave)
  if (cached) return cached

  const auth  = await getYFAuth()
  const crumb = auth ? `&crumb=${encodeURIComponent(auth.crumb)}` : ''
  const hdrs  = auth ? { ...YF_HEADERS, 'Cookie': auth.cookie } : YF_HEADERS
  const url   = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(simbolo)}?interval=${intervalo}&period1=${desde}&period2=${hasta}${crumb}`
  const resp  = await fetch(url, { headers: hdrs })
  const json  = await resp.json().catch(() => null)
  const r     = json?.chart?.result?.[0]
  if (!r) throw new Error(`Yahoo: ${json?.chart?.error?.description ?? `HTTP ${resp.status}`}`)

  const ts    = r.timestamp ?? []
  const q     = r.indicators?.quote?.[0] ?? {}
  const velas = []
  for (let i = 0; i < ts.length; i++) {
    const [open, high, low, close] = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]]
    if (open == null || high == null || low == null || close == null) continue
    if (ts[i] < desde || ts[i] >= hasta) continue
    velas.push({ time: ts[i], open, high, low, close })
  }
  toCache(clave, velas)
  return velas
}

// ── Tortugas en acciones de EE. UU.: el diario del S&P 500 (ver server/acciones-eeuu.js) ──
// La pestaña Estrategias pide el universo y después las series por tandas de 40, para ir
// enseñando cuántas lleva. En producción se guardan en el volumen. Van comprimidas: el S&P 500
// entero, cada una desde un año antes de entrar en el índice, son 15 MB así (medido el
// 19-oct-2026; con su historia entera desde 1990, unos 25) y cuatro veces más sin comprimir.
async function pedirYahooConCrumb(url) {
  const auth = await getYFAuth()
  const resp = await fetch(`${url}${auth ? `&crumb=${encodeURIComponent(auth.crumb)}` : ''}`, { headers: auth ? { ...YF_HEADERS, Cookie: auth.cookie } : YF_HEADERS })
  if (!resp.ok) throw new Error(`Yahoo: HTTP ${resp.status}`)
  return resp.json()
}
const accionesEeuu = crearAccionesEeuu({
  dir: process.env.NODE_ENV === 'production' && existsSync('/data') ? '/data/acciones-eeuu' : join(DISK_CACHE_DIR, 'acciones-eeuu'),
  pedirYahoo: pedirYahooConCrumb,
})

app.get('/api/tortugas/acciones/universo', (req, res) => res.json(accionesEeuu.universo()))

// Los mercados de las tortugas de 1983 (server/futuros-tortugas.js): los 19 de una vez, que
// son poco más de 1 MB comprimidos
const futurosTortugas = crearFuturosTortugas({
  dir: process.env.NODE_ENV === 'production' && existsSync('/data') ? '/data/futuros-tortugas' : join(DISK_CACHE_DIR, 'futuros-tortugas'),
  pedirYahoo: pedirYahooConCrumb,
})
app.get('/api/tortugas/futuros', async (req, res) => {
  const desde = String(req.query.desde ?? '2000-01-01')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) return res.status(400).json({ error: 'desde: YYYY-MM-DD' })
  try {
    const cuerpo = Buffer.from(JSON.stringify(await futurosTortugas.series({ desde })))
    res.set('Content-Type', 'application/json; charset=utf-8')
    if (!/\bgzip\b/.test(req.get('Accept-Encoding') ?? '')) return res.send(cuerpo)
    res.set({ 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' }).send(gzipSync(cuerpo))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/tortugas/acciones', async (req, res) => {
  const tickers = String(req.query.tickers ?? '').split(',').map(t => t.trim()).filter(Boolean)
  const desde = String(req.query.desde ?? '1990-01-01')
  if (!tickers.length || tickers.length > MAX_ACCIONES_PETICION) return res.status(400).json({ error: `Entre 1 y ${MAX_ACCIONES_PETICION} tickers` })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) return res.status(400).json({ error: 'desde: YYYY-MM-DD' })
  try {
    const datos = await accionesEeuu.series(tickers, { desde, soloAlta: req.query.alta === '1' })
    const cuerpo = Buffer.from(JSON.stringify(datos))
    res.set('Content-Type', 'application/json; charset=utf-8')
    if (!/\bgzip\b/.test(req.get('Accept-Encoding') ?? '')) return res.send(cuerpo)
    res.set({ 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' }).send(gzipSync(cuerpo))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ── IG: precios en tiempo real (ver server/ig.js) ──
// Arranca solo si están las credenciales en server/.env; sin ellas la fuente "IG" del
// gráfico dice qué falta. Al arrancar entra, busca los mercados y se suscribe a sus velas
// de 1 min, que server/tiempo-real.js reparte a los gráficos abiertos.
const IG_FALTAN = ['IG_API_KEY', 'IG_USUARIO', 'IG_PASSWORD'].filter(k => !process.env[k])
const ig = IG_FALTAN.length === 0
  ? crearIG({
      apiKey:     process.env.IG_API_KEY,
      usuario:    process.env.IG_USUARIO,
      password:   process.env.IG_PASSWORD,
      entorno:    process.env.IG_ENTORNO === 'real' ? 'real' : 'demo',
      cuentaCfd:  process.env.IG_CUENTA || null,
      epicsFijos: (() => { try { return JSON.parse(process.env.IG_EPICS || '{}') } catch { return {} } })(),
      // en producción, en el volumen: el histórico de IG gasta un cupo semanal y en /tmp se
      // perdería (y se volvería a pedir) en cada despliegue
      cacheDir:   process.env.NODE_ENV === 'production' && existsSync('/data') ? '/data/ig-cache' : join(DISK_CACHE_DIR, 'ig'),
    })
  : null
ig?.iniciar()

// Grabación del directo de IG (ver server/grabacion-directo.js): las velas de 1 min de los
// mercados fijos, a disco; en producción, al volumen. Los mercados sueltos (ig:EPIC) solo
// llegan con un gráfico abierto, así que no se graban. DIRECTO_GRABAR=0 la apaga.
const grabacion = ig && process.env.DIRECTO_GRABAR !== '0'
  ? crearGrabacion({
      dir: process.env.DIRECTO_DIR
        || (process.env.NODE_ENV === 'production' && existsSync('/data') ? '/data/directo' : join(DISK_CACHE_DIR, 'directo')),
      tickers: () => Object.keys(ig.estado().epics),
      // solo cuenta como grabado lo que llega con el streaming conectado y el mercado suscrito
      activo: ticker => {
        const e = ig.estado()
        return /^CONNECTED/.test(e.streaming) && /^(velas de 1 min|cotización suelta)/.test(e.suscripciones?.[ticker] ?? '')
      },
    })
  : null
if (grabacion) {
  escucharFuente('ig', (ticker, vela) => { if (!epicDeMercadoIg(ticker)) grabacion.anotar(ticker, vela) })
  grabacion.iniciar()
}

// recoger_yahoo.py deja cada mañana en tu PC la sesión de contado de los índices; desde ahí,
// scripts/subir-yahoo.mjs la sube aquí para que el servidor online la tenga (ver YAHOO_DIR).
// Solo en producción: en local, YAHOO_DIR es la carpeta de la que salen.
app.put('/api/yahoo/:fichero', claveBot.middleware, express.text({ type: () => true, limit: '50mb' }), (req, res) => {
  if (process.env.NODE_ENV !== 'production') return res.status(404).json({ error: 'Solo en el servidor online' })
  const { fichero } = req.params
  const nombres = Object.values(INDICE_YAHOO).join('|')
  if (!new RegExp(`^(${nombres})_(1|5)min\\.csv$`).test(fichero)) return res.status(400).json({ error: `Fichero desconocido: ${fichero}` })
  const texto = typeof req.body === 'string' ? req.body : ''
  const velas = parsearCsvYahoo(texto).length
  if (!velas) return res.status(400).json({ error: 'El fichero no trae velas' })
  try {
    mkdirSync(YAHOO_DIR, { recursive: true })
    const destino = join(YAHOO_DIR, fichero)
    writeFileSync(`${destino}.tmp`, texto)
    renameSync(`${destino}.tmp`, destino)
    res.json({ ok: true, fichero, velas })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/mt5/estado', async (req, res) => {
  if (!mt5) return res.status(404).json({ error: 'MetaTrader 5 solo está en local, con el terminal instalado' })
  const directo = { ...mt5.directo(), velas: resumenTiempoReal().filter(s => s.fuente === 'mt5') }
  try { res.json({ ...(await mt5.estado()), directo }) } catch (err) { res.status(503).json({ error: err.message, directo }) }
})

app.get('/api/ig/estado', (req, res) => {
  if (!ig) return res.json({ configurado: false, faltan: IG_FALTAN })
  res.json({ ...ig.estado(), directo: resumenTiempoReal().filter(s => s.fuente === 'ig'), grabacion: grabacion?.resumen() ?? null })
})

app.get('/api/ig/buscar', async (req, res) => {
  if (!ig) return res.status(404).json({ error: 'IG no está configurado' })
  try { res.json(await ig.buscar(String(req.query.q ?? ''))) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/ig/mercado', async (req, res) => {
  if (!ig) return res.status(404).json({ error: 'IG no está configurado' })
  try { res.json(await ig.mercado(String(req.query.epic ?? ''))) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/ig/actividad', async (req, res) => {
  if (!ig) return res.status(404).json({ error: 'IG no está configurado' })
  try { res.json(await ig.actividad(Date.now() - Number(req.query.minutos ?? 60) * 60_000)) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/ig/cuentas', async (req, res) => {
  if (!ig) return res.status(404).json({ error: 'IG no está configurado' })
  try { res.json(await ig.cuentas()) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/ig/listas', async (req, res) => {
  if (!ig) return res.status(404).json({ error: 'IG no está configurado' })
  try { res.json(await ig.listas()) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/ig/rebuscar', async (req, res) => {
  if (!ig) return res.status(404).json({ error: 'IG no está configurado' })
  try { res.json(await ig.rebuscarEpics()) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/ig/navegar', async (req, res) => {
  if (!ig) return res.status(404).json({ error: 'IG no está configurado' })
  try { res.json(await ig.navegar(req.query.nodo ? String(req.query.nodo) : null)) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

// Velas de 1 min en directo para un gráfico abierto (SSE). Al conectarse recibe las últimas
// cinco, para cubrir lo que haya pasado entre su histórico y este momento. Un mercado suelto
// de IG (ig:EPIC) se suscribe al abrirse el gráfico y se suelta al cerrarse; con MT5, el
// terminal se consulta mientras haya algún gráfico abierto.
app.get('/api/tiempo-real/stream', (req, res) => {
  const { fuente, ticker } = req.query
  if (!fuente || !ticker) return res.status(400).json({ error: 'fuente y ticker requeridos' })
  const soltar = fuente === 'ig' && ig ? ig.seguir(String(ticker))
    : fuente === 'mt5' && mt5 ? mt5.seguir(String(ticker))
    : () => {}
  const desconectar = suscribir(res, String(fuente), String(ticker))
  req.on('close', () => { desconectar(); soltar() })
})

// ── Bot SRS en la demo de IG (ver server/bot-srs.js) ──
// Existe con IG configurado en la demo, pero solo OPERA donde BOT_OPERA=1: en la nube
// (Railway) sí, y en local no, salvo que se pida. Dos bots con la misma cuenta entrarían dos
// veces en cada rotura. El registro va a BOT_SRS; si no se dice, en local junto al diario en
// Drive, y en producción en el volumen /data si existe (sin volumen, en /tmp, que se pierde
// en cada despliegue: el bot recupera sus posiciones abiertas desde IG, pero no el historial).
const BOT_OPERA = process.env.BOT_OPERA === '1'
const BOT_PATH = process.env.BOT_SRS || (process.env.NODE_ENV === 'production'
  ? join(existsSync('/data') ? '/data' : DISK_CACHE_DIR, 'bot-srs.json')
  : join(PHOTOS_ROOT, 'Bot SRS.json'))
// Avisos del bot por Telegram (server/telegram.js): solo los manda el servidor que opera
const telegram = crearTelegram({
  token:   process.env.TELEGRAM_TOKEN || '',
  chatId:  process.env.TELEGRAM_CHAT_ID || '',
  archivo: join(dirname(BOT_PATH), 'telegram.json'),
})

// Errores sin capturar (ver server/vigilancia.js). Una promesa rechazada que nadie recogía
// tumbaba el proceso entero, con los tres bots dentro: ahora se apunta, se avisa y el servidor
// sigue. Una excepción sin capturar sí lo para, porque el estado puede haber quedado a medias:
// avisa y sale, y Railway lo vuelve a arrancar (restartPolicyType ALWAYS en railway.json).
// Los avisos dicen primero qué pasa y qué hacer; el error tal cual, al final.
const avisarServidor = texto => (BOT_OPERA ? telegram.enviar(texto) : Promise.resolve(false))
const avisarError = crearAvisoErrores({ avisar: avisarServidor })
const textoError = err => (err instanceof Error ? err.message : String(err)).slice(0, 300)
process.on('unhandledRejection', err => {
  console.error('[proceso] promesa rechazada sin capturar:', err)
  avisarError(`⚠️ Ha fallado algo en el servidor, pero sigue en marcha y los bots también. Solo hay que mirarlo si este aviso se repite.\nDetalle: ${textoError(err)}`)
})
process.on('uncaughtException', err => {
  console.error('[proceso] excepción sin capturar, salgo:', err)
  setTimeout(() => process.exit(1), 3000)
  avisarServidor(`🔴 El servidor se ha caído y se está reiniciando solo. En un minuto debería llegarte «Servidor arrancado»; si no llega, míralo en Railway.\nDetalle: ${textoError(err)}`).finally(() => process.exit(1))
})

const bot = ig && ig.estado().entorno === 'demo' ? crearBot({ ig, archivo: BOT_PATH, avisar: BOT_OPERA ? telegram.enviar : undefined }) : null
if (bot && BOT_OPERA) bot.arrancar()
if (bot) console.log(`[bot] registro en ${BOT_PATH}; ${BOT_OPERA ? 'opera en este servidor' : 'NO opera aquí (BOT_OPERA no es 1)'}`)

const sinBot = res => res.status(404).json({ error: ig ? 'El bot solo funciona con IG en la demo (IG_ENTORNO=demo)' : 'IG no está configurado' })

app.get('/api/bot', (req, res) => {
  if (!bot) return sinBot(res)
  res.json({ archivo: BOT_PATH, opera: BOT_OPERA, telegram: telegram.estado(), ig: { sesion: ig.estado().sesion, streaming: ig.estado().streaming, cuenta: ig.estado().cuenta }, ...bot.estado() })
})

app.put('/api/bot/config', (req, res) => {
  if (!bot) return sinBot(res)
  try { res.json(bot.cambiarConfig(req.body ?? {})) }
  catch (err) { res.status(400).json({ error: err.message }) }
})

app.post('/api/bot/parar', async (req, res) => {
  if (!bot) return sinBot(res)
  try { res.json(await bot.pararYCerrar()) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

// Las posiciones abiertas de la cuenta demo (las del bot y cualquier otra)
app.get('/api/bot/posiciones', async (req, res) => {
  if (!bot) return sinBot(res)
  try { res.json(await ig.operar.posiciones()) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

// Conecta los avisos por Telegram (busca el chat la primera vez) y manda un mensaje de prueba
app.post('/api/bot/telegram', async (req, res) => {
  try { res.json(await telegram.conectar()) }
  catch (err) { res.status(400).json({ error: err.message }) }
})

app.post('/api/bot/ensayo', async (req, res) => {
  if (!bot) return sinBot(res)
  try { res.json({ pasos: await bot.ensayo(req.body?.ticker ?? '^GDAXI') }) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Bot de la Rule of 4 en la demo de IG (RULE_OF_4 en server/bot-srs.js) ──
// El motor del SRS en los días del FOMC: la cuarta vela de 10 min desde el comunicado. Otro
// bot, con su registro y sus referencias (R4-…), que opera donde opera el SRS (BOT_OPERA=1),
// avisa por el mismo Telegram y va bajo /api/bot, con la misma clave. Nace apagado.
const BOT_RULE4_PATH = process.env.BOT_RULE4 || join(dirname(BOT_PATH), process.env.NODE_ENV === 'production' ? 'bot-rule-of-4.json' : 'Bot Rule of 4.json')
// Su calendario, al día con la Reserva Federal (server/calendario-fomc.js): se lee al arrancar y
// cada día, y se guarda junto al registro en producción (en local, en la caché)
const calendarioFomc = crearCalendarioFomc({
  archivo: process.env.NODE_ENV === 'production' ? join(dirname(BOT_PATH), 'fomc-calendario.json') : join(DISK_CACHE_DIR, 'fomc-calendario.json'),
  avisar: BOT_OPERA ? telegram.enviar : undefined,
})
calendarioFomc.iniciar()
const botRule4 = bot ? crearBot({ ig, archivo: BOT_RULE4_PATH, estrategia: RULE_OF_4, avisar: BOT_OPERA ? telegram.enviar : undefined }) : null
if (botRule4 && BOT_OPERA) botRule4.arrancar()
if (botRule4) console.log(`[rule of 4] registro en ${BOT_RULE4_PATH}; ${BOT_OPERA ? 'opera en este servidor' : 'NO opera aquí (BOT_OPERA no es 1)'}`)

app.get('/api/bot/rule-of-4', (req, res) => {
  if (!botRule4) return sinBot(res)
  res.json({ archivo: BOT_RULE4_PATH, opera: BOT_OPERA, telegram: telegram.estado(), ig: { sesion: ig.estado().sesion, streaming: ig.estado().streaming, cuenta: ig.estado().cuenta }, calendario: calendarioFomc.estado(), ...botRule4.estado() })
})

app.put('/api/bot/rule-of-4/config', (req, res) => {
  if (!botRule4) return sinBot(res)
  try { res.json(botRule4.cambiarConfig(req.body ?? {})) }
  catch (err) { res.status(400).json({ error: err.message }) }
})

app.post('/api/bot/rule-of-4/parar', async (req, res) => {
  if (!botRule4) return sinBot(res)
  try { res.json(await botRule4.pararYCerrar()) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Bot de las tortugas en la demo de IG (ver server/bot-tortugas.js) ──
// Como el SRS: existe con IG en la demo, opera solo donde BOT_OPERA=1 y avisa por el mismo
// Telegram. Va bajo /api/bot, con la misma clave. Sus niveles salen del diario de cada mercado:
//   · índices y divisas, de Yahoo (tres años, que sobran para la N de Wilder y el filtro del
//     Sistema 1), con la fecha en la zona con la que Yahoo pone cada vela (la de apertura de la
//     bolsa en los índices; Londres en divisas) y sin los fines de semana;
//   · materias primas, del histórico de IG del CFD de contado: solo las velas ya cerradas y unas
//     150 sesiones, porque gasta el cupo semanal de histórico (se guarda en el volumen). Si IG
//     no lo da, el oro y la plata tiran de su respaldo (respaldoTortugas, más abajo).
const BOT_TORTUGAS_PATH = process.env.BOT_TORTUGAS || join(dirname(BOT_PATH), process.env.NODE_ENV === 'production' ? 'bot-tortugas.json' : 'Bot Tortugas.json')
const DIAS_IG_TORTUGAS = 220
const entreSemana = v => ![0, 6].includes(new Date(`${v.date}T12:00:00Z`).getUTCDay())
async function velasDiariasTortugas(ticker) {
  const m = MERCADOS_TORTUGAS[ticker]
  const ahora = Math.floor(Date.now() / 1000)
  if (m.datos.fuente === 'ig') {
    try {
      const velas = await ig.velasEntre(ticker, 'd1', ahora - DIAS_IG_TORTUGAS * 86400, ahora - 86400)
      return velas.map(v => ({ date: fechaEnZona(v.time, 'Europe/Madrid'), open: v.open, high: v.high, low: v.low, close: v.close })).filter(entreSemana)
    } catch (err) {
      if (!m.datos.respaldo?.length) throw err
      return respaldoTortugas(ticker, m.datos.respaldo, ahora, err)
    }
  }
  // `hasta` a la hora en punto: la caché de memoria acierta dentro de la hora
  const hasta = Math.floor(ahora / 3600) * 3600
  const velas = await obtenerRangoYahoo(m.datos.simbolo, '1d', hasta - 3 * 365 * 86400, hasta)
  const zona = m.datos.zona ?? m.zona
  return velas.map(v => ({ date: fechaEnZona(v.time, zona), open: v.open, high: v.high, low: v.low, close: v.close })).filter(entreSemana)
}
// El oro y la plata sin histórico de IG: las velas de 1 h del contado de su respaldo (ver
// MERCADOS_TORTUGAS), agrupadas en las sesiones del bot, la primera fuente que las dé enteras.
// Si ninguna, el error lleva el de IG por delante (con el «cupo», el bot reintenta cada hora).
const SESIONES_QUE_PUEDEN_FALTAR = 6   // Navidad, Año Nuevo y algún festivo sin cotización
async function respaldoTortugas(ticker, respaldo, ahora, errIg) {
  const desde = ahora - DIAS_IG_TORTUGAS * 86400
  const fallos = [errIg.message]
  for (const r of respaldo) {
    try {
      const horas = r.fuente === 'Twelve Data' ? await horasTwelveData(r.simbolo, desde, ahora)
        : r.fuente === 'Dukascopy' ? await horasDukascopy(r.instrumento, desde, ahora)
        : []
      const dias = diariasDeSesiones(ticker, horas)
      const faltan = sesionesQueFaltan(dias)
      if (dias.length < 80 || faltan > SESIONES_QUE_PUEDEN_FALTAR) throw new Error(`solo ${dias.length} sesiones${Number.isFinite(faltan) ? `, con ${faltan} huecos` : ''}`)
      dias.respaldo = r.fuente
      return dias
    } catch (err) { fallos.push(`${r.fuente}: ${err.message}`) }
  }
  throw new Error(fallos.join('; '))
}

// Twelve Data: el plan gratuito da el oro al contado (XAU/USD), hasta 5000 velas por petición
// (unos 208 días de 1 h) y 800 peticiones al día
async function horasTwelveData(simbolo, desde, hasta) {
  if (!process.env.TWELVEDATA_API_KEY) throw new Error('falta TWELVEDATA_API_KEY en el servidor')
  const qs = new URLSearchParams({ symbol: simbolo, interval: '1h', outputsize: '5000', timezone: 'UTC', apikey: process.env.TWELVEDATA_API_KEY })
  const resp = await fetch(`https://api.twelvedata.com/time_series?${qs}`, { signal: AbortSignal.timeout(30_000) })
  const json = await resp.json().catch(() => ({}))
  if (json.status !== 'ok') throw new Error(json.message ?? `HTTP ${resp.status}`)
  return json.values
    .map(v => ({ time: Date.parse(`${v.datetime.replace(' ', 'T')}Z`) / 1000, open: +v.open, high: +v.high, low: +v.low, close: +v.close }))
    .filter(v => v.time >= desde && v.time < hasta && [v.open, v.high, v.low, v.close].every(Number.isFinite))
    .sort((a, b) => a.time - b.time)
}

// Dukascopy: un 429 llega como ficheros vacíos, así que si ha limitado durante la descarga,
// lo bajado no vale
async function horasDukascopy(instrumento, desde, hasta) {
  if (dukaCaido() || dukascopyLimitando(DUKA_CIRCUITO_MS)) throw new Error('limita las peticiones (429) o no responde')
  const velas = await obtenerTramoDukascopy(instrumento, 'h1', desde, hasta)
  if (dukascopyLimitando()) throw new Error('ha limitado las peticiones (429) a mitad de la descarga')
  return velas
}

const botTortugas = bot ? crearBotTortugas({ ig, velasDiarias: velasDiariasTortugas, archivo: BOT_TORTUGAS_PATH, avisar: BOT_OPERA ? telegram.enviar : undefined }) : null
if (botTortugas && BOT_OPERA) botTortugas.arrancar()
if (botTortugas) console.log(`[tortugas] registro en ${BOT_TORTUGAS_PATH}; ${BOT_OPERA ? 'opera en este servidor' : 'NO opera aquí (BOT_OPERA no es 1)'}`)

// ── Vigilancia de los bots (ver server/vigilancia.js) ──
// Cada 30 s mira si los bots en marcha siguen dando vueltas, y avisa por Telegram si uno lleva
// 2 min sin completar ninguna. /healthz/bots da lo mismo, con 503 si alguno está parado, y lo
// que se ha bloqueado el bucle de eventos: es para un vigilante de fuera (UptimeRobot o
// similar), que es el único que puede avisar si se cae el proceso entero. Sin clave: no
// enseña nada más que esto.
const vigilancia = crearVigilancia({
  bots: Object.fromEntries([['SRS', bot], ['Rule of 4', botRule4], ['Tortugas', botTortugas]].filter(([, b]) => b).map(([nombre, b]) => [nombre, b.latido])),
  avisar: avisarServidor,
})
if (BOT_OPERA) setInterval(vigilancia.revisar, 30_000)
const bucle = medirBucle()
app.get('/healthz/bots', (_req, res) => {
  const e = vigilancia.estado()
  res.status(e.ok ? 200 : 503).json({ ...e, opera: BOT_OPERA, bucle: bucle() })
})

app.get('/api/bot/tortugas', (req, res) => {
  if (!botTortugas) return sinBot(res)
  res.json({ archivo: BOT_TORTUGAS_PATH, opera: BOT_OPERA, telegram: telegram.estado(), ig: { sesion: ig.estado().sesion, streaming: ig.estado().streaming, cuenta: ig.estado().cuenta }, ...botTortugas.estado() })
})

app.put('/api/bot/tortugas/config', (req, res) => {
  if (!botTortugas) return sinBot(res)
  try { res.json(botTortugas.cambiarConfig(req.body ?? {})) }
  catch (err) { res.status(400).json({ error: err.message }) }
})

app.post('/api/bot/tortugas/parar', async (req, res) => {
  if (!botTortugas) return sinBot(res)
  try { res.json(await botTortugas.pararYCerrar()) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Dibujos de la pestaña Gráfico (solo local) ──
// Un JSON junto al diario y los comentarios, con una lista de dibujos por instrumento.
// Misma escritura atómica (temporal y rename) que el resto: un corte a media escritura no
// puede dejar el fichero a medias. En producción no hay Drive y el navegador se queda con
// su propia copia.
const DIBUJOS_PATH = process.env.DIBUJOS_GRAFICO || join(PHOTOS_ROOT, 'Dibujos grafico.json')

function leerDibujosGrafico() {
  try {
    const d = JSON.parse(readFileSync(DIBUJOS_PATH, 'utf8'))
    return d?.dibujos && typeof d.dibujos === 'object' ? d.dibujos : {}
  } catch { return {} }
}

app.get('/api/dibujos', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  const { clave } = req.query
  if (!claveValida(clave)) return res.status(400).json({ error: 'Clave de instrumento no válida' })
  res.json({ clave, dibujos: leerDibujosGrafico()[clave] ?? [] })
})

app.put('/api/dibujos', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
  try {
    const { clave } = req.body ?? {}
    if (!claveValida(clave)) return res.status(400).json({ error: 'Clave de instrumento no válida' })
    let dibujos
    try { dibujos = limpiarDibujos(req.body.dibujos) }
    catch (err) { return res.status(400).json({ error: err.message }) }

    const todos = leerDibujosGrafico()
    if (dibujos.length) todos[clave] = dibujos
    else delete todos[clave]
    const tmp = `${DIBUJOS_PATH}.tmp`
    writeFileSync(tmp, JSON.stringify({ actualizado: Date.now(), dibujos: todos }, null, 2))
    renameSync(tmp, DIBUJOS_PATH)
    res.json({ clave, total: dibujos.length })
  } catch (err) {
    console.error('[dibujos]', err.message)
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

// En producción, en todas las direcciones: Railway llega desde fuera. En local, solo desde este
// PC: aquí no se pide clave, y el cortafuegos de Windows deja entrar a Node en las redes
// públicas (una wifi de fuera). Y en las dos de localhost: atando solo a IPv4, Windows resuelve
// `localhost` primero a ::1, no encuentra a nadie y cada cliente nuevo pagaba ~200 ms de
// reintento antes de caer a 127.0.0.1.
if (PRODUCCION) app.listen(PORT, alArrancar)
else {
  app.listen(PORT, '127.0.0.1', alArrancar)
  app.listen(PORT, '::1').on('error', err => console.warn(`[servidor] no escucho en ::1 (${err.message}); solo en 127.0.0.1`))
}

function alArrancar() {
  console.log(`Servidor en http://localhost:${PORT}`)
  // Pre-calentar caché Dukascopy H1 en segundo plano para evitar timeouts en primera petición
  ;(async () => {
    for (const instrument of Object.values(DUKASCOPY_DAILY)) {
      try { await obtenerVelasDiariasDesde30m(instrument) }
      catch (e) { console.warn(`[warmup] ${instrument}:`, e.message) }
    }
    console.log(`[warmup] Caché Dukascopy H1 lista (transporte ${estadoTransporteDukascopy().modo.toUpperCase()})`)
  })().catch(() => {})
}
