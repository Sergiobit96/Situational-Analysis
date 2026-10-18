// Tests del bot de las tortugas (server/bot-tortugas.js y server/tortugas-niveles.js) contra
// un IG de mentira y con un reloj que se mueve a mano: ninguna orden de verdad
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { nivelesTortugas } from '../server/tortugas-niveles.js'
import { siguientePasoTortugas, crearBotTortugas, capitalNominal, CONFIG_TORTUGAS_BOT } from '../server/bot-tortugas.js'
import { sesionDe } from '../server/bot-srs.js'
import { registrarVela } from '../server/tiempo-real.js'
import { offsetZona } from '../server/zonas.js'
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
      if (!e.pos) assert.equal(nv.alto[nv.gano ? 55 : 20], manana.compra.nivel)
    }
  }
  assert.equal(nivelesTortugas(serie(50)), null)
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
  fecha: '2026-10-19', calculado: fra(10, 19, 9, 0, 5), n: 300, k: 20, kSalida: 10,
  entrada: { largo: { nivel: 25_150, k: 20 }, corto: { nivel: 24_850, k: 20 } },
  salida: { largo: 24_850, corto: 25_150 },
  unidad: { ok: true, tamano: 0.6 },
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
  // stop por encima del canal: lo cierra IG, y el bot lo vigila de cerca
  assert.equal(con(24_900, 24_860, 24_870, { pos: { ...pos, stop: 24_880 } }).accion, 'revisar-ya')
  // fuera de la sesión, solo se vigila (el stop está en IG)
  assert.equal(paso({ pos, ahora: fra(10, 19, 20) }).accion, 'vigilar')
  assert.equal(paso({ pos, intento: { tipo: 'anadido' }, ahora }).accion, 'reconciliar')
})

// ── El bot entero, con un IG de mentira ──

const MERCADOS = {
  'IX.D.DAX.IFMM.IP':    { ticker: '^GDAXI', valorPunto: 1,   moneda: 'EUR', cambioAEur: 1,   tamanoMin: 0.5, conPrecio: true, factorMargen: 0.05 },
  'IX.D.FTSE.IFE.IP':    { ticker: '^FTSE',  valorPunto: 1,   moneda: 'EUR', cambioAEur: 1,   tamanoMin: 0.5, conPrecio: true, factorMargen: 0.05 },
  'IX.D.NASDAQ.IFMM.IP': { ticker: '^NDX',   valorPunto: 1,   moneda: 'USD', cambioAEur: 0.86, tamanoMin: 0.2, conPrecio: false },
  'IX.D.NASDAQ.IFD.IP':  { ticker: '^NDX',   valorPunto: 100, moneda: 'USD', cambioAEur: 0.86, tamanoMin: 0.2, conPrecio: true },
}

