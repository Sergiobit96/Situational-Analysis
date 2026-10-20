// Tests de la descarga de las estrategias (velasDeSesiones en src/intradayApi.js): lo
// guardado llega en una petición por lote, lo que falta se encarga a la cola del feed del
// servidor y se espera, y las sesiones salen siempre en el orden pedido
import test from 'node:test'
import assert from 'node:assert/strict'

import { velasDeSesiones } from '../src/intradayApi.js'

// Un servidor falso. `guardadas`: lo que ya está en caché. `tardan`: cuántas consultas del
// lote tarda cada fecha en bajarse desde que se encarga. `lote: '404'`: un servidor de antes
// del lote. Cualquier fecha pedida suelta devuelve una vela suya para poder reconocerla.
function servidorFalso({ guardadas = [], tardan = {}, sinDatos = [], lote = 'bien', fallan = [] } = {}) {
  const pedidas = [], encargos = []
  const listas = new Set(guardadas)
  const enCola = new Map()   // fecha -> consultas que le quedan
  globalThis.fetch = async (url, { signal } = {}) => {
    signal?.throwIfAborted()
    const u = new URL(url, 'http://local')
    if (u.pathname === '/api/velas15m/lote') {
      if (lote === '404') return new Response('Not found', { status: 404 })
      const fechas = u.searchParams.get('fechas').split(',')
      // cada consulta es un paso del reloj de la cola
      for (const [f, n] of enCola) n <= 1 ? (enCola.delete(f), listas.add(f)) : enCola.set(f, n - 1)
      if (u.searchParams.get('soloEncolar') === '1' || u.searchParams.get('encolar') === '1') {
        for (const f of fechas) if (!listas.has(f) && !sinDatos.includes(f) && !enCola.has(f) && f in tardan) enCola.set(f, tardan[f])
      }
      if (u.searchParams.get('soloEncolar') === '1') { encargos.push(fechas); return Response.json({ sesiones: {} }) }
      pedidas.push(`lote:${fechas.join(',')}`)
      return Response.json({
        sesiones: Object.fromEntries(fechas.filter(f => listas.has(f)).map(f => [f, { velas: [{ time: f, origen: 'lote' }], fuente: 'Dukascopy m15' }])),
        sinDatos: fechas.filter(f => sinDatos.includes(f)),
        pendientes: fechas.filter(f => enCola.has(f)),
        cola: { enCola: enCola.size },
      })
    }
    const date = u.searchParams.get('date')
    pedidas.push(date)
    if (fallan.includes(date)) throw new TypeError('fetch failed')
    return Response.json({ velas: [{ time: date, origen: 'suelta' }], fuente: 'Yahoo 15m' })
  }
  return { pedidas, encargos }
}

// sin esperas reales entre consultas a la cola
const setTimeoutReal = globalThis.setTimeout
globalThis.setTimeout = (fn, ms, ...args) => setTimeoutReal(fn, 0, ...args)

async function todas(tkr, fechas, tf, signal, alEsperar) {
  const out = []
  for await (const s of velasDeSesiones(tkr, fechas, tf, signal, alEsperar)) out.push(s)
  return out
}

test('lo guardado sale del lote sin pedir nada suelto, en el orden pedido', async () => {
  const { pedidas } = servidorFalso({ guardadas: ['2026-10-16', '2026-10-15', '2026-10-14'] })
  const r = await todas('^GDAXI', ['2026-10-16', '2026-10-15', '2026-10-14'], 'm15')
  assert.deepEqual(r.map(s => s.fecha), ['2026-10-16', '2026-10-15', '2026-10-14'])
  assert.deepEqual(r.map(s => s.velas[0].origen), ['lote', 'lote', 'lote'])
  assert.deepEqual(pedidas, ['lote:2026-10-16,2026-10-15,2026-10-14'])
})

