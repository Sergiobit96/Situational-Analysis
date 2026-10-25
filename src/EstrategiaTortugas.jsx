import { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, AreaSeries, HistogramSeries, PriceScaleMode, CrosshairMode } from 'lightweight-charts'
import { madridOffsetAt } from './timezone'
import {
  INDICES_TORTUGAS, TICKER_TIPO, CONFIG_TORTUGAS, prepararMercado, prepararColumnas, backtestTortugas,
  metricasTortugas, curvaConDrawdown, rentabilidadAnual, resumenPorIndice, resumenPorGrupo, porUnidades, ordenesManana, peorHastaStops, sistemasDe,
  picoPiramide, riesgoPorN, expedienteBacktest,
} from './tortugas'
import { prepararAccion, decodificarColumnas, COMISION_ACCIONES_EEUU } from './accionesEeuu'
import { Bloque, AjustesPuestos, BarraAnalizar } from './AjustesEstrategia'
import RevisionBacktest from './RevisionBacktest'
import './Tortugas.css'
import Robustez from './Robustez'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'

// ── Datos ───────────────────────────────────────────────────────────────────
// El diario de Yahoo del contado, por el mismo endpoint que el Gráfico, en páginas de diez
// años hacia atrás. Se guarda en el módulo y no en el componente: la pestaña se vuelve a
// montar al pasar del sistema 1 al 2 y no hace falta bajar otra vez 35 años de cada índice.
const cacheDiario = new Map()       // ticker → { velas, cuando }
const VIGENCIA_MS = 4 * 3600_000
const PRIMER_DIA  = Date.UTC(1988, 0, 1) / 1000   // un año de margen antes de 1990
const PAGINA_S    = 3650 * 86400                  // lo que trae cada página del endpoint

const fechaMadrid = ts => new Date((ts + madridOffsetAt(ts)) * 1000).toISOString().slice(0, 10)

// Fecha y minuto de ahora en la zona de una bolsa
function relojDe(zona) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date()).map(x => [x.type, x.value]))
  return { fecha: `${p.year}-${p.month}-${p.day}`, minutos: (Number(p.hour) % 24) * 60 + Number(p.minute) }
}

// Yahoo da la vela del día en curso a medio hacer: fuera, hasta 20 min después del cierre
function sinSesionEnCurso(info, velas) {
  const { fecha, minutos } = relojDe(info.zona)
  const [hh, mm] = info.cierre.split(':').map(Number)
  const ultima = velas.at(-1)
  return ultima && ultima.date >= fecha && minutos < hh * 60 + mm + 20 ? velas.slice(0, -1) : velas
}

// Con dos reintentos: mientras Railway cambia de despliegue, su proxy contesta a algunas
// peticiones sin cabeceras CORS (el navegador lo ve como fallo de red) o con un 5xx
async function pedirJson(url, signal) {
  for (let intento = 0; ; intento++) {
    try {
      const r = await fetch(url, { signal })
      const j = await r.json().catch(() => ({}))
      if (r.ok) return j
      if (r.status < 500 || intento >= 2) throw new Error(j.error ?? `HTTP ${r.status}`)
    } catch (e) {
      if (e.name === 'AbortError' || !(e instanceof TypeError) || intento >= 2) throw e
    }
    await new Promise(listo => setTimeout(listo, 1500 * (intento + 1)))
  }
}

async function bajarDiario(ticker, signal) {
  const visto = cacheDiario.get(ticker)
  if (visto && Date.now() - visto.cuando < VIGENCIA_MS) return visto.velas
  const paginas = []
  let hasta = Math.floor(Date.now() / 1000)
  for (let k = 0; k < 6 && hasta > PRIMER_DIA; k++) {
    let j
    try {
      j = await pedirJson(`${API}/api/grafico/velas?ticker=${encodeURIComponent(ticker)}&tf=d1&fuente=yahoo&hasta=${hasta}`, signal)
    } catch (e) {
      if (e.name === 'AbortError') throw e
      throw new Error(`${ticker}: ${e.message}`, { cause: e })
    }
    if (!j.velas?.length) break
    paginas.unshift(j.velas)
    const primera = j.velas[0].time
    // si la serie empieza dentro de la página, no hay nada más atrás
    if (!j.hayMas || primera > hasta - PAGINA_S + 30 * 86400) break
    hasta = primera
  }
  const porFecha = new Map()
  for (const v of paginas.flat()) {
    porFecha.set(fechaMadrid(v.time), { date: fechaMadrid(v.time), open: v.open, high: v.high, low: v.low, close: v.close })
  }
  const velas = [...porFecha.values()].sort((a, b) => a.date.localeCompare(b.date))
  cacheDiario.set(ticker, { velas, cuando: Date.now() })
  return velas
}

// Los mismos diarios desde los CSV de Documents\Yahoo\diario (recoger_yahoo.py), de una petición
// por índice: <ID>_1d.csv con el id de INDICES_TORTUGAS, e IRX para el tipo
const cacheDiarioCsv = new Map()    // ticker → { velas, cuando }
const ID_CSV = { ...Object.fromEntries(INDICES_TORTUGAS.map(i => [i.ticker, i.id])), [TICKER_TIPO]: 'IRX' }
async function bajarDiarioCsv(ticker, signal) {
  const visto = cacheDiarioCsv.get(ticker)
  if (visto && Date.now() - visto.cuando < VIGENCIA_MS) return visto.velas
  let j
  try {
    j = await pedirJson(`${API}/api/yahoo-csv/diario/${ID_CSV[ticker]}`, signal)
  } catch (e) {
    if (e.name === 'AbortError') throw e
    throw new Error(`${ticker}: ${e.message}`, { cause: e })
  }
  cacheDiarioCsv.set(ticker, { velas: j.velas, cuando: Date.now() })
  return j.velas
}
const csvEnCache = () => Object.fromEntries(
  [...cacheDiarioCsv].filter(([, v]) => Date.now() - v.cuando < VIGENCIA_MS).map(([t, v]) => [t, v.velas]),
)

// Los diarios de Stooq de Documents\Stooq (/api/stooq/diario): seis índices. El Nasdaq es el NDX
// de contado desde 1986, como el de Yahoo; los otros cinco, desde 2013, son cotizaciones de casi
// 24 h tipo CFD, con el hueco de la noche entre el cierre y la apertura. Stooq no trae el tipo: el
// IRX sale de Yahoo en línea.
const IDS_STOOQ = ['N225', 'DAX', 'FTSE', 'SPX', 'DJI', 'NDX']
const ANIO_STOOQ = 2014   // el primer año entero con los seis, con margen para los canales de 55
const cacheDiarioStooq = new Map()  // ticker → { velas, cuando }
async function bajarDiarioStooq(ticker, signal) {
  if (ticker === TICKER_TIPO) return bajarDiario(ticker, signal)
  const visto = cacheDiarioStooq.get(ticker)
  if (visto && Date.now() - visto.cuando < VIGENCIA_MS) return visto.velas
  let j
  try {
    j = await pedirJson(`${API}/api/stooq/diario/${ID_CSV[ticker]}`, signal)
  } catch (e) {
    if (e.name === 'AbortError') throw e
    throw new Error(`${ticker}: ${e.message}`, { cause: e })
  }
  cacheDiarioStooq.set(ticker, { velas: j.velas, cuando: Date.now() })
  return j.velas
}
const stooqEnCache = () => Object.fromEntries([
  ...[...cacheDiarioStooq].filter(([, v]) => Date.now() - v.cuando < VIGENCIA_MS).map(([t, v]) => [t, v.velas]),
  ...(cacheDiario.has(TICKER_TIPO) && Date.now() - cacheDiario.get(TICKER_TIPO).cuando < VIGENCIA_MS ? [[TICKER_TIPO, cacheDiario.get(TICKER_TIPO).velas]] : []),
])

const datosEnCache = () => Object.fromEntries(
  [...cacheDiario].filter(([, v]) => Date.now() - v.cuando < VIGENCIA_MS).map(([t, v]) => [t, v.velas]),
)

// Las acciones del S&P 500: la lista (con sector y fecha de entrada en el índice) y el diario
// de cada una, que el servidor baja de Yahoo y guarda hasta el siguiente cierre. Van por
// tandas de 40, dos a la vez, y cada tanda se prepara para el motor nada más llegar (son
// millones de velas: no se guardan ni las velas ni lo que manda el servidor). `completas`: con
// toda su historia; si no, solo desde un año antes de entrar en el índice, que es lo que hace
// falta para operar desde que entró.
let cacheAcciones = null            // { universo, mercados: { ticker: serie del motor }, completas, cuando }
const TANDA_ACCIONES = 40
const accionesEnCache = () => (cacheAcciones && Date.now() - cacheAcciones.cuando < VIGENCIA_MS ? cacheAcciones : null)

async function bajarAcciones({ completas, signal, alAvanzar }) {
  const universo = await pedirJson(`${API}/api/tortugas/acciones/universo`, signal)
  const tickers = universo.acciones.map(a => a.ticker)
  const tandas = []
  for (let k = 0; k < tickers.length; k += TANDA_ACCIONES) tandas.push(tickers.slice(k, k + TANDA_ACCIONES))
  const porTicker = new Map(universo.acciones.map(a => [a.ticker, a]))
  const mercados = {}, fallos = [], avisos = []
  let siguiente = 0, hechas = 0
  const trabajador = async () => {
    while (siguiente < tandas.length && !signal.aborted) {
      const tanda = tandas[siguiente++]
      const j = await pedirJson(`${API}/api/tortugas/acciones?tickers=${tanda.map(encodeURIComponent).join(',')}&desde=${PRIMER_ANIO}-01-01&alta=${completas ? 0 : 1}`, signal)
      for (const s of j.series) if (s.p.length) mercados[s.ticker] = prepararAccion(porTicker.get(s.ticker), s)
      fallos.push(...j.fallos.map(f => `${f.ticker} (${f.error})`))
      avisos.push(...j.avisos)
      hechas += tanda.length
      alAvanzar(hechas, tickers.length)
    }
  }
  await Promise.all([trabajador(), trabajador()])
  if (signal.aborted) throw new DOMException('Cancelado', 'AbortError')
  cacheAcciones = { universo, mercados, completas, cuando: Date.now() }
  return { datos: cacheAcciones, fallos, avisos }
}

// Los mercados de las tortugas de 1983 (server/futuros-tortugas.js): los 19 de una vez, ya
// empalmados en el servidor, y preparados para el motor al llegar
let cacheFuturos = null             // { lista, mercados: { id: serie del motor }, cuando }
const futurosEnCache = () => (cacheFuturos && Date.now() - cacheFuturos.cuando < VIGENCIA_MS ? cacheFuturos : null)
const PRIMER_ANIO_FUTUROS = 2000
// los futuros no pagan financiación de CFD ni comisión por acción: el coste es el deslizamiento
// en contratos enteros: `lote` es lo que vale un punto en uno (en dólares, que se toman por euros)
// el tamaño de una unidad para leer: en futuros, contratos (y si no llega a uno, se dice); en
// acciones, acciones; en índices, € por punto
const contratosTexto = c => (c > 0 ? `${c.toLocaleString('es-ES')} contrato${c === 1 ? '' : 's'}` : 'no llega a 1 contrato')
const infoFuturo = m => ({ id: m.id, ticker: m.simbolo, nombre: m.nombre, original: m.original, grupo: m.grupo, zona: 'America/New_York', cierre: '17:00', desde: '1900-01-01', spread: 0, dividendo: 0, ...(m.punto ? { lote: m.punto, contratos: true } : {}) })

async function bajarFuturos(signal) {
  const j = await pedirJson(`${API}/api/tortugas/futuros?desde=${PRIMER_ANIO_FUTUROS}-01-01`, signal)
  const porId = new Map(j.mercados.map(m => [m.id, m]))
  const mercados = {}
  for (const s of j.series) if (s.p.length) mercados[s.id] = prepararColumnas(infoFuturo(porId.get(s.id)), decodificarColumnas(s))
  cacheFuturos = { lista: j.mercados, mercados, cuando: Date.now() }
  return { datos: cacheFuturos, fallos: j.fallos.map(f => `${porId.get(f.id)?.nombre ?? f.id} (${f.error})`), avisos: j.avisos }
}

