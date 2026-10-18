// Tests del motor de estrategias. Se ejecutan con el runner de Node, sin dependencias:
//   npm test
//
// La idea es tener una sesión inventada a mano, con números redondos, en la que se pueda
// decir a ojo cuánto tiene que dar cada caso. Así, si algún día se toca simularPierna para
// otra cosa, esto avisa en un segundo en vez de aparecer semanas después como un acumulado
// raro en el backtest.
import test from 'node:test'
import assert from 'node:assert/strict'

import { analizarSesion, resumir, SESIONES } from '../src/segundaVelaCore.js'
import { agruparVelas, ventanaRuleOf4, prepararSesion, estrategiaDe } from '../src/estrategias.js'
import { madridOffsetAt, nuevaYorkOffsetAt } from '../src/timezone.js'

// 2 de febrero de 2026, invierno: Madrid es UTC+1, así que la apertura del DAX (09:00) cae
// a las 08:00 UTC. Con velas de 15 min correlativas desde ahí.
const T0 = Date.UTC(2026, 1, 2, 8, 0) / 1000

// Cada vela es [open, high, low, close]; se colocan una detrás de otra cada 15 min.
const velasDe = (...defs) => defs.map(([open, high, low, close], i) => ({
  time: T0 + i * 900, open, high, low, close,
}))

// Sesión base: la 2ª vela (el bracket) va de 100 a 110, así que 1R = 10 puntos.
const PREVIA  = [100, 102, 99, 101]
const BRACKET = [101, 110, 100, 105]

const analizar = (defs, opciones = {}) =>
  analizarSesion({ velas: velasDe(PREVIA, BRACKET, ...defs), ticker: '^GDAXI', ...opciones })

test('el bracket es la segunda vela y 1R su rango', () => {
  const a = analizar([[105, 106, 104, 105]])
  assert.equal(a.valido, true)
  assert.equal(a.high, 110)
  assert.equal(a.low, 100)
  assert.equal(a.rango, 10)
  assert.equal(a.dir1, 'alcista')   // la primera cierra por encima de su apertura
})

test('sin rotura del bracket no hay operación', () => {
  const a = analizar([[105, 109, 101, 104], [104, 108, 102, 103]])
  assert.equal(a.resultado, 'sin-entrada')
  assert.equal(a.entrada, null)
})

test('compra en la rotura y cierre con la sesión', () => {
  const a = analizar([[105, 112, 104, 111], [111, 116, 110, 115]], { modo: 'ambos' })
  assert.equal(a.lado, 'largo')
  assert.equal(a.entrada.precio, 110)       // se entra en el máximo del bracket
  assert.equal(a.salida.motivo, 'cierre')
  assert.equal(a.salida.precio, 115)
  assert.equal(a.resultadoPts, 5)
})

test('venta en la rotura del mínimo', () => {
  const a = analizar([[101, 102, 96, 97], [97, 98, 92, 93]], { modo: 'ambos' })
  assert.equal(a.lado, 'corto')
  assert.equal(a.entrada.precio, 100)
  assert.equal(a.resultadoPts, 100 - 93)
})

test('el stop en el extremo contrario cuesta exactamente 1R', () => {
  const a = analizar([[105, 112, 104, 111], [111, 112, 95, 96]], { modo: 'ambos' })
  assert.equal(a.salida.motivo, 'bracket')
  assert.equal(a.salida.precio, 100)
  assert.equal(a.resultadoPts, -10)
  assert.equal(a.resultadoR, -1)
})

test('una vela que entra y toca el stop se marca como ambigua', () => {
  const a = analizar([[105, 112, 95, 100]], { modo: 'ambos' })
  assert.equal(a.ambigua, true)
  assert.equal(a.resultadoPts, -10)   // se lee como la operación que salta en su propia vela
})

