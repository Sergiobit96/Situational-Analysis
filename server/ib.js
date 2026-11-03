// ── Interactive Brokers, por la API de TWS / IB Gateway (paquete @stoqey/ib) ──────────────
// IB no tiene una API REST con claves como Alpaca: hay que tener abierto en este PC el IB Gateway
// (o la TWS) con la sesión iniciada y la API activada, y el servidor se conecta a su puerto por
// TCP. Puertos por defecto: Gateway 4002 paper / 4001 real; TWS 7497 paper / 7496 real.
//
// En Railway el Gateway va en su propio servicio (docs/ib-gateway-railway.md).
//
// Solo se conecta si IB_PORT está puesto y la primera vez
// que alguien lo pide. Una vez conectado se queda escuchando la cuenta, las posiciones y las
// órdenes, y si se cae reintenta solo. Las órdenes solo salen a una cuenta paper (empiezan por
// DU) salvo con IB_REAL=1, que no está puesto en ningún sitio.

import IB from '@stoqey/ib'
import { duracion } from './vigilancia.js'
const { IBApi, EventName } = IB

const TIPOS = { market: 'MKT', limit: 'LMT', stop: 'STP', stop_limit: 'STP LMT' }
const TIPOS_INV = Object.fromEntries(Object.entries(TIPOS).map(([k, v]) => [v, k]))
const VALIDEZ = { day: 'DAY', gtc: 'GTC', ioc: 'IOC' }
const INSTRUMENTOS = new Set(['STK', 'ETF', 'FUT', 'CASH', 'IND', 'CFD'])
const SIMBOLO = /^[A-Z0-9][A-Z0-9. ]{0,14}$/
const MONEDA = /^[A-Z]{3}$/

// avisos de IB que no son errores (granjas de datos conectadas, etc.)
const INFORMATIVOS = new Set([2104, 2106, 2107, 2108, 2119, 2158, 2100, 2150, 1102, 399, 10167])
const ESTADOS = {
  PendingSubmit: 'enviando', PendingCancel: 'cancelando', PreSubmitted: 'pendiente', Submitted: 'pendiente',
  ApiPending: 'enviando', ApiCancelled: 'cancelada', Cancelled: 'cancelada', Filled: 'ejecutada', Inactive: 'inactiva',
}
export const ABIERTA = new Set(['enviando', 'pendiente', 'cancelando'])
const ACABADA = new Set(['Filled', 'Cancelled', 'ApiCancelled', 'Inactive'])

const n = x => (x == null || x === '' ? null : Number(x))
const positivo = x => Number.isFinite(x) && x > 0
// IB manda 1.7976931348623157e308 (Double.MAX) cuando un precio no está puesto
const precio = x => (Number.isFinite(x) && Math.abs(x) < 1e300 ? x : null)
export const esPaper = cuenta => /^DU/.test(cuenta ?? '')

