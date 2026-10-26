// ── Riesgo correlacionado entre los bots ──────────────────────────────────────────────
// Cada bot limita su propio riesgo, pero el Nasdaq, el S&P y el Dow comprados a la vez por el
// SRS, la Rule of 4 y las tortugas son en la práctica una sola apuesta. Aquí se juntan las
// posiciones abiertas de todos los bots por grupo de mercados que se mueven juntos y por
// sentido, y una entrada nueva no se manda si con ella lo que se perdería al saltar a la vez
// todos los stops de ese grupo y sentido pasa de un `maxPct` % del saldo de la cuenta.
// El riesgo de una posición es lo que queda hasta su stop: con el stop ya en ganancias, 0.
// Solo frena las entradas: los añadidos de la pirámide siguen sus propias reglas.
//
// Las divisas cuentan como dólar: comprar EUR/USD es vender dólares, y comprar USD/JPY,
// comprarlos. Las materias primas y los índices van por `grupos` (los de las tortugas: ticker → grupo).

export const MAX_RIESGO_GRUPO_PCT = 6
const DOLAR_DETRAS = new Set(['EURUSD', 'GBPUSD', 'AUDUSD'])   // el dólar es la segunda divisa
const DOLAR_DELANTE = new Set(['USDJPY', 'USDCAD', 'USDCHF'])
const NOMBRES_GRUPO = { EEUU: 'índices de EE. UU.', Europa: 'índices europeos', Asia: 'el Nikkei', Metales: 'metales', 'Energía': 'energía', Blandas: 'materias blandas', Granos: 'granos' }
const contrario = lado => (lado === 'largo' ? 'corto' : 'largo')

// El grupo y el sentido en el que cuenta una posición
export function exposicionDe(ticker, lado, grupos = {}) {
  if (DOLAR_DETRAS.has(ticker)) return { grupo: 'Dólar', lado: contrario(lado) }
  if (DOLAR_DELANTE.has(ticker)) return { grupo: 'Dólar', lado }
  return { grupo: grupos[ticker] ?? ticker, lado }
}
function describir({ grupo, lado }) {
  if (grupo === 'Dólar') return `dólar ${lado === 'largo' ? 'comprado' : 'vendido'}`
  return `${NOMBRES_GRUPO[grupo] ?? grupo} ${lado === 'largo' ? 'en largo' : 'en corto'}`
}

// Lo que se pierde si salta el stop de las unidades abiertas, en euros (0 si el stop ya está en ganancias)
export function riesgoHastaStop({ lado, unidades, stop = null, valorPunto = 1, cambioAEur = 1 }) {
  const dir = lado === 'largo' ? 1 : -1
  return unidades.filter(u => !u.salida).reduce((s, u) => {
    const st = u.stop ?? stop
    return st == null ? s : s + Math.max(0, dir * (u.entrada - st)) * u.tamano * valorPunto * cambioAEur
  }, 0)
}

export function crearCartera({ grupos = {}, maxPct = MAX_RIESGO_GRUPO_PCT } = {}) {
  // nombre del bot → () => [{ ticker, lado, riesgoEur, unidades: [{ dealId, stop, tamano }] }] con sus
  // posiciones abiertas (las unidades, para la conciliación con IG: server/conciliacion.js)
  const bots = new Map()

  function posiciones() {
    return [...bots].flatMap(([bot, abiertas]) => {
      try { return abiertas().map(p => ({ ...p, bot })) } catch { return [] }
    })
  }

  // Las posiciones abiertas que cuentan con una entrada de `ticker` en `lado`
  function mismasQue(ticker, lado) {
    const e = exposicionDe(ticker, lado, grupos)
    const mismas = posiciones().filter(p => {
      const x = exposicionDe(p.ticker, p.lado, grupos)
      return x.grupo === e.grupo && x.lado === e.lado && p.riesgoEur > 0
    })
    return { e, mismas, abierto: mismas.reduce((s, p) => s + p.riesgoEur, 0) }
  }

  // null si la entrada cabe; si no, por qué no
  function noCabe({ ticker, lado, riesgoEur, saldo }) {
    if (!(saldo > 0) || !(maxPct > 0)) return null
    const { e, mismas, abierto } = mismasQue(ticker, lado)
    const tope = saldo * maxPct / 100
    if (abierto + riesgoEur <= tope) return null
    const quien = [...new Set(mismas.map(p => p.bot))].join(', ')
    return `con ${describir(e)} ya hay ${Math.round(abierto)} € en riesgo (${quien}) y con esta serían ${Math.round(abierto + riesgoEur)} €,`
      + ` más del ${String(maxPct).replace('.', ',')}% del saldo (${Math.round(tope)} €)`
  }

  return {
    registrar(bot, abiertas) { bots.set(bot, abiertas) },
    noCabe,
    estado: () => ({ maxPct, posiciones: posiciones() }),
  }
}
