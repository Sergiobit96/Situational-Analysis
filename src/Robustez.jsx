// ── Robustez del backtest (pestaña Estrategias) ──────────────────────────────────────────
// Debajo de las dos mitades: las métricas en R, el Monte Carlo, el mapa de sensibilidad, el
// walk-forward y el resultado por volatilidad del día (las cuentas, en src/robustezCalculos.js). El
// mapa y el walk-forward rehacen el backtest con cada combinación, así que van con un botón.
import { useMemo, useState } from 'react'
import { metricas, histograma, monteCarlo, sensibilidad, walkForward, porTercios } from './robustezCalculos'

const nf = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d }))
const conSigno = unidad => (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${nf(v, d)}${unidad === '%' ? ' %' : ` ${unidad}`}`)
// un ancho de cubo redondo para unas 20 barras
function anchoCubo(xs) {
  const ops = xs.filter(x => x !== 0)
  if (!ops.length) return 1
  const bruto = (Math.max(...ops) - Math.min(...ops)) / 20 || 1
  const mag = 10 ** Math.floor(Math.log10(bruto))
  return [1, 2, 2.5, 5, 10].map(f => f * mag).find(x => x >= bruto)
}
const dia = f => (f ? f.split('-').reverse().join('/') : '—')

// `serie`: [{ fecha, r, medida }] de las sesiones válidas en orden (r = 0 si no operó; medida,
// la volatilidad del día). `combos`: [{ clave, fila, columna }] con las etiquetas de cada eje;
// `matrizDe()` da una fila por sesión con el resultado de cada combinación; `actual`, la clave
// de lo que está puesto. Sin `combos`, no hay mapa ni walk-forward; `unidad`, la de los resultados.
export default function Robustez({ serie, combos = [], filas = [], columnas = [], matrizDe, actual, nombreMedida, unidad = 'R', titulo = 'Robustez' }) {
  const r = conSigno(unidad)
  const resultados = useMemo(() => serie.map(s => s.r), [serie])
  const m = useMemo(() => metricas(resultados), [resultados])
  const mc = useMemo(() => monteCarlo(resultados, { veces: 2000 }), [resultados])
  const hist = useMemo(() => histograma(resultados, unidad === 'R' ? 0.5 : anchoCubo(resultados)), [resultados, unidad])
  const tercios = useMemo(() => porTercios(serie.map(s => ({ medida: s.medida, resultado: s.r }))), [serie])
  const [calculo, setCalculo] = useState(null)   // { clave de la serie, sens, wf }
  const claveSerie = `${serie.length}|${serie[0]?.fecha}|${serie.at(-1)?.fecha}|${actual}`

  if (m.n < 10) return null
  const calcular = () => {
    const matriz = matrizDe()
    const claves = combos.map(c => c.clave)
    setCalculo({ clave: claveSerie, sens: sensibilidad(matriz, claves), wf: walkForward(matriz, claves, { tramos: 5, fechaDe: f => f.fecha }) })
  }
  const vigente = calculo?.clave === claveSerie ? calculo : null
  const maxAbs = vigente ? Math.max(1, ...Object.values(vigente.sens).map(s => Math.abs(s.total))) : 1
  const maxHist = Math.max(1, ...hist.map(c => c.n))
  const etiqueta = clave => { const c = combos.find(x => x.clave === clave); return c ? `${c.fila} · ${c.columna}` : clave }

  return (
    <div className="estr-resumen estr-robustez">
      <h4 className="estr-robustez-titulo">{titulo}</h4>

      <table className="estr-mitades-tabla">
        <tbody>
          <tr><th>Expectativa por operación</th><td>{r(m.expectativa)}</td><th>SQN</th><td>{nf(m.sqn)}</td></tr>
          <tr><th>Sortino por operación</th><td>{nf(m.sortino)}</td><th>Factor de recuperación</th><td>{nf(m.recuperacion)}</td></tr>
          <tr><th>Máximo drawdown</th><td>{r(m.maxDD, 1)}</td><th>Tiempo bajo el máximo</th><td>{nf(m.pctEnDD, 0)}% de las sesiones</td></tr>
        </tbody>
      </table>

      <div className="estr-robustez-hist" role="img" aria-label={`Histograma de resultados en ${unidad}`}>
        {hist.map((c, i) => (
          <div key={c.desde} className="estr-robustez-barra" title={`${nf(c.desde, 1)} a ${nf(c.hasta, 1)} ${unidad}: ${c.n}`}>
            <span className={c.desde >= 0 ? 'pos' : 'neg'} style={{ height: `${100 * c.n / maxHist}%` }} />
            <small>{i % Math.max(1, Math.round(hist.length / 8)) === 0 ? nf(c.desde, Number.isInteger(c.desde) ? 0 : 1) : ''}</small>
          </div>
        ))}
      </div>

      {mc && (
        <table className="estr-mitades-tabla">
          <thead><tr><th>Monte Carlo ({mc.veces.toLocaleString('es-ES')} historias)</th><th>Lo normal</th><th>Malo (1 de 20)</th><th>Muy malo (1 de 100)</th><th>Lo que pasó</th></tr></thead>
          <tbody>
            <tr><th>Peor drawdown</th><td>{r(mc.dd.p50, 1)}</td><td>{r(mc.dd.p95, 1)}</td><td>{r(mc.dd.p99, 1)}</td><td>{r(m.maxDD, 1)}</td></tr>
            <tr><th>Peor racha perdedora</th><td>{mc.racha.p50}</td><td>{mc.racha.p95}</td><td>{mc.racha.p99}</td><td>{m.peorRacha}</td></tr>
            <tr><th>Total</th><td>{r(mc.total.p50, 1)}</td><td>{r(mc.total.p5, 1)}</td><td>—</td><td>{r(m.total, 1)}</td></tr>
          </tbody>
        </table>
      )}
      {mc && (
        <p className="estr-nota">
          Se rehace la historia {mc.veces.toLocaleString('es-ES')} veces sacando sesiones al azar de las que hubo. <strong>{nf(mc.pctPierde, 0)}%</strong> de las historias acaban perdiendo.
          Cuenta con ver el drawdown y la racha de la columna «Malo»: el que tocó en el histórico es solo uno de los posibles.{unidad === 'R' ? ' En R, para no depender del tamaño.' : ' Las operaciones se suman en % del capital, sin componer.'}
        </p>
      )}

      {tercios && (
        <table className="estr-mitades-tabla">
          <thead><tr><th>Por volatilidad ({nombreMedida})</th><th>Sesiones</th><th>Operaciones</th><th>Ganadoras</th><th>Expectativa</th><th>Total</th></tr></thead>
          <tbody>
            {tercios.map((t, i) => (
              <tr key={i}>
                <th>{['Baja', 'Media', 'Alta'][i]} ({nf(t.desde, 2)} – {nf(t.hasta, 2)})</th>
                <td>{t.sesiones}</td><td>{t.n}</td><td>{t.pctGanadas == null ? '—' : `${nf(t.pctGanadas, 0)}%`}</td><td>{r(t.expectativa)}</td><td>{r(t.total, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!combos.length ? null : !vigente ? (
        <div>
          <button className="pag-btn" onClick={calcular}>Calcular sensibilidad y walk-forward</button>
          <p className="estr-nota">Rehace el backtest con las {combos.length} combinaciones de stop y pirámide, en las mismas sesiones (puede tardar unos segundos).</p>
        </div>
      ) : (
        <>
          <table className="estr-mitades-tabla estr-sensibilidad">
            <thead><tr><th>Sensibilidad: total en R</th>{columnas.map(c => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {filas.map(f => (
                <tr key={f}>
                  <th>{f}</th>
                  {columnas.map(col => {
                    const c = combos.find(x => x.fila === f && x.columna === col)
                    const s = c && vigente.sens[c.clave]
                    if (!s) return <td key={col}>—</td>
                    const alfa = 0.12 + 0.5 * Math.abs(s.total) / maxAbs
                    return (
                      <td key={col} className={c.clave === actual ? 'actual' : ''} title={`${s.n} operaciones · expectativa ${r(s.expectativa)} · drawdown ${r(s.maxDD, 1)}`}
                        style={{ background: s.total >= 0 ? `rgba(34,197,94,${alfa})` : `rgba(239,68,68,${alfa})` }}>
                        {r(s.total, 1)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="estr-nota">
            El recuadro es lo que tienes puesto. Si las casillas de alrededor también ganan, es una zona robusta; si solo gana la tuya, lo más probable es que sea casualidad.
          </p>
          {vigente.wf ? (
            <>
              <table className="estr-mitades-tabla">
                <thead><tr><th>Walk-forward</th><th>Elige con lo anterior</th><th>Por sesión, dentro</th><th>Por sesión, fuera</th><th>Total del tramo</th></tr></thead>
                <tbody>
                  {vigente.wf.partes.map(p => (
                    <tr key={p.desde}>
                      <th>{dia(p.desde)} → {dia(p.hasta)}</th>
                      <td>{etiqueta(p.elegida)}</td><td>{r(p.dentro, 3)}</td><td>{r(p.fuera, 3)}</td><td>{r(p.totalFuera, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="estr-nota">
                <strong>{vigente.wf.eficiencia == null ? 'Dentro de muestra no gana: no hay nada que validar.'
                  : vigente.wf.eficiencia >= 0.5 ? `Eficiencia ${nf(vigente.wf.eficiencia)}: lo optimizado aguanta fuera de muestra.`
                  : vigente.wf.eficiencia > 0 ? `Eficiencia ${nf(vigente.wf.eficiencia)}: fuera de muestra gana bastante menos; parte de lo bueno es sobreajuste.`
                  : `Eficiencia ${nf(vigente.wf.eficiencia)}: fuera de muestra pierde; lo optimizado no sirve.`}</strong>{' '}
                Las sesiones se parten en 5 tramos seguidos. En cada uno, desde el segundo, se elige la combinación que más ganó en todo lo anterior y se mide en ese tramo, que no ha visto.
                Fuera de muestra se habrían hecho {r(vigente.wf.totalFuera, 1)}. La eficiencia es lo que gana por sesión fuera entre lo que ganaba dentro.
              </p>
            </>
          ) : <p className="estr-nota">Para el walk-forward hacen falta al menos 50 sesiones.</p>}
        </>
      )}
    </div>
  )
}
