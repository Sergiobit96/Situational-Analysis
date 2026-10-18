// ── IG: precios en tiempo real y su histórico, por la API de IG ──────────────────────
// Credenciales en server/.env (fuera de git):
//   IG_ENTORNO   demo | real
//   IG_API_KEY   la clave creada en Mi cuenta → Ajustes → Claves API
//   IG_USUARIO   el nombre de usuario con el que se entra (no el correo)
//   IG_PASSWORD  su contraseña
//   IG_EPICS     opcional: {"^GDAXI":"IX.D.DAX.IFMM.IP", …} para fijar a mano un mercado
//
// Tres piezas:
//   · la sesión REST: POST /session en su versión 2, que devuelve los tokens CST y
//     X-SECURITY-TOKEN; la versión 3 da OAuth, y el streaming no lo acepta;
//   · el histórico (GET /prices, versión 3), con caché en disco: IG da un cupo semanal de
//     puntos de histórico y cada vela que se pide lo gasta;
//   · el streaming (Lightstreamer): las velas de 1 min de cada instrumento en directo
//     (CHART:{epic}:1MINUTE), que van a tiempo-real.js.

import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { registrarVela } from './tiempo-real.js'
import { inicioDiaMadrid } from './velas-grafico.js'

const require = createRequire(import.meta.url)

const BASE = {
  demo: 'https://demo-api.ig.com/gateway/deal',
  real: 'https://api.ig.com/gateway/deal',
}

// Cómo se busca cada instrumento de la app en IG. Los nombres van en inglés y en español
// porque la búsqueda devuelve los nombres en el idioma de la cuenta.
export const BUSQUEDAS_IG = {
  '^GDAXI': ['Germany 40', 'Alemania 40'],
  '^FTSE':  ['FTSE 100', 'Reino Unido 100', 'UK 100'],
  '^NDX':   ['US Tech 100', 'EE.UU. Tech 100'],
  '^DJI':   ['Wall Street', 'EE.UU. 30'],
  '^GSPC':  ['US 500', 'EE.UU. 500'],
  '^RUT':   ['US Russell 2000', 'Russell 2000'],
  '^N225':  ['Japan 225', 'Japón 225'],
  'XAUUSD': ['Spot Gold', 'Oro al contado'],
  'XAGUSD': ['Spot Silver', 'Plata al contado'],
  'USOIL':  ['US Crude', 'Petróleo crudo de EE.UU.'],
}

// Los mercados de contado de cada instrumento, comprobados uno a uno el 18-oct-2026 con
// GET /markets/{epic} desde la cuenta demo de CFD del usuario. La regla que salió: el
// streaming acepta los mercados cuya ficha trae precio de compra y venta, y rechaza con
// "Invalid group" los que la traen vacía (en la demo, los índices americanos solo tienen
// precio en el contrato grande). Van fijos porque la búsqueda no siempre los encuentra
// (con la cuenta de Opciones solo devolvía opciones). Todos los de contado de un índice
// cotizan igual: cambia el tamaño del contrato, no el precio. `escala` pasa a dólares los
// que IG da en centavos.
export const EPICS_IG = {
  '^GDAXI': { epic: 'IX.D.DAX.IFMM.IP',      nombre: 'Alemania 40 al contado (1€)' },
  '^FTSE':  { epic: 'IX.D.FTSE.IFE.IP',      nombre: 'FTSE 100 al contado (1€)' },
  '^NDX':   { epic: 'IX.D.NASDAQ.IFD.IP',    nombre: 'EEUU Tech 100 al contado (100$)' },
  '^DJI':   { epic: 'IX.D.DOW.IFD.IP',       nombre: 'Wall Street al contado (10$)' },
  '^GSPC':  { epic: 'IX.D.SPTRD.IFD.IP',     nombre: 'EEUU 500 al contado (250$)' },
  '^RUT':   { epic: 'IX.D.RUSSELL.IFD.IP',   nombre: 'US Russell 2000 al Contado ($50)' },
  '^N225':  { epic: 'IX.D.NIKKEI.IFD.IP',    nombre: 'Japón 225 al contado (5$)' },
  'XAUUSD': { epic: 'CS.D.CFEGOLD.CEC.IP',   nombre: 'Spot Gold ($1)' },
  'XAGUSD': { epic: 'CS.D.CFDSILVER.CFM.IP', nombre: 'Plata contado (mini, 500oz)', escala: 0.01 },
  'USOIL':  { epic: 'CC.D.CL.UEC.IP',        nombre: 'Crudo - Crudo EE.UU. (1$)', escala: 0.01 },
}

// Los contratos con los que opera el bot, por orden de preferencia: primero el pequeño (1 €
// o 1 $ por punto), que deja ajustar el tamaño al riesgo; si la cuenta no puede operarlo,
// el grande (es el que tiene streaming en la demo, pero en el Nasdaq y el S&P su margen pasa
// del saldo de una demo de 20.000 €). Todos cotizan igual que el de EPICS_IG.
export const EPICS_OPERAR = {
  '^GDAXI': ['IX.D.DAX.IFMM.IP'],
  '^FTSE':  ['IX.D.FTSE.IFE.IP'],
  '^NDX':   ['IX.D.NASDAQ.IFMM.IP', 'IX.D.NASDAQ.IFD.IP'],
  '^GSPC':  ['IX.D.SPTRD.IFMM.IP', 'IX.D.SPTRD.IFD.IP'],
  '^DJI':   ['IX.D.DOW.IFE.IP', 'IX.D.DOW.IFD.IP'],
  '^RUT':   ['IX.D.RUSSELL.IFMM.IP', 'IX.D.RUSSELL.IFD.IP'],
  '^N225':  ['IX.D.NIKKEI.IFD.IP'],
}

