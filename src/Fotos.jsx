import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTrades } from './useTrades'
import { fmtFechaTS, CATEGORIAS_HORROR } from './parseTrades'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'

const MES_NOMBRE = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

const BOOKS = [
  { id: 'horror', icono: '📕', nombre: 'Book of Horror' },
  { id: 'glory',  icono: '📗', nombre: 'Book of Glory' },
]

const ANIOS = [2022, 2023, 2024, 2025, 2026]
const MESES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
const MES_ABREV = ['', 'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']

// Solo las fotos "Separados" de 2026 llevan instrumento en el nombre de archivo
const TOKEN_A_TICKER = {
  DAX: '^GDAXI', DOW: '^DJI', FTSE: '^FTSE',
  GOLD: 'XAUUSD', NASDAQ: '^NDX', SILVER: 'XAGUSD', SP500: '^GSPC',
}

// Clave del trade al que pertenece la captura, la misma que usan Trades comentados y
// Operaciones: fecha_instrumento, o año#número en las capturas numeradas de 2022-2023. El
// servidor la manda ya hecha; se recalcula aquí por si está sirviendo una versión anterior.
const claveDeFoto = f =>
  f?.clave ?? (f?.fecha ? `${f.fecha}_${f.instrumento ?? ''}` : (f?.numero ? `${f.year}#${f.numero}` : null))

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
  const [zoom, setZoom]   = useState(false)
  const [aviso,   setAviso]   = useState(null)
  // Anotaciones (comentario, etiquetas y revisado) de todos los trades, por clave: son las
  // mismas que se ven en Trades comentados y en Operaciones.
  const [anotaciones, setAnotaciones] = useState({})
  const [borrador,  setBorrador]  = useState('')
  const [catsBorrador, setCatsBorrador] = useState(null)   // { clave, cats } mientras se tocan
  const [editando,  setEditando]  = useState(false)
  const [guardando, setGuardando] = useState(false)
  // qué fotos se han mandado a cada book en esta sesión, para marcar el botón
  const [enBooks, setEnBooks] = useState({})

  const [filtroAnios,       setFiltroAnios]       = useState(new Set())
  const [filtroMeses,       setFiltroMeses]       = useState(new Set())
  const [filtroInstrumentos, setFiltroInstrumentos] = useState(new Set())
  const [fechaDesde, setFechaDesde] = useState('')
  const [fechaHasta, setFechaHasta] = useState('')
  const [filtroResultado, setFiltroResultado] = useState('todos') // todos | ganador | perdedor
  const [filtroRevisado,  setFiltroRevisado]  = useState('todos') // todos | si | no

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

  useEffect(() => {
    fetch(`${API}/api/trades-comentados/etiquetas`)
      .then(r => r.json())
      .then(d => { if (d.anotaciones) setAnotaciones(d.anotaciones) })
      .catch(() => { /* sin anotaciones se sigue pudiendo ver la foto */ })
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
    if (filtroMeses.size > 0 && (!f.fecha || !filtroMeses.has(Number(f.fecha.slice(5, 7))))) return false
    if (filtroInstrumentos.size > 0 && !filtroInstrumentos.has(f.instrumento)) return false
    if (fechaDesde && (!f.fecha || f.fecha < fechaDesde)) return false
    if (fechaHasta && (!f.fecha || f.fecha > fechaHasta)) return false
    if (filtroResultado !== 'todos' && resultadoDeFoto(f) !== filtroResultado) return false
    if (filtroRevisado !== 'todos') {
      const revisado = !!anotaciones[claveDeFoto(f)]?.revisado
      if (revisado !== (filtroRevisado === 'si')) return false
    }
    return true
  }), [catalogo, filtroAnios, filtroMeses, filtroInstrumentos, fechaDesde, fechaHasta, filtroResultado, resultadoDeFoto, filtroRevisado, anotaciones])

  // cuántas capturas del catálogo tienen ya el tick, para saber cuánto queda por repasar
  const revisadas = useMemo(
    () => catalogo.filter(f => anotaciones[claveDeFoto(f)]?.revisado).length,
    [catalogo, anotaciones],
  )

  const hayFiltros = filtroAnios.size > 0 || filtroMeses.size > 0 || filtroInstrumentos.size > 0
    || fechaDesde || fechaHasta || filtroResultado !== 'todos' || filtroRevisado !== 'todos'

  const toggleSet = (set, setSet, valor) => {
    const s = new Set(set); s.has(valor) ? s.delete(valor) : s.add(valor); setSet(s)
  }
  const limpiarFiltros = () => {
    setFiltroAnios(new Set()); setFiltroMeses(new Set()); setFiltroInstrumentos(new Set())
    setFechaDesde(''); setFechaHasta(''); setFiltroResultado('todos'); setFiltroRevisado('todos')
  }

  function mostrarAleatoria() {
    if (catalogoFiltrado.length === 0) return
    const pick = catalogoFiltrado[Math.floor(Math.random() * catalogoFiltrado.length)]
    setFoto(pick)
    setZoom(false)
    setAviso(null)
    setEditando(false)
  }

  // El comentario se guarda por clave de trade, no por archivo: la misma anotación que ya
  // existe en Trades comentados, así que lo que escribas aquí sale allí y al revés.
  const guardarAnotacion = useCallback(async (clave, cambios, mensaje) => {
    if (!clave) return
    setError(null)
    setGuardando(true)
    try {
      const res = await fetch(`${API}/api/trades-comentados/etiquetas?clave=${encodeURIComponent(clave)}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(cambios),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setAnotaciones(prev => ({ ...prev, [clave]: { texto: data.texto, cats: data.cats, revisado: data.revisado } }))
      setAviso(typeof mensaje === 'function' ? mensaje(data) : mensaje)
    } catch (err) {
      setError(`No se pudo guardar: ${err.message}`)
    } finally {
      setGuardando(false)
    }
  }, [])

  const guardarComentario = useCallback(async (clave, texto) => {
    await guardarAnotacion(clave, { comentario: texto }, texto ? 'Comentario guardado' : 'Comentario borrado')
    setEditando(false)
  }, [guardarAnotacion])

  const guardarEtiquetas = useCallback(async (clave, cats) => {
    await guardarAnotacion(clave, { cats }, d => (d.cats.length
      ? `${d.cats.length} etiqueta(s) guardadas`
      : 'Etiquetas quitadas'))
    setCatsBorrador(null)
  }, [guardarAnotacion])

  // El tick de revisado se guarda solo, sin botón aparte: es un sí o un no.
  const alternarRevisado = useCallback((clave, valor) => (
    guardarAnotacion(clave, { revisado: valor }, valor ? 'Marcado como revisado' : 'Marca de revisado quitada')
  ), [guardarAnotacion])

  // Un clic: copia la captura al book elegido. El original se queda donde está, y si ya
  // estaba en ese book el servidor lo dice en vez de duplicarla.
  const alBook = useCallback(async (item, book) => {
    setError(null)
    setAviso(null)
    try {
      const res  = await fetch(`${API}/api/books/copiar?book=${book.id}&id=${encodeURIComponent(item.id)}`, { method: 'POST' })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setEnBooks(prev => ({ ...prev, [item.id]: [...new Set([...(prev[item.id] ?? []), book.id])] }))
      setAviso(data.yaEstaba
        ? `"${data.archivo}" ya estaba en el ${book.nombre}`
        : `"${data.archivo}" añadida al ${book.nombre}`)
    } catch (err) {
      setError(`No se pudo añadir al ${book.nombre}: ${err.message}`)
    }
  }, [])

  useEffect(() => {
    if (!zoom) return
    const onKeyDown = e => { if (e.key === 'Escape') setZoom(false) }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [zoom])

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
          Mes
          {filtroMeses.size > 0 && <button className="clear-eventos" onClick={() => setFiltroMeses(new Set())}>× limpiar</button>}
        </label>
        <div className="filtro-dias-esp">
          {MESES.map(m => (
            <button
              key={m}
              className={`dia-esp-chip ${filtroMeses.has(m) ? 'activo' : ''}`}
              onClick={() => toggleSet(filtroMeses, setFiltroMeses, m)}
            >{MES_ABREV[m]}</button>
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

      <div className="filtro-group">
        <label className="filtro-label">
          Revisado
          <span className="filtro-valor">
            {revisadas} de {catalogo.length} capturas con el tick puesto
          </span>
        </label>
        <div className="filtro-dias-esp">
          {[['todos', 'Todas'], ['si', '✓ Revisadas'], ['no', 'Sin revisar']].map(([v, l]) => (
            <button
              key={v}
              className={`dia-esp-chip ${filtroRevisado === v ? 'activo' : ''}`}
              onClick={() => setFiltroRevisado(v)}
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
      {aviso && <div className="horror-aviso">{aviso}</div>}
      {!cargandoCatalogo && catalogoFiltrado.length === 0 && !error && (
        <div className="fotos-error">Ninguna foto coincide con los filtros actuales.</div>
      )}

      {foto && (
        <div className="fotos-card">
          <img
            className="fotos-img fotos-img-zoomable"
            src={`${API}/api/fotos/archivo?id=${encodeURIComponent(foto.id)}`}
            alt="Trade aleatorio"
            onClick={() => setZoom(true)}
            title="Clic para agrandar"
          />
          <div className="fotos-caption">
            {formatFecha(foto.fecha) ?? `Trade #${foto.numero}`}
            {foto.instrumento && ` · ${foto.instrumento}`}
            {!foto.instrumento && foto.fecha && instrumentosPorFecha.get(foto.fecha) &&
              ` · ${[...instrumentosPorFecha.get(foto.fecha)].join(' + ')}`}
            {` · ${foto.year}`}
          </div>
          {(() => {
            const clave      = claveDeFoto(foto)
            const anotacion  = anotaciones[clave] ?? {}
            const guardadas  = anotacion.cats ?? []
            // lo marcado se queda en el borrador hasta pulsar guardar, igual que en Operaciones
            const cats       = catsBorrador?.clave === clave ? catsBorrador.cats : guardadas
            const sinGuardar = cats.length !== guardadas.length || cats.some(n => !guardadas.includes(n))
            const alternarCat = n => setCatsBorrador({
              clave,
              cats: (cats.includes(n) ? cats.filter(x => x !== n) : [...cats, n]).sort((a, b) => a - b),
            })
            return (
              <div className="fotos-comentario">
                {editando ? (
                  <>
                    <textarea
                      className="ts-comentario-edit"
                      value={borrador}
                      autoFocus
                      rows={3}
                      placeholder="Qué pasó en este trade…"
                      onChange={e => setBorrador(e.target.value)}
                    />
                    <div className="fotos-comentario-botones">
                      <button className="btn-run-all" disabled={guardando || !clave} onClick={() => guardarComentario(clave, borrador.trim())}>
                        {guardando ? 'Guardando…' : 'Guardar'}
                      </button>
                      <button className="clear-eventos" onClick={() => setEditando(false)}>cancelar</button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className={`ts-comentario ${anotacion.texto ? '' : 'vacio'}`}>
                      {anotacion.texto || 'Sin comentario'}
                    </p>
                    <button
                      className="clear-eventos"
                      onClick={() => { setBorrador(anotacion.texto ?? ''); setEditando(true) }}
                    >{anotacion.texto ? '✎ editar comentario' : '+ comentar'}</button>
                  </>
                )}

                {/* Las mismas 12 etiquetas del Book of Horror que en Operaciones, con su
                    botón de guardar, y el tick de revisado, que se guarda solo */}
                <div className="fotos-etiquetas">
                  {CATEGORIAS_HORROR.map(c => (
                    <button
                      key={c.n}
                      className={`dia-esp-chip horror-chip ${cats.includes(c.n) ? 'activo' : ''}`}
                      onClick={() => alternarCat(c.n)}
                      title={c.nombre}
                    >#{c.n} {c.corto}</button>
                  ))}
                </div>
                <div className="fotos-comentario-botones">
                  {sinGuardar && <span className="ops-sin-guardar">sin guardar</span>}
                  <button
                    className="diario-add"
                    disabled={!sinGuardar || guardando || !clave}
                    onClick={() => guardarEtiquetas(clave, cats)}
                  >guardar etiquetas</button>
                  <button
                    className={`dia-esp-chip ${anotacion.revisado ? 'activo' : ''}`}
                    disabled={guardando || !clave}
                    onClick={() => alternarRevisado(clave, !anotacion.revisado)}
                    title="Lo mismo que el tick de Trades comentados y Seguimiento"
                  >{anotacion.revisado ? '✓ revisado' : 'marcar revisado'}</button>
                </div>
              </div>
            )
          })()}

          <div className="fotos-acciones">
            <span className="ts-books">
              {BOOKS.map(b => {
                const dentro = enBooks[foto.id]?.includes(b.id)
                return (
                  <button
                    key={b.id}
                    className={`ts-book-btn ${dentro ? 'activo' : ''}`}
                    onClick={() => alBook(foto, b)}
                    title={dentro ? `Ya la has mandado al ${b.nombre}` : `Mandar esta captura al ${b.nombre}`}
                  >{b.icono} {b.nombre}</button>
                )
              })}
            </span>
          </div>
        </div>
      )}

      {!foto && !cargandoCatalogo && catalogoFiltrado.length > 0 && (
        <div className="fotos-placeholder">Pulsa el botón para ver un trade al azar</div>
      )}

      {zoom && foto && (
        <div className="fotos-lightbox" onClick={() => setZoom(false)}>
          <button className="fotos-lightbox-cerrar" onClick={() => setZoom(false)} title="Cerrar (Esc)">×</button>
          <img
            className="fotos-lightbox-img"
            src={`${API}/api/fotos/archivo?id=${encodeURIComponent(foto.id)}`}
            alt="Trade ampliado"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  )
}
