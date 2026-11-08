// La regla de una tarjeta de posición (Posiciones activas y las tortugas): stop · entrada · ahora.
// `t`: { lado, nivel (la entrada, o la media), precio (el de ahora), stops: [...], puntos, piezas: [...] }

const num = (n, dec = 1) => n.toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec })
const decimales = x => { const a = Math.abs(x ?? 0); return a >= 1000 ? 1 : a >= 100 ? 2 : a >= 10 ? 3 : 5 }
const precio = n => (n == null ? '—' : num(n, decimales(n)))

// El trade en una regla: a la izquierda el lado del stop y a la derecha el de la ganancia
// (en una venta, el precio baja hacia la derecha). La zona entre el stop más lejano y la
// entrada media es lo que se arriesga (verde si el stop ya asegura ganancia) y el relleno,
// de la entrada al precio de ahora, lo que va ganando o perdiendo.
export default function Regla({ t }) {
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
