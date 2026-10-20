// Tests del bot de First bar negative (server/bot-srs.js con FIRST_BAR_NEGATIVE) contra un IG
// de mentira y con un reloj que se mueve a mano. Las velas de 1 min del directo se guardan en
// orden, así que cada prueba va en un día posterior al de la anterior.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { crearBot, siguientePaso, sesionFirstBar, nDiario, FIRST_BAR_NEGATIVE, SRS } from '../server/bot-srs.js'
import { registrarVela } from '../server/tiempo-real.js'
import { analizarSesion, nDiarioPorFecha } from '../src/segundaVelaCore.js'

// noviembre de 2026: Fráncfort y Madrid en invierno (UTC+1), así que el DAX abre a las 08:00 UTC
const utc = (dia, h, m = 0, s = 0) => Date.UTC(2026, 10, dia, h, m, s) / 1000

test('el bracket es la primera vela de 5 min de la sesión de cada bolsa', () => {
  const ses = sesionFirstBar('^GDAXI', utc(5, 12))
  assert.equal(ses.abre, utc(5, 8))
  assert.equal(ses.velaBracket, utc(5, 8))
  assert.equal(ses.finBracket, utc(5, 8, 5))
  assert.equal(ses.cierra, utc(5, 16, 30))
  assert.equal(sesionFirstBar('^NDX', utc(5, 18)).finBracket, utc(5, 14, 35))   // 09:35 en Nueva York
})

test('nace apagado, con sus referencias, y solo vende', () => {
  const c = FIRST_BAR_NEGATIVE.configInicial
  assert.equal(c.activo, false)
  assert.equal(c.modo, 'corto')
  assert.equal(c.colorBracket, 'bajista')
  assert.equal(c.piramide, 0.5)
  assert.equal(c.stopN, 2)
  assert.equal(FIRST_BAR_NEGATIVE.prefijo, 'FBN-')
  assert.notEqual(FIRST_BAR_NEGATIVE.prefijo, SRS.prefijo)
})

test('entra solo al perder el mínimo de la vela, nunca al superar el máximo', () => {
  const ses = sesionFirstBar('^GDAXI', utc(5, 12))
  const cfg = { ...FIRST_BAR_NEGATIVE.configInicial, activo: true }
  const dia = { estado: 'esperando-rotura', bracket: { high: 100, low: 90, rango: 10 }, plan: {} }
  const vela = (high, low) => [{ time: utc(5, 8, 6), open: 95, high, low, close: 95 }]
  const ahora = utc(5, 8, 6, 20)
  assert.equal(siguientePaso({ dia, cfg, ahora, velas: vela(101, 94), ses }).accion, 'nada')
  assert.deepEqual(siguientePaso({ dia, cfg, ahora, velas: vela(96, 89.5), ses }), { accion: 'entrar', lado: 'corto' })
})

test('la N del bot es la de la pestaña Estrategias: el ATR de Wilder de 20 sesiones diarias hasta la anterior', () => {
  // un diario cualquiera, con huecos, días sin rango y fechas desordenadas
  let precio = 20000
  const diarias = Array.from({ length: 80 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10)
    const open = precio + ((i * 37) % 23) - 11
    const high = open + 40 + ((i * 13) % 50)
    const low = i % 17 === 5 ? high : open - 30 - ((i * 7) % 40)
    precio = (high + low) / 2 + ((i * 11) % 9) - 4
    return { date, open, high, low, close: precio }
  }).reverse()
  const nDe = nDiarioPorFecha(diarias)
  for (const fecha of ['2026-06-10', '2026-06-25', '2026-07-15', '2026-08-19', '2026-12-01']) {
    const bot = nDiario(diarias, fecha)
    const pestana = nDe(fecha)
    assert.ok(bot === pestana || Math.abs(bot - pestana) < 1e-9, `${fecha}: ${bot} y ${pestana}`)
  }
  assert.equal(nDiario(diarias, '2026-06-10'), null)   // aún no hay 20 sesiones antes
})

// ── El bot entero, con un IG de mentira ──

const MERCADOS = {
  'IX.D.DAX.IFMM.IP': { ticker: '^GDAXI', valorPunto: 1, moneda: 'EUR', cambioAEur: 1, tamanoMin: 0.5, conPrecio: true },
}

