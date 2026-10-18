import { useCallback, useMemo, useRef, useState } from 'react'
import { HERRAMIENTAS_DIBUJO } from './chartDrawingTools'
import { INSTRUMENTOS } from './intradayApi'
import PanelGrafico from './PanelGrafico'
import { TEMPORALIDADES, fuentesDe, configDe, claveDibujosDe, nombreDe } from './graficoConfig'

// Pestaña Gráfico: uno o varios gráficos a la vez, cada uno con su instrumento, temporalidad
// y fuente (PanelGrafico.jsx). La barra de arriba actúa sobre el panel activo, que es el
// último que se ha tocado y va marcado con el borde.

const DISPOSICIONES = [
  { id: '1',  n: 1, cols: 1, filas: 1, title: 'Un gráfico' },
  { id: '2c', n: 2, cols: 2, filas: 1, title: 'Dos, uno al lado del otro' },
  { id: '2f', n: 2, cols: 1, filas: 2, title: 'Dos, uno encima del otro' },
  { id: '3',  n: 3, cols: 3, filas: 1, title: 'Tres en fila' },
  { id: '4',  n: 4, cols: 2, filas: 2, title: 'Cuatro, en 2 × 2' },
  { id: '6',  n: 6, cols: 3, filas: 2, title: 'Seis, en 3 × 2' },
]
const MAX_PANELES = 6

// Lo que sale en los paneles nuevos: los índices que se operan, y el oro
const POR_DEFECTO = ['^GDAXI', '^NDX', '^DJI', '^FTSE', '^GSPC', 'XAUUSD']

const VISTA = 'sa.grafico.vista'
const PREFS_DE_UNO = 'sa.grafico'   // las de cuando la pestaña tenía un solo gráfico

// Se guardan los seis paneles aunque se vean menos: al volver a una rejilla más grande,
// cada uno sale como se dejó
function leerVista() {
  let guardada = null
  let primero  = { ticker: '^GDAXI', tf: 'm15', fuente: 'duka' }
  try { guardada = JSON.parse(localStorage.getItem(VISTA)) } catch { /* sin almacenamiento */ }
  try { primero = { ...primero, ...JSON.parse(localStorage.getItem(PREFS_DE_UNO)) } } catch { /* idem */ }

  const paneles = Array.isArray(guardada?.paneles) && guardada.paneles.length ? [...guardada.paneles] : [primero]
  // los que falten, con los instrumentos que aún no salen y la temporalidad y fuente del primero
  const { tf, fuente } = paneles[0]
  for (const ticker of POR_DEFECTO) {
    if (paneles.length >= MAX_PANELES) break
    if (!paneles.some(p => p.ticker === ticker)) paneles.push({ ticker, tf, fuente: fuente === 'csv' ? 'duka' : fuente })
  }
  return {
    disposicion: DISPOSICIONES.some(d => d.id === guardada?.disposicion) ? guardada.disposicion : '1',
    activo:      Number.isInteger(guardada?.activo) ? guardada.activo : 0,
    mismaTf:     guardada?.mismaTf === true,
    paneles:     paneles.slice(0, MAX_PANELES),
  }
}

// La rejilla de cada disposición, dibujada en pequeño para el botón
function IconoDisposicion({ d }) {
  const w = 18, h = 14, hueco = 1.5
  const ancho = (w - hueco * (d.cols - 1)) / d.cols
  const alto  = (h - hueco * (d.filas - 1)) / d.filas
  const celdas = []
  for (let f = 0; f < d.filas; f++) {
    for (let c = 0; c < d.cols; c++) {
      celdas.push(<rect key={`${f}-${c}`} x={c * (ancho + hueco)} y={f * (alto + hueco)} width={ancho} height={alto} rx="1" />)
    }
  }
  return <svg className="grafico-disp-icono" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">{celdas}</svg>
}

