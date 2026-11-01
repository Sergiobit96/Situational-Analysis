import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { ordenParaIB, crearIB, esPaper } from '../server/ib.js'

test('ordenParaIB: compra a mercado de acciones en SMART', () => {
  const [p] = ordenParaIB({ simbolo: 'spy', lado: 'compra', cantidad: '3' }, { referencia: 'R' })
  assert.deepEqual(p.contrato, { symbol: 'SPY', secType: 'STK', exchange: 'SMART', currency: 'USD' })
  assert.deepEqual(p.orden, { action: 'BUY', orderType: 'MKT', totalQuantity: 3, tif: 'DAY', orderRef: 'R', transmit: true })
})

test('ordenParaIB: límite con stop de protección = bracket con la madre sin transmitir', () => {
  const patas = ordenParaIB({ simbolo: 'AAPL', lado: 'compra', tipo: 'limit', limite: 200, cantidad: 10, stopLoss: 190 }, { referencia: 'R' })
  assert.equal(patas.length, 2)
  assert.equal(patas[0].orden.transmit, false)
  assert.equal(patas[0].orden.lmtPrice, 200)
  assert.deepEqual(patas[1].orden, { action: 'SELL', orderType: 'STP', auxPrice: 190, totalQuantity: 10, tif: 'GTC', orderRef: 'R-stop', transmit: true })
})

test('ordenParaIB: rechaza lo que no cuadra', () => {
  assert.throws(() => ordenParaIB({ simbolo: 'AAPL', lado: 'compra', cantidad: 1.5 }), /entera/)
  assert.throws(() => ordenParaIB({ simbolo: 'AAPL', lado: 'compra', tipo: 'limit', cantidad: 1 }), /límite/)
  assert.throws(() => ordenParaIB({ simbolo: 'AAPL', lado: 'venta', tipo: 'limit', limite: 100, cantidad: 1, stopLoss: 90 }), /por encima/)
  assert.throws(() => ordenParaIB({ simbolo: 'ES', instrumento: 'FUT', lado: 'compra', cantidad: 1 }), /vencimiento/)
  assert.throws(() => ordenParaIB({ simbolo: 'AAPL', lado: 'x', cantidad: 1 }), /lado/)
})

test('ordenParaIB: futuro con vencimiento y divisa', () => {
  const [p] = ordenParaIB({ simbolo: 'ES', instrumento: 'FUT', bolsa: 'CME', vencimiento: '202612', lado: 'venta', cantidad: 1 })
  assert.equal(p.contrato.lastTradeDateOrContractMonth, '202612')
  assert.equal(p.contrato.exchange, 'CME')
  const [d] = ordenParaIB({ simbolo: 'EUR', instrumento: 'CASH', lado: 'compra', cantidad: 20000 })
  assert.equal(d.contrato.exchange, 'IDEALPRO')
})

test('esPaper: las cuentas paper empiezan por DU', () => {
  assert.equal(esPaper('DU1234567'), true)
  assert.equal(esPaper('U1234567'), false)
})

test('crearIB: sin IB_PORT no hay nada', () => {
  assert.equal(crearIB({}), null)
})

// un Gateway de mentira que contesta como el de verdad
function apiFalsa(cuenta) {
  return class extends EventEmitter {
    constructor() { super(); this.isConnected = false; this.mandadas = []; FalsaUltima.api = this }
    connect() {
      setImmediate(() => {
        this.isConnected = true
        this.emit('connected'); this.emit('nextValidId', 100); this.emit('managedAccounts', cuenta)
      })
    }
    reqAccountUpdates() {
      setImmediate(() => {
        this.emit('updateAccountValue', 'NetLiquidation', '1000000', 'USD', cuenta)
        this.emit('updatePortfolio', { conId: 756733, symbol: 'SPY', secType: 'STK', currency: 'USD' }, 5, 600, 3000, 590, 50, 0, cuenta)
        this.emit('accountDownloadEnd', cuenta)
      })
    }
    reqAllOpenOrders() { setImmediate(() => this.emit('openOrderEnd')) }
    placeOrder(id, c, o) { this.mandadas.push({ id, c, o }); setImmediate(() => this.emit('orderStatus', id, 'Submitted', 0, o.totalQuantity, 0)) }
    cancelOrder() {}
    disconnect() {}
    reqMarketDataType(tipo) { this.tipoDatos = tipo }
    reqMktData(id) { setImmediate(() => { this.emit('tickPrice', id, 66, 1.1); this.emit('tickPrice', id, 67, 1.2) }) }
    reqExecutions(id) {
      setImmediate(() => {
        this.emit('execDetails', id, { conId: 1, localSymbol: 'MGCZ6' }, { execId: 'x1', permId: 7, orderId: 101, orderRef: 'TIB1-a-stop', price: 4000.5, shares: 2, side: 'SLD', time: '20261102 10:00:00' })
        this.emit('execDetailsEnd', id)
      })
    }
    reqContractDetails(id, c) {
      setImmediate(() => {
        if (c.symbol === 'NADA') return this.emit('error', new Error('No security definition has been found for the request'), 200, id)
        this.emit('contractDetails', id, { contract: { ...c, conId: 5, localSymbol: 'MGCZ6' }, minTick: 0.1 })
        this.emit('contractDetailsEnd', id)
      })
    }
    reqHistoricalData(id) {
      setImmediate(() => {
        this.emit('historicalData', id, '20261029', 10, 12, 9, 11, 100)
        this.emit('historicalData', id, '20261030', 11, 13, 10, 12, 100)
        this.emit('historicalData', id, 'finished-20261029-20261030', -1, -1, -1, -1, -1)
      })
    }
  }
}
const FalsaUltima = {}

