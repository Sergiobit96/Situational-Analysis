// Tests de la robustez de un backtest (src/robustezCalculos.js)
import test from 'node:test'
import assert from 'node:assert/strict'

import { curvaDe, metricas, histograma, monteCarlo, sensibilidad, walkForward, porTercios, aleatorio } from '../src/robustezCalculos.js'

const cerca = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`)

test('la curva: peor drawdown, peor racha de pérdidas (los días sin operar no la cortan) y tiempo bajo el máximo', () => {
  const c = curvaDe([2, -1, 0, -1, -1, 3, 1])
  assert.equal(c.total, 3)
  assert.equal(c.maxDD, -3)
  assert.equal(c.peorRacha, 3)
  assert.equal(c.enDD, 4)
})

test('métricas en R: expectativa, SQN, Sortino y factor de recuperación', () => {
  const m = metricas([2, -1, 0, -1, 2])
  assert.equal(m.n, 4)
  assert.equal(m.expectativa, 0.5)
  const sd = Math.sqrt((1.5 ** 2 * 2 + 1.5 ** 2 * 2) / 3)
  cerca(m.sqn, 0.5 / sd * 2)
  cerca(m.sortino, 0.5 / Math.sqrt(2 / 4))
  assert.equal(m.maxDD, -2)
  assert.equal(m.recuperacion, 1)
  assert.equal(metricas([1, 1]).recuperacion, null, 'sin drawdown no hay cociente')
})

test('histograma en cubos de media R', () => {
  assert.deepEqual(histograma([-1, -0.9, 0, 0.2, 1.4], 0.5).map(c => [c.desde, c.n]), [[-1, 2], [-0.5, 0], [0, 1], [0.5, 0], [1, 1]])
  assert.deepEqual(histograma([0, 0]), [])
})

test('Monte Carlo: siempre el mismo con la misma semilla, el p95 del drawdown es peor que la mediana y una serie que solo gana no pierde nunca', () => {
  const serie = Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? 2 : -0.8))
  const a = monteCarlo(serie, { veces: 500, semilla: 7 })
  assert.deepEqual(a, monteCarlo(serie, { veces: 500, semilla: 7 }))
  assert.ok(a.dd.p95 <= a.dd.p50 && a.dd.p99 <= a.dd.p95)
  assert.ok(a.racha.p95 >= a.racha.p50)
  assert.ok(a.total.p5 <= a.total.p50 && a.total.p50 <= a.total.p95)
  cerca(a.total.p50, 200 * (2 / 3 - 0.8 * 2 / 3), 25)
  assert.equal(monteCarlo([1, 2, 3], { veces: 100 }).pctPierde, 0)
  assert.equal(monteCarlo([1]), null)
  const azar = aleatorio(3)
  assert.ok(Array.from({ length: 100 }, azar).every(x => x >= 0 && x < 1))
})

test('sensibilidad: el total, la expectativa y el drawdown de cada combinación', () => {
  const s = sensibilidad([{ a: 1, b: -1 }, { a: -2, b: 0 }, { a: 2 }], ['a', 'b'])
  assert.deepEqual(s.a, { total: 1, expectativa: 1 / 3, n: 3, maxDD: -2 })
  assert.deepEqual(s.b, { total: -1, expectativa: -1, n: 1, maxDD: -1 })
})

test('walk-forward: elige con lo de antes y mide en lo que viene; si la mejor cambia de tramo en tramo, se nota', () => {
  // 'a' gana en la primera mitad y pierde en la segunda; 'b' gana menos, pero siempre
  const matriz = Array.from({ length: 100 }, (_, i) => ({ fecha: i, a: i < 50 ? 1 : -1, b: 0.4 }))
  const wf = walkForward(matriz, ['a', 'b'], { tramos: 4, fechaDe: f => f.fecha })
  assert.equal(wf.partes.length, 3)
  assert.deepEqual(wf.partes.map(p => p.elegida), ['a', 'a', 'b'])
  assert.deepEqual(wf.partes.map(p => p.desde), [25, 50, 75])
  // tramo 2 (25..49) gana 25 con 'a'; tramo 3 (50..74) pierde 25 con 'a'; tramo 4 gana 10 con 'b'
  cerca(wf.totalFuera, 25 - 25 + 10)
  assert.equal(wf.fuera.length, 75)
  assert.ok(wf.eficiencia < 0.2)
  assert.equal(walkForward(matriz.slice(0, 20), ['a'], { tramos: 4 }), null)
})

test('régimen: el resultado por tercios de volatilidad', () => {
  const sesiones = Array.from({ length: 30 }, (_, i) => ({ medida: i, resultado: i < 10 ? -1 : i < 20 ? 0 : 2 }))
  const t = porTercios(sesiones)
  assert.deepEqual(t.map(x => [x.desde, x.hasta, x.n, x.total]), [[0, 9, 10, -10], [10, 19, 0, 0], [20, 29, 10, 20]])
  assert.equal(t[2].pctGanadas, 100)
  assert.equal(porTercios(sesiones.slice(0, 10)), null)
})

test('en % del capital las operaciones se componen: la caída nunca pasa del 100 %', () => {
  const c = curvaDe([10, -50, -50, 20], { compuesto: true })
  cerca(c.total, 100 * (1.1 * 0.5 * 0.5 * 1.2 - 1))
  cerca(c.maxDD, -75)
  assert.equal(c.peorRacha, 2)
  const muchas = Array.from({ length: 100 }, () => -5)
  assert.ok(curvaDe(muchas, { compuesto: true }).maxDD > -100)
  assert.equal(curvaDe(muchas).maxDD, -500, 'sumando sí pasaría')
  const mc = monteCarlo(muchas, { veces: 50, compuesto: true })
  assert.ok(mc.dd.p99 > -100 && mc.total.p1 > -100)
})
