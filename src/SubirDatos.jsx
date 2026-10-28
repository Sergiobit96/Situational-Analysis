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
    // los CSV de Dukascopy (scripts/bajar-dukascopy*.mjs) llevan cada valor entre comillas
    const cols    = lines[i].split(delim).map(c => c.trim().replace(/^"(.*)"$/, '$1'))
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

// Lee un archivo; nunca lanza: lo que falle vuelve como { error }
async function leerArchivo(file) {
  try {
    const text  = await file.text()
    // un CSV vacío es un mes sin velas (así los deja bajar-dukascopy-todo.mjs): no es un error
    if (!text.replace(/^﻿/, '').trim()) return { nombre: file.name, velas: [], vacio: true }
    const velas = file.name.toLowerCase().endsWith('.json') ? parseJSON(text) : parseCSV(text)
    if (!velas.length) throw new Error('No se extrajeron datos OHLCV válidos del archivo')
    return { nombre: file.name, velas }
  } catch (err) {
    return { nombre: file.name, velas: [], error: err.message }
  }
}

// Junta las velas de varios archivos (p. ej. un CSV por mes) en una sola serie ordenada.
// Si dos archivos traen la misma vela, se queda la del último de la lista.
function juntarVelas(archivos) {
  const porTiempo = new Map()
  for (const a of archivos) for (const v of a.velas) porTiempo.set(v.time, v)
  return [...porTiempo.values()].sort((a, b) => a.time - b.time)
}

export default function SubirDatos() {
  // datos: { archivos: [{ nombre, velas, error? }], velas } — velas ya juntadas
  const [datos,    setDatos]    = useState(null)
  const [dragging, setDragging] = useState(false)
  const [leyendo,  setLeyendo]  = useState(0)
  const inputRef = useRef(null)

  const procesar = useCallback(async (files) => {
    // por nombre: los CSV mensuales (2024-01.csv, 2024-02.csv…) quedan en orden
    const lista = [...files].sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }))
    if (!lista.length) return
    setLeyendo(lista.length)
    const archivos = await Promise.all(lista.map(leerArchivo))
    setLeyendo(0)
    setDatos({ archivos, velas: juntarVelas(archivos) })
  }, [])

  const onDrop = useCallback(e => {
    e.preventDefault()
    setDragging(false)
    procesar(e.dataTransfer.files)
  }, [procesar])

  const onFileInput = e => {
    procesar(e.target.files)
    e.target.value = ''
  }

  const conVelas = datos?.velas?.length > 0
  const fallidos = datos?.archivos.filter(a => a.error) ?? []

  const stats = conVelas ? (() => {
    const v   = datos.velas
    const fmt = ts => new Date(ts * 1000).toISOString().slice(0, 10)
    return { n: v.length, desde: fmt(v[0].time), hasta: fmt(v[v.length - 1].time) }
  })() : null

  const nombre = datos?.archivos.length === 1
    ? datos.archivos[0].nombre
    : `${datos?.archivos.length} archivos`

  return (
    <div className="subir-page">

      {/* Zona de carga */}
      <div
        className={`drop-zone ${dragging ? 'dragging' : ''} ${conVelas ? 'compact' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
      >
        <input ref={inputRef} type="file" accept=".csv,.json,.txt" multiple hidden onChange={onFileInput} />
        {leyendo > 0 ? (
          <span className="drop-replace">Leyendo {leyendo} {leyendo === 1 ? 'archivo' : 'archivos'}…</span>
        ) : conVelas ? (
          <span className="drop-replace">📂 Cambiar archivos</span>
        ) : (
          <>
            <div className="drop-icon">📂</div>
            <div className="drop-text">
              {dragging
                ? 'Suelta los archivos aquí'
                : 'Arrastra uno o varios archivos CSV / JSON o haz clic para seleccionar'}
            </div>
            <div className="drop-hint">
              Compatible con: Yahoo Finance · MetaTrader MT4/MT5 · Stooq · Dukascopy-node · TradingView
              <br />Columnas necesarias: fecha, open, high, low, close (volume opcional)
              <br />Con varios archivos (p. ej. un CSV por mes) se juntan en un solo gráfico
            </div>
          </>
        )}
      </div>

      {/* Errores de parseo */}
      {fallidos.length > 0 && (
        <div className="subir-error">
          {fallidos.map(a => (
            <div key={a.nombre}>
              <strong>Error al leer {a.nombre}</strong>
              <p>{a.error}</p>
            </div>
          ))}
          <p className="subir-error-hint">
            Columnas esperadas (cualquier orden, mayúsculas o minúsculas):<br />
            <code>date / datetime / timestamp</code> · <code>open</code> · <code>high</code> · <code>low</code> · <code>close</code> · <code>volume</code> (opcional)
          </p>
        </div>
      )}

      {datos && !conVelas && !fallidos.length && (
        <div className="subir-error">
          <strong>{nombre}: sin velas</strong>
          <p>Los archivos están vacíos.</p>
        </div>
      )}

      {/* Stats + gráfico */}
      {stats && (
        <>
          <div className="subir-stats">
            <span className="subir-nombre" title={datos.archivos.map(a => a.nombre).join('\n')}>📄 {nombre}</span>
            <span>{stats.n.toLocaleString('es-ES')} velas</span>
            {fallidos.length > 0 && <span>{fallidos.length} con error</span>}
            <span className="subir-rango">{stats.desde} → {stats.hasta}</span>
          </div>
          <GraficoVelas velas={datos.velas} patrones={[]} skipTz />
        </>
      )}
    </div>
  )
}
