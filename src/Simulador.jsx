import { useState, useEffect, useMemo } from 'react'
import { simular, cifrasDe, porAnio, REGLAS_SIN, DIAS_SEMANA } from './estadisticas.js'

// Las reglas probadas se recuerdan en este navegador: es cómodo volver y seguir con ellas
const CLAVE_LOCAL = 'sa.simulador'

function reglasGuardadas() {
  try {
    const r = JSON.parse(localStorage.getItem(CLAVE_LOCAL) ?? 'null')
    return r && typeof r === 'object' ? { ...REGLAS_SIN, ...r } : REGLAS_SIN
  } catch {
    return REGLAS_SIN
  }
}

const fmtNum = (v, dec = 0) => (v == null || !Number.isFinite(v))
  ? '—'
  : v.toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec })
const fmtSigno = (v, dec = 0) => (v == null || !Number.isFinite(v))
  ? '—'
  : `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtNum(Math.abs(v), dec)}`
const fmtPF  = v => (v == null ? '—' : v === Infinity ? '∞' : fmtNum(v, 2))
const tono   = v => (v > 0 ? 'stats-pos' : v < 0 ? 'stats-neg' : '')

const hayReglas = r => r.stopDiario > 0 || r.objetivoDiario > 0 || r.maxOperaciones > 0 ||
  r.stopFijo > 0 || r.diasFuera.length > 0 || Boolean(r.desde) || Boolean(r.hasta)

// Cuánto de la mejora (o del empeoramiento) sale de un solo año: si casi todo viene de uno,
// la regla no ha demostrado nada, solo ha esquivado unos días concretos. Se mide contra lo
// que suman los años que van en ese sentido, no contra el total neto, que con años a favor y
// en contra daba porcentajes de más del 100%.
function veredicto(anios) {
  const difs = anios.map(a => ({ anio: a.anio, d: a.simulado - a.real }))
  const mejora  = difs.filter(x => x.d > 0.5).length
  const empeora = difs.filter(x => x.d < -0.5).length
  const igual   = difs.length - mejora - empeora
  const total   = difs.reduce((s, x) => s + x.d, 0)
  const partes = [`Mejora ${mejora} de ${difs.length} años`]
  if (empeora) partes.push(`empeora ${empeora}`)
  if (igual) partes.push(`deja igual ${igual}`)
  let frase = partes.join(', ') + '.'

  const enSentido = difs.filter(x => Math.abs(x.d) > 0.5 && Math.sign(x.d) === Math.sign(total))
  const suma  = enSentido.reduce((s, x) => s + x.d, 0)
  const mayor = enSentido.reduce((a, b) => (Math.abs(b.d) > Math.abs(a?.d ?? 0) ? b : a), null)
  if (difs.length > 1 && mayor && mayor.d / suma > 0.6) {
    frase += ` El ${fmtNum(mayor.d / suma * 100)}% de lo que ${total > 0 ? 'mejora' : 'empeora'} sale de ${mayor.anio}:` +
      ' más que una regla que funcione, pueden ser unos días concretos de ese año.'
  }
  return frase
}

function Campo({ etiqueta, ayuda, children }) {
  return (
    <label className="sim-campo" title={ayuda}>
      <span className="sim-campo-tit">{etiqueta}</span>
      {children}
    </label>
  )
}

