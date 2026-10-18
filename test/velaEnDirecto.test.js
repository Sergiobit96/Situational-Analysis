// Tests de cómo entran en el gráfico las velas de 1 min en directo (src/velaEnDirecto.js)
import test from 'node:test'
import assert from 'node:assert/strict'

import { meterVelaEnDirecto } from '../src/velaEnDirecto.js'

const M = 60, H = 3600
const vela = (time, open, high, low, close) => ({ time, open, high, low, close })

test('dentro de la última vela de 15 min la amplía y mueve el cierre', () => {
  const datos = [vela(0, 100, 105, 95, 102)]
  const r = meterVelaEnDirecto(datos, vela(7 * M, 102, 108, 101, 107), 15 * M)
  assert.deepEqual(r, vela(0, 100, 108, 95, 107))
  assert.equal(datos.length, 1)
  // la misma actualización otra vez no cambia nada
  assert.deepEqual(meterVelaEnDirecto(datos, vela(7 * M, 102, 108, 101, 107), 15 * M), r)
})

test('al pasar del periodo abre una vela nueva con la apertura del minuto', () => {
  const datos = [vela(0, 100, 105, 95, 102)]
  const r = meterVelaEnDirecto(datos, vela(15 * M, 103, 104, 102, 103.5), 15 * M)
  assert.deepEqual(r, vela(15 * M, 103, 104, 102, 103.5))
  assert.equal(datos.length, 2)
})

test('la de 4 h sigue la rejilla del histórico aunque no empiece en hora redonda', () => {
  // la última vela de 4 h empezó a la 1:00 (rejilla 1, 5, 9…): un minuto de las 9:30 va a la de las 9:00
  const datos = [vela(1 * H, 100, 101, 99, 100)]
  const r = meterVelaEnDirecto(datos, vela(9 * H + 30 * M, 110, 111, 109, 110), 4 * H)
  assert.equal(r.time, 9 * H)
})

test('tras un fin de semana cae en el día que toca', () => {
  const viernes = 4 * 86400
  const datos = [vela(viernes, 100, 101, 99, 100)]
  const r = meterVelaEnDirecto(datos, vela(7 * 86400 + 9 * H, 105, 106, 104, 105), 86400)
  assert.equal(r.time, 7 * 86400)   // el lunes, no el sábado
})

test('lo anterior a la última vela se ignora, y sin histórico arranca una vela nueva', () => {
  const datos = [vela(15 * M, 100, 101, 99, 100)]
  assert.equal(meterVelaEnDirecto(datos, vela(5 * M, 1, 1, 1, 1), 15 * M), null)
  const vacio = []
  assert.deepEqual(meterVelaEnDirecto(vacio, vela(17 * M, 100, 101, 99, 100), 15 * M), vela(15 * M, 100, 101, 99, 100))
})
