// ── Bot de las tortugas en la demo de IG ──────────────────────────────────────────
// Opera las tortugas de la pestaña Estrategias (src/tortugas.js) con dinero de la demo, en
// los índices del bot SRS (a las horas de su sesión de contado) y en divisas y materias primas
// (MERCADOS_TORTUGAS), con las posiciones abiertas de un día para otro:
//   · al empezar cada sesión de un mercado, con sus velas diarias hasta la anterior, saca la N
//     (ATR de Wilder de 20) y los canales (server/tortugas-niveles.js);
//   · juega los dos sistemas a la vez, como las tortugas: el Sistema 1 entra al romper el
//     máximo de 20 sesiones y sale al romper el mínimo de 10; el Sistema 2 entra en la de 55 y
//     sale en la de 20. El filtro del Sistema 1 de las tortugas (saltarse la ruptura si la
//     anterior habría ganado y esperar a la de 55) está, pero apagado: el usuario lo quiso así. Cada uno lleva sus
//     posiciones (un índice puede tener una de cada), y cada entrada va con todo el capital.
//     Pero van como uno: si los dos dan la señal a precios parecidos (el otro ya tiene una
//     unidad a menos de ½ N), solo se ejecuta una. Por defecto, solo largos, como el backtest;
//   · una unidad es el tamaño con el que 1 N cuesta un `riesgoPct` % del capital del sistema
//     (con un 20 % menos por cada 10 % de caída desde el máximo, como el backtest); el stop de
//     todas las unidades va a 2 N del último relleno y lo guarda IG, así que la posición sigue
//     protegida de noche, en fin de semana o con el servidor caído;
//   · pirámide: una unidad más cada ½ N a favor desde el último relleno, hasta `maxUnidades`,
//     con los límites de cartera del backtest dentro de cada sistema (unidades por grupo y por
//     sentido) y, entre los dos, el nominal total como mucho 10 veces el saldo.
// Las entradas, los añadidos y la salida por el canal los decide el bot con el precio en
// directo de IG, solo dentro de la sesión de contado de cada índice (que es lo que ve el
// backtest), y van a mercado. No deja órdenes pendientes en IG. El stop de 2 N sí puede saltar
// fuera de la sesión, porque IG cotiza casi las 24 horas: el backtest solo lo vería al abrir.
//
// Como el bot SRS: cada orden lleva una referencia propia (TOR1-… o TOR2-…, según el sistema)
// para recuperar las posiciones desde IG si se pierde el registro; una orden sin confirmar se
// reconcilia antes de seguir; todo lo que hace lo cuenta por Telegram; solo opera en la demo
// (candado en server/ig.js) y solo donde BOT_OPERA=1 (server/index.js). Comparte la cuenta con
// el bot SRS: sus posiciones son aparte (cada una con su referencia), pero el saldo y el margen
// son los mismos.

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { SESIONES_BOT, tamanoPorRiesgo } from './bot-srs.js'
import { fechaEnZona, instanteEnZona } from './zonas.js'
import { ultimasVelas, escuchar } from './tiempo-real.js'
import { EPICS_OPERAR } from './ig.js'
import { nivelesTortugas } from './tortugas-niveles.js'

// Los mercados que opera, con su grupo (para el límite de unidades muy correlacionadas), las
// horas de su sesión en una zona (minutos desde la medianoche del día de la sesión; negativos si
// empieza la víspera) y de dónde salen sus niveles:
//   · índices: la sesión de contado de su bolsa (la del bot SRS) y el diario de Yahoo, como el backtest;
//   · divisas: el día de 17:00 a 17:00 de Nueva York y el diario de Yahoo (el contado, que Yahoo
//     fecha en Londres), que cotiza igual que IG;
//   · materias primas: de 18:00 a 17:00 de Nueva York (cada una cotiza dentro de ese rato, a las
//     horas de su mercado) y el diario de IG del propio CFD de contado: los futuros de Yahoo
//     saltan al cambiar de vencimiento y no cotizan como el contado de IG (que va entre dos).
// En los de 24 horas el plan se hace `esperaPlan` minutos después de abrir, cuando la vela
// diaria del día anterior ya está cerrada en Yahoo y en IG.
//
// El oro y la plata, que son contado (no un CFD entre dos vencimientos), tienen `respaldo` por
// si IG no da su histórico (se queda sin cupo semanal): las velas de 1 h del contado de otra
// fuente, agrupadas en las sesiones del bot (diariasDeSesiones). Twelve Data da el oro en su
// plan gratuito (no la plata) y pide TWELVEDATA_API_KEY; Dukascopy, los dos, cuando no limita.
const indice = (ticker, grupo) => ({ ...SESIONES_BOT[ticker], grupo, datos: { fuente: 'yahoo', simbolo: ticker } })
const divisa = (nombre, simbolo) => ({ nombre, grupo: 'Divisas', zona: 'America/New_York', apertura: -7 * 60, cierre: 17 * 60, esperaPlan: 150, datos: { fuente: 'yahoo', simbolo, zona: 'Europe/London' } })
const materia = (nombre, grupo, respaldo = []) => ({ nombre, grupo, zona: 'America/New_York', apertura: -6 * 60, cierre: 17 * 60, esperaPlan: 150, datos: { fuente: 'ig', respaldo } })
export const MERCADOS_TORTUGAS = {
  '^N225': indice('^N225', 'Asia'), '^GDAXI': indice('^GDAXI', 'Europa'), '^FTSE': indice('^FTSE', 'Europa'),
  '^NDX': indice('^NDX', 'EEUU'), '^GSPC': indice('^GSPC', 'EEUU'), '^DJI': indice('^DJI', 'EEUU'), '^RUT': indice('^RUT', 'EEUU'),
  EURUSD: divisa('EUR/USD', 'EURUSD=X'), GBPUSD: divisa('GBP/USD', 'GBPUSD=X'), USDJPY: divisa('USD/JPY', 'JPY=X'),
  AUDUSD: divisa('AUD/USD', 'AUDUSD=X'), USDCAD: divisa('USD/CAD', 'CAD=X'), USDCHF: divisa('USD/CHF', 'CHF=X'),
  XAUUSD: materia('Oro', 'Metales', [{ fuente: 'Twelve Data', simbolo: 'XAU/USD' }, { fuente: 'Dukascopy', instrumento: 'xauusd' }]),
  XAGUSD: materia('Plata', 'Metales', [{ fuente: 'Dukascopy', instrumento: 'xagusd' }]),
  COPPER: materia('Cobre', 'Metales'),
  USOIL: materia('Crudo WTI', 'Energía'), UKOIL: materia('Crudo Brent', 'Energía'), NATGAS: materia('Gas natural', 'Energía'),
  COFFEE: materia('Café', 'Blandas'), COCOA: materia('Cacao', 'Blandas'), SUGAR: materia('Azúcar', 'Blandas'), COTTON: materia('Algodón', 'Blandas'),
  CORN: materia('Maíz', 'Granos'), SOYBEAN: materia('Soja', 'Granos'),
}
export const GRUPOS_TORTUGAS = Object.fromEntries(Object.entries(MERCADOS_TORTUGAS).map(([t, m]) => [t, m.grupo]))

