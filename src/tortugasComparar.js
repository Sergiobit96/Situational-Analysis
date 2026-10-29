// ── Real frente al backtest del bot de las tortugas (pestaña Bots → Tortugas) ──
// El backtest de cada mercado con las reglas del bot (los dos sistemas como uno, `comoBot`) y
// el mismo diario del que el bot saca sus niveles (/api/bot/tortugas/diarios), sin límites de
// cartera, sin costes y sin financiación: lo que habría hecho cada mercado por su cuenta. Cada
// operación del bot se empareja con la del backtest del mismo mercado, sistema y lado abierta
// a pocos días; las que quedan solas son las que uno hizo y el otro no.
// Todo en N por unidad de la primera (como el bot apunta resultadoN): así se juntan mercados.

import { prepararMercado, backtestTortugas } from './tortugas.js'

const DIAS_PARA_CASAR = 4   // la fecha de la sesión del bot y la del diario pueden ir un día o dos separadas (divisas, fines de semana)
const dir = lado => (lado === 'largo' ? 1 : -1)
const dias = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000

// `velas`: [[fecha, apertura, máximo, mínimo, cierre], …] en orden. `config`, la del bot.
export function backtestDelBot(ticker, velas, config, { stopN = 2, paso = 0.5 } = {}) {
  const m = prepararMercado({ id: ticker, grupo: 'uno', desde: '1900-01-01', spread: 0, dividendo: 0 },
    velas.map(([date, open, high, low, close]) => ({ date, open, high, low, close })))
  const sistemas = config.sistemas ?? [1, 2]
  const res = backtestTortugas([m], null, {
    sistema: sistemas.length > 1 ? '1+2' : sistemas[0], comoBot: true, filtroS1: !!config.filtroS1,
    lados: config.lados ?? 'ambos', maxUnidades: config.maxUnidades ?? 4, anadido: config.anadido ?? 1,
    stopN, paso, maxGrupo: Infinity, maxSentido: Infinity, apalancamiento: 0,
    deslizN: 0, financiacion: false, reduccionDD: false, comisiones: false, media: 0, desde: '1900-01-01',
  })
  const deApunte = abierta => o => ({
    ticker, sistema: o.sistema, lado: o.lado, ruptura: o.ruptura, abierta: o.entrada, cerrada: o.salida, enCurso: abierta,
    entrada: o.precios[0], unidades: o.unidades, salida: o.precioSalida, motivo: o.motivo, n0: o.n,
    resultadoN: o.bruto / (o.tamanos[0] * o.n),
  })
  return [...res.operaciones.map(deApunte(false)), ...res.abiertas.map(deApunte(true))]
}

// Las del bot, cerradas y abiertas, en la misma forma. Las abiertas, a `precio` (el de IG
// ahora) o, sin él, sin resultado.
export function operacionesDelBot(operaciones, mercados) {
  const cerradas = operaciones.map(o => ({
    ticker: o.ticker, sistema: o.sistema ?? 1, lado: o.lado, ruptura: o.ruptura, abierta: o.abierta, cerrada: o.cerrada, enCurso: false,
    entrada: o.detalle?.[0]?.entrada ?? o.entradaMedia, unidades: o.unidades, salida: o.salida, motivo: o.motivo, n0: o.n0,
    resultadoN: o.resultadoN, resultadoEur: o.resultadoEur, eurPorN: o.resultadoN ? o.resultadoEur / o.resultadoN : null,
  }))
  const abiertas = mercados.flatMap(m => Object.entries(m.posiciones ?? {}).filter(([, p]) => p).map(([s, p]) => {
    const us = p.unidades.filter(u => !u.salida)
    const base = p.unidades[0].tamano
    const pts = m.precio == null ? null : us.reduce((x, u) => x + (u.tamano / base) * dir(p.lado) * (m.precio - u.entrada), 0)
    const eurPorN = base * p.valorPunto * p.cambioAEur * p.n0
    return {
      ticker: m.ticker, sistema: Number(s), lado: p.lado, ruptura: p.ruptura, abierta: p.abierta, cerrada: null, enCurso: true,
      entrada: p.unidades[0].entrada, unidades: us.length, salida: m.precio, motivo: 'abierta', n0: p.n0,
      resultadoN: pts == null || !(p.n0 > 0) ? null : pts / p.n0, eurPorN,
      resultadoEur: pts == null || !(p.n0 > 0) ? null : (pts / p.n0) * eurPorN,
    }
  }))
  return [...cerradas, ...abiertas]
}

