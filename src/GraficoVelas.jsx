import { useEffect, useRef, useState } from 'react'
import { crearGrafico } from './graficoVelasCore'
import { crearHerramientasDibujo } from './chartDrawingTools'

const HERRAMIENTAS = [
  { id: 'cursor',    icon: '↖',   title: 'Cursor / seleccionar' },
  { id: 'trendline', icon: '╱',   title: 'Línea de tendencia' },
  { id: 'fib',       icon: 'Fib', title: 'Fibonacci (retroceso + extensión)' },
  { id: 'ray',       icon: '→',   title: 'Ray horizontal' },
]

export default function GraficoVelas({ velas, patrones, ticker, prevClose, openPrice, skipTz = false, herramientas = false, trades, rango, operacion, alto, pantallaCompleta = false, onPantallaCompleta }) {
  const contenedorRef = useRef(null)
  const chartRef      = useRef(null)
  const dibujoRef     = useRef(null)
  const [modo, setModo] = useState('cursor')
  const [mostrarTrades, setMostrarTrades] = useState(false)
  const hayTrades = trades?.length > 0

  useEffect(() => {
    if (!contenedorRef.current || !velas?.length) return

    if (chartRef.current) { chartRef.current.remove(); chartRef.current = null }
    dibujoRef.current?.dispose()
    dibujoRef.current = null

    const { chart, serie } = crearGrafico(contenedorRef.current, {
      velas, patrones, ticker, prevClose, openPrice, skipTz, rango, operacion,
      trades: mostrarTrades ? trades : [],
      // `alto` lo manda quien pone el gráfico a pantalla completa; sin él vale la altura normal
      height: alto,
    })
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
  }, [velas, patrones, ticker, prevClose, openPrice, skipTz, herramientas, trades, mostrarTrades, rango, operacion, alto])

  return (
    <div className="grafico-velas-wrap">
      {(herramientas || hayTrades || onPantallaCompleta) && (
        <div className="dibujo-toolbar">
          {herramientas && HERRAMIENTAS.map(h => (
            <button
              key={h.id}
              className={`dibujo-btn ${modo === h.id ? 'activo' : ''}`}
              title={h.title}
              onClick={() => dibujoRef.current?.setMode(h.id)}
            >{h.icon}</button>
          ))}
          {herramientas && (
            <button
              className="dibujo-btn dibujo-clear"
              title="Borrar todos los dibujos"
              onClick={() => dibujoRef.current?.clearAll()}
            >🗑</button>
          )}
          {hayTrades && (
            <button
              className={`dibujo-btn trades-toggle-btn ${mostrarTrades ? 'activo' : ''}`}
              title="Mostrar/ocultar las operaciones del diario en el gráfico"
              onClick={() => setMostrarTrades(v => !v)}
            >📌 Operaciones ({trades.length})</button>
          )}
          {onPantallaCompleta && (
            <button
              className={`dibujo-btn grafico-pantalla ${pantallaCompleta ? 'activo' : ''}`}
              title={pantallaCompleta ? 'Salir de pantalla completa (Esc)' : 'Pantalla completa'}
              onClick={onPantallaCompleta}
            >{pantallaCompleta ? '⤡' : '⤢'}</button>
          )}
        </div>
      )}
      <div ref={contenedorRef} className="grafico-velas" />
    </div>
  )
}
