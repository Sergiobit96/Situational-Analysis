// Tests del bot SRS (server/bot-srs.js) contra un IG de mentira y con un reloj que se
// mueve a mano: se recorren sesiones enteras sin mandar ninguna orden de verdad
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { siguientePaso, nivelStop, crearBot, sesionDe, proximaApertura, tamanoPorRiesgo, riesgoDeCuenta, CONFIG_INICIAL } from '../server/bot-srs.js'
import { buscarCierre, crearIG } from '../server/ig.js'
import { registrarVela } from '../server/tiempo-real.js'
import { offsetZona } from '../server/zonas.js'

// Hora local de una bolsa en un día de octubre (o del mes que se diga) de 2026 → instante UTC en segundos
const en = (zona, mes = 9) => (dia, h, m = 0, s = 0) => {
  const aprox = Date.UTC(2026, mes, dia, h, m, s) / 1000
  return aprox - offsetZona(aprox - offsetZona(aprox, zona), zona)
}
const madrid = en('Europe/Madrid')
const nuevaYork = en('America/New_York')
const tokio = en('Asia/Tokyo')
// las pruebas del flip y la pirámide van en noviembre: las velas de 1 min en directo se
// guardan en orden y una más vieja que la última del instrumento no entraría
const madridNov = en('Europe/Madrid', 10)
const utc = (dia, h, m = 0) => Date.UTC(2026, 9, dia, h, m) / 1000

// ── Las sesiones, en la hora de cada bolsa ──

test('cada sesión abre a la hora de su bolsa', () => {
  // lunes 19-oct-2026: Madrid y Fráncfort en verano (UTC+2), Nueva York en verano (UTC-4)
  assert.equal(sesionDe('^GDAXI', utc(19, 12)).abre, utc(19, 7))           // 09:00 en Fráncfort
  assert.equal(sesionDe('^NDX', utc(19, 12)).abre, utc(19, 13, 30))        // 09:30 en Nueva York = 15:30 en Madrid
  assert.equal(sesionDe('^N225', utc(19, 3)).abre, utc(19, 0))             // 09:00 en Tokio
  const dax = sesionDe('^GDAXI', utc(19, 12))
  assert.equal(dax.finBracket, utc(19, 7, 30))
  assert.equal(dax.cierra, utc(19, 15, 30))                                // 17:30 en Fráncfort
})

test('la semana en que Europa ya ha cambiado de hora y Nueva York no, Nueva York abre a las 14:30 de Madrid', () => {
  // lunes 26-oct-2026: Europa en invierno (UTC+1) y Nueva York aún en verano (UTC-4)
  assert.equal(sesionDe('^GDAXI', utc(26, 12)).abre, utc(26, 8))          // 09:00 en Fráncfort = 08:00 UTC
  assert.equal(sesionDe('^NDX', utc(26, 15)).abre, utc(26, 13, 30))        // 09:30 en Nueva York = 14:30 en Madrid
  assert.equal(sesionDe('^GSPC', utc(26, 15)).abre, madrid(26, 14, 30))
})

test('en fin de semana no hay sesión, y la próxima es la del lunes', () => {
  assert.equal(sesionDe('^GDAXI', utc(24, 12)), null)                      // sábado
  assert.equal(proximaApertura('^N225', utc(24, 12)), utc(26, 0))          // lunes 09:00 en Tokio
  assert.equal(proximaApertura('^GDAXI', utc(24, 12)), utc(26, 8))
})

// ── El tamaño por riesgo ──

test('el tamaño sale del riesgo en euros, y se respeta el mínimo de IG sin arriesgar más del doble', () => {
  // DAX: 40 puntos de riesgo a 1 €/punto → 400 € son 10 contratos
  assert.deepEqual(tamanoPorRiesgo({ riesgoEur: 400, riesgoPts: 40, valorPunto: 1, cambioAEur: 1, tamanoMin: 0.5 }), { ok: true, tamano: 10, riesgoEur: 400 })
  // Dow: 120 puntos a 10 $/punto (1 $ = 0,89 €) → el mínimo 0,2 arriesga 213,6 €, menos del doble de 400
  const dow = tamanoPorRiesgo({ riesgoEur: 400, riesgoPts: 120, valorPunto: 10, cambioAEur: 0.89, tamanoMin: 0.2 })
  assert.equal(dow.ok, true)
  assert.equal(dow.tamano, 0.3)
  // Nasdaq de 100 $: el mínimo arriesga 1.068 €, más del doble de 400 → no
  const ndx = tamanoPorRiesgo({ riesgoEur: 400, riesgoPts: 60, valorPunto: 100, cambioAEur: 0.89, tamanoMin: 0.2 })
  assert.equal(ndx.ok, false)
  assert.match(ndx.motivo, /arriesgaría 1068 €/)
  assert.equal(tamanoPorRiesgo({ riesgoEur: 400, riesgoPts: 0, valorPunto: 1, cambioAEur: 1 }).ok, false)
})

test('lo que se arriesga es un % del saldo de la cuenta, un 2,5% si no se dice otra cosa', () => {
  assert.equal(CONFIG_INICIAL.riesgoPct, 2.5)
  assert.equal(riesgoDeCuenta(20000, 2.5), 500)
  assert.equal(riesgoDeCuenta(18400, 2), 368)
  assert.equal(riesgoDeCuenta(null, 2.5), null)
  assert.equal(riesgoDeCuenta(0, 2.5), null)
})

// ── La decisión ──

const sesDax = sesionDe('^GDAXI', utc(19, 12))

test('antes de que acabe la vela del bracket no hace nada; después pide el bracket', () => {
  const cfg = { ...CONFIG_INICIAL, activo: true }
  const dia = { estado: 'esperando-bracket', bracket: null }
  assert.equal(siguientePaso({ dia, cfg, ahora: madrid(19, 9, 29, 50), velas: [], ses: sesDax }).accion, 'nada')
  assert.equal(siguientePaso({ dia, cfg, ahora: madrid(19, 9, 30, 5), velas: [], ses: sesDax }).accion, 'bracket')
  assert.equal(siguientePaso({ dia, cfg: { ...cfg, activo: false }, ahora: madrid(19, 9, 30, 5), velas: [], ses: sesDax }).accion, 'nada')
})

