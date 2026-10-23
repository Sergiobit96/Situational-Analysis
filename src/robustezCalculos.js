// ── Robustez de un backtest ──────────────────────────────────────────────────────────
// Lo que miran los traders algorítmicos antes de fiarse de un resultado, sobre la lista de
// resultados por sesión (en R o en puntos, en orden de fecha; 0 si ese día no operó):
//   · métricas: expectativa, SQN, Sortino, factor de recuperación, tiempo en drawdown y el
//     histograma de los resultados;
//   · Monte Carlo: remuestrea las sesiones (con reemplazo) miles de veces para ver el drawdown,
//     la racha perdedora y el total que caben en lo esperable, no solo los que tocaron;
//   · sensibilidad: el resultado de cada combinación de parámetros, para ver si lo bueno es una
//     zona amplia o un punto suelto;
//   · walk-forward: elige la mejor combinación con lo que había hasta cada tramo y la mide en el
//     tramo siguiente, que no ha visto: lo que se habría ganado de verdad optimizando;
//   · régimen: el resultado según la volatilidad del día.
// Funciones puras, sin React, para probarlas (test/robustez.test.js).

const suma = xs => xs.reduce((a, b) => a + b, 0)
const media = xs => (xs.length ? suma(xs) / xs.length : null)
function desviacion(xs) {
  if (xs.length < 2) return null
  const m = media(xs)
  return Math.sqrt(suma(xs.map(x => (x - m) ** 2)) / (xs.length - 1))
}
function percentil(ordenados, q) {
  if (!ordenados.length) return null
  const i = Math.min(ordenados.length - 1, Math.max(0, Math.round(q * (ordenados.length - 1))))
  return ordenados[i]
}

