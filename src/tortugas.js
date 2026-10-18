// Las tortugas de Richard Dennis (Market Wizards) adaptadas a CFD de índices, en velas
// diarias y con las posiciones abiertas de un día para otro. Es el mismo motor que
// G:\Mi unidad\codigos\tortugas\tortugas.py, traducido para la pestaña Estrategias; los dos
// dan las mismas cifras con los mismos datos.
//
// Reglas de las tortugas:
//  - N = ATR de Wilder de 20 sesiones. Una unidad es el tamaño (€ por punto) con el que un
//    movimiento de 1 N cuesta `riesgo` del capital: riesgo · capital / N.
//  - Sistema 1: entra al romper el máximo (largo) o el mínimo (corto) de 20 sesiones y sale
//    al romper el extremo contrario de 10. Se salta la ruptura si la anterior, operada o no,
//    habría ganado, y entonces entra en la de 55. Sistema 2: entra en la de 55 y sale en la
//    de 20, sin filtro.
//  - Pirámide: una unidad más cada ½ N a favor desde el último relleno, hasta `maxUnidades`.
//  - Stop a 2 N del último relleno, común a todas las unidades.
//  - Todas las órdenes son stop: si la apertura ya ha saltado el nivel, se llenan en ella.
//  - Por cada 10 % de drawdown se opera con un capital nominal un 20 % menor.
//
// Adaptaciones a índices: hasta 6 unidades (las tortugas, 4), límites por grupo y por sentido
// porque todos los índices van juntos, financiación del CFD por noche natural (el viernes
// cuenta 3: el largo paga tipo + recargo y cobra el dividendo; el corto, al revés) y, por
// defecto, solo largos y un riesgo de 0,2 % por unidad. Dentro de la vela se supone el camino
// apertura → mínimo → máximo → cierre si cierra por encima de la apertura, y apertura →
// máximo → mínimo → cierre si no.

// En el orden en que abren en el día: así, el mismo día, Asia se procesa antes que Europa.
// `desde` es el primer día con máximos y mínimos de verdad en Yahoo; `spread`, el del CFD en
// tanto por uno del precio; `dividendo`, la rentabilidad anual aproximada (el DAX ya la
// incluye: es un índice de rentabilidad total).
export const INDICES_TORTUGAS = [
  { id: 'N225', ticker: '^N225',  nombre: 'Nikkei',  grupo: 'Asia',   zona: 'Asia/Tokyo',       cierre: '15:30', desde: '1989-01-01', spread: 0.00015, dividendo: 0.018 },
  { id: 'HSI',  ticker: '^HSI',   nombre: 'Hang Seng', grupo: 'Asia', zona: 'Asia/Hong_Kong',   cierre: '16:10', desde: '1990-01-01', spread: 0.0003,  dividendo: 0.035 },
  { id: 'DAX',  ticker: '^GDAXI', nombre: 'DAX',     grupo: 'Europa', zona: 'Europe/Berlin',    cierre: '17:35', desde: '1994-01-01', spread: 0.00005, dividendo: 0 },
  { id: 'FTSE', ticker: '^FTSE',  nombre: 'FTSE',    grupo: 'Europa', zona: 'Europe/London',    cierre: '16:35', desde: '1984-01-01', spread: 0.0001,  dividendo: 0.035 },
  { id: 'SPX',  ticker: '^GSPC',  nombre: 'S&P 500', grupo: 'EEUU',   zona: 'America/New_York', cierre: '16:00', desde: '1962-01-01', spread: 0.00006, dividendo: 0.02 },
  { id: 'NDX',  ticker: '^NDX',   nombre: 'Nasdaq',  grupo: 'EEUU',   zona: 'America/New_York', cierre: '16:00', desde: '1985-10-01', spread: 0.00004, dividendo: 0.01 },
  { id: 'DJI',  ticker: '^DJI',   nombre: 'Dow',     grupo: 'EEUU',   zona: 'America/New_York', cierre: '16:00', desde: '1992-01-01', spread: 0.00005, dividendo: 0.022 },
  { id: 'RUT',  ticker: '^RUT',   nombre: 'Russell', grupo: 'EEUU',   zona: 'America/New_York', cierre: '16:00', desde: '1987-09-10', spread: 0.00012, dividendo: 0.015 },
]

