// ── Diario de las acciones del S&P 500, para las tortugas en acciones (pestaña Estrategias) ──
// El universo es server/sp500.json (lo saca de Wikipedia scripts/sp500.mjs): ticker, nombre,
// sector y fecha en que entró en el índice. De cada acción se baja de Yahoo todo su diario
// desde 1985 en una sola petición, con los dividendos (Yahoo da los precios y los dividendos
// ya ajustados por los splits, pero no por los dividendos), y se guarda en disco hasta el
// siguiente cierre de Nueva York: así, de las 503, cada día se baja cada una una vez como
// mucho, la primera vez que alguien abre el backtest. Si Yahoo falla, vale la del día anterior.
//
// Para que viajen poco (son unos 3 millones de velas), van codificadas: las fechas, como días
// desde la anterior, y los precios, en enteros (con los decimales que dejan cinco cifras en el
// mínimo de la serie) y como diferencias dentro de cada vela y con el cierre anterior. Así cada
// acción ocupa unos 50 KB comprimida. src/accionesEeuu.js las decodifica.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { gzipSync, gunzipSync } from 'zlib'
import { join } from 'path'
import { fechaEnZona, diaSemanaEnZona, instanteEnZona } from './zonas.js'

export const SP500 = JSON.parse(readFileSync(new URL('./sp500.json', import.meta.url), 'utf8'))
const POR_TICKER = new Map(SP500.acciones.map(a => [a.ticker, a]))

const ZONA = 'America/New_York'
const PRIMER_DIA = Date.UTC(1985, 0, 1) / 1000
const CIERRE_MIN = 16 * 60 + 30        // la vela del día, completa en Yahoo a las 16:30 de Nueva York
const CALENTAMIENTO_DIAS = 400         // antes de la fecha pedida: para la N, los canales y el filtro del S1
export const MAX_POR_PETICION = 40
const A_LA_VEZ = 4                     // descargas de Yahoo en paralelo
const VERSION = 2                      // la de lo guardado en disco: otra obliga a bajarlo de nuevo (la 2 trae los splits)

