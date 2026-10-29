// Tests de la comparación del bot de las tortugas con el backtest (src/tortugasComparar.js)
import test from 'node:test'
import assert from 'node:assert/strict'

import { backtestDelBot, operacionesDelBot, compararTortugas } from '../src/tortugasComparar.js'

// 70 sesiones quietas entre 99 y 101 (sin rupturas una vez hay canal), 25 de subida y 25 de bajada
function serie() {
  const velas = []
  let d = Date.UTC(2026, 0, 5)
  const dia = () => {
    const f = new Date(d).toISOString().slice(0, 10)
    d += 86_400_000
    if (new Date(d).getUTCDay() === 6) d += 2 * 86_400_000
    return f
  }
  for (let i = 0; i < 70; i++) velas.push([dia(), 100, i % 2 ? 101 : 100.5, i % 2 ? 99.5 : 99, 100])
  for (let i = 0; i < 25; i++) { const c = 100 + 2 * i; velas.push([dia(), c, c + 2.5, c - 0.5, c + 2]) }
  for (let i = 0; i < 25; i++) { const c = 150 - 2 * i; velas.push([dia(), c, c + 0.5, c - 2.5, c - 2]) }
  return velas
}
const CONFIG = { sistemas: [1, 2], filtroS1: false, lados: 'largos', maxUnidades: 4, anadido: 1 }

test('el backtest con las reglas del bot: los dos sistemas entran en la subida, con su pirámide', () => {
  const ops = backtestDelBot('X', serie(), CONFIG)
  // en la parte quieta el S1 entra y sale alguna vez en el borde del canal; la buena es la última
  const s1 = ops.filter(o => o.sistema === 1).at(-1)
  const s2 = ops.find(o => o.sistema === 2)
  assert.equal(s1.ruptura, 20)
  assert.equal(s1.entrada, 101)               // el máximo de 20 sesiones
  assert.equal(s1.unidades, 4)
  assert.equal(s2.ruptura, 55)
  assert.ok(s2.abierta > s1.abierta)          // el 2 no repite la señal del 1: entra más arriba
  assert.ok(ops.every(o => o.lado === 'largo'))
  // en N de la primera unidad: con unidades iguales, la suma de lo que ganó cada una entre N
  assert.ok(s1.resultadoN > 0 && Number.isFinite(s1.resultadoN))
})

test('las del bot: cerradas tal cual y las abiertas al precio de ahora, en N y en euros', () => {
  const cerrada = { ticker: 'X', sistema: 2, lado: 'corto', ruptura: 55, abierta: '2026-05-01', cerrada: '2026-05-10', unidades: 2, entradaMedia: 99, detalle: [{ entrada: 100 }], salida: 95, motivo: 'canal 20', n0: 2, resultadoN: 4, resultadoEur: 400 }
  const pos = { lado: 'largo', ruptura: 20, abierta: '2026-06-01', n0: 2, valorPunto: 10, cambioAEur: 0.5, unidades: [{ tamano: 1, entrada: 100 }, { tamano: 0.5, entrada: 101 }, { tamano: 1, entrada: 99, salida: { nivel: 98 } }] }
  const [c, a] = operacionesDelBot([cerrada], [{ ticker: 'Y', precio: 105, posiciones: { 1: pos, 2: null } }])
  assert.equal(c.entrada, 100)                // la de la primera unidad, no la media
  assert.equal(c.eurPorN, 100)
  assert.equal(a.ticker, 'Y')
  assert.equal(a.sistema, 1)
  assert.equal(a.unidades, 2)                 // la que ya salió no cuenta
  assert.equal(a.resultadoN, (5 + 0.5 * 4) / 2)
  assert.equal(a.eurPorN, 1 * 10 * 0.5 * 2)
  assert.equal(a.resultadoEur, a.resultadoN * 10)
  // sin precio, sin resultado
  assert.equal(operacionesDelBot([], [{ ticker: 'Y', precio: null, posiciones: { 1: pos } }])[0].resultadoN, null)
})