// Lo que manda la pestaña ({ simbolo, instrumento, bolsa, moneda, vencimiento, lado, tipo,
// cantidad, limite, stop, validez, stopLoss, fueraDeHorario }) en [{ contrato, orden }]: la
// entrada y, si hay stop de protección, su stop como hija (bracket). Lanza un Error si algo no cuadra.
export function ordenParaIB(o, { referencia = `SA-${Date.now()}` } = {}) {
  const simbolo = String(o?.simbolo ?? '').trim().toUpperCase()
  if (!SIMBOLO.test(simbolo)) throw new Error(`Símbolo no válido: «${o?.simbolo ?? ''}»`)
  const instrumento = String(o.instrumento ?? 'STK').toUpperCase()
  if (!INSTRUMENTOS.has(instrumento)) throw new Error(`Tipo de instrumento no válido: ${instrumento}`)
  const moneda = String(o.moneda ?? 'USD').toUpperCase()
  if (!MONEDA.test(moneda)) throw new Error(`Moneda no válida: ${moneda}`)
  const bolsa = String(o.bolsa ?? (instrumento === 'CASH' ? 'IDEALPRO' : 'SMART')).toUpperCase()
  const contrato = { symbol: simbolo, secType: instrumento === 'ETF' ? 'STK' : instrumento, exchange: bolsa, currency: moneda }
  if (instrumento === 'FUT') {
    if (!/^\d{6}(\d{2})?$/.test(o.vencimiento ?? '')) throw new Error('Un futuro necesita el vencimiento (AAAAMM)')
    contrato.lastTradeDateOrContractMonth = o.vencimiento
  }

  const accion = o.lado === 'venta' ? 'SELL' : o.lado === 'compra' ? 'BUY' : null
  if (!accion) throw new Error('El lado tiene que ser compra o venta')
  const tipo = o.tipo ?? 'market'
  if (!TIPOS[tipo]) throw new Error(`Tipo de orden no válido: ${tipo}`)
  const validez = o.validez ?? 'day'
  if (!VALIDEZ[validez]) throw new Error(`Validez no válida: ${validez}`)
  const cantidad = n(o.cantidad)
  if (!positivo(cantidad)) throw new Error('La cantidad tiene que ser mayor que 0')
  if (instrumento !== 'CASH' && !Number.isInteger(cantidad)) throw new Error('Por la API de IB la cantidad tiene que ser entera')

  const entrada = { action: accion, orderType: TIPOS[tipo], totalQuantity: cantidad, tif: VALIDEZ[validez], orderRef: referencia, transmit: true }
  if (o.fueraDeHorario) entrada.outsideRth = true
  const limite = n(o.limite), stop = n(o.stop)
  if (tipo === 'limit' || tipo === 'stop_limit') {
    if (!positivo(limite)) throw new Error('Falta el precio límite')
    entrada.lmtPrice = limite
  }
  if (tipo === 'stop' || tipo === 'stop_limit') {
    if (!positivo(stop)) throw new Error('Falta el precio del stop')
    entrada.auxPrice = stop
  }
  const patas = [{ contrato, orden: entrada }]

  const stopLoss = n(o.stopLoss)
  if (stopLoss != null) {
    if (!positivo(stopLoss)) throw new Error('El stop de protección tiene que ser mayor que 0')
    const ref = tipo === 'market' ? null : limite ?? stop
    if (ref != null && (accion === 'BUY' ? stopLoss >= ref : stopLoss <= ref)) throw new Error(`El stop de protección tiene que quedar ${accion === 'BUY' ? 'por debajo' : 'por encima'} de la entrada`)
    // la madre no se transmite hasta que llega la hija: así IB nunca tiene la entrada sin su stop
    entrada.transmit = false
    patas.push({ contrato, orden: { action: accion === 'BUY' ? 'SELL' : 'BUY', orderType: 'STP', auxPrice: stopLoss, totalQuantity: cantidad, tif: 'GTC', orderRef: `${referencia}-stop`, transmit: true, ...(o.fueraDeHorario ? { outsideRth: true } : {}) } })
  }
  return patas
}

const nombreContrato = c => [c.localSymbol || c.symbol, c.secType !== 'STK' ? c.secType : null, c.lastTradeDateOrContractMonth || null].filter(Boolean).join(' ')