function igFalso({ precios = {}, saldo = 20_000, disponible = 20_000 } = {}) {
  const ordenes = []
  let abiertas = []
  let n = 0
  const ig = {
    precios,
    operar: {
      datosMercado: async (ticker, epic) => {
        const m = MERCADOS[epic] ?? MERCADOS['IX.D.DAX.IFMM.IP']
        const [bid, oferta] = ig.precios[ticker] ?? [25_000, 25_001]
        return { epic, ...m, stopMin: 8, estado: 'TRADEABLE', bid: m.conPrecio ? bid : null, oferta: m.conPrecio ? oferta : null, aMercado: true }
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

function botDePrueba(ig, diarios, cambios = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tortugas-'))
  let t = 0
  ig.reloj = () => t
  const avisos = []
  const pedidas = []
  const bot = crearBotTortugas({
    ig, archivo: join(dir, 'Bot Tortugas.json'), ahora: () => t, log: () => {}, revisarCadaMs: 0, avisar: x => avisos.push(x),
    velasDiarias: async ticker => { pedidas.push(ticker); return diarios[ticker] ?? [] },
  })
  bot.cambiarConfig({ activo: true, ...cambios })
  return { bot, dir, avisos, pedidas, enHora: x => { t = x }, archivo: join(dir, 'Bot Tortugas.json') }
}
const soloDax = { instrumentos: { '^N225': false, '^GDAXI': true, '^FTSE': false, '^NDX': false, '^GSPC': false, '^DJI': false, '^RUT': false } }
const vela1m = (ticker, time, high, low, close = (high + low) / 2) => registrarVela('ig', ticker, { time, open: close, high, low, close })
const mercado = (bot, ticker) => bot.estado().mercados.find(m => m.ticker === ticker)

test('el DAX de punta a punta: plan, ruptura, pirámide con el stop de todas, salida por el canal', async () => {
  const ig = igFalso({ precios: { '^GDAXI': [25_000, 25_001] } })
  const { bot, dir, avisos, enHora, archivo } = botDePrueba(ig, { '^GDAXI': diarioPlano(25_000, 150) }, soloDax)
  try {
    // domingo por la noche: el plan provisional del lunes, sin avisar
    enHora(fra(10, 18, 21)); await bot._paso()
    let m = mercado(bot, '^GDAXI')
    assert.equal(m.plan.provisional, true)
    assert.equal(m.plan.n, 300)
    assert.equal(m.plan.entrada.largo.nivel, 25_150)
    assert.equal(m.plan.salida.largo, 24_850)
    // 1% de 20.000 € = 200 € por N / 300 puntos a 1 €/punto = 0,67 → 0,6 contratos
    assert.equal(m.plan.unidad.tamano, 0.6)
    assert.equal(avisos.filter(a => /Próxima sesión/.test(a)).length, 0)

    // al abrir se rehace
    enHora(fra(10, 19, 9, 0, 5)); await bot._paso()
    m = mercado(bot, '^GDAXI')
    assert.equal(m.plan.provisional, false)

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
    assert.match(abrir.referencia, /^TOR-GDAXI-20261019-/)
    assert.equal(m.posicion.unidades.length, 1)
    assert.equal(m.posicion.unidades[0].deslizamiento, 6)
    assert.ok(avisos.some(a => /^Tortugas · DAX · Compra de 0,6 a 25\.156/.test(a)))

    // la misma vela no vuelve a entrar
    enHora(fra(10, 19, 10, 0, 40)); await bot._paso()
    assert.equal(ig.ordenes.filter(o => o.tipo === 'abrir').length, 1)

    // ½ N a favor (25.306): otra unidad y el stop de las dos a 2 N de ella
    ig.precios['^GDAXI'] = [25_307, 25_308]
    vela1m('^GDAXI', fra(10, 19, 11), 25_308, 25_290)
    enHora(fra(10, 19, 11, 0, 20)); await bot._paso()
    m = mercado(bot, '^GDAXI')
    assert.equal(m.posicion.unidades.length, 2)
    assert.equal(m.posicion.stop, 24_708)
    assert.deepEqual(ig.ordenes.filter(o => o.tipo === 'stop').map(o => [o.dealId, o.stop]), [['D1', 24_708]])

    // al día siguiente sigue abierta; rompe el mínimo de 10 sesiones: fuera las dos
    enHora(fra(10, 20, 9, 0, 5)); await bot._paso()
    assert.equal(mercado(bot, '^GDAXI').plan.fecha, '2026-10-20')
    ig.precios['^GDAXI'] = [24_845, 24_846]
    vela1m('^GDAXI', fra(10, 20, 10), 24_900, 24_840)
    enHora(fra(10, 20, 10, 0, 20)); await bot._paso()
    m = mercado(bot, '^GDAXI')
    assert.equal(m.posicion, null)
    assert.equal(ig.ordenes.filter(o => o.tipo === 'cerrar').length, 2)
    const op = bot.estado().operaciones[0]
    assert.equal(op.motivo, 'canal 10')
    assert.equal(op.unidades, 2)
    assert.ok(Math.abs(op.resultadoEur - ((24_845 - 25_156) * 0.6 + (24_845 - 25_308) * 0.6)) < 1e-6)
    assert.ok(Math.abs(op.resultadoN - ((24_845 - 25_156) + (24_845 - 25_308)) / 300) < 1e-9)

    const guardado = JSON.parse(readFileSync(archivo, 'utf8'))
    assert.equal(guardado.operaciones.length, 1)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('el stop que salta de noche en IG se apunta con el precio de la actividad', async () => {
  const ig = igFalso({ precios: { '^GDAXI': [25_000, 25_001] } })
  const { bot, dir, enHora } = botDePrueba(ig, { '^GDAXI': diarioPlano(25_000, 150, '2026-10-23') }, soloDax)
  try {
    enHora(fra(10, 26, 9, 0, 5)); await bot._paso()
    ig.precios['^GDAXI'] = [25_155, 25_156]
    vela1m('^GDAXI', fra(10, 26, 10), 25_156, 25_140)
    enHora(fra(10, 26, 10, 0, 20)); await bot._paso()
    assert.ok(mercado(bot, '^GDAXI').posicion)

    // a las 22:00 IG la ha cerrado con el stop; la actividad aún no lo tiene
    ig.quitarPosiciones()
    enHora(fra(10, 26, 22)); await bot._paso()
    assert.ok(mercado(bot, '^GDAXI').posicion, 'espera a que IG apunte el cierre')
    ig.nivelCierre = 24_550
    enHora(fra(10, 26, 22, 0, 30)); await bot._paso()
    assert.equal(mercado(bot, '^GDAXI').posicion, null)
    const op = bot.estado().operaciones[0]
    assert.equal(op.motivo, 'stop')
    assert.equal(op.salida, 24_550)
    assert.ok(Math.abs(op.resultadoEur - (24_550 - 25_156) * 0.6) < 1e-6)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('los límites de cartera: con el grupo lleno no entra otro índice del mismo grupo', async () => {
  const ig = igFalso({ precios: { '^GDAXI': [25_000, 25_001], '^FTSE': [10_000, 10_001] } })
  const instrumentos = { ...soloDax.instrumentos, '^FTSE': true }
  const { bot, dir, enHora } = botDePrueba(ig, { '^GDAXI': diarioPlano(25_000, 150, '2026-10-30'), '^FTSE': diarioPlano(10_000, 50, '2026-10-30') }, { instrumentos, maxGrupo: 1 })
  try {
    enHora(fra(11, 2, 9, 0, 5)); await bot._paso()
    ig.precios['^GDAXI'] = [25_155, 25_156]
    vela1m('^GDAXI', fra(11, 2, 10), 25_156, 25_140)
    enHora(fra(11, 2, 10, 0, 20)); await bot._paso()
    assert.ok(mercado(bot, '^GDAXI').posicion)
    // el FTSE rompe (09:00 en Londres = 10:00 en Fráncfort), pero Europa ya tiene 1 unidad larga
    ig.precios['^FTSE'] = [10_055, 10_056]
    vela1m('^FTSE', fra(11, 2, 10, 1), 10_056, 10_040)
    enHora(fra(11, 2, 10, 1, 20)); await bot._paso()
    assert.equal(mercado(bot, '^FTSE').posicion, null)
    assert.ok(bot.estado().eventos.some(e => e.ticker === '^FTSE' && /ya hay 1 unidades largas en Europa/.test(e.texto)))
    assert.equal(ig.ordenes.filter(o => o.tipo === 'abrir').length, 1)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('elige el contrato pequeño si tiene precio y, si no, el grande; si el mínimo arriesga más del doble, no opera', async () => {
  const ig = igFalso({ precios: { '^NDX': [29_000, 29_002] } })
  const instrumentos = { ...soloDax.instrumentos, '^GDAXI': false, '^NDX': true }
  const { bot, dir, enHora } = botDePrueba(ig, { '^NDX': diarioPlano(29_000, 200, '2026-11-06') }, { instrumentos })
  try {
    enHora(fra(11, 9, 16)); await bot._paso()                  // 10:00 en Nueva York
    const m = mercado(bot, '^NDX')
    // el de 1 $ no tiene precio; el de 100 $: 0,2 contratos × 400 × 100 $ × 0,86 = 6.880 € por N, frente a 200
    assert.equal(m.plan.unidad.ok, false)
    assert.match(m.plan.unidad.motivo, /IX\.D\.NASDAQ\.IFMM\.IP sin precio/)
    assert.match(m.plan.unidad.motivo, /costaría 6880 € por N/)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('al arrancar recupera de IG las posiciones del bot y deja las de otros (SRS)', async () => {
  const ig = igFalso({ precios: { '^GDAXI': [25_300, 25_301] } })
  ig.reloj = () => 0
  ig.ponerPosicion({ dealId: 'X1', ticker: '^GDAXI', epic: 'IX.D.DAX.IFMM.IP', lado: 'largo', tamano: 0.6, nivel: 25_150, stop: 24_550, referencia: 'TOR-GDAXI-20261019-abcd', abierta: '2026-10-19T08:00:00' })
  ig.ponerPosicion({ dealId: 'X2', ticker: '^GDAXI', epic: 'IX.D.DAX.IFMM.IP', lado: 'largo', tamano: 6, nivel: 25_150, stop: 25_100, referencia: 'SRS-GDAXI-20261019-wxyz', abierta: '2026-10-19T08:00:00' })
  const { bot, dir } = botDePrueba(ig, {}, soloDax)
  try {
    await bot._recuperar()
    const pos = mercado(bot, '^GDAXI').posicion
    assert.equal(pos.unidades.length, 1)
    assert.equal(pos.unidades[0].dealId, 'X1')
    assert.equal(pos.n0, 300)                                  // su stop está a 2 N
    assert.equal(pos.recuperada, true)
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})

test('la configuración se valida y un cambio de riesgo rehace los planes', async () => {
  const ig = igFalso({})
  const { bot, dir, enHora } = botDePrueba(ig, { '^GDAXI': diarioPlano(25_000, 150) }, soloDax)
  try {
    assert.throws(() => bot.cambiarConfig({ sistema: 3 }), /Sistema 1 o 2/)
    assert.throws(() => bot.cambiarConfig({ riesgoPct: 8 }), /entre el 0,05% y el 5%/)
    assert.throws(() => bot.cambiarConfig({ maxUnidades: 2.5 }), /de 1 a 10/)
    enHora(fra(10, 18, 21)); await bot._paso()
    assert.ok(mercado(bot, '^GDAXI').plan)
    bot.cambiarConfig({ riesgoPct: 2 })
    assert.equal(mercado(bot, '^GDAXI').plan, null)
    await bot._paso()
    assert.equal(mercado(bot, '^GDAXI').plan.unidad.tamano, 1.3)   // 400 € / 300
  } finally { bot.parar(); rmSync(dir, { recursive: true, force: true }) }
})
