// Tests de las tortugas en IB (server/tortugas-ib.js) contra un IB de mentira, a la altura de
// server/ib.js, y con el bot de las tortugas encima: ninguna orden de verdad
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { crearTortugasIB, vencimientoVigente, limiteRolar, MERCADOS_IB } from '../server/tortugas-ib.js'
import { crearBotTortugas } from '../server/bot-tortugas.js'
import { offsetZona } from '../server/zonas.js'

// Hora de Nueva York en un día de noviembre de 2026 → instante UTC en segundos
const ny = (mes, dia, h, m = 0, s = 0) => {
  const aprox = Date.UTC(2026, mes - 1, dia, h, m, s) / 1000
  return aprox - offsetZona(aprox - offsetZona(aprox, 'America/New_York'), 'America/New_York')
}

const futuroOro = (conId, localSymbol, mes, vence) => ({
  contract: { conId, symbol: 'MGC', secType: 'FUT', exchange: 'COMEX', currency: 'USD', localSymbol, lastTradeDateOrContractMonth: vence, multiplier: '10' },
  contractMonth: mes, minTick: 0.1,
})
const ORO = [futuroOro(11, 'MGCZ6', '202612', '20261229'), futuroOro(13, 'MGCF7', '202701', '20270127'), futuroOro(12, 'MGCG7', '202702', '20270224')]
const DETALLES = {
  MGC: ORO,
  EUR: [{ contract: { conId: 21, symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD', localSymbol: 'EUR.USD' }, minTick: 0.00005 }],
  EXS1: [{ contract: { conId: 31, symbol: 'EXS1', secType: 'STK', exchange: 'SMART', primaryExch: 'IBIS', currency: 'EUR', localSymbol: 'EXS1' }, minTick: 0.01 }],
}

// Un IB de mentira: rellena a mercado al precio de la cotización, deja los stops abiertos y
// los hace saltar a mano (saltar)
function ibFalso() {
  const ordenes = new Map()
  const ejecuciones = []
  const cotizaciones = new Map()
  let id = 1
  const ejecutar = (x, precio) => {
    x.estadoIB = 'Filled'
    x.medio = precio
    x.rellena = x.o.totalQuantity
    ejecuciones.push({ orderRef: x.o.orderRef, precio, cantidad: x.o.totalQuantity, hora: '20261103 15:00:00' })
  }
  const f = {
    ordenes, mandadas: [], historicos: [],
    cuentaBot: async () => ({ moneda: 'EUR', saldo: 1_000_000, disponible: 1_000_000 }),
    cambio: () => null,
    detalles: async c => (c.localSymbol ? Object.values(DETALLES).flat().filter(d => d.contract.localSymbol === c.localSymbol) : DETALLES[c.symbol] ?? []),
    historico: async contrato => { f.historicos.push(contrato.localSymbol); return f.diarios[contrato.localSymbol] ?? [] },
    diarios: {},
    cotizar(clave, contrato, alPrecio) {
      if (!cotizaciones.has(clave)) cotizaciones.set(clave, { clave, contrato, bid: null, ask: null, last: null, retrasado: false, alPrecio, ...f.iniciales[clave] })
      return cotizaciones.get(clave)
    },
    // el precio de un contrato; si aún no está suscrito, el que tendrá al suscribirse
    precio(clave, bid, ask) {
      const q = cotizaciones.get(clave)
      if (!q) return void (f.iniciales[clave] = { bid, ask })
      Object.assign(q, { bid, ask })
      q.alPrecio(q)
    },
    iniciales: {},
    ejecuciones: async () => ejecuciones,
    abiertas: async () => [...ordenes.values()].filter(x => x.estadoIB === 'Submitted'),
    async mandarPatas(patas) {
      const ids = []
      for (const { contrato, orden } of patas) {
        const x = { id: id++, c: contrato, o: { ...orden, ...(ids.length ? { parentId: ids[0] } : {}) }, estadoIB: 'Submitted' }
        ordenes.set(x.id, x)
        f.mandadas.push(x)
        ids.push(x.id)
        if (orden.orderType === 'MKT') {
          const q = cotizaciones.get(contrato.localSymbol)
          ejecutar(x, orden.action === 'BUY' ? q.ask : q.bid)
        }
      }
      return ids
    },
    orden: n => ordenes.get(n),
    esperarOrden: async n => ordenes.get(n),
    async modificar(n, c, o) { Object.assign(ordenes.get(n), { c, o, estadoIB: 'Submitted' }) },
    async cancelar(n) { const x = ordenes.get(n); if (x.estadoIB !== 'Filled') x.estadoIB = 'Cancelled' },
    // salta el stop de una unidad a su precio
    saltar(referencia) { const x = [...ordenes.values()].find(o => o.o.orderRef === `${referencia}-stop` && o.estadoIB === 'Submitted'); ejecutar(x, x.o.auxPrice) },
  }
  return f
}

test('el vencimiento vigente: el primero de los meses buenos a más de 10 días de su primer aviso o de su último día', () => {
  assert.equal(limiteRolar(ORO[0]), '2026-11-21')                  // el 1-dic, menos 10 días
  const meses = MERCADOS_IB.XAUUSD.meses
  assert.equal(vencimientoVigente(ORO, meses, '2026-11-03').contract.localSymbol, 'MGCZ6')
  assert.equal(vencimientoVigente(ORO, meses, '2026-11-21').contract.localSymbol, 'MGCG7')   // enero no es de los meses del oro
  // el crudo vence antes de su mes: cuenta su último día
  const crudo = { contract: { lastTradeDateOrContractMonth: '20261117' }, contractMonth: '202612' }
  assert.equal(limiteRolar(crudo), '2026-11-07')
})

test('IB: contrato, precio en directo, bracket con el stop al tick, stop movido, salto del stop y cierre a mercado', async () => {
  const ib = ibFalso()
  const t = ny(11, 3, 10)
  const tib = crearTortugasIB({ ib, ahora: () => t, log: () => {} })
  await tib.arrancar()
  assert.deepEqual(tib.estado().XAUUSD, { epic: 'MGCZ6', retrasado: false, error: null })
  assert.match(tib.estado().COPPER.error, /IB no da el contrato de Cobre/)

  ib.precio('EUR.USD', 1.0999, 1.1001)
  ib.precio('MGCZ6', 4000, 4000.2)
  const m = await tib.operar.datosMercado('XAUUSD')
  assert.equal(m.epic, 'MGCZ6')
  assert.equal(m.valorPunto, 10)
  assert.ok(Math.abs(m.cambioAEur - 1 / 1.1) < 1e-12)
  assert.equal(m.futuro, true)
  assert.equal(m.decimales, 1)
  assert.deepEqual(tib.precios.velas('XAUUSD', 1).map(v => v.close), [4000.1])

  const r = await tib.operar.abrir({ ticker: 'XAUUSD', epic: 'MGCZ6', lado: 'largo', tamano: 3, stop: 3880.04, referencia: 'TIB1-XAUUSD-1' })
  assert.deepEqual(r, { aceptada: true, dealId: 'TIB1-XAUUSD-1', nivel: 4000.2, tamano: 3, stop: 3880 })
  const [madre, hija] = ib.mandadas
  assert.equal(madre.o.transmit, false)
  assert.deepEqual([hija.o.orderType, hija.o.action, hija.o.auxPrice, hija.o.tif, hija.o.parentId], ['STP', 'SELL', 3880, 'GTC', madre.id])

  let abiertas = await tib.operar.posiciones()
  assert.deepEqual(abiertas.map(p => [p.dealId, p.ticker, p.epic, p.lado, p.tamano, p.stop]), [['TIB1-XAUUSD-1', 'XAUUSD', 'MGCZ6', 'largo', 3, 3880]])
  assert.ok(Math.abs(abiertas[0].nivel - 4000.2) < 1e-9)

  assert.deepEqual(await tib.operar.moverStop({ ticker: 'XAUUSD', dealId: 'TIB1-XAUUSD-1', stop: 3900.06 }), { aceptada: true })
  assert.equal(ib.ordenes.get(hija.id).o.auxPrice, 3900.1)

  // salta el stop: ya no está, y su precio sale de las ejecuciones
  ib.saltar('TIB1-XAUUSD-1')
  assert.deepEqual(await tib.operar.posiciones(), [])
  assert.deepEqual(await tib.operar.cierreDe({ dealId: 'TIB1-XAUUSD-1' }), { nivel: 3900.1 })
  assert.equal((await tib.operar.cerrar({ ticker: 'XAUUSD', dealId: 'TIB1-XAUUSD-1' })).aceptada, false)

  // cerrar a mercado: cancela su stop y vende
  await tib.operar.abrir({ ticker: 'XAUUSD', epic: 'MGCZ6', lado: 'largo', tamano: 2, stop: 3880, referencia: 'TIB2-XAUUSD-2' })
  ib.precio('MGCZ6', 4010, 4010.2)
  assert.deepEqual(await tib.operar.cerrar({ ticker: 'XAUUSD', dealId: 'TIB2-XAUUSD-2' }), { aceptada: true, nivel: 4010 })
  abiertas = await tib.operar.posiciones()
  assert.deepEqual(abiertas, [])
  assert.equal(ib.mandadas.at(-1).o.orderRef, 'TIB2-XAUUSD-2-cierre')
})

// 300 sesiones planas en 4.000 ± 30 (N = 60): el máximo de 20 es 4.030
const diarioPlano = (centro, medio, hasta) => {
  const fechas = []
  for (let t = Date.parse(`${hasta}T12:00:00Z`); fechas.length < 300; t -= 86_400_000) {
    const d = new Date(t)
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) fechas.unshift(d.toISOString().slice(0, 10))
  }
  return fechas.map(date => ({ date, open: centro, high: centro + medio, low: centro - medio, close: centro }))
}

test('el bot en IB: plan con el contrato vigente, entrada, cambio de vencimiento con la entrada corrida y salida por el stop', async () => {
  const ib = ibFalso()
  let t = ny(11, 3, 10)
  const tib = crearTortugasIB({ ib, ahora: () => t, log: () => {} })
  const dir = mkdtempSync(join(tmpdir(), 'tortugas-ib-'))
  const avisos = []
  const bot = crearBotTortugas({
    archivo: join(dir, 'bot.json'), ahora: () => t, log: () => {}, revisarCadaMs: 0, avisar: x => avisos.push(x),
    mercados: tib.mercados, operar: tib.operar, precios: tib.precios, epicsDe: tib.epicsDe, velasDiarias: tib.velasDiarias,
    broker: 'IB', nombre: 'Tortugas IB', prefijo: tib.prefijo,
  })
  try {
    await tib.arrancar()
    ib.precio('EUR.USD', 1.0999, 1.1001)
    ib.precio('MGCZ6', 4000, 4000.2)
    ib.diarios.MGCZ6 = diarioPlano(4000, 30, '2026-11-02')
    ib.diarios.MGCG7 = diarioPlano(4050, 30, '2026-11-20')
    bot.cambiarConfig({ activo: true, sistemas: [1], instrumentos: Object.fromEntries(Object.keys(MERCADOS_IB).map(k => [k, k === 'XAUUSD'])) })

    await bot._paso()
    let m = bot.estado().mercados.find(x => x.ticker === 'XAUUSD')
    assert.equal(m.plan.fecha, '2026-11-03')
    assert.equal(m.plan.n, 60)
    assert.equal(m.plan.sistemas[1].entrada.largo.nivel, 4030)
    // 1% de 1 M€ por pirámide llena (5 N) = 2.000 € por N; 1 N de un MGC = 60 × 10 $ = 545 € → 3 contratos
    assert.equal(m.plan.unidad.epic, 'MGCZ6')
    assert.equal(m.plan.unidad.tamano, 3)
    assert.equal(m.plan.unidad.futuro, true)

    // ruptura: compra con el stop a 2 N
    t += 60
    ib.precio('MGCZ6', 4031, 4031.2)
    await bot._paso()
    let pos = bot.estado().mercados.find(x => x.ticker === 'XAUUSD').posiciones[1]
    assert.equal(pos.epic, 'MGCZ6')
    assert.deepEqual(pos.unidades.map(u => [u.dealId, u.entrada, u.stop]), [[pos.unidades[0].referencia, 4031.2, 3911.2]])
    assert.match(pos.unidades[0].referencia, /^TIB1-XAUUSD-/)
    assert.ok(avisos.some(a => /^Tortugas IB S1 · Oro · Compra de 3 a 4031,2/.test(a)))

    // el 23-nov el diciembre ya está en su ventana de cambio: el plan va al febrero, y la posición pasa a él
    t = ny(11, 23, 10)
    ib.precio('MGCG7', 4080, 4080.4)
    ib.precio('MGCZ6', 4040, 4040.2)
    await bot._paso()                          // el plan de hoy, con el contrato nuevo
    m = bot.estado().mercados.find(x => x.ticker === 'XAUUSD')
    assert.equal(m.plan.unidad.epic, 'MGCG7')
    await bot._paso()                          // y el cambio
    pos = bot.estado().mercados.find(x => x.ticker === 'XAUUSD').posiciones[1]
    assert.equal(pos.epic, 'MGCG7')
    const u = pos.unidades[0]
    // compra el febrero a 4.080,4 y vende el diciembre a 4.040: la entrada se corre 40,4
    assert.ok(Math.abs(u.entrada - (4031.2 + 40.4)) < 1e-9)
    assert.equal(u.epic, 'MGCG7')
    assert.equal(pos.stop, 3911.2 + 40.4)
    assert.deepEqual(u.rolada.map(r => [r.de, r.a, r.salida, r.entrada]), [['MGCZ6', 'MGCG7', 4040, 4080.4]])
    assert.deepEqual((await tib.operar.posiciones()).map(p => p.epic), ['MGCG7'])

    // salta el stop del nuevo: fuera, y el resultado cuenta los dos contratos
    ib.saltar(u.dealId)
    t += 60
    await bot._paso()
    assert.equal(bot.estado().mercados.find(x => x.ticker === 'XAUUSD').posiciones[1], null)
    const op = bot.estado().operaciones[0]
    assert.equal(op.motivo, 'stop')
    // (4.040 − 4.031,2) en el diciembre + (3.951,6 − 4.080,4) en el febrero = −120 puntos por contrato
    assert.ok(Math.abs(op.resultadoPts - -120) < 1e-6)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('cerrar a mano un mercado y sistema: vende a mercado y apunta la operación como manual', async () => {
  const ib = ibFalso()
  let t = ny(11, 3, 10)
  const tib = crearTortugasIB({ ib, ahora: () => t, log: () => {} })
  const dir = mkdtempSync(join(tmpdir(), 'tortugas-ib-'))
  const bot = crearBotTortugas({
    archivo: join(dir, 'bot.json'), ahora: () => t, log: () => {}, revisarCadaMs: 0,
    mercados: tib.mercados, operar: tib.operar, precios: tib.precios, epicsDe: tib.epicsDe, velasDiarias: tib.velasDiarias,
    broker: 'IB', nombre: 'Tortugas IB', prefijo: tib.prefijo,
  })
  try {
    await tib.arrancar()
    ib.precio('EUR.USD', 1.0999, 1.1001)
    ib.precio('MGCZ6', 4000, 4000.2)
    ib.diarios.MGCZ6 = diarioPlano(4000, 30, '2026-11-02')
    bot.cambiarConfig({ activo: true, sistemas: [1], instrumentos: Object.fromEntries(Object.keys(MERCADOS_IB).map(k => [k, k === 'XAUUSD'])) })
    await bot._paso()
    t += 60
    ib.precio('MGCZ6', 4031, 4031.2)
    await bot._paso()
    await assert.rejects(bot.cerrarMercado('XAUUSD', 2), /no tiene posición/)
    ib.precio('MGCZ6', 4020, 4020.2)
    assert.deepEqual(await bot.cerrarMercado('XAUUSD', 1), { cerrada: true })
    const op = bot.estado().operaciones[0]
    assert.equal(op.motivo, 'manual')
    assert.ok(Math.abs(op.resultadoPts - (4020 - 4031.2)) < 1e-9)
    assert.deepEqual(await tib.operar.posiciones(), [])
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('IB: una horquilla imposible (la subasta de Xetra) no hace velas ni deja entrar; el stop va al escalón de su regla; un stop rechazado cancela la madre', async () => {
  const ib = ibFalso()
  ib.reglaPrecio = async () => [{ desde: 0, paso: 0.001 }, { desde: 10, paso: 0.005 }, { desde: 100, paso: 0.05 }]
  DETALLES.SXR8 = [{ contract: { conId: 41, symbol: 'SXR8', secType: 'STK', exchange: 'SMART', primaryExch: 'IBIS', currency: 'EUR', localSymbol: 'SXR8' }, minTick: 0.0001, marketRuleIds: '9,1', validExchanges: 'SMART,IBIS' }]
  const t = ny(11, 3, 4)
  const tib = crearTortugasIB({ ib, ahora: () => t, log: () => {}, mercados: { '^GSPC': { ...MERCADOS_IB['^GSPC'], simbolos: ['SXR8'] } } })
  try {
    await tib.arrancar()
    ib.precio('SXR8', 733, 1200)
    assert.deepEqual(tib.precios.velas('^GSPC', 5), [])
    const m = await tib.operar.datosMercado('^GSPC')
    assert.equal(m.oferta, null)
    // con ese precio, el stop quedaría por encima del de verdad: no se manda
    ib.precio('SXR8', 733, 733.2)
    assert.equal((await tib.operar.abrir({ ticker: '^GSPC', epic: 'SXR8', lado: 'largo', tamano: 10, stop: 1179.8553, referencia: 'TIB1-GSPC-x' })).aceptada, false)
    assert.equal(ib.mandadas.length, 0)
    const r = await tib.operar.abrir({ ticker: '^GSPC', epic: 'SXR8', lado: 'largo', tamano: 10, stop: 712.8553, referencia: 'TIB1-GSPC-y' })
    assert.equal(r.stop, 712.85)
    // si IB rechaza el stop, la madre se cancela y la entrada cuenta como rechazada
    const mandar = ib.mandarPatas
    ib.mandarPatas = async patas => {
      const ids = await mandar(patas.map(p => ({ ...p, orden: { ...p.orden, orderType: p.orden.orderType === 'MKT' ? 'LMT' : p.orden.orderType } })))
      Object.assign(ib.ordenes.get(ids[1]), { estadoIB: null, motivo: 'The price does not conform to the minimum price variation' })
      Object.assign(ib.ordenes.get(ids[0]), { estadoIB: null })
      return ids
    }
    const rechazada = await tib.operar.abrir({ ticker: '^GSPC', epic: 'SXR8', lado: 'largo', tamano: 10, stop: 712.85, referencia: 'TIB1-GSPC-z' })
    assert.equal(rechazada.aceptada, false)
    assert.match(rechazada.motivo, /rechaza su stop/)
    assert.equal(ib.mandadas.at(-2).estadoIB, 'Cancelled')
  } finally { delete DETALLES.SXR8 }
})

test('IB: en los que cotizan en centavos (priceMagnifier 100) la regla de mercado va en dólares y se pasa a centavos', async () => {
  const ib = ibFalso()
  ib.reglaPrecio = async () => [{ desde: 0, paso: 0.0001 }]
  DETALLES.CT = [{
    contract: { conId: 51, symbol: 'CT', secType: 'FUT', exchange: 'NYBOT', currency: 'USD', localSymbol: 'CTZ6', lastTradeDateOrContractMonth: '20261208', multiplier: '50000' },
    contractMonth: '202612', minTick: 0.01, priceMagnifier: 100, marketRuleIds: '87', validExchanges: 'NYBOT',
  }]
  const tib = crearTortugasIB({ ib, ahora: () => ny(11, 3, 4), log: () => {}, mercados: { COTTON: MERCADOS_IB.COTTON } })
  try {
    await tib.arrancar()
    ib.precio('CTZ6', 76.8, 76.82)
    const r = await tib.operar.abrir({ ticker: 'COTTON', epic: 'CTZ6', lado: 'corto', tamano: 2, stop: 79.623, referencia: 'TIB1-COTTON-x' })
    assert.equal(r.stop, 79.62)
  } finally { delete DETALLES.CT }
})
