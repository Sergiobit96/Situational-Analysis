// Tests de la conciliación con IG (server/conciliacion.js) y del resumen del día (server/resumen-diario.js)
import test from 'node:test'
import assert from 'node:assert/strict'

import { diferencias, crearConciliacion } from '../server/conciliacion.js'
import { textoResumen, crearResumenDiario } from '../server/resumen-diario.js'
import { crearCartera } from '../server/cartera.js'

const igPos = (dealId, extra = {}) => ({ dealId, ticker: '^GDAXI', tamano: 1, stop: 25000, referencia: 'SRS-GDAXI-20261023-abcd', ...extra })

test('las diferencias: huérfanas con referencia de bot, las que el bot cree abiertas y ya no están, y stops o tamaños distintos', () => {
  const posiciones = [
    { bot: 'SRS', ticker: '^GDAXI', unidades: [{ dealId: 'A', stop: 25000, tamano: 1 }, { dealId: 'B', stop: 25000, tamano: 1 }] },
    { bot: 'Tortugas', ticker: 'EURUSD', unidades: [{ dealId: 'C', stop: 1.08345, tamano: 2 }] },
  ]
  const abiertas = [
    igPos('A'),
    igPos('C', { ticker: 'EURUSD', stop: 1.08345000001, tamano: 3, referencia: 'TOR1-EURUSD-x' }),
    igPos('D', { referencia: 'R4-NDX-x' }),
    igPos('E', { referencia: null }),                   // abierta a mano: no es cosa de los bots
    igPos('F', { referencia: 'SRS-ENSAYO-x' }),          // un ensayo que está cerrándose
  ]
  const d = diferencias(posiciones, abiertas)
  assert.deepEqual(d.map(x => x.clave), ['falta|B', 'tamano|C|2|3', 'huerfana|D'])
  assert.match(d[0].texto, /SRS cree que tiene abierta una posición de \^GDAXI \(B\) que en IG ya no está/)
  assert.match(d[2].texto, /ningún bot sigue: nadie la cerrará/)
  assert.deepEqual(diferencias([{ bot: 'SRS', ticker: '^GDAXI', unidades: [{ dealId: 'A', stop: 25010, tamano: 1 }] }], [igPos('A')]).map(x => x.clave), ['stop|A|25010|25000'])
  assert.deepEqual(diferencias([{ bot: 'SRS', ticker: '^GDAXI', unidades: [{ dealId: 'A', stop: 25010, tamano: 1 }] }], [igPos('A', { stop: null })]).map(x => x.clave), ['sinstop|A'])
})

test('avisa de una diferencia cuando se ve dos veces seguidas, una sola vez, y avisa cuando se arregla', async () => {
  const cartera = crearCartera()
  let unidades = [{ dealId: 'A', stop: 25000, tamano: 1 }]
  cartera.registrar('SRS', () => [{ ticker: '^GDAXI', lado: 'largo', riesgoEur: 0, unidades }])
  let abiertas = []
  const avisos = []
  const c = crearConciliacion({ ig: { operar: { posiciones: async () => abiertas } }, cartera, avisar: t => avisos.push(t), log: () => {} })
  assert.deepEqual(await c.revisar(), { nuevas: 0, arregladas: 0, diferencias: 1 })
  assert.equal(avisos.length, 0, 'una vez puede ser una orden a medio confirmar')
  await c.revisar()
  assert.equal(avisos.length, 1)
  assert.match(avisos[0], /^Conciliación con IG\n⚠️ SRS cree que tiene abierta/)
  await c.revisar()
  assert.equal(avisos.length, 1, 'no repite')
  assert.equal(c.estado().pendientes.length, 1)
  abiertas = [igPos('A')]
  await c.revisar()
  assert.equal(avisos.length, 2)
  assert.match(avisos[1], /✅ Ya cuadra: SRS cree/)
  // si IG falla, no avisa de nada
  const rota = crearConciliacion({ ig: { operar: { posiciones: async () => { throw new Error('IG caído') } } }, cartera, avisar: t => avisos.push(t), log: () => {} })
  assert.equal(await rota.revisar(), null)
  assert.equal(rota.estado().error, 'IG caído')
  unidades = []
})

// viernes 23-oct-2026, 23:20 de Madrid (21:20 UTC)
const viernes = Date.UTC(2026, 9, 23, 21, 20) / 1000

test('el resumen: saldo y caída desde el máximo, lo cerrado hoy por cada bot y lo abierto con su riesgo', () => {
  const texto = textoResumen({
    t: viernes, cuenta: { saldo: 19_800 }, pico: 20_000,
    bots: [
      { nombre: 'SRS', cerradasHoy: f => (f === '2026-10-23' ? [210.4, -65] : []) },
      { nombre: 'Rule of 4', cerradasHoy: () => [] },
      { nombre: 'Roto', cerradasHoy: () => { throw new Error('x') } },
    ],
    posiciones: [{ bot: 'Tortugas', riesgoEur: 300 }, { bot: 'Tortugas', riesgoEur: 180 }, { bot: 'SRS', riesgoEur: 40 }],
  })
  assert.equal(texto, [
    '📊 Resumen del día, viernes, 23 de octubre',
    'Cuenta: 19.800 € (−1,0 % desde el máximo de 20.000 €)'.replace('−', '-'),
    'Hoy: +145 €',
    '  SRS: +145 € (2 cerradas)',
    'Abierto: 3 posiciones, 520 € en riesgo hasta los stops',
    '  Tortugas: 2 (480 €), SRS: 1 (40 €)',
  ].join('\n'))
  assert.match(textoResumen({ t: viernes, cuenta: { saldo: 20_000 }, pico: 20_000, bots: [], posiciones: [] }), /\(en máximos\)\nHoy: ninguna operación cerrada\nNada abierto$/)
})

test('el resumen sale de lunes a viernes pasadas las 23:15 de Madrid, una vez al día, y guarda el máximo del saldo', async () => {
  let t = viernes - 10 * 60   // 23:10
  let saldo = 20_500
  const avisos = []
  const r = crearResumenDiario({
    ig: { operar: { cuenta: async () => ({ saldo }) } }, cartera: crearCartera(), bots: [], avisar: x => avisos.push(x), ahora: () => t, log: () => {},
  })
  assert.equal(await r.mirar(), null)
  t = viernes
  assert.match(await r.mirar(), /Cuenta: 20\.500 € \(en máximos\)/)
  assert.equal(await r.mirar(), null, 'una vez al día')
  t = viernes + 86400       // sábado
  assert.equal(await r.mirar(), null)
  t = viernes + 3 * 86400 + 3600   // lunes a las 23:20, ya en horario de invierno
  saldo = 20_000
  assert.match(await r.mirar(), /-2,4 % desde el máximo de 20\.500 €/)
  assert.equal(avisos.length, 2)
})
