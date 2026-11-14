import { useState, useCallback, useMemo, useEffect } from 'react'
import { useRefresco } from './refresco'
import { conClaveBot, guardarClaveBot } from './claveBot'
import './Bot.css'

// Las operaciones cerradas de todos los bots juntas (/api/bot/historial, server/resumen-bots.js),
// con filtros por bróker, bot, instrumento y fecha. El resultado va en la moneda de la cuenta de
// cada bot (€ en IG y en IB, $ en Alpaca): los totales se dan por moneda, sin mezclarlas.

const ZONA = 'Europe/Madrid'
const POR_PAGINA = 100
const GUARDADO = 'sa.historial-bots'
const LADO = { largo: 'Compra', corto: 'Venta' }
const SIMBOLO = { EUR: '€', USD: '$' }
const BROKERS = ['IG', 'IB', 'Alpaca']
const FILTROS_VACIOS = { broker: '', bot: '', instrumento: '', desde: '', hasta: '' }

const num = (n, dec = 2) => n.toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec })
const dinero = (n, moneda) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${num(Math.abs(n))} ${SIMBOLO[moneda] ?? moneda ?? ''}`.trim())
const tono = n => (n == null ? '' : n > 0 ? 'bot-pos' : n < 0 ? 'bot-neg' : '')
const fechaHora = t => new Date(t * 1000).toLocaleString('es-ES', { timeZone: ZONA, day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })
// el día de Madrid en AAAA-MM-DD, el formato de los <input type="date">
const diaDe = t => new Date(t * 1000).toLocaleDateString('sv-SE', { timeZone: ZONA })
const haceDias = n => diaDe(Date.now() / 1000 - n * 86400)

const ATAJOS = [
  { nombre: 'Hoy', desde: () => haceDias(0) },
  { nombre: '7 días', desde: () => haceDias(6) },
  { nombre: '30 días', desde: () => haceDias(29) },
  { nombre: 'Este año', desde: () => `${haceDias(0).slice(0, 4)}-01-01` },
]

function leerFiltros() {
  try { return { ...FILTROS_VACIOS, ...JSON.parse(localStorage.getItem(GUARDADO) ?? '{}') } } catch { return FILTROS_VACIOS }
}

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

// Una lista desplegable con «Todos» y las opciones que haya
function Desplegable({ nombre, valor, opciones, cambiar }) {
  return (
    <label className="historial-campo">
      <span>{nombre}</span>
      <select value={valor} onChange={e => cambiar(e.target.value)}>
        <option value="">Todos</option>
        {opciones.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  )
}

export default function HistorialBots() {
  const [operaciones, setOperaciones] = useState(null)
  const [error, setError] = useState(null)
  const [pideClave, setPideClave] = useState(false)
  const [clave, setClave] = useState('')
  const [filtros, setFiltros] = useState(leerFiltros)
  const [mostradas, setMostradas] = useState(POR_PAGINA)

  const cargar = useCallback(async () => {
    try {
      setOperaciones((await pedir('/api/bot/historial')).operaciones)
      setError(null)
      setPideClave(false)
    } catch (err) {
      setError(err.message)
      if (err.necesitaClave) setPideClave(true)
    }
  }, [])
  // lo cerrado cambia poco: al abrir la vista y cada minuto
  useRefresco(cargar, 60000)

  useEffect(() => {
    try { localStorage.setItem(GUARDADO, JSON.stringify(filtros)) } catch { /* sin almacenamiento */ }
  }, [filtros])
  const cambiar = (campo, valor) => { setFiltros(f => ({ ...f, [campo]: valor })); setMostradas(POR_PAGINA) }

  const lista = useMemo(() => operaciones ?? [], [operaciones])
  // cada desplegable ofrece lo que queda con los otros filtros de arriba puestos (el elegido
  // se queda en la lista aunque ya no salga, para que se vea qué filtra)
  const conBroker = lista.filter(o => !filtros.broker || o.broker === filtros.broker)
  const opcionesBot = [...new Set([...conBroker.map(o => o.bot), filtros.bot].filter(Boolean))].sort()
  const conBot = conBroker.filter(o => !filtros.bot || o.bot === filtros.bot)
  const opcionesInstrumento = [...new Set([...conBot.map(o => o.instrumento), filtros.instrumento].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'))
  const filtradas = conBot.filter(o => {
    if (filtros.instrumento && o.instrumento !== filtros.instrumento) return false
    const dia = diaDe(o.hora)
    return (!filtros.desde || dia >= filtros.desde) && (!filtros.hasta || dia <= filtros.hasta)
  })

  // los totales de lo filtrado, uno por moneda
  const porMoneda = [...filtradas.reduce((m, o) => {
    const g = m.get(o.moneda) ?? { moneda: o.moneda, operaciones: 0, ganadoras: 0, resultado: 0 }
    g.operaciones++
    if (o.resultado > 0) g.ganadoras++
    g.resultado += o.resultado
    return m.set(o.moneda, g)
  }, new Map()).values()]
  const ganadoras = filtradas.filter(o => o.resultado > 0).length
  const hayFiltros = Object.values(filtros).some(Boolean)

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
  if (!operaciones) {
    return <div className="bot-page">{error ? <p className="bot-error">{error}</p> : <p className="bot-nota">Cargando…</p>}</div>
  }

  return (
    <div className="bot-page">
      <section className="bot-bloque">
        <h3>Historial de operaciones <small className="bot-nota">({lista.length} cerradas en total)</small></h3>
        <p className="bot-nota">
          Lo cerrado por todos los bots de este servidor. El resultado va en la moneda de la cuenta de cada bot: € en IG y en IB, $ en Alpaca. Las fechas son las del cierre, en hora de Madrid.
        </p>
        {error && <p className="bot-error">{error}</p>}

        <div className="historial-filtros">
          <div className="historial-campo">
            <span>Bróker</span>
            <div className="historial-chips">
              {['', ...BROKERS].map(b => (
                <button key={b || 'todos'} className={`estrategia-chip ${filtros.broker === b ? 'activo' : ''}`} onClick={() => cambiar('broker', b)}>{b || 'Todos'}</button>
              ))}
            </div>
          </div>
          <Desplegable nombre="Bot" valor={filtros.bot} opciones={opcionesBot} cambiar={v => cambiar('bot', v)} />
          <Desplegable nombre="Instrumento" valor={filtros.instrumento} opciones={opcionesInstrumento} cambiar={v => cambiar('instrumento', v)} />
          <label className="historial-campo">
            <span>Desde</span>
            <input type="date" value={filtros.desde} max={filtros.hasta || undefined} onChange={e => cambiar('desde', e.target.value)} />
          </label>
          <label className="historial-campo">
            <span>Hasta</span>
            <input type="date" value={filtros.hasta} min={filtros.desde || undefined} onChange={e => cambiar('hasta', e.target.value)} />
          </label>
          <div className="historial-campo">
            <span>Periodo</span>
            <div className="historial-chips">
              {ATAJOS.map(a => (
                <button key={a.nombre} className="estrategia-chip" onClick={() => { cambiar('desde', a.desde()); cambiar('hasta', '') }}>{a.nombre}</button>
              ))}
            </div>
          </div>
          {hayFiltros && (
            <button className="diario-boton historial-limpiar" onClick={() => { setFiltros(FILTROS_VACIOS); setMostradas(POR_PAGINA) }}>Quitar filtros</button>
          )}
        </div>

        <div className="bot-tarjeta-datos">
          <div className="bot-dato"><span>Operaciones</span><b className="bot-tile-valor">{filtradas.length}</b>
            {filtradas.length > 0 && <small>{Math.round(100 * ganadoras / filtradas.length)} % ganadoras</small>}</div>
          {porMoneda.map(g => (
            <div className="bot-dato" key={g.moneda ?? '?'}>
              <span>Resultado{porMoneda.length > 1 ? ` en ${SIMBOLO[g.moneda] ?? g.moneda}` : ''}</span>
              <b className={`bot-tile-valor ${tono(g.resultado)}`}>{dinero(g.resultado, g.moneda)}</b>
              {porMoneda.length > 1 && <small>{g.operaciones} operaciones</small>}
            </div>
          ))}
        </div>
      </section>

      <section className="bot-bloque">
        {filtradas.length === 0 ? (
          <p className="bot-nota">{lista.length ? 'Ninguna operación con estos filtros.' : 'Los bots aún no han cerrado ninguna operación.'}</p>
        ) : (
          <>
            <div className="velas-tabla-wrap">
              <table className="velas-tabla bot-tabla">
                <thead><tr><th>Cerrada</th><th>Bróker</th><th>Bot</th><th>Instrumento</th><th>Sentido</th><th>Resultado</th></tr></thead>
                <tbody>
                  {filtradas.slice(0, mostradas).map((o, i) => (
                    <tr key={`${o.bot}-${o.hora}-${o.instrumento}-${i}`}>
                      <td>{fechaHora(o.hora)}</td>
                      <td className="bot-celda-texto">{o.broker}</td>
                      <td className="bot-celda-texto">{o.bot}{o.nota ? <span className="bot-nota"> · {o.nota}</span> : null}</td>
                      <td className="bot-celda-texto">{o.instrumento}</td>
                      <td className="bot-celda-texto">{LADO[o.lado] ?? '—'}</td>
                      <td className={tono(o.resultado)}>{dinero(o.resultado, o.moneda)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filtradas.length > mostradas && (
              <button className="diario-boton resumen-mas" onClick={() => setMostradas(n => n + POR_PAGINA)}>
                Ver {Math.min(POR_PAGINA, filtradas.length - mostradas)} más (quedan {filtradas.length - mostradas})
              </button>
            )}
          </>
        )}
      </section>
    </div>
  )
}
