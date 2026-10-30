// ── Bot de las tortugas en las acciones del S&P 500, en la cuenta paper de Alpaca ──────
// Las tortugas de la pestaña Estrategias → Acciones de EE. UU. (src/tortugas.js), operadas con
// el dinero de mentira de Alpaca (server/alpaca.js), porque la demo de IG no da precio a las
// acciones. El backtest dice que en acciones no tienen ventaja: el usuario lo sabe y lo quiso
// igualmente (30-oct-2026).
//   · Cada día, hora y media después del cierre de Nueva York (cuando Yahoo ya tiene la vela),
//     saca de cada acción, con su diario de Yahoo (el mismo del backtest, server/acciones-eeuu.js),
//     la N y los canales para la sesión siguiente (server/tortugas-niveles.js);
//   · juega los dos sistemas: el 1 entra al romper el máximo de 20 sesiones (con el filtro, si la
//     anterior habría ganado, espera a la de 55) y sale en el mínimo de 10; el 2 entra en la de
//     55 y sale en la de 20. En Alpaca cada acción es una sola posición neta, así que una acción
//     la lleva un solo sistema: el primero que entra; el otro no entra mientras siga abierta
//     (la regla del usuario del 30-oct-2026 para el bot de IG, «el S2 no entra donde está el S1»,
//     hecha simétrica);
//   · una unidad son las acciones enteras con las que 1 N cuesta riesgoPct / picoPiramide del
//     capital: así, la pirámide llena pierde como mucho riesgoPct si salta su stop. El capital
//     es el equity de la cuenta con un 20 % menos por cada 10 % de caída desde su máximo, y se
//     vuelve al tamaño normal al recuperarse (regla permanente del usuario);
//   · añade una unidad cada ½ N a favor desde el último relleno, hasta maxUnidades, y el stop de
//     todas va a 2 N del último relleno. El stop es una orden stop GTC en Alpaca, así que la
//     posición sigue protegida con el servidor caído. Las entradas, los añadidos y la salida por
//     el canal los decide el bot con el último precio (cada medio minuto, en la sesión de 9:30 a 16:00
//     de Nueva York) y van a mercado;
//   · límites de cartera como el backtest: unidades por sector y sentido, por sentido, y el
//     nominal de todas las posiciones como mucho APALANCAMIENTO veces el equity.
//
// Alpaca no deja mandar una compra si hay una venta pendiente en el mismo símbolo (ni al
// revés): para añadir, primero se cancela el stop y después se pone otro por todo. Y en cada
// vuelta se comprueba que cada posición tiene su stop, por si algo falló a medias.
// Las órdenes llevan la referencia TA1-… o TA2-… (el sistema). Opera solo donde BOT_OPERA=1 y
// nace apagado.

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { fechaEnZona, instanteEnZona } from './zonas.js'
import { nivelesTortugas } from './tortugas-niveles.js'
import { capitalNominal, picoPiramide, PASO_N, STOP_N } from './bot-tortugas.js'

const ZONA = 'America/New_York'
export const CONFIG_TORTUGAS_ACCIONES = {
  activo:      false,
  sistemas:    [1, 2],
  filtroS1:    true,      // el Sistema 1 se salta la ruptura de 20 si la anterior habría ganado y espera a la de 55
  lados:       'largos',  // largos | ambos | cortos (en el backtest, los cortos empeoran)
  riesgoPct:   0.5,       // lo más que pierde una pirámide llena si salta su stop, en % del capital (el del backtest de acciones)
  anadido:     1,         // tamaño de cada añadido, en unidades: 1 o 0,5
  maxUnidades: 6,         // por acción, con la entrada
  maxGrupo:    15,        // por sector y sentido
  maxSentido:  50,        // por sentido
  reduccionDD: true,      // un 20 % menos del equity por cada 10 % de caída desde el máximo
  sectoresFuera: [],      // los sectores que no opera
}
export const APALANCAMIENTO = 2   // nominal de todas las posiciones / equity, como mucho (el margen de una noche en EE. UU.)
const REVISAR_CADA_MS = 30_000
const REINTENTO_PLAN_S = 600      // si el plan falla, otra vez pasado este rato
const PLAN_TRAS_CIERRE_MIN = 90   // el plan de mañana, a las 17:30 de Nueva York: Yahoo ya tiene la vela del día
const APERTURA_MIN = 3            // en los primeros minutos tras la apertura entra aunque el precio haya saltado lejos del nivel (un hueco)
const ESPERA_ERROR_S = 600        // un error al entrar en una acción no se repite hasta pasado este rato
const ESPERA_RELLENO_S = 30
const AÑOS_DIARIO = 2             // velas de Yahoo para los niveles (con el filtro del S1, más no cambia nada)
const MAX_EVENTOS = 1000, MAX_OPERACIONES = 1000, MAX_SIN_ENTRAR = 2000
const PREFIJO = 'TA'

