import { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, AreaSeries, HistogramSeries, PriceScaleMode, CrosshairMode } from 'lightweight-charts'
import { madridOffsetAt } from './timezone'
import {
  INDICES_TORTUGAS, TICKER_TIPO, CONFIG_TORTUGAS, prepararMercado, backtestTortugas,
  metricasTortugas, curvaConDrawdown, rentabilidadAnual, resumenPorIndice, porUnidades, ordenesManana, peorHastaStops, sistemasDe,
} from './tortugas'
import './Tortugas.css'

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

const datosEnCache = () => Object.fromEntries(
  [...cacheDiario].filter(([, v]) => Date.now() - v.cuando < VIGENCIA_MS).map(([t, v]) => [t, v.velas]),
)

// ── Ajustes ─────────────────────────────────────────────────────────────────

const AJUSTES_INICIALES = {
  indices: INDICES_TORTUGAS.map(i => i.id),
  lados: CONFIG_TORTUGAS.lados,
  riesgo: 100 * CONFIG_TORTUGAS.riesgo,
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
const CLAVE_LS = 'sa.tortugas'

function leerAjustes() {
  try {
    const guardados = JSON.parse(localStorage.getItem(CLAVE_LS) ?? 'null')
    return guardados ? { ...AJUSTES_INICIALES, ...guardados } : AJUSTES_INICIALES
  } catch {
    return AJUSTES_INICIALES
  }
}

const LADOS = [
  { v: 'largos', label: 'Solo largos', nota: 'En índices los cortos pagan el dividendo y la financiación y van contra la deriva alcista' },
  { v: 'ambos', label: 'Largos y cortos', nota: 'Simétrico, como las tortugas originales' },
  { v: 'cortos', label: 'Solo cortos', nota: 'Solo las rupturas a la baja' },
]
const RIESGOS = [0.1, 0.2, 0.3, 0.5, 1]
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
function Numero({ valor, onCambio, min, max, step = 1, titulo }) {
  return (
    <input
      key={valor}
      className="pag-input filtro-pct"
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
  const [ajustes, setAjustes] = useState(leerAjustes)
  const [datos, setDatos] = useState(datosEnCache)
  const [cargando, setCargando] = useState(false)
  const [progreso, setProgreso] = useState(null)
  const [error, setError] = useState(null)
  const [variantes, setVariantes] = useState(null)
  const [comparando, setComparando] = useState(false)
  const [mostradas, setMostradas] = useState(25)
  const abortRef = useRef(null)

  useEffect(() => () => abortRef.current?.abort(), [])
  useEffect(() => {
    try { localStorage.setItem(CLAVE_LS, JSON.stringify(ajustes)) } catch { /* sin almacenamiento */ }
  }, [ajustes])

  const poner = (campo, valor) => setAjustes(a => ({ ...a, [campo]: valor }))
  const alternarIndice = id => setAjustes(a => {
    const s = new Set(a.indices)
    if (s.has(id)) { if (s.size > 1) s.delete(id) } else s.add(id)
    return { ...a, indices: INDICES_TORTUGAS.map(i => i.id).filter(x => s.has(x)) }
  })

  const cfg = useMemo(() => ({
    ...CONFIG_TORTUGAS,
    sistema,
    lados: ajustes.lados,
    riesgo: ajustes.riesgo / 100,
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
  }), [ajustes, sistema])
  const claveCfg = JSON.stringify([cfg, ajustes.indices])

  // los indicadores solo dependen de los datos: se calculan una vez por índice
  const preparados = useMemo(() => {
    const r = {}
    for (const info of INDICES_TORTUGAS) {
      if (datos[info.ticker]) r[info.id] = prepararMercado(info, sinSesionEnCurso(info, datos[info.ticker]))
    }
    return r
  }, [datos])
  const tipos = datos[TICKER_TIPO] ?? null
  const mercados = useMemo(() => ajustes.indices.map(id => preparados[id]).filter(Boolean), [preparados, ajustes.indices])
  const faltan = ajustes.indices.filter(id => !preparados[id])

  const res = useMemo(() => mercados.length ? backtestTortugas(mercados, tipos, cfg) : null, [mercados, tipos, cfg])
  const m = useMemo(() => res && metricasTortugas(res), [res])
  const ordenes = useMemo(() => res ? ordenesManana(res, ajustes.capital) : [], [res, ajustes.capital])

  async function cargar() {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setCargando(true)
    setError(null)
    const tickers = [...INDICES_TORTUGAS.filter(i => ajustes.indices.includes(i.id)).map(i => i.ticker), TICKER_TIPO]
    setProgreso({ hechos: 0, total: tickers.length })
    const nuevos = {}
    const fallos = []
    let siguiente = 0
    // de tres en tres: cada índice son cuatro peticiones a Yahoo desde el servidor
    const trabajador = async () => {
      while (siguiente < tickers.length && !ctrl.signal.aborted) {
        const t = tickers[siguiente++]
        try {
          nuevos[t] = await bajarDiario(t, ctrl.signal)
        } catch (e) {
          if (e.name !== 'AbortError') fallos.push(e.message)
        }
        setProgreso(p => p && { ...p, hechos: p.hechos + 1 })
      }
    }
    await Promise.all([trabajador(), trabajador(), trabajador()])
    if (ctrl.signal.aborted) return
    setDatos(d => ({ ...d, ...nuevos }))
    if (fallos.length) setError(`No se pudieron bajar: ${fallos.join(' · ')}`)
    setCargando(false)
    setProgreso(null)
    setMostradas(25)
  }

  function comparar() {
    setComparando(true)
    // un respiro para que se pinte el aviso antes de los doce backtests
    setTimeout(() => {
      const unidades = [...new Set([1, 4, cfg.maxUnidades])].sort((a, b) => a - b)
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
  const peor = peorHastaStops({
    grupos: Object.values(INDICES_TORTUGAS.filter(i => ajustes.indices.includes(i.id)).reduce((n, i) => ({ ...n, [i.grupo]: (n[i.grupo] ?? 0) + 1 }), {})),
    maxUnidades: ajustes.maxUnidades, maxGrupo: ajustes.maxGrupo, maxSentido: ajustes.maxSentido,
    sistemas: sistemasDe(sistema).length,
  })
  // la N y la unidad son las mismas para los dos sistemas: una caja por índice
  const nPorIndice = ordenes.filter((f, k) => ordenes.findIndex(x => x.indice === f.indice) === k)

  return (
    <div className="estrategia-panel tortugas">
      <div className="filtro-controls">
        <div className="filtro-group">
          <label className="filtro-label">
            Índices
            <span className="filtro-valor">{ajustes.indices.length} de {INDICES_TORTUGAS.length} · la ventaja sale de diversificar</span>
          </label>
          <div className="filtro-presets">
            {INDICES_TORTUGAS.map(i => (
              <button key={i.id} className={`chip ${ajustes.indices.includes(i.id) ? 'activo' : ''}`}
                title={`${i.ticker} · grupo ${i.grupo} · datos desde ${i.desde.slice(0, 4)}`}
                onClick={() => alternarIndice(i.id)}>{i.nombre}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Lados
            <span className="filtro-valor">{LADOS.find(l => l.v === ajustes.lados)?.nota}</span>
          </label>
          <div className="filtro-presets"><Chips opciones={LADOS} valor={ajustes.lados} onCambio={v => poner('lados', v)} /></div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Riesgo por N y unidad
            <span className="filtro-valor">
              1 N en contra cuesta {nf(ajustes.riesgo, 2)} % del capital por unidad ({nf(ajustes.riesgo * peor.unidades, 1)} % con las {peor.unidades} unidades que caben a la vez{ajustes.lados === 'ambos' ? ' en cada sentido' : ''}).
              Hasta el stop, a {nf(CONFIG_TORTUGAS.stopN)} N, una unidad recién entrada pierde {nf(ajustes.riesgo * CONFIG_TORTUGAS.stopN, 2)} %;
              como el stop sube con cada añadido, lo peor si saltan a la vez todos los stops{ajustes.lados === 'ambos' ? ' de un sentido' : ''} es un {nf(ajustes.riesgo * peor.n, 1)} % (sin contar los huecos, que pueden pasarlos)
            </span>
          </label>
          <div className="filtro-presets">
            <Chips opciones={RIESGOS.map(r => ({ v: r, label: `${nf(r, 1)} %`, nota: r === 1 ? 'El de las tortugas, pensado para futuros poco correlacionados' : undefined }))}
              valor={ajustes.riesgo} onCambio={v => poner('riesgo', v)} />
            <Numero valor={ajustes.riesgo} min={0.01} max={5} step={0.05} titulo="% del capital por N y unidad" onCambio={v => poner('riesgo', v)} />
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Pirámide
            <span className="filtro-valor">
              hasta {ajustes.maxUnidades} unidad{ajustes.maxUnidades === 1 ? '' : 'es'} por índice{juntos ? ' y sistema' : ''}, contando la entrada: una más cada ½ N a favor
            </span>
          </label>
          <div className="filtro-presets">
            <Chips opciones={UNIDADES.map(u => ({ v: u, label: u === 1 ? 'Sin pirámide' : `${u} u`, nota: u === 4 ? 'Como las tortugas' : u === 7 ? 'Entrada + 6 añadidos' : undefined }))}
              valor={ajustes.maxUnidades} onCambio={v => poner('maxUnidades', v)} />
            <Numero valor={ajustes.maxUnidades} min={1} max={12} titulo="Unidades máximas por índice" onCambio={v => poner('maxUnidades', Math.round(v))} />
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Límites de cartera
            <span className="filtro-valor">unidades por grupo (EE. UU., Europa, Asia) y por sentido en total</span>
          </label>
          <div className="filtro-presets tortugas-limites">
            <span>grupo</span>
            <Numero valor={ajustes.maxGrupo} min={1} max={60} titulo="Unidades máximas por grupo y sentido" onCambio={v => poner('maxGrupo', Math.round(v))} />
            <span>sentido</span>
            <Numero valor={ajustes.maxSentido} min={1} max={100} titulo="Unidades máximas por sentido" onCambio={v => poner('maxSentido', Math.round(v))} />
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Overnight
            <span className="filtro-valor">
              {ajustes.financiacion
                ? `cada noche el largo paga tipo a 3 meses + ${nf(ajustes.recargo, 1)} % menos el dividendo (el viernes, 3 noches)`
                : 'sin coste por dormir con la posición: lo que se ganaría con un futuro sin base'}
            </span>
          </label>
          <div className="filtro-presets">
            <button className={`chip ${!ajustes.financiacion ? 'activo' : ''}`} onClick={() => poner('financiacion', false)}>Sin coste</button>
            {RECARGOS.map(r => (
              <button key={r} className={`chip ${ajustes.financiacion && ajustes.recargo === r ? 'activo' : ''}`}
                title={r === 2.5 ? 'El recargo de IG en índices' : undefined}
                onClick={() => setAjustes(a => ({ ...a, financiacion: true, recargo: r }))}>tipo + {nf(r, 1)} %</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Deslizamiento
            <span className="filtro-valor">en cada relleno, además de medio spread; los huecos de la noche se llenan a la apertura</span>
          </label>
          <div className="filtro-presets">
            <Chips opciones={DESLICES.map(d => ({ v: d, label: d === 0 ? 'Ninguno' : `${nf(d, 2)} N` }))} valor={ajustes.deslizN} onCambio={v => poner('deslizN', v)} />
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">Filtros</label>
          <div className="filtro-presets">
            <Chips opciones={[{ v: 0, label: 'Sin media' }, { v: 200, label: 'A favor de la media 200', nota: 'Largos solo por encima de la media de 200 sesiones; cortos, por debajo' }]}
              valor={ajustes.media} onCambio={v => poner('media', v)} />
            <button className={`chip ${ajustes.reduccionDD ? 'activo' : ''}`}
              title="Por cada 10 % de caída desde el máximo, opera con un capital nominal un 20 % menor (regla de las tortugas)"
              onClick={() => poner('reduccionDD', !ajustes.reduccionDD)}>Reducir en drawdown</button>
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Periodo y capital
            <span className="filtro-valor">el capital da el tamaño de las órdenes de mañana</span>
          </label>
          <div className="filtro-presets">
            <select className="filtro-otros" value={ajustes.desde} onChange={e => poner('desde', Number(e.target.value))}>
              {ANIOS.map(a => <option key={a} value={a}>desde {a}</option>)}
            </select>
            <Numero valor={ajustes.capital} min={1000} max={100_000_000} step={1000} titulo="Capital en €" onCambio={v => poner('capital', v)} />
          </div>
        </div>

        <button className="btn-filtrar" onClick={cargar} disabled={cargando}>
          {cargando ? 'Descargando…' : res && !faltan.length ? 'Actualizar datos' : 'Cargar datos y probar'}
        </button>
        {cargando && progreso && (
          <div className="velas-cargando">
            <span className="spinner" />
            Diario de Yahoo… {progreso.hechos}/{progreso.total}
          </div>
        )}
        {error && <div className="error-global">{error}</div>}
      </div>

      {!res && !cargando && (
        <div className="estr-vacio">
          <p className="estr-vacio-tit">Pulsa <strong>Cargar datos y probar</strong></p>
          <p className="estr-vacio-sub">
            Baja el diario de Yahoo de cada índice desde 1988 (unos segundos) y, a partir de ahí, cada ajuste recalcula al momento.
          </p>
        </div>
      )}

      {res && m && (
        <div className="estr-resultados">
          {faltan.length > 0 && (
            <p className="estr-nota tortugas-aviso">
              Faltan los datos de {faltan.join(', ')}: pulsa <strong>Cargar datos y probar</strong> para incluirlos.
            </p>
          )}
          <Resumen m={m} res={res} />
          <NDeHoy filas={nPorIndice} paso={res.cfg.paso} stopN={res.cfg.stopN} />
          <CurvaTortugas res={res} />
          <Anual res={res} />
          <PorIndice res={res} />
          <Piramide res={res} />
          <Variantes variantes={variantes} vigente={variantes?.clave === claveCfg} comparando={comparando} onComparar={comparar} />
          <Ordenes filas={ordenes} juntos={juntos} capital={ajustes.capital} ultimoDato={ultimoDato} />
          <Operaciones res={res} mostradas={mostradas} onMas={() => setMostradas(n => n + 50)} />
          <p className="estr-nota">
            Velas diarias del contado (Yahoo). Las órdenes son stop y se ejecutan en su nivel, o en la apertura si la
            noche ya lo ha saltado; dentro de la vela se supone el camino apertura → mínimo → máximo → cierre si cierra
            por encima de la apertura, y al revés si no. El tipo de la financiación es la letra del Tesoro de EE. UU. a
            3 meses para todos los índices (el euro estuvo en negativo de 2015 a 2022). Yahoo trae el FTSE siempre con
            la apertura igual al cierre anterior, y el S&P y el Russell así en muchas sesiones antes de 2007: ahí el
            hueco de la noche no se ve. Los CFD cotizan casi 24 h, así que un stop puede saltar de noche en un nivel que
            el contado no llega a marcar.
          </p>
        </div>
      )}
    </div>
  )
}

// ── Resultados ──────────────────────────────────────────────────────────────

function Resumen({ m, res }) {
  const tiles = [
    { label: 'Capital final', valor: eur(m.capitalFinal), sub: `desde ${eur(res.cfg.capital)} el ${dia(res.curva[0].date)}` },
    { label: 'Rentabilidad anual', valor: pct(m.cagr), sub: 'compuesta (CAGR)', marca: m.cagr >= 0 ? '▲' : '▼', tono: m.cagr >= 0 ? 'verde' : 'rojo' },
    { label: 'Máximo drawdown', valor: pct(m.maxDD), sub: m.peorDD ? `${dia(m.peorDD.desde)} → ${dia(m.peorDD.hasta)}` : '—', marca: '▼', tono: 'rojo' },
    { label: 'Rentabilidad / drawdown', valor: nf(m.mar, 2), sub: `MAR · Sharpe ${nf(m.sharpe, 2)}` },
    { label: 'Más tiempo sin máximos', valor: `${nf(m.ddMasLargo, 1)} años`, sub: 'el drawdown más largo' },
    { label: 'Operaciones', valor: nf(m.operaciones), sub: `${nf(m.acierto, 1)} % ganadoras · ${nf(m.diasMedios, 0)} días de media` },
    { label: 'Profit factor', valor: nf(m.profitFactor, 2), sub: `la ganadora media es ${nf(m.ganadoraPerdedora, 1)} veces la perdedora` },
    { label: 'Financiación overnight', valor: eur(-m.financiacion), sub: `${nf(m.financiacionPct, 1)} % de lo ganado en bruto` },
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
function NDeHoy({ filas, paso, stopN }) {
  return (
    <div className="estr-resumen">
      <div className="tortugas-cabecera">
        <strong>N de cada índice</strong>
        <span className="estr-nota">ATR de Wilder de 20 sesiones, al último cierre</span>
      </div>
      <div className="tortugas-n">
        {filas.map(f => (
          <div key={f.indice} className="tortugas-n-caja" title={`${f.nombre} · cierre ${nf(f.cierre, 2)} el ${dia(f.ultimoDia)}`}>
            <span className="tortugas-n-nombre">{f.nombre}</span>
            <span className="tortugas-n-valor">{nf(f.n, 1)} <small>pts</small></span>
            <span className="tortugas-n-sub">{nf(100 * f.n / f.cierre, 2)} % del precio</span>
            <span className="tortugas-n-sub">añade cada {nf(paso * f.n, 1)} pts</span>
            <span className="tortugas-n-sub">stop a {nf(stopN * f.n, 1)} pts</span>
            <span className="tortugas-n-sub">unidad {nf(f.unidad, 2)} €/pt</span>
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
    capital.setData(puntos.map(p => ({ time: p.date, value: p.valor })))
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

function PorIndice({ res }) {
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
              <th>Por índice</th><th>Desde</th><th>Operaciones</th><th>Ganadoras</th><th>Neto</th>
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
        Comprar y mantener es el índice de precio, sin dividendos (salvo el DAX, que los incluye), en el mismo periodo:
        sirve de referencia para la rentabilidad y, sobre todo, para la caída.
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

function Variantes({ variantes, vigente, comparando, onComparar }) {
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
        Los dos sistemas, por separado y juntos (el 2 con las rupturas que el 1 se salta), con y sin cortos y con distintas pirámides, con el resto de ajustes como están.
        La fila resaltada es la que se ve arriba. Fíjate más en el MAR (rentabilidad anual entre el peor drawdown)
        que en la rentabilidad: subir el riesgo sube las dos cosas a la vez.
      </p>
    </div>
  )
}

function Ordenes({ filas, juntos, capital, ultimoDato }) {
  const nivel = o => o ? `${nf(o.nivel, 2)}${o.k ? ` (${o.k})` : ' (añadido)'}` : ''
  const fuera = f => {
    if (!juntos) return f.filtro ? 'fuera · la última de 20 ganó: espera la de 55' : 'fuera'
    if (f.sistema === 1) return f.filtro ? 'fuera · la última de 20 ganó: se la salta y la coge el S2' : 'fuera'
    return f.compra || f.venta ? 'fuera · el S1 se salta la de 20: entra en la de 55' : 'fuera · solo entra si el S1 se salta la ruptura'
  }
  return (
    <div className="estr-resumen">
      <div className="tortugas-cabecera">
        <strong>Órdenes stop para la próxima sesión</strong>
        <span className="estr-nota">con el último cierre de cada índice ({dia(ultimoDato)} el más reciente) y {eur(capital)}</span>
      </div>
      <div className="tortugas-tabla-wrap">
        <table className="estr-mitades-tabla tortugas-tabla">
          <thead>
            <tr><th>Índice</th>{juntos && <th>Sistema</th>}<th>Cierre</th><th>N</th><th>Unidad</th><th>Posición</th><th>Compra stop</th><th>Venta stop</th><th>Salida stop</th></tr>
          </thead>
          <tbody>
            {filas.map(f => (
              <tr key={`${f.indice}-${f.sistema}`}>
                <th>{f.nombre}</th>
                {juntos && <td>S{f.sistema}</td>}
                <td title={dia(f.ultimoDia)}>{nf(f.cierre, 2)}</td>
                <td>{nf(f.n, 1)}</td>
                <td>{nf(f.unidad, 2)} €/pt</td>
                <td className="tortugas-izq">
                  {f.posicion
                    ? `${f.posicion.lado} · ${f.posicion.unidades} u desde ${dia(f.posicion.desde)} · medio ${nf(f.posicion.medio, 1)}`
                    : fuera(f)}
                </td>
                <td>{nivel(f.compra)}</td>
                <td>{nivel(f.venta)}</td>
                <td>{f.salida != null ? nf(f.salida, 2) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="estr-nota">
        Es la posición que tendría hoy el backtest. Entre paréntesis, las sesiones de la ruptura. La salida es el más
        cercano entre el stop de 2 N y el canal contrario{juntos ? ' (de 10 en el S1 y de 20 en el S2)' : ''}. La unidad es riesgo · capital / N: si sale por debajo del
        mínimo del broker, hace falta más capital o más riesgo por unidad.
      </p>
    </div>
  )
}

function Operaciones({ res, mostradas, onMas }) {
  const filas = useMemo(() => [...res.abiertas, ...[...res.operaciones].reverse()], [res])
  const juntos = res.cfg.sistema === '1+2'
  return (
    <div className="estr-resumen">
      <div className="tortugas-cabecera">
        <strong>Operaciones</strong>
        <span className="estr-nota">{nf(res.operaciones.length)} cerradas{res.abiertas.length ? ` y ${res.abiertas.length} abierta${res.abiertas.length === 1 ? '' : 's'}` : ''}, de la más reciente a la más antigua</span>
      </div>
      <div className="tortugas-tabla-wrap">
        <table className="estr-mitades-tabla tortugas-tabla">
          <thead>
            <tr><th>Índice</th>{juntos && <th title="S1: ruptura de 20, salida en la de 10 · S2: la de 55 que el S1 se salta, salida en la de 20">Sistema</th>}<th>Lado</th><th>Entrada</th><th>Salida</th><th>Días</th><th title="N al entrar: de él salen los añadidos y el stop">N</th><th>Unidades</th><th title="Todas las unidades juntas, en € por punto">Tamaño</th><th title="Tamaño por precio medio de entrada">Nominal</th><th>Precio medio</th><th>Precio salida</th><th>Motivo</th><th>Neto</th><th>Financiación</th><th>% capital</th></tr>
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
                <td>{nf(o.n, 1)}</td>
                <td>{o.unidades}</td>
                <td title={o.tamanos.length > 1 ? `Unidades: ${o.tamanos.map(t => nf(t, 2)).join(' + ')} €/pt` : undefined}>{nf(o.tamano, 2)} €/pt</td>
                <td>{eur(o.nominal)}</td>
                <td>{nf(o.precioEntrada, 1)}</td>
                <td>{nf(o.precioSalida, 1)}</td>
                <td>{o.motivo === 'abierta' ? '—' : o.motivo}</td>
                <td className={tono(o.neto)}>{eur(o.neto)}</td>
                <td>{eur(-o.financiacion)}</td>
                <td className={tono(o.pctCapital)}>{pct(o.pctCapital, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {mostradas < filas.length && <button className="chip tortugas-mas" onClick={onMas}>Mostrar 50 más</button>}
    </div>
  )
}
