// Añade a los diarios de Stooq de Documents\Stooq los días que les faltan. Stooq no deja bajar sus
// CSV con un programa (pide una prueba de JavaScript al navegador), así que la historia es la que
// se bajó a mano y los días nuevos salen de otro sitio:
//   · nasdaq_d.csv es el NDX de contado, igual que el de Yahoo: los días nuevos, del diario de Yahoo.
//   · Los otros cinco son cotizaciones de casi 24 h tipo CFD: los días nuevos, de los CFD de
//     Dukascopy, con las velas de 1 h juntadas por día de Madrid (como el diario del gráfico). No
//     son el mismo precio que el de Stooq, pero sí la misma clase de vela, con el hueco de la noche.
// Solo días enteros (hasta ayer). Si Dukascopy limita (429) o falla, ese índice se queda como
// estaba y se completa en la siguiente pasada. Lo que añade lo apunta en actualizar-stooq.log.
//
// Lo llama scripts/subir-yahoo.mjs antes de subir los ficheros (la tarea "Recoger Yahoo 1min",
// cada mañana), y se puede lanzar solo: node scripts/actualizar-stooq.mjs
// STOOQ_DIR cambia la carpeta.

import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { getHistoricalRates } from 'dukascopy-node'
import { instalarTransporteDukascopy, dukascopyLimitando } from '../server/dukascopy-transport.js'

const DIR = process.env.STOOQ_DIR || 'C:\\Users\\Sergio\\Documents\\Stooq'

// fichero de Stooq → de dónde salen sus días nuevos
const FUENTES = {
  '^jp':   { dukascopy: 'jpnidxjpy' },
  '^dax':  { dukascopy: 'deuidxeur' },
  '^uklc': { dukascopy: 'gbridxgbp' },
  '^sp':   { dukascopy: 'usa500idxusd' },
  '^dow':  { dukascopy: 'usa30idxusd' },
  nasdaq:  { yahoo: '^NDX', zona: 'America/New_York' },
}

const fechaEn = (zona, ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: zona })

// Las de 1 h de Dukascopy, por día de Madrid. El fin de semana no es un día: lo poco que cotice
// el domingo por la noche va al lunes, como en un diario de lunes a viernes.
function porDiaMadrid(horas) {
  const dias = new Map()
  for (const h of horas) {
    let fecha = fechaEn('Europe/Madrid', h.timestamp)
    const dia = new Date(`${fecha}T12:00:00Z`).getUTCDay()
    if (dia === 0 || dia === 6) fecha = new Date(Date.parse(`${fecha}T12:00:00Z`) + (dia === 6 ? 2 : 1) * 86400_000).toISOString().slice(0, 10)
    const d = dias.get(fecha)
    if (!d) dias.set(fecha, { date: fecha, open: h.open, high: h.high, low: h.low, close: h.close, horas: 1 })
    else { d.high = Math.max(d.high, h.high); d.low = Math.min(d.low, h.low); d.close = h.close; d.horas++ }
  }
  return [...dias.values()]
}

// Con un 429, dukascopy-node no falla: devuelve lo que llegó, con horas de menos, y el máximo,
// el mínimo o el cierre del día saldrían mal. Así que lo bajado mientras Dukascopy limitaba se
// tira. Un día con muy pocas horas es un festivo en que el CFD casi no abrió (Stooq no lo trae): fuera.
const HORAS_MIN = 6
async function diasDukascopy(instrument, desde, hasta) {
  const inicio = Date.now()
  const horas = await getHistoricalRates({
    instrument, timeframe: 'h1', format: 'json', priceType: 'bid',
    dates: { from: new Date(`${desde}T00:00:00Z`), to: new Date(Date.parse(`${hasta}T00:00:00Z`) + 2 * 86400_000) },
    ignoreFlats: true,
  })
  if (dukascopyLimitando(Date.now() - inicio + 1000)) throw new Error('Dukascopy limita las peticiones (429): se completa en la siguiente pasada')
  return porDiaMadrid(horas).filter(d => d.date >= desde && d.date <= hasta && d.horas >= HORAS_MIN)
}

async function diasYahoo(simbolo, desde, hasta) {
  const q = new URLSearchParams({ period1: String(Date.parse(`${desde}T00:00:00Z`) / 1000 - 5 * 86400), period2: String(Math.floor(Date.now() / 1000)), interval: '1d' })
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(simbolo)}?${q}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60_000),
  })
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`)
  const res = (await r.json()).chart.result[0]
  const c = res.indicators.quote[0]
  const zona = res.meta.exchangeTimezoneName
  return res.timestamp.map((t, i) => ({ date: fechaEn(zona, t * 1000), open: c.open[i], high: c.high[i], low: c.low[i], close: c.close[i] }))
    .filter(d => [d.open, d.high, d.low, d.close].every(Number.isFinite) && d.date >= desde && d.date <= hasta)
}

const redondear = (x, ref) => {
  const dec = (ref.split('.')[1] ?? '').length || 2
  return String(+x.toFixed(Math.max(dec, 1)))
}

export async function actualizarStooq({ apuntar = console.log } = {}) {
  instalarTransporteDukascopy()
  let anadidos = 0
  for (const [fichero, fuente] of Object.entries(FUENTES)) {
    const ruta = join(DIR, `${fichero}_d.csv`)
    try {
      const texto = readFileSync(ruta, 'utf8')
      const lineas = texto.trimEnd().split(/\r?\n/)
      const ultima = lineas.at(-1).split(',')
      const desde = new Date(Date.parse(`${ultima[0]}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10)
      // hasta ayer en la zona de la fuente: el día de hoy aún no está cerrado
      const hoy = fechaEn(fuente.zona ?? 'Europe/Madrid', Date.now())
      const hasta = new Date(Date.parse(`${hoy}T12:00:00Z`) - 86400_000).toISOString().slice(0, 10)
      if (desde > hasta) continue
      const dias = fuente.yahoo ? await diasYahoo(fuente.yahoo, desde, hasta) : await diasDukascopy(fuente.dukascopy, desde, hasta)
      if (!dias.length) { apuntar(`stooq/${fichero}: sin días nuevos de ${fuente.yahoo ? 'Yahoo' : 'Dukascopy'} (${desde} a ${hasta})`); continue }
      const nuevas = dias.map(d => [d.date, ...[d.open, d.high, d.low, d.close].map((x, i) => redondear(x, ultima[i + 1]))].join(','))
      const salto = texto.includes('\r\n') ? '\r\n' : '\n'
      writeFileSync(`${ruta}.tmp`, [...lineas, ...nuevas].join(salto) + salto)
      renameSync(`${ruta}.tmp`, ruta)
      anadidos += nuevas.length
      apuntar(`stooq/${fichero}: ${nuevas.length} días de ${fuente.yahoo ? `Yahoo ${fuente.yahoo}` : `Dukascopy ${fuente.dukascopy}`} (${dias[0].date} a ${dias.at(-1).date})`)
    } catch (err) {
      apuntar(`stooq/${fichero}: ${err.message}`)
    }
  }
  return anadidos
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apuntar = texto => {
    const linea = `${new Date().toISOString()} ${texto}`
    console.log(linea)
    try { appendFileSync(join(DIR, 'actualizar-stooq.log'), `${linea}\n`) } catch { /* sin log */ }
  }
  await actualizarStooq({ apuntar })
  process.exit(0)
}