const dir = lado => (lado === 'largo' ? 1 : -1)
const centimos = x => Math.round(x * 100) / 100
const num = (x, dec = 2) => (x == null ? '—' : Number(x).toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec }))
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const esperar = ms => new Promise(r => setTimeout(r, ms))

// Los niveles de un sistema para la sesión: dónde entra en cada lado y dónde sale cada lado
export function nivelesSistema(niv, sistema, filtroS1) {
  if (sistema === 1) {
    const k = filtroS1 && niv.gano ? 55 : 20
    return { k, entrada: { largo: niv.alto[k], corto: niv.bajo[k] }, salida: { largo: niv.bajo[10], corto: niv.alto[10] } }
  }
  return { k: 55, entrada: { largo: niv.alto[55], corto: niv.bajo[55] }, salida: { largo: niv.bajo[20], corto: niv.alto[20] } }
}

// Las acciones de una unidad: las que hacen que 1 N cueste `riesgoN` $. Si no sale ni una, una
// sola si cuesta como mucho el doble; si no, 0 (no cabe)
export function accionesUnidad(riesgoN, n) {
  if (!(riesgoN > 0 && n > 0)) return 0
  const k = Math.floor(riesgoN / n)
  return k >= 1 ? k : n <= 2 * riesgoN ? 1 : 0
}

// ¿Entra ahora? El precio tiene que estar al otro lado del nivel, y como mucho ½ N más allá:
// más lejos es que la ruptura pasó sin que el bot la viera (y no la persigue), salvo en los
// primeros minutos de la sesión, cuando un hueco de la noche entra a la apertura como en el backtest
export function rompe(precio, nivel, lado, n, enApertura) {
  if (!(precio > 0) || !Number.isFinite(nivel)) return false
  const pasado = dir(lado) * (precio - nivel)
  return pasado >= 0 && (enApertura || pasado <= PASO_N * n)
}

// Lo que pesa una posición en unidades (la entrada, 1; cada añadido, `anadido`)
export const unidadesDe = pos => 1 + (pos.unidades.length - 1) * (pos.anadido ?? 1)

