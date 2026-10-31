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
// pasado a % de `saldo`: los totales de hoy, 7 y 30 días y desde el principio, las cifras de
// siempre (media de las ganadoras y de las perdedoras, factor de beneficio, peor caída de la
// curva, racha), la curva acumulada y el reparto por instrumento
export function resumirCerradas(cerradas, { saldo, t }) {
  const pct = x => (x == null || !(saldo > 0) ? null : 100 * x / saldo)
  const lista = cerradas.filter(c => c.hora != null && c.resultado != null).sort((a, b) => b.hora - a.hora)
  const hoy = fechaEnZona(t, ZONA)
  const suma = xs => (xs.length ? pct(xs.reduce((s, c) => s + c.resultado, 0)) : null)
  const desde = dias => lista.filter(c => c.hora >= t - dias * DIA)
  const ganadoras = lista.filter(c => c.resultado > 0)
  const perdedoras = lista.filter(c => c.resultado < 0)
  const media = xs => (xs.length ? pct(xs.reduce((s, c) => s + c.resultado, 0) / xs.length) : null)
  const ganado = ganadoras.reduce((s, c) => s + c.resultado, 0)
  const perdido = -perdedoras.reduce((s, c) => s + c.resultado, 0)

  // la curva, de la más antigua a la última, y lo más que ha caído desde un máximo (en puntos de %)
  const curva = []
  let acumulado = 0, pico = 0, peorCaida = 0
  for (const c of [...lista].reverse()) {
    acumulado += pct(c.resultado) ?? 0
    pico = Math.max(pico, acumulado)
    peorCaida = Math.min(peorCaida, acumulado - pico)
    curva.push({ hora: c.hora, pct: acumulado, instrumento: c.instrumento, resultado: pct(c.resultado) })
  }

  // la racha de ahora: cuántas seguidas del mismo signo que la última
  let racha = null
  if (lista.length) {
    const gana = lista[0].resultado > 0
    let n = 0
    while (n < lista.length && (lista[n].resultado > 0) === gana) n++
    racha = { gana, n }
  }

  const porInstrumento = new Map()
  for (const c of lista) {
    const g = porInstrumento.get(c.instrumento) ?? { instrumento: c.instrumento, operaciones: 0, ganadoras: 0, resultado: 0 }
    g.operaciones++
    if (c.resultado > 0) g.ganadoras++
    g.resultado += c.resultado
    porInstrumento.set(c.instrumento, g)
  }

  const ordenadas = [...lista].sort((a, b) => b.resultado - a.resultado)
  const fila = c => c && { hora: c.hora, instrumento: c.instrumento, lado: c.lado, nota: c.nota ?? null, pct: pct(c.resultado) }
  return {
    totales: {
      hoy: suma(lista.filter(c => fechaEnZona(c.hora, ZONA) === hoy)),
      semana: suma(desde(7)),
      mes: suma(desde(30)),
      total: suma(lista),
      operaciones: lista.length,
      ganadoras: ganadoras.length,
    },
    cifras: {
      mediaGanadora: media(ganadoras),
      mediaPerdedora: media(perdedoras),
      factorBeneficio: perdido > 0 ? ganado / perdido : null,
      peorCaida: lista.length ? peorCaida : null,
      mejor: fila(ordenadas[0]),
      peor: fila(ordenadas.at(-1)),
      racha,
      primera: lista.at(-1)?.hora ?? null,
    },
    curva,
    porInstrumento: [...porInstrumento.values()].map(({ resultado, ...g }) => ({ ...g, pct: pct(resultado) })).sort((a, b) => b.pct - a.pct),
    ultimas: lista.slice(0, ULTIMAS).map(fila),
  }
}

