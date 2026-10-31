import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resumirCerradas, juntarAbiertas, resumenPublico, cerradasMotorSrs, crearCacheResumen } from '../server/resumen-bots.js'

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
    { bot: 'SRS', instrumento: 'DAX', lado: 'largo', desde: T - 60, resultado: 100 },
    { bot: 'SRS', instrumento: 'DAX', lado: 'largo', desde: T - 600, resultado: 50 },
    { bot: 'SRS', instrumento: 'Dow', lado: 'corto', desde: T, resultado: null },
  ], 10000)
  assert.deepEqual(r, [
    { bot: 'SRS', instrumento: 'DAX', lado: 'largo', desde: T - 600, unidades: 2, pct: 1.5 },
    { bot: 'SRS', instrumento: 'Dow', lado: 'corto', desde: T, unidades: 1, pct: null },
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
    posicionesIg: [{ bot: 'SRS', instrumento: 'DAX', lado: 'largo', desde: T, resultado: 10 }, { bot: null, instrumento: 'Oro', lado: 'largo', desde: T, resultado: 99 }],
    vigilancia: { bots: [{ nombre: 'SRS', enMarcha: true, parado: false }] },
  })
  assert.equal(r.bots[0].encendido, true)
  assert.equal(r.bots[0].enMarcha, true)
  assert.deepEqual(r.bots[0].abiertas, [{ instrumento: 'DAX', lado: 'largo', desde: T, unidades: 1, pct: 0.1 }])
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