// ¿Qué habría pasado si…? sobre las operaciones filtradas de la pestaña Estadísticas
export default function Simulador({ trades, medida, unidad, dec, puntosPosibles, resultados }) {
  const [reglas, setReglas] = useState(reglasGuardadas)
  useEffect(() => {
    try { localStorage.setItem(CLAVE_LOCAL, JSON.stringify(reglas)) } catch { /* sin almacenamiento */ }
  }, [reglas])

  const cambiar = (campo, valor) => setReglas(r => ({ ...r, [campo]: valor }))
  const numero = campo => e => cambiar(campo, Math.max(0, Number(e.target.value) || 0))
  const alternarDia = d => setReglas(r => ({
    ...r,
    diasFuera: r.diasFuera.includes(d) ? r.diasFuera.filter(x => x !== d) : [...r.diasFuera, d].sort(),
  }))

  // el stop fijo va en puntos del instrumento: sin uno elegido no hay puntos que valgan
  const efectivas = useMemo(() => ({ ...reglas, stopFijo: puntosPosibles ? reglas.stopFijo : 0 }), [reglas, puntosPosibles])
  const activas = hayReglas(efectivas)

  const sim = useMemo(
    () => (activas ? simular(trades, efectivas, { medida, resultados }) : null),
    [activas, trades, efectivas, medida, resultados],
  )
  const a = useMemo(() => (sim ? cifrasDe(sim.real) : null), [sim])
  const b = useMemo(() => (sim ? cifrasDe(sim.simulado) : null), [sim])
  const anios = useMemo(() => (sim ? porAnio(sim.real, sim.simulado) : []), [sim])

  const enUnidad = d => v => `${fmtSigno(v, d)} ${unidad}`
  const filas = a && b ? [
    { etiqueta: 'Resultado', real: a.total, sim: b.total, fmt: enUnidad(dec.total), conTono: true },
    { etiqueta: 'Operaciones', real: a.n, sim: b.n, fmt: v => fmtNum(v), fmtDif: v => fmtSigno(v) },
    { etiqueta: '% de acierto', real: a.acierto, sim: b.acierto,
      fmt: v => (v == null ? '—' : `${fmtNum(v, 1)}%`), fmtDif: v => `${fmtSigno(v, 1)} pp` },
    { etiqueta: 'Profit factor', real: a.profitFactor, sim: b.profitFactor, fmt: fmtPF, fmtDif: v => fmtSigno(v, 2) },
    { etiqueta: 'Esperanza', real: a.media, sim: b.media, fmt: enUnidad(dec.media), conTono: true },
    { etiqueta: 'Peor día', real: a.peorDia, sim: b.peorDia, fmt: enUnidad(dec.total), conTono: true },
    { etiqueta: 'Peor drawdown', real: a.maxDD, sim: b.maxDD, fmt: enUnidad(dec.total), conTono: true },
  ] : []

  const q = sim?.quitadas
  const fuera = q ? [
    q.stopDiario && `${fmtNum(q.stopDiario)} por el stop diario`,
    q.objetivo && `${fmtNum(q.objetivo)} por el objetivo diario`,
    q.maximo && `${fmtNum(q.maximo)} por el máximo de operaciones`,
    q.dia && `${fmtNum(q.dia)} por el día de la semana`,
    q.franja && `${fmtNum(q.franja)} por la hora`,
  ].filter(Boolean) : []

  return (
    <section className="stats-bloque">
      <div className="stats-bloque-cab">
        <h3>¿Qué habría pasado si…?</h3>
        {hayReglas(reglas) && (
          <button className="diario-boton" onClick={() => setReglas(REGLAS_SIN)}>Quitar reglas</button>
        )}
      </div>
      <p className="stats-nota">
        Vuelve a pasar tus operaciones reales con reglas que no seguiste. Solo quita operaciones o
        recorta su pérdida: no inventa ninguna. Va por operación, con el año y el instrumento de
        arriba, y en {medida === 'eur' ? 'euros' : 'puntos'}.
      </p>

      <div className="sim-reglas">
        <Campo etiqueta={`Stop diario (${unidad})`} ayuda="No abrir nada más ese día cuando lo ya cerrado pierde esto">
          <input type="number" min="0" step="50" className="sim-input" placeholder="sin límite"
            value={reglas.stopDiario || ''} onChange={numero('stopDiario')} />
        </Campo>
        <Campo etiqueta={`Objetivo diario (${unidad})`} ayuda="No abrir nada más ese día cuando lo ya cerrado gana esto">
          <input type="number" min="0" step="50" className="sim-input" placeholder="sin límite"
            value={reglas.objetivoDiario || ''} onChange={numero('objetivoDiario')} />
        </Campo>
        <Campo etiqueta="Máximo de operaciones al día" ayuda="Las que pasen de este número ese día no se abren">
          <input type="number" min="0" step="1" className="sim-input" placeholder="sin límite"
            value={reglas.maxOperaciones || ''} onChange={numero('maxOperaciones')} />
        </Campo>
        <Campo
          etiqueta="Stop fijo (puntos)"
          ayuda={puntosPosibles
            ? 'La operación que llegó a ir este número de puntos en contra (su MAE) habría salido ahí'
            : 'Elige un instrumento arriba: los puntos de instrumentos distintos no se pueden comparar'}
        >
          <input type="number" min="0" step="5" className="sim-input" placeholder={puntosPosibles ? 'sin stop' : 'elige instrumento'}
            disabled={!puntosPosibles} value={(puntosPosibles && reglas.stopFijo) || ''} onChange={numero('stopFijo')} />
        </Campo>
        <Campo etiqueta="No operar" ayuda="Días de la semana que se quitan">
          <span className="sim-dias">
            {DIAS_SEMANA.slice(0, 5).map((d, i) => (
              <button
                key={d}
                type="button"
                className={`estrategia-chip ${reglas.diasFuera.includes(i) ? 'activo' : ''}`}
                onClick={() => alternarDia(i)}
                title={d}
              >{d.slice(0, 2)}</button>
            ))}
          </span>
        </Campo>
        <Campo etiqueta="Entrar solo entre" ayuda="Hora de Madrid de la entrada; en blanco, sin límite">
          <span className="sim-horas">
            <input type="time" className="sim-input" value={reglas.desde} onChange={e => cambiar('desde', e.target.value)} />
            <span>y</span>
            <input type="time" className="sim-input" value={reglas.hasta} onChange={e => cambiar('hasta', e.target.value)} />
          </span>
        </Campo>
      </div>

      {!activas ? (
        <div className="fotos-placeholder">Pon alguna regla para compararla con lo que pasó de verdad</div>
      ) : (
        <>
          <div className="sim-resultados">
            <div className="velas-tabla-wrap stats-tabla-ancha">
              <table className="velas-tabla">
                <thead>
                  <tr><th></th><th>Real</th><th>Con las reglas</th><th>Diferencia</th></tr>
                </thead>
                <tbody>
                  {filas.map(f => {
                    const dif = Number.isFinite(f.real) && Number.isFinite(f.sim) ? f.sim - f.real : null
                    return (
                      <tr key={f.etiqueta}>
                        <td>{f.etiqueta}</td>
                        <td className={f.conTono ? tono(f.real) : ''}>{f.fmt(f.real)}</td>
                        <td className={f.conTono ? tono(f.sim) : ''}>{f.fmt(f.sim)}</td>
                        <td className={f.conTono ? tono(dif) : ''}>
                          {dif == null ? '—' : (f.fmtDif ?? f.fmt)(dif)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="velas-tabla-wrap stats-tabla-ancha">
              <table className="velas-tabla">
                <thead>
                  <tr><th>Año</th><th>Real</th><th>Con las reglas</th><th>Diferencia</th></tr>
                </thead>
                <tbody>
                  {anios.map(x => (
                    <tr key={x.anio}>
                      <td>{x.anio}</td>
                      <td className={tono(x.real)}>{fmtSigno(x.real, dec.total)}</td>
                      <td className={tono(x.simulado)}>{fmtSigno(x.simulado, dec.total)}</td>
                      <td className={tono(x.simulado - x.real)}>{fmtSigno(x.simulado - x.real, dec.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="stats-nota">
            <strong>{veredicto(anios)}</strong>{' '}
            {fuera.length > 0 && <>Se quedan fuera {fuera.join(', ')}{sim.diasCortados > 0 && <>, en {fmtNum(sim.diasCortados)} días</>}. </>}
            {efectivas.stopFijo > 0 && (
              <>El stop fijo recorta {fmtNum(sim.recortadas)} operaciones
                {sim.sinMae > 0 && <>; {fmtNum(sim.sinMae)} sin MAE se quedan como fueron</>}
                , con el margen de 1-3 puntos del MAE. </>
            )}
            Elegir una regla mirando el pasado sale bien casi siempre en el total: fíjate en si
            ayuda año a año.
          </p>
        </>
      )}
    </section>
  )
}
