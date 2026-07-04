import { useEffect, useRef } from 'react'
import { crearGrafico } from './graficoVelasCore'

export default function GraficoVelas({ velas, patrones, ticker, prevClose, openPrice, skipTz = false }) {
  const contenedorRef = useRef(null)
  const chartRef      = useRef(null)

  useEffect(() => {
    if (!contenedorRef.current || !velas?.length) return

    if (chartRef.current) { chartRef.current.remove(); chartRef.current = null }

    const chart = crearGrafico(contenedorRef.current, { velas, patrones, ticker, prevClose, openPrice, skipTz })
    chartRef.current = chart

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
