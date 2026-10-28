// ── Histórico de Dukascopy en CSV ─────────────────────────────────────────────
// Lo que bajan scripts/bajar-dukascopy-todo.mjs y scripts/bajar-zips-github.mjs:
// historico\<instrumento>\<AAAA-MM>.csv, velas de 1 min (bid, sin los minutos planos) de un
// mes en UTC, con time en segundos unix. Son las mismas velas que da el feed (dukascopy-node
// con sus opciones por defecto), así que un día que esté aquí no hace falta pedírselo: se
// lee del CSV y se agrupa en local al timeframe pedido, como hace dukascopy-node.
//
// Los meses salen de una carpeta con los CSV (en local) o de los zips del release
// «historico» de Sergiobit96/dukascopy-historico, uno por instrumento, sin descomprimirlos
// (en el servidor online, que los mantiene al día con server/historico-github.js).
//
// Un día solo vale si el CSV se escribió después de que acabara (el mes en curso, o uno
// bajado antes de cerrarse, trae los días hasta donde llegó y nada más). Si el día no está,
// o el CSV es de un mes sin velas, se devuelve null y quien pide sigue con el feed.

import { closeSync, openSync, readFileSync, readSync, statSync } from 'fs'
import { join } from 'path'
import { inflateRawSync } from 'zlib'

const MINUTOS_TF = { m1: 1, m5: 5, m15: 15, m30: 30, h1: 60 }
// margen tras el final del día para dar el fichero por completo (Dukascopy publica con retraso)
const MARGEN_MS = 60 * 60_000
// meses leídos que se guardan en memoria; un mes de 1 min son unas 30.000 velas
const MESES_EN_MEMORIA = 24

// Las velas de 1 min de un CSV del histórico (con BOM y valores entre comillas)
export function parsearMes(texto) {
  const lineas = texto.replace(/^﻿/, '').split(/\r?\n/)
  const velas = []
  for (let i = 1; i < lineas.length; i++) {
    if (!lineas[i]) continue
    const c = lineas[i].split(',').map(x => x.replace(/^"|"$/g, ''))
    const time = Number(c[0])
    if (!Number.isFinite(time)) continue
    velas.push({ time, open: +c[2], high: +c[3], low: +c[4], close: +c[5], volume: c[6] === '' ? 0 : +c[6] })
  }
  return velas
}

// Agrupa velas de 1 min en las de `minutos`, en tramos alineados con la época (00:00 UTC),
// que es como las arma dukascopy-node
export function agruparMinutos(velas, minutos) {
  if (minutos === 1) return velas
  const paso = minutos * 60
  const out = []
  let actual = null
  for (const v of velas) {
    const t = Math.floor(v.time / paso) * paso
    if (actual?.time !== t) {
      actual = { time: t, open: v.open, high: v.high, low: v.low, close: v.close, volume: v.volume }
      out.push(actual)
    } else {
      actual.high = Math.max(actual.high, v.high)
      actual.low = Math.min(actual.low, v.low)
      actual.close = v.close
      actual.volume += v.volume
    }
  }
  return out
}

// ── De dónde salen los meses ──
// Una fuente da, para un instrumento y un mes (AAAA-MM), { id, mtimeMs, size, leer() } o null

// historico\<instrumento>\<AAAA-MM>.csv
export function fuenteCarpeta(dir) {
  return (instrument, mes) => {
    const ruta = join(dir, instrument, `${mes}.csv`)
    try {
      const st = statSync(ruta)
      return { id: ruta, mtimeMs: st.mtimeMs, size: st.size, leer: () => readFileSync(ruta, 'utf8') }
    } catch {
      return null
    }
  }
}

