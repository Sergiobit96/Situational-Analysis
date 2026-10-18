// ── Velas para la pestaña Gráfico ──────────────────────────────────────────────
// Agrupa a cualquier temporalidad y recorta por páginas. Va aparte de index.js para poder
// probarlo sin levantar el servidor (test/velasGrafico.test.js).

// Temporalidades del gráfico: minutos por vela, la serie de Dukascopy de la que salen y
// cuántos días se piden por página. La página va por días y no por número de velas
// porque el feed se descarga por ficheros de día (de mes en la horaria, de año en la
// diaria): así cada página son unos pocos ficheros y no decenas. La de 4 h y la diaria se
// agrupan aquí desde la horaria: las del feed van cortadas en horas UTC, y la diaria de
// Dukascopy además empieza el día la tarde anterior, con lo que sacaba una vela por domingo.
export const TEMPORALIDADES = {
  m1:  { minutos: 1,    duka: 'm1',  diasPagina: 2 },
  m5:  { minutos: 5,    duka: 'm5',  diasPagina: 4 },
  m15: { minutos: 15,   duka: 'm15', diasPagina: 7 },
  m30: { minutos: 30,   duka: 'm30', diasPagina: 14 },
  h1:  { minutos: 60,   duka: 'h1',  diasPagina: 60 },
  h4:  { minutos: 240,  duka: 'h1',  diasPagina: 240 },
  d1:  { minutos: 1440, duka: 'h1',  diasPagina: 365 },
}

// Offset de Madrid en segundos para un instante UTC, memorizado por hora UTC (los cambios
// de horario caen siempre en hora en punto). Es la misma idea que src/timezone.js, que no
// se puede importar desde aquí porque el servidor se despliega solo con su carpeta.
const fmtMadrid = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Madrid', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})
const memoOffset = new Map()

export function offsetMadrid(ts) {
  const hora = Math.floor(ts / 3600)
  const visto = memoOffset.get(hora)
  if (visto !== undefined) return visto

  const p = {}
  for (const { type, value } of fmtMadrid.formatToParts(hora * 3600 * 1000)) p[type] = value
  // con hour12:false la medianoche sale como 24 en algunos motores
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000
  const off   = local - hora * 3600

  if (memoOffset.size >= 200_000) memoOffset.clear()
  memoOffset.set(hora, off)
  return off
}

// Medianoche de Madrid (en epoch UTC) del día en que cae `ts`. Las páginas se cortan ahí
// para que una vela de 4 h o diaria no quede partida entre dos páginas.
export function inicioDiaMadrid(ts) {
  const local      = ts + offsetMadrid(ts)
  const medianoche = Math.floor(local / 86400) * 86400
  const aprox      = medianoche - offsetMadrid(ts)
  return medianoche - offsetMadrid(aprox)
}

// Agrupa velas ordenadas en cubos de `minutos` contados en hora de Madrid desde `ancla`
// (minutos desde medianoche). Con 1440 son días naturales de Madrid y la vela lleva la
// hora de la medianoche. El ancla es la apertura de la sesión cuando los datos solo cubren
// la sesión (el CSV del DAX): así la de 4 h arranca a las 09:00, como en TradingView.
//
// El cubo sale del minuto local absoluto y no de la hora del día, para que un cubo que
// cruza la medianoche no se parta en dos con la misma hora. Y cuando el reloj se atrasa
// en octubre, la hora que se repite cae en el mismo cubo que la anterior y se suma a ella.
export function agruparVelas(velas, minutos, ancla = 0) {
  const out = []
  let actual = null
  let claveActual = null
  for (const v of velas) {
    const off      = offsetMadrid(v.time)
    const minLocal = Math.floor((v.time + off) / 60)
    const clave    = Math.floor((minLocal - ancla) / minutos)
    if (clave !== claveActual) {
      claveActual = clave
      const inicioLocal = (clave * minutos + ancla) * 60
      actual = { time: inicioLocal - off, open: v.open, high: v.high, low: v.low, close: v.close }
      out.push(actual)
    } else {
      if (v.high > actual.high) actual.high = v.high
      if (v.low  < actual.low)  actual.low  = v.low
      actual.close = v.close
    }
  }
  return out
}

