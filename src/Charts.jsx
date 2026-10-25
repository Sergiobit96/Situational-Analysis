import { useState, useEffect, useMemo, useCallback } from 'react'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'

// Los charts de G:\Mi unidad\CHARTS y las capturas de Trading <año>\Trades, que
// scripts/subir-charts.mjs sube cada día a GitHub. Se navega por las mismas carpetas que en
// Drive (instrumento / año / mes, o Trading <año> / Trades / ...). Solo para mirar:
// desde aquí no se puede borrar ni cambiar ninguno.

const urlChart = ruta => `${API}/api/charts/archivo?ruta=${encodeURIComponent(ruta)}`
const comparar = (a, b) => a.localeCompare(b, 'es', { numeric: true })
// años y meses ("2026", "10-Octubre") del más reciente al más antiguo; lo demás por nombre
const ordenarCarpetas = nombres =>
  nombres.every(n => /^\d/.test(n)) ? [...nombres].sort((a, b) => comparar(b, a)) : [...nombres].sort(comparar)

const nombreChart = ruta => ruta.split('/').pop().replace(/\.[^.]+$/, '')

export default function Charts() {
  const [charts, setCharts]     = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError]       = useState(null)
  const [carpeta, setCarpeta]   = useState([])     // la ruta en la que se está, por trozos
  const [abierto, setAbierto]   = useState(null)   // índice en `imagenes` del chart ampliado

  useEffect(() => {
    fetch(`${API}/api/charts/lista`)
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setCharts(d.charts) })
      .catch(err => setError(err.message))
      .finally(() => setCargando(false))
  }, [])

  // subcarpetas (con cuántos charts tienen dentro) e imágenes sueltas de la carpeta actual
  const { subcarpetas, imagenes } = useMemo(() => {
    const prefijo = carpeta.length ? `${carpeta.join('/')}/` : ''
    const cuenta = new Map()
    const imagenes = []
    for (const { ruta } of charts) {
      if (!ruta.startsWith(prefijo)) continue
      const resto = ruta.slice(prefijo.length).split('/')
      if (resto.length === 1) imagenes.push(ruta)
      else cuenta.set(resto[0], (cuenta.get(resto[0]) ?? 0) + 1)
    }
    return {
      subcarpetas: ordenarCarpetas([...cuenta.keys()]).map(n => [n, cuenta.get(n)]),
      imagenes:    imagenes.sort(comparar),
    }
  }, [charts, carpeta])

  const mover = useCallback(paso => {
    setAbierto(i => (i === null ? null : (i + paso + imagenes.length) % imagenes.length))
  }, [imagenes.length])

  useEffect(() => {
    if (abierto === null) return
    const teclas = e => {
      if (e.key === 'Escape') setAbierto(null)
      else if (e.key === 'ArrowRight') mover(1)
      else if (e.key === 'ArrowLeft') mover(-1)
    }
    window.addEventListener('keydown', teclas)
    return () => window.removeEventListener('keydown', teclas)
  }, [abierto, mover])

  const entrar = trozos => { setCarpeta(trozos); setAbierto(null) }

  return (
    <div className="fotos-page">
      <div className="fotos-toolbar">
        <nav className="charts-migas">
          <button className="clear-eventos" onClick={() => entrar([])} disabled={!carpeta.length}>CHARTS</button>
          {carpeta.map((t, i) => (
            <span key={i}>
              /
              <button className="clear-eventos" onClick={() => entrar(carpeta.slice(0, i + 1))} disabled={i === carpeta.length - 1}>{t}</button>
            </span>
          ))}
        </nav>
        <span className="fotos-total">
          {cargando ? 'Cargando…' : `${charts.length} charts`}
        </span>
      </div>

      {error && <div className="fotos-error">{error}</div>}
      {!cargando && !error && charts.length === 0 && (
        <div className="fotos-placeholder">Todavía no hay charts subidos (node scripts/subir-charts.mjs)</div>
      )}

      {subcarpetas.length > 0 && (
        <div className="filtro-dias-esp">
          {subcarpetas.map(([n, total]) => (
            <button key={n} className="dia-esp-chip" onClick={() => entrar([...carpeta, n])}>
              📁 {n} <span className="charts-cuenta">{total}</span>
            </button>
          ))}
        </div>
      )}

      {imagenes.length > 0 && (
        <div className="charts-rejilla">
          {imagenes.map((ruta, i) => (
            <button key={ruta} className="charts-miniatura" onClick={() => setAbierto(i)} title="Clic para agrandar">
              <img src={urlChart(ruta)} alt={nombreChart(ruta)} loading="lazy" />
              <span>{nombreChart(ruta)}</span>
            </button>
          ))}
        </div>
      )}

      {abierto !== null && imagenes[abierto] && (
        <div className="fotos-lightbox" onClick={() => setAbierto(null)}>
          <button className="fotos-lightbox-cerrar" onClick={() => setAbierto(null)} title="Cerrar (Esc)">×</button>
          {imagenes.length > 1 && (
            <>
              <button className="charts-flecha izq" onClick={e => { e.stopPropagation(); mover(-1) }} title="Anterior (←)">‹</button>
              <button className="charts-flecha der" onClick={e => { e.stopPropagation(); mover(1) }} title="Siguiente (→)">›</button>
            </>
          )}
          <figure className="charts-ampliado" onClick={e => e.stopPropagation()}>
            <img className="fotos-lightbox-img" src={urlChart(imagenes[abierto])} alt={nombreChart(imagenes[abierto])} />
            <figcaption>{nombreChart(imagenes[abierto])} · {abierto + 1} de {imagenes.length}</figcaption>
          </figure>
        </div>
      )}
    </div>
  )
}
