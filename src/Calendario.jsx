import { useState, useEffect } from 'react'

// Países: currency = código ForexFactory | nager = código Nager.Date
const PAISES = [
  { currency: 'EUR', nager: 'DE', label: 'EUR · Alemania',  flag: '🇩🇪', color: '#f59e0b' },
  { currency: 'GBP', nager: 'GB', label: 'GBP · R.Unido',  flag: '🇬🇧', color: '#ef4444' },
  { currency: 'USD', nager: 'US', label: 'USD · EE.UU.',    flag: '🇺🇸', color: '#60a5fa' },
]

const IMPACTOS = [
  { key: 'Holiday', label: 'Festivo', color: '#8b5cf6' },
  { key: 'High',    label: 'Alto',    color: '#ef4444' },
  { key: 'Medium',  label: 'Medio',   color: '#f59e0b' },
]

const MESES = [
  'Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre',
]
const DOW = ['Lu','Ma','Mi','Ju','Vi','Sá','Do']

// Cache Nager.Date en memoria
const nagerCache = {}
async function fetchNager(year, code) {
  const k = `${year}_${code}`
  if (nagerCache[k]) return nagerCache[k]
  try {
    const r = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${code}`)
    nagerCache[k] = r.ok ? await r.json() : []
  } catch { nagerCache[k] = [] }
  return nagerCache[k]
}

// Convierte fecha FF (ISO con offset) → string 'YYYY-MM-DD' en hora Madrid
const toMadridDate = iso =>
  new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' })

// Extrae la hora Madrid de un evento FF; devuelve null si es medianoche (sin hora concreta)
const toMadridTime = iso => {
  const d = new Date(iso)
  const t = d.toLocaleTimeString('es-ES', {
    timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit',
  })
  return t === '00:00' ? null : t
}

export default function Calendario() {
  const hoy = new Date()
  const [year,    setYear]    = useState(hoy.getFullYear())
  const [month,   setMonth]   = useState(hoy.getMonth())
  const [activos, setActivos] = useState(new Set(['EUR','GBP','USD']))
  const [impacts, setImpacts] = useState(new Set(['Holiday','High','Medium']))
  const [nager,   setNager]   = useState({})   // { year: { EUR:[...], GBP:[...], USD:[...] } }
  const [ffEvs,   setFfEvs]   = useState([])
  const [cargando,setCargando]= useState(false)

  // Cargar Nager.Date al cambiar año
  useEffect(() => {
    if (nager[year]) return
    setCargando(true)
    Promise.all(
      PAISES.map(p => fetchNager(year, p.nager).then(data => ({ currency: p.currency, data })))
    ).then(res => {
      const byC = {}
      res.forEach(({ currency, data }) => { byC[currency] = data })
      setNager(prev => ({ ...prev, [year]: byC }))
    }).finally(() => setCargando(false))
  }, [year])

  // Cargar ForexFactory una vez al montar
  useEffect(() => {
    fetch('/api/ff-calendar')
      .then(r => r.json())
      .then(d => setFfEvs(Array.isArray(d) ? d : []))
      .catch(() => {})
  }, [])

  const togglePais   = c => setActivos(prev => { const s = new Set(prev); s.has(c) ? s.delete(c) : s.add(c); return s })
  const toggleImpact = k => setImpacts(prev => { const s = new Set(prev); s.has(k) ? s.delete(k) : s.add(k); return s })

  // ── Construir mapa día→eventos para el mes visible ────────────────────────
  const mesPrefix = `${year}-${String(month + 1).padStart(2, '0')}`
  const diaMap    = {}

  const addEv = (date, ev) => {
    if (!diaMap[date]) diaMap[date] = []
    diaMap[date].push(ev)
  }

  // 1. Festivos estáticos de Nager.Date (toda la base histórica/futura)
  const nagerYear = nager[year] ?? {}
  PAISES.forEach(p => {
    if (!activos.has(p.currency) || !impacts.has('Holiday')) return
    ;(nagerYear[p.currency] ?? []).forEach(f => {
      if (!f.date.startsWith(mesPrefix)) return
      addEv(f.date, {
        src: 'nager', currency: p.currency, flag: p.flag, color: p.color,
        name: f.name, impact: 'Holiday',
      })
    })
  })

  // 2. Eventos ForexFactory (±1 semana, impacto filtrable)
  ffEvs.forEach(ev => {
    if (!impacts.has(ev.impact)) return

    const date = toMadridDate(ev.date)
    if (!date.startsWith(mesPrefix)) return

    // Determinar qué monedas afecta este evento
    const currencies = ev.country === 'ALL'
      ? PAISES.map(p => p.currency)
      : [ev.country]

    currencies.forEach(currency => {
      if (!activos.has(currency)) return
      const p = PAISES.find(x => x.currency === currency)
      if (!p) return

      // Evitar duplicar festivos que ya aparecen en Nager
      const yaEstaFestivo = ev.impact === 'Holiday' &&
        (diaMap[date] ?? []).some(e => e.src === 'nager' && e.currency === currency)
      if (yaEstaFestivo) return

      addEv(date, {
        src: 'ff', currency, flag: p.flag,
        color: IMPACTOS.find(i => i.key === ev.impact)?.color ?? '#6b7280',
        name: ev.title, impact: ev.impact,
        time: toMadridTime(ev.date),
      })
    })
  })

  // ── Cuadrícula ────────────────────────────────────────────────────────────
  const primerDia = new Date(year, month, 1)
  const diasMes   = new Date(year, month + 1, 0).getDate()
  const offsetDow = (primerDia.getDay() + 6) % 7
  const hoyStr    = hoy.toISOString().slice(0, 10)

  const prevMes = () => { if (month === 0) { setYear(y => y-1); setMonth(11) } else setMonth(m => m-1) }
  const nextMes = () => { if (month === 11) { setYear(y => y+1); setMonth(0) } else setMonth(m => m+1) }

  return (
    <div className="cal-page">

      {/* ── Cabecera ── */}
      <div className="cal-header">
        <div className="cal-nav">
          <button className="cal-nav-btn" onClick={() => setYear(y => y-1)}>«</button>
          <button className="cal-nav-btn" onClick={prevMes}>‹</button>
          <span className="cal-titulo">{MESES[month]} {year}</span>
          <button className="cal-nav-btn" onClick={nextMes}>›</button>
          <button className="cal-nav-btn" onClick={() => setYear(y => y+1)}>»</button>
        </div>

        <div className="cal-filtros">
          <div className="cal-paises">
            {PAISES.map(p => (
              <button
                key={p.currency}
                className={`cal-pais-btn ${activos.has(p.currency) ? 'activo' : ''}`}
                style={activos.has(p.currency) ? { '--c': p.color } : {}}
                onClick={() => togglePais(p.currency)}
              >{p.flag} {p.label}</button>
            ))}
          </div>

          <div className="cal-impacts">
            {IMPACTOS.map(i => (
              <button
                key={i.key}
                className={`cal-impact-btn ${impacts.has(i.key) ? 'activo' : ''}`}
                style={impacts.has(i.key) ? { '--c': i.color } : {}}
                onClick={() => toggleImpact(i.key)}
              >{i.label}</button>
            ))}
          </div>
        </div>

        {cargando && <span className="cal-cargando"><span className="spinner" /> Cargando…</span>}
      </div>

      {/* ── Cuadrícula del mes ── */}
      <div className="cal-grid">
        {DOW.map(d => <div key={d} className="cal-dow">{d}</div>)}

        {Array.from({ length: offsetDow }).map((_, i) => (
          <div key={`v${i}`} className="cal-cell vacio" />
        ))}

        {Array.from({ length: diasMes }).map((_, i) => {
          const dia     = i + 1
          const dateStr = `${mesPrefix}-${String(dia).padStart(2,'0')}`
          const eventos = diaMap[dateStr] ?? []
          const dow     = (offsetDow + i) % 7
          const esHoy   = dateStr === hoyStr
          const esFinde = dow >= 5

          return (
            <div
              key={dia}
              className={[
                'cal-cell',
                esFinde        ? 'finde'         : '',
                esHoy          ? 'hoy'            : '',
                eventos.length ? 'tiene-eventos'  : '',
              ].filter(Boolean).join(' ')}
            >
              <span className="cal-num">{dia}</span>
              <div className="cal-fests">
                {eventos.map((ev, fi) => (
                  <div
                    key={fi}
                    className={`cal-fest impact-${ev.impact.toLowerCase()}`}
                    title={`${ev.flag} ${ev.time ? ev.time + ' · ' : ''}${ev.name}`}
                  >
                    <span className="cal-fest-flag">{ev.flag}</span>
                    {ev.time && (
                      <span className="cal-fest-hora">{ev.time}</span>
                    )}
                    <span className="cal-fest-nombre" style={{ color: ev.color }}>
                      {ev.name}
                    </span>
                    {ev.src === 'ff' && ev.impact !== 'Holiday' && (
                      <span className="cal-ff-dot" style={{ background: ev.color }} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Leyenda ── */}
      <div className="cal-leyenda">
        <span className="cal-leyenda-item">
          <span className="cal-leyenda-muestra hoy" /> Hoy
        </span>
        <span className="cal-leyenda-item">
          <span className="cal-leyenda-muestra finde" /> Fin de semana
        </span>
        {IMPACTOS.filter(i => impacts.has(i.key)).map(i => (
          <span key={i.key} className="cal-leyenda-item">
            <span className="cal-leyenda-dot" style={{ background: i.color }} />
            {i.label}
          </span>
        ))}
        <span className="cal-leyenda-item cal-leyenda-ff">
          ForexFactory ±1 semana · Nager.Date resto
        </span>
      </div>
    </div>
  )
}
