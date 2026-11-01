// ── Lo que solo sirve en local: el diario «DAY <año>» de Google Sheets, los dibujos de la
// pestaña Gráfico, el historial de la cuenta y el pipeline de trading. Sacado de
// server/index.js.

import { limpiarDibujos, claveValida } from './dibujos.js'
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import { GoogleAuth } from 'google-auth-library'

export function registrarLocales({ PHOTOS_ROOT, app }) {
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

  return {  }
}
