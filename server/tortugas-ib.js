// ── Las tortugas en Interactive Brokers (server/ib.js), en la cuenta paper ────────────────
// El mismo bot que en IG (server/bot-tortugas.js), con lo de IB debajo: sus mercados, la cuenta,
// los precios en directo, las órdenes con su stop y el diario de cada contrato. Reparto de las
// cuentas (decisión del usuario, 1-nov-2026): IG para los intradía (SRS, Rule of 4, First bar
// negative), Alpaca para las tortugas en acciones e IB para todas las demás tortugas:
//   · índices, con ETF UCITS de Xetra en euros: los de EE. UU. (SPY…) no se pueden comprar
//     siendo minorista por MiFID (no tienen KID). Cotizan a las horas de Xetra, también los de
//     índices de fuera, y sus niveles salen de su propio diario;
//   · divisas, al contado en IDEALPRO, en el día de 17:00 a 17:00 de Nueva York;
//   · materias primas y el bono a 10 años, con futuros: el micro donde lo hay (oro, plata,
//     cobre, crudo WTI, maíz, soja) y el normal donde no. Se opera el vencimiento vigente: el
//     primero de los meses buenos del mercado que esté a más de ROLAR_DIAS de su primer aviso
//     (el día 1 de su mes) o de su último día de negociación, lo que llegue antes. Cuando el
//     vigente cambia, el bot pasa las posiciones al nuevo (rolar en server/bot-tortugas.js).
//     Los niveles, del diario del propio contrato: un continuo saltaría al cambiar de vencimiento.
//
// Cada unidad del bot es una orden a mercado con su stop como hija (bracket): la referencia de la
// unidad va en el orderRef de la madre, «-stop» en el del stop y «-cierre» en el de la orden que
// la cierra. La unidad está abierta mientras su stop lo esté; si ya no, se cerró (por el stop o a
// mano) y el precio sale de las ejecuciones. El stop lo guarda IB, también de noche.
//
// La cuenta va en euros (la paper DUR292606, ~1 M€): el bot cuenta en euros, y los cambios salen
// de IB (las monedas que hay en la cuenta) o de las cotizaciones de las divisas del propio bot.

import { fechaEnZona } from './zonas.js'

export const PREFIJO_IB = 'TIB'      // + el sistema: TIB1-…, TIB2-…
export const ROLAR_DIAS = 10          // días antes del primer aviso o del último día en los que se pasa al siguiente vencimiento
const ESPERA_ORDEN_MS = 20_000        // lo que se espera a que IB rellene una orden a mercado
const ESPERA_STOP_MS = 5_000          // y a que confirme un stop movido o cancelado
const ESPERA_PRECIO_MS = 3_000        // y el primer precio de un contrato recién suscrito
// Más separación que esta parte del precio entre la compra y la venta no es un precio de verdad:
// en la subasta de apertura de Xetra, IB llegó a dar una oferta de 1.200 € en un ETF de 733 €
// (2-nov-2026), y el bot vio una ruptura que no había
export const HORQUILLA_MAX = 0.01
const VIGENTE_VALE_S = 6 * 3600       // cada cuánto se vuelve a mirar qué vencimiento toca
const LETRAS = 'FGHJKMNQUVXZ'         // los meses de los futuros, de enero a diciembre

const NUEVA_YORK = 'America/New_York'
const XETRA = { zona: 'Europe/Berlin', apertura: 9 * 60, cierre: 17 * 60 + 30 }
// los de 24 horas (Globex): de 18:00 a 17:00 de Nueva York, con el plan 150 min después de abrir,
// con la vela diaria de ayer ya cerrada
const GLOBEX = { zona: NUEVA_YORK, apertura: -6 * 60, cierre: 17 * 60, esperaPlan: 150 }
const GRANOS = { zona: NUEVA_YORK, apertura: -4 * 60, cierre: 14 * 60 + 20, esperaPlan: 150 }
const hora = (h, m = 0) => h * 60 + m

