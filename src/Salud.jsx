import { useEffect, useState, useCallback } from 'react'
import { conClaveBot, guardarClaveBot } from './claveBot'
import './Bot.css'

// La salud del servidor de un vistazo (server/salud.js, /api/bot/salud): primero lo que hay que
// mirar, y debajo el detalle de cada parte, para no tener que ir pestaña por pestaña.

const fechaHora = iso => (iso ? new Date(iso).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')
const num = n => n.toLocaleString('es-ES')
const segundos = s => (s == null ? '—' : s < 90 ? `${s} s` : `${Math.round(s / 60)} min`)

async function pedir(url) {
  const r = await fetch(url, { headers: conClaveBot() })
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
  if (!r.ok || j.error) {
    const err = new Error(j.error ?? `HTTP ${r.status}`)
    err.necesitaClave = !!j.necesitaClave
    throw err
  }
  return j
}

function Dato({ nombre, valor, bien = null, nota = null }) {
  return (
    <div className="bot-dato">
      <span>{nombre}</span>
      <b className={`bot-tile-valor ${bien === true ? 'bot-pos' : bien === false ? 'bot-neg' : ''}`}>{valor}</b>
      {nota && <small>{nota}</small>}
    </div>
  )
}

export default function Salud() {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const [pideClave, setPideClave] = useState(false)
  const [clave, setClave] = useState('')

  const cargar = useCallback(async () => {
    try {
      setDatos(await pedir('/api/bot/salud'))
      setError(null)
      setPideClave(false)
    } catch (err) {
      setError(err.message)
      if (err.necesitaClave) setPideClave(true)
    }
  }, [])

  // al abrir la vista y cada 30 s (no pide nada a IG: es lo que el servidor ya sabe)
  useEffect(() => {
    const primera = setTimeout(cargar, 0)
    const reloj = setInterval(cargar, 30000)
    return () => { clearTimeout(primera); clearInterval(reloj) }
  }, [cargar])

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

  const { servidor, bots, bucle, ig, fuentes, calendarioFomc: cal, telegram, conciliacion: con, avisos } = datos
  const cupo = ig?.cupo?.remainingAllowance
  return (
    <div className="bot-page">
      <section className="bot-bloque">
        <h3>Salud del servidor</h3>
        <p className="bot-nota">
          {servidor.produccion ? 'Producción' : 'Servidor local'}{servidor.opera ? ', donde operan los bots' : ', que no opera (BOT_OPERA no es 1)'}.
          {' '}Arrancado el {fechaHora(servidor.arrancado)}{servidor.commit ? ` con ${servidor.commit}${servidor.mensaje ? ` («${servidor.mensaje.split('\n')[0]}»)` : ''}` : ''}. Se refresca cada 30 s.
        </p>
        {error && <p className="bot-error">{error}</p>}
        {avisos.length === 0
          ? <p className="bot-pos"><b>Todo en orden.</b></p>
          : <ul className="salud-avisos">{avisos.map(a => <li key={a.texto} className={a.nivel === 'mal' ? 'bot-neg' : 'salud-ojo'}>{a.texto}</li>)}</ul>}
      </section>

      <section className="bot-bloque">
        <h3>Bots</h3>
        <div className="bot-tarjeta-datos">
          {bots.bots.map(b => (
            <Dato key={b.nombre} nombre={b.nombre} valor={!b.enMarcha ? 'apagado' : b.parado ? 'parado' : 'en marcha'}
              bien={b.enMarcha ? !b.parado : null} nota={b.enMarcha ? `última vuelta hace ${segundos(b.segundosSinVuelta)}` : null} />
          ))}
          <Dato nombre="Bucle de eventos" valor={`${num(bucle.peorRecienteMs)} ms`} bien={bucle.peorRecienteMs < 2000} nota={`lo peor desde que arrancó: ${num(bucle.peorDesdeArranqueMs)} ms`} />
        </div>
      </section>

      <section className="bot-bloque">
        <h3>IG y fuentes de datos</h3>
        <div className="bot-tarjeta-datos">
          {ig ? <>
            <Dato nombre="Sesión de IG" valor={ig.sesion} bien={ig.sesion === 'abierta'} nota={ig.cuenta ? `cuenta ${ig.cuenta}` : ig.error} />
            <Dato nombre="Streaming" valor={/^CONNECTED/.test(ig.streaming ?? '') ? 'conectado' : ig.streaming} bien={/^CONNECTED/.test(ig.streaming ?? '')} />
            <Dato nombre="Cupo de histórico" valor={cupo == null ? 'sin datos' : `${num(cupo)} puntos`} bien={cupo == null ? null : cupo > 0}
              nota={ig.cupo?.allowanceExpiry != null ? `se renueva en ${Math.round(ig.cupo.allowanceExpiry / 3600)} h` : 'semanal; lo sabe tras la primera descarga'} />
          </> : <Dato nombre="IG" valor="sin configurar" bien={false} />}
          <Dato nombre="Dukascopy" valor={fuentes.dukascopy.limitando ? 'limitando (429)' : 'sin límites'} bien={!fuentes.dukascopy.limitando} nota={`transporte: ${fuentes.dukascopy.modo}`} />
          <Dato nombre="Twelve Data" valor={fuentes.twelveData.clave ? 'con clave' : 'sin clave'} bien={fuentes.twelveData.clave || !servidor.opera ? null : false} nota="reserva del oro de las tortugas" />
        </div>
      </section>

      <section className="bot-bloque">
        <h3>Calendario, avisos y conciliación</h3>
        <div className="bot-tarjeta-datos">
          <Dato nombre="Calendario del FOMC" valor={cal.error ? 'con error' : `hasta ${cal.hasta ?? '—'}`} bien={!cal.error}
            nota={`${cal.proximas?.length ? `próxima ${cal.proximas[0]} · ` : ''}leído el ${fechaHora(cal.actualizado)}`} />
          <Dato nombre="Telegram" valor={telegram.conectado ? 'conectado' : telegram.token ? 'sin conectar' : 'sin token'} bien={telegram.conectado || !servidor.opera ? null : false} nota={telegram.nombre} />
          {con && <Dato nombre="Conciliación con IG" valor={con.pendientes.length ? `${con.pendientes.length} diferencias` : con.error ? 'con error' : 'cuadra'}
            bien={!con.pendientes.length && !con.error} nota={con.ultima ? `revisada el ${fechaHora(con.ultima)}` : 'aún no ha revisado (cada 30 min donde operan los bots)'} />}
        </div>
      </section>
    </div>
  )
}
