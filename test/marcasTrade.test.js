// Tests de dónde se pintan las operaciones del diario sobre las velas (src/marcasTrade.js)
import test from 'node:test'
import assert from 'node:assert/strict'

import { pasoDeVelas, velaQueContiene, pegarAVela } from '../src/marcasTrade.js'

// velas de 1 min desde las 16:40 (hora de pared guardada como UTC), con un hueco a las 16:44
const T0 = Date.UTC(2026, 5, 25, 16, 40) / 1000
const velas = [
  { time: T0,       low: 10555.4, high: 10561.9 },
  { time: T0 + 60,  low: 10557.9, high: 10562.5 },
  { time: T0 + 120, low: 10550.9, high: 10555.2 },
  { time: T0 + 180, low: 10549.0, high: 10551.0 },
  { time: T0 + 300, low: 10548.0, high: 10550.0 },
]
const paso = pasoDeVelas(velas)

test('pasoDeVelas: la menor separación, aunque haya huecos', () => {
  assert.equal(paso, 60)
  assert.equal(pasoDeVelas([{ time: 0 }]), 60)
})

test('velaQueContiene: la vela de su minuto, o ninguna si cae fuera o en un hueco', () => {
  assert.equal(velaQueContiene(velas, paso, T0 + 77), velas[1])     // 16:41:17
  assert.equal(velaQueContiene(velas, paso, T0 - 1), null)
  assert.equal(velaQueContiene(velas, paso, T0 + 250), null)        // 16:44:10, sin vela
  assert.equal(velaQueContiene(velas, paso, T0 + 359), velas[4])
  assert.equal(velaQueContiene(velas, paso, T0 + 360), null)
})

test('pegarAVela: va sobre su vela y se pega al extremo si se sale por poco', () => {
  // la salida de las 16:41:17 a 10556,6: 1,3 puntos por debajo de su vela
  assert.deepEqual(pegarAVela(velas, paso, T0 + 77, 10556.6), { time: T0 + 60, price: 10557.9 })
  // dentro de la vela se queda en su precio, pero en la ranura de la vela
  assert.deepEqual(pegarAVela(velas, paso, T0 + 150, 10552), { time: T0 + 120, price: 10552 })
  // por encima, al máximo
  assert.deepEqual(pegarAVela(velas, paso, T0 + 190, 10553), { time: T0 + 180, price: 10551 })
})

test('pegarAVela: una diferencia grande no se esconde', () => {
  // 20 puntos son el 0,19 %: más que cualquier diferencia entre feeds
  assert.deepEqual(pegarAVela(velas, paso, T0 + 77, 10537.9), { time: T0 + 60, price: 10537.9 })
  // sin vela que la contenga, tal cual
  assert.deepEqual(pegarAVela(velas, paso, T0 + 250, 10500), { time: T0 + 250, price: 10500 })
})
