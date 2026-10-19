// Tests del motor de las tortugas (src/tortugas.js) con series hechas a mano
import test from 'node:test'
import assert from 'node:assert/strict'

import { prepararMercado, backtestTortugas, ordenesManana, nHastaStop, peorHastaStops } from '../src/tortugas.js'

test('lo que pierde una pirámide si salta su stop, que sube 2 N por debajo de la última unidad', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(k => nHastaStop(k)), [2, 3.5, 4.5, 5, 5, 4.5])
  assert.equal(nHastaStop(0), 0)
  assert.equal(nHastaStop(4, 2, 1), 2)                      // añadiendo cada 1 N: 2 + 1 + 0 − 1
})

test('lo peor si saltan todos los stops: el peor reparto de las unidades entre índices y grupos', () => {
  // 8 índices (Asia 2, Europa 2, EE. UU. 4), 6 por índice, 30 por sentido y grupos sin tope:
  // 8 × 3 unidades (4,5 N) y 6 cuartas unidades (+0,5 N cada una) = 39 N, no 30 × 2 = 60
  assert.deepEqual(peorHastaStops({ grupos: [2, 2, 4], maxUnidades: 6, maxGrupo: 30, maxSentido: 30 }), { n: 39, unidades: 30 })
  // con 9 por grupo solo caben 27 unidades; lo peor: Asia y Europa 4 + 4 (10 N cada una) y
  // EE. UU. 3 + 2 + 2 + 2 (15 N)
  assert.deepEqual(peorHastaStops({ grupos: [2, 2, 4], maxUnidades: 6, maxGrupo: 9, maxSentido: 30 }), { n: 35, unidades: 27 })
  // una sola unidad por índice: 2 N cada una
  assert.deepEqual(peorHastaStops({ grupos: [3], maxUnidades: 1, maxGrupo: 10, maxSentido: 10 }), { n: 6, unidades: 3 })
})

const INFO = { id: 'X', nombre: 'X', grupo: 'G', zona: 'UTC', cierre: '16:00', desde: '1900-01-01', spread: 0, dividendo: 0 }
// sin costes ni reducción por drawdown: las cuentas salen redondas
const LIMPIO = { capital: 100_000, deslizN: 0, financiacion: false, reduccionDD: false, desde: '2000-01-01' }
const SIN_TIPO = [{ date: '1900-01-01', close: 0 }]

// Días laborables desde el viernes 7-ene-2000: así la vela 70 cae en viernes
function fechas(n) {
  const out = []
  for (let d = Date.UTC(2000, 0, 7); out.length < n; d += 86_400_000) {
    const w = new Date(d).getUTCDay()
    if (w !== 0 && w !== 6) out.push(new Date(d).toISOString().slice(0, 10))
  }
  return out
}
const conFechas = velas => fechas(velas.length).map((date, k) => ({ date, ...velas[k] }))
const vela = (o, h, l, c) => ({ open: o, high: h, low: l, close: c })

// 60 velas de 99 a 101 (rango verdadero 2, así que N = 2) y 10 más estrechas por dentro,
// que no tocan el máximo ni el mínimo de 20 sesiones
const base = () => [
  ...Array.from({ length: 60 }, () => vela(100, 101, 99, 100)),
  ...Array.from({ length: 10 }, () => vela(100, 100.9, 98.9, 100)),
]
// la ruptura: entra en 101 y añade en 102, 103 y 104 (cada ½ N)
const RUPTURA = vela(100, 104, 99.5, 103.8)

test('prepararMercado: N de Wilder y canales de las sesiones anteriores', () => {
  const m = prepararMercado(INFO, conFechas([...base(), RUPTURA, vela(103, 103.5, 99, 99.5)]))
  assert.equal(m.n[70], 2)
  assert.equal(m.alto[20][70], 101)       // la propia vela no cuenta
  assert.equal(m.alto[20][71], 104)
  assert.equal(m.bajo[10][70], 98.9)
  assert.ok(Number.isNaN(m.alto[55][54]))
})

test('pirámide cada ½ N con el stop común a 2 N del último añadido', () => {
  const velas = conFechas([...base(), RUPTURA, vela(103, 103.5, 99, 99.5)])
  const res = backtestTortugas([prepararMercado(INFO, velas)], SIN_TIPO, LIMPIO)
  assert.equal(res.operaciones.length, 1)
  const op = res.operaciones[0]
  assert.equal(op.n, 2)
  assert.equal(op.unidades, 4)
  assert.equal(op.precioEntrada, 102.5)
  assert.equal(op.motivo, 'stop')
  assert.equal(op.precioSalida, 100)               // 104 − 2 N
  // unidad = 0,2 % · 100.000 / 2 = 100 €/pt, y pierde 1 + 2 + 3 + 4 puntos
  assert.equal(op.neto, -1000)
  assert.deepEqual(op.tamanos, [100, 100, 100, 100])
  assert.equal(op.tamano, 400)
  assert.equal(op.nominal, 400 * 102.5)
})

