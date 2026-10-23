// Tests del motor de las tortugas (src/tortugas.js) con series hechas a mano
import test from 'node:test'
import assert from 'node:assert/strict'

import { prepararMercado, backtestTortugas, ordenesManana, nHastaStop, peorHastaStops, peoresCaidas, expedienteBacktest, senalDoble, anadidoDe, CONFIG_TORTUGAS } from '../src/tortugas.js'

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

test('los dos a la vez van como uno: la ruptura a menos de ½ N de una unidad del otro sistema no entra', () => {
  const juntos = { ...CONFIG_TORTUGAS, sistema: '1+2' }
  // el 2 tiene unidades a 100 y 101 en largo; N = 2, así que ½ N = 1
  const e = { pos: { 1: null, 2: { lado: 1, unidades: [{ ref: 100 }, { ref: 101 }] } } }
  assert.equal(senalDoble(juntos, e, 1, 1, 101.9, 2), true)
  assert.equal(senalDoble(juntos, e, 1, 1, 102.1, 2), false)    // a más de ½ N: entra
  assert.equal(senalDoble(juntos, e, 1, -1, 101, 2), false)     // en el otro sentido no es la misma señal
  assert.equal(senalDoble({ ...juntos, sistema: 1 }, e, 1, 1, 101, 2), false)   // con un solo sistema no aplica
})

test('los dos a la vez: la pirámide no añade a menos de ½ N de una unidad del otro sistema', () => {
  const juntos = { ...CONFIG_TORTUGAS, sistema: '1+2' }
  // el 1 entró a 99,5 con N = 2: añadiría a 100,5, pero el 2 ya tiene 100 y 101
  const e = { pos: { 1: { lado: 1, n0: 2, unidades: [{ ref: 99.5 }] }, 2: { lado: 1, unidades: [{ ref: 100 }, { ref: 101 }] } } }
  assert.equal(anadidoDe(juntos, e, 1), 102)
  assert.equal(anadidoDe({ ...juntos, sistema: 1 }, e, 1), 100.5)              // con un solo sistema no aplica
  assert.equal(anadidoDe(juntos, { pos: { ...e.pos, 2: { ...e.pos[2], lado: -1 } } }, 1), 100.5)
})

test('lo peor hasta los stops con dos pirámides por índice, una por sistema', () => {
  // 12 unidades en un índice: lo peor son dos pirámides de 4 (5 N cada una), no una de 6
  assert.deepEqual(peorHastaStops({ grupos: [1], maxUnidades: 6, maxGrupo: 12, maxSentido: 12, sistemas: 2 }), { n: 10, unidades: 12 })
  // con 2 unidades, una en cada sistema pierde 2 + 2 N; las dos en la misma pirámide, 3,5
  assert.deepEqual(peorHastaStops({ grupos: [1], maxUnidades: 6, maxGrupo: 2, maxSentido: 2, sistemas: 2 }), { n: 4, unidades: 2 })
  assert.deepEqual(peorHastaStops({ grupos: [1], maxUnidades: 6, maxGrupo: 2, maxSentido: 2 }), { n: 3.5, unidades: 2 })
})

// ── Acciones ──

// la misma ruptura en una acción: comisión por acción con mínimo por orden, acciones enteras
const ACCION = { ...INFO, comision: { porAccion: 0.02, minimo: 15 }, lote: 1 }
const RUPTURA_Y_STOP = () => conFechas([...base(), RUPTURA, vela(103, 103.5, 99, 99.5)])

test('acciones: cada unidad paga su comisión al entrar y al salir, con 15 $ como mínimo por orden', () => {
  const op = backtestTortugas([prepararMercado(ACCION, RUPTURA_Y_STOP())], SIN_TIPO, LIMPIO).operaciones[0]
  // 100 acciones por unidad: 2 $ por orden, así que manda el mínimo; 4 entradas y 4 salidas
  assert.equal(op.comision, 8 * 15)
  assert.equal(op.neto, -1000 - 120)
  assert.equal(op.acciones, 400)
  // con 2.000 acciones por unidad pasa del mínimo: 40 $ por orden
  const grande = backtestTortugas([prepararMercado(ACCION, RUPTURA_Y_STOP())], SIN_TIPO, { ...LIMPIO, capital: 2_000_000 }).operaciones[0]
  assert.equal(grande.comision, 8 * 40)
  const sin = backtestTortugas([prepararMercado(ACCION, RUPTURA_Y_STOP())], SIN_TIPO, { ...LIMPIO, comisiones: false }).operaciones[0]
  assert.equal(sin.comision, 0)
  assert.equal(sin.neto, -1000)
})

