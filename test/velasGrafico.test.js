// Tests de la agrupación y el paginado de la pestaña Gráfico (server/velas-grafico.js)
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  agruparVelas, agruparPorSesion, paginaAnteriorA, inicioDiaMadrid, offsetMadrid, ventanaYahoo,
} from '../server/velas-grafico.js'

const utc = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000

// Velas de `paso` minutos seguidas desde `t0`, con precios que suben de uno en uno
const serie = (t0, n, paso) => Array.from({ length: n }, (_, i) => ({
  time: t0 + i * paso * 60, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i,
}))

test('offset de Madrid en invierno y en verano', () => {
  assert.equal(offsetMadrid(utc(2026, 2, 2, 8)), 3600)
  assert.equal(offsetMadrid(utc(2026, 7, 1, 8)), 7200)
})

test('agrupa 5 min en 15 min sumando máximos, mínimos y cierre', () => {
  // 2-feb-2026 09:00 Madrid = 08:00 UTC
  const velas = agruparVelas(serie(utc(2026, 2, 2, 8), 6, 5), 15)
  assert.equal(velas.length, 2)
  assert.deepEqual(velas[0], { time: utc(2026, 2, 2, 8), open: 100, high: 103, low: 99, close: 102.5 })
  assert.deepEqual(velas[1], { time: utc(2026, 2, 2, 8, 15), open: 103, high: 106, low: 102, close: 105.5 })
})

test('la de 4 h anclada en la apertura del DAX arranca a las 09:00, 13:00 y 17:00', () => {
  // sesión del DAX en 5 min: 09:00 a 17:25 Madrid, 103 velas
  const velas = agruparVelas(serie(utc(2026, 2, 2, 8), 103, 5), 240, 9 * 60)
  assert.deepEqual(velas.map(v => v.time), [utc(2026, 2, 2, 8), utc(2026, 2, 2, 12), utc(2026, 2, 2, 16)])
  assert.equal(velas[2].close, 100.5 + 102)
})

test('la diaria lleva la hora de la medianoche de Madrid', () => {
  const velas = agruparVelas(serie(utc(2026, 7, 1, 7), 10, 60), 1440)
  assert.equal(velas.length, 1)
  assert.equal(velas[0].time, utc(2026, 6, 30, 22))   // 1-jul 00:00 Madrid (UTC+2)
})

test('una vela de 4 h que cruza la medianoche no se parte en dos', () => {
  // horarias de 22:00 a 01:00 Madrid con ancla a las 09:00 → cubo de 21:00 a 01:00
  const velas = agruparVelas(serie(utc(2026, 2, 2, 21), 3, 60), 240, 9 * 60)
  assert.equal(velas.length, 1)
  assert.equal(velas[0].time, utc(2026, 2, 2, 20))
})

test('la hora que se repite al atrasar el reloj en octubre no duplica velas', () => {
  // 25-oct-2026: a las 03:00 CEST el reloj vuelve a las 02:00 CET (01:00 UTC)
  const velas = agruparVelas(serie(utc(2026, 10, 24, 23), 4, 60), 60)
  const tiempos = velas.map(v => v.time)
  assert.deepEqual(tiempos, [...new Set(tiempos)].sort((a, b) => a - b))
  // las 02:00 CEST (00:00 UTC) y las 02:00 CET (01:00 UTC) son la misma hora del reloj
  assert.equal(velas.length, 3)
})

test('la medianoche de Madrid, también el día del cambio de hora', () => {
  assert.equal(inicioDiaMadrid(utc(2026, 2, 2, 15)), utc(2026, 2, 1, 23))
  assert.equal(inicioDiaMadrid(utc(2026, 7, 1, 15)), utc(2026, 6, 30, 22))
  // 29-mar-2026 por la tarde ya es verano, pero su medianoche fue en invierno
  assert.equal(inicioDiaMadrid(utc(2026, 3, 29, 15)), utc(2026, 3, 28, 23))
})

test('pagina hacia atrás desde un instante', () => {
  const velas = serie(utc(2026, 2, 2, 8), 10, 5)
  const p1 = paginaAnteriorA(velas, Infinity, 4)
  assert.deepEqual(p1.velas, velas.slice(6))
  assert.equal(p1.hayMas, true)
  const p2 = paginaAnteriorA(velas, velas[6].time, 4)
  assert.deepEqual(p2.velas, velas.slice(2, 6))
  const p3 = paginaAnteriorA(velas, velas[2].time, 4)
  assert.deepEqual(p3.velas, velas.slice(0, 2))
  assert.equal(p3.hayMas, false)
})

test('con Yahoo, las horarias del contado americano se quedan en y media', () => {
  // 15-oct-2026: Nueva York abre a las 15:30 Madrid (13:30 UTC); Yahoo da 60m desde ahí
  const velas = agruparPorSesion(serie(utc(2026, 10, 15, 13, 30), 7, 60), 60)
  assert.deepEqual(velas.map(v => v.time), serie(utc(2026, 10, 15, 13, 30), 7, 60).map(v => v.time))
})

test('la de 4 h de Yahoo arranca en la apertura de cada día, también si se mueve', () => {
  // un día normal: 15:30 y 19:30 Madrid
  const normal = agruparPorSesion(serie(utc(2026, 10, 15, 13, 30), 7, 60), 240)
  assert.deepEqual(normal.map(v => v.time), [utc(2026, 10, 15, 13, 30), utc(2026, 10, 15, 17, 30)])
  // 26-oct-2026: Europa ya ha atrasado el reloj y Estados Unidos no, así que Nueva York
  // abre a las 14:30 Madrid. La vela sigue empezando en la apertura, no media jornada antes.
  const desfase = agruparPorSesion(serie(utc(2026, 10, 26, 13, 30), 7, 60), 240)
  assert.equal(desfase[0].time, utc(2026, 10, 26, 13, 30))
  assert.equal(desfase.length, 2)
  // y dos días seguidos no se mezclan
  const dosDias = agruparPorSesion([...serie(utc(2026, 10, 15, 13, 30), 7, 60), ...serie(utc(2026, 10, 16, 13, 30), 7, 60)], 240)
  assert.equal(dosDias.length, 4)
})

test('las ventanas de Yahoo se cortan en su límite de días', () => {
  const ahora = utc(2026, 10, 18, 10)
  const primera = ventanaYahoo('m15', ahora, ahora)
  assert.equal(primera.intervalo, '15m')
  assert.equal(primera.alLimite, false)
  assert.equal(primera.desde, inicioDiaMadrid(ahora - 20 * 86400))
  // la que llega a los 59 días se recorta ahí y avisa; más atrás ya no hay ventana
  const ultima = ventanaYahoo('m15', ahora - 50 * 86400, ahora)
  assert.equal(ultima.alLimite, true)
  assert.equal(ultima.desde, ahora - 59 * 86400)
  assert.match(ultima.aviso, /60 días/)
  assert.equal(ventanaYahoo('m15', ahora - 59 * 86400, ahora), null)
  // la diaria no tiene límite
  assert.equal(ventanaYahoo('d1', utc(1990, 1, 1), ahora).alLimite, false)
})
