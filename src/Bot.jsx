import { useEffect, useState, useCallback, useMemo } from 'react'
import { analizarSesion } from './segundaVelaCore'
import './Bot.css'

// Pestaña Bot: el bot SRS que opera en la demo de IG (server/bot-srs.js) en varias sesiones
// del día. Enseña las sesiones de hoy, el historial al lado de lo que habría hecho el
// backtest (calculado aquí, con el mismo motor que la pestaña Estrategias, sobre las velas
// que el bot guarda al cierre) y la configuración. En producción el servidor pide una clave.

const ESTADOS = {
  'esperando-bracket': 'Esperando a la vela del bracket',
  'esperando-rotura':  'Bracket listo: esperando la rotura',
  'entrando':          'Mandando la orden…',
  'en-posicion':       'Dentro',
  'terminado':         'Terminada',
  'sin-operar':        'No opera',
}
const MOTIVOS = { stop: 'stop', breakeven: 'break even', cierre: 'cierre', manual: 'a mano', objetivo: 'objetivo', bracket: 'stop' }
const CLAVE = 'sa.bot.token'

const num = (n, dec = 1) => n.toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec })
const pts = n => (n == null ? '—' : `${n > 0 ? '+' : ''}${num(n)}`)
const eur = n => (n == null ? '—' : `${n > 0 ? '+' : ''}${num(n, 0)} €`)
const precio = n => (n == null ? '—' : num(n))
const hora = iso => new Date(iso).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid' })
const fechaHora = ts => new Date(ts * 1000).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const tono = n => (n == null ? '' : n > 0 ? 'bot-pos' : n < 0 ? 'bot-neg' : '')

function leerClave() { try { return localStorage.getItem(CLAVE) ?? '' } catch { return '' } }

async function pedir(url, opciones = {}) {
  const r = await fetch(url, { ...opciones, headers: { ...opciones.headers, 'X-Bot-Token': leerClave() } })
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
  if (!r.ok || j.error) {
    const err = new Error(j.error ?? `HTTP ${r.status}`)
    err.necesitaClave = !!j.necesitaClave
    throw err
  }
  return j
}

// Lo que habría hecho el backtest esa sesión, con la configuración del día
function backtestDe(d) {
  if (!d.velas?.length) return null
  const velas = d.velas.map(([time, open, high, low, close]) => ({ time, open, high, low, close }))
  const a = analizarSesion({ velas, ticker: d.ticker, modo: d.config.modo, stopPct: d.config.stopPct, beR: d.config.beR, piramide: 0, tpPct: null, ventana: d.ventana })
  if (!a.valido) return { valido: false, motivo: a.motivo }
  return { valido: true, lado: a.lado, entrada: a.entrada?.precio ?? null, resultadoPts: a.entrada ? a.resultadoPts : null, motivo: a.salida?.motivo ?? null }
}

