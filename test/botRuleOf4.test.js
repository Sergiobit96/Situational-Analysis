// Tests del bot de la Rule of 4 (server/bot-srs.js con RULE_OF_4) contra un IG de mentira y
// con un reloj que se mueve a mano
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { crearBot, sesionRuleOf4, proximaRuleOf4, RULE_OF_4, SRS } from '../server/bot-srs.js'
import { registrarVela } from '../server/tiempo-real.js'

const utc = (mes, dia, h, m = 0, s = 0) => Date.UTC(2026, mes - 1, dia, h, m, s) / 1000

// ── La sesión: solo los días del FOMC, desde el comunicado ──

test('la sesión de la Rule of 4 empieza con el comunicado del FOMC y dura dos horas', () => {
  // miércoles 28-oct-2026: Nueva York aún en verano (UTC-4), así que las 14:00 son las 18:00 UTC
  // (las 19:00 de Madrid, que ya cambió la hora el domingo 25)
  const ses = sesionRuleOf4('^NDX', utc(10, 28, 19))
  assert.equal(ses.fecha, '2026-10-28')
  assert.equal(ses.abre, utc(10, 28, 18))
  assert.equal(ses.velaBracket, utc(10, 28, 18, 30))   // la cuarta de 10 min
  assert.equal(ses.finBracket, utc(10, 28, 18, 40))
  assert.equal(ses.cierra, utc(10, 28, 20))
  // en diciembre, con Nueva York en invierno (UTC-5): 19:00 UTC, las 20:00 de Madrid
  assert.equal(sesionRuleOf4('^GSPC', utc(12, 9, 20)).abre, utc(12, 9, 19))
  // el mismo comunicado para todos, también el DAX
  assert.equal(sesionRuleOf4('^GDAXI', utc(10, 28, 19)).abre, utc(10, 28, 18))
})

test('fuera de los días del FOMC no hay sesión; la próxima es la siguiente reunión', () => {
  assert.equal(sesionRuleOf4('^NDX', utc(10, 27, 19)), null)
  assert.equal(sesionRuleOf4('^NDX', utc(10, 19, 19)), null)
  assert.equal(sesionRuleOf4('EURUSD', utc(10, 28, 19)), null)
  assert.equal(proximaRuleOf4('^NDX', utc(10, 19, 12)), utc(10, 28, 18))
  assert.equal(proximaRuleOf4('^NDX', utc(10, 28, 18, 5)), utc(12, 9, 19))
  // el calendario de server/fomc.js llega hasta diciembre de 2026
  assert.equal(proximaRuleOf4('^NDX', utc(12, 9, 19, 5)), null)
})

test('por defecto está apagado y con Nasdaq, S&P y Dow', () => {
  const c = RULE_OF_4.configInicial
  assert.equal(c.activo, false)
  assert.deepEqual(Object.entries(c.instrumentos).filter(([, si]) => si).map(([t]) => t), ['^NDX', '^GSPC', '^DJI'])
  assert.equal(RULE_OF_4.prefijo, 'R4-')
  assert.notEqual(RULE_OF_4.prefijo, SRS.prefijo)
})

// ── El bot entero, con un IG de mentira ──

const MERCADOS = {
  'IX.D.NASDAQ.ICE.IP': { ticker: '^NDX', valorPunto: 1, moneda: 'EUR', cambioAEur: 1, tamanoMin: 0.2, conPrecio: true },
}

