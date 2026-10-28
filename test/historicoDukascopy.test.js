import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { deflateRawSync } from 'zlib'
import { tmpdir } from 'os'
import { join } from 'path'
import { agruparMinutos, crearHistoricoDukascopy, fuenteZips, parsearMes } from '../server/historico-dukascopy.js'
import { crearSincronizacionHistorico } from '../server/historico-github.js'

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

// Un .zip mínimo como los de `zip -r`: deflate y el campo extendido de fecha de Info-ZIP
function hacerZip(entradas) {
  const locales = [], centrales = []
  let offset = 0
  for (const { nombre, texto, mtime } of entradas) {
    const datos = Buffer.from(texto), comp = deflateRawSync(datos), n = Buffer.from(nombre)
    const ut = Buffer.alloc(9); ut.writeUInt16LE(0x5455, 0); ut.writeUInt16LE(5, 2); ut[4] = 1; ut.writeUInt32LE(Math.floor(mtime / 1000), 5)
    const loc = Buffer.alloc(30); loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(8, 8)
    loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(datos.length, 22); loc.writeUInt16LE(n.length, 26)
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(8, 10)
    cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(datos.length, 24); cen.writeUInt16LE(n.length, 28)
    cen.writeUInt16LE(ut.length, 30); cen.writeUInt32LE(offset, 42)
    locales.push(loc, n, comp); centrales.push(cen, n, ut)
    offset += 30 + n.length + comp.length
  }
  const dir = Buffer.concat(centrales)
  const fin = Buffer.alloc(22); fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(entradas.length, 8)
  fin.writeUInt16LE(entradas.length, 10); fin.writeUInt32LE(dir.length, 12); fin.writeUInt32LE(offset, 16)
  return Buffer.concat([...locales, dir, fin])
}

test('lee los meses de dentro del zip del instrumento, con su fecha', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hist-zip-'))
  try {
    const despues = Date.UTC(2024, 1, 1, 6)
    writeFileSync(join(dir, 'deuidxeur.zip'), hacerZip([
      { nombre: 'deuidxeur/2023-12.csv', texto: 'x', mtime: despues },
      { nombre: 'deuidxeur/2024-01.csv', texto: CSV, mtime: despues },
    ]))
    const fuente = fuenteZips(dir)
    assert.equal(fuente('deuidxeur', '2024-01').leer(), CSV)
    assert.equal(fuente('deuidxeur', '2024-01').mtimeMs, despues)
    assert.equal(fuente('deuidxeur', '2024-02'), null)
    assert.equal(fuente('gbridxgbp', '2024-01'), null)
    const h = crearHistoricoDukascopy(fuente)
    assert.equal(h('deuidxeur', '2024-01-15', 'm1').length, 4)
    assert.equal(h('deuidxeur', '2024-01-15', 'm15').at(-1).close, 24)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('la sincronización baja los zips que han cambiado y no los que no', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hist-sync-'))
  const original = globalThis.fetch
  const pedidos = []
  let actualizado = '2026-10-28T05:00:00Z'
  globalThis.fetch = async url => {
    pedidos.push(String(url))
    if (String(url).includes('/releases/tags/')) {
      return Response.json({ assets: [
        { name: 'deuidxeur.zip', size: 4096, updated_at: actualizado, browser_download_url: 'https://x/deuidxeur.zip' },
        { name: 'vacio.zip', size: 22, updated_at: actualizado, browser_download_url: 'https://x/vacio.zip' },
      ] })
    }
    return new Response(Buffer.alloc(4096, 7))
  }
  const silencio = { log() {}, warn() {} }
  try {
    const s = crearSincronizacionHistorico(dir, { log: silencio })
    await s.sincronizar()
    assert.equal(readFileSync(join(dir, 'deuidxeur.zip')).length, 4096)
    assert.equal(s.estado().zips.deuidxeur.actualizado, actualizado)
    assert.equal(s.estado().error, null)
    assert.ok(!pedidos.includes('https://x/vacio.zip'))

    pedidos.length = 0
    await crearSincronizacionHistorico(dir, { log: silencio }).sincronizar()   // como tras reiniciar
    assert.deepEqual(pedidos.filter(u => u.startsWith('https://x/')), [])

    actualizado = '2026-10-29T05:00:00Z'
    await s.sincronizar()
    assert.deepEqual(pedidos.filter(u => u.startsWith('https://x/')), ['https://x/deuidxeur.zip'])
  } finally {
    globalThis.fetch = original
    rmSync(dir, { recursive: true, force: true })
  }
})
