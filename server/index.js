import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { getHistoricalRates } from 'dukascopy-node'
import { instalarTransporteDukascopy, estadoTransporteDukascopy, dukascopyLimitando } from './dukascopy-transport.js'
import { crearHistoricoDukascopy, fuenteZips } from './historico-dukascopy.js'
import { crearSincronizacionHistorico } from './historico-github.js'
import {
  TEMPORALIDADES, YAHOO, agruparVelas, agruparPorSesion, paginaAnteriorA, inicioDiaMadrid, ventanaYahoo,
} from './velas-grafico.js'
import { crearIG, IG_RESOLUCION, epicDeMercadoIg, intervalosPendientes } from './ig.js'
import { crearGrabacion, inicioCubo, tramosEnteros } from './grabacion-directo.js'
import { crearMt5, simbolosDeEnv } from './mt5.js'
import { suscribir, resumenTiempoReal, escucharFuente, sembrarVelas } from './tiempo-real.js'
import { crearBot, RULE_OF_4, FIRST_BAR_NEGATIVE } from './bot-srs.js'
import { crearCalendarioFomc } from './calendario-fomc.js'
import { crearBotTortugas, MERCADOS_TORTUGAS, GRUPOS_TORTUGAS, diariasDeSesiones, sesionesQueFaltan } from './bot-tortugas.js'
import { crearTortugasIB, MERCADOS_IB } from './tortugas-ib.js'
import { fechaEnZona, diaSemanaEnZona, offsetZona } from './zonas.js'
import { crearClaveBot } from './clave-bot.js'
import { crearVigilancia, crearAvisoErrores, medirBucle } from './vigilancia.js'
import { crearPerfilador } from './perfil.js'
import { crearTelegram } from './telegram.js'
import { crearCartera, MAX_RIESGO_GRUPO_PCT } from './cartera.js'
import { crearNoticias } from './noticias.js'
import { crearConciliacion } from './conciliacion.js'
import { crearResumenDiario } from './resumen-diario.js'
import { INDICE_YAHOO_CSV, DIARIOS_YAHOO, DIARIOS_STOOQ, parsearCsvYahoo, parsearDiarioYahoo, parsearDiarioStooq } from './velas-yahoo.js'
import { crearAccionesEeuu, decodificarSerie, SP500, MAX_POR_PETICION as MAX_ACCIONES_PETICION } from './acciones-eeuu.js'
import { crearFuturosTortugas } from './futuros-tortugas.js'
import { crearColaFeed } from './cola-feed.js'
import { gzipSync } from 'zlib'
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { avisosDeSalud } from './salud.js'
import { crearAlpaca } from './alpaca.js'
import { crearBotTortugasAcciones } from './bot-tortugas-acciones.js'
import { resumenPublico, crearCacheResumen, cerradasMotorSrs, cerradasTortugas, cerradasTortugasAcciones, infoMotorSrs, infoTortugas } from './resumen-bots.js'
import { registrarGapFilter } from './rutas-gap-filter.js'
import { registrarDiarioLocal } from './rutas-diario-local.js'
import { registrarExcursiones } from './rutas-excursiones.js'
import { registrarDaxCash } from './rutas-dax-cash.js'
import { registrarLocales } from './rutas-locales.js'
import { registrarIB } from './rutas-ib.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Debe ejecutarse antes de la primera descarga: elige HTTPS o HTTP para el datafeed
// según lo que deje pasar la red (ver server/dukascopy-transport.js). En local, mientras
// scripts/bajar-dukascopy-todo.mjs baja el histórico (renueva su testigo cada minuto), el
// servidor no le pide nada al feed: así no le gasta el cupo de peticiones de la IP. El
// testigo viejo (la descarga acabó o se cortó) deja de contar a los 3 min.
const TESTIGO_HISTORICO = join(process.env.DUKASCOPY_DIR || 'C:\\Users\\Sergio\\Documents\\Dukascopy', 'historico', '.descargando')
let avisadoHistorico = false
function bajandoHistorico() {
  if (process.env.NODE_ENV === 'production') return false
  let enMarcha = false
  try { enMarcha = Date.now() - statSync(TESTIGO_HISTORICO).mtimeMs < 3 * 60_000 } catch { /* sin testigo */ }
  if (enMarcha !== avisadoHistorico) {
    avisadoHistorico = enMarcha
    console.log(enMarcha
      ? '[Dukascopy] El histórico completo se está bajando: el servidor no pide nada al feed hasta que acabe'
      : '[Dukascopy] La descarga del histórico ya no está en marcha: el servidor vuelve a pedir al feed')
  }
  return enMarcha
}
instalarTransporteDukascopy({ bloqueado: bajandoHistorico })

// Cache en disco para datos Dukascopy. En Railway va al volumen de /data: en /tmp se
// borraba con cada despliegue, y con ella todo lo descargado, así que tras cada push las
// estrategias volvían a pedirle al feed sesión a sesión lo que ya habían bajado. Sin
// volumen, /tmp como antes; en local, junto al servidor.
const DISK_CACHE_DIR = process.env.NODE_ENV === 'production'
  ? (existsSync('/data') ? '/data/.duka-cache' : '/tmp/.duka-cache')
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

app.disable('x-powered-by')
if (PRODUCCION) {
  // Railway llega a través de su proxy, que pone la dirección de quien llama al final de
  // X-Forwarded-For: req.ip es esa, y no la del proxy (la usa la clave del bot para bloquear
  // a quien pruebe claves). Solo ese último salto: lo de antes lo puede escribir cualquiera.
  app.set('trust proxy', 1)
  // Cabeceras de seguridad: que el navegador no adivine tipos, no meta las respuestas en un
  // marco de otra web ni mande la URL de la página a nadie, y que vaya siempre por HTTPS.
  // Lo del bot, IG y el directo, además, sin guardarse en ninguna caché por el camino.
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options':    'nosniff',
      'X-Frame-Options':           'DENY',
      'Referrer-Policy':           'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000',
    })
    if (/^\/api\/(bot|ig|tiempo-real)(\/|$)/.test(req.path)) res.set('Cache-Control', 'no-store')
    next()
  })
}

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
// antes de leer el cuerpo: sin clave no se llega a leer nada. Quien pruebe claves a ciegas
// queda bloqueado, y se avisa por Telegram (avisarServidor se define más abajo, con el bot)
const claveBot = crearClaveBot({ token: process.env.BOT_TOKEN || '', produccion: PRODUCCION, avisar: texto => avisarServidor(texto) })
if (PRODUCCION && (process.env.BOT_TOKEN || '').length < 32) {
  console.warn('[clave-bot] BOT_TOKEN tiene menos de 32 caracteres: mejor una larga y al azar (node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))")')
}
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
// Con tope: las claves salen de lo que pida cada uno (cualquier ticker, cualquier fecha), y sin
// él bastaba con pedir muchos distintos para llenar la memoria y tumbar el servidor con los bots
// dentro. Se mide en velas (lo que ocupa); pasado el tope se van las más antiguas, que de todas
// formas suelen estar también en disco. Las caducadas se barren cada diez minutos.
const cache           = new Map()
const CACHE_TTL       = 15 * 60_000
const CACHE_MAX_VELAS = 1_000_000
let velasEnCache = 0

function fromCache(key) {
  const c = cache.get(key)
  return c && Date.now() - c.ts < (c.ttl ?? CACHE_TTL) ? c.data : null
}
function sacarDeCache(key) {
  const c = cache.get(key)
  if (!c) return
  velasEnCache -= c.peso
  cache.delete(key)
}
function toCache(key, data, ttl = CACHE_TTL) {
  sacarDeCache(key)   // y vuelve a entrar al final: el orden del Map es de más antigua a más nueva
  const peso = Array.isArray(data) ? data.length : 1
  cache.set(key, { ts: Date.now(), data, ttl, peso })
  velasEnCache += peso
  for (const k of cache.keys()) {
    if (velasEnCache <= CACHE_MAX_VELAS) break
    sacarDeCache(k)
  }
}
setInterval(() => {
  for (const [k, c] of cache) if (Date.now() - c.ts >= (c.ttl ?? CACHE_TTL)) sacarDeCache(k)
}, 10 * 60_000).unref()

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

// Timezone helpers. Con el desfase memorizado de server/zonas.js: toLocaleDateString con
// timeZone crea un formateador en cada llamada, y en las series de 30 años de diario eso
// bloqueaba el servidor casi un segundo cada vez (medido con server/perfil.js)
const getMadridDate = ts => fechaEnZona(ts, 'Europe/Madrid')

