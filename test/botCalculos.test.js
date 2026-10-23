// Tests de las cuentas de las pestañas de los bots (src/botCalculos.js), con los datos del
// DAX del SRS y el EUR/USD de las tortugas del 19-oct-2026
import test from 'node:test'
import assert from 'node:assert/strict'

import { abiertoSrs, siguienteAnadidoSrs, rupturaMasCercana, acumulado, piernasDe, realFrenteABacktest } from '../src/botCalculos.js'

const daxCorto = {
  config: { piramide: 1 },
  plan: { valorPunto: 1, cambioAEur: 1 },
  precio: 25_318.3,
  operacion: {
    lado: 'corto', nivelOrden: 25_417.4, entrada: 25_417.2, riesgo: 33.9, stop: 25_375.3,
    unidades: [
      { tamano: 5.9, entrada: 25_417.2 }, { tamano: 3, entrada: 25_381.6 },
      { tamano: 3, entrada: 25_346.6 }, { tamano: 3, entrada: 25_315.4 },
    ],
  },
}

test('lo abierto del SRS con el último precio, y lo que dejaría el stop', () => {
  const { abierto, alStop } = abiertoSrs(daxCorto)
  // 5,9 × 98,9 + 3 × 63,3 + 3 × 28,3 + 3 × (−2,9)
  assert.ok(Math.abs(abierto - 849.61) < 1e-6)
  assert.ok(Math.abs(alStop - (5.9 * 41.9 + 3 * 6.3 + 3 * -28.7 + 3 * -59.9)) < 1e-6)
  assert.deepEqual(abiertoSrs({ ...daxCorto, precio: null }).abierto, null)
  assert.deepEqual(abiertoSrs({ ...daxCorto, operacion: { ...daxCorto.operacion, salida: { nivel: 1 } } }), { abierto: null, alStop: null })
})

test('el siguiente añadido sale como en el bot: n R a favor del nivel de la orden', () => {
  assert.ok(Math.abs(siguienteAnadidoSrs(daxCorto, 5) - (25_417.4 - 4 * 33.9)) < 1e-9)
  // con la pirámide llena, sin pirámide o sin añadidos, no hay siguiente
  assert.equal(siguienteAnadidoSrs(daxCorto, 4), null)
  assert.equal(siguienteAnadidoSrs({ ...daxCorto, config: { piramide: null } }, 5), null)
  assert.equal(siguienteAnadidoSrs({ ...daxCorto, operacion: { ...daxCorto.operacion, sinAnadidos: true } }, 5), null)
})

test('las piernas: la de antes de dar la vuelta y la de ahora', () => {
  assert.deepEqual(piernasDe({ anteriores: [{ lado: 'largo' }], operacion: { lado: 'corto' } }).map(p => p.lado), ['largo', 'corto'])
  assert.deepEqual(piernasDe({}), [])
})

const eurusd = {
  precio: 1.121225,
  posiciones: { 1: null, 2: null },
  plan: {
    n: 0.0064,
    sistemas: {
      1: { entrada: { largo: { nivel: 1.149452 }, corto: { nivel: 1.111408 } } },
      2: { entrada: { largo: { nivel: 1.171234 }, corto: { nivel: 1.111408 } } },
    },
  },
}

test('la ruptura más cercana de las tortugas, en N', () => {
  const r = rupturaMasCercana(eurusd, { sistemas: [1, 2], lados: 'ambos' })
  assert.equal(r.texto, 'de vender (S1)')
  assert.ok(Math.abs(r.n - (1.121225 - 1.111408) / 0.0064) < 1e-9)
  // solo largos: la compra del Sistema 1
  assert.equal(rupturaMasCercana(eurusd, { sistemas: [1, 2], lados: 'largos' }).texto, 'de comprar (S1)')
  // con una posición abierta en un sistema, ese cuenta lo que le falta para su stop
  const conPos = { ...eurusd, posiciones: { 1: { lado: 'corto', stop: 1.1340 }, 2: null } }
  const r2 = rupturaMasCercana(conPos, { sistemas: [1], lados: 'ambos' })
  assert.equal(r2.texto, 'del stop (S1)')
  assert.ok(Math.abs(r2.n - (1.1340 - 1.121225) / 0.0064) < 1e-9)
  assert.equal(rupturaMasCercana({ ...eurusd, plan: { error: 'sin cupo' } }, { sistemas: [1], lados: 'ambos' }), null)
})

test('el acumulado de una lista de resultados', () => {
  assert.deepEqual(acumulado([{ valor: 100 }, { valor: -40 }, { valor: 10 }]).map(p => p.acumulado), [100, 60, 70])
})

test('real frente al backtest: deslizamiento por instrumento y diferencia con el backtest, en puntos y en R', () => {
  const sesion = (ticker, real, bt, desl, rango = 20) => ({
    ticker, bracket: { rango }, resultadoPts: real, backtest: { valido: true, resultadoPts: bt },
    operacion: real == null ? null : { lado: 'largo', deslizamiento: desl[0], unidades: desl.map(x => ({ deslizamiento: x })) },
  })
  const historial = [
    sesion('^GDAXI', 10, 12, [2, 4]),
    sesion('^GDAXI', -20, -20, [0]),
    sesion('^GDAXI', null, 15, []),                        // el bot no entró y el backtest sí
    sesion('^NDX', 5, 5, [1], 10),
    { ticker: '^NDX', backtest: { valido: false } },     // no comparable
  ]
  const { filas, total } = realFrenteABacktest(historial)
  const dax = filas.find(f => f.ticker === '^GDAXI')
  assert.equal(dax.entradas, 3)
  assert.equal(dax.deslMedio, 2)
  assert.equal(dax.deslMediana, 2)
  assert.equal(dax.deslPctMedio, 10)
  assert.equal(dax.sesiones, 3)
  assert.equal(dax.real, -10)
  assert.equal(dax.backtest, 7)
  assert.ok(Math.abs(dax.difMedia - (-17 / 3)) < 1e-9)
  assert.ok(Math.abs(dax.difMediaR - (-17 / 60)) < 1e-9)
  assert.equal(dax.z, null, 'con menos de 5 no se juzga')
  assert.equal(total.entradas, 4)
  assert.equal(total.sesiones, 4)
  assert.ok(Math.abs(total.difMediaR - (-17 / 20 / 4)) < 1e-9)
})
