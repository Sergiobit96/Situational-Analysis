import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resumirCerradas, juntarAbiertas, resumenPublico, cerradasMotorSrs, crearCacheResumen, infoMotorSrs, historialBots, cerradasTortugas, cerradasTortugasAcciones } from '../server/resumen-bots.js'

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
  assert.deepEqual(c, { hora: T, instrumento: 'DAX', lado: null, nota: 'con flip', resultado: -30, unidades: [] })
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

test('el historial junta lo cerrado de todos los bots, con su bróker y su moneda, de la más nueva a la más vieja', () => {
  const h = historialBots([
    { nombre: 'SRS', cuenta: 'ig', cerradas: () => [{ hora: T - 100, instrumento: 'DAX', lado: 'largo', nota: null, resultado: 50 }] },
    { nombre: 'Tortugas IB', cuenta: 'ib', cerradas: () => [{ hora: T - 10, instrumento: 'Oro', lado: 'corto', nota: 'S1', resultado: -20 }, { hora: null, instrumento: 'Plata', resultado: 5 }] },
    { nombre: 'Tortugas acciones', cuenta: 'alpaca', cerradas: () => [{ hora: T - 50, instrumento: 'AAPL', lado: 'largo', nota: 'S2', resultado: null }] },
    { nombre: 'Roto', cuenta: 'ig', cerradas: () => { throw new Error('mal') } },
  ])
  assert.deepEqual(h, [
    { bot: 'Tortugas IB', broker: 'IB', moneda: 'EUR', hora: T - 10, instrumento: 'Oro', lado: 'corto', nota: 'S1', resultado: -20 },
    { bot: 'SRS', broker: 'IG', moneda: 'EUR', hora: T - 100, instrumento: 'DAX', lado: 'largo', nota: null, resultado: 50 },
  ])
})

test('las unidades del SRS: las de todas las piernas, con su resultado en € por el valor del punto', () => {
  const [c] = cerradasMotorSrs({
    sesiones: [{ ticker: '^GDAXI', nombre: 'DAX' }], hoy: [],
    historial: [{
      ticker: '^GDAXI', salida: { hora: T }, resultadoEur: 40, plan: { valorPunto: 1, cambioAEur: 1 },
      anteriores: [{ lado: 'largo', unidades: [{ tamano: 2, entrada: 100, hora: T - 300, salida: { nivel: 90, hora: T - 200 } }] }],
      operacion: { lado: 'corto', unidades: [{ tamano: 3, entrada: 90, hora: T - 200, salida: { nivel: 70, hora: T, aproximado: true } }] },
    }],
  })
  assert.deepEqual(c.unidades, [
    { lado: 'largo', tamano: 2, entrada: 100, horaEntrada: T - 300, salida: 90, horaSalida: T - 200, resultado: -20 },
    { lado: 'corto', tamano: 3, entrada: 90, horaEntrada: T - 200, salida: 70, horaSalida: T, resultado: 60, aproximado: true },
  ])
})

test('las unidades de las tortugas salen del detalle de la operación, en €', () => {
  const [c] = cerradasTortugas({
    mercados: [{ ticker: 'XAUUSD', nombre: 'Oro' }],
    operaciones: [{ ticker: 'XAUUSD', sistema: 1, lado: 'corto', cerradaHora: T, resultadoEur: 18, valorPunto: 10, cambioAEur: 0.9,
      detalle: [{ tamano: 1, entrada: 2000, hora: T - 86400, salida: { nivel: 1998, hora: T } }] }],
  })
  assert.deepEqual(c.unidades, [{ lado: 'corto', tamano: 1, entrada: 2000, horaEntrada: T - 86400, salida: 1998, horaSalida: T, resultado: 18 }])
})

test('las unidades de Alpaca: cada una si se guardó el detalle; si no, una con la entrada media', () => {
  const cerrada = new Date(T * 1000).toISOString(), abierta = new Date((T - 86400) * 1000).toISOString()
  const [nueva, vieja] = cerradasTortugasAcciones({ operaciones: [
    { simbolo: 'AAPL', sistema: 2, lado: 'largo', cerrada, salida: 110, resultado: 30, detalle: [{ acciones: 1, entrada: 100, hora: abierta }, { acciones: 2, entrada: 105, hora: cerrada }] },
    { simbolo: 'MSFT', sistema: 1, lado: 'largo', cerrada, abierta, salida: 50, resultado: -10, acciones: 5, entrada: 52 },
  ] })
  assert.deepEqual(nueva.unidades.map(u => [u.tamano, u.entrada, u.horaEntrada, u.salida, u.resultado]), [[1, 100, T - 86400, 110, 10], [2, 105, T, 110, 10]])
  assert.deepEqual(vieja.unidades, [{ lado: 'largo', tamano: 5, entrada: 52, horaEntrada: T - 86400, salida: 50, horaSalida: T, resultado: -10, media: true }])
})
