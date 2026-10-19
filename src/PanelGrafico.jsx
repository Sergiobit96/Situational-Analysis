import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { createChart, CandlestickSeries, CrosshairMode } from 'lightweight-charts'
import { crearHerramientasDibujo } from './chartDrawingTools'
import { madridOffsetAt } from './timezone'
import { leerDibujos, guardarDibujos } from './dibujosApi'
import { meterVelaEnDirecto } from './velaEnDirecto'
import { conClaveBot, urlConClaveBot } from './claveBot'
import { TEMPORALIDADES, claveDibujosDe, configDe, nombreDe, fuentesDe, esMercadoIg, decimalesDe } from './graficoConfig'

// Un gráfico de la pestaña Gráfico: instrumento, temporalidad y fuente propios, que va
// pidiendo histórico al servidor según se desplaza hacia la izquierda. La pestaña pone uno
// o varios en rejilla (Grafico.jsx) y su barra actúa sobre el que esté activo.

// Velas que quedan a la izquierda de la pantalla cuando se pide la página anterior: con
// margen suficiente para que llegue antes de que el usuario toque el borde
const MARGEN_CARGA = 60

// El servidor da las horas en UTC y el gráfico las pinta tal cual, así que se desplazan a
// hora de Madrid. La madrugada en que se atrasa el reloj en octubre dos velas caen en la
// misma hora de reloj: se juntan en una, porque la librería no admite horas repetidas.
function aHoraMadrid(velas) {
  const out = []
  for (const v of velas) {
    const time = v.time + madridOffsetAt(v.time)
    const prev = out[out.length - 1]
    if (prev && time <= prev.time) {
      prev.high  = Math.max(prev.high, v.high)
      prev.low   = Math.min(prev.low, v.low)
      prev.close = v.close
      continue
    }
    out.push({ time, open: v.open, high: v.high, low: v.low, close: v.close })
  }
  return out
}

