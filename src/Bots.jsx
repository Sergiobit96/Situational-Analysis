import { useState, useEffect } from 'react'
import Bot from './Bot'
import BotTortugas from './BotTortugas'
import Posiciones from './Posiciones'
import Salud from './Salud'
import Alpaca from './Alpaca'
import BotTortugasAcciones from './BotTortugasAcciones'

// Los bots de la demo de IG bajo una sola pestaña, cada uno en su vista, como el Diario. Todos
// operan desde el servidor que tenga BOT_OPERA=1 (en la nube) y comparten la cuenta, el
// Telegram y la clave del bot en producción.
const NOTA_RULE4 = 'Horas de Madrid; la raya vertical es ahora. Solo opera los días en que el FOMC publica su decisión: la sesión empieza con el comunicado, a las 14:00 de Nueva York (las 20:00 de Madrid casi siempre; las 19:00 o las 21:00 las semanas en que no han cambiado aún los dos la hora), y dura dos horas, hasta el cierre de Wall Street. El bracket es la cuarta vela de 10 min. La casilla enciende o apaga cada instrumento.'

const NOTA_FBN = 'Horas de Madrid; la raya vertical es ahora. Cada sesión abre a la hora de su bolsa (Tokio 09:00, Fráncfort 09:00, Londres 08:00 y Nueva York 09:30) y el bracket es su primera vela de 5 min: si cierra en negativo, vende al perder su mínimo; si no, ese día no opera. La casilla enciende o apaga cada instrumento.'

const VISTAS_BOTS = [
  { id: 'posiciones', nombre: 'Posiciones activas', render: () => <Posiciones /> },
  { id: 'srs',       nombre: 'SRS',             render: () => <Bot /> },
  { id: 'rule-of-4', nombre: 'Rule of 4 (FOMC)', render: () => <Bot api="/api/bot/rule-of-4" nombre="Rule of 4" notaDia={NOTA_RULE4} extras={false} /> },
  { id: 'first-bar-negative', nombre: 'First bar negative', render: () => <Bot api="/api/bot/first-bar-negative" nombre="First bar negative" notaDia={NOTA_FBN} extras={false} /> },
  { id: 'tortugas',  nombre: 'Tortugas',        render: () => <BotTortugas /> },
  { id: 'tortugas-acciones', nombre: 'Tortugas acciones', render: () => <BotTortugasAcciones /> },
  { id: 'alpaca',    nombre: 'Alpaca',          render: () => <Alpaca /> },
  { id: 'salud',     nombre: 'Salud',           render: () => <Salud /> },
]

const GUARDADA = 'sa.bots'
function vistaInicial(pedida) {
  if (VISTAS_BOTS.some(v => v.id === pedida)) return pedida
  try {
    const guardada = localStorage.getItem(GUARDADA)
    if (VISTAS_BOTS.some(v => v.id === guardada)) return guardada
  } catch { /* sin almacenamiento */ }
  return VISTAS_BOTS[0].id
}

// `inicial`: la vista con la que abrir (la de un enlace antiguo, #tortugas)
export default function Bots({ inicial = null }) {
  const [activa, setActiva] = useState(() => vistaInicial(inicial))
  const vista = VISTAS_BOTS.find(v => v.id === activa) ?? VISTAS_BOTS[0]

  useEffect(() => {
    try { localStorage.setItem(GUARDADA, activa) } catch { /* sin almacenamiento */ }
  }, [activa])

  return (
    <div className="diario-wrap">
      <div className="estrategias-nav">
        {VISTAS_BOTS.map(v => (
          <button
            key={v.id}
            className={`estrategia-chip ${activa === v.id ? 'activo' : ''}`}
            onClick={() => setActiva(v.id)}
          >{v.nombre}</button>
        ))}
      </div>

      {/* la clave hace que cambiar de bot monte la vista desde cero, sin datos del anterior */}
      <div key={vista.id}>{vista.render()}</div>
    </div>
  )
}
