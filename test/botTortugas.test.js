// Tests del bot de las tortugas (server/bot-tortugas.js y server/tortugas-niveles.js) contra
// un IG de mentira y con un reloj que se mueve a mano: ninguna orden de verdad
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { nivelesTortugas } from '../server/tortugas-niveles.js'
import { siguientePasoTortugas, siguienteAnadido, crearBotTortugas, capitalNominal, nivelesSistema, sesionTortugas, proximaAperturaTortugas, CONFIG_TORTUGAS_BOT, GRUPOS_TORTUGAS, diariasDeSesiones, sesionesQueFaltan } from '../server/bot-tortugas.js'
import { sesionDe } from '../server/bot-srs.js'
import { registrarVela } from '../server/tiempo-real.js'
import { offsetZona } from '../server/zonas.js'
import { crearCartera } from '../server/cartera.js'
import { INDICES_TORTUGAS, prepararMercado, backtestTortugas, ordenesManana } from '../src/tortugas.js'

// Hora local de Fráncfort en un día de octubre o noviembre de 2026 → instante UTC en segundos
const fra = (mes, dia, h, m = 0, s = 0) => {
  const aprox = Date.UTC(2026, mes - 1, dia, h, m, s) / 1000
  return aprox - offsetZona(aprox - offsetZona(aprox, 'Europe/Berlin'), 'Europe/Berlin')
}

// Días laborables hasta `hasta` (incluido), en orden
function laborables(hasta, n) {
  const fechas = []
  for (let t = Date.parse(`${hasta}T12:00:00Z`); fechas.length < n; t -= 86_400_000) {
    const d = new Date(t)
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) fechas.unshift(d.toISOString().slice(0, 10))
  }
  return fechas
}

// Un paseo aleatorio con semilla, con tendencias para que haya rupturas de todo tipo
function serie(n, semilla = 7) {
  let x = semilla
  const azar = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648)
  const fechas = laborables('2026-10-16', n)
  let c = 10_000
  return fechas.map((date, i) => {
    const deriva = Math.sin(i / 90) * 0.004
    const open = c * (1 + (azar() - 0.5) * 0.01)
    const close = open * (1 + deriva + (azar() - 0.5) * 0.025)
    const high = Math.max(open, close) * (1 + azar() * 0.008)
    const low = Math.min(open, close) * (1 - azar() * 0.008)
    c = close
    return { date, open, high, low, close }
  })
}

// ── Los niveles, iguales que los del backtest ──

test('los niveles del bot son los del backtest: N, canales y filtro del Sistema 1', () => {
  const info = { ...INDICES_TORTUGAS.find(i => i.id === 'DAX'), desde: '1900-01-01' }
  for (const semilla of [7, 11, 23, 99]) {
    const velas = serie(1500, semilla)
    const res = backtestTortugas([prepararMercado(info, velas)], null, { desde: velas[0].date })
    const e = res.estados[0]
    const manana = ordenesManana(res, 20_000)[0]
    for (const desde of [0, 700]) {
      const nv = nivelesTortugas(velas.slice(desde))
      assert.ok(Math.abs(nv.n - manana.n) < 1e-6, `N con semilla ${semilla}`)
      assert.equal(nv.gano, e.gano, `filtro con semilla ${semilla} desde ${desde}`)
      assert.deepEqual(nv.virtual && { lado: nv.virtual.lado, entrada: nv.virtual.entrada, stop: nv.virtual.stop }, e.virtual, `ruptura virtual con semilla ${semilla}`)
      assert.equal(nv.alto[20], Math.max(...velas.slice(-20).map(v => v.high)))
      assert.equal(nv.bajo[10], Math.min(...velas.slice(-10).map(v => v.low)))
      if (!e.pos[1]) assert.equal(nv.alto[nv.gano ? 55 : 20], manana.compra.nivel)
    }
  }
  assert.equal(nivelesTortugas(serie(50)), null)
})

test('el Sistema 1 entra en toda ruptura de 20: el filtro de la anterior ganadora va apagado', () => {
  assert.equal(CONFIG_TORTUGAS_BOT.filtroS1, false)
  const nv = { gano: true, alto: { 10: 110, 20: 120, 55: 150 }, bajo: { 10: 90, 20: 80, 55: 50 } }
  assert.equal(nivelesSistema(nv, 1).entrada.largo.nivel, 120)
  assert.equal(nivelesSistema(nv, 1).filtro, false)
  // con el filtro encendido, la anterior ganadora lo manda a la de 55
  assert.equal(nivelesSistema(nv, 1, true).entrada.largo.nivel, 150)
  assert.equal(nivelesSistema(nv, 1, true).filtro, true)
  assert.equal(nivelesSistema({ ...nv, gano: false }, 1, true).entrada.largo.nivel, 120)
  // al Sistema 2 no le afecta
  assert.equal(nivelesSistema(nv, 2).entrada.largo.nivel, 150)
  assert.equal(nivelesSistema(nv, 2, true).salida.largo, 80)
})

test('el capital de la unidad baja un 20% por cada 10% de caída desde el máximo', () => {
  assert.equal(capitalNominal(20_000, 20_000), 20_000)
  assert.equal(capitalNominal(18_500, 20_000), 18_500)
  assert.equal(capitalNominal(17_900, 20_000), 16_000)          // −10,5%: un tramo
  assert.ok(Math.abs(capitalNominal(15_900, 20_000) - 12_800) < 1e-9)   // −20,5%: dos tramos
  assert.equal(capitalNominal(17_900, 20_000, false), 17_900)
})

// ── La decisión ──

const ses = sesionDe('^GDAXI', fra(10, 19, 12))          // lunes 19-oct-2026, 09:00–17:30 en Fráncfort
const plan = {
  fecha: '2026-10-19', calculado: fra(10, 19, 9, 0, 5), n: 300, unidad: { ok: true, tamano: 0.6 },
  sistemas: {
    1: { k: 20, kSalida: 10, entrada: { largo: { nivel: 25_150, k: 20 }, corto: { nivel: 24_850, k: 20 } }, salida: { largo: 24_850, corto: 25_150 } },
    2: { k: 55, kSalida: 20, entrada: { largo: { nivel: 25_400, k: 55 }, corto: { nivel: 24_600, k: 55 } }, salida: { largo: 24_700, corto: 25_300 } },
  },
}
const cfg = { ...CONFIG_TORTUGAS_BOT, encendido: true, activo: true }
const v1 = (time, high, low, close = (high + low) / 2) => [{ time, open: close, high, low, close }]
const paso = x => siguientePasoTortugas({ pos: null, plan, intento: null, cfg, ses, proxima: ses, velas: [], ...x })

test('el plan se hace antes de abrir (provisional), se rehace al abrir y espera a Yahoo tras el cierre', () => {
  // el domingo por la noche: el de la sesión del lunes
  const domingo = fra(10, 18, 20)
  const lunes = sesionDe('^GDAXI', fra(10, 19, 12))
  assert.deepEqual(siguientePasoTortugas({ plan: null, cfg, ahora: domingo, velas: [], ses: null, proxima: lunes }), { accion: 'plan', ses: lunes })
  // hecho el domingo, al abrir se rehace con la cuenta de ese momento
  const provisional = { ...plan, calculado: domingo }
  assert.equal(paso({ plan: provisional, ahora: fra(10, 19, 8, 59) }).accion, 'nada')
  assert.equal(paso({ plan: provisional, ahora: fra(10, 19, 9, 0, 5) }).accion, 'plan')
  assert.equal(paso({ ahora: fra(10, 19, 9, 0, 10) }).accion, 'nada')
  // recién cerrada la sesión no se hace el del martes: Yahoo aún no tiene la vela del lunes
  const martes = sesionDe('^GDAXI', fra(10, 20, 12))
  assert.equal(paso({ ahora: fra(10, 19, 17, 45), proxima: martes }).accion, 'nada')
  assert.equal(paso({ ahora: fra(10, 19, 18, 31), proxima: martes }).accion, 'plan')
  // apagado el índice y sin posición, no hace falta plan
  assert.equal(paso({ plan: null, ahora: fra(10, 19, 10), cfg: { ...cfg, encendido: false, activo: false } }).accion, 'nada')
})

