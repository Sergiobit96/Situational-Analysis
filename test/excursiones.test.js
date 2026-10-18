// Tests del MFE/MAE de las operaciones del diario (server/excursiones.js)
import test from 'node:test'
import assert from 'node:assert/strict'

import { aUtc, ladoDe, tramoDe, calcularExcursion, claveExcursion } from '../server/excursiones.js'

const utc = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000
// Las horas del diario son hora de pared de Madrid guardada como si fuera UTC
const madrid = utc

// Velas de 1 min desde `t0` (UTC), cada una con su máximo y mínimo
const velas = (t0, rangos) => rangos.map(([low, high], i) => ({
  time: t0 + i * 60, open: low, high, low, close: high,
}))

// Largo en el DAX el 2-feb-2026 (invierno, Madrid = UTC+1): entra a las 09:05:30 a 100 y
// sale a las 09:08:10 a 104. En UTC son las 08:05:30 y las 08:08:10.
const largo = {
  producto: 'Germany 40', ticker: '^GDAXI', direccion: 'LONG',
  openTime: madrid(2026, 2, 2, 9, 5, 30), openPrice: 100,
  closeTime: madrid(2026, 2, 2, 9, 8, 10), closePrice: 104,
  puntos: 4,
}
// 08:04 (antes de entrar), 08:05 (entrada), 08:06, 08:07, 08:08 (salida), 08:09 (después)
const velasDelLargo = velas(utc(2026, 2, 2, 8, 4), [
  [80, 120], [98, 101], [96, 103], [101, 107], [103, 105], [60, 140],
])

test('pasa la hora de Madrid del diario a UTC, en invierno y en verano', () => {
  assert.equal(aUtc(madrid(2026, 2, 2, 9, 0)), utc(2026, 2, 2, 8, 0))
  assert.equal(aUtc(madrid(2026, 7, 1, 9, 0)), utc(2026, 7, 1, 7, 0))
})

test('el lado sale de la dirección del diario o del historial, y si no del resultado', () => {
  assert.equal(ladoDe({ direccion: 'LONG' }), 'largo')
  assert.equal(ladoDe({ direccion: 'Sell' }), 'corto')
  assert.equal(ladoDe({ direccion: null, openPrice: 100, closePrice: 110, puntos: 10 }), 'largo')
  assert.equal(ladoDe({ direccion: null, openPrice: 100, closePrice: 110, puntos: -10 }), 'corto')
  assert.equal(ladoDe({ direccion: null, openPrice: 100, closePrice: 100, puntos: 0 }), null)
})

test('una operación del historial cerrada a cero saca el lado del signo del tamaño', () => {
  assert.equal(ladoDe({ direccion: null, size: -2, openPrice: 100, closePrice: 100, puntos: 0 }), 'corto')
  assert.equal(ladoDe({ direccion: null, size: 1.5, openPrice: 100, closePrice: 100, puntos: 0 }), 'largo')
})

test('el tramo va de la vela de la entrada a la de la salida, incluidas', () => {
  assert.deepEqual(tramoDe(largo), { tf: 'm1', desde: utc(2026, 2, 2, 8, 5), hasta: utc(2026, 2, 2, 8, 9) })
})

test('más de 2 días abierta se mide con velas de 1 h', () => {
  const swing = { ...largo, closeTime: largo.openTime + 3 * 86400 }
  const t = tramoDe(swing)
  assert.equal(t.tf, 'h1')
  assert.equal(t.desde, utc(2026, 2, 2, 8))
})

test('largo: MFE y MAE desde la entrada, sin las velas de fuera del tramo', () => {
  const r = calcularExcursion(largo, velasDelLargo)
  assert.equal(r.lado, 'largo')
  assert.equal(r.velas, 4)
  assert.equal(r.mfe, 7)     // máximo 107
  assert.equal(r.mae, -4)    // mínimo 96
  assert.equal(r.realizado, 4)
})

test('corto: lo favorable es hacia abajo', () => {
  const corto = { ...largo, direccion: 'SHORT', openPrice: 104, closePrice: 100, puntos: 4 }
  const r = calcularExcursion(corto, velasDelLargo)
  assert.equal(r.mfe, 8)     // mínimo 96
  assert.equal(r.mae, -3)    // máximo 107
  assert.equal(r.realizado, 4)
})

test('una operación llegó a ir al menos a su resultado, aunque las velas de otra fuente no lo enseñen', () => {
  // sale a 110, por encima de todo lo que marca Dukascopy en el tramo
  const r = calcularExcursion({ ...largo, closePrice: 110, puntos: 10 }, velasDelLargo)
  assert.equal(r.mfe, 10)
  // y una perdedora llegó a ir perdiendo al menos lo que perdió
  const p = calcularExcursion({ ...largo, closePrice: 90, puntos: -10 }, velasDelLargo)
  assert.equal(p.mae, -10)
})

test('la plata del bróker va ×100 respecto a Dukascopy', () => {
  const plata = { ...largo, producto: 'Silver', ticker: 'XAGUSD', openPrice: 6400, closePrice: 6410, puntos: 10 }
  const r = calcularExcursion(plata, velas(utc(2026, 2, 2, 8, 5), [[63.9, 64.25]]))
  assert.equal(r.mfe, 25)
  assert.equal(r.mae, -10)
})

test('sin velas en el tramo, o sin lado, no hay resultado', () => {
  assert.deepEqual(calcularExcursion(largo, []), { sinDatos: 'sin velas en el tramo' })
  const sinLado = { ...largo, direccion: null, closePrice: 100, puntos: 0 }
  assert.deepEqual(calcularExcursion(sinLado, velasDelLargo), { sinDatos: 'sin dirección' })
})

test('dos piernas abiertas y cerradas en el mismo segundo tienen cada una su clave', () => {
  const otra = { ...largo, openPrice: 101 }
  assert.notEqual(claveExcursion(largo), claveExcursion(otra))
  assert.equal(claveExcursion(largo), `Germany 40|${largo.openTime}|${largo.closeTime}|100|104`)
})
