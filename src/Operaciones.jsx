import { useState, useCallback, useMemo } from 'react'
import { parseTradesXLSX, fmtFechaTS, fmtHoraTS } from './parseTrades'
import { useTrades } from './useTrades'

const PAGE_SIZE = 50

const fmtPrecio = n => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function Operaciones() {
  const [trades, setTrades] = useTrades()
  const [dragging, setDragging] = useState(false)
  const [error,    setError]    = useState(null)
  const [pagina,   setPagina]   = useState(0)

  const procesar = useCallback(async file => {
    try {
      const buffer = await file.arrayBuffer()
      const parsed = await parseTradesXLSX(buffer)
      if (!parsed.length) throw new Error('No se encontraron filas de tipo TRADE en el archivo')
      setTrades(parsed)
      setError(null)
      setPagina(0)
    } catch (err) {
      setError(err.message)
    }
  }, [setTrades])

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

  const ordenadas    = useMemo(() => [...trades].reverse(), [trades])
  const totalPaginas = Math.max(1, Math.ceil(ordenadas.length / PAGE_SIZE))
  const enPagina      = ordenadas.slice(pagina * PAGE_SIZE, (pagina + 1) * PAGE_SIZE)

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
          <span className="drop-replace">📂 Cambiar archivo de operaciones</span>
        ) : (
          <>
            <div className="drop-icon">📈</div>
            <div className="drop-text">
              {dragging ? 'Suelta el archivo aquí' : 'Arrastra tu diario de operaciones (.xlsx) o haz clic para seleccionar'}
            </div>
            <div className="drop-hint">
              Formato del diario "DAY &lt;año&gt;.xlsx": hoja con el nombre del año y columnas -ENTRY-/-EXIT-.
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

          <div className="velas-tabla-wrap">
            <table className="velas-tabla">
              <thead>
                <tr>
                  <th>Fecha apertura</th><th>Hora apertura</th><th>Precio apertura</th>
                  <th>Fecha cierre</th><th>Hora cierre</th><th>Precio cierre</th>
                  <th>Producto</th><th>Dir</th><th>Puntos</th>
                </tr>
              </thead>
              <tbody>
                {enPagina.map((t, i) => (
                  <tr key={i} className={t.puntos >= 0 ? 'fila-up' : 'fila-down'}>
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
        </>
      )}
    </div>
  )
}