test('acciones: la unidad va en acciones enteras de las de entonces (la serie está ajustada por splits)', () => {
  // un split de 4 por 1 después: cada acción de entonces son 4 de la serie
  const velas = RUPTURA_Y_STOP().map(v => ({ ...v, f: 4 }))
  const info = { ...ACCION, comision: { porAccion: 1, minimo: 0 } }
  // 0,2 % de 101.000 / 2 = 101 de la serie: 25 de entonces, que son 100 de la serie
  const op = backtestTortugas([prepararMercado(info, velas)], SIN_TIPO, { ...LIMPIO, capital: 101_000 }).operaciones[0]
  assert.deepEqual(op.tamanos, [100, 100, 100, 100])
  assert.equal(op.acciones, 100)
  assert.equal(op.comision, 8 * 25)                  // 1 $ por cada acción de entonces
  // si no llega a una acción entera, no entra
  const poco = backtestTortugas([prepararMercado(info, velas)], SIN_TIPO, { ...LIMPIO, capital: 3_000 })
  assert.equal(poco.operaciones.length + poco.abiertas.length, 0)
})

test('acciones: con «solo desde que entró en el índice» no abre antes de esa fecha', () => {
  const velas = RUPTURA_Y_STOP()
  const info = { ...ACCION, alta: velas[71].date }   // entra en el índice el día después de la ruptura
  assert.equal(backtestTortugas([prepararMercado(info, velas)], SIN_TIPO, LIMPIO).operaciones.length, 0)
  assert.equal(backtestTortugas([prepararMercado(info, velas)], SIN_TIPO, { ...LIMPIO, soloEnIndice: false }).operaciones.length, 1)
})

test('acciones: el largo cobra el dividendo el día que la acción cotiza sin él', () => {
  const velas = RUPTURA_Y_STOP()
  velas[71] = { ...velas[71], div: 0.5 }
  // con el tipo y el recargo a 0, la financiación es solo el dividendo: 400 acciones × 0,5
  const op = backtestTortugas([prepararMercado({ ...ACCION, comision: undefined }, velas)], SIN_TIPO, { ...LIMPIO, financiacion: true, recargo: 0 }).operaciones[0]
  assert.equal(op.financiacion, -200)
  assert.equal(op.neto, -800)
})

test('prepararMercado: el dividendo de una vela sin rango pasa a la siguiente', () => {
  const velas = conFechas([...base(), { ...vela(100, 100, 100, 100), div: 1 }, vela(100, 101, 99, 100)])
  const m = prepararMercado(INFO, velas)
  assert.equal(m.fechas.length, 71)
  assert.equal(m.div[70], 1)
  assert.equal(prepararMercado(INFO, conFechas(base())).div, null)
})

// ── Expediente para la revisión con Claude ──

test('peores caídas: de máximo a máximo, la más honda primero y la de ahora sin recuperar', () => {
  const curva = [['01', 100], ['02', 90], ['03', 80], ['04', 100], ['05', 110], ['06', 99]]
    .map(([d, valor]) => ({ date: `2000-01-${d}`, valor }))
  assert.deepEqual(peoresCaidas(curva), [
    { desde: '2000-01-01', fondo: '2000-01-03', recuperada: '2000-01-04', caidaPct: -20, mesesBajoElMaximo: 0 },
    { desde: '2000-01-05', fondo: '2000-01-06', recuperada: 'aún no', caidaPct: -10, mesesBajoElMaximo: 0 },
  ])
  assert.equal(peoresCaidas(curva, 1).length, 1)
})

test('expediente: la operación de la pirámide, sin repetirla entre las mejores y las peores', () => {
  const velas = conFechas([...base(), RUPTURA, vela(103, 103.5, 99, 99.5)])
  const res = backtestTortugas([prepararMercado(INFO, velas)], SIN_TIPO, LIMPIO)
  const e = expedienteBacktest(res, { universo: 'indices' })
  assert.deepEqual(e.mercados, ['X'])
  assert.equal(e.configuracion.riesgoPorUnidadPctDelCapital, 0.2)
  assert.equal(e.resultado.operaciones, 1)
  assert.equal(e.concentracion.todas, -1)                  // −1.000 € de 100.000
  assert.equal(e.concentracion.todasMenosLas10Mejores, 0)
  assert.equal(e.mejoresOperaciones.length, 1)
  assert.equal(e.peoresOperaciones.length, 0)
  assert.deepEqual(e.porMotivoDeSalida, { stop: { operaciones: 1, aciertoPct: 0, netoEur: -1000, profitFactor: 0 } })
  assert.deepEqual(e.porUnidadesAlCerrar, [{ unidades: 4, operaciones: 1, aciertoPct: 0, netoEur: -1000 }])
  assert.equal(e.porMercado[0].netoEur, -1000)
  assert.equal(e.porLado, undefined)                        // solo largos
  assert.equal(e.variantes, undefined)
  assert.equal(e.periodo.hasta, velas.at(-1).date)
  // con variantes, la de arriba va marcada
  const conVariantes = expedienteBacktest(res, { universo: 'indices', variantes: [{ sistema: '1+2', lados: 'ambos', unidades: 4, actual: true, m: { cagr: 1.234 } }] })
  assert.deepEqual(conVariantes.variantes[0], {
    sistema: 'S1 + S2', lados: 'ambos', maxUnidades: 4, esLaDeArriba: true,
    cagrPct: 1.23, maxDrawdownPct: null, mar: null, sharpe: null, operaciones: null, profitFactor: null, financiacionPctDelBruto: null,
  })
})