// Generador con semilla (mulberry32): el mismo Monte Carlo cada vez que se mira
export function aleatorio(semilla = 1) {
  let a = semilla >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// La curva de una serie: el peor drawdown (≤ 0), la peor racha de pérdidas seguidas, el total y
// cuántos pasos acabó por debajo de su máximo
export function curvaDe(resultados) {
  let total = 0, pico = 0, maxDD = 0, racha = 0, peorRacha = 0, enDD = 0
  for (const r of resultados) {
    total += r
    if (total > pico) pico = total
    if (total - pico < maxDD) maxDD = total - pico
    if (total < pico) enDD++
    if (r < 0) { racha++; if (racha > peorRacha) peorRacha = racha } else if (r > 0) racha = 0
  }
  return { total, maxDD, peorRacha, enDD }
}

// Las métricas de una serie. `ops`: solo las sesiones con operación (las de 0 no cuentan para la
// expectativa ni el SQN, sí para la curva)
export function metricas(resultados) {
  const ops = resultados.filter(r => r !== 0)
  const m = media(ops)
  const sd = desviacion(ops)
  const bajada = ops.length ? Math.sqrt(suma(ops.map(r => Math.min(0, r) ** 2)) / ops.length) : 0
  const c = curvaDe(resultados)
  return {
    n: ops.length,
    expectativa: m,
    // System Quality Number de Van Tharp: la expectativa entre su dispersión, por √n (hasta 100)
    sqn: sd > 0 ? m / sd * Math.sqrt(Math.min(ops.length, 100)) : null,
    // como el Sharpe, pero solo cuenta la dispersión de las pérdidas
    sortino: bajada > 0 ? m / bajada : null,
    total: c.total,
    maxDD: c.maxDD,
    recuperacion: c.maxDD < 0 ? c.total / -c.maxDD : null,
    pctEnDD: resultados.length ? 100 * c.enDD / resultados.length : null,
    peorRacha: c.peorRacha,
  }
}

// Histograma de los resultados (sin los 0) en cubos de `ancho`: [{ desde, hasta, n }]
export function histograma(resultados, ancho = 0.5) {
  const ops = resultados.filter(r => r !== 0)
  if (!ops.length) return []
  const lo = Math.floor(Math.min(...ops) / ancho)
  const hi = Math.floor(Math.max(...ops) / ancho)
  const cubos = Array.from({ length: hi - lo + 1 }, (_, i) => ({ desde: (lo + i) * ancho, hasta: (lo + i + 1) * ancho, n: 0 }))
  for (const r of ops) cubos[Math.floor(r / ancho) - lo].n++
  return cubos
}

// Monte Carlo por remuestreo: `veces` historias del mismo número de sesiones sacadas al azar de
// las que hubo. Da los percentiles del peor drawdown (el p95 es el que hay que esperar ver), de
// la peor racha y del total, y la parte de historias que acaban perdiendo.
export function monteCarlo(resultados, { veces = 2000, semilla = 1 } = {}) {
  if (resultados.length < 2) return null
  const azar = aleatorio(semilla)
  const dds = [], rachas = [], totales = []
  const n = resultados.length
  const serie = new Array(n)
  for (let k = 0; k < veces; k++) {
    for (let i = 0; i < n; i++) serie[i] = resultados[Math.floor(azar() * n)]
    const c = curvaDe(serie)
    dds.push(c.maxDD); rachas.push(c.peorRacha); totales.push(c.total)
  }
  dds.sort((a, b) => a - b)          // del peor (más negativo) al mejor
  rachas.sort((a, b) => a - b)
  totales.sort((a, b) => a - b)
  return {
    veces,
    dd: { p50: percentil(dds, 0.5), p95: percentil(dds, 0.05), p99: percentil(dds, 0.01) },
    racha: { p50: percentil(rachas, 0.5), p95: percentil(rachas, 0.95), p99: percentil(rachas, 0.99) },
    total: { p5: percentil(totales, 0.05), p50: percentil(totales, 0.5), p95: percentil(totales, 0.95) },
    pctPierde: 100 * totales.filter(t => t < 0).length / veces,
  }
}

// Sensibilidad: para cada combinación (`claves`), el total y la expectativa de su columna de
// `matriz` (una fila por sesión, en orden: { [clave]: resultado })
export function sensibilidad(matriz, claves) {
  return Object.fromEntries(claves.map(k => {
    const serie = matriz.map(f => f[k] ?? 0)
    const ops = serie.filter(r => r !== 0)
    return [k, { total: suma(serie), expectativa: media(ops), n: ops.length, maxDD: curvaDe(serie).maxDD }]
  }))
}

// Walk-forward anclado: parte las sesiones en `tramos` trozos seguidos; en cada uno desde el
// segundo elige la combinación con más total en todo lo anterior y la mide en ese tramo. Da cada
// tramo, la serie fuera de muestra (lo que se habría ganado optimizando de verdad) y la
// eficiencia: la media por sesión fuera de muestra entre la de dentro (cerca de 1, robusto; cerca
// de 0 o negativa, lo bueno era sobreajuste).
export function walkForward(matriz, claves, { tramos = 5, fechaDe = () => null } = {}) {
  if (matriz.length < tramos * 10 || !claves.length) return null
  const corte = i => Math.round(i * matriz.length / tramos)
  const partes = []
  const fuera = []
  let mediaDentro = 0
  for (let t = 1; t < tramos; t++) {
    const antes = matriz.slice(0, corte(t))
    const tramo = matriz.slice(corte(t), corte(t + 1))
    const totales = claves.map(k => suma(antes.map(f => f[k] ?? 0)))
    const mejor = claves[totales.indexOf(Math.max(...totales))]
    const serie = tramo.map(f => f[mejor] ?? 0)
    fuera.push(...serie)
    const dentro = totales[claves.indexOf(mejor)] / antes.length
    mediaDentro += dentro / (tramos - 1)
    partes.push({ desde: fechaDe(tramo[0]), hasta: fechaDe(tramo.at(-1)), elegida: mejor, dentro, fuera: suma(serie) / serie.length, totalFuera: suma(serie) })
  }
  const mediaFuera = suma(fuera) / fuera.length
  return { partes, fuera, totalFuera: suma(fuera), eficiencia: mediaDentro > 0 ? mediaFuera / mediaDentro : null }
}

// Régimen: las sesiones en tercios según `medida` (la volatilidad del día) y el resultado de
// cada tercio. `sesiones`: [{ medida, resultado }]; las que no tienen medida se quedan fuera.
export function porTercios(sesiones) {
  const con = sesiones.filter(s => Number.isFinite(s.medida)).sort((a, b) => a.medida - b.medida)
  if (con.length < 15) return null
  const corte = i => Math.round(i * con.length / 3)
  return [0, 1, 2].map(i => {
    const trozo = con.slice(corte(i), corte(i + 1))
    const ops = trozo.map(s => s.resultado).filter(r => r !== 0)
    return {
      desde: trozo[0].medida, hasta: trozo.at(-1).medida, sesiones: trozo.length, n: ops.length,
      total: suma(ops), expectativa: media(ops), pctGanadas: ops.length ? 100 * ops.filter(r => r > 0).length / ops.length : null,
    }
  })
}
