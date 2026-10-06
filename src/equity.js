// Curva de puntos acumulados de una estrategia y lo que se lee en ella: drawdown en cada
// momento, el peor de todos, cuánto tardó en recuperarse y las rachas.
//
// Trabaja con el resultado de cada sesión en puntos, que es como mide la estrategia. Las
// sesiones llegan de la más reciente a la más antigua, así que aquí se ordenan al revés:
// una curva acumulada solo significa algo de izquierda a derecha en el tiempo.

export function curvaEquity(sesiones) {
  const orden = [...sesiones]
    .filter(s => Number.isFinite(s.pts))
    .sort((a, b) => a.date.localeCompare(b.date))

  const puntos = []          // { date, acumulado, drawdown }
  let acumulado = 0
  let pico      = 0
  let maxDD     = 0
  let picoFecha = orden[0]?.date ?? null
  let peorDD    = { desde: null, hasta: null, profundidad: 0, sesiones: 0 }
  let desdePico = 0

  // rachas seguidas de sesiones ganadoras y perdedoras
  let rachaG = 0, rachaP = 0, mejorRachaG = 0, peorRachaP = 0

  for (const s of orden) {
    acumulado += s.pts
    if (acumulado >= pico) {
      pico      = acumulado
      picoFecha = s.date
      desdePico = 0
    } else {
      desdePico++
    }
    const dd = acumulado - pico          // 0 o negativo
    if (dd < maxDD) {
      maxDD  = dd
      peorDD = { desde: picoFecha, hasta: s.date, profundidad: dd, sesiones: desdePico }
    }
    puntos.push({ date: s.date, acumulado, drawdown: dd })

    if (s.pts > 0)      { rachaG++; rachaP = 0; mejorRachaG = Math.max(mejorRachaG, rachaG) }
    else if (s.pts < 0) { rachaP++; rachaG = 0; peorRachaP  = Math.max(peorRachaP, rachaP) }
  }

  const mejor = orden.reduce((a, b) => (b.pts > (a?.pts ?? -Infinity) ? b : a), null)
  const peor  = orden.reduce((a, b) => (b.pts < (a?.pts ??  Infinity) ? b : a), null)

  // drawdown en el que se acaba la serie (el que seguirías teniendo hoy)
  const actual = puntos.length ? puntos[puntos.length - 1].drawdown : 0

  return {
    puntos,
    total: acumulado,
    maxDD,
    peorDD,
    ddActual: actual,
    // el drawdown relativo solo tiene sentido si hubo beneficio antes de caer
    maxDDPct: pico > 0 ? maxDD / pico * 100 : null,
    mejor, peor,
    mejorRachaG, peorRachaP,
    n: orden.length,
  }
}
