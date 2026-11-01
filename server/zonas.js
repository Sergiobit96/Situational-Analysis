// ── Horas en la zona de cada bolsa ─────────────────────────────────────────────────
// El bot abre cada sesión a la hora de su bolsa (09:00 en Fráncfort, 09:30 en Nueva York,
// 09:00 en Tokio), no a una hora fija de Madrid: las semanas en que Europa y Estados Unidos
// no han cambiado de horario a la vez, Nueva York abre a las 14:30 de Madrid, y Japón no
// cambia nunca. Todo con Intl, así que no depende de la zona horaria del servidor.

const formateadores = new Map()
const memoria = new Map()   // zona → (día UTC → desfase)

function formateador(zona) {
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

// Desfase de la zona en segundos a una hora UTC en punto (los cambios de horario caen en hora
// en punto)
function offsetHora(hora, zona) {
  const p = {}
  for (const { type, value } of formateador(zona).formatToParts(hora * 3600 * 1000)) p[type] = value
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000
  return local - hora * 3600
}

// Desfase de la zona en segundos en ese instante. Memorizado por día UTC: el horario cambia
// como mucho una vez al día, así que si a las 00:00 y a las 23:00 es el mismo, vale para todo
// el día; el día del cambio se mira la hora. Por horas, 30 años de velas (262.000 horas)
// vaciaban la memoria una y otra vez.
export function offsetZona(ts, zona) {
  const dia = Math.floor(ts / 86400)
  let dias = memoria.get(zona)
  if (!dias) memoria.set(zona, (dias = new Map()))
  let d = dias.get(dia)
  if (d === undefined) {
    const a = offsetHora(dia * 24, zona), b = offsetHora(dia * 24 + 23, zona)
    d = a === b ? a : { horas: new Map() }
    if (dias.size > 100_000) dias.clear()
    dias.set(dia, d)
  }
  if (typeof d === 'number') return d
  const hora = Math.floor(ts / 3600)
  let off = d.horas.get(hora)
  if (off === undefined) d.horas.set(hora, (off = offsetHora(hora, zona)))
  return off
}

// La fecha (YYYY-MM-DD) y el día de la semana (0 = domingo) en la zona
export const fechaEnZona = (ts, zona) => new Date((ts + offsetZona(ts, zona)) * 1000).toISOString().slice(0, 10)
export const diaSemanaEnZona = (ts, zona) => new Date((ts + offsetZona(ts, zona)) * 1000).getUTCDay()

// El instante (UTC, en segundos) en que son esos minutos del día `fecha` en la zona. Se
// corrige dos veces el desfase por si la hora cae al otro lado de un cambio de horario.
export function instanteEnZona(fecha, minutos, zona) {
  const [a, m, d] = fecha.split('-').map(Number)
  const comoUTC = Date.UTC(a, m - 1, d, 0, minutos) / 1000
  let t = comoUTC - offsetZona(comoUTC, zona)
  t = comoUTC - offsetZona(t, zona)
  return t
}
