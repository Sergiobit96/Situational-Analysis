// ── Dibujos de la pestaña Gráfico ──────────────────────────────────────────────
// Se guardan por instrumento (la clave) en un JSON junto al diario. Aquí solo se valida lo
// que llega del navegador, para que el fichero no acabe con basura que luego rompa el
// gráfico al cargarla; leer y escribir el fichero va en index.js, como el resto.

const TIPOS        = new Set(['trendline', 'fib', 'ray'])
const MAX_DIBUJOS  = 500
// el instrumento, con la fuente detrás (^GDAXI@ig); los mercados sueltos de IG van con su
// epic (ig:CS.D.EURUSD.CEC.IP@ig)
const CLAVE_VALIDA = /^[\w^.=@:-]{1,60}$/

const esPunto = p => p != null && Number.isFinite(p.time) && Number.isFinite(p.price)
const punto   = p => ({ time: p.time, price: p.price })

export const claveValida = clave => typeof clave === 'string' && CLAVE_VALIDA.test(clave)

// La lista tal y como se guarda, o un error que dice qué dibujo no vale
export function limpiarDibujos(lista) {
  if (!Array.isArray(lista)) throw new Error('Se esperaba una lista de dibujos')
  if (lista.length > MAX_DIBUJOS) throw new Error(`Demasiados dibujos: ${lista.length} (máximo ${MAX_DIBUJOS})`)
  return lista.map((d, i) => {
    if (!TIPOS.has(d?.type)) throw new Error(`Dibujo ${i + 1}: tipo desconocido (${d?.type})`)
    const conDosPuntos = d.type !== 'ray'
    if (!esPunto(d.p1) || (conDosPuntos && !esPunto(d.p2))) throw new Error(`Dibujo ${i + 1}: puntos sin hora o precio`)
    return {
      type:  d.type,
      color: typeof d.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(d.color) ? d.color : null,
      p1:    punto(d.p1),
      p2:    conDosPuntos ? punto(d.p2) : null,
    }
  })
}
