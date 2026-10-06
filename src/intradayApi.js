// Tickers que Railway maneja via Dukascopy — el resto va a /api/yf-intraday (Vercel)
export const DUKA_TICKERS = new Set(['^GSPC', '^NDX', '^DJI', '^GDAXI', '^FTSE', '^RUT', '^N225', 'XAUUSD', 'XAGUSD', 'USOIL'])

export function intradayUrl(tkr, date, timeframe) {
  if (DUKA_TICKERS.has(tkr)) {
    return `/api/velas15m?${new URLSearchParams({ ticker: tkr, date, timeframe })}`
  }
  return `/api/yf-intraday?${new URLSearchParams({ ticker: tkr, date, timeframe })}`
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