test('entra al romper el bracket, por arriba o, en modo ambos, por abajo', () => {
  const dia = { estado: 'esperando-rotura', bracket: { high: 100, low: 90, rango: 10 } }
  const vela = (high, low) => [{ time: madrid(19, 9, 41), open: 95, high, low, close: 95 }]
  const ambos = { ...CONFIG_INICIAL, activo: true, modo: 'ambos' }
  const ahora = madrid(19, 9, 41, 20)
  assert.deepEqual(siguientePaso({ dia, cfg: ambos, ahora, velas: vela(100.5, 94), ses: sesDax }), { accion: 'entrar', lado: 'largo' })
  assert.deepEqual(siguientePaso({ dia, cfg: ambos, ahora, velas: vela(96, 89.5), ses: sesDax }), { accion: 'entrar', lado: 'corto' })
  assert.equal(siguientePaso({ dia, cfg: ambos, ahora, velas: vela(100, 90), ses: sesDax }).accion, 'nada')
  assert.equal(siguientePaso({ dia, cfg: { ...ambos, modo: 'largo' }, ahora, velas: vela(96, 89.5), ses: sesDax }).accion, 'nada')
  const vieja = [{ time: madrid(19, 9, 20), open: 95, high: 120, low: 80, close: 95 }]
  assert.equal(siguientePaso({ dia, cfg: ambos, ahora, velas: vieja, ses: sesDax }).accion, 'nada')
})

test('el stop va al otro lado del bracket, o a la mitad', () => {
  const b = { high: 100, low: 90, rango: 10 }
  assert.equal(nivelStop(b, 'largo', 1), 90)
  assert.equal(nivelStop(b, 'corto', 1), 100)
  assert.equal(nivelStop(b, 'largo', 0.5), 95)
})

test('al cierre cierra lo abierto y después guarda las velas de la sesión', () => {
  const cfg = { ...CONFIG_INICIAL, activo: true }
  const abierta = { estado: 'en-posicion', bracket: { high: 100, low: 90, rango: 10 }, operacion: { lado: 'largo', entrada: 100, riesgo: 10, hora: madrid(19, 10) }, salida: null }
  assert.deepEqual(siguientePaso({ dia: abierta, cfg, ahora: madrid(19, 17, 30, 2), velas: [], ses: sesDax }), { accion: 'cerrar', motivo: 'cierre' })
  assert.equal(siguientePaso({ dia: abierta, cfg, ahora: madrid(19, 12), velas: [], ses: sesDax }).accion, 'vigilar')
  assert.equal(siguientePaso({ dia: abierta, cfg: { ...cfg, activo: false }, ahora: madrid(19, 12), velas: [], ses: sesDax }).accion, 'vigilar')
  const cerrada = { ...abierta, estado: 'terminado', salida: { nivel: 105 } }
  assert.equal(siguientePaso({ dia: cerrada, cfg, ahora: madrid(19, 17, 31), velas: [], ses: sesDax }).accion, 'velas')
  assert.equal(siguientePaso({ dia: { ...cerrada, velas: [] }, cfg, ahora: madrid(19, 17, 31), velas: [], ses: sesDax }).accion, 'nada')
})

test('break even al recorrer beR veces el riesgo', () => {
  const cfg = { ...CONFIG_INICIAL, activo: true, beR: 1 }
  const dia = { estado: 'en-posicion', bracket: { high: 100, low: 90, rango: 10 }, operacion: { lado: 'largo', entrada: 100.5, riesgo: 10, hora: madrid(19, 9, 41), be: false }, salida: null }
  const vela = high => [{ time: madrid(19, 9, 50), open: 101, high, low: 100, close: 101 }]
  assert.equal(siguientePaso({ dia, cfg, ahora: madrid(19, 9, 50, 30), velas: vela(110), ses: sesDax }).accion, 'vigilar')
  assert.equal(siguientePaso({ dia, cfg, ahora: madrid(19, 9, 50, 30), velas: vela(110.5), ses: sesDax }).accion, 'breakeven')
})

test('una orden sin confirmar se reconcilia antes de nada', () => {
  const dia = { estado: 'entrando', bracket: { high: 100, low: 90, rango: 10 }, intento: { lado: 'largo', hora: madrid(19, 9, 41) } }
  assert.equal(siguientePaso({ dia, cfg: { ...CONFIG_INICIAL, activo: true }, ahora: madrid(19, 9, 41, 30), velas: [], ses: sesDax }).accion, 'reconciliar')
})

// ── El cierre en la actividad de IG (respuesta real de la demo del 18-oct-2026) ──

test('encuentra el cierre en la actividad de IG', () => {
  const actividades = [
    { date: '2026-10-18T11:15:55', description: 'Orden Límite abierta: N72525BM; ', details: { actions: [{ actionType: 'LIMIT_ORDER_OPENED', affectedDealId: 'DIAAAAYN72525BM' }], direction: 'SELL', level: 25462.8 } },
    { date: '2026-10-18T11:15:55', description: 'Stop/Límite modificado: N72525BM', details: { actions: [{ actionType: 'STOP_LIMIT_AMENDED', affectedDealId: 'DIAAAAYN72525BM' }], direction: 'BUY', level: 25478.8 } },
    { date: '2026-10-18T11:15:55', description: 'Posición abierta: N72525BM', details: { actions: [{ actionType: 'POSITION_OPENED', affectedDealId: 'DIAAAAYN72525BM' }], direction: 'BUY', level: 25478.8 } },
  ]
  assert.equal(buscarCierre(actividades, 'DIAAAAYN72525BM', 'largo').nivel, 25462.8)
  assert.equal(buscarCierre(actividades, 'OTRA', 'largo'), null)
  assert.equal(buscarCierre(actividades.slice(1), 'DIAAAAYN72525BM', 'largo'), null)
})

