// ── Cierres anticipados de los índices de EE. UU. en IG ─────────────────────────────────
// Los CFD de IG sobre el Nasdaq, el S&P, el Dow y el Russell siguen a los futuros del CME. En
// los festivos de la bolsa de Nueva York en que el CME abre (Martin Luther King, Presidentes,
// Memorial Day, Juneteenth, 4 de julio, Labor Day y Acción de Gracias) y en las vísperas en
// que la bolsa cierra a mediodía (3 de julio, el viernes después de Acción de Gracias y
// Nochebuena), IG deja de cotizar a las 13:00 de Nueva York (las 19:00 de Madrid casi siempre)
// y a partir de ahí rechaza las órdenes con MARKET_OFFLINE. El 26-nov-2026 el bot quiso cerrar a
// las 16:00 de siempre y no pudo: sus posiciones se quedaron abiertas hasta el día siguiente.
// Año Nuevo, Viernes Santo y Navidad no están: esos días no hay cotización ni vela del bracket,
// y el bot ya no opera.
//
// Las fechas salen de las reglas de cada festivo, no de una lista: no hay que tenerla al día.

// Hora a la que el bot cierra esos días, en minutos desde medianoche de Nueva York: unos minutos
// antes de que IG pare, para que haya tiempo de reintentar si rechaza la primera orden
export const CIERRE_ANTICIPADO_NY = 12 * 60 + 50

const fechaUTC = (a, m, d) => new Date(Date.UTC(a, m - 1, d))
const iso = f => f.toISOString().slice(0, 10)
const masDias = (f, n) => new Date(f.getTime() + n * 86_400_000)

// El `n`-ésimo `dow` (0 domingo … 6 sábado) del mes; n = -1, el último
function enesimo(a, m, dow, n) {
  if (n > 0) {
    const primero = fechaUTC(a, m, 1)
    return masDias(primero, (dow - primero.getUTCDay() + 7) % 7 + (n - 1) * 7)
  }
  const ultimo = fechaUTC(a, m + 1, 0)
  return masDias(ultimo, -((ultimo.getUTCDay() - dow + 7) % 7))
}

// Un festivo de fecha fija que cae en sábado se pasa al viernes; en domingo, al lunes
function observado(f) {
  const dow = f.getUTCDay()
  return dow === 6 ? masDias(f, -1) : dow === 0 ? masDias(f, 1) : f
}

const porAno = new Map()
function cierresDe(a) {
  if (porAno.has(a)) return porAno.get(a)
  const accionDeGracias = enesimo(a, 11, 4, 4)
  const festivos = [
    enesimo(a, 1, 1, 3),               // Martin Luther King: tercer lunes de enero
    enesimo(a, 2, 1, 3),               // Presidentes: tercer lunes de febrero
    enesimo(a, 5, 1, -1),              // Memorial Day: último lunes de mayo
    observado(fechaUTC(a, 6, 19)),     // Juneteenth
    observado(fechaUTC(a, 7, 4)),      // Independencia
    enesimo(a, 9, 1, 1),               // Labor Day: primer lunes de septiembre
    accionDeGracias,                   // cuarto jueves de noviembre
  ]
  const vispera = [
    fechaUTC(a, 7, 3),                 // víspera de la Independencia
    masDias(accionDeGracias, 1),       // el viernes siguiente
    fechaUTC(a, 12, 24),               // Nochebuena
  ]
  const festivoDia = new Set(festivos.map(iso))
  // una víspera en fin de semana no cuenta, ni la que es ella misma el festivo observado
  // (el 3 de julio, si el 4 cae en sábado; Nochebuena, si Navidad cae en sábado)
  const navidad = iso(observado(fechaUTC(a, 12, 25)))
  const validas = vispera.filter(f => ![0, 6].includes(f.getUTCDay()) && !festivoDia.has(iso(f)) && iso(f) !== navidad)
  const fechas = new Set([...festivoDia, ...validas.map(iso)])
  porAno.set(a, fechas)
  return fechas
}

// ¿Cierran antes los índices de EE. UU. en IG la sesión de `fecha` (YYYY-MM-DD, de Nueva York)?
export const cierraAntesNY = fecha => cierresDe(Number(fecha.slice(0, 4))).has(fecha)
