import { useState, useEffect, useMemo } from 'react'
import CurvaEquity from './CurvaEquity.jsx'
import { useTrades } from './useTrades'
import { useExcursiones } from './useExcursiones'
import { PRODUCTO_A_TICKER } from './parseTrades'
import {
  unidadesDe, resumen, desglose, DESGLOSES, MIN_MUESTRA,
  excursionesPorInstrumento, eficienciaDeSalida,
} from './estadisticas.js'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'

// Lo que el historial de la cuenta trae aparte de índices y metales (divisas, acciones…)
// va junto en un solo filtro, como el desplegable de "otros" de Operaciones
const OTROS = '__otros'

const anioDe = t => String(new Date(t.openTime * 1000).getUTCFullYear())

const fmtNum = (v, dec = 0) => (v == null || !Number.isFinite(v))
  ? '—'
  : v.toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec })
const fmtSigno = (v, dec = 0) => (v == null || !Number.isFinite(v))
  ? '—'
  : `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtNum(Math.abs(v), dec)}`
const fmtPct = v => (v == null ? '—' : `${fmtNum(v, 1)}%`)
const fmtPF  = v => (v == null ? '—' : v === Infinity ? '∞' : fmtNum(v, 2))
const tono   = v => (v > 0 ? 'stats-pos' : v < 0 ? 'stats-neg' : '')

// Barra de fondo en la columna del total. Escala al percentil 90 de la tabla, como en
// Seguimiento: con el máximo, un grupo enorme dejaba los demás en una rayita.
function topeDe(filas) {
  const o = filas.map(f => Math.abs(f.total)).sort((a, b) => a - b)
  return Math.max(1e-9, o[Math.floor(0.9 * (o.length - 1))] ?? 1)
}
const ancho = (valor, tope) => `${Math.max(6, Math.min(100, Math.abs(valor) / tope * 100))}%`

function Chips({ titulo, opciones, valor, onCambio }) {
  return (
    <div className="ts-menu-fila">
      <span className="ts-menu-tit">{titulo}</span>
      <div className="estrategias-nav">
        {opciones.map(o => (
          <button
            key={o.id}
            className={`estrategia-chip ${valor === o.id ? 'activo' : ''}`}
            onClick={() => onCambio(o.id)}
            disabled={o.disabled}
            title={o.title}
          >{o.label}</button>
        ))}
      </div>
    </div>
  )
}

