import { createChart, CandlestickSeries, LineSeries, CrosshairMode, LineStyle, createSeriesMarkers } from 'lightweight-charts'
import { madridOffsetAt } from './timezone'

// Minutos desde medianoche Madrid para un timestamp ya ajustado (ts + offset)
const madridMinOfDay = adjTs => (adjTs % 86400) / 60

// lightweight-charts solo trae marcadores circle/square/arrowUp/arrowDown anclados
// arriba/abajo de la barra (no al precio exacto), así que las marcas de operaciones se
// dibujan con un primitive propio: entrada = flecha horizontal que toca el precio exacto
// de entrada, salida = cruz en el precio exacto de salida.
class TradeMarksPrimitive {
  constructor(points) { this._points = points }
  attached({ chart, series }) { this._chart = chart; this._series = series }
  detached() { this._chart = null; this._series = null }
  updateAllViews() {}
  paneViews() {
    return [{
      renderer: () => ({
        draw: target => target.useMediaCoordinateSpace(({ context }) => {
          if (!this._chart || !this._series) return
          for (const p of this._points) {
            const x = this._chart.timeScale().timeToCoordinate(p.time)
            const y = this._series.priceToCoordinate(p.price)
            if (x == null || y == null) continue
            context.save()
            context.strokeStyle = p.color
            context.lineWidth = 2
            context.beginPath()
            if (p.tipo === 'entrada') {
              // Flecha horizontal: el vástago llega desde la izquierda y la punta toca (x,y)
              const largo = 12
              context.moveTo(x - largo, y)
              context.lineTo(x, y)
              context.lineTo(x - 4, y - 4)
              context.moveTo(x, y)
              context.lineTo(x - 4, y + 4)
            } else {
              const r = 5
              context.moveTo(x - r, y - r); context.lineTo(x + r, y + r)
              context.moveTo(x + r, y - r); context.lineTo(x - r, y + r)
            }
            context.stroke()
            context.restore()
          }
        }),
      }),
    }]
  }
}

// Ventanas horarias de sesión regular en minutos Madrid por ticker
const SESSION_MADRID = {
  '^GDAXI': [9*60,      17*60+30],  // 09:00–17:30 (Frankfurt = Madrid siempre)
  '^FTSE':  [9*60,      17*60+30],  // 09:00–17:30 (London+1h = Madrid siempre)
  '^GSPC':  [15*60+30,  22*60],     // 15:30–22:00 (NYSE 09:30 ET = 15:30 Madrid siempre)
  '^NDX':   [15*60+30,  22*60],
  '^DJI':   [15*60+30,  22*60],
  '^RUT':   [15*60+30,  22*60],
  '^N225':  [1*60,      8*60],      // 09:00–15:00 JST ≈ 01:00–08:00 Madrid (Japón no cambia de horario, rango ampliado para cubrir CET/CEST)
  'SPY':    [15*60+30,  22*60],
  'QQQ':    [15*60+30,  22*60],
}

