import { useEffect, useState, useRef, useCallback } from 'react'

// Vite proxy bufferiza SSE — conectar directo al backend en dev
const BACKEND = import.meta.env.VITE_API_URL || 'http://localhost:3001'
const STREAM_URL = import.meta.env.DEV
  ? `${BACKEND}/api/scanner/stream`
  : '/api/scanner/stream'

const fmt = {
  usd:  n => n != null ? '$' + n.toFixed(2) : '—',
  hora: ts => new Date(ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Madrid' }),
}

function useContdown(proximoScan) {
  const [segs, setSegs] = useState(null)
  useEffect(() => {
    if (!proximoScan) { setSegs(null); return }
    const tick = () => setSegs(Math.max(0, Math.round((proximoScan - Date.now()) / 1000)))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [proximoScan])
  return segs
}

export default function Scanner({ onVerDetalle }) {
  const [estado, setEstado]       = useState(null)
  const [conectado, setConectado] = useState(false)
  const [notifPerm, setNotifPerm] = useState(Notification.permission)
  const esRef = useRef(null)

  const pedirNotificaciones = async () => {
    const perm = await Notification.requestPermission()
    setNotifPerm(perm)
  }

  const notificar = useCallback((alerta) => {
    if (Notification.permission !== 'granted') return
    new Notification(`ABCD ${alerta.tipo === 'bullish' ? '▲ LONG' : '▼ SHORT'} — ${alerta.ticker}`, {
      body: `${alerta.nombre}\nEntrada: ${fmt.usd(alerta.entrada)}  Stop: ${fmt.usd(alerta.stop)}`,
      tag:  alerta.id,
    })
  }, [])

  useEffect(() => {
    const es = new EventSource(STREAM_URL)
    esRef.current = es

    es.onopen = () => setConectado(true)
    es.onerror = () => setConectado(false)

    es.addEventListener('estado', e => {
      setEstado(JSON.parse(e.data))
    })
    es.addEventListener('scan_inicio', () => {
      setEstado(prev => prev ? { ...prev, escaneando: true } : prev)
    })
    es.addEventListener('scan_fin', e => {
      const { ts, indices } = JSON.parse(e.data)
      setEstado(prev => prev
        ? { ...prev, escaneando: false, ultimoScan: ts, proximoScan: ts + 5 * 60_000, indices }
        : prev)
    })
    es.addEventListener('alerta', e => {
      const alerta = JSON.parse(e.data)
      notificar(alerta)
      setEstado(prev => {
        if (!prev) return prev
        const alertas = [alerta, ...prev.alertas].slice(0, 100)
        return { ...prev, alertas }
      })
    })

    return () => { es.close(); esRef.current = null }
  }, [notificar])

  const countdown = useContdown(estado?.proximoScan)

  if (!estado) {
    return (
      <div className="scanner-cargando">
        <span className="spinner" /> Conectando al scanner...
      </div>
    )
  }

  const indicesUS = Object.values(estado.indices).filter(i => i.zona === 'US')
  const indicesEU = Object.values(estado.indices).filter(i => i.zona === 'EU')

  return (
    <div className="scanner-page">
      {/* ── Header ── */}
      <div className="scanner-header">
        <div className="scanner-status-row">
          <div className={`scanner-dot ${conectado ? 'vivo' : 'muerto'}`} />
          <span className="scanner-status-txt">
            {estado.escaneando
              ? 'Escaneando índices...'
              : estado.ultimoScan
                ? `Último scan: ${fmt.hora(estado.ultimoScan)}  ·  Próximo en ${countdown ?? '…'}s`
                : 'Esperando primer scan...'}
          </span>
          {estado.escaneando && <span className="spinner" />}
        </div>
        <button
          className={`btn-notif ${notifPerm === 'granted' ? 'activo' : ''}`}
          onClick={pedirNotificaciones}
          disabled={notifPerm === 'denied'}
          title={notifPerm === 'denied' ? 'Bloqueadas en el navegador' : ''}
        >
          {notifPerm === 'granted' ? '🔔 Alertas activas' : '🔕 Activar alertas'}
        </button>
      </div>

      <div className="scanner-main">
        {/* ── Índices ── */}
        <div className="scanner-indices">
          <SeccionIndices
            titulo="🇺🇸 EE.UU."
            indices={indicesUS}
            onVerDetalle={onVerDetalle}
          />
          <SeccionIndices
            titulo="🇪🇺 Europa"
            indices={indicesEU}
            onVerDetalle={onVerDetalle}
          />
        </div>

        {/* ── Alertas ── */}
        <div className="scanner-alertas">
          <h3 className="alertas-titulo">
            Alertas
            {estado.alertas.length > 0 && (
              <span className="alertas-count">{estado.alertas.length}</span>
            )}
          </h3>
          {estado.alertas.length === 0 ? (
            <p className="alertas-vacias">Sin alertas aún — el scanner detectará patrones ABCD automáticamente.</p>
          ) : (
            <div className="alertas-lista">
              {estado.alertas.map(a => (
                <AlertaItem key={a.id} alerta={a} onVerDetalle={onVerDetalle} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SeccionIndices({ titulo, indices, onVerDetalle }) {
  return (
    <div className="seccion-indices">
      <h3 className="seccion-titulo">{titulo}</h3>
      <div className="indices-grid">
        {indices.length === 0
          ? <p className="indices-cargando">Escaneando...</p>
          : indices.map(ind => (
              <IndiceCard key={ind.ticker} indice={ind} onVerDetalle={onVerDetalle} />
            ))
        }
      </div>
    </div>
  )
}

function IndiceCard({ indice, onVerDetalle }) {
  const tienePatrones = indice.patrones?.length > 0
  const hayError      = !!indice.error

  return (
    <div
      className={`indice-card ${tienePatrones ? 'con-patron' : ''} ${hayError ? 'con-error' : ''}`}
      onClick={() => tienePatrones && onVerDetalle(indice.ticker)}
      style={{ cursor: tienePatrones ? 'pointer' : 'default' }}
    >
      <div className="indice-top">
        <span className="indice-ticker">{indice.ticker}</span>
        <span className="indice-precio">{fmt.usd(indice.precio)}</span>
      </div>
      <div className="indice-nombre">{indice.nombre}</div>

      {hayError ? (
        <div className="indice-error">{indice.error}</div>
      ) : tienePatrones ? (
        <div className="indice-badges">
          {indice.patrones.map((p, i) => (
            <span key={i} className={`patron-pill ${p.tipo}`}>
              {p.tipo === 'bullish' ? '▲ LONG' : '▼ SHORT'}
            </span>
          ))}
        </div>
      ) : (
        <div className="indice-sin">Sin patrón</div>
      )}
    </div>
  )
}

function AlertaItem({ alerta, onVerDetalle }) {
  return (
    <div
      className={`alerta-item ${alerta.tipo}`}
      onClick={() => onVerDetalle(alerta.ticker)}
      style={{ cursor: 'pointer' }}
    >
      <div className="alerta-top">
        <span className={`alerta-badge ${alerta.tipo}`}>
          {alerta.tipo === 'bullish' ? '▲ LONG' : '▼ SHORT'}
        </span>
        <span className="alerta-ticker">{alerta.ticker}</span>
        <span className="alerta-hora">{fmt.hora(alerta.ts)}</span>
      </div>
      <div className="alerta-nombre">{alerta.nombre}</div>
      <div className="alerta-niveles">
        <span>Entrada <strong>{fmt.usd(alerta.entrada)}</strong></span>
        <span>Stop <strong className="rojo">{fmt.usd(alerta.stop)}</strong></span>
      </div>
    </div>
  )
}