test('si la noche salta el stop, sale a la apertura', () => {
  const velas = conFechas([...base(), RUPTURA, vela(98, 98.5, 97, 97.5)])
  const op = backtestTortugas([prepararMercado(INFO, velas)], SIN_TIPO, LIMPIO).operaciones[0]
  assert.equal(op.precioSalida, 98)
  assert.equal(op.neto, -1800)
})

test('la pirámide se para en maxUnidades y el stop queda más abajo', () => {
  const velas = conFechas([...base(), RUPTURA, vela(103, 103.5, 99, 99.5)])
  const res = backtestTortugas([prepararMercado(INFO, velas)], SIN_TIPO, { ...LIMPIO, maxUnidades: 2 })
  // con 2 unidades el stop va a 102 − 4 = 98, y el mínimo de 99 no lo toca
  assert.equal(res.operaciones.length, 0)
  assert.equal(res.abiertas.length, 1)
  assert.equal(res.abiertas[0].unidades, 2)
})

test('financiación: el viernes por la noche cuenta tres noches', () => {
  const velas = conFechas([...base(), RUPTURA, vela(103, 103.5, 99, 99.5)])
  assert.equal(new Date(velas[70].date).getUTCDay(), 5)
  const op = backtestTortugas([prepararMercado(INFO, velas)], [{ date: '1900-01-01', close: 4 }],
    { ...LIMPIO, financiacion: true, recargo: 0.025 }).operaciones[0]
  // 400 €/pt sobre un cierre de 103,8, al 4 % + 2,5 %, durante 3 noches
  const esperado = 400 * 103.8 * 0.065 * 3 / 365
  assert.ok(Math.abs(op.financiacion - esperado) < 1e-9)
  assert.ok(Math.abs(op.neto - (-1000 - esperado)) < 1e-9)
})

test('solo largos no abre cortos aunque rompa el mínimo', () => {
  const quieta = Array.from({ length: 70 }, (_, k) => vela(100, 101 - 0.001 * k, 99 + 0.001 * k, 100))
  const velas = conFechas([...quieta, vela(100, 100.5, 95, 95.5), vela(95, 95.5, 90, 90.5)])
  assert.equal(backtestTortugas([prepararMercado(INFO, velas)], SIN_TIPO, LIMPIO).operaciones.length, 0)
  const ambos = backtestTortugas([prepararMercado(INFO, velas)], SIN_TIPO, { ...LIMPIO, lados: 'ambos' })
  assert.equal(ambos.abiertas[0].lado, 'corto')
})

test('sistema 1: tras una ruptura de 20 ganadora, la siguiente espera a la de 55', () => {
  const sube = Array.from({ length: 14 }, (_, j) => vela(105 + 0.01 * j, 105.5 + 0.01 * j, 104.5 + 0.01 * j, 105 + 0.01 * j))
  // un triángulo que se va cerrando: ninguna vela toca los extremos de las anteriores
  const triangulo = Array.from({ length: 20 }, (_, j) => vela(103, 103.4 - 0.01 * j, 102.6 + 0.01 * j, 103))
  const velas = conFechas([
    ...base().slice(0, 60), ...Array.from({ length: 10 }, () => vela(100, 100.9, 99.1, 100)),
    vela(100, 103, 99.5, 102.9),     // ruptura de 20: entra la real y la virtual
    ...sube,
    vela(104.4, 104.6, 103, 103.2),  // salta el mínimo de 10 con beneficio
    ...triangulo,
    vela(103, 104, 102.9, 103.9),    // rompe el máximo de 20 (103,4), no el de 55
  ])
  const res = backtestTortugas([prepararMercado(INFO, velas)], SIN_TIPO, LIMPIO)
  assert.equal(res.operaciones.length, 1)
  assert.equal(res.operaciones[0].motivo, 'canal 10')
  assert.ok(res.operaciones[0].neto > 0)
  assert.equal(res.abiertas.length, 0)               // la segunda ruptura no se opera
  const [o] = ordenesManana(res, 20_000)
  assert.equal(o.filtro, true)
  assert.equal(o.compra.k, 55)
  assert.ok(Math.abs(o.compra.nivel - 105.63) < 1e-9)
})

// ── Los dos sistemas a la vez ──

const SUBE = Array.from({ length: 14 }, (_, j) => vela(105 + 0.01 * j, 105.5 + 0.01 * j, 104.5 + 0.01 * j, 105 + 0.01 * j))
const TRIANGULO = Array.from({ length: 20 }, (_, j) => vela(103, 103.4 - 0.01 * j, 102.6 + 0.01 * j, 103))
// la serie del test anterior: una ruptura de 20 ganadora y otra de 20 que el sistema 1 se salta
const SALTADA = () => [
  ...base().slice(0, 60), ...Array.from({ length: 10 }, () => vela(100, 100.9, 99.1, 100)),
  vela(100, 103, 99.5, 102.9), ...SUBE, vela(104.4, 104.6, 103, 103.2), ...TRIANGULO,
  vela(103, 104, 102.9, 103.9),
]