// ── Ajustes ─────────────────────────────────────────────────────────────────

const AJUSTES_INICIALES = {
  indices: INDICES_TORTUGAS.map(i => i.id),
  fuenteDiario: 'yahoo',   // de dónde salen los diarios de los índices: 'yahoo' (en línea), 'csv' (Documentos) o 'stooq'
  lados: CONFIG_TORTUGAS.lados,
  riesgo: 100 * CONFIG_TORTUGAS.riesgo,
  anadido: CONFIG_TORTUGAS.anadido,
  maxUnidades: CONFIG_TORTUGAS.maxUnidades,
  maxGrupo: CONFIG_TORTUGAS.maxGrupo,
  maxSentido: CONFIG_TORTUGAS.maxSentido,
  desde: 1990,
  deslizN: CONFIG_TORTUGAS.deslizN,
  recargo: 100 * CONFIG_TORTUGAS.recargo,
  financiacion: true,
  media: 0,
  reduccionDD: true,
  capital: 20_000,
}
// En acciones, cada una con sus propios ajustes: con 500 mercados, los límites de los índices
// (15 unidades por sentido) se llenan con las primeras rupturas de una unidad y la pirámide no
// llega a crecer nunca. Por defecto, una unidad pequeña (0,1 % por N) y límites que dejan unas 50 abiertas.
const AJUSTES_ACCIONES = {
  ...AJUSTES_INICIALES,
  riesgo: 0.5,
  maxGrupo: 15,
  maxSentido: 50,
  sectoresFuera: [],
  soloEnIndice: CONFIG_TORTUGAS.soloEnIndice,
  comisiones: CONFIG_TORTUGAS.comisiones,
}
// Los mercados de las tortugas, con sus reglas: 1 % por N y unidad (un 5 % la pirámide llena), 4 unidades por mercado, 6 por
// grupo muy correlacionado y 12 por sentido, largos y cortos. Sin financiación: en un futuro, lo
// que cuesta mantenerlo ya va en el precio al empalmar un contrato con el siguiente.
const AJUSTES_FUTUROS = {
  ...AJUSTES_INICIALES,
  mercadosFuera: [],
  lados: 'ambos',
  riesgo: 5,
  maxUnidades: 4,
  maxGrupo: 6,
  maxSentido: 12,
  financiacion: false,
  desde: 2001,
}
const UNIVERSOS = {
  indices:  { clave: 'sa.tortugas', iniciales: AJUSTES_INICIALES },
  acciones: { clave: 'sa.tortugas.acciones', iniciales: AJUSTES_ACCIONES },
  futuros:  { clave: 'sa.tortugas.futuros', iniciales: AJUSTES_FUTUROS },
}
const CLAVE_UNIVERSO = 'sa.tortugas.universo'
const PRIMER_ANIO = 1990

function leerAjustes(universo) {
  const { clave, iniciales } = UNIVERSOS[universo]
  try {
    const guardados = JSON.parse(localStorage.getItem(clave) ?? 'null')
    // Los de cuando el riesgo era lo que cuesta 1 N por unidad (no traen `anadido`): se pasa a lo
    // que pierde la pirámide llena, que es el mismo tamaño de unidad
    if (guardados && guardados.anadido == null && guardados.riesgo != null) {
      const maxUnidades = guardados.maxUnidades ?? iniciales.maxUnidades
      guardados.riesgo = Math.round(100 * guardados.riesgo * picoPiramide(maxUnidades)) / 100
    }
    return guardados ? { ...iniciales, ...guardados } : iniciales
  } catch {
    return iniciales
  }
}
function leerUniverso() {
  try {
    const u = localStorage.getItem(CLAVE_UNIVERSO)
    return UNIVERSOS[u] ? u : 'indices'
  } catch { return 'indices' }
}

const LADOS = [
  { v: 'largos', label: 'Solo largos', nota: 'En índices los cortos pagan el dividendo y la financiación y van contra la deriva alcista' },
  { v: 'ambos', label: 'Largos y cortos', nota: 'Simétrico, como las tortugas originales' },
  { v: 'cortos', label: 'Solo cortos', nota: 'Solo las rupturas a la baja' },
]
const RIESGOS = [0.5, 1, 1.5, 2.5, 5]
const RIESGOS_ACCIONES = [0.1, 0.25, 0.5, 1, 2.5]
const ANADIDOS = [
  { v: 1, label: '1 unidad', nota: 'Como las tortugas: cada añadido, del tamaño de la entrada' },
  { v: 0.5, label: '½ unidad', nota: 'Cada añadido, de media unidad: con el mismo riesgo máximo, la unidad sale más grande' },
]
const UNIDADES = [1, 4, 6, 7]
const DESLICES = [0, 0.02, 0.05, 0.1]
const RECARGOS = [2.5, 3.5]
const ANIOS = Array.from({ length: 2024 - 1990 + 1 }, (_, k) => 1990 + k)

// ── Formato ─────────────────────────────────────────────────────────────────

const nf = (v, dec = 0) => Number.isFinite(v)
  ? v.toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec }) : '—'
