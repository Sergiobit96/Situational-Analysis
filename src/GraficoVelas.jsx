import { useEffect, useRef, useState } from 'react'
import { crearGrafico } from './graficoVelasCore'
import { crearHerramientasDibujo } from './chartDrawingTools'

const HERRAMIENTAS = [
  { id: 'cursor',    icon: '↖',   title: 'Cursor / seleccionar' },
  { id: 'trendline', icon: '╱',   title: 'Línea de tendencia' },
  { id: 'fib',       icon: 'Fib', title: 'Retroceso de Fibonacci' },
  { id: 'ray',       icon: '→',   title: 'Ray horizontal' },
]

export default function GraficoVelas({ velas, patrones, ticker, prevClose, openPrice, skipTz = false, herramientas = false }) {
  const contenedorRef = useRef(null)
  const chartRef      = useRef(null)
  const dibujoRef     = useRef(null)
  const [modo, setModo] = useState('cursor')

  useEffect(() => {
    if (!contenedorRef.current || !velas?.length) return

    if (chartRef.current) { chartRef.current.remove(); chartRef.current = null }
    dibujoRef.current?.dispose()
    dibujoRef.current = null

    const { chart, serie } = crearGrafico(contenedorRef.current, { velas, patrones, ticker, prevClose, openPrice, skipTz })
    chartRef.current = chart

    if (herramientas) {
      dibujoRef.current = crearHerramientasDibujo({
        chart, series: serie, container: contenedorRef.current, onModeChange: setModo,
      })
    }

    const handleResize = () => {
      if (chartRef.current) chart.applyOptions({ width: contenedorRef.current.clientWidth })
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      dibujoRef.current?.dispose()
      dibujoRef.current = null
      chart.remove()
      chartRef.current = null
    }
  }, [velas, patrones, ticker, prevClose, openPrice, skipTz, herramientas])

  return (
    <div className="grafico-velas-wrap">
      {herramientas && (
        <div className="dibujo-toolbar">
          {HERRAMIENTAS.map(h => (
            <button
              key={h.id}
              className={`dibujo-btn ${modo === h.id ? 'activo' : ''}`}
              title={h.title}
              onClick={() => dibujoRef.current?.setMode(h.id)}
            >{h.icon}</button>
          ))}
          <button
            className="dibujo-btn dibujo-clear"
            title="Borrar todos los dibujos"
            onClick={() => dibujoRef.current?.clearAll()}
          >🗑</button>
        </div>
      )}
      <div ref={contenedorRef} className="grafico-velas" />
    </div>
  )
}