function igFalso({ velas = {}, precios = {} }) {
  const ordenes = []
  let abiertas = []
  let n = 0
  const ig = {
    pedidas: [],
    velasEntre: async (ticker, tf, desde, hasta) => {
      ig.pedidas.push(tf)
      return (velas[ticker] ?? []).filter(v => v.time >= desde && v.time < hasta)
    },
    operar: {
      datosMercado: async (ticker, epic) => {
        const m = MERCADOS[epic ?? 'IX.D.NASDAQ.ICE.IP']
        const [bid, oferta] = precios[ticker] ?? [25000, 25001]
        return { epic: epic ?? 'IX.D.NASDAQ.ICE.IP', ...m, stopMin: 5, estado: 'TRADEABLE', bid, oferta, aMercado: true }
      },
      abrir: async o => {
        ordenes.push({ tipo: 'abrir', ...o })
        const [bid, oferta] = precios[o.ticker] ?? [25000, 25001]
        const nivel = o.lado === 'largo' ? oferta : bid
        const p = { dealId: `D${++n}`, ticker: o.ticker, epic: o.epic, lado: o.lado, tamano: o.tamano, nivel, stop: o.stop, referencia: o.referencia, abierta: new Date(ig.reloj() * 1000).toISOString().slice(0, 19) }
        abiertas.push(p)
        return { aceptada: true, motivo: 'SUCCESS', dealId: p.dealId, nivel, stop: o.stop, tamano: o.tamano, lado: o.lado }
      },
      moverStop: async o => { ordenes.push({ tipo: 'stop', ...o }); return { aceptada: true, motivo: 'SUCCESS' } },
      cerrar: async o => {
        ordenes.push({ tipo: 'cerrar', ...o })
        abiertas = abiertas.filter(p => p.dealId !== o.dealId)
        const [bid, oferta] = precios[o.ticker] ?? [25000, 25001]
        return { aceptada: true, motivo: 'SUCCESS', nivel: o.lado === 'largo' ? bid : oferta }
      },
      posiciones: async () => abiertas,
      cierreDe: async () => null,
      cuenta: async () => ({ saldo: 20000, disponible: 20000, moneda: 'EUR' }),
    },
    ordenes,
    ponerPosicion: p => { abiertas.push(p) },
  }
  return ig
}

