import { useEffect, useState, useCallback } from 'react'
import { conClaveBot, guardarClaveBot } from './claveBot'
import './Bot.css'

// Pestaña Bot Tortugas: el bot de las tortugas que opera en la demo de IG
// (server/bot-tortugas.js), con las posiciones abiertas de un día para otro. Enseña los
// niveles de cada índice para su sesión, las posiciones con su pirámide, los límites de
// cartera, las operaciones cerradas, el registro y la configuración. En producción el
// servidor pide la misma clave que la pestaña Bot SRS.

const num = (n, dec = 1) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec }))
const eur = n => (n == null ? '—' : `${n > 0 ? '+' : ''}${num(n, 0)} €`)
const conSigno = (n, dec = 1) => (n == null ? '—' : `${n > 0 ? '+' : ''}${num(n, dec)}`)
const tono = n => (n == null ? '' : n > 0 ? 'bot-pos' : n < 0 ? 'bot-neg' : '')
const fechaHora = ts => new Date(ts * 1000).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const horaEvento = iso => new Date(iso).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const dir = lado => (lado === 'largo' ? 1 : -1)

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

// Lo que gana o pierde una posición a `precio` y lo que perdería si salta su stop, en euros
function cuentasDe(pos, precio) {
  const vivas = pos.unidades.filter(u => !u.salida)
  const enEur = x => x * pos.valorPunto * pos.cambioAEur
  return {
    abierto: precio == null ? null : enEur(vivas.reduce((s, u) => s + u.tamano * dir(pos.lado) * (precio - u.entrada), 0)),
    alStop: pos.stop == null ? null : enEur(vivas.reduce((s, u) => s + u.tamano * dir(pos.lado) * (pos.stop - u.entrada), 0)),
    contratos: vivas.reduce((s, u) => s + u.tamano, 0),
    medio: vivas.reduce((s, u) => s + u.tamano * u.entrada, 0) / vivas.reduce((s, u) => s + u.tamano, 0),
  }
}

