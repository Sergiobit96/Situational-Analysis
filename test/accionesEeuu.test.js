// Tests del diario de las acciones del S&P 500: la codificación del servidor
// (server/acciones-eeuu.js), su decodificación en la pestaña (src/accionesEeuu.js), el recorte
// sin decodificar y lo que se saca de la respuesta de Yahoo
import test from 'node:test'
import assert from 'node:assert/strict'

import { codificarSerie, decodificarSerie as decodificarEnServidor, recortarSerie, velasDeYahoo, ultimoCierre, SP500, simboloYahoo } from '../server/acciones-eeuu.js'
import { decodificarSerie, infoAccion } from '../src/accionesEeuu.js'

const VELAS = [
  { date: '1990-01-02', open: 0.3125, high: 0.328125, low: 0.305804, close: 0.321429 },
  { date: '1990-01-03', open: 0.321429, high: 0.33, low: 0.31, close: 0.3125, div: 0.000536 },
  { date: '1990-01-08', open: 0.315, high: 0.32, low: 0.3001, close: 0.319, split: 2 },
  { date: '1990-01-09', open: 0.32, high: 0.3, low: 0.29, close: 0.295 },      // máximo por debajo del cierre: Yahoo trae cosas así
  { date: '1990-02-01', open: 5919.81982, high: 5950, low: 5900.5, close: 5920.1 },
]

test('codificar y decodificar: las mismas velas con cinco cifras en el mínimo, y los dividendos y splits', () => {
  const s = codificarSerie(VELAS)
  assert.equal(s.dec, 5)                              // el mínimo, 0,29: cinco cifras son cinco decimales
  const vuelta = decodificarEnServidor(s)
  assert.equal(vuelta.length, VELAS.length)
  VELAS.forEach((v, k) => {
    assert.equal(vuelta[k].date, v.date)
    for (const c of ['open', 'high', 'low', 'close']) assert.ok(Math.abs(vuelta[k][c] - v[c]) <= 0.5e-5 + 1e-12, `${v.date} ${c}`)
  })
  assert.equal(vuelta[1].div, 0.000536)
  assert.equal(vuelta[2].split, 2)
  // la pestaña decodifica lo mismo, y además cuántas acciones de la serie eran una de entonces
  const enPestana = decodificarSerie(s)
  const ohlc = v => ({ date: v.date, open: v.open, high: v.high, low: v.low, close: v.close, div: v.div })
  assert.deepEqual(enPestana.map(ohlc), vuelta.map(ohlc))
  assert.deepEqual(enPestana.map(v => v.f ?? 1), [2, 2, 1, 1, 1])
})

test('recortar la serie codificada da lo mismo que recortar las velas', () => {
  const muchas = Array.from({ length: 900 }, (_, k) => {
    const date = new Date(Date.UTC(2000, 0, 3) + k * 86_400_000).toISOString().slice(0, 10)
    const c = 50 + 10 * Math.sin(k / 30)
    return { date, open: c - 0.3, high: c + 1, low: c - 1, close: c, ...(k % 90 === 5 ? { div: 0.2 } : {}), ...(k === 700 ? { split: 3 } : {}) }
  })
  const s = codificarSerie(muchas)
  const recortada = recortarSerie(s, '2002-01-01')
  const esperadas = decodificarEnServidor(s).filter(v => v.date >= '2000-11-27')   // 400 días antes
  assert.equal(recortada.f0, '2000-11-27')
  assert.deepEqual(decodificarEnServidor(recortada), esperadas)
  assert.deepEqual(recortarSerie(s, '1990-01-01'), s)                            // nada que quitar
  assert.equal(recortarSerie(s, '2030-01-01').p.length, 0)                       // todo
})

// Octubre de 2026 en Nueva York (horario de verano, UTC−4); el 19 es lunes
const NY = (fecha, hhmm) => Date.parse(`${fecha}T${hhmm}:00-04:00`) / 1000

test('Yahoo: la vela del día solo cuando ha cerrado, y los dividendos y splits en la vela de su día', () => {
  const r = {
    timestamp: [NY('2026-10-15', '09:30'), NY('2026-10-16', '09:30'), NY('2026-10-19', '09:30')],
    indicators: { quote: [{ open: [10, 11, 12], high: [10.5, 11.5, 12.5], low: [9.5, 10.5, 11.5], close: [10.2, 11.2, 12.2] }] },
    events: {
      dividends: { a: { amount: 0.1, date: NY('2026-10-16', '09:30') } },
      splits: { b: { numerator: 4, denominator: 1, date: NY('2026-10-19', '09:30') } },
    },
  }
  const abierta = velasDeYahoo(r, NY('2026-10-19', '15:00'))
  assert.deepEqual(abierta.map(v => v.date), ['2026-10-15', '2026-10-16'])
  assert.equal(abierta[1].div, 0.1)
  const cerrada = velasDeYahoo(r, NY('2026-10-19', '17:00'))
  assert.deepEqual(cerrada.map(v => v.date), ['2026-10-15', '2026-10-16', '2026-10-19'])
  assert.equal(cerrada[2].split, 4)
})

test('el último cierre de Nueva York, que dice si lo guardado está al día', () => {
  assert.equal(ultimoCierre(NY('2026-10-19', '10:00')), NY('2026-10-16', '16:30'))   // el lunes por la mañana, el del viernes
  assert.equal(ultimoCierre(NY('2026-10-19', '17:00')), NY('2026-10-19', '16:30'))
  assert.equal(ultimoCierre(NY('2026-10-18', '12:00')), NY('2026-10-16', '16:30'))   // el domingo
})

test('el universo: el S&P 500 con su sector, y cómo lo llama Yahoo', () => {
  assert.ok(SP500.acciones.length >= 490)
  assert.ok(SP500.acciones.every(a => a.ticker && a.sector))
  assert.equal(simboloYahoo('BRK.B'), 'BRK-B')
  const info = infoAccion({ ticker: 'AAPL', nombre: 'Apple Inc.', sector: 'Tecnología', alta: '1982-11-30' })
  assert.deepEqual([info.id, info.grupo, info.alta, info.lote], ['AAPL', 'Tecnología', '1982-11-30', 1])
})