// Letra del Tesoro de EE. UU. a 3 meses, en %: el tipo de la financiación de todos los
// índices (una aproximación: el euro estuvo en negativo de 2015 a 2022)
export const TICKER_TIPO = '^IRX'
const TIPO_SIN_DATOS = 0.03

export const CONFIG_TORTUGAS = {
  sistema: 1,
  lados: 'largos',      // largos | ambos | cortos
  riesgo: 0.002,        // fracción del capital que cuesta 1 N por unidad
  maxUnidades: 6,
  maxGrupo: 9,          // las tortugas: 4 por mercado, 6 muy correlacionados, 12 por sentido
  maxSentido: 15,
  paso: 0.5,            // N entre añadidos
  stopN: 2,
  deslizN: 0.02,        // deslizamiento por relleno, en N (además de medio spread)
  recargo: 0.025,       // financiación del broker sobre el tipo, anual
  financiacion: true,   // false = sin coste por noche, como un futuro sin base
  media: 0,            // solo a favor de la media de tantas sesiones (0 = sin filtro)
  reduccionDD: true,
  apalancamiento: 10,   // nominal total máximo / capital (0 = sin tope)
  capital: 100_000,
  desde: '1990-01-01',
  hasta: '',
}

const DIA_MS = 86_400_000
const noches = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DIA_MS)

// ── Indicadores ─────────────────────────────────────────────────────────────

function wilder(x, k) {
  const n = new Array(x.length).fill(NaN)
  if (x.length < k) return n
  let s = 0
  for (let i = 0; i < k; i++) s += x[i]
  n[k - 1] = s / k
  for (let i = k; i < x.length; i++) n[i] = (n[i - 1] * (k - 1) + x[i]) / k
  return n
}

// Extremo de las k sesiones anteriores a cada una (sin contarla): lo que se conoce al abrir
function extremoPrevio(x, k, f) {
  const r = new Array(x.length).fill(NaN)
  for (let i = k; i < x.length; i++) {
    let e = x[i - k]
    for (let j = i - k + 1; j < i; j++) e = f(e, x[j])
    r[i] = e
  }
  return r
}

function mediaPrevia(x, k) {
  const r = new Array(x.length).fill(NaN)
  let s = 0
  for (let i = 0; i < x.length; i++) {
    if (i >= k) r[i] = s / k
    s += x[i]
    if (i >= k) s -= x[i - k]
  }
  return r
}

// Serie de un índice con los niveles que se conocen al empezar cada sesión. `velas` va en
// orden, con `date` (YYYY-MM-DD) y OHLC; se quitan las de antes de `info.desde` y las que no
// tienen rango (Yahoo trae años enteros con máximo = mínimo).
export function prepararMercado(info, velas) {
  const vs = velas.filter(v => v.date >= info.desde && v.high > v.low)
  const o = vs.map(v => v.open), h = vs.map(v => v.high), l = vs.map(v => v.low), c = vs.map(v => v.close)
  const tr = vs.map((v, i) => i === 0 ? v.high - v.low
    : Math.max(v.high - v.low, Math.abs(v.high - c[i - 1]), Math.abs(v.low - c[i - 1])))
  const nCierre = wilder(tr, 20)
  const medias = new Map()
  return {
    info, fechas: vs.map(v => v.date), o, h, l, c, nCierre,
    n: [NaN, ...nCierre.slice(0, -1)],
    alto: Object.fromEntries([10, 20, 55].map(k => [k, extremoPrevio(h, k, Math.max)])),
    bajo: Object.fromEntries([10, 20, 55].map(k => [k, extremoPrevio(l, k, Math.min)])),
    media(k) {
      if (!medias.has(k)) medias.set(k, mediaPrevia(c, k))
      return medias.get(k)
    },
  }
}

// ── Motor ───────────────────────────────────────────────────────────────────

const tamDe = p => p.unidades.reduce((s, u) => s + u.tam, 0)
const resultadoDe = (p, precio) => p.lado * p.unidades.reduce((s, u) => s + u.tam * (precio - u.precio), 0)
const precioMedio = p => p.unidades.reduce((s, u) => s + u.precio * u.tam, 0) / tamDe(p)

