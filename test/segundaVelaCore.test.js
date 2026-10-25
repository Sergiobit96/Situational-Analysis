// Tests del motor de estrategias. Se ejecutan con el runner de Node, sin dependencias:
//   npm test
//
// La idea es tener una sesión inventada a mano, con números redondos, en la que se pueda
// decir a ojo cuánto tiene que dar cada caso. Así, si algún día se toca simularPierna para
// otra cosa, esto avisa en un segundo en vez de aparecer semanas después como un acumulado
// raro en el backtest.
import test from 'node:test'
import assert from 'node:assert/strict'

import { analizarSesion, resumir, rentabilidadCompuesta, SESIONES, nDiarioPorFecha } from '../src/segundaVelaCore.js'
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

test('la pirámide para en maxUnidades posiciones, contando la entrada', () => {
  const sube = [[105, 112, 104, 111]]
  for (let r = 1; r <= 7; r++) sube.push([100 + 10 * r, 111 + 10 * r, 110 + 10 * (r - 1), 110 + 10 * r])
  assert.equal(analizar(sube, { modo: 'ambos', piramide: 1 }).unidades, 6)                  // la entrada y 5 añadidos
  assert.equal(analizar(sube, { modo: 'ambos', piramide: 1, maxUnidades: 4 }).unidades, 4)  // lo que usa el bot: la entrada y 3 añadidos
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

// ── First bar negative ─────────────────────────────────────────────────────────
// Velas de 5 min. La primera de la sesión va de 110 a 87 (23 puntos, cierra en negativo). N,
// que es la del diario, vale 4 en las pruebas: se añade cada 2 puntos y el stop va a 8 del
// último añadido.
const FBN = estrategiaDe('first-bar-negative')
const OPC_FBN = {
  ticker: '^GDAXI',
  ventana: { ...SESIONES['^GDAXI'], minutosVela: 5, nBracket: 1 },
  modo: FBN.lado,
  colorBracket: FBN.colorBracket,
  piramideN: FBN.tortuga,
  n: 4,
}
const velas5De = (...defs) => defs.map(([open, high, low, close], i) => ({
  time: T0 + i * 300, open, high, low, close,
}))
const PRIMERA_NEGRA = [108, 110, 87, 88]

test('First bar negative solo vende, y solo si la primera vela cierra en negativo', () => {
  const blanca = analizarSesion({ ...OPC_FBN, velas: velas5De([88, 110, 87, 108], [108, 109, 80, 81]) })
  assert.equal(blanca.valido, true)
  assert.equal(blanca.resultado, 'sin-entrada')
  assert.equal(blanca.sinEntrada, 'color')

  // rompe por arriba y no hace nada; luego pierde el mínimo y vende ahí
  const negra = analizarSesion({ ...OPC_FBN, piramideN: null, velas: velas5De(PRIMERA_NEGRA, [88, 109, 88, 108], [108, 108, 86, 86.5]) })
  assert.equal(negra.lado, 'corto')
  assert.equal(negra.entrada.precio, 87)
  assert.equal(negra.entrada.time, T0 + 600)
})

test('First bar negative con flip compra en el máximo de la vela cuando salta el stop', () => {
  const sesion = sigue => velas5De(
    PRIMERA_NEGRA,
    [88, 112, 88, 100],       // rompe por arriba: tampoco con flip se entra en largo de primeras
    [100, 101, 86, 86.5],     // vende en 87
    [86.5, 111, 86, 110.5],   // salta el stop en 110 → compra ahí, con el stop en 87
    sigue,
  )
  const opc = { ...OPC_FBN, piramideN: null }

  const a = analizarSesion({ ...opc, flip: true, velas: sesion([110.5, 120, 110, 119]) })
  assert.equal(a.lado, 'corto')
  assert.equal(a.entrada.precio, 87)
  assert.equal(a.salida.motivo, 'bracket')
  assert.equal(a.salida.precio, 110)
  assert.equal(a.piernas.length, 1)
  assert.equal(a.piernas[0].lado, 'largo')
  assert.equal(a.piernas[0].entrada.precio, 110)
  assert.equal(a.piernas[0].salida.motivo, 'cierre')
  assert.equal(a.resultadoTotalPts, (87 - 110) + (119 - 110))

  // el largo salta en el mínimo de la vela, y ahí se acaba: no hay segunda vuelta
  const b = analizarSesion({ ...opc, flip: true, velas: sesion([110.5, 112, 86, 86.5]) })
  assert.equal(b.piernas.length, 1)
  assert.equal(b.piernas[0].salida.motivo, 'bracket')
  assert.equal(b.piernas[0].salida.precio, 87)

  // sin flip, la misma sesión es solo la venta parada
  const c = analizarSesion({ ...opc, velas: sesion([110.5, 120, 110, 119]) })
  assert.equal(c.piernas.length, 0)
  assert.equal(c.resultadoTotalPts, 87 - 110)
})

// 26 sesiones diarias: una sin rango, que no cuenta; la 22.ª, de 12 puntos de rango verdadero;
// y el resto, de 2. La media de Wilder arranca en 2 con las 20 primeras con rango y la de 12
// la lleva a (2 × 19 + 12) / 20
const DIARIAS = Array.from({ length: 26 }, (_, i) => {
  const date = new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10)
  if (i === 3) return { date, open: 100, high: 100, low: 100, close: 100 }
  return { date, open: 100, high: i === 21 ? 111 : 101, low: 99, close: 100 }
})

test('N es la de las tortugas: el ATR de Wilder de 20 sesiones diarias hasta la anterior', () => {
  const nDe = nDiarioPorFecha([...DIARIAS].reverse())   // en cualquier orden
  assert.equal(nDe(DIARIAS[20].date), null)             // antes solo hay 19 con rango
  assert.equal(nDe(DIARIAS[21].date), 2)                // la de ese día aún no cuenta
  assert.equal(nDe(DIARIAS[22].date), (2 * 19 + 12) / 20)
  // y después de la última, cada sesión de 2 puntos la va bajando
  let esperado = (2 * 19 + 12) / 20
  for (let i = 22; i < 26; i++) esperado = (esperado * 19 + 2) / 20
  assert.ok(Math.abs(nDe('2026-12-31') - esperado) < 1e-12)

  // sin N, la pirámide de las tortugas no puede leer la sesión; con una sola unidad, sí
  const sesion = velas5De(PRIMERA_NEGRA, [88, 89, 86, 86.5])
  assert.equal(analizarSesion({ ...OPC_FBN, n: null, velas: sesion }).valido, false)
  assert.equal(analizarSesion({ ...OPC_FBN, n: null, piramideN: null, velas: sesion }).lado, 'corto')
})

test('First bar negative añade cada ½ N desde el último relleno y sube el stop a 2 N de él', () => {
  const a = analizarSesion({ ...OPC_FBN, velas: velas5De(
    PRIMERA_NEGRA,
    [88, 89, 86, 86.5],       // vende en 87; el añadido estaría en 85
    [86.5, 87, 84, 84.5],     // añade en 85 → stop a 93
    [84.5, 85, 80, 80.5],     // añade en 83 → stop a 91
    [80.5, 81, 79, 79.5],     // abre ya pasado el 81: entra a la apertura, 80,5 → stop a 88,5
    [79.5, 89, 79, 88],       // salta el stop en 88,5
  ) })

  assert.equal(a.entrada.precio, 87)
  assert.deepEqual(a.anadidos.map(x => x.precio), [85, 83, 80.5])
  assert.equal(a.salida.motivo, 'stopN')
  assert.equal(a.salida.precio, 88.5)
  assert.equal(a.resultadoPts, (87 - 88.5) + (85 - 88.5) + (83 - 88.5) + (80.5 - 88.5))
  assert.equal(a.rango, 23)   // la R sigue siendo lo que se arriesgaba al entrar
})

test('el stop a 2 N nunca se afloja', () => {
  // primera vela de solo 4 puntos con N = 3,05: 2 N del primer añadido quedaría por encima
  // del máximo de la vela, así que el stop se queda donde estaba
  const a = analizarSesion({ ...OPC_FBN, n: 3.05, velas: velas5De(
    [100, 100, 96, 97],
    [97, 97.5, 94, 94.5],     // vende en 96 y añade en 94,475 (½ N = 1,525)
    [94.5, 101, 94, 100],     // vuelve: salta el stop original en 100
  ) })
  assert.equal(a.anadidos.length, 1)
  assert.equal(a.salida.motivo, 'bracket')
  assert.equal(a.salida.precio, 100)
})

test('First bar negative llega como mucho a 4 posiciones: la entrada y 3 añadidos', () => {
  assert.equal(FBN.maxUnidades, 4)
  const cae = [PRIMERA_NEGRA]
  for (let i = 0; i < 8; i++) cae.push([86 - 3 * i, 87 - 3 * i, 83 - 3 * i, 83.5 - 3 * i])   // 3 puntos más abajo cada vela
  assert.equal(analizarSesion({ ...OPC_FBN, maxUnidades: FBN.maxUnidades, velas: velas5De(...cae) }).anadidos.length, 3)
  assert.equal(analizarSesion({ ...OPC_FBN, velas: velas5De(...cae) }).anadidos.length, 5)   // sin tope propio, el del motor
})

test('First bar negative añade cada ¼ N y cierra todo en el objetivo a 1 N de la entrada', () => {
  // N = 4: añade cada punto (86, 85, 84) y el objetivo está en 83
  const a = analizarSesion({ ...OPC_FBN, piramideN: { ...FBN.tortuga, pasoN: 0.25 }, tpN: 1, maxUnidades: FBN.maxUnidades, velas: velas5De(
    PRIMERA_NEGRA,
    [88, 88, 85.5, 86],       // vende en 87 y añade en 86
    [86, 86, 84.5, 85],       // añade en 85
    [85, 85, 82, 82.5],       // añade en 84 y llega al objetivo, 83: fuera todo
    [82.5, 83, 70, 71],
  ) })
  assert.deepEqual(a.anadidos.map(x => x.precio), [86, 85, 84])
  assert.equal(a.objetivoNivel, 83)
  assert.equal(a.salida.motivo, 'objetivo')
  assert.equal(a.salida.precio, 83)
  assert.equal(a.resultadoPts, 4 + 3 + 2 + 1)
})

test('el objetivo en N es una orden límite: si la vela abre pasada, se llena a la apertura', () => {
  const a = analizarSesion({ ...OPC_FBN, piramideN: null, tpN: 1, velas: velas5De(
    PRIMERA_NEGRA,
    [88, 88, 86, 86.5],       // vende en 87; objetivo en 83
    [82, 82.5, 81, 81.5],     // abre en 82, ya pasado el objetivo
  ) })
  assert.equal(a.salida.motivo, 'objetivo')
  assert.equal(a.salida.precio, 82)
  assert.equal(a.resultadoPts, 5)
})

test('no se añade en el objetivo: esa unidad se cerraría en el acto', () => {
  // cada ½ N (2 puntos) con el objetivo a 1 N: el segundo añadido caería justo en 83
  const a = analizarSesion({ ...OPC_FBN, tpN: 1, velas: velas5De(
    PRIMERA_NEGRA,
    [88, 88, 84.5, 85],       // vende en 87 y añade en 85
    [85, 85, 82, 82.5],       // llega a 83: cierra sin añadir
  ) })
  assert.deepEqual(a.anadidos.map(x => x.precio), [85])
  assert.equal(a.salida.precio, 83)
  assert.equal(a.resultadoPts, 4 + 2)
})

test('con BE tras 2 añadidos el stop pasa al precio medio y sale a cero', () => {
  const velas = velas5De(
    PRIMERA_NEGRA,
    [88, 89, 86, 86.5],       // vende en 87
    [86.5, 87, 84, 84.5],     // añade en 85 → stop a 93
    [84.5, 85, 82.5, 83],     // añade en 83: el medio, 85, aprieta más que 2 N (91)
    [83, 85.5, 82.8, 85.2],   // vuelve a 85: fuera a cero
  )
  const a = analizarSesion({ ...OPC_FBN, beAnadidos: 2, velas })
  assert.deepEqual(a.anadidos.map(x => x.precio), [85, 83])
  assert.equal(a.salida.motivo, 'breakeven')
  assert.equal(a.salida.precio, 85)
  assert.equal(a.resultadoPts, 0)
  // sin la regla, el stop sigue a 2 N (91) y cierra con la sesión
  assert.equal(analizarSesion({ ...OPC_FBN, velas }).salida.motivo, 'cierre')
})

test('prepararSesion deja las velas de 5 min tal cual para First bar negative', () => {
  const cinco = velas5De([100, 101, 99, 100], [100, 101, 99, 100])
  const { velas, finas, ventana } = prepararSesion(FBN, '^GDAXI', cinco)
  assert.equal(velas, cinco)
  assert.equal(finas, null)
  assert.equal(ventana.minutosVela, 5)
  assert.equal(ventana.nBracket, 1)
})

test('el CAGR compone cada sesión en R por el riesgo de cada operación', () => {
  // un año: +2R y −1R arriesgando un 1 %: 1,02 × 0,99
  const c = rentabilidadCompuesta([
    { date: '2025-01-01', r: null },
    { date: '2025-07-02', r: 2 },
    { date: '2026-01-01', r: -1 },
  ], 1)
  assert.ok(Math.abs(c.total - 0.98) < 1e-9)
  assert.ok(Math.abs(c.cagr - 0.98) < 0.01)
  assert.ok(Math.abs(c.maxDD - (100 * (1.0098 / 1.02 - 1))) < 1e-9)
  // con el doble de riesgo, todo pesa el doble: 1,04 × 0,98
  assert.ok(Math.abs(rentabilidadCompuesta([{ date: '2025-01-01', r: 2 }, { date: '2026-01-01', r: -1 }], 2).total - 1.92) < 1e-9)
  assert.equal(rentabilidadCompuesta([{ date: '2025-01-01', r: 1 }], 1), null)
})
