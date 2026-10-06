import { useState, useEffect, useMemo, useCallback } from 'react'
import { CATEGORIAS_HORROR } from './parseTrades'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

const FILTROS = [
  { id: 'todos', label: 'Todos' },
  { id: 'con',   label: 'Con comentario' },
  { id: 'sin',   label: 'Sin comentario' },
]

// Los dos books a los que se puede mandar una captura con un clic. Se copia el archivo,
// el original se queda en su carpeta y el comentario viaja con él.
const BOOKS = [
  { id: 'horror', icono: '📕', nombre: 'Book of Horror' },
  { id: 'glory',  icono: '📗', nombre: 'Book of Glory' },
]

// Las capturas numeradas de 2022 y 2023 que no están en la carpeta de un mes no tienen mes
// que mostrar: se agrupan aparte bajo esta clave, que ordena al final.
const SIN_MES = '00'

function nombreMes(mm) {
  return mm === SIN_MES ? 'sin mes' : (MESES[Number(mm) - 1] ?? mm)
}

// '2026-09-01' → '01/09'
function diaMes(fecha) {
  const [, mes, dia] = fecha.split('-')
  return `${dia}/${mes}`
}

// Las capturas las sirve el mismo endpoint que usa la pestaña Fotos
function urlImagen(trade) {
  return `${API}/api/fotos/archivo?id=${encodeURIComponent(trade.id)}`
}

// Lo que identifica al trade a ojo: fecha e instrumento, o el número de operación
function titulo(trade) {
  if (trade.fecha) return `${diaMes(trade.fecha)} · ${trade.instrumento ?? 'sin instrumento'}`
  return `#${trade.numero ?? trade.nombre}`
}

