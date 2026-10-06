import { createChart, CandlestickSeries, LineSeries, CrosshairMode, LineStyle, createSeriesMarkers } from 'lightweight-charts'
import { madridOffsetAt } from './timezone'

// Minutos desde medianoche Madrid para un timestamp ya ajustado (ts + offset)
const madridMinOfDay = adjTs => (adjTs % 86400) / 60

// lightweight-charts solo trae marcadores circle/square/arrowUp/arrowDown anclados
// arriba/abajo de la barra (no al precio exacto), así que las marcas de operaciones se
// dibujan con un primitive propio: entrada = flecha horizontal que toca el precio exacto
// de entrada, salida = cruz en el precio exacto de salida.
// El bracket se dibuja como dos líneas discontinuas a la altura del máximo y del mínimo
// de su vela (la 2ª de 15 min). Arrancan en esa misma vela, para que se vea de dónde
// sale cada nivel, y siguen hasta el borde derecho, que es la parte de la sesión en la
// que el nivel está vivo.
class RangoAperturaPrimitive {
  constructor(rango) { this._r = rango }
  attached({ chart, series }) { this._chart = chart; this._series = series }
  detached() { this._chart = null; this._series = null }
  updateAllViews() {}
  paneViews() {
    return [{
      renderer: () => ({
        draw: target => target.useMediaCoordinateSpace(({ context, mediaSize }) => {
          if (!this._chart || !this._series) return
          const x     = this._chart.timeScale().timeToCoordinate(this._r.vela)
          const yAlto = this._series.priceToCoordinate(this._r.high)
          const yBajo = this._series.priceToCoordinate(this._r.low)
          if (yAlto == null || yBajo == null) return

          const desde = Math.max(0, x ?? 0)   // fuera de pantalla: desde el borde izquierdo
          context.save()
          context.strokeStyle = '#7c3aed'
          context.lineWidth   = 1.5
          context.setLineDash([5, 4])
          for (const y of [yAlto, yBajo]) {
            context.beginPath()
            context.moveTo(desde, y)
            context.lineTo(mediaSize.width, y)
            context.stroke()
          }
          context.restore()
        }),
      }),
    }]
  }
}

// x de un instante cualquiera interpolando entre las dos velas que lo rodean. Es lo que
// permite dibujar una marca en mitad de una vela sin meter su timestamp en la escala de
// tiempo: al añadirlo (como hacía la línea que une entrada y salida, que era una serie
// propia) la escala abre una ranura nueva en la que las velas no tienen dato, y aparece
// un hueco en blanco justo donde va la marca.
function coordenadaDeTiempo(escala, tiempos, t) {
  const n = tiempos.length
  if (n === 0) return null
  if (t <= tiempos[0]) return escala.timeToCoordinate(tiempos[0])

  if (t >= tiempos[n - 1]) {
    const xUltima = escala.timeToCoordinate(tiempos[n - 1])
    if (n === 1 || xUltima == null) return xUltima
    // más allá de la última vela se prolonga con la separación de la anterior
    const xPrevia = escala.timeToCoordinate(tiempos[n - 2])
    if (xPrevia == null) return xUltima
    const paso = tiempos[n - 1] - tiempos[n - 2]
    return xUltima + ((t - tiempos[n - 1]) / paso) * (xUltima - xPrevia)
  }

  let i = 0
  while (i < n - 1 && tiempos[i + 1] <= t) i++
  const x0 = escala.timeToCoordinate(tiempos[i])
  const x1 = escala.timeToCoordinate(tiempos[i + 1])
  if (x0 == null || x1 == null) return x0 ?? x1
  return x0 + ((t - tiempos[i]) / (tiempos[i + 1] - tiempos[i])) * (x1 - x0)
}

