import { useEffect, useState, useCallback } from 'react'
import { conClaveBot, guardarClaveBot } from './claveBot'
import './Bot.css'

// Las posiciones abiertas ahora mismo en la cuenta demo de IG, las de todos los bots (y las
// abiertas a mano), con lo que va ganando cada una al precio de cierre de ahora. El bot sale
// del prefijo de la referencia de la orden (server/index.js, /api/bot/posiciones).

const num = (n, dec = 1) => n.toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec })
// los decimales según el tamaño del precio: las divisas, con 5
const decimales = x => { const a = Math.abs(x ?? 0); return a >= 1000 ? 1 : a >= 100 ? 2 : a >= 10 ? 3 : 5 }
const pts = (n, ref) => (n == null ? '—' : `${n > 0 ? '+' : ''}${num(n, decimales(ref ?? n))}`)
const dinero = (n, moneda) => (n == null ? '—' : `${n > 0 ? '+' : ''}${num(n, 2)} ${moneda ?? ''}`.trim())
const precio = n => (n == null ? '—' : num(n, decimales(n)))
// la suma en € de un campo (cada posición en su moneda, pasada a € con el cambio de IG); null
// si a alguna le falta el cambio, para no dar un total que no lo es
const sumaEur = (posiciones, campo) => {
  const conValor = posiciones.filter(p => p[campo.replace('Eur', '')] != null)
  return conValor.some(p => p[campo] == null) ? null : conValor.reduce((s, p) => s + p[campo], 0)
}
// los puntos hasta el stop desde la entrada, a favor (+) o en contra (−) de la posición
const alStopPts = p => (p.stop == null ? null : (p.stop - p.nivel) * (p.lado === 'largo' ? 1 : -1))
const tono = n => (n == null ? '' : n > 0 ? 'bot-pos' : n < 0 ? 'bot-neg' : '')
const fechaHora = iso => (iso ? new Date(iso.endsWith('Z') ? iso : `${iso}Z`).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')

// Las posiciones del mismo instrumento y del mismo lado, juntas como un solo trade: el tamaño,
// el resultado y lo que daría el stop, sumados; la entrada y los puntos, la media por tamaño.
// Los stops pueden ser distintos (cada sistema de las tortugas lleva el suyo): van todos.
function juntarEnTrades(posiciones) {
  const trades = new Map()
  for (const p of posiciones) {
    const clave = `${p.epic}|${p.lado}`
    if (!trades.has(clave)) trades.set(clave, [])
    trades.get(clave).push(p)
  }
  return [...trades.entries()].map(([clave, piezas]) => {
    const tamano = piezas.reduce((s, p) => s + p.tamano, 0)
    const media = campo => (piezas.some(p => p[campo] == null) ? null : piezas.reduce((s, p) => s + p[campo] * p.tamano, 0) / tamano)
    const suma = campo => (piezas.some(p => p[campo] == null) ? null : piezas.reduce((s, p) => s + p[campo], 0))
    const [p0] = piezas
    return {
      clave, piezas, tamano, lado: p0.lado, nombre: p0.nombre ?? p0.ticker ?? p0.epic, epic: p0.epic, mercado: p0.mercado, moneda: p0.moneda,
      precio: p0.precio, nivel: media('nivel'), puntos: media('puntos'),
      resultado: suma('resultado'), resultadoEur: suma('resultadoEur'), alStop: suma('alStop'), alStopEur: suma('alStopEur'),
      bots: [...new Set(piezas.map(p => p.bot ?? 'a mano'))],
      stops: [...new Set(piezas.map(p => p.stop).filter(Number.isFinite))],
      sinStop: piezas.filter(p => p.stop == null).length,
      abierta: piezas.map(p => p.abierta).filter(Boolean).sort()[0] ?? null,
    }
  })
}

// El trade en una regla: a la izquierda el lado del stop y a la derecha el de la ganancia
// (en una venta, el precio baja hacia la derecha). La zona entre el stop más lejano y la
// entrada media es lo que se arriesga (verde si el stop ya asegura ganancia) y el relleno,
// de la entrada al precio de ahora, lo que va ganando o perdiendo.
function Regla({ t }) {
  const signo = t.lado === 'largo' ? 1 : -1
  const niveles = [t.nivel, t.precio, ...t.stops].filter(Number.isFinite)
  if (niveles.length < 2 || !Number.isFinite(t.nivel)) return null
  const v = niveles.map(n => n * signo)
  let lo = Math.min(...v)
  let hi = Math.max(...v)
  const m = (hi - lo || Math.abs(hi) * 0.001 || 1) * 0.06
  lo -= m
  hi += m
  const x = n => ((n * signo - lo) / (hi - lo)) * 100
  const tramo = (a, b) => ({ left: `${Math.min(x(a), x(b))}%`, width: `${Math.abs(x(b) - x(a))}%` })
  // de izquierda a derecha: el primero es el más lejano del precio
  const stops = [...t.stops].sort((a, b) => a * signo - b * signo)
  const conStop = stops.length > 0
  const asegura = s => (s - t.nivel) * signo >= 0
  const gana = (t.puntos ?? 0) >= 0
  // las etiquetas no se salen de la regla: cerca de un borde, alineadas hacia dentro
  const sitio = n => {
    const a = x(n)
    return { left: `${a}%`, transform: `translateX(${a < 25 ? '-6px' : a > 75 ? 'calc(6px - 100%)' : '-50%'})` }
  }
  const textoStop = `${stops.length > 1 ? 'stops' : 'stop'} ${stops.map(precio).join(' · ')}`
  // si el stop y la entrada están muy juntos (o hay varios stops), el texto del stop baja una línea
  const juntos = conStop && (stops.length > 1 || Math.abs(x(stops[0]) - x(t.nivel)) < 30)
  const entrada = `${t.piezas.length > 1 ? 'entrada media' : 'entrada'} ${precio(t.nivel)}`
  const resumen = [conStop && textoStop, entrada, Number.isFinite(t.precio) && `ahora ${precio(t.precio)}`].filter(Boolean).join(' · ')
  return (
    <div className="pos-regla" role="img" aria-label={resumen} title={resumen}>
      {Number.isFinite(t.precio) && <span className={`pos-regla-ahora-txt ${gana ? 'bot-pos' : 'bot-neg'}`} style={sitio(t.precio)}>ahora {precio(t.precio)}</span>}
      <div className="pos-regla-pista">
        {conStop && <span className={`pos-regla-riesgo ${asegura(stops[0]) ? 'asegura' : ''}`} style={tramo(stops[0], t.nivel)} />}
        {Number.isFinite(t.precio) && <span className={`pos-regla-va ${gana ? 'sube' : 'baja'}`} style={tramo(t.nivel, t.precio)} />}
        {stops.map(s => <span key={s} className={`pos-regla-marca stop ${asegura(s) ? 'asegura' : ''}`} style={{ left: `${x(s)}%` }} />)}
        <span className="pos-regla-marca entrada" style={{ left: `${x(t.nivel)}%` }} />
        {Number.isFinite(t.precio) && <span className={`pos-regla-punto ${t.lado}`} style={{ left: `${x(t.precio)}%` }} />}
      </div>
      <div className={`pos-regla-pie ${juntos ? 'doble' : ''}`}>
        {conStop && <span className={`pos-regla-txt ${stops.every(asegura) ? 'bot-pos' : 'bot-neg'} ${juntos ? 'abajo' : ''}`} style={sitio(stops[0])}>{textoStop}</span>}
        <span className="pos-regla-txt" style={sitio(t.nivel)}>{entrada}</span>
      </div>
    </div>
  )
}

async function pedir(url) {
  const r = await fetch(url, { headers: conClaveBot() })
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
  if (!r.ok || j.error) {
    const err = new Error(j.error ?? `HTTP ${r.status}`)
    err.necesitaClave = !!j.necesitaClave
    throw err
  }
  return j
}

export default function Posiciones() {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const [pideClave, setPideClave] = useState(false)
  const [clave, setClave] = useState('')
  const [hora, setHora] = useState(null)
  const [vista, setVista] = useState(() => { try { return localStorage.getItem('sa.posiciones') ?? 'tarjetas' } catch { return 'tarjetas' } })
  const elegirVista = v => { setVista(v); try { localStorage.setItem('sa.posiciones', v) } catch { /* sin almacenamiento */ } }

  const cargar = useCallback(async () => {
    try {
      setDatos(await pedir('/api/bot/posiciones'))
      setHora(new Date())
      setError(null)
      setPideClave(false)
    } catch (err) {
      setError(err.message)
      if (err.necesitaClave) setPideClave(true)
    }
  }, [])

  // al abrir la vista y cada 10 s (cada vuelta es una petición a IG)
  useEffect(() => {
    const primera = setTimeout(cargar, 0)
    const reloj = setInterval(cargar, 10000)
    return () => { clearTimeout(primera); clearInterval(reloj) }
  }, [cargar])

  if (pideClave) {
    return (
      <div className="bot-page">
        <section className="bot-bloque bot-clave">
          <h3>Clave del bot</h3>
          <p className="bot-nota">El servidor de producción pide la clave del bot (la variable BOT_TOKEN de Railway). Se guarda en este navegador.</p>
          {error && <p className="bot-error">{error}</p>}
          <form onSubmit={e => { e.preventDefault(); guardarClaveBot(clave); cargar() }}>
            <input type="password" value={clave} onChange={e => setClave(e.target.value)} placeholder="Clave" autoComplete="current-password" />
            <button className="diario-boton" type="submit">Entrar</button>
          </form>
        </section>
      </div>
    )
  }
  if (!datos) {
    return <div className="bot-page">{error ? <p className="bot-error">{error}</p> : <p className="bot-nota">Cargando…</p>}</div>
  }

  const { posiciones, cuenta } = datos
  const resultadoEur = sumaEur(posiciones, 'resultadoEur')
  const alStopEur = sumaEur(posiciones, 'alStopEur')
  const sinStop = posiciones.filter(p => p.stop == null).length
  const trades = juntarEnTrades(posiciones)
  // en % del saldo (la cuenta va en €)
  const delSaldo = eur => (eur != null && cuenta?.saldo > 0 && cuenta.moneda === 'EUR' ? `${eur > 0 ? '+' : ''}${num(100 * eur / cuenta.saldo, 2)}% del saldo` : null)
  // En €, con el cambio de IG; si falta el cambio, en la moneda del instrumento. `enMoneda`, lo
  // mismo en su moneda, debajo, cuando no es el euro.
  const enEur = (eur, valor, moneda) => (eur != null ? dinero(eur, '€') : dinero(valor, moneda))
  const enMoneda = (eur, valor, moneda) => (eur != null && moneda && moneda !== 'EUR' ? dinero(valor, moneda) : null)

  return (
    <div className="bot-page">
      <section className="bot-bloque">
        <h3>Posiciones activas</h3>
        <p className="bot-nota">
          Lo abierto ahora en la cuenta demo de IG, de todos los bots y lo abierto a mano. El resultado es al precio al que se cerraría ahora (el bid en una compra, la oferta en una venta).
          {hora && ` Actualizado a las ${hora.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid' })}; se refresca cada 10 s.`}
        </p>
        {error && <p className="bot-error">{error}</p>}

        <div className="bot-tarjeta-datos">
          <div className="bot-dato"><span>Posiciones</span><b className="bot-tile-valor">{posiciones.length}</b>{trades.length < posiciones.length && <small>en {trades.length} trades</small>}</div>
          <div className="bot-dato"><span>Resultado abierto</span><b className={`bot-tile-valor ${tono(resultadoEur)}`}>{dinero(resultadoEur, '€')}</b>{delSaldo(resultadoEur) && <small>{delSaldo(resultadoEur)}</small>}</div>
          <div className="bot-dato" title="Lo que daría cerrar todo en sus stops, desde la entrada (sin contar el deslizamiento ni los huecos)">
            <span>Si saltan los stops</span><b className={`bot-tile-valor ${tono(alStopEur)}`}>{dinero(alStopEur, '€')}</b>
            <small>{delSaldo(alStopEur) ?? 'desde la entrada'}</small>
          </div>
          {sinStop > 0 && <div className="bot-dato"><span>Sin stop</span><b className="bot-tile-valor bot-neg">{sinStop}</b><small>riesgo sin límite</small></div>}
          {cuenta?.saldo != null && <div className="bot-dato"><span>Saldo</span><b className="bot-tile-valor">{num(cuenta.saldo, 2)} {cuenta.moneda}</b></div>}
          {cuenta?.disponible != null && <div className="bot-dato"><span>Disponible</span><b className="bot-tile-valor">{num(cuenta.disponible, 2)} {cuenta.moneda}</b></div>}
        </div>

        {posiciones.length > 0 && (
          <div className="estrategias-nav pos-vistas">
            <button className={`estrategia-chip ${vista === 'tarjetas' ? 'activo' : ''}`} onClick={() => elegirVista('tarjetas')}>Tarjetas</button>
            <button className={`estrategia-chip ${vista === 'tabla' ? 'activo' : ''}`} onClick={() => elegirVista('tabla')}>Tabla</button>
          </div>
        )}

        {posiciones.length === 0 ? <p className="bot-nota">No hay ninguna posición abierta.</p> : vista === 'tarjetas' ? (
          <div className="pos-tarjetas">
            {trades.map(t => {
              const moneda = enMoneda(t.resultadoEur, t.resultado, t.moneda)
              const cerrado = t.mercado && t.mercado !== 'TRADEABLE'
              const signo = t.lado === 'largo' ? 1 : -1
              // el stop que saltaría primero: el más cercano al precio
              const primerStop = t.stops.length ? t.stops.reduce((a, b) => (b * signo > a * signo ? b : a)) : null
              const varias = t.piezas.length > 1
              return (
                <article key={t.clave} className={`pos-tarjeta ${t.lado}`}>
                  <div className="pos-tarjeta-cab">
                    <div className="pos-tarjeta-nombre">
                      <strong>{t.nombre}</strong>
                      <div className="bot-tarjeta-titulo">
                        <span className={`bot-pill ${t.lado}`}>{t.lado === 'largo' ? 'Compra' : 'Venta'} · {num(t.tamano, 2)}</span>
                        {t.bots.map(b => <span key={b} className="bot-pill">{b}</span>)}
                        {varias && <span className="bot-pill">{t.piezas.length} entradas</span>}
                        {cerrado && <span className="bot-pill">{t.mercado === 'CLOSED' ? 'mercado cerrado' : t.mercado.toLowerCase()}</span>}
                        {t.sinStop > 0 && <span className="bot-pill pos-sin-stop">{varias ? `${t.sinStop} sin stop` : 'sin stop'}</span>}
                      </div>
                    </div>
                    <div className="bot-tarjeta-resultado">
                      <span className={`bot-grande ${tono(t.resultado)}`}>{enEur(t.resultadoEur, t.resultado, t.moneda)}</span>
                      <small>{[`${pts(t.puntos, t.nivel)} pts${varias ? ' de media' : ''}`, moneda, delSaldo(t.resultadoEur)].filter(Boolean).join(' · ')}</small>
                    </div>
                  </div>
                  <Regla t={t} />
                  <div className="bot-tarjeta-datos">
                    <div className="bot-dato" title="Lo que daría si saltaran los stops, desde la entrada (sin contar el deslizamiento)">
                      <span>{varias ? 'Si saltan los stops' : 'Si salta el stop'}</span>
                      <b className={t.sinStop ? 'bot-neg' : tono(t.alStop)}>{t.sinStop ? 'sin límite' : enEur(t.alStopEur, t.alStop, t.moneda)}</b>
                      {!t.sinStop && <small>{[delSaldo(t.alStopEur), !varias && `${pts(alStopPts(t.piezas[0]), t.nivel)} pts`].filter(Boolean).join(' · ')}</small>}
                    </div>
                    {primerStop != null && Number.isFinite(t.precio) && (
                      <div className="bot-dato" title="Lo que tiene que moverse el precio de ahora para tocar el stop más cercano">
                        <span>Al stop</span><b>{num(Math.abs(t.precio - primerStop), decimales(t.nivel))} pts</b><small>{num(100 * Math.abs(t.precio - primerStop) / t.precio, 2)}% del precio</small>
                      </div>
                    )}
                    <div className="bot-dato"><span>{varias ? 'La primera' : 'Abierta'}</span><b>{fechaHora(t.abierta)}</b><small>{t.epic}</small></div>
                  </div>
                  {varias && (
                    <details className="pos-piezas">
                      <summary>Las {t.piezas.length} entradas</summary>
                      <table>
                        <thead><tr><th>Bot</th><th className="tor-num">Tamaño</th><th className="tor-num">Entrada</th><th className="tor-num">Stop</th><th className="tor-num">Resultado</th><th>Abierta</th></tr></thead>
                        <tbody>
                          {t.piezas.map(p => (
                            <tr key={p.dealId}>
                              <td>{p.bot ?? 'a mano'}</td>
                              <td className="tor-num">{num(p.tamano, 2)}</td>
                              <td className="tor-num">{precio(p.nivel)}</td>
                              <td className={`tor-num ${p.stop == null ? 'bot-neg' : ''}`}>{p.stop == null ? 'sin stop' : precio(p.stop)}</td>
                              <td className={`tor-num ${tono(p.resultado)}`}>{enEur(p.resultadoEur, p.resultado, p.moneda)}</td>
                              <td>{fechaHora(p.abierta)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  )}
                </article>
              )
            })}
          </div>
        ) : (
          <div className="velas-tabla-wrap tor-tabla-wrap">
            <table className="velas-tabla bot-tabla tor-tabla tor-todas pos-tabla">
              <thead>
                <tr><th>Bot</th><th>Instrumento</th><th>Lado</th><th className="tor-num">Tamaño</th><th className="tor-num">Entrada</th><th className="tor-num">Stop</th><th className="tor-num">Ahora</th><th className="tor-num">Puntos</th><th className="tor-num" title="En €, con el cambio de IG; debajo, en la moneda del instrumento si no es el euro">Resultado (€)</th><th className="tor-num" title="Lo que daría si saltara el stop, desde la entrada: negativo si pierde, positivo si el stop ya asegura ganancia (sin contar el deslizamiento)">Si salta el stop</th><th>Abierta</th></tr>
              </thead>
              <tbody>
                {posiciones.map(p => (
                  <tr key={p.dealId}>
                    <td className="bot-celda-texto">{p.bot ?? <span className="bot-nota">a mano</span>}</td>
                    <td className="bot-celda-texto">{p.nombre ?? p.ticker ?? p.epic}<small className="tor-sub">{p.epic}{p.mercado && p.mercado !== 'TRADEABLE' ? ` · ${p.mercado === 'CLOSED' ? 'cerrado' : p.mercado.toLowerCase()}` : ''}</small></td>
                    <td className={`bot-celda-texto ${p.lado === 'largo' ? 'bot-pos' : 'bot-neg'}`}>{p.lado === 'largo' ? 'Compra' : 'Venta'}</td>
                    <td className="tor-num">{num(p.tamano, 2)}</td>
                    <td className="tor-num">{precio(p.nivel)}</td>
                    <td className="tor-num">{precio(p.stop)}</td>
                    <td className="tor-num">{precio(p.precio)}</td>
                    <td className={`tor-num ${tono(p.puntos)}`}>{pts(p.puntos, p.nivel)}</td>
                    <td className={`tor-num ${tono(p.resultado)}`}>
                      {enEur(p.resultadoEur, p.resultado, p.moneda)}
                      {enMoneda(p.resultadoEur, p.resultado, p.moneda) && <small className="tor-sub">{enMoneda(p.resultadoEur, p.resultado, p.moneda)}</small>}
                    </td>
                    <td className={`tor-num ${p.stop == null ? 'bot-neg' : tono(p.alStop)}`}>
                      {p.stop == null ? 'sin stop' : enEur(p.alStopEur, p.alStop, p.moneda)}
                      {p.stop != null && (
                        <small className="tor-sub">
                          {[enMoneda(p.alStopEur, p.alStop, p.moneda), delSaldo(p.alStopEur), `${pts(alStopPts(p), p.nivel)} pts`].filter(Boolean).join(' · ')}
                        </small>
                      )}
                    </td>
                    <td className="bot-celda-texto">{fechaHora(p.abierta)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
