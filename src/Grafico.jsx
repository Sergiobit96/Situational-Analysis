import { useEffect, useRef, useState } from 'react'
import { createChart, CandlestickSeries, CrosshairMode } from 'lightweight-charts'
import { crearHerramientasDibujo, HERRAMIENTAS_DIBUJO } from './chartDrawingTools'
import { INSTRUMENTOS } from './intradayApi'
import { madridOffsetAt } from './timezone'
import { leerDibujos, guardarDibujos } from './dibujosApi'

// Pestaña Gráfico: un gráfico a pantalla completa con instrumento y temporalidad a elegir,
// que va pidiendo histórico al servidor según se desplaza hacia la izquierda.

const TEMPORALIDADES = [
  { id: 'm1',  label: '1m' },
  { id: 'm5',  label: '5m' },
  { id: 'm15', label: '15m' },
  { id: 'm30', label: '30m' },
  { id: 'h1',  label: '1h' },
  { id: 'h4',  label: '4h' },
  { id: 'd1',  label: 'D' },
]

// Velas que quedan a la izquierda de la pantalla cuando se pide la página anterior: con
// margen suficiente para que llegue antes de que el usuario toque el borde
const MARGEN_CARGA = 60

const PREFS = 'sa.grafico'
function leerPrefs() {
  try { return { ticker: '^GDAXI', tf: 'm15', fuente: 'duka', ...JSON.parse(localStorage.getItem(PREFS)) } }
  catch { return { ticker: '^GDAXI', tf: 'm15', fuente: 'duka' } }
}

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

const fmt = n => n?.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const FUENTES = [
  { id: 'duka',  label: 'Dukascopy', title: 'CFD de Dukascopy: 24 h y años de histórico' },
  { id: 'yahoo', label: 'Yahoo',     title: 'Contado de los índices (oro, plata y petróleo, con el futuro). Hasta 30 días a 1m, 60 días de 5 a 30m, 2 años en 1h y 4h, y el diario completo' },
  { id: 'csv',   label: 'CSV cash',  title: 'Tu CSV del DAX cash a 5 min: solo sesión, desde 2009' },
]

// Yahoo no da el spot de estos: los sirve con el futuro (GC=F, SI=F y CL=F en el servidor)
const CON_FUTURO_EN_YAHOO = new Set(['XAUUSD', 'XAGUSD', 'USOIL'])

// Los dibujos van con la serie de precios, no con la fuente: el CSV y Yahoo dan el mismo
// contado del DAX (coinciden al céntimo) y los comparten; el CFD de Dukascopy y los futuros
// de Yahoo cotizan a otro precio y llevan los suyos.
function claveDibujosDe(ticker, fuente) {
  if (fuente === 'duka') return ticker
  if (fuente === 'yahoo' && CON_FUTURO_EN_YAHOO.has(ticker)) return `${ticker}@futuro`
  return `${ticker}@contado`
}