const etf = (nombre, grupo, simbolos, yahoo) => ({
  nombre, grupo, ...XETRA, tipo: 'etf', simbolos,
  contrato: { secType: 'STK', exchange: 'SMART', primaryExch: 'IBIS', currency: 'EUR' }, datos: { fuente: 'ib', yahoo },
})
const divisa = (nombre, base, cotizada, yahoo) => ({
  nombre, grupo: 'Divisas', zona: NUEVA_YORK, apertura: -7 * 60, cierre: 17 * 60, esperaPlan: 150, tipo: 'divisa', simbolos: [base],
  contrato: { secType: 'CASH', exchange: 'IDEALPRO', currency: cotizada }, datos: { fuente: 'ib', yahoo, zona: 'Europe/London' },
})
const futuro = (nombre, grupo, simbolos, exchange, meses, horas = GLOBEX) => ({
  nombre, grupo, ...horas, tipo: 'futuro', simbolos, meses,
  contrato: { secType: 'FUT', exchange, currency: 'USD' }, datos: { fuente: 'ib' },
})

// Con las mismas claves que MERCADOS_TORTUGAS (y el bono): la pestaña, las noticias y la
// comparación con el backtest los reconocen igual
export const MERCADOS_IB = {
  '^N225': etf('Nikkei 225', 'Asia', ['XDJP'], 'XDJP.DE'),
  '^GDAXI': etf('DAX', 'Europa', ['EXS1'], 'EXS1.DE'),
  '^FTSE': etf('FTSE 100', 'Europa', ['XDUK'], 'XDUK.DE'),
  '^NDX': etf('Nasdaq 100', 'EEUU', ['SXRV'], 'SXRV.DE'),
  '^GSPC': etf('S&P 500', 'EEUU', ['SXR8'], 'SXR8.DE'),
  '^DJI': etf('Dow Jones', 'EEUU', ['EXI3'], 'EXI3.DE'),
  '^RUT': etf('Russell 2000', 'EEUU', ['ZPRR'], 'ZPRR.DE'),
  EURUSD: divisa('EUR/USD', 'EUR', 'USD', 'EURUSD=X'), GBPUSD: divisa('GBP/USD', 'GBP', 'USD', 'GBPUSD=X'),
  USDJPY: divisa('USD/JPY', 'USD', 'JPY', 'JPY=X'), AUDUSD: divisa('AUD/USD', 'AUD', 'USD', 'AUDUSD=X'),
  USDCAD: divisa('USD/CAD', 'USD', 'CAD', 'CAD=X'), USDCHF: divisa('USD/CHF', 'USD', 'CHF', 'CHF=X'),
  XAUUSD: futuro('Oro', 'Metales', ['MGC'], 'COMEX', 'GJMQVZ'),
  // el micro de plata (1.000 onzas) es en IB el SI de la clase SIL
  XAGUSD: futuro('Plata', 'Metales', [{ symbol: 'SI', tradingClass: 'SIL' }, 'SIL'], 'COMEX', 'HKNUZ'),
  COPPER: futuro('Cobre', 'Metales', ['MHG'], 'COMEX', 'HKNUZ'),
  USOIL: futuro('Crudo WTI', 'Energía', ['MCL'], 'NYMEX', LETRAS),
  UKOIL: futuro('Crudo Brent', 'Energía', ['BZ'], 'NYMEX', LETRAS),
  NATGAS: futuro('Gas natural', 'Energía', ['QG', 'NG'], 'NYMEX', LETRAS),
  COFFEE: futuro('Café', 'Blandas', ['KC'], 'NYBOT', 'HKNUZ', { zona: NUEVA_YORK, apertura: hora(4, 15), cierre: hora(13, 30) }),
  COCOA: futuro('Cacao', 'Blandas', ['CC'], 'NYBOT', 'HKNUZ', { zona: NUEVA_YORK, apertura: hora(4, 45), cierre: hora(13, 30) }),
  SUGAR: futuro('Azúcar', 'Blandas', ['SB'], 'NYBOT', 'HKNV', { zona: NUEVA_YORK, apertura: hora(3, 30), cierre: hora(13) }),
  COTTON: futuro('Algodón', 'Blandas', ['CT'], 'NYBOT', 'HKNZ', { zona: NUEVA_YORK, apertura: -3 * 60, cierre: hora(14, 20), esperaPlan: 150 }),
  CORN: futuro('Maíz', 'Granos', ['MZC', 'ZC'], 'CBOT', 'HKNUZ', GRANOS),
  SOYBEAN: futuro('Soja', 'Granos', ['MZS', 'ZS'], 'CBOT', 'FHKNQUX', GRANOS),
  ZN: futuro('T-Note 10 años', 'Bonos', ['ZN'], 'CBOT', 'HMUZ'),
}