test('con flip se da la vuelta al saltar el stop, y como mucho una vez', () => {
  const a = analizar([
    [105, 112, 104, 111],   // compra en 110
    [111, 112, 95, 96],     // salta el stop en 100 → se vuelve corto desde 100
    [96, 99, 90, 91],       // el corto corre
    [91, 112, 90, 111],     // volvería a saltar, pero ya no caben más piernas
  ], { modo: 'flip' })

  assert.equal(a.piernas.length, 1, 'una compra y una venta, no más')
  assert.equal(a.piernas[0].lado, 'corto')
  assert.equal(a.piernas[0].entrada.precio, 100)
  assert.equal(a.resultadoPts, -10)
  assert.equal(a.resultadoTotalPts, a.resultadoPts + a.piernas[0].resultadoPts)
})

test('el break even saca la operación a cero en vez de a −1R', () => {
  const a = analizar([
    [105, 112, 104, 111],   // compra en 110
    [111, 121, 110, 120],   // recorre 1R a favor → el stop sube a la entrada
    [120, 121, 105, 106],   // vuelve: salta en 110
  ], { modo: 'ambos', beR: 1 })

  assert.equal(a.salida.motivo, 'breakeven')
  assert.equal(a.salida.precio, 110)
  assert.equal(a.resultadoPts, 0)
})

test('el stop al 50% arriesga la mitad, y esa mitad es la nueva R', () => {
  const a = analizar([[105, 112, 104, 111], [111, 112, 104, 105]], { modo: 'ambos', stopPct: 0.5 })
  assert.equal(a.salida.precio, 105)    // 110 − (10 × 0,5)
  assert.equal(a.resultadoPts, -5)
  assert.equal(a.resultadoR, -1)        // sigue siendo una R perdida, pero vale la mitad
})

test('la pirámide añade una unidad por R y pone el stop en el precio medio', () => {
  const a = analizar([
    [105, 112, 104, 111],   // compra en 110
    [111, 121, 110, 120],   // +1R → añade en 120
    [120, 131, 119, 130],   // +2R → añade en 130
    [130, 131, 115, 116],   // cae: salta el stop en el precio medio (120)
  ], { modo: 'ambos', piramide: 1 })

  assert.equal(a.unidades, 3)
  assert.deepEqual(a.anadidos.map(x => x.precio), [120, 130])
  assert.equal(a.volumen, 3)
  assert.equal(a.salida.precio, 120)              // (110 + 120 + 130) / 3
  assert.equal(a.resultadoPts, 10 + 0 - 10)       // cada unidad desde su propio precio
})

test('con añadidos de media unidad el precio medio se mueve menos', () => {
  const defs = [
    [105, 112, 104, 111],
    [111, 121, 110, 120],
    [120, 131, 119, 130],
    [130, 131, 100, 101],
  ]
  const entero = analizar(defs, { modo: 'ambos', piramide: 1 })
  const medio  = analizar(defs, { modo: 'ambos', piramide: 1, tamanoAnadido: 0.5 })

  assert.equal(entero.volumen, 3)
  assert.equal(medio.volumen, 2)                      // 1 + 0,5 + 0,5
  assert.equal(entero.salida.precio, 120)             // media simple
  assert.equal(medio.salida.precio, 117.5)            // media ponderada: (110 + 60 + 65) / 2
  assert.ok(medio.salida.precio < entero.salida.precio, 'el stop queda más lejos del precio')
})

test('el objetivo cierra cuando el conjunto suma ese porcentaje del índice', () => {
  // entrada en 110 y tpPct 10% → el objetivo son 11 puntos para toda la posición
  const a = analizar([[105, 112, 104, 111], [111, 130, 110, 129]], { modo: 'ambos', tpPct: 10 })
  assert.equal(a.salida.motivo, 'objetivo')
  assert.equal(a.objetivo, 11)
  assert.equal(a.salida.precio, 121)
  assert.equal(a.resultadoPts, 11)
})

test('los costes se pagan por unidad y por lado', () => {
  const defs = [[105, 112, 104, 111], [111, 116, 110, 115]]
  const bruto = analizar(defs, { modo: 'ambos' })
  const neto  = analizar(defs, { modo: 'ambos', costePts: 1 })

  assert.equal(bruto.resultadoPts, 5)
  assert.equal(neto.resultadoPts, 3)     // 5 − (2 lados × 1 punto × 1 unidad)
  assert.equal(neto.coste, 2)
})

