// ── Alpaca (acciones y ETF de EE. UU.), por ahora solo la cuenta PAPER ─────────────────
// La vista Alpaca de la pestaña Bots: la cuenta, las posiciones, las órdenes y un ticket para
// lanzarlas a mano. Ningún bot opera aquí todavía. Claves en ALPACA_API_KEY y ALPACA_SECRET_KEY
// (las de paper empiezan por PK). Con `paper: false` iría a la cuenta real: index.js solo lo
// hace con ALPACA_REAL=1, que no está puesto en ningún sitio.
//
// Ojo con Alpaca: rechaza una orden si en el mismo símbolo ya hay otra pendiente del lado
// contrario («potential wash trade», p. ej. una compra límite con un stop de venta puesto). Para
// entrar con stop hay que mandarlos juntos: `stopLoss` aquí, que la manda como OTO.

const URL_PAPER = 'https://paper-api.alpaca.markets'
const URL_REAL  = 'https://api.alpaca.markets'

const TIPOS = new Set(['market', 'limit', 'stop', 'stop_limit'])
const VALIDEZ = new Set(['day', 'gtc', 'ioc', 'fok', 'opg', 'cls'])
const SIMBOLO = /^[A-Z][A-Z0-9.]{0,9}$/

const n = x => (x == null || x === '' ? null : Number(x))
const positivo = x => Number.isFinite(x) && x > 0

// Lo que manda la pestaña ({ simbolo, lado, tipo, cantidad | importe, limite, stop, validez,
// stopLoss }) en el cuerpo que pide Alpaca; lanza un Error con el motivo si algo no cuadra
export function ordenParaAlpaca(o, { prefijo = 'SA-', ahora = Date.now } = {}) {
  const simbolo = String(o?.simbolo ?? '').trim().toUpperCase()
  if (!SIMBOLO.test(simbolo)) throw new Error(`Símbolo no válido: «${o?.simbolo ?? ''}»`)
  const lado = o.lado === 'venta' ? 'sell' : o.lado === 'compra' ? 'buy' : null
  if (!lado) throw new Error('El lado tiene que ser compra o venta')
  const tipo = o.tipo ?? 'market'
  if (!TIPOS.has(tipo)) throw new Error(`Tipo de orden no válido: ${tipo}`)
  const validez = o.validez ?? 'day'
  if (!VALIDEZ.has(validez)) throw new Error(`Validez no válida: ${validez}`)

  const cantidad = n(o.cantidad), importe = n(o.importe)
  if ((cantidad == null) === (importe == null)) throw new Error('Pon la cantidad o el importe en $, uno de los dos')
  if (cantidad != null && !positivo(cantidad)) throw new Error('La cantidad tiene que ser mayor que 0')
  if (importe != null && !positivo(importe)) throw new Error('El importe tiene que ser mayor que 0')
  // las fraccionarias (por importe o con decimales) solo a mercado o límite y en el día
  const fraccion = importe != null || !Number.isInteger(cantidad)
  if (fraccion && (!['market', 'limit'].includes(tipo) || validez !== 'day')) throw new Error('Las órdenes fraccionarias (por importe o con decimales) solo pueden ser a mercado o límite y del día')

  const cuerpo = { symbol: simbolo, side: lado, type: tipo, time_in_force: validez, client_order_id: `${prefijo}${ahora()}` }
  if (cantidad != null) cuerpo.qty = String(cantidad)
  else cuerpo.notional = String(importe)

  const limite = n(o.limite), stop = n(o.stop)
  if (tipo === 'limit' || tipo === 'stop_limit') {
    if (!positivo(limite)) throw new Error('Falta el precio límite')
    cuerpo.limit_price = String(limite)
  }
  if (tipo === 'stop' || tipo === 'stop_limit') {
    if (!positivo(stop)) throw new Error('Falta el precio del stop')
    cuerpo.stop_price = String(stop)
  }

  const stopLoss = n(o.stopLoss)
  if (stopLoss != null) {
    if (!positivo(stopLoss)) throw new Error('El stop de protección tiene que ser mayor que 0')
    if (fraccion) throw new Error('Una orden con stop de protección tiene que ser de acciones enteras')
    const ref = tipo === 'market' ? null : limite ?? stop
    if (ref != null && (lado === 'buy' ? stopLoss >= ref : stopLoss <= ref)) throw new Error(`El stop de protección tiene que quedar ${lado === 'buy' ? 'por debajo' : 'por encima'} de la entrada`)
    cuerpo.order_class = 'oto'
    cuerpo.stop_loss = { stop_price: String(stopLoss) }
  }
  return cuerpo
}

export const cuentaDeAlpaca = c => ({
  numero: c.account_number, estado: c.status, moneda: c.currency,
  efectivo: n(c.cash), equity: n(c.equity), equityAyer: n(c.last_equity),
  poderCompra: n(c.buying_power), bloqueada: !!(c.trading_blocked || c.account_blocked),
  paper: String(c.account_number ?? '').startsWith('PA'),
})

export const posicionDeAlpaca = p => ({
  simbolo: p.symbol, lado: p.side === 'short' ? 'corto' : 'largo', cantidad: Math.abs(n(p.qty)),
  entrada: n(p.avg_entry_price), precio: n(p.current_price), valor: n(p.market_value),
  resultado: n(p.unrealized_pl), resultadoPct: p.unrealized_plpc == null ? null : n(p.unrealized_plpc) * 100,
  resultadoHoy: n(p.unrealized_intraday_pl),
})

