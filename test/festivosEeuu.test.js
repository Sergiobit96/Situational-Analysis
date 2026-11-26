// Tests del calendario de cierres anticipados de los índices de EE. UU. (server/festivos-eeuu.js)
import test from 'node:test'
import assert from 'node:assert/strict'

import { cierraAntesNY } from '../server/festivos-eeuu.js'

const delAno = a => {
  const fechas = []
  for (let d = new Date(Date.UTC(a, 0, 1)); d.getUTCFullYear() === a; d = new Date(d.getTime() + 86_400_000)) {
    const f = d.toISOString().slice(0, 10)
    if (cierraAntesNY(f)) fechas.push(f)
  }
  return fechas
}

test('2025: los festivos con el CME abierto y las vísperas de media sesión', () => {
  assert.deepEqual(delAno(2025), [
    '2025-01-20', '2025-02-17', '2025-05-26', '2025-06-19', '2025-07-03', '2025-07-04',
    '2025-09-01', '2025-11-27', '2025-11-28', '2025-12-24',
  ])
})

test('2026: el 4 de julio en sábado se observa el viernes 3, que ya no es víspera', () => {
  assert.deepEqual(delAno(2026), [
    '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03',
    '2026-09-07', '2026-11-26', '2026-11-27', '2026-12-24',
  ])
})

test('2027: Navidad en sábado cierra el viernes 24, que no es media sesión; Juneteenth en sábado, el viernes', () => {
  const fechas = delAno(2027)
  assert.ok(!fechas.includes('2027-12-24'))
  assert.ok(fechas.includes('2027-06-18'))
  assert.ok(fechas.includes('2027-07-05'))
  assert.ok(!fechas.includes('2027-07-02'), 'el 3 de julio de 2027 es sábado: no hay víspera')
})
