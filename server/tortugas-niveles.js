// ── Niveles de las tortugas para el bot (server/bot-tortugas.js) ─────────────────────
// Lo que el bot necesita saber al empezar cada sesión de un índice, sacado de sus velas
// diarias anteriores: la N (ATR de Wilder de 20 sesiones), los máximos y mínimos de 10, 20
// y 55 sesiones y el filtro del Sistema 1 (si la última ruptura de 20, operada o no, habría
// ganado). Son las mismas cuentas que el motor del backtest (src/tortugas.js, que el
// servidor no tiene porque se despliega sin src); test/botTortugas.test.js comprueba que
// los dos dan lo mismo.

const ARRANQUE = 60   // como el backtest: las primeras sesiones solo sirven para los canales

function wilder(x, k) {
  const n = new Array(x.length).fill(NaN)
  if (x.length < k) return n
  let s = 0
  for (let i = 0; i < k; i++) s += x[i]
  n[k - 1] = s / k
  for (let i = k; i < x.length; i++) n[i] = (n[i - 1] * (k - 1) + x[i]) / k
  return n
}

// Extremo de las k sesiones anteriores a la i (sin contarla)
const extremo = (x, i, k, f) => (i < k ? NaN : f(...x.slice(i - k, i)))

// `velas`: las diarias en orden, con `date` (YYYY-MM-DD) y OHLC, hasta la última sesión
// cerrada. Devuelve los niveles para la sesión siguiente, o null si no hay bastantes.
export function nivelesTortugas(velas, { stopN = 2 } = {}) {
  const vs = (velas ?? []).filter(v => v.high > v.low)
  if (vs.length < ARRANQUE + 1) return null
  const o = vs.map(v => v.open), h = vs.map(v => v.high), l = vs.map(v => v.low), c = vs.map(v => v.close)
  const tr = vs.map((v, i) => (i === 0 ? v.high - v.low
    : Math.max(v.high - v.low, Math.abs(v.high - c[i - 1]), Math.abs(v.low - c[i - 1]))))
  const nCierre = wilder(tr, 20)

  // La ruptura "virtual" del Sistema 1: la de 20 sesiones en cualquier sentido, con salida
  // en la de 10 o en su stop de 2 N. El backtest la sigue aparte de la cartera, y se puede
  // rehacer sola porque nada de la cartera la mueve. Dentro de cada sesión, el camino es
  // cierre anterior → apertura (el salto de la noche, que llena en la apertura) → mínimo →
  // máximo → cierre si cierra por encima de la apertura, o con el máximo antes si no.
  let virtual = null, gano = false
  for (let i = ARRANQUE; i < vs.length; i++) {
    const n = nCierre[i - 1]
    const recorrer = (a, b, salto) => {
      if (a === b) return
      const sube = b > a, lado = sube ? 1 : -1
      for (let vuelta = 0; vuelta < 20; vuelta++) {
        let nivel, entra = false
        if (!virtual) { nivel = extremo(sube ? h : l, i, 20, sube ? Math.max : Math.min); entra = true }
        else if (virtual.lado === -lado) {
          nivel = sube ? Math.min(virtual.stop, extremo(h, i, 10, Math.max)) : Math.max(virtual.stop, extremo(l, i, 10, Math.min))
        } else return
        if (Number.isNaN(nivel) || (sube && nivel > b) || (!sube && nivel < b)) return
        const precio = salto ? b : sube ? Math.max(nivel, a) : Math.min(nivel, a)
        if (entra) virtual = { lado, entrada: precio, stop: precio - lado * stopN * n, fecha: vs[i].date }
        else { gano = (precio - virtual.entrada) * virtual.lado > 0; virtual = null }
        a = precio
      }
    }
    const camino = [c[i - 1], o[i], ...(c[i] >= o[i] ? [l[i], h[i]] : [h[i], l[i]]), c[i]]
    for (let k = 0; k < 4; k++) recorrer(camino[k], camino[k + 1], k === 0)
  }

  const fin = vs.length
  return {
    ultimoDia: vs.at(-1).date,
    cierre: c.at(-1),
    n: nCierre.at(-1),
    alto: { 10: extremo(h, fin, 10, Math.max), 20: extremo(h, fin, 20, Math.max), 55: extremo(h, fin, 55, Math.max) },
    bajo: { 10: extremo(l, fin, 10, Math.min), 20: extremo(l, fin, 20, Math.min), 55: extremo(l, fin, 55, Math.min) },
    gano,
    virtual,
  }
}