export const ordenDeAlpaca = o => ({
  id: o.id, referencia: o.client_order_id, simbolo: o.symbol,
  lado: o.side === 'sell' ? 'venta' : 'compra', tipo: o.type ?? o.order_type, clase: o.order_class || 'simple',
  cantidad: n(o.qty), importe: n(o.notional), rellena: n(o.filled_qty), precioMedio: n(o.filled_avg_price),
  limite: n(o.limit_price), stop: n(o.stop_price), estado: o.status, validez: o.time_in_force,
  creada: o.created_at, rellenaEn: o.filled_at,
  patas: (o.legs ?? []).map(ordenDeAlpaca),
})

// Precios de ahora de muchas acciones a la vez, del feed IEX (el gratuito: la última operación
// en IEX, que va con el resto del mercado a céntimos): en tandas, para no hacer URL enormes
const URL_DATOS = 'https://data.alpaca.markets'
const POR_TANDA = 100

export function crearAlpaca({ clave, secreto, paper = true, fetch: pedirHttp = fetch } = {}) {
  if (!clave || !secreto) return null
  const base = paper ? URL_PAPER : URL_REAL

  async function pedir(metodo, ruta, cuerpo, raiz = base) {
    const r = await pedirHttp(`${raiz}${ruta}`, {
      method: metodo,
      headers: { 'APCA-API-KEY-ID': clave, 'APCA-API-SECRET-KEY': secreto, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    const texto = await r.text()
    const datos = texto ? JSON.parse(texto) : null
    if (!r.ok) throw new Error(`Alpaca ${r.status}: ${datos?.message ?? texto}`)
    return datos
  }

  return {
    paper,
    cuenta: async () => cuentaDeAlpaca(await pedir('GET', '/v2/account')),
    reloj: async () => {
      const c = await pedir('GET', '/v2/clock')
      return { abierto: c.is_open, proximaApertura: c.next_open, proximoCierre: c.next_close }
    },
    posiciones: async () => (await pedir('GET', '/v2/positions')).map(posicionDeAlpaca),
    // las abiertas y las últimas cerradas, con las patas del OTO dentro de su orden
    ordenes: async ({ estado = 'all', limite = 50 } = {}) => (await pedir('GET', `/v2/orders?status=${estado}&limit=${limite}&nested=true&direction=desc`)).map(ordenDeAlpaca),
    enviarOrden: async (o, opciones) => ordenDeAlpaca(await pedir('POST', '/v2/orders', ordenParaAlpaca(o, opciones))),
    orden: async id => ordenDeAlpaca(await pedir('GET', `/v2/orders/${encodeURIComponent(id)}?nested=true`)),
    ordenesAbiertas: async simbolo => (await pedir('GET', `/v2/orders?status=open&nested=true&limit=500${simbolo ? `&symbols=${encodeURIComponent(simbolo)}` : ''}`)).map(ordenDeAlpaca),
    // las acciones que se pueden operar: { símbolo → { cortos: se pueden vender en corto } }
    operables: async () => Object.fromEntries((await pedir('GET', '/v2/assets?status=active&asset_class=us_equity'))
      .filter(a => a.tradable).map(a => [a.symbol, { cortos: !!(a.shortable && a.easy_to_borrow) }])),
    // los días de mercado entre dos fechas (YYYY-MM-DD), sin festivos
    dias: async (desde, hasta) => (await pedir('GET', `/v2/calendar?start=${desde}&end=${hasta}`)).map(d => d.date),
    // { símbolo → { precio, hora } } con la última operación de cada una
    precios: async simbolos => {
      const salida = {}
      for (let i = 0; i < simbolos.length; i += POR_TANDA) {
        const tanda = simbolos.slice(i, i + POR_TANDA).map(encodeURIComponent).join(',')
        const r = await pedir('GET', `/v2/stocks/snapshots?symbols=${tanda}&feed=iex`, null, URL_DATOS)
        for (const [s, x] of Object.entries(r ?? {})) if (x?.latestTrade?.p > 0) salida[s] = { precio: x.latestTrade.p, hora: x.latestTrade.t }
      }
      return salida
    },
    cancelarOrden: async id => { await pedir('DELETE', `/v2/orders/${encodeURIComponent(id)}`); return { ok: true } },
    // cierra a mercado; antes cancela las órdenes pendientes del símbolo (su stop, sobre todo),
    // o Alpaca rechazaría el cierre por tener otra del lado contrario
    cerrarPosicion: async simbolo => {
      const s = encodeURIComponent(simbolo)
      const pendientes = await pedir('GET', `/v2/orders?status=open&symbols=${s}`)
      await Promise.all(pendientes.map(o => pedir('DELETE', `/v2/orders/${o.id}`)))
      // la cancelación no es instantánea: unos intentos mientras Alpaca la confirma
      for (let intento = 0; ; intento++) {
        try { return ordenDeAlpaca(await pedir('DELETE', `/v2/positions/${s}`)) }
        catch (err) {
          if (intento >= 5 || !pendientes.length || !/40310000|wash|held_for_orders|insufficient qty/i.test(err.message)) throw err
          await new Promise(r => setTimeout(r, 500))
        }
      }
    },
  }
}
