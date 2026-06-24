import { useState, useEffect } from 'react'

const ITEMS = [
  { symbol: '^GDAXI', label: 'DAX'      },
  { symbol: '^FTSE',  label: 'FTSE'     },
  { symbol: '^GSPC',  label: 'S&P 500'  },
  { symbol: '^NDX',   label: 'Nasdaq'   },
  { symbol: '^DJI',   label: 'Dow Jones'},
  { symbol: 'GC=F',   label: 'Oro'      },
  { symbol: 'SI=F',   label: 'Plata'    },
  { symbol: 'CL=F',   label: 'WTI'      },
]

function fmt(price) {
  if (price == null) return '—'
  return price.toLocaleString('en-US', {
    minimumFractionDigits: price < 100 ? 2 : 2,
    maximumFractionDigits: price < 100 ? 3 : 2,
  })
}

export default function QuoteBar() {
  const [quotes, setQuotes] = useState({})
  const [error,  setError]  = useState(false)

  useEffect(() => {
    let alive = true
    function load() {
      fetch('/api/quotes')
        .then(r => r.json())
        .then(data => {
          if (!alive) return
          if (Array.isArray(data)) {
            const map = {}
            data.forEach(q => { map[q.symbol] = q })
            setQuotes(map)
            setError(false)
          }
        })
        .catch(() => { if (alive) setError(true) })
    }
    load()
    const id = setInterval(load, 30_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  if (error || !Object.keys(quotes).length) return null

  return (
    <div className="quote-bar">
      {ITEMS.map(({ symbol, label }) => {
        const q = quotes[symbol]
        if (!q) return null
        const up = (q.changePct ?? 0) >= 0
        return (
          <div key={symbol} className="quote-chip">
            <span className="quote-label">{label}</span>
            <span className="quote-price">{fmt(q.price)}</span>
            <span className={`quote-change ${up ? 'up' : 'down'}`}>
              {up ? '+' : ''}{q.changePct?.toFixed(2)}%
            </span>
          </div>
        )
      })}
    </div>
  )
}
