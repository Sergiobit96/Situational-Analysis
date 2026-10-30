import { useEffect, useState, useCallback } from 'react'
import { conClaveBot, guardarClaveBot } from './claveBot'
import './Bot.css'

// Las tortugas en las acciones del S&P 500, en la cuenta paper de Alpaca
// (server/bot-tortugas-acciones.js, /api/bot/tortugas-acciones).

const API = '/api/bot/tortugas-acciones'
const num = (n, dec = 2) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec }))
const dinero = n => (n == null ? '—' : `${n > 0 ? '+' : ''}${num(n)} $`)
const tono = n => (n == null ? '' : n > 0 ? 'bot-pos' : n < 0 ? 'bot-neg' : '')
const fechaHora = iso => (iso ? new Date(iso).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')
const dirDe = lado => (lado === 'largo' ? 1 : -1)

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

function Chips({ opciones, valor, onCambio, disabled }) {
  return (
    <div className="estrategias-nav">
      {opciones.map(o => (
        <button key={String(o.v)} disabled={disabled} className={`estrategia-chip ${(Array.isArray(valor) ? valor.includes(o.v) : valor === o.v) ? 'activo' : ''}`} onClick={() => onCambio(o.v)}>{o.label}</button>
      ))}
    </div>
  )
}

export default function BotTortugasAcciones() {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const [pideClave, setPideClave] = useState(false)
  const [clave, setClave] = useState('')
  const [ocupado, setOcupado] = useState(false)

  const cargar = useCallback(async () => {
    try {
      setDatos(await pedir(API))
      setError(null)
      setPideClave(false)
    } catch (err) {
      setError(err.message)
      if (err.necesitaClave) setPideClave(true)
    }
  }, [])

  useEffect(() => {
    const primera = setTimeout(cargar, 0)
    const reloj = setInterval(cargar, 15000)
    return () => { clearTimeout(primera); clearInterval(reloj) }
  }, [cargar])

  async function accion(hacer) {
    setOcupado(true)
    try { await hacer(); await cargar() }
    catch (err) { setError(err.message) }
    finally { setOcupado(false) }
  }
  const guardarConfig = cambios => accion(() => pedir(`${API}/config`, { method: 'PUT', body: JSON.stringify(cambios) }))
  const pararYCerrar = () => {
    if (!window.confirm('¿Apagar el bot de las tortugas en acciones y cerrar ahora todas sus posiciones en Alpaca?')) return
    accion(() => pedir(`${API}/parar`, { method: 'POST' }))
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

  const { config, reglas, plan, posiciones, cerca, operaciones, eventos, sinEntrar, unidad, picoEquity, opera, sectores } = datos
  const porN = config.riesgoPct / reglas.picoN
  const abierto = posiciones.reduce((s, p) => s + (p.precio == null ? 0 : (p.precio - p.entradaMedia) * dirDe(p.lado) * p.acciones), 0)
  const unidadesLado = lado => posiciones.filter(p => p.lado === lado).reduce((s, p) => s + 1 + (p.unidades.length - 1) * (p.anadido ?? 1), 0)
  const cerradas = operaciones.filter(o => o.resultado != null)
  const total = cerradas.reduce((s, o) => s + o.resultado, 0)

  return (
    <div className="bot-page">
      <section className="bot-cabecera">
        <div>
          <div className={`bot-interruptor ${config.activo ? 'encendido' : ''}`}>{config.activo ? '● Encendido' : '○ Apagado'}</div>
          <p className="bot-nota">
            Tortugas en las {plan?.conNiveles ?? '—'} acciones del S&P 500 · Sistema {config.sistemas.join(' y ')} · {config.lados} · pirámide llena hasta el stop = {num(config.riesgoPct)} % del capital (1 N por unidad = {num(porN, 3)} %) · cuenta paper de Alpaca (dinero ficticio)
          </p>
          {!opera && <p className="bot-aviso">Este servidor no opera (BOT_OPERA no es 1): el registro es el suyo, pero las órdenes las manda el servidor que tenga BOT_OPERA=1 (y las claves de Alpaca).</p>}
        </div>
        <div className="bot-botones">
          <button className="diario-boton" disabled={ocupado} onClick={() => guardarConfig({ activo: !config.activo })}>{config.activo ? 'Apagar' : 'Encender'}</button>
          <button className="diario-boton bot-peligro" disabled={ocupado} onClick={pararYCerrar}>Parar y cerrar todo</button>
        </div>
      </section>

      {error && <p className="bot-error">{error}</p>}

      <section className="bot-bloque">
        <div className="bot-tarjeta-datos">
          <div className="bot-dato"><span>Plan</span><b className="bot-tile-valor">{plan ? `sesión del ${plan.fecha}` : 'sin hacer'}</b><small>{plan ? `con el cierre del ${plan.anterior}; hecho el ${fechaHora(plan.hecho)}` : 'a las 17:30 de Nueva York, o al abrir'}</small></div>
          <div className="bot-dato"><span>Unidad</span><b className="bot-tile-valor">{unidad?.riesgoN ? `${num(unidad.riesgoN)} $ por N` : '—'}</b><small>{unidad?.capital ? `capital ${num(unidad.capital, 0)} $${picoEquity ? `; máximo ${num(picoEquity, 0)} $` : ''}` : 'se calcula en la sesión'}</small></div>
          <div className="bot-dato"><span>Posiciones</span><b className="bot-tile-valor">{posiciones.length}</b><small>{num(unidadesLado('largo'), 1)} / {config.maxSentido} unidades compradas{config.lados !== 'largos' ? `, ${num(unidadesLado('corto'), 1)} vendidas` : ''}</small></div>
          <div className="bot-dato"><span>Resultado abierto</span><b className={`bot-tile-valor ${tono(abierto)}`}>{posiciones.length ? dinero(abierto) : '—'}</b></div>
          <div className="bot-dato"><span>Cerradas</span><b className={`bot-tile-valor ${tono(total)}`}>{cerradas.length ? dinero(total) : '—'}</b><small>{cerradas.length} operaciones, {cerradas.filter(o => o.resultado > 0).length} ganadoras</small></div>
        </div>
        {plan && Object.keys(plan.sinNiveles ?? {}).length > 0 && (
          <details className="bot-nota"><summary>{Object.keys(plan.sinNiveles).length} acciones sin niveles hoy</summary>
            {Object.entries(plan.sinNiveles).map(([s, m]) => <div key={s}><b>{s}</b>: {m}</div>)}
          </details>
        )}
      </section>

      <section className="bot-bloque">
        <h3>Posiciones</h3>
        {posiciones.length === 0 ? <p className="bot-nota">Ninguna abierta.</p> : (
          <div className="velas-tabla-wrap tor-tabla-wrap">
            <table className="velas-tabla bot-tabla tor-tabla">
              <thead><tr><th>Acción</th><th>Sistema</th><th>Lado</th><th className="tor-num">Unidades</th><th className="tor-num">Acciones</th><th className="tor-num">Entrada</th><th className="tor-num">Ahora</th><th className="tor-num">Stop</th><th className="tor-num">Salida canal</th><th className="tor-num">Añade en</th><th className="tor-num">Resultado</th></tr></thead>
              <tbody>
                {posiciones.map(p => {
                  const r = p.precio == null ? null : (p.precio - p.entradaMedia) * dirDe(p.lado) * p.acciones
                  return (
                    <tr key={p.simbolo}>
                      <td className="bot-celda-texto"><b>{p.simbolo}</b> <small className="bot-nota">{p.sector}</small></td>
                      <td className="bot-celda-texto">S{p.sistema} ({p.k})</td>
                      <td className="bot-celda-texto"><span className={`bot-pill ${p.lado}`}>{p.lado === 'largo' ? 'Compra' : 'Venta'}</span></td>
                      <td className="tor-num">{p.unidades.length}</td>
                      <td className="tor-num">{p.acciones}</td>
                      <td className="tor-num">{num(p.entradaMedia)}</td>
                      <td className="tor-num">{num(p.precio)}</td>
                      <td className={`tor-num ${p.stopId ? '' : 'bot-neg'}`} title={p.stopId ? 'Orden stop puesta en Alpaca' : 'Sin orden stop en Alpaca: se pone en la siguiente vuelta'}>{num(p.stop)}</td>
                      <td className="tor-num">{num(p.salida)}</td>
                      <td className="tor-num">{p.unidades.length < config.maxUnidades ? num(p.siguiente) : 'llena'}</td>
                      <td className={`tor-num ${tono(r)}`}>{dinero(r)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bot-bloque">
        <h3>Más cerca de romper</h3>
        <p className="bot-nota">Lo que le falta a cada acción para su nivel de entrada, en N, con el último precio (fuera de la sesión, el cierre). Entra si el precio pasa el nivel y no está más de ½ N más allá (salvo a la apertura).</p>
        {cerca.length === 0 ? <p className="bot-nota">Sin plan todavía.</p> : (
          <div className="velas-tabla-wrap tor-tabla-wrap">
            <table className="velas-tabla bot-tabla tor-tabla">
              <thead><tr><th>Acción</th><th>Sector</th><th>Sistema</th><th>Lado</th><th className="tor-num">Nivel</th><th className="tor-num">Precio</th><th className="tor-num">N</th><th className="tor-num">Falta</th></tr></thead>
              <tbody>
                {cerca.slice(0, 25).map(c => (
                  <tr key={`${c.simbolo}|${c.lado}|${c.nivel}`}>
                    <td className="bot-celda-texto"><b>{c.simbolo}</b></td>
                    <td className="bot-celda-texto">{c.sector}</td>
                    <td className="bot-celda-texto">{c.sistemas.map(x => `S${x.sistema} (${x.k})`).join(' y ')}</td>
                    <td className="bot-celda-texto">{c.lado}</td>
                    <td className="tor-num">{num(c.nivel)}</td>
                    <td className="tor-num">{num(c.precio)}</td>
                    <td className="tor-num">{num(c.n)}</td>
                    <td className={`tor-num ${c.faltaN <= 0 ? 'bot-pos' : ''}`}>{c.faltaN <= 0 ? 'rota' : `${num(c.faltaN)} N`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bot-bloque">
        <h3>Ajustes</h3>
        <div className="bot-form">
          <label>Sistemas<Chips disabled={ocupado} valor={config.sistemas} onCambio={v => guardarConfig({ sistemas: config.sistemas.includes(v) ? config.sistemas.filter(x => x !== v) : [...config.sistemas, v] })}
            opciones={[{ v: 1, label: 'S1 (20/10)' }, { v: 2, label: 'S2 (55/20)' }]} /></label>
          <label>Lados<Chips disabled={ocupado} valor={config.lados} onCambio={v => guardarConfig({ lados: v })} opciones={[{ v: 'largos', label: 'Largos' }, { v: 'ambos', label: 'Ambos' }, { v: 'cortos', label: 'Cortos' }]} /></label>
          <label>Filtro del S1<Chips disabled={ocupado} valor={config.filtroS1} onCambio={v => guardarConfig({ filtroS1: v })} opciones={[{ v: true, label: 'Sí' }, { v: false, label: 'No' }]} /></label>
          <label>Riesgo de la pirámide llena<Chips disabled={ocupado} valor={config.riesgoPct} onCambio={v => guardarConfig({ riesgoPct: v })} opciones={[0.1, 0.25, 0.5, 1].map(v => ({ v, label: `${num(v, v < 0.5 && v !== 0.1 ? 2 : 1)} %` }))} /></label>
          <label>Unidades por acción<Chips disabled={ocupado} valor={config.maxUnidades} onCambio={v => guardarConfig({ maxUnidades: v })} opciones={[1, 4, 6].map(v => ({ v, label: String(v) }))} /></label>
          <label>Cada añadido<Chips disabled={ocupado} valor={config.anadido} onCambio={v => guardarConfig({ anadido: v })} opciones={[{ v: 1, label: '1 unidad' }, { v: 0.5, label: '½ unidad' }]} /></label>
          <label>Unidades por sector y sentido<input type="number" min="1" max="300" defaultValue={config.maxGrupo} key={`g${config.maxGrupo}`} onBlur={e => Number(e.target.value) !== config.maxGrupo && guardarConfig({ maxGrupo: Number(e.target.value) })} /></label>
          <label>Unidades por sentido<input type="number" min="1" max="1000" defaultValue={config.maxSentido} key={`s${config.maxSentido}`} onBlur={e => Number(e.target.value) !== config.maxSentido && guardarConfig({ maxSentido: Number(e.target.value) })} /></label>
        </div>
        <p className="bot-nota">
          Stop a {reglas.stopN} N del último relleno (orden stop en Alpaca), un añadido cada {num(reglas.pasoN, 1)} N, nominal como mucho {reglas.apalancamiento} veces el equity.
          {' '}Reducción por caída: un 20 % menos de capital por cada 10 % por debajo del máximo, y vuelta al tamaño normal al recuperarse{config.reduccionDD ? '' : ' (APAGADA)'}.
          {' '}Una acción la lleva un solo sistema: el primero que entra.
        </p>
        <details className="bot-nota">
          <summary>Sectores que no opera ({config.sectoresFuera.length})</summary>
          <Chips disabled={ocupado} valor={config.sectoresFuera} opciones={sectores.map(s => ({ v: s, label: s }))}
            onCambio={s => guardarConfig({ sectoresFuera: config.sectoresFuera.includes(s) ? config.sectoresFuera.filter(x => x !== s) : [...config.sectoresFuera, s] })} />
        </details>
      </section>

      {operaciones.length > 0 && (
        <section className="bot-bloque">
          <h3>Operaciones cerradas</h3>
          <div className="velas-tabla-wrap tor-tabla-wrap">
            <table className="velas-tabla bot-tabla tor-tabla">
              <thead><tr><th>Cerrada</th><th>Acción</th><th>Sistema</th><th>Lado</th><th className="tor-num">Unidades</th><th className="tor-num">Entrada</th><th className="tor-num">Salida</th><th>Motivo</th><th className="tor-num">Resultado</th><th className="tor-num">En N</th></tr></thead>
              <tbody>
                {operaciones.map(o => (
                  <tr key={`${o.simbolo}|${o.cerrada}`}>
                    <td className="bot-celda-texto">{fechaHora(o.cerrada)}</td>
                    <td className="bot-celda-texto"><b>{o.simbolo}</b></td>
                    <td className="bot-celda-texto">S{o.sistema}</td>
                    <td className="bot-celda-texto">{o.lado}</td>
                    <td className="tor-num">{o.unidades}</td>
                    <td className="tor-num">{num(o.entrada)}</td>
                    <td className="tor-num">{num(o.salida)}</td>
                    <td className="bot-celda-texto">{o.motivo}</td>
                    <td className={`tor-num ${tono(o.resultado)}`}>{dinero(o.resultado)}</td>
                    <td className={`tor-num ${tono(o.resultadoN)}`}>{num(o.resultadoN)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="bot-bloque">
        <h3>Eventos</h3>
        {eventos.length === 0 ? <p className="bot-nota">Nada todavía.</p> : (
          <ul className="bot-eventos">
            {eventos.map((e, i) => <li key={i}><span className="bot-hora">{fechaHora(e.hora)}</span>{e.simbolo && <b>{e.simbolo}{e.sistema ? ` S${e.sistema}` : ''} · </b>}{e.texto}</li>)}
          </ul>
        )}
      </section>

      {sinEntrar.length > 0 && (
        <section className="bot-bloque">
          <h3>Rupturas en las que no entró</h3>
          <ul className="bot-eventos">
            {sinEntrar.map((x, i) => <li key={i}><span className="bot-hora">{fechaHora(x.hora)}</span><b>{x.simbolo} S{x.sistema} {x.lado} · </b>{x.motivo}</li>)}
          </ul>
        </section>
      )}
    </div>
  )
}