function botDePrueba(ig, { estrategia = RULE_OF_4, avisar, cambios = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-r4-'))
  let t = utc(10, 28, 12)
  ig.reloj = () => t
  const bot = crearBot({ ig, archivo: join(dir, 'bot.json'), ahora: () => t, log: () => {}, revisarCadaMs: 0, avisar, estrategia })
  bot.cambiarConfig({ activo: true, ...cambios })
  return { bot, dir, enHora: x => { t = x } }
}
const vela1m = (ticker, time, high, low, close = (high + low) / 2) => registrarVela('ig', ticker, { time, open: close, high, low, close })
const apunte = (bot, ticker) => bot.estado().hoy.find(d => d.ticker === ticker)
const soloNasdaq = { instrumentos: { '^NDX': true, '^GSPC': false, '^DJI': false } }

test('una reunión del FOMC entera en el Nasdaq: bracket en la cuarta vela de 10 min, rotura, cierre a las dos horas y velas de 10 min guardadas', async () => {
  const avisos = []
  // el histórico de IG, a 5 min: lo que el bot pide para guardar la sesión si al directo le faltan velas
  const de5 = Array.from({ length: 24 }, (_, i) => ({ time: utc(10, 28, 18) + i * 300, open: 24980, high: 24990 + i, low: 24970, close: 24985 }))
  const ig = igFalso({ velas: { '^NDX': de5 }, precios: { '^NDX': [25000, 25001] } })
  const { bot, dir, enHora } = botDePrueba(ig, { avisar: x => avisos.push(x), cambios: soloNasdaq })
  try {
    // la cuarta vela de 10 min, de 18:30 a 18:39 UTC, en el directo
    for (let m = 30; m < 40; m++) vela1m('^NDX', utc(10, 28, 18, m), m === 33 ? 25000 : 24990, m === 36 ? 24950 : 24960)
    enHora(utc(10, 28, 18, 29)); await bot._paso()
    assert.equal(apunte(bot, '^NDX').estado, 'esperando-bracket')
    enHora(utc(10, 28, 18, 40, 4)); await bot._paso()
    let hoy = apunte(bot, '^NDX')
    assert.deepEqual(hoy.bracket, { high: 25000, low: 24950, rango: 50, vela: utc(10, 28, 18, 30) })
    assert.deepEqual(hoy.ventana, { open: 19 * 60, close: 21 * 60, minutosVela: 10, nBracket: 4 })
    assert.equal(hoy.estado, 'esperando-rotura')
    assert.equal(hoy.plan.tamano, 4)          // 200 € (el 1% de 20.000) / 50 puntos a 1 €/punto
    assert.equal(ig.pedidas.length, 0)        // la vela del bracket salió del directo, sin gastar cupo

    vela1m('^NDX', utc(10, 28, 18, 41), 25002, 24995)
    enHora(utc(10, 28, 18, 41, 10)); await bot._paso()
    hoy = apunte(bot, '^NDX')
    assert.equal(hoy.estado, 'en-posicion')
    const abrir = ig.ordenes.find(o => o.tipo === 'abrir')
    assert.equal(abrir.lado, 'largo')
    assert.equal(abrir.stop, 24950)
    assert.match(abrir.referencia, /^R4-NDX-20261028-/)

    // a las dos horas del comunicado, fuera
    enHora(utc(10, 28, 20, 0, 3)); await bot._paso()
    hoy = bot.estado().hoy.find(d => d.ticker === '^NDX') ?? bot.estado().historial.find(d => d.ticker === '^NDX')
    assert.equal(hoy.salida.motivo, 'cierre')
    enHora(utc(10, 28, 20, 0, 8)); await bot._paso()
    const d = bot._datos().dias['2026-10-28 ^NDX']
    // al directo le faltan velas: se guardan las del histórico de 5 min, juntas de dos en dos
    assert.equal(ig.pedidas.at(-1), 'm5')
    assert.equal(d.velas.length, 12)
    assert.deepEqual(d.velas[0], [utc(10, 28, 18), 24980, 24991, 24970, 24985])
    // los avisos dicen de qué bot son
    assert.ok(avisos.length > 0)
    assert.ok(avisos.every(a => a.startsWith('Rule of 4 · ')), avisos.find(a => !a.startsWith('Rule of 4 · ')))
    assert.ok(avisos.some(a => a.startsWith('Rule of 4 · Nasdaq 100 · Bracket')))
    assert.equal(bot.estado().estrategia.nombre, 'Rule of 4')
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('fuera de los días del FOMC no apunta nada', async () => {
  const ig = igFalso({})
  const { bot, dir, enHora } = botDePrueba(ig, { cambios: soloNasdaq })
  try {
    enHora(utc(10, 27, 18, 45)); await bot._paso()
    assert.equal(bot.estado().hoy.length, 0)
    assert.deepEqual(bot._datos().dias, {})
    assert.equal(bot.estado().sesiones.find(s => s.ticker === '^NDX').proxima, utc(10, 28, 18))
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('al arrancar, cada bot recupera solo sus posiciones: el de la Rule of 4 no se queda las del SRS, ni al revés', async () => {
  const abierta = new Date(utc(10, 28, 18, 45) * 1000).toISOString().slice(0, 19)
  const posicion = (dealId, referencia) => ({ dealId, ticker: '^NDX', epic: 'IX.D.NASDAQ.ICE.IP', lado: 'largo', tamano: 1, nivel: 25000, stop: 24950, referencia, abierta })

  const ig1 = igFalso({})
  ig1.ponerPosicion(posicion('S1', 'SRS-NDX-20261028-abcd'))
  ig1.ponerPosicion(posicion('R1', 'R4-NDX-20261028-wxyz'))
  const r4 = botDePrueba(ig1, { cambios: soloNasdaq })
  const srs = botDePrueba(ig1, { estrategia: SRS, cambios: { instrumentos: { '^NDX': true } } })
  try {
    r4.enHora(utc(10, 28, 18, 50)); srs.enHora(utc(10, 28, 18, 50))
    await r4.bot._recuperar()
    await srs.bot._recuperar()
    const deR4 = Object.values(r4.bot._datos().dias).flatMap(d => d.operacion?.unidades ?? []).map(u => u.dealId)
    const deSrs = Object.values(srs.bot._datos().dias).flatMap(d => d.operacion?.unidades ?? []).map(u => u.dealId)
    assert.deepEqual(deR4, ['R1'])
    assert.deepEqual(deSrs, ['S1'])
  } finally {
    r4.bot.parar(); srs.bot.parar()
    rmSync(r4.dir, { recursive: true, force: true }); rmSync(srs.dir, { recursive: true, force: true })
  }
})