// Empareja las del bot con las del backtest abiertas desde `desde` (las del backtest de antes no
// cuentan: el bot empezó plano, salvo la pareja de una del bot, que puede ir un día o dos antes). `eurPorN[ticker]`, lo que vale 1 N de una unidad hoy (el
// riesgoEurN del plan), para poner en euros las que solo hizo el backtest.
export function compararTortugas(reales, backtest, { desde, eurPorN = {} } = {}) {
  const antes = new Date(Date.parse(desde) - DIAS_PARA_CASAR * 86_400_000).toISOString().slice(0, 10)
  const bt = backtest.filter(o => o.abierta >= antes)
  const libres = new Set(bt.map((_, i) => i))
  const filas = []
  // primero las parejas más cercanas en fecha
  const candidatas = []
  reales.filter(r => r.abierta >= desde).forEach((r, i) => bt.forEach((b, j) => {
    if (b.ticker === r.ticker && b.sistema === r.sistema && b.lado === r.lado && dias(b.abierta, r.abierta) <= DIAS_PARA_CASAR) {
      candidatas.push({ i, j, d: dias(b.abierta, r.abierta) })
    }
  }))
  candidatas.sort((a, b) => a.d - b.d)
  const realUsada = new Set()
  const pareja = new Map()
  for (const c of candidatas) {
    if (realUsada.has(c.i) || !libres.has(c.j)) continue
    realUsada.add(c.i)
    libres.delete(c.j)
    pareja.set(c.i, c.j)
  }
  reales.filter(r => r.abierta >= desde).forEach((r, i) => {
    const b = pareja.has(i) ? bt[pareja.get(i)] : null
    const porN = r.eurPorN ?? eurPorN[r.ticker] ?? null
    // sin pareja, el backtest no hizo nada: cuenta como 0
    const difN = r.resultadoN != null ? r.resultadoN - (b?.resultadoN ?? 0) : null
    filas.push({
      tipo: b ? 'ambos' : 'solo-bot', ticker: r.ticker, sistema: r.sistema, lado: r.lado, real: r, backtest: b,
      // lo que se pagó de más en la entrada frente al relleno del backtest, en N (positivo, peor)
      deslizamientoN: b && r.n0 > 0 ? dir(r.lado) * (r.entrada - b.entrada) / r.n0 : null,
      difN, difEur: difN != null && porN != null ? difN * porN : null,
    })
  })
  for (const j of libres) {
    const b = bt[j]
    if (b.abierta < desde) continue
    const porN = eurPorN[b.ticker] ?? null
    filas.push({
      tipo: 'solo-backtest', ticker: b.ticker, sistema: b.sistema, lado: b.lado, real: null, backtest: b,
      deslizamientoN: null, difN: -b.resultadoN, difEur: porN != null ? -b.resultadoN * porN : null, eurAproximado: true,
    })
  }
  filas.sort((a, b) => (a.real ?? a.backtest).abierta.localeCompare((b.real ?? b.backtest).abierta) || a.ticker.localeCompare(b.ticker))

  const sumar = xs => xs.reduce((s, x) => s + (x ?? 0), 0)
  const ambos = filas.filter(f => f.tipo === 'ambos')
  const desl = ambos.map(f => f.deslizamientoN).filter(x => x != null)
  return {
    filas,
    resumen: {
      casadas: ambos.length,
      soloBot: filas.filter(f => f.tipo === 'solo-bot').length,
      soloBacktest: filas.filter(f => f.tipo === 'solo-backtest').length,
      realN: sumar(filas.map(f => f.real?.resultadoN)),
      backtestN: sumar(filas.map(f => f.backtest?.resultadoN)),
      difN: sumar(filas.map(f => f.difN)),
      // sin ninguna en euros (sin el plan de la unidad), sin total: no es 0 €
      difEur: filas.some(f => f.difEur != null) ? sumar(filas.map(f => f.difEur)) : null,
      // las que no entran en ese total (un mercado sin plan de unidad no tiene lo que vale 1 N)
      sinEur: filas.filter(f => f.difN != null && f.difEur == null).length,
      // de dónde sale la diferencia: las que hicieron los dos, y las que hizo solo uno
      difCasadasN: sumar(ambos.map(f => f.difN)),
      difSueltasN: sumar(filas.filter(f => f.tipo !== 'ambos').map(f => f.difN)),
      deslizamientoMedioN: desl.length ? sumar(desl) / desl.length : null,
    },
  }
}
