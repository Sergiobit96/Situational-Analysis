// Tests del cliente de IG (server/ig.js) y del reparto en directo (server/tiempo-real.js),
// contra un IG simulado: no sale nada a la red
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  medio, velaDeHistorico, velaDeStreaming, elegirMercado, intervalosPendientes, cubrir, fundirVelas, acumularPrecio, crearIG, EPICS_IG, epicDeMercadoIg,
} from '../server/ig.js'
import { ultimasVelas } from '../server/tiempo-real.js'

test('precio medio, o el que haya', () => {
  assert.equal(medio(100, 102), 101)
  assert.equal(medio('100', null), 100)
  assert.ok(Number.isNaN(medio(null, '')))
})

test('vela del histórico a precio medio y en hora UTC', () => {
  const v = velaDeHistorico({
    snapshotTimeUTC: '2026-10-16T19:55:00',
    openPrice:  { bid: 100, ask: 102 }, highPrice:  { bid: 110, ask: 112 },
    lowPrice:   { bid: 90,  ask: 92 },  closePrice: { bid: 105, ask: 107 },
  })
  assert.deepEqual(v, { time: Date.UTC(2026, 9, 16, 19, 55) / 1000, open: 101, high: 111, low: 91, close: 106 })
  assert.equal(velaDeHistorico({ snapshotTimeUTC: '2026-10-16T19:55:00', openPrice: {} }), null)
})

test('vela del streaming, con la hora redondeada al minuto', () => {
  const campos = { UTM: String(Date.UTC(2026, 9, 19, 8, 3, 27)), BID_OPEN: '25400', OFR_OPEN: '25401', BID_HIGH: '25410', OFR_HIGH: '25411',
    BID_LOW: '25390', OFR_LOW: '25391', BID_CLOSE: '25405', OFR_CLOSE: '25406' }
  assert.deepEqual(velaDeStreaming(c => campos[c]), {
    time: Date.UTC(2026, 9, 19, 8, 3) / 1000, open: 25400.5, high: 25410.5, low: 25390.5, close: 25405.5,
  })
  // un snapshot sin precios todavía no es una vela
  assert.equal(velaDeStreaming(c => (c === 'UTM' ? campos.UTM : null)), null)
})

test('elige el mercado de contado, y el mini solo si no hay otro', () => {
  const m = (epic, instrumentName, expiry = '-', instrumentType = 'INDICES') => ({ epic, instrumentName, expiry, instrumentType })
  assert.equal(elegirMercado([
    m('IX.D.DAX.MAR.IP', 'Germany 40 Futuro', 'DIC-26'),
    m('IX.D.DAX.IFMM.IP', 'Germany 40 Mini'),
    m('IX.D.DAX.IFD.IP', 'Germany 40 Cash'),
  ]).epic, 'IX.D.DAX.IFD.IP')
  assert.equal(elegirMercado([m('IX.D.DAX.IFMM.IP', 'Germany 40 Mini')]).epic, 'IX.D.DAX.IFMM.IP')
  assert.equal(elegirMercado([m('XX', 'Wall Street Bank', '-', 'SHARES')]), null)
})

test('intervalos pendientes y cubiertos', () => {
  assert.deepEqual(intervalosPendientes([], 0, 10), [[0, 10]])
  assert.deepEqual(intervalosPendientes([[2, 4], [6, 8]], 0, 10), [[0, 2], [4, 6], [8, 10]])
  assert.deepEqual(intervalosPendientes([[0, 10]], 3, 7), [])
  assert.deepEqual(cubrir([[0, 2], [6, 8]], 2, 6), [[0, 8]])
  assert.deepEqual(cubrir([[0, 2]], 5, 5), [[0, 2]])
  assert.deepEqual(fundirVelas([{ time: 1, close: 1 }, { time: 2, close: 2 }], [{ time: 2, close: 9 }, { time: 3, close: 3 }]),
    [{ time: 1, close: 1 }, { time: 2, close: 9 }, { time: 3, close: 3 }])
})

// ── El cliente entero contra un IG de mentira ──

