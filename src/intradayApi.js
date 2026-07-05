// Tickers que Railway maneja via Dukascopy — el resto va a /api/yf-intraday (Vercel)
export const DUKA_TICKERS = new Set(['^GSPC', '^NDX', '^DJI', '^GDAXI', '^FTSE', '^RUT', '^N225', 'XAUUSD', 'XAGUSD', 'USOIL'])

export function intradayUrl(tkr, date, timeframe) {
  if (DUKA_TICKERS.has(tkr)) {
    return `/api/velas15m?${new URLSearchParams({ ticker: tkr, date, timeframe })}`
  }
  return `/api/yf-intraday?${new URLSearchParams({ ticker: tkr, date })}`
}
