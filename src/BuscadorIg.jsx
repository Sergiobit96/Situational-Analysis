import { useState } from 'react'
import { PREFIJO_IG } from './graficoConfig'

// Buscador de mercados de IG para la pestaña Gráfico: cualquier mercado que dé la cuenta
// (divisas, bonos, acciones, cripto…) o los de las listas de seguimiento de IG. Al elegir
// uno, el gráfico activo lo abre con la fuente IG. Las búsquedas van al pulsar Buscar, no
// con cada letra: IG corta en cuanto se le hacen unas decenas de peticiones por minuto.

// Las opciones (OP.…) son casi todo lo que devuelve IG en algunas búsquedas y no es lo que
// se busca para un gráfico: van al final
const esOpcion = m => m.epic.startsWith('OP.')
const ordenar = mercados => [...mercados].sort((a, b) =>
  (esOpcion(a) - esOpcion(b)) || ((a.bid == null) - (b.bid == null)))

async function pedir(url) {
  const r = await fetch(url)
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
  if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`)
  return j
}

function Fila({ m, onElegir }) {
  const detalles = [m.tipo, m.vence && m.vence !== '-' ? `vence ${m.vence}` : null, m.epic].filter(Boolean)
  return (
    <button className="grafico-ig-fila" onClick={() => onElegir({ ticker: PREFIJO_IG + m.epic, nombre: m.nombre })}>
      <span>{m.nombre}</span>
      <small>{detalles.join(' · ')}</small>
      {'bid' in m && (
        <small className="grafico-ig-precio">
          {m.bid == null ? 'sin precio en esta cuenta (puede que no haya directo)' : `${m.bid} / ${m.oferta}${m.estado && m.estado !== 'TRADEABLE' ? ` · ${m.estado}` : ''}`}
        </small>
      )}
    </button>
  )
}

export default function BuscadorIg({ guardados, onElegir, onOlvidar, onCerrar }) {
  const [termino, setTermino] = useState('')
  const [resultados, setResultados] = useState(null)   // null: aún no se ha buscado
  const [listas, setListas] = useState(null)
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState(null)

  const traer = async fn => {
    setCargando(true)
    setError(null)
    try { await fn() } catch (err) { setError(err.message) } finally { setCargando(false) }
  }
  const buscar = e => {
    e.preventDefault()
    const q = termino.trim()
    if (!q) return
    traer(async () => { setListas(null); setResultados(ordenar(await pedir(`/api/ig/buscar?${new URLSearchParams({ q })}`))) })
  }
  const verListas = () => traer(async () => { setResultados(null); setListas(await pedir('/api/ig/listas')) })

  return (
    <div className="grafico-ig" onKeyDown={e => { if (e.key === 'Escape') onCerrar() }}>
      <form className="grafico-ig-form" onSubmit={buscar}>
        <input
          autoFocus
          value={termino}
          onChange={e => setTermino(e.target.value)}
          placeholder="EUR/USD, Bund, Apple, Bitcoin…"
          aria-label="Buscar un mercado en IG"
        />
        <button className="dibujo-btn" type="submit" disabled={cargando || !termino.trim()}>Buscar</button>
        <button className="dibujo-btn" type="button" disabled={cargando} onClick={verListas}>Mis listas de IG</button>
        <button className="dibujo-btn" type="button" onClick={onCerrar} aria-label="Cerrar el buscador">✕</button>
        {cargando && <span className="grafico-ig-nota">Preguntando a IG…</span>}
        {error && <span className="grafico-pro-error">{error}</span>}
      </form>

      {guardados.length > 0 && (
        <div className="grafico-ig-guardados">
          <span className="grafico-ig-nota">Abiertos antes:</span>
          {guardados.map(m => (
            <span key={m.ticker} className="grafico-ig-chip">
              <button className="dibujo-btn" onClick={() => onElegir(m)}>{m.nombre}</button>
              <button className="grafico-ig-quitar" onClick={() => onOlvidar(m.ticker)} title={`Quitar ${m.nombre} de la lista`} aria-label={`Quitar ${m.nombre}`}>×</button>
            </span>
          ))}
        </div>
      )}

      {resultados && (
        <div className="grafico-ig-lista">
          {resultados.length === 0 && <span className="grafico-ig-nota">IG no da nada con «{termino.trim()}».</span>}
          {resultados.map(m => <Fila key={m.epic} m={m} onElegir={onElegir} />)}
        </div>
      )}

      {listas && (
        <div className="grafico-ig-lista">
          {listas.length === 0 && <span className="grafico-ig-nota">La cuenta no tiene listas de seguimiento.</span>}
          {listas.map(l => (
            <div key={l.nombre} className="grafico-ig-grupo">
              <strong>{l.nombre}</strong>
              {l.mercados.length === 0 && <span className="grafico-ig-nota">vacía</span>}
              {l.mercados.map(m => <Fila key={m.epic} m={m} onElegir={onElegir} />)}
            </div>
          ))}
        </div>
      )}

      <p className="grafico-ig-nota">
        Se abre en el gráfico marcado, con el histórico de IG (gasta su cupo semanal de puntos) y la última vela en directo si la cuenta tiene precio de ese mercado.
      </p>
    </div>
  )
}