test('el candado: fuera de la demo no se manda ninguna orden', async () => {
  const llamadas = []
  const ig = crearIG({ apiKey: 'k', usuario: 'u', password: 'p', entorno: 'real', cacheDir: mkdtempSync(join(tmpdir(), 'ig-')), fetchFn: async (...a) => { llamadas.push(a); throw new Error('no debería llamar') } })
  await assert.rejects(ig.operar.abrir({ ticker: '^GDAXI', lado: 'largo', tamano: 1, stop: 1, moneda: 'EUR' }), /Solo se opera en la demo/)
  await assert.rejects(ig.operar.cerrar({ ticker: '^GDAXI', dealId: 'x', lado: 'largo', tamano: 1 }), /Solo se opera en la demo/)
  await assert.rejects(ig.operar.moverStop({ ticker: '^GDAXI', dealId: 'x', stop: 1 }), /Solo se opera en la demo/)
  assert.equal(llamadas.length, 0)
})

// ── El bot entero, con un IG de mentira ──

// Mercados de mentira: precio, valor del punto y si la cuenta tiene precio (= puede operarlo)
const MERCADOS = {
  'IX.D.DAX.IFMM.IP':    { ticker: '^GDAXI', valorPunto: 1,   moneda: 'EUR', cambioAEur: 1,    tamanoMin: 0.5, conPrecio: true },
  'IX.D.NASDAQ.IFMM.IP': { ticker: '^NDX',   valorPunto: 1,   moneda: 'USD', cambioAEur: 0.89, tamanoMin: 0.2, conPrecio: false },
  'IX.D.NASDAQ.IFD.IP':  { ticker: '^NDX',   valorPunto: 100, moneda: 'USD', cambioAEur: 0.89, tamanoMin: 0.2, conPrecio: true },
  'IX.D.NIKKEI.IFD.IP':  { ticker: '^N225',  valorPunto: 5,   moneda: 'USD', cambioAEur: 0.89, tamanoMin: 0.5, conPrecio: true },
}

