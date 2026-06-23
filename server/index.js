import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { getHistoricalRates } from 'dukascopy-node'
import { getEventIndex, getEventosEnFecha } from './eventos.js'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'

// Cache en disco para datos Dukascopy (usa /tmp en producción, local en dev)
const DISK_CACHE_DIR = process.env.NODE_ENV === 'production'
  ? '/tmp/.duka-cache'
  : join(import.meta.dirname, '.duka-cache')
try { mkdirSync(DISK_CACHE_DIR, { recursive: true }) } catch { /* non-critical */ }

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
  'xauusd':        [0,         23*60+30],  // Oro    día completo
  'xagusd':        [0,         23*60+30],  // Plata  día completo
  'usoususd':      [0,         23*60+30],  // Petróleo día completo
}

const app  = express()
const PORT = process.env.PORT || 3001
app.use(cors())
app.use(express.json())

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
async function obtenerVelasDiariasDesde30m(instrument) {
  const [sessionOpenMin, sessionCloseMin] = DUKA_SESSION_LONDON[instrument] ?? [8*60, 16*60+30]
  const cacheKey = `h1daily_${instrument}`
  const cached   = fromCache(cacheKey)
  if (cached) return cached

  const from = new Date()
  from.setFullYear(from.getFullYear() - 5)

  console.log(`[Dukascopy H1→Diario] Descargando ${instrument} (primera vez ~30s)…`)
  const bars = await getHistoricalRates({
    instrument,
    dates:     { from, to: new Date() },
    timeframe: 'h1',
  })

  const dayMap = new Map()
  for (const [ts, open, , , close] of bars) {
    const lm = getLondonMinutes(ts)
    if (lm < sessionOpenMin || lm >= sessionCloseMin) continue
    const date = getLondonDateStr(ts)
    if (!dayMap.has(date)) dayMap.set(date, { time: Math.floor(ts / 1000), open, close })
    else dayMap.get(date).close = close
  }

  const velas = [...dayMap.values()].filter(v => v.open && v.close)
  toCache(cacheKey, velas, 4 * 60 * 60_000)
  console.log(`[Dukascopy H1→Diario] ${instrument}: ${velas.length} días`)
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

// ── Yahoo Finance: velas 15 min para un día concreto ──────────────────────
async function obtenerVelas15mDia(ticker, date) {
  const cached = fromCache(`15m_${ticker}_${date}`)
  if (cached) return cached

  const auth  = await getYFAuth()
  const p1    = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000)
  const p2    = p1 + 2 * 86400
  const sym   = encodeURIComponent(ticker)
  const crumb = auth ? `&crumb=${encodeURIComponent(auth.crumb)}` : ''
  const hdrs  = auth ? { ...YF_HEADERS, 'Cookie': auth.cookie } : YF_HEADERS
  const url   = `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=15m&period1=${p1}&period2=${p2}${crumb}`
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

  toCache(`15m_${ticker}_${date}`, velas)
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

  // 2. Cache en disco (solo para fechas pasadas)
  const ayer    = new Date(Date.now() - 86400_000).toISOString().slice(0, 10)
  const useDisk = date < ayer

  if (useDisk) {
    const disk = diskCacheGet(cacheKey)
    if (disk) {
      toCache(cacheKey, disk, 6 * 60 * 60_000)
      return disk
    }
  }

  console.log(`[Dukascopy] Descargando ${instrument} ${date} (${tf})…`)
  const from = new Date(date + 'T00:00:00Z')
  const to   = new Date(date + 'T23:59:00Z')

  const data = await getHistoricalRates({
    instrument,
    dates:     { from, to },
    timeframe: tf,
  })

  const velas = data.map(([ts, open, high, low, close, volume]) => ({
    time:   Math.floor(ts / 1000),
    open, high, low, close,
    volume: volume ?? 0,
  }))

  toCache(cacheKey, velas, 6 * 60 * 60_000)
  if (useDisk && velas.length > 0) diskCacheSet(cacheKey, velas)
  return velas
}

