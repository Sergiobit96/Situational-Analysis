// Cuentas de las pestañas de los bots (Bot.jsx, BotTortugas.jsx) que alimentan sus gráficos.
// Van aparte de los componentes (botVisual.jsx) porque un archivo de componentes solo debe
// exportar componentes (recarga en caliente de Vite), y así se prueban sin React.

export const dir = lado => (lado === 'largo' ? 1 : -1)

// ── Bot SRS ──

// Las piernas de una sesión: la primera y, si dio la vuelta, la segunda
export const piernasDe = d => [...(d.anteriores ?? []), ...(d.operacion ? [d.operacion] : [])]

// Lo que va ganando ahora lo que sigue abierto de una sesión del SRS (en €, con el último
// precio) y lo que dejaría si saltara el stop. null si no hay nada abierto o falta el precio.
export function abiertoSrs(d) {
  const op = d.operacion
  if (!op || op.salida || !d.plan) return { abierto: null, alStop: null }
  const vivas = (op.unidades ?? []).filter(u => !u.salida)
  if (!vivas.length) return { abierto: null, alStop: null }
  const enEur = pts => pts * d.plan.valorPunto * (d.plan.cambioAEur ?? 1)
  const suma = nivel => enEur(vivas.reduce((s, u) => s + u.tamano * dir(op.lado) * (nivel - u.entrada), 0))
  return {
    abierto: Number.isFinite(d.precio) ? suma(d.precio) : null,
    alStop: Number.isFinite(op.stop) ? suma(op.stop) : null,
  }
}

// Dónde entraría el siguiente añadido de la pirámide: como nivelAnadido de server/bot-srs.js,
// n veces `piramide` R a favor del nivel de la orden de entrada (R, el riesgo inicial de la
// pierna; n, las posiciones abiertas). Con la de las tortugas (First bar negative), `piramide`
// N desde la última posición, como nivelAnadidoN. null si no hay pirámide o ya está llena.
export function siguienteAnadidoSrs(d, maxUnidades) {
  const op = d.operacion
  const paso = d.config?.piramide
  if (!op || op.salida || op.sinAnadidos || !paso || !(op.riesgo > 0)) return null
  const n = op.unidades?.length ?? 1
  if (n >= maxUnidades) return null
  if (d.config.piramideN) return d.n > 0 ? (op.unidades?.at(-1)?.entrada ?? op.entrada) + dir(op.lado) * paso * d.n : null
  return (op.nivelOrden ?? op.entrada) + dir(op.lado) * n * paso * op.riesgo
}

// ── Bot Tortugas ──

// La ruptura más cercana de un mercado, en N: para cada sistema que se juega y cada lado que
// se opera, lo que le falta al precio para llegar a su nivel de entrada. Con una posición
// abierta en un sistema, cuenta lo que le falta para su stop. { n, texto } o null sin datos.
export function rupturaMasCercana(m, config) {
  const plan = m.plan
  if (!plan || plan.error || !Number.isFinite(m.precio) || !(plan.n > 0)) return null
  const opciones = []
  for (const s of config.sistemas) {
    const sp = plan.sistemas?.[s]
    if (!sp) continue
    const pos = m.posiciones?.[s]
    if (pos) {
      if (Number.isFinite(pos.stop)) opciones.push({ n: dir(pos.lado) * (m.precio - pos.stop) / plan.n, texto: `del stop (S${s})` })
      continue
    }
    if (config.lados !== 'cortos') opciones.push({ n: (sp.entrada.largo.nivel - m.precio) / plan.n, texto: `de comprar (S${s})` })
    if (config.lados !== 'largos') opciones.push({ n: (m.precio - sp.entrada.corto.nivel) / plan.n, texto: `de vender (S${s})` })
  }
  if (!opciones.length) return null
  return opciones.reduce((a, b) => (b.n < a.n ? b : a))
}

// ── Para las curvas de resultados ──

// Resultados en orden de fecha → puntos con el acumulado
export function acumulado(filas) {
  let total = 0
  return filas.map(f => ({ ...f, acumulado: (total += f.valor) }))
}

// ── Real frente al backtest (pestaña Bot) ──

const mediaDe = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const medianaDe = xs => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
// La media entre su error típico: por debajo de −2, es más de lo que explica el azar (con 5 o más)
function zDe(xs) {
  if (xs.length < 5) return null
  const m = mediaDe(xs)
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
  return sd > 0 ? m / (sd / Math.sqrt(xs.length)) : null
}

// Por instrumento (y en total): el deslizamiento de cada entrada y añadido (en puntos y en % del
// bracket; positivo es pagar de más) y lo que hizo el bot frente a lo que habría hecho el backtest
// en las mismas sesiones, con la diferencia también en R (puntos entre el bracket) para poder
// juntar instrumentos. Una sesión que el bot no operó y el backtest sí cuenta como 0 del bot:
// eso también es ejecución (una noticia, un corte, el tope de riesgo).
export function realFrenteABacktest(historial) {
  const filas = new Map()
  const fila = t => {
    if (!filas.has(t)) filas.set(t, { ticker: t, desl: [], deslPct: [], difs: [], difsR: [], real: 0, backtest: 0 })
    return filas.get(t)
  }
  for (const d of historial) {
    const f = fila(d.ticker)
    for (const p of piernasDe(d)) {
      for (const u of p.unidades ?? [p]) {
        if (u.deslizamiento == null) continue
        f.desl.push(u.deslizamiento)
        if (d.bracket?.rango > 0) f.deslPct.push(100 * u.deslizamiento / d.bracket.rango)
      }
    }
    const bt = d.backtest
    if (!bt?.valido || (d.resultadoPts == null && bt.resultadoPts == null)) continue
    const dif = (d.resultadoPts ?? 0) - (bt.resultadoPts ?? 0)
    f.real += d.resultadoPts ?? 0
    f.backtest += bt.resultadoPts ?? 0
    f.difs.push(dif)
    if (d.bracket?.rango > 0) f.difsR.push(dif / d.bracket.rango)
  }
  const cerrar = f => ({
    ticker: f.ticker,
    entradas: f.desl.length,
    deslMedio: mediaDe(f.desl), deslMediana: medianaDe(f.desl), deslPctMedio: mediaDe(f.deslPct),
    sesiones: f.difs.length, real: f.real, backtest: f.backtest,
    difMedia: mediaDe(f.difs), difMediaR: mediaDe(f.difsR), z: zDe(f.difsR),
  })
  const todas = [...filas.values()]
  // en total, solo lo que se puede juntar entre instrumentos: los % del bracket y las R
  const difsR = todas.flatMap(f => f.difsR)
  const total = {
    entradas: todas.reduce((n, f) => n + f.desl.length, 0),
    deslPctMedio: mediaDe(todas.flatMap(f => f.deslPct)),
    sesiones: todas.reduce((n, f) => n + f.difs.length, 0),
    difMediaR: mediaDe(difsR), z: zDe(difsR),
  }
  return { filas: todas.map(cerrar).filter(f => f.entradas || f.sesiones), total }
}
