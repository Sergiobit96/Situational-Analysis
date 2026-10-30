// Tests del cliente de Alpaca (server/alpaca.js)
import test from 'node:test'
import assert from 'node:assert/strict'

import { ordenParaAlpaca, crearAlpaca, posicionDeAlpaca } from '../server/alpaca.js'

const ahora = () => 1700000000000

test('una compra a mercado de acciones enteras', () => {
  assert.deepEqual(ordenParaAlpaca({ simbolo: ' spy ', lado: 'compra', cantidad: '2' }, { ahora }), {
    symbol: 'SPY', side: 'buy', type: 'market', time_in_force: 'day', client_order_id: 'SA-1700000000000', qty: '2',
  })
})

test('por importe en $, fraccionaria', () => {
  const o = ordenParaAlpaca({ simbolo: 'QQQ', lado: 'compra', importe: 50 }, { ahora })
  assert.equal(o.notional, '50')
  assert.equal(o.qty, undefined)
})

test('límite y stop piden su precio', () => {
  assert.throws(() => ordenParaAlpaca({ simbolo: 'SPY', lado: 'compra', tipo: 'limit', cantidad: 1 }), /límite/)
  assert.throws(() => ordenParaAlpaca({ simbolo: 'SPY', lado: 'venta', tipo: 'stop', cantidad: 1 }), /stop/)
  const o = ordenParaAlpaca({ simbolo: 'SPY', lado: 'compra', tipo: 'stop_limit', cantidad: 1, stop: 760, limite: 761, validez: 'gtc' })
  assert.deepEqual([o.stop_price, o.limit_price, o.time_in_force], ['760', '761', 'gtc'])
})

test('cantidad o importe, uno de los dos', () => {
  assert.throws(() => ordenParaAlpaca({ simbolo: 'SPY', lado: 'compra' }), /uno de los dos/)
  assert.throws(() => ordenParaAlpaca({ simbolo: 'SPY', lado: 'compra', cantidad: 1, importe: 10 }), /uno de los dos/)
  assert.throws(() => ordenParaAlpaca({ simbolo: 'SPY', lado: 'compra', cantidad: -1 }), /mayor que 0/)
})

test('las fraccionarias, solo a mercado o límite y del día', () => {
  assert.throws(() => ordenParaAlpaca({ simbolo: 'SPY', lado: 'compra', importe: 10, validez: 'gtc' }), /fraccionarias/)
  assert.throws(() => ordenParaAlpaca({ simbolo: 'SPY', lado: 'venta', tipo: 'stop', stop: 700, cantidad: 0.5 }), /fraccionarias/)
})

test('símbolo y lado no válidos', () => {
  assert.throws(() => ordenParaAlpaca({ simbolo: 'SPY/../x', lado: 'compra', cantidad: 1 }), /Símbolo/)
  assert.throws(() => ordenParaAlpaca({ simbolo: 'SPY', lado: 'buy', cantidad: 1 }), /lado/)
})

test('el stop de protección va como OTO y del lado bueno', () => {
  const o = ordenParaAlpaca({ simbolo: 'SPY', lado: 'venta', cantidad: 1, stopLoss: 774.18 }, { ahora })
  assert.equal(o.order_class, 'oto')
  assert.deepEqual(o.stop_loss, { stop_price: '774.18' })
  assert.throws(() => ordenParaAlpaca({ simbolo: 'SPY', lado: 'compra', tipo: 'limit', limite: 700, cantidad: 1, stopLoss: 710 }), /por debajo/)
  assert.throws(() => ordenParaAlpaca({ simbolo: 'SPY', lado: 'compra', importe: 100, stopLoss: 700 }), /enteras/)
})

test('las posiciones cortas salen con cantidad positiva y el % en %', () => {
  const p = posicionDeAlpaca({ symbol: 'SPY', side: 'short', qty: '-1', avg_entry_price: '758.95', current_price: '758.9', market_value: '-758.9', unrealized_pl: '0.05', unrealized_plpc: '0.0000659', unrealized_intraday_pl: '0.05' })
  assert.equal(p.lado, 'corto')
  assert.equal(p.cantidad, 1)
  assert.ok(Math.abs(p.resultadoPct - 0.00659) < 1e-9)
})

test('sin claves no hay cliente; con claves manda las cabeceras y va a paper', async () => {
  assert.equal(crearAlpaca({}), null)
  const vistas = []
  const fetch = async (url, opciones) => {
    vistas.push({ url, opciones })
    return { ok: true, text: async () => JSON.stringify({ account_number: 'PA123', status: 'ACTIVE', currency: 'USD', cash: '100000', equity: '100000', last_equity: '99000', buying_power: '400000' }) }
  }
  const a = crearAlpaca({ clave: 'PKx', secreto: 's', fetch })
  const c = await a.cuenta()
  assert.equal(vistas[0].url, 'https://paper-api.alpaca.markets/v2/account')
  assert.equal(vistas[0].opciones.headers['APCA-API-KEY-ID'], 'PKx')
  assert.deepEqual([c.paper, c.equity, c.equityAyer], [true, 100000, 99000])
})

test('un error de Alpaca llega con su mensaje', async () => {
  const fetch = async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ code: 40310000, message: 'potential wash trade detected. use complex orders' }) })
  const a = crearAlpaca({ clave: 'PKx', secreto: 's', fetch })
  await assert.rejects(a.enviarOrden({ simbolo: 'SPY', lado: 'compra', cantidad: 1 }), /Alpaca 403: potential wash trade/)
})

test('cerrar una posición cancela antes sus órdenes pendientes', async () => {
  const pasos = []
  const fetch = async (url, { method }) => {
    pasos.push(`${method} ${url.replace('https://paper-api.alpaca.markets', '')}`)
    const cuerpo = method === 'GET' ? [{ id: 'o1' }] : method === 'DELETE' && url.includes('/positions/') ? { id: 'c1', symbol: 'SPY', side: 'sell', type: 'market', qty: '1', status: 'accepted' } : null
    return { ok: true, text: async () => (cuerpo ? JSON.stringify(cuerpo) : '') }
  }
  const a = crearAlpaca({ clave: 'PKx', secreto: 's', fetch })
  const o = await a.cerrarPosicion('SPY')
  assert.deepEqual(pasos, ['GET /v2/orders?status=open&symbols=SPY', 'DELETE /v2/orders/o1', 'DELETE /v2/positions/SPY'])
  assert.equal(o.lado, 'venta')
})
