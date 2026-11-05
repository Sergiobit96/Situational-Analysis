import { useEffect, useState, useCallback } from 'react'
import { conClaveBot, guardarClaveBot } from './claveBot'
import './Bot.css'

// Interactive Brokers (server/ib.js, /api/bot/ib): la conexión con el IB Gateway de este PC, la
// cuenta, las posiciones, las órdenes y un ticket para lanzarlas a mano. Ningún bot opera aquí.

const num = (n, dec = 2) => (n == null ? '—' : n.toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec }))
const dinero = (n, moneda = '') => (n == null ? '—' : `${n > 0 ? '+' : ''}${num(n)} ${moneda}`.trim())
const cantidad = n => (n == null ? '—' : n.toLocaleString('es-ES', { maximumFractionDigits: 4 }))
const tono = n => (n == null ? '' : n > 0 ? 'bot-pos' : n < 0 ? 'bot-neg' : '')
const fechaHora = iso => (iso ? new Date(iso).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')

const TIPOS = { market: 'Mercado', limit: 'Límite', stop: 'Stop', stop_limit: 'Stop límite' }
const INSTRUMENTOS = { STK: 'Acción / ETF', FUT: 'Futuro', CASH: 'Divisa', CFD: 'CFD' }
const ABIERTA = new Set(['enviando', 'pendiente', 'cancelando'])

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

const TICKET_INICIAL = { simbolo: 'SPY', instrumento: 'STK', bolsa: 'SMART', moneda: 'USD', vencimiento: '', lado: 'compra', cantidad: '1', tipo: 'market', limite: '', stop: '', validez: 'day', stopLoss: '', fueraDeHorario: false }

function Ticket({ alEnviar, cuenta }) {
  const [t, setT] = useState(TICKET_INICIAL)
  const [enviando, setEnviando] = useState(false)
  const [resultado, setResultado] = useState(null)
  const cambiar = campo => e => setT(v => ({ ...v, [campo]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const conLimite = t.tipo === 'limit' || t.tipo === 'stop_limit'
  const conStop = t.tipo === 'stop' || t.tipo === 'stop_limit'

  async function enviar(e) {
    e.preventDefault()
    const orden = {
      simbolo: t.simbolo, instrumento: t.instrumento, bolsa: t.bolsa, moneda: t.moneda, lado: t.lado, tipo: t.tipo, validez: t.validez, cantidad: t.cantidad,
      ...(t.instrumento === 'FUT' ? { vencimiento: t.vencimiento } : {}),
      ...(conLimite ? { limite: t.limite } : {}), ...(conStop ? { stop: t.stop } : {}),
      ...(t.stopLoss ? { stopLoss: t.stopLoss } : {}), ...(t.fueraDeHorario ? { fueraDeHorario: true } : {}),
    }
    if (!window.confirm(`¿${t.lado === 'compra' ? 'Comprar' : 'Vender'} ${t.cantidad} ${t.simbolo.toUpperCase()} (${TIPOS[t.tipo].toLowerCase()})${t.stopLoss ? ` con stop en ${t.stopLoss}` : ''} en la cuenta ${cuenta} de IB?`)) return
    setEnviando(true)
    try {
      const patas = await pedir('/api/bot/ib/orden', { method: 'POST', body: JSON.stringify(orden) })
      const mal = patas.find(o => o.motivo)
      setResultado(mal ? { ok: false, texto: `IB la rechazó: ${mal.motivo}` } : { ok: true, texto: `Orden enviada: ${patas.map(o => o.estado).join(' + ')}.` })
      alEnviar()
    } catch (err) {
      setResultado({ ok: false, texto: err.message })
    } finally { setEnviando(false) }
  }

  return (
    <form className="bot-form" onSubmit={enviar}>
      <label>Símbolo<input value={t.simbolo} onChange={cambiar('simbolo')} placeholder="SPY" required /></label>
      <label>Instrumento
        <select value={t.instrumento} onChange={cambiar('instrumento')}>{Object.entries(INSTRUMENTOS).map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>
      </label>
      <label title="SMART elige la mejor bolsa (acciones). Futuros: CME, CBOT, EUREX…">Bolsa<input value={t.bolsa} onChange={cambiar('bolsa')} /></label>
      <label>Moneda<input value={t.moneda} onChange={cambiar('moneda')} maxLength={3} /></label>
      {t.instrumento === 'FUT' && <label>Vencimiento (AAAAMM)<input value={t.vencimiento} onChange={cambiar('vencimiento')} placeholder="202612" required /></label>}
      <label>Lado
        <select value={t.lado} onChange={cambiar('lado')}><option value="compra">Compra</option><option value="venta">Venta (corto si no hay posición)</option></select>
      </label>
      <label>Tipo
        <select value={t.tipo} onChange={cambiar('tipo')}>{Object.entries(TIPOS).map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>
      </label>
      <label>Cantidad<input type="number" step="any" min="0" value={t.cantidad} onChange={cambiar('cantidad')} required /></label>
      {conStop && <label>Precio del stop<input type="number" step="any" min="0" value={t.stop} onChange={cambiar('stop')} required /></label>}
      {conLimite && <label>Precio límite<input type="number" step="any" min="0" value={t.limite} onChange={cambiar('limite')} required /></label>}
      <label>Validez
        <select value={t.validez} onChange={cambiar('validez')}><option value="day">El día</option><option value="gtc">Hasta cancelar</option><option value="ioc">Inmediata o cancelar</option></select>
      </label>
      <label title="Va como hija de la entrada (bracket): IB no la activa hasta que se ejecuta la entrada">
        Stop de protección (opcional)<input type="number" step="any" min="0" value={t.stopLoss} onChange={cambiar('stopLoss')} placeholder="sin stop" />
      </label>
      <label><span><input type="checkbox" checked={t.fueraDeHorario} onChange={cambiar('fueraDeHorario')} /> También fuera de horario</span></label>
      <div className="bot-botones" style={{ alignItems: 'flex-end' }}>
        <button className="diario-boton" type="submit" disabled={enviando}>{enviando ? 'Enviando…' : 'Enviar orden'}</button>
      </div>
      {resultado && <p className={resultado.ok ? 'bot-pos' : 'bot-error'} style={{ gridColumn: '1 / -1' }}>{resultado.texto}</p>}
    </form>
  )
}

const QUE = { ejecucion: 'Ejecución', puesta: 'Orden puesta', modificada: 'Orden movida', cancelada: 'Cancelada', rechazada: 'Rechazada' }
const FILTROS = { todo: 'Todo', ejecucion: 'Ejecuciones', ordenes: 'Órdenes', cancelada: 'Cancelaciones y rechazos' }
const fechaLarga = iso => (iso ? new Date(iso).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—')
// quién mandó la orden: un bot (por el prefijo de su referencia) o a mano
const quien = ref => (!ref ? 'fuera del servidor' : /^TIB/.test(ref) ? 'Tortugas IB' : /^SA-/.test(ref) ? 'a mano (esta vista)' : ref)

// Lo que ha pasado en la cuenta (server/historial-ib.js): se guarda en el servidor, así que no
// se pierde con los reinicios; IB solo da las ejecuciones del día
function Historial() {
  const [lista, setLista] = useState(null)
  const [error, setError] = useState(null)
  const [filtro, setFiltro] = useState('todo')
  const [cuantas, setCuantas] = useState(100)

  useEffect(() => {
    let vivo = true
    const cargar = () => pedir('/api/bot/ib/historial?limite=5000')
      .then(j => { if (vivo) { setLista(j.historial); setError(null) } })
      .catch(err => { if (vivo) setError(err.message) })
    cargar()
    const reloj = setInterval(cargar, 15000)
    return () => { vivo = false; clearInterval(reloj) }
  }, [])

  if (!lista) return <section className="bot-bloque"><h3>Historial</h3>{error ? <p className="bot-error">{error}</p> : <p className="bot-nota">Cargando…</p>}</section>
  const filtradas = lista.filter(x => filtro === 'todo' || (filtro === 'ordenes' ? x.tipo !== 'ejecucion' : filtro === 'cancelada' ? x.tipo === 'cancelada' || x.tipo === 'rechazada' : x.tipo === filtro))
  return (
    <section className="bot-bloque">
      <h3>Historial <small className="bot-nota">({lista.length} apuntes)</small></h3>
      <p className="bot-nota">
        Desde el 5-nov-2026: ejecuciones con su comisión y resultado realizado, y las órdenes puestas, movidas, canceladas y rechazadas.
        En una cancelación, «servidor» es que la pidió un bot o esta vista; «fuera», que vino de la app o la web de IB (u otro programa).
      </p>
      <div className="estrategias-nav pos-vistas">
        {Object.entries(FILTROS).map(([k, t]) => <button key={k} className={`estrategia-chip ${filtro === k ? 'activo' : ''}`} onClick={() => setFiltro(k)}>{t}</button>)}
      </div>
      {error && <p className="bot-error">{error}</p>}
      {filtradas.length === 0 ? <p className="bot-nota">Nada apuntado todavía.</p> : <>
        <div className="velas-tabla-wrap tor-tabla-wrap">
          <table className="velas-tabla bot-tabla tor-tabla">
            <thead><tr><th>Hora</th><th>Qué</th><th>Contrato</th><th>Lado</th><th className="tor-num">Cantidad</th><th className="tor-num">Precio</th><th>De</th><th>Detalle</th></tr></thead>
            <tbody>
              {filtradas.slice(0, cuantas).map((x, i) => (
                <tr key={`${x.tipo}-${x.execId ?? x.orderId}-${x.hora}-${i}`}>
                  <td className="bot-celda-texto">{fechaLarga(x.hora)}</td>
                  <td className={`bot-celda-texto ${x.tipo === 'ejecucion' ? 'bot-pos' : x.tipo === 'rechazada' || (x.tipo === 'cancelada' && x.origen === 'fuera') ? 'bot-neg' : ''}`}>{QUE[x.tipo] ?? x.tipo}{x.orden && x.tipo !== 'ejecucion' ? <small className="bot-nota"> · {TIPOS[x.orden]?.toLowerCase() ?? x.orden}</small> : null}</td>
                  <td className="bot-celda-texto"><b>{x.simbolo ?? '—'}</b>{x.orderId != null && <small className="bot-nota"> #{x.orderId}</small>}</td>
                  <td className="bot-celda-texto">{x.lado ?? '—'}</td>
                  <td className="tor-num">{cantidad(x.cantidad)}</td>
                  <td className="tor-num">{x.precio != null ? num(x.precio, x.precio < 20 ? 4 : 2) : '—'}</td>
                  <td className="bot-celda-texto" title={x.referencia ?? ''}>{quien(x.referencia)}</td>
                  <td className="bot-celda-texto">
                    {x.tipo === 'ejecucion' && <>
                      {x.comision != null && <>comisión {num(x.comision)} {x.moneda ?? ''}</>}
                      {x.realizado != null && <> · <span className={tono(x.realizado)}>realizado {dinero(x.realizado, x.moneda ?? '')}</span></>}
                    </>}
                    {x.tipo === 'cancelada' && <span className={x.origen === 'fuera' ? 'bot-neg' : ''}>{x.origen === 'fuera' ? 'fuera (app/web de IB)' : 'servidor'}</span>}
                    {x.motivo && <small className="bot-nota"> {x.motivo}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtradas.length > cuantas && <div className="bot-botones"><button className="diario-boton" onClick={() => setCuantas(c => c + 200)}>Ver más ({filtradas.length - cuantas})</button></div>}
      </>}
    </section>
  )
}

function SinConexion({ datos }) {
  const local = /^(127\.0\.0\.1|localhost|::1)$/.test(datos.host)
  return (
    <section className="bot-bloque">
      <h3>Interactive Brokers · sin conexión</h3>
      <p className="bot-error">{datos.error ?? 'No conectado'}</p>
      {local ? <>
        <p className="bot-nota">
          El servidor se conecta al IB Gateway (o la TWS) abierto en este PC, en {datos.host}:{datos.port} con el client id {datos.clientId}. Para que conecte:
        </p>
        <ol className="bot-nota">
          <li>Abre el IB Gateway, elige <b>IB API</b> y <b>Paper Trading</b>, y entra con el usuario de la cuenta paper.</li>
          <li>En Configure → Settings → API → Settings: quita «Read-Only API», deja el puerto en {datos.port} y 127.0.0.1 en «Trusted IPs».</li>
          <li>Esta vista vuelve a probar sola cada pocos segundos.</li>
        </ol>
      </> : (
        <p className="bot-nota">
          El servidor se conecta al servicio del IB Gateway en {datos.host}:{datos.port}. Si acaba de arrancar o se está reiniciando (lo hace cada noche), tarda un par de minutos en entrar en IB; esta vista vuelve a probar sola.
          Si IB ha cerrado su sesión porque se ha entrado con el mismo usuario en otro sitio, vuelve a entrar solo al cabo de un rato.
        </p>
      )}
      {datos.avisos?.length > 0 && <p className="bot-nota">Último aviso de IB: {datos.avisos[0].texto}</p>}
    </section>
  )
}

export default function IB() {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const [pideClave, setPideClave] = useState(false)
  const [clave, setClave] = useState('')
  const [ocupado, setOcupado] = useState(null)

  const cargar = useCallback(async () => {
    try {
      setDatos(await pedir('/api/bot/ib'))
      setError(null)
      setPideClave(false)
    } catch (err) {
      setError(err.message)
      if (err.necesitaClave) setPideClave(true)
    }
  }, [])

  // al abrir la vista y cada 5 s (el servidor ya lo tiene en memoria: no gasta peticiones de IB)
  useEffect(() => {
    const primera = setTimeout(cargar, 0)
    const reloj = setInterval(cargar, 5000)
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
    return <div className="bot-page">{error ? <p className="bot-error">{error}</p> : <p className="bot-nota">Conectando con IB…</p>}</div>
  }
  if (!datos.conectado) return <div className="bot-page"><SinConexion datos={datos} /></div>

  const { cuenta, paper, puedeOperar, resumen: r, posiciones, ordenes, avisos } = datos
  const abiertas = ordenes.filter(o => ABIERTA.has(o.estado))
  const stopsDe = p => abiertas.filter(o => o.conId === p.id && (o.tipo === 'stop' || o.tipo === 'stop_limit') && o.lado === (p.lado === 'largo' ? 'venta' : 'compra'))
  // lo que quedaría desde la entrada si saltan sus stops a su precio (sin deslizamiento), y
  // cuánta posición cubren
  const siSaltaStop = p => {
    if (p.entrada == null || p.aumentoPrecio == null) return null
    const signo = p.lado === 'largo' ? 1 : -1
    let total = 0, cubierta = 0
    for (const o of stopsDe(p)) {
      const q = Math.min((o.cantidad ?? 0) - (o.rellena ?? 0), p.cantidad - cubierta)
      if (!(q > 0) || o.stop == null) continue
      total += signo * (o.stop / (p.aumentoPrecio ?? 1) - p.entrada) * q * (p.multiplicador ?? 1)
      cubierta += q
    }
    return cubierta ? { total, cubierta } : null
  }

  return (
    <div className="bot-page">
      <section className="bot-bloque">
        <h3>Interactive Brokers {paper ? '· cuenta paper' : '· CUENTA REAL'}</h3>
        <p className="bot-nota">
          Cuenta {cuenta}, conectada al IB Gateway en {datos.host}:{datos.port} desde el {fechaHora(datos.desde)}. Aquí operan Tortugas IB (referencias TIB…) y las órdenes que mandes a mano. Se refresca cada 5 s.
        </p>
        {!paper && <p className="bot-error"><b>Ojo: es una cuenta real.</b> {puedeOperar ? 'IB_REAL=1 está puesto: las órdenes salen con dinero de verdad.' : 'Las órdenes están bloqueadas (solo salen con IB_REAL=1).'}</p>}
        {error && <p className="bot-error">{error}</p>}
        <div className="bot-tarjeta-datos">
          <div className="bot-dato"><span>Valor de liquidación</span><b className="bot-tile-valor">{num(r.liquidacion)} {r.moneda}</b></div>
          <div className="bot-dato"><span>Efectivo</span><b className="bot-tile-valor">{num(r.efectivo)} {r.moneda}</b></div>
          <div className="bot-dato"><span>Poder de compra</span><b className="bot-tile-valor">{num(r.poderCompra)} {r.moneda}</b></div>
          <div className="bot-dato"><span>Resultado abierto</span><b className={`bot-tile-valor ${tono(r.latente)}`}>{dinero(r.latente, r.moneda)}</b><small>{posiciones.length} posiciones</small></div>
          <div className="bot-dato"><span>Realizado hoy</span><b className={`bot-tile-valor ${tono(r.realizado)}`}>{dinero(r.realizado, r.moneda)}</b></div>
        </div>
      </section>

      <section className="bot-bloque">
        <h3>Posiciones</h3>
        {posiciones.length === 0 ? <p className="bot-nota">No hay ninguna posición abierta.</p> : (
          <div className="velas-tabla-wrap tor-tabla-wrap">
            <table className="velas-tabla bot-tabla tor-tabla">
              <thead><tr><th>Contrato</th><th>Lado</th><th className="tor-num">Cantidad</th><th className="tor-num">Entrada</th><th className="tor-num">Ahora</th><th className="tor-num">Stop</th><th className="tor-num">Valor</th><th className="tor-num" title="Ganancia o pérdida abierta que calcula IB con el precio de ahora">Resultado</th><th className="tor-num" title="Lo que quedaría desde la entrada si saltan los stops a su precio, sin deslizamiento">Si salta el stop</th><th /></tr></thead>
              <tbody>
                {posiciones.map(p => (
                  <tr key={p.id}>
                    <td className="bot-celda-texto"><b>{p.simbolo}</b> <small className="bot-nota">{p.moneda}</small>{p.nombre && <><br /><small className="bot-nota">{p.nombre}</small></>}</td>
                    <td className="bot-celda-texto"><span className={`bot-pill ${p.lado}`}>{p.lado === 'largo' ? 'Compra' : 'Venta'}</span></td>
                    <td className="tor-num">{cantidad(p.cantidad)}</td>
                    <td className="tor-num">{num(p.entrada)}</td>
                    <td className="tor-num">{num(p.precio)}</td>
                    <td className={`tor-num ${stopsDe(p).length ? '' : 'bot-neg'}`}>{stopsDe(p).length ? stopsDe(p).map(o => p.aumentoPrecio == null ? `${num(o.stop)} (en las unidades de la orden)` : num(o.stop / p.aumentoPrecio, p.aumentoPrecio > 1 ? 4 : 2)).join(' · ') : 'sin stop'}</td>
                    <td className="tor-num">{num(Math.abs(p.valor ?? 0))}</td>
                    <td className={`tor-num ${tono(p.resultado)}`}>{dinero(p.resultado)} {p.resultadoPct != null && <small>({num(p.resultadoPct)} %)</small>}</td>
                    {(s => <td className={`tor-num ${s ? tono(s.total) : p.aumentoPrecio == null ? '' : 'bot-neg'}`} title={p.aumentoPrecio == null ? 'Faltan los detalles del contrato (IB aún no los ha dado)' : undefined}>{s ? dinero(s.total) : p.aumentoPrecio == null ? '—' : 'sin stop'}{s && s.cubierta < p.cantidad && <small> (solo {cantidad(s.cubierta)} de {cantidad(p.cantidad)})</small>}</td>)(siSaltaStop(p))}
                    <td>{puedeOperar && <button className="diario-boton bot-peligro" disabled={ocupado === p.id}
                      onClick={() => accion(p.id, `¿Cerrar a mercado ${cantidad(p.cantidad)} ${p.simbolo}${p.nombre ? ` (${p.nombre})` : ''}? Se cancelan antes sus órdenes pendientes (su stop).`, `/api/bot/ib/posicion/${p.id}`)}>Cerrar</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {puedeOperar && (
        <section className="bot-bloque">
          <h3>Nueva orden</h3>
          <p className="bot-nota">El stop de protección va como hija de la entrada (bracket): la entrada no llega a IB sin él.</p>
          <Ticket alEnviar={cargar} cuenta={cuenta} />
        </section>
      )}

      <section className="bot-bloque">
        <h3>Órdenes {abiertas.length > 0 && <small className="bot-nota">({abiertas.length} abiertas)</small>}</h3>
        {ordenes.length === 0 ? <p className="bot-nota">No hay órdenes abiertas ni mandadas desde que arrancó el servidor.</p> : (
          <div className="velas-tabla-wrap tor-tabla-wrap">
            <table className="velas-tabla bot-tabla tor-tabla">
              <thead><tr><th>Id</th><th>Contrato</th><th>Lado</th><th>Tipo</th><th className="tor-num">Cantidad</th><th className="tor-num">Precio</th><th>Estado</th><th /></tr></thead>
              <tbody>
                {ordenes.map(o => (
                  <tr key={o.id}>
                    <td className="bot-celda-texto">{o.padre ? <span className="bot-nota">└ {o.id}</span> : o.id}</td>
                    <td className="bot-celda-texto"><b>{o.simbolo}</b></td>
                    <td className="bot-celda-texto">{o.lado}</td>
                    <td className="bot-celda-texto">{TIPOS[o.tipo] ?? o.tipo}</td>
                    <td className="tor-num">{cantidad(o.cantidad)}{o.rellena > 0 && o.rellena !== o.cantidad ? <small> ({cantidad(o.rellena)})</small> : null}</td>
                    <td className="tor-num">{precioDeOrden(o)}</td>
                    <td className={`bot-celda-texto ${o.estado === 'ejecutada' ? 'bot-pos' : o.estado === 'rechazada' || o.estado === 'inactiva' ? 'bot-neg' : ''}`} title={o.motivo ?? ''}>{o.estado}{o.motivo ? ' ⓘ' : ''}</td>
                    <td>{ABIERTA.has(o.estado) && (
                      <button className="diario-boton bot-peligro" disabled={ocupado === o.id}
                        onClick={() => accion(o.id, `¿Cancelar la orden ${o.id} de ${o.lado} de ${o.simbolo}?`, `/api/bot/ib/orden/${o.id}`)}>Cancelar</button>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Historial />

      {avisos.length > 0 && (
        <section className="bot-bloque">
          <h3>Avisos de IB</h3>
          <ul className="bot-nota">{avisos.map((a, i) => <li key={i}>{fechaHora(a.hora)} · {a.codigo != null ? `[${a.codigo}] ` : ''}{a.texto}</li>)}</ul>
        </section>
      )}
    </div>
  )
}
