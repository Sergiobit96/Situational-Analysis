// ── MFE / MAE de las operaciones del diario ───────────────────────────────────
// MFE (máxima excursión favorable): lo más que llegó a ir ganando la operación mientras
// estuvo abierta. MAE (máxima excursión adversa): lo más que llegó a ir perdiendo. Las dos
// en puntos del instrumento y desde el precio de entrada, con las velas de Dukascopy del
// tramo en que la posición estuvo abierta. Va aparte de index.js para poder probarlo sin
// levantar el servidor (test/excursiones.test.js).
//
// Precisión: el 75-80% de las entradas del diario cae dentro de su vela de 1 min de
// Dukascopy, y las que no, se salen 1-3 puntos (el bróker cotiza su propia fuente, con
// spread, y la hora del diario va al segundo). Además, la vela de la entrada y la de la
// salida cuentan enteras. Por eso se fuerza lo único que se sabe seguro: una operación que
// cerró ganando X llegó a ir ganando al menos X, y una que cerró perdiendo X llegó a ir
// perdiendo al menos X.
import { offsetMadrid } from './velas-grafico.js'

// Subirla hace que se recalculen todas las guardadas (cambio en la forma de medir o en la
// clave). La 2 añadió los precios a la clave.
export const VERSION_EXCURSION = 2

// Hasta este tiempo abierta se mide con velas de 1 min; las más largas (swing) con las de
// 1 h, que para movimientos de varios días sobran y son 60 veces menos datos
export const MAX_SEGUNDOS_M1 = 2 * 86400

// La misma escala que FACTOR_PRECIO en src/parseTrades.js: el bróker cotiza la plata ×100
const FACTOR_PRECIO = { XAGUSD: 100 }

// Producto y horas no bastan: el historial trae piernas distintas abiertas y cerradas en el
// mismo segundo (351 operaciones en 2021-2026), y sin los precios la segunda heredaba el MFE
// de la primera. La misma clave que claveDeExcursion en src/estadisticas.js.
export const claveExcursion = t => `${t.producto}|${t.openTime}|${t.closeTime}|${t.openPrice}|${t.closePrice}`

// Las horas del diario van en hora de pared de Madrid guardada como si fuera UTC (es como
// las pinta el gráfico); las velas de Dukascopy van en UTC de verdad
export function aUtc(local) {
  return local - offsetMadrid(local - offsetMadrid(local))
}

// El diario dice LONG/SHORT y el historial de la cuenta Buy/Sell. Si no dice nada, el lado
// sale del signo del resultado frente al del movimiento de precio.
export function ladoDe(t) {
  const d = String(t.direccion ?? '').toUpperCase()
  if (d === 'LONG' || d === 'BUY') return 'largo'
  if (d === 'SHORT' || d === 'SELL') return 'corto'
  const movimiento = t.closePrice - t.openPrice
  if (!Number.isFinite(t.puntos) || t.puntos === 0 || !movimiento) return null
  return (t.puntos > 0) === (movimiento > 0) ? 'largo' : 'corto'
}

// Velas que hay que mirar, en UTC: de la que contiene la entrada a la que contiene la salida
export function tramoDe(t) {
  const entrada = aUtc(t.openTime)
  const salida  = aUtc(t.closeTime)
  const tf   = salida - entrada <= MAX_SEGUNDOS_M1 ? 'm1' : 'h1'
  const paso = tf === 'm1' ? 60 : 3600
  return {
    tf,
    desde: Math.floor(entrada / paso) * paso,
    hasta: Math.floor(salida / paso) * paso + paso,
  }
}

const redondear = x => Math.round(x * 100) / 100

// `velas` puede traer más de lo necesario (el día entero): aquí se recorta al tramo
export function calcularExcursion(t, velas) {
  const lado = ladoDe(t)
  if (!lado) return { sinDatos: 'sin dirección' }

  const { tf, desde, hasta } = tramoDe(t)
  let maximo = -Infinity, minimo = Infinity, n = 0
  for (const v of velas) {
    if (v.time < desde || v.time >= hasta) continue
    if (v.high > maximo) maximo = v.high
    if (v.low  < minimo) minimo = v.low
    n++
  }
  if (n === 0) return { sinDatos: 'sin velas en el tramo' }

  const factor = FACTOR_PRECIO[t.ticker] ?? 1
  maximo *= factor
  minimo *= factor

  const largo     = lado === 'largo'
  const realizado = largo ? t.closePrice - t.openPrice : t.openPrice - t.closePrice
  const favorable = largo ? maximo - t.openPrice : t.openPrice - minimo
  const adversa   = largo ? minimo - t.openPrice : t.openPrice - maximo

  return {
    lado, tf, velas: n,
    mfe:       redondear(Math.max(favorable, realizado, 0)),
    mae:       redondear(Math.min(adversa, realizado, 0)),
    realizado: redondear(realizado),
  }
}
