import { useEffect, useState, useCallback } from 'react'
import './Bot.css'

// Cómo van los bots para quien no tiene la clave (/api/resumen-bots): si están encendidos, lo
// que tienen abierto y lo que han dejado, en % del saldo de su cuenta. Solo mira: los mandos
// siguen en la pestaña Bots, con la clave.

const pct = x => (x == null ? '—' : `${x > 0.005 ? '+' : x < -0.005 ? '−' : ''}${Math.abs(x).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`)
const signo = x => (x == null ? '' : x > 0.005 ? 'bot-pos' : x < -0.005 ? 'bot-neg' : '')
const fecha = t => (t ? new Date(t * 1000).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')
const LADO = { largo: 'Compra', corto: 'Venta' }

function Dato({ nombre, valor }) {
  return (
    <div className="bot-dato">
      <span>{nombre}</span>
      <b className={`bot-tile-valor ${signo(valor)}`}>{pct(valor)}</b>
    </div>
  )
}

function Estado({ b }) {
  if (!b.encendido) return <span className="bot-interruptor">Apagado</span>
  if (b.parado) return <span className="bot-interruptor bot-neg">Encendido, pero parado</span>
  return <span className="bot-interruptor encendido">{b.enMarcha ? 'Encendido' : 'Encendido (no opera en este servidor)'}</span>
}

function TarjetaBot({ b }) {
  const { totales: tot } = b
  return (
    <section className="bot-bloque">
      <div className="bot-cabecera">
        <div>
          <h3>{b.nombre}</h3>
          <span className="bot-nota">{b.cuenta}</span>
        </div>
        <Estado b={b} />
      </div>

      <div className="resumen-bots-datos">
        <Dato nombre="Hoy" valor={tot.hoy} />
        <Dato nombre="7 días" valor={tot.semana} />
        <Dato nombre="30 días" valor={tot.mes} />
        <Dato nombre="Desde el principio" valor={tot.total} />
        <div className="bot-dato">
          <span>Operaciones cerradas</span>
          <b className="bot-tile-valor">{tot.operaciones}{tot.operaciones ? ` (${Math.round(100 * tot.ganadoras / tot.operaciones)} % ganadoras)` : ''}</b>
        </div>
      </div>

      <h4 className="resumen-bots-sub">Abierto ahora</h4>
      {b.abiertas.length ? (
        <div className="velas-tabla-wrap">
          <table className="velas-tabla bot-tabla">
            <thead><tr><th>Instrumento</th><th>Sentido</th><th>Desde</th><th>Posiciones</th><th>Va</th></tr></thead>
            <tbody>
              {b.abiertas.map(a => (
                <tr key={`${a.instrumento}-${a.lado}`}>
                  <td>{a.instrumento}</td><td>{LADO[a.lado] ?? a.lado}</td><td>{fecha(a.desde)}</td><td>{a.unidades}</td>
                  <td className={signo(a.pct)}>{pct(a.pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="bot-nota">Nada abierto.</p>}

      <h4 className="resumen-bots-sub">Últimas cerradas</h4>
      {b.ultimas.length ? (
        <div className="velas-tabla-wrap">
          <table className="velas-tabla bot-tabla">
            <thead><tr><th>Cerrada</th><th>Instrumento</th><th>Sentido</th><th>Resultado</th></tr></thead>
            <tbody>
              {b.ultimas.map((c, i) => (
                <tr key={i}>
                  <td>{fecha(c.hora)}</td><td>{c.instrumento}{c.nota ? <span className="bot-nota"> · {c.nota}</span> : null}</td>
                  <td>{LADO[c.lado] ?? '—'}</td><td className={signo(c.pct)}>{pct(c.pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="bot-nota">Aún no ha cerrado ninguna.</p>}
    </section>
  )
}

export default function ResumenBots() {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)

  const cargar = useCallback(async () => {
    try {
      const r = await fetch('/api/resumen-bots')
      const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
      if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`)
      setDatos(j)
      setError(null)
    } catch (err) { setError(err.message) }
  }, [])

  // al abrir la pestaña y cada minuto (el servidor lo guarda medio minuto)
  useEffect(() => {
    const primera = setTimeout(cargar, 0)
    const reloj = setInterval(cargar, 60000)
    return () => { clearTimeout(primera); clearInterval(reloj) }
  }, [cargar])

  if (!datos) {
    return <div className="bot-page">{error ? <p className="bot-error">{error}</p> : <p className="bot-nota">Cargando…</p>}</div>
  }
  return (
    <div className="bot-page">
      <p className="bot-nota">
        Los resultados van en % del saldo de ahora de la cuenta de cada bot (las de IG y Alpaca son de prueba, sin dinero real).
        Actualizado {fecha(datos.hora)}.
      </p>
      {error && <p className="bot-error">{error}</p>}
      {datos.bots.length ? datos.bots.map(b => <TarjetaBot key={b.nombre} b={b} />) : <p className="bot-nota">No hay bots en este servidor.</p>}
    </div>
  )
}