// avisarCaida(texto): Telegram, una vez cuando lleva caidaMs sin poder conectar y otra al volver.
// Hace falta porque el Gateway de Railway puede quedarse muerto con el puerto abierto (su reinicio
// de cada noche, si la sesión se perdió de día, deja el Gateway parado y solo responde el socat)
export function crearIB({ host = '127.0.0.1', port, clientId = 17, real = false, Api = IBApi, log = console, avisarCaida = () => {}, caidaMs = 15 * 60_000, ahora = Date.now } = {}) {
  if (!port) return null
  const e = {
    api: null, conectado: false, conectando: null, siguienteId: null, cuenta: null, cuentas: [],
    valores: {}, cartera: new Map(), ordenes: new Map(), avisos: [], ultimoError: null, desde: null,
    reintento: null, esperaReintento: 5_000, listaCuenta: false, cerrado: false, caidoDesde: null, caidaAvisada: false,
    // lo que piden los bots: peticiones con respuesta (contratos, histórico, ejecuciones), precios
    // en directo y ejecuciones. Sus ids, muy por encima de los de las órdenes: IB avisa de los
    // errores de las dos cosas con el mismo número
    sigPeticion: 100_000_000, peticiones: new Map(), cotizaciones: new Map(), ejecuciones: new Map(), abiertas: null, reglas: new Map(),
  }
  const avisar = (texto, codigo = null, id = null) => {
    e.avisos.unshift({ hora: new Date().toISOString(), codigo, id, texto })
    e.avisos.length = Math.min(e.avisos.length, 30)
  }

  function montar() {
    const api = new Api({ host, port: Number(port), clientId: Number(clientId) })
    api.on(EventName.connected, () => { e.conectado = true; e.desde = new Date().toISOString(); e.esperaReintento = 5_000; e.ultimoError = null })
    api.on(EventName.disconnected, () => {
      const estaba = e.conectado
      e.conectado = false; e.siguienteId = null; e.listaCuenta = false
      if (estaba) avisar('Desconectado del IB Gateway')
      programarReintento()
    })
    api.on(EventName.nextValidId, id => { e.siguienteId = id })
    api.on(EventName.managedAccounts, lista => {
      e.cuentas = String(lista).split(',').map(s => s.trim()).filter(Boolean)
      e.cuenta = process.env.IB_CUENTA && e.cuentas.includes(process.env.IB_CUENTA) ? process.env.IB_CUENTA : e.cuentas[0] ?? null
      if (e.cuenta) api.reqAccountUpdates(true, e.cuenta)
      api.reqAllOpenOrders()
      // sin suscripción a un mercado, IB da sus precios con 15 min de retraso en vez de nada
      api.reqMarketDataType(3)
      for (const [id, q] of e.cotizaciones) api.reqMktData(id, q.contrato, '', false, false)
      api.reqExecutions(e.sigPeticion++, {})
    })
    api.on(EventName.updateAccountValue, (clave, valor, moneda, cuenta) => {
      if (cuenta !== e.cuenta) return
      e.valores[`${clave}:${moneda}`] = valor
    })
    api.on(EventName.updatePortfolio, (c, pos, mercado, valor, coste, latente, realizado, cuenta) => {
      if (cuenta && cuenta !== e.cuenta) return
      if (!pos) return void e.cartera.delete(c.conId)
      e.cartera.set(c.conId, { c, pos, mercado, valor, coste, latente, realizado })
    })
    api.on(EventName.accountDownloadEnd, () => { e.listaCuenta = true })
    api.on(EventName.openOrder, (id, c, o, st) => {
      const antes = e.ordenes.get(id) ?? {}
      e.ordenes.set(id, { ...antes, id, c, o, estadoIB: st?.status ?? antes.estadoIB, permId: o.permId, actualizada: Date.now() })
      e.abiertas?.lista.push({ id, c, o, estadoIB: st?.status ?? null })
    })
    api.on(EventName.openOrderEnd, () => { e.abiertas?.fin() })
    api.on(EventName.orderStatus, (id, estado, rellena, quedan, medio, permId, padre) => {
      const antes = e.ordenes.get(id)
      if (!antes) return
      e.ordenes.set(id, { ...antes, estadoIB: estado, rellena, quedan, medio, padre, permId: permId || antes.permId, actualizada: Date.now() })
    })
    api.on(EventName.contractDetails, (id, d) => { e.peticiones.get(id)?.filas.push(d) })
    api.on(EventName.contractDetailsEnd, id => { const p = e.peticiones.get(id); p?.ok(p.filas) })
    api.on(EventName.historicalData, (id, hora, open, high, low, close) => {
      const p = e.peticiones.get(id)
      if (!p) return
      if (String(hora).startsWith('finished')) return p.ok(p.filas)
      if ([open, high, low, close].every(x => Number.isFinite(x) && x > 0)) p.filas.push({ hora: String(hora), open, high, low, close })
    })
    api.on(EventName.execDetails, (_id, c, x) => {
      e.ejecuciones.set(x.execId, { permId: x.permId, orderId: x.orderId, orderRef: x.orderRef ?? null, precio: x.price, cantidad: x.shares, lado: x.side, hora: x.time, conId: c.conId, simbolo: c.localSymbol || c.symbol })
    })
    api.on(EventName.execDetailsEnd, id => { e.peticiones.get(id)?.ok(null) })
    // los escalones de precio de una regla de mercado: [{ lowEdge, increment }]
    api.on(EventName.marketRule, (id, escalones) => { e.reglas.get(id)?.ok(escalones) })
    // los precios en directo (o con retraso: 66 a 68 son los mismos con 15 min de retraso)
    const CAMPOS = { 1: 'bid', 2: 'ask', 4: 'last', 66: 'bid', 67: 'ask', 68: 'last' }
    api.on(EventName.tickPrice, (id, campo, valor) => {
      const q = e.cotizaciones.get(id)
      const k = CAMPOS[campo]
      if (!q || !k || !(valor > 0)) return
      q[k] = valor
      q.retrasado = campo >= 66
      q.hora = Date.now()
      q.error = null
      try { q.alPrecio?.(q) } catch (err) { log.warn?.(`IB: ${err.message}`) }
    })
    api.on(EventName.error, (err, codigo, id) => {
      if (INFORMATIVOS.has(codigo)) return
      const texto = String(err?.message ?? err).replace(/<br>\s*/gi, ' ').replace(/\s+/g, ' ').trim()
      // el error de una petición de un bot es suyo: la falla, y no es de ninguna orden
      if (e.peticiones.has(id)) return e.peticiones.get(id).mal(new Error(texto))
      if (e.cotizaciones.has(id)) { e.cotizaciones.get(id).error = texto; return }
      if (codigo === 502 || codigo === 504 || /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH/.test(texto)) e.ultimoError = `No hay IB Gateway escuchando en ${host}:${port} (${texto})`
      else e.ultimoError = texto
      const orden = id > 0 ? e.ordenes.get(id) : null
      // 202 = cancelada; 10147/10148 = no se pudo cancelar (ya lo estaba): no son el motivo de la orden
      if (orden && ![202, 10147, 10148].includes(codigo)) e.ordenes.set(id, { ...orden, motivo: texto })
      // el mismo fallo de conexión una y otra vez: solo se actualiza la hora del último
      if (codigo === 502 && e.avisos[0]?.codigo === 502 && e.avisos[0].texto === texto) e.avisos[0].hora = new Date().toISOString()
      else avisar(texto, codigo ?? null, id > 0 ? id : null)
    })
    return api
  }

  const enRailway = host.endsWith('.railway.internal')
  function revisarCaida(conectado) {
    if (conectado) {
      if (e.caidaAvisada) avisarCaida(`✅ Vuelvo a estar conectado con Interactive Brokers (cuenta ${e.cuenta ?? '?'}), tras ${duracion(ahora() - e.caidoDesde)} sin conexión.`)
      e.caidoDesde = null; e.caidaAvisada = false
      return
    }
    e.caidoDesde ??= ahora()
    if (e.caidaAvisada || ahora() - e.caidoDesde < caidaMs) return
    e.caidaAvisada = true
    avisarCaida([
      `⚠️ Llevo ${duracion(ahora() - e.caidoDesde)} sin poder hablar con Interactive Brokers: Tortugas IB no puede abrir, cerrar ni mover stops (los stops ya puestos siguen en IB).`,
      enRailway
        ? 'Lo primero: en Railway, Restart del servicio ib-gateway y mirar sus registros (si sale «Unrecognized Username or Password», revisar TWS_PASSWORD).'
        : 'Lo primero: abrir el IB Gateway del PC e iniciar sesión.',
      `Detalle: ${e.ultimoError ?? 'sin conexión'}`,
    ].join('\n'))
  }

  function programarReintento() {
    if (e.reintento || e.cerrado) return
    e.reintento = setTimeout(() => { e.reintento = null; conectar().catch(() => {}) }, e.esperaReintento)
    e.reintento.unref?.()
    e.esperaReintento = Math.min(e.esperaReintento * 2, 60_000)
  }

  // conecta (si no lo está) y espera a tener el primer id de orden y la cuenta, como mucho 8 s
  function conectar() {
    if (e.conectado && e.siguienteId != null) return Promise.resolve()
    if (e.conectando) return e.conectando
    e.conectando = new Promise((ok, mal) => {
      e.ultimoError = null
      try {
        if (!e.api) e.api = montar()
        if (!e.api.isConnected) e.api.connect()
      } catch (err) { e.ultimoError = err.message; e.conectando = null; programarReintento(); revisarCaida(false); return mal(err) }
      const t0 = Date.now()
      const mirar = setInterval(() => {
        if (e.conectado && e.siguienteId != null && (e.listaCuenta || Date.now() - t0 > 4_000)) { clearInterval(mirar); e.conectando = null; revisarCaida(true); ok() }
        else if ((!e.conectado && e.ultimoError) || Date.now() - t0 > 8_000) {
          clearInterval(mirar); e.conectando = null
          if (!e.conectado) {
            // el socket abierto sin saludo de IB se tira, para que el reintento empiece de cero
            if (!e.ultimoError) {
              e.ultimoError = `El IB Gateway de ${host}:${port} acepta la conexión pero no contesta (¿sin sesión iniciada en IB, o esperando a que se acepte la conexión de la API?)`
              avisar(e.ultimoError)
            }
            const api = e.api
            e.api = null
            // disconnect() no cierra un socket que no ha pasado del saludo: se cierra a mano
            api?.controller?.socket?.client?.destroy()
            try { api?.removeAllListeners(); api?.disconnect() } catch { /* ya cerrado */ }
            programarReintento()
            revisarCaida(false)
          }
          mal(new Error(e.ultimoError))
        }
      }, 100)
    })
    return e.conectando
  }

  // cada valor de la cuenta en la moneda base (los que IB da por divisa traen también uno «BASE»)
  const valor = clave => {
    const k = `${clave}:BASE` in e.valores ? `${clave}:BASE` : Object.keys(e.valores).find(x => x.startsWith(`${clave}:`))
    return k ? n(e.valores[k]) : null
  }
  const monedaBase = () => Object.keys(e.valores).find(x => x.startsWith('NetLiquidation:'))?.split(':')[1] ?? null

  const posiciones = () => [...e.cartera.values()].map(({ c, pos, mercado, valor: v, coste, latente, realizado }) => {
    const mult = Number(c.multiplier) || 1
    return {
      id: c.conId, simbolo: nombreContrato(c), instrumento: c.secType, moneda: c.currency,
      lado: pos < 0 ? 'corto' : 'largo', cantidad: Math.abs(pos), entrada: coste != null ? coste / mult : null,
      precio: precio(mercado), valor: precio(v), resultado: precio(latente), realizado: precio(realizado),
      resultadoPct: coste && latente != null ? (latente / Math.abs(coste * pos)) * 100 : null,
    }
  })

  const ordenes = () => [...e.ordenes.values()].sort((a, b) => b.id - a.id).map(x => {
    const estado = x.motivo && ['Inactive', 'Cancelled', 'ApiCancelled', undefined, null].includes(x.estadoIB) ? 'rechazada' : ESTADOS[x.estadoIB] ?? x.estadoIB ?? 'enviando'
    return {
      id: x.id, simbolo: nombreContrato(x.c), conId: x.c.conId, lado: x.o.action === 'SELL' ? 'venta' : 'compra',
      tipo: TIPOS_INV[x.o.orderType] ?? x.o.orderType, cantidad: n(x.o.totalQuantity), rellena: x.rellena ?? 0,
      precioMedio: x.medio || null, limite: precio(x.o.lmtPrice) || null, stop: precio(x.o.auxPrice) || null, validez: x.o.tif,
      estado, motivo: x.motivo ?? null, padre: x.padre || x.o.parentId || null, referencia: x.o.orderRef ?? null,
      actualizada: x.actualizada ? new Date(x.actualizada).toISOString() : null,
    }
  })

  function comprobarQueSePuedeOperar() {
    if (!e.cuenta) throw new Error('IB no ha dicho todavía qué cuenta es')
    if (!esPaper(e.cuenta) && !real) throw new Error(`La cuenta ${e.cuenta} es real: las órdenes solo salen a una paper (DU…) salvo con IB_REAL=1`)
  }

  // Una petición con respuesta: `lanzar(id)` la manda, y los eventos de arriba la terminan
  function pedir(que, lanzar, ms = 15_000) {
    return new Promise((ok, mal) => {
      const id = e.sigPeticion++
      const t = setTimeout(() => { e.peticiones.delete(id); mal(new Error(`IB no contesta (${que})`)) }, ms)
      const fin = f => x => { clearTimeout(t); e.peticiones.delete(id); f(x) }
      e.peticiones.set(id, { filas: [], ok: fin(ok), mal: fin(mal) })
      lanzar(id)
    })
  }

  // Las órdenes abiertas ahora mismo en IB, pidiéndoselas: las que se rellenaron o cancelaron
  // sin que este proceso lo viera (con la conexión caída) ya no salen
  function pedirAbiertas() {
    if (e.abiertas) return e.abiertas.promesa
    let fin
    const promesa = new Promise(ok => { fin = ok })
    const lista = []
    const t = setTimeout(() => e.abiertas?.fin(), 5_000)
    e.abiertas = { lista, promesa, fin: () => { clearTimeout(t); e.abiertas = null; fin(lista.filter(x => !ACABADA.has(x.estadoIB))) } }
    e.api.reqAllOpenOrders()
    return promesa
  }

  // Espera a que una orden termine (rellena, cancelada o rechazada), como mucho `ms`. Un aviso
  // de IB sin estado no la termina: muchos son advertencias, y la orden sigue
  async function esperarOrden(id, ms) {
    const t0 = Date.now()
    while (Date.now() - t0 < ms && !ACABADA.has(e.ordenes.get(id)?.estadoIB)) await new Promise(r => setTimeout(r, 100))
    return e.ordenes.get(id)
  }

  function mandar(patas) {
    let padre = null
    const ids = []
    for (const { contrato, orden } of patas) {
      const id = e.siguienteId++
      const o = { ...orden, account: e.cuenta, ...(padre != null ? { parentId: padre } : {}) }
      e.ordenes.set(id, { id, c: contrato, o, estadoIB: null, actualizada: Date.now() })
      e.api.placeOrder(id, contrato, o)
      ids.push(id)
      padre ??= id
    }
    return ids
  }

  // espera a que IB conteste algo de las órdenes (estado o rechazo), como mucho `ms`
  async function respuesta(ids, ms = 3_000) {
    const t0 = Date.now()
    while (Date.now() - t0 < ms && ids.some(id => { const x = e.ordenes.get(id); return !x?.estadoIB && !x?.motivo })) await new Promise(r => setTimeout(r, 100))
    return ordenes().filter(o => ids.includes(o.id))
  }

  return {
    host, port: Number(port), clientId: Number(clientId),
    async estado() {
      // mientras espera para reintentar no vuelve a probar: contesta con el último error
      let error = e.reintento && !e.conectado ? e.ultimoError : null
      if (!error) try { await conectar() } catch (err) { error = err.message }
      if (!e.conectado) return { conectado: false, error, host, port: Number(port), clientId: Number(clientId), avisos: e.avisos.slice(0, 10) }
      if (e.api) e.api.reqAllOpenOrders()
      return {
        conectado: true, desde: e.desde, host, port: Number(port), clientId: Number(clientId),
        cuenta: e.cuenta, cuentas: e.cuentas, paper: esPaper(e.cuenta), puedeOperar: esPaper(e.cuenta) || real,
        resumen: {
          moneda: monedaBase(), liquidacion: valor('NetLiquidation'), efectivo: valor('TotalCashValue'), poderCompra: valor('BuyingPower'),
          disponible: valor('AvailableFunds'), latente: valor('UnrealizedPnL'), realizado: valor('RealizedPnL'),
        },
        posiciones: posiciones(), ordenes: ordenes(), avisos: e.avisos.slice(0, 10),
      }
    },
    async enviarOrden(o) {
      const patas = ordenParaIB(o)
      await conectar()
      comprobarQueSePuedeOperar()
      return respuesta(mandar(patas))
    },
    async cancelarOrden(id) {
      await conectar()
      if (!e.ordenes.has(Number(id))) throw new Error(`No conozco la orden ${id}`)
      e.api.cancelOrder(Number(id))
      return { ok: true }
    },
    // cierra a mercado; antes cancela sus órdenes pendientes (el stop, sobre todo), para que no
    // salte después y abra la posición contraria
    async cerrarPosicion(conId) {
      await conectar()
      comprobarQueSePuedeOperar()
      const p = e.cartera.get(Number(conId))
      if (!p) throw new Error('No hay ninguna posición abierta con ese contrato')
      for (const o of ordenes()) if (o.conId === p.c.conId && ABIERTA.has(o.estado)) e.api.cancelOrder(o.id)
      const contrato = { conId: p.c.conId, exchange: p.c.secType === 'STK' ? 'SMART' : p.c.exchange || p.c.primaryExch }
      const ids = mandar([{ contrato, orden: { action: p.pos > 0 ? 'SELL' : 'BUY', orderType: 'MKT', totalQuantity: Math.abs(p.pos), tif: 'DAY', orderRef: `SA-cierre-${Date.now()}`, transmit: true } }])
      return (await respuesta(ids))[0]
    },

    // ── Para los bots (server/tortugas-ib.js) ──
    async cuentaBot() {
      await conectar()
      return { moneda: monedaBase(), saldo: valor('NetLiquidation'), disponible: valor('AvailableFunds') }
    },
    // lo que vale una moneda en la base de la cuenta, si IB lo da (solo las que hay en la cuenta)
    cambio: moneda => n(e.valores[`ExchangeRate:${moneda}`]),
    async detalles(contrato) {
      await conectar()
      return pedir(`contrato ${contrato.symbol}`, id => e.api.reqContractDetails(id, contrato))
    },
    // las velas de `barra` (las diarias, con date 'AAAA-MM-DD')
    async historico(contrato, { duracion = '1 Y', barra = '1 day', que = 'TRADES', rth = false } = {}) {
      await conectar()
      const filas = await pedir(`histórico ${contrato.localSymbol ?? contrato.symbol}`, id => e.api.reqHistoricalData(id, contrato, '', duracion, barra, que, rth ? 1 : 0, 1, false), 60_000)
      return filas.map(f => ({ date: /^\d{8}$/.test(f.hora) ? `${f.hora.slice(0, 4)}-${f.hora.slice(4, 6)}-${f.hora.slice(6, 8)}` : f.hora, open: f.open, high: f.high, low: f.low, close: f.close }))
    },
    // precios en directo de un contrato (con su conId), una suscripción por `clave`;
    // `alPrecio(q)` con cada precio nuevo. Da la cotización, que se va actualizando sola
    cotizar(clave, contrato, alPrecio = null) {
      const ya = [...e.cotizaciones.values()].find(q => q.clave === clave)
      if (ya) return ya
      const id = e.sigPeticion++
      const q = { clave, contrato, bid: null, ask: null, last: null, retrasado: null, hora: null, error: null, alPrecio }
      e.cotizaciones.set(id, q)
      if (e.conectado && e.api) e.api.reqMktData(id, contrato, '', false, false)
      else conectar().catch(() => {})   // al conectar se suscriben todas
      return q
    },
    // los escalones de precio de una regla de mercado (las de un contrato, en sus detalles:
    // marketRuleIds), ordenados de menor a mayor precio
    async reglaPrecio(id) {
      await conectar()
      const ya = e.reglas.get(Number(id))
      if (ya) return ya.promesa
      const r = {}
      r.promesa = new Promise((ok, mal) => {
        const t = setTimeout(() => { e.reglas.delete(Number(id)); mal(new Error(`IB no da la regla de precios ${id}`)) }, 10_000)
        r.ok = escalones => { clearTimeout(t); ok([...escalones].map(x => ({ desde: Number(x.lowEdge), paso: Number(x.increment) })).sort((a, b) => a.desde - b.desde)) }
      })
      e.reglas.set(Number(id), r)
      e.api.reqMarketRule(Number(id))
      return r.promesa
    },
    async ejecuciones() {
      await conectar()
      await pedir('ejecuciones', id => e.api.reqExecutions(id, {}))
      return [...e.ejecuciones.values()]
    },
    async abiertas() {
      await conectar()
      return pedirAbiertas()
    },
    // manda las patas (la primera, la madre) y da sus ids; solo a una cuenta paper
    async mandarPatas(patas) {
      await conectar()
      comprobarQueSePuedeOperar()
      return mandar(patas)
    },
    orden: id => e.ordenes.get(id) ?? null,
    esperarOrden,
    // cambia una orden abierta (con su misma id, que tiene que ser de este cliente)
    async modificar(id, contrato, orden) {
      await conectar()
      comprobarQueSePuedeOperar()
      const o = { ...orden, account: e.cuenta, transmit: true }
      e.ordenes.set(id, { ...e.ordenes.get(id), id, c: contrato, o, motivo: null, estadoIB: null, actualizada: Date.now() })
      e.api.placeOrder(id, contrato, o)
    },
    async cancelar(id) {
      await conectar()
      e.api.cancelOrder(id)
    },

    cerrar() {
      e.cerrado = true
      clearTimeout(e.reintento); e.reintento = null
      try { e.api?.disconnect() } catch (err) { log.warn?.(`IB: ${err.message}`) }
    },
  }
}
