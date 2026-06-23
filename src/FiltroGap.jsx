import { useState, useEffect } from 'react'
import GraficoVelas from './GraficoVelas'

const DIAS = [
  { n: 1, label: 'L', nombre: 'Lunes' },
  { n: 2, label: 'M', nombre: 'Martes' },
  { n: 3, label: 'X', nombre: 'Miércoles' },
  { n: 4, label: 'J', nombre: 'Jueves' },
  { n: 5, label: 'V', nombre: 'Viernes' },
]

const GAP_SIZES = [0, 0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0]

const EVENTOS_DEF = [
  { id: 'FOMC', label: 'FOMC',  title: 'Fed rate decision' },
  { id: 'CPI',  label: 'CPI',   title: 'Consumer Price Index US' },
  { id: 'NFP',  label: 'NFP',   title: 'Non-Farm Payrolls' },
  { id: 'ECB',  label: 'ECB',   title: 'ECB rate decision' },
  { id: 'PPI',  label: 'PPI',   title: 'Producer Price Index US' },
  { id: 'GDP',  label: 'GDP',   title: 'Gross Domestic Product' },
  { id: 'PMI',  label: 'PMI',   title: 'Purchasing Managers Index' },
]

const PERIODOS = [
  { meses: 3,  label: '3m'  },
  { meses: 6,  label: '6m'  },
  { meses: 12, label: '12m' },
  { meses: 24, label: '2a'  },
  { meses: 60, label: '5a'  },
]

const PRESETS = [
  { label: 'DAX',    value: '^GDAXI' },
  { label: 'FTSE',   value: '^FTSE'  },
  { label: 'Nasdaq', value: '^NDX'   },
  { label: 'DJ',     value: '^DJI'   },
  { label: 'S&P',    value: '^GSPC'  },
  { label: 'Oro',    value: 'XAUUSD' },
  { label: 'Plata',  value: 'XAGUSD' },
  { label: 'Petróleo', value: 'USOIL' },
]