// En Yahoo, la clase de acción va con guion (BRK.B → BRK-B)
export const simboloYahoo = ticker => ticker.replace(/\./g, '-')
const masDias = (fecha, n) => new Date(Date.parse(`${fecha}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

// El último cierre de Nueva York (16:30, un día entre semana) antes de `t`: una serie bajada
// antes de él ya no está al día
export function ultimoCierre(t) {
  for (let d = 0; d < 8; d++) {
    const fecha = masDias(fechaEnZona(t, ZONA), -d)
    const cierre = instanteEnZona(fecha, CIERRE_MIN, ZONA)
    if (cierre <= t && ![0, 6].includes(diaSemanaEnZona(cierre, ZONA))) return cierre
  }
  return t
}

// ── Codificación ──
// `velas`: [{ date, open, high, low, close, div?, split? }] en orden. Devuelve { f0, dd, dec,
// p, div, sp }: la primera fecha, los días entre cada una y la anterior, los decimales, cuatro
// enteros por vela (apertura − cierre anterior, máximo − el mayor de apertura y cierre, el
// menor de los dos − mínimo y cierre − apertura), los dividendos como [índice, importe] y los
// splits como [índice, acciones nuevas por cada vieja].
export function codificarSerie(velas) {
  if (!velas.length) return { f0: null, dd: [], dec: 2, p: [], div: [], sp: [] }
  const minimo = Math.min(...velas.map(v => v.low).filter(x => x > 0))
  const dec = Math.min(6, Math.max(2, 4 - Math.floor(Math.log10(Number.isFinite(minimo) ? minimo : 1))))
  const f = 10 ** dec
  const dd = [], p = [], div = [], sp = []
  let cierre = 0
  velas.forEach((v, i) => {
    if (i) dd.push(Math.round((Date.parse(v.date) - Date.parse(velas[i - 1].date)) / 86_400_000))
    const o = Math.round(v.open * f), h = Math.round(v.high * f), l = Math.round(v.low * f), c = Math.round(v.close * f)
    p.push(o - cierre, h - Math.max(o, c), Math.min(o, c) - l, c - o)
    cierre = c
    if (v.div) div.push([i, v.div])
    if (v.split) sp.push([i, v.split])
  })
  return { f0: velas[0].date, dd, dec, p, div, sp }
}

export function decodificarSerie({ f0, dd, dec, p, div, sp }) {
  const f = 10 ** dec
  const velas = []
  let fecha = f0, cierre = 0
  for (let i = 0; 4 * i < p.length; i++) {
    if (i) fecha = masDias(fecha, dd[i - 1])
    const o = cierre + p[4 * i], c = o + p[4 * i + 3]
    velas.push({ date: fecha, open: o / f, high: (Math.max(o, c) + p[4 * i + 1]) / f, low: (Math.min(o, c) - p[4 * i + 2]) / f, close: c / f })
    cierre = c
  }
  for (const [i, importe] of div ?? []) if (velas[i]) velas[i].div = importe
  for (const [i, x] of sp ?? []) if (velas[i]) velas[i].split = x
  return velas
}

// La respuesta de Yahoo (chart v8 con events=div|split) en velas con la fecha de Nueva York,
// sin la del día en curso si la sesión no ha cerrado. El dividendo y el split van en la vela
// del día que cotiza sin él (o en la siguiente, si ese día no hay vela).
export function velasDeYahoo(r, ahora) {
  const ts = r?.timestamp ?? []
  const q = r?.indicators?.quote?.[0] ?? {}
  const hoy = fechaEnZona(ahora, ZONA)
  const sinCerrar = ahora < instanteEnZona(hoy, CIERRE_MIN, ZONA)
  const velas = []
  for (let i = 0; i < ts.length; i++) {
    const [open, high, low, close] = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]]
    if ([open, high, low, close].some(x => x == null || !Number.isFinite(x))) continue
    const date = fechaEnZona(ts[i], ZONA)
    if (date === velas.at(-1)?.date || (date >= hoy && sinCerrar)) continue
    velas.push({ date, open, high, low, close })
  }
  const velaDel = t => {
    const fecha = fechaEnZona(t, ZONA)
    let lo = 0, hi = velas.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (velas[mid].date < fecha) lo = mid + 1; else hi = mid }
    return velas[lo]
  }
  for (const d of Object.values(r?.events?.dividends ?? {})) {
    const v = d.amount > 0 ? velaDel(d.date) : null
    if (v) v.div = (v.div ?? 0) + d.amount
  }
  for (const s of Object.values(r?.events?.splits ?? {})) {
    const v = s.numerator > 0 && s.denominator > 0 ? velaDel(s.date) : null
    if (v) v.split = (v.split ?? 1) * s.numerator / s.denominator
  }
  return velas
}

// La serie codificada desde `desde` (YYYY-MM-DD), con el calentamiento por delante, sin
// decodificarla: se suman los cierres de lo que se quita para que la primera apertura que
// queda vuelva a ser absoluta
export function recortarSerie(s, desde) {
  const lim = Date.parse(`${masDias(desde, -CALENTAMIENTO_DIAS)}T00:00:00Z`)
  if (!s.f0 || Date.parse(`${s.f0}T00:00:00Z`) >= lim) return s
  const n = s.p.length / 4
  let fecha = Date.parse(`${s.f0}T00:00:00Z`), k = 0, cierre = 0
  while (k < n - 1 && fecha < lim) {
    cierre += s.p[4 * k] + s.p[4 * k + 3]
    fecha += s.dd[k] * 86_400_000
    k++
  }
  if (fecha < lim) return { f0: null, dd: [], dec: s.dec, p: [], div: [], sp: [] }
  const p = s.p.slice(4 * k)
  p[0] += cierre
  const desplazar = xs => (xs ?? []).filter(([i]) => i >= k).map(([i, x]) => [i - k, x])
  return { f0: new Date(fecha).toISOString().slice(0, 10), dd: s.dd.slice(k), dec: s.dec, p, div: desplazar(s.div), sp: desplazar(s.sp) }
}

const ultimaFecha = s => (s.f0 ? new Date(Date.parse(`${s.f0}T00:00:00Z`) + s.dd.reduce((a, d) => a + d, 0) * 86_400_000).toISOString().slice(0, 10) : null)

// ── Descarga y caché ──
// `pedirYahoo(url)` hace la petición con la cookie y el crumb de Yahoo y devuelve el JSON
export function crearAccionesEeuu({ dir, pedirYahoo, ahora = () => Math.floor(Date.now() / 1000), log = console.log }) {
  try { mkdirSync(dir, { recursive: true }) } catch { /* no crítico */ }
  const archivo = ticker => join(dir, `${simboloYahoo(ticker)}.json.gz`)
  const enCurso = new Map()
  let activas = 0
  const esperando = []
  const turno = () => (activas < A_LA_VEZ ? (activas++, Promise.resolve()) : new Promise(r => esperando.push(r)))
  const soltar = () => { const sig = esperando.shift(); if (sig) sig(); else activas-- }

  function leer(ticker) {
    try { return JSON.parse(gunzipSync(readFileSync(archivo(ticker))).toString()) } catch { return null }
  }

  async function bajar(ticker) {
    await turno()
    try {
      const t = ahora()
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(simboloYahoo(ticker))}?interval=1d&period1=${PRIMER_DIA}&period2=${t}&events=div%7Csplit`
      let json
      for (let intento = 0; ; intento++) {
        try { json = await pedirYahoo(url); break } catch (err) {
          // si Yahoo limita, se espera un poco y se repite
          if (intento >= 2 || !/429|Too Many/i.test(err.message)) throw err
          await new Promise(r => setTimeout(r, 3000 * (intento + 1)))
        }
      }
      const r = json?.chart?.result?.[0]
      if (!r) throw new Error(json?.chart?.error?.description ?? 'Yahoo no da la serie')
      const velas = velasDeYahoo(r, t)
      if (velas.length < 2) throw new Error('Yahoo no da velas')
      const guardado = { version: VERSION, ticker, descargado: t, serie: codificarSerie(velas) }
      try {
        writeFileSync(`${archivo(ticker)}.tmp`, gzipSync(JSON.stringify(guardado)))
        renameSync(`${archivo(ticker)}.tmp`, archivo(ticker))
      } catch (err) { log(`[acciones] no se ha podido guardar ${ticker}: ${err.message}`) }
      return guardado
    } finally { soltar() }
  }

  // La serie de una acción: la del disco si se bajó después del último cierre; si no, de
  // Yahoo (y si Yahoo falla, la del disco aunque sea vieja, avisando)
  async function serie(ticker) {
    const visto = leer(ticker)
    if (visto?.version === VERSION && visto.descargado >= ultimoCierre(ahora())) return visto
    if (!enCurso.has(ticker)) enCurso.set(ticker, bajar(ticker).finally(() => enCurso.delete(ticker)))
    try {
      return await enCurso.get(ticker)
    } catch (err) {
      if (!visto) throw err
      return { ...visto, aviso: `Yahoo: ${err.message}; datos hasta el ${ultimaFecha(visto.serie)}` }
    }
  }

  // Las series de varias acciones, desde `desde` (o, con `soloAlta`, desde que entraron en el
  // índice si fue después) con el calentamiento por delante, codificadas
  async function series(tickers, { desde = '1990-01-01', soloAlta = false } = {}) {
    const desconocidos = tickers.filter(t => !POR_TICKER.has(t))
    if (desconocidos.length) throw new Error(`No están en el S&P 500: ${desconocidos.join(', ')}`)
    const salida = [], fallos = [], avisos = []
    await Promise.all(tickers.map(async ticker => {
      try {
        const s = await serie(ticker)
        const alta = POR_TICKER.get(ticker).alta
        const inicio = soloAlta && alta && alta > desde ? alta : desde
        salida.push({ ticker, ...recortarSerie(s.serie, inicio) })
        if (s.aviso) avisos.push(`${ticker}: ${s.aviso}`)
      } catch (err) { fallos.push({ ticker, error: err.message }) }
    }))
    const orden = new Map(tickers.map((t, k) => [t, k]))
    salida.sort((a, b) => orden.get(a.ticker) - orden.get(b.ticker))
    return { series: salida, fallos, avisos }
  }

  return { series, universo: () => SP500 }
}
