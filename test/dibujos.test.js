// Tests de los dibujos guardados: colocar una hora entre velas de cualquier temporalidad
// (src/chartDrawingTools.js) y validar lo que llega al servidor (server/dibujos.js)
import test from 'node:test'
import assert from 'node:assert/strict'

import { pasoDe, ubicarTiempo } from '../src/chartDrawingTools.js'
import { limpiarDibujos, claveValida } from '../server/dibujos.js'

const H = 3600
// velas horarias de 09:00 a 17:00 de dos días seguidos (con la noche en medio)
const horarias = [0, 1].flatMap(dia => Array.from({ length: 9 }, (_, i) => dia * 86400 + (9 + i) * H))

test('el paso es el de la temporalidad, no el de la noche', () => {
  assert.equal(pasoDe(horarias), H)
  assert.equal(pasoDe([0]), 60)
})

test('una hora que es una vela cae justo en ella', () => {
  assert.deepEqual(ubicarTiempo(horarias, 11 * H, H), { i: 2, frac: 0 })
  assert.deepEqual(ubicarTiempo(horarias, horarias.at(-1), H), { i: 17, frac: 0 })
})

test('un punto dibujado en 15 min cae a mitad de su vela de 1 h', () => {
  assert.deepEqual(ubicarTiempo(horarias, 11 * H + 15 * 60, H), { i: 2, frac: 0.25 })
})

test('un punto de la noche cae entre el cierre y la apertura siguiente', () => {
  const u = ubicarTiempo(horarias, 86400 + 1 * H, H)   // 01:00 del segundo día
  assert.equal(u.i, 8)                                  // tras la vela de las 17:00
  assert.ok(u.frac > 0 && u.frac < 1)
})

test('fuera de los datos se cuenta en velas desde el borde', () => {
  assert.deepEqual(ubicarTiempo(horarias, 6 * H, H), { borde: 0, barras: -3 })
  assert.deepEqual(ubicarTiempo(horarias, 86400 + 20 * H, H), { borde: 17, barras: 3 })
  assert.equal(ubicarTiempo([], 0, H), null)
})

test('valida y limpia los dibujos antes de guardarlos', () => {
  const limpios = limpiarDibujos([
    { type: 'trendline', color: '#7c3aed', p1: { time: 1, price: 100 }, p2: { time: 2, price: 110 }, selected: true, id: 4 },
    { type: 'ray', color: 'javascript:x', p1: { time: 3, price: 105 }, p2: { time: 9, price: 9 } },
  ])
  assert.deepEqual(limpios, [
    { type: 'trendline', color: '#7c3aed', p1: { time: 1, price: 100 }, p2: { time: 2, price: 110 } },
    { type: 'ray', color: null, p1: { time: 3, price: 105 }, p2: null },
  ])
  assert.deepEqual(limpiarDibujos([]), [])
})

test('rechaza dibujos que romperían el gráfico al cargarlos', () => {
  assert.throws(() => limpiarDibujos('nada'), /lista/)
  assert.throws(() => limpiarDibujos([{ type: 'circulo', p1: { time: 1, price: 1 } }]), /tipo desconocido/)
  assert.throws(() => limpiarDibujos([{ type: 'fib', p1: { time: 1, price: 1 } }]), /puntos/)
  assert.throws(() => limpiarDibujos([{ type: 'ray', p1: { time: 'ayer', price: 1 } }]), /puntos/)
  assert.throws(() => limpiarDibujos(Array(501).fill({ type: 'ray', p1: { time: 1, price: 1 } })), /Demasiados/)
})

test('claves de instrumento', () => {
  assert.ok(claveValida('^GDAXI'))
  assert.ok(claveValida('^GDAXI@csv'))
  assert.ok(claveValida('XAUUSD'))
  assert.ok(!claveValida('../../etc'))
  assert.ok(!claveValida(''))
  assert.ok(!claveValida(undefined))
})
