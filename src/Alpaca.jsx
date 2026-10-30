import { useEffect, useState, useCallback } from 'react'
import { conClaveBot, guardarClaveBot } from './claveBot'
import './Bot.css'

// La cuenta paper de Alpaca (acciones y ETF de EE. UU.; server/alpaca.js, /api/bot/alpaca): la
// cuenta, las posiciones, las órdenes y un ticket para lanzarlas a mano. Ningún bot opera aquí.

const num = (n, dec = 2) => (n == null ? '—' : n.toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec }))
const dinero = n => (n == null ? '—' : `${n > 0 ? '+' : ''}${num(n)} $`)
const cantidad = n => (n == null ? '—' : n.toLocaleString('es-ES', { maximumFractionDigits: 6 }))
const tono = n => (n == null ? '' : n > 0 ? 'bot-pos' : n < 0 ? 'bot-neg' : '')
const fechaHora = iso => (iso ? new Date(iso).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')

const TIPOS = { market: 'Mercado', limit: 'Límite', stop: 'Stop', stop_limit: 'Stop límite' }
const ESTADOS = {
  new: 'pendiente', accepted: 'aceptada', pending_new: 'enviando', partially_filled: 'en parte', filled: 'ejecutada',
  canceled: 'cancelada', expired: 'caducada', rejected: 'rechazada', held: 'en espera', done_for_day: 'fin del día', replaced: 'sustituida',
}
const ABIERTA = new Set(['new', 'accepted', 'pending_new', 'partially_filled', 'held'])

async function pedir(url, opciones = {}) {
  const r = await fetch(url, { ...opciones, headers: conClaveBot(opciones.body ? { 'Content-Type': 'application/json' } : {}) })
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
  if (!r.ok || j.error) {
    const err = new Error(j.error ?? `HTTP ${r.status}`)
    err.necesitaClave = !!j.necesitaClave
    throw err
  }
  return j
}

function precioDeOrden(o) {
  if (o.precioMedio != null) return num(o.precioMedio)
  if (o.tipo === 'stop_limit') return `${num(o.stop)} → ${num(o.limite)}`
  return o.limite != null ? num(o.limite) : o.stop != null ? num(o.stop) : '—'
}

const TICKET_INICIAL = { simbolo: 'SPY', lado: 'compra', por: 'cantidad', cantidad: '1', importe: '', tipo: 'market', limite: '', stop: '', validez: 'day', stopLoss: '' }

function Ticket({ alEnviar }) {
  const [t, setT] = useState(TICKET_INICIAL)
  const [enviando, setEnviando] = useState(false)
  const [resultado, setResultado] = useState(null)
  const cambiar = campo => e => setT(v => ({ ...v, [campo]: e.target.value }))
  const conLimite = t.tipo === 'limit' || t.tipo === 'stop_limit'
  const conStop = t.tipo === 'stop' || t.tipo === 'stop_limit'

  async function enviar(e) {
    e.preventDefault()
    const orden = {
      simbolo: t.simbolo, lado: t.lado, tipo: t.tipo, validez: t.validez,
      ...(t.por === 'cantidad' ? { cantidad: t.cantidad } : { importe: t.importe }),
      ...(conLimite ? { limite: t.limite } : {}), ...(conStop ? { stop: t.stop } : {}),
      ...(t.stopLoss ? { stopLoss: t.stopLoss } : {}),
    }
    const resumen = `${t.lado === 'compra' ? 'Comprar' : 'Vender'} ${t.por === 'cantidad' ? `${t.cantidad} ${Number(t.cantidad) === 1 ? 'acción' : 'acciones'} de` : `${t.importe} $ de`} ${t.simbolo.toUpperCase()} (${TIPOS[t.tipo].toLowerCase()})${t.stopLoss ? ` con stop en ${t.stopLoss}` : ''} en la cuenta paper?`
    if (!window.confirm(`¿${resumen}`)) return
    setEnviando(true)
    try {
      const o = await pedir('/api/bot/alpaca/orden', { method: 'POST', body: JSON.stringify(orden) })
      setResultado({ ok: true, texto: `Orden enviada: ${ESTADOS[o.estado] ?? o.estado}.` })
      alEnviar()
    } catch (err) {
      setResultado({ ok: false, texto: err.message })
    } finally { setEnviando(false) }
  }

  return (
    <form className="bot-form" onSubmit={enviar}>
      <label>Símbolo<input value={t.simbolo} onChange={cambiar('simbolo')} placeholder="SPY" required /></label>
      <label>Lado
        <select value={t.lado} onChange={cambiar('lado')}><option value="compra">Compra</option><option value="venta">Venta (corto si no hay posición)</option></select>
      </label>
      <label>Tipo
        <select value={t.tipo} onChange={cambiar('tipo')}>{Object.entries(TIPOS).map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>
      </label>
      <label>Tamaño en
        <select value={t.por} onChange={cambiar('por')}><option value="cantidad">acciones</option><option value="importe">dólares (fraccionaria)</option></select>
      </label>
      {t.por === 'cantidad'
        ? <label>Acciones<input type="number" step="any" min="0" value={t.cantidad} onChange={cambiar('cantidad')} required /></label>
        : <label>Importe ($)<input type="number" step="any" min="0" value={t.importe} onChange={cambiar('importe')} required /></label>}
      {conStop && <label>Precio del stop<input type="number" step="any" min="0" value={t.stop} onChange={cambiar('stop')} required /></label>}
      {conLimite && <label>Precio límite<input type="number" step="any" min="0" value={t.limite} onChange={cambiar('limite')} required /></label>}
      <label>Validez
        <select value={t.validez} onChange={cambiar('validez')}><option value="day">El día</option><option value="gtc">Hasta cancelar</option><option value="ioc">Inmediata o cancelar</option></select>
      </label>
      <label title="Se manda junto con la entrada (OTO): Alpaca no deja poner un stop aparte mientras haya otra orden del lado contrario">
        Stop de protección (opcional)<input type="number" step="any" min="0" value={t.stopLoss} onChange={cambiar('stopLoss')} placeholder="sin stop" />
      </label>
      <div className="bot-botones" style={{ alignItems: 'flex-end' }}>
        <button className="diario-boton" type="submit" disabled={enviando}>{enviando ? 'Enviando…' : 'Enviar orden'}</button>
      </div>
      {resultado && <p className={resultado.ok ? 'bot-pos' : 'bot-error'} style={{ gridColumn: '1 / -1' }}>{resultado.texto}</p>}
    </form>
  )
}

export default function Alpaca() {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const [pideClave, setPideClave] = useState(false)
  const [clave, setClave] = useState('')
  const [ocupado, setOcupado] = useState(null)

  const cargar = useCallback(async () => {
    try {
      setDatos(await pedir('/api/bot/alpaca'))
      setError(null)
      setPideClave(false)
    } catch (err) {
      setError(err.message)
      if (err.necesitaClave) setPideClave(true)
    }
  }, [])

  // al abrir la vista y cada 10 s
  useEffect(() => {
    const primera = setTimeout(cargar, 0)
    const reloj = setInterval(cargar, 10000)
    return () => { clearTimeout(primera); clearInterval(reloj) }
  }, [cargar])

  async function accion(clave, pregunta, url) {
    if (!window.confirm(pregunta)) return
    setOcupado(clave)
    try { await pedir(url, { method: 'DELETE' }); await cargar() }
    catch (err) { setError(err.message) }
    finally { setOcupado(null) }
  }

  if (pideClave) {
    return (
      <div className="bot-page">
        <section className="bot-bloque bot-clave">
          <h3>Clave del bot</h3>
          <p className="bot-nota">El servidor de producción pide la clave del bot (la variable BOT_TOKEN de Railway). Se guarda en este navegador.</p>
          {error && <p className="bot-error">{error}</p>}
          <form onSubmit={e => { e.preventDefault(); guardarClaveBot(clave); cargar() }}>
            <input type="password" value={clave} onChange={e => setClave(e.target.value)} placeholder="Clave" autoComplete="current-password" />
            <button className="diario-boton" type="submit">Entrar</button>
          </form>
        </section>
      </div>
    )
  }
  if (!datos) {
    return <div className="bot-page">{error ? <p className="bot-error">{error}</p> : <p className="bot-nota">Cargando…</p>}</div>
  }

  const { cuenta, reloj, posiciones, ordenes, paper } = datos
  const hoy = cuenta.equity != null && cuenta.equityAyer != null ? cuenta.equity - cuenta.equityAyer : null
  const abierto = posiciones.reduce((s, p) => s + (p.resultado ?? 0), 0)
  const abiertas = ordenes.filter(o => ABIERTA.has(o.estado) || o.patas.some(p => ABIERTA.has(p.estado)))
  // una orden y sus patas (el stop del OTO), en filas seguidas
  const filas = ordenes.flatMap(o => [o, ...o.patas.map(p => ({ ...p, pata: true }))])

  return (
    <div className="bot-page">
      <section className="bot-bloque">
        <h3>Alpaca {paper ? '· cuenta paper' : '· CUENTA REAL'}</h3>
        <p className="bot-nota">
          Acciones y ETF de EE. UU. en la cuenta {cuenta.numero} ({cuenta.estado?.toLowerCase()}). Ningún bot opera aquí: las órdenes son las que mandes a mano.
          {' '}El mercado está {reloj.abierto ? `abierto hasta las ${fechaHora(reloj.proximoCierre)}` : `cerrado; abre el ${fechaHora(reloj.proximaApertura)}`} (hora de Madrid). Se refresca cada 10 s.
        </p>
        {!paper && <p className="bot-error"><b>Ojo: es la cuenta real (ALPACA_REAL=1).</b></p>}
        {cuenta.bloqueada && <p className="bot-error">La cuenta tiene bloqueado operar.</p>}
        {error && <p className="bot-error">{error}</p>}
        <div className="bot-tarjeta-datos">
          <div className="bot-dato"><span>Equity</span><b className="bot-tile-valor">{num(cuenta.equity)} {cuenta.moneda}</b></div>
          <div className="bot-dato"><span>Hoy</span><b className={`bot-tile-valor ${tono(hoy)}`}>{dinero(hoy)}</b><small>frente al cierre de ayer</small></div>
          <div className="bot-dato"><span>Efectivo</span><b className="bot-tile-valor">{num(cuenta.efectivo)} {cuenta.moneda}</b></div>
          <div className="bot-dato"><span>Poder de compra</span><b className="bot-tile-valor">{num(cuenta.poderCompra)} {cuenta.moneda}</b></div>
          <div className="bot-dato"><span>Resultado abierto</span><b className={`bot-tile-valor ${tono(abierto)}`}>{dinero(posiciones.length ? abierto : null)}</b><small>{posiciones.length} posiciones</small></div>
        </div>
      </section>

      <section className="bot-bloque">
        <h3>Posiciones</h3>
        {posiciones.length === 0 ? <p className="bot-nota">No hay ninguna posición abierta.</p> : (
          <div className="velas-tabla-wrap tor-tabla-wrap">
            <table className="velas-tabla bot-tabla tor-tabla">
              <thead><tr><th>Símbolo</th><th>Lado</th><th className="tor-num">Acciones</th><th className="tor-num">Entrada</th><th className="tor-num">Ahora</th><th className="tor-num">Valor</th><th className="tor-num">Resultado</th><th className="tor-num">Hoy</th><th /></tr></thead>
              <tbody>
                {posiciones.map(p => (
                  <tr key={p.simbolo}>
                    <td className="bot-celda-texto"><b>{p.simbolo}</b></td>
                    <td className="bot-celda-texto"><span className={`bot-pill ${p.lado}`}>{p.lado === 'largo' ? 'Compra' : 'Venta'}</span></td>
                    <td className="tor-num">{cantidad(p.cantidad)}</td>
                    <td className="tor-num">{num(p.entrada)}</td>
                    <td className="tor-num">{num(p.precio)}</td>
                    <td className="tor-num">{num(Math.abs(p.valor ?? 0))}</td>
                    <td className={`tor-num ${tono(p.resultado)}`}>{dinero(p.resultado)} <small>({num(p.resultadoPct)} %)</small></td>
                    <td className={`tor-num ${tono(p.resultadoHoy)}`}>{dinero(p.resultadoHoy)}</td>
                    <td><button className="diario-boton bot-peligro" disabled={ocupado === p.simbolo}
                      onClick={() => accion(p.simbolo, `¿Cerrar a mercado ${cantidad(p.cantidad)} ${p.simbolo}? Se cancelan antes sus órdenes pendientes (su stop).`, `/api/bot/alpaca/posicion/${encodeURIComponent(p.simbolo)}`)}>Cerrar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bot-bloque">
        <h3>Nueva orden</h3>
        <p className="bot-nota">Alpaca no deja tener a la vez una compra y una venta pendientes en el mismo símbolo: el stop de una entrada va en «Stop de protección», que se manda junto con ella.</p>
        <Ticket alEnviar={cargar} />
      </section>

      <section className="bot-bloque">
        <h3>Órdenes {abiertas.length > 0 && <small className="bot-nota">({abiertas.length} abiertas)</small>}</h3>
        {filas.length === 0 ? <p className="bot-nota">Todavía no hay órdenes.</p> : (
          <div className="velas-tabla-wrap tor-tabla-wrap">
            <table className="velas-tabla bot-tabla tor-tabla">
              <thead><tr><th>Creada</th><th>Símbolo</th><th>Lado</th><th>Tipo</th><th className="tor-num">Tamaño</th><th className="tor-num">Precio</th><th>Estado</th><th /></tr></thead>
              <tbody>
                {filas.map(o => (
                  <tr key={o.id}>
                    <td className="bot-celda-texto">{o.pata ? <span className="bot-nota">└ su stop</span> : fechaHora(o.creada)}</td>
                    <td className="bot-celda-texto"><b>{o.simbolo}</b></td>
                    <td className="bot-celda-texto">{o.lado}</td>
                    <td className="bot-celda-texto">{TIPOS[o.tipo] ?? o.tipo}{o.clase === 'oto' && !o.pata ? ' + stop' : ''}</td>
                    <td className="tor-num">{o.importe != null ? `${num(o.importe)} $` : cantidad(o.cantidad)}{o.rellena > 0 && o.rellena !== o.cantidad ? <small> ({cantidad(o.rellena)})</small> : null}</td>
                    <td className="tor-num">{precioDeOrden(o)}</td>
                    <td className={`bot-celda-texto ${o.estado === 'filled' ? 'bot-pos' : o.estado === 'rejected' ? 'bot-neg' : ''}`}>{ESTADOS[o.estado] ?? o.estado}</td>
                    <td>{ABIERTA.has(o.estado) && (
                      <button className="diario-boton bot-peligro" disabled={ocupado === o.id}
                        onClick={() => accion(o.id, `¿Cancelar la orden de ${o.lado} de ${o.simbolo}?`, `/api/bot/alpaca/orden/${o.id}`)}>Cancelar</button>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
