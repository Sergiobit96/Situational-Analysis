import { useState, useEffect } from 'react'

const ITEMS = [
  { symbol: '^GDAXI', label: 'DAX',       close: '17:30' },
  { symbol: '^FTSE',  label: 'FTSE',      close: '17:30' },
  { symbol: '^GSPC',  label: 'S&P 500',   close: '22:00' },
  { symbol: '^NDX',   label: 'Nasdaq',    close: '22:00' },
  { symbol: '^DJI',   label: 'Dow Jones', close: '22:00' },
  { symbol: 'GC=F',   label: 'Oro',       close: null    },
  { symbol: 'SI=F',   label: 'Plata',     close: null    },
  { symbol: 'CL=F',   label: 'WTI',       close: null    },
]

function fmt(price) {
  if (price == null) return '—'
  return price.toLocaleString('en-US', {
    minimumFractionDigits: 2,
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
      {ITEMS.map(({ symbol, label, close }) => {
        const q  = quotes[symbol]
        if (!q) return null
        const up = (q.changePct ?? 0) >= 0
        return (
          <div key={symbol} className="quote-chip">
            <span className="quote-label">{label}</span>
            <div className="quote-row">
              <span className="quote-price">{fmt(q.price)}</span>
              <span className={`quote-change ${up ? 'up' : 'down'}`}>
                {up ? '+' : ''}{q.changePct?.toFixed(2)}%
              </span>
            </div>
            {q.prevClose != null && (
              <div className="quote-prev">
                <span className="quote-prev-val">{fmt(q.prevClose)}</span>
                {close && <span className="quote-prev-time">{close}</span>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
