// Vercel serverless function — proxies Yahoo Finance intraday data.
// Runs on Vercel's IPs (not Railway), bypassing Yahoo Finance's datacenter IP block.
// Vercel API routes take priority over vercel.json rewrites, so this is NOT forwarded to Railway.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

let _auth = null
let _authTs = 0

async function getAuth() {
  if (_auth && Date.now() - _authTs < 3_600_000) return _auth
  try {
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
    })
    const raw    = r1.headers.get('set-cookie') ?? ''
    const cookie = raw.split(',').map(c => c.split(';')[0].trim()).filter(Boolean).join('; ')
    const r2     = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, 'Cookie': cookie },
    })
    const crumb = (await r2.text()).trim()
    if (crumb && crumb.length < 60 && !crumb.startsWith('<')) {
      _auth  = { cookie, crumb }
      _authTs = Date.now()
    }
  } catch {}
  return _auth
}

const getMadridDate = t =>
  new Date(t * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' })

export default async function handler(req, res) {
  const { ticker, date } = req.query ?? {}
  if (!ticker || !date) return res.status(400).json({ error: 'ticker y date requeridos' })

  try {
    const auth  = await getAuth()
    const p1    = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000)
    const p2    = p1 + 2 * 86400
    const sym   = encodeURIComponent(ticker)
    const crumb = auth ? `&crumb=${encodeURIComponent(auth.crumb)}` : ''
    const hdrs  = auth ? { 'User-Agent': UA, 'Cookie': auth.cookie } : { 'User-Agent': UA }
    const url   = `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=15m&period1=${p1}&period2=${p2}${crumb}`

    const resp = await fetch(url, { headers: hdrs })
    const json = await resp.json()
    const r    = json.chart?.result?.[0]

    if (!r) return res.json({ ticker, date, velas: [], fuente: 'Yahoo 15m' })

    const ts    = r.timestamp ?? []
    const q     = r.indicators.quote[0]
    const velas = []
    for (let i = 0; i < ts.length; i++) {
      if (q.open[i] == null || q.close[i] == null) continue
      if (getMadridDate(ts[i]) !== date) continue
      velas.push({
        time:   ts[i],
        open:   q.open[i],
        high:   q.high[i],
        low:    q.low[i],
        close:  q.close[i],
        volume: q.volume?.[i] ?? 0,
      })
    }

    res.json({ ticker, date, velas, fuente: 'Yahoo 15m' })
  } catch (err) {
    console.error('[yf-intraday]', err.message)
    res.status(500).json({ error: err.message })
  }
}
