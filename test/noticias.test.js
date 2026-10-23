// Tests de las noticias de alto impacto (server/noticias.js) y del riesgo correlacionado entre
// bots (server/cartera.js)
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { crearNoticias, parsearFf, monedasDe } from '../server/noticias.js'
import { crearCartera, exposicionDe, riesgoHastaStop } from '../server/cartera.js'
import { GRUPOS_TORTUGAS } from '../server/bot-tortugas.js'

const FF = [
  { title: 'Non-Farm Employment Change', country: 'USD', date: '2026-10-02T08:30:00-04:00', impact: 'High' },
  { title: 'German ifo', country: 'EUR', date: '2026-10-02T04:00:00-04:00', impact: 'Medium' },
  { title: 'CPI y/y', country: 'JPY', date: '2026-10-02T19:30:00-04:00', impact: 'High' },
]
const nfp = Date.parse('2026-10-02T12:30:00Z') / 1000

test('del calendario de ForexFactory solo cuentan las de alto impacto', () => {
  assert.deepEqual(parsearFf(FF).map(e => e.moneda), ['USD', 'JPY'])
  assert.equal(parsearFf(FF)[0].t, nfp)
  assert.deepEqual(parsearFf(null), [])
})

test('cada mercado mira su divisa y el dólar', () => {
  assert.deepEqual(monedasDe('^GDAXI'), ['EUR', 'USD'])
  assert.deepEqual(monedasDe('^NDX'), ['USD'])
  assert.deepEqual(monedasDe('USDJPY'), ['USD', 'JPY'])
  assert.deepEqual(monedasDe('EURUSD'), ['EUR', 'USD'])
  assert.deepEqual(monedasDe('XAUUSD'), ['USD'])
  assert.deepEqual(monedasDe('COFFEE'), ['USD'])
})

test('tapa las entradas de X minutos antes a X después, guarda lo leído y sigue con ello si ForexFactory no contesta', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'noticias-'))
  const archivo = join(dir, 'noticias.json')
  let ahora = nfp - 3600
  const fetchFn = async url => ({ ok: true, json: async () => (url.includes('thisweek') ? FF : []) })
  try {
    const n = crearNoticias({ archivo, fetchFn, log: () => {}, ahora: () => ahora })
    assert.equal(await n.actualizar(), true)
    assert.equal(n.bloqueo('^NDX', nfp - 16 * 60, 15), null)
    const b = n.bloqueo('^NDX', nfp - 15 * 60, 15)
    assert.equal(b.hasta, nfp + 15 * 60)
    assert.match(b.texto, /^USD Non-Farm Employment Change a las 14:30$/)
    assert.ok(n.bloqueo('^GDAXI', nfp + 14 * 60, 15), 'el dólar mueve también el DAX')
    assert.equal(n.bloqueo('^NDX', nfp + 15 * 60, 15), null)
    assert.equal(n.bloqueo('^NDX', nfp, null), null, 'sin margen no mira las noticias')
    assert.equal(n.bloqueo('^GDAXI', Date.parse('2026-10-02T08:00:00Z') / 1000, 15), null, 'la de impacto medio no cuenta')

    // otro arranque sin red: lo de la última vez
    const sinRed = crearNoticias({ archivo, fetchFn: async () => { throw new Error('sin red') }, log: () => {}, ahora: () => ahora })
    assert.equal(await sinRed.actualizar(), false)
    assert.ok(sinRed.bloqueo('^NDX', nfp, 15))
    assert.equal(sinRed.estado().error, 'sin red')
    // y lo viejo se olvida
    ahora = nfp + 4 * 86400
    await n.actualizar()
    assert.equal(n.bloqueo('^NDX', nfp, 15), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('las divisas cuentan como dólar comprado o vendido', () => {
  assert.deepEqual(exposicionDe('EURUSD', 'largo', GRUPOS_TORTUGAS), { grupo: 'Dólar', lado: 'corto' })
  assert.deepEqual(exposicionDe('USDJPY', 'largo', GRUPOS_TORTUGAS), { grupo: 'Dólar', lado: 'largo' })
  assert.deepEqual(exposicionDe('^NDX', 'corto', GRUPOS_TORTUGAS), { grupo: 'EEUU', lado: 'corto' })
})

test('el riesgo de una posición es lo que queda hasta el stop de cada unidad, y 0 si ya está en ganancias', () => {
  const unidades = [{ entrada: 100, tamano: 2, stop: 90 }, { entrada: 110, tamano: 1, stop: 90 }, { entrada: 80, tamano: 1, stop: 70, salida: {} }]
  assert.equal(riesgoHastaStop({ lado: 'largo', unidades, valorPunto: 2, cambioAEur: 0.5 }), (10 * 2 + 20) * 2 * 0.5)
  assert.equal(riesgoHastaStop({ lado: 'largo', unidades: [{ entrada: 100, tamano: 1, stop: 105 }] }), 0)
  assert.equal(riesgoHastaStop({ lado: 'corto', unidades: [{ entrada: 100, tamano: 1 }], stop: 104 }), 4)
})

test('el tope junta los bots por grupo y sentido; con EUR/USD comprado y USD/JPY vendido, es el mismo dólar vendido', () => {
  const cartera = crearCartera({ grupos: GRUPOS_TORTUGAS, maxPct: 2 })
  cartera.registrar('Tortugas', () => [{ ticker: 'EURUSD', lado: 'largo', riesgoEur: 300 }])
  cartera.registrar('Roto', () => { throw new Error('no cuenta') })
  assert.match(cartera.noCabe({ ticker: 'USDJPY', lado: 'corto', riesgoEur: 150, saldo: 20000 }), /dólar vendido ya hay 300 € en riesgo \(Tortugas\) y con esta serían 450 €, más del 2% del saldo \(400 €\)/)
  assert.equal(cartera.noCabe({ ticker: 'USDJPY', lado: 'largo', riesgoEur: 150, saldo: 20000 }), null)
  assert.equal(cartera.noCabe({ ticker: 'USDJPY', lado: 'corto', riesgoEur: 100, saldo: 20000 }), null, 'justo en el tope cabe')
  assert.equal(cartera.noCabe({ ticker: 'USDJPY', lado: 'corto', riesgoEur: 150, saldo: null }), null, 'sin saldo no frena')
})
