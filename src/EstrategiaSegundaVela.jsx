import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import GraficoVelas from './GraficoVelas'
import CurvaEquity from './CurvaEquity.jsx'
import { INSTRUMENTOS, intradayUrl } from './intradayApi'
import { useTrades } from './useTrades'
import { fmtFechaTS } from './parseTrades'
import { SESIONES, analizarSesion, resumir, fmtMin, fmtPts } from './segundaVelaCore'
import { estrategiaDe, agruparVelas, prepararSesion, ventanaRuleOf4 } from './estrategias'
import { FOMC, ANIOS_FOMC } from './fomc'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'

const DIAS = [
  { n: 1, label: 'L', nombre: 'Lunes' },
  { n: 2, label: 'M', nombre: 'Martes' },
  { n: 3, label: 'X', nombre: 'Miércoles' },
  { n: 4, label: 'J', nombre: 'Jueves' },
  { n: 5, label: 'V', nombre: 'Viernes' },
]
const DIA_CORTO = { 1: 'LUN', 2: 'MAR', 3: 'MIÉ', 4: 'JUE', 5: 'VIE' }

const PERIODOS   = [
  { meses: 1, label: '1m' }, { meses: 3, label: '3m' }, { meses: 6, label: '6m' },
  { meses: 12, label: '12m' }, { meses: 24, label: '2a' }, { meses: 60, label: '5a' },
  { meses: 120, label: '10a' },
]
// El tope real lo pone la paciencia: el feed se descarga sesión a sesión y en serie, porque
// Dukascopy corta por IP si se le piden muchos ficheros a la vez. Lo ya descargado se queda
// en la caché de disco del servidor, así que la segunda pasada sobre las mismas fechas vuela.
const CANTIDADES = [20, 60, 120, 250, 500]

// Cómo acabó cada pierna de la sesión, no solo la primera: con flip una sesión puede saltar
// el stop, darse la vuelta y cerrar en el objetivo, y las tres cosas cuentan para filtrar.
const salidasDe = a => a.entrada
  ? [a.salida, ...(a.piernas ?? []).map(p => p.salida)].map(x => x.motivo)
  : []

// Unidades añadidas por la pirámide en toda la sesión, sumando las vueltas
const anadidosDe = a => a.entrada
  ? (a.anadidos?.length ?? 0) + (a.piernas ?? []).reduce((n, p) => n + (p.anadidos?.length ?? 0), 0)
  : 0

// Una sesión pasa cuando cumple todas las condiciones marcadas (sin ninguna, pasan todas)
const pasaFiltros = (a, ids) =>
  [...ids].every(id => FILTROS.find(f => f.id === id)?.test(a) ?? true)

// Qué tarjetas se ven. Cada filtro lleva su propia condición, así que añadir uno nuevo es
// una línea. `nota` es el texto que sale al pasar el ratón por encima.
const FILTROS = [
  { id: 'todas',       label: 'Todas',                test: () => true,                           nota: 'Todas las sesiones analizadas' },
  { id: 'compra',      label: 'Con operación',        test: a => !!a.entrada,                     nota: 'Las sesiones en las que el precio rompió el bracket' },
  { id: 'ganadas',     label: 'Ganadas',              test: a => a.resultado === 'ganada',        nota: 'La sesión entera acaba en positivo' },
  { id: 'perdidas',    label: 'Perdidas',             test: a => a.resultado === 'perdida',       nota: 'La sesión entera acaba en negativo' },
  { id: 'sin',         label: 'Sin entrada',          test: a => a.resultado === 'sin-entrada',   nota: 'El precio no llegó a romper el bracket' },
  { id: 'stop',        label: 'Salta el stop',        test: a => salidasDe(a).includes('bracket'),   nota: 'Alguna pierna cierra en el extremo contrario del bracket' },
  { id: 'be',          label: 'Sale en BE',           test: a => salidasDe(a).includes('breakeven'), nota: 'Alguna pierna cierra en break even (stop ya movido a la entrada o al precio medio)' },
  { id: 'objetivo',    label: 'Objetivo alcanzado',   test: a => salidasDe(a).includes('objetivo'),  nota: 'Alguna pierna cierra en la toma de beneficios' },
  { id: 'cierre',      label: 'Cierra con la sesión', test: a => salidasDe(a).includes('cierre'),    nota: 'Aguanta hasta el cierre sin tocar stop ni objetivo' },
  { id: 'flip',        label: 'Con vuelta',           test: a => a.piernas?.length > 0,           nota: 'El stop saltó y se dio la vuelta a la posición' },
  { id: 'add1',        label: 'Con añadidos',         test: a => anadidosDe(a) >= 1,              nota: 'La pirámide llegó a añadir al menos una unidad' },
  { id: 'add2',        label: 'Añade 2+',             test: a => anadidosDe(a) >= 2,              nota: 'Dos unidades añadidas o más' },
  { id: 'add3',        label: 'Añade 3+',             test: a => anadidosDe(a) >= 3,              nota: 'Tres unidades añadidas o más' },
  { id: 'descartadas', label: 'Sin datos',            test: a => !a.valido,                       nota: 'Sesiones que no se pudieron leer' },
]

// Color de la primera vela de 15 min de la sesión, tal como se pinta en el gráfico:
// blanca si cierra por encima de su apertura, negra si cierra por debajo. Filtra el
// conjunto que se analiza, no solo lo que se ve, para poder comparar las estadísticas
// de la estrategia en un caso y en el otro.
const VELAS1 = [
  { id: 'todas',  label: 'Todas',    dir: null },
  { id: 'blanca', label: '⬜ Blanca', dir: 'alcista' },
  { id: 'negra',  label: '⬛ Negra',  dir: 'bajista' },
]

// Qué operativa se simula. El stop de una pierna es el nivel de entrada de la contraria,
// así que "con flip" es literalmente darle la vuelta a la posición cuando salta.
const MODOS = [
  { id: 'ambos', label: 'Largos y cortos',  nota: 'manda el extremo que se rompa antes' },
  { id: 'flip',  label: 'Con flip',         nota: 'al saltar el stop se da la vuelta a la posición' },
]

// Dónde se pone el stop. Al otro extremo, 1R es el rango entero de la vela; a la mitad se
// arriesga la mitad, así que la R se hace pequeña y con ella el disparador del break even y
// el paso de la pirámide.
// A qué modo se cae cuando el stop deja de estar en el extremo contrario
const SIN_FLIP = { flip: 'ambos' }

