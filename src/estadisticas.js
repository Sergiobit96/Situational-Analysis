// ── Estadísticas de las operaciones reales ────────────────────────────────────
// Lo que se lee de tu propio historial: cuánto aciertas, cuánto ganas cuando aciertas
// frente a lo que pierdes cuando no, y en qué franjas, días, instrumentos y errores del
// Book of Horror se va el dinero. Va aparte de la pestaña para poder probarlo con el runner
// de Node (test/estadisticas.test.js).
import { fmtFechaTS, fmtHoraTS, pnlDeTrade, valorDelPunto, PRODUCTO_A_INSTRUMENTO, CATEGORIAS_HORROR } from './parseTrades.js'
import { curvaEquity } from './equity.js'

// Por debajo de esto un grupo se enseña apagado: con tres operaciones un 100% de acierto
// no dice nada, y no debe poder colarse arriba de la tabla como si fuera lo mejor
export const MIN_MUESTRA = 10

// La misma regla que server/excursiones.js (el servidor se despliega solo con su carpeta y
// no puede importar de aquí): el diario dice LONG/SHORT y el historial de la cuenta Buy/Sell.
// Si no dice nada (las del historial guardadas antes de leer el lado del Amount), el
// tamaño va en negativo en las ventas; y si tampoco hay tamaño, el signo del resultado
// frente al del precio.
export function ladoDe(t) {
  const d = String(t.direccion ?? '').toUpperCase()
  if (d === 'LONG' || d === 'BUY') return 'largo'
  if (d === 'SHORT' || d === 'SELL') return 'corto'
  if (Number.isFinite(t.size) && t.size !== 0) return t.size > 0 ? 'largo' : 'corto'
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
      ticker:    t.ticker,
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

export const DIAS_SEMANA = DIAS

// ── Simulador de reglas ──
// Vuelve a pasar tus operaciones reales con unas reglas que no seguiste, para ver qué habría
// cambiado. Solo quita operaciones o recorta su pérdida; no inventa ninguna: lo que la regla
// deja fuera no se sustituye por otra cosa. Las reglas en €, o en puntos si `medida` lo es.
//   · stopDiario / objetivoDiario: no abrir nada más ese día cuando lo ya cerrado llega ahí;
//   · maxOperaciones: no abrir más de N al día;
//   · stopFijo (puntos): la operación cuyo MAE llegó a −stopFijo habría salido en −stopFijo;
//   · diasFuera (0 = lunes … 6 = domingo) y desde/hasta ('HH:MM', hora de Madrid de la entrada).
export const REGLAS_SIN = {
  stopDiario: 0, objetivoDiario: 0, maxOperaciones: 0, stopFijo: 0, diasFuera: [], desde: '', hasta: '',
}

const minutoDelDia = ts => { const f = fechaDe(ts); return f.getUTCHours() * 60 + f.getUTCMinutes() }
const aMinutos = texto => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(texto ?? '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

export function simular(trades, reglas = REGLAS_SIN, { medida = 'eur', resultados = {} } = {}) {
  const r = { ...REGLAS_SIN, ...reglas }
  const diasFuera = new Set(r.diasFuera)
  const desde = aMinutos(r.desde)
  const hasta = aMinutos(r.hasta)

  const porDia = new Map()
  for (const t of trades) {
    const valor = medida === 'puntos' ? t.puntos : pnlDeTrade(t)
    if (!Number.isFinite(valor)) continue
    const fecha = fmtFechaTS(t.openTime)
    if (!porDia.has(fecha)) porDia.set(fecha, [])
    porDia.get(fecha).push({ t, valor })
  }

  const real = [], simulado = []
  const quitadas = { dia: 0, franja: 0, maximo: 0, stopDiario: 0, objetivo: 0 }
  const diasCortados = new Set()
  let recortadas = 0, sinMae = 0

  for (const [fecha, ops] of porDia) {
    ops.sort((a, b) => a.t.openTime - b.t.openTime)
    const tomadas = []
    // Una vez tocado el stop o el objetivo del día, el resto del día queda fuera, aunque luego
    // una que seguía abierta cierre en positivo y lo cerrado vuelva a quedar por encima
    let parada = null
    for (const { t, valor } of ops) {
      const u = { producto: t.producto, ticker: t.ticker, fecha, openTime: t.openTime, closeTime: t.closeTime, valor }
      real.push(u)

      if (diasFuera.has((fechaDe(t.openTime).getUTCDay() + 6) % 7)) { quitadas.dia++; continue }
      const minuto = minutoDelDia(t.openTime)
      if ((desde != null && minuto < desde) || (hasta != null && minuto >= hasta)) { quitadas.franja++; continue }
      if (r.maxOperaciones > 0 && tomadas.length >= r.maxOperaciones) {
        quitadas.maximo++; diasCortados.add(fecha); continue
      }
      if (!parada) {
        // lo ya cerrado cuando se abre esta: las que siguen abiertas todavía no cuentan
        const cerrado = tomadas.reduce((s, x) => (x.closeTime <= t.openTime ? s + x.valor : s), 0)
        if (r.stopDiario > 0 && cerrado <= -r.stopDiario) parada = 'stopDiario'
        else if (r.objetivoDiario > 0 && cerrado >= r.objetivoDiario) parada = 'objetivo'
      }
      if (parada) { quitadas[parada]++; diasCortados.add(fecha); continue }

      let v = valor
      if (r.stopFijo > 0) {
        const e = excursionDe(t, resultados)
        if (!e) sinMae++
        else if (e.mae <= -r.stopFijo) {
          v = -r.stopFijo * (medida === 'puntos' ? 1 : valorDelPunto(t))
          recortadas++
        }
      }
      const tomada = { ...u, valor: v }
      tomadas.push(tomada)
      simulado.push(tomada)
    }
  }
  return { real, simulado, quitadas, recortadas, sinMae, diasCortados: diasCortados.size }
}

// Lo que se compara de un lado y otro: el resumen, el peor día y el peor drawdown día a día
export function cifrasDe(unidades) {
  const porDia = new Map()
  for (const u of unidades) porDia.set(u.fecha, (porDia.get(u.fecha) ?? 0) + u.valor)
  const curva = curvaEquity([...porDia.entries()].map(([date, pts]) => ({ date, pts })))
  return { ...resumen(unidades), peorDia: porDia.size ? Math.min(...porDia.values()) : null, maxDD: curva.maxDD }
}

// Real frente a simulado año a año: una regla elegida mirando el pasado sale bien en el
// total casi por construcción; lo que dice algo es si ayuda en todos los años o en uno solo
export function porAnio(real, simulado) {
  const anios = new Map()
  const sumar = (lista, campo) => {
    for (const u of lista) {
      const a = fechaDe(u.openTime).getUTCFullYear()
      if (!anios.has(a)) anios.set(a, { anio: a, real: 0, simulado: 0 })
      anios.get(a)[campo] += u.valor
    }
  }
  sumar(real, 'real')
  sumar(simulado, 'simulado')
  return [...anios.values()].sort((a, b) => a.anio - b.anio)
}

// ── Contexto de mercado de cada sesión ──
// Con las sesiones que da /api/gap-filter, una por día y por instrumento: gap de apertura,
// máximo y mínimo del día anterior y eventos del calendario. Devuelve fecha → contexto.
export function contextoDeSesiones(sesiones) {
  const mapa = new Map()
  const rangos = []   // el rango de cada "ayer", en orden
  for (const s of [...(sesiones ?? [])].sort((a, b) => a.date.localeCompare(b.date))) {
    const rango = s.prevHigh - s.prevLow
    const previos = rangos.slice(-20)
    // con menos de 10 días detrás la media de comparación no es fiable
    const mediaPrevia = previos.length >= 10 ? suma(previos) / previos.length : null
    mapa.set(s.date, {
      gapPct:   s.gapPct,
      apertura: s.openPrice > s.prevHigh ? 'encima' : s.openPrice < s.prevLow ? 'debajo' : 'dentro',
      rangoRel: mediaPrevia ? rango / mediaPrevia : null,
      eventos:  s.eventos ?? [],
    })
    if (Number.isFinite(rango)) rangos.push(rango)
  }
  return mapa
}

const GAPS = [
  { hasta: 0.25,     etiqueta: 'Menos de 0,25%' },
  { hasta: 0.5,      etiqueta: '0,25 a 0,5%' },
  { hasta: 1,        etiqueta: '0,5 a 1%' },
  { hasta: Infinity, etiqueta: 'Más de 1%' },
]
const APERTURAS = {
  encima: 'Abre por encima del máximo de ayer',
  dentro: 'Abre dentro del rango de ayer',
  debajo: 'Abre por debajo del mínimo de ayer',
}
const VOLATILIDAD = ['Ayer estrecho (menos de 0,8×)', 'Ayer normal', 'Ayer amplio (más de 1,25×)']
const EVENTOS = {
  FOMC: 'Fed (FOMC)', CPI: 'IPC', NFP: 'Empleo de EE. UU. (NFP)', ECB: 'BCE',
  PPI: 'Precios de producción', GDP: 'PIB', PMI: 'PMI', FESTIVO: 'Tras un festivo', ninguno: 'Día sin evento',
}

// Las tablas de contexto. `contextoDe(u)` da el contexto del instrumento ese día, o null si
// no lo hay (divisas y demás del historial no tienen diarias en la app).
export function desglosesDeContexto(contextoDe) {
  const ctx = u => contextoDe(u) ?? null
  return [
    {
      id: 'gap', titulo: 'Por gap de apertura', columna: 'Gap',
      nota: 'Del instrumento ese día: apertura frente al cierre anterior, sin el signo.',
      clave: u => { const c = ctx(u); return c ? GAPS.findIndex(g => Math.abs(c.gapPct) < g.hasta) : null },
      etiqueta: i => GAPS[i].etiqueta,
      orden: porNumero,
    },
    {
      id: 'conGap', titulo: 'Tu lado frente al gap', columna: 'Lado',
      nota: 'A favor: largo con gap al alza o corto con gap a la baja. Sin los gaps de menos de 0,1%.',
      clave: u => {
        const c = ctx(u)
        if (!c || (u.lado !== 'largo' && u.lado !== 'corto') || Math.abs(c.gapPct) < 0.1) return null
        return (u.lado === 'largo') === (c.gapPct > 0) ? 'favor' : 'contra'
      },
      etiqueta: k => (k === 'favor' ? 'A favor del gap' : 'Contra el gap'),
      orden: porTamano,
    },
    {
      id: 'apertura', titulo: 'Apertura frente al rango de ayer', columna: 'Apertura',
      clave: u => ctx(u)?.apertura ?? null,
      etiqueta: k => APERTURAS[k],
      orden: (a, b) => Object.keys(APERTURAS).indexOf(a.clave) - Object.keys(APERTURAS).indexOf(b.clave),
    },
    {
      id: 'volatilidad', titulo: 'Por volatilidad del día anterior', columna: 'Día anterior',
      nota: 'El rango de ayer frente a la media de los 20 días de antes.',
      clave: u => {
        const rel = ctx(u)?.rangoRel
        return rel == null ? null : rel < 0.8 ? 0 : rel <= 1.25 ? 1 : 2
      },
      etiqueta: i => VOLATILIDAD[i],
      orden: porNumero,
    },
    {
      id: 'evento', titulo: 'Por evento del día', columna: 'Evento',
      nota: 'El calendario de la app tiene Fed, IPC y BCE hasta 2025; de 2026 solo el NFP y las últimas semanas de ForexFactory.',
      clave: u => { const c = ctx(u); return c ? (c.eventos.length ? c.eventos : ['ninguno']) : null },
      etiqueta: k => EVENTOS[k] ?? k,
      // "sin evento" al final, como referencia
      orden: (a, b) => (a.clave === 'ninguno') - (b.clave === 'ninguno') || b.n - a.n,
    },
  ]
}

// ── Expediente de un día para la revisión con Claude ──
// Todo lo que hace falta para juzgar el día frente a lo habitual, con los números ya
// redondeados para que el texto que se manda sea corto.
const r2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null)

const resumenCorto = r => ({
  operaciones: r.n,
  aciertoPct: r2(r.acierto),
  resultadoEur: r2(r.total),
  esperanzaEur: r2(r.media),
  profitFactor: r.profitFactor === Infinity ? 'sin pérdidas' : r2(r.profitFactor),
})

export function expedienteDelDia(fecha, trades, { anotaciones = {}, resultados = {} } = {}) {
  const esDelDia = t => fmtFechaTS(t.openTime) === fecha
  const delDia = trades.filter(esDelDia).sort((a, b) => a.openTime - b.openTime)
  const resto  = trades.filter(t => !esDelDia(t))

  const operaciones = delDia.map(t => {
    const e = excursionDe(t, resultados)
    const otroDia = fmtFechaTS(t.closeTime) !== fecha
    return {
      instrumento: t.producto,
      lado: ladoDe(t),
      entrada: fmtHoraTS(t.openTime),
      salida: (otroDia ? `${fmtFechaTS(t.closeTime)} ` : '') + fmtHoraTS(t.closeTime),
      minutosAbierta: Math.round((t.closeTime - t.openTime) / 60),
      precioEntrada: t.openPrice,
      precioSalida: t.closePrice,
      tamano: Number.isFinite(t.size) ? Math.abs(t.size) : null,
      puntos: r2(t.puntos),
      euros: r2(pnlDeTrade(t)),
      ...(e ? {
        mfe: e.mfe,
        mae: e.mae,
        eficienciaSalidaPct: e.realizado > 0 && e.mfe > 0 ? Math.round(e.realizado / e.mfe * 100) : null,
        ...(e.fuente === 'yahoo' ? { velasDe: 'Yahoo (menos preciso)' } : {}),
      } : {}),
    }
  })

  // Comentario y errores del Book of Horror de cada instrumento operado ese día
  const productos = [...new Set(delDia.map(t => t.producto))]
  const notas = []
  for (const producto of productos) {
    const t = delDia.find(x => x.producto === producto)
    const a = anotaciones[claveDeSesion(t)]
    const cats = categoriasDe(t, anotaciones)
    if (a?.texto || cats.size) {
      notas.push({
        instrumento: producto,
        comentario: a?.texto || null,
        erroresBookOfHorror: [...cats].map(n => CATEGORIAS_HORROR[n - 1]?.nombre).filter(Boolean),
      })
    }
  }

  // Lo habitual: todo el historial menos ese día, y por instrumento solo los del día
  const opsPorDia = new Map()
  for (const t of resto) {
    const f = fmtFechaTS(t.openTime)
    opsPorDia.set(f, (opsPorDia.get(f) ?? 0) + 1)
  }
  const general = resumen(unidadesDe(resto))
  const excursionesHabituales = excursionesPorInstrumento(resto, resultados)
  const porInstrumento = {}
  for (const producto of productos) {
    const x = excursionesHabituales.find(f => f.producto === producto)
    porInstrumento[producto] = {
      ...resumenCorto(resumen(unidadesDe(resto.filter(t => t.producto === producto)))),
      ...(x ? {
        mfeMediano: r2(x.mfeMediano),
        maeMediano: r2(x.maeMediano),
        eficienciaSalidaPct: r2(x.eficiencia),
        maeDel90PorCientoDeGanadoras: r2(x.maeGanadorasP90),
      } : {}),
    }
  }

  return {
    fecha,
    diaSemana: DIAS[(fechaDe(Date.parse(`${fecha}T12:00:00Z`) / 1000).getUTCDay() + 6) % 7],
    horas: 'hora de Madrid',
    operaciones,
    anotaciones: notas,
    resumenDelDia: resumenCorto(resumen(unidadesDe(delDia))),
    habitual: {
      ...resumenCorto(general),
      diasOperados: opsPorDia.size,
      operacionesPorDiaMediana: mediana([...opsPorDia.values()]),
      resultadoMedioPorDiaEur: opsPorDia.size ? r2(general.total / opsPorDia.size) : null,
      porInstrumento,
    },
  }
}