test('una ventana distinta braquetea otra vela de otro tamaño', () => {
  // cuatro velas de 10 min desde la apertura: el bracket es la cuarta
  const ses = SESIONES['^GDAXI']
  const velas = [0, 1, 2, 3, 4, 5].map(i => ({
    time: T0 + i * 600,
    open: 100, high: i === 3 ? 140 : 110, low: i === 3 ? 130 : 90, close: 100,
  }))
  const a = analizarSesion({
    velas, ticker: '^GDAXI',
    ventana: { ...ses, minutosVela: 10, nBracket: 4 },
  })
  assert.equal(a.valido, true)
  assert.equal(a.high, 140)
  assert.equal(a.low, 130)
  assert.equal(a.minutosVela, 10)
})

test('agruparVelas ancla los cubos donde se le dice, no en horas en punto', () => {
  const finas = [0, 1, 2, 3].map(i => ({
    time: T0 + i * 300, open: 10 + i, high: 20 + i, low: i, close: 15 + i,
  }))
  const diez = agruparVelas(finas, 10, T0)
  assert.equal(diez.length, 2)
  assert.equal(diez[0].open, 10)
  assert.equal(diez[0].high, 21)
  assert.equal(diez[0].low, 0)
  assert.equal(diez[0].close, 16)
  assert.equal(diez[1].time, T0 + 600)
})

test('prepararSesion agrupa a velas de 1 h desde la apertura', () => {
  const estr = estrategiaDe('primera-vela-1h')
  const quince = [0, 1, 2, 3, 4].map(i => ({
    time: T0 + i * 900, open: 100, high: 101, low: 99, close: 100,
  }))
  const { velas, finas, ventana } = prepararSesion(estr, '^GDAXI', quince)
  assert.equal(ventana.minutosVela, 60)
  assert.equal(ventana.nBracket, 1)
  assert.equal(velas.length, 2)          // cuatro velas de 15 min son una hora, y sobra una
  assert.equal(velas[0].time, T0)
  assert.equal(finas.length, 5)          // las de 15 se guardan para caminar el recorrido
})

test('la Rule of 4 ancla su ventana en las 14:00 de Nueva York', () => {
  const invierno = ventanaRuleOf4('2026-01-28')   // Madrid y NY con el mismo desfase
  const marzo    = ventanaRuleOf4('2026-03-18')   // NY ya ha cambiado la hora y Madrid no
  assert.equal(invierno.open, 20 * 60)
  assert.equal(marzo.open, 19 * 60)
  assert.equal(invierno.close - invierno.open, 120)
  assert.equal(invierno.minutosVela, 10)
  assert.equal(invierno.nBracket, 4)
})

test('resumir cuenta lo que hay, no lo que se descartó', () => {
  const ganada  = analizar([[105, 112, 104, 111], [111, 116, 110, 115]], { modo: 'ambos' })
  const perdida = analizar([[105, 112, 104, 111], [111, 112, 95, 96]], { modo: 'ambos' })
  const sin     = analizar([[105, 109, 101, 104]], { modo: 'ambos' })
  const malo    = analizarSesion({ velas: [], ticker: '^GDAXI' })

  const r = resumir([ganada, perdida, sin, malo])
  assert.equal(r.n, 3)
  assert.equal(r.descartadas, 1)
  assert.equal(r.nOps, 2)
  assert.equal(r.totalPts, -5)
  assert.equal(r.ganadoPts, 5)
  assert.equal(r.perdidoPts, 10)
  assert.equal(r.profitFactor, 0.5)
})

test('los desfases horarios son los de cada zona en esa fecha', () => {
  const invierno = Date.UTC(2026, 0, 15, 12) / 1000
  const verano   = Date.UTC(2026, 6, 15, 12) / 1000
  assert.equal(madridOffsetAt(invierno), 3600)
  assert.equal(madridOffsetAt(verano), 7200)
  assert.equal(nuevaYorkOffsetAt(invierno), -5 * 3600)
  assert.equal(nuevaYorkOffsetAt(verano), -4 * 3600)
  // la memoria interna no puede cambiar la respuesta
  assert.equal(madridOffsetAt(invierno), 3600)
})