function bisectIzq(arr, x) {
  let lo = 0, hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

// `tipos`: [{ date, close }] del ^IRX en %, en orden. Sin ellos, un 3 % fijo.
export function backtestTortugas(mercados, tipos, parcial = {}) {
  const cfg = { ...CONFIG_TORTUGAS, ...parcial }
  const hasta = cfg.hasta || '9999-12-31'
  const fechas = [...new Set(mercados.flatMap(m => m.fechas.filter(f => f >= cfg.desde && f <= hasta)))].sort()
  const fechasTipo = tipos?.length ? tipos.map(t => t.date) : null
  const fechasSet = new Set(fechas)
  // el tipo del último día con dato hasta esa fecha
  const tipoEn = f => {
    if (!fechasTipo) return fechasSet.has(f) ? TIPO_SIN_DATOS : 0
    const k = bisectIzq(fechasTipo, f + '\uffff') - 1
    return k >= 0 ? tipos[k].close / 100 : 0
  }
  const arranque = Math.max(60, cfg.media + 1)

  const est = mercados.map(m => {
    const ptr = bisectIzq(m.fechas, cfg.desde)
    return { m, ptr, pos: null, virtual: null, gano: false, ultimo: ptr > 0 ? m.c[ptr - 1] : NaN, i: -1 }
  })
  let efectivo = cfg.capital, valorAyer = cfg.capital, pico = cfg.capital, nominal = cfg.capital
  const operaciones = [], curva = [], exposicion = []

  const valor = () => efectivo + est.reduce((s, e) => s + (e.pos ? resultadoDe(e.pos, e.ultimo) : 0), 0)
  const tamano = e => cfg.riesgo * nominal / e.m.n[e.i]

  const fijarCapital = () => {
    const v = valorAyer
    pico = Math.max(pico, v)
    if (!cfg.reduccionDD) { nominal = v; return }
    const tramos = Math.floor((1 - v / pico) / 0.10 + 1e-9)
    nominal = Math.min(v, pico * 0.8 ** tramos)
  }

  const permite = (e, lado) => {
    if (cfg.lados !== 'ambos' && (cfg.lados === 'largos') !== (lado > 0)) return false
    if (cfg.media) {
      const media = e.m.media(cfg.media)[e.i], pc = e.m.c[e.i - 1]
      return lado > 0 ? pc > media : pc < media
    }
    return true
  }

  const cabe = (e, lado) => {
    if (nominal <= 0) return false
    let grupo = 0, total = 0
    for (const x of est) {
      if (x.pos && x.pos.lado === lado) {
        total += x.pos.unidades.length
        if (x.m.info.grupo === e.m.info.grupo) grupo += x.pos.unidades.length
      }
    }
    if (grupo >= cfg.maxGrupo || total >= cfg.maxSentido) return false
    if (cfg.apalancamiento) {
      let nom = 0
      for (const x of est) if (x.pos) nom += tamDe(x.pos) * x.ultimo
      nom += tamano(e) * e.m.c[e.i - 1]
      if (nom > cfg.apalancamiento * valorAyer) return false
    }
    return true
  }

  // Órdenes stop vivas en esa dirección: [nivel, prioridad, acción]. La cartera real va antes
  // que la ruptura virtual, para que el filtro mire la ruptura anterior y no esta.
  const ordenes = (e, sube) => {
    const { m, i } = e
    const lado = sube ? 1 : -1
    const canal = sube ? m.alto : m.bajo
    const primero = sube ? Math.min : Math.max
    const res = []
    if (cfg.sistema === 1) {
      const v = e.virtual
      if (!v) res.push([canal[20][i], 1, { tipo: 'v_entra', lado }])
      else if (v.lado === -lado) res.push([primero(v.stop, canal[10][i]), 1, { tipo: 'v_sale' }])
    }
    const p = e.pos
    if (!p) {
      if (permite(e, lado) && cabe(e, lado)) {
        const k = cfg.sistema === 2 || e.gano ? 55 : 20
        res.push([canal[k][i], 0, { tipo: 'entra', lado, k }])
      }
    } else if (p.lado === lado) {
      if (p.unidades.length < cfg.maxUnidades && cabe(e, lado)) {
        res.push([p.unidades.at(-1).ref + lado * cfg.paso * p.n0, 0, { tipo: 'anade' }])
      }
    } else {
      const k = cfg.sistema === 1 ? 10 : 20
      const nivel = primero(p.stop, canal[k][i])
      res.push([nivel, 0, { tipo: 'sale', motivo: nivel === p.stop ? 'stop' : `canal ${k}` }])
    }
    return res
  }

  const apunte = (e, p, fecha, salida, motivo, bruto) => {
    const neto = bruto - p.financiacion
    return {
      indice: e.m.info.id, lado: p.lado > 0 ? 'largo' : 'corto', ruptura: p.ruptura,
      entrada: p.abierta, salida: fecha, dias: fecha ? noches(p.abierta, fecha) : null,
      n: p.n0, unidades: p.unidades.length, precioEntrada: precioMedio(p), precioSalida: salida, motivo,
      bruto, financiacion: p.financiacion, neto, pctCapital: 100 * neto / p.capital,
    }
  }

  const ejecutar = (e, accion, precio) => {
    const { m } = e
    const n = m.n[e.i], fecha = m.fechas[e.i]
    if (accion.tipo === 'v_entra') {
      e.virtual = { lado: accion.lado, entrada: precio, stop: precio - accion.lado * cfg.stopN * n }
      return
    }
    if (accion.tipo === 'v_sale') {
      e.gano = (precio - e.virtual.entrada) * e.virtual.lado > 0
      e.virtual = null
      return
    }
    const coste = m.info.spread * precio / 2 + cfg.deslizN * n
    if (accion.tipo === 'entra') {
      e.pos = { lado: accion.lado, n0: n, abierta: fecha, capital: valorAyer, ruptura: accion.k, stop: NaN, unidades: [], financiacion: 0 }
    }
    const p = e.pos
    if (accion.tipo === 'entra' || accion.tipo === 'anade') {
      p.unidades.push({ fecha, ref: precio, precio: precio + p.lado * coste, tam: tamano(e) })
      p.stop = precio - p.lado * cfg.stopN * p.n0
      return
    }
    const salida = precio - p.lado * coste
    const bruto = resultadoDe(p, salida)
    efectivo += bruto
    operaciones.push(apunte(e, p, fecha, salida, accion.motivo, bruto))
    e.pos = null
  }

  // Lleva el precio de a a b y ejecuta, de la más cercana a la más lejana, las órdenes que
  // encuentra. En el salto de la noche (salto) todo se llena a la apertura.
  const recorrer = (e, a, b, salto) => {
    if (a === b) return
    const sube = b > a
    for (let vuelta = 0; vuelta < 20; vuelta++) {
      let mejor = null
      for (const [nivel, prioridad, accion] of ordenes(e, sube)) {
        if (Number.isNaN(nivel) || (sube && nivel > b) || (!sube && nivel < b)) continue
        const dist = Math.max(sube ? nivel - a : a - nivel, 0)
        if (!mejor || dist < mejor.dist || (dist === mejor.dist && prioridad < mejor.prioridad)) {
          mejor = { dist, prioridad, nivel, accion }
        }
      }
      if (!mejor) return
      const precio = salto ? b : sube ? Math.max(mejor.nivel, a) : Math.min(mejor.nivel, a)
      ejecutar(e, mejor.accion, precio)
      a = precio
    }
  }

  const financiar = (e, i) => {
    const p = e.pos
    if (!p || !cfg.financiacion) return
    const { m } = e
    const tipo = tipoEn(m.fechas[i - 1])
    const tasa = p.lado > 0 ? tipo + cfg.recargo - m.info.dividendo : cfg.recargo - tipo + m.info.dividendo
    const coste = tamDe(p) * m.c[i - 1] * tasa * noches(m.fechas[i - 1], m.fechas[i]) / 365
    efectivo -= coste
    p.financiacion += coste
  }

  const sesion = (e, i) => {
    e.i = i
    financiar(e, i)
    const { o, h, l, c } = e.m
    const camino = [c[i - 1], o[i], ...(c[i] >= o[i] ? [l[i], h[i]] : [h[i], l[i]]), c[i]]
    for (let k = 0; k < 4; k++) recorrer(e, camino[k], camino[k + 1], k === 0)
  }

  for (const f of fechas) {
    fijarCapital()
    for (const e of est) {
      const i = e.ptr
      if (i < e.m.fechas.length && e.m.fechas[i] === f) {
        e.ptr++
        if (i >= arranque) sesion(e, i)
        e.ultimo = e.m.c[i]
      }
    }
    const v = valor()
    curva.push({ date: f, valor: v })
    let nom = 0
    for (const e of est) if (e.pos) nom += tamDe(e.pos) * e.ultimo
    exposicion.push(nom / Math.max(v, 1e-9))
    valorAyer = v
  }

  const abiertas = est.filter(e => e.pos).map(e => apunte(e, e.pos, null, e.ultimo, 'abierta', resultadoDe(e.pos, e.ultimo)))
  return { cfg, curva, exposicion, operaciones, abiertas, estados: est }
}

// ── Resultados ──────────────────────────────────────────────────────────────

const suma = xs => xs.reduce((s, x) => s + x, 0)
const media = xs => xs.length ? suma(xs) / xs.length : NaN

export function metricasTortugas(res) {
  const eq = res.curva.map(p => p.valor)
  if (eq.length < 2) return null
  const anios = noches(res.curva[0].date, res.curva.at(-1).date) / 365.25
  const cagr = eq.at(-1) > 0 ? (eq.at(-1) / eq[0]) ** (1 / anios) - 1 : -1
  let pico = -Infinity, maxDD = 0, racha = 0, peorRacha = 0, desde = null, peor = null
  eq.forEach((v, k) => {
    if (v > pico) { pico = v; desde = res.curva[k].date }
    const dd = v / pico - 1
    if (dd < maxDD) { maxDD = dd; peor = { desde, hasta: res.curva[k].date } }
    racha = dd < 0 ? racha + 1 : 0
    peorRacha = Math.max(peorRacha, racha)
  })
  const r = eq.slice(1).map((v, k) => v / eq[k] - 1)
  const mr = media(r)
  const sd = Math.sqrt(suma(r.map(x => (x - mr) ** 2)) / (r.length - 1))
  const ops = res.operaciones
  const ganan = ops.filter(o => o.neto > 0), pierden = ops.filter(o => o.neto <= 0)
  const brutoPositivo = suma(ops.filter(o => o.bruto > 0).map(o => o.bruto))
  return {
    capitalFinal: eq.at(-1),
    cagr: 100 * cagr,
    maxDD: 100 * maxDD,
    peorDD: peor,
    mar: maxDD < 0 ? cagr / -maxDD : NaN,
    sharpe: sd > 0 ? mr / sd * Math.sqrt(252) : NaN,
    ddMasLargo: peorRacha / 260,
    operaciones: ops.length,
    acierto: ops.length ? 100 * ganan.length / ops.length : NaN,
    profitFactor: pierden.length ? suma(ganan.map(o => o.neto)) / -suma(pierden.map(o => o.neto)) : NaN,
    ganadoraPerdedora: ganan.length && pierden.length ? media(ganan.map(o => o.neto)) / -media(pierden.map(o => o.neto)) : NaN,
    diasMedios: media(ops.map(o => o.dias)),
    financiacion: suma(ops.map(o => o.financiacion)),
    financiacionPct: brutoPositivo > 0 ? 100 * suma(ops.map(o => o.financiacion)) / brutoPositivo : NaN,
    apalancamientoMedio: media(res.exposicion),
    apalancamientoMax: Math.max(...res.exposicion),
  }
}

// La curva con su drawdown en %, para el gráfico
export function curvaConDrawdown(res) {
  let pico = -Infinity
  return res.curva.map(p => {
    pico = Math.max(pico, p.valor)
    return { date: p.date, valor: p.valor, dd: 100 * (p.valor / pico - 1) }
  })
}

export function rentabilidadAnual(res) {
  const finDeAnio = new Map()
  for (const p of res.curva) finDeAnio.set(p.date.slice(0, 4), p.valor)
  let previo = res.cfg.capital
  return [...finDeAnio].map(([anio, v]) => {
    const pct = 100 * (v / previo - 1)
    previo = v
    return { anio: Number(anio), pct }
  })
}

export function resumenPorIndice(res) {
  const ini = res.curva[0]?.date, fin = res.curva.at(-1)?.date
  return res.estados.map(({ m }) => {
    const o = res.operaciones.filter(x => x.indice === m.info.id)
    const netoDe = xs => suma(xs.map(x => x.neto))
    const cs = m.c.filter((_, k) => m.fechas[k] >= ini && m.fechas[k] <= fin)
    const fs = m.fechas.filter(f => f >= ini && f <= fin)
    let pico = -Infinity, dd = 0
    for (const v of cs) { pico = Math.max(pico, v); dd = Math.min(dd, v / pico - 1) }
    const anios = fs.length > 1 ? noches(fs[0], fs.at(-1)) / 365.25 : NaN
    return {
      indice: m.info.id, nombre: m.info.nombre, desde: fs[0] ?? null,
      operaciones: o.length,
      acierto: o.length ? 100 * o.filter(x => x.neto > 0).length / o.length : NaN,
      neto: netoDe(o),
      largos: netoDe(o.filter(x => x.lado === 'largo')),
      cortos: netoDe(o.filter(x => x.lado === 'corto')),
      financiacion: suma(o.map(x => x.financiacion)),
      compraCagr: cs.length > 1 ? 100 * ((cs.at(-1) / cs[0]) ** (1 / anios) - 1) : NaN,
      compraDD: 100 * dd,
    }
  })
}

// Cuánto deja cada operación según hasta dónde llegó la pirámide
export function porUnidades(res) {
  const grupos = new Map()
  for (const o of res.operaciones) {
    const g = grupos.get(o.unidades) ?? { unidades: o.unidades, n: 0, neto: 0, ganan: 0 }
    g.n++
    g.neto += o.neto
    if (o.neto > 0) g.ganan++
    grupos.set(o.unidades, g)
  }
  return [...grupos.values()].sort((a, b) => a.unidades - b.unidades)
}

// Las órdenes stop para la próxima sesión de cada índice, a partir del estado al último
// cierre del backtest, con el tamaño de la unidad para `capital`
export function ordenesManana(res, capital) {
  const { cfg } = res
  return res.estados.map(e => {
    const { m } = e
    const n = m.nCierre.at(-1)
    const alto = k => Math.max(...m.h.slice(-k)), bajo = k => Math.min(...m.l.slice(-k))
    const fila = {
      indice: m.info.id, nombre: m.info.nombre, ultimoDia: m.fechas.at(-1), cierre: m.c.at(-1), n,
      unidad: cfg.riesgo * capital / n,
      posicion: null, compra: null, venta: null, salida: null, filtro: false,
    }
    const p = e.pos
    if (!p) {
      const k = cfg.sistema === 2 || e.gano ? 55 : 20
      const mm = cfg.media ? media(m.c.slice(-cfg.media)) : null
      fila.filtro = cfg.sistema === 1 && e.gano
      if (cfg.lados !== 'cortos' && (!cfg.media || m.c.at(-1) > mm)) fila.compra = { nivel: alto(k), k }
      if (cfg.lados !== 'largos' && (!cfg.media || m.c.at(-1) < mm)) fila.venta = { nivel: bajo(k), k }
    } else {
      const k = cfg.sistema === 1 ? 10 : 20
      fila.posicion = { lado: p.lado > 0 ? 'largo' : 'corto', unidades: p.unidades.length, desde: p.abierta, medio: precioMedio(p) }
      fila.salida = p.lado > 0 ? Math.max(p.stop, bajo(k)) : Math.min(p.stop, alto(k))
      if (p.unidades.length < cfg.maxUnidades) {
        const anadido = { nivel: p.unidades.at(-1).ref + p.lado * cfg.paso * p.n0, k: null }
        if (p.lado > 0) fila.compra = anadido
        else fila.venta = anadido
      }
    }
    return fila
  })
}
