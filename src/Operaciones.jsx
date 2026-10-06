import { useState, useCallback, useMemo, useEffect } from 'react'
import { parseTradesXLSX, parseTradesDesdeAPI, fmtFechaTS, fmtHoraTS, CATEGORIAS_HORROR, PRODUCTO_A_INSTRUMENTO, PRODUCTO_A_TICKER, FACTOR_PRECIO } from './parseTrades'
import { useTrades } from './useTrades'
import { intradayUrl } from './intradayApi'
import GraficoVelas from './GraficoVelas'

const PAGE_SIZE = 50
const PAGE_SIZE_FOTOS = 12
const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'

const fmtPrecio = n => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
// El tamaño viene con signo en el historial del bróker (negativo en las ventas); el lado ya
// lo dice la columna Dir, así que aquí se enseña en positivo.
const fmtSize = v => Number.isFinite(v) ? Math.abs(v).toLocaleString('es-ES', { maximumFractionDigits: 2 }) : '—'

// Clave para no duplicar una operación ya cargada al añadir el archivo de otro año
const claveTrade = t => `${t.producto}|${t.openTime}|${t.closeTime}`

const TIMEFRAMES = [
  { label: '1m',  duka: 'm1'  },
  { label: '5m',  duka: 'm5'  },
  { label: '15m', duka: 'm15' },
  { label: '30m', duka: 'm30' },
  { label: '1h',  duka: 'h1'  },
]

// Los dos books a los que se puede mandar la captura de una operación con un clic. Copian
// el archivo a su carpeta: la captura original se queda donde está.
const BOOKS = [
  { id: 'horror', icono: '📕', nombre: 'Book of Horror' },
  { id: 'glory',  icono: '📗', nombre: 'Book of Glory' },
]

// Identidad del trade dentro de un book, la misma que usa el servidor para engancharle
// su comentario y sus etiquetas ('2026-09-11_DAX')
const claveDeFoto = foto => (foto?.fecha ? `${foto.fecha}_${foto.instrumento ?? ''}` : null)

// La misma clave, pero sacada de la operación: así se puede etiquetar un día aunque su
// captura todavía no esté en Drive
const claveDeOperacion = t => `${fmtFechaTS(t.openTime)}_${PRODUCTO_A_INSTRUMENTO[t.producto] ?? ''}`

const ANOTACION_VACIA = { cats: [], texto: '' }

