// ── Eventos económicos de alto impacto ────────────────────────────────────
// Fuente: ForexFactory (JSON público) + fechas históricas hardcodeadas
// FF cubre esta semana / la pasada / la próxima.
// Para fechas anteriores usamos el histórico curado.

// ── FOMC (Fed rate decision, día del comunicado) ───────────────────────────
const FOMC = [
  '2021-01-27','2021-03-17','2021-04-28','2021-06-16',
  '2021-07-28','2021-09-22','2021-11-03','2021-12-15',
  '2022-02-02','2022-03-16','2022-05-04','2022-06-15',
  '2022-07-27','2022-09-21','2022-11-02','2022-12-14',
  '2023-02-01','2023-03-22','2023-05-03','2023-06-14',
  '2023-07-26','2023-09-20','2023-11-01','2023-12-13',
  '2024-01-31','2024-03-20','2024-05-01','2024-06-12',
  '2024-07-31','2024-09-18','2024-11-07','2024-12-18',
  '2025-01-29','2025-03-19','2025-05-07','2025-06-18',
  '2025-07-30','2025-09-17','2025-10-29','2025-12-10',
]

// ── CPI EE.UU. (BLS release dates) ────────────────────────────────────────
const CPI_USD = [
  '2021-01-13','2021-02-10','2021-03-10','2021-04-13',
  '2021-05-12','2021-06-10','2021-07-13','2021-08-11',
  '2021-09-14','2021-10-13','2021-11-10','2021-12-10',
  '2022-01-12','2022-02-10','2022-03-10','2022-04-12',
  '2022-05-11','2022-06-10','2022-07-13','2022-08-10',
  '2022-09-13','2022-10-13','2022-11-10','2022-12-13',
  '2023-01-12','2023-02-14','2023-03-14','2023-04-12',
  '2023-05-10','2023-06-13','2023-07-12','2023-08-10',
  '2023-09-13','2023-10-12','2023-11-14','2023-12-12',
  '2024-01-11','2024-02-13','2024-03-12','2024-04-10',
  '2024-05-15','2024-06-12','2024-07-11','2024-08-14',
  '2024-09-11','2024-10-10','2024-11-13','2024-12-11',
  '2025-01-15','2025-02-12','2025-03-12','2025-04-10',
  '2025-05-13','2025-06-11','2025-07-15','2025-08-13',
  '2025-09-10','2025-10-14','2025-11-12','2025-12-10',
]

// ── ECB (rate decision) ────────────────────────────────────────────────────
const ECB = [
  '2021-01-21','2021-03-11','2021-04-22','2021-06-10',
  '2021-07-22','2021-09-09','2021-10-28','2021-12-16',
  '2022-02-03','2022-03-10','2022-04-14','2022-06-09',
  '2022-07-21','2022-09-08','2022-10-27','2022-12-15',
  '2023-02-02','2023-03-16','2023-05-04','2023-06-15',
  '2023-07-27','2023-09-14','2023-10-26','2023-12-14',
  '2024-01-25','2024-03-07','2024-04-11','2024-06-06',
  '2024-07-18','2024-09-12','2024-10-17','2024-12-12',
  '2025-01-30','2025-03-06','2025-04-17','2025-06-05',
  '2025-07-24','2025-09-11','2025-10-30','2025-12-18',
]

// ── NFP (primer viernes de cada mes, ~95% exacto) ─────────────────────────
function calcNFP(yearFrom, yearTo) {
  const dates = []
  for (let y = yearFrom; y <= yearTo; y++) {
    for (let m = 0; m < 12; m++) {
      const d = new Date(Date.UTC(y, m, 1))
      while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1)
      dates.push(d.toISOString().slice(0, 10))
    }
  }
  return dates
}
const NFP = calcNFP(2021, 2026)

// ── Palabras clave para detectar eventos en ForexFactory ──────────────────
const FF_KEYWORDS = {
  'FOMC': ['Federal Funds Rate', 'FOMC Statement', 'FOMC Meeting'],
  'CPI':  ['CPI', 'Consumer Price Index'],
  'NFP':  ['Non-Farm Payrolls', 'Nonfarm Payrolls', 'NFP'],
  'ECB':  ['ECB', 'Main Refinancing Rate', 'Deposit Facility Rate'],
  'PPI':  ['PPI', 'Producer Price Index'],
  'GDP':  ['GDP', 'Gross Domestic Product'],
  'PMI':  ['PMI', 'Purchasing Managers'],
}
const FF_COUNTRIES = {
  'FOMC': 'USD', 'CPI': null, 'NFP': 'USD',
  'ECB':  'EUR', 'PPI': 'USD', 'GDP': null, 'PMI': null,
}

// ── Índice: fecha → [eventos] ──────────────────────────────────────────────
let eventIndex = null      // Map<YYYY-MM-DD, string[]>
let indexTTL   = 0         // timestamp de expiración

function buildStaticIndex() {
  const idx = new Map()
  const add = (dates, label) => {
    for (const d of dates) {
      if (!idx.has(d)) idx.set(d, [])
      if (!idx.get(d).includes(label)) idx.get(d).push(label)
    }
  }
  add(FOMC,    'FOMC')
  add(CPI_USD, 'CPI')
  add(ECB,     'ECB')
  add(NFP,     'NFP')
  return idx
}

async function fetchFFWeek(slug) {
  try {
    const url  = `https://nfs.faireconomy.media/ff_calendar_${slug}.json`
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    })
    if (!resp.ok) return []
    return await resp.json()
  } catch { return [] }
}

function isoToMadridDate(isoStr) {
  const ts = new Date(isoStr).getTime()
  if (isNaN(ts)) return null
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' })
}

function labelFromFF(event) {
  for (const [label, keywords] of Object.entries(FF_KEYWORDS)) {
    const matchCountry = FF_COUNTRIES[label]
    if (matchCountry && event.country !== matchCountry) continue
    if (keywords.some(k => event.title.includes(k))) return label
  }
  return null
}

export async function getEventIndex() {
  const now = Date.now()
  if (eventIndex && now < indexTTL) return eventIndex

  // Construir índice estático
  const idx = buildStaticIndex()

  // Enriquecer con ForexFactory (semana pasada, actual, siguiente)
  const ff = (await Promise.all(['lastweek','thisweek','nextweek'].map(fetchFFWeek))).flat()
  for (const ev of ff) {
    if (ev.impact !== 'High') continue
    const date  = isoToMadridDate(ev.date)
    const label = labelFromFF(ev)
    if (!date || !label) continue
    if (!idx.has(date)) idx.set(date, [])
    if (!idx.get(date).includes(label)) idx.get(date).push(label)
  }

  eventIndex = idx
  indexTTL   = now + 60 * 60_000  // TTL 1 hora
  return idx
}

export function getEventosEnFecha(idx, date) {
  return idx.get(date) ?? []
}
