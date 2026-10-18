// ── Estadísticas de las operaciones reales ────────────────────────────────────
// Lo que se lee de tu propio historial: cuánto aciertas, cuánto ganas cuando aciertas
// frente a lo que pierdes cuando no, y en qué franjas, días, instrumentos y errores del
// Book of Horror se va el dinero. Va aparte de la pestaña para poder probarlo con el runner
// de Node (test/estadisticas.test.js).
import { fmtFechaTS, pnlDeTrade, PRODUCTO_A_INSTRUMENTO, CATEGORIAS_HORROR } from './parseTrades.js'

// Por debajo de esto un grupo se enseña apagado: con tres operaciones un 100% de acierto
// no dice nada, y no debe poder colarse arriba de la tabla como si fuera lo mejor
export const MIN_MUESTRA = 10

// La misma regla que server/excursiones.js (el servidor se despliega solo con su carpeta y
// no puede importar de aquí): el diario dice LONG/SHORT, el historial de la cuenta Buy/Sell
// y, si no dice nada, el lado sale del signo del resultado frente al del precio.
export function ladoDe(t) {
  const d = String(t.direccion ?? '').toUpperCase()
  if (d === 'LONG' || d === 'BUY') return 'largo'
  if (d === 'SHORT' || d === 'SELL') return 'corto'
  const movimiento = t.closePrice - t.openPrice
  if (!Number.isFinite(t.puntos) || t.puntos === 0 || !movimiento) return null
  return (t.puntos > 0) === (movimiento > 0) ? 'largo' : 'corto'
}

// La identidad de los resultados de MFE/MAE del servidor (claveExcursion en
// server/excursiones.js: lleva los precios porque hay piernas distintas con las mismas
// horas) y la del día+instrumento que usan las anotaciones
export const claveDeExcursion = t => `${t.producto}|${t.openTime}|${t.closeTime}|${t.openPrice}|${t.closePrice}`
export const claveDeSesion    = t => `${fmtFechaTS(t.openTime)}_${PRODUCTO_A_INSTRUMENTO[t.producto] ?? ''}`

// Las categorías del Book of Horror llegan por dos sitios: la hoja "Scenarios" del diario
// (por número de sesión, ya pegadas a la operación) y las etiquetas puestas desde la app
// (por día e instrumento, en las anotaciones). Cuentan las dos.
function categoriasDe(t, anotaciones) {
  const cats = new Set((t.categorias ?? []).map(c => c.n))
  for (const n of anotaciones?.[claveDeSesion(t)]?.cats ?? []) cats.add(n)
  return cats
}

// Lo que se cuenta: cada operación tal cual, o cada sesión (día + instrumento, la unidad
// con la que se revisa en Seguimiento) sumando sus piernas. `medida` es 'eur' o 'puntos'.
export function unidadesDe(trades, { modo = 'operacion', medida = 'eur', anotaciones = {} } = {}) {
  const ops = []
  for (const t of trades) {
    const valor = medida === 'puntos' ? t.puntos : pnlDeTrade(t)
    if (!Number.isFinite(valor)) continue
    ops.push({
      producto:  t.producto,
      fecha:     fmtFechaTS(t.openTime),
      openTime:  t.openTime,
      closeTime: t.closeTime,
      valor,
      lado:      ladoDe(t),
      cats:      categoriasDe(t, anotaciones),
      piernas:   1,
    })
  }
  if (modo !== 'sesion') return ops

  const sesiones = new Map()
  for (const o of ops) {
    const clave = `${o.fecha}|${o.producto}`
    const s = sesiones.get(clave)
    if (!s) { sesiones.set(clave, { ...o, cats: new Set(o.cats) }); continue }
    s.valor     += o.valor
    s.openTime   = Math.min(s.openTime, o.openTime)
    s.closeTime  = Math.max(s.closeTime, o.closeTime)
    s.piernas   += 1
    if (!s.lado) s.lado = o.lado
    else if (o.lado && o.lado !== s.lado) s.lado = 'ambos'
    for (const n of o.cats) s.cats.add(n)
  }
  return [...sesiones.values()]
}

const suma = a => a.reduce((x, y) => x + y, 0)

