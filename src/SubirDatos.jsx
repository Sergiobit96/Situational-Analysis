import { useState, useRef, useCallback } from 'react'
import GraficoVelas from './GraficoVelas'

// ── Parsers ──────────────────────────────────────────────────────────────────

function parseFecha(dateStr, timeStr = '') {
  const s = dateStr.trim()
  if (!s) return null

  // Unix timestamp numérico (segundos o milisegundos)
  if (/^\d{9,13}$/.test(s) && !timeStr) {
    const n = Number(s)
    return n > 1e12 ? Math.floor(n / 1000) : n
  }

  // Combinar date + time, normalizar separadores de fecha
  let combined = (s + (timeStr ? ' ' + timeStr.trim() : ''))
    .replace(/(\d{4})\.(\d{2})\.(\d{2})/, '$1-$2-$3')   // 2024.01.02 → 2024-01-02
    .replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$1-$2')   // MM/DD/YYYY → YYYY-MM-DD
    .replace(/(\d{2})-(\d{2})-(\d{4})/, '$3-$1-$2')     // MM-DD-YYYY → YYYY-MM-DD (heurístico)
    .trim()

  // Añadir sufijo UTC si falta
  if (/\d{2}:\d{2}/.test(combined)) {
    if (!combined.includes('Z') && !combined.includes('+'))
      combined = combined.replace(' ', 'T') + 'Z'
  } else {
    combined += 'T00:00:00Z'
  }

  const d = new Date(combined)
  return isNaN(d) ? null : Math.floor(d.getTime() / 1000)
}

function detectDelim(text) {
  const line = text.split('\n')[0]
  const t = (line.match(/\t/g) || []).length
  const c = (line.match(/,/g) || []).length
  const s = (line.match(/;/g) || []).length
  return t >= c && t >= s ? '\t' : s > c ? ';' : ','
}

function normHeader(h) {
  return h.trim().replace(/^[<\s]+|[>\s]+$/g, '').toLowerCase().replace(/[^a-z]/g, '')
}

function parseCSV(text) {
  const delim   = detectDelim(text)
  const lines   = text.trim().split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) throw new Error('El archivo tiene menos de 2 líneas')

  const headers = lines[0].split(delim).map(normHeader)
  const find    = (...opts) => headers.findIndex(h => opts.includes(h))

  // Detectar columnas por nombre normalizado
  const iDate  = find('date','datetime','time','timestamp','fecha','dt')
  const iTime  = headers.findIndex((h, i) => i !== iDate && ['time','hora','hhmm'].includes(h))
  const iOpen  = find('open','apertura')
  const iHigh  = find('high','max','maximo','alto')
  const iLow   = find('low','min','minimo','bajo')
  const iClose = find('close','adjclose','cierre')
  const iVol   = find('vol','volume','tickvol','volumen','volum')

  if (iDate  === -1) throw new Error('No se encontró columna de fecha (date, datetime, timestamp…)')
  if (iOpen  === -1 || iClose === -1) throw new Error('No se encontraron columnas OHLC (open, close…)')

  const velas = []
  for (let i = 1; i < lines.length; i++) {
    const cols    = lines[i].split(delim)
    const timeStr = iTime !== -1 ? (cols[iTime] ?? '') : ''
    const time    = parseFecha(cols[iDate] ?? '', timeStr)
    if (!time) continue

    const open   = parseFloat(cols[iOpen])
    const close  = parseFloat(cols[iClose])
    if (isNaN(open) || isNaN(close)) continue

    const high   = iHigh !== -1 ? parseFloat(cols[iHigh])  : Math.max(open, close)
    const low    = iLow  !== -1 ? parseFloat(cols[iLow])   : Math.min(open, close)
    const volume = iVol  !== -1 ? parseFloat(cols[iVol]) || 0 : 0

    velas.push({
      time, open,
      high:   isNaN(high) ? Math.max(open, close) : high,
      low:    isNaN(low)  ? Math.min(open, close) : low,
      close,  volume,
    })
  }

  if (!velas.length) throw new Error('No se extrajeron filas válidas. Revisa que las columnas open/close sean numéricas.')
  return velas.sort((a, b) => a.time - b.time)
}

