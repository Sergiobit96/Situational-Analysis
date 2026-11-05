// Historial de IB (server/historial-ib.js) y lo que server/ib.js apunta en él

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { crearHistorialIB, horaDeIB } from '../server/historial-ib.js'
import { crearIB } from '../server/ib.js'

test('horaDeIB: sin zona es UTC; con zona se pasa a UTC', () => {
  assert.equal(horaDeIB('20261105 10:07:29'), '2026-11-05T10:07:29.000Z')
  assert.equal(horaDeIB('20261105 11:07:29 Europe/Madrid'), '2026-11-05T10:07:29.000Z')
  assert.equal(horaDeIB('20261105-10:07:29'), '2026-11-05T10:07:29.000Z')
  assert.equal(horaDeIB('basura', Date.UTC(2026, 10, 5)), '2026-11-05T00:00:00.000Z')
})

test('historial: ejecuciones sin repetir, en orden por hora, con la comisión aunque llegue antes; se guarda y se vuelve a leer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'historial-ib-'))
  const archivo = join(dir, 'h.json')
  try {
    const h = crearHistorialIB({ archivo, ahora: () => Date.UTC(2026, 10, 5, 12) })
    h.comision({ execId: 'b', commission: 1.25, currency: 'EUR', realizedPNL: 1.7976931348623157e308 })
    h.ejecucion({ execId: 'b', orderId: 2, referencia: 'TIB1-x', simbolo: 'XDJP', conId: 1, lado: 'SLD', cantidad: 10, precio: 35.7, hora: '20261105 10:00:00' })
    h.ejecucion({ execId: 'a', orderId: 1, referencia: 'SA-1', simbolo: 'EXS1', conId: 2, lado: 'BOT', cantidad: 1, precio: 219.3, hora: '20261105 09:41:20' })
    h.ejecucion({ execId: 'a', orderId: 1, simbolo: 'EXS1', lado: 'BOT', cantidad: 1, precio: 219.3, hora: '20261105 09:41:20' })
    h.comision({ execId: 'a', commission: 3, currency: 'EUR', realizedPNL: -0.1 })
    h.orden('cancelada', { orderId: 90, simbolo: 'XDJP', lado: 'compra', orden: 'stop', cantidad: 2552, precio: 37.335, origen: 'fuera' })
    const l = h.lista()
    assert.deepEqual(l.map(x => x.execId ?? x.orderId), [90, 'b', 'a'])
    assert.deepEqual([l[1].lado, l[1].comision, l[1].realizado], ['venta', 1.25, null])
    assert.deepEqual([l[2].lado, l[2].comision, l[2].realizado], ['compra', 3, -0.1])
    await new Promise(r => setTimeout(r, 1100))
    assert.equal(JSON.parse(readFileSync(archivo, 'utf8')).length, 3)
    const otra = crearHistorialIB({ archivo })
    otra.ejecucion({ execId: 'a', orderId: 1, simbolo: 'EXS1', lado: 'BOT', cantidad: 1, precio: 219.3, hora: '20261105 09:41:20' })
    assert.equal(otra.lista().length, 3)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// un Gateway de mentira: confirma las órdenes y las cancela cuando se le pide
class Falsa extends EventEmitter {
  constructor() { super(); this.isConnected = false; Falsa.ultima = this }
  connect() { setImmediate(() => { this.isConnected = true; this.emit('connected'); this.emit('nextValidId', 100); this.emit('managedAccounts', 'DU1') }) }
  reqAccountUpdates() { setImmediate(() => this.emit('accountDownloadEnd', 'DU1')) }
  reqAllOpenOrders() { setImmediate(() => this.emit('openOrderEnd')) }
  reqMarketDataType() {}
  reqExecutions(id) { setImmediate(() => this.emit('execDetailsEnd', id)) }
  placeOrder(id, c, o) { setImmediate(() => this.emit('orderStatus', id, 'Submitted', 0, o.totalQuantity, 0)) }
  cancelOrder(id) { setImmediate(() => this.emit('orderStatus', id, 'Cancelled', 0, 0, 0)) }
  disconnect() {}
}

test('crearIB: apunta las órdenes puestas y si una cancelación la pidió el servidor o vino de fuera', async () => {
  const h = crearHistorialIB()
  const ib = crearIB({ port: 4002, Api: Falsa, historial: h })
  try {
    await ib.estado()
    const contrato = { conId: 9, symbol: 'XDJP', secType: 'STK', exchange: 'SMART', currency: 'EUR', localSymbol: 'XDJP' }
    const stop = { action: 'BUY', orderType: 'STP', auxPrice: 37.335, totalQuantity: 2552, tif: 'GTC', orderRef: 'TIB1-N225-x-stop', transmit: true }
    const [a] = await ib.mandarPatas([{ contrato, orden: stop }])
    const [b] = await ib.mandarPatas([{ contrato, orden: { ...stop, orderRef: 'TIB1-COPPER-y-stop' } }])
    await new Promise(r => setImmediate(r))
    await ib.cancelar(a)
    await new Promise(r => setImmediate(r))
    Falsa.ultima.emit('orderStatus', b, 'Cancelled', 0, 0, 0)        // desde la app de IB
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
    const l = ib.historial()
    assert.deepEqual(l.map(x => [x.tipo, x.orderId, x.origen]), [['cancelada', b, 'fuera'], ['cancelada', a, 'servidor'], ['puesta', b, null], ['puesta', a, null]])
    assert.deepEqual([l[0].simbolo, l[0].lado, l[0].orden, l[0].precio, l[0].cantidad], ['XDJP', 'compra', 'stop', 37.335, 2552])
    // la misma cancelación otra vez no se apunta dos veces
    Falsa.ultima.emit('orderStatus', b, 'Cancelled', 0, 0, 0)
    assert.equal(ib.historial().length, 4)
  } finally { ib.cerrar() }
})
