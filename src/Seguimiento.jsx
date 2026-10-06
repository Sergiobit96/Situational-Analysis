import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTrades } from './useTrades'
import { fmtFechaTS, PRODUCTO_A_INSTRUMENTO, pnlDeTrade } from './parseTrades'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

const FILTROS = [
  { id: 'todos',    label: 'Todos' },
  { id: 'pendiente', label: 'Sin revisar' },
  { id: 'revisado',  label: 'Revisados' },
]

// La misma identidad que usan los comentarios y las etiquetas ('2026-09-11_DAX'), para que
// el tick de revisado sea exactamente el de Trades comentados.
const claveDeGrupo = g => `${g.fecha}_${PRODUCTO_A_INSTRUMENTO[g.producto] ?? ''}`

const fmtDia = fecha => {
  const [anio, mes, dia] = fecha.split('-')
  return `${dia}/${mes}/${anio}`
}

// Una fila por día e instrumento tradeado, que es la unidad con la que se revisa
export default function Seguimiento({ onIrATrade }) {
  const [trades] = useTrades()
  const [anotaciones, setAnotaciones] = useState({})
  const [error,  setError]  = useState(null)
  const [anioElegido, setAnioElegido] = useState(null)
  const [mesElegido,  setMesElegido]  = useState(null)
  const [filtro, setFiltro] = useState('todos')

  const hayServidor = import.meta.env.DEV

  const cargar = useCallback(() => {
    if (!hayServidor) return
    fetch(`${API}/api/trades-comentados/etiquetas`)
      .then(r => r.json())
      .then(d => { if (d.anotaciones) setAnotaciones(d.anotaciones) })
      .catch(() => setError('No se pudo leer lo revisado (¿servidor local apagado?)'))
  }, [hayServidor])

  useEffect(() => { cargar() }, [cargar])

  // Agrupa las operaciones por día + instrumento
  const grupos = useMemo(() => {
    const mapa = new Map()
    for (const t of trades) {
      const fecha = fmtFechaTS(t.openTime)
      const clave = `${fecha}|${t.producto}`
      if (!mapa.has(clave)) {
        mapa.set(clave, {
          fecha, producto: t.producto, ticker: t.ticker,
          operaciones: 0, puntos: 0, pnl: 0, conPnl: 0, openTime: t.openTime,
        })
      }
      const g = mapa.get(clave)
      g.operaciones += 1
      g.puntos += t.puntos ?? 0
      // las operaciones sin importe (diario sin tamaño) no cuentan para el PNL del día
      const pnl = pnlDeTrade(t)
      if (Number.isFinite(pnl)) { g.pnl += pnl; g.conPnl += 1 }
      g.openTime = Math.min(g.openTime, t.openTime)
    }
    return [...mapa.values()].sort((a, b) => b.openTime - a.openTime)
  }, [trades])

  const porAnio = useMemo(() => {
    const mapa = new Map()
    for (const g of grupos) {
      const anio = g.fecha.slice(0, 4)
      const mes  = g.fecha.slice(5, 7)
      if (!mapa.has(anio)) mapa.set(anio, new Map())
      const meses = mapa.get(anio)
      if (!meses.has(mes)) meses.set(mes, [])
      meses.get(mes).push(g)
    }
    return mapa
  }, [grupos])

  const anios = useMemo(() => [...porAnio.keys()].sort((a, b) => b.localeCompare(a)), [porAnio])
  const anio  = anioElegido !== null && anios.includes(anioElegido) ? anioElegido : (anios[0] ?? null)

  const mesesDelAnio = useMemo(() => {
    const delAnio = porAnio.get(anio)
    return delAnio ? [...delAnio.entries()].sort((a, b) => b[0].localeCompare(a[0])) : []
  }, [porAnio, anio])

  const mes = mesesDelAnio.some(([m]) => m === mesElegido) ? mesElegido : (mesesDelAnio[0]?.[0] ?? null)
  const delMes = useMemo(
    () => mesesDelAnio.find(([m]) => m === mes)?.[1] ?? [],
    [mesesDelAnio, mes],
  )

  const revisado = g => anotaciones[claveDeGrupo(g)]?.revisado === true
  const comentario = g => anotaciones[claveDeGrupo(g)]?.texto ?? ''

  const visibles = useMemo(() => {
    if (filtro === 'revisado')  return delMes.filter(g => revisado(g))
    if (filtro === 'pendiente') return delMes.filter(g => !revisado(g))
    return delMes
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `revisado` sale de anotaciones
  }, [delMes, filtro, anotaciones])

  const pnlTotal = useMemo(() => grupos.reduce((n, g) => n + g.pnl, 0), [grupos])

  const totalRevisados = useMemo(
    () => grupos.filter(g => anotaciones[claveDeGrupo(g)]?.revisado).length,
    [grupos, anotaciones],
  )

  const alternarRevisado = useCallback(async g => {
    const clave = claveDeGrupo(g)
    const nuevo = !(anotaciones[clave]?.revisado === true)
    setError(null)
    try {
      const res = await fetch(`${API}/api/trades-comentados/etiquetas?clave=${encodeURIComponent(clave)}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ revisado: nuevo }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setAnotaciones(prev => ({
        ...prev,
        [clave]: { cats: data.cats, texto: data.texto, revisado: data.revisado },
      }))
    } catch (err) {
      setError(`No se pudo marcar como revisado: ${err.message}`)
    }
  }, [anotaciones])

  return (
    <div className="seg-page">
      <div className="ts-intro">
        <h2>Seguimiento</h2>
        <p>
          Un renglón por día e instrumento tradeado. Clic en la fila para abrir ese trade en
          Operaciones con su gráfico, y el tick de revisado es el mismo que el de
          <strong> Diario → Trades comentados</strong>: se guarda en la anotación del trade,
          así que lo que marques aquí sale allí y al revés.
        </p>
      </div>

      {error && <div className="fotos-error">{error}</div>}

      <div className="ts-toolbar">
        <span className="diario-total">
          {grupos.length === 0
            ? 'Sin operaciones cargadas todavía (ve a Operaciones y sincroniza)'
            : `${grupos.length} día(s) de trading · PNL ${pnlTotal > 0 ? '+' : ''}${pnlTotal.toFixed(2)} · ${totalRevisados} revisado(s) · ${grupos.length - totalRevisados} pendiente(s)`}
        </span>
        {hayServidor && (
          <button className="diario-boton" onClick={cargar}>↻ releer revisados</button>
        )}
      </div>

      {anios.length > 0 && (
        <div className="ts-menu">
          <div className="ts-menu-fila">
            <span className="ts-menu-tit">año</span>
            <div className="estrategias-nav">
              {anios.map(a => (
                <button
                  key={a}
                  className={`estrategia-chip ${anio === a ? 'activo' : ''}`}
                  onClick={() => setAnioElegido(a)}
                >{a}</button>
              ))}
            </div>
          </div>
          <div className="ts-menu-fila">
            <span className="ts-menu-tit">mes</span>
            <div className="estrategias-nav">
              {mesesDelAnio.map(([m, lista]) => (
                <button
                  key={m}
                  className={`estrategia-chip ${mes === m ? 'activo' : ''}`}
                  onClick={() => setMesElegido(m)}
                >{MESES[Number(m) - 1] ?? m} <span className="ts-chip-num">{lista.length}</span></button>
              ))}
            </div>
          </div>
          <div className="ts-menu-fila">
            <span className="ts-menu-tit">ver</span>
            <div className="estrategias-nav">
              {FILTROS.map(f => (
                <button
                  key={f.id}
                  className={`estrategia-chip ${filtro === f.id ? 'activo' : ''}`}
                  onClick={() => setFiltro(f.id)}
                >{f.label}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="velas-tabla-wrap">
        <table className="velas-tabla trades-tabla">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Instrumento</th>
              <th>Ops</th>
              <th>Puntos</th>
              <th title="Importe del día: del bróker en los años del historial, y puntos × tamaño en los que vienen del diario">PNL</th>
              <th>Comentario</th>
              {hayServidor && <th>Revisado</th>}
            </tr>
          </thead>
          <tbody>
            {visibles.map(g => (
              <tr
                key={`${g.fecha}|${g.producto}`}
                className={`clickable-row ${g.puntos >= 0 ? 'fila-up' : 'fila-down'} ${revisado(g) ? 'seg-revisada' : ''}`}
                onClick={() => onIrATrade?.({ fecha: g.fecha, producto: g.producto })}
                title="Abrir este trade en Operaciones"
              >
                <td>{fmtDia(g.fecha)}</td>
                <td>{g.producto}</td>
                <td>{g.operaciones}</td>
                <td>{g.puntos > 0 ? '+' : ''}{g.puntos.toFixed(2)}</td>
                <td className={`seg-pnl ${g.conPnl === 0 ? '' : (g.pnl >= 0 ? 'positivo' : 'negativo')}`}>
                  {g.conPnl === 0 ? '—' : `${g.pnl > 0 ? '+' : ''}${g.pnl.toFixed(2)}`}
                </td>
                <td className="seg-comentario" title={comentario(g)}>
                  {comentario(g) ? `💬 ${comentario(g)}` : ''}
                </td>
                {hayServidor && (
                  <td className="seg-tick-cell">
                    <button
                      className={`seg-tick ${revisado(g) ? 'activo' : ''}`}
                      onClick={e => { e.stopPropagation(); alternarRevisado(g) }}
                      title={revisado(g) ? 'Revisado · clic para desmarcar' : 'Marcar como revisado'}
                    >{revisado(g) ? '✓' : ''}</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {visibles.length === 0 && grupos.length > 0 && (
        <div className="fotos-placeholder">
          {filtro === 'pendiente' ? 'Todo este mes está revisado' : 'Nada que mostrar con este filtro'}
        </div>
      )}
    </div>
  )
}