function parseJSON(text) {
  const raw = JSON.parse(text)

  // Respuesta de Yahoo Finance API
  const yf = raw?.chart?.result?.[0]
  if (yf) {
    const ts = yf.timestamp ?? []
    const q  = yf.indicators?.quote?.[0] ?? {}
    return ts
      .map((t, i) => ({
        time: t, open: q.open?.[i], high: q.high?.[i],
        low:  q.low?.[i], close: q.close?.[i], volume: q.volume?.[i] ?? 0,
      }))
      .filter(v => v.open != null && v.close != null)
  }

  // Buscar el primer array dentro del objeto si no es un array directo
  const arr = Array.isArray(raw)
    ? raw
    : Object.values(raw).find(v => Array.isArray(v))

  if (!arr?.length) throw new Error('JSON no reconocido: debe ser un array u objeto con Yahoo Finance format')

  // Array de objetos [{date, open, high, low, close, volume}]
  if (!Array.isArray(arr[0])) {
    return arr.map(r => {
      const t = r.time ?? r.timestamp ?? r.date ?? r.Date ?? r.datetime
      const time = typeof t === 'number'
        ? (t > 1e12 ? Math.floor(t / 1000) : t)
        : parseFecha(String(t ?? ''))
      return {
        time,
        open:   parseFloat(r.open   ?? r.Open),
        high:   parseFloat(r.high   ?? r.High),
        low:    parseFloat(r.low    ?? r.Low),
        close:  parseFloat(r.close  ?? r.Close ?? r['Adj Close']),
        volume: parseFloat(r.volume ?? r.Volume ?? r.vol ?? 0) || 0,
      }
    })
    .filter(v => v.time && !isNaN(v.open) && !isNaN(v.close))
    .sort((a, b) => a.time - b.time)
  }

  // Array de arrays [[ts, o, h, l, c, v], ...]  (Dukascopy-node, TradingView)
  return arr.map(([ts, open, high, low, close, volume = 0]) => ({
    time:   ts > 1e12 ? Math.floor(ts / 1000) : ts,
    open, high, low, close, volume: volume ?? 0,
  }))
  .filter(v => v.time && !isNaN(v.open))
  .sort((a, b) => a.time - b.time)
}

// ── Componente ────────────────────────────────────────────────────────────────

export default function SubirDatos() {
  const [datos,    setDatos]    = useState(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef(null)

  const procesar = useCallback((file) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const text  = e.target.result
        const velas = file.name.toLowerCase().endsWith('.json')
          ? parseJSON(text)
          : parseCSV(text)
        if (!velas.length) throw new Error('No se extrajeron datos OHLCV válidos del archivo')
        setDatos({ nombre: file.name, velas, error: null })
      } catch (err) {
        setDatos({ nombre: file.name, velas: [], error: err.message })
      }
    }
    reader.readAsText(file, 'utf-8')
  }, [])

  const onDrop = useCallback(e => {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) procesar(f)
  }, [procesar])

  const onFileInput = e => {
    const f = e.target.files[0]
    if (f) procesar(f)
    e.target.value = ''
  }

  const stats = datos?.velas?.length ? (() => {
    const v   = datos.velas
    const fmt = ts => new Date(ts * 1000).toISOString().slice(0, 10)
    return { n: v.length, desde: fmt(v[0].time), hasta: fmt(v[v.length - 1].time) }
  })() : null

  return (
    <div className="subir-page">

      {/* Zona de carga */}
      <div
        className={`drop-zone ${dragging ? 'dragging' : ''} ${datos && !datos.error ? 'compact' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
      >
        <input ref={inputRef} type="file" accept=".csv,.json,.txt" hidden onChange={onFileInput} />
        {datos && !datos.error ? (
          <span className="drop-replace">📂 Cambiar archivo</span>
        ) : (
          <>
            <div className="drop-icon">📂</div>
            <div className="drop-text">
              {dragging
                ? 'Suelta el archivo aquí'
                : 'Arrastra un archivo CSV / JSON o haz clic para seleccionar'}
            </div>
            <div className="drop-hint">
              Compatible con: Yahoo Finance · MetaTrader MT4/MT5 · Stooq · Dukascopy-node · TradingView
              <br />Columnas necesarias: fecha, open, high, low, close (volume opcional)
            </div>
          </>
        )}
      </div>

      {/* Error de parseo */}
      {datos?.error && (
        <div className="subir-error">
          <strong>Error al leer {datos.nombre}</strong>
          <p>{datos.error}</p>
          <p className="subir-error-hint">
            Columnas esperadas (cualquier orden, mayúsculas o minúsculas):<br />
            <code>date / datetime / timestamp</code> · <code>open</code> · <code>high</code> · <code>low</code> · <code>close</code> · <code>volume</code> (opcional)
          </p>
        </div>
      )}

      {/* Stats + gráfico */}
      {stats && (
        <>
          <div className="subir-stats">
            <span className="subir-nombre">📄 {datos.nombre}</span>
            <span>{stats.n.toLocaleString('es-ES')} velas</span>
            <span className="subir-rango">{stats.desde} → {stats.hasta}</span>
          </div>
          <GraficoVelas velas={datos.velas} patrones={[]} skipTz />
        </>
      )}
    </div>
  )
}
