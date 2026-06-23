import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { getHistoricalRates } from 'dukascopy-node'
import { getEventIndex, getEventosEnFecha } from './eventos.js'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'

// Cache persistente en disco para datos Dukascopy 15m (sobrevive reinicios)
const DISK_CACHE_DIR = join(import.meta.dirname, '.duka-cache')
mkdirSync(DISK_CACHE_DIR, { recursive: true })

function diskCacheGet(key) {
  const file = join(DISK_CACHE_DIR, key.replace(/[^a-z0-9_-]/gi, '_') + '.json')
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}
function diskCacheSet(key, data) {
  const file = join(DISK_CACHE_DIR, key.replace(/[^a-z0-9_-]/gi, '_') + '.json')
  try { writeFileSync(file, JSON.stringify(data)) } catch { /* no crítico */ }
}

// Tickers para velas 15m (fallback cuando Yahoo no tiene datos)
const YF_TO_DUKASCOPY = {
  '^GSPC':  'usa500idxusd',
  '^NDX':   'usatechidxusd',
  '^DJI':   'usa30idxusd',
  '^GDAXI': 'deuidxeur',
  '^FTSE':  'gbridxgbp',
  'SPY':    'usa500idxusd',
  'QQQ':    'usatechidxusd',
}

// Yahoo Finance bloquea IPs de datacenter → usar Dukascopy H1 para todos los índices
const DUKASCOPY_DAILY = {
  '^FTSE':  'gbridxgbp',
  '^GDAXI': 'deuidxeur',
  '^GSPC':  'usa500idxusd',
  '^NDX':   'usatechidxusd',
  '^DJI':   'usa30idxusd',
  'SPY':    'usa500idxusd',
  'QQQ':    'usatechidxusd',
}

const app  = express()
const PORT = process.env.PORT || 3001
app.use(cors())
app.use(express.json())

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json, text/plain, */*',
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

// ── Dukascopy H1 → barras diarias con open/close real de sesión ──────────
// FTSE: sesión 08:00-16:30 Londres (09:00-17:30 Madrid)
// Con H1: open = barra 08:00 Londres | close = barra 16:00-17:00 Londres
// (el cierre oficial 16:30 cae dentro de esa barra → precio representativo)
// H1 descarga en ~30s frente a >3 min de 30m (distintas estructuras de ficheros en CDN)
async function obtenerVelasDiariasDesde30m(instrument, sessionOpenMin = 8*60, sessionCloseMin = 17*60) {
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
  toCache(cacheKey, velas, 60 * 60_000)
  console.log(`[Dukascopy H1→Diario] ${instrument}: ${velas.length} días`)
  return velas
}

// ── Yahoo Finance: datos diarios para gap detection (hasta 5 años) ─────────
async function obtenerVelasDiarias(ticker) {
  // Para tickers con open incorrecto en Yahoo, usar Dukascopy H1
  const dukaInstrument = DUKASCOPY_DAILY[ticker]
  if (dukaInstrument) return obtenerVelasDiariasDesde30m(dukaInstrument)

  const cached = fromCache(`1d_${ticker}`)
  if (cached) return cached

  const sym  = encodeURIComponent(ticker)
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5y`
  const resp = await fetch(url, { headers: YF_HEADERS })
  const json = await resp.json()
  const r    = json.chart?.result?.[0]
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

  const p1   = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000)
  const p2   = p1 + 2 * 86400
  const sym  = encodeURIComponent(ticker)
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=15m&period1=${p1}&period2=${p2}`
  const resp = await fetch(url, { headers: YF_HEADERS })
  const json = await resp.json()
  const r = json.chart?.result?.[0]
  if (!r) return []   // fecha antigua o sin datos → fallback a Dukascopy

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
    const fuenteDiaria = DUKASCOPY_DAILY[ticker] ? `Dukascopy H1 (${meses}m)` : `Yahoo 1d (${meses}m)`
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
      // Fallback Yahoo para tickers sin mapping en Dukascopy (siempre 15m)
      velas  = await obtenerVelas15mDia(ticker, date)
      fuente = 'Yahoo Finance 15m'
    }

    res.json({ ticker, date, velas, fuente })
  } catch (err) {
    console.error('[velas15m]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Pipeline trading ──────────────────────────────────────────────────────
const TRADING_DIR = 'G:\\Mi unidad\\codigos'
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
  // Pre-cargar en background los índices con datos diarios de Dukascopy
  for (const instrument of Object.values(DUKASCOPY_DAILY)) {
    obtenerVelasDiariasDesde30m(instrument)
      .catch(err => console.error(`[Pre-carga ${instrument}]`, err.message))
  }
})
