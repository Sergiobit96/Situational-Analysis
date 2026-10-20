// Tickers que Railway maneja via Dukascopy — el resto va a /api/yf-intraday (Vercel)
export const DUKA_TICKERS = new Set(['^GSPC', '^NDX', '^DJI', '^GDAXI', '^FTSE', '^RUT', '^N225', 'XAUUSD', 'XAGUSD', 'USOIL'])

export function intradayUrl(tkr, date, timeframe) {
  if (DUKA_TICKERS.has(tkr)) {
    return `/api/velas15m?${new URLSearchParams({ ticker: tkr, date, timeframe })}`
  }
  return `/api/yf-intraday?${new URLSearchParams({ ticker: tkr, date, timeframe })}`
}

// Sesiones que van en cada lote: pocas para que la primera tanda se pinte enseguida, y
// por debajo del máximo del servidor (60), que es lo que se usa para encargar
const POR_LOTE = 25
const POR_ENCARGO = 60
// Cada cuánto se vuelve a mirar si la cola del feed ya ha bajado lo que falta
const ESPERA_COLA_MS = 3_000

// Una pausa que se corta al cancelar
function pausa(ms, signal) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason) }, { once: true })
  })
}

// El lote de esas fechas, o null si el servidor no lo sirve (uno anterior a /lote) o falla
async function pedirLote(tkr, fechas, timeframe, signal, extra) {
  try {
    const q = new URLSearchParams({ ticker: tkr, timeframe, fechas: fechas.join(','), ...extra })
    const r = await fetch(`/api/velas15m/lote?${q}`, { signal })
    return r.ok ? await r.json() : null
  } catch (e) {
    if (e.name === 'AbortError') throw e
    return null
  }
}

async function pedirSuelta(tkr, fecha, timeframe, signal) {
  try {
    const d = await (await fetch(intradayUrl(tkr, fecha, timeframe), { signal })).json()
    return { fecha, velas: d.velas ?? [], fuente: d.fuente ?? null }
  } catch (e) {
    if (e.name === 'AbortError') throw e
    return { fecha, velas: [], fuente: null }
  }
}

// Las velas de muchas sesiones, en el orden de `fechas` y a medida que llegan. Lo que el
// servidor ya tiene guardado sale en lotes de una sola petición. Lo que falta se encarga
// de entrada a la cola del feed del servidor, que lo baja al ritmo que aguanta Dukascopy
// y sin fallbacks (una barra de Yahoo o la diaria no sirven para analizar una sesión), y
// aquí se espera a que llegue; `alEsperar(cola)` dice cómo va mientras tanto. Si se
// cancela, el servidor sigue bajando lo encargado y la próxima vez ya estará. Solo la
// sesión de hoy, y lo que no es de Dukascopy, se piden una a una con /api/velas15m.
// Cancelar lanza el AbortError; cualquier otro fallo deja esa sesión sin velas.
export async function* velasDeSesiones(tkr, fechas, timeframe, signal, alEsperar) {
  const conLote = DUKA_TICKERS.has(tkr)
  // En segundo plano, para no retrasar la primera tanda cuando todo está en caché, y del
  // último trozo al primero: cada encargo pasa delante del anterior, así que la cola acaba
  // en el orden en que se va a pintar. Cada consulta de abajo vuelve a adelantar lo que se
  // está esperando, así que un encargo que llegue tarde no lo retrasa.
  if (conLote) {
    (async () => {
      for (let i = Math.floor((fechas.length - 1) / POR_ENCARGO) * POR_ENCARGO; i >= 0; i -= POR_ENCARGO) {
        if (!await pedirLote(tkr, fechas.slice(i, i + POR_ENCARGO), timeframe, signal, { soloEncolar: '1' })) break
      }
    })().catch(() => {})
  }
  for (let i = 0; i < fechas.length; i += POR_LOTE) {
    const bloque = fechas.slice(i, i + POR_LOTE)
    let k = 0
    while (k < bloque.length) {
      const r = conLote ? await pedirLote(tkr, bloque.slice(k), timeframe, signal, { encolar: '1' }) : null
      if (!r) {
        for (const fecha of bloque.slice(k)) yield await pedirSuelta(tkr, fecha, timeframe, signal)
        break
      }
      const pendientes = new Set(r.pendientes ?? [])
      const sinDatos   = new Set(r.sinDatos ?? [])
      while (k < bloque.length && !pendientes.has(bloque[k])) {
        const fecha = bloque[k++]
        yield r.sesiones?.[fecha] ? { fecha, ...r.sesiones[fecha] }
          : sinDatos.has(fecha) ? { fecha, velas: [], fuente: null }
          : await pedirSuelta(tkr, fecha, timeframe, signal)
      }
      if (k < bloque.length) {
        alEsperar?.(r.cola ?? null)
        await pausa(ESPERA_COLA_MS, signal)
      }
    }
  }
}

// Instrumentos con datos de Dukascopy, con su nombre para la interfaz
export const INSTRUMENTOS = [
  { label: 'DAX',          value: '^GDAXI' },
  { label: 'FTSE',         value: '^FTSE'  },
  { label: 'Nasdaq',       value: '^NDX'   },
  { label: 'Dow Jones',    value: '^DJI'   },
  { label: 'S&P',          value: '^GSPC'  },
  { label: 'Russell 2000', value: '^RUT'   },
  { label: 'Nikkei',       value: '^N225'  },
  { label: 'Oro',          value: 'XAUUSD' },
  { label: 'Plata',        value: 'XAGUSD' },
  { label: 'Petróleo',     value: 'USOIL'  },
]
