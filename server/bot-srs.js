// ── Bot SRS en la demo de IG ───────────────────────────────────────────────────────
// Opera la estrategia SRS de la pestaña Estrategias en varias sesiones del día, cada una a
// la hora de su bolsa: Tokio (Nikkei), Fráncfort (DAX), Londres (FTSE) y Nueva York (Nasdaq,
// S&P, Dow, Russell). En cada una: bracket = máximo y mínimo de la segunda vela de 15 min;
// se compra al romper el máximo (y en modo "ambos" se vende al romper el mínimo, mandando el
// que se rompa antes); stop al otro lado del bracket (o a mitad, con stopPct 0,5);
// opcionalmente a break even al recorrer beR veces el riesgo; y cierre con la sesión.
// En modo "flip" (flip the switch), si salta el stop se da la vuelta: entra en el sentido
// contrario con el stop al otro lado del bracket, una sola vez por sesión. Con pirámide,
// añade una posición cada `piramide` R a favor, hasta MAX_UNIDADES abiertas, y el stop de
// todas va a su precio medio. Las reglas son las de analizarSesion (src/segundaVelaCore.js),
// para que lo que hace el bot se pueda comparar con el backtest.
//
// Cómo opera:
//   · la entrada la decide el bot con el precio en directo: orden a mercado con el stop
//     dentro, que guarda IG (donde IG no admite órdenes a mercado, como el DAX de fin de
//     semana, límite que se ejecuta al momento o se anula); si el precio ya se ha ido del
//     nivel más de `deslizamientoMaxR` veces el bracket, no la manda: no persigue el precio;
//     no deja órdenes pendientes en IG, así que no entran dos lados a la vez ni entra nada
//     con el bot parado;
//   · el tamaño sale del riesgo: un `riesgoPct` % del saldo de la cuenta entre los puntos
//     hasta el stop (y el valor del punto), con el contrato más pequeño que la cuenta pueda
//     operar y sin pasar de una parte del margen;
//   · la pirámide no se come el margen de las entradas que aún esperan otros instrumentos con
//     sesión mientras dure la suya (el DAX y, a las 15:30, el Nasdaq y el Dow): un añadido que
//     no cabe se recorta o espera a que haya margen, y si IG lo rechaza por falta de fondos se
//     reintenta en vez de dejar la pirámide;
//   · cada orden lleva una referencia propia (SRS-…): si el registro se pierde (un despliegue
//     sin volumen), al arrancar recupera sus posiciones abiertas desde IG y las sigue;
//   · si arranca con la sesión empezada y la rotura ya pasó, no entra tarde;
//   · todo lo que apunta (bracket, entradas, añadidos, stops, salidas, errores) lo avisa
//     también por Telegram, si el servidor lo tiene configurado (server/telegram.js).
// Solo opera en la demo (candado en server/ig.js) y solo donde BOT_OPERA=1 (server/index.js).
//
// El registro (configuración y un apunte por sesión) va a un JSON. Al cierre guarda las velas
// de 15 min de la sesión: con ellas la pestaña Bot calcula lo que habría hecho el backtest
// con el mismo motor que la pestaña Estrategias (el servidor se despliega sin src).
//
// El mismo motor opera también la Rule of 4 (RULE_OF_4, con crearBot({ estrategia })): solo
// los días en que el FOMC publica su decisión, con la sesión anclada en el comunicado (14:00
// de Nueva York) y dos horas de duración, y el bracket en la cuarta vela de 10 min. Es otro
// bot, con su registro, su configuración y sus referencias (R4-…): los dos pueden tener a la
// vez posiciones en el mismo índice, que IG no compensa (las órdenes van con forceOpen).

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { offsetMadrid } from './velas-grafico.js'
import { fechaEnZona, diaSemanaEnZona, instanteEnZona } from './zonas.js'
import { ultimasVelas, escuchar } from './tiempo-real.js'
import { EPICS_OPERAR } from './ig.js'
import { HORA_FOMC_NY, diasFomc, esDiaFomc } from './fomc.js'

// Apertura y cierre de cada sesión en la hora de su bolsa (minutos desde medianoche)
export const SESIONES_BOT = {
  '^N225':  { zona: 'Asia/Tokyo',       apertura: 9 * 60,      cierre: 15 * 60 + 30, nombre: 'Nikkei 225' },
  '^GDAXI': { zona: 'Europe/Berlin',    apertura: 9 * 60,      cierre: 17 * 60 + 30, nombre: 'DAX' },
  '^FTSE':  { zona: 'Europe/London',    apertura: 8 * 60,      cierre: 16 * 60 + 30, nombre: 'FTSE 100' },
  '^NDX':   { zona: 'America/New_York', apertura: 9 * 60 + 30, cierre: 16 * 60,      nombre: 'Nasdaq 100' },
  '^GSPC':  { zona: 'America/New_York', apertura: 9 * 60 + 30, cierre: 16 * 60,      nombre: 'S&P 500' },
  '^DJI':   { zona: 'America/New_York', apertura: 9 * 60 + 30, cierre: 16 * 60,      nombre: 'Dow Jones' },
  '^RUT':   { zona: 'America/New_York', apertura: 9 * 60 + 30, cierre: 16 * 60,      nombre: 'Russell 2000' },
}

export const CONFIG_INICIAL = {
  activo:            false,
  instrumentos:      { '^N225': true, '^GDAXI': true, '^FTSE': false, '^NDX': true, '^GSPC': true, '^DJI': true, '^RUT': false },
  modo:              'flip',  // 'largo': solo compra; 'ambos': compra o vende, la rotura que llegue antes;
                              // 'flip': como 'ambos', y si salta el stop da la vuelta (una vez por sesión)
  stopPct:           1,       // 1: stop al otro lado del bracket; 0,5: a mitad de vela (sin flip)
  beR:               null,    // null, 1 o 2: stop a la entrada al recorrer esas veces el riesgo
  piramide:          1,       // null: sin pirámide; un número: una posición más cada tantas R a favor
  tamanoAnadido:     0.5,     // lo que mete cada añadido, en fracción de la entrada: 1 o 0,5
  riesgoPct:         1,       // lo que se arriesga por operación hasta el stop, en % del saldo de la cuenta: el tamaño es
                              // saldo × riesgoPct / (puntos hasta el stop × valor del punto); 200 € en la demo de 20.000 €
                              // (era un 2,5%; el usuario lo bajó al 1% el 18-oct-2026, al añadir los índices de EE. UU.)
  deslizamientoMaxR: 0.25,    // no entra (ni da la vuelta, ni añade) si el precio ya se ha ido del nivel más de esta
                              // fracción del bracket; donde IG no admite órdenes a mercado, es el límite de la orden
  rangoMaxPct:       0.8,     // si el bracket mide más (en % del precio), ese día no se opera
}

const MINUTOS_VELA = 15
const REVISAR_CADA_MS = 30_000   // cada cuánto se mira en IG si una posición sigue abierta
const REVISAR_YA_MS = 2_000      // con el precio al otro lado del stop y una vuelta pendiente, se mira mucho más a menudo
const ESPERA_STOP_S = 10         // si el precio pasó el stop y IG no ha cerrado en este rato, cierra el bot
const BUSQUEDAS_CIERRE = 4       // revisiones buscando el precio de cierre antes de dar por bueno el del stop
const MARGEN_MAX = 0.4           // parte del disponible que puede ocupar el margen de una posición (el mínimo del Nikkei es ~36%)
const MARGEN_IG = 0.05           // el margen que pide IG, en tanto por uno del nominal, si su ficha no lo dice
const COLCHON_MARGEN = 0.05      // parte del saldo que un añadido deja sin tocar: el disponible sube y baja con lo que ganan las posiciones
const ESPERA_MARGEN_S = 60       // un añadido que no cabe en el margen lo vuelve a mirar pasado este rato
const ESPERA_FONDOS_S = 300      // y si IG lo rechaza por falta de fondos, pasado este
const BRACKETS_TIPICOS = 10      // los últimos brackets de un instrumento con los que se estima el margen de su entrada
const PREFIJO = 'SRS-'           // referencia de las órdenes del bot
export const MAX_UNIDADES = 4    // posiciones abiertas como mucho por instrumento y sentido, la entrada incluida: la entrada y
                                 // 3 añadidos (el usuario lo bajó de 5 el 19-oct-2026, por el margen que se comía la pirámide)
const MAX_PIERNAS = 2            // flip the switch: la entrada y una única vuelta, como el backtest
const MIN_EN_VELA = 12           // de las 15 velas de 1 min, las que tiene que haber para dar por buena una de 15 hecha con el directo
const ESPERA_HISTORICO_S = 300   // si el histórico de IG falla (sin cupo semanal, p. ej.), no se le vuelve a pedir hasta pasado este rato
const INTENTOS_VELAS = 3         // al cierre, las veces que se pide el histórico antes de guardar lo que haya del directo

export const minutoMadrid = ts => Math.floor(((ts + offsetMadrid(ts)) % 86400 + 86400) % 86400 / 60)
const horaMadrid = ts => new Date((ts + offsetMadrid(ts)) * 1000).toISOString().slice(11, 16)
const euros = x => `${Math.round(x).toLocaleString('es-ES')} €`

// Velas de `minutos` hechas con las de 1 min del directo entre `desde` y `hasta`, alineadas a
// `desde`, con cuántas de 1 min lleva cada una (`n`). Son las mismas que da el histórico de IG
// (las dos a precio medio) y no gastan su cupo semanal, que se agota con el Gráfico.
export function agruparDirecto(velas1, desde, hasta, minutos = MINUTOS_VELA) {
  const tramo = minutos * 60
  const porTramo = new Map()
  for (const v of velas1) {
    if (v.time < desde || v.time >= hasta) continue
    const t = desde + Math.floor((v.time - desde) / tramo) * tramo
    const a = porTramo.get(t)
    porTramo.set(t, a
      ? { ...a, high: Math.max(a.high, v.high), low: Math.min(a.low, v.low), close: v.close, n: a.n + 1 }
      : { time: t, open: v.open, high: v.high, low: v.low, close: v.close, n: 1 })
  }
  return [...porTramo.values()].sort((a, b) => a.time - b.time)
}

