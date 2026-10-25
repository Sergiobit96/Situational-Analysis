import { useState } from 'react'
import EstrategiaSegundaVela from './EstrategiaSegundaVela'
import EstrategiaTortugas from './EstrategiaTortugas'

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
  {
    id:          'first-bar-negative',
    nombre:      'First bar negative',
    titular:     'First bar negative · vender bajo la primera vela de 5 min si cierra en negativo',
    descripcion: 'Si la primera vela de 5 min de la sesión cierra por debajo de su apertura, se vende cuando ' +
                 'el precio pierde su mínimo, con el stop al otro lado de la vela, en su máximo. Si cierra en ' +
                 'positivo, ese día no se opera. Luego se piramida como las tortugas: una unidad más cada ½ N ' +
                 'a favor desde el último relleno, y con cada añadido el stop de toda la posición baja a 2 N ' +
                 'por encima de él (solo si así se aprieta). N es la de las tortugas, en velas diarias: el ATR de ' +
                 'Wilder de 20 sesiones hasta la anterior, con el diario de Yahoo del índice. Como mucho un añadido por vela de 5 min ' +
                 'y hasta 4 posiciones con la entrada (3 añadidos); lo que siga abierto se cierra con la sesión. Con flip, si salta el stop en el ' +
                 'máximo de la vela se compra ahí mismo, con el stop en su mínimo y la misma pirámide hacia arriba. Se puede probar ' +
                 'también añadiendo cada ¼ N, y con una toma de beneficios a 1 N o 2 N de la entrada que cierra toda la posición.',
    Componente:  EstrategiaSegundaVela,
  },
  {
    id:          'tortugas-1',
    nombre:      'Tortugas S1',
    titular:     'Tortugas · sistema 1: ruptura de 20 sesiones, salida en la de 10',
    descripcion: 'El sistema de Richard Dennis (Market Wizards) llevado a los índices o a las acciones del ' +
                 'S&P 500, en velas diarias y durmiendo con la posición abierta. Compra al romper el máximo de las últimas 20 sesiones ' +
                 'y sale al romper el mínimo de las últimas 10. Si la ruptura anterior habría ganado, se la ' +
                 'salta y espera a la de 55. Cada ½ N a favor añade una unidad, hasta 6, y el stop de todas ' +
                 'va a 2 N de la última. N es el rango medio de 20 sesiones, y cada unidad se dimensiona para ' +
                 'que 1 N en contra cueste un porcentaje fijo del capital. Las órdenes son stop, así que un ' +
                 'hueco de la noche se ejecuta a la apertura. Cada noche se paga la financiación del CFD.',
    Componente:  EstrategiaTortugas,
  },
  {
    id:          'tortugas-2',
    nombre:      'Tortugas S2',
    titular:     'Tortugas · sistema 2: ruptura de 55 sesiones, salida en la de 20',
    descripcion: 'El sistema largo de las tortugas: compra al romper el máximo de las últimas 55 sesiones y ' +
                 'sale al romper el mínimo de las últimas 20, sin filtro de la ruptura anterior. Opera ' +
                 'menos y aguanta más que el 1, con las mismas reglas de unidades, pirámide hasta 6, stop a ' +
                 '2 N, huecos a la apertura y financiación de cada noche. Los límites por grupo y por sentido ' +
                 'están porque todos los índices se mueven juntos. Por defecto va solo largo: en índices, ' +
                 'los cortos pagan el dividendo y van contra la deriva alcista.',
    Componente:  EstrategiaTortugas,
  },
  {
    id:          'tortugas-12',
    nombre:      'Tortugas S1+S2',
    titular:     'Tortugas · los dos sistemas a la vez: el 2 coge las rupturas que el 1 se salta',
    descripcion: 'Los sistemas 1 y 2 en la misma cartera. El 1 compra al romper el máximo de 20 sesiones y sale ' +
                 'en el mínimo de 10, pero si la ruptura anterior habría ganado se la salta. Esa la coge el ' +
                 'sistema 2 cuando rompe el máximo de 55 y la lleva con sus reglas: sale en el mínimo de 20, que ' +
                 'le da más cuerda. Si la anterior perdió, entra el 1 y el 2 se queda fuera. Cada sistema lleva su ' +
                 'propia posición, con su pirámide hasta 6 y su stop a 2 N, así que si el 2 sigue dentro cuando le ' +
                 'toca entrar al 1, están los dos a la vez, salvo que su ruptura caiga a menos de ½ N de una unidad ' +
                 'del 2: van como uno y esa señal doble se ejecuta una sola vez. Cada entrada va con todo el ' +
                 'capital, así que las unidades son del mismo tamaño en los dos, y los ' +
                 'límites por grupo y por sentido cuentan las de ambos. Huecos a la apertura y financiación de ' +
                 'cada noche, como en los otros.',
    Componente:  EstrategiaTortugas,
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
