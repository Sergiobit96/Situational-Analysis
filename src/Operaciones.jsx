import { useState, useCallback, useMemo, useEffect } from 'react'
import { parseTradesXLSX, fmtFechaTS, fmtHoraTS } from './parseTrades'
import { useTrades } from './useTrades'
import { intradayUrl } from './intradayApi'
import GraficoVelas from './GraficoVelas'

const PAGE_SIZE = 50

const fmtPrecio = n => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Clave para no duplicar una operación ya cargada al añadir el archivo de otro año
const claveTrade = t => `${t.producto}|${t.openTime}|${t.closeTime}`

const TIMEFRAMES = [
  { label: '1m',  duka: 'm1'  },
  { label: '5m',  duka: 'm5'  },
  { label: '15m', duka: 'm15' },
  { label: '30m', duka: 'm30' },
  { label: '1h',  duka: 'h1'  },
]

export default function Operaciones() {
  const [trades, setTrades] = useTrades()
  const [dragging, setDragging] = useState(false)
  const [error,    setError]    = useState(null)
  const [pagina,   setPagina]   = useState(0)
  const [productosActivos, setProductosActivos] = useState(new Set())
  const [fechaDesde, setFechaDesde] = useState('')
  const [fechaHasta, setFechaHasta] = useState('')
  const [seleccionado, setSeleccionado]   = useState(null)
  const [timeframe,    setTimeframe]      = useState('m15')
  const [velas,        setVelas]          = useState([])
  const [cargandoVelas,setCargandoVelas]  = useState(false)
  const [prevClose,    setPrevClose]      = useState(null)

  const toggleProducto = p => {
    setProductosActivos(prev => {
      const s = new Set(prev); s.has(p) ? s.delete(p) : s.add(p); return s
    })
    setPagina(0)
  }

  const cambiarFechaDesde = v => { setFechaDesde(v); setPagina(0) }
  const cambiarFechaHasta = v => { setFechaHasta(v); setPagina(0) }
  const limpiarFiltros = () => { setProductosActivos(new Set()); setFechaDesde(''); setFechaHasta(''); setPagina(0) }

  const procesar = useCallback(async file => {
    try {
      const buffer = await file.arrayBuffer()
      const parsed = await parseTradesXLSX(buffer)
      if (!parsed.length) throw new Error('No se encontraron filas de tipo TRADE en el archivo')
      // Se añade al histórico ya cargado (p.ej. subir "DAY 2025.xlsx" y luego
      // "DAY 2026.xlsx") en vez de reemplazarlo, evitando duplicar operaciones repetidas.
      const claves = new Set(trades.map(claveTrade))
      const nuevas = parsed.filter(t => !claves.has(claveTrade(t)))
      setTrades([...trades, ...nuevas].sort((a, b) => a.openTime - b.openTime))
      setError(null)
      setPagina(0)
    } catch (err) {
      setError(err.message)
    }
  }, [trades, setTrades])

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

  const stats = useMemo(() => {
    if (!trades.length) return null
    const productos = new Set(trades.map(t => t.producto))
    const sinTicker  = trades.filter(t => !t.ticker).length
    return {
      n: trades.length,
      desde: fmtFechaTS(trades[0].openTime),
      hasta: fmtFechaTS(trades[trades.length - 1].openTime),
      productos: productos.size,
      sinTicker,
    }
  }, [trades])

  // Lista de productos presentes en el archivo cargado, para los chips de filtro
  const productosDisponibles = useMemo(
    () => [...new Set(trades.map(t => t.producto))].sort(),
    [trades]
  )

  const hayFiltros = productosActivos.size > 0 || fechaDesde || fechaHasta

  const filtradas = useMemo(() => trades.filter(t => {
    if (productosActivos.size > 0 && !productosActivos.has(t.producto)) return false
    const fecha = fmtFechaTS(t.openTime)
    if (fechaDesde && fecha < fechaDesde) return false
    if (fechaHasta && fecha > fechaHasta) return false
    return true
  }), [trades, productosActivos, fechaDesde, fechaHasta])

  const ordenadas     = useMemo(() => [...filtradas].reverse(), [filtradas])
  const totalPaginas  = Math.max(1, Math.ceil(ordenadas.length / PAGE_SIZE))
  const enPagina       = ordenadas.slice(pagina * PAGE_SIZE, (pagina + 1) * PAGE_SIZE)

  // Todas las operaciones (con filtros o sin ellos) del mismo instrumento+día que la
  // fila seleccionada, para marcarlas todas en el gráfico
  const tradesDelDia = useMemo(() => {
    if (!seleccionado) return []
    const fecha = fmtFechaTS(seleccionado.openTime)
    return trades.filter(t => t.ticker === seleccionado.ticker &&
      (fmtFechaTS(t.openTime) === fecha || fmtFechaTS(t.closeTime) === fecha))
  }, [trades, seleccionado])

  // Carga las velas intraday del día de la operación seleccionada
  useEffect(() => {
    if (!seleccionado?.ticker) return
    const controller = new AbortController()
    const fecha = fmtFechaTS(seleccionado.openTime)
    setCargandoVelas(true)
    setVelas([])
    fetch(intradayUrl(seleccionado.ticker, fecha, timeframe), { signal: controller.signal })
      .then(r => r.json())
      .then(d => { if (!controller.signal.aborted && d.velas?.length) setVelas(d.velas) })
      .catch(e => { if (e.name !== 'AbortError') console.error(e) })
      .finally(() => { if (!controller.signal.aborted) setCargandoVelas(false) })
    return () => controller.abort()
  }, [seleccionado, timeframe])

  // Cierre del día de negociación anterior, para la línea de referencia del gráfico
  useEffect(() => {
    if (!seleccionado?.ticker) return
    const controller = new AbortController()
    const fecha = fmtFechaTS(seleccionado.openTime)
    fetch(`/api/cierre-anterior?${new URLSearchParams({ ticker: seleccionado.ticker, date: fecha })}`, { signal: controller.signal })
      .then(r => r.json())
      .then(d => { if (!controller.signal.aborted) setPrevClose(d.error ? null : d.prevClose) })
      .catch(e => { if (e.name !== 'AbortError') console.error(e) })
    return () => controller.abort()
  }, [seleccionado])

  return (
    <div className="subir-page">
      <div
        className={`drop-zone ${dragging ? 'dragging' : ''} ${trades.length ? 'compact' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => document.getElementById('trades-file-input')?.click()}
      >
        <input id="trades-file-input" type="file" accept=".xlsx" hidden onChange={onFileInput} />
        {trades.length ? (
          <span className="drop-replace">📂 Añadir otro archivo de operaciones (p.ej. de otro año)</span>
        ) : (
          <>
            <div className="drop-icon">📈</div>
            <div className="drop-text">
              {dragging ? 'Suelta el archivo aquí' : 'Arrastra tu diario de operaciones (.xlsx) o haz clic para seleccionar'}
            </div>
            <div className="drop-hint">
              Formato del diario "DAY &lt;año&gt;.xlsx": hoja(s) con el nombre del año y columnas -ENTRY-/-EXIT-.
              Puedes subir varios años, ya sea en el mismo archivo (una hoja por año) o subiendo un archivo por año.
              <br />Los datos se procesan solo en tu navegador, no se suben a ningún servidor.
            </div>
          </>
        )}
      </div>

      {error && (
        <div className="subir-error">
          <strong>Error al leer el archivo</strong>
          <p>{error}</p>
        </div>
      )}

      {stats && (
        <>
          <div className="subir-stats">
            <span className="subir-nombre">📈 {stats.n.toLocaleString('es-ES')} operaciones</span>
            <span>{stats.productos} instrumentos</span>
            {stats.sinTicker > 0 && (
              <span title="Productos sin ticker mapeado en la app">
                ⚠ {stats.sinTicker} sin ticker reconocido
              </span>
            )}
            <span className="subir-rango">{stats.desde} → {stats.hasta}</span>
            <button className="clear-eventos" onClick={() => { setTrades([]); setPagina(0) }}>
              × borrar
            </button>
          </div>

          <div className="filtro-group">
            <label className="filtro-label">
              Instrumento
              {productosActivos.size > 0 && (
                <button className="clear-eventos" onClick={() => { setProductosActivos(new Set()); setPagina(0) }}>× limpiar</button>
              )}
            </label>
            <div className="filtro-dias-esp">
              {productosDisponibles.map(p => (
                <button
                  key={p}
                  className={`dia-esp-chip ${productosActivos.has(p) ? 'activo' : ''}`}
                  onClick={() => toggleProducto(p)}
                >{p}</button>
              ))}
            </div>
          </div>

          <div className="filtro-group">
            <label className="filtro-label">
              Fecha
              {(fechaDesde || fechaHasta) && (
                <button className="clear-eventos" onClick={() => { setFechaDesde(''); setFechaHasta(''); setPagina(0) }}>× limpiar</button>
              )}
            </label>
            <div className="fecha-manual-row">
              <input className="filtro-input-fecha" type="date" value={fechaDesde} onChange={e => cambiarFechaDesde(e.target.value)} />
              <span>→</span>
              <input className="filtro-input-fecha" type="date" value={fechaHasta} onChange={e => cambiarFechaHasta(e.target.value)} />
            </div>
          </div>

          {hayFiltros && (
            <div className="subir-stats">
              <span>{filtradas.length.toLocaleString('es-ES')} de {stats.n.toLocaleString('es-ES')} operaciones tras filtrar</span>
              <button className="clear-eventos" onClick={limpiarFiltros}>× limpiar todos los filtros</button>
            </div>
          )}

          <div className="velas-tabla-wrap">
            <table className="velas-tabla trades-tabla">
              <thead>
                <tr>
                  <th>Fecha apertura</th><th>Hora apertura</th><th>Precio apertura</th>
                  <th>Fecha cierre</th><th>Hora cierre</th><th>Precio cierre</th>
                  <th>Producto</th><th>Dir</th><th>Puntos</th>
                </tr>
              </thead>
              <tbody>
                {enPagina.map((t, i) => (
                  <tr
                    key={i}
                    className={`clickable-row ${t.puntos >= 0 ? 'fila-up' : 'fila-down'} ${seleccionado === t ? 'fila-seleccionada' : ''}`}
                    onClick={() => { setVelas([]); setPrevClose(null); setSeleccionado(t) }}
                    title={t.ticker ? 'Ver gráfico de este día' : 'Sin ticker reconocido para este producto'}
                  >
                    <td>{fmtFechaTS(t.openTime)}</td>
                    <td>{fmtHoraTS(t.openTime)}</td>
                    <td>{fmtPrecio(t.openPrice)}</td>
                    <td>{fmtFechaTS(t.closeTime)}</td>
                    <td>{fmtHoraTS(t.closeTime)}</td>
                    <td>{fmtPrecio(t.closePrice)}</td>
                    <td>{t.producto}</td>
                    <td>{t.direccion}</td>
                    <td>{t.puntos > 0 ? '+' : ''}{t.puntos.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="paginacion">
            <button className="pag-btn" onClick={() => setPagina(p => p - 1)} disabled={pagina === 0}>‹ Anterior</button>
            <span className="pag-info">{pagina + 1} / {totalPaginas}</span>
            <button className="pag-btn" onClick={() => setPagina(p => p + 1)} disabled={pagina >= totalPaginas - 1}>Siguiente ›</button>
          </div>

          {seleccionado && (
            <div className="ops-grafico">
              <div className="multi-charts-header">
                <span className="multi-charts-fecha">
                  {seleccionado.producto} · {fmtFechaTS(seleccionado.openTime)}
                </span>
                <div className="tf-selector">
                  {TIMEFRAMES.map(tf => (
                    <button
                      key={tf.duka}
                      className={`tf-chip ${timeframe === tf.duka ? 'activo' : ''}`}
                      onClick={() => setTimeframe(tf.duka)}
                    >{tf.label}</button>
                  ))}
                </div>
                <button className="btn-ir-fecha" onClick={() => { setVelas([]); setPrevClose(null); setSeleccionado(null) }}>× cerrar</button>
              </div>

              {!seleccionado.ticker && (
                <div className="filtro-vacio">
                  "{seleccionado.producto}" no tiene un ticker reconocido en la app, no se puede cargar el gráfico.
                </div>
              )}
              {seleccionado.ticker && cargandoVelas && (
                <div className="velas-cargando"><span className="spinner" /> Cargando velas…</div>
              )}
              {seleccionado.ticker && !cargandoVelas && velas.length > 0 && (
                <GraficoVelas
                  velas={velas}
                  patrones={[]}
                  ticker={seleccionado.ticker}
                  trades={tradesDelDia}
                  prevClose={prevClose}
                />
              )}
              {seleccionado.ticker && !cargandoVelas && velas.length === 0 && (
                <div className="filtro-vacio">Sin datos intraday disponibles para esta fecha.</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