test('entra al romper el canal con el precio de ahora, solo en la sesión y solo largos por defecto', () => {
  const ahora = fra(10, 19, 10, 0, 30)
  assert.deepEqual(paso({ ahora, velas: v1(fra(10, 19, 10), 25_151, 25_140) }), { accion: 'entrar', lado: 'largo' })
  assert.equal(paso({ ahora, velas: v1(fra(10, 19, 10), 25_150 - 1, 25_140) }).accion, 'nada')
  // una ruptura de hace rato que ya no está no cuenta
  assert.equal(paso({ ahora, velas: v1(fra(10, 19, 9, 50), 25_200, 25_140) }).accion, 'nada')
  // la de abajo solo con cortos
  assert.equal(paso({ ahora, velas: v1(fra(10, 19, 10), 24_900, 24_840) }).accion, 'nada')
  assert.deepEqual(paso({ ahora, velas: v1(fra(10, 19, 10), 24_900, 24_840), cfg: { ...cfg, lados: 'ambos' } }), { accion: 'entrar', lado: 'corto' })
  // apagado, sin unidad que quepa o fuera de la sesión, no
  assert.equal(paso({ ahora, velas: v1(fra(10, 19, 10), 25_200, 25_140), cfg: { ...cfg, activo: false } }).accion, 'nada')
  assert.equal(paso({ ahora, velas: v1(fra(10, 19, 10), 25_200, 25_140), plan: { ...plan, unidad: { ok: false } } }).accion, 'nada')
  assert.equal(paso({ ahora: fra(10, 19, 18, 0, 30), velas: v1(fra(10, 19, 18), 25_200, 25_140) }).accion, 'nada')
  // el Sistema 2 espera a su canal de 55
  assert.equal(paso({ ahora, velas: v1(fra(10, 19, 10), 25_151, 25_140), sistema: 2 }).accion, 'nada')
  assert.deepEqual(paso({ ahora, velas: v1(fra(10, 19, 10), 25_401, 25_140), sistema: 2 }), { accion: 'entrar', lado: 'largo' })
})

test('los dos sistemas como uno: la pirámide no añade a menos de ½ N de una unidad del otro', () => {
  const pos = { lado: 'largo', n0: 300, unidades: [{ entrada: 25_160 }] }
  assert.equal(siguienteAnadido(pos), 25_310)
  assert.equal(siguienteAnadido(pos, [25_470]), 25_310)                 // a 160, más de ½ N (150): no molesta
  assert.equal(siguienteAnadido(pos, [25_250]), 25_400)                 // ese ya está comprado: ½ N más allá
  assert.equal(siguienteAnadido(pos, [25_250, 25_420]), 25_570)         // y del siguiente del otro, igual
  assert.equal(siguienteAnadido({ ...pos, lado: 'corto' }, [24_950]), 24_800)  // en corto, hacia abajo
  const ahora = fra(10, 19, 11, 0, 30)
  const con = (high, ocupados) => paso({ pos: { ...pos, stop: 24_560 }, ahora, velas: v1(fra(10, 19, 11), high, 25_200, high - 10), ocupados })
  assert.equal(con(25_320, []).accion, 'anadir')
  assert.equal(con(25_320, [25_250]).accion, 'vigilar')
  assert.equal(con(25_410, [25_250]).accion, 'anadir')
})

test('con posición: añade cada ½ N, sale por el canal y vigila el stop', () => {
  const pos = { lado: 'largo', n0: 300, stop: 24_560, unidades: [{ entrada: 25_160, tamano: 0.6 }] }
  const ahora = fra(10, 19, 11, 0, 30)
  const con = (high, low, close, x = {}) => paso({ pos, ahora, velas: v1(fra(10, 19, 11), high, low, close), ...x })
  assert.equal(con(25_300, 25_200, 25_250).accion, 'vigilar')
  assert.equal(con(25_310, 25_200, 25_300).accion, 'anadir')                    // 25.160 + 150
  assert.equal(con(25_310, 25_200, 25_300, { cfg: { ...cfg, maxUnidades: 1 } }).accion, 'vigilar')
  assert.equal(con(25_310, 25_200, 25_300, { cfg: { ...cfg, activo: false } }).accion, 'vigilar')
  assert.deepEqual(con(24_900, 24_850, 24_870), { accion: 'salir', motivo: 'canal 10' })
  // la misma posición en el Sistema 2 sale por su canal de 20, más abajo
  assert.equal(con(24_900, 24_850, 24_870, { sistema: 2 }).accion, 'vigilar')
  assert.deepEqual(con(24_750, 24_690, 24_720, { sistema: 2 }), { accion: 'salir', motivo: 'canal 20' })
  // stop por encima del canal: lo cierra IG, y el bot lo vigila de cerca
  assert.equal(con(24_900, 24_860, 24_870, { pos: { ...pos, stop: 24_880 } }).accion, 'revisar-ya')
  // fuera de la sesión, solo se vigila (el stop está en IG)
  assert.equal(paso({ pos, ahora: fra(10, 19, 20) }).accion, 'vigilar')
  assert.equal(paso({ pos, intento: { tipo: 'anadido' }, ahora }).accion, 'reconciliar')
})

test('un stop que IG no movió por un fallo suyo se reintenta al rato, en la sesión o fuera de ella', () => {
  const pos = { lado: 'largo', n0: 300, stop: 24_560, stopPendiente: 24_700, esperaStop: fra(10, 19, 11, 0, 40), unidades: [{ entrada: 25_160, tamano: 0.6 }] }
  const velas = v1(fra(10, 19, 11), 25_300, 25_200, 25_250)
  assert.equal(paso({ pos, ahora: fra(10, 19, 11, 0, 30), velas }).accion, 'vigilar')         // aún no
  assert.equal(paso({ pos, ahora: fra(10, 19, 11, 0, 50), velas }).accion, 'stop')
  assert.equal(paso({ pos, ahora: fra(10, 19, 20) }).accion, 'stop')
  // salir por el canal va antes
  assert.deepEqual(paso({ pos, ahora: fra(10, 19, 11, 0, 50), velas: v1(fra(10, 19, 11), 24_900, 24_850, 24_870) }), { accion: 'salir', motivo: 'canal 10' })
})

// ── El bot entero, con un IG de mentira ──