const sgn = (v, dec = 1) => Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${nf(Math.abs(v), dec)}` : '—'
const eur = (v, dec = 0) => Number.isFinite(v) ? `${v < 0 ? '−' : ''}${nf(Math.abs(v), dec)} €` : '—'
const pct = (v, dec = 1) => Number.isFinite(v) ? `${sgn(v, dec)} %` : '—'
const dia = f => f ? f.split('-').reverse().join('/') : '—'
// un precio con los decimales que pide su tamaño (las acciones ajustadas por splits valían
// céntimos; el yen va en milésimas de dólar)
const nfp = v => nf(v, Math.abs(v) >= 100 ? 1 : Math.abs(v) >= 1 ? 2 : Math.abs(v) >= 0.01 ? 4 : 6)
const tono = v => v > 0 ? 'positivo' : v < 0 ? 'negativo' : ''
const nombreSistema = s => (s === '1+2' ? 'S1 + S2' : `S${s}`)

function Chips({ opciones, valor, onCambio }) {
  return opciones.map(o => (
    <button key={String(o.v)} className={`chip ${valor === o.v ? 'activo' : ''}`} title={o.nota} onClick={() => onCambio(o.v)}>
      {o.label}
    </button>
  ))
}

// Campo numérico que solo aplica al salir o con Enter; la `key` lo reinicia cuando el valor
// cambia desde los botones
function Numero({ valor, onCambio, min, max, step = 1, titulo, ancho = false }) {
  return (
    <input
      key={valor}
      className={`pag-input filtro-pct ${ancho ? 'tortugas-numero-ancho' : ''}`}
      type="number" min={min} max={max} step={step} defaultValue={valor} title={titulo}
      onFocus={e => e.target.select()}
      onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
      onBlur={e => {
        const n = Number(e.target.value)
        if (!Number.isFinite(n) || n < min || n > max) { e.target.value = valor; return }
        onCambio(n)
      }}
    />
  )
}

// ── Panel ───────────────────────────────────────────────────────────────────

export default function EstrategiaTortugas({ estrategiaId }) {
  const sistema = estrategiaId === 'tortugas-2' ? 2 : estrategiaId === 'tortugas-12' ? '1+2' : 1
  const juntos = sistema === '1+2'
  const [universo, setUniverso] = useState(leerUniverso)
  const acciones = universo === 'acciones'
  const futuros = universo === 'futuros'
  const [todosAjustes, setTodosAjustes] = useState(() => Object.fromEntries(Object.keys(UNIVERSOS).map(u => [u, leerAjustes(u)])))
  const ajustes = todosAjustes[universo]
  const setAjustes = f => setTodosAjustes(t => ({ ...t, [universo]: f(t[universo]) }))
  const [datos, setDatos] = useState(datosEnCache)
  const [datosCsv, setDatosCsv] = useState(csvEnCache)
  const [datosStooq, setDatosStooq] = useState(stooqEnCache)
  const [fuentes, setFuentes] = useState(null)          // Yahoo frente a Stooq: { clave, filas, desde, indices }
  const [comparandoFuentes, setComparandoFuentes] = useState(false)
  const [datosAcciones, setDatosAcciones] = useState(accionesEnCache)
  const [datosFuturos, setDatosFuturos] = useState(futurosEnCache)
  const [cargando, setCargando] = useState(false)
  const [progreso, setProgreso] = useState(null)
  const [error, setError] = useState(null)
  const [variantes, setVariantes] = useState(null)
  const [comparando, setComparando] = useState(false)
  const [mostradas, setMostradas] = useState(25)
  const abortRef = useRef(null)
  const filtrosRef = useRef(null)

  useEffect(() => () => abortRef.current?.abort(), [])
  useEffect(() => {
    try {
      for (const [u, a] of Object.entries(todosAjustes)) localStorage.setItem(UNIVERSOS[u].clave, JSON.stringify(a))
      localStorage.setItem(CLAVE_UNIVERSO, universo)
    } catch { /* sin almacenamiento */ }
  }, [todosAjustes, universo])

  const poner = (campo, valor) => setAjustes(a => ({ ...a, [campo]: valor }))
  const alternarIndice = id => setAjustes(a => {
    const s = new Set(a.indices)
    if (s.has(id)) { if (s.size > 1) s.delete(id) } else s.add(id)
    return { ...a, indices: INDICES_TORTUGAS.map(i => i.id).filter(x => s.has(x)) }
  })
  const lista = useMemo(() => datosAcciones?.universo?.acciones ?? [], [datosAcciones])
  const sectores = useMemo(() => [...new Set(lista.map(a => a.sector))].sort((a, b) => a.localeCompare(b, 'es')), [lista])
  const alternarSector = sector => setAjustes(a => {
    const fuera = new Set(a.sectoresFuera)
    if (fuera.has(sector)) fuera.delete(sector)
    else if (sectores.filter(s => !fuera.has(s)).length > 1) fuera.add(sector)
    return { ...a, sectoresFuera: [...fuera] }
  })
  const listaFuturos = useMemo(() => datosFuturos?.lista ?? [], [datosFuturos])
  const alternarMercado = id => setAjustes(a => {
    const fuera = new Set(a.mercadosFuera)
    if (fuera.has(id)) fuera.delete(id)
    else if (listaFuturos.filter(x => !fuera.has(x.id)).length > 1) fuera.add(id)
    return { ...a, mercadosFuera: [...fuera] }
  })
  const cambiarUniverso = u => {
    if (u === universo) return
    abortRef.current?.abort()
    setCargando(false)
    setProgreso(null)
    setError(null)
    setVariantes(null)
    setMostradas(25)
    setUniverso(u)
  }

  const cfg = useMemo(() => ({
    ...CONFIG_TORTUGAS,
    sistema,
    lados: ajustes.lados,
    riesgo: ajustes.riesgo / 100,
    anadido: ajustes.anadido,
    maxUnidades: ajustes.maxUnidades,
    maxGrupo: ajustes.maxGrupo,
    maxSentido: ajustes.maxSentido,
    desde: `${ajustes.desde}-01-01`,
    deslizN: ajustes.deslizN,
    recargo: ajustes.recargo / 100,
    financiacion: ajustes.financiacion,
    media: ajustes.media,
    reduccionDD: ajustes.reduccionDD,
    capital: ajustes.capital,
    soloEnIndice: ajustes.soloEnIndice ?? CONFIG_TORTUGAS.soloEnIndice,
    comisiones: ajustes.comisiones ?? CONFIG_TORTUGAS.comisiones,
    // en futuros, sin tope de nominal: las letras, con su N diminuta, llevan un nominal enorme,
    // como el eurodólar de las tortugas (un millón de dólares por contrato)
    apalancamiento: universo === 'futuros' ? 0 : CONFIG_TORTUGAS.apalancamiento,
  }), [ajustes, sistema, universo])
  // en índices, los diarios pueden salir de los CSV de Documentos en vez de Yahoo en línea
  const deCsv = universo === 'indices' && ajustes.fuenteDiario === 'csv'
  const deStooq = universo === 'indices' && ajustes.fuenteDiario === 'stooq'
  const diarios = deStooq ? datosStooq : deCsv ? datosCsv : datos
  // Stooq no tiene el Hang Seng ni el Russell: con Stooq se prueba con los otros que estén elegidos
  const indicesUsados = useMemo(() => (deStooq ? ajustes.indices.filter(id => IDS_STOOQ.includes(id)) : ajustes.indices), [deStooq, ajustes.indices])
  const claveCfg = JSON.stringify([universo, cfg, ajustes.indices, ajustes.sectoresFuera, ajustes.mercadosFuera, ajustes.fuenteDiario])

  // los indicadores solo dependen de los datos: se calculan una vez por índice
  const preparados = useMemo(() => {
    const r = {}
    for (const info of INDICES_TORTUGAS) {
      if (diarios[info.ticker]) r[info.id] = prepararMercado(info, sinSesionEnCurso(info, diarios[info.ticker]))
    }
    return r
  }, [diarios])
  // las acciones ya llegan preparadas (bajarAcciones), en el orden de la lista
  const accionesPreparadas = useMemo(() => (acciones && datosAcciones
    ? datosAcciones.universo.acciones.map(a => datosAcciones.mercados[a.ticker]).filter(Boolean) : []), [acciones, datosAcciones])
  const tipos = diarios[TICKER_TIPO] ?? null
  const mercados = useMemo(() => {
    if (futuros) {
      const fuera = new Set(ajustes.mercadosFuera)
      return listaFuturos.filter(x => !fuera.has(x.id)).map(x => datosFuturos.mercados[x.id]).filter(Boolean)
    }
    if (!acciones) return indicesUsados.map(id => preparados[id]).filter(Boolean)
    const fuera = new Set(ajustes.sectoresFuera)
    return accionesPreparadas.filter(x => !fuera.has(x.info.grupo))
  }, [futuros, listaFuturos, datosFuturos, ajustes.mercadosFuera, acciones, preparados, indicesUsados, accionesPreparadas, ajustes.sectoresFuera])
  // con «solo desde que entró», el servidor manda cada acción desde un año antes de entrar en
  // el índice: sin esa casilla hace falta su historia entera
  const faltan = futuros ? (datosFuturos ? [] : ['los mercados de las tortugas'])
    : !acciones ? indicesUsados.filter(id => !preparados[id])
    : !datosAcciones || (!cfg.soloEnIndice && !datosAcciones.completas) ? ['las acciones'] : []

  // en índices se prueba con los que haya (y se avisa de los que faltan); en lo demás, con todo
  const listo = mercados.length > 0 && (universo === 'indices' || !faltan.length)
  const res = useMemo(() => listo ? backtestTortugas(mercados, tipos, cfg) : null, [listo, mercados, tipos, cfg])
  const m = useMemo(() => res && metricasTortugas(res), [res])
  // cada operación cerrada, en orden de salida, con lo que dejó en % del capital (para el Monte Carlo)
  const serieRobustez = useMemo(() => (res ? [...res.operaciones].sort((a, b) => a.salida.localeCompare(b.salida)).map(o => ({ fecha: o.salida, r: o.pctCapital })) : []), [res])
  const ordenes = useMemo(() => res ? ordenesManana(res, ajustes.capital) : [], [res, ajustes.capital])

  async function cargar() {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setCargando(true)
    setError(null)
    if (futuros) {
      setProgreso({ hechos: 0, total: null })
      try {
        const [{ datos: nuevos, fallos, avisos }, tipo] = await Promise.all([
          bajarFuturos(ctrl.signal),
          bajarDiario(TICKER_TIPO, ctrl.signal).catch(e => { if (e.name === 'AbortError') throw e; return null }),
        ])
        if (ctrl.signal.aborted) return
        setDatosFuturos(nuevos)
        if (tipo) setDatos(d => ({ ...d, [TICKER_TIPO]: tipo }))
        const avisosTexto = [fallos.length && `Yahoo no dio ${fallos.join(' · ')}`, avisos.length && avisos.join(' · ')].filter(Boolean)
        if (avisosTexto.length) setError(avisosTexto.join('. '))
      } catch (e) {
        if (e.name === 'AbortError') return
        setError(`No se pudieron bajar los mercados de las tortugas: ${e.message}`)
      }
      setCargando(false)
      setProgreso(null)
      setMostradas(25)
      return
    }
    if (acciones) {
      setProgreso({ hechos: 0, total: null })
      try {
        const [{ datos: nuevas, fallos, avisos }, tipo] = await Promise.all([
          bajarAcciones({ completas: !cfg.soloEnIndice, signal: ctrl.signal, alAvanzar: (hechos, total) => setProgreso({ hechos, total }) }),
          bajarDiario(TICKER_TIPO, ctrl.signal).catch(e => { if (e.name === 'AbortError') throw e; return null }),
        ])
        if (ctrl.signal.aborted) return
        setDatosAcciones(nuevas)
        if (tipo) setDatos(d => ({ ...d, [TICKER_TIPO]: tipo }))
        const avisosTexto = [fallos.length && `Yahoo no dio ${fallos.length}: ${fallos.slice(0, 8).join(' · ')}${fallos.length > 8 ? '…' : ''}`,
          avisos.length && `${avisos.length} con datos de días anteriores`, !tipo && 'sin el tipo de la financiación (se usa un 3 %)'].filter(Boolean)
        if (avisosTexto.length) setError(avisosTexto.join('. '))
      } catch (e) {
        if (e.name === 'AbortError') return
        setError(`No se pudieron bajar las acciones: ${e.message}`)
      }
      setCargando(false)
      setProgreso(null)
      setMostradas(25)
      return
    }
    const tickers = [...INDICES_TORTUGAS.filter(i => indicesUsados.includes(i.id)).map(i => i.ticker), TICKER_TIPO]
    const bajar = deStooq ? bajarDiarioStooq : deCsv ? bajarDiarioCsv : bajarDiario
    setProgreso({ hechos: 0, total: tickers.length })
    const nuevos = {}
    const fallos = []
    let siguiente = 0
    // de tres en tres: cada índice son cuatro peticiones a Yahoo desde el servidor
    const trabajador = async () => {
      while (siguiente < tickers.length && !ctrl.signal.aborted) {
        const t = tickers[siguiente++]
        try {
          nuevos[t] = await bajar(t, ctrl.signal)
        } catch (e) {
          if (e.name !== 'AbortError') fallos.push(e.message)
        }
        setProgreso(p => p && { ...p, hechos: p.hechos + 1 })
      }
    }
    await Promise.all([trabajador(), trabajador(), trabajador()])
    if (ctrl.signal.aborted) return
    ;(deStooq ? setDatosStooq : deCsv ? setDatosCsv : setDatos)(d => ({ ...d, ...nuevos }))
    if (fallos.length) setError(`No se pudieron ${deCsv || deStooq ? 'leer' : 'bajar'}: ${fallos.join(' · ')}`)
    setCargando(false)
    setProgreso(null)
    setMostradas(25)
  }

  // Los mismos ajustes con los diarios de Yahoo (en línea, o los CSV si es la fuente elegida) y con
  // los de Stooq, en los índices que tienen los dos y desde que hay los seis en Stooq (2014). Baja
  // lo que falte de cada fuente.
  const yahooCsv = ajustes.fuenteDiario === 'csv'
  const indicesFuentes = useMemo(() => ajustes.indices.filter(id => IDS_STOOQ.includes(id)), [ajustes.indices])
  const desdeFuentes = Math.max(ajustes.desde, ANIO_STOOQ)
  const claveFuentes = JSON.stringify([claveCfg, yahooCsv])
  async function compararFuentes() {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setComparandoFuentes(true)
    setError(null)
    const tickers = [...INDICES_TORTUGAS.filter(i => indicesFuentes.includes(i.id)).map(i => i.ticker), TICKER_TIPO]
    const deYahoo = { ...(yahooCsv ? datosCsv : datos) }, deStooqYa = { ...datosStooq }, fallos = []
    const pedir = async (destino, bajar, t) => {
      if (destino[t]) return
      try { destino[t] = await bajar(t, ctrl.signal) } catch (e) { if (e.name === 'AbortError') throw e; fallos.push(e.message) }
    }
    try {
      for (const t of tickers) {
        await Promise.all([pedir(deYahoo, yahooCsv ? bajarDiarioCsv : bajarDiario, t), pedir(deStooqYa, bajarDiarioStooq, t)])
      }
    } catch (e) {
      if (e.name !== 'AbortError') throw e
    }
    if (ctrl.signal.aborted) { setComparandoFuentes(false); return }
    ;(yahooCsv ? setDatosCsv : setDatos)(deYahoo)
    setDatosStooq(deStooqYa)
    if (fallos.length) setError(`No se pudieron bajar: ${fallos.join(' · ')}`)
    // un respiro para que se pinte el aviso antes de los backtests
    await new Promise(listo => setTimeout(listo, 30))
    const preparar = d => INDICES_TORTUGAS.filter(i => indicesFuentes.includes(i.id) && d[i.ticker]).map(i => prepararMercado(i, sinSesionEnCurso(i, d[i.ticker])))
    const lados = { yahoo: preparar(deYahoo), stooq: preparar(deStooqYa) }
    const tiposDe = { yahoo: deYahoo[TICKER_TIPO] ?? null, stooq: deStooqYa[TICKER_TIPO] ?? deYahoo[TICKER_TIPO] ?? null }
    const base = { ...cfg, desde: `${desdeFuentes}-01-01` }
    const unidades = [...new Set([1, 4, cfg.maxUnidades])].sort((a, b) => a - b)
    const filas = []
    for (const s of [1, 2, '1+2']) for (const l of ['largos', 'ambos']) for (const u of unidades) {
      const c = { ...base, sistema: s, lados: l, maxUnidades: u }
      const m = Object.fromEntries(Object.entries(lados).map(([f, ms]) => [f, ms.length ? metricasTortugas(backtestTortugas(ms, tiposDe[f], c)) : null]))
      filas.push({ sistema: s, lados: l, unidades: u, actual: s === cfg.sistema && l === cfg.lados && u === cfg.maxUnidades, m })
    }
    setFuentes({ clave: claveFuentes, filas, desde: desdeFuentes, indices: lados.stooq.map(x => x.info.nombre), yahooCsv })
    setComparandoFuentes(false)
  }

  function comparar() {
    setComparando(true)
    // un respiro para que se pinte el aviso antes de los backtests. En acciones cada uno tarda
    // unos segundos: solo los sistemas y los lados, con la pirámide de ahora
    setTimeout(() => {
      const unidades = acciones ? [cfg.maxUnidades] : [...new Set([1, 4, cfg.maxUnidades])].sort((a, b) => a - b)
      const filas = []
      for (const s of [1, 2, '1+2']) for (const lados of ['largos', 'ambos']) for (const u of unidades) {
        const r = backtestTortugas(mercados, tipos, { ...cfg, sistema: s, lados, maxUnidades: u })
        filas.push({ sistema: s, lados, unidades: u, actual: s === cfg.sistema && lados === cfg.lados && u === cfg.maxUnidades, m: metricasTortugas(r) })
      }
      setVariantes({ clave: claveCfg, filas })
      setComparando(false)
    }, 30)
  }

  const ultimoDato = mercados.length ? mercados.map(x => x.fechas.at(-1)).sort().at(-1) : null
  // Lo que se pierde: 1 N en contra de todas las unidades, y hasta los stops (a 2 N de la última
  // unidad de cada pirámide), con el peor reparto de las unidades que caben. Con los dos
  // sistemas, cada índice puede llevar dos pirámides.
  const gruposDe = xs => Object.values(xs.reduce((n, g) => ({ ...n, [g]: (n[g] ?? 0) + 1 }), {}))
  const peor = peorHastaStops({
    grupos: futuros
      ? gruposDe(listaFuturos.filter(x => !ajustes.mercadosFuera.includes(x.id)).map(x => x.grupo))
      : acciones
        ? gruposDe(lista.filter(a => !ajustes.sectoresFuera.includes(a.sector)).map(a => a.sector))
        : gruposDe(INDICES_TORTUGAS.filter(i => indicesUsados.includes(i.id)).map(i => i.grupo)),
    maxUnidades: ajustes.maxUnidades, maxGrupo: ajustes.maxGrupo, maxSentido: ajustes.maxSentido,
    sistemas: sistemasDe(sistema).length, anadido: ajustes.anadido,
  })
  // `riesgo` es lo que pierde la pirámide llena en su peor punto: 1 N por unidad, eso entre el pico
  const picoN = picoPiramide(ajustes.maxUnidades, CONFIG_TORTUGAS.stopN, CONFIG_TORTUGAS.paso, ajustes.anadido)
  const porN = 100 * riesgoPorN(cfg)
  // la N y la unidad son las mismas para los dos sistemas: una caja por índice (en acciones,
  // solo las que tienen posición: son cientos)
  const conPosicion = new Set(ordenes.filter(f => f.posicion).map(f => f.indice))
  const nPorIndice = ordenes.filter((f, k) => ordenes.findIndex(x => x.indice === f.indice) === k && (!acciones || conPosicion.has(f.indice)))

  // Los ajustes que no están en el valor con el que arranca este grupo de mercados, para la
  // barra de encima de los resultados. Qué mercados entran no cuenta: va en el texto de al lado.
  const iniciales = UNIVERSOS[universo].iniciales
  const volver = campos => () => setAjustes(a => ({ ...a, ...Object.fromEntries(campos.map(c => [c, iniciales[c]])) }))
  const ajustesPuestos = [
    ajustes.lados !== iniciales.lados && { id: 'lados', texto: LADOS.find(l => l.v === ajustes.lados)?.label, quitar: volver(['lados']) },
    ajustes.riesgo !== iniciales.riesgo && { id: 'riesgo', texto: `Riesgo ${nf(ajustes.riesgo, 2)} % por pirámide`, quitar: volver(['riesgo']) },
    ajustes.anadido !== iniciales.anadido && { id: 'anadido', texto: `Añade ${ajustes.anadido === 0.5 ? '½' : nf(ajustes.anadido, 2)} unidad`, quitar: volver(['anadido']) },
    ajustes.maxUnidades !== iniciales.maxUnidades && {
      id: 'unidades', texto: ajustes.maxUnidades === 1 ? 'Sin pirámide' : `Pirámide de ${ajustes.maxUnidades} u`, quitar: volver(['maxUnidades']),
    },
    (ajustes.maxGrupo !== iniciales.maxGrupo || ajustes.maxSentido !== iniciales.maxSentido) && {
      id: 'limites', texto: `Límites ${ajustes.maxGrupo} / ${ajustes.maxSentido}`, quitar: volver(['maxGrupo', 'maxSentido']),
    },
    ajustes.media !== iniciales.media && { id: 'media', texto: ajustes.media ? `A favor de la media ${ajustes.media}` : 'Sin media', quitar: volver(['media']) },
    ajustes.reduccionDD !== iniciales.reduccionDD && {
      id: 'dd', texto: ajustes.reduccionDD ? 'Reduce en drawdown' : 'Sin reducir en drawdown', quitar: volver(['reduccionDD']),
    },
    (ajustes.financiacion !== iniciales.financiacion || (ajustes.financiacion && ajustes.recargo !== iniciales.recargo)) && {
      id: 'overnight', texto: ajustes.financiacion ? `Overnight tipo + ${nf(ajustes.recargo, 1)} %` : 'Sin coste overnight',
      quitar: volver(['financiacion', 'recargo']),
    },
    ajustes.deslizN !== iniciales.deslizN && {
      id: 'desliz', texto: ajustes.deslizN ? `Deslizamiento ${nf(ajustes.deslizN, 2)} N` : 'Sin deslizamiento', quitar: volver(['deslizN']),
    },
    acciones && ajustes.soloEnIndice !== iniciales.soloEnIndice && {
      id: 'enIndice', texto: ajustes.soloEnIndice ? 'Solo desde que entró' : 'Con toda su historia', quitar: volver(['soloEnIndice']),
    },
    acciones && ajustes.comisiones !== iniciales.comisiones && {
      id: 'comisiones', texto: ajustes.comisiones ? 'Comisión de IG' : 'Sin comisiones', quitar: volver(['comisiones']),
    },
    ajustes.desde !== iniciales.desde && { id: 'desde', texto: `Desde ${ajustes.desde}`, quitar: volver(['desde']) },
    ajustes.capital !== iniciales.capital && { id: 'capital', texto: `Capital ${eur(ajustes.capital)}`, quitar: volver(['capital']) },
  ].filter(Boolean)
  const camposAjuste = ['lados', 'riesgo', 'anadido', 'maxUnidades', 'maxGrupo', 'maxSentido', 'media', 'reduccionDD', 'financiacion',
    'recargo', 'deslizN', 'desde', 'capital', ...(acciones ? ['soloEnIndice', 'comisiones'] : [])]
  const baseAjustes = `${futuros ? 'Mercados de las tortugas' : acciones ? 'Acciones del S&P 500' : 'Índices'} · ${nf(mercados.length)} ${
    futuros ? 'mercados' : acciones ? 'acciones' : `de ${INDICES_TORTUGAS.length}`} · sistema ${nombreSistema(sistema)}${deCsv ? ' · CSV de Documentos' : deStooq ? ' · Stooq' : ''}`

  const textoCargar = cargando ? 'Descargando…' : res && !faltan.length ? 'Actualizar datos' : faltan.length && res ? 'Cargar lo que falta' : 'Cargar datos y probar'

  return (
    <div className="estrategia-panel tortugas">
      <div className="filtro-controls" ref={filtrosRef}>
        <Bloque n={1} titulo="Mercados" nota="Se bajan al pulsar el botón. Después, cada ajuste se recalcula al momento">
          <div className="filtro-group">
            <label className="filtro-label">Qué se prueba</label>
            <div className="filtro-presets">
              <Chips opciones={[
                { v: 'indices', label: 'Índices', nota: 'Los ocho índices de contado' },
                { v: 'acciones', label: 'Acciones de EE. UU.', nota: 'Las 503 del S&P 500, cada sector un grupo' },
                { v: 'futuros', label: 'Mercados de las tortugas', nota: 'Los 19 futuros que operaban las tortugas en 1983: bonos, letras, divisas, S&P, metales, energía y blandas' },
              ]} valor={universo} onCambio={cambiarUniverso} />
            </div>
            <p className="estr-explica">
              {futuros
                ? 'Los futuros que operaban las tortugas en 1983, con sus reglas. Cada grupo de mercados guarda sus ajustes'
                : acciones
                  ? 'Cada acción con sus ajustes; los de los índices se guardan aparte'
                  : 'Los índices, las acciones del S&P 500 o los mercados de las tortugas, cada uno con sus ajustes'}
            </p>
          </div>

          {futuros && (
            <div className="filtro-group">
              <label className="filtro-label">
                Futuros
                {listaFuturos.length > 0 && <span className="filtro-valor">{nf(mercados.length)} de {nf(listaFuturos.length)}</span>}
              </label>
              <div className="filtro-presets">
                {listaFuturos.map(x => (
                  <button key={x.id} className={`chip ${ajustes.mercadosFuera.includes(x.id) ? '' : 'activo'}`}
                    title={`${x.original} · ${x.simbolo} en Yahoo · grupo ${x.grupo}`}
                    onClick={() => alternarMercado(x.id)}>{x.nombre}</button>
                ))}
              </div>
              <p className="estr-explica">
                {listaFuturos.length
                  ? 'Sin grano ni carne, que Dennis ya operaba al límite'
                  : 'Bonos, letras, divisas, S&P 500, metales, energía y blandas: carga los datos para elegir'}
              </p>
            </div>
          )}

          {universo === 'indices' && (
            <div className="filtro-group">
              <label className="filtro-label">
                Índices
                <span className="filtro-valor">{ajustes.indices.length} de {INDICES_TORTUGAS.length}</span>
              </label>
              <div className="filtro-presets">
                {INDICES_TORTUGAS.map(i => (
                  <button key={i.id} className={`chip ${ajustes.indices.includes(i.id) ? 'activo' : ''}`}
                    title={`${i.ticker} · grupo ${i.grupo} · datos desde ${i.desde.slice(0, 4)}`}
                    onClick={() => alternarIndice(i.id)}>{i.nombre}</button>
                ))}
              </div>
              <p className="estr-explica">La ventaja sale de diversificar</p>
            </div>
          )}

          {universo === 'indices' && (
            <div className="filtro-group">
              <label className="filtro-label">
                Datos
                {(deCsv || deStooq) && Object.keys(diarios).length > 0 && (
                  <span className="filtro-valor">hasta el {dia(Object.values(diarios).map(v => v.at(-1)?.date ?? '').sort()[0])}</span>
                )}
              </label>
              <div className="filtro-presets">
                <Chips opciones={[
                  { v: 'yahoo', label: 'Yahoo en línea', nota: 'El servidor baja de Yahoo el diario de cada índice, al día' },
                  { v: 'csv', label: 'CSV de Documentos', nota: 'Los CSV diarios de Documents\\Yahoo\\diario que deja recoger_yahoo.py' },
                  { v: 'stooq', label: 'Stooq', nota: 'Los diarios de Documents\\Stooq: seis índices, cinco de ellos cotizaciones de casi 24 h desde 2013' },
                ]} valor={ajustes.fuenteDiario ?? 'yahoo'} onCambio={v => poner('fuenteDiario', v)} />
              </div>
              <p className="estr-explica">
                {deStooq
                  ? <>Los diarios de Stooq de Documents\Stooq, sin Hang Seng ni Russell. El Nasdaq es el contado desde 1986; los otros cinco, cotizaciones de casi 24 h desde 2013, en las que se ve el hueco de la noche (en Yahoo la apertura es muchas veces el cierre anterior y el stop se llena en su nivel). Para probar con los seis, desde {ANIO_STOOQ}.
                      {ajustes.desde < ANIO_STOOQ && indicesUsados.length > 1 && <strong> Desde {ajustes.desde}, hasta 2013 solo opera el Nasdaq.</strong>}</>
                  : deCsv
                  ? 'Los CSV diarios de Yahoo de Documents\\Yahoo\\diario (y el del tipo a 3 meses, IRX): llegan hasta el día que se grabaron'
                  : 'Del servidor, que los baja de Yahoo al día'}
              </p>
            </div>
          )}

          {acciones && (
            <div className="filtro-group">
              <label className="filtro-label">
                Sectores
                {lista.length > 0 && <span className="filtro-valor">{nf(mercados.length)} acciones de {nf(lista.length)}</span>}
              </label>
              <div className="filtro-presets">
                {sectores.map(s => (
                  <button key={s} className={`chip ${ajustes.sectoresFuera.includes(s) ? '' : 'activo'}`}
                    title={`${lista.filter(a => a.sector === s).length} acciones`}
                    onClick={() => alternarSector(s)}>{s}</button>
                ))}
              </div>
              <p className="estr-explica">
                {lista.length
                  ? 'Cada sector es un grupo para el límite de unidades'
                  : 'Las 503 acciones del S&P 500 por sector GICS: carga los datos para elegir'}
              </p>
            </div>
          )}

          {acciones && (
            <div className="filtro-group">
              <label className="filtro-label">Historia de cada acción</label>
              <div className="filtro-presets">
                <button className={`chip ${ajustes.soloEnIndice ? 'activo' : ''}`}
                  title="No abre una acción antes de la fecha en que entró en el índice (según Wikipedia)"
                  onClick={() => poner('soloEnIndice', !ajustes.soloEnIndice)}>Solo desde que entró en el índice</button>
              </div>
              <p className="estr-explica">
                {ajustes.soloEnIndice
                  ? 'Cada una solo desde que entró en el S&P 500: sin eso, el backtest compraría las ganadoras antes de que lo fueran'
                  : 'Cada una con toda su historia: es la lista de hoy, así que se compran las que ya se sabe que acabarían en el índice'}
              </p>
            </div>
          )}

          {faltan.length > 0 && res && !cargando && (
            <p className="estr-pendiente">Faltan los datos de {faltan.join(', ')}: pulsa el botón para incluirlos.</p>
          )}
          <button className="btn-filtrar" onClick={cargar} disabled={cargando}>{textoCargar}</button>
          {cargando && progreso && (
            <div className="velas-cargando">
              <span className="spinner" />
              {futuros
                ? 'Futuros de las tortugas (Yahoo)…'
                : acciones
                  ? progreso.total ? `Diario de Yahoo de las acciones… ${progreso.hechos}/${progreso.total}` : 'Lista del S&P 500…'
                  : `${deStooq ? 'Diarios de Stooq' : deCsv ? 'CSV diarios de Documentos' : 'Diario de Yahoo'}… ${progreso.hechos}/${progreso.total}`}
            </div>
          )}
          {error && <div className="error-global">{error}</div>}
        </Bloque>

        <Bloque n={2} titulo="Cómo se opera" nota="Se recalcula al momento">
          <div className="filtro-group">
            <label className="filtro-label">Lados</label>
            <div className="filtro-presets"><Chips opciones={LADOS} valor={ajustes.lados} onCambio={v => poner('lados', v)} /></div>
            <p className="estr-explica">{LADOS.find(l => l.v === ajustes.lados)?.nota}</p>
          </div>

          <div className="filtro-group">
            <label className="filtro-label">
              Riesgo máximo por pirámide
              <span className="filtro-valor">
                {nf(ajustes.riesgo, 2)} % por pirámide · 1 N por unidad = {nf(porN, 2)} %
              </span>
            </label>
            <div className="filtro-presets">
              <Chips opciones={(acciones ? RIESGOS_ACCIONES : RIESGOS).map(r => ({ v: r, label: `${nf(r, Number.isInteger(r * 10) ? 1 : 2)} %`, nota: r === 5 ? 'El de las tortugas (1 % por N y unidad), pensado para futuros poco correlacionados' : undefined }))}
                valor={ajustes.riesgo} onCambio={v => poner('riesgo', v)} />
              <Numero valor={ajustes.riesgo} min={0.05} max={25} step={0.1} titulo="% del capital que pierde como mucho una pirámide llena si salta su stop" onCambio={v => poner('riesgo', v)} />
            </div>
            <p className="estr-explica">
              Lo más que pierde la pirámide de un {acciones ? 'valor' : futuros ? 'mercado' : 'índice'} si salta su stop, en su peor punto ({nf(picoN, 2)} N por unidad con {ajustes.maxUnidades} unidad{ajustes.maxUnidades === 1 ? '' : 'es'} y añadidos de {ajustes.anadido === 0.5 ? '½' : nf(ajustes.anadido, 2)}):
              así 1 N en contra cuesta {nf(porN, 2)} % del capital por unidad, y el máximo es el mismo añadas una unidad o media. Una unidad recién entrada pierde {nf(porN * CONFIG_TORTUGAS.stopN, 2)} % hasta el stop, a {nf(CONFIG_TORTUGAS.stopN)} N;
              con todas las que caben a la vez ({peor.unidades}{ajustes.lados === 'ambos' ? ' en cada sentido' : ''}), lo peor si saltan a la vez todos los stops{ajustes.lados === 'ambos' ? ' de un sentido' : ''} es un {nf(porN * peor.n, 1)} % (sin contar los huecos, que pueden pasarlos)
            </p>
          </div>

          <div className="filtro-group">
            <label className="filtro-label">Tamaño de cada añadido</label>
            <div className="filtro-presets"><Chips opciones={ANADIDOS} valor={ajustes.anadido} onCambio={v => poner('anadido', v)} /></div>
            <p className="estr-explica">{ANADIDOS.find(a => a.v === ajustes.anadido)?.nota}</p>
          </div>

          <div className="filtro-group">
            <label className="filtro-label">Pirámide</label>
            <div className="filtro-presets">
              <Chips opciones={UNIDADES.map(u => ({ v: u, label: u === 1 ? 'Sin pirámide' : `${u} u`, nota: u === 4 ? 'Como las tortugas' : u === 7 ? 'Entrada + 6 añadidos' : undefined }))}
                valor={ajustes.maxUnidades} onCambio={v => poner('maxUnidades', v)} />
              <Numero valor={ajustes.maxUnidades} min={1} max={12} titulo="Unidades máximas por índice" onCambio={v => poner('maxUnidades', Math.round(v))} />
            </div>
            <p className="estr-explica">
              Hasta {ajustes.maxUnidades} unidad{ajustes.maxUnidades === 1 ? '' : 'es'} por {acciones ? 'acción' : futuros ? 'mercado' : 'índice'}{juntos ? ' y sistema' : ''}, contando la entrada: {ajustes.anadido === 1 ? 'una más' : `${ajustes.anadido === 0.5 ? 'media' : nf(ajustes.anadido, 2)} más`} cada ½ N a favor
            </p>
          </div>

          <div className="filtro-group">
            <label className="filtro-label">Límites de cartera</label>
            <div className="filtro-presets tortugas-limites">
              <span>grupo</span>
              <Numero valor={ajustes.maxGrupo} min={1} max={acciones ? 300 : 60} titulo={`Unidades máximas por ${acciones ? 'sector' : 'grupo'} y sentido`} onCambio={v => poner('maxGrupo', Math.round(v))} />
              <span>sentido</span>
              <Numero valor={ajustes.maxSentido} min={1} max={acciones ? 1000 : 100} titulo="Unidades máximas por sentido" onCambio={v => poner('maxSentido', Math.round(v))} />
            </div>
            <p className="estr-explica">
              {acciones
                ? 'Unidades por sector y por sentido en total: con cientos de acciones, si se llenan con rupturas de una unidad, la pirámide no crece'
                : futuros
                  ? 'Unidades por grupo (tipos, divisas, índices, metales, energía, blandas) y por sentido en total: las tortugas, 6 y 12'
                  : 'Unidades por grupo (EE. UU., Europa, Asia) y por sentido en total'}
            </p>
          </div>

          <div className="filtro-group">
            <label className="filtro-label">Reglas extra</label>
            <div className="filtro-presets">
              <Chips opciones={[{ v: 0, label: 'Sin media' }, { v: 200, label: 'A favor de la media 200', nota: 'Largos solo por encima de la media de 200 sesiones; cortos, por debajo' }]}
                valor={ajustes.media} onCambio={v => poner('media', v)} />
              <button className={`chip ${ajustes.reduccionDD ? 'activo' : ''}`}
                title="Por cada 10 % de caída desde el máximo, opera con un capital nominal un 20 % menor (regla de las tortugas)"
                onClick={() => poner('reduccionDD', !ajustes.reduccionDD)}>Reducir en drawdown</button>
            </div>
            <p className="estr-explica">
              {ajustes.media ? 'Largos solo por encima de la media de 200 sesiones; cortos, por debajo' : 'Entra en cualquier ruptura, sin mirar la tendencia'}
              {ajustes.reduccionDD ? '. Por cada 10 % de caída desde el máximo, el capital nominal baja un 20 %' : ''}
            </p>
          </div>
        </Bloque>

        <Bloque n={3} titulo="Costes, periodo y capital" nota="Se recalcula al momento">
          <div className="filtro-group">
            <label className="filtro-label">Overnight</label>
            <div className="filtro-presets">
              <button className={`chip ${!ajustes.financiacion ? 'activo' : ''}`} onClick={() => poner('financiacion', false)}>Sin coste</button>
              {RECARGOS.map(r => (
                <button key={r} className={`chip ${ajustes.financiacion && ajustes.recargo === r ? 'activo' : ''}`}
                  title={r === 2.5 ? 'El recargo de IG en índices' : undefined}
                  onClick={() => setAjustes(a => ({ ...a, financiacion: true, recargo: r }))}>tipo + {nf(r, 1)} %</button>
              ))}
            </div>
            <p className="estr-explica">
              {ajustes.financiacion
                ? acciones
                  ? `Cada noche el largo paga tipo a 3 meses + ${nf(ajustes.recargo, 1)} % (el viernes, 3 noches) y cobra los dividendos el día que la acción cotiza sin ellos; el corto, al revés`
                  : `Cada noche el largo paga tipo a 3 meses + ${nf(ajustes.recargo, 1)} % menos el dividendo (el viernes, 3 noches)`
                : futuros
                  ? 'Futuros: lo que cuesta mantenerlos ya va en el precio al empalmar cada contrato con el siguiente (las divisas van al contado, sin el diferencial de tipos)'
                  : 'Sin coste por dormir con la posición: lo que se ganaría con un futuro sin base'}
            </p>
          </div>

          <div className="filtro-group">
            <label className="filtro-label">Deslizamiento</label>
            <div className="filtro-presets">
              <Chips opciones={DESLICES.map(d => ({ v: d, label: d === 0 ? 'Ninguno' : `${nf(d, 2)} N` }))} valor={ajustes.deslizN} onCambio={v => poner('deslizN', v)} />
            </div>
            <p className="estr-explica">En cada relleno, además de medio spread; los huecos de la noche se llenan a la apertura</p>
          </div>

          {acciones && (
            <div className="filtro-group">
              <label className="filtro-label">Comisiones</label>
              <div className="filtro-presets">
                <button className={`chip ${ajustes.comisiones ? 'activo' : ''}`}
                  title="CFD de acciones de EE. UU. en IG: 0,02 $ por acción y 15 $ como mínimo por orden"
                  onClick={() => poner('comisiones', !ajustes.comisiones)}>Comisión de IG</button>
              </div>
              <p className="estr-explica">
                {ajustes.comisiones
                  ? `${nf(100 * COMISION_ACCIONES_EEUU.porAccion)} centavos por acción, ${nf(COMISION_ACCIONES_EEUU.minimo)} $ como mínimo por orden (cada unidad es una al entrar y otra al salir)`
                  : 'Sin comisiones'}
              </p>
            </div>
          )}

          <div className="filtro-group">
            <label className="filtro-label">Desde</label>
            <div className="filtro-presets">
              <select className="filtro-otros" value={ajustes.desde} onChange={e => poner('desde', Number(e.target.value))}>
                {ANIOS.map(a => <option key={a} value={a}>desde {a}</option>)}
              </select>
              {/* todo el histórico: desde el primer año que se puede pedir */}
              <button
                className={`chip ${ajustes.desde === ANIOS[0] ? 'activo' : ''}`}
                title={`Todo el histórico, desde ${ANIOS[0]}`}
                onClick={() => poner('desde', ANIOS[0])}
              >Máx</button>
            </div>
          </div>

          <div className="filtro-group">
            <label className="filtro-label">Capital</label>
            <div className="filtro-presets">
              <Numero valor={ajustes.capital} min={1000} max={100_000_000} step={1000} titulo="Capital en €" ancho onCambio={v => poner('capital', v)} />
              <span className="estr-explica">€</span>
            </div>
            <p className="estr-explica">Da el tamaño de las órdenes de mañana</p>
          </div>
        </Bloque>
      </div>

      {!res && !cargando && (
        <div className="estr-vacio">
          <p className="estr-vacio-tit">Pulsa <strong>Cargar datos y probar</strong></p>
          <p className="estr-vacio-sub">
            {futuros
              ? <>Baja de Yahoo los 19 futuros de las tortugas desde 2000, empalmados en cada vencimiento, y las divisas al
                  contado (unos segundos; la primera vez del día, algo más).</>
              : acciones
              ? <>Baja el diario de Yahoo de las 503 acciones del S&P 500{ajustes.soloEnIndice ? ', cada una desde un año antes de entrar en el índice' : ' con toda su historia'}. La
                  primera vez del día, el servidor tarda un minuto en traerlas de Yahoo; después, unos segundos. Cada ajuste
                  recalcula en un par de segundos.{datosAcciones && !datosAcciones.completas && !ajustes.soloEnIndice
                  ? ' Las cargadas son solo desde que entró cada una en el índice: hay que bajarlas otra vez enteras.' : ''}</>
              : 'Baja el diario de Yahoo de cada índice desde 1988 (unos segundos) y, a partir de ahí, cada ajuste recalcula al momento.'}
          </p>
        </div>
      )}

      {res && m && (
        <div className="estr-resultados">
          <AjustesPuestos base={baseAjustes} ajustes={ajustesPuestos} onRestablecer={volver(camposAjuste)} />
          {faltan.length > 0 && (
            <p className="estr-nota tortugas-aviso">
              Faltan los datos de {faltan.join(', ')}: pulsa <strong>Cargar lo que falta</strong> para incluirlos.
            </p>
          )}
          <Resumen m={m} res={res} />
          <NDeHoy filas={nPorIndice} paso={res.cfg.paso} stopN={res.cfg.stopN} acciones={acciones} futuros={futuros} />
          <CurvaTortugas res={res} />
          <Anual res={res} />
          {acciones ? <PorSector res={res} /> : <PorIndice res={res} futuros={futuros} />}
          <Piramide res={res} />
          <Robustez serie={serieRobustez} unidad="%" titulo="Robustez de las operaciones (en % del capital)" />
          <Variantes variantes={variantes} vigente={variantes?.clave === claveCfg} comparando={comparando} onComparar={comparar} acciones={acciones} />
          {universo === 'indices' && (
            <YahooFrenteStooq fuentes={fuentes} vigente={fuentes?.clave === claveFuentes} comparando={comparandoFuentes}
              onComparar={compararFuentes} desde={desdeFuentes} hayIndices={indicesFuentes.length > 0} />
          )}
          <RevisionBacktest
            clave={claveCfg}
            armar={() => expedienteBacktest(res, { universo, variantes: variantes?.clave === claveCfg ? variantes.filas : null })}
            hasta={res.curva.at(-1).date}
            hayVariantes={variantes?.clave === claveCfg}
            nota={<>Claude lee el resumen, los años, las peores caídas, las dos mitades del periodo, de dónde sale el
              beneficio (mercados, pirámide, lados, las mejores operaciones) y las limitaciones de los datos, y dice si
              el resultado es sólido o frágil y qué probar para comprobarlo. Si antes pulsas <strong>Comparar
              variantes</strong>, también las tiene en cuenta para juzgar si estos ajustes están hechos a medida de la historia.</>}
          />
          <Ordenes filas={ordenes} juntos={juntos} capital={ajustes.capital} ultimoDato={ultimoDato} acciones={acciones} futuros={futuros} />
          <Operaciones res={res} mostradas={mostradas} onMas={() => setMostradas(n => n + 50)} acciones={acciones} futuros={futuros} />
          {futuros ? (
            <p className="estr-nota">
              Los mercados de las reglas de las tortugas (Curtis Faith) con el futuro de hoy de cada uno en Yahoo, desde 2000:
              la gasolina RBOB por la sin plomo, el E-mini por el S&P 500 grande y el euro por el marco y el franco francés.
              Yahoo da el contrato más cercano y salta al siguiente al vencer: la serie está empalmada hacia atrás en cada
              cambio (el día lo dice el volumen dentro de la ventana de vencimiento de cada contrato), así que los precios
              de hace años no son los que cotizaban, pero sí lo que se movían. Las divisas, al contado (en el futuro, Yahoo
              cambia cada mes a un contrato sin volumen), sin el diferencial de tipos que lleva el futuro. El eurodólar ya
              no existe y las letras a 90 días salen del tipo a 3 meses (100 − ^IRX): su N es diminuta, así que su unidad
              lleva un nominal enorme, como el eurodólar de las tortugas; por eso aquí no hay tope de nominal. Las tortugas
              además cobraban los intereses del dinero que no estaba en margen; aquí no. Las órdenes son stop, con el
              deslizamiento elegido y sin comisión.
            </p>
          ) : acciones ? (
            <p className="estr-nota">
              Velas diarias de Yahoo, ajustadas por los splits (por eso las de hace años salen a céntimos; la comisión
              y las acciones enteras se cuentan con las acciones de entonces). La lista es la de hoy del S&P 500 (Wikipedia, con la fecha
              de entrada de cada una): no están las que salieron del índice ni las que dejaron de cotizar, así que, aun
              operando cada una solo desde que entró, el resultado sale mejor de lo que habría sido. Las escisiones
              (spin-offs) no vienen ajustadas: el día que se separa la filial parece una caída. Las órdenes son stop y se
              ejecutan en su nivel, o en la apertura si la noche ya lo ha saltado (los huecos de los resultados trimestrales
              pasan los stops); dentro de la vela se supone el camino apertura → mínimo → máximo → cierre si cierra por
              encima de la apertura, y al revés si no. Spread de 4 puntos básicos y las cuentas en euros como si fueran dólares.
            </p>
          ) : (
            <p className="estr-nota">
              Velas diarias del contado (Yahoo). Las órdenes son stop y se ejecutan en su nivel, o en la apertura si la
              noche ya lo ha saltado; dentro de la vela se supone el camino apertura → mínimo → máximo → cierre si cierra
              por encima de la apertura, y al revés si no. El tipo de la financiación es la letra del Tesoro de EE. UU. a
              3 meses para todos los índices (el euro estuvo en negativo de 2015 a 2022). Yahoo trae el FTSE siempre con
              la apertura igual al cierre anterior, y el S&P y el Russell así en muchas sesiones antes de 2007: ahí el
              hueco de la noche no se ve. Los CFD cotizan casi 24 h, así que un stop puede saltar de noche en un nivel que
              el contado no llega a marcar.
            </p>
          )}
        </div>
      )}

      <BarraAnalizar
        filtrosRef={filtrosRef}
        resumen={res ? baseAjustes : 'Sin datos todavía'}
        texto={textoCargar}
        onAnalizar={cargar}
        disabled={cargando}
      />
    </div>
  )
}

// ── Resultados ──────────────────────────────────────────────────────────────

function Resumen({ m, res }) {
  const tiles = [
    { label: 'Capital final', valor: eur(m.capitalFinal), sub: m.quiebra ? `la cuenta se quedó a cero el ${dia(m.quiebra)}` : `desde ${eur(res.cfg.capital)} el ${dia(res.curva[0].date)}`, ...(m.quiebra ? { marca: '▼', tono: 'rojo' } : {}) },
    { label: 'Rentabilidad anual', valor: pct(m.cagr), sub: 'compuesta (CAGR)', marca: m.cagr >= 0 ? '▲' : '▼', tono: m.cagr >= 0 ? 'verde' : 'rojo' },
    { label: 'Máximo drawdown', valor: pct(m.maxDD), sub: m.peorDD ? `${dia(m.peorDD.desde)} → ${dia(m.peorDD.hasta)}` : '—', marca: '▼', tono: 'rojo' },
    { label: 'Rentabilidad / drawdown', valor: nf(m.mar, 2), sub: `MAR · Sharpe ${nf(m.sharpe, 2)}` },
    { label: 'Más tiempo sin máximos', valor: `${nf(m.ddMasLargo, 1)} años`, sub: 'el drawdown más largo' },
    { label: 'Operaciones', valor: nf(m.operaciones), sub: `${nf(m.acierto, 1)} % ganadoras · ${nf(m.diasMedios, 0)} días de media` },
    { label: 'Profit factor', valor: nf(m.profitFactor, 2), sub: `la ganadora media es ${nf(m.ganadoraPerdedora, 1)} veces la perdedora` },
    { label: 'Financiación overnight', valor: eur(-m.financiacion), sub: `${nf(m.financiacionPct, 1)} % de lo ganado en bruto` },
    ...(m.comisiones > 0 ? [{ label: 'Comisiones', valor: eur(-m.comisiones), sub: `${nf(m.comisionesPct, 1)} % de lo ganado en bruto` }] : []),
    { label: 'Apalancamiento', valor: `${nf(m.apalancamientoMedio, 2)}×`, sub: `nominal / capital · máximo ${nf(m.apalancamientoMax, 1)}×` },
  ]
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
    </div>
  )
}

// La volatilidad con la que se mide todo: N de cada índice al último cierre, en puntos y en %
// del precio, con lo que sale de él (cada cuánto se añade, a qué distancia va el stop y el
// tamaño de una unidad)
function NDeHoy({ filas, paso, stopN, acciones, futuros }) {
  if (acciones && !filas.length) return null
  const pts = acciones ? '$' : 'pts'
  const dec = acciones ? 2 : 1
  const fn = x => (futuros ? nfp(x) : nf(x, dec))
  return (
    <div className="estr-resumen">
      <div className="tortugas-cabecera">
        <strong>{acciones ? 'N de las acciones con posición' : futuros ? 'N de cada mercado' : 'N de cada índice'}</strong>
        <span className="estr-nota">ATR de Wilder de 20 sesiones, al último cierre</span>
      </div>
      <div className="tortugas-n">
        {filas.map(f => (
          <div key={f.indice} className="tortugas-n-caja" title={`${f.nombre} · cierre ${nf(f.cierre, 2)} el ${dia(f.ultimoDia)}`}>
            <span className="tortugas-n-nombre">{acciones ? f.indice : f.nombre}</span>
            <span className="tortugas-n-valor">{fn(f.n)} <small>{pts}</small></span>
            <span className="tortugas-n-sub">{nf(100 * f.n / f.cierre, 2)} % del precio</span>
            <span className="tortugas-n-sub">añade cada {fn(paso * f.n)} {pts}</span>
            <span className="tortugas-n-sub">stop a {fn(stopN * f.n)} {pts}</span>
            <span className="tortugas-n-sub">unidad {f.contratos != null ? contratosTexto(f.contratos) : acciones ? `${nf(f.unidad)} acciones` : `${nf(f.unidad, 2)} €/pt`}</span>
            {f.anadido !== f.unidad && <span className="tortugas-n-sub">añadido {f.contratos != null ? contratosTexto(f.contratosAnadido) : acciones ? `${nf(f.anadido)} acciones` : `${nf(f.anadido, 2)} €/pt`}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

// Capital en escala logarítmica (con interés compuesto es la que deja comparar épocas) y el
// drawdown en % debajo
function CurvaTortugas({ res }) {
  const ref = useRef(null)
  const puntos = useMemo(() => curvaConDrawdown(res), [res])

  useEffect(() => {
    if (!ref.current || !puntos.length) return
    const chart = createChart(ref.current, {
      layout: { background: { color: '#ffffff' }, textColor: '#1a1a1a' },
      grid: { vertLines: { color: '#e5e7eb' }, horzLines: { color: '#e5e7eb' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#d1d5db', mode: PriceScaleMode.Logarithmic, scaleMargins: { top: 0.05, bottom: 0.32 } },
      timeScale: { borderColor: '#d1d5db', minBarSpacing: 0.01 },
      localization: { priceFormatter: v => Math.round(v).toLocaleString('es-ES') },
      width: ref.current.clientWidth,
      height: 320,
    })
    const capital = chart.addSeries(AreaSeries, {
      lineColor: '#3fb950', topColor: 'rgba(63,185,80,0.28)', bottomColor: 'rgba(63,185,80,0.02)',
      lineWidth: 2, priceLineVisible: false,
    })
    // en escala logarítmica no cabe un capital de cero o menos: desde ahí, la línea se corta
    capital.setData(puntos.map(p => (p.valor > 0 ? { time: p.date, value: p.valor } : { time: p.date })))
    const dd = chart.addSeries(HistogramSeries, {
      color: 'rgba(248,81,73,0.55)', priceScaleId: 'dd', priceLineVisible: false, lastValueVisible: false,
      priceFormat: { type: 'custom', formatter: v => `${v.toFixed(0)} %` },
    })
    dd.setData(puntos.map(p => ({ time: p.date, value: p.dd })))
    chart.priceScale('dd').applyOptions({ scaleMargins: { top: 0.72, bottom: 0 }, mode: PriceScaleMode.Normal })
    chart.timeScale().fitContent()
    const encuadrar = requestAnimationFrame(() => {
      chart.applyOptions({ width: ref.current?.clientWidth ?? 0 })
      chart.timeScale().fitContent()
    })
    const alRedimensionar = () => chart.applyOptions({ width: ref.current?.clientWidth ?? 0 })
    window.addEventListener('resize', alRedimensionar)
    return () => {
      cancelAnimationFrame(encuadrar)
      window.removeEventListener('resize', alRedimensionar)
      chart.remove()
    }
  }, [puntos])

  return (
    <div className="estr-resumen">
      <div ref={ref} className="curva-equity-grafico" />
      <p className="estr-nota">
        Línea verde: el capital día a día, en escala logarítmica (la misma subida en % mide lo mismo en cualquier
        época). Barras rojas: lo que se llevaba perdido desde el máximo anterior, en %.
      </p>
    </div>
  )
}

function Anual({ res }) {
  const anios = useMemo(() => rentabilidadAnual(res), [res])
  const negativos = anios.filter(a => a.pct < 0).length
  return (
    <div className="estr-resumen">
      <div className="tortugas-anios">
        {anios.map(a => (
          <div key={a.anio} className={`tortugas-anio ${tono(a.pct)}`} title={`${a.anio}: ${pct(a.pct)}`}>
            <span>{a.anio}</span>
            <strong>{sgn(a.pct, 0)}</strong>
          </div>
        ))}
      </div>
      <p className="estr-nota">Rentabilidad de cada año en %: {anios.length - negativos} en positivo y {negativos} en negativo.</p>
    </div>
  )
}

function PorIndice({ res, futuros }) {
  const filas = useMemo(() => resumenPorIndice(res), [res])
  const hayCortos = res.cfg.lados !== 'largos'
  const hayLargos = res.cfg.lados !== 'cortos'
  const juntos = res.cfg.sistema === '1+2'
  const delSistema = s => {
    const ops = res.operaciones.filter(o => o.sistema === s)
    return { n: ops.length, neto: ops.reduce((t, o) => t + o.neto, 0), ganan: ops.filter(o => o.neto > 0).length }
  }
  const [s1, s2] = juntos ? [delSistema(1), delSistema(2)] : []
  return (
    <div className="estr-resumen">
      <div className="tortugas-tabla-wrap">
        <table className="estr-mitades-tabla tortugas-tabla">
          <thead>
            <tr>
              <th>{futuros ? 'Por mercado' : 'Por índice'}</th><th>Desde</th><th>Operaciones</th><th>Ganadoras</th><th>Neto</th>
              {hayLargos && hayCortos && <><th>Largos</th><th>Cortos</th></>}
              {juntos && <><th>Sistema 1</th><th>Sistema 2</th></>}
              <th>Financiación</th><th>Comprar y mantener</th><th>Su peor caída</th>
            </tr>
          </thead>
          <tbody>
            {filas.map(f => (
              <tr key={f.indice}>
                <th>{f.nombre}</th>
                <td>{dia(f.desde)}</td>
                <td>{nf(f.operaciones)}</td>
                <td>{nf(f.acierto, 1)} %</td>
                <td className={tono(f.neto)}>{eur(f.neto)}</td>
                {hayLargos && hayCortos && <><td className={tono(f.largos)}>{eur(f.largos)}</td><td className={tono(f.cortos)}>{eur(f.cortos)}</td></>}
                {juntos && <><td className={tono(f.s1)}>{eur(f.s1)}</td><td className={tono(f.s2)}>{eur(f.s2)}</td></>}
                <td>{eur(-f.financiacion)}</td>
                <td>{pct(f.compraCagr)} al año</td>
                <td>{pct(f.compraDD, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="estr-nota">
        {juntos && <>
          El sistema 1 deja <strong className={tono(s1.neto)}>{eur(s1.neto)}</strong> en {nf(s1.n)} operaciones ({nf(s1.n ? 100 * s1.ganan / s1.n : NaN, 0)} % ganadoras)
          y el 2, con las rupturas que el 1 se salta, <strong className={tono(s2.neto)}>{eur(s2.neto)}</strong> en {nf(s2.n)} ({nf(s2.n ? 100 * s2.ganan / s2.n : NaN, 0)} % ganadoras).{' '}
        </>}
        {futuros
          ? 'Comprar y mantener es el futuro empalmado (estar siempre en el contrato más cercano, con lo que cuesta pasar de uno a otro) o, en divisas, el contado, en el mismo periodo: '
          : 'Comprar y mantener es el índice de precio, sin dividendos (salvo el DAX, que los incluye), en el mismo periodo: '}
        sirve de referencia para la rentabilidad y, sobre todo, para la caída.
      </p>
    </div>
  )
}

// En acciones, en vez de una fila por mercado (son cientos): lo de cada sector y las acciones
// que más dejaron y más quitaron
function PorSector({ res }) {
  const porAccion = useMemo(() => resumenPorIndice(res), [res])
  const sectores = useMemo(() => resumenPorGrupo(res, porAccion), [res, porAccion])
  const acciones = useMemo(() => porAccion.filter(f => f.operaciones).sort((a, b) => b.neto - a.neto), [porAccion])
  const hayCortos = res.cfg.lados !== 'largos'
  const hayLargos = res.cfg.lados !== 'cortos'
  const juntos = res.cfg.sistema === '1+2'
  const mejores = acciones.slice(0, 10)
  const peores = acciones.slice(-10).reverse().filter(f => !mejores.includes(f))
  const filaAccion = f => (
    <tr key={f.indice}>
      <th title={f.nombre}>{f.indice}</th>
      <td className="tortugas-izq">{f.grupo}</td>
      <td>{nf(f.operaciones)}</td>
      <td>{nf(f.acierto, 1)} %</td>
      <td className={tono(f.neto)}>{eur(f.neto)}</td>
      <td>{eur(-f.comision)}</td>
      <td>{pct(f.compraCagr)} al año</td>
    </tr>
  )
  return (
    <div className="estr-resumen">
      <div className="tortugas-tabla-wrap">
        <table className="estr-mitades-tabla tortugas-tabla">
          <thead>
            <tr>
              <th>Por sector</th><th>Acciones</th><th>Operaciones</th><th>Ganadoras</th><th>Neto</th>
              {hayLargos && hayCortos && <><th>Largos</th><th>Cortos</th></>}
              {juntos && <><th>Sistema 1</th><th>Sistema 2</th></>}
              <th>Financiación</th><th>Comisiones</th>
            </tr>
          </thead>
          <tbody>
            {sectores.map(g => (
              <tr key={g.grupo}>
                <th>{g.grupo}</th>
                <td title={`${g.conOperaciones} con alguna operación`}>{nf(g.mercados)}</td>
                <td>{nf(g.operaciones)}</td>
                <td>{nf(g.acierto, 1)} %</td>
                <td className={tono(g.neto)}>{eur(g.neto)}</td>
                {hayLargos && hayCortos && <><td className={tono(g.largos)}>{eur(g.largos)}</td><td className={tono(g.cortos)}>{eur(g.cortos)}</td></>}
                {juntos && <><td className={tono(g.s1)}>{eur(g.s1)}</td><td className={tono(g.s2)}>{eur(g.s2)}</td></>}
                <td>{eur(-g.financiacion)}</td>
                <td>{eur(-g.comision)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {[['Las que más dejan', mejores], ['Las que más quitan', peores]].filter(([, filas]) => filas.length).map(([titulo, filas]) => (
        <div key={titulo} className="tortugas-tabla-wrap">
          <table className="estr-mitades-tabla tortugas-tabla">
            <thead>
              <tr><th>{titulo}</th><th>Sector</th><th>Operaciones</th><th>Ganadoras</th><th>Neto</th><th>Comisiones</th><th>Comprar y mantener</th></tr>
            </thead>
            <tbody>{filas.map(filaAccion)}</tbody>
          </table>
        </div>
      ))}
      <p className="estr-nota">
        La financiación ya descuenta los dividendos cobrados. Comprar y mantener es la acción sin dividendos desde
        su primer día en el periodo (o desde que hay datos de ella). {nf(acciones.length)} acciones llegaron a tener
        alguna operación.
      </p>
    </div>
  )
}

function Piramide({ res }) {
  const filas = useMemo(() => porUnidades(res), [res])
  const total = filas.reduce((s, f) => s + f.neto, 0)
  return (
    <div className="estr-resumen">
      <div className="tortugas-tabla-wrap">
        <table className="estr-mitades-tabla tortugas-tabla">
          <thead>
            <tr><th>Unidades al cerrar</th><th>Operaciones</th><th>Ganadoras</th><th>Neto</th><th>Del total</th></tr>
          </thead>
          <tbody>
            {filas.map(f => (
              <tr key={f.unidades}>
                <th>{f.unidades}</th>
                <td>{nf(f.n)}</td>
                <td>{nf(100 * f.ganan / f.n, 1)} %</td>
                <td className={tono(f.neto)}>{eur(f.neto)}</td>
                <td>{total ? `${nf(100 * f.neto / total, 0)} %` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="estr-nota">
        Hasta dónde llegó la pirámide en cada operación. En un sistema de tendencia lo normal es que las de pocas
        unidades pierdan (rupturas falsas cortadas pronto) y que todo el beneficio venga de las pocas que se completan.
      </p>
    </div>
  )
}

const LADO_CORTO = { largos: 'solo largos', ambos: 'largos y cortos', cortos: 'solo cortos' }

function Variantes({ variantes, vigente, comparando, onComparar, acciones }) {
  return (
    <div className="estr-resumen">
      <div className="tortugas-cabecera">
        <strong>Sistema 1, sistema 2 y los dos juntos</strong>
        <button className="chip" onClick={onComparar} disabled={comparando}>
          {comparando ? 'Calculando…' : variantes ? 'Volver a comparar' : 'Comparar variantes'}
        </button>
      </div>
      {variantes && (
        <div className={`tortugas-tabla-wrap ${vigente ? '' : 'tortugas-caducada'}`}>
          <table className="estr-mitades-tabla tortugas-tabla">
            <thead>
              <tr><th>Variante</th><th>Anual</th><th>Máx. DD</th><th>MAR</th><th>Sharpe</th><th>Operaciones</th><th>Profit factor</th><th>Financiación / bruto</th></tr>
            </thead>
            <tbody>
              {variantes.filas.map(f => (
                <tr key={`${f.sistema}-${f.lados}-${f.unidades}`} className={f.actual ? 'tortugas-actual' : ''}>
                  <th>{nombreSistema(f.sistema)} · {LADO_CORTO[f.lados]} · {f.unidades === 1 ? 'sin pirámide' : `${f.unidades} u`}</th>
                  <td className={tono(f.m.cagr)}>{pct(f.m.cagr)}</td>
                  <td>{pct(f.m.maxDD, 0)}</td>
                  <td>{nf(f.m.mar, 2)}</td>
                  <td>{nf(f.m.sharpe, 2)}</td>
                  <td>{nf(f.m.operaciones)}</td>
                  <td>{nf(f.m.profitFactor, 2)}</td>
                  <td>{nf(f.m.financiacionPct, 0)} %</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="estr-nota">
        {variantes && !vigente
          ? <strong>Los ajustes han cambiado desde la comparación: vuelve a calcularla. </strong>
          : null}
        Los dos sistemas, por separado y juntos (el 2 con las rupturas que el 1 se salta), con y sin cortos{acciones ? ' (con la pirámide de ahora: con cientos de acciones cada backtest tarda unos segundos)' : ' y con distintas pirámides'}, con el resto de ajustes como están.
        La fila resaltada es la que se ve arriba. Fíjate más en el MAR (rentabilidad anual entre el peor drawdown)
        que en la rentabilidad: subir el riesgo sube las dos cosas a la vez.
      </p>
    </div>
  )
}

// Las mismas variantes con los diarios de Yahoo y con los de Stooq, lado a lado
function YahooFrenteStooq({ fuentes, vigente, comparando, onComparar, desde, hayIndices }) {
  const celdas = m => m
    ? <><td className={tono(m.cagr)}>{pct(m.cagr)}</td><td>{pct(m.maxDD, 0)}</td><td>{nf(m.mar, 2)}</td><td>{nf(m.profitFactor, 2)}</td></>
    : <td colSpan={4}>sin datos</td>
  return (
    <div className="estr-resumen">
      <div className="tortugas-cabecera">
        <strong>Yahoo frente a Stooq</strong>
        <button className="chip" onClick={onComparar} disabled={comparando || !hayIndices}>
          {comparando ? 'Calculando…' : fuentes ? 'Volver a comparar' : 'Comparar Yahoo y Stooq'}
        </button>
      </div>
      {fuentes && (
        <div className={`tortugas-tabla-wrap ${vigente ? '' : 'tortugas-caducada'}`}>
          <table className="estr-mitades-tabla tortugas-tabla">
            <thead>
              <tr><th rowSpan={2}>Variante</th><th colSpan={4} style={{ textAlign: 'center' }}>Yahoo{fuentes.yahooCsv ? ' (CSV)' : ''}</th><th colSpan={4} style={{ textAlign: 'center' }}>Stooq</th></tr>
              <tr><th>Anual</th><th>Máx. DD</th><th>MAR</th><th>PF</th><th>Anual</th><th>Máx. DD</th><th>MAR</th><th>PF</th></tr>
            </thead>
            <tbody>
              {fuentes.filas.map(f => (
                <tr key={`${f.sistema}-${f.lados}-${f.unidades}`} className={f.actual ? 'tortugas-actual' : ''}>
                  <th>{nombreSistema(f.sistema)} · {LADO_CORTO[f.lados]} · {f.unidades === 1 ? 'sin pirámide' : `${f.unidades} u`}</th>
                  {celdas(f.m.yahoo)}
                  {celdas(f.m.stooq)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="estr-nota">
        {fuentes && !vigente ? <strong>Los ajustes han cambiado desde la comparación: vuelve a calcularla. </strong> : null}
        {!hayIndices
          ? 'Elige alguno de los índices que tiene Stooq (todos menos el Hang Seng y el Russell). '
          : fuentes ? `${fuentes.indices.join(', ')}, desde ${fuentes.desde}. ` : `Los índices elegidos que tiene Stooq, desde ${desde}. `}
        Los mismos ajustes con las dos fuentes. Stooq trae cotizaciones de casi 24 h, en las que el stop que salta
        de noche se llena a la apertura; en el diario de Yahoo la apertura es muchas veces el cierre anterior y el stop
        se llena en su nivel, así que lo que gana de más con Yahoo es en buena parte optimismo de los datos.
        El tipo de la financiación sale de Yahoo en los dos.
      </p>
    </div>
  )
}

// En acciones, de las cientos que hay: las que tienen posición y las que tienen la ruptura más
// cerca (en N desde el último cierre)
const CERCANAS = 25
const distanciaN = f => Math.min(
  f.compra && !f.posicion ? (f.compra.nivel - f.cierre) / f.n : Infinity,
  f.venta && !f.posicion ? (f.cierre - f.venta.nivel) / f.n : Infinity,
)

function Ordenes({ filas: todas, juntos, capital, ultimoDato, acciones, futuros }) {
  const filas = useMemo(() => {
    if (!acciones) return todas
    const conPosicion = todas.filter(f => f.posicion)
    const cercanas = todas.filter(f => !f.posicion && Number.isFinite(distanciaN(f))).sort((a, b) => distanciaN(a) - distanciaN(b)).slice(0, CERCANAS)
    return [...conPosicion, ...cercanas]
  }, [todas, acciones])
  const nivel = o => o ? `${acciones || futuros ? nfp(o.nivel) : nf(o.nivel, 2)}${o.k ? ` (${o.k})` : ' (añadido)'}` : ''
  const fuera = f => {
    if (!juntos) return f.filtro ? 'fuera · la última de 20 ganó: espera la de 55' : 'fuera'
    if (f.sistema === 1) return f.filtro ? 'fuera · la última de 20 ganó: se la salta y la coge el S2' : 'fuera'
    return f.compra || f.venta ? 'fuera · el S1 se salta la de 20: entra en la de 55' : 'fuera · solo entra si el S1 se salta la ruptura'
  }
  return (
    <div className="estr-resumen">
      <div className="tortugas-cabecera">
        <strong>Órdenes stop para la próxima sesión</strong>
        <span className="estr-nota">con el último cierre de cada {acciones ? 'acción' : futuros ? 'mercado' : 'índice'} ({dia(ultimoDato)} el más reciente) y {eur(capital)}</span>
      </div>
      <div className="tortugas-tabla-wrap">
        <table className="estr-mitades-tabla tortugas-tabla">
          <thead>
            <tr>
              <th>{acciones ? 'Acción' : futuros ? 'Mercado' : 'Índice'}</th>{juntos && <th>Sistema</th>}<th>Cierre</th><th>N</th><th>Unidad</th><th>Posición</th>
              {acciones && <th title="Lo que le falta al precio para llegar a la ruptura, en N">A cuánto</th>}
              <th>Compra stop</th><th>Venta stop</th><th>Salida stop</th>
            </tr>
          </thead>
          <tbody>
            {filas.map(f => (
              <tr key={`${f.indice}-${f.sistema}`}>
                <th title={acciones ? `${f.nombre} · ${f.grupo}` : undefined}>{acciones ? f.indice : f.nombre}</th>
                {juntos && <td>S{f.sistema}</td>}
                <td title={dia(f.ultimoDia)}>{acciones || futuros ? nfp(f.cierre) : nf(f.cierre, 2)}</td>
                <td>{futuros ? nfp(f.n) : nf(f.n, acciones ? 2 : 1)}</td>
                <td title={f.anadido !== f.unidad ? `cada añadido: ${f.contratos != null ? contratosTexto(f.contratosAnadido) : acciones ? `${nf(f.anadido)} acc.` : `${nf(f.anadido, 2)} €/pt`}` : undefined}>{f.contratos != null ? contratosTexto(f.contratos) : acciones ? `${nf(f.unidad)} acc.` : `${nf(f.unidad, 2)} €/pt`}</td>
                <td className="tortugas-izq">
                  {f.posicion
                    ? `${f.posicion.lado} · ${f.posicion.unidades} u desde ${dia(f.posicion.desde)} · medio ${acciones || futuros ? nfp(f.posicion.medio) : nf(f.posicion.medio, 1)}`
                    : fuera(f)}
                </td>
                {acciones && <td>{f.posicion ? '' : `${nf(distanciaN(f), 2)} N`}</td>}
                <td>{nivel(f.compra)}</td>
                <td>{nivel(f.venta)}</td>
                <td>{f.salida != null ? (acciones || futuros ? nfp(f.salida) : nf(f.salida, 2)) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="estr-nota">
        {acciones && <>De las {nf(todas.length / (juntos ? 2 : 1))} acciones, las que tienen posición y las {CERCANAS} filas con la ruptura más cerca. </>}
        Es la posición que tendría hoy el backtest. Entre paréntesis, las sesiones de la ruptura. La salida es el más
        cercano entre el stop de 2 N y el canal contrario{juntos ? ' (de 10 en el S1 y de 20 en el S2)' : ''}. La unidad es capital · riesgo por N / N (el riesgo de la pirámide entre su peor punto)
        {acciones ? ', en acciones enteras: si sale 0, hace falta más capital o más riesgo por unidad.' : ': si sale por debajo del mínimo del broker, hace falta más capital o más riesgo por unidad.'}
      </p>
    </div>
  )
}

function Operaciones({ res, mostradas, onMas, acciones, futuros }) {
  // el acumulado del neto en el orden en que se cerraron; las abiertas suman encima, como si
  // se cerraran hoy
  const filas = useMemo(() => {
    const todas = []
    let suma = 0
    for (const o of [...res.operaciones, ...res.abiertas]) {
      suma += o.neto
      todas.push({ ...o, acumulado: suma })
    }
    return todas.reverse()
  }, [res])
  const juntos = res.cfg.sistema === '1+2'
  const precio = acciones || futuros ? nfp : v => nf(v, 1)
  return (
    <div className="estr-resumen">
      <div className="tortugas-cabecera">
        <strong>Operaciones</strong>
        <span className="estr-nota">{nf(res.operaciones.length)} cerradas{res.abiertas.length ? ` y ${res.abiertas.length} abierta${res.abiertas.length === 1 ? '' : 's'}` : ''}, de la más reciente a la más antigua</span>
      </div>
      <div className="tortugas-tabla-wrap">
        <table className="estr-mitades-tabla tortugas-tabla">
          <thead>
            <tr>
              <th>{acciones ? 'Acción' : futuros ? 'Mercado' : 'Índice'}</th>{juntos && <th title="S1: ruptura de 20, salida en la de 10 · S2: la de 55 que el S1 se salta, salida en la de 20">Sistema</th>}<th>Lado</th><th>Entrada</th><th>Salida</th><th>Días</th><th title="N al entrar: de él salen los añadidos y el stop">N</th><th>Unidades</th>
              <th title={acciones ? 'Todas las unidades juntas, en acciones de las de entonces' : 'Todas las unidades juntas, en € por punto'}>Tamaño</th><th title="Tamaño por precio medio de entrada">Nominal</th>
              <th title={acciones ? 'Ajustado por los splits posteriores' : undefined}>Precio medio</th><th>Precio salida</th><th>Motivo</th><th title="Antes de la financiación y las comisiones">Bruto</th><th>Financiación</th>{acciones && <th>Comisiones</th>}<th>Neto</th><th>% capital</th><th title="La suma del neto hasta esta operación, en el orden en que se cerraron (las abiertas, como si se cerraran hoy)">Acumulado</th>
            </tr>
          </thead>
          <tbody>
            {filas.slice(0, mostradas).map((o, k) => (
              <tr key={k} className={o.motivo === 'abierta' ? 'tortugas-actual' : ''}>
                <th>{o.indice}</th>
                {juntos && <td>S{o.sistema}</td>}
                <td>{o.lado}</td>
                <td>{dia(o.entrada)}</td>
                <td>{o.salida ? dia(o.salida) : 'abierta'}</td>
                <td>{o.dias ?? ''}</td>
                <td>{acciones || futuros ? nfp(o.n) : nf(o.n, 1)}</td>
                <td>{o.unidades}</td>
                {acciones
                  ? <td>{nf(o.acciones)} acc.</td>
                  : o.contratos != null ? <td>{contratosTexto(o.contratos)}</td>
                  : <td title={o.tamanos.length > 1 ? `Unidades: ${o.tamanos.map(t => nf(t, 2)).join(' + ')} €/pt` : undefined}>{nf(o.tamano, 2)} €/pt</td>}
                <td>{eur(o.nominal)}</td>
                <td>{precio(o.precioEntrada)}</td>
                <td>{precio(o.precioSalida)}</td>
                <td>{o.motivo === 'abierta' ? '—' : o.motivo}</td>
                <td className={tono(o.bruto)}>{eur(o.bruto)}</td>
                <td>{eur(-o.financiacion)}</td>
                {acciones && <td>{eur(-o.comision)}</td>}
                <td className={tono(o.neto)}>{eur(o.neto)}</td>
                <td className={tono(o.pctCapital)}>{pct(o.pctCapital, 2)}</td>
                <td className={tono(o.acumulado)}>{eur(o.acumulado)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {mostradas < filas.length && <button className="chip tortugas-mas" onClick={onMas}>Mostrar 50 más</button>}
    </div>
  )
}