// Como agruparVelas, pero cada día se ancla en su primera vela en vez de en una hora fija.
// Es lo que hace falta con Yahoo: el contado americano abre a y media, así que sus velas
// horarias son 15:30, 16:30… y con un ancla fija en la hora en punto saldrían rotuladas
// media hora antes. Y la apertura en hora de Madrid se mueve las semanas en que Europa y
// Estados Unidos no han cambiado aún de horario a la vez, así que tampoco vale un ancla
// fija en las 15:30. Anclar en la primera vela del día cubre los dos casos, y en lo que
// cotiza 24 h esa vela es la de medianoche, que es lo mismo que el ancla 0.
export function agruparPorSesion(velas, minutos) {
  const out = []
  let actual = null
  let claveActual = null
  let dia = null
  let ancla = 0
  for (const v of velas) {
    const off   = offsetMadrid(v.time)
    const local = Math.floor((v.time + off) / 60)
    const d     = Math.floor(local / 1440)
    if (d !== dia) { dia = d; ancla = local - d * 1440 }
    const clave = `${d}|${Math.floor((local - d * 1440 - ancla) / minutos)}`
    if (clave !== claveActual) {
      claveActual = clave
      const inicioLocal = (local - ((local - d * 1440 - ancla) % minutos)) * 60
      actual = { time: inicioLocal - off, open: v.open, high: v.high, low: v.low, close: v.close }
      out.push(actual)
    } else {
      if (v.high > actual.high) actual.high = v.high
      if (v.low  < actual.low)  actual.low  = v.low
      actual.close = v.close
    }
  }
  return out
}

// ── Yahoo como fuente del gráfico ──
// Intervalo de Yahoo para cada temporalidad, días por página y hasta dónde llega: Yahoo
// rechaza la petición entera si empieza antes de su límite ("must be within the last 60
// days"), así que la última página se recorta ahí. Se deja un día de margen en cada límite.
// La de 1 min, además, no admite más de 8 días por petición.
export const YAHOO = {
  m1:  { intervalo: '1m',  diasPagina: 5,    diasMax: 29,       aviso: 'Yahoo solo guarda 30 días a 1 min' },
  m5:  { intervalo: '5m',  diasPagina: 10,   diasMax: 59,       aviso: 'Yahoo solo guarda 60 días por debajo de 1 h' },
  m15: { intervalo: '15m', diasPagina: 20,   diasMax: 59,       aviso: 'Yahoo solo guarda 60 días por debajo de 1 h' },
  m30: { intervalo: '30m', diasPagina: 30,   diasMax: 59,       aviso: 'Yahoo solo guarda 60 días por debajo de 1 h' },
  h1:  { intervalo: '60m', diasPagina: 120,  diasMax: 729,      aviso: 'Yahoo solo guarda 2 años en velas horarias' },
  h4:  { intervalo: '60m', diasPagina: 240,  diasMax: 729,      aviso: 'Yahoo solo guarda 2 años en velas horarias' },
  d1:  { intervalo: '1d',  diasPagina: 3650, diasMax: Infinity, aviso: null },
}

// La ventana de Yahoo que termina en `hasta`, cortada en la medianoche de Madrid como las
// de Dukascopy, o null si `hasta` ya está más allá del límite del intervalo
export function ventanaYahoo(tf, hasta, ahora) {
  const c = YAHOO[tf]
  const limite = ahora - c.diasMax * 86400
  if (hasta <= limite) return null
  const desde = inicioDiaMadrid(hasta - c.diasPagina * 86400)
  return desde <= limite
    ? { intervalo: c.intervalo, desde: limite, hasta, alLimite: true,  aviso: c.aviso }
    : { intervalo: c.intervalo, desde,         hasta, alLimite: false, aviso: null }
}

// Las `limite` velas anteriores a `hasta` (excluida) de una serie ordenada
export function paginaAnteriorA(velas, hasta, limite) {
  let lo = 0, hi = velas.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (velas[mid].time < hasta) lo = mid + 1
    else hi = mid
  }
  const desde = Math.max(0, lo - limite)
  return { velas: velas.slice(desde, lo), hayMas: desde > 0 }
}