const getMadridDay = ts => {
  const dow = diaSemanaEnZona(ts, 'Europe/Madrid')
  return dow === 0 ? 7 : dow   // 1=lun … 5=vie, 7=dom
}

// Helpers para timezone Londres (maneja GMT/BST automáticamente)
function getLondonMinutes(tsMs) {
  const t = tsMs / 1000
  const local = Math.floor(t + offsetZona(t, 'Europe/London'))
  return Math.floor((((local % 86400) + 86400) % 86400) / 60)
}
function getLondonDateStr(tsMs) {
  return fechaEnZona(tsMs / 1000, 'Europe/London')
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
const ANIOS_DIARIAS = 30
// Lo que se baja de una vez cuando no hay nada en disco: diez años de H1 caben en el tiempo
// de una descarga histórica; treinta no. El resto lo va bajando profundizarDiario hacia
// atrás, año a año y en segundo plano, hasta ANIOS_DIARIAS o hasta donde empiece el feed.
const ANIOS_PRIMERA_DESCARGA = 10

// Une series diarias por fecha de Londres; en una fecha repetida manda la última serie
function unirDiarias(...series) {
  const porFecha = new Map()
  for (const serie of series) for (const v of serie ?? []) porFecha.set(getLondonDateStr(v.time * 1000), v)
  return [...porFecha.values()].sort((a, b) => a.time - b.time)
}

// Guarda la serie en disco (solo sesiones cerradas: la de hoy puede estar a medias) unida a lo
// que haya en ese momento: la actualización del día y profundizarDiario escriben en la misma
// clave, y ninguna debe pisar lo que haya añadido la otra mientras descargaba
function guardarDiario(cacheKey, velas) {
  const hoy = getLondonDateStr(Date.now())
  const cerradas = velas.filter(v => getLondonDateStr(v.time * 1000) < hoy)
  if (cerradas.length > 0) diskCacheSet(cacheKey, unirDiarias(diskCacheGet(cacheKey), cerradas))
}

async function obtenerVelasDiariasDesde30m(instrument) {
  const [sessionOpenMin, sessionCloseMin] = DUKA_SESSION_LONDON[instrument] ?? [8*60, 16*60+30]
  const cacheKey = `h1daily${ANIOS_DIARIAS}_${instrument}`
  const cached   = fromCache(cacheKey)
  if (cached) return cached

  const ayer = getLondonDateStr(Date.now() - 86400_000)

  // Disk cache: arranque rápido tras un reinicio del contenedor. Mientras no está la serie
  // larga, se parte de la de diez años que hubiera, en vez de volver a bajarla entera
  const disk        = diskCacheGet(cacheKey) ?? diskCacheGet(`h1daily${ANIOS_PRIMERA_DESCARGA}_${instrument}`)
  const ultimaDisco  = disk?.length ? getLondonDateStr(disk[disk.length - 1].time * 1000) : null

  // Si el disco ya llega hasta la sesión de ayer, está al día → usarlo tal cual
  if (disk && ultimaDisco >= ayer) {
    if (!diskCacheGet(cacheKey)) diskCacheSet(cacheKey, disk)
    toCache(cacheKey, disk, 4 * 60 * 60_000)
    console.log(`[Dukascopy H1→Diario] ${instrument}: ${disk.length} días (disco, al día)`)
    profundizarDiario(instrument, sessionOpenMin, sessionCloseMin)
    return disk
  }

  // Sin disco (primera vez) o desactualizado: descargar solo lo que falta desde la base en disco
  const from = ultimaDisco
    ? new Date(new Date(ultimaDisco).getTime() - 2 * 86400_000)  // margen de solape
    : (() => { const d = new Date(); d.setFullYear(d.getFullYear() - ANIOS_PRIMERA_DESCARGA); return d })()

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
        const yfVelas = await obtenerVelasDiariasYF(yfTicker, from)
        // el disco se vuelve a leer: mientras se descargaba, profundizarDiario puede haber añadido años
        const velas   = unirDiarias(disk, diskCacheGet(cacheKey), yfVelas)

        // TTL corto: es un fallback, reintentar Dukascopy pronto en vez de esperar 4h
        toCache(cacheKey, velas, 30 * 60_000)
        guardarDiario(cacheKey, velas)

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

  // Combinar con la base de disco (si la había, y releída por lo que haya añadido
  // profundizarDiario mientras tanto) y deduplicar por fecha
  const velas = unirDiarias(disk, diskCacheGet(cacheKey), agregarVelasH1ADiarias(bars, sessionOpenMin, sessionCloseMin))

  toCache(cacheKey, velas, 4 * 60 * 60_000)
  guardarDiario(cacheKey, velas)

  console.log(`[Dukascopy H1→Diario] ${instrument}: ${velas.length} días`)
  profundizarDiario(instrument, sessionOpenMin, sessionCloseMin)
  return velas
}

// Lleva la serie diaria de un instrumento hacia atrás hasta ANIOS_DIARIAS, un año de H1 por
// descarga (cada uno cabe holgado en el tiempo de una histórica), sin que nadie espere: las
// peticiones siguen sirviendo lo que hay y cada año que llega se añade al disco y a la
// memoria. Para en cuanto un año viene vacío, que es donde empieza el feed de ese
// instrumento, y lo apunta para no volver a intentarlo. Si falla (el feed corta, o una
// consulta vacía se cuelga hasta el tiempo máximo) lo reintenta al día siguiente, y a los
// tres fallos seguidos en el mismo punto lo da por el principio.
const profundizando = new Set()
async function profundizarDiario(instrument, sessionOpenMin, sessionCloseMin) {
  if (profundizando.has(instrument)) return
  const cacheKey = `h1daily${ANIOS_DIARIAS}_${instrument}`
  const marcaKey = `h1dailyInicio${ANIOS_DIARIAS}_${instrument}`
  const marca    = diskCacheGet(marcaKey) ?? {}
  if (marca.fin) return
  if (marca.fallo && Date.now() - marca.fallo < 24 * 3600_000) return

  profundizando.add(instrument)
  try {
    const limite = new Date()
    limite.setFullYear(limite.getFullYear() - ANIOS_DIARIAS)
    for (;;) {
      const disk = diskCacheGet(cacheKey)
      if (!disk?.length) return
      const primera = new Date(disk[0].time * 1000)
      const desde   = getLondonDateStr(disk[0].time * 1000)
      if (primera <= limite) { diskCacheSet(marcaKey, { fin: true, desde }); return }

      const from = new Date(Math.max(limite.getTime(), primera.getTime() - 365 * 86400_000))
      let bars
      try {
        bars = await dukaFetch({ instrument, dates: { from, to: primera }, timeframe: 'h1' },
          DUKA_TIMEOUT_HISTORICO_MS, DUKA_OPCIONES_HISTORICO)
      } catch (err) {
        const intentos = marca.desde === desde ? (marca.intentos ?? 0) + 1 : 1
        console.warn(`[Dukascopy H1→Diario] ${instrument}: no se pudo ir más atrás de ${desde} (${errDetalle(err)}, intento ${intentos})`)
        diskCacheSet(marcaKey, intentos >= 3 ? { fin: true, desde } : { fallo: Date.now(), desde, intentos })
        return
      }

      const nuevas = agregarVelasH1ADiarias(bars, sessionOpenMin, sessionCloseMin).filter(v => v.time < disk[0].time)
      if (nuevas.length === 0) {
        console.log(`[Dukascopy H1→Diario] ${instrument}: el feed empieza en ${desde}`)
        diskCacheSet(marcaKey, { fin: true, desde })
        return
      }
      guardarDiario(cacheKey, nuevas)
      const enMemoria = fromCache(cacheKey)
      if (enMemoria) toCache(cacheKey, unirDiarias(nuevas, enMemoria), 4 * 60 * 60_000)
      console.log(`[Dukascopy H1→Diario] ${instrument}: +${nuevas.length} días, desde ${getLondonDateStr(nuevas[0].time * 1000)}`)
    }
  } catch (err) {
    console.warn(`[Dukascopy H1→Diario] ${instrument}: profundizar falló (${err.message})`)
  } finally {
    profundizando.delete(instrument)
  }
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

// Sesión cerrada (ayer y antes): sus datos ya no cambian y pueden ir al disco
const sesionCerrada = date => date <= new Date(Date.now() - 86400_000).toISOString().slice(0, 10)

// El histórico de Dukascopy a 1 min: lo que esté ahí sale de sus CSV, idéntico a lo que daría
// el feed. En local, la carpeta Documents\Dukascopy\historico (scripts/bajar-dukascopy-todo.mjs
// y bajar-zips-github.mjs); en el servidor online, los zips del release de GitHub, que se
// mantienen al día en el volumen (server/historico-github.js). DUKASCOPY_HISTORICO_DIR
// apunta a otra carpeta de CSV.
const HISTORICO_ZIPS_DIR = process.env.NODE_ENV === 'production' && existsSync('/data') ? '/data/dukascopy-historico' : null
const sincronizacionHistorico = HISTORICO_ZIPS_DIR ? crearSincronizacionHistorico(HISTORICO_ZIPS_DIR) : null
const velasDelHistorico = crearHistoricoDukascopy(process.env.DUKASCOPY_HISTORICO_DIR
  || (HISTORICO_ZIPS_DIR ? fuenteZips(HISTORICO_ZIPS_DIR)
    : process.env.NODE_ENV === 'production' ? null : 'C:\\Users\\Sergio\\Documents\\Dukascopy\\historico'))
sincronizacionHistorico?.iniciar()

// Las velas de ese día que ya están guardadas, sin salir a la red; null si no las hay
function velasDukascopyGuardadas(instrument, date, tf) {
  const cacheKey = `duka_${instrument}_${date}_${tf}`

  // 1. Cache en memoria
  const cached = fromCache(cacheKey)
  if (cached) return cached

  // 2. El histórico en CSV
  const delHistorico = velasDelHistorico(instrument, date, tf)
  if (delHistorico) {
    toCache(cacheKey, delHistorico, 6 * 60 * 60_000)
    return delHistorico
  }

  // 3. Cache en disco: ayer y antes (sesión cerrada → datos inmutables)
  if (!sesionCerrada(date)) return null
  const disk = diskCacheGet(cacheKey)
  if (disk) toCache(cacheKey, disk, 6 * 60 * 60_000)
  return disk
}

async function obtenerVelasDukascopy(instrument, date, timeframe = 'm15') {
  const tf = DUKA_TIMEFRAMES.has(timeframe) ? timeframe : 'm15'

  const guardadas = velasDukascopyGuardadas(instrument, date, tf)
  if (guardadas) return guardadas

  // 4. Sin caché: si la fuente está marcada como caída, no gastar otro timeout de 10 s
  if (dukaCaido()) return []
  return descargarVelasDukascopy(instrument, date, tf)
}

// La descarga en sí, sin mirar la caché de velas ni el circuito de corte, y lo que baja
// queda guardado. La usa también la cola del feed, que lleva su propio ritmo.
async function descargarVelasDukascopy(instrument, date, tf) {
  const cacheKey = `duka_${instrument}_${date}_${tf}`
  const useDisk  = sesionCerrada(date)

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

// Gap Filter y su exportación a PowerPoint (server/rutas-gap-filter.js)
registrarGapFilter({ ANIOS_DIARIAS, DUKASCOPY_DAILY, app, claveBot, getMadridDate, getMadridDay, obtenerVelasDiarias })

// ── ForexFactory Calendar ─────────────────────────────────────────────────
// Proxy server-side para evitar CORS; combina semana pasada + actual + próxima
app.get('/api/ff-calendar', async (req, res) => {
  try {
    const cached = fromCache('ff_calendar')
    if (cached) return res.json(cached)

    // esta semana y la siguiente, de lo que ya leyeron los bots (server/noticias.js) si es
    // reciente: ForexFactory limita mucho las peticiones
    const leido = noticias.crudo()
    const slugs  = leido ? ['lastweek'] : ['lastweek', 'thisweek', 'nextweek']
    const events = [...(await Promise.all(
      slugs.map(slug =>
        fetch(`https://nfs.faireconomy.media/ff_calendar_${slug}.json`, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        }).then(r => r.ok ? r.json() : []).then(l => (Array.isArray(l) ? l : [])).catch(() => [])
      )
    )).flat(), ...(leido ? [...leido.thisweek, ...(leido.nextweek ?? [])] : [])]

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

// Las sesiones que las estrategias piden y no están guardadas se bajan aquí, de una en una
// y al ritmo que aguanta el feed (ver server/cola-feed.js). Sin fallbacks: una barra de
// Yahoo de 60 min o la diaria no le sirven a una estrategia de velas de 15.
const colaFeed = crearColaFeed({
  bajar: async ({ instrument, date, tf }) => {
    if (velasDukascopyGuardadas(instrument, date, tf)) return 'cache'
    // con el fichero del día ya en disco no sale a la red, solo agrega; aun así se hace
    // aquí, para que un fichero que no sirve acabe como vacío en vez de volver a la cola
    const local = tf !== 'h1' && diaEnCacheDukascopy(instrument, Date.parse(`${date}T00:00:00Z`) / 1000)
    const t0 = Date.now()
    const hubo429 = () => dukascopyLimitando(Date.now() - t0 + 1_000)
    let velas
    try { velas = await descargarVelasDukascopy(instrument, date, tf) } catch { return hubo429() ? 'limitado' : 'fallo' }
    // un 429 llega como fichero vacío: si lo ha habido durante la descarga, el vacío no vale
    if (!velas.length) return hubo429() ? 'limitado' : 'vacio'
    if (local) return 'cache'
    dukaCaidaTs = 0   // el feed responde: el resto de peticiones puede volver a usarlo
    return 'ok'
  },
})

// Varias sesiones en una sola petición, con lo que ya está guardado: con la caché
// caliente, 500 sesiones de una estrategia son veinte viajes en vez de 500 en serie. No
// sale a la red. Con `encolar=1`, lo que falte se encarga a la cola del feed y viene en
// `pendientes` hasta que esté; con `soloEncolar=1` solo se encarga, sin devolver velas.
// Lo que no se encarga (la sesión de hoy, que aún no ha cerrado) no viene en ninguna de
// las dos listas, y el cliente lo pide con /api/velas15m.
const MAX_SESIONES_LOTE = 60

app.get('/api/velas15m/lote', async (req, res) => {
  try {
    const { ticker, timeframe = 'm15' } = req.query
    const instrument = YF_TO_DUKASCOPY[ticker]
    const fechas = String(req.query.fechas ?? '').split(',').filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f))
    if (!instrument || !fechas.length) return res.status(400).json({ error: 'ticker de Dukascopy y fechas requeridos' })
    if (fechas.length > MAX_SESIONES_LOTE) return res.status(400).json({ error: `máximo ${MAX_SESIONES_LOTE} fechas por lote` })
    const tf = DUKA_TIMEFRAMES.has(timeframe) ? timeframe : 'm15'
    const soloEncolar = req.query.soloEncolar === '1'
    const encolar     = soloEncolar || req.query.encolar === '1'

    const sesiones = {}, sinDatos = [], aEncolar = []
    for (const date of fechas) {
      const clave = `${instrument}|${date}`
      if (colaFeed.sinDatos(clave)) { sinDatos.push(date); continue }
      // con el fichero de 1 min del día ya en disco (otro timeframe, el backfill) las velas
      // se agregan en local, sin pedirle nada al feed. La horaria sale de ficheros de mes.
      const enDisco = tf !== 'h1' && sesionCerrada(date) && diaEnCacheDukascopy(instrument, Date.parse(`${date}T00:00:00Z`) / 1000)
      if (soloEncolar) {
        if (!enDisco && !velasDukascopyGuardadas(instrument, date, tf) && sesionCerrada(date)) aEncolar.push({ clave, instrument, date, tf })
        continue
      }
      let velas = velasDukascopyGuardadas(instrument, date, tf)
      if (!velas && enDisco) {
        try { velas = await descargarVelasDukascopy(instrument, date, tf) } catch { velas = null }
      }
      if (velas?.length) sesiones[date] = { velas, fuente: `Dukascopy ${timeframe}` }
      else if (sesionCerrada(date)) aEncolar.push({ clave, instrument, date, tf })
    }
    if (encolar && aEncolar.length) colaFeed.encolar(aEncolar)
    const pendientes = fechas.filter(date => colaFeed.pendiente(`${instrument}|${date}`))
    res.json({
      ticker, timeframe, sesiones, sinDatos, pendientes,
      cola: { ...colaFeed.estado(), limitando: dukascopyLimitando() },
    })
  } catch (err) {
    console.error('[velas15m/lote]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Fotos, charts, books, diario, comentarios y revisiones con Claude (server/rutas-diario-local.js)
const { PHOTOS_ROOT, leerTradesDiario } = registrarDiarioLocal({ DISK_CACHE_DIR, PRODUCCION, app, claveBot })

// MFE / MAE de las operaciones y las velas de Yahoo y Stooq en disco (server/rutas-excursiones.js)
const { STOOQ_DIR, YAHOO_DIR, diaEnCacheDukascopy, velasYahooLocales } = registrarExcursiones({ DISK_CACHE_DIR, DUKA_RAW_CACHE_DIR, DUKA_TIMEOUT_MS, PHOTOS_ROOT, YF_TO_DUKASCOPY, app, errDetalle, leerTradesDiario, obtenerTramoDukascopy })

// Diario DAY de Google Sheets, dibujos, historial de la cuenta y pipeline (server/rutas-locales.js)
registrarLocales({ PHOTOS_ROOT, app })

// Histórico del DAX cash desde el CSV de 5 min (server/rutas-dax-cash.js)
const olvidarVelasDax = () => _daxPorTf.clear()
const { DAX_CSV, getSesionesDax } = registrarDaxCash({ DISK_CACHE_DIR, app, claveBot, olvidarVelasDax })

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
      if (ticker !== '^GDAXI') return res.status(400).json({ error: 'El CSV solo tiene el DAX' })
      if (tf === 'm1') return res.status(400).json({ error: 'El CSV del DAX va a 5 minutos: no hay velas de 1 min' })
      if (!existsSync(DAX_CSV)) return res.status(404).json({ error: `No se encuentra el CSV: ${DAX_CSV}` })
      const { velas, hayMas } = paginaAnteriorA(velasCsvDax(tf), hasta, VELAS_POR_PAGINA_CSV)
      return res.json({ ticker, tf, fuente: 'CSV DAX cash 5m', velas, hayMas })
    }

    if (fuente === 'ig') {
      // el histórico de IG gasta su cupo semanal: en producción, solo con la clave del bot
      if (!claveBot.exigir(req, res)) return
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
  // El directo en memoria (el de los bots y los gráficos de sus sesiones) se pierde en cada
  // reinicio: se rellena con los tres últimos días grabados, antes de escuchar el directo
  // nuevo para no volver a escribirlos
  const arranque = Math.floor(Date.now() / 1000)
  for (const ticker of grabacion.mercados()) sembrarVelas('ig', ticker, grabacion.m1Entre(ticker, arranque - 3 * 86400, arranque + 60))
  escucharFuente('ig', (ticker, vela) => { if (!epicDeMercadoIg(ticker)) grabacion.anotar(ticker, vela) })
  grabacion.iniciar()
}

// recoger_yahoo.py deja cada mañana en tu PC la sesión de contado de los índices; desde ahí,
// scripts/subir-yahoo.mjs la sube aquí para que el servidor online la tenga (ver YAHOO_DIR).
// Solo en producción: en local, YAHOO_DIR es la carpeta de la que salen.
// Las diarias van a diario/ (PUT /api/yahoo/diario/<ID>_1d.csv), como en la carpeta del PC.
app.put(['/api/yahoo/:fichero', '/api/yahoo/diario/:diario'], claveBot.middleware, express.text({ type: () => true, limit: '50mb' }), (req, res) => {
  if (process.env.NODE_ENV !== 'production') return res.status(404).json({ error: 'Solo en el servidor online' })
  const { fichero, diario } = req.params
  const nombres = Object.values(INDICE_YAHOO_CSV).join('|')
  if (diario ? !new RegExp(`^(${DIARIOS_YAHOO.join('|')})_1d\\.csv$`).test(diario) : !new RegExp(`^(${nombres})_(1|5)min\\.csv$`).test(fichero)) {
    return res.status(400).json({ error: `Fichero desconocido: ${diario ?? fichero}` })
  }
  const texto = typeof req.body === 'string' ? req.body : ''
  const velas = (diario ? parsearDiarioYahoo(texto) : parsearCsvYahoo(texto)).length
  if (!velas) return res.status(400).json({ error: 'El fichero no trae velas' })
  try {
    const carpeta = diario ? join(YAHOO_DIR, 'diario') : YAHOO_DIR
    mkdirSync(carpeta, { recursive: true })
    const destino = join(carpeta, diario ?? fichero)
    writeFileSync(`${destino}.tmp`, texto)
    renameSync(`${destino}.tmp`, destino)
    res.json({ ok: true, fichero: diario ? `diario/${diario}` : fichero, velas })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Las diarias de Stooq, igual: PUT /api/stooq/<fichero>_d.csv (ver DIARIOS_STOOQ)
app.put('/api/stooq/:fichero', claveBot.middleware, express.text({ type: () => true, limit: '20mb' }), (req, res) => {
  if (process.env.NODE_ENV !== 'production') return res.status(404).json({ error: 'Solo en el servidor online' })
  const { fichero } = req.params
  if (!Object.values(DIARIOS_STOOQ).some(f => fichero === `${f}_d.csv`)) return res.status(400).json({ error: `Fichero desconocido: ${fichero}` })
  const texto = typeof req.body === 'string' ? req.body : ''
  const velas = parsearDiarioStooq(texto).length
  if (!velas) return res.status(400).json({ error: 'El fichero no trae velas' })
  try {
    mkdirSync(STOOQ_DIR, { recursive: true })
    const destino = join(STOOQ_DIR, fichero)
    writeFileSync(`${destino}.tmp`, texto)
    renameSync(`${destino}.tmp`, destino)
    res.json({ ok: true, fichero: `stooq/${fichero}`, velas })
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
  // sin esperar a juntarlo con otros avisos: el proceso sale en 3 s
  const aviso = `🔴 El servidor se ha caído y se está reiniciando solo. En un minuto debería llegarte «Servidor arrancado»; si no llega, míralo en Railway.\nDetalle: ${textoError(err)}`
  ;(BOT_OPERA ? telegram.enviar(aviso, { ya: true }) : Promise.resolve(false)).finally(() => process.exit(1))
})

// Lo que comparten los bots: el riesgo abierto en mercados que se mueven juntos (server/cartera.js;
// RIESGO_GRUPO_MAX_PCT cambia el tope) y el calendario de noticias de alto impacto (server/noticias.js)
const cartera = crearCartera({ grupos: GRUPOS_TORTUGAS, maxPct: Number(process.env.RIESGO_GRUPO_MAX_PCT) || MAX_RIESGO_GRUPO_PCT })
const noticias = crearNoticias({ archivo: join(dirname(BOT_PATH), 'noticias.json') })
if (BOT_OPERA) noticias.iniciar()

const bot = ig && ig.estado().entorno === 'demo' ? crearBot({ ig, archivo: BOT_PATH, cartera, noticias, avisar: BOT_OPERA ? telegram.enviar : undefined }) : null
if (bot && BOT_OPERA) bot.arrancar()
if (bot) console.log(`[bot] registro en ${BOT_PATH}; ${BOT_OPERA ? 'opera en este servidor' : 'NO opera aquí (BOT_OPERA no es 1)'}`)

const sinBot = res => res.status(404).json({ error: ig ? 'El bot solo funciona con IG en la demo (IG_ENTORNO=demo)' : 'IG no está configurado' })

app.get('/api/bot', (req, res) => {
  if (!bot) return sinBot(res)
  res.json({ archivo: BOT_PATH, opera: BOT_OPERA, telegram: telegram.estado(), riesgoGrupoPct: cartera.estado().maxPct, noticias: noticias.estado(), ig: { sesion: ig.estado().sesion, streaming: ig.estado().streaming, cuenta: ig.estado().cuenta }, ...bot.estado() })
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

// Las posiciones abiertas de la cuenta demo (las de los bots y cualquier otra), cada una con
// el bot que la abrió, que se sabe por el prefijo de su referencia, y la cuenta
// Con el cambio a euros de cada moneda (el de la ficha del mercado en IG, guardado 10 min para
// no gastar peticiones en cada refresco), el resultado y lo que daría el stop van también en €.
const BOT_DE_REFERENCIA = [['SRS-', 'SRS'], ['R4-', 'Rule of 4'], ['FBN-', 'First bar negative'], ['TOR', 'Tortugas']]
const CAMBIO_VALE_MS = 10 * 60_000
const cambiosAEur = new Map([['EUR', { cambio: 1, t: Infinity }]])
async function cambioAEur(moneda, { ticker, epic }) {
  const visto = cambiosAEur.get(moneda)
  if (visto && Date.now() - visto.t < CAMBIO_VALE_MS) return visto.cambio
  try {
    const m = await ig.operar.datosMercado(ticker, epic)
    if (m.moneda === moneda && m.cambioAEur) cambiosAEur.set(moneda, { cambio: m.cambioAEur, t: Date.now() })
    return m.moneda === moneda ? m.cambioAEur : visto?.cambio ?? null
  } catch { return visto?.cambio ?? null }
}
app.get('/api/bot/posiciones', async (req, res) => {
  if (!bot) return sinBot(res)
  try {
    const [posiciones, cuenta] = await Promise.all([ig.operar.posiciones(), ig.operar.cuenta().catch(() => null)])
    const cambios = {}
    for (const p of posiciones) if (p.moneda && !(p.moneda in cambios)) cambios[p.moneda] = await cambioAEur(p.moneda, p)
    const aEur = (x, moneda) => (x == null || cambios[moneda] == null ? null : x * cambios[moneda])
    res.json({
      opera: BOT_OPERA, cuenta,
      posiciones: posiciones.map(p => ({
        ...p, bot: BOT_DE_REFERENCIA.find(([prefijo]) => p.referencia?.startsWith(prefijo))?.[1] ?? null,
        resultadoEur: aEur(p.resultado, p.moneda), alStopEur: aEur(p.alStop, p.moneda),
      })),
    })
  }
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

// ── Alpaca (server/alpaca.js): la cuenta paper, sus posiciones y órdenes, y órdenes a mano ──
// Bajo /api/bot para que en producción pida la misma clave. Ningún bot opera aquí todavía.
// La cuenta real solo con ALPACA_REAL=1.
const alpaca = crearAlpaca({ clave: process.env.ALPACA_API_KEY, secreto: process.env.ALPACA_SECRET_KEY, paper: process.env.ALPACA_REAL !== '1' })
const conAlpaca = hacer => async (req, res) => {
  if (!alpaca) return res.status(404).json({ error: 'Alpaca no está configurado (faltan ALPACA_API_KEY y ALPACA_SECRET_KEY)' })
  try { res.json(await hacer(req)) }
  catch (err) { res.status(/^Alpaca 4|no válid|Falta|tiene que|Pon la|solo pueden/.test(err.message) ? 400 : 500).json({ error: err.message }) }
}
app.get('/api/bot/alpaca', conAlpaca(async () => {
  const [cuenta, reloj, posiciones, ordenes, abiertas] = await Promise.all([alpaca.cuenta(), alpaca.reloj(), alpaca.posiciones(), alpaca.ordenes(), alpaca.ordenesAbiertas()])
  return { paper: alpaca.paper, cuenta, reloj, posiciones, ordenes, abiertas }
}))
app.post('/api/bot/alpaca/orden', conAlpaca(req => alpaca.enviarOrden(req.body ?? {})))
app.delete('/api/bot/alpaca/orden/:id', conAlpaca(req => alpaca.cancelarOrden(req.params.id)))
app.delete('/api/bot/alpaca/posicion/:simbolo', conAlpaca(req => alpaca.cerrarPosicion(req.params.simbolo)))

// ── Interactive Brokers (server/rutas-ib.js): donde haya IB Gateway e IB_PORT (en local, el de
// este PC; en producción, el servicio ib-gateway de Railway). Lo usan la vista de IB y las tortugas en IB ──
const { ib } = registrarIB({ app })

// ── Tortugas en las acciones del S&P 500, en la cuenta paper de Alpaca (server/bot-tortugas-acciones.js) ──
// Los niveles salen del diario de Yahoo del backtest (accionesEeuu); opera donde BOT_OPERA=1 y nace apagado.
const BOT_TORTUGAS_ACCIONES_PATH = process.env.BOT_TORTUGAS_ACCIONES || join(dirname(BOT_PATH), PRODUCCION ? 'bot-tortugas-acciones.json' : 'Bot Tortugas acciones.json')
const botTortugasAcciones = alpaca?.paper ? crearBotTortugasAcciones({
  alpaca, universo: SP500.acciones, archivo: BOT_TORTUGAS_ACCIONES_PATH,
  velasDiarias: async (tickers, desde) => {
    const { series, fallos } = await accionesEeuu.series(tickers, { desde })
    return { velas: Object.fromEntries(series.map(x => [x.ticker, decodificarSerie(x)])), fallos: Object.fromEntries(fallos.map(x => [x.ticker, x.error])) }
  },
  avisar: BOT_OPERA ? telegram.enviar : undefined,
}) : null
if (botTortugasAcciones && BOT_OPERA) botTortugasAcciones.arrancar()
if (botTortugasAcciones) console.log(`[tortugas acciones] registro en ${BOT_TORTUGAS_ACCIONES_PATH}; ${BOT_OPERA ? 'opera en este servidor' : 'NO opera aquí (BOT_OPERA no es 1)'}`)
const conTortugasAcciones = hacer => async (req, res) => {
  if (!botTortugasAcciones) return res.status(404).json({ error: 'Hacen falta las claves de la cuenta paper de Alpaca (ALPACA_API_KEY y ALPACA_SECRET_KEY)' })
  try { res.json(await hacer(req)) }
  catch (err) { res.status(400).json({ error: err.message }) }
}
app.get('/api/bot/tortugas-acciones', conTortugasAcciones(async () => {
  // con el precio de ahora de lo abierto y de lo que está más cerca de romper
  const precios = await alpaca.precios(botTortugasAcciones.simbolosVistos()).catch(() => ({}))
  return { archivo: BOT_TORTUGAS_ACCIONES_PATH, opera: BOT_OPERA, telegram: telegram.estado(), ...botTortugasAcciones.estado({ precios }) }
}))
app.put('/api/bot/tortugas-acciones/config', conTortugasAcciones(req => botTortugasAcciones.cambiarConfig(req.body ?? {})))
app.post('/api/bot/tortugas-acciones/parar', conTortugasAcciones(() => botTortugasAcciones.pararYCerrar()))

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
const botRule4 = bot ? crearBot({ ig, archivo: BOT_RULE4_PATH, estrategia: RULE_OF_4, cartera, noticias, avisar: BOT_OPERA ? telegram.enviar : undefined }) : null
if (botRule4 && BOT_OPERA) botRule4.arrancar()
if (botRule4) console.log(`[rule of 4] registro en ${BOT_RULE4_PATH}; ${BOT_OPERA ? 'opera en este servidor' : 'NO opera aquí (BOT_OPERA no es 1)'}`)

app.get('/api/bot/rule-of-4', (req, res) => {
  if (!botRule4) return sinBot(res)
  res.json({ archivo: BOT_RULE4_PATH, opera: BOT_OPERA, telegram: telegram.estado(), riesgoGrupoPct: cartera.estado().maxPct, noticias: noticias.estado(), ig: { sesion: ig.estado().sesion, streaming: ig.estado().streaming, cuenta: ig.estado().cuenta }, calendario: calendarioFomc.estado(), ...botRule4.estado() })
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

// ── Bot de First bar negative en la demo de IG (FIRST_BAR_NEGATIVE en server/bot-srs.js) ──
// El motor del SRS con la primera vela de 5 min de cada sesión: solo vende, y solo si esa vela
// cierra en negativo, con la pirámide de las tortugas. Como la Rule of 4: su registro, sus
// referencias (FBN-…), opera donde BOT_OPERA=1, el mismo Telegram y la misma clave. Nace apagado.
const BOT_FBN_PATH = process.env.BOT_FBN || join(dirname(BOT_PATH), process.env.NODE_ENV === 'production' ? 'bot-first-bar-negative.json' : 'Bot First bar negative.json')
// su N es la de las tortugas: la saca del mismo diario de Yahoo que el bot de las tortugas
const botFbn = bot ? crearBot({ ig, archivo: BOT_FBN_PATH, estrategia: FIRST_BAR_NEGATIVE, velasDiarias: velasDiariasTortugas, cartera, noticias, avisar: BOT_OPERA ? telegram.enviar : undefined }) : null
if (botFbn && BOT_OPERA) botFbn.arrancar()
if (botFbn) console.log(`[first bar negative] registro en ${BOT_FBN_PATH}; ${BOT_OPERA ? 'opera en este servidor' : 'NO opera aquí (BOT_OPERA no es 1)'}`)

app.get('/api/bot/first-bar-negative', (req, res) => {
  if (!botFbn) return sinBot(res)
  res.json({ archivo: BOT_FBN_PATH, opera: BOT_OPERA, telegram: telegram.estado(), riesgoGrupoPct: cartera.estado().maxPct, noticias: noticias.estado(), ig: { sesion: ig.estado().sesion, streaming: ig.estado().streaming, cuenta: ig.estado().cuenta }, ...botFbn.estado() })
})

app.put('/api/bot/first-bar-negative/config', (req, res) => {
  if (!botFbn) return sinBot(res)
  try { res.json(botFbn.cambiarConfig(req.body ?? {})) }
  catch (err) { res.status(400).json({ error: err.message }) }
})

app.post('/api/bot/first-bar-negative/parar', async (req, res) => {
  if (!botFbn) return sinBot(res)
  try { res.json(await botFbn.pararYCerrar()) }
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
    const diaria = v => ({ date: fechaEnZona(v.time, 'Europe/Madrid'), open: v.open, high: v.high, low: v.low, close: v.close })
    const desde = ahora - DIAS_IG_TORTUGAS * 86400
    try {
      return (await ig.velasEntre(ticker, 'd1', desde, ahora - 86400)).map(diaria).filter(entreSemana)
    } catch (err) {
      if (!m.datos.respaldo?.length) throw err
      return respaldoTortugas(ticker, m.datos.respaldo, ahora, err, ig.velasEnCache(ticker, 'd1', desde, ahora - 86400).map(diaria).filter(entreSemana))
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
// `guardadas`, las diarias de IG que ya están en su caché: si llegan hasta hace poco, al
// respaldo solo se le piden los días que faltan desde la última (unas pocas descargas, que
// casi nunca hacen saltar el 429 de Dukascopy), y no los 220 días.
// Si ninguna, el error lleva el de IG por delante (con el «cupo», el bot reintenta cada hora).
const SESIONES_QUE_PUEDEN_FALTAR = 6   // Navidad, Año Nuevo y algún festivo sin cotización
const DIAS_PARA_COMPLETAR = 14         // las guardadas valen si la última es de hace como mucho esto
async function respaldoTortugas(ticker, respaldo, ahora, errIg, guardadas = []) {
  const ultima = guardadas.at(-1)?.date
  const completar = guardadas.length >= 80 && ultima && ahora - Date.parse(ultima) / 1000 <= DIAS_PARA_COMPLETAR * 86400
  // desde dos días antes de la última guardada: la primera sesión que se baje puede ir a medias, y se descarta
  const desde = completar ? Date.parse(ultima) / 1000 - 2 * 86400 : ahora - DIAS_IG_TORTUGAS * 86400
  const fallos = [errIg.message]
  for (const r of respaldo) {
    try {
      const horas = r.fuente === 'Twelve Data' ? await horasTwelveData(r.simbolo, desde, ahora)
        : r.fuente === 'Dukascopy' ? await horasDukascopy(r.instrumento, desde, ahora)
        : []
      if (completar) {
        const nuevas = diariasDeSesiones(ticker, horas).filter(d => d.date > ultima)
        const faltan = sesionesQueFaltan([guardadas.at(-1), ...nuevas])
        if (faltan > 1) throw new Error(`le faltan ${faltan} sesiones desde el ${ultima}`)
        // sin nada nuevo, que sea porque no ha habido sesión (un fin de semana), no porque no haya bajado nada
        const hasta = (nuevas.at(-1) ?? guardadas.at(-1)).date
        if (ahora - Date.parse(hasta) / 1000 > 4 * 86400) throw new Error(`no da nada después del ${hasta}`)
        const dias = [...guardadas, ...nuevas]
        dias.respaldo = nuevas.length ? `IG y, desde el ${nuevas[0].date}, ${r.fuente}` : 'IG (lo guardado)'
        return dias
      }
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

// El último diario que pidió el bot de cada mercado, para comparar en la pestaña sus operaciones
// con el backtest sobre las mismas velas (/api/bot/tortugas/diarios)
const diariosTortugas = new Map()
async function velasDiariasTortugasGuardadas(ticker) {
  const velas = await velasDiariasTortugas(ticker)
  diariosTortugas.set(ticker, { velas, hora: Date.now(), fuente: velas.respaldo ?? (MERCADOS_TORTUGAS[ticker].datos.fuente === 'ig' ? 'IG' : 'Yahoo') })
  return velas
}

const botTortugas = bot ? crearBotTortugas({ ig, velasDiarias: velasDiariasTortugasGuardadas, archivo: BOT_TORTUGAS_PATH, cartera, noticias, avisar: BOT_OPERA ? telegram.enviar : undefined }) : null
if (botTortugas && BOT_OPERA) botTortugas.arrancar()
if (botTortugas) console.log(`[tortugas] registro en ${BOT_TORTUGAS_PATH}; ${BOT_OPERA ? 'opera en este servidor' : 'NO opera aquí (BOT_OPERA no es 1)'}`)

// ── Tortugas en Interactive Brokers (server/tortugas-ib.js), en la cuenta paper ──
// El mismo bot con los mercados de IB: índices con ETF de Xetra, divisas al contado y futuros.
// Los niveles salen del diario de IB de cada contrato; si IB no lo da, el de los ETF y las divisas
// sale de Yahoo (los futuros no: un continuo de Yahoo no cotiza como el vencimiento que se opera).
// Como los demás: opera solo donde BOT_OPERA=1, nace apagado y avisa por el mismo Telegram.
const BOT_TORTUGAS_IB_PATH = process.env.BOT_TORTUGAS_IB || join(dirname(BOT_PATH), PRODUCCION ? 'bot-tortugas-ib.json' : 'Bot Tortugas IB.json')
const tortugasIB = ib ? crearTortugasIB({ ib }) : null
const diariosTortugasIB = new Map()
async function velasDiariasTortugasIB(ticker) {
  let velas
  try { velas = await tortugasIB.velasDiarias(ticker) } catch (err) {
    const m = MERCADOS_IB[ticker]
    if (!m.datos.yahoo) throw err
    const hasta = Math.floor(Date.now() / 3_600_000) * 3600
    velas = (await obtenerRangoYahoo(m.datos.yahoo, '1d', hasta - 365 * 86400, hasta))
      .map(v => ({ date: fechaEnZona(v.time, m.datos.zona ?? m.zona), open: v.open, high: v.high, low: v.low, close: v.close })).filter(entreSemana)
    velas.respaldo = 'Yahoo'
  }
  diariosTortugasIB.set(ticker, { velas, hora: Date.now(), fuente: velas.respaldo ?? 'IB' })
  return velas
}
const botTortugasIB = tortugasIB ? crearBotTortugas({
  ...tortugasIB, velasDiarias: velasDiariasTortugasIB, archivo: BOT_TORTUGAS_IB_PATH, noticias,
  broker: 'IB', nombre: 'Tortugas IB', avisar: BOT_OPERA ? telegram.enviar : undefined,
}) : null
// primero los contratos y sus precios; después el bot
if (botTortugasIB && BOT_OPERA) tortugasIB.arrancar().finally(() => botTortugasIB.arrancar())
if (botTortugasIB) console.log(`[tortugas ib] registro en ${BOT_TORTUGAS_IB_PATH}; ${BOT_OPERA ? 'opera en este servidor' : 'NO opera aquí (BOT_OPERA no es 1)'}`)

// ── Vigilancia de los bots (ver server/vigilancia.js) ──
// Cada 30 s mira si los bots en marcha siguen dando vueltas, y avisa por Telegram si uno lleva
// 2 min sin completar ninguna. /healthz/bots da lo mismo, con 503 si alguno está parado, y lo
// que se ha bloqueado el bucle de eventos: es para un vigilante de fuera (UptimeRobot o
// similar), que es el único que puede avisar si se cae el proceso entero. Sin clave: no
// enseña nada más que esto.
const vigilancia = crearVigilancia({
  bots: Object.fromEntries([['SRS', bot], ['Rule of 4', botRule4], ['First bar negative', botFbn], ['Tortugas', botTortugas], ['Tortugas IB', botTortugasIB], ['Tortugas acciones', botTortugasAcciones]].filter(([, b]) => b).map(([nombre, b]) => [nombre, b.latido])),
  avisar: avisarServidor,
})
if (BOT_OPERA) setInterval(vigilancia.revisar, 30_000)

// ── Conciliación con IG y resumen del día (server/conciliacion.js, server/resumen-diario.js) ──
// Cada media hora, lo que los bots creen tener frente a lo que hay en IG; y de lunes a viernes a
// las 23:15 de Madrid, el resumen del día. Los dos solo donde operan los bots.
const conciliacion = bot ? crearConciliacion({ ig, cartera, avisar: avisarServidor }) : null
const salidaHoy = (hora, fecha) => hora != null && fechaEnZona(hora, 'Europe/Madrid') === fecha
const cerradasSrs = b => fecha => {
  const e = b.estado()
  return [...e.hoy, ...e.historial].filter(d => d.resultadoEur != null && salidaHoy(d.salida?.hora, fecha)).map(d => d.resultadoEur)
}
const resumenDiario = bot ? crearResumenDiario({
  ig, cartera, archivo: join(dirname(BOT_PATH), 'resumen-diario.json'), avisar: avisarServidor,
  bots: [
    ...[['SRS', bot], ['Rule of 4', botRule4], ['First bar negative', botFbn]].filter(([, b]) => b).map(([nombre, b]) => ({ nombre, cerradasHoy: cerradasSrs(b) })),
    ...(botTortugas ? [{ nombre: 'Tortugas', cerradasHoy: fecha => botTortugas.estado().operaciones.filter(o => o.resultadoEur != null && salidaHoy(o.cerradaHora, fecha)).map(o => o.resultadoEur) }] : []),
  ],
}) : null
if (BOT_OPERA) { conciliacion?.iniciar(); resumenDiario?.iniciar() }

// Cómo va la copia del histórico de Dukascopy en el servidor online (qué zips tiene y de cuándo)
app.get('/api/dukascopy-historico', (_req, res) => {
  res.json(sincronizacionHistorico
    ? { fuente: 'zips', dir: HISTORICO_ZIPS_DIR, ...sincronizacionHistorico.estado() }
    : { fuente: process.env.NODE_ENV === 'production' ? null : 'carpeta' })
})

const bucle = medirBucle()
app.get('/healthz/bots', (_req, res) => {
  const e = vigilancia.estado()
  res.status(e.ok ? 200 : 503).json({ ...e, opera: BOT_OPERA, bucle: bucle() })
})

// Todo lo que dice si el servidor está sano, junto (server/salud.js), para la vista Salud de la
// pestaña Bots. Va bajo /api/bot, con su clave: enseña el estado de IG y de la cuenta.
const ARRANCADO = new Date().toISOString()
// Perfil de CPU de unos minutos, para ver qué bloquea el bucle (server/perfil.js): POST con
// { segundos } lo enciende y GET da el último resumen
const perfilador = crearPerfilador()
app.get('/api/bot/perfil', (_req, res) => res.json(perfilador.estado()))
app.post('/api/bot/perfil', async (req, res) => {
  try { res.json(await perfilador.empezar(req.body?.segundos)) } catch (err) { res.status(409).json({ error: err.message }) }
})

app.get('/api/bot/salud', (_req, res) => {
  const e = ig?.estado()
  const s = {
    servidor: {
      arrancado: ARRANCADO, opera: BOT_OPERA, produccion: PRODUCCION,
      commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null, mensaje: process.env.RAILWAY_GIT_COMMIT_MESSAGE ?? null,
    },
    bots: vigilancia.estado(),
    bucle: bucle(),
    ig: e ? { sesion: e.sesion, streaming: e.streaming, cuenta: e.cuenta, error: e.error, cupo: e.cupo } : null,
    fuentes: {
      dukascopy: { limitando: dukascopyLimitando(10 * 60_000), ...estadoTransporteDukascopy() },
      twelveData: { clave: !!process.env.TWELVEDATA_API_KEY },
    },
    grabacion: grabacion ? { error: grabacion.resumen().error } : null,
    calendarioFomc: calendarioFomc.estado(),
    noticias: noticias.estado(),
    telegram: telegram.estado(),
    conciliacion: conciliacion?.estado() ?? null,
  }
  res.json({ ...s, avisos: avisosDeSalud(s) })
})

// Resumen de los bots para quien no tiene la clave (server/resumen-bots.js): fuera de /api/bot a
// propósito. Solo lee, sin euros ni saldo, y guardado 30 s para no gastar peticiones de IG.
const ultimoResumen = { posIg: [], cuentaIg: null, posAlpaca: [], cuentaAlpaca: null }
const resumenBots = crearCacheResumen(async () => {
  const t = Math.floor(Date.now() / 1000)
  const motorSrs = [['SRS', bot], ['Rule of 4', botRule4], ['First bar negative', botFbn]].filter(([, b]) => b)
  const bots = [
    ...motorSrs.map(([nombre, b]) => ({ nombre, cuenta: 'ig', activo: () => b.estado().config.activo, cerradas: () => cerradasMotorSrs(b.estado()), info: () => infoMotorSrs(b.estado(), t) })),
    ...(botTortugas ? [{ nombre: 'Tortugas', cuenta: 'ig', activo: () => botTortugas.estado().config.activo, cerradas: () => cerradasTortugas(botTortugas.estado()), info: () => infoTortugas(botTortugas.estado()) }] : []),
    ...(botTortugasIB ? [{ nombre: 'Tortugas IB', cuenta: 'ib', activo: () => botTortugasIB.estado().config.activo, cerradas: () => cerradasTortugas(botTortugasIB.estado()), info: () => infoTortugas(botTortugasIB.estado()) }] : []),
    ...(botTortugasAcciones ? [{ nombre: 'Tortugas acciones', cuenta: 'alpaca', activo: () => botTortugasAcciones.estado().config.activo, cerradas: () => cerradasTortugasAcciones(botTortugasAcciones.estado()), info: () => ({ instrumentos: SP500.acciones.length }) }] : []),
  ]
  const nombres = new Map()
  for (const [, b] of motorSrs) for (const s of b.estado().sesiones) nombres.set(s.ticker, s.nombre)
  for (const m of botTortugas?.estado().mercados ?? []) nombres.set(m.ticker, m.nombre)
  // si IG o Alpaca no contestan (recién arrancado, p. ej.), lo último que dieron: mejor eso que nada
  const [posIg, cuentaIg, posAlpaca, cuentaAlpaca, cuentaIb] = await Promise.all([
    bot ? ig.operar.posiciones().then(x => (ultimoResumen.posIg = x)).catch(() => ultimoResumen.posIg) : [],
    bot ? ig.operar.cuenta().then(x => (x?.saldo != null ? (ultimoResumen.cuentaIg = x) : ultimoResumen.cuentaIg)).catch(() => ultimoResumen.cuentaIg) : null,
    botTortugasAcciones ? alpaca.posiciones().then(x => (ultimoResumen.posAlpaca = x)).catch(() => ultimoResumen.posAlpaca) : [],
    botTortugasAcciones ? alpaca.cuenta().then(x => (ultimoResumen.cuentaAlpaca = x)).catch(() => ultimoResumen.cuentaAlpaca) : null,
    botTortugasIB ? tortugasIB.operar.cuenta().then(x => (ultimoResumen.cuentaIb = x)).catch(() => ultimoResumen.cuentaIb) : null,
  ])
  // IG da el resultado en la moneda de cada posición (yenes en el USD/JPY): a euros, como el saldo
  const cambios = {}
  for (const p of posIg) if (p.moneda && !(p.moneda in cambios)) cambios[p.moneda] = await cambioAEur(p.moneda, p)
  const delBotAcciones = new Set(Object.values(botTortugasAcciones?._datos().posiciones ?? {}).map(p => p.simbolo))
  // lo que daría cada acción del bot si saltara su stop: sus unidades, desde su entrada hasta el stop
  const alStopAcciones = new Map(Object.values(botTortugasAcciones?._datos().posiciones ?? {}).map(p => {
    const sentido = p.lado === 'corto' ? -1 : 1
    const us = p.unidades ?? []
    return [p.simbolo, p.stop != null && us.length && us.every(u => u.entrada != null && u.acciones != null) ? us.reduce((s, u) => s + sentido * (p.stop - u.entrada) * u.acciones, 0) : null]
  }))
  return resumenPublico({
    bots, t, vigilancia: vigilancia.estado(),
    saldoIg: cuentaIg?.saldo ?? null,
    posicionesIg: posIg.map(p => ({
      bot: BOT_DE_REFERENCIA.find(([prefijo]) => p.referencia?.startsWith(prefijo))?.[1] ?? null,
      instrumento: nombres.get(p.ticker) ?? p.nombre ?? p.epic, lado: p.lado,
      resultado: p.resultado == null || cambios[p.moneda] == null ? null : p.resultado * cambios[p.moneda],
      alStop: p.alStop == null || cambios[p.moneda] == null ? null : p.alStop * cambios[p.moneda],
      // IG da la hora de apertura en UTC sin la Z
      desde: p.abierta ? Math.floor(Date.parse(/Z$/.test(p.abierta) ? p.abierta : `${p.abierta}Z`) / 1000) || null : null,
    })),
    saldoAlpaca: cuentaAlpaca?.equity ?? null,
    posicionesAlpaca: posAlpaca.filter(p => delBotAcciones.has(p.simbolo)).map(p => ({ bot: 'Tortugas acciones', instrumento: p.simbolo, lado: p.lado, desde: null, resultado: p.resultado, alStop: alStopAcciones.get(p.simbolo) ?? null })),
    saldoIb: cuentaIb?.saldo ?? null,
    posicionesIb: botTortugasIB ? posicionesTortugasIB() : [],
  })
})
// Las unidades del bot de las tortugas en IB para el resumen (como las posiciones de IG, una por
// unidad), con lo que llevan y lo que darían en su stop, en euros, al último precio de su contrato
function posicionesTortugasIB() {
  return botTortugasIB.estado().mercados.flatMap(m => Object.values(m.posiciones).filter(Boolean).flatMap(p => {
    const precio = tortugasIB.precios.velas(p.ticker, 1, p.epic).at(-1)?.close ?? null
    const enEur = (u, nivel) => (p.lado === 'largo' ? 1 : -1) * (nivel - u.entrada) * u.tamano * p.valorPunto * p.cambioAEur
    return p.unidades.filter(u => !u.salida).map(u => ({
      bot: 'Tortugas IB', instrumento: m.nombre, lado: p.lado, desde: u.hora ?? null,
      resultado: precio == null ? null : enEur(u, precio),
      alStop: p.stop == null ? null : enEur(u, p.stop),
    }))
  }))
}
app.get('/api/resumen-bots', async (_req, res) => {
  try { res.json(await resumenBots()) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/bot/tortugas', (req, res) => {
  if (!botTortugas) return sinBot(res)
  res.json({ archivo: BOT_TORTUGAS_PATH, opera: BOT_OPERA, telegram: telegram.estado(), riesgoGrupoPct: cartera.estado().maxPct, noticias: noticias.estado(), ig: { sesion: ig.estado().sesion, streaming: ig.estado().streaming, cuenta: ig.estado().cuenta }, ...botTortugas.estado() })
})

// El diario de cada mercado del bot de las tortugas: el que usó el bot si es de hace menos de
// 6 h; si no, Yahoo otra vez (con su caché) o, en los de IG, lo que haya en la caché de IG,
// sin pedirle nada: el cupo semanal de histórico es para el bot.
const DIARIO_FRESCO_MS = 6 * 3600_000
app.get('/api/bot/tortugas/diarios', async (req, res) => {
  if (!botTortugas) return sinBot(res)
  const salida = {}
  await Promise.all(Object.keys(MERCADOS_TORTUGAS).map(async ticker => {
    let g = diariosTortugas.get(ticker)
    if (!g || Date.now() - g.hora > DIARIO_FRESCO_MS) {
      try {
        if (MERCADOS_TORTUGAS[ticker].datos.fuente !== 'ig') {
          await velasDiariasTortugasGuardadas(ticker)
          g = diariosTortugas.get(ticker)
        } else if (!g) {
          const ahora = Math.floor(Date.now() / 1000)
          const velas = ig.velasEnCache(ticker, 'd1', ahora - DIAS_IG_TORTUGAS * 86400, ahora - 86400)
            .map(v => ({ date: fechaEnZona(v.time, 'Europe/Madrid'), open: v.open, high: v.high, low: v.low, close: v.close })).filter(entreSemana)
          g = { velas, hora: null, fuente: 'IG (caché)' }
        }
      } catch (err) { if (!g) return void (salida[ticker] = { error: err.message }) }
    }
    salida[ticker] = { fuente: g.fuente, hora: g.hora, velas: g.velas.map(v => [v.date, v.open, v.high, v.low, v.close]) }
  }))
  res.json(salida)
})

app.put('/api/bot/tortugas/config', (req, res) => {
  if (!botTortugas) return sinBot(res)
  try { res.json(botTortugas.cambiarConfig(req.body ?? {})) }
  catch (err) { res.status(400).json({ error: err.message }) }
})

// Aprieta a mano el stop de una posición del bot: { ticker, sistema, stop }
app.post('/api/bot/tortugas/stop', async (req, res) => {
  if (!botTortugas) return sinBot(res)
  const { ticker, sistema, stop } = req.body ?? {}
  try { res.json(await botTortugas.apretarStop(ticker, sistema, stop)) }
  catch (err) { res.status(400).json({ error: err.message }) }
})

// Cierra a mano la posición de un mercado y sistema: { ticker, sistema }
app.post('/api/bot/tortugas/cerrar', async (req, res) => {
  if (!botTortugas) return sinBot(res)
  const { ticker, sistema } = req.body ?? {}
  try { res.json(await botTortugas.cerrarMercado(ticker, sistema)) }
  catch (err) { res.status(400).json({ error: err.message }) }
})

app.post('/api/bot/tortugas/parar', async (req, res) => {
  if (!botTortugas) return sinBot(res)
  try { res.json(await botTortugas.pararYCerrar()) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

// Las tortugas en IB: lo mismo que las de IG, bajo /api/bot/tortugas-ib
const sinBotIB = res => res.status(404).json({ error: 'Las tortugas en IB necesitan IB_PORT en este servidor' })
app.get('/api/bot/tortugas-ib', async (req, res) => {
  if (!botTortugasIB) return sinBotIB(res)
  const cuenta = await ib.estado().catch(err => ({ conectado: false, error: err.message }))
  res.json({
    archivo: BOT_TORTUGAS_IB_PATH, opera: BOT_OPERA, telegram: telegram.estado(), noticias: noticias.estado(), broker: 'IB',
    ib: { conectado: cuenta.conectado, error: cuenta.error ?? null, cuenta: cuenta.cuenta ?? null, paper: cuenta.paper ?? null, moneda: cuenta.resumen?.moneda ?? null },
    contratos: tortugasIB.estado(),
    ...botTortugasIB.estado(),
  })
})
app.get('/api/bot/tortugas-ib/diarios', async (req, res) => {
  if (!botTortugasIB) return sinBotIB(res)
  const salida = {}
  await Promise.all(Object.keys(MERCADOS_IB).map(async ticker => {
    let g = diariosTortugasIB.get(ticker)
    if (!g || Date.now() - g.hora > DIARIO_FRESCO_MS) {
      try { await velasDiariasTortugasIB(ticker); g = diariosTortugasIB.get(ticker) } catch (err) { if (!g) return void (salida[ticker] = { error: err.message }) }
    }
    salida[ticker] = { fuente: g.fuente, hora: g.hora, velas: g.velas.map(v => [v.date, v.open, v.high, v.low, v.close]) }
  }))
  res.json(salida)
})
app.put('/api/bot/tortugas-ib/config', (req, res) => {
  if (!botTortugasIB) return sinBotIB(res)
  try { res.json(botTortugasIB.cambiarConfig(req.body ?? {})) }
  catch (err) { res.status(400).json({ error: err.message }) }
})
app.post('/api/bot/tortugas-ib/stop', async (req, res) => {
  if (!botTortugasIB) return sinBotIB(res)
  const { ticker, sistema, stop } = req.body ?? {}
  try { res.json(await botTortugasIB.apretarStop(ticker, sistema, stop)) }
  catch (err) { res.status(400).json({ error: err.message }) }
})
app.post('/api/bot/tortugas-ib/cerrar', async (req, res) => {
  if (!botTortugasIB) return sinBotIB(res)
  const { ticker, sistema } = req.body ?? {}
  try { res.json(await botTortugasIB.cerrarMercado(ticker, sistema)) }
  catch (err) { res.status(400).json({ error: err.message }) }
})
app.post('/api/bot/tortugas-ib/parar', async (req, res) => {
  if (!botTortugasIB) return sinBotIB(res)
  try { res.json(await botTortugasIB.pararYCerrar()) }
  catch (err) { res.status(500).json({ error: err.message }) }
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
