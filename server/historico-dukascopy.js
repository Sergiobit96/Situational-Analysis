// ── Histórico de Dukascopy en CSV ─────────────────────────────────────────────
// Lo que bajan scripts/bajar-dukascopy-todo.mjs y scripts/bajar-zips-github.mjs:
// historico\<instrumento>\<AAAA-MM>.csv, velas de 1 min (bid, sin los minutos planos) de un
// mes en UTC, con time en segundos unix. Son las mismas velas que da el feed (dukascopy-node
// con sus opciones por defecto), así que un día que esté aquí no hace falta pedírselo: se
// lee del CSV y se agrupa en local al timeframe pedido, como hace dukascopy-node.
//
// Un día solo vale si el CSV se escribió después de que acabara (el mes en curso, o uno
// bajado antes de cerrarse, trae los días hasta donde llegó y nada más). Si el día no está,
// o el CSV es de un mes sin velas, se devuelve null y quien pide sigue con el feed.

import { readFileSync, statSync } from 'fs'
import { join } from 'path'

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

export function crearHistoricoDukascopy(dir) {
  const meses = new Map()   // ruta → { mtime, velas }

  function leerMes(ruta, mtime) {
    const visto = meses.get(ruta)
    if (visto?.mtime === mtime) {
      meses.delete(ruta); meses.set(ruta, visto)   // al final: el más reciente
      return visto.velas
    }
    const velas = parsearMes(readFileSync(ruta, 'utf8'))
    meses.set(ruta, { mtime, velas })
    while (meses.size > MESES_EN_MEMORIA) meses.delete(meses.keys().next().value)
    return velas
  }

  // Las velas de `date` (AAAA-MM-DD, día UTC) en el timeframe `tf`, o null si no están
  return function velasDelHistorico(instrument, date, tf) {
    const minutos = MINUTOS_TF[tf]
    if (!dir || !minutos || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
    const ruta = join(dir, instrument.toLowerCase(), `${date.slice(0, 7)}.csv`)
    let st
    try { st = statSync(ruta) } catch { return null }
    const desde = Date.parse(`${date}T00:00:00Z`) / 1000
    const hasta = desde + 86400
    if (st.size === 0 || st.mtimeMs < hasta * 1000 + MARGEN_MS) return null
    let velas
    try { velas = leerMes(ruta, st.mtimeMs) } catch { return null }
    // búsqueda binaria del primer minuto del día: el mes viene ordenado
    let lo = 0, hi = velas.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (velas[m].time < desde) lo = m + 1; else hi = m }
    let fin = lo
    while (fin < velas.length && velas[fin].time < hasta) fin++
    if (fin === lo) return null
    // descargarVelasDukascopy le pide al feed hasta las 23:59: quedan fuera las velas que
    // empiezan a esa hora o después, pero la última agrupada sí lleva ese minuto dentro
    return agruparMinutos(velas.slice(lo, fin), minutos).filter(v => v.time < hasta - 60)
  }
}