export default function BotTortugas() {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const [pideClave, setPideClave] = useState(false)
  const [clave, setClave] = useState('')
  const [form, setForm] = useState(null)
  const [ocupado, setOcupado] = useState(false)

  const cargar = useCallback(async () => {
    try {
      setDatos(await pedir('/api/bot/tortugas'))
      setError(null)
      setPideClave(false)
    } catch (err) {
      setError(err.message)
      if (err.necesitaClave) setPideClave(true)
    }
  }, [])

  useEffect(() => {
    const primera = setTimeout(cargar, 0)
    const reloj = setInterval(cargar, 5000)
    return () => { clearTimeout(primera); clearInterval(reloj) }
  }, [cargar])

  const accion = async fn => {
    setOcupado(true)
    try { await fn(); await cargar() } catch (err) { setError(err.message) } finally { setOcupado(false) }
  }
  const guardarConfig = cambios => accion(() => pedir('/api/bot/tortugas/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cambios),
  }))
  const pararYCerrar = () => {
    if (!window.confirm('¿Apagar el bot de las tortugas y cerrar ahora todas sus posiciones?')) return
    accion(() => pedir('/api/bot/tortugas/parar', { method: 'POST' }))
  }

  if (pideClave) {
    return (
      <div className="bot-page">
        <section className="bot-bloque bot-clave">
          <h3>Clave del bot</h3>
          <p className="bot-nota">El servidor de producción pide la clave del bot (la variable BOT_TOKEN de Railway). Es la misma que la de la pestaña Bot SRS y se guarda en este navegador.</p>
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

  const { config, mercados, operaciones, eventos, ig, opera, reglas } = datos
  const editando = form ?? config
  const cambiar = (campo, valor) => setForm({ ...editando, [campo]: valor })
  const nombre = t => mercados.find(m => m.ticker === t)?.nombre ?? t
  const totalEur = operaciones.reduce((s, o) => s + (o.resultadoEur ?? 0), 0)
  const ladosTexto = { largos: 'solo largos', ambos: 'largos y cortos', cortos: 'solo cortos' }[config.lados]

  // Unidades abiertas por grupo y sentido, para ver lo lejos que están los límites
  const abiertas = mercados.filter(m => m.posicion)
  const unidades = (filtro) => abiertas.filter(filtro).reduce((s, m) => s + m.posicion.unidades.filter(u => !u.salida).length, 0)
  const grupos = [...new Set(mercados.map(m => m.grupo))]
  const lados = config.lados === 'ambos' ? ['largo', 'corto'] : [config.lados === 'cortos' ? 'corto' : 'largo']
  const saldo = mercados.find(m => m.plan?.saldo)?.plan.saldo ?? null
  const nominal = abiertas.reduce((s, m) => s + m.posicion.unidades.filter(u => !u.salida).reduce((x, u) => x + u.tamano * u.entrada, 0) * m.posicion.valorPunto * m.posicion.cambioAEur, 0)

  return (
    <div className="bot-page">
      <section className="bot-cabecera">
        <div>
          <div className={`bot-interruptor ${config.activo ? 'encendido' : ''}`}>{config.activo ? '● Encendido' : '○ Apagado'}</div>
          <p className="bot-nota">Tortugas · Sistema {config.sistema} · {ladosTexto} · 1 N por unidad = {num(config.riesgoPct, 2)}% del saldo · demo de IG (dinero ficticio) · cuenta {ig.cuenta ?? '—'} · {ig.streaming}</p>
          {!opera && <p className="bot-aviso">Este servidor no opera (BOT_OPERA no es 1): el registro es el suyo, pero las órdenes las manda el servidor que tenga BOT_OPERA=1.</p>}
        </div>
        <div className="bot-botones">
          <button className="diario-boton" disabled={ocupado} onClick={() => guardarConfig({ activo: !config.activo })}>{config.activo ? 'Apagar' : 'Encender'}</button>
          <button className="diario-boton bot-peligro" disabled={ocupado} onClick={pararYCerrar}>Parar y cerrar todo</button>
        </div>
      </section>

      {error && <p className="bot-error">{error}</p>}

      <section className="bot-bloque">
        <h3>Índices</h3>
        <div className="velas-tabla-wrap tor-tabla-wrap">
          <table className="velas-tabla bot-tabla tor-tabla tor-todas">
            <thead>
              <tr><th>Índice</th><th>Sesión</th><th className="tor-num">N</th><th className="tor-num">Precio</th><th>Entrada</th><th>Salida</th><th>Unidad</th><th>Posición</th><th className="tor-num">Abierto</th></tr>
            </thead>
            <tbody>
              {mercados.map(m => <FilaIndice key={m.ticker} m={m} config={config} ocupado={ocupado} reglas={reglas}
                alternar={si => guardarConfig({ instrumentos: { [m.ticker]: si } })} />)}
            </tbody>
          </table>
        </div>
        <p className="bot-nota">
          Los niveles salen del diario de Yahoo de cada índice hasta la sesión anterior, como en el backtest; el precio es el de IG (el CFD de contado, que puede ir unos puntos separado del índice).
          Antes de abrir, el plan es provisional: al abrir se rehace con el saldo de ese momento. «Abierto» es lo que va ganando la posición; debajo, lo que dejaría si saltara el stop ahora.
        </p>
      </section>

      <section className="bot-bloque">
        <h3>Cartera</h3>
        <div className="estr-tiles">
          {lados.map(lado => (
            <Tile key={lado} label={`Unidades ${lado === 'largo' ? 'largas' : 'cortas'}`}
              valor={`${unidades(m => m.posicion.lado === lado)} de ${config.maxSentido}`}
              sub={grupos.map(g => `${g} ${unidades(m => m.grupo === g && m.posicion.lado === lado)}/${config.maxGrupo}`).join(' · ')} />
          ))}
          <Tile label="Nominal abierto" valor={`${num(nominal / 1000, 1)} mil €`}
            sub={saldo ? `${num(nominal / saldo, 1)} veces el saldo (máximo ${reglas.apalancamiento})` : ''} />
          <Tile label="Saldo de la cuenta" valor={saldo ? `${num(saldo, 0)} €` : '—'}
            sub={datos.picoSaldo ? `máximo ${num(datos.picoSaldo, 0)} €${config.reduccionDD ? ' · −20% de unidad por cada −10%' : ''}` : ''} />
          <Tile label="Operaciones cerradas" valor={eur(operaciones.length ? totalEur : null)} tonoValor={tono(totalEur)}
            sub={`${operaciones.length} ${operaciones.length === 1 ? 'operación' : 'operaciones'} (demo)`} />
        </div>
      </section>

      <section className="bot-bloque">
        <h3>Operaciones cerradas</h3>
        {operaciones.length === 0 ? <p className="bot-nota">Todavía no ha cerrado ninguna.</p> : (
          <div className="velas-tabla-wrap">
            <table className="velas-tabla bot-tabla tor-todas">
              <thead>
                <tr><th>Cerrada</th><th>Índice</th><th>Lado</th><th>Abierta</th><th>Unidades</th><th>Entrada media</th><th>Salida</th><th>Motivo</th><th>N</th><th>€</th></tr>
              </thead>
              <tbody>
                {operaciones.map(o => (
                  <tr key={`${o.ticker}-${o.cerradaHora}`}>
                    <td>{o.cerrada}</td>
                    <td className="bot-celda-texto">{nombre(o.ticker)}</td>
                    <td className="bot-celda-texto">{o.lado === 'largo' ? 'Largo' : 'Corto'}{o.ruptura ? ` (${o.ruptura})` : ''}</td>
                    <td>{o.abierta}</td>
                    <td>{o.unidades} · {num(o.contratos, 1)} c.</td>
                    <td>{num(o.entradaMedia)}</td>
                    <td>{num(o.salida)}{o.aproximado ? ' (aprox.)' : ''}</td>
                    <td className="bot-celda-texto">{o.motivo}</td>
                    <td className={tono(o.resultadoN)}>{conSigno(o.resultadoN, 2)}</td>
                    <td className={tono(o.resultadoEur)}>{eur(o.resultadoEur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bot-bloque">
        <h3>Registro</h3>
        {eventos.length === 0 ? <p className="bot-nota">Nada todavía.</p> : (
          <ul className="bot-eventos tor-eventos">
            {eventos.map((e, i) => <li key={i}><span className="bot-hora">{horaEvento(e.hora)}</span><b>{nombre(e.ticker)}</b> · {e.texto}</li>)}
          </ul>
        )}
      </section>

      <section className="bot-bloque">
        <h3>Configuración</h3>
        <div className="bot-form">
          <label>Sistema
            <select value={editando.sistema} onChange={e => cambiar('sistema', Number(e.target.value))}>
              <option value={1}>1: entra en 20 (55 con el filtro), sale en 10</option>
              <option value={2}>2: entra en 55, sale en 20</option>
            </select>
          </label>
          <label>Lados
            <select value={editando.lados} onChange={e => cambiar('lados', e.target.value)}>
              <option value="largos">Solo largos</option>
              <option value="ambos">Largos y cortos</option>
              <option value="cortos">Solo cortos</option>
            </select>
          </label>
          <label>1 N por unidad (% del saldo)
            <input type="number" min="0.05" max="5" step="0.05" value={editando.riesgoPct} onChange={e => cambiar('riesgoPct', e.target.value)} />
          </label>
          <label>Unidades por índice
            <input type="number" min="1" max="10" step="1" value={editando.maxUnidades} onChange={e => cambiar('maxUnidades', e.target.value)} />
          </label>
          <label>Unidades por grupo y sentido
            <input type="number" min="1" max="30" step="1" value={editando.maxGrupo} onChange={e => cambiar('maxGrupo', e.target.value)} />
          </label>
          <label>Unidades por sentido
            <input type="number" min="1" max="50" step="1" value={editando.maxSentido} onChange={e => cambiar('maxSentido', e.target.value)} />
          </label>
          <label>Reducción por drawdown
            <select value={editando.reduccionDD ? 'si' : 'no'} onChange={e => cambiar('reduccionDD', e.target.value === 'si')}>
              <option value="si">Sí: −20% de capital por cada −10%</option>
              <option value="no">No</option>
            </select>
          </label>
        </div>
        <p className="bot-nota">
          Una unidad es el tamaño con el que un movimiento de 1 N (el ATR de 20 sesiones) cuesta ese % del saldo; el stop va a {reglas.stopN} N del último relleno, así que cada unidad arriesga el doble.
          El backtest usa un 0,2% repartido en 8 índices; las tortugas originales, un 1%. Si el mínimo de IG obliga a más del doble de lo que toca, ese índice no opera (sale en la columna Unidad).
          Pirámide: una unidad más cada {num(reglas.pasoN, 1)} N a favor, y el stop de todas sube a {reglas.stopN} N de la última. El stop lo guarda IG, así que también puede saltar fuera de la sesión;
          las entradas, los añadidos y la salida por el canal, solo dentro de ella y a mercado.
          Los avisos van al mismo Telegram que el bot SRS (se conecta en esa pestaña). Un cambio de sistema, lados o riesgo rehace los planes de todos los índices.
        </p>
        <button className="diario-boton" disabled={ocupado || !form} onClick={() => {
          const { sistema, lados: l, riesgoPct, maxUnidades, maxGrupo, maxSentido, reduccionDD } = form
          guardarConfig({ sistema, lados: l, riesgoPct, maxUnidades, maxGrupo, maxSentido, reduccionDD }).then(() => setForm(null))
        }}>Guardar configuración</button>
      </section>
    </div>
  )
}

// Por dónde sale una posición: el canal de salida o el stop, el que esté más cerca
function salidaDe(pos, hoy) {
  const canal = hoy.salida[pos.lado]
  if (pos.stop == null) return canal
  return pos.lado === 'largo' ? Math.max(canal, pos.stop) : Math.min(canal, pos.stop)
}

function FilaIndice({ m, config, ocupado, reglas, alternar }) {
  const { plan, posicion: pos } = m
  const hoy = plan && !plan.error ? plan : null
  const c = pos ? cuentasDe(pos, m.precio) : null
  const siguiente = pos ? pos.unidades.at(-1).entrada + dir(pos.lado) * reglas.pasoN * pos.n0 : null
  const entrada = !hoy ? '—'
    : pos ? (pos.unidades.length < config.maxUnidades ? `añade en ${num(siguiente)}` : 'pirámide llena')
    : [config.lados !== 'cortos' && `> ${num(hoy.entrada.largo.nivel)}`, config.lados !== 'largos' && `< ${num(hoy.entrada.corto.nivel)}`].filter(Boolean).join(' · ')
  return (
    <tr className={m.encendido ? '' : 'tor-apagado'}>
      <td className="bot-celda-texto">
        <label className="tor-indice">
          <input type="checkbox" checked={m.encendido} disabled={ocupado} onChange={e => alternar(e.target.checked)} />
          <span><b>{m.nombre}</b><small className="tor-sub">{m.grupo}</small></span>
        </label>
      </td>
      <td className="bot-celda-texto">{m.enSesion ? <span className="bot-pos">abierta</span> : m.proxima ? `abre ${fechaHora(m.proxima)}` : '—'}</td>
      <td className="tor-num">{hoy ? num(hoy.n) : '—'}</td>
      <td className="tor-num">{num(m.precio)}</td>
      <td className="bot-celda-texto" title={hoy ? `Canal de ${hoy.k} sesiones${hoy.filtro ? ': la ruptura de 20 anterior habría ganado, así que espera a la de 55' : ''}` : ''}>
        {entrada}{hoy && !pos ? <small> ({hoy.k}{hoy.filtro ? ', filtro' : ''})</small> : null}
      </td>
      <td>{hoy && pos ? <>{num(salidaDe(pos, hoy))}<small className="tor-sub">{salidaDe(pos, hoy) === pos.stop ? 'stop' : `canal de ${hoy.kSalida}`}</small></> : '—'}</td>
      <td className="bot-celda-texto">
        {!plan ? '—'
          : plan.error ? <><span className="bot-neg">sin plan</span><small className="tor-sub tor-motivo">{plan.error}</small></>
          : plan.unidad?.ok ? <>{num(plan.unidad.tamano)} contratos<small className="tor-sub">{Math.round(plan.unidad.eurPorN)} € por N{plan.provisional ? ' · provisional' : ''}</small></>
          : <><span className="bot-neg">no cabe</span><small className="tor-sub tor-motivo">{plan.unidad?.motivo}</small></>}
      </td>
      <td className="bot-celda-texto">
        {pos ? <>{pos.lado === 'largo' ? 'Largo' : 'Corto'} ×{pos.unidades.length} · {num(c.contratos)} c. a {num(c.medio)}<small className="tor-sub">stop {num(pos.stop)} · desde {pos.abierta}{pos.recuperada ? ' · recuperada' : ''}</small></>
          : m.intento ? 'mandando la orden…' : '—'}
      </td>
      <td className={`tor-num ${tono(c?.abierto)}`}>
        {c ? <>{eur(c.abierto)}<small className={`tor-sub ${tono(c.alStop)}`}>al stop {eur(c.alStop)}</small></> : '—'}
      </td>
    </tr>
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