// El índice de un .zip (su directorio central): nombre → dónde está y cómo va comprimido.
// Solo lo que hace falta para los zips de `zip -r` (sin zip64: ni ficheros de 4 GB ni 65.535
// entradas). La fecha es la del campo extendido de Info-ZIP (segundos unix); si no viene,
// la de MS-DOS leída como UTC, que es la hora de los runners de Actions donde se hacen.
export function leerIndiceZip(ruta) {
  const fd = openSync(ruta, 'r')
  try {
    const tam = statSync(ruta).size
    const cola = Buffer.alloc(Math.min(tam, 65_557))
    readSync(fd, cola, 0, cola.length, tam - cola.length)
    let eocd = -1
    for (let i = cola.length - 22; i >= 0; i--) if (cola.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
    if (eocd < 0) throw new Error('no es un zip')
    const n = cola.readUInt16LE(eocd + 10), tamDir = cola.readUInt32LE(eocd + 12), iniDir = cola.readUInt32LE(eocd + 16)
    const dir = Buffer.alloc(tamDir)
    readSync(fd, dir, 0, tamDir, iniDir)
    const indice = new Map()
    for (let p = 0, k = 0; k < n; k++) {
      if (dir.readUInt32LE(p) !== 0x02014b50) throw new Error('directorio del zip roto')
      const metodo = dir.readUInt16LE(p + 10), hora = dir.readUInt16LE(p + 12), fecha = dir.readUInt16LE(p + 14)
      const comprimido = dir.readUInt32LE(p + 20), tamano = dir.readUInt32LE(p + 24)
      const lNombre = dir.readUInt16LE(p + 28), lExtra = dir.readUInt16LE(p + 30), lComent = dir.readUInt16LE(p + 32)
      const offset = dir.readUInt32LE(p + 42)
      const nombre = dir.toString('utf8', p + 46, p + 46 + lNombre)
      let mtimeMs = Date.UTC(1980 + (fecha >> 9), ((fecha >> 5) & 15) - 1, fecha & 31, hora >> 11, (hora >> 5) & 63, (hora & 31) * 2)
      for (let e = p + 46 + lNombre, fin = e + lExtra; e + 4 <= fin;) {
        const id = dir.readUInt16LE(e), l = dir.readUInt16LE(e + 2)
        if (id === 0x5455 && l >= 5 && (dir[e + 4] & 1)) mtimeMs = dir.readUInt32LE(e + 5) * 1000
        e += 4 + l
      }
      indice.set(nombre, { metodo, comprimido, tamano, offset, mtimeMs })
      p += 46 + lNombre + lExtra + lComent
    }
    return indice
  } finally {
    closeSync(fd)
  }
}

export function leerEntradaZip(ruta, e) {
  const fd = openSync(ruta, 'r')
  try {
    const cab = Buffer.alloc(30)
    readSync(fd, cab, 0, 30, e.offset)
    if (cab.readUInt32LE(0) !== 0x04034b50) throw new Error('entrada del zip rota')
    const datos = Buffer.alloc(e.comprimido)
    readSync(fd, datos, 0, e.comprimido, e.offset + 30 + cab.readUInt16LE(26) + cab.readUInt16LE(28))
    if (e.metodo === 0) return datos
    if (e.metodo === 8) return inflateRawSync(datos)
    throw new Error(`compresión ${e.metodo} no soportada`)
  } finally {
    closeSync(fd)
  }
}

// <dir>\<instrumento>.zip, con <instrumento>/<AAAA-MM>.csv dentro
export function fuenteZips(dir) {
  const indices = new Map()   // ruta → { mtime, indice }
  return (instrument, mes) => {
    const ruta = join(dir, `${instrument}.zip`)
    try {
      const mtime = statSync(ruta).mtimeMs
      let visto = indices.get(ruta)
      if (visto?.mtime !== mtime) indices.set(ruta, visto = { mtime, indice: leerIndiceZip(ruta) })
      const e = visto.indice.get(`${instrument}/${mes}.csv`)
      if (!e) return null
      return {
        id: `${ruta}|${mes}|${mtime}`, mtimeMs: e.mtimeMs, size: e.tamano,
        leer: () => leerEntradaZip(ruta, e).toString('utf8'),
      }
    } catch {
      return null
    }
  }
}

// `fuente`: una carpeta con los CSV (texto) o una de las fuentes de arriba; null, nada
export function crearHistoricoDukascopy(fuente) {
  const mesDe = typeof fuente === 'string' ? fuenteCarpeta(fuente) : fuente
  const meses = new Map()   // id → velas

  function leerMes(m) {
    const visto = meses.get(m.id)
    if (visto) {
      meses.delete(m.id); meses.set(m.id, visto)   // al final: el más reciente
      return visto
    }
    const velas = parsearMes(m.leer())
    meses.set(m.id, velas)
    while (meses.size > MESES_EN_MEMORIA) meses.delete(meses.keys().next().value)
    return velas
  }

  // Las velas de `date` (AAAA-MM-DD, día UTC) en el timeframe `tf`, o null si no están
  return function velasDelHistorico(instrument, date, tf) {
    const minutos = MINUTOS_TF[tf]
    if (!mesDe || !minutos || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
    const m = mesDe(instrument.toLowerCase(), date.slice(0, 7))
    const desde = Date.parse(`${date}T00:00:00Z`) / 1000
    const hasta = desde + 86400
    if (!m || m.size === 0 || m.mtimeMs < hasta * 1000 + MARGEN_MS) return null
    let velas
    try { velas = leerMes(m) } catch { return null }
    // búsqueda binaria del primer minuto del día: el mes viene ordenado
    let lo = 0, hi = velas.length
    while (lo < hi) { const k = (lo + hi) >> 1; if (velas[k].time < desde) lo = k + 1; else hi = k }
    let fin = lo
    while (fin < velas.length && velas[fin].time < hasta) fin++
    if (fin === lo) return null
    // descargarVelasDukascopy le pide al feed hasta las 23:59: quedan fuera las velas que
    // empiezan a esa hora o después, pero la última agrupada sí lleva ese minuto dentro
    return agruparMinutos(velas.slice(lo, fin), minutos).filter(v => v.time < hasta - 60)
  }
}