// Una sesión con su vela del bracket: la `nBracket`-ésima de `minutosVela` desde la apertura
const conBracket = (ticker, fecha, abre, cierra, minutosVela, nBracket) => ({
  ticker, fecha, abre, cierra,
  velaBracket: abre + (nBracket - 1) * minutosVela * 60,
  finBracket:  abre + nBracket * minutosVela * 60,
})

// La sesión de un instrumento en curso en `t` (o la de ese día, si ya cerró), en su bolsa.
// null en fin de semana.
export function sesionDe(ticker, t) {
  const s = SESIONES_BOT[ticker]
  if (!s) return null
  const dow = diaSemanaEnZona(t, s.zona)
  if (dow === 0 || dow === 6) return null
  const fecha = fechaEnZona(t, s.zona)
  return conBracket(ticker, fecha, instanteEnZona(fecha, s.apertura, s.zona), instanteEnZona(fecha, s.cierre, s.zona), MINUTOS_VELA, 2)
}

// La próxima apertura de un instrumento a partir de `t` (para enseñarla en la pestaña)
export function proximaApertura(ticker, t) {
  for (let d = 0; d < 8; d++) {
    const ses = sesionDe(ticker, t + d * 86400)
    if (ses && ses.abre > t) return ses.abre
  }
  return null
}

// ── Rule of 4: los días del FOMC ──
// La sesión empieza con el comunicado, a las 14:00 de Nueva York (las 20:00 de Madrid casi
// siempre; las 19:00 o las 21:00 las semanas en que los dos no han cambiado aún la hora), y
// dura dos horas, hasta el cierre de Wall Street. Igual para todos los instrumentos: el DAX,
// el FTSE y el Nikkei también cotizan a esa hora. La fecha es la de Nueva York. El calendario
// es el de server/fomc.js, que server/calendario-fomc.js tiene al día con la Reserva Federal.
const ZONA_FOMC = 'America/New_York'
const comunicado = fecha => instanteEnZona(fecha, HORA_FOMC_NY, ZONA_FOMC)

export function sesionRuleOf4(ticker, t) {
  if (!SESIONES_BOT[ticker]) return null
  const fecha = fechaEnZona(t, ZONA_FOMC)
  if (!esDiaFomc(fecha)) return null
  const abre = comunicado(fecha)
  return conBracket(ticker, fecha, abre, abre + 120 * 60, 10, 4)
}

// El próximo comunicado a partir de `t`, o null si el calendario se acaba
export function proximaRuleOf4(ticker, t) {
  for (const fecha of diasFomc()) {
    const abre = comunicado(fecha)
    if (abre > t) return abre
  }
  return null
}

// Lo que cambia de una estrategia a otra; el resto del bot es el mismo. `aviso` va delante de
// lo que se manda a Telegram, para saber de qué bot es (el SRS, sin nada, como siempre).
export const SRS = {
  id: 'srs', nombre: 'SRS', prefijo: PREFIJO, etiquetaLog: 'bot', aviso: '',
  minutosVela: MINUTOS_VELA, nBracket: 2,
  configInicial: CONFIG_INICIAL, sesionDe, proximaApertura,
}
export const RULE_OF_4 = {
  id: 'rule-of-4', nombre: 'Rule of 4', prefijo: 'R4-', etiquetaLog: 'rule of 4', aviso: 'Rule of 4 · ',
  minutosVela: 10, nBracket: 4,
  configInicial: {
    ...CONFIG_INICIAL,
    instrumentos: { '^N225': false, '^GDAXI': false, '^FTSE': false, '^NDX': true, '^GSPC': true, '^DJI': true, '^RUT': false },
  },
  sesionDe: sesionRuleOf4, proximaApertura: proximaRuleOf4,
}

// ── Piernas y posiciones ──
// Cada sesión tiene una pierna en curso (`operacion`: un sentido, con una o varias
// posiciones de IG en `unidades`) y las que ya se cerraron antes de dar la vuelta
// (`anteriores`).

// Una pierna abierta: la operación en curso, sin salida
export const posicionAbierta = d => !!d?.operacion && !d.operacion.salida && !d.salida
// La sesión aún tiene algo entre manos: posiciones, una orden por confirmar o una vuelta pendiente
const enJuego = d => posicionAbierta(d) || d?.estado === 'entrando' || d?.estado === 'esperando-vuelta'
// Como el backtest: con flip y el stop al otro lado del bracket (justo donde entra el sentido
// contrario) da la vuelta, y solo desde la primera pierna
const puedeDarLaVuelta = (dia, cfg) => cfg.modo === 'flip' && cfg.stopPct === 1 && (dia.anteriores?.length ?? 0) + 1 < MAX_PIERNAS
const nivelDe = (bracket, lado) => (lado === 'largo' ? bracket.high : bracket.low)
const contrario = lado => (lado === 'largo' ? 'corto' : 'largo')
// Dónde entra la posición n+1 de la pirámide: n tramos de `piramide` R desde el nivel de la
// rotura, que es desde donde cuenta el backtest
const nivelAnadido = (op, cfg, n) => op.nivelOrden + (op.lado === 'largo' ? 1 : -1) * n * cfg.piramide * op.riesgo

// ── La decisión (pura) ──
// Con el apunte de la sesión, la configuración, la hora, las últimas velas de 1 min en
// directo y la sesión, dice qué toca hacer ahora. No llama a nada.
export function siguientePaso({ dia, cfg, ahora, velas, ses }) {
  const abierta = posicionAbierta(dia)
  // una orden mandada cuya confirmación no llegó: antes de nada, ver en IG si entró
  if (dia?.estado === 'entrando') return { accion: 'reconciliar' }
  // con la sesión cerrada: cerrar lo que siga abierto y guardar las velas del día
  if (ahora >= ses.cierra) {
    if (abierta) return { accion: 'cerrar', motivo: 'cierre' }
    if (dia?.estado === 'esperando-vuelta') return { accion: 'sin-vuelta' }
    return dia?.bracket && !dia.velas && !(dia.esperaVelas > ahora) ? { accion: 'velas' } : { accion: 'nada' }
  }
  // el precio de ahora: la última vela de 1 min, si es de hace nada
  const ultima = velas.at(-1)
  const precio = ultima && ultima.time + 120 > ahora ? ultima.close : null
  if (abierta) {
    const op = dia.operacion
    const largo = op.lado === 'largo'
    // el precio está al otro lado del stop y toca dar la vuelta: IG la cierra con su stop, y
    // hay que verlo cuanto antes para entrar en el otro sentido cerca del nivel
    if (puedeDarLaVuelta(dia, cfg) && !op.be && op.stop != null && precio != null && (largo ? precio <= op.stop : precio >= op.stop)) {
      return { accion: 'revisar-ya' }
    }
    // pirámide: el precio llegó al nivel de la siguiente posición (una como mucho cada 5 min)
    const n = op.unidades?.length ?? 1
    if (cfg.activo && cfg.piramide && n < MAX_UNIDADES && !op.sinAnadidos && precio != null
        && Math.floor(ahora / 300) !== op.ultimoCubo5 && !(op.esperaAnadir > ahora)) {
      const nivel = nivelAnadido(op, cfg, n)
      if (largo ? precio >= nivel : precio <= nivel) return { accion: 'anadir' }
    }
    if (cfg.beR != null && !op.be) {
      const despues = velas.filter(v => v.time + 60 > op.hora)
      const favor = largo
        ? Math.max(...despues.map(v => v.high)) - op.entrada
        : op.entrada - Math.min(...despues.map(v => v.low))
      if (despues.length && favor >= cfg.beR * op.riesgo) return { accion: 'breakeven' }
    }
    return { accion: 'vigilar' }
  }
  if (!dia || dia.estado === 'terminado' || dia.estado === 'sin-operar') return { accion: 'nada' }
  if (!cfg.activo) return { accion: 'nada' }
  if (dia.estado === 'esperando-vuelta') {
    // se da la vuelta con el precio al otro lado del bracket, que es donde entra el sentido
    // contrario; si ya ha vuelto dentro, se espera a que lo rompa otra vez
    const lado = contrario(dia.anteriores.at(-1).lado)
    const nivel = nivelDe(dia.bracket, lado)
    if (precio != null && !(dia.esperaVuelta > ahora) && (lado === 'largo' ? precio >= nivel : precio <= nivel)) return { accion: 'vuelta', lado }
    return { accion: 'nada' }
  }
  if (ahora < ses.finBracket) return { accion: 'nada' }
  // sin bracket, o con él pero sin plan porque falló algo a medias: se intenta (otra vez) al rato
  if (!dia.bracket || (!dia.plan && dia.estado === 'esperando-bracket')) return dia.esperaBracket > ahora ? { accion: 'nada' } : { accion: 'bracket' }

  const { high, low } = dia.bracket
  for (const v of velas.filter(x => x.time >= ses.finBracket)) {
    if (v.high > high) return { accion: 'entrar', lado: 'largo' }
    if (cfg.modo !== 'largo' && v.low < low) return { accion: 'entrar', lado: 'corto' }
  }
  return { accion: 'nada' }
}

// Nivel del stop: al otro lado del bracket, o a la fracción del rango que diga stopPct
export function nivelStop(bracket, lado, stopPct) {
  const riesgo = bracket.rango * stopPct
  return lado === 'largo' ? bracket.high - riesgo : bracket.low + riesgo
}

// Lo que se arriesga por operación: un `riesgoPct` % del saldo de la cuenta
export const riesgoDeCuenta = (saldo, riesgoPct) => (saldo > 0 && riesgoPct > 0 ? saldo * riesgoPct / 100 : null)