export default function DiarioTrades() {
  const [trades,   setTrades]   = useState([])
  const [info,     setInfo]     = useState(null)   // carpeta raíz y archivo de comentarios
  const [cargando, setCargando] = useState(true)
  const [error,    setError]    = useState(null)
  const [aviso,    setAviso]    = useState(null)

  const [anioElegido, setAnioElegido] = useState(null)
  const [mesElegido,  setMesElegido]  = useState(null)
  const [filtro,      setFiltro]      = useState('todos')

  const [editando,  setEditando]  = useState(null)   // clave del trade en edición
  const [guardando, setGuardando] = useState(null)
  const [etiquetando,   setEtiquetando]   = useState(null)  // clave con el editor abierto
  const [borradorCats,  setBorradorCats]  = useState(null)  // etiquetas marcadas sin guardar
  const [zoomClave, setZoomClave] = useState(null)
  const [zoomTexto, setZoomTexto] = useState('')

  const cargar = useCallback((refrescar = false) => {
    fetch(`${API}/api/trades-comentados/lista${refrescar ? '?refrescar=1' : ''}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) throw new Error(data.error)
        setTrades(data.trades)
        setInfo({ carpeta: data.carpeta, archivo: data.archivo })
        setError(null)
      })
      .catch(err => setError(err.message))
      .finally(() => setCargando(false))
  }, [])

  useEffect(() => { cargar() }, [cargar])

  // Menú: año → mes → capturas de ese mes (el servidor las manda ya ordenadas)
  const porAnio = useMemo(() => {
    const mapa = new Map()
    for (const trade of trades) {
      const mes = trade.mes ?? SIN_MES
      if (!mapa.has(trade.anio)) mapa.set(trade.anio, new Map())
      const meses = mapa.get(trade.anio)
      if (!meses.has(mes)) meses.set(mes, [])
      meses.get(mes).push(trade)
    }
    return mapa
  }, [trades])

  const anios = useMemo(() => [...porAnio.keys()].sort((a, b) => b.localeCompare(a)), [porAnio])

  // Año y mes se derivan de lo elegido: si el mes no existe en el año nuevo (o se queda
  // sin capturas), manda el más reciente que sí exista, sin estados a medio camino.
  const anio = anioElegido !== null && anios.includes(anioElegido) ? anioElegido : (anios[0] ?? null)

  const mesesDelAnio = useMemo(() => {
    const delAnio = porAnio.get(anio)
    if (!delAnio) return []
    return [...delAnio.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [porAnio, anio])

  const mes = mesesDelAnio.some(([m]) => m === mesElegido) ? mesElegido : (mesesDelAnio[0]?.[0] ?? null)

  const delMes = useMemo(
    () => mesesDelAnio.find(([m]) => m === mes)?.[1] ?? [],
    [mesesDelAnio, mes],
  )

  const visibles = useMemo(() => {
    if (filtro === 'con') return delMes.filter(t => t.comentario)
    if (filtro === 'sin') return delMes.filter(t => !t.comentario)
    return delMes
  }, [delMes, filtro])

  const comentados = useMemo(() => trades.filter(t => t.comentario).length, [trades])

  const guardarComentario = useCallback(async (trade, texto) => {
    const limpio = texto.trim()
    if (limpio === trade.comentario) return
    setGuardando(trade.clave)
    setError(null)
    try {
      const res = await fetch(`${API}/api/trades-comentados/comentario?id=${encodeURIComponent(trade.id)}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ comentario: limpio }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setTrades(prev => prev.map(t => (t.clave === data.trade.clave ? data.trade : t)))
    } catch (err) {
      setError(`No se pudo guardar el comentario: ${err.message}`)
    } finally {
      setGuardando(null)
    }
  }, [])

  // Un clic: copia la captura al book elegido. Si ya estaba, lo dice en vez de duplicarla.
  const añadirABook = useCallback(async (trade, book) => {
    setError(null)
    setAviso(null)
    try {
      const res = await fetch(
        `${API}/api/books/copiar?book=${book.id}&id=${encodeURIComponent(trade.id)}`,
        { method: 'POST' },
      )
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setTrades(prev => prev.map(t => (t.clave === data.trade.clave ? data.trade : t)))
      setAviso(data.yaEstaba
        ? `"${data.archivo}" ya estaba en el ${book.nombre}`
        : `"${data.archivo}" añadida al ${book.nombre}`)
    } catch (err) {
      setError(`No se pudo añadir al ${book.nombre}: ${err.message}`)
    }
  }, [])

  // Marcar un trade como revisado (o desmarcarlo). Se guarda en la misma anotación que el
  // comentario y las etiquetas, así que sobrevive a recargar y se ve desde cualquier vista.
  const alternarRevisado = useCallback(async trade => {
    setError(null)
    try {
      const res = await fetch(`${API}/api/trades-comentados/etiquetas?clave=${encodeURIComponent(trade.clave)}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ revisado: !trade.revisado }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setTrades(prev => prev.map(t => (t.clave === data.clave ? { ...t, revisado: data.revisado } : t)))
    } catch (err) {
      setError(`No se pudo marcar como revisado: ${err.message}`)
    }
  }, [])

  const revisados = useMemo(() => trades.filter(t => t.revisado).length, [trades])

  const guardarCats = useCallback(async (trade, cats) => {
    setGuardando(trade.clave)
    setError(null)
    try {
      const res = await fetch(`${API}/api/trades-comentados/etiquetas?clave=${encodeURIComponent(trade.clave)}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ cats }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setTrades(prev => prev.map(t => (t.clave === data.clave ? { ...t, cats: data.cats } : t)))
      setBorradorCats(null)
    } catch (err) {
      setError(`No se pudieron guardar las etiquetas: ${err.message}`)
    } finally {
      setGuardando(null)
    }
  }, [])

  // Las 13 etiquetas del Book of Horror para un trade. Marcar solo cambia el borrador:
  // lo que las asocia al trade es el botón de guardar, igual que en Operaciones.
  const editorEtiquetas = trade => {
    const guardadas = trade.cats ?? []
    const cats      = borradorCats?.clave === trade.clave ? borradorCats.cats : guardadas
    const sinGuardar = cats.length !== guardadas.length || cats.some(n => !guardadas.includes(n))
    const alternar = n => setBorradorCats({
      clave: trade.clave,
      cats: (cats.includes(n) ? cats.filter(c => c !== n) : [...cats, n]).sort((a, b) => a - b),
    })

    return (
      <div className="ts-etiquetas">
        <div className="ops-etiquetas-chips">
          {CATEGORIAS_HORROR.map(c => (
            <button
              key={c.n}
              className={`dia-esp-chip horror-chip ${cats.includes(c.n) ? 'activo' : ''}`}
              onClick={() => alternar(c.n)}
              title={c.nombre}
            >#{c.n} {c.corto}</button>
          ))}
        </div>
        <div className="ops-etiquetas-guardar">
          {sinGuardar && <span className="ops-sin-guardar">sin guardar</span>}
          <button
            className="diario-add"
            onClick={() => guardarCats(trade, cats)}
            disabled={!sinGuardar || guardando === trade.clave}
          >guardar</button>
        </div>
      </div>
    )
  }

  // Las etiquetas ya puestas, para verlas sin abrir el editor
  const badgesEtiquetas = trade => (trade.cats?.length > 0 ? (
    <div className="horror-badges-cell ts-badges">
      {trade.cats.map(n => {
        const cat = CATEGORIAS_HORROR.find(c => c.n === n)
        return <span key={n} className="horror-badge" title={cat?.nombre ?? `Categoría ${n}`}>#{n} {cat?.corto ?? ''}</span>
      })}
    </div>
  ) : null)

  const zoom = zoomClave ? visibles.find(t => t.clave === zoomClave) ?? null : null

  const abrirZoom = useCallback(trade => {
    setZoomClave(trade.clave)
    setZoomTexto(trade.comentario)
  }, [])

  // Cerrar guarda lo escrito: con la foto a pantalla completa es donde se comenta de verdad
  const cerrarZoom = useCallback(() => {
    if (zoom) guardarComentario(zoom, zoomTexto)
    setZoomClave(null)
  }, [zoom, zoomTexto, guardarComentario])

  useEffect(() => {
    if (!zoom) return
    const onKeyDown = e => { if (e.key === 'Escape') cerrarZoom() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [zoom, cerrarZoom])

  return (
    <div className="ts-page">
      <div className="ts-intro">
        <h2>Trades comentados</h2>
        <p>
          Todas tus capturas de trades por año y mes: las subcarpetas <strong>Separados</strong> de
          2024 en adelante y las numeradas de 2022 y 2023. Doble clic sobre un comentario para
          escribirlo o cambiarlo; clic en la captura para verla grande y comentarla desde ahí.
          Las fotos no se tocan: los comentarios se guardan aparte
          en {info?.archivo ?? 'un JSON junto a las fotos'}.
        </p>
      </div>

      {error && <div className="fotos-error">{error}</div>}
      {aviso && <div className="horror-aviso">{aviso}</div>}

      <div className="ts-toolbar">
        <span className="diario-total">
          {cargando
            ? 'Leyendo las carpetas de Drive…'
            : `${trades.length} trades · ${comentados} comentado(s) · ${revisados} revisado(s) · ${trades.length - comentados} sin comentar`}
        </span>
        <button
          className="diario-boton"
          onClick={() => { setCargando(true); cargar(true) }}
          disabled={cargando}
        >↻ releer carpetas</button>
      </div>

      {!cargando && trades.length === 0 && !error && (
        <div className="fotos-placeholder">No se ha encontrado ninguna captura de trades</div>
      )}

      {anios.length > 0 && (
        <div className="ts-menu">
          <div className="ts-menu-fila">
            <span className="ts-menu-tit">año</span>
            <div className="estrategias-nav">
              {anios.map(a => {
                const lista = [...(porAnio.get(a)?.values() ?? [])].flat()
                return (
                  <button
                    key={a}
                    className={`estrategia-chip ${anio === a ? 'activo' : ''}`}
                    onClick={() => setAnioElegido(a)}
                    title={`${lista.filter(t => t.comentario).length} de ${lista.length} comentados`}
                  >{a} <span className="ts-chip-num">{lista.length}</span></button>
                )
              })}
            </div>
          </div>

          <div className="ts-menu-fila">
            <span className="ts-menu-tit">mes</span>
            <div className="estrategias-nav">
              {mesesDelAnio.map(([m, lista]) => (
                <button
                  key={m}
                  className={`estrategia-chip ${mes === m ? 'activo' : ''}`}
                  onClick={() => setMesElegido(m)}
                  title={`${lista.filter(t => t.comentario).length} de ${lista.length} comentados`}
                >
                  {nombreMes(m)} <span className="ts-chip-num">
                    {lista.filter(t => t.comentario).length}/{lista.length}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="ts-menu-fila">
            <span className="ts-menu-tit">ver</span>
            <div className="estrategias-nav">
              {FILTROS.map(f => (
                <button
                  key={f.id}
                  className={`estrategia-chip ${filtro === f.id ? 'activo' : ''}`}
                  onClick={() => setFiltro(f.id)}
                >{f.label}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {mes && (
        <header className="ts-mes-head">
          <h3>{nombreMes(mes)} {anio}</h3>
          <span className="ts-mes-num">
            {visibles.length === delMes.length
              ? `${delMes.length} captura(s)`
              : `${visibles.length} de ${delMes.length} captura(s)`}
          </span>
        </header>
      )}

      {mes && visibles.length === 0 && (
        <div className="fotos-placeholder">
          {filtro === 'sin' ? 'Todo este mes está comentado' : 'Ninguna captura comentada todavía en este mes'}
        </div>
      )}

      <div className="ts-grid">
        {visibles.map(trade => (
          <article key={trade.clave} className={`ts-trade ${trade.comentario ? 'comentado' : ''} ${trade.revisado ? 'revisado' : ''}`}>
            <img
              className="ts-thumb"
              src={urlImagen(trade)}
              alt={trade.nombre}
              loading="lazy"
              onClick={() => abrirZoom(trade)}
              title={`${trade.nombre}\n(clic para verla grande)`}
            />
            <div className="ts-cabecera">
              {trade.fecha ? (
                <>
                  <span className="ts-dia">{diaMes(trade.fecha)}</span>
                  <span className="ts-instrumento">{trade.instrumento ?? 'sin instrumento'}</span>
                </>
              ) : (
                <span className="ts-dia">#{trade.numero ?? trade.nombre}</span>
              )}
              {guardando === trade.clave && <span className="ts-guardando">guardando…</span>}
              <button
                className={`ts-revisado ${trade.revisado ? 'activo' : ''}`}
                onClick={() => alternarRevisado(trade)}
                title={trade.revisado ? 'Marcado como revisado · clic para desmarcar' : 'Marcar como revisado'}
              >✓ revisado</button>
              <button
                className="ts-revisado"
                onClick={() => abrirZoom(trade)}
                title="Ver este trade a pantalla completa"
              >⤢ pantalla completa</button>
              <button
                className={`ts-revisado ${etiquetando === trade.clave ? 'abierto' : ''}`}
                onClick={() => {
                  setBorradorCats(null)
                  setEtiquetando(prev => (prev === trade.clave ? null : trade.clave))
                }}
                title="Poner o quitar etiquetas a este trade"
              >🏷 etiquetas</button>
              <span className="ts-books">
                {BOOKS.map(b => {
                  const dentro = trade.books?.includes(b.id)
                  return (
                    <button
                      key={b.id}
                      className={`ts-book-btn ${dentro ? 'activo' : ''}`}
                      onClick={() => añadirABook(trade, b)}
                      title={dentro ? `Ya está en el ${b.nombre}` : `Añadir al ${b.nombre}`}
                    >{b.icono}</button>
                  )
                })}
              </span>
            </div>

            {editando === trade.clave ? (
              <textarea
                className="ts-comentario-edit"
                rows={4}
                defaultValue={trade.comentario}
                autoFocus
                onBlur={ev => { setEditando(null); guardarComentario(trade, ev.target.value) }}
                onKeyDown={ev => {
                  // restaurar el original antes del blur deja el guardado en nada
                  if (ev.key === 'Escape') { ev.target.value = trade.comentario; ev.target.blur() }
                }}
              />
            ) : (
              <p
                className={`ts-comentario ${trade.comentario ? '' : 'vacio'}`}
                title="Doble clic para escribir"
                onDoubleClick={() => setEditando(trade.clave)}
              >{trade.comentario || 'Sin comentario · doble clic para escribirlo'}</p>
            )}

            {etiquetando === trade.clave ? editorEtiquetas(trade) : badgesEtiquetas(trade)}
          </article>
        ))}
      </div>

      {zoom && (
        <div className="fotos-lightbox" onClick={cerrarZoom}>
          <button className="fotos-lightbox-cerrar" onClick={cerrarZoom} title="Cerrar y guardar (Esc)">×</button>
          <div className="ts-zoom" onClick={e => e.stopPropagation()}>
            <img className="fotos-lightbox-img" src={urlImagen(zoom)} alt={zoom.nombre} />
            <div className="ts-zoom-pie">
              <div className="ts-zoom-cabecera">
                <span className="ts-zoom-tit">{titulo(zoom)} · {zoom.anio}</span>
                <span className="ts-books">
                  {BOOKS.map(b => {
                    const dentro = zoom.books?.includes(b.id)
                    return (
                      <button
                        key={b.id}
                        className={`ts-book-btn ${dentro ? 'activo' : ''}`}
                        onClick={() => añadirABook(zoom, b)}
                        title={dentro ? `Ya está en el ${b.nombre}` : `Añadir al ${b.nombre}`}
                      >{b.icono}</button>
                    )
                  })}
                </span>
              </div>
              <textarea
                className="ts-comentario-edit"
                rows={3}
                placeholder="Qué viste, qué hiciste y qué harías distinto"
                value={zoomTexto}
                onChange={e => setZoomTexto(e.target.value)}
              />
              <button className="diario-add" onClick={() => guardarComentario(zoom, zoomTexto)}>
                guardar comentario
              </button>
              {/* mismas etiquetas que en la tarjeta, con sitio para verlas todas */}
              {editorEtiquetas(zoom)}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
