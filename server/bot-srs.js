// ── Bot SRS en la demo de IG ───────────────────────────────────────────────────────
// Opera la estrategia SRS de la pestaña Estrategias en varias sesiones del día, cada una a
// la hora de su bolsa: Tokio (Nikkei), Fráncfort (DAX), Londres (FTSE) y Nueva York (Nasdaq,
// S&P, Dow, Russell). En cada una: bracket = máximo y mínimo de la segunda vela de 15 min;
// se compra al romper el máximo (y en modo "ambos" se vende al romper el mínimo, mandando el
// que se rompa antes); stop al otro lado del bracket (o a mitad, con stopPct 0,5);
// opcionalmente a break even al recorrer beR veces el riesgo; y cierre con la sesión.
//
// Cómo opera:
//   · la entrada la decide el bot con el precio en directo: orden a mercado con el stop
//     dentro, que guarda IG (donde IG no admite órdenes a mercado, como el DAX de fin de
//     semana, límite que se ejecuta al momento o se anula, con tope de deslizamiento);
//     no deja órdenes pendientes en IG, así que no entran dos lados a la vez ni entra nada
//     con el bot parado;
//   · el tamaño sale del riesgo: se arriesgan `riesgoEur` euros hasta el stop, con el
//     contrato más pequeño que la cuenta pueda operar y sin pasar de una parte del margen;
//   · cada orden lleva una referencia propia (SRS-…): si el registro se pierde (un despliegue
//     sin volumen), al arrancar recupera sus posiciones abiertas desde IG y las sigue;
//   · si arranca con la sesión empezada y la rotura ya pasó, no entra tarde.
// Solo opera en la demo (candado en server/ig.js) y solo donde BOT_OPERA=1 (server/index.js).
//
// El registro (configuración y un apunte por sesión) va a un JSON. Al cierre guarda las velas
// de 15 min de la sesión: con ellas la pestaña Bot calcula lo que habría hecho el backtest
// con el mismo motor que la pestaña Estrategias (el servidor se despliega sin src).

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { offsetMadrid } from './velas-grafico.js'
import { fechaEnZona, diaSemanaEnZona, instanteEnZona } from './zonas.js'
import { ultimasVelas, escuchar } from './tiempo-real.js'
import { EPICS_OPERAR } from './ig.js'

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
  modo:              'ambos', // 'largo': solo compra; 'ambos': compra o vende, la rotura que llegue antes
  stopPct:           1,       // 1: stop al otro lado del bracket; 0,5: a mitad de vela
  beR:               null,    // null, 1 o 2: stop a la entrada al recorrer esas veces el riesgo
  riesgoEur:         400,     // lo que se arriesga por operación hasta el stop, en euros (un 2% de la demo de 20.000 €;
                              // con menos, el mínimo de IG en el Dow o el Nikkei ya arriesga más del doble y no entrarían)
  deslizamientoMaxR: 0.25,    // solo donde IG no admite órdenes a mercado: peor precio aceptable, en fracción del bracket
  rangoMaxPct:       0.8,     // si el bracket mide más (en % del precio), ese día no se opera
}

const MINUTOS_VELA = 15
const REVISAR_CADA_MS = 30_000   // cada cuánto se mira en IG si una posición sigue abierta
const BUSQUEDAS_CIERRE = 4       // revisiones buscando el precio de cierre antes de dar por bueno el del stop
const MARGEN_MAX = 0.4           // parte del disponible que puede ocupar el margen de una posición (el mínimo del Nikkei es ~36%)
const PREFIJO = 'SRS-'           // referencia de las órdenes del bot

export const minutoMadrid = ts => Math.floor(((ts + offsetMadrid(ts)) % 86400 + 86400) % 86400 / 60)
const horaMadrid = ts => new Date((ts + offsetMadrid(ts)) * 1000).toISOString().slice(11, 16)

