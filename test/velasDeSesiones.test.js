// Tests de la descarga por lotes de las estrategias (velasDeSesiones en src/intradayApi.js):
// lo guardado llega en una petición por lote, lo que falta se pide de una en una, y las
// sesiones salen siempre en el orden pedido
import test from 'node:test'
import assert from 'node:assert/strict'

import { velasDeSesiones } from '../src/intradayApi.js'

// Un servidor falso: `guardadas` es lo que el lote encuentra en caché, y cualquier fecha
// pedida suelta devuelve una vela con su propia fecha para poder reconocerla
function servidorFalso({ guardadas = [], lote = 'bien', fallan = [] } = {}) {
  const pedidas = []
  globalThis.fetch = async (url, { signal } = {}) => {
    signal?.throwIfAborted()
    const u = new URL(url, 'http://local')
    pedidas.push(u.pathname === '/api/velas15m/lote' ? `lote:${u.searchParams.get('fechas')}` : u.searchParams.get('date'))
    if (u.pathname === '/api/velas15m/lote') {
      if (lote === '404') return new Response('Not found', { status: 404 })
      const sesiones = Object.fromEntries(u.searchParams.get('fechas').split(',')
        .filter(f => guardadas.includes(f))
        .map(f => [f, { velas: [{ time: f, origen: 'lote' }], fuente: 'Dukascopy m15' }]))
      return Response.json({ sesiones })
    }
    const date = u.searchParams.get('date')
    if (fallan.includes(date)) throw new TypeError('fetch failed')
    return Response.json({ velas: [{ time: date, origen: 'suelta' }], fuente: 'Dukascopy m15' })
  }
  return pedidas
}

async function todas(...args) {
  const out = []
  for await (const s of velasDeSesiones(...args)) out.push(s)
  return out
}

test('lo guardado sale del lote y solo lo que falta se pide suelto, en el orden pedido', async () => {
  const pedidas = servidorFalso({ guardadas: ['2026-10-16', '2026-10-14'] })
  const r = await todas('^GDAXI', ['2026-10-16', '2026-10-15', '2026-10-14'], 'm15')
  assert.deepEqual(r.map(s => s.fecha), ['2026-10-16', '2026-10-15', '2026-10-14'])
  assert.deepEqual(r.map(s => s.velas[0].origen), ['lote', 'suelta', 'lote'])
  assert.deepEqual(pedidas, ['lote:2026-10-16,2026-10-15,2026-10-14', '2026-10-15'])
})

test('va en lotes de 25', async () => {
  const fechas = Array.from({ length: 60 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`)
  const pedidas = servidorFalso({ guardadas: fechas })
  const r = await todas('^GDAXI', fechas, 'm5')
  assert.equal(r.length, 60)
  assert.deepEqual(pedidas.map(p => p.split(',').length), [25, 25, 10])
})

test('con un servidor sin el lote, lo pide todo suelto como antes', async () => {
  const pedidas = servidorFalso({ lote: '404' })
  const r = await todas('^GDAXI', ['2026-10-16', '2026-10-15'], 'm15')
  assert.deepEqual(r.map(s => s.velas[0].origen), ['suelta', 'suelta'])
  assert.deepEqual(pedidas.slice(1), ['2026-10-16', '2026-10-15'])
})

test('una sesión que falla queda sin velas y las demás siguen', async () => {
  servidorFalso({ fallan: ['2026-10-15'] })
  const r = await todas('^GDAXI', ['2026-10-16', '2026-10-15', '2026-10-14'], 'm15')
  assert.deepEqual(r.map(s => s.velas.length), [1, 0, 1])
  assert.equal(r[1].fuente, null)
})

test('los tickers sin Dukascopy no piden lote', async () => {
  const pedidas = servidorFalso()
  await todas('AAPL', ['2026-10-16'], 'm15')
  assert.deepEqual(pedidas, ['2026-10-16'])
})

test('cancelar corta la descarga con AbortError', async () => {
  servidorFalso()
  const ctrl = new AbortController()
  const vistas = []
  await assert.rejects(async () => {
    for await (const s of velasDeSesiones('^GDAXI', ['2026-10-16', '2026-10-15', '2026-10-14'], 'm15', ctrl.signal)) {
      vistas.push(s.fecha)
      ctrl.abort()
    }
  }, { name: 'AbortError' })
  assert.deepEqual(vistas, ['2026-10-16'])
})
