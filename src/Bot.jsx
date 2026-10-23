import { useEffect, useState, useCallback, useMemo } from 'react'
import { analizarSesion } from './segundaVelaCore'
import { conClaveBot, guardarClaveBot } from './claveBot'
import { piernasDe, abiertoSrs, siguienteAnadidoSrs, acumulado, realFrenteABacktest } from './botCalculos'
import { GraficoSesion, Piramide, LineaDelDia, CurvaResultados, BarraResultado } from './botVisual'
import './Bot.css'

// Un bot del motor de server/bot-srs.js en la demo de IG: el SRS, en varias sesiones del día,
// la Rule of 4, los días del FOMC, o First bar negative (`api`, `nombre` y `notaDia` dicen
// cuál; la configuración de este último trae `piramideN`, y con ella cambia su formulario). Enseña las
// sesiones de hoy, el historial al lado de lo que habría hecho el backtest (calculado aquí,
// con el mismo motor que la pestaña Estrategias, sobre las velas que el bot guarda al cierre)
// y la configuración. Telegram y el ensayo de órdenes son de la cuenta, no de un bot: van solo
// en el SRS (`extras`). En producción el servidor pide una clave.

const ESTADOS = {
  'esperando-bracket': 'Esperando a la vela del bracket',
  'esperando-rotura':  'Bracket listo: esperando la rotura',
  'entrando':          'Mandando la orden…',
  'en-posicion':       'Dentro',
  'esperando-vuelta':  'Saltó el stop: esperando para dar la vuelta',
  'terminado':         'Terminada',
  'sin-operar':        'No opera',
}
// Orden de las tarjetas de hoy: lo que tiene algo abierto, lo que espera y lo terminado
const ORDEN_ESTADO = {
  'en-posicion': 0, 'entrando': 0, 'esperando-vuelta': 0,
  'esperando-rotura': 1, 'esperando-bracket': 2,
  'terminado': 3, 'sin-operar': 3,
}
// Lo mismo en corto, para la línea del día
const ESTADOS_CORTOS = {
  'esperando-bracket': 'esperando bracket',
  'esperando-rotura':  'esperando rotura',
  'entrando':          'entrando…',
  'esperando-vuelta':  'esperando la vuelta',
  'sin-operar':        'no opera',
}
const MOTIVOS = { stop: 'stop', breakeven: 'break even', cierre: 'cierre', manual: 'a mano', objetivo: 'objetivo', bracket: 'stop', stopN: 'stop a 2 N' }

const num = (n, dec = 1) => n.toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec })
const pts = n => (n == null ? '—' : `${n > 0 ? '+' : ''}${num(n)}`)
const eur = n => (n == null ? '—' : `${n > 0 ? '+' : ''}${num(n, 0)} €`)
const precio = n => (n == null ? '—' : num(n))
const hora = iso => new Date(iso).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid' })
const horaMinuto = ts => new Date(ts * 1000).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' })
const fechaHora = ts => new Date(ts * 1000).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const tono = n => (n == null ? '' : n > 0 ? 'bot-pos' : n < 0 ? 'bot-neg' : '')

async function pedir(url, opciones = {}) {
  const r = await fetch(url, { ...opciones, headers: conClaveBot(opciones.headers) })
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
  if (!r.ok || j.error) {
    const err = new Error(j.error ?? `HTTP ${r.status}`)
    err.necesitaClave = !!j.necesitaClave
    throw err
  }
  return j
}

const ladoTexto = lado => (lado === 'largo' ? 'Compra' : 'Venta')
const describirPiernas = d => piernasDe(d).map(p => `${ladoTexto(p.lado)}${p.unidades?.length > 1 ? ` ×${p.unidades.length}` : ''}`).join(' → ')