const MERCADOS = {
  'IX.D.DAX.IFMM.IP':   { ticker: '^GDAXI', valorPunto: 1,   moneda: 'EUR', cambioAEur: 1,    tamanoMin: 0.5, factorMargen: 0.05 },
  'IX.D.FTSE.IFE.IP':   { ticker: '^FTSE',  valorPunto: 1,   moneda: 'EUR', cambioAEur: 1,    tamanoMin: 0.5, factorMargen: 0.05 },
  'IX.D.NASDAQ.ICE.IP': { ticker: '^NDX',   valorPunto: 1,   moneda: 'EUR', cambioAEur: 1,    tamanoMin: 0.2, factorMargen: 0.05 },
  'IX.D.NASDAQ.IEC.IP': { ticker: '^NDX',   valorPunto: 1,   moneda: 'USD', cambioAEur: 0.86, tamanoMin: 0.2, factorMargen: 0.05 },
  'IX.D.NASDAQ.IFD.IP': { ticker: '^NDX',   valorPunto: 100, moneda: 'USD', cambioAEur: 0.86, tamanoMin: 0.2, factorMargen: 0.05 },
  // en divisas el punto de IG es el pip (0,0001): 1 $ por pip en el mini son 10.000 $ por unidad de precio
  'CS.D.EURUSD.CECM.IP': { ticker: 'EURUSD', valorPunto: 1, valorPrecio: 10_000, moneda: 'USD', cambioAEur: 0.86, tamanoMin: 0.1, factorMargen: 0.0333, decimales: 5 },
  'CS.D.EURUSD.CEC.IP':  { ticker: 'EURUSD', valorPunto: 10, valorPrecio: 100_000, moneda: 'USD', cambioAEur: 0.86, tamanoMin: 0.1, factorMargen: 0.0333, decimales: 5 },
  'CS.D.CFEGOLD.CEC.IP': { ticker: 'XAUUSD', valorPunto: 1, moneda: 'USD', cambioAEur: 0.86, tamanoMin: 0.1, factorMargen: 0.05, decimales: 2 },
}

// `sinPrecio`: los contratos que la cuenta no puede operar (su ficha viene sin precio)
function igFalso({ precios = {}, saldo = 20_000, disponible = 20_000, sinPrecio = [] } = {}) {
  const ordenes = []
  let abiertas = []
  let n = 0
  const ig = {
    precios,
    operar: {
      datosMercado: async (ticker, epic) => {
        const m = MERCADOS[epic]
        if (!m) throw new Error(`mercado desconocido en la prueba: ${epic}`)
        const conPrecio = !sinPrecio.includes(epic)
        const [bid, oferta] = ig.precios[ticker] ?? [25_000, 25_001]
        return { epic, ...m, stopMin: 8, estado: 'TRADEABLE', conPrecio, bid: conPrecio ? bid : null, oferta: conPrecio ? oferta : null, aMercado: true }
      },
      abrir: async o => {
        ordenes.push({ tipo: 'abrir', ...o })
        const [bid, oferta] = ig.precios[o.ticker]
        const nivel = o.lado === 'largo' ? oferta : bid
        const p = { dealId: `D${++n}`, ticker: o.ticker, epic: o.epic, lado: o.lado, tamano: o.tamano, nivel, stop: o.stop, referencia: o.referencia, abierta: new Date(ig.reloj() * 1000).toISOString().slice(0, 19) }
        abiertas.push(p)
        return { aceptada: true, motivo: 'SUCCESS', dealId: p.dealId, nivel, stop: o.stop, tamano: o.tamano, lado: o.lado }
      },
      moverStop: async o => {
        ordenes.push({ tipo: 'stop', ...o })
        const p = abiertas.find(x => x.dealId === o.dealId)
        if (p) p.stop = o.stop
        return { aceptada: true, motivo: 'SUCCESS' }
      },
      cerrar: async o => {
        ordenes.push({ tipo: 'cerrar', ...o })
        abiertas = abiertas.filter(p => p.dealId !== o.dealId)
        const [bid, oferta] = ig.precios[o.ticker]
        return { aceptada: true, motivo: 'SUCCESS', nivel: o.lado === 'largo' ? bid : oferta }
      },
      posiciones: async () => abiertas.map(p => ({ ...p })),
      cierreDe: async () => (ig.nivelCierre == null ? null : { nivel: ig.nivelCierre }),
      cuenta: async () => ({ saldo, disponible, moneda: 'EUR' }),
    },
    ordenes,
    quitarPosiciones: () => { abiertas = [] },
    ponerPosicion: p => { abiertas.push(p) },
  }
  return ig
}

// Un diario plano: cada día abre y cierra en `centro` y se mueve ± `medio` → N = 2·medio, el
// máximo de 20 sesiones es centro + medio y el mínimo de 10, centro − medio
const diarioPlano = (centro, medio, hasta = '2026-10-16') => laborables(hasta, 300)
  .map(date => ({ date, open: centro, high: centro + medio, low: centro - medio, close: centro }))

function botDePrueba(ig, diarios, cambios = {}, { cartera, noticias } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tortugas-'))
  let t = 0
  ig.reloj = () => t
  const avisos = []
  const pedidas = []
  const bot = crearBotTortugas({
    ig, archivo: join(dir, 'Bot Tortugas.json'), ahora: () => t, log: () => {}, revisarCadaMs: 0, avisar: x => avisos.push(x), cartera, noticias,
    velasDiarias: async ticker => {
      pedidas.push(ticker)
      if (diarios[ticker] instanceof Error) throw diarios[ticker]
      return diarios[ticker] ?? []
    },
  })
  bot.cambiarConfig({ activo: true, ...cambios })
  return { bot, dir, avisos, pedidas, enHora: x => { t = x }, archivo: join(dir, 'Bot Tortugas.json') }
}
const soloDax = { instrumentos: { '^N225': false, '^GDAXI': true, '^FTSE': false, '^NDX': false, '^GSPC': false, '^DJI': false, '^RUT': false } }
const soloS1 = { ...soloDax, sistemas: [1] }
const vela1m = (ticker, time, high, low, close = (high + low) / 2) => registrarVela('ig', ticker, { time, open: close, high, low, close })
const mercado = (bot, ticker) => bot.estado().mercados.find(m => m.ticker === ticker)
const posicion = (bot, ticker, sistema = 1) => mercado(bot, ticker).posiciones[sistema]