const NIVELES = [
  { id: 'extremo', label: 'Al otro lado',  stopPct: 1,   nota: 'el stop va al extremo contrario de la vela del bracket' },
  { id: 'medio',   label: 'Al 50%',        stopPct: 0.5, nota: 'el stop va a mitad de la vela: la mitad de riesgo y el doble de R' },
]

// Cuánto mete cada añadido de la pirámide. La entrada vale siempre 1. Con añadidos de media
// unidad el precio medio de la posición sube menos, y como el stop del conjunto se pone en
// ese precio medio, queda más lejos del precio y la operación aguanta más antes de saltar.
const TAMANOS = [
  { id: 'uno',   label: '1',   tamano: 1,   nota: 'cada añadido mete una unidad entera' },
  { id: 'medio', label: '0,5', tamano: 0.5, nota: 'cada añadido mete media unidad: el precio medio se mueve menos y el stop del conjunto queda más lejos' },
]

// Hipótesis a contrastar: mover el stop a la entrada en cuanto el precio recorre esas R
// a favor. Cambia el peor caso de −1R a 0R, a cambio de cerrar a cero operaciones que
// habrían acabado ganando.
// Tamaño de la posición: fijo, o sumando una unidad cada vez que el precio recorre otra
// R a favor. Al añadir, el stop de toda la posición pasa a su precio medio, que es donde
// el conjunto sale a cero.
const VOLUMENES = [
  { id: 'fijo',      label: '1 unidad',   piramide: 0, nota: 'una sola unidad, stop en el extremo del bracket' },
  { id: 'piramide',  label: '+1 cada 1R', piramide: 1, nota: 'añade una unidad cada R recorrida y pone el stop de todo en break even' },
  { id: 'piramide2', label: '+1 cada 2R', piramide: 2, nota: 'añade una unidad cada 2R: menos unidades, pero cada una con más recorrido detrás' },
]

// Toma de beneficios opcional: se cierra cuando el resultado acumulado de la posición —la
// suma de todas las unidades de la pirámide— llega a ese porcentaje del índice. Con el DAX
// en 20.000, un 3,5% son 700 puntos: con una sola unidad se los tiene que recorrer el
// índice entero, y con seis basta con que se mueva la sexta parte.
const OBJETIVOS = [
  { id: 'no',  label: 'Sin objetivo', nota: 'la posición corre hasta el stop o el cierre de la sesión' },
  { id: 'pct', label: 'Toma de beneficios', nota: null },
]

const TP_POR_DEFECTO = 3.5

const STOPS = [
  { id: 'fijo', label: 'Fijo',        beR: null, nota: 'el stop se queda en el extremo contrario del bracket' },
  { id: 'be1',  label: 'BE en +1R',   beR: 1,    nota: 'el stop pasa a la entrada al recorrer 1R a favor' },
  { id: 'be2',  label: 'BE en +2R',   beR: 2,    nota: 'el stop pasa a la entrada al recorrer 2R a favor' },
]

// Años que cubre el CSV de DAX cash de 5 min
const ANIOS_CSV = Array.from({ length: 2026 - 2009 + 1 }, (_, i) => 2009 + i)

// Con qué velas se dibuja el mosaico. No toca el análisis: el bracket sale siempre de las
// dos primeras velas de 15 min, pase lo que pase aquí.
const TIMEFRAMES = [
  { id: '5m',   label: '5 min', nota: 'se piden al vuelo solo para las tarjetas que se ven' },
  { id: 'base', label: null,    nota: 'las mismas velas con las que se analiza la sesión' },
]

const POR_PAGINA = 6

