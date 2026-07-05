// Vercel serverless function — batch quotes from CNBC quote service.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

// Mapa: símbolo interno → símbolo CNBC
const INSTRUMENTS = [
  { id: '^GDAXI', cnbc: '.GDAXI' },
  { id: '^FTSE',  cnbc: '.FTSE'  },
  { id: '^GSPC',  cnbc: '.SPX'   },
  { id: '^NDX',   cnbc: '.NDX'   },
  { id: '^DJI',   cnbc: '.DJI'   },
  { id: '^RUT',   cnbc: '.RUT'   },
  { id: '^N225',  cnbc: '.N225'  },
  { id: 'GC=F',   cnbc: '@GC.1'  },
  { id: 'SI=F',   cnbc: '@SI.1'  },
  { id: 'CL=F',   cnbc: '@CL.1'  },
]

export default async function handler(req, res) {
  try {
    const cnbcSymbols = INSTRUMENTS.map(i => i.cnbc).join('|')
    const fields = 'symbol,last,change,changePct,previous_day_closing,open,name'
    const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol` +
      `?symbols=${encodeURIComponent(cnbcSymbols)}` +
      `&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1` +
      `&outputFields=${fields}`

    const resp = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Referer':    'https://www.cnbc.com/',
        'Origin':     'https://www.cnbc.com',
        'Accept':     'application/json, text/javascript, */*',
      },
    })
    const json   = await resp.json()
    const quotes = json.FormattedQuoteResult?.FormattedQuote ?? []

    // CNBC devuelve números formateados: "7,365.46", "-1.44%"
    const num = s => parseFloat(String(s ?? '').replace(/,/g, '').replace('%', ''))

    // Índice inverso: símbolo CNBC → id interno
    const byId = {}
    INSTRUMENTS.forEach(i => { byId[i.cnbc] = i.id })

    const result = quotes.map(q => ({
      symbol:    byId[q.symbol] ?? q.symbol,
      price:     num(q.last),
      change:    num(q.change),
      changePct: num(q.change_pct),
      prevClose: num(q.previous_day_closing ?? q.open),
    })).filter(q => !isNaN(q.price))

    res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=10')
    res.json(result)
  } catch (err) {
    console.error('[quotes/cnbc]', err.message)
    res.status(500).json({ error: err.message })
  }
}
