// ── Velas de 1 min de Yahoo como reserva para el MFE/MAE ─────────────────────
// recoger_yahoo.py (G:\Mi unidad\codigos\firstrate) guarda cada mañana la sesión de contado
// de los índices en Documents\Yahoo\<INDICE>_1min.csv, en hora de Madrid. Cuando Dukascopy
// no sirve un día que no está en su caché, el MFE/MAE de esas operaciones sale de aquí.
// Va aparte de index.js para poder probarlo sin levantar el servidor (test/velasYahoo.test.js).
//
// Es peor fuente que Dukascopy para esto, medido con las operaciones de sep-oct 2026:
//   · solo trae la sesión de contado, así que una operación fuera de ella no se puede medir;
//   · es el índice de contado, no el CFD. El DAX y el FTSE van pegados a él (la entrada cae
//     en su vela el 64% y el 41% de las veces, a menos de 4 y 2 puntos el 90%), pero el CFD
//     americano lleva su propio desfase: en el Dow, el 90% de las entradas quedaba a 29
//     puntos. Con el desfase del día medido con las propias ejecuciones baja a 7 en el Dow
//     y el Nasdaq; en el DAX y el FTSE esa corrección empeoraba, y por eso no se les aplica.
import { tramoDe, aUtc } from './excursiones.js'

// Ticker de la app → nombre del CSV de recoger_yahoo.py (metales y demás no están)
export const INDICE_YAHOO = {
  '^GDAXI': 'DAX', '^FTSE': 'FTSE', '^GSPC': 'SPX', '^NDX': 'NDX', '^DJI': 'DJI', '^RUT': 'RUT',
}

// Índices cuyo CFD no va pegado al contado: se corrigen con el desfase del día
export const CALIBRAR = new Set(['^GSPC', '^NDX', '^DJI', '^RUT'])

// Huecos tolerados dentro del tramo: Yahoo pierde alguna vela suelta
const HUECO_MAX_S = 5 * 60

// "Date;Time;Open;High;Low;Close;Source" en hora de Madrid → velas en UTC, ordenadas
export function parsearCsvYahoo(texto) {
  const velas = []
  for (const linea of texto.split(/\r?\n/)) {
    const [fecha, hora, open, high, low, close] = linea.split(';')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha ?? '') || close === undefined) continue
    const [h, m] = hora.split(':').map(Number)
    const local = Date.parse(`${fecha}T00:00:00Z`) / 1000 + h * 3600 + m * 60
    const v = { time: aUtc(local), open: +open, high: +high, low: +low, close: +close }
    if ([v.time, v.open, v.high, v.low, v.close].every(Number.isFinite)) velas.push(v)
  }
  return velas.sort((a, b) => a.time - b.time)
}

// Primera posición con time >= t (búsqueda binaria)
function desde(velas, t) {
  let lo = 0, hi = velas.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (velas[mid].time < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

const mediana = valores => {
  const o = [...valores].sort((a, b) => a - b)
  return o.length ? o[o.length >> 1] : null
}

// Desfase del CFD respecto al contado ese día: mediana de (precio ejecutado − centro de su
// vela) en todas las ejecuciones del día en ese instrumento. `ejecuciones` va en UTC.
export function desfaseDelDia(velas, ejecuciones) {
  const muestras = []
  for (const { time, precio } of ejecuciones) {
    const i = desde(velas, Math.floor(time / 60) * 60)
    const v = velas[i]
    if (v && v.time === Math.floor(time / 60) * 60) muestras.push(precio - (v.high + v.low) / 2)
  }
  return mediana(muestras)
}

// Velas de Yahoo para medir la operación `t`, o null si no cubren entero el tramo en que
// estuvo abierta (de la vela de la entrada a la de la salida, sin huecos de más de 5 min).
// `ejecuciones` son las del mismo día e instrumento, para el desfase de los americanos.
export function velasYahooDeOperacion(velas, t, ejecuciones = []) {
  const { tf, desde: ini, hasta } = tramoDe(t)
  if (tf !== 'm1' || !velas?.length) return null

  const tramo = velas.slice(desde(velas, ini), desde(velas, hasta))
  if (!tramo.length || tramo[0].time !== ini || tramo[tramo.length - 1].time !== hasta - 60) return null
  for (let i = 1; i < tramo.length; i++) {
    if (tramo[i].time - tramo[i - 1].time > HUECO_MAX_S) return null
  }

  const d = CALIBRAR.has(t.ticker) ? (desfaseDelDia(velas, ejecuciones) ?? 0) : 0
  return d === 0 ? tramo : tramo.map(v => ({ ...v, high: v.high + d, low: v.low + d }))
}
