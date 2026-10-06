import { useState } from 'react'
import EstrategiaSegundaVela from './EstrategiaSegundaVela'

// Catálogo de estrategias. Las que solo cambian qué vela se braquetea comparten panel
// (EstrategiaSegundaVela, que recibe el id y saca de él su ventana y su tamaño de vela);
// una que necesite otros filtros puede traer su propio componente. La pestaña se encarga
// del selector y del encabezado.
const ESTRATEGIAS = [
  {
    id:          'segunda-vela',
    nombre:      'SRS',
    titular:     'SRS · bracket de la segunda vela de 15 min',
    descripcion: 'El máximo y el mínimo de la segunda vela de 15 min de la sesión forman el bracket. ' +
                 'Se entra en la primera rotura: comprando por encima del máximo o vendiendo por ' +
                 'debajo del mínimo, con el stop en el extremo contrario; si no salta, la posición ' +
                 'se cierra con la sesión. Como el stop está en el extremo opuesto a la entrada, ' +
                 '1R es el propio rango del bracket. Los filtros permiten quedarse solo con las ' +
                 'compras, dar la vuelta a la posición cuando salta el stop (flip the switch) y ' +
                 'mover el stop a break even al recorrer 1R o 2R a favor.',
    Componente:  EstrategiaSegundaVela,
  },
  {
    id:          'rule-of-4',
    nombre:      'Rule of 4 (FOMC)',
    titular:     'Braquetear la cuarta vela de 10 min del comunicado del FOMC',
    descripcion: 'Los días en que el FOMC anuncia su decisión —a las 14:00 de Nueva York, que casi ' +
                 'siempre son las 20:00 de Madrid— se cuentan cuatro velas de 10 min desde la noticia. ' +
                 'El máximo y el mínimo de esa cuarta vela forman el bracket y se opera igual que en la ' +
                 'otra estrategia: compra por encima, venta por debajo y stop en el extremo contrario. ' +
                 'Solo tiene sentido esos días, así que el calendario son las reuniones ordinarias que ' +
                 'publica la Reserva Federal desde 2013, el año en que el comunicado pasó a salir ' +
                 'siempre a las 14:00. La ventana se cierra dos horas después, con Wall Street.',
    Componente:  EstrategiaSegundaVela,
  },
  {
    id:          'primera-vela-1h',
    nombre:      'Primera vela de 1 h',
    titular:     'Romper la primera vela de una hora, esperando continuación',
    descripcion: 'El máximo y el mínimo de la primera hora de la sesión forman el bracket: si el precio ' +
                 'rompe hacia arriba se compra y si rompe hacia abajo se vende, lo que pase antes. El stop ' +
                 'puede ir al otro extremo de la vela —entonces 1R es la hora entera— o a la mitad, que ' +
                 'arriesga la mitad y por tanto dobla el tamaño de la R con la que se miden el break even ' +
                 'y la pirámide. Con el stop a media vela no hay flip: el nivel donde salta ya no es la ' +
                 'entrada del lado contrario. Para estudiar qué pasa según cómo cierre esa primera hora ' +
                 'está el filtro de 1ª vela, blanca o negra.',
    Componente:  EstrategiaSegundaVela,
  },
]

export default function Estrategias() {
  const [activa, setActiva] = useState(ESTRATEGIAS[0].id)
  const estrategia = ESTRATEGIAS.find(e => e.id === activa) ?? ESTRATEGIAS[0]
  const { Componente } = estrategia

  return (
    <div className="estrategias-page">
      <div className="estrategias-nav">
        {ESTRATEGIAS.map(e => (
          <button
            key={e.id}
            className={`estrategia-chip ${activa === e.id ? 'activo' : ''}`}
            onClick={() => setActiva(e.id)}
          >{e.nombre}</button>
        ))}
      </div>

      <div className="estrategia-intro">
        <h2>{estrategia.titular}</h2>
        <p>{estrategia.descripcion}</p>
      </div>

      {/* la `key` reinicia el panel al cambiar de estrategia: ni las velas ni el
          calendario de la anterior valen para la siguiente */}
      <Componente key={estrategia.id} estrategiaId={estrategia.id} />
    </div>
  )
}
