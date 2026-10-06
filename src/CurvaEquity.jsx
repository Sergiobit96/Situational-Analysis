import { useEffect, useMemo, useRef } from 'react'
import { createChart, AreaSeries, HistogramSeries, LineStyle, CrosshairMode } from 'lightweight-charts'
import { curvaEquity } from './equity'

const fmt = (v, dec = 0) => v == null ? '—'
  : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('es-ES', { maximumFractionDigits: dec })}`

const fmtDia = f => f ? f.split('-').reverse().join('/') : '—'

// Curva de puntos acumulados con su drawdown debajo, en el mismo gráfico: la línea vive en
// el 70% de arriba y las barras rojas de drawdown en el 30% de abajo, que es como se leen
// las dos cosas a la vez sin cambiar de escala.
export default function CurvaEquity({ sesiones }) {
  const contenedorRef = useRef(null)
  const datos = useMemo(() => curvaEquity(sesiones), [sesiones])

  useEffect(() => {
    if (!contenedorRef.current || datos.puntos.length === 0) return

    const chart = createChart(contenedorRef.current, {
      layout: { background: { color: '#ffffff' }, textColor: '#1a1a1a' },
      grid:   { vertLines: { color: '#e5e7eb' }, horzLines: { color: '#e5e7eb' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#d1d5db', scaleMargins: { top: 0.05, bottom: 0.32 } },
      // con 4.400 sesiones el mínimo por defecto (0,5 px por barra) no deja encajarlas
      // todas y el gráfico se quedaba enseñando solo los últimos años
      timeScale: { borderColor: '#d1d5db', minBarSpacing: 0.02 },
      width:  contenedorRef.current.clientWidth,
      height: 300,
    })

    const equity = chart.addSeries(AreaSeries, {
      lineColor: '#3fb950', topColor: 'rgba(63,185,80,0.28)', bottomColor: 'rgba(63,185,80,0.02)',
      lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
    })
    equity.setData(datos.puntos.map(p => ({ time: p.date, value: p.acumulado })))

    const dd = chart.addSeries(HistogramSeries, {
      color: 'rgba(248,81,73,0.55)', priceScaleId: 'dd',
      priceLineVisible: false, lastValueVisible: false,
    })
    dd.setData(datos.puntos.map(p => ({ time: p.date, value: p.drawdown })))
    chart.priceScale('dd').applyOptions({ scaleMargins: { top: 0.72, bottom: 0 } })

    equity.createPriceLine({ price: 0, color: '#9ca3af', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false })

    // El ajuste se repite en el siguiente fotograma: al crear el gráfico el contenedor aún
    // no tiene su ancho definitivo y el encuadre se quedaba en las últimas sesiones.
    chart.timeScale().fitContent()
    const encuadrar = requestAnimationFrame(() => {
      chart.applyOptions({ width: contenedorRef.current?.clientWidth ?? 0 })
      chart.timeScale().fitContent()
    })

    const alRedimensionar = () => {
      chart.applyOptions({ width: contenedorRef.current.clientWidth })
      chart.timeScale().fitContent()
    }
    window.addEventListener('resize', alRedimensionar)
    return () => {
      cancelAnimationFrame(encuadrar)
      window.removeEventListener('resize', alRedimensionar)
      chart.remove()
    }
  }, [datos])

  if (datos.puntos.length === 0) return null

  const tiles = [
    { label: 'Puntos acumulados', valor: fmt(datos.total),  sub: `${datos.n} sesiones operadas` },
    {
      label: 'Máximo drawdown',
      valor: fmt(datos.maxDD),
      sub: datos.maxDDPct != null ? `${Math.abs(datos.maxDDPct).toFixed(0)}% desde su máximo` : 'sin máximo previo',
      marca: '▼', tono: 'rojo',
    },
    {
      label: 'Peor racha en pérdidas',
      valor: `${datos.peorDD.sesiones} sesiones`,
      sub: `${fmtDia(datos.peorDD.desde)} → ${fmtDia(datos.peorDD.hasta)}`,
    },
    { label: 'Drawdown al final', valor: fmt(datos.ddActual), sub: datos.ddActual === 0 ? 'en máximos' : 'sin recuperar' },
    { label: 'Mejor sesión',  valor: fmt(datos.mejor?.pts, 1), sub: fmtDia(datos.mejor?.date), marca: '▲', tono: 'verde' },
    { label: 'Peor sesión',   valor: fmt(datos.peor?.pts, 1),  sub: fmtDia(datos.peor?.date),  marca: '▼', tono: 'rojo' },
    { label: 'Racha ganadora', valor: `${datos.mejorRachaG} seguidas`, sub: 'sesiones en verde' },
    { label: 'Racha perdedora', valor: `${datos.peorRachaP} seguidas`, sub: 'sesiones en rojo' },
  ]

  return (
    <div className="estr-resumen curva-equity">
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
      <div ref={contenedorRef} className="curva-equity-grafico" />
      <p className="estr-nota">
        Línea verde: puntos acumulados sesión a sesión, de la más antigua a la más reciente.
        Barras rojas de abajo: lo que se llevaba perdido desde el máximo anterior en cada momento.
      </p>
    </div>
  )
}