export default function Operaciones({ abrir, onAbierto }) {
  const [trades, setTrades] = useTrades()
  const [dragging, setDragging] = useState(false)
  const [error,    setError]    = useState(null)
  const [pagina,   setPagina]   = useState(0)
  const [productosActivos, setProductosActivos] = useState(new Set())
  const [categoriasActivas, setCategoriasActivas] = useState(new Set())
  const [fechaDesde, setFechaDesde] = useState('')
  const [fechaHasta, setFechaHasta] = useState('')
  const [seleccionado, setSeleccionado]   = useState(null)
  const [timeframe,    setTimeframe]      = useState('m5')
  const [velas,        setVelas]          = useState([])
  const [cargandoVelas,setCargandoVelas]  = useState(false)
  const [prevClose,    setPrevClose]      = useState(null)
  const [catalogoFotos, setCatalogoFotos] = useState([])
  const [errorFotos,    setErrorFotos]    = useState(null)
  const [fotoZoom,      setFotoZoom]      = useState(null)
  const [enBooks,       setEnBooks]       = useState({ horror: new Set(), glory: new Set() })
  const [avisoBook,     setAvisoBook]     = useState(null)
  const [anotaciones,   setAnotaciones]   = useState({})   // clave de trade → { cats }
  const [verFoto,       setVerFoto]       = useState(false) // enseñar la captura del día
  const [borrador,      setBorrador]      = useState(null) // etiquetas marcadas sin guardar
  const [pantallaCompleta, setPantallaCompleta] = useState(false)
  const [borradorTexto, setBorradorTexto] = useState(null)  // comentario sin guardar
  const [aniosConectables, setAniosConectables] = useState([])
  const [sincronizando,    setSincronizando]    = useState(false)
  const [errorSync,        setErrorSync]        = useState(null)
  const [ultimaSync,       setUltimaSync]       = useState(null)

  // Catálogo de capturas locales (servidor Express en dev, lee las carpetas Trading<año>
  // de Drive) para poder mostrar la foto real de cada caso del Book of Horror
  useEffect(() => {
    fetch(`${API}/api/fotos/lista`)
      .then(r => r.json())
      .then(data => { if (data.error) throw new Error(data.error); setCatalogoFotos(data.fotos) })
      .catch(err => setErrorFotos(err.message))
  }, [])

  // Qué capturas están ya en cada book, para que el botón salga marcado. Como el resto de
  // lo que toca disco, solo existe con el servidor local delante.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    let vivo = true
    Promise.all(BOOKS.map(b =>
      fetch(`${API}/api/books/lista?book=${b.id}`)
        .then(r => r.json())
        .then(d => [b.id, new Set((d.archivos ?? []).map(a => a.clave).filter(Boolean))]),
    ))
      .then(pares => { if (vivo) setEnBooks(Object.fromEntries(pares)) })
      .catch(() => { /* sin servidor local no hay books que marcar */ })
    return () => { vivo = false }
  }, [])

  // Etiquetas ya puestas a cada trade (las 12 categorías del Book of Horror). Viven en el
  // mismo JSON que los comentarios, junto a las fotos de Drive.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    let vivo = true
    fetch(`${API}/api/trades-comentados/etiquetas`)
      .then(r => r.json())
      .then(d => { if (vivo && d.anotaciones) setAnotaciones(d.anotaciones) })
      .catch(() => { /* sin servidor local no hay etiquetas que pintar */ })
    return () => { vivo = false }
  }, [])

  // Guarda una parte de la anotación del trade (etiquetas o comentario); lo que no se
  // manda se queda como estaba en el servidor.
  const guardarAnotacion = useCallback(async (clave, cambios, aviso) => {
    setAvisoBook(null)
    try {
      const res = await fetch(`${API}/api/trades-comentados/etiquetas?clave=${encodeURIComponent(clave)}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(cambios),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setAnotaciones(prev => ({ ...prev, [clave]: { cats: data.cats, texto: data.texto, revisado: data.revisado } }))
      setAvisoBook(aviso(data))
    } catch (err) {
      setAvisoBook(`No se pudo guardar: ${err.message}`)
    }
  }, [])

  const guardarEtiquetas = useCallback((clave, cats) => {
    setBorrador(null)
    return guardarAnotacion(clave, { cats }, d => (d.cats.length
      ? `${d.cats.length} etiqueta(s) guardadas en ${clave}`
      : `Etiquetas quitadas de ${clave}`))
  }, [guardarAnotacion])

  const guardarComentario = useCallback((clave, comentario) => {
    setBorradorTexto(null)
    return guardarAnotacion(clave, { comentario }, d => (d.texto
      ? `Comentario guardado en ${clave}`
      : `Comentario borrado de ${clave}`))
  }, [guardarAnotacion])

  // El mismo tick de revisado que Trades comentados y Seguimiento: se guarda al momento
  const alternarRevisado = useCallback(clave => {
    const nuevo = !(anotaciones[clave]?.revisado === true)
    return guardarAnotacion(clave, { revisado: nuevo }, d => (d.revisado
      ? `${clave} marcado como revisado`
      : `${clave} desmarcado como revisado`))
  }, [anotaciones, guardarAnotacion])

  const mandarABook = useCallback(async (foto, book) => {
    if (!foto) return
    setAvisoBook(null)
    try {
      const res  = await fetch(`${API}/api/books/copiar?book=${book.id}&id=${encodeURIComponent(foto.id)}`, { method: 'POST' })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      const clave = data.trade?.clave
      if (clave) setEnBooks(prev => ({ ...prev, [book.id]: new Set(prev[book.id]).add(clave) }))
      setAvisoBook(`${data.yaEstaba ? 'Ya estaba' : 'Añadida'}: "${data.archivo}" en el ${data.nombre}`)
    } catch (err) {
      setAvisoBook(`No se pudo añadir al ${book.nombre}: ${err.message}`)
    }
  }, [])

  // Añade operaciones nuevas al histórico sin duplicar las ya cargadas (por ejemplo, al
  // sincronizar "DAY 2026" varias veces en el día, o al combinar con un .xlsx subido a
  // mano de otro año). Usa el actualizador funcional para poder disparar varias fuentes
  // (varios años) a la vez sin que una pise el resultado de la otra.
  const mergeTrades = useCallback(parsed => {
    let añadidas = 0
    setTrades(prev => {
      const claves = new Set(prev.map(claveTrade))
      const nuevas = parsed.filter(t => !claves.has(claveTrade(t)))
      añadidas = nuevas.length
      if (!nuevas.length) return prev
      return [...prev, ...nuevas].sort((a, b) => a.openTime - b.openTime)
    })
    return añadidas
  }, [setTrades])

  // Trae el diario directamente de Google Sheets vía el servidor local, sin tener que
  // exportar y subir el .xlsx a mano cada día.
  const sincronizarAnios = useCallback(async years => {
    if (!years.length) return
    setSincronizando(true)
    try {
      const resultados = await Promise.all(years.map(async year => {
        const r = await fetch(`${API}/api/day-trades?year=${year}`)
        const data = await r.json()
        if (data.error) throw new Error(`DAY ${year}: ${data.error}`)
        return parseTradesDesdeAPI(data)
      }))

      // Los años sin diario DAY se rellenan con el historial de la cuenta, que está en una
      // sola hoja desde 2021. Los que sí tienen diario se quedan con él, que trae número de
      // sesión y dirección; así tampoco se duplica nada.
      let delHistorial = []
      try {
        const r    = await fetch(`${API}/api/historial-trades`)
        const data = await r.json()
        if (!data.error && Array.isArray(data.filas)) {
          const conDiario = new Set(years)
          delHistorial = parseTradesDesdeAPI({ log: data.filas, scenarios: [] })
            .filter(t => !conDiario.has(new Date(t.openTime * 1000).getUTCFullYear()))
        }
      } catch { /* sin historial se sigue con los diarios */ }

      mergeTrades([...resultados.flat(), ...delHistorial])
      setErrorSync(null)
      setUltimaSync(new Date())
    } catch (err) {
      setErrorSync(err.message)
    } finally {
      setSincronizando(false)
    }
  }, [mergeTrades])

  // Al abrir la pestaña: averigua qué años están conectados a Sheets y los sincroniza
  // solo, sin que haga falta subir el archivo a mano.
  useEffect(() => {
    fetch(`${API}/api/day-trades/anios`)
      .then(r => r.json())
      .then(data => {
        const anios = data.anios ?? []
        setAniosConectables(anios)
        if (anios.length) sincronizarAnios(anios)
      })
      .catch(() => { /* servidor local no disponible: sigue funcionando con la carga manual */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al montar
  }, [])

  const toggleProducto = p => {
    setProductosActivos(prev => {
      const s = new Set(prev); s.has(p) ? s.delete(p) : s.add(p); return s
    })
    setPagina(0)
  }

  const toggleCategoria = nombre => {
    setCategoriasActivas(prev => {
      const s = new Set(prev); s.has(nombre) ? s.delete(nombre) : s.add(nombre); return s
    })
    setPagina(0)
  }

  const cambiarFechaDesde = v => { setFechaDesde(v); setPagina(0) }
  const cambiarFechaHasta = v => { setFechaHasta(v); setPagina(0) }
  const limpiarFiltros = () => {
    setProductosActivos(new Set()); setCategoriasActivas(new Set())
    setFechaDesde(''); setFechaHasta(''); setPagina(0)
  }

  const procesar = useCallback(async file => {
    try {
      const buffer = await file.arrayBuffer()
      const parsed = await parseTradesXLSX(buffer)
      if (!parsed.length) throw new Error('No se encontraron filas de tipo TRADE en el archivo')
      // Se añade al histórico ya cargado (p.ej. subir "DAY 2025.xlsx" y luego
      // "DAY 2026.xlsx") en vez de reemplazarlo, evitando duplicar operaciones repetidas.
      mergeTrades(parsed)
      setError(null)
      setPagina(0)
    } catch (err) {
      setError(err.message)
    }
  }, [mergeTrades])

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
  // Los índices y metales que la app grafica van como chips a la vista; el resto de lo que
  // aparece en el historial de la cuenta (divisas, acciones, materias primas…) se esconde
  // en un desplegable para no llenar la pantalla, y solo sale como chip si está activo.
  const productosDisponibles = useMemo(
    () => [...new Set(trades.map(t => t.producto))].sort(),
    [trades]
  )

  const productosPrincipales = useMemo(
    () => productosDisponibles.filter(p => PRODUCTO_A_TICKER[p]),
    [productosDisponibles],
  )

  const productosSecundarios = useMemo(
    () => productosDisponibles.filter(p => !PRODUCTO_A_TICKER[p]),
    [productosDisponibles],
  )

  const secundariosActivos = useMemo(
    () => productosSecundarios.filter(p => productosActivos.has(p)),
    [productosSecundarios, productosActivos],
  )

  // Categorías del Book of Horror presentes en las operaciones cargadas (requiere que
  // el .xlsx subido incluya la hoja "Scenarios" del mismo libro que el diario)
  const categoriasDisponibles = useMemo(() => {
    const presentes = new Set(trades.flatMap(t => (t.categorias ?? []).map(c => c.nombre)))
    return CATEGORIAS_HORROR.filter(c => presentes.has(c.nombre))
  }, [trades])

  const hayFiltros = productosActivos.size > 0 || categoriasActivas.size > 0 || fechaDesde || fechaHasta

  const filtradas = useMemo(() => trades.filter(t => {
    if (productosActivos.size > 0 && !productosActivos.has(t.producto)) return false
    if (categoriasActivas.size > 0 && !(t.categorias ?? []).some(c => categoriasActivas.has(c.nombre))) return false
    const fecha = fmtFechaTS(t.openTime)
    if (fechaDesde && fecha < fechaDesde) return false
    if (fechaHasta && fecha > fechaHasta) return false
    return true
  }), [trades, productosActivos, categoriasActivas, fechaDesde, fechaHasta])

  const ordenadas     = useMemo(() => [...filtradas].reverse(), [filtradas])

  // Abrir una operación: lo mismo que pulsar su fila, más llevar la tabla a su página para
  // que se vea marcada cuando se salta con las flechas.
  const abrirTrade = t => {
    setVelas([])
    setPrevClose(null)
    setAvisoBook(null)
    setBorrador(null)
    setBorradorTexto(null)
    setSeleccionado(t)
    const i = ordenadas.indexOf(t)
    if (i >= 0) setPagina(Math.floor(i / PAGE_SIZE))
  }
  // Las flechas no se mueven pierna a pierna, sino por día+instrumento, igual que la tabla
  // de Seguimiento: un día con tres entradas en el DAX es una sola parada, no tres. De cada
  // sesión se abre su primera operación, que es la que Seguimiento usa para el gráfico.
  const claveSesion = t => `${fmtFechaTS(t.openTime)}|${t.producto}`

  const sesiones = useMemo(() => {
    const primera = new Map()
    // `ordenadas` va de la más reciente a la más antigua: se recorre al revés para quedarse
    // con la primera pierna de cada sesión, no con la última
    for (let i = ordenadas.length - 1; i >= 0; i--) {
      const t = ordenadas[i]
      const clave = claveSesion(t)
      if (!primera.has(clave)) primera.set(clave, t)
    }
    return [...primera.values()].reverse()
  }, [ordenadas])

  // "anterior" es la sesión de antes en el tiempo, o sea la siguiente de la lista
  const iAbierta = seleccionado
    ? sesiones.findIndex(t => claveSesion(t) === claveSesion(seleccionado))
    : -1
  const totalPaginas  = Math.max(1, Math.ceil(ordenadas.length / PAGE_SIZE))
  const enPagina       = ordenadas.slice(pagina * PAGE_SIZE, (pagina + 1) * PAGE_SIZE)

  // Con una categoría del Book of Horror activa, se muestra la foto de cada caso en vez
  // de la tabla de entry/exit: se agrupan las piernas de una misma sesión ("D53" puede
  // tener varias filas TRADE) porque comparten la misma captura.
  const modoGaleria = categoriasActivas.size > 0

  const gruposHorror = useMemo(() => {
    if (!modoGaleria) return []
    const porSesion = new Map()
    for (const t of filtradas) {
      const clave = t.sesion ?? `${t.producto}|${t.openTime}`
      if (!porSesion.has(clave)) {
        porSesion.set(clave, {
          clave, sesion: t.sesion, producto: t.producto,
          fecha: fmtFechaTS(t.openTime), openTime: t.openTime,
          categorias: [], puntos: 0,
        })
      }
      const g = porSesion.get(clave)
      g.puntos += t.puntos
      for (const c of (t.categorias ?? [])) {
        if (!g.categorias.some(x => x.n === c.n)) g.categorias.push(c)
      }
    }
    return [...porSesion.values()].sort((a, b) => b.openTime - a.openTime)
  }, [filtradas, modoGaleria])

  // Cruce fecha+instrumento → foto local. Los años sin recorte por instrumento (todo
  // salvo 2026 "Separados") solo tienen una captura del día completo: se usa como
  // respaldo cuando no hay una versión separada por instrumento para esa fecha.
  const fotoIndex = useMemo(() => {
    const porFechaInstrumento = new Map()
    const porFecha = new Map()
    for (const f of catalogoFotos) {
      if (!f.fecha) continue
      if (f.instrumento) porFechaInstrumento.set(`${f.fecha}|${f.instrumento}`, f)
      else if (!porFecha.has(f.fecha)) porFecha.set(f.fecha, f)
    }
    return { porFechaInstrumento, porFecha }
  }, [catalogoFotos])

  const fotoDeGrupo = g => {
    const token = PRODUCTO_A_INSTRUMENTO[g.producto]
    const porInstrumento = token && fotoIndex.porFechaInstrumento.get(`${g.fecha}|${token}`)
    return porInstrumento ?? fotoIndex.porFecha.get(g.fecha) ?? null
  }

  const fotoDeTrade = t => fotoDeGrupo({ producto: t.producto, fecha: fmtFechaTS(t.openTime) })

  // Paginación con salto directo: con decenas de páginas, ir de una en una no sirve.
  // El campo se reinicia con `key` cada vez que cambia la página, así las flechas también
  // lo actualizan sin necesidad de un estado aparte.
  const paginacion = total => {
    const saltar = campo => {
      const n = Math.round(Number(campo.value))
      if (!Number.isFinite(n) || n < 1) { campo.value = pagina + 1; return }
      setPagina(Math.min(n, total) - 1)
    }
    return (
      <div className="paginacion">
        <button className="pag-btn" onClick={() => setPagina(p => p - 1)} disabled={pagina === 0}>‹ Anterior</button>
        <span className="pag-info">
          <input
            key={pagina}
            className="pag-input"
            type="number"
            min={1}
            max={total}
            defaultValue={pagina + 1}
            title={`Escribe la página (1–${total}) y pulsa Enter`}
            onFocus={e => e.target.select()}
            onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
            onBlur={e => saltar(e.target)}
          /> / {total}
        </span>
        <button className="pag-btn" onClick={() => setPagina(p => p + 1)} disabled={pagina >= total - 1}>Siguiente ›</button>
      </div>
    )
  }

  // Los books son carpetas del disco: los botones solo tienen sentido con el servidor local
  const hayBooks = import.meta.env.DEV

  // Un clic manda al Book of Horror o al de Glory la misma captura que se está viendo
  const botonesBook = foto => {
    if (!hayBooks || !foto) return null
    const clave = claveDeFoto(foto)
    return (
      <span className="ts-books">
        {BOOKS.map(b => {
          const dentro = clave && enBooks[b.id]?.has(clave)
          return (
            <button
              key={b.id}
              className={`ts-book-btn ${dentro ? 'activo' : ''}`}
              onClick={e => { e.stopPropagation(); mandarABook(foto, b) }}
              title={dentro ? `Ya está en el ${b.nombre}` : `Mandar al ${b.nombre}`}
            >{b.icono}</button>
          )
        })}
      </span>
    )
  }

  // Etiquetas del trade seleccionado: las 12 del Book of Horror. Marcar y desmarcar solo
  // cambia el borrador; lo que las asocia al trade es el botón de guardar, que las escribe
  // donde los comentarios y hace que salgan en el book junto a su captura.
  // Comentario del trade seleccionado, al final del panel. Como las etiquetas: lo escrito
  // queda en el borrador y el botón es lo que lo asocia al trade, en la misma anotación.
  const editorComentario = t => {
    if (!hayBooks || !t) return null
    const clave    = claveDeOperacion(t)
    const guardado = (anotaciones[clave] ?? ANOTACION_VACIA).texto ?? ''
    const texto    = borradorTexto?.clave === clave ? borradorTexto.texto : guardado
    const sinGuardar = texto.trim() !== guardado
    const revisado   = anotaciones[clave]?.revisado === true

    return (
      <div className="ops-comentario">
        <div className="ops-comentario-cabecera">
          <span className="ops-etiquetas-tit">Comentario</span>
          <span className="ops-comentario-clave">{clave}</span>
          <span className="ops-etiquetas-guardar">
            {sinGuardar && <span className="ops-sin-guardar">sin guardar</span>}
            <button
              className={`ts-revisado ${revisado ? 'activo' : ''}`}
              onClick={() => alternarRevisado(clave)}
              title={revisado ? 'Marcado como revisado · clic para desmarcar' : 'Marcar como revisado'}
            >✓ revisado</button>
            <button
              className="diario-add"
              onClick={() => guardarComentario(clave, texto.trim())}
              disabled={!sinGuardar}
            >guardar</button>
          </span>
        </div>
        <textarea
          className="ts-comentario-edit"
          rows={4}
          placeholder="Qué viste, qué hiciste y qué harías distinto"
          value={texto}
          onChange={e => setBorradorTexto({ clave, texto: e.target.value })}
        />
      </div>
    )
  }

  // La captura del día, debajo del comentario. Va plegada por defecto: son imágenes grandes
  // de Drive y no tiene sentido descargarlas cada vez que se abre un trade. Una vez abierta,
  // se queda abierta para los siguientes, que es lo cómodo cuando se repasan varios.
  const visorFoto = t => {
    if (!t) return null
    const foto = fotoDeTrade(t)
    const src  = foto ? `${API}/api/fotos/archivo?id=${encodeURIComponent(foto.id)}` : null
    return (
      <div className="ops-comentario ops-foto">
        <div className="ops-comentario-cabecera">
          <span className="ops-etiquetas-tit">Foto del trade</span>
          {foto
            ? <>
                <span className="ops-comentario-clave">{foto.instrumento ?? ''} {foto.fecha ?? ''}</span>
                <span className="ops-etiquetas-guardar">
                  <button className="diario-add" onClick={() => setVerFoto(v => !v)}>
                    {verFoto ? 'ocultar' : 'ver foto'}
                  </button>
                </span>
              </>
            : <span className="ops-comentario-clave">sin captura en Drive para este día</span>}
        </div>
        {verFoto && src && (
          <img
            className="ops-foto-img"
            src={src}
            alt={`Captura de ${t.producto} del ${fmtFechaTS(t.openTime)}`}
            title="Clic para verla en grande"
            onClick={() => setFotoZoom(foto)}
          />
        )}
      </div>
    )
  }

  const editorEtiquetas = t => {
    if (!hayBooks || !t) return null
    const clave     = claveDeOperacion(t)
    const guardadas = (anotaciones[clave] ?? ANOTACION_VACIA).cats
    const cats      = borrador?.clave === clave ? borrador.cats : guardadas
    const sinGuardar = cats.length !== guardadas.length || cats.some(n => !guardadas.includes(n))

    const alternar = n => setBorrador({
      clave,
      cats: (cats.includes(n) ? cats.filter(c => c !== n) : [...cats, n]).sort((a, b) => a - b),
    })

    return (
      <div className="ops-etiquetas">
        <span className="ops-etiquetas-tit">Etiquetas</span>
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
            onClick={() => guardarEtiquetas(clave, cats)}
            disabled={!sinGuardar}
            title={`Guardar las etiquetas en ${clave}`}
          >guardar</button>
        </div>
      </div>
    )
  }

  const totalPaginasGaleria = Math.max(1, Math.ceil(gruposHorror.length / PAGE_SIZE_FOTOS))
  const gruposEnPagina = gruposHorror.slice(pagina * PAGE_SIZE_FOTOS, (pagina + 1) * PAGE_SIZE_FOTOS)

  // Seguimiento pide abrir un día+instrumento: se filtra por esa fecha y se selecciona
  // su primera operación, que es la que abre el gráfico.
  useEffect(() => {
    if (!abrir) return
    const t = trades.find(x => fmtFechaTS(x.openTime) === abrir.fecha && x.producto === abrir.producto)
    // viene de otra pestaña (Seguimiento), no hay render del que derivarlo
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFechaDesde(abrir.fecha)
    setFechaHasta(abrir.fecha)
    setPagina(0)
    setVelas([])
    setPrevClose(null)
    setAvisoBook(null)
    setBorrador(null)
    setBorradorTexto(null)
    if (t) setSeleccionado(t)
    onAbierto?.()
  }, [abrir, trades, onAbierto])

  // Esc saca el gráfico de pantalla completa (la foto ampliada tiene su propio Esc)
  useEffect(() => {
    if (!pantallaCompleta) return
    const onKeyDown = e => { if (e.key === 'Escape') setPantallaCompleta(false) }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pantallaCompleta])

  useEffect(() => {
    if (!fotoZoom) return
    const onKeyDown = e => { if (e.key === 'Escape') setFotoZoom(null) }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fotoZoom])

  // Todas las operaciones (con filtros o sin ellos) del mismo instrumento+día que la
  // fila seleccionada, para marcarlas todas en el gráfico
  const tradesDelDia = useMemo(() => {
    if (!seleccionado) return []
    const fecha  = fmtFechaTS(seleccionado.openTime)
    const factor = FACTOR_PRECIO[seleccionado.ticker] ?? 1
    const delDia = trades.filter(t => t.ticker === seleccionado.ticker &&
      (fmtFechaTS(t.openTime) === fecha || fmtFechaTS(t.closeTime) === fecha))
    // la tabla sigue enseñando el precio tal cual lo da el bróker; solo el gráfico
    // necesita la escala del instrumento (ver FACTOR_PRECIO)
    return factor === 1 ? delDia : delDia.map(t => ({
      ...t,
      openPrice:  t.openPrice / factor,
      closePrice: t.closePrice / factor,
    }))
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
      {aniosConectables.length > 0 && (
        <div className="sync-sheets-row">
          <span className="sync-sheets-label">
            🔗 Conectado con Google Sheets: {aniosConectables.map(a => `DAY ${a}`).join(', ')}
          </span>
          <button className="dia-esp-chip" onClick={() => sincronizarAnios(aniosConectables)} disabled={sincronizando}>
            {sincronizando ? 'Sincronizando…' : '🔄 Sincronizar ahora'}
          </button>
          {ultimaSync && !sincronizando && (
            <span className="sync-sheets-hora">Última sincronización: {ultimaSync.toLocaleTimeString('es-ES')}</span>
          )}
          {errorSync && <span className="sync-sheets-error">⚠ {errorSync}</span>}
        </div>
      )}

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
              {[...productosPrincipales, ...secundariosActivos].map(p => (
                <button
                  key={p}
                  className={`dia-esp-chip ${productosActivos.has(p) ? 'activo' : ''}`}
                  onClick={() => toggleProducto(p)}
                >{p}</button>
              ))}
              {productosSecundarios.length > 0 && (
                <select
                  className="filtro-otros"
                  value=""
                  onChange={e => { if (e.target.value) toggleProducto(e.target.value) }}
                  title="Instrumentos sueltos del historial de la cuenta"
                >
                  <option value="">otros ({productosSecundarios.length})…</option>
                  {productosSecundarios.map(p => (
                    <option key={p} value={p}>{productosActivos.has(p) ? '✓ ' : ''}{p}</option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {categoriasDisponibles.length > 0 && (
            <div className="filtro-group">
              <label className="filtro-label">
                Categoría (Book of Horror)
                {categoriasActivas.size > 0 && (
                  <button className="clear-eventos" onClick={() => { setCategoriasActivas(new Set()); setPagina(0) }}>× limpiar</button>
                )}
              </label>
              <div className="filtro-dias-esp">
                {categoriasDisponibles.map(c => (
                  <button
                    key={c.n}
                    className={`dia-esp-chip horror-chip ${categoriasActivas.has(c.nombre) ? 'activo' : ''}`}
                    title={c.nombre}
                    onClick={() => toggleCategoria(c.nombre)}
                  >#{c.n} {c.corto}</button>
                ))}
              </div>
            </div>
          )}

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

          {modoGaleria ? (
            <>
              {errorFotos && <div className="fotos-error">No se pudo cargar el catálogo de fotos: {errorFotos}</div>}
              {!errorFotos && catalogoFotos.length === 0 && (
                <div className="fotos-error">Cargando catálogo de fotos… (requiere el servidor local en modo desarrollo)</div>
              )}

              <div className="horror-galeria">
                {gruposEnPagina.map(g => {
                  const foto = fotoDeGrupo(g)
                  return (
                    <div key={g.clave} className="fotos-card horror-galeria-card">
                      {foto ? (
                        <img
                          className="fotos-img fotos-img-zoomable"
                          src={`${API}/api/fotos/archivo?id=${encodeURIComponent(foto.id)}`}
                          alt={`${g.producto} ${g.fecha}`}
                          onClick={() => setFotoZoom(foto)}
                          title="Clic para agrandar"
                        />
                      ) : (
                        <div className="filtro-vacio">Sin captura local encontrada para esta sesión.</div>
                      )}
                      <div className="fotos-caption">
                        {g.fecha} · {g.producto}{g.sesion ? ` · ${g.sesion}` : ''}
                        {' · '}<span className={g.puntos >= 0 ? 'texto-verde' : 'texto-rojo'}>
                          {g.puntos > 0 ? '+' : ''}{g.puntos.toFixed(2)} pts
                        </span>
                      </div>
                      <div className="horror-badges-cell horror-galeria-badges">
                        {g.categorias.map(c => (
                          <span key={c.n} className="horror-badge" title={c.nombre}>#{c.n} {c.corto}</span>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>

              {paginacion(totalPaginasGaleria)}
            </>
          ) : (
            <>
              <div className="velas-tabla-wrap">
                <table className="velas-tabla trades-tabla">
                  <thead>
                    <tr>
                      <th>Fecha apertura</th><th>Hora apertura</th><th>Precio apertura</th>
                      <th>Fecha cierre</th><th>Hora cierre</th><th>Precio cierre</th>
                      <th>Producto</th><th>Dir</th>
                      <th title="Tamaño de la posición tal como viene del diario o del historial">Size</th>
                      <th>Puntos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {enPagina.map((t, i) => (
                      <tr
                        key={i}
                        className={`clickable-row ${t.puntos >= 0 ? 'fila-up' : 'fila-down'} ${seleccionado === t ? 'fila-seleccionada' : ''}`}
                        onClick={() => abrirTrade(t)}
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
                        <td>{fmtSize(t.size)}</td>
                        <td className="trades-puntos">{t.puntos > 0 ? '+' : ''}{t.puntos.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {paginacion(totalPaginas)}
            </>
          )}

          {seleccionado && (
            <div className={`ops-grafico ${pantallaCompleta ? 'pantalla-completa' : ''}`}>
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
                  {botonesBook(fotoDeTrade(seleccionado))}
                </div>
                <button
                  className="tf-chip ops-pantalla"
                  onClick={() => setPantallaCompleta(v => !v)}
                  title={pantallaCompleta ? 'Salir de pantalla completa (Esc)' : 'Ver el trade a pantalla completa'}
                >{pantallaCompleta ? '⤡ salir' : '⤢ pantalla completa'}</button>
                <button className="btn-ir-fecha" onClick={() => { setVelas([]); setPrevClose(null); setPantallaCompleta(false); setSeleccionado(null) }}>× cerrar</button>
              </div>

              {/* a pantalla completa se deja solo el gráfico: ni etiquetas, ni comentario */}
              {!pantallaCompleta && avisoBook && <div className="horror-aviso">{avisoBook}</div>}

              {!pantallaCompleta && editorEtiquetas(seleccionado)}

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
                  alto={pantallaCompleta ? Math.max(360, window.innerHeight - 110) : undefined}
                  pantallaCompleta={pantallaCompleta}
                  onPantallaCompleta={() => setPantallaCompleta(v => !v)}
                />
              )}
              {seleccionado.ticker && !cargandoVelas && velas.length === 0 && (
                <div className="filtro-vacio">Sin datos intraday disponibles para esta fecha.</div>
              )}

              {!pantallaCompleta && editorComentario(seleccionado)}

              {!pantallaCompleta && visorFoto(seleccionado)}

              {/* saltar de sesión sin volver a la tabla, al final del repaso */}
              {!pantallaCompleta && (
                <div className="ops-nav ops-nav-pie">
                  <button
                    className="tf-chip"
                    disabled={iAbierta < 0 || iAbierta >= sesiones.length - 1}
                    onClick={() => abrirTrade(sesiones[iAbierta + 1])}
                    title="Día e instrumento anterior, como en Seguimiento"
                  >‹ anterior</button>
                  {iAbierta >= 0 && (
                    <span className="ops-nav-pos">
                      {sesiones.length - iAbierta} de {sesiones.length}
                    </span>
                  )}
                  <button
                    className="tf-chip"
                    disabled={iAbierta <= 0}
                    onClick={() => abrirTrade(sesiones[iAbierta - 1])}
                    title="Día e instrumento siguiente, como en Seguimiento"
                  >siguiente ›</button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* una sola lupa para las dos vistas: la galería de casos y la foto del trade abierto */}
      {fotoZoom && (
        <div className="fotos-lightbox" onClick={() => setFotoZoom(null)}>
          <button className="fotos-lightbox-cerrar" onClick={() => setFotoZoom(null)} title="Cerrar (Esc)">×</button>
          <img
            className="fotos-lightbox-img"
            src={`${API}/api/fotos/archivo?id=${encodeURIComponent(fotoZoom.id)}`}
            alt="Captura ampliada"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  )
}