// Una vela con los precios multiplicados por `escala` (si la hay)
export const escalar = (vela, escala) => (!escala || escala === 1 ? vela : {
  ...vela, open: vela.open * escala, high: vela.high * escala, low: vela.low * escala, close: vela.close * escala,
})

// Cómo se reconoce cada instrumento por su nombre en IG, en inglés o en español: sirve
// para las listas de seguimiento, que traen de todo, y para filtrar lo que da la búsqueda
export const NOMBRES_IG = {
  '^GDAXI': /alemania 40|germany 40/i,
  '^FTSE':  /ftse 100|reino unido 100|uk 100/i,
  '^NDX':   /tech 100|nasdaq/i,
  '^DJI':   /wall street|ee\.? ?uu\.? 30|us 30/i,
  '^GSPC':  /ee\.? ?uu\.? 500|us 500|s&p/i,
  '^RUT':   /russell/i,
  '^N225':  /jap[oó]n 225|japan 225|nikkei/i,
  'XAUUSD': /\boro\b|\bgold\b/i,
  'XAGUSD': /\bplata\b|\bsilver\b/i,
  'USOIL':  /^(?!.*brent).*(crudo|crude|\bwti\b)/i,   // el americano, no el Brent
}

// Resolución de IG para cada temporalidad del gráfico y días por página. Una página son
// unas 300 velas: lo bastante para llenar la pantalla sin quemar el cupo semanal.
export const IG_RESOLUCION = {
  m1:  { res: 'MINUTE',    segundos: 60,    diasPagina: 0.25 },
  m5:  { res: 'MINUTE_5',  segundos: 300,   diasPagina: 1 },
  m15: { res: 'MINUTE_15', segundos: 900,   diasPagina: 3 },
  m30: { res: 'MINUTE_30', segundos: 1800,  diasPagina: 6 },
  h1:  { res: 'HOUR',      segundos: 3600,  diasPagina: 12 },
  h4:  { res: 'HOUR_4',    segundos: 14400, diasPagina: 50 },
  d1:  { res: 'DAY',       segundos: 86400, diasPagina: 400 },
}

// Lo que IG contesta con un código, dicho de forma que se sepa qué tocar
const ERRORES = {
  'error.security.invalid-details':     'IG no acepta el usuario o la contraseña (IG_USUARIO es el nombre de usuario, no el correo)',
  'error.security.api-key-invalid':     'IG no reconoce la clave de API (IG_API_KEY). ¿Es de este entorno (demo o real)?',
  'error.security.invalid-application': 'IG no reconoce la clave de API (IG_API_KEY). ¿Es de este entorno (demo o real)?',
  'error.security.api-key-disabled':    'La clave de API está desactivada en IG',
  'error.security.account-suspended':   'IG tiene la cuenta suspendida',
  'error.public-api.exceeded-api-key-allowance': 'IG limita las peticiones de esta clave: espera un minuto',
  'error.public-api.exceeded-account-historical-data-allowance': 'Agotado el cupo semanal de histórico de IG; el directo sigue funcionando',
}
const mensaje = codigo => ERRORES[codigo] ?? `IG: ${codigo}`

// ── Piezas puras (probadas en test/ig.test.js) ──

const numero = v => (v === null || v === undefined || v === '' ? NaN : Number(v))

// Precio medio entre compra y venta, o el que haya si falta uno
export function medio(bid, ask) {
  const b = numero(bid), a = numero(ask)
  if (Number.isFinite(b) && Number.isFinite(a)) return (b + a) / 2
  return Number.isFinite(b) ? b : a
}

// Una vela del histórico de IG (GET /prices) como la usa el gráfico, a precio medio
export function velaDeHistorico(p) {
  const time = Date.parse(`${p.snapshotTimeUTC}Z`) / 1000
  const vela = {
    time,
    open:  medio(p.openPrice?.bid,  p.openPrice?.ask),
    high:  medio(p.highPrice?.bid,  p.highPrice?.ask),
    low:   medio(p.lowPrice?.bid,   p.lowPrice?.ask),
    close: medio(p.closePrice?.bid, p.closePrice?.ask),
  }
  return Object.values(vela).every(Number.isFinite) ? vela : null
}

// Una actualización del streaming (CHART:{epic}:1MINUTE) como vela de 1 min a precio medio.
// `valor` devuelve el texto de un campo, como Lightstreamer.
export function velaDeStreaming(valor) {
  const utm = numero(valor('UTM'))
  const lado = campo => medio(valor(`BID_${campo}`), valor(`OFR_${campo}`))
  const vela = {
    time:  Math.floor(utm / 60_000) * 60,
    open:  lado('OPEN'),
    high:  lado('HIGH'),
    low:   lado('LOW'),
    close: lado('CLOSE'),
  }
  return Object.values(vela).every(Number.isFinite) ? vela : null
}

// La vela de 1 min hecha con cotizaciones sueltas: la del minuto en curso se amplía y, al
// cambiar de minuto, empieza otra con el precio que llega
export function acumularPrecio(vela, precio, ms) {
  const minuto = Math.floor(ms / 60_000) * 60
  if (!vela || vela.time !== minuto) return { time: minuto, open: precio, high: precio, low: precio, close: precio }
  return { ...vela, high: Math.max(vela.high, precio), low: Math.min(vela.low, precio), close: precio }
}