test('los dos a la vez: la ruptura que el sistema 1 se salta la coge el 2 en la de 55', () => {
  const res = backtestTortugas([prepararMercado(INFO, conFechas(SALTADA()))], SIN_TIPO, { ...LIMPIO, sistema: '1+2' })
  assert.deepEqual(res.operaciones.map(o => [o.sistema, o.ruptura, o.motivo]), [[1, 20, 'canal 10']])
  assert.equal(res.abiertas.length, 0)
  const [s1, s2] = ordenesManana(res, 20_000)
  assert.deepEqual([s1.indice, s1.sistema, s2.indice, s2.sistema], ['X', 1, 'X', 2])
  assert.equal(s1.filtro, true)
  assert.equal(s1.compra, null)                    // el 1 no tiene la de 55 de reserva
  assert.equal(s2.compra.k, 55)
  assert.ok(Math.abs(s2.compra.nivel - 105.63) < 1e-9)
})

test('los dos a la vez: el sistema 2 lleva la de 55 con su salida de 20, no con la de 10', () => {
  const velas = conFechas([
    ...SALTADA(),
    vela(104, 106.4, 103.9, 106.3),                // rompe la de 55 (105,63)
    ...Array.from({ length: 24 }, (_, j) => vela(106.5 + j, 107.4 + j, 106.4 + j, 107.3 + j)),
    vela(130, 130.1, 115, 115.5),                  // rompe el mínimo de 10 (120,4), no el de 20
    vela(115, 115.5, 108, 108.5),                  // rompe el de 20 (111,4)
  ])
  const mercado = prepararMercado(INFO, velas)
  const cfg = { ...LIMPIO, maxUnidades: 1 }
  // solo, el sistema 1 entra en la de 55 de reserva y sale en la de 10
  const solo = backtestTortugas([mercado], SIN_TIPO, { ...cfg, sistema: 1 }).operaciones.at(-1)
  assert.deepEqual([solo.sistema, solo.ruptura, solo.motivo, solo.precioSalida], [1, 55, 'canal 10', 120.4])
  const juntos = backtestTortugas([mercado], SIN_TIPO, { ...cfg, sistema: '1+2' }).operaciones
  assert.deepEqual(juntos.map(o => [o.sistema, o.ruptura, o.motivo]), [[1, 20, 'canal 10'], [2, 55, 'canal 20']])
  assert.equal(juntos[1].precioEntrada, 105.63)
  assert.equal(juntos[1].precioSalida, 111.4)
})

test('los dos a la vez: si la ruptura anterior perdió, entra el sistema 1 y el 2 se queda fuera', () => {
  const velas = conFechas([
    ...base(), RUPTURA,
    vela(103, 103.5, 96, 96.5),                    // rompe el mínimo de 10 (98,9): la real y la virtual pierden
    ...Array.from({ length: 10 }, () => vela(100, 101, 99, 100)),
    vela(100, 106, 99.9, 105.9),                   // 104 es a la vez el máximo de 20 y el de 55
  ])
  const res = backtestTortugas([prepararMercado(INFO, velas)], SIN_TIPO, { ...LIMPIO, sistema: '1+2', maxUnidades: 1 })
  assert.deepEqual(res.operaciones.map(o => [o.sistema, o.motivo, o.precioSalida]), [[1, 'canal 10', 98.9]])
  assert.equal(res.estados[0].gano, false)
  assert.deepEqual(res.abiertas.map(o => [o.sistema, o.ruptura, o.precioEntrada]), [[1, 20, 104]])
  const [, s2] = ordenesManana(res, 20_000)
  assert.equal(s2.posicion, null)
  assert.equal(s2.compra, null)
})

test('lo peor hasta los stops con dos pirámides por índice, una por sistema', () => {
  // 12 unidades en un índice: lo peor son dos pirámides de 4 (5 N cada una), no una de 6
  assert.deepEqual(peorHastaStops({ grupos: [1], maxUnidades: 6, maxGrupo: 12, maxSentido: 12, sistemas: 2 }), { n: 10, unidades: 12 })
  // con 2 unidades, una en cada sistema pierde 2 + 2 N; las dos en la misma pirámide, 3,5
  assert.deepEqual(peorHastaStops({ grupos: [1], maxUnidades: 6, maxGrupo: 2, maxSentido: 2, sistemas: 2 }), { n: 4, unidades: 2 })
  assert.deepEqual(peorHastaStops({ grupos: [1], maxUnidades: 6, maxGrupo: 2, maxSentido: 2 }), { n: 3.5, unidades: 2 })
})