function TablaDesglose({ d, filas, cuenta, dec }) {
  const tope = topeDe(filas)
  return (
    <div className="stats-tabla">
      <h3>{d.titulo}</h3>
      {d.nota && <p className="stats-nota">{d.nota}</p>}
      <div className="velas-tabla-wrap">
        <table className="velas-tabla">
          <thead>
            <tr>
              <th>{d.columna}</th>
              <th>{cuenta}</th>
              <th>% acierto</th>
              <th>Total</th>
              <th>Media</th>
              <th title="Lo ganado entre lo perdido">PF</th>
            </tr>
          </thead>
          <tbody>
            {filas.map(f => (
              <tr
                key={f.clave}
                className={f.poca ? 'stats-poca' : ''}
                title={f.poca ? `Solo ${f.n}: muestra pequeña, no saques conclusiones` : undefined}
              >
                <td>{f.etiqueta}</td>
                <td>{f.n}</td>
                <td>{fmtPct(f.acierto)}</td>
                <td className={`stats-barra ${tono(f.total)}`} style={{ '--barra': ancho(f.total, tope) }}>
                  {fmtSigno(f.total, dec.total)}
                </td>
                <td className={tono(f.media)}>{fmtSigno(f.media, dec.media)}</td>
                <td>{fmtPF(f.profitFactor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function BloqueExcursiones({ exc, filtradas }) {
  const { disponible, resultados, estado, error, calcular } = exc
  const filas = useMemo(() => excursionesPorInstrumento(filtradas, resultados), [filtradas, resultados])

  const conVelas  = filtradas.filter(t => t.ticker).length
  const medidas   = filas.reduce((n, f) => n + f.n, 0)
  const sinVelas  = useMemo(
    () => Object.values(resultados).filter(r => r.sinDatos === 'sin velas en el tramo').length,
    [resultados],
  )
  const activo    = estado?.activo === true
  const pendientes = estado?.pendientes ?? 0

  if (!disponible) {
    return (
      <section className="stats-bloque">
        <h3>MFE y MAE</h3>
        <p className="stats-nota">Solo en local: se calculan con las velas de Dukascopy del servidor.</p>
      </section>
    )
  }

  return (
    <section className="stats-bloque">
      <div className="stats-bloque-cab">
        <h3>MFE y MAE</h3>
        <span className="stats-cobertura">
          {fmtNum(medidas)} de {fmtNum(conVelas)} operaciones medidas
        </span>
        {activo ? (
          <span className="stats-progreso">
            <span className="spinner" /> Calculando {fmtNum(estado.hechas)} de {fmtNum(estado.total)}…
            puedes seguir usando la app
          </span>
        ) : (
          <>
            {pendientes > 0 && (
              <button className="diario-boton" onClick={() => calcular()}>
                Calcular las {fmtNum(pendientes)} que faltan
              </button>
            )}
            {sinVelas > 0 && (
              <button
                className="diario-boton"
                onClick={() => calcular({ reintentar: true })}
                title="Operaciones para las que Dukascopy no devolvió velas. Casi todas caen en su pausa diaria de los índices americanos (20:15-22:00 UTC): ahí reintentar no cambia nada"
              >Reintentar {fmtNum(sinVelas)} sin velas</button>
            )}
          </>
        )}
      </div>

      {error && <div className="fotos-error">{error}</div>}
      {!activo && estado?.error && (
        <div className="fotos-error">
          El cálculo se paró: {estado.error}. Lo hecho hasta ahí está guardado; vuelve a pulsar en unos minutos.
        </div>
      )}

      <p className="stats-nota">
        <strong>MFE</strong>: lo más que llegó a ir ganando la operación mientras estuvo abierta.
        <strong> MAE</strong>: lo más que llegó a ir perdiendo. En puntos del instrumento, desde tu
        precio de entrada, con las velas de 1 min de Dukascopy (de 1 h si estuvo abierta más de
        2 días). Dukascopy no es la cotización de tu bróker: cuenta con 1-3 puntos de margen. Va
        siempre por operación, aunque arriba cuentes por sesión.
      </p>

      {filas.length > 0 ? (
        <div className="velas-tabla-wrap stats-tabla-ancha">
          <table className="velas-tabla">
            <thead>
              <tr>
                <th>Instrumento</th>
                <th>Medidas</th>
                <th title="La mitad de tus operaciones llegó a ir ganando al menos esto">MFE mediano</th>
                <th title="La mitad de tus operaciones llegó a ir perdiendo al menos esto">MAE mediano</th>
                <th title="En las ganadoras: qué parte del MFE te llevaste al cerrar">Eficiencia de salida</th>
                <th title="El 90% de tus ganadoras no fue más en contra que esto: una referencia para el stop">MAE del 90% de ganadoras</th>
                <th title="Perdedoras que llegaron a ir ganando al menos lo que acabaron perdiendo">Perdedoras que iban ganando</th>
              </tr>
            </thead>
            <tbody>
              {filas.map(f => (
                <tr
                  key={f.producto}
                  className={f.poca ? 'stats-poca' : ''}
                  title={f.poca ? `Solo ${f.n}: muestra pequeña` : undefined}
                >
                  <td>{f.producto}</td>
                  <td>{fmtNum(f.n)}</td>
                  <td className="stats-pos">{fmtSigno(f.mfeMediano, 1)}</td>
                  <td className="stats-neg">{fmtSigno(f.maeMediano, 1)}</td>
                  <td>{fmtPct(f.eficiencia)}</td>
                  <td className="stats-neg">{fmtSigno(f.maeGanadorasP90, 1)}</td>
                  <td>{fmtPct(f.perdedorasQueIbanGanando)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="fotos-placeholder">
          {activo ? 'Las primeras saldrán aquí en unos segundos' : 'Todavía no hay ninguna operación medida con este filtro'}
        </div>
      )}
    </section>
  )
}

export default function Estadisticas() {
  const [trades] = useTrades()
  const exc = useExcursiones()
  const [anotaciones, setAnotaciones] = useState({})
  const [anio,        setAnio]        = useState('todos')
  const [instrumento, setInstrumento] = useState('todos')
  const [modo,        setModo]        = useState('operacion')
  const [medidaElegida, setMedida]    = useState('eur')

  // Las etiquetas del Book of Horror puestas desde la app, para el desglose por error
  useEffect(() => {
    if (!import.meta.env.DEV) return
    let vivo = true
    fetch(`${API}/api/trades-comentados/etiquetas`)
      .then(r => r.json())
      .then(d => { if (vivo && d.anotaciones) setAnotaciones(d.anotaciones) })
      .catch(() => { /* sin servidor local solo cuentan las de la hoja Scenarios */ })
    return () => { vivo = false }
  }, [])

  const anios = useMemo(() => [...new Set(trades.map(anioDe))].sort().reverse(), [trades])
  const principales = useMemo(
    () => [...new Set(trades.map(t => t.producto))].filter(p => PRODUCTO_A_TICKER[p]).sort(),
    [trades],
  )
  const hayOtros = useMemo(() => trades.some(t => !PRODUCTO_A_TICKER[t.producto]), [trades])

  // Los puntos solo se suman dentro de un mismo instrumento: 20 del DAX no son 20 del Dow
  const puntosPosibles = instrumento !== 'todos' && instrumento !== OTROS
  const medida = puntosPosibles ? medidaElegida : 'eur'
  const dec    = medida === 'eur' ? { total: 0, media: 2 } : { total: 1, media: 1 }
  const unidad = medida === 'eur' ? '€' : 'pts'
  const cuenta = modo === 'sesion' ? 'Sesiones' : 'Ops'

  const filtradas = useMemo(() => trades.filter(t => {
    if (anio !== 'todos' && anioDe(t) !== anio) return false
    if (instrumento === OTROS) return !PRODUCTO_A_TICKER[t.producto]
    return instrumento === 'todos' || t.producto === instrumento
  }), [trades, anio, instrumento])

  const unidades = useMemo(
    () => unidadesDe(filtradas, { modo, medida, anotaciones }),
    [filtradas, modo, medida, anotaciones],
  )
  const r = useMemo(() => resumen(unidades), [unidades])
  const eficiencia = useMemo(() => eficienciaDeSalida(filtradas, exc.resultados), [filtradas, exc.resultados])

  // Un punto por día con lo de ese día, para la curva del conjunto filtrado
  const curva = useMemo(() => {
    const porDia = new Map()
    for (const u of unidades) porDia.set(u.fecha, (porDia.get(u.fecha) ?? 0) + u.valor)
    return [...porDia.entries()].map(([date, pts]) => ({ date, pts }))
  }, [unidades])

  const tablas = useMemo(() => DESGLOSES
    .filter(d => !(d.soloSin === 'anio' && anio !== 'todos') && !(d.soloSin === 'instrumento' && instrumento !== 'todos'))
    .map(d => ({ d, filas: desglose(unidades, d.clave, d) }))
    // la de categorías no dice nada si nada está etiquetado: sale una sola fila, "sin etiqueta"
    .filter(({ d, filas }) => !(d.id === 'categoria' && filas.every(f => f.clave === 0))),
  [unidades, anio, instrumento])

  const porCada = modo === 'sesion' ? 'por sesión' : 'por operación'
  const tiles = [
    { label: 'Resultado', valor: `${fmtSigno(r.total, dec.total)} ${unidad}`, tono: tono(r.total),
      sub: `${fmtNum(r.n)} ${modo === 'sesion' ? 'sesiones' : 'operaciones'}` },
    { label: '% de acierto', valor: fmtPct(r.acierto),
      sub: `${fmtNum(r.ganadoras)} ganadas · ${fmtNum(r.perdedoras)} perdidas · ${fmtNum(r.empates)} a cero` },
    { label: 'Profit factor', valor: fmtPF(r.profitFactor),
      tono: r.profitFactor == null ? '' : r.profitFactor >= 1 ? 'stats-pos' : 'stats-neg',
      sub: 'lo ganado entre lo perdido' },
    { label: 'Esperanza', valor: `${fmtSigno(r.media, dec.media)} ${unidad}`, tono: tono(r.media),
      sub: `media ${porCada} · mediana ${fmtSigno(r.mediana, dec.media)}` },
    { label: 'Ganancia / pérdida media', valor: `${fmtSigno(r.gananciaMedia, dec.media)} / ${fmtSigno(r.perdidaMedia, dec.media)}`,
      sub: `cada ganancia vale ${fmtNum(r.ratio, 2)} pérdidas` },
    // el drawdown y las rachas los pone la curva de debajo, día a día
    ...(eficiencia.medidas > 0 ? [{
      label: 'Eficiencia de salida', valor: fmtPct(eficiencia.eficiencia),
      sub: `del MFE que te llevaste en las ganadoras (${fmtNum(eficiencia.medidas)} medidas)`,
    }] : []),
  ]

  const opcionesInstrumento = [
    { id: 'todos', label: 'Todos' },
    ...principales.map(p => ({ id: p, label: p })),
    ...(hayOtros ? [{ id: OTROS, label: 'Otros', title: 'Divisas, acciones y demás del historial de la cuenta' }] : []),
  ]

  return (
    <div className="stats-page">
      <div className="ts-intro">
        <h2>Estadísticas</h2>
        <p>
          Lo que dicen tus operaciones reales: cuánto aciertas, cuánto ganas cuando aciertas frente a
          lo que pierdes cuando no, y en qué franjas, días e instrumentos se va el dinero. Los grupos
          con menos de {MIN_MUESTRA} salen en gris: con tan poco, un 100% de acierto no significa nada.
        </p>
      </div>

      {trades.length === 0 ? (
        <div className="fotos-placeholder">Sin operaciones cargadas todavía (ve a Operaciones y sincroniza)</div>
      ) : (
        <>
          <div className="ts-menu">
            <Chips
              titulo="año"
              valor={anio}
              onCambio={setAnio}
              opciones={[{ id: 'todos', label: 'Todos' }, ...anios.map(a => ({ id: a, label: a }))]}
            />
            <Chips titulo="instr." valor={instrumento} onCambio={setInstrumento} opciones={opcionesInstrumento} />
            <Chips
              titulo="contar"
              valor={modo}
              onCambio={setModo}
              opciones={[
                { id: 'operacion', label: 'Por operación', title: 'Cada pierna del diario por separado' },
                { id: 'sesion',    label: 'Por sesión',    title: 'Día + instrumento, sumando todas sus piernas, como en Seguimiento' },
              ]}
            />
            <Chips
              titulo="medir"
              valor={medida}
              onCambio={setMedida}
              opciones={[
                { id: 'eur',    label: '€' },
                { id: 'puntos', label: 'Puntos', disabled: !puntosPosibles,
                  title: puntosPosibles ? undefined : 'Elige un instrumento: los puntos de instrumentos distintos no se pueden sumar' },
              ]}
            />
          </div>

          {r.n === 0 ? (
            <div className="fotos-placeholder">Nada que contar con este filtro</div>
          ) : (
            <>
              <div className="estr-tiles stats-tiles">
                {tiles.map(t => (
                  <div key={t.label} className="estr-tile">
                    <span className="estr-tile-label">{t.label}</span>
                    <span className={`estr-tile-valor ${t.tono ?? ''}`}>{t.valor}</span>
                    <span className="estr-tile-sub">{t.sub}</span>
                  </div>
                ))}
              </div>

              {curva.length > 1 && <CurvaEquity sesiones={curva} unidad={unidad} />}

              <div className="stats-grid">
                {tablas.map(({ d, filas }) => (
                  <TablaDesglose key={d.id} d={d} filas={filas} cuenta={cuenta} dec={dec} />
                ))}
              </div>
            </>
          )}

          <BloqueExcursiones exc={exc} filtradas={filtradas} />
        </>
      )}
    </div>
  )
}
