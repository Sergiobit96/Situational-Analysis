import { useState } from 'react'
import DiarioFortalezas from './DiarioFortalezas'
import DiarioTrades from './DiarioTrades'

// Dos diarios independientes bajo la misma pestaña: el de fortalezas y debilidades vive
// en localStorage (funciona también en la versión publicada) y el de trades escribe fotos
// en disco a través del servidor, así que solo existe en local, como Fotos o Book of Horror.
const VISTAS = [
  { id: 'fd',     nombre: 'Fortalezas y debilidades', Componente: DiarioFortalezas },
  ...( import.meta.env.DEV ? [
    { id: 'trades', nombre: '📷 Trades comentados', Componente: DiarioTrades },
  ] : []),
]

export default function Diario() {
  const [activa, setActiva] = useState(VISTAS[0].id)
  const vista = VISTAS.find(v => v.id === activa) ?? VISTAS[0]
  const { Componente } = vista

  return (
    <div className="diario-wrap">
      {VISTAS.length > 1 && (
        <div className="estrategias-nav">
          {VISTAS.map(v => (
            <button
              key={v.id}
              className={`estrategia-chip ${activa === v.id ? 'activo' : ''}`}
              onClick={() => setActiva(v.id)}
            >{v.nombre}</button>
          ))}
        </div>
      )}

      <Componente />
    </div>
  )
}
