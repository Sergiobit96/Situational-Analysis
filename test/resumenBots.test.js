import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resumirCerradas, juntarAbiertas, resumenPublico, cerradasMotorSrs, crearCacheResumen, infoMotorSrs } from '../server/resumen-bots.js'

const T = Date.parse('2026-10-31T12:00:00Z') / 1000

test('los totales van en % del saldo, por hoy, 7 y 30 días', () => {
  const r = resumirCerradas([
    { hora: T - 3600, instrumento: 'DAX', lado: 'largo', resultado: 200 },
    { hora: T - 3 * 86400, instrumento: 'Dow', lado: 'corto', resultado: -100 },
    { hora: T - 20 * 86400, instrumento: 'Nasdaq', lado: 'largo', resultado: 50 },
    { hora: T - 90 * 86400, instrumento: 'Nikkei', lado: 'largo', resultado: 1000 },
  ], { saldo: 10000, t: T })
  assert.deepEqual(r.totales, { hoy: 2, semana: 1, mes: 1.5, total: 11.5, operaciones: 4, ganadoras: 3 })
  assert.equal(r.ultimas[0].instrumento, 'DAX')
  assert.equal(r.ultimas[0].pct, 2)
  assert.ok(!('resultado' in r.ultimas[0]), 'no enseña euros')
})

test('sin saldo no hay %', () => {
  assert.equal(resumirCerradas([{ hora: T, resultado: 5 }], { saldo: null, t: T }).totales.total, null)
})

test('las del mismo bot, instrumento y lado se juntan', () => {
  const r = juntarAbiertas([
    { bot: 'SRS', instrumento: 'DAX', lado: 'largo', desde: T - 60, resultado: 100, alStop: -50 },
    { bot: 'SRS', instrumento: 'DAX', lado: 'largo', desde: T - 600, resultado: 50, alStop: 20 },
    { bot: 'SRS', instrumento: 'Dow', lado: 'corto', desde: T, resultado: null, alStop: null },
  ], 10000)
  assert.deepEqual(r, [
    { bot: 'SRS', instrumento: 'DAX', lado: 'largo', desde: T - 600, unidades: 2, pct: 1.5, alStopPct: -0.3 },
    { bot: 'SRS', instrumento: 'Dow', lado: 'corto', desde: T, unidades: 1, pct: null, alStopPct: null },
  ])
})

test('una sesión con flip sale sin sentido y con la nota', () => {
  const [c] = cerradasMotorSrs({
    sesiones: [{ ticker: '^GDAXI', nombre: 'DAX' }],
    hoy: [],
    historial: [{ ticker: '^GDAXI', salida: { hora: T }, resultadoEur: -30, anteriores: [{ lado: 'largo' }], operacion: { lado: 'corto' } }],
  })
  assert.deepEqual(c, { hora: T, instrumento: 'DAX', lado: null, nota: 'con flip', resultado: -30 })
})

test('el resumen público: estado de cada bot, sin lo que no es de ningún bot', () => {
  const r = resumenPublico({
    t: T, saldoIg: 10000,
    bots: [{ nombre: 'SRS', cuenta: 'ig', activo: () => true, cerradas: () => [] }, { nombre: 'Tortugas', cuenta: 'ig', activo: () => false, cerradas: () => { throw new Error('roto') } }],
    posicionesIg: [{ bot: 'SRS', instrumento: 'DAX', lado: 'largo', desde: T, resultado: 10, alStop: -100 }, { bot: null, instrumento: 'Oro', lado: 'largo', desde: T, resultado: 99 }],
    vigilancia: { bots: [{ nombre: 'SRS', enMarcha: true, parado: false }] },
  })
  assert.equal(r.bots[0].encendido, true)
  assert.equal(r.bots[0].enMarcha, true)
  assert.deepEqual(r.bots[0].abiertas, [{ instrumento: 'DAX', lado: 'largo', desde: T, unidades: 1, pct: 0.1, alStopPct: -1 }])
  assert.deepEqual(r.conjunto.ig, { abiertas: 1, abierto: 0.1, alStop: -1, hoy: null, semana: null, mes: null, total: null })
  assert.equal(r.conjunto.encendidos, 1)
  assert.equal(r.bots[1].encendido, false)
  assert.equal(r.bots[1].totales.operaciones, 0)
})

test('la caché pregunta una sola vez por mucho que se pida', async () => {
  let t = 0, llamadas = 0
  const pedir = crearCacheResumen(async () => ++llamadas, { ahora: () => t })
  await Promise.all([pedir(), pedir(), pedir()])
  t = 29_000; await pedir()
  assert.equal(llamadas, 1)
  t = 31_000; await pedir()
  assert.equal(llamadas, 2)
})

test('las cifras: medias, factor de beneficio, peor caída, racha, curva y por mercado', () => {
  const r = resumirCerradas([
    { hora: T - 5000, instrumento: 'DAX', resultado: 300 },
    { hora: T - 4000, instrumento: 'DAX', resultado: -100 },
    { hora: T - 3000, instrumento: 'Dow', resultado: -200 },
    { hora: T - 2000, instrumento: 'Dow', resultado: 100 },
    { hora: T - 1000, instrumento: 'DAX', resultado: 100 },
  ], { saldo: 10000, t: T })
  const c = r.cifras
  assert.ok(Math.abs(c.mediaGanadora - 500 / 3 / 100) < 1e-9)
  assert.equal(c.mediaPerdedora, -1.5)
  assert.equal(c.factorBeneficio, 500 / 300)
  assert.ok(Math.abs(c.peorCaida - -3) < 1e-9)
  assert.deepEqual(c.racha, { gana: true, n: 2 })
  assert.equal(c.mejor.pct, 3)
  assert.equal(c.peor.instrumento, 'Dow')
  assert.equal(c.primera, T - 5000)
  assert.deepEqual(r.curva.map(p => Math.round(p.pct * 100) / 100), [3, 2, 0, 1, 2])
  assert.deepEqual(r.porInstrumento.map(g => [g.instrumento, g.operaciones, g.pct]), [['DAX', 3, 3], ['Dow', 2, -1]])
})

test('qué hace ahora un bot del motor del SRS', () => {
  const i = infoMotorSrs({ sesiones: [
    { nombre: 'DAX', encendido: true, hoy: { abre: T - 60, cierra: T + 60 }, proxima: T + 86400 },
    { nombre: 'Dow', encendido: true, hoy: { abre: T + 600, cierra: T + 9000 }, proxima: T + 600 },
    { nombre: 'Nikkei', encendido: false, hoy: { abre: T - 60, cierra: T + 60 }, proxima: T + 10 },
  ] }, T)
  assert.deepEqual(i, { instrumentos: 2, enSesion: ['DAX'], proxima: T + 600 })
})