export default function Grafico() {
  const [prefs, setPrefs] = useState(leerPrefs)
  const [estado, setEstado] = useState({ cargando: true, error: null, fuente: null, n: 0, hayMas: true, aviso: null })
  const [leyenda, setLeyenda] = useState(null)
  const [modo, setModo] = useState('cursor')
  const [errorDibujos, setErrorDibujos] = useState(null)
  const contenedorRef = useRef(null)
  const dibujoRef     = useRef(null)
  const reintentarRef = useRef(null)

  // El CSV del DAX cash solo existe en local, y va a 5 min: sin él, Dukascopy; en 1 min, 5 min
  const hayCsv = import.meta.env.DEV && prefs.ticker === '^GDAXI'
  const elegida = FUENTES.some(f => f.id === prefs.fuente) ? prefs.fuente : 'duka'
  const fuente = elegida === 'csv' && !hayCsv ? 'duka' : elegida
  const tf     = fuente === 'csv' && prefs.tf === 'm1' ? 'm5' : prefs.tf
  const { ticker } = prefs
  // Los dibujos son de la serie de precios y se ven en todas las temporalidades, como en TradingView
  const claveDibujos = claveDibujosDe(ticker, fuente)

  const cambiar = cambio => setPrefs(p => {
    const nuevo = { ...p, ...cambio }
    try { localStorage.setItem(PREFS, JSON.stringify(nuevo)) } catch { /* sin almacenamiento */ }
    return nuevo
  })

  useEffect(() => {
    const contenedor = contenedorRef.current
    const chart = createChart(contenedor, {
      autoSize: true,
      layout: { background: { color: '#11151d' }, textColor: '#8a93a5', fontFamily: 'Inter, sans-serif' },
      grid: { vertLines: { color: '#1a202b' }, horzLines: { color: '#1a202b' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#232a37' },
      timeScale: { borderColor: '#232a37', timeVisible: tf !== 'd1', secondsVisible: false, rightOffset: 8 },
      // los precios del eje con el mismo formato que la leyenda (25.464,68)
      localization: { locale: 'es-ES', priceFormatter: fmt },
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
    const guardar = lista => {
      setErrorDibujos(null)
      guardarDibujos(claveDibujos, lista)
        .catch(err => { if (!abortar.signal.aborted) setErrorDibujos(`No se han guardado los dibujos: ${err.message}`) })
    }
    const herramientas = crearHerramientasDibujo({
      chart, series: serie, container: contenedor, onModeChange: setModo,
      onChange: lista => {
        if (dibujosListos) guardar(lista)
        else cambioPendiente = true
      },
    })
    dibujoRef.current = herramientas
    leerDibujos(claveDibujos, abortar.signal)
      .then(lista => {
        herramientas.cargar(lista)
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
        const r = await fetch(`/api/grafico/velas?${qs}`, { signal: abortar.signal })
        const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
        if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`)

        hayMas = j.hayMas
        if (j.velas.length) {
          masAntigua = j.velas[0].time
          const nuevas = aHoraMadrid(j.velas)
          datos = datos.length ? [...nuevas.filter(v => v.time < datos[0].time), ...datos] : nuevas
          serie.setData(datos)
        }
        if (!hasta) setLeyenda(leyendaDe(datos[datos.length - 1]))
        parado = false
        setEstado({ cargando: false, error: null, fuente: j.fuente, n: datos.length, hayMas, aviso: j.aviso ?? null })
      } catch (err) {
        if (err.name === 'AbortError') return
        parado = true
        setEstado(e => ({ ...e, cargando: false, error: err.message }))
      } finally {
        cargando = false
      }
    }
    reintentarRef.current = () => cargar(masAntigua ?? undefined)

    chart.timeScale().subscribeVisibleLogicalRangeChange(rango => {
      if (!rango || cargando || parado || !hayMas || !datos.length) return
      if (rango.from < MARGEN_CARGA) cargar(masAntigua)
    })

    // Encima del gráfico, los datos de la vela bajo el cursor (o de la última si no hay)
    chart.subscribeCrosshairMove(param => {
      const vela = param.time ? param.seriesData.get(serie) : datos[datos.length - 1]
      setLeyenda(leyendaDe(vela))
    })

    cargar()

    return () => {
      abortar.abort()
      reintentarRef.current = null
      dibujoRef.current?.dispose()
      dibujoRef.current = null
      chart.remove()
    }
  }, [ticker, tf, fuente, claveDibujos])

  const nombre = INSTRUMENTOS.find(i => i.value === ticker)?.label ?? ticker
  const sube   = leyenda && leyenda.cambio >= 0

  // Ahora borrar es para siempre (los dibujos están guardados): se pide confirmación
  const borrarDibujos = () => {
    const n = dibujoRef.current?.cuantos() ?? 0
    if (n === 0) return
    const cual = claveDibujos.endsWith('@futuro') ? ' (futuro)' : claveDibujos.endsWith('@contado') ? ' (contado)' : ''
    if (window.confirm(`¿Borrar ${n === 1 ? 'el dibujo' : `los ${n} dibujos`} de ${nombre}${cual}?`)) {
      dibujoRef.current?.clearAll()
    }
  }

  return (
    <div className="grafico-pro">
      <div className="grafico-pro-barra">
        <select
          className="grafico-pro-select"
          value={ticker}
          onChange={e => cambiar({ ticker: e.target.value })}
          aria-label="Instrumento"
        >
          {INSTRUMENTOS.map(i => <option key={i.value} value={i.value}>{i.label}</option>)}
        </select>

        <div className="grafico-pro-grupo" role="group" aria-label="Temporalidad">
          {TEMPORALIDADES.map(t => (
            <button
              key={t.id}
              className={`dibujo-btn ${tf === t.id ? 'activo' : ''}`}
              disabled={fuente === 'csv' && t.id === 'm1'}
              title={fuente === 'csv' && t.id === 'm1' ? 'El CSV del DAX va a 5 minutos' : undefined}
              onClick={() => cambiar({ tf: t.id })}
            >{t.label}</button>
          ))}
        </div>

        <div className="grafico-pro-grupo" role="group" aria-label="Fuente de datos">
          {FUENTES.filter(f => f.id !== 'csv' || hayCsv).map(f => (
            <button
              key={f.id}
              className={`dibujo-btn ${fuente === f.id ? 'activo' : ''}`}
              title={f.title}
              onClick={() => cambiar({ fuente: f.id })}
            >{f.label}</button>
          ))}
        </div>

        <div className="grafico-pro-grupo" role="group" aria-label="Dibujo">
          {HERRAMIENTAS_DIBUJO.map(h => (
            <button
              key={h.id}
              className={`dibujo-btn ${modo === h.id ? 'activo' : ''}`}
              title={h.title}
              onClick={() => dibujoRef.current?.setMode(h.id)}
            >{h.icon}</button>
          ))}
          <button
            className="dibujo-btn"
            title="Borrar todos los dibujos de este instrumento"
            onClick={borrarDibujos}
          >🗑</button>
        </div>

        <div className="grafico-pro-estado">
          {errorDibujos && <span className="grafico-pro-error">{errorDibujos}</span>}
          {estado.error ? (
            <>
              <span className="grafico-pro-error">{estado.error}</span>
              <button className="dibujo-btn" onClick={() => reintentarRef.current?.()}>Reintentar</button>
              {fuente === 'duka' && (
                <button className="dibujo-btn" onClick={() => cambiar({ fuente: 'yahoo' })}>Ver con Yahoo</button>
              )}
            </>
          ) : estado.cargando ? 'Cargando…' : (
            <>{estado.n.toLocaleString('es-ES')} velas · {estado.fuente}{!estado.hayMas && ` · ${estado.aviso ?? 'inicio del histórico'}`}</>
          )}
        </div>
      </div>

      <div className="grafico-pro-lienzo">
        <div ref={contenedorRef} className="grafico-pro-chart" />
        {leyenda && (
          <div className="grafico-pro-leyenda">
            <strong>{nombre} · {TEMPORALIDADES.find(t => t.id === tf)?.label}</strong>
            <span>O <b>{fmt(leyenda.open)}</b></span>
            <span>H <b>{fmt(leyenda.high)}</b></span>
            <span>L <b>{fmt(leyenda.low)}</b></span>
            <span>C <b>{fmt(leyenda.close)}</b></span>
            <span className={sube ? 'sube' : 'baja'}>
              {sube ? '+' : ''}{fmt(leyenda.cambio)} ({sube ? '+' : ''}{fmt(leyenda.pct)}%)
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
