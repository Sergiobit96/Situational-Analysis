// Baja velas de Dukascopy a un CSV en Documents\Dukascopy, con las mismas columnas que
// duka_deuidxeur_2014-04-30_m5.csv salvo la fecha, que va en hora de Madrid: time (unix en
// segundos), datetime_madrid (con su desfase, +01:00 o +02:00), open, high, low, close, volume (en
// millones, como lo da Dukascopy). Va mes a mes para que los rangos largos no se
// queden colgados en una sola petición; si Dukascopy limita (429) o falla, para y lo dice.
//
//   node scripts/bajar-dukascopy.mjs <instrumento> <desde> [hasta] [timeframe] [bid|ask]
//   node scripts/bajar-dukascopy.mjs deuidxeur 2014-04-30
//   node scripts/bajar-dukascopy.mjs eurusd 2020-01-01 2020-12-31 m1 ask
//
// desde y hasta son días de Madrid, hasta incluido (por defecto, el mismo día que desde);
// timeframe por defecto m5.
// DUKASCOPY_DIR cambia la carpeta.

import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getHistoricalRates } from 'dukascopy-node'
import { instalarTransporteDukascopy, dukascopyLimitando } from '../server/dukascopy-transport.js'

const DIR = process.env.DUKASCOPY_DIR || 'C:\\Users\\Sergio\\Documents\\Dukascopy'
const TIMEFRAMES = ['tick', 's1', 'm1', 'm5', 'm15', 'm30', 'h1', 'h4', 'd1', 'mn1']
const esFecha = s => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '')

const enMadrid = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})
// minutos que Madrid va por delante de UTC en ese instante (60 en invierno, 120 en verano)
const desfaseMadrid = ms => (Date.parse(enMadrid.format(ms).replace(' ', 'T') + 'Z') - Math.floor(ms / 1000) * 1000) / 60_000
// "2014-04-30T02:20:00+02:00"
function fechaMadrid(ms) {
  const min = desfaseMadrid(ms)
  return `${enMadrid.format(ms).replace(' ', 'T')}+${String(min / 60).padStart(2, '0')}:00`
}
// las 00:00 de Madrid de ese día, en ms UTC
function medianocheMadrid(fecha) {
  const utc = Date.parse(`${fecha}T00:00:00Z`)
  return utc - desfaseMadrid(utc - desfaseMadrid(utc) * 60_000) * 60_000
}

const [instrumento, desde, hastaArg, timeframe = 'm5', precio = 'bid'] = process.argv.slice(2)
const hasta = hastaArg ?? desde
if (!instrumento || !esFecha(desde) || !esFecha(hasta) || hasta < desde || !TIMEFRAMES.includes(timeframe) || !['bid', 'ask'].includes(precio)) {
  console.error('Uso: node scripts/bajar-dukascopy.mjs <instrumento> <desde AAAA-MM-DD> [hasta AAAA-MM-DD] [timeframe] [bid|ask]')
  console.error(`timeframes: ${TIMEFRAMES.join(', ')}`)
  process.exit(1)
}

// tramos de un mes natural como mucho: [inicio, fin) en ms UTC
function tramos(desdeMs, finMs) {
  const lista = []
  for (let ini = desdeMs; ini < finMs;) {
    const d = new Date(ini)
    const fin = Math.min(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1), finMs)
    lista.push([ini, fin])
    ini = fin
  }
  return lista
}

instalarTransporteDukascopy()
const desdeMs = medianocheMadrid(desde)
const finMs = medianocheMadrid(new Date(Date.parse(`${hasta}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10))
const velas = []
for (const [ini, fin] of tramos(desdeMs, finMs)) {
  const inicio = Date.now()
  let parte
  try {
    parte = await getHistoricalRates({
      instrument: instrumento.toLowerCase(), timeframe, format: 'json', priceType: precio,
      dates: { from: new Date(ini), to: new Date(fin) },
      volumes: true, ignoreFlats: true, retryCount: 3, pauseBetweenRetriesMs: 2000,
    })
  } catch (err) {
    if (!dukascopyLimitando(Date.now() - inicio + 1000)) {
      console.error(`Dukascopy falla: ${err.message}`)
      process.exit(1)
    }
  }
  if (dukascopyLimitando(Date.now() - inicio + 1000)) {
    console.error('Dukascopy limita las peticiones (429): prueba otra vez dentro de un rato')
    process.exit(1)
  }
  velas.push(...parte.filter(v => v.timestamp >= ini && v.timestamp < fin))
  console.log(`${new Date(ini).toISOString().slice(0, 7)}: ${parte.length} velas`)
}
if (!velas.length) {
  console.error(`Dukascopy no tiene velas de ${instrumento} entre ${desde} y ${hasta} (¿instrumento mal escrito o días sin mercado?)`)
  process.exit(1)
}

const comillas = v => `"${v}"`
const cabecera = timeframe === 'tick'
  ? ['time', 'datetime_madrid', 'ask', 'bid', 'ask_volume', 'bid_volume']
  : ['time', 'datetime_madrid', 'open', 'high', 'low', 'close', 'volume']
const filas = velas.map(v => {
  const t = Math.floor(v.timestamp / 1000)
  const fecha = fechaMadrid(v.timestamp)
  const valores = timeframe === 'tick'
    ? [v.askPrice, v.bidPrice, v.askVolume, v.bidVolume]
    : [v.open, v.high, v.low, v.close, v.volume]
  return [t, fecha, ...valores.map(x => x ?? '')].map(comillas).join(',')
})

mkdirSync(DIR, { recursive: true })
const nombre = `duka_${instrumento.toLowerCase()}_${desde}${hasta !== desde ? `_${hasta}` : ''}_${timeframe}${precio === 'ask' ? '_ask' : ''}.csv`
const ruta = join(DIR, nombre)
// con BOM, como el CSV de ejemplo, para que Excel lo abra en UTF-8
writeFileSync(`${ruta}.tmp`, '\uFEFF' + [cabecera.map(comillas).join(','), ...filas].join('\r\n') + '\r\n')
renameSync(`${ruta}.tmp`, ruta)
console.log(`${velas.length} velas → ${ruta}`)
