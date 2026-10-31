// ── Resumen público de los bots ──────────────────────────────────────────────────────────
// Para la pestaña «Resumen bots», que ve cualquiera sin la clave del bot: si cada bot está
// encendido y dando vueltas, lo que tiene abierto y cómo le ha ido. Sin euros ni saldo (los
// resultados van en % del saldo de ahora de su cuenta), sin referencias ni dealIds, sin
// configuración y sin nada que cambie algo. El servidor lo guarda CACHE_MS: por mucho que se
// pida, a IG y a Alpaca se les pregunta como mucho una vez cada medio minuto.

import { fechaEnZona } from './zonas.js'

const ZONA = 'Europe/Madrid'
const DIA = 86400
const ULTIMAS = 25
export const CACHE_MS = 30_000

// Lo cerrado de un bot, con la hora en segundos y el resultado en la moneda de su cuenta,
// pasado a % de `saldo`, con los totales de hoy, 7 y 30 días y desde el principio
export function resumirCerradas(cerradas, { saldo, t }) {
  const pct = x => (x == null || !(saldo > 0) ? null : 100 * x / saldo)
  const lista = cerradas.filter(c => c.hora != null && c.resultado != null).sort((a, b) => b.hora - a.hora)
  const hoy = fechaEnZona(t, ZONA)
  const suma = xs => (xs.length ? pct(xs.reduce((s, c) => s + c.resultado, 0)) : null)
  const desde = dias => lista.filter(c => c.hora >= t - dias * DIA)
  return {
    totales: {
      hoy: suma(lista.filter(c => fechaEnZona(c.hora, ZONA) === hoy)),
      semana: suma(desde(7)),
      mes: suma(desde(30)),
      total: suma(lista),
      operaciones: lista.length,
      ganadoras: lista.filter(c => c.resultado > 0).length,
    },
    ultimas: lista.slice(0, ULTIMAS).map(c => ({ hora: c.hora, instrumento: c.instrumento, lado: c.lado, nota: c.nota ?? null, pct: pct(c.resultado) })),
  }
}

// Las posiciones abiertas del mismo bot, instrumento y lado, juntas como una sola
export function juntarAbiertas(posiciones, saldo) {
  const grupos = new Map()
  for (const p of posiciones) {
    const k = `${p.bot}|${p.instrumento}|${p.lado}`
    const g = grupos.get(k) ?? { bot: p.bot, instrumento: p.instrumento, lado: p.lado, desde: p.desde, unidades: 0, resultado: 0, sinPrecio: false }
    g.unidades++
    if (p.desde && (!g.desde || p.desde < g.desde)) g.desde = p.desde
    if (p.resultado == null) g.sinPrecio = true
    else g.resultado += p.resultado
    grupos.set(k, g)
  }
  return [...grupos.values()].map(({ resultado, sinPrecio, ...g }) => ({ ...g, pct: sinPrecio || !(saldo > 0) ? null : 100 * resultado / saldo }))
}

// Lo cerrado del SRS y de los que usan su motor (Rule of 4, First bar negative): una sesión por fila
export function cerradasMotorSrs(estado) {
  const nombres = Object.fromEntries((estado.sesiones ?? []).map(s => [s.ticker, s.nombre]))
  return [...(estado.hoy ?? []), ...(estado.historial ?? [])].filter(d => d.resultadoEur != null && d.salida?.hora != null).map(d => {
    const piernas = [...(d.anteriores ?? []), ...(d.operacion ? [d.operacion] : [])]
    const lados = [...new Set(piernas.map(p => p.lado))]
    return { hora: d.salida.hora, instrumento: nombres[d.ticker] ?? d.ticker, lado: lados.length === 1 ? lados[0] : null, nota: lados.length > 1 ? 'con flip' : null, resultado: d.resultadoEur }
  })
}

export function cerradasTortugas(estado) {
  const nombres = Object.fromEntries((estado.mercados ?? []).map(m => [m.ticker, m.nombre]))
  return (estado.operaciones ?? []).map(o => ({ hora: o.cerradaHora, instrumento: nombres[o.ticker] ?? o.ticker, lado: o.lado, nota: `S${o.sistema}`, resultado: o.resultadoEur }))
}

export function cerradasTortugasAcciones(estado) {
  return (estado.operaciones ?? []).map(o => ({ hora: o.cerrada ? Math.floor(Date.parse(o.cerrada) / 1000) : null, instrumento: o.simbolo, lado: o.lado, nota: `S${o.sistema}`, resultado: o.resultado }))
}

// `bots`: [{ nombre, cuenta: 'ig' | 'alpaca', activo(), cerradas() }]; `posicionesIg`: las de la
// cuenta de IG con su bot ya puesto (las que no son de ningún bot no salen); `vigilancia`: su estado
export function resumenPublico({ bots, saldoIg, posicionesIg = [], saldoAlpaca = null, posicionesAlpaca = [], vigilancia, t }) {
  const latidos = Object.fromEntries((vigilancia?.bots ?? []).map(b => [b.nombre, b]))
  const abiertas = [
    ...juntarAbiertas(posicionesIg.filter(p => p.bot), saldoIg),
    ...juntarAbiertas(posicionesAlpaca, saldoAlpaca),
  ]
  return {
    hora: t,
    bots: bots.map(b => {
      const saldo = b.cuenta === 'alpaca' ? saldoAlpaca : saldoIg
      let cerradas = []
      try { cerradas = b.cerradas() } catch { /* un bot roto no tumba el resumen */ }
      const latido = latidos[b.nombre]
      return {
        nombre: b.nombre,
        cuenta: b.cuenta === 'alpaca' ? 'Alpaca (paper)' : 'IG (demo)',
        encendido: !!b.activo(),
        enMarcha: !!latido?.enMarcha,
        parado: !!latido?.parado,
        abiertas: abiertas.filter(a => a.bot === b.nombre).map(({ bot: _bot, ...a }) => a),
        ...resumirCerradas(cerradas, { saldo, t }),
      }
    }),
  }
}

// Guarda el último resumen CACHE_MS; mientras se calcula uno, los que piden esperan a ese mismo
export function crearCacheResumen(calcular, { ahora = Date.now } = {}) {
  let ultimo = null, cuando = 0, enCurso = null
  return async () => {
    if (ultimo && ahora() - cuando < CACHE_MS) return ultimo
    enCurso ??= calcular().then(r => { ultimo = r; cuando = ahora(); return r }).finally(() => { enCurso = null })
    return enCurso
  }
}
