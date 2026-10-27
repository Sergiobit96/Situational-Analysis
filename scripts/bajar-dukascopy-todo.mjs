// Baja de Dukascopy todo el histórico a 1 min (bid) de varios instrumentos, desde su primera
// vela, un CSV por mes en Documents\Dukascopy\historico\<instrumento>\<AAAA-MM>.csv, con las
// mismas columnas que scripts/bajar-dukascopy.mjs (time, datetime_madrid, open, high, low,
// close, volume).
//
// Es para dejarlo horas o días: se puede cortar y volver a lanzar, y sigue por donde iba (un
// mes con su CSV escrito después de cerrarse ya está hecho; el mes en curso se rehace siempre),
// y lanzado a diario lo mantiene al día (tarea «Actualizar Dukascopy»). Cuando Dukascopy limita
// (429) no se para: tira ese mes, que puede venir incompleto, espera y lo repite.
//
//   node scripts/bajar-dukascopy-todo.mjs                  los 15 de la lista
//   node scripts/bajar-dukascopy-todo.mjs deuidxeur xauusd solo esos
//
// DUKASCOPY_DIR cambia la carpeta base. El progreso queda también en historico\progreso.log.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getHistoricalRates, instrumentMetaData } from 'dukascopy-node'
import { instalarTransporteDukascopy, dukascopyLimitando } from '../server/dukascopy-transport.js'

const INSTRUMENTOS = [
  // índices: DAX, FTSE, Nasdaq, Dow, S&P, Russell, Nikkei
  'deuidxeur', 'gbridxgbp', 'usatechidxusd', 'usa30idxusd', 'usa500idxusd', 'ussc2000idxusd', 'jpnidxjpy',
  // oro, plata y las 6 divisas de las tortugas
  'xauusd', 'xagusd', 'eurusd', 'gbpusd', 'usdjpy', 'audusd', 'usdcad', 'usdchf',
]
const BASE = join(process.env.DUKASCOPY_DIR || 'C:\\Users\\Sergio\\Documents\\Dukascopy', 'historico')
const LOG = join(BASE, 'progreso.log')
// esperas tras un 429 o un fallo: va subiendo hasta 30 min y ahí se queda
const ESPERAS_MIN = [2, 5, 10, 20, 30]
// una pausa corta entre meses, para no ir a la máxima velocidad que deja el feed
const PAUSA_ENTRE_MESES_MS = 3_000

const enMadrid = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})
const desfaseMadrid = ms => (Date.parse(enMadrid.format(ms).replace(' ', 'T') + 'Z') - Math.floor(ms / 1000) * 1000) / 60_000
function fechaMadrid(ms) {
  const min = desfaseMadrid(ms)
  return `${enMadrid.format(ms).replace(' ', 'T')}+${String(min / 60).padStart(2, '0')}:00`
}

const dormir = ms => new Promise(res => setTimeout(res, ms))
function anotar(texto) {
  const linea = `${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}  ${texto}`
  console.log(linea)
  try { appendFileSync(LOG, linea + '\n') } catch { /* el log es solo ayuda */ }
}

// meses en UTC [inicio, fin) desde el de la primera vela hasta ahora
function meses(primeraMs, finMs) {
  const lista = []
  const d = new Date(primeraMs)
  for (let a = d.getUTCFullYear(), m = d.getUTCMonth(); Date.UTC(a, m, 1) < finMs; m++) {
    if (m === 12) { a++; m = 0 }
    lista.push([Math.max(Date.UTC(a, m, 1), primeraMs), Math.min(Date.UTC(a, m + 1, 1), finMs), `${a}-${String(m + 1).padStart(2, '0')}`])
  }
  return lista
}

// Un mes entero; null si Dukascopy limitó o falló por el camino (el mes no vale)
async function bajarMes(instrumento, ini, fin) {
  const inicio = Date.now()
  try {
    const velas = await getHistoricalRates({
      instrument: instrumento, timeframe: 'm1', format: 'json', priceType: 'bid',
      dates: { from: new Date(ini), to: new Date(fin) },
      volumes: true, ignoreFlats: true, retryCount: 3, pauseBetweenRetriesMs: 3000,
      batchSize: 5, pauseBetweenBatchesMs: 1500,
    })
    if (dukascopyLimitando(Date.now() - inicio + 1000)) return { error: '429' }
    return { velas: velas.filter(v => v.timestamp >= ini && v.timestamp < fin) }
  } catch (err) {
    return { error: dukascopyLimitando(Date.now() - inicio + 1000) ? '429' : err.message }
  }
}

