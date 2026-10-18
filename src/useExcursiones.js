import { useState, useEffect, useCallback } from 'react'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'

// Cada cuánto se mira el progreso mientras el servidor calcula, y cada cuántas vueltas se
// traen los resultados para que las tablas se vayan llenando sin esperar al final
const CADA_MS = 3_000
const VUELTAS_POR_RECARGA = 5

// MFE/MAE de cada operación, calculados y guardados por el servidor local
// (server/excursiones.js). Como el diario en disco, solo existen en local: en la versión
// publicada no hay servidor con las velas, y `disponible` sale en falso.
export function useExcursiones() {
  const disponible = import.meta.env.DEV
  const [resultados, setResultados] = useState({})
  const [estado,     setEstado]     = useState(null)
  const [error,      setError]      = useState(null)

  const cargar = useCallback(async () => {
    const d = await (await fetch(`${API}/api/excursiones`)).json()
    if (d.error) throw new Error(d.error)
    setResultados(d.resultados ?? {})
  }, [])

  useEffect(() => {
    if (!disponible) return
    let vivo = true
    Promise.all([
      fetch(`${API}/api/excursiones`).then(r => r.json()),
      fetch(`${API}/api/excursiones/estado`).then(r => r.json()),
    ])
      .then(([d, e]) => {
        if (!vivo) return
        if (d.error) throw new Error(d.error)
        setResultados(d.resultados ?? {})
        setEstado(e)
      })
      .catch(() => { if (vivo) setError('No se pudo leer el MFE/MAE (¿servidor local apagado?)') })
    return () => { vivo = false }
  }, [disponible])

  const activo = estado?.activo === true
  useEffect(() => {
    if (!activo) return
    let vueltas = 0
    const id = setInterval(async () => {
      try {
        const e = await (await fetch(`${API}/api/excursiones/estado`)).json()
        setEstado(e)
        if (!e.activo || ++vueltas % VUELTAS_POR_RECARGA === 0) await cargar()
      } catch { /* el servidor se ha reiniciado: lo dirá la siguiente vuelta */ }
    }, CADA_MS)
    return () => clearInterval(id)
  }, [activo, cargar])

  // `reintentar` vuelve a pedir también las operaciones que la otra vez se quedaron sin velas
  const calcular = useCallback(async ({ reintentar = false } = {}) => {
    setError(null)
    try {
      const res = await fetch(`${API}/api/excursiones/calcular${reintentar ? '?reintentar=1' : ''}`, { method: 'POST' })
      const d = await res.json()
      if (d.error) throw new Error(d.error)
      setEstado(d)
    } catch (err) {
      setError(`No se pudo arrancar el cálculo: ${err.message}`)
    }
  }, [])

  return { disponible, resultados, estado, error, calcular }
}
