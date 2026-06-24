// Vercel serverless function — batch quotes from Yahoo Finance.
// Runs on Vercel IPs (not Railway), so it's not blocked by Yahoo Finance.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

const SYMBOLS = ['^GDAXI', '^FTSE', '^GSPC', '^NDX', '^DJI', 'GC=F', 'SI=F', 'CL=F']

let _auth = null, _authTs = 0

async function getAuth() {
  if (_auth && Date.now() - _authTs < 3_600_000) return _auth
  try {
    const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'follow' })
    const raw    = r1.headers.get('set-cookie') ?? ''
    const cookie = raw.split(',').map(c => c.split(';')[0].trim()).filter(Boolean).join('; ')
    const r2     = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, 'Cookie': cookie },
    })
    const crumb = (await r2.text()).trim()
    if (crumb && crumb.length < 60 && !crumb.startsWith('<')) {
      _auth = { cookie, crumb }; _authTs = Date.now()
    }
  } catch {}
  return _auth
}

export default async function handler(req, res) {
  try {
    const auth   = await getAuth()
    const syms   = encodeURIComponent(SYMBOLS.join(','))
    const crumb  = auth ? `&crumb=${encodeURIComponent(auth.crumb)}` : ''
    const hdrs   = auth ? { 'User-Agent': UA, 'Cookie': auth.cookie } : { 'User-Agent': UA }
    const url    = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${syms}${crumb}`

    const resp   = await fetch(url, { headers: hdrs })
    const json   = await resp.json()
    const result = (json.quoteResponse?.result ?? []).map(q => ({
      symbol:     q.symbol,
      price:      q.regularMarketPrice,
      change:     q.regularMarketChange,
      changePct:  q.regularMarketChangePercent,
      prevClose:  q.regularMarketPreviousClose,
    }))

    res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=10')
    res.json(result)
  } catch (err) {
    console.error('[quotes]', err.message)
    res.status(500).json({ error: err.message })
  }
}
