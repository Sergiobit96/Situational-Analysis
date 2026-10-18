// Tests del transporte de Dukascopy (server/dukascopy-transport.js): cuando el 443 falla,
// la descarga se repite por HTTP y el modo pasa a HTTP sin esperar a la media hora
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  instalarTransporteDukascopy, revalidarTransporteDukascopy, estadoTransporteDukascopy,
} from '../server/dukascopy-transport.js'

// Un fetch falso en lugar de la red. La sonda (HistoryStart.bi5) siempre conecta, como
// pasa en la realidad cuando el 443 está "abierto" pero contesta 429 a los datos.
const pedidas = []
let https = 'bien'
globalThis.fetch = async url => {
  pedidas.push(url)
  if (url.endsWith('HistoryStart.bi5')) return new Response('sonda')
  if (url.startsWith('https://datafeed.dukascopy.com/')) {
    if (https === '429') return new Response('', { status: 429 })
    if (https === 'timeout') throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })
  }
  return new Response('datos')
}
instalarTransporteDukascopy()

const FICHERO = 'https://datafeed.dukascopy.com/datafeed/DEUIDXEUR/2026/09/15/BID_candles_min_1.bi5'
const POR_HTTP = FICHERO.replace('https://', 'http://')

async function descargar() {
  pedidas.length = 0
  const r = await fetch(FICHERO)
  return { status: r.status, cuerpo: await r.text(), pedidas: pedidas.filter(u => !u.endsWith('HistoryStart.bi5')) }
}

test('con el 443 sano descarga por HTTPS', async () => {
  https = 'bien'
  revalidarTransporteDukascopy()
  const d = await descargar()
  assert.deepEqual(d, { status: 200, cuerpo: 'datos', pedidas: [FICHERO] })
  assert.equal(estadoTransporteDukascopy().modo, 'https')
})

test('un 429 por HTTPS se repite al momento por HTTP y el modo pasa a HTTP', async () => {
  https = '429'
  revalidarTransporteDukascopy()
  const d = await descargar()
  assert.deepEqual(d, { status: 200, cuerpo: 'datos', pedidas: [FICHERO, POR_HTTP] })
  assert.equal(estadoTransporteDukascopy().modo, 'http')
  // y las siguientes ya van directas por HTTP, sin volver a probar el 443
  assert.deepEqual((await descargar()).pedidas, [POR_HTTP])
})

test('un timeout de conexión por HTTPS también acaba por HTTP', async () => {
  https = 'timeout'
  revalidarTransporteDukascopy()
  const d = await descargar()
  assert.deepEqual(d, { status: 200, cuerpo: 'datos', pedidas: [FICHERO, POR_HTTP] })
  assert.equal(estadoTransporteDukascopy().modo, 'http')
})

test('lo que no es el datafeed pasa sin tocarse', async () => {
  pedidas.length = 0
  await fetch('https://query2.finance.yahoo.com/v8/finance/chart/%5EGDAXI')
  assert.deepEqual(pedidas, ['https://query2.finance.yahoo.com/v8/finance/chart/%5EGDAXI'])
})