function igFalso({ precios = {}, velas = {} } = {}) {
  const ordenes = []
  let abiertas = []
  let n = 0
  const ig = {
    velasEntre: async (ticker, tf, desde, hasta) => (velas[ticker] ?? []).filter(v => v.time >= desde && v.time < hasta),
    operar: {
      datosMercado: async (ticker, epic) => {
        const [bid, oferta] = precios[ticker] ?? [25500, 25501]
        return { epic: epic ?? 'IX.D.DAX.IFMM.IP', ...MERCADOS['IX.D.DAX.IFMM.IP'], stopMin: 5, estado: 'TRADEABLE', bid, oferta, aMercado: true }
      },
      abrir: async o => {
        ordenes.push({ tipo: 'abrir', ...o })
        const [bid, oferta] = precios[o.ticker] ?? [25500, 25501]
        const nivel = o.lado === 'largo' ? oferta : bid
        const p = { dealId: `D${++n}`, ticker: o.ticker, epic: o.epic, lado: o.lado, tamano: o.tamano, nivel, stop: o.stop, referencia: o.referencia, abierta: new Date(ig.reloj() * 1000).toISOString().slice(0, 19) }
        abiertas.push(p)
        return { aceptada: true, motivo: 'SUCCESS', dealId: p.dealId, nivel, stop: o.stop, tamano: o.tamano, lado: o.lado }
      },
      moverStop: async o => { ordenes.push({ tipo: 'stop', ...o }); return { aceptada: true, motivo: 'SUCCESS' } },
      cerrar: async o => {
        ordenes.push({ tipo: 'cerrar', ...o })
        abiertas = abiertas.filter(p => p.dealId !== o.dealId)
        const [bid, oferta] = precios[o.ticker] ?? [25500, 25501]
        return { aceptada: true, motivo: 'SUCCESS', nivel: o.lado === 'largo' ? bid : oferta }
      },
      posiciones: async () => abiertas,
      cierreDe: async () => (ig.nivelCierre == null ? null : { nivel: ig.nivelCierre }),
      cuenta: async () => ({ saldo: 20000, disponible: 20000, moneda: 'EUR' }),
    },
    ordenes,
    quitarPosiciones: () => { abiertas = [] },
  }
  return ig
}

// El diario del DAX: 30 sesiones de septiembre y octubre de 4 puntos de rango verdadero, así que
// N = 4 (se añade cada 2 puntos y el stop va a 8 de la última). La de hoy, a medio hacer, no cuenta
const DIARIO_DAX = [
  ...Array.from({ length: 30 }, (_, i) => ({ date: new Date(Date.UTC(2026, 8, 20 + i)).toISOString().slice(0, 10), open: 25500, high: 25502, low: 25498, close: 25500 })),
  { date: '2026-11-05', open: 25500, high: 26000, low: 25000, close: 25500 },
]

function botDePrueba(ig, { avisar, velasDiarias = async () => DIARIO_DAX } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-fbn-'))
  let t = 0
  ig.reloj = () => t
  const bot = crearBot({ ig, archivo: join(dir, 'bot.json'), ahora: () => t, log: () => {}, revisarCadaMs: 0, avisar, estrategia: FIRST_BAR_NEGATIVE, velasDiarias })
  bot.cambiarConfig({ activo: true, instrumentos: { '^N225': false, '^GDAXI': true, '^NDX': false, '^GSPC': false, '^DJI': false } })
  return { bot, dir, enHora: x => { t = x } }
}
const vela1m = (time, open, high, low, close) => registrarVela('ig', '^GDAXI', { time, open, high, low, close })
const apunte = bot => {
  const { hoy, historial } = bot.estado()
  return hoy.find(d => d.ticker === '^GDAXI') ?? historial.find(d => d.ticker === '^GDAXI')
}

// La primera vela de la sesión, de 25521 a 25479 (42 puntos) y cerrando en negativo
function mananaNegra(dia) {
  const primera = [[25515, 25521, 25510, 25512], [25512, 25513, 25500, 25505], [25505, 25506, 25490, 25495], [25495, 25498, 25485, 25490], [25490, 25492, 25479, 25485]]
  primera.forEach(([o, h, l, c], m) => vela1m(utc(dia, 8, m), o, h, l, c))
}