// ── Gap Filter ─────────────────────────────────────────────────────────────
app.get('/api/gap-filter', async (req, res) => {
  try {
    const ticker = req.query.ticker ?? '^GDAXI'
    const dias   = req.query.dias ? req.query.dias.split(',').map(Number) : [1,2,3,4,5]
    const dir    = req.query.dir  ?? 'both'
    const gapMin = parseFloat(req.query.gapMin ?? 0)
    const meses  = Math.min(60, Math.max(1, parseInt(req.query.meses ?? 12, 10)))

    const diarias = await obtenerVelasDiarias(ticker)

    // Filtrar al periodo solicitado
    const cutoff  = Date.now() / 1000 - meses * 31 * 86400
    const periodo = diarias.filter(v => v.time >= cutoff)

    const evIdx    = await getEventIndex()
    const sesiones = []

    for (let i = 1; i < periodo.length; i++) {
      const curr = periodo[i]
      const prev = periodo[i - 1]

      const gapPct    = (curr.open - prev.close) / prev.close * 100
      const gapDir    = gapPct >= 0 ? 'up' : 'down'
      const date      = getMadridDate(curr.time)
      const dayOfWeek = getMadridDay(curr.time)
      const eventos   = getEventosEnFecha(evIdx, date)

      if (!dias.includes(dayOfWeek))         continue
      if (dir !== 'both' && gapDir !== dir)   continue
      if (Math.abs(gapPct) < gapMin - 0.001) continue

      sesiones.push({
        date, dayOfWeek,
        gapPct:    parseFloat(gapPct.toFixed(3)),
        gapDir,
        prevClose: prev.close,
        openPrice: curr.open,
        eventos,
      })
    }

    const fechaInicio = periodo[0] ? getMadridDate(periodo[0].time) : null
    const periodoLabel = meses >= 12 ? `${meses / 12}a` : `${meses}m`
    const fuenteDiaria = DUKASCOPY_DAILY[ticker]
      ? `Dukascopy · ${periodoLabel}`
      : `Stooq 1d · ${periodoLabel}`
    res.json({ ticker, sesiones, total: sesiones.length, fuente: fuenteDiaria, fechaInicio })
  } catch (err) {
    console.error('[gap-filter]', err.message)
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

// ── Velas intraday para una sesión concreta (carga bajo demanda) ──────────
// Usa Dukascopy siempre (fuente única, sin límite de 60 días de Yahoo Finance)
app.get('/api/velas15m', async (req, res) => {
  try {
    const { ticker, date, timeframe = 'm15' } = req.query
    if (!ticker || !date) return res.status(400).json({ error: 'ticker y date requeridos' })

    const instrument = YF_TO_DUKASCOPY[ticker]
    let velas, fuente

    if (instrument) {
      velas  = await obtenerVelasDukascopy(instrument, date, timeframe)
      fuente = `Dukascopy ${timeframe}`
    } else {
      // Acciones individuales: Stooq (5m → 60m → 1d), Yahoo como último recurso
      try {
        const result = await obtenerVelasIntradayStooq(ticker, date)
        velas  = result.velas
        fuente = result.fuente
      } catch (stooqErr) {
        console.warn(`[Stooq intraday] falló para ${ticker}:`, stooqErr.message)
        velas  = await obtenerVelas15mDia(ticker, date)
        fuente = 'Yahoo Finance 15m'
      }
    }

    res.json({ ticker, date, velas, fuente })
  } catch (err) {
    console.error('[velas15m]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Pipeline trading (solo local — en producción lo gestionan GitHub Actions) ──
const TRADING_DIR = process.env.TRADING_DIR || 'G:\\Mi unidad\\codigos\\Server'
const PIPELINE = [
  { id: 'sync',      label: 'TradeNation Sync',  file: 'TradeNation_sync.py' },
  { id: 'historial', label: 'Historial Total',    file: 'actualizar_historial_total.py' },
  { id: 'charts',    label: 'Chart Capture',      file: 'chart_capture.py' },
  { id: 'collage',   label: 'Collage',            file: 'collage.py' },
]

// Construye los args extra para cada script según los params recibidos
function buildArgs(scriptId, params) {
  const extra = []
  if (scriptId === 'collage' || scriptId === 'all') {
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor en http://localhost:${PORT}`)
})