function guardarMes(ruta, velas) {
  const comillas = v => `"${v}"`
  const filas = velas.map(v => [Math.floor(v.timestamp / 1000), fechaMadrid(v.timestamp), v.open, v.high, v.low, v.close, v.volume ?? ''].map(comillas).join(','))
  const cabecera = ['time', 'datetime_madrid', 'open', 'high', 'low', 'close', 'volume'].map(comillas).join(',')
  writeFileSync(`${ruta}.tmp`, '\uFEFF' + [cabecera, ...filas].join('\r\n') + '\r\n')
  renameSync(`${ruta}.tmp`, ruta)
}

// Un mes está hecho si su CSV se escribió después de que el mes acabara; si no (el mes en
// curso, o el anterior bajado antes de cerrarse), se rehace. Así, lanzado cada día, se
// pone al día solo.
function mesHecho(ruta, fin) {
  try { return statSync(ruta).mtimeMs > fin + 60 * 60_000 } catch { return false }
}

const pedidos = process.argv.slice(2).map(s => s.toLowerCase())
const lista = pedidos.length ? pedidos : INSTRUMENTOS
for (const i of lista) {
  if (!instrumentMetaData[i]) { console.error(`Dukascopy no tiene el instrumento ${i}`); process.exit(1) }
}

mkdirSync(BASE, { recursive: true })

// Si ya hay otra descarga en marcha (testigo renovado hace menos de 3 min), esta no hace nada:
// la tarea diaria no se pisa con una descarga larga lanzada a mano.
const TESTIGO = join(BASE, '.descargando')
try {
  if (Date.now() - statSync(TESTIGO).mtimeMs < 3 * 60_000) {
    console.log(`Ya hay una descarga en marcha (PID ${readFileSync(TESTIGO, 'utf8')}); no hago nada`)
    process.exit(0)
  }
} catch { /* no hay testigo: adelante */ }

instalarTransporteDukascopy()

// El testigo de que la descarga está en marcha: el servidor local, mientras lo ve renovado
// (cada minuto), no le pide nada a Dukascopy. Se borra al acabar; si el proceso muere sin
// borrarlo, a los 3 min sin renovar deja de contar.
const renovarTestigo = () => { try { writeFileSync(TESTIGO, String(process.pid)) } catch { /* no es crítico */ } }
renovarTestigo()
const relojTestigo = setInterval(renovarTestigo, 60_000)
process.on('exit', () => { try { unlinkSync(TESTIGO) } catch { /* ya no está */ } })
process.on('SIGINT', () => process.exit(130))
anotar(`Empiezo: ${lista.join(', ')} → ${BASE}`)

const ahora = Date.now()
const mesEnCurso = new Date(ahora).toISOString().slice(0, 7)
for (const instrumento of lista) {
  const dir = join(BASE, instrumento)
  mkdirSync(dir, { recursive: true })
  const primera = Date.parse(instrumentMetaData[instrumento].startDayForMinuteCandles)
  const todos = meses(primera, ahora)
  const pendientes = todos.filter(([, fin, mes]) => !mesHecho(join(dir, `${mes}.csv`), fin))
  anotar(`${instrumento}: ${todos.length} meses desde ${todos[0][2]}, faltan ${pendientes.length}`)
  for (const [ini, fin, mes] of pendientes) {
    for (let intento = 0; ; intento++) {
      const r = await bajarMes(instrumento, ini, fin)
      if (r.velas) {
        if (r.velas.length) guardarMes(join(dir, `${mes}.csv`), r.velas)
        // un mes sin velas (antes de que haya datos, o mercado cerrado) se marca vacío para no repetirlo
        else writeFileSync(join(dir, `${mes}.csv`), '')
        anotar(`${instrumento} ${mes}: ${r.velas.length} velas`)
        break
      }
      const espera = ESPERAS_MIN[Math.min(intento, ESPERAS_MIN.length - 1)]
      anotar(`${instrumento} ${mes}: ${r.error === '429' ? 'Dukascopy limita (429)' : `falla: ${r.error}`}; espero ${espera} min y lo repito`)
      await dormir(espera * 60_000)
    }
    await dormir(PAUSA_ENTRE_MESES_MS)
  }
  anotar(`${instrumento}: hecho`)
}
anotar('Todo bajado')
clearInterval(relojTestigo)
