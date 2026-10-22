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
//  - Los dos a la vez ('1+2'): cada índice lleva una posición de cada sistema. El 1 entra en
//    la de 20 si la anterior perdió; si habría ganado se la salta, y esa ruptura la coge el 2
//    en la de 55 y la lleva con su salida de 20. El 1 ya no tiene la de 55 de reserva. Van
//    como uno: un sistema no entra si el otro ya tiene en el índice una unidad del mismo
//    sentido a menos de `paso` N de su ruptura (la señal doble se ejecuta una sola vez), y
//    cada entrada va con todo el capital, como la del bot (server/bot-tortugas.js).
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
//
// Acciones de EE. UU. (el S&P 500, cada sector un grupo): lo que el mercado trae en su `info`
// las adapta. `comision` es la de IG en CFD de acciones americanas (2 centavos por acción y
// 15 $ como mínimo en cada orden; cada unidad es una orden al entrar y otra al salir), `lote`
// redondea la unidad a acciones enteras (sin acciones no entra) y `alta`, la fecha en que entró
// en el índice: con `soloEnIndice` no se abre nada antes. Los dividendos van en `div` de cada
// vela, el día que cotiza sin él: el largo lo cobra y el corto lo paga, con la financiación.
// Como los precios de Yahoo están ajustados por los splits, `f` en cada vela dice cuántas
// acciones de la serie eran una de entonces: la comisión y las acciones enteras se cuentan así.

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
  sistema: 1,           // 1 | 2 | '1+2'
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
  soloEnIndice: true,   // acciones: no abrir antes de la fecha en que entró en el índice (`alta`)
  comisiones: true,     // acciones: la comisión de cada orden (`comision` del mercado)
  apalancamiento: 10,   // nominal total máximo / capital (0 = sin tope)
  capital: 100_000,
  desde: '1990-01-01',
  hasta: '',
}

const DIA_MS = 86_400_000
const noches = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DIA_MS)

export const sistemasDe = sistema => (sistema === '1+2' ? [1, 2] : [sistema])

// La ruptura con la que entra un sistema que está fuera, o null si no entra. Solo, el 1 entra
// en la de 20, o en la de 55 si la anterior habría ganado, y el 2 en la de 55. Juntos, la que
// el 1 se salta la coge el 2, siempre que el 1 no esté dentro.
function entradaDe(cfg, e, s) {
  if (cfg.sistema !== '1+2') return s === 2 || e.gano ? 55 : 20
  if (s === 1) return e.gano ? null : 20
  return e.gano && !e.pos[1] ? 55 : null
}

// Juntos, la ruptura de un sistema que cae a menos de `paso` N de una unidad del otro en el
// mismo sentido es la misma señal: ya está dentro y no se repite
export function senalDoble(cfg, e, s, lado, nivel, n) {
  const otra = cfg.sistema === '1+2' ? e.pos[s === 1 ? 2 : 1] : null
  return !!otra && otra.lado === lado && otra.unidades.some(u => Math.abs(u.ref - nivel) < cfg.paso * n)
}

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

// Extremo de las k sesiones anteriores a cada una (sin contarla): lo que se conoce al abrir.
// `vacia(n)` da el array del resultado (uno normal o, para ahorrar memoria, un Float32Array)
const vaciaNormal = n => new Array(n).fill(NaN)
const vacia32 = n => new Float32Array(n).fill(NaN)
function extremoPrevio(x, k, f, vacia = vaciaNormal) {
  const r = vacia(x.length)
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
// orden, con `date` (YYYY-MM-DD) y OHLC (y, en las acciones, `div`, el dividendo, y `f`, las
// acciones de la serie que eran una de entonces); se quitan las de antes de `info.desde` y las
// que no tienen rango (Yahoo trae años enteros con máximo = mínimo). El dividendo de una vela
// quitada pasa a la siguiente.
export function prepararMercado(info, velas, opciones) {
  return prepararColumnas(info, {
    fechas: velas.map(v => v.date), o: velas.map(v => v.open), h: velas.map(v => v.high), l: velas.map(v => v.low), c: velas.map(v => v.close),
    div: velas.some(v => v.div) ? velas.map(v => v.div ?? 0) : null,
    f: velas.some(v => v.f) ? velas.map(v => v.f ?? 1) : null,
  }, opciones)
}

// Lo mismo con las velas en columnas ({ fechas, o, h, l, c, div?, f? }; `div` puede ser un
// objeto con solo los días que hay). Con `compacto`, las series van en Float32Array: la mitad
// de memoria, para las acciones, que son millones de velas (los precios pierden decimales más
// allá de la séptima cifra, que no cambian nada).
export function prepararColumnas(info, cols, { compacto = false } = {}) {
  const idx = []
  for (let i = 0; i < cols.fechas.length; i++) if (cols.fechas[i] >= info.desde && cols.h[i] > cols.l[i]) idx.push(i)
  const serie = x => (compacto ? Float32Array.from(idx, i => x[i]) : idx.map(i => x[i]))
  const o = serie(cols.o), h = serie(cols.h), l = serie(cols.l), c = serie(cols.c)
  const tr = idx.map((_, i) => i === 0 ? h[i] - l[i]
    : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])))
  const nW = wilder(tr, 20)
  const nCierre = compacto ? Float32Array.from(nW) : nW
  const n = compacto ? Float32Array.from(nW, (_, i) => (i ? nW[i - 1] : NaN)) : [NaN, ...nW.slice(0, -1)]
  const vacia = compacto ? vacia32 : vaciaNormal
  const medias = new Map()
  // el dividendo, solo en los días que lo hay
  let div = null
  if (cols.div) {
    div = {}
    let pendiente = 0, k = 0
    for (let i = 0; i < cols.fechas.length; i++) {
      if (cols.fechas[i] < info.desde) continue
      pendiente += cols.div[i] ?? 0
      if (cols.h[i] > cols.l[i]) {
        if (pendiente) div[k] = pendiente
        pendiente = 0
        k++
      }
    }
  }
  return {
    info, fechas: idx.map(i => cols.fechas[i]), o, h, l, c, nCierre, n, div,
    // acciones de la serie por acción de verdad (los splits posteriores; ver src/accionesEeuu.js)
    factor: cols.f ? Float32Array.from(idx, i => cols.f[i]) : null,
    alto: Object.fromEntries([10, 20, 55].map(k => [k, extremoPrevio(h, k, Math.max, vacia)])),
    bajo: Object.fromEntries([10, 20, 55].map(k => [k, extremoPrevio(l, k, Math.min, vacia)])),
    media(k) {
      if (!medias.has(k)) medias.set(k, mediaPrevia(c, k))
      return medias.get(k)
    },
  }
}