// Índice de la vela con esa hora (o -1) en una serie ordenada
function indiceDe(velas, time) {
  let lo = 0, hi = velas.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (velas[mid].time === time) return mid
    if (velas[mid].time < time) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

const fmt = (n, decimales = 2) => n?.toLocaleString('es-ES', { minimumFractionDigits: decimales, maximumFractionDigits: decimales })

// Dos paneles con la misma serie de precios (el DAX a 5 min y a 1 h, por ejemplo) comparten
// dibujos. Cuando uno guarda, los demás repintan su lista: si no, al guardar después desde
// el otro, lo dibujado en el primero se perdería.
const panelesConDibujos = new Set()   // { clave, aplicar(lista) }

// `registrar` recibe los mandos del panel (modo de dibujo, borrar, reintentar) para que la
// barra de la pestaña los use cuando este panel es el activo; null al desmontarse.
export default function PanelGrafico({ config, activo, conMarco, onActivar, onCambiar, onModo, registrar }) {
  const { ticker, tf, fuente } = configDe(config)
  const [estado, setEstado] = useState({ cargando: true, error: null, fuente: null, n: 0, hayMas: true, aviso: null })
  const [leyenda, setLeyenda] = useState(null)
  const [errorDibujos, setErrorDibujos] = useState(null)
  const [vivo, setVivo] = useState(null)   // hora del último precio en directo
  const [decimales, setDecimales] = useState(2)
  // el gráfico pasó solo a MT5 o a IG porque Dukascopy no dio nada: { ticker, fuente, motivo }
  const [respaldo, setRespaldo] = useState(null)
  const contenedorRef = useRef(null)
  const reintentarRef = useRef(null)
  // Los dibujos son de la serie de precios y se ven en todas las temporalidades, como en TradingView
  const claveDibujos = claveDibujosDe(ticker, fuente)
  const conIg = fuente !== 'ig' && fuentesDe(ticker).some(f => f.id === 'ig')
  const conMt5 = fuente !== 'mt5' && fuentesDe(ticker).some(f => f.id === 'mt5')

  // Si Dukascopy no da ni la primera página (suele ser su 429), el gráfico pasa a MT5 (en
  // local) o a IG, que tienen el mismo instrumento, en vez de quedarse en blanco. MT5 va
  // antes: IG gasta su cupo semanal de histórico, que comparte con los bots.
  const respaldoDe = conMt5 ? 'mt5' : conIg ? 'ig' : null
  const pasarARespaldo = useEffectEvent(motivo => {
    setRespaldo({ ticker, fuente: respaldoDe, motivo })
    onCambiar({ fuente: respaldoDe })
  })

  useEffect(() => {
    const contenedor = contenedorRef.current
    // un mercado suelto de IG puede ser una divisa: sus decimales salen de lo que cotiza
    let dec = 2
    setDecimales(2)
    const chart = createChart(contenedor, {
      autoSize: true,
      layout: { background: { color: '#11151d' }, textColor: '#8a93a5', fontFamily: 'Inter, sans-serif' },
      grid: { vertLines: { color: '#1a202b' }, horzLines: { color: '#1a202b' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#232a37' },
      timeScale: { borderColor: '#232a37', timeVisible: tf !== 'd1', secondsVisible: false, rightOffset: 8 },
      // los precios del eje con el mismo formato que la leyenda (25.464,68)
      localization: { locale: 'es-ES', priceFormatter: n => fmt(n, dec) },
    })
    const serie = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e', downColor: '#ef4444',
      borderUpColor: '#22c55e', borderDownColor: '#ef4444',
      wickUpColor: '#22c55e', wickDownColor: '#ef4444',
    })
    const abortar = new AbortController()

    // Hasta que llegan los dibujos guardados no se guarda nada: un dibujo hecho en ese
    // instante se guardaría solo y pisaría los demás. Se apunta y se guarda al llegar.
    let dibujosListos   = false
    let cambioPendiente = false
    const esteConDibujos = {
      clave: claveDibujos,
      // lo que manda otro panel es más nuevo que lo que esté por llegar del servidor
      aplicar: lista => { herramientas.reemplazar(lista); dibujosListos = true },
    }
    const guardar = lista => {
      setErrorDibujos(null)
      for (const p of panelesConDibujos) if (p !== esteConDibujos && p.clave === claveDibujos) p.aplicar(lista)
      guardarDibujos(claveDibujos, lista)
        .catch(err => { if (!abortar.signal.aborted) setErrorDibujos(`No se han guardado los dibujos: ${err.message}`) })
    }
    const herramientas = crearHerramientasDibujo({
      chart, series: serie, container: contenedor, onModeChange: onModo,
      onChange: lista => {
        if (dibujosListos) guardar(lista)
        else cambioPendiente = true
      },
    })
    panelesConDibujos.add(esteConDibujos)
    leerDibujos(claveDibujos, abortar.signal)
      .then(lista => {
        if (!dibujosListos) herramientas.cargar(lista)
        dibujosListos = true
        if (cambioPendiente) guardar(herramientas.exportar())
      })
      .catch(() => { /* abortada al cambiar de instrumento */ })

    let datos      = []     // velas en hora de Madrid, tal y como las pinta el gráfico
    let masAntigua = null   // hora UTC de la más antigua: de ahí hacia atrás va la página siguiente
    let hayMas     = true
    let cargando   = false
    // tras un error no se vuelve a pedir solo al desplazarse (sería martillear al feed
    // justo cuando limita): hace falta pulsar Reintentar
    let parado     = false

    const leyendaDe = vela => {
      if (!vela) return null
      const i      = indiceDe(datos, vela.time)
      const previo = i > 0 ? datos[i - 1].close : vela.open
      const cambio = vela.close - previo
      return { ...vela, cambio, pct: (cambio / previo) * 100 }
    }

    async function cargar(hasta) {
      cargando = true
      setEstado(e => ({ ...e, cargando: true, error: null }))
      try {
        const qs = new URLSearchParams({ ticker, tf, fuente })
        if (hasta) qs.set('hasta', hasta)
        // lo de IG, en producción, va con la clave del bot
        const r = await fetch(`/api/grafico/velas?${qs}`, { signal: abortar.signal, headers: fuente === 'ig' ? conClaveBot() : {} })
        const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
        if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`)

        hayMas = j.hayMas
        if (j.velas.length) {
          masAntigua = j.velas[0].time
          const nuevas = aHoraMadrid(j.velas)
          if (!datos.length && esMercadoIg(ticker)) {
            dec = decimalesDe(nuevas.at(-1).close)
            serie.applyOptions({ priceFormat: { type: 'price', precision: dec, minMove: 1 / 10 ** dec } })
            setDecimales(dec)
          }
          datos = datos.length ? [...nuevas.filter(v => v.time < datos[0].time), ...datos] : nuevas
          serie.setData(datos)
        }
        if (!hasta) setLeyenda(leyendaDe(datos[datos.length - 1]))
        if (!hasta && j.directo) abrirDirecto()
        parado = false
        setEstado({ cargando: false, error: null, fuente: j.fuente, n: datos.length, hayMas, aviso: j.aviso ?? null })
        // el aviso del paso a MT5 o IG solo vale para ese instrumento, mientras siga ahí
        if (!hasta) setRespaldo(r => (r && (r.ticker !== ticker || fuente !== r.fuente) ? null : r))
      } catch (err) {
        if (err.name === 'AbortError') return
        if (fuente === 'duka' && !hasta && !datos.length && respaldoDe) { pasarARespaldo(err.message); return }
        parado = true
        setEstado(e => ({ ...e, cargando: false, error: err.message }))
      } finally {
        cargando = false
      }
    }
    reintentarRef.current = () => cargar(masAntigua ?? undefined)

    // En directo (IG y MT5): llegan velas de 1 min que amplían la última del gráfico o abren la
    // siguiente. El EventSource se reconecta solo si se corta, y al volver el servidor
    // manda las últimas cinco para cubrir el hueco.
    let directo = null
    let encima  = false   // con el ratón sobre una vela, la leyenda enseña esa y no la última
    const segundosVela = (TEMPORALIDADES.find(t => t.id === tf)?.minutos ?? 1) * 60
    setVivo(null)
    function abrirDirecto() {
      if (directo) return
      directo = new EventSource(urlConClaveBot(`/api/tiempo-real/stream?${new URLSearchParams({ fuente, ticker })}`))
      directo.addEventListener('velas', e => {
        let ultima = null
        for (const v of JSON.parse(e.data)) {
          const enMadrid = { ...v, time: v.time + madridOffsetAt(v.time) }
          const cambiada = meterVelaEnDirecto(datos, enMadrid, segundosVela)
          if (cambiada) { serie.update(cambiada); ultima = cambiada }
        }
        if (!ultima) return
        if (!encima) setLeyenda(leyendaDe(ultima))
        setVivo(Date.now())
      })
    }

    chart.timeScale().subscribeVisibleLogicalRangeChange(rango => {
      if (!rango || cargando || parado || !hayMas || !datos.length) return
      if (rango.from < MARGEN_CARGA) cargar(masAntigua)
    })

    // Encima del gráfico, los datos de la vela bajo el cursor (o de la última si no hay)
    chart.subscribeCrosshairMove(param => {
      encima = !!param.time
      const vela = param.time ? param.seriesData.get(serie) : datos[datos.length - 1]
      setLeyenda(leyendaDe(vela))
    })

    registrar?.({
      setMode:   m => herramientas.setMode(m),
      cuantos:   () => herramientas.cuantos(),
      clearAll:  () => herramientas.clearAll(),
      reintentar: () => reintentarRef.current?.(),
    })

    cargar()

    return () => {
      registrar?.(null)
      panelesConDibujos.delete(esteConDibujos)
      directo?.close()
      abortar.abort()
      reintentarRef.current = null
      herramientas.dispose()
      chart.remove()
    }
  }, [ticker, tf, fuente, claveDibujos, respaldoDe, onModo, registrar])

  const sube = leyenda && leyenda.cambio >= 0

  return (
    <div
      className={`grafico-panel ${conMarco ? 'con-marco' : ''} ${conMarco && activo ? 'activo' : ''}`}
      onMouseDownCapture={onActivar}
    >
      <div className="grafico-pro-lienzo">
        <div ref={contenedorRef} className="grafico-pro-chart" />
        {leyenda && (
          <div className="grafico-pro-leyenda">
            <strong>{nombreDe(ticker)} · {TEMPORALIDADES.find(t => t.id === tf)?.label}</strong>
            <span>O <b>{fmt(leyenda.open, decimales)}</b></span>
            <span>H <b>{fmt(leyenda.high, decimales)}</b></span>
            <span>L <b>{fmt(leyenda.low, decimales)}</b></span>
            <span>C <b>{fmt(leyenda.close, decimales)}</b></span>
            <span className={sube ? 'sube' : 'baja'}>
              {sube ? '+' : ''}{fmt(leyenda.cambio, decimales)} ({sube ? '+' : ''}{fmt(leyenda.pct)}%)
            </span>
          </div>
        )}
      </div>

      {/* .grafico-pro-estado se mantiene: la busca la prueba de navegador del directo de IG */}
      <div className="grafico-pro-estado grafico-panel-estado">
        {errorDibujos && <span className="grafico-pro-error">{errorDibujos}</span>}
        {estado.error ? (
          <>
            <span className="grafico-pro-error" title={estado.error}>{estado.error}</span>
            <button className="dibujo-btn" onClick={() => reintentarRef.current?.()}>Reintentar</button>
            {fuente === 'duka' && conMt5 && (
              <button className="dibujo-btn" onClick={() => onCambiar({ fuente: 'mt5' })}>Ver con MT5</button>
            )}
            {fuente === 'duka' && conIg && (
              <button className="dibujo-btn" onClick={() => onCambiar({ fuente: 'ig' })}>Ver con IG</button>
            )}
            {fuente === 'duka' && (
              <button className="dibujo-btn" onClick={() => onCambiar({ fuente: 'yahoo' })}>Ver con Yahoo</button>
            )}
          </>
        ) : estado.cargando ? 'Cargando…' : (
          <>
            {respaldo?.ticker === ticker && fuente === respaldo.fuente && (
              <>
                <span className="grafico-pro-respaldo" title={respaldo.motivo}>Dukascopy no responde: se ve con {respaldo.fuente === 'mt5' ? 'MT5' : 'IG'}</span>
                <button className="dibujo-btn" onClick={() => { setRespaldo(null); onCambiar({ fuente: 'duka' }) }}>Volver a Dukascopy</button>
              </>
            )}
            <span className="grafico-panel-datos">
              {estado.n.toLocaleString('es-ES')} velas · {estado.fuente}
              {!estado.hayMas && ` · ${estado.aviso ?? 'inicio del histórico'}`}
              {estado.hayMas && estado.aviso && ` · ${estado.aviso}`}
            </span>
            {vivo && (
              <span className="grafico-pro-vivo" title="Hora del último precio recibido">
                ● en directo · {new Date(vivo).toLocaleTimeString('es-ES')}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  )
}