test('crearIB: conecta, lee la cuenta y manda un bracket con la hija colgada de la madre', async () => {
  const ib = crearIB({ port: 4002, Api: apiFalsa('DU999') })
  const e = await ib.estado()
  assert.equal(e.conectado, true)
  assert.equal(e.cuenta, 'DU999')
  assert.equal(e.paper, true)
  assert.equal(e.resumen.liquidacion, 1_000_000)
  assert.equal(e.resumen.moneda, 'USD')
  assert.equal(e.posiciones[0].simbolo, 'SPY')
  assert.equal(e.posiciones[0].resultado, 50)

  const r = await ib.enviarOrden({ simbolo: 'AAPL', lado: 'compra', tipo: 'limit', limite: 200, cantidad: 2, stopLoss: 190 })
  const [madre, hija] = FalsaUltima.api.mandadas
  assert.equal(madre.id, 100)
  assert.equal(hija.o.parentId, 100)
  assert.equal(hija.o.account, 'DU999')
  assert.deepEqual(r.map(o => o.estado), ['pendiente', 'pendiente'])
  ib.cerrar()
})

test('crearIB: para los bots, contratos, histórico diario, precios (con retraso si no hay suscripción) y ejecuciones', async () => {
  const ib = crearIB({ port: 4002, Api: apiFalsa('DU999') })
  const [d] = await ib.detalles({ symbol: 'MGC', secType: 'FUT', exchange: 'COMEX' })
  assert.equal(d.contract.conId, 5)
  await assert.rejects(ib.detalles({ symbol: 'NADA', secType: 'FUT' }), /No security definition/)
  assert.equal(FalsaUltima.api.tipoDatos, 3)
  const velas = await ib.historico(d.contract)
  assert.deepEqual(velas.map(v => v.date), ['2026-10-29', '2026-10-30'])
  let avisos = 0
  const q = ib.cotizar('MGCZ6', d.contract, () => avisos++)
  await new Promise(r => setTimeout(r, 20))
  assert.equal(q.bid, 1.1)
  assert.equal(q.ask, 1.2)
  assert.equal(q.retrasado, true)
  assert.equal(avisos, 2)
  assert.equal(ib.cotizar('MGCZ6', d.contract), q)
  const ej = await ib.ejecuciones()
  assert.equal(ej[0].orderRef, 'TIB1-a-stop')
  assert.equal(ej[0].precio, 4000.5)
  assert.deepEqual(await ib.abiertas(), [])
  ib.cerrar()
})

test('crearIB: no manda órdenes a una cuenta real sin IB_REAL', async () => {
  const ib = crearIB({ port: 4001, Api: apiFalsa('U123') })
  await assert.rejects(ib.enviarOrden({ simbolo: 'AAPL', lado: 'compra', cantidad: 1 }), /es real/)
  assert.equal(FalsaUltima.api.mandadas.length, 0)
  ib.cerrar()
})

test('crearIB: sin Gateway contesta que no está conectado', async () => {
  const Muda = class extends EventEmitter { get isConnected() { return false } connect() { setImmediate(() => this.emit('error', new Error('connect ECONNREFUSED'), 502, -1)) } disconnect() {} }
  const ib = crearIB({ port: 4002, Api: Muda })
  const e = await ib.estado()
  assert.equal(e.conectado, false)
  assert.match(e.error, /No hay IB Gateway/)
  ib.cerrar()
})