const DIA_NOMBRE = { 1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves', 5: 'Viernes' }
const DIA_CORTO  = { 1: 'Lu', 2: 'Ma', 3: 'Mi', 4: 'Ju', 5: 'Vi' }

export default function FiltroGap() {
  const [ticker,        setTicker]        = useState('^GDAXI')
  const [dias,          setDias]          = useState(new Set([1, 2, 3, 4, 5]))
  const [dir,           setDir]           = useState('both')
  const [gapMin,        setGapMin]        = useState(0)
  const [meses,         setMeses]         = useState(12)
  const [eventosActivos, setEventosActivos] = useState(new Set())
  const [cargando,      setCargando]      = useState(false)
  const [resultado,     setResultado]     = useState(null)
  const [error,         setError]         = useState(null)
  const [seleccion,     setSeleccion]     = useState(null)
  const [velas,         setVelas]         = useState([])
  const [fuenteVelas,   setFuenteVelas]   = useState(null)
  const [cargandoVelas, setCargandoVelas] = useState(false)
  const [timeframe,     setTimeframe]     = useState('m15')
  const [fechaManual,   setFechaManual]   = useState('')

  const toggleDia = n => setDias(prev => {
    const s = new Set(prev); s.has(n) ? s.delete(n) : s.add(n); return s
  })

  const toggleEvento = id => setEventosActivos(prev => {
    const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s
  })

  // Filtrado secundario por evento (client-side, instantáneo)
  const sesionesVisibles = (() => {
    const all = resultado?.sesiones ?? []
    if (eventosActivos.size === 0) return all
    return all.filter(s => s.eventos?.some(e => eventosActivos.has(e)))
  })()

  const buscar = async () => {
    if (!ticker.trim() || dias.size === 0) return
    setCargando(true)
    setError(null)
    setResultado(null)
    setSeleccion(null)
    setVelas([])
    setFuenteVelas(null)
    try {
      const p = new URLSearchParams({
        ticker: ticker.trim(),
        dias:   [...dias].sort().join(','),
        dir,
        gapMin,
        meses,
      })
      const res  = await fetch(`/api/gap-filter?${p}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setResultado(data)
      if (data.sesiones.length > 0) setSeleccion(data.sesiones[data.sesiones.length - 1])
    } catch (e) {
      setError(e.message)
    } finally {
      setCargando(false)
    }
  }

  const irAFecha = () => {
    if (!fechaManual) return
    setSeleccion({ date: fechaManual })
    setVelas([])
  }

  // Carga velas intraday cuando cambia la sesión seleccionada o el timeframe
  useEffect(() => {
    if (!seleccion) return
    const tkr = resultado?.ticker ?? ticker
    setCargandoVelas(true)
    setVelas([])
    const p = new URLSearchParams({ ticker: tkr, date: seleccion.date, timeframe })
    fetch(`/api/velas15m?${p}`)
      .then(r => r.json())
      .then(d => {
        if (d.velas?.length) setVelas(d.velas)
        setFuenteVelas(d.fuente ?? null)
      })
      .catch(console.error)
      .finally(() => setCargandoVelas(false))
  }, [seleccion, timeframe])

  return (
    <div className="filtro-page">

      {/* ── Panel de controles ── */}
      <div className="filtro-controls">

        <div className="filtro-group">
          <label className="filtro-label">Instrumento</label>
          <div className="filtro-ticker-row">
            <input
              className="filtro-input"
              value={ticker}
              onChange={e => setTicker(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && buscar()}
              placeholder="^GDAXI, ^GSPC…"
            />
          </div>
          <div className="filtro-presets">
            {PRESETS.map(p => (
              <button
                key={p.value}
                className={`chip ${ticker === p.value ? 'activo' : ''}`}
                onClick={() => setTicker(p.value)}
              >{p.label}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">Día de la semana</label>
          <div className="filtro-dias">
            {DIAS.map(d => (
              <button
                key={d.n}
                className={`dia-chip ${dias.has(d.n) ? 'activo' : ''}`}
                onClick={() => toggleDia(d.n)}
                title={d.nombre}
              >{d.label}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">Dirección del gap</label>
          <div className="filtro-dir">
            {[
              { v: 'both', label: '↕  Ambos'      },
              { v: 'up',   label: '▲  Gap arriba' },
              { v: 'down', label: '▼  Gap abajo'  },
            ].map(d => (
              <button
                key={d.v}
                className={`dir-chip ${dir === d.v ? 'activo' : ''}`}
                onClick={() => setDir(d.v)}
              >{d.label}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Gap mínimo&nbsp;
            <span className="filtro-valor">
              {gapMin === 0 ? 'cualquiera' : `≥ ${gapMin}%`}
            </span>
          </label>
          <div className="filtro-gap-sizes">
            {GAP_SIZES.map(g => (
              <button
                key={g}
                className={`gap-chip ${gapMin === g ? 'activo' : ''}`}
                onClick={() => setGapMin(g)}
              >{g === 0 ? 'Todos' : `${g}%`}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Histórico&nbsp;
            <span className="fuente-tag yahoo">Yahoo 1d</span>
          </label>
          <div className="filtro-periodos">
            {PERIODOS.map(p => (
              <button
                key={p.meses}
                className={`periodo-chip ${meses === p.meses ? 'activo' : ''}`}
                onClick={() => setMeses(p.meses)}
              >{p.label}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Evento económico
            {eventosActivos.size > 0 && (
              <button className="clear-eventos" onClick={() => setEventosActivos(new Set())}>
                × limpiar
              </button>
            )}
          </label>
          <div className="filtro-eventos">
            {EVENTOS_DEF.map(ev => (
              <button
                key={ev.id}
                className={`evento-chip ev-${ev.id.toLowerCase()} ${eventosActivos.has(ev.id) ? 'activo' : ''}`}
                onClick={() => toggleEvento(ev.id)}
                title={ev.title}
              >{ev.label}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">Ir a fecha concreta</label>
          <div className="fecha-manual-row">
            <input
              type="date"
              className="filtro-input-fecha"
              value={fechaManual}
              onChange={e => setFechaManual(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && irAFecha()}
            />
            <button
              className="btn-ir-fecha"
              onClick={irAFecha}
              disabled={!fechaManual}
            >Ver</button>
          </div>
        </div>

        <button
          className="btn-filtrar"
          onClick={buscar}
          disabled={cargando || dias.size === 0}
        >
          {cargando
            ? <><span className="spinner" /> Cargando…</>
            : '🔍  Filtrar sesiones'}
        </button>

        {resultado && (
          <div className="filtro-resumen">
            <strong>{sesionesVisibles.length}</strong>
            {sesionesVisibles.length !== resultado.total && (
              <span className="resumen-filtrado"> / {resultado.total}</span>
            )}
            {' '}sesión{sesionesVisibles.length !== 1 ? 'es' : ''} · {resultado.ticker}
            {resultado.fuente      && <span className="resumen-fuente"> · {resultado.fuente}</span>}
            {resultado.fechaInicio && <span className="resumen-desde"> · desde {resultado.fechaInicio}</span>}
          </div>
        )}
      </div>

      {/* ── Resultados ── */}
      <div className="filtro-resultados">
        {error && <p className="error-global">{error}</p>}

        {resultado && sesionesVisibles.length === 0 && (
          <div className="filtro-vacio">
            Sin sesiones con esos filtros.
            {eventosActivos.size > 0 && ' Prueba quitando algún filtro de evento.'}
          </div>
        )}

        <div className={resultado && sesionesVisibles.length > 0 ? 'filtro-split' : ''}>

          {/* Lista de sesiones (solo cuando hay resultados del filtro) */}
          {resultado && sesionesVisibles.length > 0 && (
            <div className="sesiones-lista">
              {sesionesVisibles.map(s => (
                <SesionCard
                  key={s.date}
                  sesion={s}
                  activo={seleccion?.date === s.date}
                  onClick={() => setSeleccion(s)}
                />
              ))}
            </div>
          )}

          {/* Detalle / gráfico (visible tanto para selecciones de lista como manuales) */}
          {seleccion && (
            <div className="sesion-detalle">
              <div className="sesion-detalle-header">
                <div className="sesion-detalle-titulo">
                  <span className="sesion-detalle-fecha">{seleccion.date}</span>
                  {seleccion.dayOfWeek && (
                    <span className="sesion-detalle-dia">{DIA_NOMBRE[seleccion.dayOfWeek]}</span>
                  )}
                  {seleccion.gapDir && (
                    <span className={`gap-pill ${seleccion.gapDir}`}>
                      {seleccion.gapDir === 'up' ? '▲' : '▼'}
                      {seleccion.gapPct > 0 ? ' +' : ' '}{seleccion.gapPct.toFixed(3)}%
                    </span>
                  )}
                  {seleccion.eventos?.map(e => (
                    <span key={e} className={`ev-badge ev-${e.toLowerCase()}`}>{e}</span>
                  ))}
                </div>
                {seleccion.prevClose != null && (
                  <div className="sesion-detalle-meta">
                    Cierre anterior&nbsp;
                    <strong>{seleccion.prevClose.toFixed(2)}</strong>
                    &nbsp;→ Apertura&nbsp;
                    <strong>{seleccion.openPrice.toFixed(2)}</strong>
                    {velas.length > 0 && (
                      <>&nbsp;·&nbsp;{velas.length} velas
                        {fuenteVelas && (
                          <span className={`fuente-tag ${fuenteVelas.startsWith('Duka') ? 'dukascopy' : 'yahoo'}`}>
                            {fuenteVelas}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                )}
                {seleccion.prevClose == null && velas.length > 0 && (
                  <div className="sesion-detalle-meta">
                    {velas.length} velas
                    {fuenteVelas && (
                      <span className={`fuente-tag ${fuenteVelas.startsWith('Duka') ? 'dukascopy' : 'yahoo'}`}>
                        {fuenteVelas}
                      </span>
                    )}
                  </div>
                )}
                <div className="tf-selector">
                  {[
                    { label: '1m',  duka: 'm1'  },
                    { label: '5m',  duka: 'm5'  },
                    { label: '15m', duka: 'm15' },
                    { label: '30m', duka: 'm30' },
                    { label: '1h',  duka: 'h1'  },
                  ].map(tf => (
                    <button
                      key={tf.duka}
                      className={`tf-chip ${timeframe === tf.duka ? 'activo' : ''}`}
                      onClick={() => setTimeframe(tf.duka)}
                    >{tf.label}</button>
                  ))}
                </div>
              </div>

              {cargandoVelas && (
                <div className="velas-cargando">
                  <span className="spinner" /> Cargando velas…
                </div>
              )}

              {!cargandoVelas && velas.length > 0 && (
                <>
                  <GraficoVelas
                    velas={velas}
                    patrones={[]}
                    ticker={resultado?.ticker ?? ticker}
                    prevClose={seleccion.prevClose}
                    openPrice={seleccion.openPrice}
                  />
                  <VelasTabla velas={velas} />
                </>
              )}

              {!cargandoVelas && velas.length === 0 && (
                <div className="filtro-vacio">
                  No hay datos intraday disponibles para esta fecha.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SesionCard({ sesion, activo, onClick }) {
  const up = sesion.gapDir === 'up'
  return (
    <div
      className={`sesion-card ${up ? 'up' : 'down'} ${activo ? 'activo' : ''}`}
      onClick={onClick}
    >
      <div className="sesion-card-izq">
        <span className="sesion-card-dia">{DIA_CORTO[sesion.dayOfWeek]}</span>
        <span className="sesion-card-fecha">{sesion.date}</span>
      </div>
      <div className={`sesion-card-gap ${up ? 'verde' : 'rojo'}`}>
        {up ? '▲' : '▼'} {sesion.gapPct > 0 ? '+' : ''}{sesion.gapPct.toFixed(3)}%
      </div>
      <div className="sesion-card-derecha">
        <div className="sesion-card-precios">
          {sesion.prevClose.toFixed(2)} → {sesion.openPrice.toFixed(2)}
        </div>
        {sesion.eventos?.length > 0 && (
          <div className="sesion-card-eventos">
            {sesion.eventos.map(e => (
              <span key={e} className={`ev-badge ev-${e.toLowerCase()}`}>{e}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function VelasTabla({ velas }) {
  const fmtHora = ts => new Date(ts * 1000).toLocaleTimeString('es-ES', {
    timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit',
  })
  return (
    <div className="velas-tabla-wrap">
      <table className="velas-tabla">
        <thead>
          <tr>
            <th>Hora</th><th>Open</th><th>High</th><th>Low</th><th>Close</th>
            <th>Rango</th><th>Dir</th>
          </tr>
        </thead>
        <tbody>
          {velas.map(v => {
            const alcista = v.close >= v.open
            return (
              <tr key={v.time} className={alcista ? 'fila-up' : 'fila-down'}>
                <td>{fmtHora(v.time)}</td>
                <td>{v.open.toFixed(2)}</td>
                <td>{v.high.toFixed(2)}</td>
                <td>{v.low.toFixed(2)}</td>
                <td><strong>{v.close.toFixed(2)}</strong></td>
                <td>{(v.high - v.low).toFixed(2)}</td>
                <td>{alcista ? '▲' : '▼'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