const fmtPct = v => v == null ? '—' : `${Math.round(v)}%`
// Resultados en puntos del instrumento, que es como se leen en el gráfico
const fmtSgn = v => v == null ? '—'
  : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('es-ES', { maximumFractionDigits: Math.abs(v) < 10 ? 2 : 1 })}`
const fmtPtsSgn = v => v == null ? '—' : `${fmtSgn(v)} pts`

// Descarga y analiza las sesiones de una en una: Dukascopy limita por IP en cuanto
// se le piden muchos ficheros seguidos, así que se va en serie y cada resultado se
// pinta en cuanto llega (con el botón de cancelar disponible todo el rato).
export default function EstrategiaSegundaVela({ estrategiaId = 'segunda-vela' }) {
  const estr = estrategiaDe(estrategiaId)
  const [ticker,     setTicker]     = useState('^GDAXI')
  const [meses,      setMeses]      = useState(3)
  const [cantidad,   setCantidad]   = useState(20)
  const [dias,       setDias]       = useState(new Set([1, 2, 3, 4, 5]))
  const [resultados, setResultados] = useState([])
  const [cargando,   setCargando]   = useState(false)
  const [progreso,   setProgreso]   = useState(null)
  const [error,      setError]      = useState(null)
  const [filtros,    setFiltros]    = useState(() => new Set())   // vacío = sin filtrar
  const [vela1,      setVela1]      = useState('todas')
  const [modo,       setModo]       = useState(estrategiaDe(estrategiaId).modoInicial ?? 'ambos')
  const [nivelStop,  setNivelStop]  = useState('extremo')
  const [tamano,     setTamano]     = useState('uno')
  const [stopModo,   setStopModo]   = useState('fijo')
  const [volumen,    setVolumen]    = useState('fijo')
  const [tpModo,     setTpModo]     = useState('no')
  const [tpPct,      setTpPct]      = useState(TP_POR_DEFECTO)
  const [aPantalla,  setAPantalla]  = useState(null)   // fecha de la sesión abierta a pantalla completa
  const [fuente,     setFuente]     = useState('feed')   // 'feed' (Dukascopy) o 'csv' (DAX 2009→)
  // la Rule of 4 arranca en los últimos años: cada reunión es una descarga del feed
  const [anioDesde,  setAnioDesde]  = useState(estr.soloFomc ? 2024 : 2009)
  const [anioHasta,  setAnioHasta]  = useState(2026)
  const [mostradas,  setMostradas]  = useState(POR_PAGINA)
  const [finas5m,    setFinas5m]    = useState({})   // fecha -> velas de 5 min, solo para dibujar
  const pedidas5mRef = useRef(new Set())
  const centinelaRef = useRef(null)
  const abortRef = useRef(null)
  const [trades] = useTrades()

  const sesion = SESIONES[ticker]
  const stopPct = NIVELES.find(n => n.id === nivelStop)?.stopPct ?? 1
  // Con el stop a media vela no hay vuelta posible: el nivel donde salta ya no es la entrada
  // del lado contrario, así que el modo cae a su equivalente sin flip.
  const modoEfectivo = stopPct !== 1 ? (SIN_FLIP[modo] ?? modo) : modo
  // el objetivo solo cuenta cuando está activado y el porcentaje es un número utilizable
  const tpValor = tpModo === 'pct' && Number(tpPct) > 0 ? Number(tpPct) : null

  // Todo lo que define la operativa, en un solo sitio: lo usan las tres descargas, el
  // afinado de las dudosas y el recálculo al tocar un filtro.
  const opcionesMotor = {
    ticker,
    modo: modoEfectivo,
    beR: STOPS.find(x => x.id === stopModo)?.beR ?? null,
    piramide: VOLUMENES.find(v => v.id === volumen)?.piramide ?? 0,
    tpPct: tpValor,
    stopPct,
    tamanoAnadido: TAMANOS.find(t => t.id === tamano)?.tamano ?? 1,
  }

  const toggleDia = n => setDias(prev => {
    const s = new Set(prev); s.has(n) ? s.delete(n) : s.add(n); return s
  })

  // Vuelve al principio del mosaico y tira las velas finas ya pedidas
  const reiniciarVista = () => {
    setMostradas(POR_PAGINA)
    setFinas5m({})
    pedidas5mRef.current.clear()
  }

  const cancelar = () => {
    abortRef.current?.abort()
    setCargando(false)
    setProgreso(null)
  }

  // El CSV de DAX cash a 5 min (2009 en adelante) llega ya agregado a velas de 15 min y
  // de una sola petición: 17 años de sesiones sin depender del feed ni de su límite por IP.
  // Cuando una vela toca los dos extremos del bracket no se sabe cuál se rompió antes, y
  // por tanto tampoco si la operación ganó o perdió. Se baja de resolución en cadena: las
  // dudosas de 15 min se recorren con 5 min, y las que sigan dudosas con 1 min.
  const afinarDudosas = useCallback(async (ctrl, opciones, inicial) => {
    // la lista viaja por parámetro: leer el estado con un actualizador no es síncrono y
    // dejaba el afinado sin nada que hacer
    let lista = inicial

    const paso = async (etiqueta, traerVelas) => {
      const dudosas = lista.filter(r => r.analisis.ambigua).map(r => r.sesion.date)
      if (!dudosas.length) return
      const finas = await traerVelas(dudosas)
      if (ctrl.signal.aborted || !finas.size) return
      lista = lista.map(r => {
        const v = finas.get(r.sesion.date)
        if (!v?.length) return r
        const analisis = analizarSesion({ ...opciones, ventana: r.ventana ?? null, velas: r.velas, velasFinas: v, finasEtiqueta: etiqueta })
        return { ...r, finas: v, finasEtiqueta: etiqueta, analisis }
      })
      setResultados(lista)
    }

    await paso('5m', async dudosas => {
      const mapa = new Map()
      if (fuente === 'csv') {
        const q = new URLSearchParams({ finas: '1', dias: dudosas.join(',') })
        const d = await (await fetch(`${API}/api/dax-historico?${q}`, { signal: ctrl.signal })).json()
        for (const s of d.sesiones ?? []) mapa.set(s.date, s.finas)
      } else {
        for (const fecha of dudosas) {
          const d = await (await fetch(intradayUrl(ticker, fecha, 'm5'), { signal: ctrl.signal })).json()
          if (d.velas?.length) mapa.set(fecha, d.velas)
        }
      }
      return mapa
    })

    // 1 min: siempre del feed, que es quien lo tiene (Dukascopy no llega a los años más
    // antiguos del CSV, así que alguna sesión se queda sin resolver y se dice en la tarjeta)
    await paso('1m', async dudosas => {
      const mapa = new Map()
      const tkr = fuente === 'csv' ? '^GDAXI' : ticker
      for (const fecha of dudosas) {
        if (ctrl.signal.aborted) break
        try {
          const d = await (await fetch(intradayUrl(tkr, fecha, 'm1'), { signal: ctrl.signal })).json()
          if (d.velas?.length) mapa.set(fecha, d.velas)
        } catch (e) { if (e.name === 'AbortError') break }
      }
      return mapa
    })
  }, [fuente, ticker])

  const analizarHistorico = async () => {
    cancelar()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setCargando(true)
    setError(null)
    setResultados([])
    reiniciarVista()
    setProgreso({ done: 0, total: 0 })

    try {
      const p = new URLSearchParams({ desde: `${anioDesde}-01-01`, hasta: `${anioHasta}-12-31` })
      const r = await fetch(`${API}/api/dax-historico?${p}`, { signal: ctrl.signal })
      const d = await r.json()
      if (d.error) throw new Error(d.error)

      const semana = new Set(dias)
      const lista = (d.sesiones ?? [])
        .filter(s => semana.has(new Date(`${s.date}T12:00:00Z`).getUTCDay()))
        .reverse()
      if (lista.length === 0) throw new Error('Ninguna sesión del CSV cumple el filtro')

      setProgreso({ done: lista.length, total: lista.length })
      const opciones = { ...opcionesMotor, ticker: '^GDAXI' }
      const base = lista.map(s => {
        const prep = prepararSesion(estr, '^GDAXI', s.velas)
        return {
          sesion: { date: s.date, prevClose: null },
          velas: prep.velas, finas: prep.finas, finasEtiqueta: prep.finas ? '15m' : undefined,
          ventana: prep.ventana,
          fuente: 'CSV DAX 5 min',
          analisis: analizarSesion({
            ...opciones, velas: prep.velas, velasFinas: prep.finas, finasEtiqueta: '15m', ventana: prep.ventana,
          }),
        }
      })
      setResultados(base)
      await afinarDudosas(ctrl, opciones, base)
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message)
    } finally {
      if (!ctrl.signal.aborted) { setCargando(false); setProgreso(null) }
    }
  }

  // Rule of 4: solo los días de reunión del FOMC, y de cada uno su ventana de dos horas
  // desde el comunicado. Las velas llegan de 5 min y se agrupan en velas de 10 ancladas en
  // la noticia; las de 5 se guardan como finas, así que el recorrido ya se camina con ellas.
  const analizarFomc = async () => {
    cancelar()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setCargando(true)
    setError(null)
    setResultados([])
    reiniciarVista()
    setProgreso({ done: 0, total: 0 })

    try {
      const semana = new Set(dias)
      const fechas = FOMC
        .filter(f => Number(f.slice(0, 4)) >= anioDesde && Number(f.slice(0, 4)) <= anioHasta)
        .filter(f => semana.has(new Date(`${f}T12:00:00Z`).getUTCDay()))
        .filter(f => f <= new Date().toISOString().slice(0, 10))
        .reverse()
      if (fechas.length === 0) throw new Error('No hay reuniones del FOMC en esos años')
      setProgreso({ done: 0, total: fechas.length })

      const opciones = opcionesMotor
      const acumuladas = []
      for (const fecha of fechas) {
        if (ctrl.signal.aborted) return
        let velas5 = [], fuenteVelas = null
        try {
          const d = await (await fetch(intradayUrl(ticker, fecha, 'm5'), { signal: ctrl.signal })).json()
          velas5      = d.velas ?? []
          fuenteVelas = d.fuente ?? null
        } catch (e) {
          if (e.name === 'AbortError') return
        }
        if (ctrl.signal.aborted) return

        // El feed devuelve el día entero (00:00-23:59). Se recorta a la ventana con media hora
        // de contexto por delante: si no, las dos horas que importan quedan aplastadas en un
        // dedo de gráfico y las marcas de entrada, stop y vuelta se amontonan.
        const ventana = ventanaRuleOf4(fecha)
        const finTs   = ventana.inicioTs + (ventana.close - ventana.open) * 60
        const v5      = velas5.filter(v => v.time >= ventana.inicioTs - 1800 && v.time < finTs + 600)
        const velas10 = agruparVelas(velas5, ventana.minutosVela, ventana.inicioTs).filter(v => v.time < finTs)
        const fila = {
          sesion: { date: fecha, prevClose: null },
          velas: velas10, finas: v5, finasEtiqueta: '5m', ventana,
          fuente: fuenteVelas,
          analisis: analizarSesion({ ...opciones, ventana, velas: velas10, velasFinas: v5 }),
        }
        acumuladas.push(fila)
        setResultados(prev => [...prev, fila])
        setProgreso(prev => ({ ...prev, done: prev.done + 1 }))
      }

      // las que sigan sin resolverse se recorren con velas de 1 min
      await afinarDudosas(ctrl, opciones, acumuladas)
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message)
    } finally {
      if (!ctrl.signal.aborted) { setCargando(false); setProgreso(null) }
    }
  }

  const analizar = async () => {
    if (estr.soloFomc) return analizarFomc()
    if (fuente === 'csv') return analizarHistorico()
    cancelar()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setCargando(true)
    setError(null)
    setResultados([])
    reiniciarVista()
    setProgreso({ done: 0, total: 0 })

    try {
      // El Gap Filter ya sabe qué días negoció cada instrumento (y filtra por día
      // de la semana): se reutiliza como calendario de sesiones.
      const p = new URLSearchParams({
        ticker, meses, gapMin: 0, gapModo: 'pct', dir: 'both',
        dias: [...dias].sort().join(','),
      })
      const r = await fetch(`/api/gap-filter?${p}`, { signal: ctrl.signal })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? 'No se pudo obtener el calendario de sesiones')

      const lista = (d.sesiones ?? []).slice(-cantidad).reverse()
      if (lista.length === 0) throw new Error('Ningún día cumple el filtro en ese periodo')
      setProgreso({ done: 0, total: lista.length })

      const acumuladas = []
      for (const s of lista) {
        if (ctrl.signal.aborted) return
        let velas = [], fuente = null
        try {
          const rv = await fetch(intradayUrl(ticker, s.date, 'm15'), { signal: ctrl.signal })
          const dv = await rv.json()
          velas  = dv.velas ?? []
          fuente = dv.fuente ?? null
        } catch (e) {
          if (e.name === 'AbortError') return
        }
        if (ctrl.signal.aborted) return
        const prep = prepararSesion(estr, ticker, velas)
        const fila = {
          sesion: s, fuente,
          velas: prep.velas, finas: prep.finas, finasEtiqueta: prep.finas ? '15m' : undefined,
          ventana: prep.ventana,
          analisis: analizarSesion({
            ...opcionesMotor, velas: prep.velas, velasFinas: prep.finas, finasEtiqueta: '15m', ventana: prep.ventana,
          }),
        }
        acumuladas.push(fila)
        setResultados(prev => [...prev, fila])
        setProgreso(prev => ({ ...prev, done: prev.done + 1 }))
      }

      // y las sesiones que quedaron sin resolver se recorren con 5 y, si hace falta, 1 min
      await afinarDudosas(ctrl, opcionesMotor, acumuladas)
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message)
    } finally {
      if (!ctrl.signal.aborted) { setCargando(false); setProgreso(null) }
    }
  }

  // El color de la 1ª vela recorta el conjunto analizado: las estadísticas de abajo son
  // las de ese subconjunto. Las sesiones descartadas no tienen color que mirar, así que
  // solo entran cuando no se filtra por él.
  // La operativa se recalcula sobre las velas ya descargadas: cambiar de modo no vuelve
  // a pedirle nada al feed.
  const conModo = useMemo(() => resultados.map(r => ({
    ...r,
    analisis: analizarSesion({
      ...opcionesMotor,
      velas: r.velas, ventana: r.ventana ?? null,
      velasFinas: r.finas, finasEtiqueta: r.finasEtiqueta ?? '5m',
    }),
  // opcionesMotor se rehace en cada render; sus piezas son las que de verdad disparan el
  // recalculo, y son todas valores sueltos
  // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [resultados, ticker, modoEfectivo, stopModo, volumen, tpValor, stopPct, tamano])

  const analizadas = useMemo(() => {
    const dir = VELAS1.find(v => v.id === vela1)?.dir
    return dir ? conModo.filter(({ analisis: a }) => a.valido && a.dir1 === dir) : conModo
  }, [conModo, vela1])

  const resumen = useMemo(() => resumir(analizadas.map(r => r.analisis)), [analizadas])

  // Para la curva hace falta el resultado de cada sesión con su fecha, del conjunto que
  // esté filtrado en ese momento
  const sesionesCurva = useMemo(
    () => analizadas
      .filter(({ analisis: a }) => a.valido && a.entrada)
      .map(({ sesion, analisis: a }) => ({ date: sesion.date, pts: a.resultadoTotalPts ?? a.resultadoPts })),
    [analizadas],
  )

  // Los filtros se acumulan: una sesión sale si cumple TODOS los que estén puestos, así que
  // "Sale en BE" + "Añade 3+" son los días en los que pasaron las dos cosas.
  const visibles = useMemo(
    () => analizadas.filter(({ analisis: a }) => pasaFiltros(a, filtros)),
    [analizadas, filtros],
  )

  // Lo que daría cada chip si lo añadieras a lo que ya está puesto, para no ir a ciegas: con
  // nada marcado es el total de cada condición, y los chips ya activos muestran lo que se ve.
  const cuentas = useMemo(() => Object.fromEntries(FILTROS.map(f => {
    const combinado = f.id === 'todas' ? new Set() : new Set([...filtros, f.id])
    return [f.id, analizadas.filter(({ analisis: a }) => pasaFiltros(a, combinado)).length]
  })), [analizadas, filtros])

  // "Todas" limpia; los demás se encienden y se apagan
  const alternarFiltro = id => {
    setFiltros(prev => {
      if (id === 'todas') return new Set()
      const s = new Set(prev)
      s.has(id) ? s.delete(id) : s.add(id)
      return s
    })
    setMostradas(POR_PAGINA)
  }

  const enVista = visibles.slice(0, mostradas)
  const quedan  = visibles.length - enVista.length
  // dependencia estable para el efecto que pide las velas de 5 min
  const fechasVista = enVista
    .filter(r => !(r.finasEtiqueta === '5m' && r.finas?.length))
    .map(r => r.sesion.date)
    .join(',')

  // Scroll infinito: cuando el final del mosaico se acerca a la pantalla se añade otra
  // tanda de tarjetas. El observador se queda en el centinela, que vive debajo del mosaico.
  useEffect(() => {
    const el = centinelaRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) setMostradas(n => Math.min(n + POR_PAGINA, visibles.length)) },
      { rootMargin: '800px' },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [visibles.length])

  // Los gráficos del mosaico se dibujan con velas de 5 min, pero solo se piden las de las
  // tarjetas que se están viendo: el histórico entero a 5 min son 37 MB, y seis sesiones
  // son 50 KB. El análisis sigue hecho sobre las de 15, que son las que definen el bracket.
  useEffect(() => {
    const faltan = fechasVista.split(',').filter(f => f && !pedidas5mRef.current.has(f))
    if (faltan.length === 0) return
    faltan.forEach(f => pedidas5mRef.current.add(f))
    let vivo = true
    ;(async () => {
      const nuevas = {}
      try {
        if (fuente === 'csv') {
          const q = new URLSearchParams({ finas: '1', dias: faltan.join(',') })
          const d = await (await fetch(`${API}/api/dax-historico?${q}`)).json()
          for (const ses of d.sesiones ?? []) if (ses.finas?.length) nuevas[ses.date] = ses.finas
        } else {
          for (const f of faltan) {
            const d = await (await fetch(intradayUrl(ticker, f, 'm5'))).json()
            if (d.velas?.length) nuevas[f] = d.velas
          }
        }
      } catch { /* si fallan, la tarjeta se queda con sus velas de 15 min */ }
      if (vivo && Object.keys(nuevas).length) setFinas5m(prev => ({ ...prev, ...nuevas }))
    })()
    return () => { vivo = false }
  }, [fechasVista, fuente, ticker])

  const tradesPara = fecha => trades.filter(t =>
    t.ticker === ticker && (fmtFechaTS(t.openTime) === fecha || fmtFechaTS(t.closeTime) === fecha)
  )

  return (
    <div className="estrategia-panel">
      <div className="filtro-controls">
        {estr.admiteCsv && <div className="filtro-group">
          <label className="filtro-label">
            Datos
            <span className="filtro-valor">
              {fuente === 'csv'
                ? 'CSV de DAX cash a 5 min, sin límite de peticiones'
                : 'del feed, unas pocas sesiones por tanda'}
            </span>
          </label>
          <div className="filtro-presets">
            <button className={`chip ${fuente === 'feed' ? 'activo' : ''}`} onClick={() => setFuente('feed')}>
              Feed (Dukascopy)
            </button>
            <button className={`chip ${fuente === 'csv' ? 'activo' : ''}`} onClick={() => { setFuente('csv'); setTicker('^GDAXI') }}>
              DAX 2009 → 2026
            </button>
          </div>
        </div>}

        {(fuente === 'csv' || estr.soloFomc) && (
          <div className="filtro-group">
            <label className="filtro-label">
              Años
              <span className="filtro-valor">
                {estr.soloFomc
                  ? `${FOMC.filter(f => Number(f.slice(0, 4)) >= anioDesde && Number(f.slice(0, 4)) <= anioHasta).length} reuniones del FOMC`
                  : 'DAX cash, sesión 09:00-17:30'}
              </span>
            </label>
            <div className="filtro-presets">
              <select className="filtro-otros" value={anioDesde} onChange={e => setAnioDesde(Number(e.target.value))}>
                {(estr.soloFomc ? ANIOS_FOMC : ANIOS_CSV).map(a => <option key={a} value={a}>desde {a}</option>)}
              </select>
              <select className="filtro-otros" value={anioHasta} onChange={e => setAnioHasta(Number(e.target.value))}>
                {(estr.soloFomc ? ANIOS_FOMC : ANIOS_CSV).map(a => <option key={a} value={a}>hasta {a}</option>)}
              </select>
            </div>
          </div>
        )}

        {fuente === 'feed' && (
          <div className="filtro-group">
            <label className="filtro-label">
              Instrumento
              {estr.soloFomc
                ? <span className="filtro-valor">la ventana la marca el comunicado, no la apertura</span>
                : sesion && <span className="filtro-valor">apertura {fmtMin(sesion.open)} · {sesion.plaza}</span>}
            </label>
            <div className="filtro-presets">
              {INSTRUMENTOS.map(i => (
                <button
                  key={i.value}
                  className={`chip ${ticker === i.value ? 'activo' : ''}`}
                  onClick={() => setTicker(i.value)}
                >{i.label}</button>
              ))}
            </div>
          </div>
        )}

        <div className="filtro-group">
          <label className="filtro-label">Días de la semana</label>
          <div className="filtro-dias">
            {DIAS.map(d => (
              <button
                key={d.n}
                title={d.nombre}
                className={`dia-chip ${dias.has(d.n) ? 'activo' : ''}`}
                onClick={() => toggleDia(d.n)}
              >{d.label}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            1ª vela de {estr.etiquetaVela}
            {vela1 !== 'todas' && (
              <span className="filtro-valor">{analizadas.length} de {resultados.length} sesiones</span>
            )}
          </label>
          <div className="filtro-presets">
            {VELAS1.map(v => (
              <button
                key={v.id}
                className={`chip ${vela1 === v.id ? 'activo' : ''}`}
                onClick={() => { setVela1(v.id); setMostradas(POR_PAGINA) }}
                title={v.dir ? `Solo las sesiones cuya primera vela cierra ${v.dir === 'alcista' ? 'por encima' : 'por debajo'} de su apertura` : 'Sin filtrar por el color de la primera vela'}
              >{v.label}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Operativa
            <span className="filtro-valor">{MODOS.find(m => m.id === modoEfectivo)?.nota}</span>
          </label>
          <div className="filtro-presets">
            {MODOS.map(m => {
              const sinFlip = m.id in SIN_FLIP && stopPct !== 1
              return (
                <button
                  key={m.id}
                  className={`chip ${modoEfectivo === m.id ? 'activo' : ''}`}
                  disabled={sinFlip}
                  onClick={() => { setModo(m.id); setMostradas(POR_PAGINA) }}
                  title={sinFlip ? 'Con el stop a media vela no hay vuelta: el nivel donde salta ya no es la entrada del lado contrario' : m.nota}
                >{m.label}</button>
              )
            })}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Volumen
            <span className="filtro-valor">{VOLUMENES.find(v => v.id === volumen)?.nota}</span>
          </label>
          <div className="filtro-presets">
            {VOLUMENES.map(v => (
              <button
                key={v.id}
                className={`chip ${volumen === v.id ? 'activo' : ''}`}
                onClick={() => { setVolumen(v.id); setMostradas(POR_PAGINA) }}
                title={v.nota}
              >{v.label}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Tamaño de los añadidos
            <span className="filtro-valor">{TAMANOS.find(t => t.id === tamano)?.nota}</span>
          </label>
          <div className="filtro-presets">
            {TAMANOS.map(t => (
              <button
                key={t.id}
                className={`chip ${tamano === t.id ? 'activo' : ''}`}
                onClick={() => { setTamano(t.id); setMostradas(POR_PAGINA) }}
                title={t.nota}
              >{t.label}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Nivel del stop
            <span className="filtro-valor">{NIVELES.find(n => n.id === nivelStop)?.nota}</span>
          </label>
          <div className="filtro-presets">
            {NIVELES.map(n => (
              <button
                key={n.id}
                className={`chip ${nivelStop === n.id ? 'activo' : ''}`}
                onClick={() => { setNivelStop(n.id); setMostradas(POR_PAGINA) }}
                title={n.nota}
              >{n.label}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Break even
            <span className="filtro-valor">{STOPS.find(s => s.id === stopModo)?.nota}</span>
          </label>
          <div className="filtro-presets">
            {STOPS.map(s => (
              <button
                key={s.id}
                className={`chip ${stopModo === s.id ? 'activo' : ''}`}
                onClick={() => { setStopModo(s.id); setMostradas(POR_PAGINA) }}
                title={s.nota}
              >{s.label}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Objetivo
            <span className="filtro-valor">
              {tpValor == null
                ? OBJETIVOS[0].nota
                : `cierra cuando la posición entera gana un ${tpValor.toLocaleString('es-ES')}% del índice`}
            </span>
          </label>
          <div className="filtro-presets">
            {OBJETIVOS.map(o => (
              <button
                key={o.id}
                className={`chip ${tpModo === o.id ? 'activo' : ''}`}
                onClick={() => { setTpModo(o.id); setMostradas(POR_PAGINA) }}
                title={o.nota ?? 'Cierra la posición en cuanto sus unidades suman ese porcentaje del índice'}
              >{o.label}</button>
            ))}
            {tpModo === 'pct' && (
              <span className="filtro-pct-campo">
                <input
                  className="pag-input filtro-pct"
                  type="number" min={0.1} max={20} step={0.1}
                  value={tpPct}
                  onChange={e => { setTpPct(e.target.value); setMostradas(POR_PAGINA) }}
                  title="Porcentaje del índice que recorre la posición antes de cerrarse"
                />
                % del índice
              </span>
            )}
          </div>
        </div>

        {fuente === 'feed' && !estr.soloFomc && <div className="filtro-group">
          <label className="filtro-label">Periodo</label>
          <div className="filtro-periodos">
            {PERIODOS.map(p => (
              <button
                key={p.meses}
                className={`periodo-chip ${meses === p.meses ? 'activo' : ''}`}
                onClick={() => setMeses(p.meses)}
              >{p.label}</button>
            ))}
          </div>
        </div>}

        {fuente === 'feed' && !estr.soloFomc && <div className="filtro-group">
          <label className="filtro-label">
            Sesiones a analizar
            <span className="filtro-valor">
              las {cantidad} más recientes del periodo · una descarga por sesión
            </span>
          </label>
          <div className="filtro-periodos">
            {CANTIDADES.map(c => (
              <button
                key={c}
                className={`periodo-chip ${cantidad === c ? 'activo' : ''}`}
                onClick={() => setCantidad(c)}
              >{c}</button>
            ))}
            {/* la `key` reinicia el campo cuando la cantidad cambia desde los botones */}
            <input
              key={cantidad}
              className="pag-input"
              type="number"
              min={1}
              max={2000}
              defaultValue={cantidad}
              title="Escribe cuántas sesiones quieres analizar y pulsa Enter"
              onFocus={e => e.target.select()}
              onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
              onBlur={e => {
                const n = Math.round(Number(e.target.value))
                if (!Number.isFinite(n) || n < 1) { e.target.value = cantidad; return }
                setCantidad(Math.min(n, 2000))
              }}
            />
          </div>
        </div>}

        <button className="btn-filtrar" onClick={analizar} disabled={cargando || dias.size === 0}>
          {cargando ? 'Analizando…' : 'Analizar sesiones'}
        </button>

        {cargando && (
          <div className="velas-cargando">
            <span className="spinner" />
            {progreso?.total
              ? `Descargando velas… ${progreso.done}/${progreso.total}`
              : 'Buscando sesiones…'}
            <button className="btn-cancelar-velas" onClick={cancelar}>✕ Cancelar</button>
          </div>
        )}
        {error && <div className="error-global">{error}</div>}
      </div>

      {resultados.length > 0 && (
        <>
          <Resumen r={resumen} />

          <CurvaEquity sesiones={sesionesCurva} />

          <div className="filtro-group">
            <label className="filtro-label">
              Gráficos
              <span className="filtro-valor">
                {visibles.length} de {resultados.length}
                {filtros.size > 1 && ` · ${filtros.size} filtros a la vez`}
              </span>
            </label>
            <div className="filtro-presets">
              {FILTROS.map(f => (
                <button
                  key={f.id}
                  className={`chip ${(f.id === 'todas' ? filtros.size === 0 : filtros.has(f.id)) ? 'activo' : ''}`}
                  onClick={() => alternarFiltro(f.id)}
                  title={`${f.nota} · ${cuentas[f.id]} sesion${cuentas[f.id] === 1 ? '' : 'es'}${filtros.size && f.id !== 'todas' ? ' con los filtros puestos' : ''}`}
                >{f.label} <span className="chip-cuenta">{cuentas[f.id]}</span></button>
              ))}
            </div>
          </div>

          {visibles.length === 0 ? (
            <div className="filtro-vacio">
              Ninguna sesión cumple {filtros.size > 1 ? 'todos estos filtros a la vez' : 'este filtro'}.
              {filtros.size > 0 && (
                <button className="pag-btn" onClick={() => alternarFiltro('todas')}>Quitar filtros</button>
              )}
            </div>
          ) : (
            <>
              <div className="multi-charts-grid">
                {enVista.map(({ sesion: s, analisis: a, velas, fuente, finas, finasEtiqueta }) => (
                  <SesionEstrategia
                    key={s.date}
                    sesion={s} analisis={a} velas={velas} fuente={fuente}
                    // las de 1 min del afinado no sirven aquí: el mosaico va en velas de 5
                    velasGrafico={finas5m[s.date] ?? (finasEtiqueta === '5m' ? finas : null)}
                    etiquetaVela={estr.etiquetaVela}
                    ticker={ticker} trades={tradesPara(s.date)}
                    pantallaCompleta={aPantalla === s.date}
                    onPantallaCompleta={() => setAPantalla(prev => (prev === s.date ? null : s.date))}
                  />
                ))}
              </div>
              {quedan > 0 && (
                <div className="paginacion" ref={centinelaRef}>
                  <button className="pag-btn" onClick={() => setMostradas(n => Math.min(n + POR_PAGINA, visibles.length))}>
                    Cargar {Math.min(POR_PAGINA, quedan)} más
                  </button>
                  <span className="pag-info">{enVista.length} de {visibles.length} sesiones</span>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

// Fila de cifras del conjunto. El valor va siempre en tinta normal: el color lo
// lleva la marca que acompaña a la etiqueta, para que nunca sea el único indicio.
function Resumen({ r }) {
  if (r.n === 0) return null
  const sobreOps = `sobre ${r.nOps} operaci${r.nOps === 1 ? 'ón' : 'ones'}`
  // El lado ya no es siempre comprador: los textos hablan de operaciones y de roturas
  const lados = r.nCortos > 0 ? `${r.nOps - r.nCortos} largas · ${r.nCortos} cortas` : `${r.nOps} de ${r.n} rompen el bracket`
  const tiles = [
    { label: 'Sesiones analizadas',   valor: r.n,                  sub: r.descartadas > 0 ? `${r.descartadas} sin datos de 15 min` : 'todas con datos' },
    { label: 'Días con operación',    valor: fmtPct(r.pctEntrada), sub: lados },
    { label: 'Operaciones ganadoras', valor: fmtPct(r.pctGanadas), sub: sobreOps, marca: '▲', tono: 'verde' },
    { label: 'Resultado medio',       valor: fmtPtsSgn(r.resultadoMedPts), sub: 'por sesión operada' },
    { label: 'Acumulado',             valor: fmtPtsSgn(r.totalPts), sub: sobreOps },
    {
      label: 'Profit factor',
      // sin ninguna pérdida la división no existe: se pinta como infinito
      valor: r.nOps === 0 ? '—' : r.profitFactor == null ? '∞' : r.profitFactor.toFixed(2),
      sub:   `${fmtSgn(r.ganadoPts)} ganados / ${fmtSgn(-r.perdidoPts)} perdidos`,
      marca: r.profitFactor != null && r.profitFactor < 1 ? '▼' : '▲',
      tono:  r.profitFactor != null && r.profitFactor < 1 ? 'rojo' : 'verde',
    },
    { label: 'Salta el stop',         valor: fmtPct(r.pctVenta),   sub: r.pctBE ? `${fmtPct(r.pctBE)} sale en break even` : 'el resto cierra con la sesión', marca: '▼', tono: 'rojo' },
    { label: 'Recorrido máximo',      valor: fmtPtsSgn(r.mfeMedPts), sub: 'mediana a favor antes de cerrar' },
    { label: 'Doblan el bracket',     valor: fmtPct(r.pct2R),      sub: 'recorren 2 veces su rango' },
  ]
  if (r.pctObjetivo) tiles.push({
    label: 'Cierran en el objetivo', valor: fmtPct(r.pctObjetivo),
    sub: sobreOps, marca: '▲', tono: 'verde',
  })
  return (
    <div className="estr-resumen">
      <div className="estr-tiles">
        {tiles.map(t => (
          <div key={t.label} className="estr-tile">
            <span className="estr-tile-label">
              {t.marca && <span className={`estr-marca ${t.tono}`}>{t.marca}</span>}
              {t.label}
            </span>
            <span className="estr-tile-valor">{t.valor}</span>
            <span className="estr-tile-sub">{t.sub}</span>
          </div>
        ))}
      </div>
      <p className="estr-nota">
        Bracket mediano <strong>{fmtPts(r.rangoMedPts)} pts</strong>
        {r.rangoMedPct != null && <> ({r.rangoMedPct.toFixed(2)}%)</>}
        {r.minutosMed != null && <> · la entrada salta a los <strong>{r.minutosMed} min</strong> de la apertura</>}
        {r.nFlips > 0 && <> · <strong>{r.nFlips}</strong> sesion{r.nFlips === 1 ? '' : 'es'} con vuelta de posición</>}
        . Los resultados van en puntos del instrumento: cerrar en el extremo contrario del
        bracket cuesta exactamente su rango. Si una vela rompe los dos extremos a la vez,
        se lee como entrada larga con el stop saltando en esa misma vela.
      </p>
    </div>
  )
}

function SesionEstrategia({ sesion: s, analisis: a, velas, velasGrafico, etiquetaVela, fuente, ticker, trades, pantallaCompleta, onPantallaCompleta }) {
  // el tamaño de vela es de cada gráfico: unas sesiones se leen mejor finas y otras enteras
  const [tf, setTf] = useState('5m')
  // Esc cierra la pantalla completa, igual que en el gráfico de Operaciones
  useEffect(() => {
    if (!pantallaCompleta) return
    const alPulsar = e => { if (e.key === 'Escape') onPantallaCompleta?.() }
    window.addEventListener('keydown', alPulsar)
    return () => window.removeEventListener('keydown', alPulsar)
  }, [pantallaCompleta, onPantallaCompleta])

  // la ventana de la estrategia: la sesión del instrumento, o la del comunicado del FOMC
  const ses  = a.ventana ?? SESIONES[ticker]
  // en 5 min en cuanto llegan; hasta entonces, y si se pide, las velas del análisis
  const finasListas  = tf === '5m' && velasGrafico?.length > 0
  const velasChart   = finasListas ? velasGrafico : velas
  const minutosChart = finasListas ? 5 : (a.minutosVela ?? 15)
  const hora = ts => new Date(ts * 1000).toLocaleTimeString('es-ES', {
    timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit',
  })

  return (
    <div className={`multi-chart-item estr-card ${pantallaCompleta ? 'pantalla-completa' : ''}`}>
      <div className="estr-card-head">
        <span className="estr-card-fecha">
          <span className="sesion-card-dia">{DIA_CORTO[s.dayOfWeek]}</span> {s.date}
        </span>
        <div className="estr-badges">
          {!a.valido && <span className="estr-badge neutro">{a.motivo}</span>}
          {a.valido && !a.entrada && <span className="estr-badge neutro">Sin entrada</span>}
          {a.entrada && (
            <>
              <span className={`estr-badge ${a.lado === 'largo' ? 'verde' : 'rojo'}`}>
                {a.lado === 'largo' ? 'Compra' : 'Venta'}
              </span>
              <span className={`estr-badge ${a.resultado === 'ganada' ? 'verde' : 'rojo'}`}>
                {a.resultado === 'ganada' ? 'Ganada' : 'Perdida'} {fmtPtsSgn(a.resultadoTotalPts ?? a.resultadoPts)}
              </span>
              {a.piernas?.length > 0 && (
                <span className="estr-badge neutro">
                  {a.piernas.length === 1
                    ? `Flip a ${a.piernas[0].lado} ${fmtPtsSgn(a.piernas[0].resultadoPts)}`
                    : `${a.piernas.length} vueltas`}
                </span>
              )}
              <span className="estr-badge neutro">
                {a.salida.motivo === 'bracket'   ? 'Salta el stop en el bracket'
                  : a.salida.motivo === 'breakeven' ? 'Sale en break even'
                  : a.salida.motivo === 'objetivo'  ? 'Cierra en el objetivo'
                  : 'Cierra con la sesión'}
              </span>
            </>
          )}
          {a.resolucion && a.resolucion !== '15m' && (
            <span className="estr-badge neutro">Leída con velas de {a.resolucion}</span>
          )}
          {a.ambigua && (
            <span className="estr-badge rojo" title="Una vela toca los dos extremos y no hay datos más finos para saber cuál se rompió antes">
              Orden sin resolver
            </span>
          )}
          {a.parcial && <span className="estr-badge neutro">Sesión en curso</span>}
        </div>
        <div className="estr-tf">
          {TIMEFRAMES.map(t => (
            <button
              key={t.id}
              className={`chip ${tf === t.id ? 'activo' : ''}`}
              onClick={() => setTf(t.id)}
              title={`Dibujar esta sesión con velas de ${t.label ?? etiquetaVela}. El análisis no cambia: el bracket sale siempre de las de ${etiquetaVela}`}
            >{t.label ?? etiquetaVela}</button>
          ))}
        </div>
      </div>

      {a.valido && (
        <div className="estr-metricas">
          <span>Bracket <strong>{fmtPts(a.rango)}</strong> ({a.rangoPct.toFixed(2)}%) · vela de {a.minutosVela ?? 15} min</span>

          <span>1ª vela <strong>{a.dir1 === 'alcista' ? 'blanca' : 'negra'}</strong></span>
          {(a.nBracket ?? 2) > 1 && <span>{a.nBracket}ª vela <strong>{a.dir2}</strong></span>}
          {a.entrada ? (
            <>
              <span>{a.lado === 'largo' ? 'Compra' : 'Venta'} <strong>{fmtPts(a.entrada.precio)}</strong> a las {hora(a.entrada.time)} (+{a.entrada.minutos} min)</span>
              <span>Cierre <strong>{fmtPts(a.salida.precio)}</strong> a las {hora(a.salida.time)}</span>
              <span>Recorrido máx. <strong>{fmtPtsSgn(a.mfePts)}</strong></span>
              {a.objetivo != null && (
                <span>
                  Objetivo <strong>{fmtPtsSgn(a.objetivo)}</strong> sumando todas las unidades
                  {' '}({(a.objetivo / a.entrada.precio * 100).toLocaleString('es-ES', { maximumFractionDigits: 2 })}% del índice)
                </span>
              )}
              {a.unidades > 1 && (
                <span>
                  Posición <strong>{fmtPts(a.volumen ?? a.unidades)} unidades</strong>
                  {(a.tamanoAnadido ?? 1) !== 1 && ` (1 + ${a.unidades - 1} de ${fmtPts(a.tamanoAnadido)})`}
                  : añade en {a.anadidos.map(x => fmtPts(x.precio)).join(' · ')} (stop al precio medio)
                </span>
              )}
              {a.piernas?.map((p, i) => (
                <span key={i}>
                  Vuelta {i + 1}: {p.lado === 'largo' ? 'compra' : 'venta'} <strong>{fmtPts(p.entrada.precio)}</strong> a las {hora(p.entrada.time)} y cierra en <strong>{fmtPts(p.salida.precio)}</strong> ({fmtPtsSgn(p.resultadoPts)})
                </span>
              ))}
            </>
          ) : (
            <span>El precio no supera el máximo del bracket{a.tocaAbajoAntes && ', y sí pierde el mínimo'}</span>
          )}
        </div>
      )}

      {velasChart.length > 0 ? (
        <GraficoVelas
          velas={velasChart}
          patrones={[]}
          ticker={ticker}
          prevClose={s.prevClose}
          trades={trades}
          alto={pantallaCompleta ? Math.max(360, window.innerHeight - 190) : undefined}
          pantallaCompleta={pantallaCompleta}
          onPantallaCompleta={onPantallaCompleta}
          rango={a.valido ? { vela: a.velaBracket, high: a.high, low: a.low, etiqueta: `${a.nBracket ?? 2}ª vela` } : undefined}
          operacion={a.entrada ? {
            entrada: a.entrada,
            salida:  a.salida,
            lado:    a.lado,
            ganada:  a.resultadoR > 0,
            anadidos: a.anadidos,
            vueltas: a.piernas?.map(p => ({
              entrada: p.entrada, salida: p.salida, lado: p.lado,
              ganada: p.resultadoR > 0, anadidos: p.anadidos,
            })),
          } : undefined}
        />
      ) : (
        <div className="filtro-vacio">Sin velas para {s.date}</div>
      )}

      <div className="estr-card-pie">
        {ses && `${ses.etiqueta ?? 'Sesión'} ${fmtMin(ses.open)}–${fmtMin(ses.close)} (hora Madrid) · velas de ${minutosChart} min`}
        {fuente && (
          <span className={`fuente-tag ${fuente.startsWith('Duka') ? 'dukascopy' : fuente.startsWith('Stooq') ? 'stooq' : 'yahoo'}`}>
            {fuente}
          </span>
        )}
      </div>
    </div>
  )
}