export default function Bot() {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const [pideClave, setPideClave] = useState(false)
  const [clave, setClave] = useState('')
  const [form, setForm] = useState(null)
  const [ocupado, setOcupado] = useState(false)
  const [ensayo, setEnsayo] = useState(null)
  const [ensayoTicker, setEnsayoTicker] = useState('^GDAXI')

  const cargar = useCallback(async () => {
    try {
      setDatos(await pedir('/api/bot'))
      setError(null)
      setPideClave(false)
    } catch (err) {
      setError(err.message)
      if (err.necesitaClave) setPideClave(true)
    }
  }, [])

  // al abrir la pestaña y cada 5 s: el bot cambia solo (bracket, entrada, cierre)
  useEffect(() => {
    const primera = setTimeout(cargar, 0)
    const reloj = setInterval(cargar, 5000)
    return () => { clearTimeout(primera); clearInterval(reloj) }
  }, [cargar])

  const historial = useMemo(() => (datos?.historial ?? []).map(d => ({ ...d, backtest: backtestDe(d) })), [datos])

  const accion = async fn => {
    setOcupado(true)
    try { await fn(); await cargar() } catch (err) { setError(err.message) } finally { setOcupado(false) }
  }
  const guardarConfig = cambios => accion(() => pedir('/api/bot/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cambios),
  }))
  const pararYCerrar = () => {
    if (!window.confirm('¿Apagar el bot y cerrar ahora todo lo que tenga abierto?')) return
    accion(() => pedir('/api/bot/parar', { method: 'POST' }))
  }
  const ensayar = () => {
    if (!window.confirm('El ensayo abre y cierra en la demo la posición mínima del instrumento, para comprobar que IG acepta las órdenes del bot. Se paga la horquilla (dinero de la demo). ¿Seguir?')) return
    setEnsayo({ cargando: true })
    accion(async () => {
      try {
        const r = await pedir('/api/bot/ensayo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticker: ensayoTicker }) })
        setEnsayo({ pasos: r.pasos })
      } catch (err) { setEnsayo({ error: err.message }) }
    })
  }

  if (pideClave) {
    return (
      <div className="bot-page">
        <section className="bot-bloque bot-clave">
          <h3>Clave del bot</h3>
          <p className="bot-nota">El servidor de producción pide la clave del bot (la variable BOT_TOKEN de Railway). Se guarda en este navegador.</p>
          {error && <p className="bot-error">{error}</p>}
          <form onSubmit={e => { e.preventDefault(); try { localStorage.setItem(CLAVE, clave) } catch { /* sin almacenamiento */ } cargar() }}>
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

  const { config, hoy, sesiones, ig, opera } = datos
  const editando = form ?? config
  const cambiar = (campo, valor) => setForm({ ...editando, [campo]: valor })
  const nombre = t => sesiones.find(s => s.ticker === t)?.nombre ?? t
  const operados = historial.filter(d => d.resultadoPts != null)
  const totalEur = operados.reduce((n, d) => n + (d.resultadoEur ?? 0), 0)

  return (
    <div className="bot-page">
      <section className="bot-cabecera">
        <div>
          <div className={`bot-interruptor ${config.activo ? 'encendido' : ''}`}>{config.activo ? '● Encendido' : '○ Apagado'}</div>
          <p className="bot-nota">SRS · demo de IG (dinero ficticio) · cuenta {ig.cuenta ?? '—'} · {ig.streaming}</p>
          {!opera && <p className="bot-aviso">Este servidor no opera (BOT_OPERA no es 1): el registro es el suyo, pero las órdenes las manda el servidor que tenga BOT_OPERA=1.</p>}
        </div>
        <div className="bot-botones">
          <button className="diario-boton" disabled={ocupado} onClick={() => guardarConfig({ activo: !config.activo })}>{config.activo ? 'Apagar' : 'Encender'}</button>
          <button className="diario-boton bot-peligro" disabled={ocupado} onClick={pararYCerrar}>Parar y cerrar todo</button>
        </div>
      </section>

      {error && <p className="bot-error">{error}</p>}

      <section className="bot-bloque">
        <h3>Sesiones</h3>
        <div className="bot-sesiones">
          {sesiones.map(s => (
            <label key={s.ticker} className={`bot-sesion ${s.encendido ? 'encendida' : ''}`}>
              <input type="checkbox" checked={s.encendido} disabled={ocupado}
                onChange={e => guardarConfig({ instrumentos: { [s.ticker]: e.target.checked } })} />
              <span className="bot-sesion-nombre">{s.nombre}</span>
              <span className="bot-sesion-hora">{s.proxima ? `abre ${fechaHora(s.proxima)}` : '—'}</span>
            </label>
          ))}
        </div>
        <p className="bot-nota">Horas de Madrid. Cada sesión abre a la hora de su bolsa: Tokio 09:00, Fráncfort 09:00, Londres 08:00 y Nueva York 09:30.</p>
      </section>

      <section className="bot-bloque">
        <h3>Hoy</h3>
        {hoy.length === 0 ? (
          <p className="bot-nota">{config.activo ? 'Ninguna sesión empezada todavía.' : 'El bot está apagado: enciéndelo para que opere las próximas sesiones.'}</p>
        ) : hoy.map(d => <SesionHoy key={d.clave} d={d} nombre={nombre(d.ticker)} />)}
      </section>

      <section className="bot-bloque">
        <h3>Historial</h3>
        {historial.length === 0 ? <p className="bot-nota">Todavía no hay sesiones anteriores.</p> : (
          <>
            <p className="bot-nota">{operados.length} sesiones con operación · resultado del bot <b className={tono(totalEur)}>{eur(totalEur)}</b> (demo)</p>
            <div className="velas-tabla-wrap">
              <table className="velas-tabla bot-tabla">
                <thead>
                  <tr><th>Sesión</th><th>Instrumento</th><th>Operación</th><th>Entrada</th><th>Deslizamiento</th><th>Salida</th><th>Bot</th><th>€</th><th>Backtest</th><th>Nota</th></tr>
                </thead>
                <tbody>
                  {historial.map(d => {
                    const bt = d.backtest
                    return (
                      <tr key={d.clave}>
                        <td>{d.fecha}</td>
                        <td className="bot-celda-texto">{nombre(d.ticker)}</td>
                        <td className="bot-celda-texto">{d.operacion ? (d.operacion.lado === 'largo' ? 'Compra' : 'Venta') : '—'}</td>
                        <td>{precio(d.operacion?.entrada)}</td>
                        <td>{pts(d.operacion?.deslizamiento)}</td>
                        <td>{d.salida ? `${precio(d.salida.nivel)} (${MOTIVOS[d.salida.motivo] ?? d.salida.motivo}${d.salida.aproximado ? ', aprox.' : ''})` : '—'}</td>
                        <td className={tono(d.resultadoPts)}>{pts(d.resultadoPts)}</td>
                        <td className={tono(d.resultadoEur)}>{eur(d.resultadoEur)}</td>
                        <td className={tono(bt?.resultadoPts)} title={bt?.valido === false ? bt.motivo : bt?.lado ? `${bt.lado}, ${bt.motivo}` : ''}>
                          {bt == null ? '—' : !bt.valido ? 'no calculable' : bt.resultadoPts == null ? 'sin entrada' : pts(bt.resultadoPts)}
                        </td>
                        <td className="bot-nota-celda">{d.estado === 'sin-operar' ? d.eventos?.at(-1)?.texto : ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="bot-bloque">
        <h3>Configuración</h3>
        <div className="bot-form">
          <label>Operativa
            <select value={editando.modo} onChange={e => cambiar('modo', e.target.value)}>
              <option value="ambos">Compra o venta (la 1.ª rotura)</option>
              <option value="largo">Solo compras</option>
            </select>
          </label>
          <label>Stop
            <select value={editando.stopPct} onChange={e => cambiar('stopPct', Number(e.target.value))}>
              <option value={1}>Al otro lado del bracket</option>
              <option value={0.5}>A mitad del bracket</option>
            </select>
          </label>
          <label>Break even
            <select value={editando.beR ?? ''} onChange={e => cambiar('beR', e.target.value === '' ? null : Number(e.target.value))}>
              <option value="">No</option>
              <option value={1}>Al recorrer 1R</option>
              <option value={2}>Al recorrer 2R</option>
            </select>
          </label>
          <label>Riesgo por operación (€)
            <input type="number" min="1" max="5000" value={editando.riesgoEur} onChange={e => cambiar('riesgoEur', e.target.value)} />
          </label>
          <label>Bracket máximo (% del precio)
            <input type="number" min="0.01" max="10" step="0.1" value={editando.rangoMaxPct} onChange={e => cambiar('rangoMaxPct', e.target.value)} />
          </label>
        </div>
        <p className="bot-nota">
          El tamaño sale del riesgo: lo que se pierde si salta el stop. Si el mínimo de IG obliga a arriesgar más del doble, esa sesión no entra.
          Las órdenes van a mercado: lo que se paga de más respecto al nivel de la rotura se ve en la columna Deslizamiento.
          Un cambio vale para las sesiones que aún no han fijado su bracket.
        </p>
        <button className="diario-boton" disabled={ocupado || !form} onClick={() => {
          const { modo, stopPct, beR, riesgoEur, rangoMaxPct } = form
          guardarConfig({ modo, stopPct, beR, riesgoEur, rangoMaxPct }).then(() => setForm(null))
        }}>Guardar configuración</button>
      </section>

      <section className="bot-bloque">
        <h3>Ensayo de órdenes</h3>
        <p className="bot-nota">Abre y cierra la posición mínima en la demo para comprobar que IG acepta las órdenes del bot en ese instrumento. Necesita el mercado abierto.</p>
        <div className="bot-botones">
          <select className="bot-select" value={ensayoTicker} onChange={e => setEnsayoTicker(e.target.value)}>
            {sesiones.map(s => <option key={s.ticker} value={s.ticker}>{s.nombre}</option>)}
          </select>
          <button className="diario-boton" disabled={ocupado} onClick={ensayar}>Ensayar órdenes</button>
        </div>
        {ensayo?.cargando && <p className="bot-nota">Probando…</p>}
        {ensayo?.error && <p className="bot-error">{ensayo.error}</p>}
        {ensayo?.pasos && <ul className="bot-eventos">{ensayo.pasos.map((p, i) => <li key={i}>{p}</li>)}</ul>}
      </section>
    </div>
  )
}

function SesionHoy({ d, nombre }) {
  const { plan, operacion: op } = d
  return (
    <div className="bot-hoy">
      <div className="bot-hoy-cab">
        <strong>{nombre}</strong>
        <span className="bot-nota">{d.fecha} · abre {fechaHora(d.abre)}</span>
      </div>
      <div className="estr-tiles">
        <Tile label="Estado" valor={ESTADOS[d.estado] ?? d.estado} sub={d.recuperada ? 'recuperada de IG al arrancar' : ''} />
        <Tile label="Bracket" valor={d.bracket ? `${precio(d.bracket.low)} – ${precio(d.bracket.high)}` : '—'} sub={d.bracket ? `${precio(d.bracket.rango)} puntos` : ''} />
        <Tile label="Plan" valor={plan ? `${plan.tamano} contratos` : '—'} sub={plan ? `${plan.valorPunto} ${plan.moneda}/punto · ${Math.round(plan.riesgoEur)} € de riesgo` : ''} />
        <Tile label="Operación" valor={op ? `${op.lado === 'largo' ? 'Compra' : 'Venta'} a ${precio(op.entrada)}` : '—'}
          sub={op ? `stop ${precio(op.stop)}${op.be ? ' (break even)' : ''} · deslizamiento ${pts(op.deslizamiento)}` : ''} />
        <Tile label="Resultado" valor={pts(d.resultadoPts)} tonoValor={tono(d.resultadoPts)}
          sub={d.salida ? `${eur(d.resultadoEur)} · salida ${precio(d.salida.nivel)} (${MOTIVOS[d.salida.motivo] ?? d.salida.motivo})` : op ? 'abierta' : ''} />
      </div>
      {d.eventos?.length > 0 && (
        <ul className="bot-eventos">
          {[...d.eventos].reverse().map((e, i) => <li key={i}><span className="bot-hora">{hora(e.hora)}</span>{e.texto}</li>)}
        </ul>
      )}
    </div>
  )
}

function Tile({ label, valor, sub, tonoValor = '' }) {
  return (
    <div className="estr-tile">
      <span className="estr-tile-label">{label}</span>
      <span className={`estr-tile-valor bot-tile-valor ${tonoValor}`}>{valor}</span>
      <span className="estr-tile-sub">{sub}</span>
    </div>
  )
}