// Un IG que apunta lo que se le pide y contesta lo que diga cada prueba. `velas` por
// instrumento: la del bracket (por su hora) y las de después
function igFalso({ velas = {}, precios = {}, saldo = 20000, disponible = 20000, aMercado = true }) {
  const ordenes = []
  let abiertas = []
  let n = 0
  const ig = {
    velasEntre: async (ticker, tf, desde, hasta) => (velas[ticker] ?? []).filter(v => v.time >= desde && v.time < hasta),
    operar: {
      datosMercado: async (ticker, epic) => {
        const m = MERCADOS[epic] ?? MERCADOS['IX.D.DAX.IFMM.IP']
        const [bid, oferta] = precios[ticker] ?? [25500, 25501]
        return { epic, ...m, stopMin: 5, estado: 'TRADEABLE', bid: m.conPrecio ? bid : null, oferta: m.conPrecio ? oferta : null, aMercado }
      },
      abrir: async o => {
        ordenes.push({ tipo: 'abrir', ...o })
        const [bid, oferta] = precios[o.ticker] ?? [25500, 25501]
        const nivel = o.lado === 'largo' ? oferta : bid
        const p = { dealId: `D${++n}`, ticker: o.ticker, epic: o.epic, lado: o.lado, tamano: o.tamano, nivel, stop: o.stop, referencia: o.referencia, abierta: new Date(ig.reloj() * 1000).toISOString().slice(0, 19) }
        abiertas.push(p)
        if (ig.fallarAlAbrir) throw new Error('fetch failed')
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
      cierreDe: async () => ig.nivelCierre == null ? null : { nivel: ig.nivelCierre },
      cuenta: async () => ({ saldo, disponible, moneda: 'EUR' }),
    },
    ordenes,
    quitarPosiciones: () => { abiertas = [] },
    ponerPosicion: p => { abiertas.push(p) },
  }
  return ig
}

function botDePrueba(ig, cambios = {}, { avisar } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-'))
  let t = 0
  ig.reloj = () => t
  const bot = crearBot({ ig, archivo: join(dir, 'Bot SRS.json'), ahora: () => t, log: () => {}, revisarCadaMs: 0, avisar })
  bot.cambiarConfig({ activo: true, ...cambios })
  return { bot, dir, enHora: x => { t = x }, archivo: join(dir, 'Bot SRS.json') }
}
const vela1m = (ticker, time, high, low, close = (high + low) / 2) => registrarVela('ig', ticker, { time, open: close, high, low, close })
const vela15 = (time, open, high, low, close) => ({ time, open, high, low, close })
const soloDax = { instrumentos: { '^N225': false, '^GDAXI': true, '^NDX': false, '^GSPC': false, '^DJI': false } }
const apunte = (bot, ticker) => bot.estado().hoy.find(d => d.ticker === ticker)

test('una sesión del DAX entera: bracket, plan, rotura, cierre a las 17:30 y velas guardadas', async () => {
  const sesion = Array.from({ length: 34 }, (_, i) => {
    const time = madrid(19, 9, 0) + i * 900
    if (i === 0) return vela15(time, 25470, 25485, 25455, 25480)
    if (i === 1) return vela15(time, 25480, 25500, 25460, 25490)
    return vela15(time, 25510, 25530, 25505, 25520)
  })
  const ig = igFalso({ velas: { '^GDAXI': sesion }, precios: { '^GDAXI': [25502, 25503] } })
  const { bot, dir, enHora, archivo } = botDePrueba(ig, { ...soloDax, riesgoPct: 2 })
  try {
    enHora(madrid(19, 9, 30, 4)); await bot._paso()
    let hoy = apunte(bot, '^GDAXI')
    assert.deepEqual(hoy.bracket, { high: 25500, low: 25460, rango: 40, vela: madrid(19, 9, 15) })
    assert.equal(hoy.estado, 'esperando-rotura')
    // 400 € / 40 puntos a 1 €/punto = 10 contratos, pero el margen (10 × 25.490 × 5% = 12.745 €)
    // pasa del 40% de 20.000 €: se recorta a 6,2
    assert.equal(hoy.plan.epic, 'IX.D.DAX.IFMM.IP')
    assert.equal(hoy.plan.tamano, 6.2)

    vela1m('^GDAXI', madrid(19, 9, 41), 25502, 25495)
    enHora(madrid(19, 9, 41, 10)); await bot._paso()
    hoy = apunte(bot, '^GDAXI')
    assert.equal(hoy.estado, 'en-posicion')
    const abrir = ig.ordenes.find(o => o.tipo === 'abrir')
    assert.equal(abrir.lado, 'largo')
    assert.equal(abrir.stop, 25460)
    assert.equal(abrir.tamano, 6.2)
    assert.equal(abrir.limite, null)                      // a mercado
    assert.match(abrir.referencia, /^SRS-GDAXI-20261019-/)
    assert.equal(hoy.operacion.deslizamiento, 3)

    vela1m('^GDAXI', madrid(19, 9, 42), 25510, 25500)
    enHora(madrid(19, 9, 42, 10)); await bot._paso()
    assert.equal(ig.ordenes.filter(o => o.tipo === 'abrir').length, 1)

    enHora(madrid(19, 17, 30, 3)); await bot._paso()
    hoy = apunte(bot, '^GDAXI')
    assert.equal(hoy.estado, 'terminado')
    assert.equal(hoy.salida.motivo, 'cierre')
    assert.equal(ig.ordenes.find(o => o.tipo === 'cerrar').limite, null)
    assert.equal(hoy.resultadoPts, 25502 - 25503)
    assert.ok(Math.abs(hoy.resultadoEur - (-1 * 6.2)) < 1e-9)

    enHora(madrid(19, 17, 31)); await bot._paso()
    hoy = apunte(bot, '^GDAXI')
    assert.equal(hoy.velas.length, 34)
    assert.deepEqual(hoy.ventana, { open: 9 * 60, close: 17 * 60 + 30, minutosVela: 15, nBracket: 2 })

    const guardado = JSON.parse(readFileSync(archivo, 'utf8'))
    assert.equal(guardado.dias['2026-10-19 ^GDAXI'].estado, 'terminado')
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('el plan arriesga el 2,5% del saldo entre los puntos hasta el stop, y sin saldo no se opera', async () => {
  const bracket = [vela15(madrid(30, 9, 0), 25470, 25485, 25455, 25480), vela15(madrid(30, 9, 15), 25480, 25500, 25460, 25490)]   // 40 puntos
  // con margen de sobra: 2,5% de 20.000 € = 500 € / 40 puntos a 1 €/punto = 12,5 contratos
  const ig = igFalso({ velas: { '^GDAXI': bracket }, saldo: 20000, disponible: 100000 })
  const { bot, dir, enHora } = botDePrueba(ig, soloDax)
  try {
    enHora(madrid(30, 9, 30, 4)); await bot._paso()
    const hoy = apunte(bot, '^GDAXI')
    assert.equal(hoy.config.riesgoPct, 2.5)
    assert.equal(hoy.plan.tamano, 12.5)
    assert.equal(hoy.plan.riesgoEur, 500)
    assert.equal(hoy.plan.saldo, 20000)
    assert.ok(hoy.eventos.some(e => /el 2,5% de 20\.000 € son 500 €/.test(e.texto)))
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }

  const sinSaldo = igFalso({ velas: { '^GDAXI': bracket }, saldo: null })
  const b = botDePrueba(sinSaldo, soloDax)
  try {
    b.enHora(madrid(30, 9, 30, 4)); await b.bot._paso()
    const hoy = apunte(b.bot, '^GDAXI')
    assert.equal(hoy.estado, 'sin-operar')
    assert.match(hoy.eventos.at(-1).texto, /saldo/)
  } finally { b.bot.parar(); rmSync(b.dir, { recursive: true, force: true }) }
})

test('el riesgo se cambia en % de la cuenta, entre el 0,1% y el 10%', () => {
  const ig = igFalso({})
  const { bot, dir } = botDePrueba(ig, soloDax)
  try {
    assert.equal(bot.cambiarConfig({ riesgoPct: 1.5 }).riesgoPct, 1.5)
    assert.throws(() => bot.cambiarConfig({ riesgoPct: 25 }), /10%/)
    assert.throws(() => bot.cambiarConfig({ riesgoPct: 0 }), /0,1%/)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('donde IG no admite órdenes a mercado, entra con límite a un cuarto del bracket del nivel, y sale con ese margen', async () => {
  const sesion = [
    vela15(madrid(19, 9, 0), 25470, 25485, 25455, 25480),
    vela15(madrid(19, 9, 15), 25480, 25500, 25460, 25490),   // bracket de 40 puntos
  ]
  const ig = igFalso({ velas: { '^GDAXI': sesion }, precios: { '^GDAXI': [25503, 25504] }, aMercado: false })
  const { bot, dir, enHora } = botDePrueba(ig, { ...soloDax, riesgoPct: 2 })
  try {
    enHora(madrid(19, 9, 30, 4)); await bot._paso()
    vela1m('^GDAXI', madrid(19, 9, 41), 25502, 25495)
    enHora(madrid(19, 9, 41, 10)); await bot._paso()
    assert.equal(ig.ordenes.find(o => o.tipo === 'abrir').limite, 25500 + 0.25 * 40)
    enHora(madrid(19, 17, 30, 3)); await bot._paso()
    assert.equal(ig.ordenes.find(o => o.tipo === 'cerrar').limite, 25503 - 0.25 * 40)
    assert.equal(apunte(bot, '^GDAXI').estado, 'terminado')
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('en Nueva York, si el contrato pequeño no tiene precio para la cuenta, prueba el grande, y si no cabe en el riesgo no entra', async () => {
  const bracket = vela15(nuevaYork(20, 9, 45), 29200, 29230, 29170, 29210)   // 60 puntos
  const ig = igFalso({ velas: { '^NDX': [bracket] }, precios: { '^NDX': [29230, 29231] } })
  const { bot, dir, enHora } = botDePrueba(ig, { instrumentos: { '^N225': false, '^GDAXI': false, '^NDX': true, '^GSPC': false, '^DJI': false }, riesgoPct: 2 })
  try {
    enHora(nuevaYork(20, 10, 0, 5)); await bot._paso()
    const hoy = apunte(bot, '^NDX')
    assert.equal(hoy.estado, 'sin-operar')
    assert.match(hoy.eventos.at(-1).texto, /IX\.D\.NASDAQ\.IFMM\.IP sin precio.*IX\.D\.NASDAQ\.IFD\.IP: el mínimo de IG \(0\.2\) arriesgaría 1068 €/)
    assert.equal(ig.ordenes.length, 0)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('Tokio: el bracket es la vela de 09:15 a 09:30 de Tokio, que en Madrid es de madrugada', async () => {
  const bracket = vela15(tokio(21, 9, 15), 63400, 63500, 63300, 63450)   // 200 puntos
  const ig = igFalso({ velas: { '^N225': [bracket] }, precios: { '^N225': [63499, 63505] } })
  const { bot, dir, enHora } = botDePrueba(ig, { instrumentos: { '^N225': true, '^GDAXI': false, '^NDX': false, '^GSPC': false, '^DJI': false }, riesgoPct: 2 })
  try {
    enHora(tokio(21, 9, 30, 5)); await bot._paso()
    const hoy = apunte(bot, '^N225')
    assert.equal(hoy.fecha, '2026-10-21')
    assert.equal(hoy.estado, 'esperando-rotura')
    // 400 € / (200 puntos × 5 $ × 0,89) = 0,449 → por debajo del mínimo 0,5, que arriesga 445 € (menos del doble)
    assert.equal(hoy.plan.tamano, 0.5)
    vela1m('^N225', tokio(21, 9, 40), 63501, 63490)
    enHora(tokio(21, 9, 40, 5)); await bot._paso()
    assert.equal(apunte(bot, '^N225').estado, 'en-posicion')
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('sin flip, si salta el stop en IG, lo ve al revisar, lo apunta a su precio y la sesión termina', async () => {
  const ig = igFalso({ velas: { '^GDAXI': [vela15(madrid(20, 9, 15), 25480, 25500, 25460, 25490)] }, precios: { '^GDAXI': [25499, 25500] } })
  const { bot, dir, enHora } = botDePrueba(ig, { ...soloDax, modo: 'ambos' })
  try {
    enHora(madrid(20, 9, 30, 4)); await bot._paso()
    vela1m('^GDAXI', madrid(20, 9, 35), 25501, 25498)
    enHora(madrid(20, 9, 35, 5)); await bot._paso()
    ig.quitarPosiciones()
    ig.nivelCierre = 25459
    enHora(madrid(20, 11)); await bot._paso()
    const hoy = apunte(bot, '^GDAXI')
    assert.equal(hoy.estado, 'terminado')
    assert.equal(hoy.salida.motivo, 'stop')
    assert.equal(hoy.resultadoPts, 25459 - 25500)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('si arranca tarde y la rotura ya pasó, no entra', async () => {
  const velas = [vela15(madrid(21, 9, 15), 25480, 25500, 25460, 25490), vela15(madrid(21, 9, 30), 25490, 25510, 25480, 25505)]
  const ig = igFalso({ velas: { '^GDAXI': velas } })
  const { bot, dir, enHora } = botDePrueba(ig, soloDax)
  try {
    enHora(madrid(21, 11, 0)); await bot._paso()
    const hoy = apunte(bot, '^GDAXI')
    assert.equal(hoy.estado, 'sin-operar')
    assert.match(hoy.eventos.at(-1).texto, /con el bot parado/)
    assert.equal(ig.ordenes.length, 0)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('si la confirmación no llega, no repite la orden: adopta la posición que hay en IG', async () => {
  const ig = igFalso({ velas: { '^GDAXI': [vela15(madrid(22, 9, 15), 25480, 25500, 25460, 25490)] } })
  ig.fallarAlAbrir = true
  const { bot, dir, enHora } = botDePrueba(ig, soloDax)
  try {
    enHora(madrid(22, 9, 30, 4)); await bot._paso()
    vela1m('^GDAXI', madrid(22, 9, 36), 25503, 25499)
    enHora(madrid(22, 9, 36, 5))
    await assert.rejects(bot._paso(), /fetch failed/)
    assert.equal(apunte(bot, '^GDAXI').estado, 'entrando')
    enHora(madrid(22, 9, 36, 10)); await bot._paso()
    const hoy = apunte(bot, '^GDAXI')
    assert.equal(hoy.estado, 'en-posicion')
    assert.equal(hoy.operacion.dealId, 'D1')
    assert.equal(ig.ordenes.filter(o => o.tipo === 'abrir').length, 1)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('un bracket más grande que el límite (en % del precio) deja la sesión sin operar', async () => {
  const ig = igFalso({ velas: { '^GDAXI': [vela15(madrid(23, 9, 15), 25480, 25700, 25460, 25490)] } })   // 240 puntos = 0,94%
  const { bot, dir, enHora } = botDePrueba(ig, { ...soloDax, rangoMaxPct: 0.8 })
  try {
    enHora(madrid(23, 9, 30, 4)); await bot._paso()
    assert.equal(apunte(bot, '^GDAXI').estado, 'sin-operar')
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('con break even en 1R mueve el stop a la entrada una sola vez', async () => {
  const ig = igFalso({ velas: { '^GDAXI': [vela15(madrid(26, 9, 15), 25480, 25500, 25460, 25490)] }, precios: { '^GDAXI': [25499, 25500] } })
  const { bot, dir, enHora } = botDePrueba(ig, { ...soloDax, beR: 1 })
  try {
    enHora(madrid(26, 9, 30, 4)); await bot._paso()
    vela1m('^GDAXI', madrid(26, 9, 31), 25501, 25499)
    enHora(madrid(26, 9, 31, 5)); await bot._paso()
    vela1m('^GDAXI', madrid(26, 9, 50), 25545, 25530)
    enHora(madrid(26, 9, 50, 5)); await bot._paso()
    enHora(madrid(26, 9, 50, 10)); await bot._paso()
    const stops = ig.ordenes.filter(o => o.tipo === 'stop')
    assert.equal(stops.length, 1)
    assert.equal(stops[0].stop, 25500)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('si IG aún no ha apuntado el cierre, espera; si no lo apunta nunca, usa el stop y lo marca', async () => {
  const ig = igFalso({ velas: { '^GDAXI': [vela15(madrid(27, 9, 15), 25480, 25500, 25460, 25490)] }, precios: { '^GDAXI': [25499, 25500] } })
  const { bot, dir, enHora } = botDePrueba(ig, { ...soloDax, modo: 'ambos' })
  try {
    enHora(madrid(27, 9, 30, 4)); await bot._paso()
    vela1m('^GDAXI', madrid(27, 9, 33), 25501, 25498)
    enHora(madrid(27, 9, 33, 5)); await bot._paso()
    ig.quitarPosiciones()
    ig.nivelCierre = null
    enHora(madrid(27, 10, 0)); await bot._paso()
    assert.equal(apunte(bot, '^GDAXI').estado, 'en-posicion')
    for (let i = 1; i < 4; i++) { enHora(madrid(27, 10, i)); await bot._paso() }
    const hoy = apunte(bot, '^GDAXI')
    assert.equal(hoy.estado, 'terminado')
    assert.equal(hoy.salida.nivel, 25460)
    assert.equal(hoy.salida.aproximado, true)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('al arrancar recupera de IG una posición suya que el registro no tiene, y la cierra con la sesión', async () => {
  const ig = igFalso({ precios: { '^GDAXI': [25600, 25601] } })
  const { bot, dir, enHora } = botDePrueba(ig, soloDax)
  try {
    ig.ponerPosicion({ dealId: 'X9', ticker: '^GDAXI', epic: 'IX.D.DAX.IFMM.IP', lado: 'largo', tamano: 2, nivel: 25500, stop: 25460, referencia: 'SRS-GDAXI-20261028-abcd', abierta: new Date(madrid(28, 9, 40) * 1000).toISOString().slice(0, 19) })
    ig.ponerPosicion({ dealId: 'Y1', ticker: '^GDAXI', epic: 'IX.D.DAX.IFMM.IP', lado: 'largo', tamano: 1, nivel: 25000, stop: 24000, referencia: 'MANUAL', abierta: new Date(madrid(28, 9, 40) * 1000).toISOString().slice(0, 19) })
    enHora(madrid(28, 12)); await bot._recuperar()
    const hoy = apunte(bot, '^GDAXI')
    assert.equal(hoy.estado, 'en-posicion')
    assert.equal(hoy.operacion.dealId, 'X9')       // la manual (sin referencia SRS-) no es suya
    assert.equal(hoy.recuperada, true)
    enHora(madrid(28, 17, 30, 5)); await bot._paso()
    assert.equal(apunte(bot, '^GDAXI').salida.motivo, 'cierre')
    assert.deepEqual(ig.ordenes.map(o => [o.tipo, o.dealId]), [['cerrar', 'X9']])
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('una posición que quedó abierta de una sesión anterior se cierra en cuanto el bot la ve', async () => {
  const ig = igFalso({ precios: { '^GDAXI': [25600, 25601] } })
  const { bot, dir, enHora } = botDePrueba(ig, soloDax)
  try {
    ig.ponerPosicion({ dealId: 'Z1', ticker: '^GDAXI', epic: 'IX.D.DAX.IFMM.IP', lado: 'largo', tamano: 1, nivel: 25500, stop: 25460, referencia: 'SRS-GDAXI-20261029-zz', abierta: new Date(madrid(29, 9, 40) * 1000).toISOString().slice(0, 19) })
    enHora(madrid(30, 8)); await bot._recuperar()      // al día siguiente, antes de abrir
    await bot._paso()
    const viejo = bot._datos().dias['2026-10-29 ^GDAXI']
    assert.equal(viejo.salida.motivo, 'cierre')
    assert.deepEqual(ig.ordenes.map(o => [o.tipo, o.dealId]), [['cerrar', 'Z1']])
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('un instrumento con un error no tumba a los demás', async () => {
  // 30-oct-2026: Nueva York abre a las 14:30 de Madrid, con el DAX aún abierto
  const ig = igFalso({
    velas: { '^GDAXI': [vela15(madrid(30, 9, 15), 25480, 25500, 25460, 25490)] },
    precios: { '^GDAXI': [25499, 25500] },
  })
  const original = ig.velasEntre
  ig.velasEntre = async (ticker, ...resto) => { if (ticker === '^NDX') throw new Error('IG caído para el Nasdaq'); return original(ticker, ...resto) }
  const { bot, dir, enHora } = botDePrueba(ig, { instrumentos: { '^N225': false, '^GDAXI': true, '^NDX': true, '^GSPC': false, '^DJI': false } })
  try {
    enHora(nuevaYork(30, 10, 0, 5))
    await assert.rejects(bot._paso(), /Nasdaq/)
    assert.equal(apunte(bot, '^GDAXI').estado, 'esperando-rotura')
    assert.match(apunte(bot, '^NDX').eventos.at(-1).texto, /Error: IG caído para el Nasdaq/)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

// ── Flip the switch, pirámide, tope de deslizamiento y avisos ──

test('con flip solo mira el stop con el precio de ahora: una vela que lo pasó antes de entrar no cuenta', () => {
  const cfg = { ...CONFIG_INICIAL, activo: true }
  const op = { lado: 'largo', entrada: 100.5, stop: 90, riesgo: 10, hora: madrid(19, 9, 41, 30), be: false, unidades: [{}] }
  const dia = { estado: 'en-posicion', bracket: { high: 100, low: 90, rango: 10 }, operacion: op, salida: null }
  const vela = (low, close) => [{ time: madrid(19, 9, 41), open: 95, high: 101, low, close }]
  const ahora = madrid(19, 9, 41, 40)
  assert.equal(siguientePaso({ dia, cfg, ahora, velas: vela(89, 100.5), ses: sesDax }).accion, 'vigilar')
  assert.equal(siguientePaso({ dia, cfg, ahora, velas: vela(89, 89.5), ses: sesDax }).accion, 'revisar-ya')
  // con el stop ya en break even, o sin flip, no hay vuelta que esperar
  assert.equal(siguientePaso({ dia: { ...dia, operacion: { ...op, be: true } }, cfg, ahora, velas: vela(89, 89.5), ses: sesDax }).accion, 'vigilar')
  assert.equal(siguientePaso({ dia, cfg: { ...cfg, modo: 'ambos' }, ahora, velas: vela(89, 89.5), ses: sesDax }).accion, 'vigilar')
})

test('flip the switch: si salta el stop de la compra, vende en el mínimo con el stop en el máximo, y una sola vez', async () => {
  const precios = { '^GDAXI': [25501, 25502] }
  const ig = igFalso({ velas: { '^GDAXI': [vela15(madridNov(2, 9, 15), 25480, 25500, 25460, 25490)] }, precios })
  const avisos = []
  const { bot, dir, enHora } = botDePrueba(ig, soloDax, { avisar: t => avisos.push(t) })
  try {
    assert.equal(bot._datos().config.modo, 'flip')      // es lo que hace por defecto
    enHora(madridNov(2, 9, 30, 4)); await bot._paso()
    vela1m('^GDAXI', madridNov(2, 9, 41), 25503, 25495, 25502)
    enHora(madridNov(2, 9, 41, 10)); await bot._paso()
    assert.equal(apunte(bot, '^GDAXI').operacion.lado, 'largo')

    // el precio cae por debajo del mínimo; mientras IG no la cierra, el bot espera
    vela1m('^GDAXI', madridNov(2, 9, 50), 25470, 25455, 25458)
    enHora(madridNov(2, 9, 50, 5)); await bot._paso()
    assert.equal(apunte(bot, '^GDAXI').estado, 'en-posicion')
    // IG la cierra con su stop: la vuelta, en cuanto lo ve
    ig.quitarPosiciones()
    ig.nivelCierre = 25459
    precios['^GDAXI'] = [25457, 25458]
    enHora(madridNov(2, 9, 50, 8)); await bot._paso()
    assert.equal(apunte(bot, '^GDAXI').estado, 'esperando-vuelta')
    enHora(madridNov(2, 9, 50, 9)); await bot._paso()
    let hoy = apunte(bot, '^GDAXI')
    assert.equal(hoy.estado, 'en-posicion')
    const venta = ig.ordenes.filter(o => o.tipo === 'abrir')[1]
    assert.deepEqual([venta.lado, venta.stop, venta.tamano, venta.limite], ['corto', 25500, 6.2, null])
    assert.equal(hoy.operacion.entrada, 25457)
    assert.equal(hoy.anteriores[0].salida.nivel, 25459)
    assert.ok(avisos.some(t => t.startsWith('DAX · Flip the switch: venta')))

    // si salta también el stop de la venta, ya no hay más vueltas
    vela1m('^GDAXI', madridNov(2, 10, 30), 25505, 25490, 25503)
    ig.quitarPosiciones()
    ig.nivelCierre = 25501
    enHora(madridNov(2, 10, 30, 5)); await bot._paso()
    hoy = apunte(bot, '^GDAXI')
    assert.equal(hoy.estado, 'terminado')
    assert.equal(hoy.resultadoPts, (25459 - 25502) + (25457 - 25501))
    assert.ok(Math.abs(hoy.resultadoEur - hoy.resultadoPts * 6.2) < 1e-9)
    enHora(madridNov(2, 10, 30, 10)); await bot._paso()
    assert.equal(ig.ordenes.filter(o => o.tipo === 'abrir').length, 2)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('no da la vuelta si el precio ya se ha ido del nivel más del tope', async () => {
  const precios = { '^GDAXI': [25501, 25502] }
  const ig = igFalso({ velas: { '^GDAXI': [vela15(madridNov(3, 9, 15), 25480, 25500, 25460, 25490)] }, precios })
  const { bot, dir, enHora } = botDePrueba(ig, soloDax)
  try {
    enHora(madridNov(3, 9, 30, 4)); await bot._paso()
    vela1m('^GDAXI', madridNov(3, 9, 41), 25503, 25495, 25502)
    enHora(madridNov(3, 9, 41, 10)); await bot._paso()
    ig.quitarPosiciones()
    ig.nivelCierre = 25459
    precios['^GDAXI'] = [25440, 25441]     // 20 puntos por debajo del mínimo; el tope es 10
    vela1m('^GDAXI', madridNov(3, 9, 52), 25462, 25438, 25441)
    enHora(madridNov(3, 9, 52, 5)); await bot._paso()
    enHora(madridNov(3, 9, 52, 6)); await bot._paso()
    const hoy = apunte(bot, '^GDAXI')
    assert.equal(hoy.estado, 'terminado')
    assert.match(hoy.eventos.at(-1).texto, /20\.0 puntos más allá de 25460, y el tope es 10\.0: no se da la vuelta/)
    assert.equal(ig.ordenes.filter(o => o.tipo === 'abrir').length, 1)
    assert.equal(hoy.resultadoPts, 25459 - 25502)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('pirámide: una posición más por cada R a favor, como mucho una cada 5 min y hasta 5, con el stop de todas en su precio medio', async () => {
  const precios = { '^GDAXI': [25500, 25501] }
  const ig = igFalso({ velas: { '^GDAXI': [vela15(madridNov(4, 9, 15), 25480, 25500, 25460, 25490)] }, precios })
  const { bot, dir, enHora } = botDePrueba(ig, { ...soloDax, piramide: 1, tamanoAnadido: 1 })
  const subir = async (h, m, oferta) => {
    precios['^GDAXI'] = [oferta - 1, oferta]
    vela1m('^GDAXI', madridNov(4, h, m), oferta, oferta - 10, oferta - 1)
    enHora(madridNov(4, h, m, 5)); await bot._paso()
    return apunte(bot, '^GDAXI').operacion
  }
  try {
    enHora(madridNov(4, 9, 30, 4)); await bot._paso()
    vela1m('^GDAXI', madridNov(4, 9, 41), 25502, 25495, 25501)
    enHora(madridNov(4, 9, 41, 10)); await bot._paso()           // compra a 25501

    let op = await subir(9, 45, 25542)                             // +1R (nivel 25540): la segunda
    assert.equal(op.unidades.length, 2)
    assert.equal(op.stop, 25521.5)                                 // (25501 + 25542) / 2
    assert.deepEqual(ig.ordenes.filter(o => o.tipo === 'stop').map(o => [o.dealId, o.stop]), [['D1', 25521.5]])
    op = await subir(9, 46, 25582)                                 // +2R, pero en el mismo tramo de 5 min
    assert.equal(op.unidades.length, 2)
    op = await subir(9, 50, 25582)
    assert.equal(op.unidades.length, 3)
    op = await subir(9, 55, 25622)
    op = await subir(10, 0, 25662)
    assert.equal(op.unidades.length, 5)
    op = await subir(10, 5, 25702)                                 // +5R: ya hay 5, no añade más
    assert.equal(op.unidades.length, 5)
    assert.equal(ig.ordenes.filter(o => o.tipo === 'abrir').length, 5)
    assert.equal(op.stop, 25581.8)                                 // la media de las cinco

    // salta el stop de todas en el precio medio: la pierna sale a cero y, como es un break
    // even, no da la vuelta
    ig.quitarPosiciones()
    ig.nivelCierre = 25581.8
    enHora(madridNov(4, 10, 10, 5)); await bot._paso()
    const hoy = apunte(bot, '^GDAXI')
    assert.equal(hoy.estado, 'terminado')
    assert.equal(hoy.salida.motivo, 'breakeven')
    assert.ok(Math.abs(hoy.resultadoPts) < 1e-6)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('no entra si al romper el precio ya se ha ido del nivel más de un cuarto del bracket', async () => {
  const ig = igFalso({ velas: { '^GDAXI': [vela15(madridNov(5, 9, 15), 25480, 25500, 25460, 25490)] }, precios: { '^GDAXI': [25514, 25515] } })
  const { bot, dir, enHora } = botDePrueba(ig, soloDax)
  try {
    enHora(madridNov(5, 9, 30, 4)); await bot._paso()
    vela1m('^GDAXI', madridNov(5, 9, 33), 25516, 25498, 25514)
    enHora(madridNov(5, 9, 33, 5)); await bot._paso()
    const hoy = apunte(bot, '^GDAXI')
    assert.equal(hoy.estado, 'sin-operar')
    assert.match(hoy.eventos.at(-1).texto, /15\.0 puntos más allá de 25500, y el tope es 10\.0: hoy no se entra/)
    assert.equal(ig.ordenes.length, 0)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('avisa de lo que apunta y de los cambios de configuración, y de un error que se repite solo una vez', async () => {
  const ig = igFalso({})
  ig.velasEntre = async () => { throw new Error('IG caído') }
  const avisos = []
  const { bot, dir, enHora } = botDePrueba(ig, soloDax, { avisar: t => avisos.push(t) })
  try {
    assert.ok(avisos[0].startsWith('Bot encendido\n'))
    enHora(madridNov(6, 9, 30, 4))
    await assert.rejects(bot._paso(), /IG caído/)
    enHora(madridNov(6, 9, 30, 10))
    await assert.rejects(bot._paso(), /IG caído/)
    assert.equal(avisos.filter(t => t === 'DAX · Error: IG caído').length, 1)
    bot.cambiarConfig({ piramide: 2, tamanoAnadido: 1 })
    assert.equal(avisos.at(-1), 'Pirámide: una posición más cada 2R a favor, hasta 5\nCada añadido: una unidad entera')
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('flip the switch necesita el stop al otro lado del bracket', () => {
  const { bot, dir } = botDePrueba(igFalso({}), soloDax)
  try {
    assert.throws(() => bot.cambiarConfig({ stopPct: 0.5 }), /Flip the switch necesita/)
    assert.equal(bot.cambiarConfig({ modo: 'ambos', stopPct: 0.5 }).stopPct, 0.5)
    assert.throws(() => bot.cambiarConfig({ piramide: 9 }), /Pirámide no válida/)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('por defecto, la pirámide añade media posición cada 1R, con el mínimo de IG como suelo', async () => {
  assert.equal(CONFIG_INICIAL.piramide, 1)
  assert.equal(CONFIG_INICIAL.tamanoAnadido, 0.5)
  const precios = { '^GDAXI': [25500, 25501] }
  const ig = igFalso({ velas: { '^GDAXI': [vela15(madridNov(9, 9, 15), 25480, 25500, 25460, 25490)] }, precios })
  const { bot, dir, enHora } = botDePrueba(ig, soloDax)
  try {
    enHora(madridNov(9, 9, 30, 4)); await bot._paso()
    vela1m('^GDAXI', madridNov(9, 9, 41), 25502, 25495, 25501)
    enHora(madridNov(9, 9, 41, 10)); await bot._paso()
    precios['^GDAXI'] = [25541, 25542]
    vela1m('^GDAXI', madridNov(9, 9, 45), 25542, 25530, 25541)
    enHora(madridNov(9, 9, 45, 5)); await bot._paso()
    const op = apunte(bot, '^GDAXI').operacion
    assert.deepEqual(op.unidades.map(u => u.tamano), [6.2, 3.1])
    assert.equal(op.stop, 25514.7)                                // (6,2 × 25501 + 3,1 × 25542) / 9,3
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})
