// Tests de los mercados de las tortugas (server/futuros-tortugas.js): dónde se busca cada
// cambio de contrato, el empalme hacia atrás y las letras sacadas del tipo; y las fechas de
// Yahoo cuando cada mercado tiene su zona y su hora de cierre (server/acciones-eeuu.js)
import test from 'node:test'
import assert from 'node:assert/strict'

import { ventana, cambiosDeContrato, empalmar, letrasDeTipo, MERCADOS_1983 } from '../server/futuros-tortugas.js'
import { velasDeYahoo, ultimoCierre } from '../server/acciones-eeuu.js'

test('la ventana de cada vencimiento, con el mes anterior y los meses cortos', () => {
  const crudo = { meses: [1], desde: [-1, 14], hasta: [-1, 25] }
  assert.deepEqual(ventana(crudo, 2026, 1), ['2025-12-14', '2025-12-25'])     // el de enero vence en diciembre
  assert.deepEqual(ventana({ desde: [0, 28], hasta: [0, 31] }, 2026, 2), ['2026-02-28', '2026-02-28'])
  assert.deepEqual(ventana({ desde: [-1, 24], hasta: [0, 4] }, 2026, 3), ['2026-02-24', '2026-03-04'])
})

// Días entre semana con volumen 1000 y precio 100 (de 99 a 101); `cambios` pone el precio y el volumen de algunos días
function serie(desde, hasta, cambios = {}) {
  const velas = []
  for (let t = Date.parse(`${desde}T12:00:00Z`); t <= Date.parse(`${hasta}T12:00:00Z`); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10)
    if ([0, 6].includes(new Date(t).getUTCDay())) continue
    velas.push({ date, open: 100, high: 101, low: 99, close: 100, volume: 1000, ...cambios[date] })
  }
  return velas
}
const TRIMESTRAL = { meses: [3, 6, 9, 12], desde: [0, 14], hasta: [0, 26], salto: 2 }

test('el cambio de contrato es el salto de volumen dentro de su ventana, y se empalma hacia atrás', () => {
  const nuevo = { open: 110, high: 111, low: 109, close: 110 }
  const despues = Object.fromEntries(serie('2026-03-20', '2026-04-30').map(v => [v.date, nuevo]))
  const velas = serie('2026-01-05', '2026-04-30', {
    ...despues,
    '2026-02-16': { volume: 10 },                    // un festivo fuera de la ventana: no es un cambio
    '2026-03-19': { volume: 10 },                    // el último día del contrato viejo, casi sin volumen
    '2026-03-20': { ...nuevo, volume: 1000 },        // el nuevo abre un 10 % más arriba
  })
  const idx = cambiosDeContrato(velas, TRIMESTRAL)
  assert.deepEqual(idx.map(i => velas[i].date), ['2026-03-20'])
  const { velas: empalmadas, cambios } = empalmar(velas, TRIMESTRAL)
  assert.equal(cambios.length, 1)
  assert.equal(cambios[0].date, '2026-03-20')
  assert.ok(Math.abs(cambios[0].salto - 0.1) < 1e-12)
  // lo anterior al cambio, un 10 % más arriba: ya no hay salto
  const antes = empalmadas.find(v => v.date === '2026-03-19')
  assert.ok(Math.abs(antes.close - 110) < 1e-9)
  assert.ok(Math.abs(empalmadas[0].high - 111.1) < 1e-9)
  assert.equal(empalmadas.find(v => v.date === '2026-04-30').close, 110)
})

test('fuera las velas sin precio positivo (el crudo a −37 $ el 20-abr-2020)', () => {
  const velas = serie('2020-03-02', '2020-04-30', { '2020-04-20': { open: 17, high: 17, low: -40, close: -37 } })
  const { velas: limpias } = empalmar(velas, { meses: [], desde: [0, 1], hasta: [0, 2], salto: 2 })
  assert.equal(limpias.length, velas.length - 1)
  assert.ok(limpias.every(v => v.low > 0))
})

test('las letras a 90 días: 100 menos el tipo, con el máximo del precio en el mínimo del tipo', () => {
  assert.deepEqual(letrasDeTipo([{ date: '2026-10-16', open: 4, high: 4.2, low: 3.9, close: 4.1 }]),
    [{ date: '2026-10-16', open: 96, high: 96.1, low: 95.8, close: 95.9, volume: 0 }])
})

test('los 19 mercados de las tortugas, con sus grupos', () => {
  assert.equal(MERCADOS_1983.length, 19)
  assert.deepEqual([...new Set(MERCADOS_1983.map(m => m.grupo))], ['Tipos de interés', 'Divisas', 'Índices', 'Metales', 'Energía', 'Blandas'])
  // las divisas, al contado; las letras, del tipo; lo demás, futuros con su calendario
  assert.ok(MERCADOS_1983.every(m => m.contado || m.tipo || m.contratos?.meses?.length))
})

test('Yahoo: las divisas, con la fecha de Londres y el día cerrado a medianoche; los futuros, sin la vela de mañana', () => {
  const q = { open: [1, 2], high: [1.5, 2.5], low: [0.5, 1.5], close: [1.2, 2.2] }
  // Yahoo fecha las divisas a las 00:00 de Londres (23:00 UTC en verano): con la hora de Nueva York caerían la víspera
  const divisas = { timestamp: [Date.UTC(2026, 9, 14, 23) / 1000, Date.UTC(2026, 9, 15, 23) / 1000], indicators: { quote: [q] } }
  const londres = { zona: 'Europe/London', cierreMin: 24 * 60 }
  assert.deepEqual(velasDeYahoo(divisas, Date.UTC(2026, 9, 16, 12) / 1000, londres).map(v => v.date), ['2026-10-15'])
  assert.deepEqual(velasDeYahoo(divisas, Date.UTC(2026, 9, 16, 23, 30) / 1000, londres).map(v => v.date), ['2026-10-15', '2026-10-16'])
  // el futuro abre el lunes a las 18:00 de Nueva York la vela del martes: el lunes por la noche no vale
  const futuro = { timestamp: [Date.parse('2026-10-19T00:00:00-04:00') / 1000, Date.parse('2026-10-20T00:00:00-04:00') / 1000], indicators: { quote: [q] } }
  const nuevaYork = { zona: 'America/New_York', cierreMin: 17 * 60 + 15 }
  assert.deepEqual(velasDeYahoo(futuro, Date.parse('2026-10-19T19:00:00-04:00') / 1000, nuevaYork).map(v => v.date), ['2026-10-19'])
  // y lo guardado vale hasta el siguiente cierre de su zona
  assert.equal(ultimoCierre(Date.UTC(2026, 9, 16, 12) / 1000, 24 * 60, 'Europe/London'), Date.UTC(2026, 9, 15, 23) / 1000)
})