// ── Sesiones (las de divisas y materias primas empiezan la víspera) ──
const masDias = (fecha, n) => new Date(Date.parse(`${fecha}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
function sesionDelDia(ticker, fecha) {
  const m = MERCADOS_TORTUGAS[ticker]
  const dow = new Date(`${fecha}T12:00:00Z`).getUTCDay()
  if (!m || dow === 0 || dow === 6) return null
  return { ticker, fecha, abre: instanteEnZona(fecha, m.apertura, m.zona), cierra: instanteEnZona(fecha, m.cierre, m.zona), esperaPlan: (m.esperaPlan ?? 0) * 60 }
}
// La sesión en curso en `t`; si no hay ninguna, la de ese día en la zona del mercado (null en fin de semana)
export function sesionTortugas(ticker, t) {
  const m = MERCADOS_TORTUGAS[ticker]
  if (!m) return null
  const hoy = fechaEnZona(t, m.zona)
  const manana = sesionDelDia(ticker, masDias(hoy, 1))
  if (manana && t >= manana.abre && t < manana.cierra) return manana
  return sesionDelDia(ticker, hoy)
}
export function proximaAperturaTortugas(ticker, t) {
  const m = MERCADOS_TORTUGAS[ticker]
  if (!m) return null
  const hoy = fechaEnZona(t, m.zona)
  for (let d = 0; d < 9; d++) {
    const s = sesionDelDia(ticker, masDias(hoy, d))
    if (s && s.abre > t) return s.abre
  }
  return null
}
export const SISTEMAS = [1, 2]

// Velas de 1 h (en orden, con `time` al empezar la hora) en las diarias de las sesiones del
// mercado: cada hora va a la sesión en curso a esa hora, y las de fuera (la pausa de las 17:00
// de Nueva York, el fin de semana) se quedan fuera
export function diariasDeSesiones(ticker, velasHora) {
  const dias = []
  let ses = null
  for (const v of velasHora) {
    if (!ses || v.time < ses.abre || v.time >= ses.cierra) {
      ses = sesionTortugas(ticker, v.time)
      if (!ses || v.time < ses.abre || v.time >= ses.cierra) { ses = null; continue }
    }
    const d = dias.at(-1)
    if (d?.date === ses.fecha) {
      d.high = Math.max(d.high, v.high)
      d.low = Math.min(d.low, v.low)
      d.close = v.close
    } else dias.push({ date: ses.fecha, open: v.open, high: v.high, low: v.low, close: v.close })
  }
  return dias
}

// Las sesiones entre semana que faltan entre la primera y la última: un respaldo a medias
// (Dukascopy, cuando limita, devuelve ficheros vacíos en vez de un error) daría niveles falsos
export function sesionesQueFaltan(dias) {
  if (!dias.length) return Infinity
  const hay = new Set(dias.map(d => d.date))
  let faltan = 0
  for (let f = dias[0].date; f <= dias.at(-1).date; f = masDias(f, 1)) {
    const dow = new Date(`${f}T12:00:00Z`).getUTCDay()
    if (dow !== 0 && dow !== 6 && !hay.has(f)) faltan++
  }
  return faltan
}

export const CONFIG_TORTUGAS_BOT = {
  activo:       false,
  instrumentos: Object.fromEntries(Object.keys(GRUPOS_TORTUGAS).map(t => [t, true])),
  sistemas:     [1, 2],     // los que juega, a la vez y con el capital a partes iguales
  filtroS1:     false,      // true: el Sistema 1 se salta la ruptura de 20 si la anterior habría ganado y entra en la de 55
  lados:        'largos',   // largos | ambos | cortos
  riesgoPct:    1,          // lo que cuesta 1 N por unidad, en % del saldo (en cada sistema: todo el capital)
                            // (el backtest usa 0,2 con 8 índices; las tortugas, 1)
  maxUnidades:  6,          // por índice y sistema, con la entrada
  maxGrupo:     9,          // por grupo (Asia, Europa, EEUU), sentido y sistema
  maxSentido:   15,         // por sentido y sistema
  reduccionDD:  true,       // un 20 % menos de capital por cada 10 % de caída desde el máximo
}

export const PASO_N = 0.5          // N entre añadidos
export const STOP_N = 2            // N hasta el stop desde el último relleno
export const APALANCAMIENTO = 10   // nominal total de las posiciones (de los dos sistemas) / saldo, como mucho
const MARGEN_MAX = 0.4             // una orden no puede pedir más margen que esta parte del disponible
const PREFIJO = 'TOR'              // + el sistema: TOR1-…, TOR2-…
const RECIENTE_S = 120             // las velas de 1 min que cuentan como el precio de ahora
const REVISAR_CADA_MS = 30_000     // cada cuánto se mira en IG si las posiciones siguen abiertas
const REVISAR_YA_MS = 2_000        // con el precio al otro lado de un stop
const ESPERA_STOP_S = 10           // si el precio pasó el stop y IG no ha cerrado en este rato, cierra el bot
const ESPERA_STOP_FALLIDO_S = 30   // si IG falla al mover un stop (un error suyo, no un rechazo), se reintenta pasado este rato
const BUSQUEDAS_CIERRE = 4
const REINTENTO_PLAN_S = 600       // si no se pudo hacer el plan, se intenta de nuevo pasado este rato
const REINTENTO_IG_S = 120         // si fue IG (p. ej., porque limita las peticiones), algo antes; nunca en cada paso
const CUENTA_VALE_S = 30           // el saldo se pide una vez para todos los planes de una ronda
const ESPERA_TRAS_CIERRE_S = 3600  // Yahoo tarda en dejar la vela del día: el plan de mañana, una hora después del cierre
const DIAS_VIEJO = 6               // una vela diaria más vieja que esto (días naturales) es que Yahoo no está al día
const MAX_EVENTOS = 1000
const MAX_OPERACIONES = 500

const dir = lado => (lado === 'largo' ? 1 : -1)
const redondear = (x, dec = 1) => Math.round(x * 10 ** dec) / 10 ** dec
const num = (x, dec = 1) => (x == null ? '—' : Number(x).toLocaleString('es-ES', { maximumFractionDigits: dec }))
// Decimales para enseñar un precio (o una distancia) según su tamaño: las divisas, con 5
export const decimalesPara = x => { const a = Math.abs(x ?? 0); return a >= 1000 ? 1 : a >= 100 ? 2 : a >= 10 ? 3 : 5 }
const px = x => (x == null ? '—' : num(x, decimalesPara(x)))
const nombreDe = ticker => MERCADOS_TORTUGAS[ticker]?.nombre ?? ticker
// Lo que vale moverse una unidad del precio, por contrato (en divisas el punto de IG es el pip)
const valorDe = m => m.valorPrecio ?? m.valorPunto
// Los contratos que admiten tamaños por debajo de la décima, de centésima en centésima
const pasoDe = m => (m.tamanoMin != null && m.tamanoMin < 0.1 ? 0.01 : 0.1)
// Posiciones e intentos van por índice y sistema
export const claveDe = (ticker, sistema) => `${ticker}|${sistema}`
// El sistema de una orden del bot, por su referencia (TOR1-…, TOR2-…); null si no es suya
export const sistemaDeReferencia = ref => {
  const m = /^TOR([12])?-/.exec(ref ?? '')
  return m ? Number(m[1] ?? 1) : null
}

// El capital con el que se calcula la unidad: el saldo, recortado un 20 % por cada 10 % que
// esté por debajo de su máximo (como fijarCapital en el backtest)
export function capitalNominal(saldo, pico, reduccion = true) {
  if (!reduccion || !(pico > 0)) return saldo
  const tramos = Math.floor((1 - saldo / pico) / 0.10 + 1e-9)
  return Math.min(saldo, pico * 0.8 ** Math.max(tramos, 0))
}

// Dónde entra la siguiente unidad: ½ N a favor desde el último relleno. `ocupados`, los precios
// del otro sistema en el mismo sentido: si la unidad cae a menos de ½ N de uno, eso ya está
// comprado (los dos van como uno) y pasa a ½ N más allá de él
export function siguienteAnadido(pos, ocupados = []) {
  const d = PASO_N * pos.n0
  let nivel = pos.unidades.at(-1).entrada + dir(pos.lado) * d
  for (let o; (o = ocupados.find(x => Math.abs(x - nivel) < d)) != null;) nivel = o + dir(pos.lado) * d
  return nivel
}

// Los niveles de un sistema con la N y los canales del día. Con `filtroS1`, el Sistema 1
// espera a la ruptura de 55 si la anterior de 20 habría ganado
export function nivelesSistema(nv, sistema, filtroS1 = false) {
  const filtro = sistema === 1 && filtroS1 && nv.gano
  const k = sistema === 2 || filtro ? 55 : 20
  const kSalida = sistema === 1 ? 10 : 20
  return {
    k, kSalida, filtro,
    entrada: { largo: { nivel: nv.alto[k], k }, corto: { nivel: nv.bajo[k], k } },
    salida: { largo: nv.bajo[kSalida], corto: nv.alto[kSalida] },
  }
}

// ── La decisión (pura) ──
// Para un índice y un sistema. `ses` es la sesión de hoy del índice (null en fin de semana) y
// `proxima`, la siguiente que abre; `velas`, las últimas de 1 min en directo; `cfg.encendido`
// y `cfg.activo` ya dicen si ese índice y ese sistema se juegan y si el bot está encendido.
export function siguientePasoTortugas({ pos, plan, intento, cfg, ahora, velas, ses, proxima, sistema = 1, ocupados = [] }) {
  // una orden mandada cuya confirmación no llegó: antes de nada, ver en IG si entró
  if (intento) return { accion: 'reconciliar' }
  const enSesion = !!ses && ahora >= ses.abre && ahora < ses.cierra
  // El plan (de los dos sistemas) de la sesión en curso o, fuera de ella, el de la siguiente
  // (provisional: se rehace al abrir, con la cuenta de ese momento). Recién cerrada la sesión,
  // se espera a que Yahoo tenga su vela diaria.
  const objetivo = enSesion ? ses : proxima
  if (objetivo && (cfg.encendido || pos)) {
    const deEsa = plan?.fecha === objetivo.fecha
    const vale = deEsa && !(enSesion && plan.calculado < ses.abre)
    const reintento = deEsa && plan.error && ahora >= plan.reintentar
    const recienCerrada = !!ses && ahora >= ses.cierra && ahora < ses.cierra + ESPERA_TRAS_CIERRE_S
    // en los de 24 horas, el de la sesión se hace un rato después de abrir (con la vela de ayer cerrada)
    const pronto = enSesion && ahora < ses.abre + (ses.esperaPlan ?? 0)
    if ((!vale || reintento) && !recienCerrada && !pronto) return { accion: 'plan', ses: objetivo }
  }
  // un stop que IG no movió por un fallo suyo: se reintenta al rato, con la sesión abierta o no
  const stopPendiente = pos?.stopPendiente != null && !(pos.esperaStop > ahora)
  const quieto = { accion: stopPendiente ? 'stop' : pos ? 'vigilar' : 'nada' }
  if (!enSesion) return quieto

  const delSistema = plan?.fecha === ses.fecha && !plan.error ? plan.sistemas?.[sistema] : null
  const hoy = delSistema ? { ...plan, ...delSistema } : null
  // el precio de ahora: las velas de 1 min de los dos últimos minutos de la sesión
  const recientes = velas.filter(v => v.time >= ses.abre && v.time + RECIENTE_S > ahora)
  if (!recientes.length) return quieto
  const alto = Math.max(...recientes.map(v => v.high))
  const bajo = Math.min(...recientes.map(v => v.low))
  const precio = recientes.at(-1).close

  if (pos) {
    const largo = pos.lado === 'largo'
    const canal = hoy?.salida?.[pos.lado]
    if (canal != null && (largo ? bajo <= canal : alto >= canal)) return { accion: 'salir', motivo: `canal ${hoy.kSalida}` }
    // al otro lado del stop: lo cierra IG, y si no lo hace en unos segundos, el bot
    if (pos.stop != null && (largo ? precio <= pos.stop : precio >= pos.stop)) return { accion: 'revisar-ya' }
    if (stopPendiente) return { accion: 'stop' }
    if (cfg.activo && hoy?.unidad?.ok && pos.unidades.length < cfg.maxUnidades && pos.sinAnadidos !== ses.fecha && !(pos.esperaAnadir > ahora)) {
      const nivel = siguienteAnadido(pos, ocupados)
      if (largo ? alto >= nivel : bajo <= nivel) return { accion: 'anadir' }
    }
    return { accion: 'vigilar' }
  }

  if (!cfg.activo || !hoy?.unidad?.ok || hoy.bloqueado || hoy.esperaEntrar > ahora) return { accion: 'nada' }
  for (const lado of ['largo', 'corto']) {
    if ((lado === 'largo' && cfg.lados === 'cortos') || (lado === 'corto' && cfg.lados === 'largos')) continue
    const nivel = hoy.entrada[lado].nivel
    if (lado === 'largo' ? alto >= nivel : bajo <= nivel) return { accion: 'entrar', lado }
  }
  return { accion: 'nada' }
}

const describirSistemas = v => (v.length === 2
  ? 'Sistemas 1 y 2 a la vez, como uno y con todo el capital en cada entrada'
  : `Solo el Sistema ${v[0]}: ${v[0] === 1 ? 'entra en 20 sesiones y sale en 10' : 'entra en 55 sesiones y sale en 20'}`)
const DESCRIBIR = {
  activo:      v => (v ? 'Bot de las tortugas encendido' : 'Bot de las tortugas apagado'),
  sistemas:    describirSistemas,
  filtroS1:    v => (v ? 'Filtro del Sistema 1: si la ruptura anterior habría ganado, espera a la de 55' : 'Sistema 1 sin filtro: entra en toda ruptura de 20'),
  lados:       v => `Lados: ${{ largos: 'solo largos', ambos: 'largos y cortos', cortos: 'solo cortos' }[v]}`,
  riesgoPct:   v => `Riesgo: 1 N por unidad cuesta el ${String(v).replace('.', ',')}% del saldo`,
  maxUnidades: v => `Hasta ${v} unidades por índice y sistema`,
  maxGrupo:    v => `Hasta ${v} unidades por grupo, sentido y sistema`,
  maxSentido:  v => `Hasta ${v} unidades por sentido y sistema`,
  reduccionDD: v => `Reducción por drawdown: ${v ? 'sí' : 'no'}`,
}
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ── El bot ──
// `velasDiarias(ticker)` da las diarias de Yahoo del índice ([{ date, open, high, low, close }],
// en orden, con la fecha en la zona de su bolsa). `avisar(texto)` es Telegram.
export function crearBotTortugas({ ig, velasDiarias, archivo, ahora = () => Math.floor(Date.now() / 1000), log = console.log, revisarCadaMs = REVISAR_CADA_MS, avisar = () => {} }) {
  const vacio = () => ({ config: { ...CONFIG_TORTUGAS_BOT, instrumentos: { ...CONFIG_TORTUGAS_BOT.instrumentos } }, picoSaldo: null, planes: {}, posiciones: {}, intentos: {}, operaciones: [], eventos: [] })
  let datos = vacio()
  try {
    const leido = JSON.parse(readFileSync(archivo, 'utf8'))
    const config = { ...datos.config }
    for (const k of Object.keys(CONFIG_TORTUGAS_BOT)) if (k in (leido.config ?? {})) config[k] = leido.config[k]
    config.instrumentos = { ...CONFIG_TORTUGAS_BOT.instrumentos, ...config.instrumentos }
    datos = { ...datos, ...leido, config }
    delete datos.config.sistema
    // Los registros de antes de jugar los dos sistemas: las posiciones e intentos iban por
    // índice y eran del sistema elegido; los planes no traían los dos sistemas y se rehacen
    const sistemaViejo = Number(leido.config?.sistema) || 1
    for (const coleccion of [datos.posiciones, datos.intentos]) {
      for (const [k, x] of Object.entries(coleccion)) {
        if (k.includes('|')) continue
        delete coleccion[k]
        coleccion[claveDe(k, x.sistema ?? sistemaViejo)] = { ...x, ticker: x.ticker ?? k, sistema: x.sistema ?? sistemaViejo }
      }
    }
    for (const [t, p] of Object.entries(datos.planes)) if (!p?.sistemas && !p?.error) delete datos.planes[t]
  } catch { /* primera vez */ }

  let guardado = JSON.stringify(datos, null, 2)
  const guardar = () => {
    const texto = JSON.stringify(datos, null, 2)
    if (texto === guardado) return
    try {
      writeFileSync(`${archivo}.tmp`, texto)
      renameSync(`${archivo}.tmp`, archivo)
      guardado = texto
    } catch (err) { log(`[tortugas] no se ha podido guardar: ${err.message}`) }
  }

  function avisarSinFallar(texto) {
    try { Promise.resolve(avisar(texto)).catch(() => {}) } catch { /* el aviso es lo de menos */ }
  }
  // Apunta lo que pasa en un índice (y sistema, si es cosa de uno) y lo avisa. Lo mismo dos
  // veces seguidas (un error que se repite en cada paso) se apunta una sola vez.
  function apuntar(ticker, texto, { aviso = true, sistema = null } = {}) {
    const ultimo = datos.eventos.findLast(e => e.ticker === ticker && (e.sistema ?? null) === sistema)
    if (ultimo?.texto === texto) return
    datos.eventos.push({ hora: new Date(ahora() * 1000).toISOString(), ticker, ...(sistema ? { sistema } : {}), texto })
    if (datos.eventos.length > MAX_EVENTOS) datos.eventos.splice(0, datos.eventos.length - MAX_EVENTOS)
    log(`[tortugas] ${ticker}${sistema ? ` S${sistema}` : ''} ${texto}`)
    if (aviso) avisarSinFallar(`Tortugas${sistema ? ` S${sistema}` : ''} · ${nombreDe(ticker)} · ${texto}`)
  }
  const referenciaNueva = (ticker, sistema) => `${PREFIJO}${sistema}-${ticker.replace(/\W/g, '')}-${fechaEnZona(ahora(), 'Europe/Madrid').replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6)}`
  const posicionesDe = sistema => Object.values(datos.posiciones).filter(p => p.sistema === sistema)

  // ── El plan de una sesión: niveles de Yahoo y tamaño de la unidad con la cuenta de IG ──
  // Sin cupo de histórico de IG fallan a la vez todas las materias primas: se avisa una vez,
  // con un solo mensaje, y no uno por mercado cada vez que se reintenta
  let avisoSinCupo = 0
  let cuentaVista = null
  async function cuentaReciente() {
    if (!cuentaVista || ahora() - cuentaVista.t >= CUENTA_VALE_S) cuentaVista = { t: ahora(), c: await ig.operar.cuenta() }
    return cuentaVista.c
  }

  // Un error de IG a mitad del plan lo deja con error y fecha de reintento: si no, se
  // repetiría en cada paso, y con IG limitando las peticiones eso las agotaría (también las
  // del bot SRS, que usa la misma clave)
  async function calcularPlan(ticker, ses) {
    try { await hacerPlan(ticker, ses) } catch (err) {
      const plan = { fecha: ses.fecha, calculado: ahora(), provisional: ahora() < ses.abre, error: `IG: ${err.message}`, reintentar: ahora() + REINTENTO_IG_S }
      datos.planes[ticker] = plan
      apuntar(ticker, `Sin plan: ${err.message}`, { aviso: !plan.provisional })
    }
  }

  // El plan es del índice: la N, los niveles de cada sistema (de los dos siempre, para que un
  // sistema que se deja de jugar pueda seguir sacando sus posiciones por su canal) y la unidad,
  // que es la misma en los dos porque cada entrada va con todo el capital
  async function hacerPlan(ticker, ses) {
    const cfg = datos.config
    const plan = { fecha: ses.fecha, calculado: ahora(), provisional: ahora() < ses.abre, riesgoPct: cfg.riesgoPct }
    const falla = (texto, { espera = REINTENTO_PLAN_S, aviso = !plan.provisional } = {}) => {
      Object.assign(plan, { error: texto, reintentar: ahora() + espera })
      datos.planes[ticker] = plan
      apuntar(ticker, texto, { aviso })
    }
    const fuente = MERCADOS_TORTUGAS[ticker]?.datos?.fuente === 'ig' ? 'IG' : 'Yahoo'
    let velas
    try { velas = await velasDiarias(ticker) } catch (err) {
      if (!/cupo/i.test(err.message)) return falla(`${fuente} no da el diario: ${err.message}`)
      // sin el cupo semanal de histórico de IG, no tiene sentido pedirlo más a menudo que cada hora
      if (ahora() - avisoSinCupo > 12 * 3600) {
        avisoSinCupo = ahora()
        avisarSinFallar('Tortugas: IG ha agotado el cupo semanal de histórico, así que las materias primas sin otra fuente no tienen niveles hasta que se renueve. Lo reintento cada hora.')
      }
      return falla(`${fuente} no da el diario: ${err.message}`, { espera: 3600, aviso: false })
    }
    // si los niveles salen de un respaldo (el oro y la plata sin histórico de IG), de cuál
    const origen = velas?.respaldo ?? fuente
    const nv = nivelesTortugas((velas ?? []).filter(v => v.date < ses.fecha), { stopN: STOP_N })
    if (!nv) return falla(`No hay bastantes velas diarias de ${origen} para calcular los niveles`)
    if ((Date.parse(ses.fecha) - Date.parse(nv.ultimoDia)) / 86_400_000 > DIAS_VIEJO) {
      return falla(`La última vela diaria de ${origen} es del ${nv.ultimoDia}: sin datos al día no se opera`)
    }
    Object.assign(plan, {
      ...(velas?.respaldo ? { respaldo: velas.respaldo } : {}),
      ultimoDia: nv.ultimoDia, cierre: nv.cierre, n: nv.n,
      sistemas: Object.fromEntries(SISTEMAS.map(s => [s, nivelesSistema(nv, s, cfg.filtroS1)])),
    })

    // La unidad sale del saldo de la cuenta y de la N: riesgoPct % del capital por cada N, en
    // cada entrada (los sistemas no se reparten el capital)
    const cuenta = await cuentaReciente()
    if (!(cuenta?.saldo > 0)) return falla('IG no da el saldo de la cuenta: sin él no se sabe el tamaño')
    datos.picoSaldo = Math.max(datos.picoSaldo ?? cuenta.saldo, cuenta.saldo)
    const nominal = capitalNominal(cuenta.saldo, datos.picoSaldo, cfg.reduccionDD)
    Object.assign(plan, { saldo: cuenta.saldo, disponible: cuenta.disponible, nominal, riesgoEurN: nominal * cfg.riesgoPct / 100 })
    const descartes = []
    for (const epic of EPICS_OPERAR[ticker] ?? [null]) {
      const m = await ig.operar.datosMercado(ticker, epic)
      if (!m.conPrecio) { descartes.push(`${m.epic} sin precio para esta cuenta`); continue }
      const t = tamanoPorRiesgo({ riesgoEur: plan.riesgoEurN, riesgoPts: nv.n, valorPunto: valorDe(m), cambioAEur: m.cambioAEur, tamanoMin: m.tamanoMin, paso: pasoDe(m) })
      if (!t.ok) { descartes.push(`${m.epic}: ${t.motivo.replace('arriesgaría', 'costaría')} por N`); continue }
      plan.unidad = { ok: true, epic: m.epic, moneda: m.moneda, tamano: t.tamano, eurPorN: t.riesgoEur, valorPunto: valorDe(m), cambioAEur: m.cambioAEur, tamanoMin: m.tamanoMin, factorMargen: m.factorMargen ?? 0.05 }
      break
    }
    plan.unidad ??= { ok: false, motivo: descartes.join('; ') || 'sin contrato' }
    datos.planes[ticker] = plan

    const partes = [`N ${px(plan.n)}${plan.respaldo ? ` (niveles de ${plan.respaldo}: IG no da su histórico)` : ''}`]
    for (const s of SISTEMAS) {
      const pos = datos.posiciones[claveDe(ticker, s)]
      const sp = plan.sistemas[s]
      if (pos) {
        const n = pos.unidades.length
        partes.push(`S${s}: ${n} ${n === 1 ? 'unidad abierta' : 'unidades abiertas'}, stop ${px(pos.stop)}, salida por el canal en ${px(sp.salida[pos.lado])}`
          + (n < cfg.maxUnidades ? `, siguiente unidad en ${px(siguienteAnadido(pos, ocupadosPorOtro(ticker, s, pos.lado)))}` : ''))
      } else if (cfg.sistemas.includes(s)) {
        const lados = []
        if (cfg.lados !== 'cortos') lados.push(`compra por encima de ${px(sp.entrada.largo.nivel)} (máximo de ${sp.k} sesiones${sp.filtro ? ': la ruptura anterior habría ganado' : ''})`)
        if (cfg.lados !== 'largos') lados.push(`venta por debajo de ${px(sp.entrada.corto.nivel)} (mínimo de ${sp.k})`)
        partes.push(`S${s}: ${lados.join(', ')}`)
      }
    }
    partes.push(plan.unidad.ok
      ? `unidad de ${num(plan.unidad.tamano, 2)} contratos de ${plan.unidad.epic} (${Math.round(plan.unidad.eurPorN)} € por N)`
      : `no se puede operar: ${plan.unidad.motivo}`)
    // el plan se queda en los eventos de la pestaña, sin Telegram: la tabla de la pestaña ya
    // enseña la N, los niveles de cada sistema y la unidad (petición del usuario, 19-oct-2026)
    const texto = `${plan.provisional ? 'Próxima sesión' : 'Sesión de hoy'}: ${partes.join(' · ')}`
    apuntar(ticker, texto, { aviso: false })
  }

  // ── Límites de cartera (los del backtest, dentro de cada sistema; el nominal, de todo) ──
  const unidadesDe = ps => ps.reduce((s, p) => s + p.unidades.filter(u => !u.salida).length, 0)
  const nominalDe = p => p.unidades.filter(u => !u.salida).reduce((s, u) => s + u.tamano * u.entrada, 0) * p.valorPunto * p.cambioAEur
  // `cuenta`: el saldo y el disponible de ahora (el margen ya ocupado cambia con cada orden)
  function noCabe(ticker, sistema, lado, tamano, precio, m, cuenta) {
    const cfg = datos.config
    const mismoLado = posicionesDe(sistema).filter(p => p.lado === lado)
    const grupo = GRUPOS_TORTUGAS[ticker]
    const ladoTexto = lado === 'largo' ? 'largas' : 'cortas'
    if (unidadesDe(mismoLado.filter(p => GRUPOS_TORTUGAS[p.ticker] === grupo)) >= cfg.maxGrupo) return `el Sistema ${sistema} ya tiene ${cfg.maxGrupo} unidades ${ladoTexto} en ${grupo}`
    if (unidadesDe(mismoLado) >= cfg.maxSentido) return `el Sistema ${sistema} ya tiene ${cfg.maxSentido} unidades ${ladoTexto}`
    const nominal = Object.values(datos.posiciones).reduce((s, p) => s + nominalDe(p), 0) + tamano * precio * valorDe(m) * m.cambioAEur
    if (cuenta.saldo > 0 && nominal > APALANCAMIENTO * cuenta.saldo) return `el nominal de las tortugas pasaría de ${APALANCAMIENTO} veces el saldo`
    const margen = tamano * precio * valorDe(m) * m.cambioAEur * (m.factorMargen ?? 0.05)
    if (cuenta.disponible != null && margen > MARGEN_MAX * cuenta.disponible) return `el margen (${Math.round(margen)} €) pasa del ${MARGEN_MAX * 100}% del disponible`
    return null
  }

  const cuentaDeAhora = async plan => {
    const c = await ig.operar.cuenta().catch(() => null)
    return { saldo: c?.saldo ?? plan.saldo, disponible: c?.disponible ?? plan.disponible }
  }

  // Los precios en los que el otro sistema ya está en el índice en ese sentido: sus unidades
  // abiertas y su orden sin confirmar
  function ocupadosPorOtro(ticker, sistema, lado) {
    return SISTEMAS.filter(s => s !== sistema).flatMap(s => {
      const pos = datos.posiciones[claveDe(ticker, s)]
      const intento = datos.intentos[claveDe(ticker, s)]
      return [
        ...(pos?.lado === lado ? pos.unidades.filter(u => !u.salida).map(u => u.entrada) : []),
        ...(intento?.lado === lado ? [intento.nivel] : []),
      ].filter(p => p != null)
    })
  }

  // Los dos sistemas van como uno: si el otro ya tiene en el índice una unidad en el mismo
  // sentido a menos de ½ N de este precio (o una orden suya sin confirmar), es la misma señal
  // y no se ejecuta otra vez. Da el sistema que ya está dentro, o null.
  function otroYaDentro(ticker, sistema, lado, precio, n) {
    if (!ocupadosPorOtro(ticker, sistema, lado).some(p => Math.abs(p - precio) < PASO_N * n)) return null
    return SISTEMAS.find(s => s !== sistema)
  }

  // ── Entradas y añadidos ──
  async function entrar(ticker, sistema, lado, ses) {
    const plan = datos.planes[ticker]
    const sp = plan.sistemas[sistema]
    const u = plan.unidad
    const m = await ig.operar.datosMercado(ticker, u.epic)
    const precio = lado === 'largo' ? m.oferta : m.bid
    if (precio == null) { sp.esperaEntrar = ahora() + 60; return }
    const nivel = sp.entrada[lado].nivel
    // el precio ha vuelto atrás desde la vela que lo rompió: se espera a que lo rompa otra vez
    if ((lado === 'largo' ? precio < nivel : precio > nivel) && Math.abs(precio - nivel) > 0.25 * plan.n) { sp.esperaEntrar = ahora() + 5; return }
    const otro = otroYaDentro(ticker, sistema, lado, precio, plan.n)
    if (otro) {
      sp.bloqueado = `señal doble con el Sistema ${otro}`
      apuntar(ticker, `Ruptura de ${px(nivel)}, pero no entra: el Sistema ${otro} ya ${lado === 'largo' ? 'compró' : 'vendió'} a menos de ½ N de ${px(precio)} (señal doble, se ejecuta una sola vez)`, { sistema })
      return
    }
    const motivo = noCabe(ticker, sistema, lado, u.tamano, precio, m, await cuentaDeAhora(plan))
    if (motivo) {
      sp.esperaEntrar = ahora() + 60
      apuntar(ticker, `Ruptura de ${px(nivel)}, pero no entra: ${motivo}`, { sistema })
      return
    }
    const stop = redondear(precio - dir(lado) * STOP_N * plan.n, m.decimales ?? 1)
    const referencia = referenciaNueva(ticker, sistema)
    apuntar(ticker, `Ruptura del ${lado === 'largo' ? 'máximo' : 'mínimo'} de ${sp.k} sesiones (${px(nivel)}): ${lado === 'largo' ? 'compra' : 'venta'} de ${num(u.tamano, 2)} con stop en ${px(stop)}`, { aviso: false, sistema })
    // Se apunta ANTES de mandarla: si la confirmación no llega, el bot no la repite, sino que
    // mira en IG si entró (repetirla podría dejar dos posiciones)
    const clave = claveDe(ticker, sistema)
    datos.intentos[clave] = { ticker, sistema, tipo: 'entrada', lado, tamano: u.tamano, stop, hora: ahora(), referencia, nivel, k: sp.k, n: plan.n, fecha: ses.fecha }
    guardar()
    const limite = m.aMercado ? null : precio + dir(lado) * 0.25 * plan.n
    const r = await ig.operar.abrir({ ticker, epic: u.epic, lado, tamano: u.tamano, stop, moneda: u.moneda, limite, referencia })
    delete datos.intentos[clave]
    if (!r.aceptada) {
      sp.bloqueado = r.motivo
      apuntar(ticker, `IG rechaza la orden (${r.motivo}): hoy ya no entra`, { sistema })
      return
    }
    abrirPosicion(ticker, sistema, { lado, n0: plan.n, k: sp.k, fecha: ses.fecha, nivel, dealId: r.dealId, tamano: r.tamano ?? u.tamano, entrada: r.nivel, stop: r.stop ?? stop, referencia })
  }

  function abrirPosicion(ticker, sistema, { lado, n0, k, fecha, nivel, dealId, tamano, entrada, stop, referencia, hora = null }) {
    const u = datos.planes[ticker]?.unidad ?? {}
    const h = hora ?? ahora()
    const deslizamiento = nivel == null ? null : dir(lado) * (entrada - nivel)
    datos.posiciones[claveDe(ticker, sistema)] = {
      ticker, sistema, lado, n0, ruptura: k, abierta: fecha, abiertaHora: h, epic: u.epic ?? null, moneda: u.moneda ?? null,
      valorPunto: u.valorPunto ?? 1, cambioAEur: u.cambioAEur ?? 1, stop,
      unidades: [{ dealId, tamano, entrada, stop, hora: h, referencia, nivel, deslizamiento }],
    }
    apuntar(ticker, `${lado === 'largo' ? 'Compra' : 'Venta'} de ${num(tamano, 2)} a ${px(entrada)} (ruptura de ${k} sesiones en ${px(nivel)}`
      + `${deslizamiento != null ? `, ${deslizamiento >= 0 ? '+' : ''}${px(deslizamiento)}` : ''}), stop en ${px(stop)} (2 N, con N ${px(n0)})`, { sistema })
  }

  async function anadir(ticker, sistema, ses) {
    const plan = datos.planes[ticker]
    const pos = datos.posiciones[claveDe(ticker, sistema)]
    const largo = pos.lado === 'largo'
    const m = await ig.operar.datosMercado(ticker, pos.epic)
    const precio = largo ? m.oferta : m.bid
    const nivel = siguienteAnadido(pos, ocupadosPorOtro(ticker, sistema, pos.lado))
    if (precio == null || (largo ? precio < nivel : precio > nivel)) { pos.esperaAnadir = ahora() + 5; return }
    // la unidad de hoy (la N y el capital de hoy), en el contrato de la posición
    const t = tamanoPorRiesgo({ riesgoEur: plan.riesgoEurN, riesgoPts: plan.n, valorPunto: pos.valorPunto, cambioAEur: pos.cambioAEur, tamanoMin: m.tamanoMin, paso: pasoDe(m) })
    if (!t.ok) { pos.sinAnadidos = ses.fecha; apuntar(ticker, `Hoy no se añade: ${t.motivo}`, { sistema }); return }
    const motivo = noCabe(ticker, sistema, pos.lado, t.tamano, precio, m, await cuentaDeAhora(plan))
    if (motivo) {
      pos.esperaAnadir = ahora() + 60
      apuntar(ticker, `La unidad ${pos.unidades.length + 1} no entra: ${motivo}`, { sistema })
      return
    }
    const stop = redondear(precio - dir(pos.lado) * STOP_N * pos.n0, m.decimales ?? 1)
    const referencia = referenciaNueva(ticker, sistema)
    const clave = claveDe(ticker, sistema)
    datos.intentos[clave] = { ticker, sistema, tipo: 'anadido', lado: pos.lado, tamano: t.tamano, stop, hora: ahora(), referencia, nivel }
    guardar()
    const limite = m.aMercado ? null : precio + dir(pos.lado) * 0.25 * pos.n0
    const r = await ig.operar.abrir({ ticker, epic: pos.epic, lado: pos.lado, tamano: t.tamano, stop, moneda: pos.moneda, limite, referencia })
    delete datos.intentos[clave]
    if (!r.aceptada) {
      pos.sinAnadidos = ses.fecha
      apuntar(ticker, `IG rechaza la unidad ${pos.unidades.length + 1} (${r.motivo}): hoy no se añade más`, { sistema })
      return
    }
    await sumarUnidad(pos, { dealId: r.dealId, tamano: r.tamano ?? t.tamano, entrada: r.nivel, stop: r.stop ?? stop, referencia, nivel })
  }

  // Una unidad más, con el stop de todas a 2 N de ella (solo se aprieta, nunca se afloja)
  async function sumarUnidad(pos, { dealId, tamano, entrada, stop, referencia, nivel = null, hora = null }) {
    pos.unidades.push({ dealId, tamano, entrada, stop, hora: hora ?? ahora(), referencia, nivel, deslizamiento: nivel == null ? null : dir(pos.lado) * (entrada - nivel) })
    const nuevo = pos.lado === 'largo' ? Math.max(pos.stop ?? -Infinity, stop) : Math.min(pos.stop ?? Infinity, stop)
    let comoQueda
    try {
      const fallos = await moverStops(pos, nuevo)
      comoQueda = fallos.length ? `IG no deja mover el stop de todas a ${px(nuevo)} (${fallos[0]})` : `stop de todas en ${px(nuevo)}`
    } catch (err) { comoQueda = err.message }
    const n = pos.unidades.filter(u => !u.salida).length
    apuntar(pos.ticker, `Pirámide: ${num(tamano, 2)} más a ${px(entrada)}, ${n} de ${datos.config.maxUnidades} unidades; ${comoQueda}`, { sistema: pos.sistema })
  }

  // El stop de todas las unidades abiertas en `nivel`. Devuelve lo que IG haya rechazado. Si IG
  // falla (un error suyo, no un rechazo), el stop queda pendiente y se reintenta al rato
  async function moverStops(pos, nivel) {
    const fallos = []
    pos.stopPendiente = nivel
    for (const u of pos.unidades.filter(x => !x.salida && x.stop !== nivel)) {
      let r
      try { r = await ig.operar.moverStop({ ticker: pos.ticker, dealId: u.dealId, stop: nivel }) } catch (err) {
        pos.esperaStop = ahora() + ESPERA_STOP_FALLIDO_S
        throw new Error(`IG ha fallado al mover el stop de todas a ${px(nivel)}; se reintenta cada ${ESPERA_STOP_FALLIDO_S} s (${err.message})`, { cause: err })
      }
      if (r.aceptada) u.stop = nivel
      else fallos.push(r.motivo)
    }
    delete pos.stopPendiente
    delete pos.esperaStop
    if (!fallos.length) pos.stop = nivel
    return fallos
  }

  // Un stop que IG no movió por un fallo suyo. Si falta alguna unidad, de la posición se ocupa
  // la revisión; si siguen todas, se vuelve a mover, sin repetirlo en las que IG ya tiene en
  // ese nivel (la orden pudo entrar aunque fallara su confirmación)
  async function reintentarStop(pos) {
    const nivel = pos.stopPendiente
    pos.esperaStop = ahora() + ESPERA_STOP_FALLIDO_S
    const abiertas = await ig.operar.posiciones()
    const pendientes = pos.unidades.filter(u => !u.salida)
    if (pendientes.some(u => !abiertas.some(p => p.dealId === u.dealId))) {
      delete pos.stopPendiente
      delete pos.esperaStop
      return
    }
    for (const u of pendientes) {
      const p = abiertas.find(x => x.dealId === u.dealId)
      if (p.stop != null && Math.abs(p.stop - nivel) <= Math.abs(nivel) * 1e-9) u.stop = nivel
    }
    let texto
    try {
      const fallos = await moverStops(pos, nivel)
      texto = fallos.length ? `IG no deja mover el stop de todas a ${px(nivel)} (${fallos[0]})` : `Stop de todas en ${px(nivel)}, tras el fallo de IG`
    } catch (err) { texto = err.message }
    apuntar(pos.ticker, texto, { sistema: pos.sistema })
  }

  // Tras una orden sin confirmar: si IG tiene la posición con su referencia (o una del mismo
  // sistema en ese mercado abierta desde el intento), es la nuestra; si no, no entró
  async function reconciliar(ticker, sistema) {
    const clave = claveDe(ticker, sistema)
    const intento = datos.intentos[clave]
    const abiertas = await ig.operar.posiciones()
    const conocidas = new Set(Object.values(datos.posiciones).flatMap(p => p.unidades.map(u => u.dealId)))
    const nuestra = abiertas.find(p => p.referencia && p.referencia === intento.referencia)
      ?? abiertas.find(p => p.ticker === ticker && !conocidas.has(p.dealId) && (!p.referencia || sistemaDeReferencia(p.referencia) === sistema)
        && Date.parse(`${p.abierta}Z`) / 1000 >= intento.hora - 60)
    delete datos.intentos[clave]
    const sp = datos.planes[ticker]?.sistemas?.[sistema]
    if (!nuestra) {
      apuntar(ticker, `La orden (${intento.tipo === 'entrada' ? 'entrada' : 'añadido'}) no llegó a entrar en IG`, { sistema })
      if (intento.tipo === 'entrada' && sp) sp.esperaEntrar = ahora() + 60
      return
    }
    apuntar(ticker, 'La confirmación no llegó, pero la posición está abierta en IG: se sigue con ella', { sistema })
    const pos = datos.posiciones[clave]
    if (intento.tipo === 'entrada' || !pos) {
      abrirPosicion(ticker, sistema, { lado: nuestra.lado, n0: intento.n ?? datos.planes[ticker]?.n, k: intento.k, fecha: intento.fecha, nivel: intento.nivel, dealId: nuestra.dealId, tamano: nuestra.tamano, entrada: nuestra.nivel, stop: nuestra.stop ?? intento.stop, referencia: nuestra.referencia })
    } else {
      await sumarUnidad(pos, { dealId: nuestra.dealId, tamano: nuestra.tamano, entrada: nuestra.nivel, stop: nuestra.stop ?? intento.stop, referencia: nuestra.referencia, nivel: intento.nivel })
    }
  }

  // ── Salidas ──
  // Cierra una unidad a mercado (con límite donde IG no admite órdenes a mercado)
  async function cerrarUnidad(pos, u) {
    let r
    let margen = Math.max(0.25 * (pos.n0 || 0), 1)
    for (let intento = 0; intento < 3; intento++, margen *= 2) {
      const m = await ig.operar.datosMercado(pos.ticker, pos.epic)
      const limite = m.aMercado ? null : (pos.lado === 'largo' ? m.bid - margen : m.oferta + margen)
      try {
        r = await ig.operar.cerrar({ ticker: pos.ticker, dealId: u.dealId, lado: pos.lado, tamano: u.tamano, limite })
      } catch (err) {
        // un fallo de IG (o de su confirmación): si la unidad ya no está, se cerró y la
        // revisión busca a qué precio; si sigue abierta, el siguiente paso lo vuelve a intentar
        if ((await ig.operar.posiciones()).some(p => p.dealId === u.dealId)) throw err
        return { aceptada: false, motivo: err.message }
      }
      if (r.aceptada) break
      apuntar(pos.ticker, `IG no cierra ${limite == null ? 'a mercado' : `con ${px(margen)} de margen`} (${r.motivo})`, { sistema: pos.sistema })
    }
    return r
  }

  async function cerrarUnidades(pos, unidades) {
    const fallidas = []
    for (const u of unidades) {
      const r = await cerrarUnidad(pos, u)
      if (r.aceptada) u.salida = { nivel: r.nivel, hora: ahora() }
      else fallidas.push(u)
    }
    return fallidas
  }

  async function salir(pos, motivo) {
    if ((await cerrarUnidades(pos, pos.unidades.filter(u => !u.salida))).length) {
      // puede que ya las hubiera cerrado el stop: la revisión lo aclara
      apuntar(pos.ticker, 'Se revisa si ya estaba cerrada', { aviso: false, sistema: pos.sistema })
      await revisar({ forzar: true })
      return
    }
    terminar(pos, motivo)
  }

  // El resultado de una posición: en puntos, en unidades de la primera (como el backtest
  // cuenta las unidades: todas iguales); en N; y en euros, con el tamaño de cada una
  function resultadoDe(pos) {
    const d = dir(pos.lado)
    const us = pos.unidades.filter(u => u.salida)
    const base = pos.unidades[0].tamano
    const pts = us.reduce((s, u) => s + (u.tamano / base) * d * (u.salida.nivel - u.entrada), 0)
    const eur = us.reduce((s, u) => s + u.tamano * d * (u.salida.nivel - u.entrada), 0) * pos.valorPunto * pos.cambioAEur
    return { pts, n: pos.n0 > 0 ? pts / pos.n0 : null, eur }
  }

  function terminar(pos, motivo) {
    const { ticker, sistema } = pos
    const us = pos.unidades
    const volumen = us.reduce((s, u) => s + u.tamano, 0)
    const { pts, n, eur } = resultadoDe(pos)
    const zona = MERCADOS_TORTUGAS[ticker]?.zona ?? 'Europe/Madrid'
    const op = {
      ticker, sistema, lado: pos.lado, ruptura: pos.ruptura, n0: pos.n0, abierta: pos.abierta, abiertaHora: pos.abiertaHora,
      cerrada: fechaEnZona(ahora(), zona), cerradaHora: ahora(), motivo, unidades: us.length, contratos: volumen,
      entradaMedia: us.reduce((s, u) => s + u.tamano * u.entrada, 0) / volumen,
      salida: us.reduce((s, u) => s + u.tamano * u.salida.nivel, 0) / volumen,
      resultadoPts: pts, resultadoN: n, resultadoEur: eur,
      valorPunto: pos.valorPunto, cambioAEur: pos.cambioAEur, epic: pos.epic,
      detalle: us.map(u => ({ dealId: u.dealId, tamano: u.tamano, entrada: u.entrada, hora: u.hora, salida: u.salida })),
      ...(us.some(u => u.salida.aproximado) ? { aproximado: true } : {}),
      ...(pos.recuperada ? { recuperada: true } : {}),
    }
    datos.operaciones.unshift(op)
    if (datos.operaciones.length > MAX_OPERACIONES) datos.operaciones.length = MAX_OPERACIONES
    delete datos.posiciones[claveDe(ticker, sistema)]
    const dias = Math.round((op.cerradaHora - op.abiertaHora) / 86400)
    apuntar(ticker, `Fuera a ${px(op.salida)} (${motivo}${op.aproximado ? ', precio aproximado' : ''}) con ${us.length} ${us.length === 1 ? 'unidad' : 'unidades'}`
      + `${dias >= 1 ? ` tras ${dias} ${dias === 1 ? 'día' : 'días'}` : ''}: ${eur >= 0 ? '+' : ''}${Math.round(eur)} € (${n >= 0 ? '+' : ''}${num(n, 2)} N)`, { sistema })
  }

  // ¿Siguen abiertas en IG las unidades? Si falta alguna, la cerró su stop (o alguien a mano):
  // se cierran las demás y se busca a qué precio salió cada una. IG tarda unos segundos en
  // apuntar el cierre en la actividad: si aún no está, se mira en las revisiones siguientes y
  // solo tras unas cuantas se da por bueno el nivel del stop. Con `cruces` (posiciones con el
  // precio ya al otro lado del stop) se mira a menudo, y si IG no cierra en unos segundos,
  // cierra el bot. Una sola petición de posiciones para todas.
  let ultimaRevision = 0
  async function revisar({ forzar = false, cruces = new Set() } = {}) {
    const abiertas = Object.values(datos.posiciones)
    if (!abiertas.length) return
    const cada = cruces.size ? Math.min(revisarCadaMs, REVISAR_YA_MS) : revisarCadaMs
    if (!forzar && Date.now() - ultimaRevision < cada) return
    ultimaRevision = Date.now()
    const ids = new Set((await ig.operar.posiciones()).map(p => p.dealId))
    for (const pos of abiertas) {
      try { await revisarPosicion(pos, ids, cruces.has(claveDe(pos.ticker, pos.sistema))) } catch (err) { apuntar(pos.ticker, `Error: ${err.message}`, { sistema: pos.sistema }) }
    }
  }

  async function revisarPosicion(pos, ids, cruce) {
    const { ticker, sistema } = pos
    const pendientes = pos.unidades.filter(u => !u.salida)
    const vivas = pendientes.filter(u => ids.has(u.dealId))
    const idas = pendientes.filter(u => !ids.has(u.dealId))
    if (!idas.length) {
      pos.vista = ahora()
      if (!cruce) { delete pos.cruce; return }
      if (!pos.cruce || ahora() - pos.cruceVisto > 5) pos.cruce = ahora()
      pos.cruceVisto = ahora()
      if (ahora() - pos.cruce < ESPERA_STOP_S) return
      apuntar(ticker, `El precio pasó el stop (${px(pos.stop)}) y IG no ha cerrado: se cierra a mercado`, { sistema })
      if ((await cerrarUnidades(pos, vivas)).length) return
      terminar(pos, 'stop')
      return
    }
    // la actividad se busca desde poco antes de la última vez que se vio abierta
    for (const u of idas) {
      const desde = Math.max(u.hora, (pos.vista ?? u.hora) - 600)
      const c = await ig.operar.cierreDe({ ticker, dealId: u.dealId, lado: pos.lado, desdeMs: desde * 1000 })
      if (c) u.salida = { nivel: c.nivel, hora: ahora() }
    }
    const sinPrecio = idas.filter(u => !u.salida)
    if (sinPrecio.length && (pos.busquedasCierre = (pos.busquedasCierre ?? 0) + 1) < BUSQUEDAS_CIERRE) {
      if (pos.busquedasCierre === 1) apuntar(ticker, 'La posición ya no está en IG: buscando a qué precio se cerró', { aviso: false, sistema })
      return
    }
    for (const u of sinPrecio) u.salida = { nivel: u.stop ?? pos.stop, hora: ahora(), aproximado: true }
    if (vivas.length) {
      apuntar(ticker, `Salieron ${idas.length} de ${pendientes.length} unidades por el stop: se cierran las demás`, { sistema })
      if ((await cerrarUnidades(pos, vivas)).length) return
    }
    terminar(pos, 'stop')
  }

  // Salidas apuntadas al precio del stop porque IG aún no las tenía en la actividad: se
  // buscan otra vez, unas pocas, y si aparecen se corrige el resultado
  let ultimaAfinada = 0
  async function afinar() {
    const pendientes = datos.operaciones.slice(0, 20).flatMap(op => op.detalle
      .filter(u => u.salida?.aproximado && (u.busquedas ?? 0) < BUSQUEDAS_CIERRE).map(u => [op, u]))
    if (!pendientes.length || Date.now() - ultimaAfinada < revisarCadaMs) return
    ultimaAfinada = Date.now()
    const corregidas = new Set()
    for (const [op, u] of pendientes) {
      u.busquedas = (u.busquedas ?? 0) + 1
      const c = await ig.operar.cierreDe({ ticker: op.ticker, dealId: u.dealId, lado: op.lado, desdeMs: (op.cerradaHora - 3600) * 1000 })
      if (c) { u.salida = { nivel: c.nivel, hora: u.salida.hora }; corregidas.add(op) }
    }
    for (const op of corregidas) {
      const d = dir(op.lado), base = op.detalle[0].tamano, volumen = op.detalle.reduce((s, u) => s + u.tamano, 0)
      op.salida = op.detalle.reduce((s, u) => s + u.tamano * u.salida.nivel, 0) / volumen
      op.resultadoPts = op.detalle.reduce((s, u) => s + (u.tamano / base) * d * (u.salida.nivel - u.entrada), 0)
      op.resultadoN = op.n0 > 0 ? op.resultadoPts / op.n0 : null
      op.resultadoEur = op.detalle.reduce((s, u) => s + u.tamano * d * (u.salida.nivel - u.entrada), 0) * op.valorPunto * op.cambioAEur
      if (!op.detalle.some(u => u.salida.aproximado)) delete op.aproximado
      apuntar(op.ticker, `Precio de salida corregido con la actividad de IG: ${Math.round(op.resultadoEur)} €`, { aviso: false, sistema: op.sistema ?? null })
    }
  }

  // Al arrancar: las posiciones del bot (por su referencia, que dice el sistema) que el
  // registro no tiene se recuperan. Sin el registro no se sabe su N de entrada: se deduce de
  // su stop (2 N).
  async function recuperarPosiciones() {
    const conocidas = new Set(Object.values(datos.posiciones).flatMap(p => p.unidades.map(u => u.dealId)))
    const nuevas = (await ig.operar.posiciones())
      .filter(p => sistemaDeReferencia(p.referencia) && p.ticker && GRUPOS_TORTUGAS[p.ticker] && !conocidas.has(p.dealId))
      .sort((a, b) => Date.parse(`${a.abierta}Z`) - Date.parse(`${b.abierta}Z`))
    for (const p of nuevas) {
      const sistema = sistemaDeReferencia(p.referencia)
      const hora = Date.parse(`${p.abierta}Z`) / 1000
      const pos = datos.posiciones[claveDe(p.ticker, sistema)]
      apuntar(p.ticker, `Recuperada de IG una posición del bot que no estaba en el registro (${p.referencia})`, { sistema })
      if (pos) {
        if (pos.lado !== p.lado) { apuntar(p.ticker, `Va en sentido contrario a la que el bot tiene abierta: revísala en IG (${p.dealId})`, { sistema }); continue }
        pos.unidades.push({ dealId: p.dealId, tamano: p.tamano, entrada: p.nivel, stop: p.stop, hora, referencia: p.referencia, nivel: null, deslizamiento: null })
        continue
      }
      const m = await ig.operar.datosMercado(p.ticker, p.epic)
      const n0 = p.stop != null ? Math.abs(p.nivel - p.stop) / STOP_N : null
      datos.posiciones[claveDe(p.ticker, sistema)] = {
        ticker: p.ticker, sistema, lado: p.lado, n0, ruptura: null, abierta: fechaEnZona(hora, MERCADOS_TORTUGAS[p.ticker].zona), abiertaHora: hora,
        epic: p.epic, moneda: m.moneda, valorPunto: valorDe(m) ?? 1, cambioAEur: m.cambioAEur ?? 1, stop: p.stop, recuperada: true,
        unidades: [{ dealId: p.dealId, tamano: p.tamano, entrada: p.nivel, stop: p.stop, hora, referencia: p.referencia, nivel: null, deslizamiento: null }],
      }
    }
  }

  // ── El bucle ──
  // Las acciones van de una en una por la misma cola: una vela que llega mientras se manda
  // una orden espera a que termine, y así nunca salen dos órdenes por la misma ruptura.
  let cola = Promise.resolve()
  let pendiente = false
  // para la vigilancia (server/vigilancia.js): cuándo arrancó y cuándo completó su última vuelta
  let arrancadoEn = null
  let ultimaVuelta = null
  function encolar(fn) {
    const hecho = cola.then(fn)
    cola = hecho.catch(() => {})
    return hecho
  }
  function despertar() {
    if (pendiente) return
    pendiente = true
    encolar(async () => {
      pendiente = false
      try { await paso() } catch (err) { log(`[tortugas] error: ${err.message}`) }
      guardar()
      ultimaVuelta = Date.now()
    })
  }

  // Un índice no tumba a los demás: su error queda en el registro y se sigue con el siguiente.
  // En cada índice, cada sistema que se juega (o que tiene algo entre manos) decide por su cuenta.
  async function paso() {
    const cfg = datos.config
    const t = ahora()
    const cruces = new Set()
    for (const ticker of Object.keys(GRUPOS_TORTUGAS)) {
      const encendido = !!cfg.instrumentos[ticker]
      const sistemas = SISTEMAS.filter(s => (encendido && cfg.sistemas.includes(s))
        || datos.posiciones[claveDe(ticker, s)] || datos.intentos[claveDe(ticker, s)])
      if (!sistemas.length) continue
      try {
        const ses = sesionTortugas(ticker, t)
        const abre = proximaAperturaTortugas(ticker, t)
        const proxima = abre ? sesionTortugas(ticker, abre) : null
        const velas = ultimasVelas('ig', ticker, 5)
        for (const sistema of sistemas) {
          const clave = claveDe(ticker, sistema)
          const juega = encendido && cfg.sistemas.includes(sistema)
          const pos = datos.posiciones[clave]
          const p = siguientePasoTortugas({
            pos, plan: datos.planes[ticker], intento: datos.intentos[clave], ahora: t, velas, ses, proxima, sistema,
            ocupados: pos ? ocupadosPorOtro(ticker, sistema, pos.lado) : [],
            cfg: { ...cfg, encendido: juega, activo: cfg.activo && juega },
          })
          // el plan es del índice: hecho, este paso ya no sigue con él
          if (p.accion === 'plan')        { await calcularPlan(ticker, p.ses); break }
          if (p.accion === 'entrar')      await entrar(ticker, sistema, p.lado, ses)
          if (p.accion === 'anadir')      await anadir(ticker, sistema, ses)
          if (p.accion === 'salir')       await salir(pos, p.motivo)
          if (p.accion === 'reconciliar') await reconciliar(ticker, sistema)
          if (p.accion === 'stop')        await reintentarStop(pos)
          if (p.accion === 'revisar-ya')  cruces.add(clave)
        }
      } catch (err) {
        apuntar(ticker, `Error: ${err.message}`)
      }
    }
    await revisar({ cruces })
    await afinar()
  }

  let reloj = null
  const dejarDeEscuchar = []
  function arrancar() {
    // los planes provisionales (los de la próxima sesión) se rehacen: puede haber cambiado el código
    for (const [t, p] of Object.entries(datos.planes)) if (p?.provisional) delete datos.planes[t]
    encolar(async () => {
      try { await recuperarPosiciones() } catch (err) {
        log(`[tortugas] no se han podido revisar las posiciones al arrancar: ${err.message}`)
        avisarSinFallar(`Tortugas: no he podido revisar las posiciones de IG al arrancar: ${err.message}`)
      }
      guardar()
    })
    arrancadoEn = Date.now()
    reloj = setInterval(despertar, 5_000)
    for (const ticker of Object.keys(GRUPOS_TORTUGAS)) dejarDeEscuchar.push(escuchar('ig', ticker, despertar))
    despertar()
    const abiertas = Object.keys(datos.posiciones).length
    if (datos.config.activo || abiertas) avisarSinFallar(`Tortugas: servidor arrancado, el bot está ${datos.config.activo ? 'encendido' : 'apagado'}${abiertas ? ` con ${abiertas} ${abiertas === 1 ? 'posición abierta' : 'posiciones abiertas'}` : ''}`)
  }
  function parar() {
    clearInterval(reloj)
    reloj = null
    dejarDeEscuchar.splice(0).forEach(f => f())
  }

  // ── Lo que usa la pestaña ──
  function cambiarConfig(cambios) {
    const c = { ...datos.config, instrumentos: { ...datos.config.instrumentos } }
    const entero = (k, min, max, texto) => {
      const n = Number(cambios[k])
      if (!(Number.isInteger(n) && n >= min && n <= max)) throw new Error(texto)
      c[k] = n
    }
    if ('activo' in cambios) c.activo = !!cambios.activo
    if ('instrumentos' in cambios) {
      for (const [t, si] of Object.entries(cambios.instrumentos ?? {})) {
        if (!GRUPOS_TORTUGAS[t]) throw new Error(`Instrumento desconocido: ${t}`)
        c.instrumentos[t] = !!si
      }
    }
    if ('sistemas' in cambios) {
      const s = [...new Set((Array.isArray(cambios.sistemas) ? cambios.sistemas : [cambios.sistemas]).map(Number))].sort()
      if (!s.length || !s.every(x => SISTEMAS.includes(x))) throw new Error('Sistemas: el 1, el 2 o los dos')
      c.sistemas = s
    }
    if ('lados' in cambios) {
      if (!['largos', 'ambos', 'cortos'].includes(cambios.lados)) throw new Error('Lados: largos, ambos o cortos')
      c.lados = cambios.lados
    }
    if ('riesgoPct' in cambios) {
      const n = Number(cambios.riesgoPct)
      if (!(n >= 0.05 && n <= 5)) throw new Error('Riesgo por N entre el 0,05% y el 5% del saldo')
      c.riesgoPct = n
    }
    if ('maxUnidades' in cambios) entero('maxUnidades', 1, 10, 'Unidades por índice: de 1 a 10')
    if ('maxGrupo' in cambios) entero('maxGrupo', 1, 30, 'Unidades por grupo: de 1 a 30')
    if ('maxSentido' in cambios) entero('maxSentido', 1, 50, 'Unidades por sentido: de 1 a 50')
    if ('reduccionDD' in cambios) c.reduccionDD = !!cambios.reduccionDD
    if ('filtroS1' in cambios) c.filtroS1 = !!cambios.filtroS1
    const antes = datos.config
    datos.config = c
    // lo que cambia los niveles o la unidad obliga a rehacer los planes
    if (['sistemas', 'filtroS1', 'lados', 'riesgoPct', 'reduccionDD'].some(k => !igual(antes[k], c[k]))) datos.planes = {}
    guardar()
    const lineas = Object.entries(DESCRIBIR).filter(([k]) => !igual(antes[k], c[k])).map(([k, describir]) => describir(c[k]))
    for (const t of Object.keys(GRUPOS_TORTUGAS)) {
      if (!!antes.instrumentos[t] !== !!c.instrumentos[t]) lineas.push(`${nombreDe(t)}: ${c.instrumentos[t] ? 'activado' : 'desactivado'}`)
    }
    if (lineas.length) avisarSinFallar(`Tortugas · ${lineas.join('\n')}`)
    despertar()
    return c
  }

  // Apaga el bot y cierra todo lo que tenga abierto
  async function pararYCerrar() {
    datos.config.activo = false
    await encolar(async () => {
      for (const pos of Object.values(datos.posiciones)) {
        try { await salir(pos, 'manual') } catch (err) { apuntar(pos.ticker, `Error al cerrar: ${err.message}`, { sistema: pos.sistema }) }
      }
    })
    guardar()
    avisarSinFallar('Tortugas: bot apagado con «Parar y cerrar todo»')
    return estado()
  }

  function estado() {
    const t = ahora()
    return {
      config: datos.config,
      reglas: { pasoN: PASO_N, stopN: STOP_N, apalancamiento: APALANCAMIENTO, sistemas: SISTEMAS },
      picoSaldo: datos.picoSaldo,
      mercados: Object.keys(GRUPOS_TORTUGAS).map(ticker => {
        const ses = sesionTortugas(ticker, t)
        return {
          ticker, nombre: nombreDe(ticker), grupo: GRUPOS_TORTUGAS[ticker], encendido: !!datos.config.instrumentos[ticker],
          enSesion: !!ses && t >= ses.abre && t < ses.cierra, proxima: proximaAperturaTortugas(ticker, t),
          precio: ultimasVelas('ig', ticker, 1).at(-1)?.close ?? null,
          plan: datos.planes[ticker] ?? null,
          posiciones: Object.fromEntries(SISTEMAS.map(s => [s, datos.posiciones[claveDe(ticker, s)] ?? null])),
          intentos: Object.fromEntries(SISTEMAS.map(s => [s, datos.intentos[claveDe(ticker, s)] ?? null])),
        }
      }),
      operaciones: datos.operaciones.slice(0, 200),
      eventos: datos.eventos.slice(-300).reverse(),
    }
  }

  return {
    arrancar, parar, estado, cambiarConfig, pararYCerrar,
    latido: () => ({ enMarcha: reloj !== null, desde: arrancadoEn, ultimaVuelta }),
    // un paso del bucle sin el temporizador (para las pruebas): por la misma cola y guardando
    _paso: () => encolar(async () => { try { await paso() } finally { guardar() } }),
    _recuperar: () => encolar(async () => { try { await recuperarPosiciones() } finally { guardar() } }),
    _datos: () => datos,
  }
}
