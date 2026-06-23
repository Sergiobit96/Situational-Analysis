import { useState, useRef, useCallback } from 'react'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'
const CUR_MONTH = new Date().getMonth() + 1
const CUR_YEAR  = new Date().getFullYear()

const MONTHS = [
  { v: 0, l: 'Todo el año' },
  { v: 1, l: 'Enero' }, { v: 2, l: 'Febrero' }, { v: 3, l: 'Marzo' },
  { v: 4, l: 'Abril' }, { v: 5, l: 'Mayo' },    { v: 6, l: 'Junio' },
  { v: 7, l: 'Julio' }, { v: 8, l: 'Agosto' },  { v: 9, l: 'Septiembre' },
  { v: 10, l: 'Octubre' }, { v: 11, l: 'Noviembre' }, { v: 12, l: 'Diciembre' },
]

const SCRIPTS = [
  { id: 'sync',      label: 'TradeNation Sync' },
  { id: 'historial', label: 'Historial Total' },
  { id: 'charts',    label: 'Chart Capture' },
  { id: 'collage',   label: 'Collage' },
]

export default function Pipeline() {
  const [lines, setLines]     = useState([])
  const [running, setRunning] = useState(false)
  const [status, setStatus]   = useState('Listo')
  const [month, setMonth]     = useState(CUR_MONTH)
  const [year,  setYear]      = useState(CUR_YEAR)
  const [autoYes, setAutoYes] = useState(true)
  const esRef     = useRef(null)
  const bottomRef = useRef(null)

  const addLine = useCallback((text, type = 'line') => {
    setLines(prev => [...prev, { text, type, id: Date.now() + Math.random() }])
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 0)
  }, [])

  function buildUrl(scriptId) {
    const p = new URLSearchParams({ script: scriptId })
    p.set('month', month)
    p.set('year',  year)
    if (autoYes) p.set('yes', '1')
    return `${API}/api/pipeline/run?${p}`
  }

  function stop() {
    esRef.current?.close()
    addLine('\n⏹ Proceso detenido por el usuario\n', 'err')
    setStatus('Detenido')
    setRunning(false)
  }

  function run(scriptId) {
    if (running) return
    esRef.current?.close()
    setLines([])
    setRunning(true)
    setStatus(scriptId === 'all' ? 'Iniciando pipeline…' : 'Iniciando…')

    const es = new EventSource(buildUrl(scriptId))
    esRef.current = es

    es.addEventListener('start', e => {
      const { label } = JSON.parse(e.data)
      setStatus(`Ejecutando ${label}…`)
      addLine(`── ${label} ──────────────────────\n`, 'header')
    })
    es.addEventListener('line', e => addLine(JSON.parse(e.data).text))
    es.addEventListener('end',  e => {
      const { label, code } = JSON.parse(e.data)
      addLine(code === 0 ? `✓ ${label} completado\n` : `✗ ${label} falló (${code})\n`, code === 0 ? 'ok' : 'err')
    })
    es.addEventListener('done', () => {
      addLine('\n✓ Pipeline completo\n', 'ok')
      setStatus('Listo')
      setRunning(false)
      es.close()
    })
    es.addEventListener('error', e => {
      if (e instanceof MessageEvent) {
        try { addLine(`✗ ${JSON.parse(e.data).msg}\n`, 'err') } catch {}
      } else {
        addLine('✗ No se pudo conectar con el servidor\n', 'err')
      }
      setStatus('Error')
      setRunning(false)
      es.close()
    })
  }

  return (
    <div className="pipeline-page">

      {/* Parámetros */}
      <div className="pipeline-params">
        <div className="param-group">
          <label className="param-label">Mes (Collage)</label>
          <select
            className="param-select"
            value={month}
            onChange={e => setMonth(Number(e.target.value))}
            disabled={running}
          >
            {MONTHS.map(m => (
              <option key={m.v} value={m.v}>{m.l}</option>
            ))}
          </select>
        </div>

        <div className="param-group">
          <label className="param-label">Año (Charts)</label>
          <input
            className="param-input"
            type="number"
            value={year}
            min={2020} max={2099}
            onChange={e => setYear(Number(e.target.value))}
            disabled={running}
          />
        </div>

        <label className="param-check">
          <input
            type="checkbox"
            checked={autoYes}
            onChange={e => setAutoYes(e.target.checked)}
            disabled={running}
          />
          Auto-confirmar (Charts)
        </label>
      </div>

      {/* Botones */}
      <div className="pipeline-toolbar">
        {!running
          ? <button className="btn-run-all" onClick={() => run('all')}>▶ Ejecutar Todo</button>
          : <button className="btn-stop" onClick={stop}>⏹ Detener</button>
        }
        <div className="pipeline-divider" />
        {SCRIPTS.map(s => (
          <button key={s.id} className="btn-script" onClick={() => run(s.id)} disabled={running}>
            {s.label}
          </button>
        ))}
        <button className="btn-clear-log" onClick={() => setLines([])} disabled={running}>
          Limpiar
        </button>
      </div>

      {/* Terminal */}
      <div className="pipeline-terminal">
        {lines.length === 0
          ? <span className="pipeline-placeholder">Pulsa un botón para ejecutar el pipeline…</span>
          : lines.map(l => <span key={l.id} className={`pl-${l.type}`}>{l.text}</span>)
        }
        <div ref={bottomRef} />
      </div>

      <div className="pipeline-statusbar">
        <span className={`pipeline-dot ${running ? 'running' : 'idle'}`} />
        {status}
      </div>
    </div>
  )
}