// El mercado de contado (sin vencimiento) entre los resultados de una búsqueda; el mini y
// los de opciones, solo si no hay otro. Todos los de contado de un índice cotizan igual:
// cambia el tamaño del contrato, no el precio.
export function elegirMercado(mercados) {
  const validos = (mercados ?? []).filter(m =>
    (m.expiry === '-' || m.expiry === 'DFB') &&
    ['INDICES', 'COMMODITIES', 'CURRENCIES'].includes(m.instrumentType))
  const penaliza = m => (/mini/i.test(m.instrumentName) ? 1 : 0) + (/opci|option/i.test(m.instrumentName) ? 2 : 0)
  return validos.sort((a, b) => penaliza(a) - penaliza(b))[0] ?? null
}

// Intervalos [a, b) de [desde, hasta) que no están en `cubiertos` (ordenados y sin solapes)
export function intervalosPendientes(cubiertos, desde, hasta) {
  const pendientes = []
  let cursor = desde
  for (const [a, b] of cubiertos) {
    if (b <= cursor) continue
    if (a >= hasta) break
    if (a > cursor) pendientes.push([cursor, Math.min(a, hasta)])
    cursor = Math.max(cursor, b)
    if (cursor >= hasta) break
  }
  if (cursor < hasta) pendientes.push([cursor, hasta])
  return pendientes
}

// Añade [desde, hasta) a los intervalos cubiertos, fundiendo los que se tocan
export function cubrir(cubiertos, desde, hasta) {
  if (hasta <= desde) return cubiertos
  const todos = [...cubiertos, [desde, hasta]].sort((x, y) => x[0] - y[0])
  const out = []
  for (const [a, b] of todos) {
    const ultimo = out[out.length - 1]
    if (ultimo && a <= ultimo[1]) ultimo[1] = Math.max(ultimo[1], b)
    else out.push([a, b])
  }
  return out
}

// Funde velas nuevas con las que ya había, por hora (la nueva manda)
export function fundirVelas(antes, nuevas) {
  const porHora = new Map(antes.map(v => [v.time, v]))
  for (const v of nuevas) porHora.set(v.time, v)
  return [...porHora.values()].sort((a, b) => a.time - b.time)
}

// En la actividad de la cuenta, la operación que cerró una posición: una acción sobre ella
// en el sentido contrario al de la entrada que no sea su apertura ni un cambio de stop.
// No basta con buscar POSITION_CLOSED: un cierre con orden límite IG lo apunta como
// LIMIT_ORDER_OPENED sobre la posición (comprobado el 18-oct-2026 en la demo).
export function buscarCierre(actividades, dealId, lado) {
  const contrario = lado === 'largo' ? 'SELL' : 'BUY'
  for (const a of actividades ?? []) {
    const sobreEsta = (a.details?.actions ?? []).some(x =>
      x.affectedDealId === dealId && !['POSITION_OPENED', 'STOP_LIMIT_AMENDED'].includes(x.actionType))
    if (sobreEsta && a.details?.direction === contrario && a.details?.level != null) {
      return { nivel: a.details.level, fecha: a.date, descripcion: a.description }
    }
  }
  return null
}

// "2026-10-16T19:55:00", como la quiere /prices
const fechaIG = ts => new Date(ts * 1000).toISOString().slice(0, 19)

// ── El cliente ──