export function crearBotTortugasAcciones({ alpaca, velasDiarias, universo, archivo, ahora = () => Math.floor(Date.now() / 1000), log = console.log, avisar = () => {}, revisarCadaMs = REVISAR_CADA_MS, esperarMs = esperar }) {
  const sectorDe = Object.fromEntries(universo.map(a => [a.ticker, a.sector]))
  const vacio = () => ({ config: { ...CONFIG_TORTUGAS_ACCIONES }, picoEquity: null, plan: null, posiciones: {}, intentos: {}, operaciones: [], eventos: [], sinEntrar: [] })
  let datos = vacio()
  try {
    const leido = JSON.parse(readFileSync(archivo, 'utf8'))
    datos = { ...datos, ...leido, config: { ...CONFIG_TORTUGAS_ACCIONES, ...leido.config } }
  } catch { /* primera vez */ }

  let guardado = JSON.stringify(datos)
  const guardar = () => {
    const texto = JSON.stringify(datos)
    if (texto === guardado) return
    try {
      writeFileSync(`${archivo}.tmp`, texto)
      renameSync(`${archivo}.tmp`, archivo)
      guardado = texto
    } catch (err) { log(`[tortugas acciones] no se ha podido guardar: ${err.message}`) }
  }
  const hora = () => new Date(ahora() * 1000).toISOString()
  function avisarSinFallar(texto) {
    try { Promise.resolve(avisar(texto)).catch(() => {}) } catch { /* el aviso es lo de menos */ }
  }
  function apuntar(simbolo, texto, { aviso = true, sistema = null } = {}) {
    const ultimo = datos.eventos.findLast(e => e.simbolo === simbolo)
    if (ultimo?.texto === texto) return
    datos.eventos.push({ hora: hora(), simbolo, ...(sistema ? { sistema } : {}), texto })
    if (datos.eventos.length > MAX_EVENTOS) datos.eventos.splice(0, datos.eventos.length - MAX_EVENTOS)
    log(`[tortugas acciones] ${simbolo ?? ''}${sistema ? ` S${sistema}` : ''} ${texto}`)
    if (aviso) avisarSinFallar(`Tortugas acciones${sistema ? ` S${sistema}` : ''} · ${simbolo ? `${simbolo} · ` : ''}${texto}`)
  }
  // por qué no entró en una ruptura: lo último de cada sesión, acción, sistema y lado
  function noEntro(simbolo, sistema, lado, motivo) {
    const fecha = datos.plan?.fecha
    const mismo = x => x.fecha === fecha && x.simbolo === simbolo && x.sistema === sistema && x.lado === lado
    if (datos.sinEntrar.find(mismo)?.motivo === motivo) return
    const lista = datos.sinEntrar.filter(x => !mismo(x))
    lista.push({ fecha, simbolo, sistema, lado, motivo, hora: hora() })
    datos.sinEntrar = lista.slice(-MAX_SIN_ENTRAR)
  }

  // ── El plan de cada sesión ──
  // La sesión que toca: la de hoy si está abierta (o aún no ha abierto hoy), si no la siguiente
  async function sesionQueToca(reloj) {
    const t = ahora()
    const fecha = fechaEnZona(reloj.abierto ? t : Math.floor(Date.parse(reloj.proximaApertura) / 1000), ZONA)
    const dias = await alpaca.dias(fechaEnZona(t - 15 * 86400, ZONA), fecha)
    const anterior = dias.filter(d => d < fecha).at(-1)
    return { fecha, anterior }
  }

  let planEnCurso = false, planFallo = 0
  async function hacerPlan({ fecha, anterior }) {
    planEnCurso = true
    try {
      const tickers = universo.map(a => a.ticker)
      const desde = fechaEnZona(ahora() - AÑOS_DIARIO * 365 * 86400, ZONA)
      const { velas, fallos } = await velasDiarias(tickers, desde)
      const niveles = {}, sinNiveles = { ...fallos }
      for (const t of tickers) {
        const vs = (velas[t] ?? []).filter(v => v.date < fecha)
        const niv = vs.length ? nivelesTortugas(vs, { stopN: STOP_N }) : null
        if (!niv) { sinNiveles[t] ??= 'pocas velas'; continue }
        if (niv.ultimoDia !== anterior) { sinNiveles[t] = `Yahoo no tiene la vela del ${anterior} (la última, del ${niv.ultimoDia})`; continue }
        niveles[t] = { n: niv.n, cierre: niv.cierre, alto: niv.alto, bajo: niv.bajo, gano: niv.gano }
      }
      datos.plan = { fecha, anterior, hecho: hora(), niveles, sinNiveles }
      const faltan = Object.keys(sinNiveles).length
      apuntar(null, `Plan del ${fecha}: ${Object.keys(niveles).length} acciones con niveles${faltan ? `, ${faltan} sin ellos` : ''}`, { aviso: false })
    } finally { planEnCurso = false }
  }

  // ── Órdenes ──
  const referencia = (sistema, simbolo) => `${PREFIJO}${sistema}-${simbolo}-`
  async function esperarRelleno(id) {
    let o
    for (let i = 0; i < ESPERA_RELLENO_S; i++) {
      o = await alpaca.orden(id)
      if (['filled', 'canceled', 'expired', 'rejected'].includes(o.estado)) break
      await esperarMs(1000)
    }
    if (!['filled', 'canceled', 'expired', 'rejected'].includes(o.estado)) {
      // lo que no se ha llenado en medio minuto se cancela; vale lo que haya entrado
      try { await alpaca.cancelarOrden(o.id) } catch { /* puede que se acabe de llenar */ }
      o = await alpaca.orden(id)
    }
    return o
  }
  async function aMercado(pos, lado, cantidad) {
    const o = await alpaca.enviarOrden({ simbolo: pos.simbolo, lado: lado === 'largo' ? 'compra' : 'venta', cantidad }, { prefijo: referencia(pos.sistema, pos.simbolo), ahora: () => Date.now() })
    const hecho = await esperarRelleno(o.id)
    if (!(hecho.rellena > 0)) throw new Error(`la orden a mercado ha quedado ${hecho.estado}`)
    return hecho
  }
  async function quitarStop(pos) {
    if (!pos.stopId) return
    try { await alpaca.cancelarOrden(pos.stopId) } catch { /* ya no estaba */ }
    for (let i = 0; i < 10; i++) {
      const o = await alpaca.orden(pos.stopId).catch(() => null)
      if (!o || !['new', 'accepted', 'pending_new', 'held', 'pending_cancel'].includes(o.estado)) break
      await esperarMs(500)
    }
    pos.stopId = null
  }
  async function ponerStop(pos, cantidad) {
    const o = await alpaca.enviarOrden({ simbolo: pos.simbolo, lado: pos.lado === 'largo' ? 'venta' : 'compra', tipo: 'stop', stop: pos.stop, cantidad, validez: 'gtc' },
      { prefijo: `${referencia(pos.sistema, pos.simbolo)}stop-`, ahora: () => Date.now() })
    pos.stopId = o.id
  }

  const unidadAhora = { riesgoN: null, capital: null }
  // las acciones que Alpaca deja operar (y vender en corto), una vez al día
  let operablesDe = { fecha: null, lista: {} }
  async function operablesHoy() {
    const fecha = fechaEnZona(ahora(), ZONA)
    if (operablesDe.fecha !== fecha) operablesDe = { fecha, lista: await alpaca.operables() }
    return operablesDe.lista
  }
  async function entrar(simbolo, sistema, lado, niv, acciones) {
    const pos = { simbolo, sistema, lado, sector: sectorDe[simbolo], n0: niv.n, unidad: acciones, anadido: datos.config.anadido, unidades: [], stop: null, stopId: null, abierta: hora(), k: nivelesSistema(niv, sistema, datos.config.filtroS1).k }
    const o = await aMercado(pos, lado, acciones)
    pos.unidades.push({ acciones: o.rellena, entrada: o.precioMedio, hora: o.rellenaEn ?? hora() })
    pos.stop = centimos(o.precioMedio - dir(lado) * STOP_N * pos.n0)
    datos.posiciones[simbolo] = pos
    try { await ponerStop(pos, o.rellena) } catch (err) { apuntar(simbolo, `Ojo: no he podido poner el stop en ${num(pos.stop)} (${err.message}); lo reintento en la siguiente vuelta`, { sistema }) }
    apuntar(simbolo, `${lado === 'largo' ? 'Compro' : 'Vendo en corto'} ${o.rellena} acciones a ${num(o.precioMedio)} (ruptura de ${pos.k}; N ${num(pos.n0)}). Stop en ${num(pos.stop)}`, { sistema })
  }
  async function anadir(pos) {
    const cantidad = Math.max(1, Math.round(pos.unidad * pos.anadido))
    await quitarStop(pos)
    let o
    try { o = await aMercado(pos, pos.lado, cantidad) }
    finally { if (!o) await ponerStop(pos, totalDe(pos)).catch(() => {}) }   // si no entra, vuelve el stop de antes
    pos.unidades.push({ acciones: o.rellena, entrada: o.precioMedio, hora: o.rellenaEn ?? hora() })
    pos.stop = centimos(o.precioMedio - dir(pos.lado) * STOP_N * pos.n0)
    try { await ponerStop(pos, totalDe(pos)) } catch (err) { apuntar(pos.simbolo, `Ojo: no he podido mover el stop a ${num(pos.stop)} (${err.message}); lo reintento en la siguiente vuelta`, { sistema: pos.sistema }) }
    apuntar(pos.simbolo, `Añado ${o.rellena} acciones a ${num(o.precioMedio)} (unidad ${pos.unidades.length}). Stop de todas en ${num(pos.stop)}`, { sistema: pos.sistema })
  }
  const totalDe = pos => pos.unidades.reduce((s, u) => s + u.acciones, 0)
  const entradaMedia = pos => pos.unidades.reduce((s, u) => s + u.acciones * u.entrada, 0) / totalDe(pos)

  function cerrarEnRegistro(pos, precio, motivo) {
    const acciones = totalDe(pos)
    const resultado = precio == null ? null : (precio - entradaMedia(pos)) * dir(pos.lado) * acciones
    datos.operaciones.unshift({
      simbolo: pos.simbolo, sistema: pos.sistema, lado: pos.lado, sector: pos.sector, abierta: pos.abierta, cerrada: hora(),
      unidades: pos.unidades.length, acciones, entrada: entradaMedia(pos), salida: precio, n: pos.n0, motivo,
      resultado, resultadoN: resultado == null ? null : resultado / (pos.n0 * pos.unidad),
    })
    datos.operaciones.splice(MAX_OPERACIONES)
    delete datos.posiciones[pos.simbolo]
    const texto = { stop: 'Salta el stop', canal: `Sale por el canal de ${pos.sistema === 1 ? 10 : 20}`, manual: 'Cierro a mano', fuera: 'La posición ya no está en Alpaca (cerrada fuera del bot)' }[motivo] ?? motivo
    apuntar(pos.simbolo, `${texto}: ${acciones} acciones${precio != null ? ` a ${num(precio)}` : ''}${resultado != null ? `, ${resultado >= 0 ? '+' : ''}${num(resultado)} $` : ''}`, { sistema: pos.sistema })
  }
  async function salir(pos, motivo) {
    const o = await alpaca.cerrarPosicion(pos.simbolo)
    const hecho = await esperarRelleno(o.id)
    pos.stopId = null
    cerrarEnRegistro(pos, hecho.precioMedio, motivo)
  }

  // ── Cada vuelta ──
  // Lo que Alpaca dice que hay frente a lo que cree el bot: las cerradas por su stop (o a mano)
  // salen del registro, y cada posición que sigue tiene su stop por todas las acciones
  async function conciliar(posiciones, abiertas) {
    const enAlpaca = Object.fromEntries(posiciones.map(p => [p.simbolo, p]))
    for (const pos of Object.values(datos.posiciones)) {
      const p = enAlpaca[pos.simbolo]
      if (!p || p.lado !== pos.lado) {
        const stop = pos.stopId ? await alpaca.orden(pos.stopId).catch(() => null) : null
        cerrarEnRegistro(pos, stop?.estado === 'filled' ? stop.precioMedio : null, stop?.estado === 'filled' ? 'stop' : 'fuera')
        continue
      }
      // si Alpaca tiene menos (el stop se ha llenado en parte), se quitan del registro desde la última unidad
      let sobra = totalDe(pos) - p.cantidad
      while (sobra > 0 && pos.unidades.length) {
        const u = pos.unidades.at(-1), quita = Math.min(sobra, u.acciones)
        u.acciones -= quita; sobra -= quita
        if (!u.acciones) pos.unidades.pop()
      }
      const stop = abiertas.find(o => o.id === pos.stopId)
      if (!stop || stop.cantidad !== p.cantidad || stop.stop !== pos.stop) {
        try {
          // cualquier otra orden pendiente del símbolo estorbaría (Alpaca: «wash trade»)
          for (const o of abiertas.filter(o => o.simbolo === pos.simbolo)) await alpaca.cancelarOrden(o.id).catch(() => {})
          pos.stopId = null
          await ponerStop(pos, p.cantidad)
          if (stop) apuntar(pos.simbolo, `Stop puesto de nuevo en ${num(pos.stop)} por ${p.cantidad} acciones`, { aviso: false, sistema: pos.sistema })
        } catch (err) { apuntar(pos.simbolo, `No he podido poner el stop en ${num(pos.stop)}: ${err.message}`, { sistema: pos.sistema }) }
      }
    }
  }

  async function paso() {
    const cfg = datos.config
    const t = ahora()
    const reloj = await alpaca.reloj()
    const [cuenta, posiciones, abiertas] = await Promise.all([alpaca.cuenta(), alpaca.posiciones(), alpaca.ordenesAbiertas()])
    if (!cuenta.paper) throw new Error('El bot de las tortugas en acciones solo opera en la cuenta paper')
    datos.picoEquity = Math.max(datos.picoEquity ?? cuenta.equity, cuenta.equity)
    await conciliar(posiciones, abiertas)

    // el plan: el de la sesión que toca, hecho después del cierre anterior + hora y media
    const ses = await sesionQueToca(reloj)
    // aparte de la vuelta (bajar de Yahoo las 503 la primera vez tarda casi un minuto), que sigue vigilando los stops
    if (datos.plan?.fecha !== ses.fecha && !planEnCurso && t - planFallo >= REINTENTO_PLAN_S) {
      const listo = instanteEnZona(ses.anterior, 16 * 60 + PLAN_TRAS_CIERRE_MIN, ZONA)
      if (t >= listo || reloj.abierto) {
        hacerPlan(ses)
          .catch(err => { planFallo = ahora(); apuntar(null, `No he podido hacer el plan del ${ses.fecha}: ${err.message}`) })
          .finally(guardar)
      }
    }
    if (!cfg.activo || !reloj.abierto || datos.plan?.fecha !== fechaEnZona(t, ZONA)) return

    const capital = capitalNominal(cuenta.equity, datos.picoEquity, cfg.reduccionDD)
    const riesgoN = capital * cfg.riesgoPct / 100 / picoPiramide(cfg.maxUnidades, cfg.anadido)
    Object.assign(unidadAhora, { riesgoN, capital })
    const enApertura = t < instanteEnZona(fechaEnZona(t, ZONA), 9 * 60 + 30 + APERTURA_MIN, ZONA)
    const niveles = datos.plan.niveles
    const fuera = new Set(cfg.sectoresFuera)
    const precios = await alpaca.precios([...new Set([...Object.keys(niveles), ...Object.keys(datos.posiciones)])])
    const precio = s => precios[s]?.precio

    // lo abierto: salidas por el canal y añadidos
    for (const pos of Object.values(datos.posiciones)) {
      const niv = niveles[pos.simbolo], p = precio(pos.simbolo)
      if (!niv || !p) continue
      const sal = nivelesSistema(niv, pos.sistema, cfg.filtroS1).salida[pos.lado]
      try {
        if (dir(pos.lado) * (p - sal) <= 0) { await salir(pos, 'canal'); continue }
        const siguiente = pos.unidades.at(-1).entrada + dir(pos.lado) * PASO_N * pos.n0
        if (pos.unidades.length < cfg.maxUnidades && dir(pos.lado) * (p - siguiente) >= 0) {
          const motivo = limite(pos.simbolo, pos.lado, pos.anadido, p * Math.round(pos.unidad * pos.anadido), cuenta)
          if (motivo) noEntro(pos.simbolo, pos.sistema, pos.lado, `añadido: ${motivo}`)
          else await anadir(pos)
        }
      } catch (err) { apuntar(pos.simbolo, `Error: ${err.message}`, { sistema: pos.sistema }) }
      guardar()
    }

    // las entradas nuevas: primero las más cerca de su nivel (en N), y con el S1 antes que el S2
    const lados = cfg.lados === 'ambos' ? ['largo', 'corto'] : [cfg.lados === 'cortos' ? 'corto' : 'largo']
    const señales = []
    for (const [s, niv] of Object.entries(niveles)) {
      if (datos.posiciones[s] || fuera.has(sectorDe[s])) continue
      const p = precio(s)
      if (!p) continue
      for (const sistema of cfg.sistemas) {
        const nv = nivelesSistema(niv, sistema, cfg.filtroS1)
        for (const lado of lados) {
          if (!rompe(p, nv.entrada[lado], lado, niv.n, enApertura)) {
            if (dir(lado) * (p - nv.entrada[lado]) > PASO_N * niv.n && !datos.sinEntrar.some(x => x.fecha === datos.plan.fecha && x.simbolo === s && x.sistema === sistema && x.lado === lado)) {
              noEntro(s, sistema, lado, `la ruptura pasó sin verla: el precio ya estaba a ${num(dir(lado) * (p - nv.entrada[lado]) / niv.n)} N del nivel`)
            }
            continue
          }
          señales.push({ s, sistema, lado, niv, p, fuerza: dir(lado) * (p - nv.entrada[lado]) / niv.n })
        }
      }
    }
    señales.sort((a, b) => a.fuerza - b.fuerza || a.sistema - b.sistema)
    const operables = señales.length ? await operablesHoy() : {}
    for (const { s, sistema, lado, niv, p } of señales) {
      if (datos.posiciones[s]) continue   // la ha cogido el otro sistema
      const intento = datos.intentos[s]
      if (intento && t - intento < ESPERA_ERROR_S) continue
      if (!operables[s]) { noEntro(s, sistema, lado, 'Alpaca no la deja operar'); continue }
      if (lado === 'corto' && !operables[s].cortos) { noEntro(s, sistema, lado, 'Alpaca no la deja vender en corto'); continue }
      const acciones = accionesUnidad(riesgoN, niv.n)
      if (!acciones) { noEntro(s, sistema, lado, `no cabe: 1 acción arriesga ${num(niv.n)} $ por N y la unidad, ${num(riesgoN)} $`); continue }
      const motivo = limite(s, lado, 1, p * acciones, cuenta)
      if (motivo) { noEntro(s, sistema, lado, motivo); continue }
      try { await entrar(s, sistema, lado, niv, acciones); delete datos.intentos[s] }
      catch (err) { datos.intentos[s] = t; apuntar(s, `Error al entrar: ${err.message}`, { sistema }) }
      guardar()
    }
  }

  // El motivo por el que una orden más pasaría de los límites de cartera (null si cabe)
  function limite(simbolo, lado, unidades, nominal, cuenta) {
    const cfg = datos.config
    const abiertas = Object.values(datos.posiciones)
    const enLado = abiertas.filter(p => p.lado === lado)
    const sector = sectorDe[simbolo]
    const delSector = enLado.filter(p => p.sector === sector && p.simbolo !== simbolo)
    if (enLado.reduce((s, p) => s + unidadesDe(p), 0) + unidades > cfg.maxSentido) return `límite de ${cfg.maxSentido} unidades ${lado === 'largo' ? 'compradas' : 'vendidas'}`
    const propias = datos.posiciones[simbolo] ? unidadesDe(datos.posiciones[simbolo]) : 0
    if (delSector.reduce((s, p) => s + unidadesDe(p), 0) + propias + unidades > cfg.maxGrupo) return `límite de ${cfg.maxGrupo} unidades en ${sector}`
    const total = abiertas.reduce((s, p) => s + totalDe(p) * p.unidades.at(-1).entrada, 0)
    if (total + nominal > APALANCAMIENTO * cuenta.equity) return `el nominal pasaría de ${APALANCAMIENTO} veces el equity`
    if (nominal > cuenta.poderCompra) return 'no queda poder de compra'
    return null
  }

  // ── Arranque y parada ──
  let reloj = null, arrancadoEn = null, ultimaVuelta = null, cola = Promise.resolve()
  const encolar = f => (cola = cola.then(f, f))
  function despertar() {
    encolar(async () => {
      try { await paso(); ultimaVuelta = Date.now() }
      catch (err) { apuntar(null, `Error en la vuelta: ${err.message}`) }
      finally { guardar() }
    })
  }
  function arrancar() {
    arrancadoEn = Date.now()
    reloj = setInterval(despertar, revisarCadaMs)
    despertar()
    const abiertas = Object.keys(datos.posiciones).length
    if (datos.config.activo || abiertas) avisarSinFallar(`Tortugas acciones: servidor arrancado, el bot está ${datos.config.activo ? 'encendido' : 'apagado'}${abiertas ? ` con ${abiertas} posiciones` : ''}`)
  }
  function parar() { clearInterval(reloj); reloj = null }

  // ── Lo que usa la pestaña ──
  function cambiarConfig(cambios) {
    const c = { ...datos.config }
    const entero = (k, min, max, texto) => {
      const n = Number(cambios[k])
      if (!(Number.isInteger(n) && n >= min && n <= max)) throw new Error(texto)
      c[k] = n
    }
    if ('activo' in cambios) c.activo = !!cambios.activo
    if ('sistemas' in cambios) {
      const s = [...new Set((Array.isArray(cambios.sistemas) ? cambios.sistemas : [cambios.sistemas]).map(Number))].sort()
      if (!s.length || !s.every(x => x === 1 || x === 2)) throw new Error('Sistemas: el 1, el 2 o los dos')
      c.sistemas = s
    }
    if ('lados' in cambios) {
      if (!['largos', 'ambos', 'cortos'].includes(cambios.lados)) throw new Error('Lados: largos, ambos o cortos')
      c.lados = cambios.lados
    }
    if ('riesgoPct' in cambios) {
      const n = Number(cambios.riesgoPct)
      if (!(n >= 0.05 && n <= 5)) throw new Error('Riesgo por pirámide entre el 0,05% y el 5%')
      c.riesgoPct = n
    }
    if ('anadido' in cambios) {
      const a = Number(cambios.anadido)
      if (a !== 1 && a !== 0.5) throw new Error('Cada añadido: de una unidad o de media')
      c.anadido = a
    }
    if ('maxUnidades' in cambios) entero('maxUnidades', 1, 10, 'Unidades por acción: de 1 a 10')
    if ('maxGrupo' in cambios) entero('maxGrupo', 1, 300, 'Unidades por sector: de 1 a 300')
    if ('maxSentido' in cambios) entero('maxSentido', 1, 1000, 'Unidades por sentido: de 1 a 1000')
    if ('filtroS1' in cambios) c.filtroS1 = !!cambios.filtroS1
    if ('reduccionDD' in cambios) c.reduccionDD = !!cambios.reduccionDD
    if ('sectoresFuera' in cambios) {
      const sectores = new Set(universo.map(a => a.sector))
      const fuera = [...new Set(cambios.sectoresFuera ?? [])]
      if (!fuera.every(s => sectores.has(s))) throw new Error('Sector desconocido')
      c.sectoresFuera = fuera
    }
    const antes = datos.config
    datos.config = c
    guardar()
    const cambiadas = Object.keys(c).filter(k => !igual(antes[k], c[k]))
    if (cambiadas.length) avisarSinFallar(`Tortugas acciones · ${cambiadas.map(k => `${k}: ${JSON.stringify(antes[k])} → ${JSON.stringify(c[k])}`).join('\n')}`)
    if (c.activo && !antes.activo) despertar()
    return c
  }

  async function pararYCerrar() {
    datos.config.activo = false
    await encolar(async () => {
      for (const pos of Object.values(datos.posiciones)) {
        try { await salir(pos, 'manual') } catch (err) { apuntar(pos.simbolo, `Error al cerrar: ${err.message}`, { sistema: pos.sistema }) }
      }
    })
    guardar()
    avisarSinFallar('Tortugas acciones: bot apagado con «Parar y cerrar todo»')
    return estado()
  }

  // Lo que la pestaña enseña: las posiciones, las acciones más cerca de romper (en N) y lo demás
  function estado({ precios = {} } = {}) {
    const cfg = datos.config
    const niveles = datos.plan?.niveles ?? {}
    const cerca = []
    for (const [s, niv] of Object.entries(niveles)) {
      if (datos.posiciones[s]) continue
      const ref = precios[s]?.precio ?? niv.cierre
      for (const sistema of cfg.sistemas) {
        const nv = nivelesSistema(niv, sistema, cfg.filtroS1)
        for (const lado of cfg.lados === 'ambos' ? ['largo', 'corto'] : [cfg.lados === 'cortos' ? 'corto' : 'largo']) {
          // con el filtro, el S1 puede esperar a la misma ruptura de 55 que el S2: una sola fila
          const igual = cerca.find(c => c.simbolo === s && c.lado === lado && c.nivel === nv.entrada[lado])
          if (igual) { igual.sistemas.push({ sistema, k: nv.k }); continue }
          cerca.push({ simbolo: s, sector: sectorDe[s], sistemas: [{ sistema, k: nv.k }], lado, nivel: nv.entrada[lado], n: niv.n, precio: ref, faltaN: dir(lado) * (nv.entrada[lado] - ref) / niv.n })
        }
      }
    }
    cerca.sort((a, b) => a.faltaN - b.faltaN)
    return {
      config: cfg,
      reglas: { pasoN: PASO_N, stopN: STOP_N, apalancamiento: APALANCAMIENTO, picoN: picoPiramide(cfg.maxUnidades, cfg.anadido) },
      sectores: [...new Set(universo.map(a => a.sector))].sort(),
      picoEquity: datos.picoEquity,
      unidad: unidadAhora,
      plan: datos.plan && { fecha: datos.plan.fecha, anterior: datos.plan.anterior, hecho: datos.plan.hecho, conNiveles: Object.keys(niveles).length, sinNiveles: datos.plan.sinNiveles },
      posiciones: Object.values(datos.posiciones).map(p => {
        const niv = niveles[p.simbolo]
        return { ...p, acciones: totalDe(p), entradaMedia: entradaMedia(p), precio: precios[p.simbolo]?.precio ?? null,
          salida: niv ? nivelesSistema(niv, p.sistema, cfg.filtroS1).salida[p.lado] : null,
          siguiente: p.unidades.at(-1).entrada + dir(p.lado) * PASO_N * p.n0 }
      }),
      cerca: cerca.slice(0, 40),
      operaciones: datos.operaciones.slice(0, 300),
      eventos: datos.eventos.slice(-300).reverse(),
      sinEntrar: datos.sinEntrar.slice(-300).reverse(),
      enMarcha: reloj !== null,
    }
  }

  return {
    arrancar, parar, estado, cambiarConfig, pararYCerrar,
    simbolosVistos: () => [...new Set([...Object.keys(datos.posiciones), ...estado().cerca.map(c => c.simbolo)])],
    latido: () => ({ enMarcha: reloj !== null, desde: arrancadoEn, ultimaVuelta }),
    _paso: () => encolar(async () => { try { await paso() } finally { guardar() } }),
    _datos: () => datos,
  }
}