// Contratos para arriesgar `riesgoEur` hasta el stop, de `paso` en `paso` (décimas, o
// centésimas en los contratos que admiten tamaños menores). Si eso queda por debajo del mínimo
// de IG, se usa el mínimo mientras no arriesgue más del doble; si no, no.
export function tamanoPorRiesgo({ riesgoEur, riesgoPts, valorPunto, cambioAEur, tamanoMin, paso = 0.1 }) {
  if (!(riesgoPts > 0) || !(valorPunto > 0) || !(cambioAEur > 0)) return { ok: false, motivo: 'faltan datos del mercado' }
  const eurPorContrato = riesgoPts * valorPunto * cambioAEur
  const min = tamanoMin ?? 0.1
  let tamano = Math.round(Math.floor(riesgoEur / eurPorContrato / paso + 1e-9) * paso * 100) / 100
  if (tamano < min) {
    if (min * eurPorContrato > 2 * riesgoEur) {
      return { ok: false, motivo: `el mínimo de IG (${min}) arriesgaría ${Math.round(min * eurPorContrato)} €` }
    }
    tamano = min
  }
  return { ok: true, tamano, riesgoEur: tamano * eurPorContrato }
}

// El margen de un contrato del plan al precio `precio`, en euros
export const margenPorContrato = (precio, plan) => precio * plan.valorPunto * plan.cambioAEur * (plan.factorMargen ?? MARGEN_IG)

// La parte del saldo que suele pedir de margen la entrada de un instrumento. Arriesgando un
// riesgoPct % del saldo con el stop a una fracción b del precio, el nominal es riesgoPct % / b
// veces el saldo, y el margen, el factor de IG de eso. `brackets`: los últimos, en fracción del
// precio; con su mediana sale b. Sin ninguno, o si sale más, el tope de margen de una entrada.
export function margenTipico(brackets, { riesgoPct, stopPct = 1, factorMargen = MARGEN_IG }) {
  const b = [...brackets].filter(x => x > 0).sort((x, y) => x - y)
  if (!b.length) return MARGEN_MAX
  const mediana = b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2
  return Math.min(MARGEN_MAX, riesgoPct / 100 * factorMargen / (mediana * stopPct))
}

// Los apuntes de antes de la pirámide y el flip tenían una sola posición por sesión: se
// pasan a la forma de ahora (la pierna con su lista de posiciones) al leer el registro
function normalizar(d) {
  const op = d.operacion
  if (!op || op.unidades) return
  const salida = d.salida ? { nivel: d.salida.nivel, hora: d.salida.hora, ...(d.salida.aproximado ? { aproximado: true } : {}) } : null
  op.unidades = [{ dealId: op.dealId, tamano: op.tamano, entrada: op.entrada, stop: op.stop, hora: op.hora, ...(salida ? { salida } : {}) }]
  if (d.salida) Object.assign(op, { salida: d.salida, resultadoPts: d.resultadoPts ?? null, resultadoEur: d.resultadoEur ?? null })
}

// Lo que cuenta cada cambio de configuración en el aviso
const DESCRIBIR = {
  activo:            v => (v ? 'Bot encendido' : 'Bot apagado'),
  modo:              v => `Operativa: ${{ largo: 'solo compras', ambos: 'compra o venta', flip: 'compra o venta, con flip the switch' }[v]}`,
  stopPct:           v => `Stop: ${v === 1 ? 'al otro lado del bracket' : 'a mitad del bracket'}`,
  beR:               v => `Break even: ${v == null ? 'no' : `al recorrer ${v}R`}`,
  piramide:          v => `Pirámide: ${v == null ? 'no' : `una posición más cada ${v}R a favor, hasta ${MAX_UNIDADES - 1} añadidos`}`,
  tamanoAnadido:     v => `Cada añadido: ${v === 1 ? 'una unidad entera' : 'media unidad'}`,
  riesgoPct:         v => `Riesgo por operación: ${String(v).replace('.', ',')}% de la cuenta`,
  deslizamientoMaxR: v => `No entra si el precio se ha ido del nivel más de un ${Math.round(v * 100)}% del bracket`,
  rangoMaxPct:       v => `Bracket máximo: ${v}% del precio`,
}