export function crearIG({ apiKey, usuario, password, entorno = 'demo', cuentaCfd = null, epicsFijos = {}, cacheDir, fetchFn = fetch, Lightstreamer = null, pausaBusquedaMs = 400 }) {
  const base = BASE[entorno] ?? BASE.demo
  const estado = {
    configurado: true, entorno, sesion: 'sin iniciar', streaming: 'sin conectar',
    error: null, cuenta: null, epics: {}, candidatos: {}, cupo: null,
  }
  let sesion = null
  let logueando = null
  let clienteLS = null
  let reconexion = null
  const tickerDeEpic = new Map()
  try { mkdirSync(cacheDir, { recursive: true }) } catch { /* no crítico */ }

  // `oauth` son las cabeceras del login de la versión 3 (token y cuenta): con ellas la
  // petición va por su cuenta, sin la sesión de tokens CST/XST
  async function pedir(ruta, { metodo = 'GET', version = 1, cuerpo, reintento = true, oauth = null, cabeceras = null } = {}) {
    if (!sesion && !oauth && ruta !== '/session') await login()
    const headers = {
      'X-IG-API-KEY': apiKey,
      'Content-Type': 'application/json; charset=UTF-8',
      'Accept':       'application/json; charset=UTF-8',
      'Version':      String(version),
      ...oauth,
      ...cabeceras,
    }
    if (sesion && !oauth && ruta !== '/session') { headers.CST = sesion.cst; headers['X-SECURITY-TOKEN'] = sesion.xst }
    const resp = await fetchFn(base + ruta, { method: metodo, headers, body: cuerpo ? JSON.stringify(cuerpo) : undefined })
    const json = await resp.json().catch(() => ({}))
    // los tokens caducan tras unas horas sin uso: se entra otra vez y se repite una vez
    if (resp.status === 401 && reintento && !oauth && ruta !== '/session' && json.errorCode !== 'error.security.api-key-invalid') {
      sesion = null
      return pedir(ruta, { metodo, version, cuerpo, reintento: false, cabeceras })
    }
    if (!resp.ok) throw new Error(mensaje(json.errorCode ?? `HTTP ${resp.status}`))
    return { json, resp }
  }

  function login() {
    if (logueando) return logueando
    logueando = (async () => {
      try {
        try {
          const { json, resp } = await pedir('/session', { metodo: 'POST', version: 2, cuerpo: { identifier: usuario, password } })
          const cst = resp.headers.get('cst')
          const xst = resp.headers.get('x-security-token')
          if (!cst || !xst) throw new Error('IG no ha devuelto los tokens de sesión')
          sesion = { cst, xst, cuenta: json.currentAccountId, ls: json.lightstreamerEndpoint }
          estado.cuentas = (json.accounts ?? []).map(a => ({ id: a.accountId, nombre: a.accountName, tipo: a.accountType, preferida: a.preferred }))
        } catch (err) {
          if (!/stockbroking-not-supported/.test(err.message)) throw err
          await loginEnCuentaCfd()
        }
        Object.assign(estado, { sesion: 'abierta', cuenta: sesion.cuenta, error: null })
      } catch (err) {
        Object.assign(estado, { sesion: 'error', error: err.message })
        throw err
      } finally {
        logueando = null
      }
    })()
    return logueando
  }

  // El login de la versión 2 entra siempre en la cuenta preferida y, si esa es de acciones,
  // IG lo rechaza ("stockbroking-not-supported"). El de la versión 3 entra con un token, con
  // el que se puede ver la lista de cuentas, pasar a la de CFD y pedir para ella los tokens
  // CST/XST, que son los que acepta el streaming.
  async function loginEnCuentaCfd() {
    const paso = async (nombre, promesa) => { try { return await promesa } catch (err) { throw new Error(`${err.message} (en ${nombre})`, { cause: err }) } }
    const { json } = await paso('login v3', pedir('/session', { metodo: 'POST', version: 3, cuerpo: { identifier: usuario, password } }))
    const token = json.oauthToken?.access_token
    if (!token) throw new Error('IG no ha devuelto el token del login (versión 3)')
    let oauth = { Authorization: `Bearer ${token}`, 'IG-ACCOUNT-ID': json.accountId }

    // Desde la cuenta de acciones IG tampoco deja ver la lista de cuentas: si se sabe el
    // número de la de CFD (IG_CUENTA), se va directo a ella
    let cfd = cuentaCfd ? { id: cuentaCfd } : null
    if (!cfd) {
      let lista
      try { ({ json: lista } = await pedir('/accounts', { oauth })) }
      catch (err) {
        if (!/product-code-not-allowed/.test(err.message)) throw err
        throw new Error('IG entra en tu cuenta de acciones y no deja ver las demás. Pon en IG_CUENTA el número de tu cuenta de CFD (sale en el selector de cuentas de IG) o márcala como predeterminada', { cause: err })
      }
      estado.cuentas = (lista.accounts ?? []).map(a => ({ id: a.accountId, nombre: a.accountName, tipo: a.accountType, preferida: a.preferred }))
      cfd = estado.cuentas.find(c => c.tipo === 'CFD')
      if (!cfd) throw new Error(`Esta cuenta de IG no tiene cuenta de CFD (solo ${estado.cuentas.map(c => `${c.nombre} (${c.tipo})`).join(', ') || 'ninguna'}): la API no funciona con las de acciones`)
    }
    // Los tokens se piden ya para la cuenta de CFD (la cabecera IG-ACCOUNT-ID elige la
    // cuenta); si IG no lo acepta así, se cambia la sesión de cuenta y se piden después
    let resp
    try {
      ({ resp } = await pedir('/session?fetchSessionTokens=true', { oauth: { ...oauth, 'IG-ACCOUNT-ID': cfd.id } }))
    } catch (err) {
      if (cfd.id === json.accountId) throw err
      await paso('cambio a la cuenta de CFD', pedir('/session', { metodo: 'PUT', version: 1, cuerpo: { accountId: cfd.id, defaultAccount: false }, oauth }))
      oauth = { ...oauth, 'IG-ACCOUNT-ID': cfd.id };
      ({ resp } = await paso('tokens de sesión', pedir('/session?fetchSessionTokens=true', { oauth })))
    }
    const cst = resp.headers.get('cst')
    const xst = resp.headers.get('x-security-token')
    if (!cst || !xst) throw new Error('IG no ha devuelto los tokens de sesión de la cuenta de CFD')
    sesion = { cst, xst, cuenta: cfd.id, ls: json.lightstreamerEndpoint }
  }

  // ── Qué mercado de IG es cada instrumento (se guarda: no hace falta buscarlo cada vez) ──
  const ficheroEpics = join(cacheDir, `epics-${entorno}.json`)

  // Primero las listas de seguimiento de la cuenta (toda cuenta trae una de mercados
  // populares con casi todos estos, y son dos o tres peticiones) y después la búsqueda,
  // que con esta API devuelve sobre todo opciones. Lo que no aparece se apunta y no se
  // vuelve a buscar en un día: cada reinicio del servidor eran ~25 búsquedas, y IG corta
  // en cuanto se pasan unas pocas decenas por minuto.
  async function resolverEpics() {
    let guardado = {}
    try { guardado = JSON.parse(readFileSync(ficheroEpics, 'utf8')) } catch { /* primera vez */ }
    // manda lo fijado en IG_EPICS; luego los de EPICS_IG; luego lo encontrado buscando otras
    // veces. En disco solo se guarda esto último: si se guardaran también los fijos, un
    // cambio en EPICS_IG no llegaría nunca a aplicarse.
    const encontrados = { ...guardado.epics }
    for (const ticker of Object.keys(BUSQUEDAS_IG)) {
      if (epicsFijos[ticker]) estado.epics[ticker] = { epic: epicsFijos[ticker], nombre: 'fijado en IG_EPICS' }
      else if (EPICS_IG[ticker]) estado.epics[ticker] = EPICS_IG[ticker]
      else if (encontrados[ticker]) estado.epics[ticker] = encontrados[ticker]
    }
    const faltan = () => Object.keys(BUSQUEDAS_IG).filter(t => !estado.epics[t])
    const reciente = guardado.intentado && Date.now() - guardado.intentado < 86_400_000

    if (faltan().length && !reciente) {
      const pausa = () => new Promise(r => setTimeout(r, pausaBusquedaMs))
      const asignar = mercados => {
        for (const ticker of faltan()) {
          const elegido = elegirMercado((mercados ?? []).filter(m => NOMBRES_IG[ticker].test(m.instrumentName)))
          if (elegido) estado.epics[ticker] = encontrados[ticker] = { epic: elegido.epic, nombre: elegido.instrumentName }
        }
      }
      const { json: listas } = await pedir('/watchlists')
      estado.listas = (listas.watchlists ?? []).map(w => w.name)
      for (const w of listas.watchlists ?? []) {
        if (!faltan().length) break
        await pausa()
        const { json } = await pedir(`/watchlists/${encodeURIComponent(w.id)}`)
        asignar(json.markets)
      }
      for (const ticker of faltan()) {
        for (const termino of BUSQUEDAS_IG[ticker]) {
          await pausa()
          const { json } = await pedir(`/markets?searchTerm=${encodeURIComponent(termino)}`)
          estado.candidatos[ticker] = (json.markets ?? []).filter(m => !m.epic.startsWith('OP.')).slice(0, 6)
            .map(m => ({ epic: m.epic, nombre: m.instrumentName, tipo: m.instrumentType, vence: m.expiry }))
          asignar(json.markets)
          if (estado.epics[ticker]) break
        }
      }
      guardado.intentado = Date.now()
    }
    estado.noEncontrados = faltan()
    try { writeFileSync(ficheroEpics, JSON.stringify({ epics: encontrados, intentado: guardado.intentado ?? null }, null, 2)) } catch { /* no crítico */ }
    tickerDeEpic.clear()
    for (const [ticker, epics] of Object.entries(EPICS_OPERAR)) for (const e of epics) tickerDeEpic.set(e, ticker)
    for (const [ticker, { epic }] of Object.entries(estado.epics)) tickerDeEpic.set(epic, ticker)
  }

  // Vuelve a buscar los mercados que faltan sin esperar al día (tras corregir algo)
  async function rebuscarEpics() {
    try { writeFileSync(ficheroEpics, JSON.stringify({ epics: {}, intentado: null }, null, 2)) } catch { /* no crítico */ }
    await resolverEpics()
    conectarStreaming()
    return estado.epics
  }

  // ── Streaming de velas de 1 min ──
  function conectarStreaming() {
    const { LightstreamerClient, Subscription } = Lightstreamer ?? require('lightstreamer-client-node')
    clienteLS?.disconnect()
    const items = Object.values(estado.epics).map(e => `CHART:${e.epic}:1MINUTE`)
    if (items.length === 0) { estado.streaming = 'sin mercados'; return }

    const cliente = new LightstreamerClient(sesion.ls)
    cliente.connectionDetails.setUser(sesion.cuenta)
    cliente.connectionDetails.setPassword(`CST-${sesion.cst}|XST-${sesion.xst}`)
    cliente.addListener({
      onStatusChange: s => { estado.streaming = s },
      // un error del servidor suele ser la sesión caducada: se entra de nuevo y se reconecta
      onServerError: (codigo, texto) => {
        estado.error = `Streaming de IG: ${texto} (${codigo})`
        programarReconexion()
      },
    })
    // Una suscripción por instrumento: si IG rechaza una, las demás siguen. Primero las
    // velas de 1 min de IG; si no hay permiso (con la cuenta de Opciones lo rechaza), la
    // cotización suelta, y la vela de 1 min se hace aquí con ella.
    estado.suscripciones = {}
    estado.recibidas = {}
    for (const [ticker, { epic }] of Object.entries(estado.epics)) suscribirVelas(cliente, Subscription, ticker, epic)
    cliente.connect()
    clienteLS = cliente
  }

  function suscribirVelas(cliente, Subscription, ticker, epic) {
    const campos = ['UTM', 'BID_OPEN', 'BID_HIGH', 'BID_LOW', 'BID_CLOSE', 'OFR_OPEN', 'OFR_HIGH', 'OFR_LOW', 'OFR_CLOSE']
    const sub = new Subscription('MERGE', [`CHART:${epic}:1MINUTE`], campos)
    sub.setRequestedSnapshot('yes')
    sub.addListener({
      onSubscription: () => { estado.suscripciones[ticker] = 'velas de 1 min de IG' },
      onItemUpdate: u => {
        // lo que llega, tal cual, para poder ver en /api/ig/estado si IG manda algo
        const recibido = Object.fromEntries(campos.map(c => [c, u.getValue(c)]))
        estado.recibidas[ticker] = { n: (estado.recibidas[ticker]?.n ?? 0) + 1, ultima: recibido }
        const vela = velaDeStreaming(campo => u.getValue(campo))
        if (vela) registrarVela('ig', ticker, escalar(vela, estado.epics[ticker]?.escala))
      },
      onSubscriptionError: (codigo, texto) => {
        estado.suscripciones[ticker] = `velas rechazadas (${texto}); probando cotización suelta`
        suscribirPrecios(cliente, Subscription, ticker, epic)
      },
    })
    cliente.subscribe(sub)
  }

  function suscribirPrecios(cliente, Subscription, ticker, epic) {
    const sub = new Subscription('MERGE', [`MARKET:${epic}`], ['BID', 'OFFER', 'MARKET_STATE'])
    sub.setRequestedSnapshot('yes')
    let vela = null
    sub.addListener({
      onSubscription: () => { estado.suscripciones[ticker] = 'cotización suelta (la vela de 1 min se hace aquí)' },
      onItemUpdate: u => {
        // con el mercado cerrado IG sigue dando el último precio: no es un precio de ahora
        if (u.getValue('MARKET_STATE') !== 'TRADEABLE') return
        const precio = medio(u.getValue('BID'), u.getValue('OFFER'))
        if (!Number.isFinite(precio)) return
        vela = acumularPrecio(vela, precio, Date.now())
        registrarVela('ig', ticker, escalar(vela, estado.epics[ticker]?.escala))
      },
      onSubscriptionError: (codigo, texto) => { estado.suscripciones[ticker] = `sin permiso para precios en directo (${texto})` },
    })
    cliente.subscribe(sub)
  }

  function programarReconexion(esperaMs = 30_000) {
    if (reconexion) return
    reconexion = setTimeout(async () => {
      reconexion = null
      sesion = null
      try {
        await login()
        // si el arranque falló antes de encontrar los mercados, hay que buscarlos ahora
        if (estado.noEncontrados === undefined) await resolverEpics()
        conectarStreaming()
      } catch {
        programarReconexion(Math.min(esperaMs * 2, 10 * 60_000))
      }
    }, esperaMs)
  }

  async function iniciar() {
    try {
      await login()
      await resolverEpics()
      conectarStreaming()
    } catch (err) {
      estado.error = err.message
      // con credenciales mal puestas no tiene sentido insistir cada medio minuto
      if (!/usuario|clave de API|desactivada|suspendida|IG_CUENTA|cuenta de CFD/.test(err.message)) programarReconexion()
    }
  }

  // ── Histórico con caché en disco ──
  // Por mercado y resolución: las velas y los intervalos de tiempo ya pedidos. La vela en
  // curso no cuenta como pedida, para que se vuelva a traer completa la próxima vez.
  const caches = new Map()
  const ficheroCache = (epic, res) => join(cacheDir, `${epic}_${res}.json`.replace(/[^\w.-]/g, '_'))
  function leerCache(epic, res) {
    const clave = `${epic}|${res}`
    if (!caches.has(clave)) {
      let c = { cubiertos: [], velas: [] }
      try { c = JSON.parse(readFileSync(ficheroCache(epic, res), 'utf8')) } catch { /* vacía */ }
      caches.set(clave, c)
    }
    return caches.get(clave)
  }
  function guardarCache(epic, res, c) {
    const fichero = ficheroCache(epic, res)
    try { writeFileSync(`${fichero}.tmp`, JSON.stringify(c)); renameSync(`${fichero}.tmp`, fichero) } catch { /* no crítico */ }
  }

  async function velasEntre(ticker, tf, desde, hasta) {
    const epic = estado.epics[ticker]?.epic
    if (!epic) throw new Error(estado.error ?? `IG: no se ha encontrado el mercado de ${ticker}`)
    const { res, segundos } = IG_RESOLUCION[tf]
    const c = leerCache(epic, res)
    const cerradoHasta = Date.now() / 1000 - segundos

    for (const [a, b] of intervalosPendientes(c.cubiertos, desde, hasta)) {
      // una hora de margen por el final: no está claro si IG lee las fechas en UTC o en
      // hora de Londres, y así el tramo pedido queda entero en los dos casos
      const qs = new URLSearchParams({ resolution: res, from: fechaIG(a), to: fechaIG(Math.min(b + 3600, Date.now() / 1000)), pageSize: '0' })
      const { json } = await pedir(`/prices/${epic}?${qs}`, { version: 3 })
      if (json.metadata?.allowance) estado.cupo = json.metadata.allowance
      c.velas = fundirVelas(c.velas, (json.prices ?? []).map(velaDeHistorico).filter(Boolean))
      c.cubiertos = cubrir(c.cubiertos, a, Math.min(b, cerradoHasta))
    }
    guardarCache(epic, res, c)

    const velas = c.velas.filter(v => v.time >= desde && v.time < hasta).map(v => escalar(v, estado.epics[ticker]?.escala))
    // la diaria de IG empieza el día a una hora que no es la medianoche de Madrid: se rotula
    // con el día que cubre la mayor parte de la vela, sumándole medio día
    return tf === 'd1' ? velas.map(v => ({ ...v, time: inicioDiaMadrid(v.time + 43200) })) : velas
  }

  // Para ver a mano qué mercados da IG con un término (y corregir uno con IG_EPICS)
  async function buscar(termino) {
    const { json } = await pedir(`/markets?searchTerm=${encodeURIComponent(termino)}`)
    return (json.markets ?? []).map(m => ({ epic: m.epic, nombre: m.instrumentName, tipo: m.instrumentType, vence: m.expiry, bid: m.bid, oferta: m.offer, estado: m.marketStatus }))
  }

  // Un mercado por su epic: si la cuenta puede verlo y operarlo, y con qué reglas
  async function mercado(epic) {
    const { json } = await pedir(`/markets/${encodeURIComponent(epic)}`, { version: 3 })
    const i = json.instrument ?? {}, r = json.dealingRules ?? {}
    return {
      epic, nombre: i.name, tipo: i.type, vence: i.expiry,
      bid: json.snapshot?.bid, oferta: json.snapshot?.offer, estado: json.snapshot?.marketStatus,
      valorPunto: i.valueOfOnePip, unPuntoEs: i.onePipMeans, tamanoContrato: i.contractSize,
      moneda: i.currencies?.find(c => c.isDefault)?.code ?? i.currencies?.[0]?.code,
      margen: i.marginFactor != null ? `${i.marginFactor}${i.marginFactorUnit === 'PERCENTAGE' ? '%' : ` ${i.marginFactorUnit}`}` : null,
      tamanoMin: r.minDealSize?.value, stopMin: r.minNormalStopOrLimitDistance?.value,
      ordenesMercado: r.marketOrderPreference, streaming: i.streamingPricesAvailable,
      monedas: i.currencies,
    }
  }

  // Las cuentas del usuario con su saldo (solo lectura)
  async function cuentas() {
    const { json } = await pedir('/accounts')
    return (json.accounts ?? []).map(a => ({ id: a.accountId, nombre: a.accountName, tipo: a.accountType, moneda: a.currency,
      saldo: a.balance?.balance, disponible: a.balance?.available, resultado: a.balance?.profitLoss }))
  }

  // Las listas de seguimiento de la cuenta con sus mercados, tal cual
  async function listas() {
    const { json } = await pedir('/watchlists')
    const out = []
    for (const w of json.watchlists ?? []) {
      await new Promise(r => setTimeout(r, pausaBusquedaMs))
      const { json: l } = await pedir(`/watchlists/${encodeURIComponent(w.id)}`)
      out.push({ nombre: w.name, mercados: (l.markets ?? []).map(m => ({ epic: m.epic, nombre: m.instrumentName, tipo: m.instrumentType, vence: m.expiry })) })
    }
    return out
  }

  // El árbol de mercados de la plataforma (Índices → …): sin nodo, la raíz
  async function navegar(nodo) {
    const { json } = await pedir(nodo ? `/marketnavigation/${encodeURIComponent(nodo)}` : '/marketnavigation')
    return {
      nodos: (json.nodes ?? []).map(n => ({ id: n.id, nombre: n.name })),
      mercados: (json.markets ?? []).map(m => ({ epic: m.epic, nombre: m.instrumentName, tipo: m.instrumentType, vence: m.expiry, bid: m.bid, oferta: m.offer, estado: m.marketStatus })),
    }
  }

  // ── Operar (solo en la demo) ──
  // Lo usa el bot (server/bot-srs.js). Los precios entran y salen en las unidades del
  // gráfico: si IG da el mercado en centavos (`escala`), aquí se pasan a las suyas.
  // El candado va en cada función que manda órdenes, no en el bot: así ningún otro código
  // puede operar en la cuenta real por despiste.
  function soloDemo() {
    if (entorno !== 'demo') throw new Error('Solo se opera en la demo de IG (IG_ENTORNO=demo)')
  }
  const epicDe   = (ticker, epic = null) => {
    const e = epic ?? estado.epics[ticker]?.epic
    if (!e) throw new Error(`IG: no hay mercado para ${ticker}`)
    return e
  }
  const escalaDe = ticker => estado.epics[ticker]?.escala ?? 1
  const aIG      = (ticker, precio) => (precio == null ? null : precio / escalaDe(ticker))
  const deIG     = (ticker, precio) => (precio == null ? null : precio * escalaDe(ticker))

  // Lo que hace falta para mandar una orden: moneda, tamaño mínimo, distancia mínima del
  // stop, cuánto vale un punto (y en euros, con el cambio que da IG: baseExchangeRate es lo
  // que vale 1 € en esa moneda), si la cuenta tiene precio, que es lo que dice si puede
  // operarlo, y si admite órdenes a mercado (los de diario sí; el DAX de fin de semana no)
  async function datosMercado(ticker, epic = null) {
    const { json } = await pedir(`/markets/${encodeURIComponent(epicDe(ticker, epic))}`, { version: 3 })
    const reglas = json.dealingRules ?? {}
    const monedas = json.instrument?.currencies ?? []
    const moneda = monedas.find(c => c.isDefault) ?? monedas[0] ?? {}
    const bid = deIG(ticker, json.snapshot?.bid), oferta = deIG(ticker, json.snapshot?.offer)
    return {
      epic:        epicDe(ticker, epic),
      moneda:      moneda.code,
      cambioAEur:  moneda.code === 'EUR' ? 1 : (moneda.baseExchangeRate ? 1 / moneda.baseExchangeRate : null),
      valorPunto:  Number(json.instrument?.valueOfOnePip) || null,
      tamanoMin:   reglas.minDealSize?.value ?? null,
      stopMin:     deIG(ticker, reglas.minNormalStopOrLimitDistance?.value ?? null),
      estado:      json.snapshot?.marketStatus,
      bid, oferta,
      conPrecio:   bid != null && oferta != null,
      aMercado:    reglas.marketOrderPreference !== 'NOT_AVAILABLE',
    }
  }

  // Una orden se manda y IG contesta con una referencia; si salió o no se sabe al pedir su
  // confirmación, que puede tardar un instante en estar lista
  async function confirmar(referencia) {
    for (let i = 0; i < 5; i++) {
      try {
        const { json } = await pedir(`/confirms/${encodeURIComponent(referencia)}`)
        return json
      } catch (err) {
        if (i === 4) throw err
        await new Promise(r => setTimeout(r, 300 * (i + 1)))
      }
    }
  }
  const resumenConfirmacion = (ticker, c) => ({
    aceptada: c.dealStatus === 'ACCEPTED', motivo: c.reason, dealId: c.dealId,
    nivel: deIG(ticker, c.level), stop: deIG(ticker, c.stopLevel), tamano: c.size, lado: c.direction === 'BUY' ? 'largo' : 'corto',
  })

  // Abre con el stop dentro de la misma orden: lo guarda IG, así que la posición queda
  // protegida aunque el servidor se caiga después. Sin `limite` va a mercado. Con él, para
  // los mercados que no admiten órdenes a mercado (market-orders.not-supported-for-epic),
  // va con límite que se ejecuta entera al momento o se anula, con `limite` como el peor
  // precio aceptable: si el precio ya se ha ido más allá, no entra.
  const orden = (ticker, limite) => (limite == null
    ? { orderType: 'MARKET', level: null, timeInForce: null }
    : { orderType: 'LIMIT', level: aIG(ticker, limite), timeInForce: 'FILL_OR_KILL' })

  // `referencia` es la dealReference propia de la orden: con ella se reconocen después las
  // posiciones que abrió el bot (letras, números, - y _, hasta 30)
  async function abrir({ ticker, epic = null, lado, tamano, stop, moneda, limite = null, referencia = null }) {
    soloDemo()
    const { json } = await pedir('/positions/otc', {
      metodo: 'POST', version: 2,
      cuerpo: {
        ...(referencia ? { dealReference: referencia } : {}),
        epic: epicDe(ticker, epic), expiry: '-', direction: lado === 'largo' ? 'BUY' : 'SELL', size: tamano,
        currencyCode: moneda, forceOpen: true, guaranteedStop: false,
        stopLevel: aIG(ticker, stop), trailingStop: false, limitLevel: null, quoteId: null,
        ...orden(ticker, limite),
      },
    })
    return resumenConfirmacion(ticker, await confirmar(json.dealReference))
  }

  async function moverStop({ ticker, dealId, stop }) {
    soloDemo()
    const { json } = await pedir(`/positions/otc/${encodeURIComponent(dealId)}`, {
      metodo: 'PUT', version: 2,
      cuerpo: { stopLevel: aIG(ticker, stop), limitLevel: null, guaranteedStop: false, trailingStop: false },
    })
    return resumenConfirmacion(ticker, await confirmar(json.dealReference))
  }

  // Cerrar va por POST con la cabecera _method: DELETE, porque IG pide un cuerpo y un
  // DELETE con cuerpo no siempre llega entero
  async function cerrar({ ticker, dealId, lado, tamano, limite = null }) {
    soloDemo()
    const { json } = await pedir('/positions/otc', {
      metodo: 'POST', version: 1, cabeceras: { _method: 'DELETE' },
      cuerpo: { dealId, direction: lado === 'largo' ? 'SELL' : 'BUY', size: tamano, epic: null, expiry: null, quoteId: null, ...orden(ticker, limite) },
    })
    return resumenConfirmacion(ticker, await confirmar(json.dealReference))
  }

  // Lo que la cuenta tiene disponible para margen (en su moneda): con él el bot no deja que
  // una posición se coma la cuenta
  async function disponible() {
    const { json } = await pedir('/accounts')
    const c = (json.accounts ?? []).find(x => x.accountId === sesion?.cuenta)
    return c?.balance?.available ?? null
  }

  async function posiciones() {
    const { json } = await pedir('/positions', { version: 2 })
    return (json.positions ?? []).map(({ position: p, market: m }) => {
      const ticker = tickerDeEpic.get(m.epic) ?? null
      const f = ticker ? escalaDe(ticker) : 1
      return {
        dealId: p.dealId, epic: m.epic, ticker, lado: p.direction === 'BUY' ? 'largo' : 'corto', tamano: p.size,
        nivel: p.level * f, stop: p.stopLevel == null ? null : p.stopLevel * f, abierta: p.createdDateUTC,
        referencia: p.dealReference ?? null,
      }
    })
  }

  // A qué precio se cerró una posición que ya no está (la cerró su stop, o alguien a mano):
  // se busca en la actividad de la cuenta la operación en sentido contrario sobre ella. No
  // basta con buscar "POSITION_CLOSED": un cierre con orden límite IG lo apunta como
  // LIMIT_ORDER_OPENED sobre la posición (comprobado el 18-oct-2026 en la demo).
  async function cierreDe({ ticker, dealId, lado, desdeMs }) {
    const qs = new URLSearchParams({ from: new Date(desdeMs).toISOString().slice(0, 19), detailed: 'true', pageSize: '50' })
    const { json } = await pedir(`/history/activity?${qs}`, { version: 3 })
    const cierre = buscarCierre(json.activities, dealId, lado)
    return cierre && { ...cierre, nivel: deIG(ticker, cierre.nivel) }
  }

  // La actividad de la cuenta tal cual (para ver qué devuelve IG)
  async function actividad(desdeMs) {
    const qs = new URLSearchParams({ from: new Date(desdeMs).toISOString().slice(0, 19), detailed: 'true', pageSize: '50' })
    const { json } = await pedir(`/history/activity?${qs}`, { version: 3 })
    return json
  }

  return {
    iniciar,
    velasEntre,
    actividad,
    buscar,
    navegar,
    listas,
    mercado,
    cuentas,
    rebuscarEpics,
    estado: () => ({ ...estado, epics: { ...estado.epics } }),
    operar: { datosMercado, abrir, moverStop, cerrar, posiciones, cierreDe, disponible },
  }
}
