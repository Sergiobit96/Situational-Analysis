// Tickers que Railway maneja via Dukascopy — el resto va a /api/yf-intraday (Vercel)
export const DUKA_TICKERS = new Set(['^GSPC', '^NDX', '^DJI', '^GDAXI', '^FTSE', '^RUT', '^N225', 'XAUUSD', 'XAGUSD', 'USOIL'])

export function intradayUrl(tkr, date, timeframe) {
  if (DUKA_TICKERS.has(tkr)) {
    return `/api/velas15m?${new URLSearchParams({ ticker: tkr, date, timeframe })}`
  }
  return `/api/yf-intraday?${new URLSearchParams({ ticker: tkr, date, timeframe })}`
}

// Sesiones que van en cada lote: pocas para que la primera tanda se pinte enseguida, y
// por debajo del máximo del servidor
const POR_LOTE = 25

// Las velas de muchas sesiones, en el orden de `fechas` y a medida que llegan. Lo que el
// servidor ya tiene guardado sale en lotes de una sola petición; solo lo que falta se
// pide sesión a sesión y en serie, que es lo que aguanta el límite por IP de Dukascopy.
// Cancelar lanza el AbortError; cualquier otro fallo deja esa sesión sin velas.
export async function* velasDeSesiones(tkr, fechas, timeframe, signal) {
  for (let i = 0; i < fechas.length; i += POR_LOTE) {
    const bloque = fechas.slice(i, i + POR_LOTE)
    let guardadas = {}
    if (DUKA_TICKERS.has(tkr)) {
      try {
        const q = new URLSearchParams({ ticker: tkr, timeframe, fechas: bloque.join(',') })
        const r = await fetch(`/api/velas15m/lote?${q}`, { signal })
        if (r.ok) guardadas = (await r.json()).sesiones ?? {}
      } catch (e) {
        if (e.name === 'AbortError') throw e
      }
    }
    for (const fecha of bloque) {
      let datos = guardadas[fecha]
      if (!datos) {
        try {
          const d = await (await fetch(intradayUrl(tkr, fecha, timeframe), { signal })).json()
          datos = { velas: d.velas ?? [], fuente: d.fuente ?? null }
        } catch (e) {
          if (e.name === 'AbortError') throw e
          datos = { velas: [], fuente: null }
        }
      }
      yield { fecha, ...datos }
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
