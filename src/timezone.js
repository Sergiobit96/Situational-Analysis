// Offset Madrid en segundos para un timestamp UTC concreto (maneja CET/CEST según la
// fecha, no según "ahora" — imprescindible porque el desfase cambia entre invierno y verano)
export function madridOffsetAt(tsSecs) {
  const d     = new Date(tsSecs * 1000)
  const local = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }))
  const utc   = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }))
  return Math.round((local - utc) / 1000)
}