test('lo que falta se espera a la cola del feed, sin caer a Yahoo', async () => {
  const { pedidas } = servidorFalso({ guardadas: ['2026-10-16', '2026-10-14'], tardan: { '2026-10-15': 2 } })
  const esperas = []
  const r = await todas('^GDAXI', ['2026-10-16', '2026-10-15', '2026-10-14'], 'm15', undefined, cola => esperas.push(cola))
  assert.deepEqual(r.map(s => s.fecha), ['2026-10-16', '2026-10-15', '2026-10-14'])
  assert.deepEqual(r.map(s => s.velas[0].origen), ['lote', 'lote', 'lote'])
  assert.ok(esperas.length >= 1 && esperas.every(c => c.enCola >= 1))
  assert.ok(pedidas.every(p => p.startsWith('lote:')))
})

test('todo se encarga de entrada, del último trozo al primero', async () => {
  const fechas = Array.from({ length: 130 }, (_, i) => `f${String(i).padStart(3, '0')}`)
  const { encargos } = servidorFalso({ guardadas: fechas })
  const r = await todas('^GDAXI', fechas, 'm5')
  assert.equal(r.length, 130)
  // los encargos van en segundo plano: pueden acabar después que la descarga
  while (encargos.length < 3) await new Promise(res => setTimeout(res, 0))
  assert.deepEqual(encargos.map(e => [e[0], e.length]), [['f120', 10], ['f060', 60], ['f000', 60]])
})

test('las sesiones sin datos en el feed salen vacías', async () => {
  servidorFalso({ guardadas: ['2026-10-16'], sinDatos: ['2026-10-15'] })
  const r = await todas('^GDAXI', ['2026-10-16', '2026-10-15'], 'm15')
  assert.deepEqual(r.map(s => s.velas.length), [1, 0])
})

test('lo que la cola no lleva (la sesión de hoy) se pide suelto', async () => {
  const { pedidas } = servidorFalso({ guardadas: ['2026-10-20'] })
  const r = await todas('^GDAXI', ['2026-10-21', '2026-10-20'], 'm15')
  assert.deepEqual(r.map(s => s.velas[0].origen), ['suelta', 'lote'])
  assert.deepEqual(pedidas, ['lote:2026-10-21,2026-10-20', '2026-10-21'])
})

test('con un servidor sin el lote, lo pide todo suelto como antes', async () => {
  const { pedidas } = servidorFalso({ lote: '404' })
  const r = await todas('^GDAXI', ['2026-10-16', '2026-10-15'], 'm15')
  assert.deepEqual(r.map(s => s.velas[0].origen), ['suelta', 'suelta'])
  assert.deepEqual(pedidas, ['2026-10-16', '2026-10-15'])
})

test('una sesión suelta que falla queda sin velas y las demás siguen', async () => {
  servidorFalso({ lote: '404', fallan: ['2026-10-15'] })
  const r = await todas('^GDAXI', ['2026-10-16', '2026-10-15', '2026-10-14'], 'm15')
  assert.deepEqual(r.map(s => s.velas.length), [1, 0, 1])
  assert.equal(r[1].fuente, null)
})

test('los tickers sin Dukascopy no piden lote', async () => {
  const { pedidas, encargos } = servidorFalso()
  await todas('AAPL', ['2026-10-16'], 'm15')
  assert.deepEqual(pedidas, ['2026-10-16'])
  assert.deepEqual(encargos, [])
})

test('cancelar mientras se espera a la cola corta con AbortError', async () => {
  servidorFalso({ guardadas: ['2026-10-16'], tardan: { '2026-10-15': 1000 } })
  const ctrl = new AbortController()
  const vistas = []
  await assert.rejects(async () => {
    for await (const s of velasDeSesiones('^GDAXI', ['2026-10-16', '2026-10-15'], 'm15', ctrl.signal, () => ctrl.abort())) {
      vistas.push(s.fecha)
    }
  }, { name: 'AbortError' })
  assert.deepEqual(vistas, ['2026-10-16'])
})
