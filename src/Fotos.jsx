import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTrades } from './useTrades'
import { fmtFechaTS } from './parseTrades'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'

const MES_NOMBRE = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

const ANIOS = [2022, 2023, 2024, 2025, 2026]

// Solo las fotos "Separados" de 2026 llevan instrumento en el nombre de archivo
const TOKEN_A_TICKER = {
  DAX: '^GDAXI', DOW: '^DJI', FTSE: '^FTSE',
  GOLD: 'XAUUSD', NASDAQ: '^NDX', SILVER: 'XAGUSD', SP500: '^GSPC',
}

function formatFecha(fecha) {
  if (!fecha) return null
  const [y, m, d] = fecha.split('-').map(Number)
  return `${d} de ${MES_NOMBRE[m]} ${y}`
}

export default function Fotos() {
  const [trades]   = useTrades()
  const [catalogo, setCatalogo] = useState([])
  const [cargandoCatalogo, setCargandoCatalogo] = useState(true)
  const [error, setError] = useState(null)
  const [foto, setFoto]   = useState(null)

  const [filtroAnios,       setFiltroAnios]       = useState(new Set())
  const [filtroInstrumentos, setFiltroInstrumentos] = useState(new Set())
  const [fechaDesde, setFechaDesde] = useState('')
  const [fechaHasta, setFechaHasta] = useState('')
  const [filtroResultado, setFiltroResultado] = useState('todos') // todos | ganador | perdedor

  useEffect(() => {
    fetch(`${API}/api/fotos/lista`)
      .then(r => r.json())
      .then(data => {
        if (data.error) throw new Error(data.error)
        setCatalogo(data.fotos)
      })
      .catch(err => setError(err.message))
      .finally(() => setCargandoCatalogo(false))
  }, [])

  // Suma de puntos por fecha y por fecha+ticker, para poder marcar cada foto como ganadora/perdedora
  const resultadoPorClave = useMemo(() => {
    const map = new Map()
    const sumar = (clave, puntos) => {
      const cur = map.get(clave) ?? 0
      map.set(clave, cur + puntos)
    }
    for (const t of trades) {
      const fecha = fmtFechaTS(t.openTime)
      sumar(fecha, t.puntos)
      if (t.ticker) sumar(`${fecha}|${t.ticker}`, t.puntos)
    }
    return map
  }, [trades])

  const resultadoDeFoto = useCallback(item => {
    if (!item.fecha) return null
    const ticker = item.instrumento ? TOKEN_A_TICKER[item.instrumento.toUpperCase()] : null
    const clave  = ticker ? `${item.fecha}|${ticker}` : item.fecha
    const puntos = resultadoPorClave.get(clave)
    if (puntos == null) return null
    return puntos > 0 ? 'ganador' : puntos < 0 ? 'perdedor' : 'empate'
  }, [resultadoPorClave])

  // Productos operados en cada fecha, para poder mostrar el/los instrumento(s) en el pie
  // de las fotos que no llevan el instrumento en el nombre de archivo (todo salvo 2026
  // "Separados"): la mayoría de esas fotos son una única captura de todo el día, así que
  // puede haber más de un instrumento por fecha.
  const instrumentosPorFecha = useMemo(() => {
    const map = new Map()
    for (const t of trades) {
      const fecha = fmtFechaTS(t.openTime)
      if (!map.has(fecha)) map.set(fecha, new Set())
      map.get(fecha).add(t.producto)
    }
    return map
  }, [trades])

  const instrumentosDisponibles = useMemo(
    () => [...new Set(catalogo.map(f => f.instrumento).filter(Boolean))].sort(),
    [catalogo]
  )

  const catalogoFiltrado = useMemo(() => catalogo.filter(f => {
    if (filtroAnios.size > 0 && !filtroAnios.has(f.year)) return false
    if (filtroInstrumentos.size > 0 && !filtroInstrumentos.has(f.instrumento)) return false
    if (fechaDesde && (!f.fecha || f.fecha < fechaDesde)) return false
    if (fechaHasta && (!f.fecha || f.fecha > fechaHasta)) return false
    if (filtroResultado !== 'todos' && resultadoDeFoto(f) !== filtroResultado) return false
    return true
  }), [catalogo, filtroAnios, filtroInstrumentos, fechaDesde, fechaHasta, filtroResultado, resultadoDeFoto])

  const hayFiltros = filtroAnios.size > 0 || filtroInstrumentos.size > 0 || fechaDesde || fechaHasta || filtroResultado !== 'todos'

  const toggleSet = (set, setSet, valor) => {
    const s = new Set(set); s.has(valor) ? s.delete(valor) : s.add(valor); setSet(s)
  }
  const limpiarFiltros = () => {
    setFiltroAnios(new Set()); setFiltroInstrumentos(new Set())
    setFechaDesde(''); setFechaHasta(''); setFiltroResultado('todos')
  }

  function mostrarAleatoria() {
    if (catalogoFiltrado.length === 0) return
    const pick = catalogoFiltrado[Math.floor(Math.random() * catalogoFiltrado.length)]
    setFoto(pick)
  }

  return (
    <div className="fotos-page">
      <div className="filtro-group">
        <label className="filtro-label">
          Año
          {filtroAnios.size > 0 && <button className="clear-eventos" onClick={() => setFiltroAnios(new Set())}>× limpiar</button>}
        </label>
        <div className="filtro-dias-esp">
          {ANIOS.map(a => (
            <button
              key={a}
              className={`dia-esp-chip ${filtroAnios.has(a) ? 'activo' : ''}`}
              onClick={() => toggleSet(filtroAnios, setFiltroAnios, a)}
            >{a}</button>
          ))}
        </div>
      </div>

      <div className="filtro-group">
        <label className="filtro-label">
          Instrumento <span className="filtro-valor">(solo fotos separadas por instrumento, 2026)</span>
          {filtroInstrumentos.size > 0 && <button className="clear-eventos" onClick={() => setFiltroInstrumentos(new Set())}>× limpiar</button>}
        </label>
        <div className="filtro-dias-esp">
          {instrumentosDisponibles.map(i => (
            <button
              key={i}
              className={`dia-esp-chip ${filtroInstrumentos.has(i) ? 'activo' : ''}`}
              onClick={() => toggleSet(filtroInstrumentos, setFiltroInstrumentos, i)}
            >{i}</button>
          ))}
        </div>
      </div>

      <div className="filtro-group">
        <label className="filtro-label">
          Fecha
          {(fechaDesde || fechaHasta) && <button className="clear-eventos" onClick={() => { setFechaDesde(''); setFechaHasta('') }}>× limpiar</button>}
        </label>
        <div className="fecha-manual-row">
          <input className="filtro-input-fecha" type="date" value={fechaDesde} onChange={e => setFechaDesde(e.target.value)} />
          <span>→</span>
          <input className="filtro-input-fecha" type="date" value={fechaHasta} onChange={e => setFechaHasta(e.target.value)} />
        </div>
      </div>

      <div className="filtro-group">
        <label className="filtro-label">
          Resultado
          {trades.length === 0 && <span className="filtro-valor">(sube el diario en la pestaña Operaciones para poder filtrar)</span>}
        </label>
        <div className="filtro-dias-esp">
          {[['todos', 'Todos'], ['ganador', '✓ Ganador'], ['perdedor', '✗ Perdedor']].map(([v, l]) => (
            <button
              key={v}
              className={`dia-esp-chip ${filtroResultado === v ? 'activo' : ''}`}
              onClick={() => setFiltroResultado(v)}
              disabled={v !== 'todos' && trades.length === 0}
            >{l}</button>
          ))}
        </div>
      </div>

      <div className="fotos-toolbar">
        <button className="btn-run-all" onClick={mostrarAleatoria} disabled={cargandoCatalogo || catalogoFiltrado.length === 0}>
          🎲 Trade aleatorio
        </button>
        <span className="fotos-total">
          {cargandoCatalogo ? 'Cargando catálogo…' : `${catalogoFiltrado.length} de ${catalogo.length} fotos`}
        </span>
        {hayFiltros && <button className="clear-eventos" onClick={limpiarFiltros}>× limpiar todos los filtros</button>}
      </div>

      {error && <div className="fotos-error">{error}</div>}
      {!cargandoCatalogo && catalogoFiltrado.length === 0 && !error && (
        <div className="fotos-error">Ninguna foto coincide con los filtros actuales.</div>
      )}

      {foto && (
        <div className="fotos-card">
          <img
            className="fotos-img"
            src={`${API}/api/fotos/archivo?id=${encodeURIComponent(foto.id)}`}
            alt="Trade aleatorio"
          />
          <div className="fotos-caption">
            {formatFecha(foto.fecha) ?? `Trade #${foto.numero}`}
            {foto.instrumento && ` · ${foto.instrumento}`}
            {!foto.instrumento && foto.fecha && instrumentosPorFecha.get(foto.fecha) &&
              ` · ${[...instrumentosPorFecha.get(foto.fecha)].join(' + ')}`}
            {` · ${foto.year}`}
          </div>
        </div>
      )}

      {!foto && !cargandoCatalogo && catalogoFiltrado.length > 0 && (
        <div className="fotos-placeholder">Pulsa el botón para ver un trade al azar</div>
      )}
    </div>
  )
}