const aFecha = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
const masDias = (fecha, n) => new Date(Date.parse(`${fecha}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const entreSemana = v => ![0, 6].includes(new Date(`${v.date}T12:00:00Z`).getUTCDay())
const decimalesTick = tick => Math.max(0, Math.min(8, Math.ceil(-Math.log10(tick) - 1e-9)))
// la fecha y hora de IB sin la Z, como las da IG (el bot les pone la Z)
const isoSinZ = t => new Date(t * 1000).toISOString().slice(0, 19)

// El último día de negociación de un futuro (AAAA-MM-DD) y el día en que deja de ser el vigente
const venceDe = d => aFecha(String(d.realExpirationDate || d.contract?.lastTradeDateOrContractMonth || '').slice(0, 8))
export function limiteRolar(d, dias = ROLAR_DIAS) {
  const vence = venceDe(d)
  const mes = d.contractMonth ? `${d.contractMonth.slice(0, 4)}-${d.contractMonth.slice(4, 6)}-01` : vence
  return masDias(vence < mes ? vence : mes, -dias)
}
// El vencimiento que toca el día `hoy` entre los de la lista de IB: el primero de los meses buenos
// que no esté ya en su ventana de cambio
export function vencimientoVigente(lista, meses, hoy, dias = ROLAR_DIAS) {
  return lista
    .filter(d => d.contractMonth && meses.includes(LETRAS[Number(d.contractMonth.slice(4, 6)) - 1]) && limiteRolar(d, dias) > hoy)
    .sort((a, b) => (venceDe(a) < venceDe(b) ? -1 : 1))[0] ?? null
}

// El precio medio de unas ejecuciones, y la hora de la primera
function mediaDe(ejecuciones) {
  const cantidad = ejecuciones.reduce((s, j) => s + j.cantidad, 0)
  if (!(cantidad > 0)) return null
  return { precio: ejecuciones.reduce((s, j) => s + j.precio * j.cantidad, 0) / cantidad, hora: ejecuciones[0].hora }
}
// la hora de una ejecución de IB («AAAAMMDD hh:mm:ss», quizá con la zona detrás) como la de IG
const horaEjecucion = h => {
  const m = /^(\d{4})(\d{2})(\d{2})\s+(\d{2}:\d{2}:\d{2})/.exec(h ?? '')
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}` : null
}

export function crearTortugasIB({ ib, mercados = MERCADOS_IB, ahora = () => Math.floor(Date.now() / 1000), prefijo = PREFIJO_IB, log = console.log }) {
  const contratos = new Map()   // epic → { ticker, epic, contrato, valorPunto, tick, decimales, moneda, tipo, q }
  const vigentes = new Map()    // ticker → { epic, hasta }
  const velas = new Map()       // epic → velas de 1 min de su precio en directo
  const oyentes = new Map()     // ticker → funciones a las que avisar con cada precio
  const errores = new Map()     // ticker → el último error al buscar su contrato

  // ── Contratos ──
  const epicDe = k => (k.secType === 'CASH' ? `${k.symbol}.${k.currency}` : k.localSymbol || k.symbol)
  function registrar(ticker, d) {
    const k = d.contract
    const epic = epicDe(k)
    if (contratos.has(epic)) return epic
    const tick = d.minTick > 0 ? d.minTick : 0.01
    const contrato = {
      conId: k.conId, symbol: k.symbol, secType: k.secType, currency: k.currency, localSymbol: k.localSymbol,
      exchange: k.secType === 'STK' ? 'SMART' : k.exchange,
      ...(k.primaryExch ? { primaryExch: k.primaryExch } : {}),
      ...(k.secType === 'FUT' ? { lastTradeDateOrContractMonth: k.lastTradeDateOrContractMonth, multiplier: k.multiplier } : {}),
    }
    const c = {
      ticker, epic, contrato, tick, decimales: decimalesTick(tick), moneda: k.currency, tipo: mercados[ticker].tipo,
      // lo que vale moverse 1 en el precio, por contrato: el multiplicador entre lo que IB aumenta
      // el precio (los granos y las blandas cotizan en centavos)
      valorPunto: k.secType === 'FUT' ? Number(k.multiplier) / (d.priceMagnifier || 1) : 1,
    }
    c.q = ib.cotizar(epic, contrato, q => alPrecio(c, q))
    // los escalones de precio del contrato en su bolsa (en los ETF de Xetra dependen del precio):
    // sin ellos, IB rechaza un stop que no cae en uno
    const reglas = String(d.marketRuleIds ?? '').split(',')
    const bolsas = String(d.validExchanges ?? '').split(',')
    const regla = reglas[Math.max(0, bolsas.indexOf(k.primaryExch || k.exchange))]
    // la regla va en dólares aunque el contrato cotice en centavos (granos y blandas, con
    // priceMagnifier 100): sus bordes y escalones se pasan a las unidades del precio
    const aumento = d.priceMagnifier > 1 ? d.priceMagnifier : 1
    c.escalones = regla
      ? Promise.resolve(ib.reglaPrecio?.(regla))
        .then(xs => xs?.map(x => ({ desde: x.desde * aumento, paso: x.paso * aumento })) ?? null)
        .catch(() => null)
      : Promise.resolve(null)
    contratos.set(epic, c)
    return epic
  }

  async function primeroQueExista(m, buscar) {
    const fallos = []
    // cada símbolo, solo o con su clase ({ symbol, tradingClass })
    for (const s of m.simbolos) {
      const busqueda = typeof s === 'string' ? { symbol: s } : s
      const texto = [busqueda.symbol, busqueda.tradingClass].filter(Boolean).join(' ')
      try {
        const d = buscar(await ib.detalles({ ...m.contrato, ...busqueda }))
        if (d) return d
        fallos.push(`${texto}: ningún vencimiento bueno`)
      } catch (err) { fallos.push(`${texto}: ${err.message}`) }
    }
    throw new Error(`IB no da el contrato de ${m.nombre} (${fallos.join('; ')})`)
  }

  // El contrato que se opera ahora en un mercado (su epic), buscado como mucho cada 6 h
  async function resolver(ticker) {
    const m = mercados[ticker]
    if (!m) throw new Error(`Mercado desconocido: ${ticker}`)
    const ya = vigentes.get(ticker)
    if (ya && ya.hasta > ahora()) return ya.epic
    try {
      const d = await primeroQueExista(m, lista => (m.tipo === 'futuro' ? vencimientoVigente(lista, m.meses, fechaEnZona(ahora(), m.zona)) : lista[0]))
      const epic = registrar(ticker, d)
      vigentes.set(ticker, { epic, hasta: ahora() + VIGENTE_VALE_S })
      errores.delete(ticker)
      return epic
    } catch (err) { errores.set(ticker, err.message); throw err }
  }

  // Un contrato por su epic (el de una posición en un vencimiento que ya no es el vigente)
  async function contratoDe(ticker, epic) {
    if (contratos.has(epic)) return contratos.get(epic)
    const m = mercados[ticker]
    if (m?.tipo !== 'futuro') {
      const vigente = await resolver(ticker)
      if (vigente !== epic) throw new Error(`${epic} no es el contrato de ${m?.nombre ?? ticker} (${vigente})`)
      return contratos.get(epic)
    }
    const [d] = await ib.detalles({ ...m.contrato, localSymbol: epic })
    if (!d) throw new Error(`IB no da el contrato ${epic}`)
    return contratos.get(registrar(ticker, d))
  }

  // El mercado del bot de un contrato de IB (el de una orden abierta)
  function tickerDe(c) {
    const ya = [...contratos.values()].find(k => k.contrato.conId === c.conId)
    if (ya) return ya.ticker
    return Object.keys(mercados).find(t => {
      const m = mercados[t]
      return m.contrato.secType === c.secType && m.simbolos.some(s => (typeof s === 'string' ? s === c.symbol : s.symbol === c.symbol && (!c.tradingClass || s.tradingClass === c.tradingClass)))
        && (c.secType !== 'CASH' || m.contrato.currency === c.currency)
    }) ?? null
  }

  // ── Precios en directo: velas de 1 min con el precio medio (o el último) de cada contrato ──
  function alPrecio(c, q) {
    const precio = precioDe(q)
    if (!(precio > 0)) return
    const minuto = Math.floor(ahora() / 60) * 60
    const vs = velas.get(c.epic) ?? []
    const v = vs.at(-1)
    if (v?.time === minuto) Object.assign(v, { high: Math.max(v.high, precio), low: Math.min(v.low, precio), close: precio })
    else {
      vs.push({ time: minuto, open: precio, high: precio, low: precio, close: precio })
      if (vs.length > 30) vs.shift()
    }
    velas.set(c.epic, vs)
    for (const fn of oyentes.get(c.ticker) ?? []) fn()
  }
  // la compra y la venta, si las dos están y la horquilla es creíble
  const horquilla = q => (q.bid > 0 && q.ask > 0 && q.ask >= q.bid && q.ask - q.bid <= HORQUILLA_MAX * (q.ask + q.bid) / 2 ? { bid: q.bid, ask: q.ask } : null)
  // el precio de ahora: el medio de una horquilla creíble o, sin ella, el último
  const precioDe = q => { const h = horquilla(q); return h ? (h.bid + h.ask) / 2 : q.last ?? null }
  const precioMedio = epic => {
    const q = contratos.get(epic)?.q
    return q?.bid > 0 && q?.ask > 0 ? (q.bid + q.ask) / 2 : q?.last ?? null
  }

  async function cotizacionFresca(c) {
    const t0 = Date.now()
    while (!(c.q.bid > 0 || c.q.last > 0) && !c.q.error && Date.now() - t0 < ESPERA_PRECIO_MS) await new Promise(r => setTimeout(r, 100))
    return c.q
  }

  // Lo que vale una moneda en euros: lo de IB si lo da, y si no, de las cotizaciones de las divisas
  function cambioAEur(moneda) {
    if (moneda === 'EUR') return 1
    const deIB = ib.cambio(moneda)
    if (deIB > 0) return deIB
    const eurusd = precioMedio('EUR.USD')
    if (!eurusd) return null
    if (moneda === 'USD') return 1 / eurusd
    const directo = precioMedio(`${moneda}.USD`)
    if (directo) return directo / eurusd
    const inverso = precioMedio(`USD.${moneda}`)
    return inverso ? 1 / (inverso * eurusd) : null
  }

  // ── Órdenes ──
  // un precio en el escalón del contrato (el de su regla de mercado a ese precio, o su tick)
  const alTick = (precio, c, escalones = null) => {
    // nunca más fino que el tick del contrato
    const paso = Math.max(escalones?.findLast(x => precio >= x.desde)?.paso ?? 0, c.tick)
    return Number((Math.round(precio / paso) * paso).toFixed(decimalesTick(paso)))
  }
  const ordenStop = (o, nivel, { conPadre = true } = {}) => ({
    action: o.action, orderType: 'STP', auxPrice: nivel, totalQuantity: Number(o.totalQuantity), tif: 'GTC', outsideRth: true, orderRef: o.orderRef,
    ...(conPadre && o.parentId ? { parentId: o.parentId } : {}),
  })
  const delBot = x => x.o.orderType === 'STP' && x.o.orderRef?.startsWith(prefijo) && x.o.orderRef.endsWith('-stop')
  const stopDe = async dealId => (await ib.abiertas()).find(x => x.o.orderRef === `${dealId}-stop`) ?? null

  const operar = {
    async cuenta() {
      const c = await ib.cuentaBot()
      if (c.moneda && c.moneda !== 'EUR') throw new Error(`la cuenta de IB va en ${c.moneda} y el bot cuenta en euros`)
      return { saldo: c.saldo, disponible: c.disponible }
    },

    async datosMercado(ticker, epic = null) {
      const c = await contratoDe(ticker, epic ?? await resolver(ticker))
      const q = await cotizacionFresca(c)
      const divisa = c.tipo === 'divisa'
      // con una horquilla imposible no hay precio para entrar: el bot espera
      const h = horquilla(q)
      const sinHorquilla = !(q.bid > 0 && q.ask > 0)
      return {
        epic: c.epic, moneda: c.moneda, conPrecio: precioDe(q) > 0,
        oferta: h?.ask ?? (sinHorquilla ? q.last ?? null : null), bid: h?.bid ?? (sinHorquilla ? q.last ?? null : null), retrasado: q.retrasado, error: q.error,
        valorPunto: c.valorPunto, cambioAEur: cambioAEur(c.moneda), decimales: c.decimales, aMercado: true,
        // IDEALPRO admite cualquier cantidad, pero por debajo de unos 25.000 $ va como lote suelto
        tamanoMin: divisa ? 1000 : 1, paso: divisa ? 1000 : 1,
        factorMargen: { divisa: 0.05, futuro: 0.1, etf: 0.5 }[c.tipo],
        ...(c.tipo === 'futuro' ? { futuro: true } : {}),
      }
    },

    // A mercado, con el stop de la unidad como hija: IB no tiene nunca la entrada sin su stop
    async abrir({ ticker, epic, lado, tamano, stop, referencia }) {
      const c = await contratoDe(ticker, epic)
      const compra = lado === 'largo'
      const nivel = alTick(stop, c, await c.escalones)
      // un stop al otro lado del precio es que el precio no era bueno: no se manda
      const precioAhora = compra ? horquilla(c.q)?.bid : horquilla(c.q)?.ask
      if (precioAhora != null && (compra ? nivel >= precioAhora : nivel <= precioAhora)) return { aceptada: false, motivo: `el stop (${nivel}) queda al otro lado del precio (${precioAhora})` }
      const [id, idStop] = await ib.mandarPatas([
        { contrato: c.contrato, orden: { action: compra ? 'BUY' : 'SELL', orderType: 'MKT', totalQuantity: tamano, tif: 'DAY', orderRef: referencia, transmit: false } },
        { contrato: c.contrato, orden: { action: compra ? 'SELL' : 'BUY', orderType: 'STP', auxPrice: nivel, totalQuantity: tamano, tif: 'GTC', outsideRth: true, orderRef: `${referencia}-stop`, transmit: true } },
      ])
      // si IB rechaza el stop, la madre no sale nunca (va con transmit=false): se cancela y no entra
      const t0 = Date.now()
      let o = ib.orden(id)
      while (Date.now() - t0 < ESPERA_ORDEN_MS && !['Filled', 'Cancelled', 'ApiCancelled', 'Inactive'].includes(o?.estadoIB)) {
        const s = ib.orden(idStop)
        if (s?.motivo && !['Submitted', 'PreSubmitted', 'Filled'].includes(s.estadoIB)) {
          await ib.cancelar(id).catch(() => {})
          return { aceptada: false, motivo: `IB rechaza su stop: ${s.motivo}` }
        }
        await new Promise(r => setTimeout(r, 100))
        o = ib.orden(id)
      }
      if (o?.estadoIB === 'Filled') return { aceptada: true, dealId: referencia, nivel: o.medio, tamano: o.rellena || tamano, stop: nivel }
      if (['Cancelled', 'ApiCancelled', 'Inactive'].includes(o?.estadoIB)) return { aceptada: false, motivo: o.motivo ?? 'IB la ha cancelado' }
      // sin respuesta: el bot mira después en las órdenes abiertas si entró (por su referencia)
      throw new Error(`IB no ha rellenado la orden en ${ESPERA_ORDEN_MS / 1000} s${o?.motivo ? ` (${o.motivo})` : ''}`)
    },

    // Cancela su stop y la cierra a mercado; si IB no la cierra, vuelve a poner el stop
    async cerrar({ ticker, dealId }) {
      const x = await stopDe(dealId)
      if (!x) return { aceptada: false, motivo: 'la unidad ya no tiene stop abierto en IB' }
      const c = await contratoDe(ticker ?? tickerDe(x.c), epicDe(x.c)).catch(() => null)
      const contrato = c?.contrato ?? x.c
      await ib.cancelar(x.id)
      const cancelada = await ib.esperarOrden(x.id, ESPERA_STOP_MS)
      if (cancelada?.estadoIB === 'Filled') return { aceptada: false, motivo: 'acaba de saltar su stop' }
      if (!['Cancelled', 'ApiCancelled'].includes(cancelada?.estadoIB)) throw new Error('IB no confirma que haya cancelado el stop')
      const [id] = await ib.mandarPatas([{ contrato, orden: { action: x.o.action, orderType: 'MKT', totalQuantity: Number(x.o.totalQuantity), tif: 'DAY', orderRef: `${dealId}-cierre`, transmit: true } }])
      const o = await ib.esperarOrden(id, ESPERA_ORDEN_MS)
      if (o?.estadoIB === 'Filled') return { aceptada: true, nivel: o.medio }
      await ib.cancelar(id)
      await ib.mandarPatas([{ contrato, orden: ordenStop(x.o, x.o.auxPrice, { conPadre: false }) }])
      return { aceptada: false, motivo: o?.motivo ?? 'IB no la ha cerrado a mercado; el stop vuelve a estar puesto' }
    },

    async moverStop({ ticker, dealId, stop }) {
      const x = await stopDe(dealId)
      if (!x) return { aceptada: false, motivo: 'IB no tiene abierto su stop' }
      if (!(x.id > 0)) return { aceptada: false, motivo: 'su stop lo puso otro cliente de la API' }
      const c = await contratoDe(ticker ?? tickerDe(x.c), epicDe(x.c)).catch(() => null)
      const nivel = c ? alTick(stop, c, await c.escalones) : stop
      await ib.modificar(x.id, c?.contrato ?? x.c, ordenStop(x.o, nivel))
      const t0 = Date.now()
      let o = ib.orden(x.id)
      while (Date.now() - t0 < ESPERA_STOP_MS && !o?.estadoIB && !o?.motivo) {
        await new Promise(r => setTimeout(r, 100))
        o = ib.orden(x.id)
      }
      if (o?.motivo) return { aceptada: false, motivo: o.motivo }
      if (!o?.estadoIB) throw new Error('IB no confirma el stop movido')
      return { aceptada: true }
    },

    // Las unidades abiertas de este bot: los stops abiertos con su prefijo
    async posiciones() {
      const [abiertas, ejecuciones] = await Promise.all([ib.abiertas(), ib.ejecuciones().catch(() => [])])
      return abiertas.filter(delBot).map(x => {
        const referencia = x.o.orderRef.slice(0, -'-stop'.length)
        const entrada = mediaDe(ejecuciones.filter(j => j.orderRef === referencia))
        return {
          dealId: referencia, referencia, ticker: tickerDe(x.c), epic: epicDe(x.c),
          lado: x.o.action === 'SELL' ? 'largo' : 'corto', tamano: Number(x.o.totalQuantity), stop: x.o.auxPrice,
          nivel: entrada?.precio ?? null, abierta: horaEjecucion(entrada?.hora) ?? isoSinZ(ahora()),
        }
      })
    },

    // El precio al que salió una unidad que ya no está: el de su stop o el de su cierre
    async cierreDe({ dealId }) {
      const ejecuciones = await ib.ejecuciones()
      const salida = mediaDe(ejecuciones.filter(j => j.orderRef === `${dealId}-stop` || j.orderRef === `${dealId}-cierre`))
      return salida ? { nivel: salida.precio } : null
    },
  }

  const precios = {
    // las del contrato `epic` (por defecto, el vigente)
    velas: (ticker, n, epic = null) => (velas.get(epic ?? vigentes.get(ticker)?.epic) ?? []).slice(-n),
    escuchar(ticker, fn) {
      if (!oyentes.has(ticker)) oyentes.set(ticker, new Set())
      oyentes.get(ticker).add(fn)
      return () => oyentes.get(ticker)?.delete(fn)
    },
  }

  return {
    operar, precios, mercados, prefijo,
    epicsDe: async ticker => [await resolver(ticker)],
    // El diario del contrato vigente: el punto medio en las divisas, lo negociado en lo demás (en
    // los ETF, solo en la sesión de Xetra)
    async velasDiarias(ticker) {
      const m = mercados[ticker]
      const c = contratos.get(await resolver(ticker))
      const v = await ib.historico(c.contrato, { duracion: '1 Y', que: m.tipo === 'divisa' ? 'MIDPOINT' : 'TRADES', rth: m.tipo === 'etf' })
      return v.filter(entreSemana)
    },
    // Busca el contrato de todos los mercados y se suscribe a sus precios
    async arrancar() {
      for (const ticker of Object.keys(mercados)) {
        try { await resolver(ticker) } catch (err) { log(`[tortugas ib] ${ticker}: ${err.message}`) }
      }
    },
    estado: () => Object.fromEntries(Object.keys(mercados).map(ticker => {
      const epic = vigentes.get(ticker)?.epic ?? null
      const q = epic ? contratos.get(epic)?.q : null
      return [ticker, { epic, retrasado: q?.retrasado ?? null, error: errores.get(ticker) ?? q?.error ?? null }]
    })),
  }
}
