import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { agruparMinutos, crearHistoricoDukascopy, parsearMes } from '../server/historico-dukascopy.js'

const DIA = Date.parse('2024-01-15T00:00:00Z') / 1000
const fila = (t, o, h, l, c, v) => [t, 'x', o, h, l, c, v].map(x => `"${x}"`).join(',')
const CSV = '﻿' + [
  ['time', 'datetime_madrid', 'open', 'high', 'low', 'close', 'volume'].map(x => `"${x}"`).join(','),
  fila(DIA - 60, 9, 9, 9, 9, 1),             // el día anterior
  fila(DIA, 10, 12, 9, 11, 1),
  fila(DIA + 60, 11, 13, 10, 12, 2),
  fila(DIA + 300, 12, 12, 8, 9, 3),
  fila(DIA + 86400 - 120, 20, 21, 19, 20, 1),
  fila(DIA + 86400 - 60, 20, 25, 18, 24, 1),  // 23:59
].join('\r\n') + '\r\n'

function conHistorico(fn, { mtime = Date.now(), csv = CSV } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hist-duka-'))
  try {
    mkdirSync(join(dir, 'deuidxeur'))
    const ruta = join(dir, 'deuidxeur', '2024-01.csv')
    writeFileSync(ruta, csv)
    utimesSync(ruta, new Date(), new Date(mtime))
    fn(crearHistoricoDukascopy(dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('parsea el CSV con BOM y comillas', () => {
  const v = parsearMes(CSV)
  assert.equal(v.length, 6)
  assert.deepEqual(v[1], { time: DIA, open: 10, high: 12, low: 9, close: 11, volume: 1 })
})

test('agrupa en tramos alineados con la época', () => {
  const v = agruparMinutos(parsearMes(CSV).slice(1, 4), 5)
  assert.deepEqual(v.map(x => x.time), [DIA, DIA + 300])
  assert.deepEqual(v[0], { time: DIA, open: 10, high: 13, low: 9, close: 12, volume: 3 })
})

test('el día en 1 min deja fuera la vela de las 23:59, como el feed', () => {
  conHistorico(h => {
    const v = h('deuidxeur', '2024-01-15', 'm1')
    assert.equal(v.length, 4)
    assert.equal(v[0].time, DIA)
    assert.equal(v.at(-1).time, DIA + 86400 - 120)
  })
})

test('la última vela agrupada sí lleva el minuto 23:59', () => {
  conHistorico(h => {
    const ultima = h('deuidxeur', '2024-01-15', 'm15').at(-1)
    assert.equal(ultima.time, DIA + 86400 - 900)
    assert.equal(ultima.close, 24)
    assert.equal(ultima.high, 25)
  })
})

test('sin fichero, día sin velas o CSV escrito antes de acabar el día: null', () => {
  conHistorico(h => {
    assert.equal(h('deuidxeur', '2024-01-20', 'm15'), null)
    assert.equal(h('deuidxeur', '2024-02-01', 'm15'), null)
    assert.equal(h('gbridxgbp', '2024-01-15', 'm15'), null)
  })
  conHistorico(h => assert.equal(h('deuidxeur', '2024-01-15', 'm15'), null), { mtime: (DIA + 86400) * 1000 })
  conHistorico(h => assert.equal(h('deuidxeur', '2024-01-15', 'm15'), null), { csv: '' })
})

test('sin carpeta configurada no hace nada', () => {
  assert.equal(crearHistoricoDukascopy(null)('deuidxeur', '2024-01-15', 'm15'), null)
})