function igFalso() {
  const peticiones = []
  const precio = (t, c) => ({ snapshotTimeUTC: new Date(t * 1000).toISOString().slice(0, 19),
    openPrice: { bid: c, ask: c + 2 }, highPrice: { bid: c + 5, ask: c + 7 }, lowPrice: { bid: c - 5, ask: c - 3 }, closePrice: { bid: c + 1, ask: c + 3 } })
  const fetchFn = async (url, init) => {
    peticiones.push({ url, init })
    const ruta = url.replace('https://demo-api.ig.com/gateway/deal', '')
    const json = body => ({ ok: true, status: 200, json: async () => body, headers: new Headers({ CST: 'cst1', 'X-SECURITY-TOKEN': 'xst1' }) })
    if (ruta === '/session') {
      const { identifier, password } = JSON.parse(init.body)
      if (identifier !== 'yo' || password !== 'secreta') return { ok: false, status: 401, json: async () => ({ errorCode: 'error.security.invalid-details' }), headers: new Headers() }
      return json({ currentAccountId: 'ABC123', lightstreamerEndpoint: 'https://demo-apd.ejemplo' })
    }
    if (ruta.startsWith('/markets')) {
      const termino = new URL('http://x' + ruta).searchParams.get('searchTerm')
      return json({ markets: termino === 'Germany 40' ? [{ epic: 'IX.D.DAX.IFD.IP', instrumentName: 'Germany 40 Cash', expiry: '-', instrumentType: 'INDICES' }] : [] })
    }
    if (ruta.startsWith('/prices/')) {
      const qs = new URL('http://x' + ruta).searchParams
      const desde = Date.parse(qs.get('from') + 'Z') / 1000, hasta = Date.parse(qs.get('to') + 'Z') / 1000
      const prices = []
      for (let t = Math.ceil(desde / 300) * 300; t < hasta; t += 300) prices.push(precio(t, 25000))
      return json({ prices, metadata: { allowance: { remainingAllowance: 9000, totalAllowance: 10000 } } })
    }
    return { ok: false, status: 404, json: async () => ({}), headers: new Headers() }
  }
  return { fetchFn, peticiones }
}

// Un Lightstreamer de mentira que guarda la suscripción para poder mandarle actualizaciones
function lightstreamerFalso() {
  const yo = { usuario: null, clave: null, subs: [], quitadas: [] }
  class LightstreamerClient {
    constructor(endpoint) { yo.endpoint = endpoint; this.connectionDetails = { setUser: u => { yo.usuario = u }, setPassword: p => { yo.clave = p } } }
    addListener() {}
    subscribe(sub) { yo.subs.push(sub) }
    unsubscribe(sub) { yo.subs = yo.subs.filter(s => s !== sub); yo.quitadas.push(sub) }
    connect() {}
    disconnect() {}
  }
  class Subscription {
    constructor(modo, items, campos) { Object.assign(this, { modo, items, campos, oyentes: [] }) }
    setRequestedSnapshot() {}
    addListener(o) { this.oyentes.push(o) }
  }
  yo.Lightstreamer = { LightstreamerClient, Subscription }
  const de = item => yo.subs.filter(s => s.items.includes(item))
  yo.mandar = (item, campos) => de(item).forEach(s => s.oyentes.forEach(o => o.onItemUpdate({ getItemName: () => item, getValue: c => campos[c] ?? null })))
  yo.rechazar = item => de(item).forEach(s => s.oyentes.forEach(o => o.onSubscriptionError(-1, 'Insufficient permissions')))
  yo.aceptar = item => de(item).forEach(s => s.oyentes.forEach(o => o.onSubscription?.()))
  return yo
}