test('empareja por mercado, sistema, lado y fecha cercana; las sueltas cuentan como 0 del otro', () => {
  const bt = [
    { ticker: 'X', sistema: 1, lado: 'largo', abierta: '2026-03-02', entrada: 100, resultadoN: 3 },
    { ticker: 'X', sistema: 1, lado: 'largo', abierta: '2026-04-01', entrada: 110, resultadoN: -1 },
    { ticker: 'X', sistema: 2, lado: 'largo', abierta: '2026-03-03', entrada: 102, resultadoN: 2 },
    { ticker: 'X', sistema: 1, lado: 'largo', abierta: '2026-01-10', entrada: 90, resultadoN: 9 },   // de antes de empezar
  ]
  const reales = [
    { ticker: 'X', sistema: 1, lado: 'largo', abierta: '2026-03-03', entrada: 100.5, n0: 2, resultadoN: 2.5, eurPorN: 50 },
    { ticker: 'X', sistema: 1, lado: 'corto', abierta: '2026-03-20', entrada: 95, n0: 2, resultadoN: -1, eurPorN: 50 },
  ]
  const { filas, resumen } = compararTortugas(reales, bt, { desde: '2026-02-01', eurPorN: { X: 40 } })
  assert.deepEqual(filas.map(f => f.tipo), ['ambos', 'solo-backtest', 'solo-bot', 'solo-backtest'])
  const casada = filas[0]
  assert.equal(casada.backtest.entrada, 100)
  assert.equal(casada.deslizamientoN, 0.25)   // pagó medio punto más, con N = 2
  assert.equal(casada.difN, -0.5)
  assert.equal(casada.difEur, -25)            // con lo que vale 1 N en la del bot
  assert.equal(filas[1].difEur, -80)          // la del S2 solo del backtest, con el eurPorN de hoy
  assert.ok(filas[1].eurAproximado)
  assert.equal(resumen.casadas, 1)
  assert.equal(resumen.soloBot, 1)
  assert.equal(resumen.soloBacktest, 2)
  assert.equal(resumen.realN, 1.5)
  assert.equal(resumen.backtestN, 4)
  assert.equal(resumen.difN, -2.5)
  assert.equal(resumen.difCasadasN, -0.5)
  assert.equal(resumen.difSueltasN, -2)
  assert.equal(resumen.deslizamientoMedioN, 0.25)
})

test('una operación del backtest no se empareja dos veces: gana la más cercana en fecha', () => {
  const bt = [{ ticker: 'X', sistema: 1, lado: 'largo', abierta: '2026-03-05', entrada: 100, resultadoN: 1 }]
  const reales = [
    { ticker: 'X', sistema: 1, lado: 'largo', abierta: '2026-03-02', entrada: 100, n0: 1, resultadoN: 1 },
    { ticker: 'X', sistema: 1, lado: 'largo', abierta: '2026-03-06', entrada: 100, n0: 1, resultadoN: 1 },
  ]
  const { filas } = compararTortugas(reales, bt, { desde: '2026-01-01' })
  assert.deepEqual(filas.map(f => [f.real.abierta, f.tipo]), [['2026-03-02', 'solo-bot'], ['2026-03-06', 'ambos']])
})

test('sin nada que pasar a euros, la diferencia en euros queda sin total (no 0 €)', () => {
  const bt = [{ ticker: 'X', sistema: 1, lado: 'largo', abierta: '2026-03-05', entrada: 100, resultadoN: 1 }]
  assert.equal(compararTortugas([], bt, { desde: '2026-01-01' }).resumen.difEur, null)
  assert.equal(compararTortugas([], bt, { desde: '2026-01-01', eurPorN: { X: 30 } }).resumen.difEur, -30)
})

test('la pareja del backtest puede abrir un poco antes de «desde»; las sueltas de antes, no cuentan', () => {
  const bt = [
    { ticker: 'X', sistema: 1, lado: 'largo', abierta: '2026-03-01', entrada: 100, resultadoN: 1 },
    { ticker: 'Y', sistema: 1, lado: 'largo', abierta: '2026-03-01', entrada: 100, resultadoN: 2 },
  ]
  const reales = [{ ticker: 'X', sistema: 1, lado: 'largo', abierta: '2026-03-02', entrada: 100, n0: 1, resultadoN: 1 }]
  const { filas } = compararTortugas(reales, bt, { desde: '2026-03-02' })
  assert.deepEqual(filas.map(f => [f.ticker, f.tipo]), [['X', 'ambos']])
})

test('el total en euros dice cuántas se quedan fuera por no tener lo que vale 1 N', () => {
  const bt = [
    { ticker: 'X', sistema: 1, lado: 'largo', abierta: '2026-03-05', entrada: 100, resultadoN: 1 },
    { ticker: 'Y', sistema: 1, lado: 'largo', abierta: '2026-03-05', entrada: 100, resultadoN: 2 },
  ]
  const { resumen } = compararTortugas([], bt, { desde: '2026-01-01', eurPorN: { X: 30 } })
  assert.equal(resumen.difN, -3)
  assert.equal(resumen.difEur, -30)
  assert.equal(resumen.sinEur, 1)
})