test('una sesión del DAX: vende al perder el mínimo, añade cada ½ N y sale en el stop a 2 N', async () => {
  const avisos = []
  const precios = { '^GDAXI': [25500, 25501] }
  const ig = igFalso({ precios })
  const { bot, dir, enHora } = botDePrueba(ig, { avisar: x => avisos.push(x) })
  const bajar = async (m, bid) => {
    precios['^GDAXI'] = [bid, bid + 1]
    vela1m(utc(5, 8, m), bid + 2, bid + 3, bid, bid)
    enHora(utc(5, 8, m, 10)); await bot._paso()
    return apunte(bot)
  }
  try {
    mananaNegra(5)
    enHora(utc(5, 8, 5, 4)); await bot._paso()
    let d = apunte(bot)
    assert.deepEqual(d.bracket, { high: 25521, low: 25479, rango: 42, vela: utc(5, 8) })
    assert.equal(d.n, 4)
    assert.equal(d.estado, 'esperando-rotura')
    assert.match(d.eventos.at(-1).texto, /N = 4\.0: añade cada 2\.0 puntos y lleva el stop a 8\.0 de la última/)
    assert.equal(d.plan.tamano, 4.7)                       // 200 € entre 42 puntos a 1 €/punto

    d = await bajar(6, 25478)                              // pierde el mínimo: venta a 25478
    assert.equal(d.operacion.lado, 'corto')
    const entrada = ig.ordenes.find(o => o.tipo === 'abrir')
    assert.equal(entrada.stop, 25521)                      // el stop, en el máximo de la vela
    assert.match(entrada.referencia, /^FBN-GDAXI-20261105-/)

    d = await bajar(7, 25475)                              // ½ N (2 puntos) más abajo: añade, y el stop a 25475 + 8
    assert.equal(d.operacion.unidades.length, 2)
    assert.equal(d.operacion.stop, 25483)
    assert.equal(d.operacion.stopMovido, true)
    d = await bajar(8, 25472)                              // otro ½ N, pero en el mismo tramo de 5 min
    assert.equal(d.operacion.unidades.length, 2)
    d = await bajar(10, 25472)                             // ya en otro tramo: cuenta desde la última (25475)
    assert.equal(d.operacion.unidades.length, 3)
    assert.equal(d.operacion.stop, 25480)
    assert.deepEqual(ig.ordenes.filter(o => o.tipo === 'stop').map(o => [o.dealId, o.stop]), [['D1', 25483], ['D1', 25480], ['D2', 25480]])

    // salta el stop de las tres
    ig.quitarPosiciones()
    ig.nivelCierre = 25480
    enHora(utc(5, 8, 20, 5)); await bot._paso()
    d = apunte(bot)
    assert.equal(d.estado, 'terminado')
    assert.equal(d.salida.motivo, 'stopN')
    assert.equal(d.resultadoPts, -2 - 5 - 8)
    assert.ok(avisos.every(a => a.startsWith('First bar negative · ')))

    // la pestaña Bot pasa por el backtest las velas que guarda el bot con la N del día, y ve la
    // misma venta y los mismos añadidos
    const aVelas = filas => filas.map(([time, open, high, low, close]) => ({ time, open, high, low, close }))
    const c = d.config
    const a = analizarSesion({
      velas: aVelas(d.velas), n: d.n, ticker: d.ticker, ventana: d.ventana,
      modo: c.modo, colorBracket: c.colorBracket, piramideN: { pasoN: c.piramide, stopN: c.stopN },
    })
    assert.equal(a.lado, 'corto')
    assert.equal(a.entrada.precio, 25479)
    assert.equal(a.anadidos.length, 2)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('si la primera vela cierra en positivo, ese día no opera', async () => {
  const ig = igFalso()
  const { bot, dir, enHora } = botDePrueba(ig)
  try {
    const primera = [[25485, 25490, 25479, 25488], [25488, 25500, 25486, 25498], [25498, 25510, 25495, 25505], [25505, 25521, 25500, 25515], [25515, 25518, 25508, 25512]]
    primera.forEach(([o, h, l, c], m) => vela1m(utc(6, 8, m), o, h, l, c))
    enHora(utc(6, 8, 5, 4)); await bot._paso()
    vela1m(utc(6, 8, 6), 25480, 25481, 25470, 25471)       // pierde el mínimo, pero da igual
    enHora(utc(6, 8, 6, 10)); await bot._paso()
    const d = apunte(bot)
    assert.equal(d.estado, 'sin-operar')
    assert.match(d.eventos.at(-1).texto, /cierra en positivo/)
    assert.equal(ig.ordenes.length, 0)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('sin el diario no hay N: opera la entrada pero no añade', async () => {
  const precios = { '^GDAXI': [25500, 25501] }
  const ig = igFalso({ precios })
  const { bot, dir, enHora } = botDePrueba(ig, { velasDiarias: async () => { throw new Error('Yahoo no contesta') } })
  try {
    const primera = [[25515, 25521, 25510, 25512], [25512, 25513, 25500, 25505], [25505, 25506, 25490, 25495], [25495, 25498, 25485, 25490], [25490, 25492, 25479, 25485]]
    primera.forEach(([o, h, l, c], m) => vela1m(utc(9, 8, m), o, h, l, c))
    enHora(utc(9, 8, 5, 4)); await bot._paso()
    let d = apunte(bot)
    assert.equal(d.n, null)
    assert.ok(d.eventos.some(e => e.texto === 'Sin N (Yahoo no contesta): hoy la pierna no añade'))

    precios['^GDAXI'] = [25478, 25479]
    vela1m(utc(9, 8, 6), 25480, 25481, 25478, 25478)
    enHora(utc(9, 8, 6, 10)); await bot._paso()
    precios['^GDAXI'] = [25400, 25401]
    vela1m(utc(9, 8, 10), 25410, 25411, 25400, 25400)       // muy a favor: con N habría añadido
    enHora(utc(9, 8, 10, 10)); await bot._paso()
    d = apunte(bot)
    assert.equal(d.operacion.unidades.length, 1)
    assert.equal(ig.ordenes.filter(o => o.tipo === 'abrir').length, 1)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('la configuración no deja comprar', () => {
  const ig = igFalso()
  const { bot, dir } = botDePrueba(ig)
  try {
    assert.throws(() => bot.cambiarConfig({ modo: 'ambos' }), /Modo no válido: corto/)
    assert.equal(bot.cambiarConfig({ modo: 'corto', piramide: null }).piramide, null)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})