test('entra, usa los mercados de contado comprobados, se suscribe a sus velas de 1 min y las reparte', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ig-'))
  try {
    const { fetchFn, peticiones } = igFalso()
    const ls = lightstreamerFalso()
    const ig = crearIG({ apiKey: 'k', usuario: 'yo', password: 'secreta', cacheDir: dir, pausaBusquedaMs: 0, fetchFn, Lightstreamer: ls.Lightstreamer })
    await ig.iniciar()

    const e = ig.estado()
    assert.equal(e.sesion, 'abierta')
    assert.equal(e.cuenta, 'ABC123')
    assert.deepEqual(e.epics, EPICS_IG)
    // la clave de API va en cada petición y los tokens en todas menos el login
    assert.ok(peticiones.every(p => p.init.headers['X-IG-API-KEY'] === 'k'))
    // sin búsquedas: los mercados ya se conocen
    assert.equal(peticiones.filter(p => p.url.includes('/markets') || p.url.includes('/watchlists')).length, 0)

    // streaming: usuario = cuenta, contraseña = los dos tokens
    assert.equal(ls.endpoint, 'https://demo-apd.ejemplo')
    assert.equal(ls.usuario, 'ABC123')
    assert.equal(ls.clave, 'CST-cst1|XST-xst1')
    // una suscripción por instrumento (los 10 del gráfico y las divisas y materias primas del bot de las tortugas)
    assert.equal(ls.subs.length, Object.keys(EPICS_IG).length)
    assert.equal(ls.subs.length, 25)
    assert.deepEqual(ls.subs[0].items, ['CHART:IX.D.DAX.IFMM.IP:1MINUTE'])

    const utm = Date.UTC(2026, 9, 19, 8, 3, 10)
    ls.mandar('CHART:IX.D.DAX.IFMM.IP:1MINUTE', { UTM: String(utm), BID_OPEN: '1', OFR_OPEN: '3', BID_HIGH: '5', OFR_HIGH: '7', BID_LOW: '0', OFR_LOW: '2', BID_CLOSE: '4', OFR_CLOSE: '6' })
    assert.deepEqual(ultimasVelas('ig', '^GDAXI'), [{ time: Date.UTC(2026, 9, 19, 8, 3) / 1000, open: 2, high: 6, low: 1, close: 5 }])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('el histórico se pide una vez y luego sale de la caché', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ig-'))
  try {
    const { fetchFn, peticiones } = igFalso()
    const ig = crearIG({ apiKey: 'k', usuario: 'yo', password: 'secreta', cacheDir: dir, pausaBusquedaMs: 0, fetchFn, Lightstreamer: lightstreamerFalso().Lightstreamer })
    await ig.iniciar()
    const desde = Date.UTC(2026, 9, 14, 8) / 1000, hasta = Date.UTC(2026, 9, 14, 10) / 1000
    const v1 = await ig.velasEntre('^GDAXI', 'm5', desde, hasta)
    assert.equal(v1.length, 24)
    assert.equal(v1[0].open, 25001)
    assert.equal(ig.estado().cupo.remainingAllowance, 9000)

    const antes = peticiones.filter(p => p.url.includes('/prices/')).length
    const v2 = await ig.velasEntre('^GDAXI', 'm5', desde + 1800, hasta)
    assert.equal(v2.length, 18)
    assert.equal(peticiones.filter(p => p.url.includes('/prices/')).length, antes)   // nada nuevo a IG

    // y otro cliente (otro arranque del servidor) la lee del disco
    const otro = crearIG({ apiKey: 'k', usuario: 'yo', password: 'secreta', cacheDir: dir, pausaBusquedaMs: 0, fetchFn, Lightstreamer: lightstreamerFalso().Lightstreamer })
    await otro.iniciar()
    const n = peticiones.length
    assert.equal((await otro.velasEntre('^GDAXI', 'm5', desde, hasta)).length, 24)
    assert.equal(peticiones.filter(p => p.url.includes('/prices/')).length, peticiones.slice(0, n).filter(p => p.url.includes('/prices/')).length)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('el gráfico deja para el bot de las tortugas lo último del cupo de histórico, y sin cupo no lo pide', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ig-'))
  try {
    const { fetchFn, peticiones } = igFalso()
    let sinCupo = false
    const conCupo = async (url, init) => (sinCupo && url.includes('/prices/')
      ? (peticiones.push({ url, init }), { ok: false, status: 403, json: async () => ({ errorCode: 'error.public-api.exceeded-account-historical-data-allowance' }), headers: new Headers() })
      : fetchFn(url, init))
    const ig = crearIG({ apiKey: 'k', usuario: 'yo', password: 'secreta', cacheDir: dir, pausaBusquedaMs: 0, fetchFn: conCupo, Lightstreamer: lightstreamerFalso().Lightstreamer })
    await ig.iniciar()
    const dia = (d, h) => Date.UTC(2026, 9, d, h) / 1000
    const precios = () => peticiones.filter(p => p.url.includes('/prices/')).length
    // quedan 9000: con 2500 de reserva se pide
    assert.equal((await ig.velasEntre('^GDAXI', 'm5', dia(14, 8), dia(14, 9), { reservar: 2500 })).length, 12)
    // con 9500 de reserva, no: se contesta como sin cupo y no se pregunta a IG
    const antes = precios()
    await assert.rejects(ig.velasEntre('^GDAXI', 'm5', dia(15, 8), dia(15, 9), { reservar: 9500 }), /cupo semanal de histórico de IG \(9000 puntos\) es para el bot/)
    assert.equal(precios(), antes)
    // lo que ya está en la caché sale aunque no quede cupo
    assert.equal((await ig.velasEntre('^GDAXI', 'm5', dia(14, 8), dia(14, 9), { reservar: 9500 })).length, 12)
    // IG se queda sin cupo: desde ahí el gráfico no lo pide, y el bot sí, para ver si ha vuelto
    sinCupo = true
    await assert.rejects(ig.velasEntre('^GDAXI', 'm5', dia(16, 8), dia(16, 9)), /Agotado el cupo semanal/)
    assert.equal(ig.estado().cupo.remainingAllowance, 0)
    const n = precios()
    await assert.rejects(ig.velasEntre('^GDAXI', 'm5', dia(16, 8), dia(16, 9), { reservar: 2500 }), /es para el bot/)
    assert.equal(precios(), n)
    await assert.rejects(ig.velasEntre('^GDAXI', 'm5', dia(16, 8), dia(16, 9)), /Agotado el cupo semanal/)
    assert.equal(precios(), n + 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('con credenciales malas lo dice claro y no se queda reintentando', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ig-'))
  try {
    const { fetchFn } = igFalso()
    const ig = crearIG({ apiKey: 'k', usuario: 'yo@correo.es', password: 'x', cacheDir: dir, pausaBusquedaMs: 0, fetchFn, Lightstreamer: lightstreamerFalso().Lightstreamer })
    await ig.iniciar()
    assert.equal(ig.estado().sesion, 'error')
    assert.match(ig.estado().error, /nombre de usuario, no el correo/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('la vela de 1 min con cotizaciones sueltas', () => {
  const t = Date.UTC(2026, 9, 19, 8, 3, 0)
  let v = acumularPrecio(null, 100, t + 5_000)
  v = acumularPrecio(v, 104, t + 20_000)
  v = acumularPrecio(v, 98, t + 40_000)
  v = acumularPrecio(v, 101, t + 59_000)
  assert.deepEqual(v, { time: t / 1000, open: 100, high: 104, low: 98, close: 101 })
  assert.deepEqual(acumularPrecio(v, 102, t + 61_000), { time: t / 1000 + 60, open: 102, high: 102, low: 102, close: 102 })
})

test('si IG rechaza las velas, tira de la cotización suelta, y solo con el mercado abierto', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ig-'))
  try {
    const { fetchFn } = igFalso()
    const ls = lightstreamerFalso()
    const ig = crearIG({ apiKey: 'k', usuario: 'yo', password: 'secreta', cacheDir: dir, pausaBusquedaMs: 0, fetchFn, Lightstreamer: ls.Lightstreamer })
    await ig.iniciar()
    ls.rechazar('CHART:IX.D.FTSE.IFE.IP:1MINUTE')
    const precios = ls.subs.find(s => s.items[0] === 'MARKET:IX.D.FTSE.IFE.IP')
    assert.ok(precios, 'se suscribe a la cotización')
    assert.deepEqual(precios.campos, ['BID', 'OFFER', 'MARKET_STATE'])
    ls.aceptar('MARKET:IX.D.FTSE.IFE.IP')
    assert.match(ig.estado().suscripciones['^FTSE'], /cotización suelta/)

    ls.mandar('MARKET:IX.D.FTSE.IFE.IP', { BID: '10000', OFFER: '10002', MARKET_STATE: 'EDITS_ONLY' })
    assert.deepEqual(ultimasVelas('ig', '^FTSE'), [])   // cerrado: no es un precio de ahora
    ls.mandar('MARKET:IX.D.FTSE.IFE.IP', { BID: '10000', OFFER: '10002', MARKET_STATE: 'TRADEABLE' })
    ls.mandar('MARKET:IX.D.FTSE.IFE.IP', { BID: '10004', OFFER: '10006', MARKET_STATE: 'TRADEABLE' })
    const [v] = ultimasVelas('ig', '^FTSE').slice(-1)
    assert.equal(v.open, 10001)
    assert.equal(v.close, 10005)
    assert.equal(v.high, 10005)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('los precios que IG da en centavos se pasan a dólares', async () => {
  const { escalar, EPICS_IG: epics } = await import('../server/ig.js')
  const v = { time: 1, open: 9925.5, high: 9930.8, low: 9923.1, close: 9929.7 }
  const e = escalar(v, epics.USOIL.escala)
  for (const [campo, esperado] of Object.entries({ open: 99.255, high: 99.308, low: 99.231, close: 99.297 })) {
    assert.ok(Math.abs(e[campo] - esperado) < 1e-9, `${campo}: ${e[campo]}`)
  }
  assert.equal(escalar(v, epics['^GDAXI'].escala), v)   // los índices van tal cual
})

test('escribir a un gráfico que ya se cerró no tumba el servidor', async () => {
  const { suscribir, registrarVela: registrar } = await import('../server/tiempo-real.js')
  const escritos = []
  const res = {
    destroyed: false, writableEnded: false, oyentes: {},
    setHeader() {}, flushHeaders() {}, on(ev, fn) { this.oyentes[ev] = fn },
    write(t) { if (this.destroyed) throw new Error('write after end'); escritos.push(t) },
  }
  const desconectar = suscribir(res, 'ig', 'PRUEBA')
  registrar('ig', 'PRUEBA', { time: 60, open: 1, high: 2, low: 0, close: 1 })
  res.destroyed = true                                   // el navegador cerró el gráfico
  assert.doesNotThrow(() => registrar('ig', 'PRUEBA', { time: 120, open: 1, high: 2, low: 0, close: 1 }))
  assert.equal(typeof res.oyentes.error, 'function')     // los errores de la conexión se descartan
  assert.equal(escritos.filter(t => t.startsWith('event: velas')).length, 2)   // la inicial y la primera
  desconectar()
})

test('un mercado cualquiera de IG (ig:EPIC): histórico por su epic y directo mientras haya un gráfico abierto', async () => {
  assert.equal(epicDeMercadoIg('ig:CS.D.EURUSD.CEC.IP'), 'CS.D.EURUSD.CEC.IP')
  assert.equal(epicDeMercadoIg('ig:../../session'), null)
  assert.equal(epicDeMercadoIg('^GDAXI'), null)

  const dir = mkdtempSync(join(tmpdir(), 'ig-'))
  try {
    const { fetchFn, peticiones } = igFalso()
    const ls = lightstreamerFalso()
    const ig = crearIG({ apiKey: 'k', usuario: 'yo', password: 'secreta', cacheDir: dir, pausaBusquedaMs: 0, soltarTrasMs: 20, fetchFn, Lightstreamer: ls.Lightstreamer })
    await ig.iniciar()
    const ticker = 'ig:CS.D.EURUSD.CEC.IP'
    const desde = Date.UTC(2026, 9, 14, 8) / 1000, hasta = Date.UTC(2026, 9, 14, 9) / 1000
    assert.equal((await ig.velasEntre(ticker, 'm5', desde, hasta)).length, 12)
    assert.ok(peticiones.some(p => p.url.includes('/prices/CS.D.EURUSD.CEC.IP?')))

    const item = 'CHART:CS.D.EURUSD.CEC.IP:1MINUTE'
    const soltarA = ig.seguir(ticker)
    const soltarB = ig.seguir(ticker)
    assert.equal(ls.subs.filter(s => s.items.includes(item)).length, 1)   // dos gráficos, una suscripción
    const utm = Date.UTC(2026, 9, 19, 8, 3, 10)
    ls.mandar(item, { UTM: String(utm), BID_OPEN: '1.1', OFR_OPEN: '1.1002', BID_HIGH: '1.1', OFR_HIGH: '1.1002', BID_LOW: '1.1', OFR_LOW: '1.1002', BID_CLOSE: '1.1', OFR_CLOSE: '1.1002' })
    assert.equal(ultimasVelas('ig', ticker).at(-1).close, 1.1001)

    soltarA()
    soltarB()
    soltarB()   // soltar dos veces el mismo no descuenta otro gráfico
    await new Promise(r => setTimeout(r, 40))
    assert.equal(ls.subs.filter(s => s.items.includes(item)).length, 0)
    assert.equal(ls.quitadas.length, 1)
    // los mercados de la app no van por aquí: ya tienen su suscripción fija
    ig.seguir('^GDAXI')()
    assert.equal(ls.quitadas.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('si un gráfico vuelve a abrir el mercado suelto antes de soltarlo, la suscripción sigue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ig-'))
  try {
    const { fetchFn } = igFalso()
    const ls = lightstreamerFalso()
    const ig = crearIG({ apiKey: 'k', usuario: 'yo', password: 'secreta', cacheDir: dir, pausaBusquedaMs: 0, soltarTrasMs: 20, fetchFn, Lightstreamer: ls.Lightstreamer })
    await ig.iniciar()
    const ticker = 'ig:CS.D.GBPUSD.CEC.IP'
    ig.seguir(ticker)()
    const soltar = ig.seguir(ticker)   // otra temporalidad: cierra y abre enseguida
    await new Promise(r => setTimeout(r, 40))
    assert.equal(ls.subs.filter(s => s.items.includes('CHART:CS.D.GBPUSD.CEC.IP:1MINUTE')).length, 1)
    assert.equal(ls.quitadas.length, 0)
    soltar()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