// Construye el chart de velas dentro de `container` (usado tanto por el componente visible
// como por la captura headless para exportar imágenes a PPT). `width`/`height` fuerzan el
// tamaño cuando el contenedor no está en el layout visible (p.ej. durante la exportación).
export function crearGrafico(container, { velas, patrones, ticker, prevClose, openPrice, skipTz = false, width, height, trades }) {
  const velasAjustadas = skipTz
    ? velas
    : velas.map(v => ({ ...v, time: v.time + madridOffsetAt(v.time) }))

  // Determinar ventana de sesión antes de pintar para poder sombrear fuera de rango
  const session = SESSION_MADRID[ticker]
  const [sOpen, sClose] = session ?? [null, null]

  // Barras fuera de sesión → gris claro; dentro → esquema negro/blanco normal
  const velasRender = session
    ? velasAjustadas.map(v => {
        const m = madridMinOfDay(v.time)
        if (m >= sOpen && m < sClose) return v
        return { ...v, color: '#e2e2e2', borderColor: '#c8c8c8', wickColor: '#c8c8c8' }
      })
    : velasAjustadas

  const chart = createChart(container, {
    layout: { background: { color: '#ffffff' }, textColor: '#1a1a1a' },
    grid:   { vertLines: { color: '#e5e7eb' }, horzLines: { color: '#e5e7eb' } },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#d1d5db' },
    timeScale: { borderColor: '#d1d5db', timeVisible: true, secondsVisible: false },
    width:  width  ?? container.clientWidth,
    height: height ?? (window.innerWidth < 600 ? 220 : 420),
  })

  const serie = chart.addSeries(CandlestickSeries, {
    upColor:         '#ffffff',
    downColor:       '#000000',
    borderUpColor:   '#000000',
    borderDownColor: '#000000',
    wickUpColor:     '#000000',
    wickDownColor:   '#000000',
  })
  serie.setData(velasRender)

  // Marcadores de apertura y cierre de sesión regular
  // El precio de apertura se toma del primer bar intraday de sesión (exactamente 09:00 / 15:30)
  let intradayOpen = null
  const markers = []
  if (session) {
    const sessionVelas = velasAjustadas.filter(v => {
      const m = madridMinOfDay(v.time)
      return m >= sOpen && m < sClose
    })
    const apertura = sessionVelas[0]
    const cierre   = sessionVelas[sessionVelas.length - 1]
    intradayOpen   = apertura?.open ?? null
    if (apertura) markers.push({
      time: apertura.time, position: 'belowBar', color: '#60a5fa',
      shape: 'arrowUp', text: 'Apertura', size: 1,
    })
    if (cierre && cierre.time !== apertura?.time) markers.push({
      time: cierre.time, position: 'aboveBar', color: '#f97316',
      shape: 'arrowDown', text: 'Cierre', size: 1,
    })
  }

  // Marcas de operaciones reales (diario de trading) que caen en este día/instrumento:
  // flecha horizontal de entrada + cruz de salida, ambas exactamente al precio de la
  // operación y coloreadas según su dirección (azul = LONG, naranja = SHORT), unidas
  // por una línea discontinua del mismo color.
  const marcasTrade = []
  trades?.forEach(t => {
    const esShort = t.direccion === 'SHORT'
    const color   = esShort ? '#f97316' : '#3b82f6'
    marcasTrade.push({ time: t.openTime,  price: t.openPrice,  color, tipo: 'entrada' })
    marcasTrade.push({ time: t.closeTime, price: t.closePrice, color, tipo: 'salida' })

    if (t.closeTime !== t.openTime) {
      const linea = chart.addSeries(LineSeries, {
        color, lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false,
      })
      linea.setData([
        { time: t.openTime,  value: t.openPrice },
        { time: t.closeTime, value: t.closePrice },
      ])
    }
  })

  if (markers.length) createSeriesMarkers(serie, [...markers].sort((a, b) => a.time - b.time))
  if (marcasTrade.length) serie.attachPrimitive(new TradeMarksPrimitive(marcasTrade))

  // Líneas horizontales de referencia
  if (prevClose != null) serie.createPriceLine({
    price: prevClose, color: '#f97316', lineWidth: 1,
    lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Cierre ant.',
  })
  const refOpen = intradayOpen ?? openPrice
  if (refOpen != null) serie.createPriceLine({
    price: refOpen, color: '#60a5fa', lineWidth: 1,
    lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Apertura',
  })

  patrones?.forEach((p, idx) => {
    const color = p.tipo === 'bullish' ? '#3b82f6' : '#f97316'

    const lineaABCD = chart.addSeries(LineSeries, {
      color, lineWidth: 2, lineStyle: LineStyle.Solid, priceLineVisible: false, lastValueVisible: false,
    })
    lineaABCD.setData([
      { time: p.A.time + madridOffsetAt(p.A.time), value: p.A.price },
      { time: p.B.time + madridOffsetAt(p.B.time), value: p.B.price },
      { time: p.C.time + madridOffsetAt(p.C.time), value: p.C.price },
      { time: p.D.time + madridOffsetAt(p.D.time), value: p.D.price },
    ])

    serie.createPriceLine({ price: p.entrada, color,           lineWidth: 1, lineStyle: LineStyle.Dashed,  axisLabelVisible: true, title: `Entrada ${idx + 1}` })
    serie.createPriceLine({ price: p.stop,    color: '#f85149', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: 'Stop' })
    serie.createPriceLine({ price: p.target1, color: '#3fb950', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: 'T1' })
    serie.createPriceLine({ price: p.target2, color: '#22c55e', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: 'T2' })
  })

  chart.timeScale().fitContent()
  return { chart, serie }
}

// Renderiza un chart fuera de pantalla (mismo aspecto que el detalle de sesión) y devuelve
// un PNG en base64 (data URL). Usado por la exportación a PPT para capturar los gráficos
// de todas las coincidencias sin tener que montarlos en la interfaz.
export async function capturarVelasPNG({ velas, ticker, prevClose, openPrice, width = 960, height = 540 }) {
  if (!velas?.length) return null

  const container = document.createElement('div')
  container.style.cssText = `position:absolute; left:-99999px; top:0; width:${width}px; height:${height}px;`
  document.body.appendChild(container)

  try {
    const { chart } = crearGrafico(container, { velas, patrones: [], ticker, prevClose, openPrice, width, height })
    // Esperar dos frames para asegurar que el canvas ha pintado antes de capturarlo
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    const canvas = chart.takeScreenshot()
    const dataUrl = canvas.toDataURL('image/png')
    chart.remove()
    return dataUrl
  } finally {
    document.body.removeChild(container)
  }
}