test('el DAX de punta a punta: plan, ruptura, pirámide con el stop de todas, salida por el canal', async () => {
  const ig = igFalso({ precios: { '^GDAXI': [25_000, 25_001] } })
  const { bot, dir, avisos, enHora, archivo } = botDePrueba(ig, { '^GDAXI': diarioPlano(25_000, 150) }, soloS1)
  try {
    // domingo por la noche: el plan provisional del lunes, sin avisar
    enHora(fra(10, 18, 21)); await bot._paso()
    let m = mercado(bot, '^GDAXI')
    assert.equal(m.plan.provisional, true)
    assert.equal(m.plan.n, 300)
    assert.equal(m.plan.sistemas[1].entrada.largo.nivel, 25_150)
    assert.equal(m.plan.sistemas[1].salida.largo, 24_850)
    // 1% de 20.000 € = 200 € por N / 300 puntos a 1 €/punto = 0,67 → 0,6 contratos
    assert.equal(m.plan.unidad.tamano, 0.6)
    assert.equal(avisos.filter(a => /Próxima sesión/.test(a)).length, 0)

    // al abrir se rehace; se apunta en los eventos de la pestaña, pero no va a Telegram
    // (la tabla de la pestaña ya lo enseña)
    enHora(fra(10, 19, 9, 0, 5)); await bot._paso()
    m = mercado(bot, '^GDAXI')
    assert.equal(m.plan.provisional, false)
    assert.ok(bot.estado().eventos.some(e => /^Sesión de hoy: N 300/.test(e.texto)))
    assert.equal(avisos.filter(a => /Sesión de hoy/.test(a)).length, 0)

    // ruptura: compra a mercado con el stop a 2 N del relleno
    ig.precios['^GDAXI'] = [25_155, 25_156]
    vela1m('^GDAXI', fra(10, 19, 10), 25_156, 25_140)
    enHora(fra(10, 19, 10, 0, 20)); await bot._paso()
    m = mercado(bot, '^GDAXI')
    const abrir = ig.ordenes.find(o => o.tipo === 'abrir')
    assert.equal(abrir.lado, 'largo')
    assert.equal(abrir.tamano, 0.6)
    assert.equal(abrir.stop, 24_556)                        // 25.156 − 600
    assert.equal(abrir.limite, null)
    assert.match(abrir.referencia, /^TOR1-GDAXI-20261019-/)
    assert.equal(posicion(bot, '^GDAXI').unidades.length, 1)
    assert.equal(posicion(bot, '^GDAXI').unidades[0].deslizamiento, 6)
    assert.ok(avisos.some(a => /^Tortugas S1 · DAX · Compra de 0,6 a 25\.156/.test(a)))

    // la misma vela no vuelve a entrar
    enHora(fra(10, 19, 10, 0, 40)); await bot._paso()
    assert.equal(ig.ordenes.filter(o => o.tipo === 'abrir').length, 1)

    // ½ N a favor (25.306): otra unidad y el stop de las dos a 2 N de ella
    ig.precios['^GDAXI'] = [25_307, 25_308]
    vela1m('^GDAXI', fra(10, 19, 11), 25_308, 25_290)
    enHora(fra(10, 19, 11, 0, 20)); await bot._paso()
    assert.equal(posicion(bot, '^GDAXI').unidades.length, 2)
    assert.equal(posicion(bot, '^GDAXI').stop, 24_708)
    assert.deepEqual(ig.ordenes.filter(o => o.tipo === 'stop').map(o => [o.dealId, o.stop]), [['D1', 24_708]])

    // al día siguiente sigue abierta; rompe el mínimo de 10 sesiones: fuera las dos
    enHora(fra(10, 20, 9, 0, 5)); await bot._paso()
    assert.equal(mercado(bot, '^GDAXI').plan.fecha, '2026-10-20')
    ig.precios['^GDAXI'] = [24_845, 24_846]
    vela1m('^GDAXI', fra(10, 20, 10), 24_900, 24_840)
    enHora(fra(10, 20, 10, 0, 20)); await bot._paso()
    assert.equal(posicion(bot, '^GDAXI'), null)
    assert.equal(ig.ordenes.filter(o => o.tipo === 'cerrar').length, 2)
    const op = bot.estado().operaciones[0]
    assert.equal(op.motivo, 'canal 10')
    assert.equal(op.sistema, 1)
    assert.equal(op.unidades, 2)
    assert.ok(Math.abs(op.resultadoEur - ((24_845 - 25_156) * 0.6 + (24_845 - 25_308) * 0.6)) < 1e-6)
    assert.ok(Math.abs(op.resultadoN - ((24_845 - 25_156) + (24_845 - 25_308)) / 300) < 1e-9)

    const guardado = JSON.parse(readFileSync(archivo, 'utf8'))
    assert.equal(guardado.operaciones.length, 1)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

// La compra del DAX a 25.156 y, a ½ N, la segunda unidad, con el stop de las dos a 24.708, el
// `dia` de octubre (cada prueba el suyo: las velas de 1 min del directo son de todas)
async function compraYAnadido(ig, bot, enHora, dia) {
  enHora(fra(10, dia, 9, 0, 5)); await bot._paso()
  ig.precios['^GDAXI'] = [25_155, 25_156]
  vela1m('^GDAXI', fra(10, dia, 10), 25_156, 25_140)
  enHora(fra(10, dia, 10, 0, 20)); await bot._paso()
  ig.precios['^GDAXI'] = [25_307, 25_308]
  vela1m('^GDAXI', fra(10, dia, 11), 25_308, 25_290)
  enHora(fra(10, dia, 11, 0, 20)); await bot._paso()
}
const falloIG = () => { throw new Error('Fallo interno de IG con la orden (error.service.execution.find)') }

test('si IG falla al mover el stop de la pirámide, se reintenta a los 30 s', async () => {
  const ig = igFalso({ precios: { '^GDAXI': [25_000, 25_001] } })
  const moverStop = ig.operar.moverStop
  ig.operar.moverStop = falloIG
  const { bot, dir, avisos, enHora } = botDePrueba(ig, { '^GDAXI': diarioPlano(25_000, 150, '2026-10-20') }, soloS1)
  try {
    await compraYAnadido(ig, bot, enHora, 21)
    assert.equal(posicion(bot, '^GDAXI').unidades.length, 2)
    assert.equal(posicion(bot, '^GDAXI').stop, 24_556)
    assert.ok(avisos.some(a => /Pirámide: .*; IG ha fallado al mover el stop de todas a 24\.708; se reintenta cada 30 s \(Fallo interno de IG/.test(a)))
    ig.operar.moverStop = moverStop
    enHora(fra(10, 21, 11, 0, 30)); await bot._paso()                // aún no
    assert.equal(ig.ordenes.filter(o => o.tipo === 'stop').length, 0)
    enHora(fra(10, 21, 11, 0, 55)); await bot._paso()
    assert.deepEqual(ig.ordenes.filter(o => o.tipo === 'stop').map(o => [o.dealId, o.stop]), [['D1', 24_708]])
    assert.equal(posicion(bot, '^GDAXI').stop, 24_708)
    assert.ok(avisos.at(-1).endsWith('Stop de todas en 24.708, tras el fallo de IG'))
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('si IG falla al cerrar pero la unidad ya no está, se busca a qué precio salió en vez de insistir', async () => {
  const ig = igFalso({ precios: { '^GDAXI': [25_000, 25_001] } })
  const { bot, dir, enHora } = botDePrueba(ig, { '^GDAXI': diarioPlano(25_000, 150, '2026-10-21') }, soloS1)
  try {
    await compraYAnadido(ig, bot, enHora, 22)
    enHora(fra(10, 23, 9, 0, 5)); await bot._paso()
    ig.operar.cerrar = async () => { ig.quitarPosiciones(); falloIG() }
    ig.nivelCierre = 24_845
    ig.precios['^GDAXI'] = [24_845, 24_846]
    vela1m('^GDAXI', fra(10, 23, 10), 24_900, 24_840)
    enHora(fra(10, 23, 10, 0, 20)); await bot._paso()
    assert.equal(posicion(bot, '^GDAXI'), null)
    assert.equal(bot.estado().operaciones[0].salida, 24_845)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('el stop que salta de noche en IG se apunta con el precio de la actividad', async () => {
  const ig = igFalso({ precios: { '^GDAXI': [25_000, 25_001] } })
  const { bot, dir, enHora } = botDePrueba(ig, { '^GDAXI': diarioPlano(25_000, 150, '2026-10-23') }, soloS1)
  try {
    enHora(fra(10, 26, 9, 0, 5)); await bot._paso()
    ig.precios['^GDAXI'] = [25_155, 25_156]
    vela1m('^GDAXI', fra(10, 26, 10), 25_156, 25_140)
    enHora(fra(10, 26, 10, 0, 20)); await bot._paso()
    assert.ok(posicion(bot, '^GDAXI'))

    // a las 22:00 IG la ha cerrado con el stop; la actividad aún no lo tiene
    ig.quitarPosiciones()
    enHora(fra(10, 26, 22)); await bot._paso()
    assert.ok(posicion(bot, '^GDAXI'), 'espera a que IG apunte el cierre')
    ig.nivelCierre = 24_550
    enHora(fra(10, 26, 22, 0, 30)); await bot._paso()
    assert.equal(posicion(bot, '^GDAXI'), null)
    const op = bot.estado().operaciones[0]
    assert.equal(op.motivo, 'stop')
    assert.equal(op.salida, 24_550)
    assert.ok(Math.abs(op.resultadoEur - (24_550 - 25_156) * 0.6) < 1e-6)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('los límites de cartera: con el grupo lleno no entra otro índice del mismo grupo', async () => {
  const ig = igFalso({ precios: { '^GDAXI': [25_000, 25_001], '^FTSE': [10_000, 10_001] } })
  const instrumentos = { ...soloDax.instrumentos, '^FTSE': true }
  const { bot, dir, enHora } = botDePrueba(ig, { '^GDAXI': diarioPlano(25_000, 150, '2026-10-30'), '^FTSE': diarioPlano(10_000, 50, '2026-10-30') }, { instrumentos, maxGrupo: 1, sistemas: [1] })
  try {
    enHora(fra(11, 2, 9, 0, 5)); await bot._paso()
    ig.precios['^GDAXI'] = [25_155, 25_156]
    vela1m('^GDAXI', fra(11, 2, 10), 25_156, 25_140)
    enHora(fra(11, 2, 10, 0, 20)); await bot._paso()
    assert.ok(posicion(bot, '^GDAXI'))
    // el FTSE rompe (09:00 en Londres = 10:00 en Fráncfort), pero Europa ya tiene 1 unidad larga
    ig.precios['^FTSE'] = [10_055, 10_056]
    vela1m('^FTSE', fra(11, 2, 10, 1), 10_056, 10_040)
    enHora(fra(11, 2, 10, 1, 20)); await bot._paso()
    assert.equal(posicion(bot, '^FTSE'), null)
    assert.ok(bot.estado().eventos.some(e => e.ticker === '^FTSE' && /el Sistema 1 ya tiene 1 unidades largas en Europa/.test(e.texto)))
    assert.equal(ig.ordenes.filter(o => o.tipo === 'abrir').length, 1)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('junto a una noticia no entra; pasada, entra. Y no entra si el riesgo de los otros bots en Europa ya llena el tope', async () => {
  const ig = igFalso({ precios: { '^GDAXI': [25_000, 25_001] } })
  const pasa = fra(11, 2, 10, 15)
  const noticias = { bloqueo: (ticker, t, minutos) => (t < pasa && minutos === 15 ? { texto: 'EUR IPC a las 10:00', hasta: pasa } : null) }
  const otros = []
  const cartera = crearCartera({ grupos: GRUPOS_TORTUGAS, maxPct: 6 })
  cartera.registrar('SRS', () => otros)
  const { bot, dir, enHora } = botDePrueba(ig, { '^GDAXI': diarioPlano(25_000, 150, '2026-10-30') }, soloS1, { cartera, noticias })
  try {
    enHora(fra(11, 2, 9, 0, 5)); await bot._paso()
    ig.precios['^GDAXI'] = [25_155, 25_156]
    vela1m('^GDAXI', fra(11, 2, 10), 25_156, 25_140)
    enHora(fra(11, 2, 10, 0, 20)); await bot._paso()
    assert.equal(posicion(bot, '^GDAXI'), null)
    assert.ok(bot.estado().eventos.some(e => /hay noticia \(EUR IPC a las 10:00\): no entra hasta que pase/.test(e.texto)))
    // pasada la noticia, el SRS tiene el FTSE comprado con todo el tope: no entra
    otros.push({ ticker: '^FTSE', lado: 'largo', riesgoEur: 1200 })
    vela1m('^GDAXI', fra(11, 2, 10, 15), 25_156, 25_150)
    enHora(pasa + 20); await bot._paso()
    assert.equal(posicion(bot, '^GDAXI'), null)
    assert.ok(bot.estado().eventos.some(e => /no entra: con índices europeos en largo ya hay 1200 € en riesgo \(SRS\)/.test(e.texto)))
    // el SRS sale, y al minuto entra
    otros.length = 0
    vela1m('^GDAXI', fra(11, 2, 10, 17), 25_156, 25_150)
    enHora(pasa + 90); await bot._paso()
    assert.ok(posicion(bot, '^GDAXI'))
    assert.ok(cartera.estado().posiciones.find(p => p.bot === 'Tortugas' && p.ticker === '^GDAXI').riesgoEur > 0)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('en EE. UU. usa el contrato de 1 € (o el de 1 $) y, sin ellos, el grande, que no cabe', async () => {
  const instrumentos = { ...soloDax.instrumentos, '^GDAXI': false, '^NDX': true }
  const diarios = { '^NDX': diarioPlano(29_000, 200, '2026-11-06') }
  const planDe = async sinPrecio => {
    const { bot, dir, enHora } = botDePrueba(igFalso({ precios: { '^NDX': [29_000, 29_002] }, sinPrecio }), diarios, { instrumentos, sistemas: [1] })
    try {
      enHora(fra(11, 9, 16)); await bot._paso()                // 10:00 en Nueva York
      return mercado(bot, '^NDX').plan
    } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
  }
  // 1% de 20.000 € = 200 € por N / 400 puntos a 1 €/punto = 0,5 contratos de 1 €
  let plan = await planDe([])
  assert.equal(plan.unidad.epic, 'IX.D.NASDAQ.ICE.IP')
  assert.equal(plan.unidad.tamano, 0.5)
  // sin el de 1 €, el de 1 $: 200 / (400 × 0,86) = 0,58 → 0,5
  plan = await planDe(['IX.D.NASDAQ.ICE.IP'])
  assert.equal(plan.unidad.epic, 'IX.D.NASDAQ.IEC.IP')
  assert.equal(plan.unidad.tamano, 0.5)
  // sin ninguno de los dos, el de 100 $: 0,2 contratos × 400 × 100 $ × 0,86 = 6.880 € por N, frente a 200
  plan = await planDe(['IX.D.NASDAQ.ICE.IP', 'IX.D.NASDAQ.IEC.IP'])
  assert.equal(plan.unidad.ok, false)
  assert.match(plan.unidad.motivo, /IX\.D\.NASDAQ\.ICE\.IP sin precio/)
  assert.match(plan.unidad.motivo, /costaría 6880 € por N/)
})

test('al arrancar recupera de IG las posiciones del bot y deja las de otros (SRS)', async () => {
  const ig = igFalso({ precios: { '^GDAXI': [25_300, 25_301] } })
  ig.reloj = () => 0
  ig.ponerPosicion({ dealId: 'X1', ticker: '^GDAXI', epic: 'IX.D.DAX.IFMM.IP', lado: 'largo', tamano: 0.6, nivel: 25_150, stop: 24_550, referencia: 'TOR2-GDAXI-20261019-abcd', abierta: '2026-10-19T08:00:00' })
  ig.ponerPosicion({ dealId: 'X2', ticker: '^GDAXI', epic: 'IX.D.DAX.IFMM.IP', lado: 'largo', tamano: 6, nivel: 25_150, stop: 25_100, referencia: 'SRS-GDAXI-20261019-wxyz', abierta: '2026-10-19T08:00:00' })
  const { bot, dir } = botDePrueba(ig, {}, soloDax)
  try {
    await bot._recuperar()
    assert.equal(posicion(bot, '^GDAXI', 1), null)
    const pos = posicion(bot, '^GDAXI', 2)                      // su referencia dice que es del Sistema 2
    assert.equal(pos.unidades.length, 1)
    assert.equal(pos.unidades[0].dealId, 'X1')
    assert.equal(pos.n0, 300)                                  // su stop está a 2 N
    assert.equal(pos.recuperada, true)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('al recuperar una pirámide, la N sale del stop de la última unidad, no de la primera', async () => {
  const ig = igFalso({ precios: { '^GDAXI': [25_600, 25_601] } })
  ig.reloj = () => 0
  // N = 300: entradas cada ½ N y el stop de todas a 2 N de la última (25.600 − 600)
  for (const [i, nivel] of [25_150, 25_300, 25_450, 25_600].entries())
    ig.ponerPosicion({ dealId: `X${i}`, ticker: '^GDAXI', epic: 'IX.D.DAX.IFMM.IP', lado: 'largo', tamano: 0.6, nivel, stop: 25_000, referencia: `TOR2-GDAXI-20261019-${i}abc`, abierta: `2026-10-19T08:0${i}:00` })
  const { bot, dir } = botDePrueba(ig, {}, soloDax)
  try {
    await bot._recuperar()
    const pos = posicion(bot, '^GDAXI', 2)
    assert.equal(pos.unidades.length, 4)
    assert.equal(pos.n0, 300)
    assert.equal(pos.stop, 25_000)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('si IG falla a mitad del plan, no lo reintenta en cada paso, y el saldo se pide una vez por ronda', async () => {
  const ig = igFalso({ precios: { '^GDAXI': [25_000, 25_001], '^FTSE': [10_000, 10_001] } })
  let cuentas = 0, fallar = true
  const cuenta = ig.operar.cuenta
  ig.operar.cuenta = async () => { cuentas++; if (fallar) throw new Error('IG limita las peticiones de esta clave: espera un minuto'); return cuenta() }
  const instrumentos = { ...soloDax.instrumentos, '^FTSE': true }
  const { bot, dir, enHora, avisos } = botDePrueba(ig, { '^GDAXI': diarioPlano(25_000, 150, '2026-11-13'), '^FTSE': diarioPlano(10_000, 50, '2026-11-13') }, { instrumentos, sistemas: [1] })
  try {
    enHora(fra(11, 16, 9, 0, 5)); await bot._paso()
    assert.match(mercado(bot, '^GDAXI').plan.error, /limita las peticiones/)
    assert.ok(avisos.some(a => /DAX · Sin plan: IG limita/.test(a)))
    const tras = cuentas
    enHora(fra(11, 16, 9, 0, 10)); await bot._paso()
    enHora(fra(11, 16, 9, 1, 0)); await bot._paso()
    assert.equal(cuentas, tras, 'ni a los 5 s ni al minuto')
    fallar = false
    enHora(fra(11, 16, 9, 2, 10)); await bot._paso()
    assert.equal(mercado(bot, '^GDAXI').plan.unidad.tamano, 0.6)
    assert.equal(mercado(bot, '^FTSE').plan.unidad.tamano, 2)
    assert.equal(cuentas, tras + 1, 'un saldo para los dos planes')
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('la configuración se valida y un cambio de riesgo rehace los planes', async () => {
  const ig = igFalso({})
  const { bot, dir, enHora } = botDePrueba(ig, { '^GDAXI': diarioPlano(25_000, 150) }, soloDax)
  try {
    assert.throws(() => bot.cambiarConfig({ sistemas: [3] }), /el 1, el 2 o los dos/)
    assert.throws(() => bot.cambiarConfig({ sistemas: [] }), /el 1, el 2 o los dos/)
    assert.throws(() => bot.cambiarConfig({ riesgoPct: 8 }), /entre el 0,05% y el 5%/)
    assert.throws(() => bot.cambiarConfig({ maxUnidades: 2.5 }), /de 1 a 10/)
    enHora(fra(10, 18, 21)); await bot._paso()
    assert.ok(mercado(bot, '^GDAXI').plan)
    bot.cambiarConfig({ riesgoPct: 2 })
    assert.equal(mercado(bot, '^GDAXI').plan, null)
    await bot._paso()
    assert.equal(mercado(bot, '^GDAXI').plan.unidad.tamano, 1.3)   // con los dos sistemas, cada entrada con todo el capital: 400 / 300
    bot.cambiarConfig({ sistemas: [2] })
    await bot._paso()
    assert.equal(mercado(bot, '^GDAXI').plan.unidad.tamano, 1.3)   // y con el Sistema 2 solo, lo mismo
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('juega los dos sistemas a la vez: cada uno entra en su canal, con todo el capital y su referencia', async () => {
  // un máximo de hace 40 sesiones separa los canales: el de 20 queda en 25.150 y el de 55, en 25.400
  const diario = diarioPlano(25_000, 150, '2026-11-20')
  diario[diario.length - 40] = { ...diario[diario.length - 40], high: 25_400 }
  const ig = igFalso({ precios: { '^GDAXI': [25_000, 25_001] } })
  const { bot, dir, enHora, avisos } = botDePrueba(ig, { '^GDAXI': diario }, soloDax)
  try {
    assert.deepEqual(bot._datos().config.sistemas, [1, 2])     // los dos, si no se dice otra cosa
    enHora(fra(11, 23, 9, 0, 5)); await bot._paso()
    const plan = mercado(bot, '^GDAXI').plan
    assert.equal(plan.sistemas[1].entrada.largo.nivel, 25_150)
    assert.equal(plan.sistemas[2].entrada.largo.nivel, 25_400)
    assert.equal(plan.sistemas[2].salida.largo, 24_850)
    // 1% de 20.000 € en cada entrada, de cualquier sistema: 200 € por N; con N ≈ 302, 0,66 → 0,6
    assert.equal(plan.riesgoEurN, 200)
    assert.equal(plan.unidad.tamano, 0.6)

    // rompe 20: entra solo el Sistema 1
    ig.precios['^GDAXI'] = [25_160, 25_161]
    vela1m('^GDAXI', fra(11, 23, 10), 25_161, 25_140)
    enHora(fra(11, 23, 10, 0, 20)); await bot._paso()
    assert.ok(posicion(bot, '^GDAXI', 1))
    assert.equal(posicion(bot, '^GDAXI', 2), null)

    // rompe 55 lejos de la unidad del 1 (con una sola unidad, el 1 no añade): entra también el
    // Sistema 2, en una posición aparte
    bot.cambiarConfig({ maxUnidades: 1 })
    ig.precios['^GDAXI'] = [25_405, 25_406]
    vela1m('^GDAXI', fra(11, 23, 11), 25_406, 25_390)
    enHora(fra(11, 23, 11, 0, 20)); await bot._paso()
    const s2 = posicion(bot, '^GDAXI', 2)
    assert.equal(s2.unidades.length, 1)
    assert.equal(s2.ruptura, 55)
    assert.match(s2.unidades[0].referencia, /^TOR2-GDAXI-/)
    assert.match(posicion(bot, '^GDAXI', 1).unidades[0].referencia, /^TOR1-GDAXI-/)
    assert.ok(avisos.some(a => /^Tortugas S2 · DAX · Compra de 0,6 a 25\.406/.test(a)))

    // dos órdenes (la entrada de cada uno), cada una su posición en IG
    assert.equal(ig.ordenes.filter(o => o.tipo === 'abrir').length, 2)
    assert.equal(new Set([...posicion(bot, '^GDAXI', 1).unidades, ...s2.unidades].map(u => u.dealId)).size, 2)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('los dos sistemas van como uno: una señal doble a precios parecidos se ejecuta una sola vez', async () => {
  // el mismo canal de 20 y de 55 (25.150): la misma ruptura es la señal de los dos
  const ig = igFalso({ precios: { '^GDAXI': [25_000, 25_001] } })
  const { bot, dir, enHora, avisos } = botDePrueba(ig, { '^GDAXI': diarioPlano(25_000, 150, '2026-11-20') }, soloDax)
  try {
    enHora(fra(11, 23, 9, 0, 5)); await bot._paso()
    ig.precios['^GDAXI'] = [25_160, 25_161]
    vela1m('^GDAXI', fra(11, 23, 10), 25_161, 25_140)
    enHora(fra(11, 23, 10, 0, 20)); await bot._paso()
    assert.ok(posicion(bot, '^GDAXI', 1))
    assert.equal(posicion(bot, '^GDAXI', 2), null)
    assert.equal(ig.ordenes.filter(o => o.tipo === 'abrir').length, 1)
    assert.ok(avisos.some(a => /^Tortugas S2 · DAX · .*señal doble/.test(a)))
    // y no lo vuelve a intentar ese día, aunque el precio se aleje
    ig.precios['^GDAXI'] = [25_200, 25_201]
    vela1m('^GDAXI', fra(11, 23, 10, 5), 25_201, 25_180)
    enHora(fra(11, 23, 10, 5, 20)); await bot._paso()
    assert.equal(posicion(bot, '^GDAXI', 2), null)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('una unidad del Sistema 1 a menos de ½ N de la ruptura de 55 hace que el 2 no entre', async () => {
  const diario = diarioPlano(25_000, 150, '2026-11-20')
  diario[diario.length - 40] = { ...diario[diario.length - 40], high: 25_400 }
  const ig = igFalso({ precios: { '^GDAXI': [25_000, 25_001] } })
  const { bot, dir, enHora } = botDePrueba(ig, { '^GDAXI': diario }, soloDax)
  try {
    enHora(fra(11, 23, 9, 0, 5)); await bot._paso()
    ig.precios['^GDAXI'] = [25_160, 25_161]
    vela1m('^GDAXI', fra(11, 23, 10), 25_161, 25_140)
    enHora(fra(11, 23, 10, 0, 20)); await bot._paso()
    // a 25.406 el 1 añade su segunda unidad, y esa es también la ruptura de 55 del 2
    ig.precios['^GDAXI'] = [25_405, 25_406]
    vela1m('^GDAXI', fra(11, 23, 11), 25_406, 25_390)
    enHora(fra(11, 23, 11, 0, 20)); await bot._paso()
    assert.equal(posicion(bot, '^GDAXI', 1).unidades.length, 2)
    assert.equal(posicion(bot, '^GDAXI', 2), null)
    assert.equal(ig.ordenes.filter(o => o.tipo === 'abrir').length, 2)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('un registro de antes de los dos sistemas se lee con sus posiciones en el sistema que tenía', async () => {
  const carpeta = mkdtempSync(join(tmpdir(), 'tortugas-'))
  const archivo = join(carpeta, 'Bot Tortugas.json')
  writeFileSync(archivo, JSON.stringify({
    config: { ...CONFIG_TORTUGAS_BOT, sistemas: undefined, sistema: 2, activo: true },
    posiciones: { '^GDAXI': { ticker: '^GDAXI', lado: 'largo', n0: 300, stop: 24_500, unidades: [{ dealId: 'V1', tamano: 0.6, entrada: 25_100 }] } },
    intentos: {}, planes: { '^GDAXI': { fecha: '2026-10-19', n: 300, k: 55 } }, operaciones: [], eventos: [],
  }))
  try {
    const bot = crearBotTortugas({ ig: igFalso({}), archivo, velasDiarias: async () => [], log: () => {} })
    const d = bot._datos()
    assert.deepEqual(d.config.sistemas, [1, 2])
    assert.equal(d.config.sistema, undefined)
    assert.equal(d.posiciones['^GDAXI|2'].sistema, 2)
    assert.equal(d.posiciones['^GDAXI'], undefined)
    assert.deepEqual(d.planes, {})
  } finally { rmSync(carpeta, { recursive: true, force: true }) }
})

test('con cortos: vende al romper el mínimo, añade ½ N más abajo y sale al romper el máximo de 10', async () => {
  const ig = igFalso({ precios: { '^GDAXI': [25_000, 25_001] } })
  const { bot, dir, enHora } = botDePrueba(ig, { '^GDAXI': diarioPlano(25_000, 150, '2026-11-27') }, { ...soloS1, lados: 'ambos' })
  try {
    enHora(fra(11, 30, 9, 0, 5)); await bot._paso()
    assert.equal(mercado(bot, '^GDAXI').plan.sistemas[1].entrada.corto.nivel, 24_850)
    // rompe el mínimo de 20: venta a la oferta de compra (bid) con el stop 2 N por encima
    ig.precios['^GDAXI'] = [24_845, 24_846]
    vela1m('^GDAXI', fra(11, 30, 10), 24_860, 24_844)
    enHora(fra(11, 30, 10, 0, 20)); await bot._paso()
    const venta = ig.ordenes.find(o => o.tipo === 'abrir')
    assert.deepEqual([venta.lado, venta.tamano, venta.stop], ['corto', 0.6, 25_445])
    // ½ N a favor es más abajo (24.695): otra unidad, y el stop de las dos baja a 2 N de ella
    ig.precios['^GDAXI'] = [24_694, 24_695]
    vela1m('^GDAXI', fra(11, 30, 11), 24_710, 24_690)
    enHora(fra(11, 30, 11, 0, 20)); await bot._paso()
    assert.equal(posicion(bot, '^GDAXI').unidades.length, 2)
    assert.equal(posicion(bot, '^GDAXI').stop, 25_294)
    // rompe el máximo de 10 (25.150): fuera las dos, comprando a la oferta
    ig.precios['^GDAXI'] = [25_154, 25_155]
    vela1m('^GDAXI', fra(11, 30, 12), 25_156, 25_100)
    enHora(fra(11, 30, 12, 0, 20)); await bot._paso()
    assert.equal(posicion(bot, '^GDAXI'), null)
    const op = bot.estado().operaciones[0]
    assert.equal(op.lado, 'corto')
    assert.equal(op.motivo, 'canal 10')
    assert.ok(Math.abs(op.resultadoEur - ((24_845 - 25_155) * 0.6 + (24_694 - 25_155) * 0.6)) < 1e-6)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

// ── Divisas y materias primas ──

const utcS = (mes, dia, h, m = 0, sg = 0) => Date.UTC(2026, mes - 1, dia, h, m, sg) / 1000
const solo = ticker => ({ instrumentos: Object.fromEntries(Object.keys(CONFIG_TORTUGAS_BOT.instrumentos).map(t => [t, t === ticker])), sistemas: [1] })

test('las divisas tienen su día de 17:00 a 17:00 de Nueva York y las materias primas, de 18:00 a 17:00', () => {
  // domingo 18-oct a las 18:00 de Nueva York (22:00 UTC): ya es la sesión del lunes
  const lunes = sesionTortugas('EURUSD', utcS(10, 18, 22))
  assert.equal(lunes.fecha, '2026-10-19')
  assert.equal(lunes.abre, utcS(10, 18, 21))
  assert.equal(lunes.cierra, utcS(10, 19, 21))
  // el viernes a las 17:30 de Nueva York no queda sesión hasta el domingo
  const viernes = utcS(10, 23, 21, 30)
  const s = sesionTortugas('EURUSD', viernes)
  assert.ok(!(viernes >= s.abre && viernes < s.cierra))
  assert.equal(proximaAperturaTortugas('EURUSD', viernes), utcS(10, 25, 21))
  // el crudo abre el domingo a las 18:00 de Nueva York
  assert.equal(sesionTortugas('USOIL', utcS(10, 18, 23)).abre, utcS(10, 18, 22))
  // y los índices, a la hora de su bolsa, como el bot SRS
  assert.equal(sesionTortugas('^GDAXI', utcS(10, 19, 12)).abre, sesionDe('^GDAXI', utcS(10, 19, 12)).abre)
})

test('divisas: el plan, dos horas y media después de abrir; la unidad, por pip; el stop, con sus 5 decimales', async () => {
  const ig = igFalso({ precios: { EURUSD: [1.12, 1.12008] } })
  // un diario plano de 1,117 a 1,123: N = 0,006, máximo de 20 = 1,123
  const { bot, dir, enHora } = botDePrueba(ig, { EURUSD: diarioPlano(1.12, 0.003) }, solo('EURUSD'))
  try {
    enHora(utcS(10, 18, 21, 10)); await bot._paso()               // domingo, 10 min después de abrir
    assert.equal(mercado(bot, 'EURUSD').plan, null)
    enHora(utcS(10, 18, 23, 31)); await bot._paso()               // 2 h 31 min después
    const plan = mercado(bot, 'EURUSD').plan
    assert.equal(plan.fecha, '2026-10-19')
    assert.ok(Math.abs(plan.n - 0.006) < 1e-12)
    // 1% de 20.000 € = 200 € por N; una N son 60 pips × 1 $ × 0,86 = 51,6 € por contrato mini: 3,8
    assert.equal(plan.unidad.epic, 'CS.D.EURUSD.CECM.IP')
    assert.equal(plan.unidad.tamano, 3.8)
    // rompe 1,123: compra con el stop a 2 N (0,012), redondeado a 5 decimales
    ig.precios.EURUSD = [1.12305, 1.12312]
    vela1m('EURUSD', utcS(10, 18, 23, 40), 1.12315, 1.1229)
    enHora(utcS(10, 18, 23, 40, 20)); await bot._paso()
    const abrir = ig.ordenes.find(o => o.tipo === 'abrir')
    assert.equal(abrir.tamano, 3.8)
    assert.equal(abrir.stop, 1.11112)
    assert.ok(bot.estado().eventos.some(e => /Compra de 3,8 a 1,12312/.test(e.texto)))
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('el respaldo del oro y la plata: las velas de 1 h, en las sesiones del bot (de 18:00 a 17:00 de Nueva York)', () => {
  // cada hora desde el viernes 16-oct a las 15:00 de Nueva York hasta el martes a las 09:00,
  // con el fin de semana y la pausa de las 17:00 dentro; la hora k vale k
  const inicio = Date.parse('2026-10-16T15:00:00-04:00') / 1000
  const horas = Array.from({ length: 91 }, (_, k) => ({ time: inicio + 3600 * k, open: k, high: k + 0.5, low: k - 0.5, close: k + 0.2 }))
  const dias = diariasDeSesiones('XAUUSD', horas)
  assert.deepEqual(dias, [
    { date: '2026-10-16', open: 0, high: 1.5, low: -0.5, close: 1.2 },      // el viernes, hasta las 17:00
    { date: '2026-10-19', open: 51, high: 73.5, low: 50.5, close: 73.2 },   // del domingo a las 18:00 al lunes a las 17:00
    { date: '2026-10-20', open: 75, high: 90.5, low: 74.5, close: 90.2 },   // sin la hora de las 17:00 del lunes
  ])
  assert.equal(sesionesQueFaltan(dias), 0)
  assert.equal(sesionesQueFaltan([dias[0], dias[2]]), 1)                    // falta el lunes
  assert.equal(sesionesQueFaltan([]), Infinity)
})

test('oro: sin histórico de IG, el plan sale de su respaldo y lo dice', async () => {
  const ig = igFalso({ precios: { XAUUSD: [4000, 4000.4] } })
  const diario = diarioPlano(4000, 30, '2026-10-16')
  diario.respaldo = 'Twelve Data'
  const { bot, dir, enHora } = botDePrueba(ig, { XAUUSD: diario }, solo('XAUUSD'))
  try {
    enHora(utcS(10, 19, 0, 31)); await bot._paso()                // lunes 00:31 UTC: 2 h 31 min después de abrir
    const plan = mercado(bot, 'XAUUSD').plan
    assert.equal(plan.error, undefined)
    assert.equal(plan.respaldo, 'Twelve Data')
    assert.equal(plan.n, 60)
    assert.equal(plan.sistemas[1].entrada.largo.nivel, 4030)
    assert.ok(bot.estado().eventos.some(e => /niveles de Twelve Data: IG no da su histórico/.test(e.texto)))
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('materias primas: sin cupo de histórico de IG, el plan espera una hora en vez de insistir', async () => {
  const ig = igFalso({})
  const sinCupo = new Error('Agotado el cupo semanal de histórico de IG; el directo sigue funcionando')
  const { bot, dir, enHora, pedidas, avisos } = botDePrueba(ig, { USOIL: sinCupo }, solo('USOIL'))
  try {
    enHora(utcS(10, 19, 0, 31)); await bot._paso()                // lunes 00:31 UTC: 2 h 31 min después de abrir
    assert.match(mercado(bot, 'USOIL').plan.error, /IG no da el diario: Agotado el cupo/)
    assert.equal(pedidas.filter(t => t === 'USOIL').length, 1)
    enHora(utcS(10, 19, 1, 0)); await bot._paso()
    assert.equal(pedidas.filter(t => t === 'USOIL').length, 1, 'no vuelve a pedirlo antes de una hora')
    enHora(utcS(10, 19, 1, 32)); await bot._paso()
    assert.equal(pedidas.filter(t => t === 'USOIL').length, 2)
    // un solo aviso por Telegram para el cupo, no uno por mercado
    assert.equal(avisos.filter(a => /no da el diario/.test(a)).length, 0)
    assert.equal(avisos.filter(a => /agotado el cupo semanal de histórico/.test(a)).length, 1)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('el añadido que salta las unidades del otro sistema siempre termina, aunque el redondeo no cuadre', () => {
  // con N = 301,7, (25.000,1 + ½ N) − 25.000,1 sale un pelo menor que ½ N: buscar otra vez
  // volvía a dar con la misma unidad y colgaba el servidor
  const pos = { lado: 'largo', n0: 301.7, unidades: [{ entrada: 24_900 }] }
  assert.ok(Math.abs(siguienteAnadido(pos, [25_000.1]) - (25_000.1 + 150.85)) < 1e-6)
  // varias seguidas, en cualquier orden: salta todas
  assert.ok(Math.abs(siguienteAnadido(pos, [25_250, 25_000.1, 25_120]) - (25_250 + 150.85)) < 1e-6)
  // en corto, hacia abajo
  const corto = { lado: 'corto', n0: 301.7, unidades: [{ entrada: 25_100 }] }
  assert.ok(Math.abs(siguienteAnadido(corto, [24_999.9]) - (24_999.9 - 150.85)) < 1e-6)
})
