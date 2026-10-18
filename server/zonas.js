// ── Horas en la zona de cada bolsa ─────────────────────────────────────────────────
// El bot abre cada sesión a la hora de su bolsa (09:00 en Fráncfort, 09:30 en Nueva York,
// 09:00 en Tokio), no a una hora fija de Madrid: las semanas en que Europa y Estados Unidos
// no han cambiado de horario a la vez, Nueva York abre a las 14:30 de Madrid, y Japón no
// cambia nunca. Todo con Intl, así que no depende de la zona horaria del servidor.

const formateadores = new Map()
const memoria = new Map()

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

// Desfase de la zona en segundos en ese instante (memorizado por hora UTC: los cambios de
// horario caen en hora en punto)
export function offsetZona(ts, zona) {
  const hora = Math.floor(ts / 3600)
  const clave = `${zona}|${hora}`
  const visto = memoria.get(clave)
  if (visto !== undefined) return visto
  const p = {}
  for (const { type, value } of formateador(zona).formatToParts(hora * 3600 * 1000)) p[type] = value
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000
  const off = local - hora * 3600
  if (memoria.size > 100_000) memoria.clear()
  memoria.set(clave, off)
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