// ── El bot ──
// `avisar(texto)` recibe lo que pasa (para Telegram); si falla, el bot sigue a lo suyo.
// `estrategia`: SRS (por defecto) o RULE_OF_4.
export function crearBot({ ig, archivo, ahora = () => Math.floor(Date.now() / 1000), log = console.log, revisarCadaMs = REVISAR_CADA_MS, avisar = () => {}, estrategia = SRS }) {
  const E = estrategia
  const inicial = E.configInicial
  // de las velas de 1 min de la del bracket, las que tiene que haber para hacerla con el directo
  const minEnVela = Math.round(E.minutosVela * MIN_EN_VELA / MINUTOS_VELA)
  let datos = { config: { ...inicial }, dias: {} }
  try {
    const leido = JSON.parse(readFileSync(archivo, 'utf8'))
    const config = { ...inicial }
    for (const k of Object.keys(inicial)) if (k in (leido.config ?? {})) config[k] = leido.config[k]
    config.instrumentos = { ...inicial.instrumentos, ...config.instrumentos }
    datos = { config, dias: leido.dias ?? {} }
  } catch { /* primera vez */ }
  for (const d of Object.values(datos.dias)) normalizar(d)

  // Solo se escribe si algo cambió: el bucle pasa cada 5 s
  let guardado = JSON.stringify(datos, null, 2)
  const guardar = () => {
    const texto = JSON.stringify(datos, null, 2)
    if (texto === guardado) return
    try {
      writeFileSync(`${archivo}.tmp`, texto)
      renameSync(`${archivo}.tmp`, archivo)
      guardado = texto
    } catch (err) { log(`[${E.etiquetaLog}] no se ha podido guardar: ${err.message}`) }
  }

  function avisarSinFallar(texto) {
    try { Promise.resolve(avisar(`${E.aviso}${texto}`)).catch(() => {}) } catch { /* el aviso es lo de menos */ }
  }

  const clave = ses => `${ses.fecha} ${ses.ticker}`
  function apunteDe(ses, crear) {
    const k = clave(ses)
    if (!datos.dias[k] && crear) {
      datos.dias[k] = {
        clave: k, fecha: ses.fecha, ticker: ses.ticker, abre: ses.abre, cierra: ses.cierra,
        // la ventana en minutos de Madrid, para que la pestaña pase las velas por el backtest
        ventana: { open: minutoMadrid(ses.abre), close: minutoMadrid(ses.cierra), minutosVela: E.minutosVela, nBracket: E.nBracket },
        config: { ...datos.config }, estado: 'esperando-bracket', bracket: null, plan: null,
        operacion: null, salida: null, eventos: [],
      }
    }
    return datos.dias[k] ?? null
  }
  // Apunta lo que pasa en la sesión y lo avisa. Lo mismo dos veces seguidas (un error que se
  // repite en cada paso) se apunta y se avisa una sola vez.
  function apuntar(dia, texto, { aviso = true } = {}) {
    if (dia.eventos.at(-1)?.texto === texto) return
    dia.eventos.push({ hora: new Date(ahora() * 1000).toISOString(), texto })
    log(`[${E.etiquetaLog}] ${dia.clave} ${texto}`)
    if (aviso) avisarSinFallar(`${SESIONES_BOT[dia.ticker]?.nombre ?? dia.ticker} · ${texto}`)
  }
  const referenciaNueva = dia => `${E.prefijo}${dia.ticker.replace(/\W/g, '')}-${dia.fecha.replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6)}`

  // ── Las velas: primero las del directo, y el histórico de IG solo si faltan ──
  const directo = ticker => ultimasVelas('ig', ticker, 3 * 1440)
  // El histórico de IG gasta un cupo semanal: si falla, no se le vuelve a pedir en un rato
  // (sin esto, una sesión sin cupo lo pediría en cada paso, cada 5 s)
  let historicoHasta = 0
  // Velas de la estrategia entre `desde` y `hasta`, alineadas a `desde`. IG no da velas de 10
  // min: para la Rule of 4 se piden las de 5 y se juntan de dos en dos.
  async function historico(ticker, desde, hasta) {
    if (ahora() < historicoHasta) throw new Error('el histórico de IG ha fallado hace poco; se vuelve a pedir en unos minutos')
    try {
      if (E.minutosVela === 15) return await ig.velasEntre(ticker, 'm15', desde, hasta)
      return agruparDirecto(await ig.velasEntre(ticker, 'm5', desde, hasta), desde, hasta, E.minutosVela)
    } catch (err) {
      historicoHasta = ahora() + ESPERA_HISTORICO_S
      throw err
    }
  }

  // ── El margen ──
  // Lo que un añadido tiene que dejar libre: el margen de las entradas que aún pueden llegar
  // mientras siga abierta la sesión de `dia`, las de los otros instrumentos encendidos cuya
  // sesión se cruza con lo que le queda y que aún no han entrado (o esperan para dar la
  // vuelta). Con plan, lo que pedirá su entrada; sin él, lo que suele pedir según sus últimos
  // brackets (margenTipico). Así la pirámide de un instrumento no deja sin entrada a otro: el
  // DAX, p. ej., no se come el margen que necesitan a las 15:30 el Nasdaq y el Dow.
  function margenReservado(dia, saldo) {
    const cfg = datos.config
    const t = ahora()
    const reservas = []
    if (!cfg.activo) return reservas
    for (const [ticker, si] of Object.entries(cfg.instrumentos)) {
      if (!si || ticker === dia.ticker || !SESIONES_BOT[ticker]) continue
      const cruzan = [E.sesionDe(ticker, t), E.sesionDe(ticker, dia.cierra - 1)].filter(s => s && s.cierra > t && s.abre < dia.cierra)
      for (const ses of new Map(cruzan.map(s => [clave(s), s])).values()) {
        const otro = datos.dias[clave(ses)]
        if (otro && !['esperando-bracket', 'esperando-rotura', 'esperando-vuelta'].includes(otro.estado)) continue
        const eur = otro?.plan
          ? otro.plan.tamano * margenPorContrato(otro.cierreBracket ?? otro.bracket.high, otro.plan)
          : saldo * margenTipicoDe(ticker, otro?.config ?? cfg)
        reservas.push({ ticker, eur })
      }
    }
    return reservas
  }

  // margenTipico de un instrumento con sus últimos brackets del registro (los que se podían operar)
  function margenTipicoDe(ticker, cfg) {
    const pasados = Object.values(datos.dias)
      .filter(d => d.ticker === ticker && d.bracket?.rango > 0)
      .sort((a, b) => b.abre - a.abre)
    const brackets = pasados
      .map(d => d.bracket.rango / (d.cierreBracket ?? d.bracket.high))
      .filter(b => b * 100 <= cfg.rangoMaxPct)
      .slice(0, BRACKETS_TIPICOS)
    const factorMargen = pasados.find(d => d.plan?.factorMargen)?.plan.factorMargen ?? MARGEN_IG
    return margenTipico(brackets, { riesgoPct: cfg.riesgoPct, stopPct: cfg.stopPct, factorMargen })
  }

  // ── Las acciones ──

  // El bracket y el plan del día. Si algo falla a medias (el saldo o la ficha del mercado), la
  // sesión se queda esperando con el bracket y sin plan, sin poder entrar, y el plan se vuelve
  // a intentar al rato
  async function calcularBracket(dia, ses) {
    try { await bracketYPlan(dia, ses) } catch (err) {
      if (!dia.plan && dia.estado === 'esperando-bracket') dia.esperaBracket = ahora() + 30
      throw err
    }
  }

  // El bracket y el plan del día: qué contrato, cuántos y si cabe en el margen
  async function bracketYPlan(dia, ses) {
    const cfg = dia.config
    let v
    if (dia.bracket) {
      // ya estaba: solo falta el plan, que falló la otra vez
      v = { high: dia.bracket.high, low: dia.bracket.low, close: dia.cierreBracket ?? dia.bracket.high }
    } else {
      // la vela del bracket, hecha con el directo si lo tiene casi entero (el servidor estaba en marcha)
      v = agruparDirecto(directo(dia.ticker), ses.velaBracket, ses.finBracket, E.minutosVela).find(x => x.time === ses.velaBracket && x.n >= minEnVela)
      if (!v) {
        let velas
        try { velas = await historico(dia.ticker, ses.velaBracket, ses.finBracket) } catch (err) {
          dia.esperaBracket = ahora() + 60
          apuntar(dia, `Sin la vela del bracket: el directo no la tiene entera y el histórico de IG falla (${err.message}). Se sigue intentando`)
          return
        }
        v = velas.find(x => x.time === ses.velaBracket)
      }
      if (!v) { dia.estado = 'sin-operar'; apuntar(dia, 'IG no da la vela del bracket (¿festivo?): hoy no se opera'); return }
      const rango = v.high - v.low
      dia.bracket = { high: v.high, low: v.low, rango, vela: ses.velaBracket }
      dia.cierreBracket = v.close
      const pct = rango / v.close * 100
      apuntar(dia, `Bracket ${v.low.toFixed(1)} – ${v.high.toFixed(1)} (${rango.toFixed(1)} puntos, ${pct.toFixed(2)}%)`)
      if (!(rango > 0) || pct > cfg.rangoMaxPct) {
        dia.estado = 'sin-operar'
        apuntar(dia, `Rango fuera del límite (${cfg.rangoMaxPct}% del precio): hoy no se opera`)
        return
      }
    }
    const { rango } = dia.bracket

    // si el bot arranca tarde, la rotura pudo pasar con él parado: no se entra tarde
    if (ahora() > ses.finBracket + 120) {
      // si el directo estaba vivo al acabar el bracket (tiene velas de sus últimos minutos), con
      // él; si no, con el histórico de IG, y sin ninguno de los dos no se sabe si ya rompió: no se entra
      const d = directo(dia.ticker)
      let despues
      if (d.some(x => x.time >= ses.finBracket - 300 && x.time < ses.finBracket)) despues = d.filter(x => x.time >= ses.finBracket)
      else {
        try { despues = await historico(dia.ticker, ses.finBracket, ahora()) } catch (err) {
          dia.estado = 'sin-operar'
          apuntar(dia, `El bot arrancó con la sesión empezada y sin el histórico de IG (${err.message}) no se sabe si ya rompió: hoy no se entra`)
          return
        }
      }
      const rota = despues.find(x => x.high > v.high || (cfg.modo !== 'largo' && x.low < v.low))
      if (rota) {
        dia.estado = 'sin-operar'
        apuntar(dia, `La rotura fue a las ${horaMadrid(rota.time)} con el bot parado: hoy no se entra`)
        return
      }
    }

    // lo que se arriesga sale del saldo de la cuenta de hoy
    const cuenta = await ig.operar.cuenta()
    const riesgoEur = riesgoDeCuenta(cuenta?.saldo, cfg.riesgoPct)
    if (riesgoEur == null) { dia.estado = 'sin-operar'; apuntar(dia, 'IG no da el saldo de la cuenta: sin él no se sabe el tamaño, hoy no se opera'); return }

    // el contrato: el primero de la lista con precio para la cuenta y que quepa en el riesgo
    const riesgoPts = rango * cfg.stopPct
    const descartes = []
    let plan = null
    for (const epic of EPICS_OPERAR[dia.ticker] ?? [null]) {
      const m = await ig.operar.datosMercado(dia.ticker, epic)
      if (!m.conPrecio) { descartes.push(`${m.epic} sin precio para esta cuenta`); continue }
      const t = tamanoPorRiesgo({ riesgoEur, riesgoPts, valorPunto: m.valorPunto, cambioAEur: m.cambioAEur, tamanoMin: m.tamanoMin })
      if (!t.ok) { descartes.push(`${m.epic}: ${t.motivo}`); continue }
      plan = { epic: m.epic, moneda: m.moneda, tamano: t.tamano, riesgoEur: t.riesgoEur, valorPunto: m.valorPunto, cambioAEur: m.cambioAEur, tamanoMin: m.tamanoMin,
        factorMargen: m.factorMargen ?? MARGEN_IG, saldo: cuenta.saldo, riesgoPct: cfg.riesgoPct }
      break
    }
    if (!plan) {
      dia.estado = 'sin-operar'
      apuntar(dia, `Ningún contrato vale: ${descartes.join('; ')}`)
      return
    }
    // que el margen de la posición no se coma la cuenta: como mucho una parte del disponible
    // (IG pide un 5% del nominal en casi todos estos índices)
    const { disponible } = cuenta
    if (disponible != null) {
      const margenUno = margenPorContrato(v.close, plan)
      const tope = Math.floor((disponible * MARGEN_MAX / margenUno) * 10) / 10
      if (plan.tamano > tope) {
        if (tope < (plan.tamanoMin ?? 0.1)) {
          dia.estado = 'sin-operar'
          apuntar(dia, `El margen de ${plan.tamanoMin} contratos (${Math.round(margenUno * (plan.tamanoMin ?? 0.1))} €) pasa del ${MARGEN_MAX * 100}% del disponible: hoy no se opera`)
          return
        }
        apuntar(dia, `Tamaño recortado de ${plan.tamano} a ${tope} por el margen`)
        plan.riesgoEur = plan.riesgoEur * tope / plan.tamano
        plan.tamano = tope
      }
    }
    dia.plan = plan
    dia.estado = 'esperando-rotura'
    apuntar(dia, `Plan: ${plan.tamano} contratos de ${plan.epic} (${plan.valorPunto} ${plan.moneda} por punto), ${Math.round(plan.riesgoEur)} € hasta el stop`
      + ` (el ${String(cfg.riesgoPct).replace('.', ',')}% de ${Math.round(cuenta.saldo).toLocaleString('es-ES')} € son ${Math.round(riesgoEur)} €)`)
  }

  // Entra en la rotura (o, con `vuelta`, en el sentido contrario tras saltar el stop) si el
  // precio no se ha ido del nivel más del tope
  async function entrar(dia, lado, { vuelta = false } = {}) {
    const cfg = dia.config
    const { plan, bracket } = dia
    const nivel = nivelDe(bracket, lado)
    const stop = nivelStop(bracket, lado, cfg.stopPct)
    const tope = cfg.deslizamientoMaxR * bracket.rango
    const m = await ig.operar.datosMercado(dia.ticker, plan.epic)
    const precio = lado === 'largo' ? m.oferta : m.bid
    const exceso = lado === 'largo' ? precio - nivel : nivel - precio
    const noSigue = () => { if (vuelta) finalizar(dia); else dia.estado = 'sin-operar' }
    if (exceso > tope) {
      apuntar(dia, `El precio (${precio}) ya está ${exceso.toFixed(1)} puntos más allá de ${nivel}, y el tope es ${tope.toFixed(1)}: ${vuelta ? 'no se da la vuelta' : 'hoy no se entra'}`)
      noSigue()
      return
    }
    if (vuelta && exceso < -tope) {
      // ha vuelto dentro del bracket desde la última vela: se espera a que lo rompa otra vez
      dia.esperaVuelta = ahora() + 5
      return
    }
    const limite = m.aMercado ? null : (lado === 'largo' ? nivel + tope : nivel - tope)
    const referencia = referenciaNueva(dia)
    apuntar(dia, vuelta
      ? `Flip the switch: ${lado === 'largo' ? 'compra' : 'venta'} de ${plan.tamano} con stop en ${stop.toFixed(1)}`
      : `Rotura ${lado === 'largo' ? 'por arriba: compra' : 'por abajo: venta'} de ${plan.tamano} con stop en ${stop.toFixed(1)}`)
    // Se apunta ANTES de mandarla: si la confirmación no llega (un corte justo ahí), el bot
    // no la repite, sino que mira en IG si entró. Repetirla podría dejar dos posiciones.
    dia.estado = 'entrando'
    dia.intento = { tipo: vuelta ? 'vuelta' : 'entrada', lado, tamano: plan.tamano, stop, hora: ahora(), referencia }
    guardar()
    const r = await ig.operar.abrir({ ticker: dia.ticker, epic: plan.epic, lado, tamano: plan.tamano, stop, moneda: plan.moneda, limite, referencia })
    if (!r.aceptada) {
      apuntar(dia, `IG rechaza la orden: ${r.motivo}`)
      noSigue()
      return
    }
    adoptar(dia, { lado, dealId: r.dealId, tamano: r.tamano ?? plan.tamano, nivel: r.nivel, stop: r.stop ?? stop, referencia })
  }

  // Una pierna nueva con su primera posición
  function adoptar(dia, { lado, dealId, tamano, nivel, stop, referencia = null, hora = null }) {
    const nivelOrden = dia.bracket ? nivelDe(dia.bracket, lado) : nivel
    const h = hora ?? dia.intento?.hora ?? ahora()
    // lo que se pagó de más (o de menos) respecto al nivel de la rotura, que es donde entra el backtest
    const deslizamiento = lado === 'largo' ? nivel - nivelOrden : nivelOrden - nivel
    dia.operacion = {
      lado, dealId, tamano, nivelOrden, entrada: nivel, stop,
      riesgo: dia.bracket ? dia.bracket.rango * dia.config.stopPct : Math.abs(nivel - stop),
      hora: h, be: false, deslizamiento,
      unidades: [{ dealId, tamano, entrada: nivel, stop, hora: h, referencia, deslizamiento }],
    }
    dia.estado = 'en-posicion'
    apuntar(dia, `Dentro a ${nivel} (${deslizamiento >= 0 ? '+' : ''}${deslizamiento.toFixed(1)} puntos sobre el nivel)`)
  }

  // Una posición más en la pierna en curso (un añadido de la pirámide)
  function sumarUnidad(dia, { dealId, tamano, entrada, stop, referencia = null, nivel = entrada, hora = null }) {
    const op = dia.operacion
    const deslizamiento = op.lado === 'largo' ? entrada - nivel : nivel - entrada
    op.unidades.push({ dealId, tamano, entrada, stop, hora: hora ?? ahora(), referencia, nivel, deslizamiento })
    op.ultimoCubo5 = Math.floor(ahora() / 300)
    apuntar(dia, `Añadida a ${entrada}: ${op.unidades.length} posiciones abiertas`)
  }

  // Tras una orden sin confirmar: si IG tiene la posición con su referencia (o una de ese
  // mercado abierta desde el intento), es la nuestra; si no, no entró
  async function reconciliar(dia) {
    const { intento } = dia
    const abiertas = await ig.operar.posiciones()
    const conocidas = new Set((dia.operacion?.unidades ?? []).map(u => u.dealId))
    // (sin la referencia, solo una sin referencia o con la del bot: la de otro bot de la misma
    // cuenta, como el de las tortugas, no es nuestra aunque entre a la vez)
    const nuestra = abiertas.find(p => p.referencia && p.referencia === intento.referencia)
      ?? abiertas.find(p => p.ticker === dia.ticker && !conocidas.has(p.dealId) && (!p.referencia || p.referencia.startsWith(E.prefijo))
        && Date.parse(`${p.abierta}Z`) / 1000 >= intento.hora - 60)
    if (intento.tipo === 'anadido') {
      dia.estado = 'en-posicion'
      if (!nuestra) { apuntar(dia, 'El añadido no llegó a entrar en IG'); return }
      apuntar(dia, 'La confirmación del añadido no llegó, pero la posición está abierta en IG: se sigue con ella')
      sumarUnidad(dia, { dealId: nuestra.dealId, tamano: nuestra.tamano, entrada: nuestra.nivel, stop: nuestra.stop ?? intento.stop, referencia: nuestra.referencia, nivel: intento.nivel })
      await ajustarStops(dia)
      return
    }
    if (nuestra) {
      apuntar(dia, 'La confirmación no llegó, pero la posición está abierta en IG: se sigue con ella')
      adoptar(dia, { lado: nuestra.lado, dealId: nuestra.dealId, tamano: nuestra.tamano, nivel: nuestra.nivel, stop: nuestra.stop ?? intento.stop, referencia: nuestra.referencia })
    } else if (intento.tipo === 'vuelta') {
      apuntar(dia, 'La orden de la vuelta no llegó a entrar en IG')
      finalizar(dia)
    } else {
      dia.estado = 'sin-operar'
      apuntar(dia, 'La orden no llegó a entrar en IG; hoy ya no se entra')
    }
  }

  // Pone el stop de todas las posiciones abiertas de la pierna en `nivel`. Devuelve lo que
  // IG haya rechazado; la pierna solo cambia de stop si lo aceptó para todas
  async function moverStops(dia, nivel) {
    const op = dia.operacion
    const fallos = []
    for (const u of op.unidades.filter(x => !x.salida && x.stop !== nivel)) {
      const r = await ig.operar.moverStop({ ticker: dia.ticker, dealId: u.dealId, stop: nivel })
      if (r.aceptada) u.stop = nivel
      else fallos.push(r.motivo)
    }
    if (!fallos.length) op.stop = nivel
    return fallos
  }

  async function breakeven(dia) {
    const op = dia.operacion
    op.be = true
    const fallos = await moverStops(dia, op.entrada)
    if (fallos.length) { apuntar(dia, `IG no deja mover el stop a break even: ${fallos[0]}`); return }
    apuntar(dia, `Stop a break even (${op.entrada})`)
  }

  // El stop de la pierna en el precio medio de sus posiciones (contando `extra`, una que va
  // a entrar), que es donde el conjunto sale a cero; solo se aprieta, nunca se afloja
  function stopMedio(op, extra = null) {
    const us = [...op.unidades.filter(u => !u.salida), ...(extra ? [extra] : [])]
    const medio = Math.round(us.reduce((n, u) => n + u.tamano * u.entrada, 0) / us.reduce((n, u) => n + u.tamano, 0) * 10) / 10
    return op.lado === 'largo' ? Math.max(op.stop, medio) : Math.min(op.stop, medio)
  }

  async function ajustarStops(dia) {
    const op = dia.operacion
    const stop = stopMedio(op)
    // con el stop en el precio medio la pierna ya no pierde: como en el backtest, cuenta como
    // break even, y de un break even no se da la vuelta
    op.be = true
    const fallos = await moverStops(dia, stop)
    if (fallos.length) apuntar(dia, `IG no deja mover el stop a ${stop}: ${fallos[0]}`)
    else apuntar(dia, `Stop de las ${op.unidades.length} posiciones al precio medio: ${stop}`)
  }

  // Pirámide: una posición más al llegar el precio a su nivel, con el stop de todas en su
  // precio medio. Si el precio se ha ido del nivel más del tope, espera a que vuelva cerca.
  // Si no cabe en el margen (dejando el de las entradas que aún esperan otros instrumentos),
  // se recorta, o espera a que lo haya; y si IG la rechaza por falta de fondos, se reintenta
  async function anadir(dia) {
    const cfg = dia.config
    const { plan } = dia
    const op = dia.operacion
    const largo = op.lado === 'largo'
    const tope = cfg.deslizamientoMaxR * dia.bracket.rango
    const m = await ig.operar.datosMercado(dia.ticker, plan.epic)
    const precio = largo ? m.oferta : m.bid
    // el último nivel alcanzado: si el precio se saltó alguno, entra en el de ahora
    const n = Math.floor((largo ? precio - op.nivelOrden : op.nivelOrden - precio) / (cfg.piramide * op.riesgo) + 1e-9)
    if (n < op.unidades.length) return
    const nivel = nivelAnadido(op, cfg, n)
    const exceso = largo ? precio - nivel : nivel - precio
    if (exceso > tope) {
      op.esperaAnadir = ahora() + 5
      if (op.avisoAnadido !== n) {
        op.avisoAnadido = n
        apuntar(dia, `Añadido en espera: el precio va ${exceso.toFixed(1)} puntos más allá de su nivel (${nivel.toFixed(1)}), y el tope es ${tope.toFixed(1)}`, { aviso: false })
      }
      return
    }
    let tamano = Math.max(plan.tamanoMin ?? 0.1, Math.round(plan.tamano * cfg.tamanoAnadido * 10) / 10)
    // el margen: lo que queda del disponible tras guardar el de las entradas de los demás y un colchón
    let cuenta
    try { cuenta = await ig.operar.cuenta() } catch (err) { op.esperaAnadir = ahora() + ESPERA_MARGEN_S; throw err }
    if (cuenta?.disponible != null) {
      const saldo = cuenta.saldo ?? plan.saldo
      const reservas = margenReservado(dia, saldo)
      const reservado = reservas.reduce((s, r) => s + r.eur, 0)
      const cabe = Math.floor((cuenta.disponible - reservado - COLCHON_MARGEN * saldo) / margenPorContrato(precio, plan) * 10 + 1e-9) / 10
      const cuentas = `${euros(cuenta.disponible)} disponibles`
        + (reservas.length ? `, de los que ${euros(reservado)} se guardan para la entrada de ${reservas.map(r => SESIONES_BOT[r.ticker].nombre).join(' y ')}` : '')
      if (cabe < (plan.tamanoMin ?? 0.1)) {
        op.esperaAnadir = ahora() + ESPERA_MARGEN_S
        if (op.avisoMargen !== n) {
          op.avisoMargen = n
          apuntar(dia, `Añadido en espera: no cabe en el margen (${cuentas}). Se vuelve a mirar cada minuto`)
        }
        return
      }
      if (cabe < tamano) {
        apuntar(dia, `Añadido recortado de ${tamano} a ${cabe} por el margen (${cuentas})`, { aviso: false })
        tamano = cabe
      }
    }
    const stop = stopMedio(op, { tamano, entrada: precio })
    const limite = m.aMercado ? null : (largo ? nivel + tope : nivel - tope)
    const referencia = referenciaNueva(dia)
    // tras un rechazo de IG por falta de fondos, los reintentos no se apuntan hasta que entre
    const reintento = op.sinFondos != null
    if (!reintento) apuntar(dia, `Pirámide: ${largo ? 'compra' : 'venta'} de ${tamano} más, la posición ${op.unidades.length + 1} de ${MAX_UNIDADES} como mucho`)
    dia.estado = 'entrando'
    dia.intento = { tipo: 'anadido', lado: op.lado, tamano, stop, hora: ahora(), referencia, nivel }
    guardar()
    const r = await ig.operar.abrir({ ticker: dia.ticker, epic: plan.epic, lado: op.lado, tamano, stop, moneda: plan.moneda, limite, referencia })
    dia.estado = 'en-posicion'
    if (!r.aceptada) {
      if (r.motivo === 'INSUFFICIENT_FUNDS') {
        // sin margen ahora no es sin margen luego (otra sesión cierra, o la posición gana): se reintenta
        op.esperaAnadir = ahora() + ESPERA_FONDOS_S
        op.sinFondos = ahora()
        if (!reintento) apuntar(dia, `IG rechaza el añadido por falta de fondos (${r.motivo}): se reintenta cada ${ESPERA_FONDOS_S / 60} min mientras el precio siga en su nivel`)
        return
      }
      // otro motivo: no se insiste en esta pierna
      op.sinAnadidos = true
      apuntar(dia, `IG rechaza el añadido (${r.motivo}): esta pierna no añade más`)
      return
    }
    delete op.sinFondos
    sumarUnidad(dia, { dealId: r.dealId, tamano: r.tamano ?? tamano, entrada: r.nivel, stop: r.stop ?? stop, referencia, nivel })
    await ajustarStops(dia)
  }

  // Resultado de una pierna: cada posición desde su entrada hasta su salida. En puntos cuenta
  // en unidades de la entrada, como el backtest (un añadido de media unidad suma la mitad);
  // en euros, con su tamaño real
  function resultadoPierna(dia, op) {
    const dir = op.lado === 'largo' ? 1 : -1
    const us = op.unidades.filter(u => u.salida)
    const pts = us.reduce((n, u) => n + (u.tamano / op.tamano) * dir * (u.salida.nivel - u.entrada), 0)
    const plan = dia.plan
    const eur = plan?.valorPunto && plan?.cambioAEur
      ? us.reduce((n, u) => n + u.tamano * dir * (u.salida.nivel - u.entrada), 0) * plan.valorPunto * plan.cambioAEur
      : null
    return { pts, eur }
  }

  // La salida de la pierna: el precio medio al que salieron sus posiciones
  function salidaPierna(op, motivo, hora) {
    const volumen = op.unidades.reduce((n, u) => n + u.tamano, 0)
    const nivel = Math.round(op.unidades.reduce((n, u) => n + u.tamano * u.salida.nivel, 0) / volumen * 10) / 10
    const aproximado = op.unidades.some(u => u.salida.aproximado)
    return { nivel, hora, motivo, ...(aproximado ? { aproximado: true } : {}) }
  }

  // Con todas sus posiciones fuera, la pierna termina. Si fue el stop y toca flip, se espera
  // a dar la vuelta; si no, la sesión ya no opera más
  function terminarPierna(dia, motivo, ses = null) {
    const op = dia.operacion
    op.salida = salidaPierna(op, motivo, ahora())
    const { pts, eur } = resultadoPierna(dia, op)
    op.resultadoPts = pts
    op.resultadoEur = eur
    const n = op.unidades.length
    apuntar(dia, `Fuera a ${op.salida.nivel} (${motivo}${op.salida.aproximado ? ', precio aproximado' : ''}): ${op.resultadoPts >= 0 ? '+' : ''}${op.resultadoPts.toFixed(1)} puntos`
      + `${n > 1 ? ` con ${n} posiciones` : ''}${op.resultadoEur != null ? ` (${op.resultadoEur >= 0 ? '+' : ''}${Math.round(op.resultadoEur)} €)` : ''}`)
    if (motivo === 'stop' && ses && ahora() < ses.cierra && puedeDarLaVuelta(dia, dia.config)) {
      dia.anteriores = [...(dia.anteriores ?? []), op]
      dia.operacion = null
      dia.estado = 'esperando-vuelta'
      const lado = contrario(op.lado)
      apuntar(dia, `Flip the switch: ${lado === 'largo' ? 'compra por encima de' : 'venta por debajo de'} ${nivelDe(dia.bracket, lado)}`)
      return
    }
    finalizar(dia)
  }

  // La sesión ya no opera más: su salida es la de la última pierna y el resultado, la suma
  function finalizar(dia) {
    const piernas = [...(dia.anteriores ?? []), ...(dia.operacion ? [dia.operacion] : [])].filter(p => p.salida)
    dia.estado = 'terminado'
    if (!piernas.length) return
    dia.salida = piernas.at(-1).salida
    dia.resultadoPts = piernas.reduce((n, p) => n + p.resultadoPts, 0)
    dia.resultadoEur = piernas.every(p => p.resultadoEur != null) ? piernas.reduce((n, p) => n + p.resultadoEur, 0) : null
  }

  // Cierra una posición a mercado, reintentando si IG la rechaza. Donde no admite órdenes a
  // mercado va con límite, y si el precio se escapa del margen, se reintenta con el precio
  // nuevo y el doble de margen
  async function cerrarUnidad(dia, u) {
    const op = dia.operacion
    const epic = dia.plan?.epic ?? null
    let r
    let margen = Math.max((dia.config.deslizamientoMaxR ?? 0.25) * (dia.bracket?.rango ?? op.riesgo), 1)
    for (let intento = 0; intento < 3; intento++, margen *= 2) {
      const m = await ig.operar.datosMercado(dia.ticker, epic)
      const limite = m.aMercado ? null : (op.lado === 'largo' ? m.bid - margen : m.oferta + margen)
      r = await ig.operar.cerrar({ ticker: dia.ticker, dealId: u.dealId, lado: op.lado, tamano: u.tamano, limite })
      if (r.aceptada) break
      apuntar(dia, limite == null ? `IG no cierra a mercado (${r.motivo})` : `IG no cierra con ${margen.toFixed(1)} puntos de margen (${r.motivo})`)
    }
    return r
  }

  // Devuelve las que IG no ha dejado cerrar
  async function cerrarUnidades(dia, unidades) {
    const fallidas = []
    for (const u of unidades) {
      const r = await cerrarUnidad(dia, u)
      if (r.aceptada) u.salida = { nivel: r.nivel, hora: ahora() }
      else fallidas.push(u)
    }
    return fallidas
  }

  // Al cierre (o a mano) hay que salir sí o sí
  async function cerrar(dia, motivo, ses = null) {
    const op = dia.operacion
    if ((await cerrarUnidades(dia, op.unidades.filter(u => !u.salida))).length) {
      // puede que ya las hubiera cerrado el stop: la revisión lo aclara
      apuntar(dia, 'Se revisa si ya estaba cerrada', { aviso: false })
      await revisar(dia, ses, { forzar: true })
      return
    }
    terminarPierna(dia, motivo, ses)
  }

  // ¿Siguen abiertas en IG las posiciones de la pierna? Si falta alguna, la cerró el stop (o
  // alguien a mano) y la pierna se acaba: las demás se cierran y se busca a qué precio salió
  // cada una. IG tarda unos segundos en apuntar el cierre en la actividad: si aún no está, se
  // mira en las siguientes revisiones, y solo tras unas cuantas se da por bueno el nivel del
  // stop. Con una vuelta pendiente no se espera: se apunta el stop y se afina después.
  // Con `cruce` (el precio ya está al otro lado del stop) se mira a menudo, y si IG no la
  // cierra en unos segundos, la cierra el bot.
  const ultimaRevision = new Map()
  async function revisar(dia, ses, { forzar = false, cruce = false } = {}) {
    const cada = cruce ? Math.min(revisarCadaMs, REVISAR_YA_MS) : revisarCadaMs
    if (!forzar && Date.now() - (ultimaRevision.get(dia.clave) ?? 0) < cada) return
    ultimaRevision.set(dia.clave, Date.now())
    const op = dia.operacion
    const ids = new Set((await ig.operar.posiciones()).map(p => p.dealId))
    const pendientes = op.unidades.filter(u => !u.salida)
    const vivas = pendientes.filter(u => ids.has(u.dealId))
    const idas = pendientes.filter(u => !ids.has(u.dealId))
    if (!idas.length) {
      if (!cruce) return
      // el tiempo que lleva el precio al otro lado del stop sin que IG cierre
      if (!op.cruce || ahora() - op.cruceVisto > 5) op.cruce = ahora()
      op.cruceVisto = ahora()
      if (ahora() - op.cruce < ESPERA_STOP_S) return
      apuntar(dia, `El precio pasó el stop (${op.stop}) y IG no ha cerrado: se cierra a mercado`)
      if ((await cerrarUnidades(dia, vivas)).length) return
      terminarPierna(dia, 'stop', ses)
      return
    }
    const sinEsperar = puedeDarLaVuelta(dia, dia.config) && !op.be
    for (const u of idas) {
      const c = await ig.operar.cierreDe({ ticker: dia.ticker, dealId: u.dealId, lado: op.lado, desdeMs: u.hora * 1000 })
      if (c) u.salida = { nivel: c.nivel, hora: ahora() }
    }
    const sinPrecio = idas.filter(u => !u.salida)
    if (sinPrecio.length && !sinEsperar && (op.busquedasCierre = (op.busquedasCierre ?? 0) + 1) < BUSQUEDAS_CIERRE) {
      if (op.busquedasCierre === 1) apuntar(dia, 'La posición ya no está en IG: buscando a qué precio se cerró', { aviso: false })
      return
    }
    for (const u of sinPrecio) u.salida = { nivel: u.stop ?? op.stop, hora: ahora(), aproximado: true }
    if (vivas.length) {
      apuntar(dia, `Salió ${idas.length} de ${pendientes.length} posiciones por el stop: se cierran las demás`)
      if ((await cerrarUnidades(dia, vivas)).length) return
    }
    terminarPierna(dia, op.be ? 'breakeven' : 'stop', ses)
  }

  // Salidas apuntadas al precio del stop porque IG aún no las tenía en la actividad: se
  // buscan otra vez, unas pocas, y si aparecen se corrige el resultado
  const ultimaAfinada = new Map()
  async function afinar(dia) {
    const piernas = [...(dia.anteriores ?? []), ...(dia.operacion ? [dia.operacion] : [])]
    const pendientes = piernas.flatMap(p => (p.unidades ?? []).filter(u => u.salida?.aproximado && (u.busquedas ?? 0) < BUSQUEDAS_CIERRE).map(u => [p, u]))
    if (!pendientes.length) return
    if (Date.now() - (ultimaAfinada.get(dia.clave) ?? 0) < revisarCadaMs) return
    ultimaAfinada.set(dia.clave, Date.now())
    let corregidas = 0
    for (const [p, u] of pendientes) {
      u.busquedas = (u.busquedas ?? 0) + 1
      const c = await ig.operar.cierreDe({ ticker: dia.ticker, dealId: u.dealId, lado: p.lado, desdeMs: u.hora * 1000 })
      if (c) { u.salida = { nivel: c.nivel, hora: u.salida.hora }; corregidas++ }
    }
    if (!corregidas) return
    for (const p of piernas.filter(x => x.salida)) {
      p.salida = salidaPierna(p, p.salida.motivo, p.salida.hora)
      const { pts, eur } = resultadoPierna(dia, p)
      Object.assign(p, { resultadoPts: pts, resultadoEur: eur })
    }
    if (dia.estado === 'terminado') finalizar(dia)
    apuntar(dia, 'Precio de salida corregido con la actividad de IG', { aviso: false })
  }

  // Las velas de la sesión (de 15 min, o de 10 en la Rule of 4), para comparar con el
  // backtest en la pestaña: las del directo si están todas; si no, las del histórico de IG; y
  // si este falla unas cuantas veces, las que haya del directo (el backtest de ese día puede
  // salir incompleto)
  async function guardarVelas(dia, ses) {
    const propias = agruparDirecto(directo(dia.ticker), ses.abre, ses.cierra, E.minutosVela)
    const esperadas = Math.round((ses.cierra - ses.abre) / (E.minutosVela * 60))
    const guardarlas = (velas, de) => {
      dia.velas = velas.map(v => [v.time, v.open, v.high, v.low, v.close])
      apuntar(dia, `Guardadas ${velas.length} velas de ${E.minutosVela} min de la sesión (${de})`, { aviso: false })
    }
    if (propias.length >= esperadas - 1 && propias[0]?.time === ses.abre) return guardarlas(propias, 'del directo')
    try { return guardarlas(await historico(dia.ticker, ses.abre, ses.cierra), 'del histórico de IG') } catch (err) {
      dia.intentosVelas = (dia.intentosVelas ?? 0) + 1
      if (dia.intentosVelas >= INTENTOS_VELAS) return guardarlas(propias, `del directo, ${propias.length} de ${esperadas}: el histórico de IG falla`)
      dia.esperaVelas = ahora() + 600
      apuntar(dia, `No se pueden guardar aún las velas de la sesión: ${err.message}`, { aviso: false })
    }
  }

  // Al arrancar: las posiciones del bot (por su referencia) que el registro no tiene, se
  // recuperan; las de una sesión ya cerrada se cierran en el siguiente paso
  async function recuperarPosiciones() {
    const conocidas = new Set(Object.values(datos.dias).filter(posicionAbierta).flatMap(d => d.operacion.unidades.map(u => u.dealId)))
    const nuevas = (await ig.operar.posiciones())
      .filter(p => p.referencia?.startsWith(E.prefijo) && p.ticker && !conocidas.has(p.dealId))
      .sort((a, b) => Date.parse(`${a.abierta}Z`) - Date.parse(`${b.abierta}Z`))
    for (const p of nuevas) {
      const abierta = Date.parse(`${p.abierta}Z`) / 1000
      const ses = E.sesionDe(p.ticker, abierta)
      if (!ses) continue
      const dia = apunteDe(ses, true)
      apuntar(dia, `Recuperada de IG una posición del bot que no estaba en el registro (${p.referencia})`)
      if (posicionAbierta(dia)) {
        if (dia.operacion.lado !== p.lado) { apuntar(dia, `Va en sentido contrario a la que el bot tiene abierta: revísala en IG (${p.dealId})`); continue }
        sumarUnidad(dia, { dealId: p.dealId, tamano: p.tamano, entrada: p.nivel, stop: p.stop, referencia: p.referencia, hora: abierta })
      } else {
        adoptar(dia, { lado: p.lado, dealId: p.dealId, tamano: p.tamano, nivel: p.nivel, stop: p.stop, referencia: p.referencia, hora: abierta })
      }
      dia.recuperada = true
    }
  }

  // ── El bucle ──
  // Las acciones van de una en una: una vela que llega mientras se manda una orden espera
  // a que termine, y así nunca salen dos órdenes por la misma rotura.
  let cola = Promise.resolve()
  let pendiente = false
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
      try { await paso() } catch (err) { log(`[${E.etiquetaLog}] error: ${err.message}`) }
      guardar()
    })
  }

  // Los instrumentos a mirar: los encendidos y cualquiera con algo entre manos
  function tickersAMirar() {
    const encendidos = Object.entries(datos.config.instrumentos).filter(([, si]) => si).map(([t]) => t)
    const abiertos = Object.values(datos.dias).filter(enJuego).map(d => d.ticker)
    return [...new Set([...encendidos, ...abiertos])].filter(t => SESIONES_BOT[t])
  }

  // Un instrumento no tumba a los demás: su error queda en su apunte y se sigue con el siguiente
  async function paso() {
    const cfg = datos.config
    const t = ahora()
    let primerError = null
    for (const ticker of tickersAMirar()) {
      try {
        const ses = E.sesionDe(ticker, t)
        // algo que quedó entre manos de una sesión que ya terminó (el bot estaba parado al cierre)
        const viejas = Object.values(datos.dias).filter(d => d.ticker === ticker && enJuego(d) && d.cierra <= t && (!ses || d.clave !== clave(ses)))
        for (const d of viejas) await pasoDe(d, { ticker, fecha: d.fecha, abre: d.abre, cierra: d.cierra, finBracket: d.abre + E.nBracket * E.minutosVela * 60 }, cfg, t)
        if (!ses) continue
        const crear = cfg.activo && !!cfg.instrumentos[ticker] && t < ses.cierra
        const dia = apunteDe(ses, crear)
        if (!dia) continue
        // hasta que se fija el bracket, la sesión sigue la configuración del momento
        if (dia.estado === 'esperando-bracket' && !dia.bracket) dia.config = { ...cfg }
        await pasoDe(dia, ses, cfg, t)
      } catch (err) { primerError ??= err }
    }
    if (primerError) throw primerError
  }

  async function pasoDe(dia, ses, cfg, t) {
    try {
      const velas = ultimasVelas('ig', dia.ticker, 3)
      const activo = cfg.activo && !!cfg.instrumentos[dia.ticker]
      const p = siguientePaso({ dia, cfg: { ...dia.config, activo }, ahora: t, velas, ses })
      if (p.accion === 'bracket')     await calcularBracket(dia, ses)
      if (p.accion === 'entrar')      await entrar(dia, p.lado)
      if (p.accion === 'vuelta')      await entrar(dia, p.lado, { vuelta: true })
      if (p.accion === 'anadir')      await anadir(dia)
      if (p.accion === 'breakeven')   await breakeven(dia)
      if (p.accion === 'cerrar')      await cerrar(dia, p.motivo, ses)
      if (p.accion === 'vigilar')     await revisar(dia, ses)
      if (p.accion === 'revisar-ya')  await revisar(dia, ses, { cruce: true })
      if (p.accion === 'reconciliar') await reconciliar(dia)
      if (p.accion === 'velas')       await guardarVelas(dia, ses)
      if (p.accion === 'sin-vuelta')  { apuntar(dia, 'La sesión cerró sin que el precio volviera a romper: no hay vuelta'); finalizar(dia) }
      await afinar(dia)
    } catch (err) {
      apuntar(dia, `Error: ${err.message}`)
      throw err
    }
  }

  let reloj = null
  const dejarDeEscuchar = []
  function arrancar() {
    encolar(async () => {
      try { await recuperarPosiciones() } catch (err) {
        log(`[${E.etiquetaLog}] no se han podido revisar las posiciones al arrancar: ${err.message}`)
        avisarSinFallar(`No he podido revisar las posiciones de IG al arrancar: ${err.message}`)
      }
      guardar()
    })
    reloj = setInterval(despertar, 5_000)
    for (const ticker of Object.keys(SESIONES_BOT)) dejarDeEscuchar.push(escuchar('ig', ticker, despertar))
    despertar()
    avisarSinFallar(`Servidor arrancado: el bot está ${datos.config.activo ? 'encendido' : 'apagado'}`)
  }
  function parar() {
    clearInterval(reloj)
    dejarDeEscuchar.splice(0).forEach(f => f())
  }

  // ── Lo que usa la pestaña Bot ──
  function cambiarConfig(cambios) {
    const c = { ...datos.config, instrumentos: { ...datos.config.instrumentos } }
    const numero = (k, min, max, texto) => {
      const n = Number(cambios[k])
      if (!(n >= min && n <= max)) throw new Error(texto)
      c[k] = n
    }
    if ('activo' in cambios) c.activo = !!cambios.activo
    if ('instrumentos' in cambios) {
      for (const [t, si] of Object.entries(cambios.instrumentos ?? {})) {
        if (!SESIONES_BOT[t]) throw new Error(`Instrumento desconocido: ${t}`)
        c.instrumentos[t] = !!si
      }
    }
    if ('modo' in cambios) {
      if (!['largo', 'ambos', 'flip'].includes(cambios.modo)) throw new Error('Modo no válido: largo, ambos o flip')
      c.modo = cambios.modo
    }
    if ('stopPct' in cambios) {
      if (![1, 0.5].includes(Number(cambios.stopPct))) throw new Error('Stop no válido: 1 o 0,5')
      c.stopPct = Number(cambios.stopPct)
    }
    if ('beR' in cambios) {
      const be = cambios.beR === null || cambios.beR === '' ? null : Number(cambios.beR)
      if (![null, 1, 2].includes(be)) throw new Error('Break even no válido: ninguno, 1 o 2')
      c.beR = be
    }
    if ('piramide' in cambios) {
      const p = cambios.piramide === null || cambios.piramide === '' ? null : Number(cambios.piramide)
      if (p !== null && !(p >= 0.25 && p <= 5)) throw new Error('Pirámide no válida: ninguna, o cada 0,25 a 5 R')
      c.piramide = p
    }
    if ('tamanoAnadido' in cambios) {
      if (![1, 0.5].includes(Number(cambios.tamanoAnadido))) throw new Error('Cada añadido es de 1 o de 0,5 unidades')
      c.tamanoAnadido = Number(cambios.tamanoAnadido)
    }
    if ('riesgoPct' in cambios) numero('riesgoPct', 0.1, 10, 'Riesgo por operación entre el 0,1% y el 10% de la cuenta')
    if ('deslizamientoMaxR' in cambios) numero('deslizamientoMaxR', 0.01, 2, 'Deslizamiento máximo entre 0,01 y 2 veces el bracket')
    if ('rangoMaxPct' in cambios) numero('rangoMaxPct', 0.01, 10, 'Rango máximo entre 0,01% y 10%')
    if (c.modo === 'flip' && c.stopPct !== 1) throw new Error('Flip the switch necesita el stop al otro lado del bracket, que es justo donde entra el sentido contrario')
    const antes = datos.config
    datos.config = c
    guardar()
    const lineas = Object.entries(DESCRIBIR).filter(([k]) => antes[k] !== c[k]).map(([k, describir]) => describir(c[k]))
    for (const t of Object.keys(SESIONES_BOT)) {
      if (!!antes.instrumentos[t] !== !!c.instrumentos[t]) lineas.push(`${SESIONES_BOT[t].nombre}: ${c.instrumentos[t] ? 'activado' : 'desactivado'}`)
    }
    if (lineas.length) avisarSinFallar(lineas.join('\n'))
    despertar()
    return c
  }

  // Apaga el bot y cierra todo lo que tenga abierto
  async function pararYCerrar() {
    datos.config.activo = false
    await encolar(async () => {
      for (const d of Object.values(datos.dias)) {
        if (posicionAbierta(d)) await cerrar(d, 'manual')
        else if (d.estado === 'esperando-vuelta') { apuntar(d, 'Bot parado a mano: no hay vuelta'); finalizar(d) }
        else if (['esperando-bracket', 'esperando-rotura'].includes(d.estado)) { d.estado = 'sin-operar'; apuntar(d, 'Bot parado a mano') }
      }
    })
    guardar()
    avisarSinFallar('Bot apagado con «Parar y cerrar todo»')
    return estado()
  }

  // Ensayo de órdenes en un instrumento: abre la posición mínima con stop, se lo mueve, la
  // cierra y busca el cierre en la actividad. Solo con el mercado abierto y sin nada del bot
  // entre manos en ese instrumento. Prueba los mismos contratos que usa el bot de las tortugas.
  async function ensayo(ticker = '^GDAXI') {
    if (!SESIONES_BOT[ticker]) throw new Error(`Instrumento desconocido: ${ticker}`)
    if (Object.values(datos.dias).some(d => d.ticker === ticker && enJuego(d))) {
      throw new Error('El bot tiene una posición abierta en ese instrumento: ahora no se ensaya')
    }
    const pasos = []
    let m = null
    for (const epic of EPICS_OPERAR[ticker] ?? [null]) {
      const x = await ig.operar.datosMercado(ticker, epic)
      pasos.push(`${x.epic}: ${x.estado}, ${x.bid} / ${x.oferta} ${x.moneda}; mínimo ${x.tamanoMin}, ${x.valorPunto} por punto${x.conPrecio ? '' : ' (sin precio para esta cuenta)'}`)
      if (x.conPrecio) { m = x; break }
    }
    if (!m) throw new Error(`Ningún contrato de ${ticker} tiene precio para esta cuenta`)
    if (m.estado !== 'TRADEABLE') throw new Error(`El mercado está ${m.estado}: el ensayo necesita el mercado abierto`)
    const distancia = Math.max(3 * (m.stopMin ?? 10), 30)
    const margen = Math.max(m.oferta - m.bid, 5)
    const tipo = m.aMercado ? 'a mercado' : 'con límite (este mercado no admite órdenes a mercado)'
    const r = await ig.operar.abrir({ ticker, epic: m.epic, lado: 'largo', tamano: m.tamanoMin ?? 1, stop: m.bid - distancia, moneda: m.moneda, limite: m.aMercado ? null : m.oferta + margen, referencia: `${E.prefijo}ENSAYO-${Date.now().toString(36)}` })
    pasos.push(`Abrir compra de ${r.tamano ?? m.tamanoMin} ${tipo} con stop en ${(m.bid - distancia).toFixed(1)}: ${r.aceptada ? `aceptada a ${r.nivel}` : 'rechazada'} (${r.motivo})`)
    if (!r.aceptada) return pasos
    try {
      const p = (await ig.operar.posiciones()).find(x => x.dealId === r.dealId)
      pasos.push(p ? `En las posiciones de la cuenta: ${p.lado} ${p.tamano} a ${p.nivel}, stop ${p.stop}, referencia ${p.referencia}` : 'NO aparece en las posiciones de la cuenta')
      const s = await ig.operar.moverStop({ ticker, dealId: r.dealId, stop: m.bid - distancia - 5 })
      pasos.push(`Mover el stop 5 puntos: ${s.aceptada ? 'aceptado' : 'rechazado'} (${s.motivo})`)
    } finally {
      const m2 = await ig.operar.datosMercado(ticker, m.epic)
      const c = await ig.operar.cerrar({ ticker, dealId: r.dealId, lado: 'largo', tamano: r.tamano ?? m.tamanoMin, limite: m2.aMercado ? null : m2.bid - margen })
      pasos.push(`Cerrar: ${c.aceptada ? `aceptada a ${c.nivel}` : 'rechazada'} (${c.motivo})`)
      let ci = null
      for (let i = 0; i < 5 && !ci; i++) {
        await new Promise(res => setTimeout(res, 2000))
        ci = await ig.operar.cierreDe({ ticker, dealId: r.dealId, lado: 'largo', desdeMs: Date.now() - 10 * 60_000 })
      }
      pasos.push(`El cierre en la actividad de la cuenta: ${ci ? `a ${ci.nivel}` : 'no encontrado'}`)
    }
    return pasos
  }

  function estado() {
    const t = ahora()
    const dias = Object.values(datos.dias).sort((a, b) => b.abre - a.abre)
    // "hoy": la sesión en curso o la última del día de cada instrumento, y lo que siga entre manos
    const actuales = new Set()
    for (const ticker of Object.keys(SESIONES_BOT)) {
      const ses = E.sesionDe(ticker, t)
      if (ses && datos.dias[clave(ses)]) actuales.add(clave(ses))
    }
    for (const d of dias) if (enJuego(d)) actuales.add(d.clave)
    // Para el gráfico de la pestaña: la sesión que aún no ha guardado sus velas lleva las de 15
    // min que van del directo, y todas, el último precio (sale de la memoria, no gasta cupo)
    const conDirecto = d => {
      const ultima = ultimasVelas('ig', d.ticker, 1).at(-1)
      const precio = ultima?.close ?? null
      if (d.velas) return { ...d, precio }
      const velas = agruparDirecto(directo(d.ticker), d.abre, Math.min(d.cierra, t + 1), E.minutosVela).map(v => [v.time, v.open, v.high, v.low, v.close])
      return { ...d, velas, velasEnDirecto: true, precio }
    }
    return {
      estrategia: { id: E.id, nombre: E.nombre, minutosVela: E.minutosVela, nBracket: E.nBracket },
      config: datos.config,
      maxUnidades: MAX_UNIDADES,
      sesiones: Object.entries(SESIONES_BOT).map(([ticker, s]) => {
        const ses = E.sesionDe(ticker, t)
        return {
          ticker, nombre: s.nombre, zona: s.zona, encendido: !!datos.config.instrumentos[ticker], proxima: E.proximaApertura(ticker, t),
          hoy: ses ? { abre: ses.abre, cierra: ses.cierra } : null,
        }
      }),
      hoy: dias.filter(d => actuales.has(d.clave)).map(conDirecto),
      historial: dias.filter(d => !actuales.has(d.clave)).slice(0, 150),
    }
  }

  return {
    arrancar, parar, estado, cambiarConfig, pararYCerrar, ensayo,
    // un paso del bucle sin el temporizador (para las pruebas): por la misma cola y guardando
    _paso: () => encolar(async () => { try { await paso() } finally { guardar() } }),
    _recuperar: () => encolar(async () => { try { await recuperarPosiciones() } finally { guardar() } }),
    _datos: () => datos,
  }
}
