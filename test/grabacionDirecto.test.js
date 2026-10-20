// Tests de la grabación del directo (server/grabacion-directo.js) en una carpeta temporal
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  crearGrabacion, alargarTramos, tramosEnteros, cuboDesde, inicioCubo, parsearCsvGrabado, fechaMadrid,
} from '../server/grabacion-directo.js'

// 19-oct-2026, 11:00 de Madrid (9:00 UTC, horario de verano)
const T0 = Date.UTC(2026, 9, 19, 9, 0) / 1000
const vela = (time, close, extra = {}) => ({ time, open: 100, high: Math.max(100, close), low: Math.min(100, close), close, ...extra })

function grabacionDePrueba({ activos = ['^GDAXI'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'grabacion-'))
  let reloj = (T0 + 30) * 1000
  const encendidos = new Set(activos)
  const g = crearGrabacion({
    dir, tickers: () => ['^GDAXI', 'XAUUSD'], activo: t => encendidos.has(t), ahora: () => reloj, log: () => {},
  })
  return { g, dir, encendidos, en: s => { reloj = s * 1000 }, fichero: (t, fecha) => join(dir, encodeURIComponent(t), `${fecha}.csv`) }
}

test('una vela se escribe al llegar la del minuto siguiente, y la que se hace se lee de memoria', () => {
  const { g, dir, fichero } = grabacionDePrueba()
  try {
    g.anotar('^GDAXI', vela(T0, 101))
    g.anotar('^GDAXI', vela(T0, 103))
    assert.throws(() => readFileSync(fichero('^GDAXI', '2026-10-19')))
    g.anotar('^GDAXI', vela(T0 + 60, 102))
    assert.equal(readFileSync(fichero('^GDAXI', '2026-10-19'), 'utf8'), `${T0},100,103,100,103\n`)
    assert.deepEqual(g.m1Entre('^GDAXI', T0, T0 + 120).map(v => v.close), [103, 102])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('con el mercado parado, la última se escribe dos minutos después de acabar', () => {
  const { g, dir, en, fichero } = grabacionDePrueba()
  try {
    g.anotar('^GDAXI', vela(T0, 101))
    en(T0 + 60 + 100); g._paso()
    assert.throws(() => readFileSync(fichero('^GDAXI', '2026-10-19')))
    en(T0 + 60 + 120); g._paso()
    assert.equal(readFileSync(fichero('^GDAXI', '2026-10-19'), 'utf8').trim().split('\n').length, 1)
    // y no se repite
    en(T0 + 300); g._paso()
    assert.equal(readFileSync(fichero('^GDAXI', '2026-10-19'), 'utf8').trim().split('\n').length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('una corrección de un minuto ya escrito va en otra línea y al leer manda la última', () => {
  const { g, dir } = grabacionDePrueba()
  try {
    g.anotar('^GDAXI', vela(T0, 101))
    g.anotar('^GDAXI', vela(T0 + 60, 102))
    g.anotar('^GDAXI', vela(T0, 105))   // la final del minuto anterior, que llega tarde
    g.anotar('^GDAXI', vela(T0 + 120, 99))
    assert.deepEqual(g.m1Entre('^GDAXI', T0, T0 + 180).map(v => v.close), [105, 102, 99])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('cada día de Madrid va en su fichero y la página los junta', () => {
  const { g, dir, en, fichero } = grabacionDePrueba()
  try {
    const noche = Date.UTC(2026, 9, 19, 21, 59) / 1000   // 23:59 de Madrid
    g.anotar('^GDAXI', vela(noche, 101))
    g.anotar('^GDAXI', vela(noche + 60, 102))           // 00:00 del 20
    g.anotar('^GDAXI', vela(noche + 120, 103))
    en(noche + 1000); g._paso()
    assert.ok(readFileSync(fichero('^GDAXI', '2026-10-19'), 'utf8').startsWith(`${noche},`))
    assert.equal(readFileSync(fichero('^GDAXI', '2026-10-20'), 'utf8').trim().split('\n').length, 2)
    assert.deepEqual(g.m1Entre('^GDAXI', noche, noche + 180).map(v => v.close), [101, 102, 103])
    // la diaria: una por día de Madrid, rotulada a su medianoche
    const diarias = g.velas('^GDAXI', 1440, inicioCubo(noche, 1440), noche + 86400)
    assert.deepEqual(diarias.map(v => [fechaMadrid(v.time), v.close]), [['2026-10-19', 101], ['2026-10-20', 103]])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('agrupa a la temporalidad del gráfico, también con lo que está en un día ya cerrado', () => {
  const { g, dir, en } = grabacionDePrueba()
  try {
    for (let i = 0; i < 10; i++) g.anotar('^GDAXI', vela(T0 + i * 60, 100 + i))
    en(T0 + 3600); g._paso()
    const de5 = g.velas('^GDAXI', 5, T0, T0 + 600)
    assert.deepEqual(de5.map(v => [v.time, v.high, v.close]), [[T0, 104, 104], [T0 + 300, 109, 109]])
    // al día siguiente, el 19 está cerrado: la de 4 h sale de lo guardado
    en(T0 + 86400)
    const de4h = g.velas('^GDAXI', 240, inicioCubo(T0, 1440), T0 + 86400)
    assert.equal(de4h.length, 1)
    assert.equal(de4h[0].close, 109)
    // y una corrección tardía de ese día, en cuanto se escribe, no deja vieja la agrupada
    g.anotar('^GDAXI', vela(T0 + 9 * 60, 120))
    g._paso()
    assert.equal(g.velas('^GDAXI', 240, inicioCubo(T0, 1440), T0 + 86400)[0].close, 120)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('los tramos se alargan mientras el mercado está activo y un corte corto no los parte', () => {
  const { g, dir, en, encendidos } = grabacionDePrueba()
  try {
    en(T0 + 30); g._paso()
    en(T0 + 600); g._paso()
    assert.deepEqual(g.cubiertos('^GDAXI'), [[T0, Infinity]])
    assert.deepEqual(g.cubiertos('XAUUSD'), [])
    encendidos.delete('^GDAXI')
    en(T0 + 630); g._paso()
    assert.deepEqual(g.cubiertos('^GDAXI'), [[T0, T0 + 600]])
    // vuelve a los cinco minutos: el mismo tramo
    encendidos.add('^GDAXI')
    en(T0 + 900); g._paso()
    assert.deepEqual(g.cubiertos('^GDAXI'), [[T0, Infinity]])
    // otro arranque lee los tramos de disco
    const otra = crearGrabacion({ dir, tickers: () => ['^GDAXI'], activo: () => false, ahora: () => (T0 + 900) * 1000, log: () => {} })
    assert.deepEqual(otra.cubiertos('^GDAXI'), [[T0, T0 + 900]])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('un corte largo abre otro tramo', () => {
  assert.deepEqual(alargarTramos([[0, 600]], 1500, 1600), [[0, 600], [1500, 1600]])
  assert.deepEqual(alargarTramos([[0, 600]], 1000, 1600), [[0, 1600]])
})

test('los tramos se recortan a velas enteras', () => {
  const ini = T0 + 7 * 60   // 11:07 de Madrid
  assert.equal(cuboDesde(ini, 60), T0 + 3600)
  assert.equal(cuboDesde(T0, 60), T0)
  assert.deepEqual(tramosEnteros([[ini, T0 + 3 * 3600 + 120]], 60), [[T0 + 3600, T0 + 3 * 3600]])
  assert.deepEqual(tramosEnteros([[ini, Infinity]], 5), [[T0 + 600, Infinity]])
  // el que no llega a una vela entera desaparece
  assert.deepEqual(tramosEnteros([[ini, ini + 600]], 60), [])
  // la diaria: de la medianoche siguiente, también el día del cambio de hora (25 h)
  const cambio = Date.UTC(2026, 9, 25, 10) / 1000
  assert.equal(fechaMadrid(cuboDesde(cambio, 1440)), '2026-10-26')
  assert.equal(cuboDesde(cambio, 1440), Date.UTC(2026, 9, 25, 23) / 1000)
})

test('dice qué mercados tienen algo grabado', () => {
  const { g, dir } = grabacionDePrueba()
  try {
    assert.deepEqual(g.mercados(), [])
    g.anotar('^GDAXI', vela(T0, 101))
    g.anotar('^GDAXI', vela(T0 + 60, 102))
    assert.deepEqual(g.mercados(), ['^GDAXI'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('el CSV grabado se lee sin las líneas rotas', () => {
  assert.deepEqual(parsearCsvGrabado('60,1,2,0.5,1.5\nbasura\n120,1,1,1\n60,1,3,0.5,2\n'), [{ time: 60, open: 1, high: 3, low: 0.5, close: 2 }])
})

test('si no se puede escribir, lo dice una vez y sigue', () => {
  const avisos = []
  const g = crearGrabacion({ dir: join(tmpdir(), 'no-existe-\0'), tickers: () => [], activo: () => false, log: (...a) => avisos.push(a.join(' ')) })
  g.anotar('^GDAXI', vela(T0, 1))
  g.anotar('^GDAXI', vela(T0 + 60, 1))
  g.anotar('^GDAXI', vela(T0 + 120, 1))
  assert.equal(avisos.length, 1)
  assert.ok(g.resumen().error)
})