// Lo que habría hecho el backtest esa sesión, con la configuración del día (y el mismo tope
// de posiciones de la pirámide que el bot, el de la sesión si lo lleva). Con la pirámide de las tortugas, la N que el bot
// sacó del diario ese día
const aVelas = filas => filas.map(([time, open, high, low, close]) => ({ time, open, high, low, close }))
function backtestDe(d, maxUnidades) {
  if (!d.velas?.length) return null
  const velas = aVelas(d.velas)
  const c = d.config
  const piramideN = c.piramideN && c.piramide ? { pasoN: c.piramide, stopN: c.stopN ?? 2 } : null
  const a = analizarSesion({
    velas, ticker: d.ticker, modo: c.modo, stopPct: c.stopPct, beR: c.beR, piramide: piramideN ? 0 : c.piramide ?? 0,
    tamanoAnadido: c.tamanoAnadido ?? 1, maxUnidades: c.maxUnidades ?? maxUnidades, tpPct: null, ventana: d.ventana,
    colorBracket: c.colorBracket ?? null, piramideN, n: d.n ?? null,
  })
  if (!a.valido) return { valido: false, motivo: a.motivo }
  if (!a.entrada) return { valido: true, resultadoPts: null }
  const piernas = [a, ...a.piernas]
  return {
    valido: true,
    resultadoPts: a.resultadoTotalPts ?? a.resultadoPts,
    resumen: piernas.map(p => `${ladoTexto(p.lado)}${p.unidades > 1 ? ` ×${p.unidades}` : ''} (${MOTIVOS[p.salida.motivo] ?? p.salida.motivo})`).join(' → '),
  }
}

const NOTA_SRS = 'Horas de Madrid; la raya vertical es ahora. Cada sesión abre a la hora de su bolsa (Tokio 09:00, Fráncfort 09:00, Londres 08:00 y Nueva York 09:30) y la casilla la enciende o la apaga.'