export function mediana(valores) {
  const o = valores.filter(Number.isFinite).sort((a, b) => a - b)
  if (!o.length) return null
  const m = o.length >> 1
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2
}

// Percentil q (0-1) por rango más cercano por debajo, sin interpolar
export function percentil(valores, q) {
  const o = valores.filter(Number.isFinite).sort((a, b) => a - b)
  return o.length ? o[Math.floor(q * (o.length - 1))] : null
}

const media = valores => {
  const v = valores.filter(Number.isFinite)
  return v.length ? suma(v) / v.length : null
}

export function resumen(unidades) {
  const valores = unidades.map(u => u.valor)
  const n = valores.length
  const ganadas  = valores.filter(v => v > 0)
  const perdidas = valores.filter(v => v < 0)
  const sG = suma(ganadas)
  const sP = suma(perdidas)

  // El drawdown y las rachas no van aquí: los da la curva de equity (src/equity.js), día a día
  const gananciaMedia = ganadas.length  ? sG / ganadas.length  : null
  const perdidaMedia  = perdidas.length ? sP / perdidas.length : null
  return {
    n,
    ganadoras:  ganadas.length,
    perdedoras: perdidas.length,
    empates:    n - ganadas.length - perdidas.length,
    acierto:    n ? ganadas.length / n * 100 : null,
    total:      sG + sP,
    media:      n ? (sG + sP) / n : null,
    mediana:    mediana(valores),
    gananciaMedia,
    perdidaMedia,
    ratio: gananciaMedia != null && perdidaMedia != null ? gananciaMedia / -perdidaMedia : null,
    // sin ninguna pérdida el cociente no existe: Infinity, y la pestaña lo pinta como ∞
    profitFactor: perdidas.length ? sG / -sP : (ganadas.length ? Infinity : null),
    mejor: n ? Math.max(...valores) : null,
    peor:  n ? Math.min(...valores) : null,
  }
}

// Agrupa y resume cada grupo. `claveDe` puede devolver varias claves (una sesión con dos
// categorías del Book of Horror cuenta en las dos) o null para dejar la unidad fuera.
export function desglose(unidades, claveDe, { etiqueta, orden } = {}) {
  const grupos = new Map()
  for (const u of unidades) {
    const claves = claveDe(u)
    for (const k of Array.isArray(claves) ? claves : [claves]) {
      if (k == null) continue
      if (!grupos.has(k)) grupos.set(k, [])
      grupos.get(k).push(u)
    }
  }
  const filas = [...grupos.entries()].map(([clave, us]) => ({
    clave,
    etiqueta: etiqueta ? etiqueta(clave) : String(clave),
    ...resumen(us),
    poca: us.length < MIN_MUESTRA,
  }))
  return filas.sort(orden ?? ((a, b) => (a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0)))
}

// Las horas van en hora de Madrid guardada como si fuera UTC, así que se leen con getUTC*
const fechaDe = ts => new Date(ts * 1000)
const dosCifras = n => String(n).padStart(2, '0')
const hhmm = minutos => `${dosCifras(Math.floor(minutos / 60) % 24)}:${dosCifras(minutos % 60)}`

const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']

const DURACIONES = [
  { hasta: 120,      etiqueta: 'Menos de 2 min' },
  { hasta: 300,      etiqueta: '2 a 5 min' },
  { hasta: 900,      etiqueta: '5 a 15 min' },
  { hasta: 3600,     etiqueta: '15 a 60 min' },
  { hasta: 4 * 3600, etiqueta: '1 a 4 h' },
  { hasta: 86400,    etiqueta: '4 h a 1 día' },
  { hasta: Infinity, etiqueta: 'Más de 1 día' },
]

const LADOS = { largo: 'Largo', corto: 'Corto', ambos: 'Largo y corto' }

const porNumero = (a, b) => a.clave - b.clave
const porTamano = (a, b) => b.n - a.n

