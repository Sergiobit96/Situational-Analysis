import { useEffect, useRef } from 'react'
import { createChart, CandlestickSeries, LineSeries, CrosshairMode, LineStyle, createSeriesMarkers } from 'lightweight-charts'

// Offset Madrid en segundos para un timestamp concreto (maneja CET/CEST por fecha, no por "ahora")
function madridOffsetAt(tsSecs) {
  const d     = new Date(tsSecs * 1000)
  const local = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }))
  const utc   = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }))
  return Math.round((local - utc) / 1000)
}

// Minutos desde medianoche Madrid para un timestamp ya ajustado (ts + offset)
const madridMinOfDay = adjTs => (adjTs % 86400) / 60

// Ventanas horarias de sesión regular en minutos Madrid por ticker
const SESSION_MADRID = {
  '^GDAXI': [9*60,  17*60+30],  // 09:00–17:30
  '^FTSE':  [9*60,  17*60+30],  // 09:00–17:30
  '^GSPC':  [14*60, 22*60+30],  // cubre 14:30 CET (invierno) y 15:30 CEST (verano)
  '^NDX':   [14*60, 22*60+30],
  '^DJI':   [14*60, 22*60+30],
  'SPY':    [14*60, 22*60+30],
  'QQQ':    [14*60, 22*60+30],
}

export default function GraficoVelas({ velas, patrones, ticker, prevClose, openPrice, skipTz = false }) {
  const contenedorRef = useRef(null)
  const chartRef      = useRef(null)

  useEffect(() => {
    if (!contenedorRef.current || !velas?.length) return

    if (chartRef.current) { chartRef.current.remove(); chartRef.current = null }

    const velasAjustadas = skipTz
      ? velas
      : velas.map(v => ({ ...v, time: v.time + madridOffsetAt(v.time) }))

    const chart = createChart(contenedorRef.current, {
      layout: { background: { color: '#ffffff' }, textColor: '#1a1a1a' },
      grid:   { vertLines: { color: '#e5e7eb' }, horzLines: { color: '#e5e7eb' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#d1d5db' },
      timeScale: { borderColor: '#d1d5db', timeVisible: true, secondsVisible: false },
      width:  contenedorRef.current.clientWidth,
      height: 420,
    })
    chartRef.current = chart

    const serie = chart.addSeries(CandlestickSeries, {
      upColor:         '#ffffff',
      downColor:       '#000000',
      borderUpColor:   '#000000',
      borderDownColor: '#000000',
      wickUpColor:     '#000000',
      wickDownColor:   '#000000',
    })
    serie.setData(velasAjustadas)

    // Líneas horizontales de referencia: cierre anterior y apertura del día
    if (prevClose != null) serie.createPriceLine({
      price: prevClose, color: '#f97316', lineWidth: 1,
      lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Cierre ant.',
    })
    if (openPrice != null) serie.createPriceLine({
      price: openPrice, color: '#60a5fa', lineWidth: 1,
      lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Apertura',
    })

    // Marcadores de apertura y cierre de sesión regular
    const session = SESSION_MADRID[ticker]
    if (session) {
      const [sOpen, sClose] = session
      const sessionVelas = velasAjustadas.filter(v => {
        const m = madridMinOfDay(v.time)
        return m >= sOpen && m < sClose
      })
      const apertura = sessionVelas[0]
      const cierre   = sessionVelas[sessionVelas.length - 1]
      const markers  = []
      if (apertura) markers.push({
        time: apertura.time, position: 'belowBar', color: '#60a5fa',
        shape: 'arrowUp', text: 'Apertura', size: 1,
      })
      if (cierre && cierre.time !== apertura?.time) markers.push({
        time: cierre.time, position: 'aboveBar', color: '#f97316',
        shape: 'arrowDown', text: 'Cierre', size: 1,
      })
      if (markers.length) createSeriesMarkers(serie, markers)
    }

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

    const handleResize = () => {
      if (chartRef.current) chart.applyOptions({ width: contenedorRef.current.clientWidth })
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
      chartRef.current = null
    }
  }, [velas, patrones, ticker, prevClose, openPrice, skipTz])

  return <div ref={contenedorRef} className="grafico-velas" />
}
