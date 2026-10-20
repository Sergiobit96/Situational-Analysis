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