// Las tablas de la pestaña. `soloSin` esconde la que no aporta con el filtro puesto (por
// año, con un año elegido, sale una sola fila).
export const DESGLOSES = [
  {
    id: 'franja', titulo: 'Por franja horaria', columna: 'Entrada',
    nota: 'Hora de Madrid a la que entraste, en tramos de media hora.',
    clave: u => { const f = fechaDe(u.openTime); return Math.floor((f.getUTCHours() * 60 + f.getUTCMinutes()) / 30) * 30 },
    etiqueta: m => `${hhmm(m)}–${hhmm(m + 30)}`,
    orden: porNumero,
  },
  {
    id: 'dia', titulo: 'Por día de la semana', columna: 'Día',
    clave: u => (fechaDe(u.openTime).getUTCDay() + 6) % 7,
    etiqueta: d => DIAS[d],
    orden: porNumero,
  },
  {
    id: 'instrumento', titulo: 'Por instrumento', columna: 'Instrumento', soloSin: 'instrumento',
    clave: u => u.producto,
    orden: porTamano,
  },
  {
    id: 'categoria', titulo: 'Por error del Book of Horror', columna: 'Categoría',
    nota: 'Una sesión con varias etiquetas cuenta en cada una. Las etiquetas son por día e instrumento.',
    clave: u => (u.cats.size ? [...u.cats] : [0]),
    etiqueta: n => (n === 0 ? 'Sin etiqueta' : `#${n} ${CATEGORIAS_HORROR[n - 1]?.corto ?? ''}`),
    // las categorías por número y "sin etiqueta" al final, como referencia
    orden: (a, b) => (a.clave === 0) - (b.clave === 0) || a.clave - b.clave,
  },
  {
    id: 'duracion', titulo: 'Por tiempo abierta', columna: 'Duración',
    clave: u => DURACIONES.findIndex(d => u.closeTime - u.openTime < d.hasta),
    etiqueta: i => DURACIONES[i].etiqueta,
    orden: porNumero,
  },
  {
    id: 'lado', titulo: 'Por lado', columna: 'Lado',
    clave: u => u.lado,
    etiqueta: l => LADOS[l] ?? l,
    orden: porTamano,
  },
  {
    id: 'anio', titulo: 'Por año', columna: 'Año', soloSin: 'anio',
    clave: u => fechaDe(u.openTime).getUTCFullYear(),
    orden: porNumero,
  },
]

// ── MFE / MAE ──
// Los resultados los calcula el servidor (server/excursiones.js) y van por operación: no
// tiene sentido sumar la excursión de varias piernas. Los puntos de un instrumento no se
// pueden mezclar con los de otro, así que todo va agrupado por instrumento salvo la
// eficiencia de salida, que es un porcentaje.
const excursionDe = (t, resultados) => {
  const r = resultados?.[claveDeExcursion(t)]
  return r && !r.sinDatos && Number.isFinite(r.mfe) ? r : null
}

// Qué parte del movimiento a favor te llevaste en las ganadoras: realizado / MFE
const eficiencias = rs => rs.filter(r => r.realizado > 0 && r.mfe > 0).map(r => r.realizado / r.mfe * 100)

export function excursionesPorInstrumento(trades, resultados) {
  const grupos = new Map()
  for (const t of trades) {
    const r = excursionDe(t, resultados)
    if (!r) continue
    if (!grupos.has(t.producto)) grupos.set(t.producto, [])
    grupos.get(t.producto).push(r)
  }
  return [...grupos.entries()].map(([producto, rs]) => {
    const ganadoras  = rs.filter(r => r.realizado > 0)
    const perdedoras = rs.filter(r => r.realizado < 0)
    return {
      producto,
      n:           rs.length,
      mfeMediano:  mediana(rs.map(r => r.mfe)),
      maeMediano:  mediana(rs.map(r => r.mae)),
      eficiencia:  media(eficiencias(rs)),
      // el MAE es negativo: el percentil 10 es la cota que no pasó el 90% de las ganadoras
      maeGanadorasP90: percentil(ganadoras.map(r => r.mae), 0.1),
      // perdedoras que llegaron a ir ganando al menos lo que acabaron perdiendo
      perdedorasQueIbanGanando: perdedoras.length
        ? perdedoras.filter(r => r.mfe >= -r.realizado).length / perdedoras.length * 100
        : null,
      poca: rs.length < MIN_MUESTRA,
    }
  }).sort((a, b) => b.n - a.n)
}

export function eficienciaDeSalida(trades, resultados) {
  const rs = trades.map(t => excursionDe(t, resultados)).filter(Boolean)
  return { medidas: rs.length, eficiencia: media(eficiencias(rs)) }
}
