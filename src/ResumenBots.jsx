import { useEffect, useState, useCallback, useRef } from 'react'
import './Bot.css'

// Cómo van los bots para quien no tiene la clave (/api/resumen-bots): primero la cuenta de IG
// entera, y luego cada bot con qué hace, si está operando, su curva, sus cifras, lo que tiene
// abierto y lo que ha cerrado, todo en % del saldo de su cuenta. Solo mira: los mandos siguen
// en la pestaña Bots, con la clave.

const pct = (x, dec = 2) => (x == null ? '—' : `${x > 0.005 ? '+' : x < -0.005 ? '−' : ''}${Math.abs(x).toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec })} %`)
const signo = x => (x == null ? '' : x > 0.005 ? 'bot-pos' : x < -0.005 ? 'bot-neg' : '')
const fecha = t => (t ? new Date(t * 1000).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')
const dia = t => (t ? new Date(t * 1000).toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', year: '2-digit' }) : '—')
const proximaTexto = t => (t ? new Date(t * 1000).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null)
const LADO = { largo: 'Compra', corto: 'Venta' }

// Qué hace cada bot, para quien no lo conoce
const DESCRIPCION = {
  SRS: 'Intradía en los índices (Nikkei, DAX, FTSE y los de Nueva York): opera la rotura del máximo o el mínimo de la segunda vela de 15 minutos de cada sesión, con stop al otro lado, añade si el precio va a favor, se da la vuelta una vez si salta el stop y cierra con la sesión.',
  'Rule of 4': 'Solo los días en que la Reserva Federal (FOMC) publica su decisión: opera la rotura de la cuarta vela de 10 minutos tras el comunicado, durante dos horas.',
  'First bar negative': 'Intradía en los índices: si la primera vela de 5 minutos de la sesión cierra en negativo, vende cuando pierde su mínimo.',
  Tortugas: 'Seguimiento de tendencia con las reglas de las tortugas de Richard Dennis en índices, divisas y materias primas: entra en rupturas de 20 y 55 días, añade si va a favor y sale en la ruptura contraria. Aguanta las posiciones días o semanas.',
  'Tortugas acciones': 'Las reglas de las tortugas en las acciones del S&P 500, solo a largo, en la cuenta de prueba de Alpaca.',
}

function Dato({ nombre, valor, texto = null, clase = null, nota = null }) {
  return (
    <div className="bot-dato">
      <span>{nombre}</span>
      <b className={`bot-tile-valor ${clase ?? signo(valor)}`}>{texto ?? pct(valor)}</b>
      {nota && <small>{nota}</small>}
    </div>
  )
}

// La curva acumulada de lo cerrado, con la raya del cero y una cruz que dice cada operación
function Curva({ puntos }) {
  const ref = useRef(null)
  const [cursor, setCursor] = useState(null)
  if (puntos.length < 2) return null
  const W = 720, H = 170, IZQ = 44, DER = 8, ARR = 10, ABA = 22
  const serie = [{ hora: puntos[0].hora, pct: 0, inicio: true }, ...puntos]
  const ys = serie.map(p => p.pct)
  let min = Math.min(0, ...ys), max = Math.max(0, ...ys)
  if (max - min < 0.5) { max += 0.25; min -= 0.25 }
  const x = i => IZQ + (i / (serie.length - 1)) * (W - IZQ - DER)
  const y = v => ARR + (1 - (v - min) / (max - min)) * (H - ARR - ABA)
  const paso = (max - min) / 4
  const marcas = [0, 1, 2, 3, 4].map(k => min + k * paso)
  const camino = serie.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.pct).toFixed(1)}`).join('')
  const ultimo = serie.at(-1).pct
  const color = ultimo >= 0 ? 'var(--green)' : 'var(--red)'
  const relleno = `${camino}L${x(serie.length - 1)},${y(0)}L${x(0)},${y(0)}Z`

  function mover(e) {
    const caja = ref.current.getBoundingClientRect()
    const px = ((e.clientX - caja.left) / caja.width) * W
    const i = Math.round(((px - IZQ) / (W - IZQ - DER)) * (serie.length - 1))
    setCursor(Math.max(1, Math.min(serie.length - 1, i)))
  }
  const c = cursor != null ? serie[cursor] : null
  return (
    <div className="bv-grafico resumen-curva">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} onMouseMove={mover} onMouseLeave={() => setCursor(null)} role="img"
        aria-label={`Resultado acumulado de ${puntos.length} operaciones: ${pct(ultimo)}`}>
        {marcas.map(m => (
          <g key={m}>
            <line className="bv-rejilla" x1={IZQ} x2={W - DER} y1={y(m)} y2={y(m)} />
            <text className="bv-eje" x={IZQ - 6} y={y(m) + 3} textAnchor="end">{pct(m, 1)}</text>
          </g>
        ))}
        <line className="bv-cero" x1={IZQ} x2={W - DER} y1={y(0)} y2={y(0)} />
        <path d={relleno} fill={color} opacity="0.08" />
        <path d={camino} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <text className="bv-eje" x={IZQ} y={H - 6}>{dia(serie[1].hora)}</text>
        <text className="bv-eje" x={W - DER} y={H - 6} textAnchor="end">{dia(serie.at(-1).hora)}</text>
        {c && (
          <g>
            <line className="bv-cruz" x1={x(cursor)} x2={x(cursor)} y1={ARR} y2={H - ABA} />
            <circle cx={x(cursor)} cy={y(c.pct)} r="4" fill={color} stroke="var(--surface)" strokeWidth="2" />
          </g>
        )}
      </svg>
      {c && (
        <div className="resumen-curva-tip" style={{ left: `${Math.min(82, Math.max(18, (x(cursor) / W) * 100))}%` }}>
          <b>{fecha(c.hora)}</b> · {c.instrumento}<br />
          Operación <span className={signo(c.resultado)}>{pct(c.resultado)}</span> · acumulado <span className={signo(c.pct)}>{pct(c.pct)}</span>
        </div>
      )}
    </div>
  )
}

function Estado({ b }) {
  if (!b.encendido) return <span className="resumen-estado apagado">Apagado</span>
  if (b.parado) return <span className="resumen-estado mal">Encendido, pero parado</span>
  if (!b.enMarcha) return <span className="resumen-estado">Encendido (no opera en este servidor)</span>
  return <span className="resumen-estado bien">Encendido</span>
}

// Qué está haciendo ahora: en sesión, o cuándo vuelve
function Ahora({ b }) {
  if (!b.encendido) return null
  const partes = []
  if (b.instrumentos != null) partes.push(`${b.instrumentos} ${b.nombre === 'Tortugas acciones' ? 'acciones' : b.instrumentos === 1 ? 'mercado' : 'mercados'} vigilados`)
  if (b.enSesion.length) partes.push(`ahora con el mercado abierto en ${b.enSesion.length > 6 ? `${b.enSesion.length} mercados` : b.enSesion.join(', ')}`)
  else if (b.proxima) partes.push(`vuelve a operar el ${proximaTexto(b.proxima)}`)
  return partes.length ? <p className="bot-nota">{partes.join(' · ')}</p> : null
}

function TarjetaBot({ b }) {
  const { totales: tot, cifras: c } = b
  const [todas, setTodas] = useState(false)
  const ultimas = todas ? b.ultimas : b.ultimas.slice(0, 8)
  return (
    <section className="bot-bloque resumen-bot">
      <div className="resumen-bot-cab">
        <div>
          <h3>{b.nombre} <span className="bot-nota">· {b.cuenta}</span></h3>
          {DESCRIPCION[b.nombre] && <p className="resumen-desc">{DESCRIPCION[b.nombre]}</p>}
          <Ahora b={b} />
        </div>
        <Estado b={b} />
      </div>

      <div className="resumen-bots-datos">
        <Dato nombre="Hoy" valor={tot.hoy} />
        <Dato nombre="7 días" valor={tot.semana} />
        <Dato nombre="30 días" valor={tot.mes} />
        <Dato nombre="Desde el principio" valor={tot.total} nota={c.primera ? `desde el ${dia(c.primera)}` : null} />
        <Dato nombre="Abierto ahora" valor={b.abierto.pct} texto={b.abiertas.length ? null : '—'} nota={b.abiertas.length ? `${b.abiertas.length} ${b.abiertas.length === 1 ? 'mercado' : 'mercados'}` : 'nada abierto'} />
      </div>

      {tot.operaciones > 0 && (
        <>
          <Curva puntos={b.curva} />
          <div className="resumen-bots-datos resumen-cifras">
            <Dato nombre="Operaciones" texto={`${tot.operaciones}`} clase="" nota={`${Math.round(100 * tot.ganadoras / tot.operaciones)} % ganadoras`} />
            <Dato nombre="Media ganadora" valor={c.mediaGanadora} />
            <Dato nombre="Media perdedora" valor={c.mediaPerdedora} />
            <Dato nombre="Factor de beneficio" texto={c.factorBeneficio == null ? '—' : c.factorBeneficio.toLocaleString('es-ES', { maximumFractionDigits: 2 })}
              clase={c.factorBeneficio == null ? '' : c.factorBeneficio >= 1 ? 'bot-pos' : 'bot-neg'} nota="lo ganado entre lo perdido" />
            <Dato nombre="Peor caída" valor={c.peorCaida} nota="desde un máximo de la curva" />
            <Dato nombre="Mejor" valor={c.mejor?.pct} nota={c.mejor && `${c.mejor.instrumento}, ${dia(c.mejor.hora)}`} />
            <Dato nombre="Peor" valor={c.peor?.pct} nota={c.peor && `${c.peor.instrumento}, ${dia(c.peor.hora)}`} />
            {c.racha && <Dato nombre="Racha" texto={`${c.racha.n} ${c.racha.gana ? (c.racha.n === 1 ? 'ganadora' : 'ganadoras') : (c.racha.n === 1 ? 'perdedora' : 'perdedoras')}`}
              clase={c.racha.gana ? 'bot-pos' : 'bot-neg'} nota="seguidas, hasta la última" />}
          </div>
        </>
      )}

      <h4 className="resumen-bots-sub">Abierto ahora</h4>
      {b.abiertas.length ? (
        <div className="velas-tabla-wrap">
          <table className="velas-tabla bot-tabla">
            <thead><tr><th>Mercado</th><th>Sentido</th><th>Desde</th><th>Posiciones</th><th>Va</th><th>Si salta el stop</th></tr></thead>
            <tbody>
              {[...b.abiertas].sort((x, y) => (y.pct ?? -Infinity) - (x.pct ?? -Infinity)).map(a => (
                <tr key={`${a.instrumento}-${a.lado}`}>
                  <td>{a.instrumento}</td><td>{LADO[a.lado] ?? a.lado}</td><td>{fecha(a.desde)}</td><td>{a.unidades}</td>
                  <td className={signo(a.pct)}>{pct(a.pct)}</td>
                  <td className={signo(a.alStopPct)}>{pct(a.alStopPct)}</td>
                </tr>
              ))}
            </tbody>
            {b.abiertas.length > 1 && (
              <tfoot><tr><td colSpan={4}>Todo</td><td className={signo(b.abierto.pct)}>{pct(b.abierto.pct)}</td><td className={signo(b.abierto.alStopPct)}>{pct(b.abierto.alStopPct)}</td></tr></tfoot>
            )}
          </table>
        </div>
      ) : <p className="bot-nota">Nada abierto.</p>}

      {b.porInstrumento.length > 1 && (
        <>
          <h4 className="resumen-bots-sub">Por mercado (lo cerrado)</h4>
          <div className="velas-tabla-wrap">
            <table className="velas-tabla bot-tabla">
              <thead><tr><th>Mercado</th><th>Operaciones</th><th>Ganadoras</th><th>Resultado</th></tr></thead>
              <tbody>
                {b.porInstrumento.map(g => (
                  <tr key={g.instrumento}>
                    <td>{g.instrumento}</td><td>{g.operaciones}</td><td>{Math.round(100 * g.ganadoras / g.operaciones)} %</td>
                    <td className={signo(g.pct)}>{pct(g.pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h4 className="resumen-bots-sub">Últimas cerradas</h4>
      {b.ultimas.length ? (
        <>
          <div className="velas-tabla-wrap">
            <table className="velas-tabla bot-tabla">
              <thead><tr><th>Cerrada</th><th>Mercado</th><th>Sentido</th><th>Resultado</th></tr></thead>
              <tbody>
                {ultimas.map((u, i) => (
                  <tr key={i}>
                    <td>{fecha(u.hora)}</td><td>{u.instrumento}{u.nota ? <span className="bot-nota"> · {u.nota}</span> : null}</td>
                    <td>{LADO[u.lado] ?? '—'}</td><td className={signo(u.pct)}>{pct(u.pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {b.ultimas.length > 8 && (
            <button className="diario-boton resumen-mas" onClick={() => setTodas(v => !v)}>{todas ? 'Ver menos' : `Ver las ${b.ultimas.length} últimas`}</button>
          )}
        </>
      ) : <p className="bot-nota">Aún no ha cerrado ninguna.</p>}
    </section>
  )
}

// La cuenta de IG entera: sus bots comparten el saldo, así que sus % se suman
function Conjunto({ conjunto: k }) {
  return (
    <section className="bot-bloque resumen-bot">
      <div className="resumen-bot-cab">
        <div>
          <h3>Todos los bots</h3>
          <p className="resumen-desc">
            {k.encendidos} de {k.bots} encendidos. Las cifras de abajo son las de la cuenta de IG, que comparten el SRS, la Rule of 4, First bar negative y las Tortugas.
          </p>
        </div>
        {k.parados.length
          ? <span className="resumen-estado mal">Parado: {k.parados.join(', ')}</span>
          : <span className="resumen-estado bien">Todo en marcha</span>}
      </div>
      <div className="resumen-bots-datos">
        <Dato nombre="Hoy" valor={k.ig.hoy} />
        <Dato nombre="7 días" valor={k.ig.semana} />
        <Dato nombre="30 días" valor={k.ig.mes} />
        <Dato nombre="Desde el principio" valor={k.ig.total} />
        <Dato nombre="Abierto ahora" valor={k.ig.abierto} nota={`${k.ig.abiertas} ${k.ig.abiertas === 1 ? 'mercado' : 'mercados'}`} />
        <Dato nombre="Si saltan todos los stops" valor={k.ig.alStop} nota="desde la entrada" />
      </div>
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
        Los resultados van en % del saldo de ahora de la cuenta de cada bot (las de IG y Alpaca son de prueba, sin dinero real),
        sin contar lo que sigue abierto salvo donde se dice. Actualizado {fecha(datos.hora)}; se refresca solo cada minuto.
      </p>
      {error && <p className="bot-error">{error}</p>}
      {datos.conjunto && <Conjunto conjunto={datos.conjunto} />}
      {datos.bots.length ? datos.bots.map(b => <TarjetaBot key={b.nombre} b={b} />) : <p className="bot-nota">No hay bots en este servidor.</p>}
    </div>
  )
}