class TradeMarksPrimitive {
  constructor({ marcas, lineas, tiempos }) {
    this._points  = marcas
    this._lineas  = lineas ?? []
    this._tiempos = tiempos ?? []
  }
  attached({ chart, series }) { this._chart = chart; this._series = series }
  detached() { this._chart = null; this._series = null }
  updateAllViews() {}
  paneViews() {
    return [{
      renderer: () => ({
        draw: target => target.useMediaCoordinateSpace(({ context }) => {
          if (!this._chart || !this._series) return
          const escala = this._chart.timeScale()
          const xDe    = t => coordenadaDeTiempo(escala, this._tiempos, t)

          // Línea discontinua entrada → salida
          for (const l of this._lineas) {
            const x0 = xDe(l.desde), x1 = xDe(l.hasta)
            const y0 = this._series.priceToCoordinate(l.precioDesde)
            const y1 = this._series.priceToCoordinate(l.precioHasta)
            if (x0 == null || x1 == null || y0 == null || y1 == null) continue
            context.save()
            context.strokeStyle = l.color
            context.lineWidth   = 1
            context.setLineDash([4, 4])
            context.beginPath()
            context.moveTo(x0, y0)
            context.lineTo(x1, y1)
            context.stroke()
            context.restore()
          }

          for (const p of this._points) {
            const x = xDe(p.time)
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
              // Y un triángulo que dice de qué lado va: hacia arriba si se compra y hacia
              // abajo si se vende, que con la flecha sola no había forma de saberlo
              if (p.lado) {
                const h = p.lado === 'corto' ? 9 : -9
                context.stroke()
                context.beginPath()
                context.moveTo(x, y + (p.lado === 'corto' ? 3 : -3))
                context.lineTo(x - 5, y + h)
                context.lineTo(x + 5, y + h)
                context.closePath()
                context.fillStyle = p.color
                context.fill()
                context.beginPath()
              }
            } else if (p.tipo === 'anadido') {
              // una cruz de sumar en el nivel donde entra la unidad de más
              context.moveTo(x - 7, y); context.lineTo(x + 7, y)
              context.moveTo(x, y - 5); context.lineTo(x, y + 5)
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
export function crearGrafico(container, { velas, patrones, ticker, prevClose, openPrice, skipTz = false, width, height, trades, rango, operacion }) {
  const ajustarTiempo = t => skipTz ? t : t + madridOffsetAt(t)
  const velasAjustadas = velas.map(v => ({ ...v, time: ajustarTiempo(v.time) }))

  // Determinar ventana de sesión antes de pintar para poder sombrear fuera de rango
  const session = SESSION_MADRID[ticker]
  const [sOpen, sClose] = session ?? [null, null]

  // Bracket de la estrategia: `rango` llega con el timestamp crudo de la vela que lo define
  const rangoVela = rango ? ajustarTiempo(rango.vela) : null

  // Barras fuera de sesión → gris claro; la vela del bracket → contorno violeta;
  // el resto → esquema negro/blanco normal
  const velasRender = (session || rango)
    ? velasAjustadas.map(v => {
        if (v.time === rangoVela) return { ...v, borderColor: '#7c3aed', wickColor: '#7c3aed' }
        if (!session) return v
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
  const lineasTrade = []
  // Verde para los largos y rojo para los cortos, en el diario y en la estrategia: lo que
  // se quiere ver de un vistazo en el gráfico es de qué lado iba la operación.
  trades?.forEach(t => {
    const esShort = t.direccion === 'SHORT'
    const color   = esShort ? '#f85149' : '#3fb950'
    marcasTrade.push({ time: t.openTime,  price: t.openPrice,  color, tipo: 'entrada', lado: esShort ? 'corto' : 'largo' })
    marcasTrade.push({ time: t.closeTime, price: t.closePrice, color, tipo: 'salida' })

    if (t.closeTime !== t.openTime) lineasTrade.push({
      desde: t.openTime,  precioDesde: t.openPrice,
      hasta: t.closeTime, precioHasta: t.closePrice,
      color,
    })
  })

  // Extremos del bracket: el precio que la estrategia vigila desde que esa vela cierra
  if (rango) {
    markers.push({
      time: rangoVela, position: 'aboveBar', color: '#7c3aed',
      shape: 'circle', text: rango.etiqueta ?? 'Bracket', size: 1,
    })
    serie.attachPrimitive(new RangoAperturaPrimitive({
      vela: rangoVela, high: rango.high, low: rango.low,
    }))
  }

  // Operación simulada por la estrategia: entra en la rotura del bracket y cierra en el
  // extremo contrario (o al cierre si no lo toca). Mismas marcas que las operaciones del
  // diario, pero coloreadas según cómo acabó. `flip` es la vuelta a la posición, que se
  // pinta igual porque es otra operación con su entrada y su salida.
  const piernas = operacion ? [operacion, ...(operacion.vueltas ?? [])].filter(Boolean) : []
  for (const pierna of piernas) {
    const color    = pierna.lado === 'corto' ? '#f85149' : '#3fb950'
    const tEntrada = ajustarTiempo(pierna.entrada.time)
    const tSalida  = ajustarTiempo(pierna.salida.time)
    marcasTrade.push({ time: tEntrada, price: pierna.entrada.precio, color, tipo: 'entrada', lado: pierna.lado })
    marcasTrade.push({ time: tSalida,  price: pierna.salida.precio,  color, tipo: 'salida'  })
    // cada unidad añadida, en su vela y a su precio
    for (const a of pierna.anadidos ?? []) {
      marcasTrade.push({ time: ajustarTiempo(a.time), price: a.precio, color, tipo: 'anadido' })
    }

    if (tSalida !== tEntrada) lineasTrade.push({
      desde: tEntrada, precioDesde: pierna.entrada.precio,
      hasta: tSalida,  precioHasta: pierna.salida.precio,
      color,
    })
  }

  if (markers.length) createSeriesMarkers(serie, [...markers].sort((a, b) => a.time - b.time))
  if (marcasTrade.length) serie.attachPrimitive(new TradeMarksPrimitive({
    marcas: marcasTrade,
    lineas: lineasTrade,
    // tiempos de las velas, que son las únicas ranuras reales de la escala
    tiempos: velasAjustadas.map(v => v.time).sort((a, b) => a - b),
  }))

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