// La sesión de un instrumento en curso en `t` (o la de ese día, si ya cerró), en su bolsa.
// null en fin de semana.
export function sesionDe(ticker, t) {
  const s = SESIONES_BOT[ticker]
  if (!s) return null
  const dow = diaSemanaEnZona(t, s.zona)
  if (dow === 0 || dow === 6) return null
  const fecha = fechaEnZona(t, s.zona)
  const abre = instanteEnZona(fecha, s.apertura, s.zona)
  return {
    ticker, fecha, abre,
    cierra:      instanteEnZona(fecha, s.cierre, s.zona),
    velaBracket: abre + MINUTOS_VELA * 60,
    finBracket:  abre + 2 * MINUTOS_VELA * 60,
  }
}

// La próxima apertura de un instrumento a partir de `t` (para enseñarla en la pestaña)
export function proximaApertura(ticker, t) {
  for (let d = 0; d < 8; d++) {
    const ses = sesionDe(ticker, t + d * 86400)
    if (ses && ses.abre > t) return ses.abre
  }
  return null
}

// ── La decisión (pura) ──
// Con el apunte de la sesión, la configuración, la hora, las últimas velas de 1 min en
// directo y la sesión, dice qué toca hacer ahora. No llama a nada.
export function siguientePaso({ dia, cfg, ahora, velas, ses }) {
  const abierta = dia?.operacion && !dia.salida
  // una orden mandada cuya confirmación no llegó: antes de nada, ver en IG si entró
  if (dia?.estado === 'entrando') return { accion: 'reconciliar' }
  // con la sesión cerrada: cerrar lo que siga abierto y guardar las velas del día
  if (ahora >= ses.cierra) {
    if (abierta) return { accion: 'cerrar', motivo: 'cierre' }
    return dia?.bracket && !dia.velas ? { accion: 'velas' } : { accion: 'nada' }
  }
  if (abierta) {
    const op = dia.operacion
    if (cfg.beR != null && !op.be) {
      const despues = velas.filter(v => v.time + 60 > op.hora)
      const favor = op.lado === 'largo'
        ? Math.max(...despues.map(v => v.high)) - op.entrada
        : op.entrada - Math.min(...despues.map(v => v.low))
      if (despues.length && favor >= cfg.beR * op.riesgo) return { accion: 'breakeven' }
    }
    return { accion: 'vigilar' }
  }
  if (!dia || dia.estado === 'terminado' || dia.estado === 'sin-operar') return { accion: 'nada' }
  if (!cfg.activo) return { accion: 'nada' }
  if (ahora < ses.finBracket) return { accion: 'nada' }
  if (!dia.bracket) return { accion: 'bracket' }

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

// Contratos para arriesgar `riesgoEur` hasta el stop, de décima en décima. Si eso queda por
// debajo del mínimo de IG, se usa el mínimo mientras no arriesgue más del doble; si no, no.
export function tamanoPorRiesgo({ riesgoEur, riesgoPts, valorPunto, cambioAEur, tamanoMin }) {
  if (!(riesgoPts > 0) || !(valorPunto > 0) || !(cambioAEur > 0)) return { ok: false, motivo: 'faltan datos del mercado' }
  const eurPorContrato = riesgoPts * valorPunto * cambioAEur
  const min = tamanoMin ?? 0.1
  let tamano = Math.floor((riesgoEur / eurPorContrato) * 10 + 1e-9) / 10
  if (tamano < min) {
    if (min * eurPorContrato > 2 * riesgoEur) {
      return { ok: false, motivo: `el mínimo de IG (${min}) arriesgaría ${Math.round(min * eurPorContrato)} €` }
    }
    tamano = min
  }
  return { ok: true, tamano, riesgoEur: tamano * eurPorContrato }
}

// ── El bot ──
export function crearBot({ ig, archivo, ahora = () => Math.floor(Date.now() / 1000), log = console.log, revisarCadaMs = REVISAR_CADA_MS }) {
  let datos = { config: { ...CONFIG_INICIAL }, dias: {} }
  try {
    const leido = JSON.parse(readFileSync(archivo, 'utf8'))
    const config = { ...CONFIG_INICIAL }
    for (const k of Object.keys(CONFIG_INICIAL)) if (k in (leido.config ?? {})) config[k] = leido.config[k]
    config.instrumentos = { ...CONFIG_INICIAL.instrumentos, ...config.instrumentos }
    datos = { config, dias: leido.dias ?? {} }
  } catch { /* primera vez */ }

  // Solo se escribe si algo cambió: el bucle pasa cada 5 s
  let guardado = JSON.stringify(datos, null, 2)
  const guardar = () => {
    const texto = JSON.stringify(datos, null, 2)
    if (texto === guardado) return
    try {
      writeFileSync(`${archivo}.tmp`, texto)
      renameSync(`${archivo}.tmp`, archivo)
      guardado = texto
    } catch (err) { log(`[bot] no se ha podido guardar: ${err.message}`) }
  }

  const clave = ses => `${ses.fecha} ${ses.ticker}`
  function apunteDe(ses, crear) {
    const k = clave(ses)
    if (!datos.dias[k] && crear) {
      datos.dias[k] = {
        clave: k, fecha: ses.fecha, ticker: ses.ticker, abre: ses.abre, cierra: ses.cierra,
        // la ventana en minutos de Madrid, para que la pestaña pase las velas por el backtest
        ventana: { open: minutoMadrid(ses.abre), close: minutoMadrid(ses.cierra), minutosVela: MINUTOS_VELA, nBracket: 2 },
        config: { ...datos.config }, estado: 'esperando-bracket', bracket: null, plan: null,
        operacion: null, salida: null, eventos: [],
      }
    }
    return datos.dias[k] ?? null
  }
  function apuntar(dia, texto) {
    dia.eventos.push({ hora: new Date(ahora() * 1000).toISOString(), texto })
    log(`[bot] ${dia.clave} ${texto}`)
  }

  // ── Las acciones ──

  // El bracket y el plan del día: qué contrato, cuántos y si cabe en el margen
  async function calcularBracket(dia, ses) {
    const cfg = dia.config
    const velas = await ig.velasEntre(dia.ticker, 'm15', ses.velaBracket, ses.finBracket)
    const v = velas.find(x => x.time === ses.velaBracket)
    if (!v) { dia.estado = 'sin-operar'; apuntar(dia, 'IG no da la vela del bracket (¿festivo?): hoy no se opera'); return }
    const rango = v.high - v.low
    dia.bracket = { high: v.high, low: v.low, rango, vela: ses.velaBracket }
    const pct = rango / v.close * 100
    apuntar(dia, `Bracket ${v.low.toFixed(1)} – ${v.high.toFixed(1)} (${rango.toFixed(1)} puntos, ${pct.toFixed(2)}%)`)
    if (!(rango > 0) || pct > cfg.rangoMaxPct) {
      dia.estado = 'sin-operar'
      apuntar(dia, `Rango fuera del límite (${cfg.rangoMaxPct}% del precio): hoy no se opera`)
      return
    }

    // si el bot arranca tarde, la rotura pudo pasar con él parado: no se entra tarde
    if (ahora() > ses.finBracket + 120) {
      const despues = await ig.velasEntre(dia.ticker, 'm15', ses.finBracket, ahora())
      const rota = despues.find(x => x.high > v.high || (cfg.modo !== 'largo' && x.low < v.low))
      if (rota) {
        dia.estado = 'sin-operar'
        apuntar(dia, `La rotura fue a las ${horaMadrid(rota.time)} con el bot parado: hoy no se entra`)
        return
      }
    }

    // el contrato: el primero de la lista con precio para la cuenta y que quepa en el riesgo
    const riesgoPts = rango * cfg.stopPct
    const descartes = []
    let plan = null
    for (const epic of EPICS_OPERAR[dia.ticker] ?? [null]) {
      const m = await ig.operar.datosMercado(dia.ticker, epic)
      if (!m.conPrecio) { descartes.push(`${m.epic} sin precio para esta cuenta`); continue }
      const t = tamanoPorRiesgo({ riesgoEur: cfg.riesgoEur, riesgoPts, valorPunto: m.valorPunto, cambioAEur: m.cambioAEur, tamanoMin: m.tamanoMin })
      if (!t.ok) { descartes.push(`${m.epic}: ${t.motivo}`); continue }
      plan = { epic: m.epic, moneda: m.moneda, tamano: t.tamano, riesgoEur: t.riesgoEur, valorPunto: m.valorPunto, cambioAEur: m.cambioAEur, tamanoMin: m.tamanoMin }
      break
    }
    if (!plan) {
      dia.estado = 'sin-operar'
      apuntar(dia, `Ningún contrato vale: ${descartes.join('; ')}`)
      return
    }
    // que el margen de la posición no se coma la cuenta: como mucho una parte del disponible
    // (IG pide un 5% del nominal en estos índices)
    const disponible = await ig.operar.disponible()
    if (disponible != null) {
      const margenUno = v.close * plan.valorPunto * plan.cambioAEur * 0.05
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
    apuntar(dia, `Plan: ${plan.tamano} contratos de ${plan.epic} (${plan.valorPunto} ${plan.moneda} por punto), ${Math.round(plan.riesgoEur)} € hasta el stop`)
  }

  async function entrar(dia, lado) {
    const cfg = dia.config
    const { plan } = dia
    const stop = nivelStop(dia.bracket, lado, cfg.stopPct)
    const m = await ig.operar.datosMercado(dia.ticker, plan.epic)
    const margen = cfg.deslizamientoMaxR * dia.bracket.rango
    const limite = m.aMercado ? null : (lado === 'largo' ? m.oferta + margen : m.bid - margen)
    const referencia = `${PREFIJO}${dia.ticker.replace(/\W/g, '')}-${dia.fecha.replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6)}`
    apuntar(dia, `Rotura ${lado === 'largo' ? 'por arriba: compra' : 'por abajo: venta'} de ${plan.tamano} con stop en ${stop.toFixed(1)}`)
    // Se apunta ANTES de mandarla: si la confirmación no llega (un corte justo ahí), el bot
    // no la repite, sino que mira en IG si entró. Repetirla podría dejar dos posiciones.
    dia.estado = 'entrando'
    dia.intento = { lado, tamano: plan.tamano, stop, hora: ahora(), referencia }
    guardar()
    const r = await ig.operar.abrir({ ticker: dia.ticker, epic: plan.epic, lado, tamano: plan.tamano, stop, moneda: plan.moneda, limite, referencia })
    if (!r.aceptada) {
      dia.estado = 'sin-operar'
      apuntar(dia, `IG rechaza la orden: ${r.motivo}`)
      return
    }
    adoptar(dia, { lado, dealId: r.dealId, tamano: r.tamano ?? plan.tamano, nivel: r.nivel, stop: r.stop ?? stop })
  }

  function adoptar(dia, { lado, dealId, tamano, nivel, stop, hora = null }) {
    const nivelOrden = dia.bracket ? (lado === 'largo' ? dia.bracket.high : dia.bracket.low) : nivel
    dia.operacion = {
      lado, dealId, tamano, nivelOrden, entrada: nivel, stop,
      riesgo: dia.bracket ? dia.bracket.rango * dia.config.stopPct : Math.abs(nivel - stop),
      hora: hora ?? dia.intento?.hora ?? ahora(), be: false,
      // lo que se pagó de más (o de menos) respecto al nivel de la rotura, que es donde entra el backtest
      deslizamiento: lado === 'largo' ? nivel - nivelOrden : nivelOrden - nivel,
    }
    dia.estado = 'en-posicion'
    apuntar(dia, `Dentro a ${nivel} (${dia.operacion.deslizamiento >= 0 ? '+' : ''}${dia.operacion.deslizamiento.toFixed(1)} puntos sobre el nivel)`)
  }

  // Tras una orden sin confirmar: si IG tiene la posición con su referencia (o una de ese
  // mercado abierta desde el intento), es la nuestra; si no, no entró y hoy ya no se entra
  async function reconciliar(dia) {
    const { intento } = dia
    const abiertas = await ig.operar.posiciones()
    const nuestra = abiertas.find(p => p.referencia && p.referencia === intento.referencia)
      ?? abiertas.find(p => p.ticker === dia.ticker && Date.parse(`${p.abierta}Z`) / 1000 >= intento.hora - 60)
    if (nuestra) {
      apuntar(dia, 'La confirmación no llegó, pero la posición está abierta en IG: se sigue con ella')
      adoptar(dia, { lado: nuestra.lado, dealId: nuestra.dealId, tamano: nuestra.tamano, nivel: nuestra.nivel, stop: nuestra.stop ?? intento.stop })
    } else {
      dia.estado = 'sin-operar'
      apuntar(dia, 'La orden no llegó a entrar en IG; hoy ya no se entra')
    }
  }

  async function breakeven(dia) {
    const op = dia.operacion
    const r = await ig.operar.moverStop({ ticker: dia.ticker, dealId: op.dealId, stop: op.entrada })
    op.be = true
    if (!r.aceptada) { apuntar(dia, `IG no deja mover el stop a break even: ${r.motivo}`); return }
    op.stop = op.entrada
    apuntar(dia, `Stop a break even (${op.entrada})`)
  }

  function cerrarDia(dia, salida) {
    const op = dia.operacion
    dia.salida = salida
    dia.resultadoPts = (op.lado === 'largo' ? 1 : -1) * (salida.nivel - op.entrada)
    const plan = dia.plan
    if (plan?.valorPunto && plan?.cambioAEur) dia.resultadoEur = dia.resultadoPts * op.tamano * plan.valorPunto * plan.cambioAEur
    dia.estado = 'terminado'
    apuntar(dia, `Fuera a ${salida.nivel} (${salida.motivo}): ${dia.resultadoPts >= 0 ? '+' : ''}${dia.resultadoPts.toFixed(1)} puntos`)
  }

  // Al cierre hay que salir sí o sí: a mercado, reintentando si IG la rechaza. Donde no
  // admite órdenes a mercado va con límite, y si el precio se escapa del margen, se
  // reintenta con el precio nuevo y el doble de margen
  async function cerrar(dia, motivo) {
    const op = dia.operacion
    const epic = dia.plan?.epic ?? null
    let r
    let margen = Math.max((dia.config.deslizamientoMaxR ?? 0.25) * (dia.bracket?.rango ?? op.riesgo), 1)
    for (let intento = 0; intento < 3; intento++, margen *= 2) {
      const m = await ig.operar.datosMercado(dia.ticker, epic)
      const limite = m.aMercado ? null : (op.lado === 'largo' ? m.bid - margen : m.oferta + margen)
      r = await ig.operar.cerrar({ ticker: dia.ticker, dealId: op.dealId, lado: op.lado, tamano: op.tamano, limite })
      if (r.aceptada) break
      apuntar(dia, limite == null ? `IG no cierra a mercado (${r.motivo})` : `IG no cierra con ${margen.toFixed(1)} puntos de margen (${r.motivo})`)
    }
    if (!r.aceptada) {
      // puede que ya la hubiera cerrado el stop: la revisión lo aclara
      apuntar(dia, 'Se revisa si ya estaba cerrada')
      await revisar(dia, true)
      return
    }
    cerrarDia(dia, { nivel: r.nivel, hora: ahora(), motivo })
  }

  // ¿Sigue abierta en IG? Si no, la cerró el stop (o alguien a mano): se busca a qué precio.
  // IG tarda unos segundos en apuntar el cierre en la actividad: si aún no está, se mira en
  // las siguientes revisiones, y solo tras unas cuantas se da por bueno el nivel del stop.
  const ultimaRevision = new Map()
  async function revisar(dia, forzar = false) {
    if (!forzar && Date.now() - (ultimaRevision.get(dia.clave) ?? 0) < revisarCadaMs) return
    ultimaRevision.set(dia.clave, Date.now())
    const op = dia.operacion
    const abiertas = await ig.operar.posiciones()
    if (abiertas.some(p => p.dealId === op.dealId)) return
    const cierre = await ig.operar.cierreDe({ ticker: dia.ticker, dealId: op.dealId, lado: op.lado, desdeMs: op.hora * 1000 })
    if (!cierre && (op.busquedasCierre = (op.busquedasCierre ?? 0) + 1) < BUSQUEDAS_CIERRE) {
      if (op.busquedasCierre === 1) apuntar(dia, 'La posición ya no está en IG: buscando a qué precio se cerró')
      return
    }
    cerrarDia(dia, { nivel: cierre?.nivel ?? op.stop, hora: ahora(), motivo: op.be ? 'breakeven' : 'stop', ...(cierre ? {} : { aproximado: true }) })
  }

  // Las velas de 15 min de la sesión, para comparar con el backtest en la pestaña
  async function guardarVelas(dia, ses) {
    const velas = await ig.velasEntre(dia.ticker, 'm15', ses.abre, ses.cierra)
    dia.velas = velas.map(v => [v.time, v.open, v.high, v.low, v.close])
    apuntar(dia, `Guardadas ${velas.length} velas de 15 min de la sesión`)
  }

  // Al arrancar: las posiciones del bot (por su referencia) que el registro no tiene, se
  // recuperan; las de una sesión ya cerrada se cierran en el siguiente paso
  async function recuperarPosiciones() {
    const abiertas = (await ig.operar.posiciones()).filter(p => p.referencia?.startsWith(PREFIJO) && p.ticker)
    for (const p of abiertas) {
      if (Object.values(datos.dias).some(d => d.operacion?.dealId === p.dealId && !d.salida)) continue
      const abierta = Date.parse(`${p.abierta}Z`) / 1000
      const ses = sesionDe(p.ticker, abierta)
      if (!ses) continue
      const dia = apunteDe(ses, true)
      apuntar(dia, `Recuperada de IG una posición del bot que no estaba en el registro (${p.referencia})`)
      adoptar(dia, { lado: p.lado, dealId: p.dealId, tamano: p.tamano, nivel: p.nivel, stop: p.stop, hora: abierta })
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
      try { await paso() } catch (err) { log(`[bot] error: ${err.message}`) }
      guardar()
    })
  }

  // Los instrumentos a mirar: los encendidos y cualquiera con una posición abierta
  function tickersAMirar() {
    const encendidos = Object.entries(datos.config.instrumentos).filter(([, si]) => si).map(([t]) => t)
    const abiertos = Object.values(datos.dias).filter(d => d.operacion && !d.salida).map(d => d.ticker)
    return [...new Set([...encendidos, ...abiertos])].filter(t => SESIONES_BOT[t])
  }

  // Un instrumento no tumba a los demás: su error queda en su apunte y se sigue con el siguiente
  async function paso() {
    const cfg = datos.config
    const t = ahora()
    let primerError = null
    for (const ticker of tickersAMirar()) {
      try {
        const ses = sesionDe(ticker, t)
        // una posición abierta de una sesión que ya terminó (el bot estaba parado al cierre)
        const viejas = Object.values(datos.dias).filter(d => d.ticker === ticker && d.operacion && !d.salida && d.cierra <= t && (!ses || d.clave !== clave(ses)))
        for (const d of viejas) await pasoDe(d, { ticker, fecha: d.fecha, abre: d.abre, cierra: d.cierra, finBracket: d.abre + 1800 }, cfg, t)
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
      if (p.accion === 'breakeven')   await breakeven(dia)
      if (p.accion === 'cerrar')      await cerrar(dia, p.motivo)
      if (p.accion === 'vigilar')     await revisar(dia)
      if (p.accion === 'reconciliar') await reconciliar(dia)
      if (p.accion === 'velas')       await guardarVelas(dia, ses)
    } catch (err) {
      apuntar(dia, `Error: ${err.message}`)
      throw err
    }
  }

  let reloj = null
  const dejarDeEscuchar = []
  function arrancar() {
    encolar(async () => {
      try { await recuperarPosiciones() } catch (err) { log(`[bot] no se han podido revisar las posiciones al arrancar: ${err.message}`) }
      guardar()
    })
    reloj = setInterval(despertar, 5_000)
    for (const ticker of Object.keys(SESIONES_BOT)) dejarDeEscuchar.push(escuchar('ig', ticker, despertar))
    despertar()
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
      if (!['largo', 'ambos'].includes(cambios.modo)) throw new Error('Modo no válido: largo o ambos')
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
    if ('riesgoEur' in cambios) numero('riesgoEur', 1, 5000, 'Riesgo por operación entre 1 y 5.000 €')
    if ('deslizamientoMaxR' in cambios) numero('deslizamientoMaxR', 0.01, 2, 'Deslizamiento máximo entre 0,01 y 2 veces el bracket')
    if ('rangoMaxPct' in cambios) numero('rangoMaxPct', 0.01, 10, 'Rango máximo entre 0,01% y 10%')
    datos.config = c
    guardar()
    despertar()
    return c
  }

  // Apaga el bot y cierra todo lo que tenga abierto
  async function pararYCerrar() {
    datos.config.activo = false
    await encolar(async () => {
      for (const d of Object.values(datos.dias)) {
        if (d.operacion && !d.salida) await cerrar(d, 'manual')
        else if (['esperando-bracket', 'esperando-rotura'].includes(d.estado)) { d.estado = 'sin-operar'; apuntar(d, 'Bot parado a mano') }
      }
    })
    guardar()
    return estado()
  }

  // Ensayo de órdenes en un instrumento: abre la posición mínima con stop, se lo mueve, la
  // cierra y busca el cierre en la actividad. Solo con el mercado abierto y sin posición del
  // bot abierta en ese instrumento.
  async function ensayo(ticker = '^GDAXI') {
    if (!SESIONES_BOT[ticker]) throw new Error(`Instrumento desconocido: ${ticker}`)
    if (Object.values(datos.dias).some(d => d.ticker === ticker && d.operacion && !d.salida)) {
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
    const r = await ig.operar.abrir({ ticker, epic: m.epic, lado: 'largo', tamano: m.tamanoMin ?? 1, stop: m.bid - distancia, moneda: m.moneda, limite: m.aMercado ? null : m.oferta + margen, referencia: `${PREFIJO}ENSAYO-${Date.now().toString(36)}` })
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
    // "hoy": la sesión en curso o la última del día de cada instrumento, y lo que siga abierto
    const actuales = new Set()
    for (const ticker of Object.keys(SESIONES_BOT)) {
      const ses = sesionDe(ticker, t)
      if (ses && datos.dias[clave(ses)]) actuales.add(clave(ses))
    }
    for (const d of dias) if (d.operacion && !d.salida) actuales.add(d.clave)
    return {
      config: datos.config,
      sesiones: Object.entries(SESIONES_BOT).map(([ticker, s]) => ({
        ticker, nombre: s.nombre, zona: s.zona, encendido: !!datos.config.instrumentos[ticker], proxima: proximaApertura(ticker, t),
      })),
      hoy: dias.filter(d => actuales.has(d.clave)),
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