// ── Motor ───────────────────────────────────────────────────────────────────

// las posiciones abiertas de un índice, una por sistema como mucho
const abiertasDe = e => [e.pos[1], e.pos[2]].filter(Boolean)
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
  const todas = new Set()
  for (const m of mercados) for (const f of m.fechas) if (f >= cfg.desde && f <= hasta) todas.add(f)
  const fechas = [...todas].sort()
  const fechasTipo = tipos?.length ? tipos.map(t => t.date) : null
  const fechasSet = new Set(fechas)
  // el tipo del último día con dato hasta esa fecha
  const tipoEn = f => {
    if (!fechasTipo) return fechasSet.has(f) ? TIPO_SIN_DATOS : 0
    const k = bisectIzq(fechasTipo, f + '\uffff') - 1
    return k >= 0 ? tipos[k].close / 100 : 0
  }
  const arranque = Math.max(60, cfg.media + 1)

  const est = mercados.map((m, k) => {
    const ptr = bisectIzq(m.fechas, cfg.desde)
    return { m, k, ptr, pos: { 1: null, 2: null }, virtual: null, gano: false, ultimo: ptr > 0 ? m.c[ptr - 1] : NaN, i: -1 }
  })
  let efectivo = cfg.capital, valorAyer = cfg.capital, pico = cfg.capital, nominal = cfg.capital
  const operaciones = [], curva = [], exposicion = []

  // Los mercados con alguna posición abierta, en el orden de `est`. Las cuentas de la cartera
  // (valor, límites, nominal) solo recorren estos: con cientos de acciones, recorrerlos todos
  // en cada orden era lo que más tardaba. Como van en el mismo orden y los demás sumaban 0,
  // dan lo mismo al céntimo.
  const abiertos = []
  const marcar = e => {
    const dentro = abiertasDe(e).length > 0
    const k = abiertos.indexOf(e)
    if (dentro && k < 0) {
      let j = 0
      while (j < abiertos.length && abiertos[j].k < e.k) j++
      abiertos.splice(j, 0, e)
    } else if (!dentro && k >= 0) abiertos.splice(k, 1)
  }

  const valor = () => efectivo + abiertos.reduce((s, e) => s + abiertasDe(e).reduce((t, p) => t + resultadoDe(p, e.ultimo), 0), 0)
  // En acciones (`lote`), la unidad se redondea hacia abajo a acciones enteras de las de ese
  // día (`factor`: las de la serie, ajustada por splits, que hacían una)
  const tamano = e => {
    const t = cfg.riesgo * nominal / e.m.n[e.i]
    const lote = e.m.info.lote && e.m.info.lote * (e.m.factor?.[e.i] ?? 1)
    return lote ? Math.floor(t / lote + 1e-9) * lote : t
  }
  // La comisión de una orden de `tam` el día i: un tanto por acción (de las de ese día) con un
  // mínimo por orden
  const comisionDe = (m, tam, i) => (cfg.comisiones && m.info.comision
    ? Math.max(m.info.comision.porAccion * tam / (m.factor?.[i] ?? 1), m.info.comision.minimo) : 0)

  const fijarCapital = () => {
    const v = valorAyer
    pico = Math.max(pico, v)
    if (!cfg.reduccionDD) { nominal = v; return }
    const tramos = Math.floor((1 - v / pico) / 0.10 + 1e-9)
    nominal = Math.min(v, pico * 0.8 ** tramos)
  }

  const permite = (e, lado) => {
    if (cfg.lados !== 'ambos' && (cfg.lados === 'largos') !== (lado > 0)) return false
    if (cfg.soloEnIndice && e.m.info.alta && e.m.fechas[e.i] < e.m.info.alta) return false
    if (cfg.media) {
      const media = e.m.media(cfg.media)[e.i], pc = e.m.c[e.i - 1]
      return lado > 0 ? pc > media : pc < media
    }
    return true
  }

  const cabe = (e, lado) => {
    if (nominal <= 0 || !(tamano(e) > 0)) return false
    let grupo = 0, total = 0
    for (const x of abiertos) {
      for (const p of abiertasDe(x)) {
        if (p.lado !== lado) continue
        total += p.unidades.length
        if (x.m.info.grupo === e.m.info.grupo) grupo += p.unidades.length
      }
    }
    if (grupo >= cfg.maxGrupo || total >= cfg.maxSentido) return false
    if (cfg.apalancamiento) {
      let nom = 0
      for (const x of abiertos) for (const p of abiertasDe(x)) nom += tamDe(p) * x.ultimo
      nom += tamano(e) * e.m.c[e.i - 1]
      if (nom > cfg.apalancamiento * valorAyer) return false
    }
    return true
  }

  // Órdenes stop vivas en esa dirección: [nivel, prioridad, acción]. La cartera real va antes
  // que la ruptura virtual, para que el filtro mire la ruptura anterior y no esta. Las que
  // suman unidades (`limitada`) solo valen si caben en la cartera, pero eso se mira en recorrer
  // y solo si el precio llega a su nivel: con cientos de acciones, mirarlo en todas era lo que
  // más tardaba, y como no se ejecuta nada entre una cosa y otra, da lo mismo.
  const ordenes = (e, sube) => {
    const { m, i } = e
    const lado = sube ? 1 : -1
    const canal = sube ? m.alto : m.bajo
    const primero = sube ? Math.min : Math.max
    const res = []
    if (cfg.sistema !== 2) {
      const v = e.virtual
      if (!v) res.push([canal[20][i], 1, { tipo: 'v_entra', lado }])
      else if (v.lado === -lado) res.push([primero(v.stop, canal[10][i]), 1, { tipo: 'v_sale' }])
    }
    for (const s of sistemasDe(cfg.sistema)) {
      const p = e.pos[s]
      if (!p) {
        const k = entradaDe(cfg, e, s)
        if (k && permite(e, lado) && !senalDoble(cfg, e, s, lado, canal[k][i], m.n[i])) res.push([canal[k][i], 0, { tipo: 'entra', sis: s, lado, k, limitada: true }])
      } else if (p.lado === lado) {
        if (p.unidades.length < cfg.maxUnidades) {
          res.push([p.unidades.at(-1).ref + lado * cfg.paso * p.n0, 0, { tipo: 'anade', sis: s, limitada: true }])
        }
      } else {
        const k = s === 1 ? 10 : 20
        const nivel = primero(p.stop, canal[k][i])
        res.push([nivel, 0, { tipo: 'sale', sis: s, motivo: nivel === p.stop ? 'stop' : `canal ${k}` }])
      }
    }
    return res
  }

  const apunte = (e, p, fecha, salida, motivo, bruto) => {
    const neto = bruto - p.financiacion - p.comision
    return {
      indice: e.m.info.id, sistema: p.sis, lado: p.lado > 0 ? 'largo' : 'corto', ruptura: p.ruptura,
      entrada: p.abierta, salida: fecha, dias: fecha ? noches(p.abierta, fecha) : null,
      n: p.n0, unidades: p.unidades.length, tamano: tamDe(p), nominal: tamDe(p) * precioMedio(p),
      tamanos: p.unidades.map(u => u.tam), precioEntrada: precioMedio(p), precioSalida: salida, motivo,
      bruto, financiacion: p.financiacion, comision: p.comision, neto, pctCapital: 100 * neto / p.capital,
      // en acciones, cuántas eran de las de entonces (la serie está ajustada por los splits)
      ...(e.m.info.lote ? { acciones: p.unidades.reduce((s, u) => s + u.tam / (u.f ?? 1), 0) } : {}),
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
      e.pos[accion.sis] = { sis: accion.sis, lado: accion.lado, n0: n, abierta: fecha, capital: valorAyer, ruptura: accion.k, stop: NaN, unidades: [], financiacion: 0, comision: 0 }
      marcar(e)
    }
    const p = e.pos[accion.sis]
    if (accion.tipo === 'entra' || accion.tipo === 'anade') {
      const tam = tamano(e)
      p.unidades.push({ fecha, ref: precio, precio: precio + p.lado * coste, tam, ...(m.factor ? { f: m.factor[e.i] } : {}) })
      p.stop = precio - p.lado * cfg.stopN * p.n0
      const comision = comisionDe(m, tam, e.i)
      efectivo -= comision
      p.comision += comision
      return
    }
    const salida = precio - p.lado * coste
    const bruto = resultadoDe(p, salida)
    // cada unidad es una posición en IG y se cierra con su propia orden
    const comision = p.unidades.reduce((s, u) => s + comisionDe(m, u.tam, e.i), 0)
    efectivo += bruto - comision
    p.comision += comision
    operaciones.push(apunte(e, p, fecha, salida, accion.motivo, bruto))
    e.pos[accion.sis] = null
    marcar(e)
  }

  // Lleva el precio de a a b y ejecuta, de la más cercana a la más lejana, las órdenes que
  // encuentra. En el salto de la noche (salto) todo se llena a la apertura.
  const recorrer = (e, a, b, salto) => {
    if (a === b) return
    const sube = b > a
    for (let vuelta = 0; vuelta < 20; vuelta++) {
      let mejor = null
      let cabeAqui = null
      for (const [nivel, prioridad, accion] of ordenes(e, sube)) {
        if (Number.isNaN(nivel) || (sube && nivel > b) || (!sube && nivel < b)) continue
        if (accion.limitada && !(cabeAqui ??= cabe(e, sube ? 1 : -1))) continue
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
    if (!cfg.financiacion) return
    const { m } = e
    for (const p of abiertasDe(e)) {
      const tipo = tipoEn(m.fechas[i - 1])
      const tasa = p.lado > 0 ? tipo + cfg.recargo - m.info.dividendo : cfg.recargo - tipo + m.info.dividendo
      const coste = tamDe(p) * m.c[i - 1] * tasa * noches(m.fechas[i - 1], m.fechas[i]) / 365
      efectivo -= coste
      p.financiacion += coste
      // el día que cotiza sin el dividendo: el largo lo cobra y el corto lo paga
      if (m.div?.[i]) {
        const dividendo = p.lado * tamDe(p) * m.div[i]
        efectivo += dividendo
        p.financiacion -= dividendo
      }
    }
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
    for (const e of abiertos) for (const p of abiertasDe(e)) nom += tamDe(p) * e.ultimo
    exposicion.push(nom / Math.max(v, 1e-9))
    valorAyer = v
  }

  const abiertas = est.flatMap(e => abiertasDe(e).map(p => apunte(e, p, null, e.ultimo, 'abierta', resultadoDe(p, e.ultimo))))
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
  // el día que la cuenta se queda a cero (con las comisiones de las acciones puede pasar): desde
  // ahí ya no abre nada, y el apalancamiento solo se mide mientras queda algo
  const k0 = eq.findIndex(v => v <= 0)
  const exposicion = k0 < 0 ? res.exposicion : res.exposicion.slice(0, k0)
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
    comisiones: suma(ops.map(o => o.comision ?? 0)),
    comisionesPct: brutoPositivo > 0 ? 100 * suma(ops.map(o => o.comision ?? 0)) / brutoPositivo : NaN,
    apalancamientoMedio: media(exposicion),
    apalancamientoMax: exposicion.reduce((a, x) => Math.max(a, x), -Infinity),
    quiebra: k0 < 0 ? null : res.curva[k0].date,
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
  const porIndice = new Map()
  for (const x of res.operaciones) {
    if (!porIndice.has(x.indice)) porIndice.set(x.indice, [])
    porIndice.get(x.indice).push(x)
  }
  return res.estados.map(({ m }) => {
    const o = porIndice.get(m.info.id) ?? []
    const netoDe = xs => suma(xs.map(x => x.neto))
    // las sesiones del periodo son un tramo seguido de la serie
    const a = bisectIzq(m.fechas, ini), b = bisectIzq(m.fechas, fin + '\uffff')
    let pico = -Infinity, dd = 0
    for (let k = a; k < b; k++) { pico = Math.max(pico, m.c[k]); dd = Math.min(dd, m.c[k] / pico - 1) }
    const anios = b - a > 1 ? noches(m.fechas[a], m.fechas[b - 1]) / 365.25 : NaN
    return {
      indice: m.info.id, nombre: m.info.nombre, grupo: m.info.grupo, desde: b > a ? m.fechas[a] : null,
      operaciones: o.length,
      ganan: o.filter(x => x.neto > 0).length,
      acierto: o.length ? 100 * o.filter(x => x.neto > 0).length / o.length : NaN,
      neto: netoDe(o),
      largos: netoDe(o.filter(x => x.lado === 'largo')),
      cortos: netoDe(o.filter(x => x.lado === 'corto')),
      s1: netoDe(o.filter(x => x.sistema === 1)),
      s2: netoDe(o.filter(x => x.sistema === 2)),
      financiacion: suma(o.map(x => x.financiacion)),
      comision: suma(o.map(x => x.comision ?? 0)),
      compraCagr: b - a > 1 ? 100 * ((m.c[b - 1] / m.c[a]) ** (1 / anios) - 1) : NaN,
      compraDD: 100 * dd,
    }
  })
}

// Lo mismo, sumado por grupo (en acciones, por sector), con cuántos mercados tiene y en
// cuántos llegó a operar. `filas`: las de resumenPorIndice, si ya están hechas
export function resumenPorGrupo(res, filas = resumenPorIndice(res)) {
  const grupos = new Map()
  for (const f of filas) {
    const g = grupos.get(f.grupo) ?? { grupo: f.grupo, mercados: 0, conOperaciones: 0, operaciones: 0, ganan: 0, neto: 0, largos: 0, cortos: 0, s1: 0, s2: 0, financiacion: 0, comision: 0 }
    g.mercados++
    if (f.operaciones) g.conOperaciones++
    for (const k of ['operaciones', 'ganan', 'neto', 'largos', 'cortos', 's1', 's2', 'financiacion', 'comision']) g[k] += f[k]
    grupos.set(f.grupo, g)
  }
  return [...grupos.values()].map(g => ({ ...g, acierto: g.operaciones ? 100 * g.ganan / g.operaciones : NaN })).sort((a, b) => b.neto - a.neto)
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

// ── Riesgo hasta los stops ──────────────────────────────────────────────────

// Lo que pierde una posición de k unidades si salta su stop, en N por unidad de riesgo. Cada
// unidad entra `paso` N más allá que la anterior y el stop de todas queda a `stopN` N de la
// última, así que la unidad i (desde 0) pierde stopN − (k − 1 − i)·paso: con 2 N y ½ N, 2 N
// con una unidad, 3,5 con dos, 4,5 con tres, 5 con cuatro o cinco y 4,5 con seis. No cuenta
// los huecos, que pueden pasar el stop.
export const nHastaStop = (k, stopN = CONFIG_TORTUGAS.stopN, paso = CONFIG_TORTUGAS.paso) =>
  (k > 0 ? k * stopN - paso * k * (k - 1) / 2 : 0)

// Lo peor que se pierde, en N por unidad de riesgo, si saltan a la vez todos los stops de un
// sentido: las unidades repartidas como peor convenga entre los índices (`grupos` son cuántos
// índices hay en cada grupo), con los límites por índice, por grupo y por sentido. Primero lo
// peor de cada grupo según cuántas unidades tenga y después el reparto entre grupos, las dos
// cosas con programación dinámica. También devuelve cuántas unidades caben como mucho. Con
// `sistemas` = 2 cada índice puede llevar dos pirámides a la vez, una por sistema, cada una con
// su stop.
export function peorHastaStops({ grupos, maxUnidades, maxGrupo, maxSentido, sistemas = 1, stopN = CONFIG_TORTUGAS.stopN, paso = CONFIG_TORTUGAS.paso }) {
  const repartir = (piezas, tope) => {
    let mejor = [0, ...new Array(tope).fill(-Infinity)]
    for (const pieza of piezas) {
      const sig = [...mejor]
      for (let u = 0; u <= tope; u++) {
        if (mejor[u] === -Infinity) continue
        for (let k = 1; k < pieza.length && u + k <= tope; k++) {
          if (pieza[k] > -Infinity) sig[u + k] = Math.max(sig[u + k], mejor[u] + pieza[k])
        }
      }
      mejor = sig
    }
    return mejor
  }
  const piramide = Array.from({ length: maxUnidades + 1 }, (_, k) => nHastaStop(k, stopN, paso))
  const indice = repartir(new Array(sistemas).fill(piramide), sistemas * maxUnidades)
  const porGrupo = grupos.filter(n => n > 0).map(n => repartir(new Array(n).fill(indice), Math.min(maxGrupo, maxSentido)))
  const total = repartir(porGrupo, maxSentido)
  const posibles = total.reduce((u, v, k) => (v > -Infinity ? k : u), 0)
  return { n: Math.max(0, ...total.filter(Number.isFinite)), unidades: posibles }
}

// Las órdenes stop para la próxima sesión de cada índice, a partir del estado al último
// cierre del backtest, con el tamaño de la unidad para `capital`. Con los dos sistemas a la
// vez, una fila por índice y sistema.
export function ordenesManana(res, capital) {
  const { cfg } = res
  return res.estados.flatMap(e => sistemasDe(cfg.sistema).map(s => {
    const { m } = e
    const n = m.nCierre.at(-1)
    const alto = k => Math.max(...m.h.slice(-k)), bajo = k => Math.min(...m.l.slice(-k))
    const unidad = cfg.riesgo * capital / n, lote = m.info.lote && m.info.lote * (m.factor?.at(-1) ?? 1)
    const fila = {
      indice: m.info.id, sistema: s, nombre: m.info.nombre, grupo: m.info.grupo, ultimoDia: m.fechas.at(-1), cierre: m.c.at(-1), n,
      unidad: lote ? Math.floor(unidad / lote + 1e-9) * lote : unidad,
      posicion: null, compra: null, venta: null, salida: null, filtro: false,
    }
    const p = e.pos[s]
    if (!p) {
      const k = entradaDe(cfg, e, s)
      const mm = cfg.media ? media(m.c.slice(-cfg.media)) : null
      fila.filtro = s === 1 && e.gano
      if (k && cfg.lados !== 'cortos' && (!cfg.media || m.c.at(-1) > mm) && !senalDoble(cfg, e, s, 1, alto(k), n)) fila.compra = { nivel: alto(k), k }
      if (k && cfg.lados !== 'largos' && (!cfg.media || m.c.at(-1) < mm) && !senalDoble(cfg, e, s, -1, bajo(k), n)) fila.venta = { nivel: bajo(k), k }
    } else {
      const k = s === 1 ? 10 : 20
      fila.posicion = { lado: p.lado > 0 ? 'largo' : 'corto', unidades: p.unidades.length, desde: p.abierta, medio: precioMedio(p) }
      fila.salida = p.lado > 0 ? Math.max(p.stop, bajo(k)) : Math.min(p.stop, alto(k))
      if (p.unidades.length < cfg.maxUnidades) {
        const anadido = { nivel: p.unidades.at(-1).ref + p.lado * cfg.paso * p.n0, k: null }
        if (p.lado > 0) fila.compra = anadido
        else fila.venta = anadido
      }
    }
    return fila
  }))
}

// ── Expediente para la revisión con Claude ──────────────────────────────────
// Lo que hace falta para juzgar si el resultado es sólido: las cifras del resumen, de dónde
// sale el beneficio (años, mercados, pirámide, lados, las mejores operaciones), las peores
// caídas y las dos mitades del periodo. Sin la lista de operaciones, que en acciones son
// miles: solo los extremos. Los números van redondeados para que el texto sea corto.

const r2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null)
const r0 = v => (Number.isFinite(v) ? Math.round(v) : null)

// Las caídas desde un máximo hasta recuperarlo, de la más honda a la menos
export function peoresCaidas(curva, cuantas = 5) {
  const caidas = []
  let pico = null, caida = null
  for (const p of curva) {
    if (!pico || p.valor >= pico.valor) {
      if (caida) caidas.push({ ...caida, recuperada: p.date })
      pico = p
      caida = null
    } else {
      const dd = p.valor / pico.valor - 1
      if (!caida || dd < caida.dd) caida = { desde: pico.date, fondo: p.date, dd, recuperada: null }
    }
  }
  if (caida) caidas.push(caida)
  const fin = curva.at(-1)?.date
  return caidas.sort((a, b) => a.dd - b.dd).slice(0, cuantas).map(c => ({
    desde: c.desde, fondo: c.fondo, recuperada: c.recuperada ?? 'aún no', caidaPct: r2(100 * c.dd),
    mesesBajoElMaximo: r0(noches(c.desde, c.recuperada ?? fin) / 30.44),
  }))
}

// Operaciones, acierto, neto y profit factor de un grupo de operaciones
function agregado(ops) {
  const ganado = suma(ops.filter(o => o.neto > 0).map(o => o.neto))
  const perdido = -suma(ops.filter(o => o.neto <= 0).map(o => o.neto))
  return {
    operaciones: ops.length,
    aciertoPct: ops.length ? r2(100 * ops.filter(o => o.neto > 0).length / ops.length) : null,
    netoEur: r0(ganado - perdido),
    profitFactor: perdido > 0 ? r2(ganado / perdido) : null,
  }
}

const agrupar = (ops, clave) => Object.fromEntries([...new Set(ops.map(clave))].map(k => [k, agregado(ops.filter(o => clave(o) === k))]))

// Rentabilidad, peor caída y operaciones cerradas de un tramo de la curva (de la sesión a a la b)
function tramo(res, a, b) {
  const curva = res.curva.slice(a, b + 1)
  const desde = curva[0].date, hasta = curva.at(-1).date
  const ini = curva[0].valor, fin = curva.at(-1).valor
  let pico = -Infinity, dd = 0
  for (const p of curva) { pico = Math.max(pico, p.valor); dd = Math.min(dd, p.valor / pico - 1) }
  const ops = res.operaciones.filter(o => (a === 0 || o.salida > desde) && o.salida <= hasta)
  return {
    desde, hasta,
    cagrPct: ini > 0 && fin > 0 && hasta > desde ? r2(100 * ((fin / ini) ** (365.25 / noches(desde, hasta)) - 1)) : null,
    maxDrawdownPct: r2(100 * dd),
    ...agregado(ops),
  }
}

const LIMITACIONES = {
  comun: 'Dentro de cada vela diaria se supone el camino apertura → mínimo → máximo → cierre si cierra por encima de la apertura, y al revés si no: cuando la entrada y el stop caen en la misma vela, el orden real pudo ser otro.',
  indices: [
    'Velas diarias del contado (Yahoo). El CFD cotiza casi 24 h, así que un stop puede saltar de noche en un nivel que el contado no marca.',
    'Yahoo trae el FTSE siempre con la apertura igual al cierre anterior, y el S&P y el Russell así en muchas sesiones antes de 2007: ahí no se ven los huecos de la noche.',
    'La financiación usa el tipo de EE. UU. a 3 meses para todos los índices. Comprar y mantener es el índice de precio, sin dividendos (salvo el DAX).',
  ],
  acciones: [
    'La lista es la de hoy del S&P 500: faltan las que salieron del índice o dejaron de cotizar (sesgo de supervivencia), así que el resultado sale mejor de lo que habría sido.',
    'Los resultados trimestrales abren huecos que pasan los stops. Las escisiones no vienen ajustadas y parecen caídas. Las cuentas en euros son dólares contados como euros.',
  ],
  futuros: [
    'Futuros de Yahoo empalmados hacia atrás en cada vencimiento: los precios antiguos no son los que cotizaban, pero sí lo que se movían. Las divisas, al contado, sin el diferencial de tipos.',
    'Las letras salen de 100 − tipo a 3 meses: su N es diminuta y su unidad lleva un nominal enorme, por eso aquí no hay tope de nominal. No se cobran intereses del dinero que no está en margen, como hacían las tortugas.',
  ],
}

// `universo`: indices | acciones | futuros. `variantes`: las filas de «Comparar variantes» si
// están hechas con estos mismos ajustes
export function expedienteBacktest(res, { universo, variantes = null } = {}) {
  const { cfg } = res
  const m = metricasTortugas(res)
  const acciones = universo === 'acciones'
  const juntos = cfg.sistema === '1+2'
  const ops = res.operaciones

  // en % del capital al entrar: en € una operación de 2020 pesa más que una de 1995 solo por
  // el interés compuesto
  const porPct = [...ops].sort((a, b) => b.pctCapital - a.pctCapital)
  const mejores = porPct.slice(0, 10)
  const totalPct = suma(ops.map(o => o.pctCapital))
  const delMejor = f => suma(porPct.slice(0, Math.max(1, Math.round(ops.length * f))).map(o => o.pctCapital))
  const apunte = o => ({
    mercado: o.indice, ...(juntos ? { sistema: o.sistema } : {}), lado: o.lado, entrada: o.entrada, salida: o.salida,
    dias: o.dias, unidades: o.unidades, motivo: o.motivo, pctCapital: r2(o.pctCapital), netoEur: r0(o.neto),
  })

  const filas = resumenPorIndice(res)
  const fila = f => ({
    mercado: acciones ? f.indice : f.nombre, grupo: f.grupo, desde: f.desde, operaciones: f.operaciones,
    aciertoPct: r2(f.acierto), netoEur: r0(f.neto),
    ...(cfg.lados === 'ambos' ? { largosEur: r0(f.largos), cortosEur: r0(f.cortos) } : {}),
    ...(juntos ? { s1Eur: r0(f.s1), s2Eur: r0(f.s2) } : {}),
    financiacionEur: r0(f.financiacion), ...(acciones ? { comisionEur: r0(f.comision) } : {}),
    comprarYMantenerCagrPct: r2(f.compraCagr), comprarYMantenerPeorCaidaPct: r2(f.compraDD),
  })
  const conOperaciones = filas.filter(f => f.operaciones).sort((a, b) => b.neto - a.neto)
  const mitad = Math.floor((res.curva.length - 1) / 2)

  return {
    universo: { indices: 'índices de contado (CFD)', acciones: 'acciones del S&P 500 (CFD)', futuros: 'los futuros de las tortugas de 1983' }[universo],
    mercados: acciones
      ? { acciones: filas.length, conAlgunaOperacion: conOperaciones.length, sectores: new Set(filas.map(f => f.grupo)).size }
      : filas.map(f => f.nombre),
    moneda: 'EUR. Los € por mercado, lado, sistema o pirámide llevan el interés compuesto: pesan más los años recientes',
    configuracion: {
      sistema: juntos ? 'S1 + S2' : `S${cfg.sistema}`,
      lados: cfg.lados,
      riesgoPorUnidadPctDelCapital: Math.round(100_000 * cfg.riesgo) / 1000,
      maxUnidadesPorMercado: cfg.maxUnidades,
      maxUnidadesPorGrupoYSentido: cfg.maxGrupo,
      maxUnidadesPorSentido: cfg.maxSentido,
      anadeCadaN: cfg.paso,
      stopEnN: cfg.stopN,
      deslizamientoEnN: cfg.deslizN,
      financiacion: cfg.financiacion ? `tipo a 3 meses + ${r2(100 * cfg.recargo)} % anual` : 'sin coste overnight',
      soloAFavorDeLaMedia: cfg.media || 'no',
      reduceEnDrawdown: cfg.reduccionDD,
      topeDeApalancamiento: cfg.apalancamiento || 'sin tope',
      ...(acciones ? { comisiones: cfg.comisiones, soloDesdeQueEntroEnElIndice: cfg.soloEnIndice } : {}),
    },
    periodo: { desde: res.curva[0].date, hasta: res.curva.at(-1).date, anios: r2(noches(res.curva[0].date, res.curva.at(-1).date) / 365.25) },
    resultado: {
      capitalInicialEur: cfg.capital,
      capitalFinalEur: r0(m.capitalFinal),
      cagrPct: r2(m.cagr),
      maxDrawdownPct: r2(m.maxDD),
      mar: r2(m.mar),
      sharpe: r2(m.sharpe),
      drawdownMasLargoAnios: r2(m.ddMasLargo),
      operaciones: m.operaciones,
      aciertoPct: r2(m.acierto),
      profitFactor: r2(m.profitFactor),
      ganadoraMediaEntrePerdedoraMedia: r2(m.ganadoraPerdedora),
      diasMediosPorOperacion: r0(m.diasMedios),
      diasMediosGanadoras: r0(media(ops.filter(o => o.neto > 0).map(o => o.dias))),
      diasMediosPerdedoras: r0(media(ops.filter(o => o.neto <= 0).map(o => o.dias))),
      financiacionEur: r0(m.financiacion),
      financiacionPctDelBrutoGanado: r2(m.financiacionPct),
      ...(m.comisiones > 0 ? { comisionesEur: r0(m.comisiones), comisionesPctDelBrutoGanado: r2(m.comisionesPct) } : {}),
      apalancamientoMedio: r2(m.apalancamientoMedio),
      apalancamientoMax: r2(m.apalancamientoMax),
      ...(m.quiebra ? { cuentaACeroEl: m.quiebra } : {}),
      posicionesAbiertas: res.abiertas.length,
    },
    rentabilidadPorAnioPct: Object.fromEntries(rentabilidadAnual(res).map(a => [a.anio, r2(a.pct)])),
    peoresCaidas: peoresCaidas(res.curva),
    mitadesDelPeriodo: [tramo(res, 0, mitad), tramo(res, mitad, res.curva.length - 1)],
    concentracion: {
      medida: 'suma del resultado de cada operación en % del capital al entrar (sin el efecto del interés compuesto)',
      todas: r2(totalPct),
      soloEl1PorCientoMejor: r2(delMejor(0.01)),
      soloEl5PorCientoMejor: r2(delMejor(0.05)),
      soloEl10PorCientoMejor: r2(delMejor(0.1)),
      todasMenosLas10Mejores: r2(totalPct - suma(mejores.map(o => o.pctCapital))),
    },
    mejoresOperaciones: mejores.map(apunte),
    peoresOperaciones: porPct.slice(-10).reverse().filter(o => !mejores.includes(o)).map(apunte),
    porMotivoDeSalida: agrupar(ops, o => o.motivo),
    ...(cfg.lados === 'ambos' ? { porLado: agrupar(ops, o => o.lado) } : {}),
    ...(juntos ? { porSistema: agrupar(ops, o => `S${o.sistema}`) } : {}),
    porUnidadesAlCerrar: porUnidades(res).map(f => ({ unidades: f.unidades, operaciones: f.n, aciertoPct: r2(100 * f.ganan / f.n), netoEur: r0(f.neto) })),
    ...(acciones
      ? {
        porSector: resumenPorGrupo(res, filas).map(g => ({
          sector: g.grupo, acciones: g.mercados, conOperaciones: g.conOperaciones, operaciones: g.operaciones,
          aciertoPct: r2(g.acierto), netoEur: r0(g.neto), financiacionEur: r0(g.financiacion), comisionEur: r0(g.comision),
        })),
        accionesQueMasDejan: conOperaciones.slice(0, 10).map(fila),
        accionesQueMasQuitan: conOperaciones.slice(10).slice(-10).reverse().map(fila),
      }
      : { porMercado: filas.map(fila) }),
    ...(variantes?.length ? {
      variantes: variantes.map(v => ({
        sistema: v.sistema === '1+2' ? 'S1 + S2' : `S${v.sistema}`, lados: v.lados, maxUnidades: v.unidades,
        ...(v.actual ? { esLaDeArriba: true } : {}),
        cagrPct: r2(v.m?.cagr), maxDrawdownPct: r2(v.m?.maxDD), mar: r2(v.m?.mar), sharpe: r2(v.m?.sharpe),
        operaciones: v.m?.operaciones ?? null, profitFactor: r2(v.m?.profitFactor), financiacionPctDelBruto: r2(v.m?.financiacionPct),
      })),
    } : {}),
    limitacionesDeLosDatos: [LIMITACIONES.comun, ...(LIMITACIONES[universo] ?? [])],
  }
}
