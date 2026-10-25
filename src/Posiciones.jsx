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
const tono = n => (n == null ? '' : n > 0 ? 'bot-pos' : n < 0 ? 'bot-neg' : '')
const fechaHora = iso => (iso ? new Date(iso.endsWith('Z') ? iso : `${iso}Z`).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')

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
          <div className="bot-dato"><span>Posiciones</span><b className="bot-tile-valor">{posiciones.length}</b></div>
          <div className="bot-dato"><span>Resultado abierto</span><b className={`bot-tile-valor ${tono(resultadoEur)}`}>{dinero(resultadoEur, '€')}</b>{delSaldo(resultadoEur) && <small>{delSaldo(resultadoEur)}</small>}</div>
          <div className="bot-dato" title="Lo que daría cerrar todo en sus stops, desde la entrada (sin contar el deslizamiento ni los huecos)">
            <span>Si saltan los stops</span><b className={`bot-tile-valor ${tono(alStopEur)}`}>{dinero(alStopEur, '€')}</b>
            <small>{delSaldo(alStopEur) ?? 'desde la entrada'}</small>
          </div>
          {sinStop > 0 && <div className="bot-dato"><span>Sin stop</span><b className="bot-tile-valor bot-neg">{sinStop}</b><small>riesgo sin límite</small></div>}
          {cuenta?.saldo != null && <div className="bot-dato"><span>Saldo</span><b className="bot-tile-valor">{num(cuenta.saldo, 2)} {cuenta.moneda}</b></div>}
          {cuenta?.disponible != null && <div className="bot-dato"><span>Disponible</span><b className="bot-tile-valor">{num(cuenta.disponible, 2)} {cuenta.moneda}</b></div>}
        </div>

        {posiciones.length === 0 ? <p className="bot-nota">No hay ninguna posición abierta.</p> : (
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
                          {[enMoneda(p.alStopEur, p.alStop, p.moneda), delSaldo(p.alStopEur), `${pts(p.stop - p.nivel, p.nivel)} pts`].filter(Boolean).join(' · ')}
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