export default function Grafico() {
  const [vista, setVista] = useState(leerVista)
  const [modos, setModos] = useState([])   // modo de dibujo de cada panel
  const mandos = useRef([])                // lo que cada panel deja manejar a la barra

  const guardar = useCallback(cambio => setVista(v => {
    const nueva = typeof cambio === 'function' ? cambio(v) : { ...v, ...cambio }
    try { localStorage.setItem(VISTA, JSON.stringify(nueva)) } catch { /* sin almacenamiento */ }
    return nueva
  }), [])

  // Un aviso de modo y un registro de mandos fijos por panel: si cambiaran en cada render,
  // el panel rehará su gráfico entero
  const avisosModo = useMemo(() => Array.from({ length: MAX_PANELES }, (_, i) => modo =>
    setModos(ms => { const c = [...ms]; c[i] = modo; return c })), [])
  const registros = useMemo(() => Array.from({ length: MAX_PANELES }, (_, i) => m => { mandos.current[i] = m }), [])

  const disp   = DISPOSICIONES.find(d => d.id === vista.disposicion) ?? DISPOSICIONES[0]
  const activo = Math.min(vista.activo, disp.n - 1)
  const { ticker, tf, fuente } = configDe(vista.paneles[activo])
  const disponibles = fuentesDe(ticker)
  const varios = disp.n > 1

  const cambiarPanel = (i, cambio) =>
    guardar(v => ({ ...v, paneles: v.paneles.map((p, j) => (j === i ? { ...p, ...cambio } : p)) }))

  // Con "en todos" la temporalidad cambia en todos los paneles que se ven
  const cambiarTf = nueva => guardar(v => ({
    ...v,
    paneles: v.paneles.map((p, j) => (j === activo || (v.mismaTf && j < disp.n) ? { ...p, tf: nueva } : p)),
  }))

  // Ahora borrar es para siempre (los dibujos están guardados): se pide confirmación
  const borrarDibujos = () => {
    const m = mandos.current[activo]
    const n = m?.cuantos() ?? 0
    if (n === 0) return
    const clave = claveDibujosDe(ticker, fuente)
    const cual = clave.endsWith('@futuro') ? ' (futuro)' : clave.endsWith('@contado') ? ' (contado)' : ''
    if (window.confirm(`¿Borrar ${n === 1 ? 'el dibujo' : `los ${n} dibujos`} de ${nombreDe(ticker)}${cual}?`)) {
      m.clearAll()
    }
  }

  return (
    <div className={`grafico-pro ${varios ? 'grafico-varios' : ''}`}>
      <div className="grafico-pro-barra">
        <div className="grafico-pro-grupo" role="group" aria-label="Disposición">
          {DISPOSICIONES.map(d => (
            <button
              key={d.id}
              className={`dibujo-btn grafico-disp ${disp.id === d.id ? 'activo' : ''}`}
              title={d.title}
              aria-label={d.title}
              onClick={() => guardar({ disposicion: d.id })}
            ><IconoDisposicion d={d} /></button>
          ))}
        </div>

        <select
          className="grafico-pro-select"
          value={ticker}
          onChange={e => cambiarPanel(activo, { ticker: e.target.value })}
          aria-label="Instrumento"
        >
          {INSTRUMENTOS.map(i => <option key={i.value} value={i.value}>{i.label}</option>)}
        </select>

        <div className="grafico-pro-grupo" role="group" aria-label="Temporalidad">
          {TEMPORALIDADES.map(t => (
            <button
              key={t.id}
              className={`dibujo-btn ${tf === t.id ? 'activo' : ''}`}
              disabled={fuente === 'csv' && t.id === 'm1'}
              title={fuente === 'csv' && t.id === 'm1' ? 'El CSV del DAX va a 5 minutos' : undefined}
              onClick={() => cambiarTf(t.id)}
            >{t.label}</button>
          ))}
          {varios && (
            <button
              className={`dibujo-btn ${vista.mismaTf ? 'activo' : ''}`}
              title="Con esto marcado, la temporalidad cambia en todos los gráficos a la vez"
              onClick={() => guardar({ mismaTf: !vista.mismaTf })}
            >en todos</button>
          )}
        </div>

        <div className="grafico-pro-grupo" role="group" aria-label="Fuente de datos">
          {disponibles.map(f => (
            <button
              key={f.id}
              className={`dibujo-btn ${fuente === f.id ? 'activo' : ''}`}
              title={f.title}
              onClick={() => cambiarPanel(activo, { fuente: f.id })}
            >{f.label}</button>
          ))}
        </div>

        <div className="grafico-pro-grupo" role="group" aria-label="Dibujo">
          {HERRAMIENTAS_DIBUJO.map(h => (
            <button
              key={h.id}
              className={`dibujo-btn ${(modos[activo] ?? 'cursor') === h.id ? 'activo' : ''}`}
              title={h.title}
              onClick={() => mandos.current[activo]?.setMode(h.id)}
            >{h.icon}</button>
          ))}
          <button
            className="dibujo-btn"
            title="Borrar todos los dibujos de este instrumento"
            onClick={borrarDibujos}
          >🗑</button>
        </div>

        {varios && (
          <span className="grafico-pro-pista">
            La barra cambia el gráfico marcado ({nombreDe(ticker)}); haz clic en otro para elegirlo
          </span>
        )}
      </div>

      <div className="grafico-rejilla" style={{ '--cols': disp.cols, '--filas': disp.filas }}>
        {vista.paneles.slice(0, disp.n).map((p, i) => (
          <PanelGrafico
            key={i}
            config={p}
            activo={i === activo}
            conMarco={varios}
            onActivar={() => { if (i !== activo) guardar({ activo: i }) }}
            onCambiar={cambio => cambiarPanel(i, cambio)}
            onModo={avisosModo[i]}
            registrar={registros[i]}
          />
        ))}
      </div>
    </div>
  )
}