// Las posiciones abiertas del mismo bot, instrumento y lado, juntas como una sola, con lo que
// va y con lo que daría si saltaran todos sus stops (negativo si se perdería)
export function juntarAbiertas(posiciones, saldo) {
  const grupos = new Map()
  for (const p of posiciones) {
    const k = `${p.bot}|${p.instrumento}|${p.lado}`
    const g = grupos.get(k) ?? { bot: p.bot, instrumento: p.instrumento, lado: p.lado, desde: p.desde, unidades: 0, resultado: 0, sinPrecio: false, alStop: 0, sinStop: false }
    g.unidades++
    if (p.desde && (!g.desde || p.desde < g.desde)) g.desde = p.desde
    if (p.resultado == null) g.sinPrecio = true
    else g.resultado += p.resultado
    if (p.alStop == null) g.sinStop = true
    else g.alStop += p.alStop
    grupos.set(k, g)
  }
  const pct = x => (!(saldo > 0) ? null : 100 * x / saldo)
  return [...grupos.values()].map(({ resultado, sinPrecio, alStop, sinStop, ...g }) => ({ ...g, pct: sinPrecio ? null : pct(resultado), alStopPct: sinStop ? null : pct(alStop) }))
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

// Lo que el resumen cuenta de cada bot además de sus operaciones: cuántos instrumentos tiene
// encendidos, en cuáles está en sesión ahora y cuándo abre la próxima (en segundos)
export function infoMotorSrs(estado, t) {
  const encendidas = (estado.sesiones ?? []).filter(s => s.encendido)
  const proximas = encendidas.map(s => s.proxima).filter(Boolean)
  return {
    instrumentos: encendidas.length,
    enSesion: encendidas.filter(s => s.hoy && t >= s.hoy.abre && t < s.hoy.cierra).map(s => s.nombre),
    proxima: proximas.length ? Math.min(...proximas) : null,
  }
}

export function infoTortugas(estado) {
  const encendidos = (estado.mercados ?? []).filter(m => m.encendido)
  return { instrumentos: encendidos.length, enSesion: encendidos.filter(m => m.enSesion).map(m => m.nombre) }
}

export function cerradasTortugas(estado) {
  const nombres = Object.fromEntries((estado.mercados ?? []).map(m => [m.ticker, m.nombre]))
  return (estado.operaciones ?? []).map(o => ({ hora: o.cerradaHora, instrumento: nombres[o.ticker] ?? o.ticker, lado: o.lado, nota: `S${o.sistema}`, resultado: o.resultadoEur }))
}

export function cerradasTortugasAcciones(estado) {
  return (estado.operaciones ?? []).map(o => ({ hora: o.cerrada ? Math.floor(Date.parse(o.cerrada) / 1000) : null, instrumento: o.simbolo, lado: o.lado, nota: `S${o.sistema}`, resultado: o.resultado }))
}

// `bots`: [{ nombre, cuenta: 'ig' | 'alpaca', activo(), cerradas(), info?() }]; `posicionesIg`: las de
// la cuenta de IG con su bot ya puesto (las que no son de ningún bot no salen); `vigilancia`: su estado.
// `info()` da lo que cuenta de cada bot además: { instrumentos, enSesion, proxima }
export function resumenPublico({ bots, saldoIg, posicionesIg = [], saldoAlpaca = null, posicionesAlpaca = [], vigilancia, t }) {
  const latidos = Object.fromEntries((vigilancia?.bots ?? []).map(b => [b.nombre, b]))
  const abiertas = [
    ...juntarAbiertas(posicionesIg.filter(p => p.bot), saldoIg),
    ...juntarAbiertas(posicionesAlpaca, saldoAlpaca),
  ]
  const lista = bots.map(b => {
    const saldo = b.cuenta === 'alpaca' ? saldoAlpaca : saldoIg
    let cerradas = [], info = {}
    try { cerradas = b.cerradas() } catch { /* un bot roto no tumba el resumen */ }
    try { info = b.info?.() ?? {} } catch { /* ídem */ }
    const latido = latidos[b.nombre]
    const suyas = abiertas.filter(a => a.bot === b.nombre).map(({ bot: _bot, ...a }) => a)
    const sumar = clave => (suyas.length && suyas.every(a => a[clave] != null) ? suyas.reduce((s, a) => s + a[clave], 0) : suyas.length ? null : 0)
    return {
      nombre: b.nombre,
      cuenta: b.cuenta === 'alpaca' ? 'Alpaca (paper)' : 'IG (demo)',
      tipoCuenta: b.cuenta,
      encendido: !!b.activo(),
      enMarcha: !!latido?.enMarcha,
      parado: !!latido?.parado,
      instrumentos: info.instrumentos ?? null,
      enSesion: info.enSesion ?? [],
      proxima: info.proxima ?? null,
      abiertas: suyas,
      abierto: { pct: sumar('pct'), alStopPct: sumar('alStopPct') },
      ...resumirCerradas(cerradas, { saldo, t }),
    }
  })
  // la cuenta de IG entera: sus bots comparten saldo, así que los % se pueden sumar
  const deIg = lista.filter(b => b.tipoCuenta === 'ig')
  const sumarIg = f => deIg.reduce((s, b) => (f(b) == null ? s : (s ?? 0) + f(b)), null)
  return {
    hora: t,
    conjunto: {
      encendidos: lista.filter(b => b.encendido).length,
      bots: lista.length,
      parados: lista.filter(b => b.parado).map(b => b.nombre),
      ig: {
        abiertas: deIg.reduce((s, b) => s + b.abiertas.length, 0),
        abierto: sumarIg(b => b.abierto.pct),
        alStop: sumarIg(b => b.abierto.alStopPct),
        hoy: sumarIg(b => b.totales.hoy),
        semana: sumarIg(b => b.totales.semana),
        mes: sumarIg(b => b.totales.mes),
        total: sumarIg(b => b.totales.total),
      },
    },
    bots: lista.map(({ tipoCuenta: _t, ...b }) => b),
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
