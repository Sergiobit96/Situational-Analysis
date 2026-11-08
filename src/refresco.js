import { useEffect } from 'react'

// Pide al abrir la vista y luego cada `ms`, pero no mientras la pestaña del navegador está
// oculta (cada respuesta es tráfico de salida de Railway); al volver a verla, pide en el acto.
export function useRefresco(cargar, ms) {
  useEffect(() => {
    const vuelta = () => { if (!document.hidden) cargar() }
    const primera = setTimeout(cargar, 0)
    const reloj = setInterval(vuelta, ms)
    document.addEventListener('visibilitychange', vuelta)
    return () => { clearTimeout(primera); clearInterval(reloj); document.removeEventListener('visibilitychange', vuelta) }
  }, [cargar, ms])
}