export default function Bot({ api = '/api/bot', nombre: nombreBot = 'SRS', notaDia = NOTA_SRS, extras = true }) {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const [pideClave, setPideClave] = useState(false)
  const [clave, setClave] = useState('')
  const [form, setForm] = useState(null)
  const [ocupado, setOcupado] = useState(false)
  const [ensayo, setEnsayo] = useState(null)
  const [ensayoTicker, setEnsayoTicker] = useState('^GDAXI')
  const [avisoTelegram, setAvisoTelegram] = useState(null)
  const [ahora, setAhora] = useState(() => Math.floor(Date.now() / 1000))
  const [abierto, setAbierto] = useState(null)   // la sesión del historial con el gráfico desplegado

  const cargar = useCallback(async () => {
    try {
      setDatos(await pedir(api))
      setAhora(Math.floor(Date.now() / 1000))
      setError(null)
      setPideClave(false)
    } catch (err) {
      setError(err.message)
      if (err.necesitaClave) setPideClave(true)
    }
  }, [api])

  // al abrir la pestaña y cada 5 s: el bot cambia solo (bracket, entrada, cierre)
  useEffect(() => {
    const primera = setTimeout(cargar, 0)
    const reloj = setInterval(cargar, 5000)
    return () => { clearTimeout(primera); clearInterval(reloj) }
  }, [cargar])

  const historial = useMemo(() => (datos?.historial ?? []).map(d => ({ ...d, backtest: backtestDe(d, datos.maxUnidades) })), [datos])

  const accion = async fn => {
    setOcupado(true)
    try { await fn(); await cargar() } catch (err) { setError(err.message) } finally { setOcupado(false) }
  }
  const guardarConfig = cambios => accion(() => pedir(`${api}/config`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cambios),
  }))
  const pararYCerrar = () => {
    if (!window.confirm(`¿Apagar el bot ${nombreBot} y cerrar ahora todo lo que tenga abierto?`)) return
    accion(() => pedir(`${api}/parar`, { method: 'POST' }))
  }
  const conectarTelegram = () => accion(async () => {
    setAvisoTelegram(null)
    await pedir('/api/bot/telegram', { method: 'POST' })
    setAvisoTelegram('Mensaje de prueba enviado: mira Telegram.')
  })
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
          <p className="bot-nota">El servidor de producción pide la clave del bot (la variable BOT_TOKEN de Railway). Se guarda en este navegador, y con ella el Gráfico también tiene IG.</p>
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

  const { config, hoy, sesiones, ig, opera } = datos
  const telegram = datos.telegram ?? { token: false, conectado: false, nombre: null }
  const editando = form ?? config
  const cambiar = (campo, valor) => setForm({ ...editando, [campo]: valor })
  const nombre = t => sesiones.find(s => s.ticker === t)?.nombre ?? t
  const operados = historial.filter(d => d.resultadoPts != null)
  const totalEur = operados.reduce((n, d) => n + (d.resultadoEur ?? 0), 0)
  const maxUnidades = datos.maxUnidades ?? 4
  // First bar negative: solo vende, con el stop en el máximo de la vela y la pirámide en N
  const tortuga = !!config.piramideN

  // Las sesiones de hoy: las que siguen en "hoy" y las que ya cerraron hoy, que el servidor
  // pasa al historial al momento
  const cerradasHoy = historial.filter(d => sesiones.some(s => s.ticker === d.ticker && s.hoy?.abre === d.abre))
  const deHoy = [...hoy, ...cerradasHoy]
  // Lo de hoy: lo cerrado (piernas terminadas) y lo que va abierto, con el último precio
  const cuentasHoy = deHoy.map(d => {
    const cerrado = piernasDe(d).reduce((s, p) => s + (p.salida ? (p.resultadoEur ?? 0) : 0), 0)
    return { d, cerrado, ...abiertoSrs(d) }
  })
  const cerradoHoy = cuentasHoy.reduce((s, c) => s + c.cerrado, 0)
  const abiertoHoy = cuentasHoy.reduce((s, c) => s + (c.abierto ?? 0), 0)
  const alStopHoy = cuentasHoy.reduce((s, c) => s + (c.alStop ?? 0), 0)
  const hayAbierto = cuentasHoy.some(c => c.abierto != null)
  const saldo = deHoy.find(d => d.plan?.saldo)?.plan.saldo ?? null
  const curva = acumulado([...operados].reverse().map(d => ({ etiqueta: `${d.fecha} · ${nombre(d.ticker)}`, valor: d.resultadoEur ?? 0 })))
  const maxEur = Math.max(0, ...operados.map(d => Math.abs(d.resultadoEur ?? 0)))
  const ejecucion = realFrenteABacktest(historial)
  // la próxima sesión de cualquier instrumento encendido (en la Rule of 4, la próxima reunión)
  const proximas = sesiones.filter(s => s.encendido && s.proxima).map(s => s.proxima)
  const proxima = proximas.length ? Math.min(...proximas) : null

  // Una fila por instrumento en la línea del día: su sesión de hoy y cómo va
  const filasDia = sesiones.map(s => {
    const d = deHoy.find(x => x.ticker === s.ticker)
    const abre = s.hoy?.abre ?? d?.abre ?? null
    const cierra = s.hoy?.cierra ?? d?.cierra ?? null
    const op = d ? piernasDe(d).at(-1) : null
    const c = cuentasHoy.find(x => x.d === d)
    const clase = !s.encendido && !d ? 'apagada'
      : d?.estado === 'en-posicion' ? `dentro ${op?.lado ?? ''}`
      : d?.estado === 'terminado' ? 'terminada'
      : d?.estado === 'sin-operar' ? 'sin-operar'
      : abre != null && ahora >= abre && ahora < cierra ? 'en-curso'
      : abre != null && ahora >= cierra ? 'terminada'
      : 'proxima'
    const resultado = d ? (d.salida ? d.resultadoEur : (c?.cerrado ?? 0) + (c?.abierto ?? 0)) : null
    const derecha = !s.encendido && !d ? <span className="bot-nota">apagada</span>
      : d && (d.salida || op) ? <span className={tono(resultado)}>{eur(resultado)}{!d.salida && op ? <small> abierto</small> : null}</span>
      : d ? <span className="bot-nota">{ESTADOS_CORTOS[d.estado] ?? d.estado}</span>
      : abre == null || ahora >= cierra ? <span className="bot-nota">abre {fechaHora(s.proxima)}</span>
      : <span className="bot-nota">{ahora < abre ? `abre ${horaMinuto(abre)}` : 'en curso'}</span>
    return {
      clave: s.ticker, nombre: s.nombre, abre, cierra, clase, derecha,
      control: <input type="checkbox" checked={s.encendido} disabled={ocupado} title={s.encendido ? 'Apagar esta sesión' : 'Encender esta sesión'}
        onChange={e => guardarConfig({ instrumentos: { [s.ticker]: e.target.checked } })} />,
    }
  })

  return (
    <div className="bot-page">
      <section className="bot-cabecera">
        <div>
          <div className={`bot-interruptor ${config.activo ? 'encendido' : ''}`}>{config.activo ? '● Encendido' : '○ Apagado'}</div>
          <p className="bot-nota">{nombreBot} · demo de IG (dinero ficticio) · cuenta {ig.cuenta ?? '—'} · {ig.streaming}</p>
          {!opera && <p className="bot-aviso">Este servidor no opera (BOT_OPERA no es 1): el registro es el suyo, pero las órdenes las manda el servidor que tenga BOT_OPERA=1.</p>}
        </div>
        <div className="bot-botones">
          <button className="diario-boton" disabled={ocupado} onClick={() => guardarConfig({ activo: !config.activo })}>{config.activo ? 'Apagar' : 'Encender'}</button>
          <button className="diario-boton bot-peligro" disabled={ocupado} onClick={pararYCerrar}>Parar y cerrar todo</button>
        </div>
      </section>

      {error && <p className="bot-error">{error}</p>}

      <div className="estr-tiles bot-kpis">
        <Tile label="Hoy" valor={deHoy.length ? eur(cerradoHoy + abiertoHoy) : '—'} tonoValor={tono(cerradoHoy + abiertoHoy)}
          sub={deHoy.length ? `${eur(cerradoHoy)} cerrado${hayAbierto ? ` · ${eur(abiertoHoy)} abierto` : ''}` : 'ninguna sesión empezada'} />
        <Tile label="Abierto ahora" valor={hayAbierto ? eur(abiertoHoy) : '—'} tonoValor={tono(abiertoHoy)}
          sub={hayAbierto ? `si saltan los stops: ${eur(alStopHoy)}` : 'nada abierto'} />
        <Tile label="Saldo de la cuenta" valor={saldo ? `${num(saldo, 0)} €` : '—'} sub={`riesgo por operación: ${String(config.riesgoPct ?? 1).replace('.', ',')}%`} />
        <Tile label="Historial" valor={operados.length ? eur(totalEur) : '—'} tonoValor={tono(totalEur)}
          sub={`${operados.length} ${operados.length === 1 ? 'sesión' : 'sesiones'} con operación (demo)`} />
      </div>

      <section className="bot-bloque">
        <h3>El día</h3>
        <LineaDelDia filas={filasDia} ahora={ahora} />
        <p className="bot-nota">{notaDia}</p>
        {datos.calendario && <CalendarioFomc c={datos.calendario} />}
      </section>

      <section className="bot-bloque">
        <h3>Hoy</h3>
        {hoy.length === 0 ? (
          <p className="bot-nota">
            {cerradasHoy.length ? 'Las sesiones de hoy ya han cerrado: están en el historial.'
              : config.activo ? 'Ninguna sesión empezada todavía.' : 'El bot está apagado: enciéndelo para que opere las próximas sesiones.'}
            {proxima && ` La próxima: ${fechaHora(proxima)}.`}
          </p>
        ) : (
          <div className="bot-tarjetas">
            {cuentasHoy.filter(c => hoy.includes(c.d)).sort((a, b) => (ORDEN_ESTADO[a.d.estado] ?? 1) - (ORDEN_ESTADO[b.d.estado] ?? 1) || a.d.abre - b.d.abre)
              .map(c => <SesionHoy key={c.d.clave} cuentas={c} nombre={nombre(c.d.ticker)} maxUnidades={maxUnidades} ahora={ahora} />)}
          </div>
        )}
      </section>

      <section className="bot-bloque">
        <h3>Historial</h3>
        {historial.length === 0 ? <p className="bot-nota">Todavía no hay sesiones anteriores.</p> : (
          <>
            <p className="bot-nota">{operados.length} sesiones con operación · resultado del bot <b className={tono(totalEur)}>{eur(totalEur)}</b> (demo)</p>
            <CurvaResultados puntos={curva} />
            <div className="velas-tabla-wrap bot-historial-wrap">
              <table className="velas-tabla bot-tabla">
                <thead>
                  <tr><th>Sesión</th><th>Instrumento</th><th>Operación</th><th>Entrada</th><th>Deslizamiento</th><th>Salida</th><th>Bot</th><th>€</th><th>Backtest</th><th>Nota</th><th /></tr>
                </thead>
                <tbody>
                  {historial.map(d => {
                    const bt = d.backtest
                    const desplegado = abierto === d.clave
                    return [
                      <tr key={d.clave}>
                        <td>{d.fecha}</td>
                        <td className="bot-celda-texto">{nombre(d.ticker)}</td>
                        <td className="bot-celda-texto">{describirPiernas(d) || '—'}</td>
                        <td>{precio(piernasDe(d)[0]?.entrada)}</td>
                        <td>{pts(piernasDe(d)[0]?.deslizamiento)}</td>
                        <td>{d.salida ? `${precio(d.salida.nivel)} (${MOTIVOS[d.salida.motivo] ?? d.salida.motivo}${d.salida.aproximado ? ', aprox.' : ''})` : '—'}</td>
                        <td className={tono(d.resultadoPts)}>{pts(d.resultadoPts)}</td>
                        <td className={`bot-celda-barra ${tono(d.resultadoEur)}`}><BarraResultado valor={d.resultadoEur} max={maxEur} />{eur(d.resultadoEur)}</td>
                        <td className={tono(bt?.resultadoPts)} title={bt?.valido === false ? bt.motivo : bt?.resumen ?? ''}>
                          {bt == null ? '—' : !bt.valido ? 'no calculable' : bt.resultadoPts == null ? 'sin entrada' : pts(bt.resultadoPts)}
                        </td>
                        <td className="bot-nota-celda">{d.estado === 'sin-operar' ? d.eventos?.at(-1)?.texto : ''}</td>
                        <td>{d.velas?.length ? (
                          <button className="dibujo-btn" onClick={() => setAbierto(desplegado ? null : d.clave)} aria-expanded={desplegado}>{desplegado ? 'ocultar' : 'gráfico'}</button>
                        ) : null}</td>
                      </tr>,
                      desplegado && (
                        <tr key={`${d.clave}-grafico`} className="bot-fila-grafico">
                          <td colSpan={11}>
                            <GraficoSesion velas={d.velas} abre={d.abre} cierra={d.cierra} minutos={d.ventana?.minutosVela ?? 15}
                              bracket={d.bracket} piernas={piernasDe(d)} decimales={1} />
                          </td>
                        </tr>
                      ),
                    ]
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {ejecucion.filas.length > 0 && (
        <section className="bot-bloque">
          <h3>Real frente al backtest</h3>
          <div className="velas-tabla-wrap">
            <table className="velas-tabla bot-tabla">
              <thead>
                <tr><th>Instrumento</th><th>Entradas</th><th>Deslizamiento medio</th><th>Mediana</th><th>% del bracket</th><th>Sesiones</th><th>Bot</th><th>Backtest</th><th>Diferencia por sesión</th><th>En R</th></tr>
              </thead>
              <tbody>
                {ejecucion.filas.map(f => (
                  <tr key={f.ticker}>
                    <td className="bot-celda-texto">{nombre(f.ticker)}</td>
                    <td>{f.entradas}</td>
                    <td className={tono(f.deslMedio == null ? null : -f.deslMedio)}>{pts(f.deslMedio)}</td>
                    <td>{pts(f.deslMediana)}</td>
                    <td>{f.deslPctMedio == null ? '—' : `${num(f.deslPctMedio)}%`}</td>
                    <td>{f.sesiones}</td>
                    <td className={tono(f.real)}>{pts(f.real)}</td>
                    <td className={tono(f.backtest)}>{pts(f.backtest)}</td>
                    <td className={tono(f.difMedia)}>{pts(f.difMedia)}</td>
                    <td className={tono(f.difMediaR)}>{f.difMediaR == null ? '—' : `${f.difMediaR > 0 ? '+' : ''}${num(f.difMediaR, 2)} R`}</td>
                  </tr>
                ))}
                <tr className="bot-fila-total">
                  <td className="bot-celda-texto"><b>Todos</b></td>
                  <td>{ejecucion.total.entradas}</td>
                  <td>—</td><td>—</td>
                  <td>{ejecucion.total.deslPctMedio == null ? '—' : `${num(ejecucion.total.deslPctMedio)}%`}</td>
                  <td>{ejecucion.total.sesiones}</td>
                  <td>—</td><td>—</td><td>—</td>
                  <td className={tono(ejecucion.total.difMediaR)}>{ejecucion.total.difMediaR == null ? '—' : `${ejecucion.total.difMediaR > 0 ? '+' : ''}${num(ejecucion.total.difMediaR, 2)} R`}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="bot-nota">
            {ejecucion.total.z == null ? 'Con menos de 5 sesiones comparables aún no se puede decir si la diferencia es casualidad.'
              : ejecucion.total.z < -2 ? <b className="bot-neg">El bot va peor que el backtest más de lo que explica el azar: revisa el deslizamiento y las sesiones que no operó.</b>
              : ejecucion.total.z > 2 ? <b className="bot-pos">El bot va mejor que el backtest más de lo que explica el azar: mira si el backtest es demasiado pesimista.</b>
              : 'La diferencia entre el bot y el backtest cabe en lo que da el azar: el backtest describe bien lo que pasa.'}
            {' '}El deslizamiento es lo que se pagó de más sobre el nivel de la rotura (positivo, peor), en cada entrada y añadido. La diferencia es lo que hizo el bot menos lo que habría hecho el backtest en la misma sesión;
            una sesión que el bot no operó y el backtest sí cuenta como 0 del bot. En R, entre el bracket, para poder juntar instrumentos.
          </p>
        </section>
      )}

      <section className="bot-bloque">
        <h3>Configuración</h3>
        <div className="bot-form">
          {!tortuga && <>
          <label>Operativa
            <select value={editando.modo} onChange={e => cambiar('modo', e.target.value)}>
              <option value="flip">Con flip the switch</option>
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
          </>}
          <label>Pirámide
            <select value={editando.piramide ?? ''} onChange={e => cambiar('piramide', e.target.value === '' ? null : Number(e.target.value))}>
              <option value="">No</option>
              {tortuga ? <option value={0.5}>Una más cada ½ N, con el stop a 2 N de la última</option> : <>
                <option value={0.5}>Una más cada 0,5R a favor</option>
                <option value={1}>Una más cada 1R a favor</option>
                <option value={2}>Una más cada 2R a favor</option>
              </>}
            </select>
          </label>
          <label>Cada añadido
            <select value={editando.tamanoAnadido ?? 1} disabled={editando.piramide == null} onChange={e => cambiar('tamanoAnadido', Number(e.target.value))}>
              <option value={1}>Del tamaño de la entrada</option>
              <option value={0.5}>La mitad de la entrada</option>
            </select>
          </label>
          <label>Riesgo por operación (% de la cuenta)
            <input type="number" min="0.1" max="10" step="0.1" value={editando.riesgoPct ?? 1} onChange={e => cambiar('riesgoPct', e.target.value)} />
          </label>
          <label>No entrar si el precio se ha ido más de (% del bracket)
            <input type="number" min="1" max="200" step="5" value={Math.round(editando.deslizamientoMaxR * 100)} onChange={e => cambiar('deslizamientoMaxR', Number(e.target.value) / 100)} />
          </label>
          <label>Bracket máximo (% del precio)
            <input type="number" min="0.01" max="10" step="0.1" value={editando.rangoMaxPct} onChange={e => cambiar('rangoMaxPct', e.target.value)} />
          </label>
          <label>Noticias de alto impacto
            <select value={editando.margenNoticias ?? ''} onChange={e => cambiar('margenNoticias', e.target.value === '' ? null : Number(e.target.value))}>
              <option value="">No las mira</option>
              <option value={5}>No entra 5 min antes ni después</option>
              <option value={15}>No entra 15 min antes ni después</option>
              <option value={30}>No entra 30 min antes ni después</option>
              <option value={60}>No entra 1 h antes ni después</option>
            </select>
          </label>
        </div>
        {tortuga ? (
          <p className="bot-nota">
            Solo vende, y solo los días en que la primera vela de 5 min cierra en negativo: al perder su mínimo, con el stop en su máximo.
            El tamaño sale del riesgo, que es lo que se pierde si salta ese stop: ese % del saldo de la cuenta entre el rango de la vela (por lo que vale el punto del contrato). Si el mínimo de IG obliga a arriesgar más del doble, esa sesión no entra.
            La entrada va a mercado, pero solo si el precio no se ha ido del mínimo más de lo que digas.
            La pirámide añade otra posición cada ½ N desde el precio de la última, aunque el precio ya lo haya pasado, como mucho una cada 5 min y hasta {datos.maxUnidades ?? 4} con la entrada; con cada una, el stop de todas baja a 2 N de ella si así se aprieta.
            N es la de las tortugas: el ATR de Wilder de 20 sesiones del diario del índice, hasta la anterior.
            Junto a una noticia de alto impacto (ForexFactory) de la divisa del mercado o del dólar no entra: espera a que pase. Y ninguna entrada se manda si, con ella, lo que se perdería al saltar a la vez todos los stops de los mercados que se mueven juntos (los índices de EE. UU., los europeos, el dólar…) en ese sentido, contando todos los bots, pasa del {datos.riesgoGrupoPct ?? 6}% del saldo.
            Un cambio vale para las sesiones que aún no han fijado su bracket.
          </p>
        ) : (
          <p className="bot-nota">
            El tamaño sale del riesgo, que es lo que se pierde si salta el stop: ese % del saldo de la cuenta entre los puntos hasta el stop (por lo que vale el punto del contrato). Si el mínimo de IG obliga a arriesgar más del doble, esa sesión no entra.
            Las órdenes van a mercado, pero solo si el precio no se ha ido del nivel más de lo que digas: si no, no entra (ni da la vuelta), y un añadido espera a que vuelva cerca.
            Con flip the switch, si salta el stop da la vuelta una vez; necesita el stop al otro lado del bracket.
            La pirámide abre como mucho {datos.maxUnidades ?? 4} posiciones (con la entrada) y lleva el stop de todas a su precio medio.
            Junto a una noticia de alto impacto (ForexFactory) de la divisa del mercado o del dólar no entra: espera a que pase. Y ninguna entrada se manda si, con ella, lo que se perdería al saltar a la vez todos los stops de los mercados que se mueven juntos (los índices de EE. UU., los europeos, el dólar…) en ese sentido, contando todos los bots, pasa del {datos.riesgoGrupoPct ?? 6}% del saldo.
            Un cambio vale para las sesiones que aún no han fijado su bracket.
          </p>
        )}
        <button className="diario-boton" disabled={ocupado || !form} onClick={() => {
          const { modo, stopPct, beR, piramide, tamanoAnadido, riesgoPct, deslizamientoMaxR, rangoMaxPct, margenNoticias } = form
          guardarConfig({ modo, stopPct, beR, piramide, tamanoAnadido, riesgoPct, deslizamientoMaxR, rangoMaxPct, margenNoticias: margenNoticias ?? null }).then(() => setForm(null))
        }}>Guardar configuración</button>
      </section>

      {extras && <>
      <section className="bot-bloque">
        <h3>Avisos por Telegram</h3>
        <p className="bot-nota">
          {telegram.conectado
            ? `Conectado${telegram.nombre ? ` con ${telegram.nombre}` : ''}: cada entrada, añadido, salida, cambio y error llega a Telegram.`
            : telegram.token
              ? 'Falta conectar el chat: abre tu bot en Telegram, pulsa Iniciar y después «Conectar Telegram».'
              : 'Sin configurar: falta la variable TELEGRAM_TOKEN en el servidor.'}
          {!opera && ' Los avisos los manda el servidor que opera (BOT_OPERA=1).'}
        </p>
        <div className="bot-botones">
          <button className="diario-boton" disabled={ocupado || !telegram.token} onClick={conectarTelegram}>
            {telegram.conectado ? 'Mandar un mensaje de prueba' : 'Conectar Telegram'}
          </button>
        </div>
        {avisoTelegram && <p className="bot-nota">{avisoTelegram}</p>}
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
      </>}
    </div>
  )
}

// Una sesión de hoy: cabecera con el estado y el resultado, el gráfico de la sesión y debajo
// los datos (pirámide, bracket, riesgo, stop) y el registro plegado
function SesionHoy({ cuentas, nombre, maxUnidades, ahora }) {
  const { d, cerrado, abierto, alStop } = cuentas
  const { plan } = d
  const piernas = piernasDe(d)
  // la pierna en curso (o la última) y, si dio la vuelta, la de antes
  const op = piernas.at(-1) ?? null
  const antes = piernas.length > 1 ? piernas[0] : null
  const vivas = op && !op.salida ? (op.unidades ?? []).filter(u => !u.salida) : []
  const contratos = vivas.reduce((s, u) => s + u.tamano, 0)
  const resultado = d.salida ? d.resultadoEur : (op ? cerrado + (abierto ?? 0) : null)
  const siguiente = siguienteAnadidoSrs(d, maxUnidades)
  const ultimo = d.eventos?.at(-1)

  // sin empezar: una línea con cuándo abre y cuál será la vela del bracket
  if (!d.velas?.length && !d.bracket && !op) {
    const v = d.ventana ?? { minutosVela: 15, nBracket: 2 }
    const desdeBracket = d.abre + (v.nBracket - 1) * v.minutosVela * 60
    return (
      <article className="bot-tarjeta bot-tarjeta-espera">
        <div className="bot-tarjeta-titulo">
          <strong>{nombre}</strong>
          <span className={`bot-pill estado-${d.estado}`}>{ESTADOS[d.estado] ?? d.estado}</span>
        </div>
        <span className="bot-nota">abre a las {horaMinuto(d.abre)} · el bracket es la vela de {horaMinuto(desdeBracket)} a {horaMinuto(desdeBracket + v.minutosVela * 60)}</span>
      </article>
    )
  }

  return (
    <article className="bot-tarjeta">
      <header className="bot-tarjeta-cab">
        <div className="bot-tarjeta-titulo">
          <strong>{nombre}</strong>
          <span className={`bot-pill estado-${d.estado}`}>{ESTADOS[d.estado] ?? d.estado}</span>
          {op && <span className={`bot-pill ${op.lado}`}>{ladoTexto(op.lado)}</span>}
          {d.recuperada && <span className="bot-pill">recuperada de IG</span>}
        </div>
        <div className="bot-tarjeta-resultado">
          <span className={`bot-grande ${tono(resultado)}`}>{resultado == null ? '—' : eur(resultado)}</span>
          <small>{d.salida ? `final · ${pts(d.resultadoPts)} puntos` : op ? 'abierto, con el último precio' : `abre ${fechaHora(d.abre)}`}</small>
        </div>
      </header>

      <GraficoSesion velas={d.velas} abre={d.abre} cierra={d.cierra} minutos={d.ventana?.minutosVela ?? 15}
        bracket={d.bracket} piernas={piernas} stop={op?.stop} be={op?.be} siguiente={siguiente} precio={d.precio} ahora={ahora} decimales={1} />

      <div className="bot-tarjeta-datos">
        {op && !op.salida && (
          <div className="bot-dato"><span>Pirámide</span><Piramide n={op.unidades?.length ?? 1} max={maxUnidades} lado={op.lado} />
            <small>{siguiente != null ? `la siguiente en ${precio(siguiente)}` : 'llena'}</small></div>
        )}
        <div className="bot-dato"><span>Bracket</span><b>{d.bracket ? `${precio(d.bracket.rango)} puntos` : '—'}</b>
          <small>{d.bracket ? `${precio(d.bracket.low)} – ${precio(d.bracket.high)}` : 'esperando su vela'}</small></div>
        {d.n > 0 && (
          <div className="bot-dato"><span>N</span><b>{precio(d.n)}</b>
            <small>añade cada {precio(d.n * (d.config.piramide ?? 0.5))} · stop a {precio(d.n * (d.config.stopN ?? 2))}</small></div>
        )}
        <div className="bot-dato"><span>Riesgo</span><b>{plan ? `${Math.round(plan.riesgoEur)} €` : '—'}</b>
          <small>{plan ? `${num(plan.tamano, 1)} contratos de ${plan.valorPunto} ${plan.moneda}/punto` : ''}</small></div>
        {antes && (
          <div className="bot-dato"><span>Primera pierna</span><b className={tono(antes.resultadoEur)}>{eur(antes.resultadoEur)}</b>
            <small>{ladoTexto(antes.lado)} a {precio(antes.entrada)} · {MOTIVOS[antes.salida?.motivo] ?? antes.salida?.motivo}</small></div>
        )}
        {op && (
          <div className="bot-dato"><span>{antes ? 'La vuelta' : 'Entrada'}</span><b>{precio(op.entrada)}</b>
            <small>deslizamiento {pts(op.deslizamiento)}{vivas.length > 1 ? ` · ${num(contratos, 1)} contratos` : ''}</small></div>
        )}
        {op && !op.salida && (
          <div className="bot-dato"><span>Stop{op.be ? ' (break even)' : op.stopMovido ? ' (a 2 N)' : ''}</span><b>{precio(op.stop)}</b>
            <small className={tono(alStop)}>si salta: {eur(alStop)}</small></div>
        )}
        {d.salida && (
          <div className="bot-dato"><span>Salida</span><b>{precio(d.salida.nivel)}</b><small>{MOTIVOS[d.salida.motivo] ?? d.salida.motivo}</small></div>
        )}
      </div>

      {d.eventos?.length > 0 && (
        <details className="bot-registro">
          <summary><span className="bot-hora">{hora(ultimo.hora)}</span>{ultimo.texto}<small> · registro ({d.eventos.length})</small></summary>
          <ul className="bot-eventos">
            {[...d.eventos].reverse().map((e, i) => <li key={i}><span className="bot-hora">{hora(e.hora)}</span>{e.texto}</li>)}
          </ul>
        </details>
      )}
    </article>
  )
}

// Hasta dónde llega el calendario del FOMC del bot de la Rule of 4, que el servidor pone al día
// cada día con la página de la Reserva Federal
function CalendarioFomc({ c }) {
  const dia = f => new Date(`${f}T12:00:00Z`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  return (
    <p className="bot-nota">
      Calendario del FOMC: {c.quedan} {c.quedan === 1 ? 'reunión' : 'reuniones'} por delante, hasta el {c.hasta ? dia(c.hasta) : '—'}
      {c.proximas?.length ? ` (las próximas: ${c.proximas.map(dia).join(', ')})` : ''}.{' '}
      {c.actualizado
        ? `Leído de la Reserva Federal el ${new Date(c.actualizado).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}; se vuelve a leer cada día.`
        : 'Aún sin leer de la Reserva Federal: vale la lista que trae el servidor.'}
      {c.error && <span className="bot-error"> Último intento: {c.error}</span>}
    </p>
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
