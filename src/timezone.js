// Offset de una zona en segundos para un timestamp UTC concreto (maneja el cambio de
// horario según la fecha, no según "ahora" — imprescindible porque el desfase cambia
// entre invierno y verano)
//
// Esto se llama una vez por vela, y el análisis de la estrategia recorre cientos de miles
// (4.400 sesiones del CSV del DAX son 150.000 velas), así que el camino rápido importa:
//   · un formateador por zona, creado una sola vez — construir un Intl.DateTimeFormat en
//     cada llamada, que es lo que hace toLocaleString por dentro, costaba el 99% del tiempo;
//   · el resultado memorizado por hora UTC. Los cambios de horario caen siempre en hora en
//     punto, así que la hora es el cubo más grande que sigue dando el valor exacto.
const formateadores = new Map()
const memoria       = new Map()

// Más allá de esto la memoria deja de compensar: son ya 22 años de horas por zona y lo que
// se guarda son sesiones viejas que no se van a volver a mirar.
const MAX_MEMORIA = 200_000

function formateadorDe(zona) {
  let f = formateadores.get(zona)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zona, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    formateadores.set(zona, f)
  }
  return f
}

function offsetAt(tsSecs, zona) {
  const clave = `${zona}_${Math.floor(tsSecs / 3600)}`
  const visto = memoria.get(clave)
  if (visto !== undefined) return visto

  const p = {}
  for (const { type, value } of formateadorDe(zona).formatToParts(tsSecs * 1000)) p[type] = value
  // con hour12:false la medianoche sale como 24 en algunos motores
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000
  const off   = Math.round(local - tsSecs)

  if (memoria.size >= MAX_MEMORIA) memoria.clear()
  memoria.set(clave, off)
  return off
}

export const madridOffsetAt  = tsSecs => offsetAt(tsSecs, 'Europe/Madrid')
export const londresOffsetAt = tsSecs => offsetAt(tsSecs, 'Europe/London')
// Nueva York hace falta para anclar las noticias de la Fed, que salen a su hora local
export const nuevaYorkOffsetAt = tsSecs => offsetAt(tsSecs, 'America/New_York')
