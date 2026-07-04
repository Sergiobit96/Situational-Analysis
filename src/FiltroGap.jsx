import { useState, useEffect, useRef, useMemo } from 'react'
import GraficoVelas from './GraficoVelas'
import { capturarVelasPNG } from './graficoVelasCore'

// Tickers que Railway maneja via Dukascopy — el resto va a /api/yf-intraday (Vercel)
const DUKA_TICKERS = new Set(['^GSPC', '^NDX', '^DJI', '^GDAXI', '^FTSE', 'XAUUSD', 'XAGUSD', 'USOIL'])

function intradayUrl(tkr, date, timeframe) {
  if (DUKA_TICKERS.has(tkr)) {
    return `/api/velas15m?${new URLSearchParams({ ticker: tkr, date, timeframe })}`
  }
  return `/api/yf-intraday?${new URLSearchParams({ ticker: tkr, date })}`
}

const DIAS = [
  { n: 1, label: 'L', nombre: 'Lunes' },
  { n: 2, label: 'M', nombre: 'Martes' },
  { n: 3, label: 'X', nombre: 'Miércoles' },
  { n: 4, label: 'J', nombre: 'Jueves' },
  { n: 5, label: 'V', nombre: 'Viernes' },
]

const GAP_SIZES = [0, 0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0]

const EVENTOS_DEF = [
  { id: 'FOMC', label: 'FOMC',  title: 'Fed rate decision' },
  { id: 'CPI',  label: 'CPI',   title: 'Consumer Price Index US' },
  { id: 'NFP',  label: 'NFP',   title: 'Non-Farm Payrolls' },
  { id: 'ECB',  label: 'ECB',   title: 'ECB rate decision' },
  { id: 'PPI',  label: 'PPI',   title: 'Producer Price Index US' },
  { id: 'GDP',  label: 'GDP',   title: 'Gross Domestic Product' },
  { id: 'PMI',  label: 'PMI',   title: 'Purchasing Managers Index' },
]

const PERIODOS = [
  { meses: 3,  label: '3m'  },
  { meses: 6,  label: '6m'  },
  { meses: 12, label: '12m' },
  { meses: 24, label: '2a'  },
  { meses: 60, label: '5a'  },
]

const PRESETS = [
  { label: 'DAX',    value: '^GDAXI' },
  { label: 'FTSE',   value: '^FTSE'  },
  { label: 'Nasdaq', value: '^NDX'   },
  { label: 'Dow Jones', value: '^DJI'   },
  { label: 'S&P',    value: '^GSPC'  },
  { label: 'Oro',    value: 'XAUUSD' },
  { label: 'Plata',  value: 'XAGUSD' },
  { label: 'Petróleo', value: 'USOIL' },
]

const STOCKS = {
  '^GDAXI': [
    { name: 'SAP',            ticker: 'SAP.DE'   },
    { name: 'Siemens',        ticker: 'SIE.DE'   },
    { name: 'Allianz',        ticker: 'ALV.DE'   },
    { name: 'Mercedes-Benz',  ticker: 'MBG.DE'   },
    { name: 'BMW',            ticker: 'BMW.DE'   },
    { name: 'Deutsche Telekom', ticker: 'DTE.DE' },
    { name: 'Volkswagen',     ticker: 'VOW3.DE'  },
    { name: 'Bayer',          ticker: 'BAYN.DE'  },
    { name: 'BASF',           ticker: 'BAS.DE'   },
    { name: 'Munich Re',      ticker: 'MUV2.DE'  },
    { name: 'Rheinmetall',    ticker: 'RHM.DE'   },
    { name: 'Airbus',         ticker: 'AIR.PA'   },
    { name: 'Infineon',       ticker: 'IFX.DE'   },
    { name: 'Adidas',         ticker: 'ADS.DE'   },
    { name: 'Deutsche Bank',  ticker: 'DBK.DE'   },
  ],
  '^FTSE': [
    { name: 'AstraZeneca',    ticker: 'AZN.L'    },
    { name: 'Shell',          ticker: 'SHEL.L'   },
    { name: 'HSBC',           ticker: 'HSBA.L'   },
    { name: 'Unilever',       ticker: 'ULVR.L'   },
    { name: 'Rio Tinto',      ticker: 'RIO.L'    },
    { name: 'BP',             ticker: 'BP.L'     },
    { name: 'GSK',            ticker: 'GSK.L'    },
    { name: 'Diageo',         ticker: 'DGE.L'    },
    { name: 'Rolls-Royce',    ticker: 'RR.L'     },
    { name: 'BAE Systems',    ticker: 'BA.L'     },
    { name: 'Barclays',       ticker: 'BARC.L'   },
    { name: 'Lloyds',         ticker: 'LLOY.L'   },
    { name: 'National Grid',  ticker: 'NG.L'     },
    { name: 'Vodafone',       ticker: 'VOD.L'    },
    { name: 'BT Group',       ticker: 'BT-A.L'   },
  ],
  '^GSPC': [
    { name: 'Apple',          ticker: 'AAPL'     },
    { name: 'Microsoft',      ticker: 'MSFT'     },
    { name: 'NVIDIA',         ticker: 'NVDA'     },
    { name: 'Amazon',         ticker: 'AMZN'     },
    { name: 'Alphabet',       ticker: 'GOOGL'    },
    { name: 'Meta',           ticker: 'META'     },
    { name: 'Berkshire B',    ticker: 'BRK-B'    },
    { name: 'Tesla',          ticker: 'TSLA'     },
    { name: 'Broadcom',       ticker: 'AVGO'     },
    { name: 'JPMorgan',       ticker: 'JPM'      },
    { name: 'Eli Lilly',      ticker: 'LLY'      },
    { name: 'Visa',           ticker: 'V'        },
    { name: 'UnitedHealth',   ticker: 'UNH'      },
    { name: 'Exxon',          ticker: 'XOM'      },
    { name: 'Johnson & J.',   ticker: 'JNJ'      },
  ],
  '^NDX': [
    { name: 'Apple',          ticker: 'AAPL'     },
    { name: 'Microsoft',      ticker: 'MSFT'     },
    { name: 'NVIDIA',         ticker: 'NVDA'     },
    { name: 'Amazon',         ticker: 'AMZN'     },
    { name: 'Meta',           ticker: 'META'     },
    { name: 'Alphabet',       ticker: 'GOOGL'    },
    { name: 'Tesla',          ticker: 'TSLA'     },
    { name: 'Broadcom',       ticker: 'AVGO'     },
    { name: 'Netflix',        ticker: 'NFLX'     },
    { name: 'Adobe',          ticker: 'ADBE'     },
    { name: 'AMD',            ticker: 'AMD'      },
    { name: 'Qualcomm',       ticker: 'QCOM'     },
    { name: 'Intel',          ticker: 'INTC'     },
    { name: 'Applied Mat.',   ticker: 'AMAT'     },
    { name: 'Micron',         ticker: 'MU'       },
  ],
  '^DJI': [
    { name: 'UnitedHealth',   ticker: 'UNH'      },
    { name: 'Goldman Sachs',  ticker: 'GS'       },
    { name: 'Microsoft',      ticker: 'MSFT'     },
    { name: 'Home Depot',     ticker: 'HD'       },
    { name: 'McDonald\'s',    ticker: 'MCD'      },
    { name: 'Visa',           ticker: 'V'        },
    { name: 'Caterpillar',    ticker: 'CAT'      },
    { name: 'Amazon',         ticker: 'AMZN'     },
    { name: 'Salesforce',     ticker: 'CRM'      },
    { name: 'Apple',          ticker: 'AAPL'     },
    { name: 'JPMorgan',       ticker: 'JPM'      },
    { name: 'Amgen',          ticker: 'AMGN'     },
    { name: 'Boeing',         ticker: 'BA'       },
    { name: 'Procter & G.',   ticker: 'PG'       },
    { name: 'Honeywell',      ticker: 'HON'      },
    { name: 'Chevron',        ticker: 'CVX'      },
    { name: 'Johnson & J.',   ticker: 'JNJ'      },
    { name: 'American Exp.',  ticker: 'AXP'      },
    { name: 'Nike',           ticker: 'NKE'      },
    { name: 'IBM',            ticker: 'IBM'      },
    { name: 'Walmart',        ticker: 'WMT'      },
    { name: 'Disney',         ticker: 'DIS'      },
    { name: 'Merck',          ticker: 'MRK'      },
    { name: 'Cisco',          ticker: 'CSCO'     },
    { name: 'Coca-Cola',      ticker: 'KO'       },
    { name: 'Travelers',      ticker: 'TRV'      },
    { name: 'Verizon',        ticker: 'VZ'       },
    { name: '3M',             ticker: 'MMM'      },
    { name: 'Walgreens',      ticker: 'WBA'      },
    { name: 'Intel',          ticker: 'INTC'     },
  ],
}

const DIA_NOMBRE = { 1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves', 5: 'Viernes' }
const DIA_CORTO  = { 1: 'Lu', 2: 'Ma', 3: 'Mi', 4: 'Ju', 5: 'Vi' }
const PAGE_SIZE  = 50

export default function FiltroGap() {
  const [ticker,        setTicker]        = useState('^GDAXI')
  const [dias,          setDias]          = useState(new Set([1, 2, 3, 4, 5]))
  const [dir,           setDir]           = useState('both')
  const [gapMin,        setGapMin]        = useState(0)
  const [gapModo,       setGapModo]       = useState('pct') // 'pct' | 'pts'
  const [meses,         setMeses]         = useState(12)
  const [eventosActivos, setEventosActivos] = useState(new Set())
  const [cargando,      setCargando]      = useState(false)
  const [resultado,     setResultado]     = useState(null)
  const [error,         setError]         = useState(null)
  const [seleccion,     setSeleccion]     = useState(null)
  const [velas,         setVelas]         = useState([])
  const [fuenteVelas,   setFuenteVelas]   = useState(null)
  const [cargandoVelas, setCargandoVelas] = useState(false)
  const [timeframe,     setTimeframe]     = useState('m15')
  const [fechaManual,   setFechaManual]   = useState('')
  const abortVelasRef = useRef(null)

  // ── Modo multi-instrumento (fecha concreta) ──
  const [indiceAcciones, setIndiceAcciones] = useState(null)
  const [instrManual, setInstrManual] = useState(new Set())
  const [velasMulti,  setVelasMulti]  = useState({})   // { ticker: {velas,fuente,loading} }
  const [fechaMulti,  setFechaMulti]  = useState(null)
  const abortMultiRef = useRef({})
  const [pagina,         setPagina]         = useState(0)
  const [diasEspeciales, setDiasEspeciales] = useState(new Set())
  const [exportando,     setExportando]     = useState(false)
  const [exportProgreso, setExportProgreso] = useState(null)  // { done, total }

  const toggleDia = n => setDias(prev => {
    const s = new Set(prev); s.has(n) ? s.delete(n) : s.add(n); return s
  })

  const toggleEvento = id => setEventosActivos(prev => {
    const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s
  })

  const toggleInstrManual = val => setInstrManual(prev => {
    const s = new Set(prev); s.has(val) ? s.delete(val) : s.add(val); return s
  })

  const toggleDiaEspecial = id => setDiasEspeciales(prev => {
    const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s
  })

  // Calcula qué fechas son primer/último día de negociación del mes y del trimestre
  const fechasEspeciales = useMemo(() => {
    const all = resultado?.sesiones ?? []
    if (all.length === 0) return null
    const byMes = {}
    for (const s of all) {
      const key = s.date.slice(0, 7) // 'YYYY-MM'
      if (!byMes[key]) byMes[key] = []
      byMes[key].push(s.date)
    }
    const primerMes    = new Set()
    const ultimoMes    = new Set()
    const primerTrim   = new Set()
    const ultimoTrim   = new Set()
    const inicioTrim   = new Set(['01','04','07','10'])
    const finTrim      = new Set(['03','06','09','12'])
    for (const [key, fechas] of Object.entries(byMes)) {
      const ord = [...fechas].sort()
      const mes = key.slice(5, 7)
      primerMes.add(ord[0])
      ultimoMes.add(ord[ord.length - 1])
      if (inicioTrim.has(mes)) primerTrim.add(ord[0])
      if (finTrim.has(mes))    ultimoTrim.add(ord[ord.length - 1])
    }
    return { primerMes, ultimoMes, primerTrim, ultimoTrim }
  }, [resultado])

  // Filtrado secundario por evento y día especial (client-side, instantáneo)
  const sesionesVisibles = (() => {
    let all = resultado?.sesiones ?? []
    if (eventosActivos.size > 0)
      all = all.filter(s => s.eventos?.some(e => eventosActivos.has(e)))
    if (diasEspeciales.size > 0 && fechasEspeciales)
      all = all.filter(s =>
        (diasEspeciales.has('primerMes')  && fechasEspeciales.primerMes.has(s.date))  ||
        (diasEspeciales.has('ultimoMes')  && fechasEspeciales.ultimoMes.has(s.date))  ||
        (diasEspeciales.has('primerTrim') && fechasEspeciales.primerTrim.has(s.date)) ||
        (diasEspeciales.has('ultimoTrim') && fechasEspeciales.ultimoTrim.has(s.date))
      )
    return all
  })()

  // Paginación: orden descendente (más reciente primero) para ver datos actuales sin scroll
  const sesionesOrdenadas = [...sesionesVisibles].reverse()
  const totalPaginas      = Math.max(1, Math.ceil(sesionesOrdenadas.length / PAGE_SIZE))
  const sesionsPagina     = sesionesOrdenadas.slice(pagina * PAGE_SIZE, (pagina + 1) * PAGE_SIZE)

  // Resetear página al cambiar resultados o filtros secundarios
  useEffect(() => { setPagina(0) }, [resultado, eventosActivos, diasEspeciales])

  const buscar = async () => {
    if (!ticker.trim() || dias.size === 0) return
    setCargando(true)
    setError(null)
    setResultado(null)
    setSeleccion(null)
    setVelas([])
    setFuenteVelas(null)
    setVelasMulti({})
    setFechaMulti(null)
    try {
      const p = new URLSearchParams({
        ticker: ticker.trim(),
        dias:   [...dias].sort().join(','),
        dir,
        gapMin,
        gapModo,
        meses,
        ...(diasEspeciales.size > 0 ? { diasEsp: [...diasEspeciales].join(',') } : {}),
      })
      const res  = await fetch(`/api/gap-filter?${p}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setResultado(data)
      if (data.sesiones.length > 0) setSeleccion(data.sesiones[data.sesiones.length - 1])
    } catch (e) {
      setError(e.message)
    } finally {
      setCargando(false)
    }
  }

  // Genera el PPT con el gráfico intradía de cada coincidencia (una llamada + un render
  // por sesión, igual que al hacer clic en una sesión en la lista de resultados).
  const exportarPPT = async () => {
    const lista = sesionesVisibles
    if (lista.length === 0) return
    const tkr = resultado?.ticker ?? ticker
    setExportando(true)
    setError(null)
    setExportProgreso({ done: 0, total: lista.length })
    try {
      const sesionesConGrafico = []
      for (const s of lista) {
        let imagen = null
        try {
          const r = await fetch(intradayUrl(tkr, s.date, timeframe))
          const d = await r.json()
          if (d.velas?.length) {
            imagen = await capturarVelasPNG({
              velas: d.velas, ticker: tkr, prevClose: s.prevClose, openPrice: s.openPrice,
            })
          }
        } catch { /* sin gráfico para esta sesión, se marcará como "sin datos" en el PPT */ }
        sesionesConGrafico.push({ ...s, imagen })
        setExportProgreso(prev => ({ done: prev.done + 1, total: prev.total }))
      }
      setExportProgreso(null)

      const resp = await fetch('/api/export-ppt', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticker:   tkr,
          sesiones: sesionesConGrafico,
          filtros: {
            dias:    [...dias].sort().join(', '),
            dir,
            gapMin,
            gapModo,
            periodo: PERIODOS.find(p => p.meses === meses)?.label,
          },
        }),
      })
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}))
        throw new Error(data.error ?? 'Error generando la presentación')
      }
      const blob = await resp.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `situational-analysis-${tkr}.pptx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e.message)
    } finally {
      setExportando(false)
      setExportProgreso(null)
    }
  }

  const irAFecha = () => {
    if (!fechaManual) return
    if (instrManual.size === 0) {
      // Sin chips seleccionados → comportamiento anterior (un solo ticker)
      setVelasMulti({})
      setFechaMulti(null)
      setSeleccion({ date: fechaManual })
      setVelas([])
    } else {
      // Multi-instrumento
      setSeleccion(null)
      setVelas([])
      Object.values(abortMultiRef.current).forEach(c => c.abort())
      abortMultiRef.current = {}
      const tickers = [...instrManual]
      const init = {}
      tickers.forEach(t => { init[t] = { velas: [], fuente: null, loading: true } })
      setVelasMulti(init)
      setFechaMulti(fechaManual)
      tickers.forEach(tkr => {
        const ctrl = new AbortController()
        abortMultiRef.current[tkr] = ctrl
        fetch(intradayUrl(tkr, fechaManual, timeframe), { signal: ctrl.signal })
          .then(r => r.json())
          .then(d => {
            if (!ctrl.signal.aborted)
              setVelasMulti(prev => ({ ...prev, [tkr]: { velas: d.velas ?? [], fuente: d.fuente ?? null, loading: false } }))
          })
          .catch(e => {
            if (e.name !== 'AbortError')
              setVelasMulti(prev => ({ ...prev, [tkr]: { velas: [], fuente: null, loading: false } }))
          })
      })
    }
  }

  const cancelarVelas = () => {
    abortVelasRef.current?.abort()
    setCargandoVelas(false)
  }

  // Carga velas intraday cuando cambia la sesión seleccionada o el timeframe
  useEffect(() => {
    if (!seleccion) return
    const controller = new AbortController()
    abortVelasRef.current = controller
    const tkr = resultado?.ticker ?? ticker
    setCargandoVelas(true)
    setVelas([])
    fetch(intradayUrl(tkr, seleccion.date, timeframe), { signal: controller.signal })
      .then(r => r.json())
      .then(d => {
        if (controller.signal.aborted) return
        if (d.velas?.length) setVelas(d.velas)
        setFuenteVelas(d.fuente ?? null)
      })
      .catch(e => { if (e.name !== 'AbortError') console.error(e) })
      .finally(() => { if (!controller.signal.aborted) setCargandoVelas(false) })
    return () => controller.abort()
  }, [seleccion, timeframe])

  return (
    <div className="filtro-page">

      {/* ── Panel de controles ── */}
      <div className="filtro-controls">

        <div className="filtro-group">
          <label className="filtro-label">Instrumento</label>
          <div className="filtro-ticker-row">
            <input
              className="filtro-input"
              value={ticker}
              onChange={e => setTicker(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && buscar()}
              placeholder="^GDAXI, ^GSPC…"
            />
          </div>
          <div className="filtro-presets">
            {PRESETS.map(p => (
              <button
                key={p.value}
                className={`chip ${ticker === p.value ? 'activo' : ''}`}
                onClick={() => {
                  setTicker(p.value)
                  setIndiceAcciones(STOCKS[p.value] ? p.value : null)
                }}
              >{p.label}</button>
            ))}
          </div>

          {/* ── Acciones del índice seleccionado ── */}
          {indiceAcciones && STOCKS[indiceAcciones] && (
            <div className="acciones-panel">
              <div className="acciones-header">
                <span>Acciones · {PRESETS.find(p => p.value === indiceAcciones)?.label}</span>
                <button className="clear-eventos" onClick={() => setIndiceAcciones(null)}>× cerrar</button>
              </div>
              <div className="acciones-lista">
                {STOCKS[indiceAcciones].map(s => (
                  <button
                    key={s.ticker}
                    className={`stock-chip ${ticker === s.ticker ? 'activo' : ''}`}
                    title={s.ticker}
                    onClick={() => setTicker(s.ticker)}
                  >
                    <span className="stock-nombre">{s.name}</span>
                    <span className="stock-ticker">{s.ticker}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="filtro-group">
          <label className="filtro-label">Día de la semana</label>
          <div className="filtro-dias">
            {DIAS.map(d => (
              <button
                key={d.n}
                className={`dia-chip ${dias.has(d.n) ? 'activo' : ''}`}
                onClick={() => toggleDia(d.n)}
                title={d.nombre}
              >{d.label}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">Dirección del gap</label>
          <div className="filtro-dir">
            {[
              { v: 'both', label: '↕  Ambos'      },
              { v: 'up',   label: '▲  Gap arriba' },
              { v: 'down', label: '▼  Gap abajo'  },
            ].map(d => (
              <button
                key={d.v}
                className={`dir-chip ${dir === d.v ? 'activo' : ''}`}
                onClick={() => setDir(d.v)}
              >{d.label}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Gap mínimo&nbsp;
            <span className="filtro-valor">
              {gapMin === 0 ? 'cualquiera' : `≥ ${gapMin}${gapModo === 'pct' ? '%' : ' pts'}`}
            </span>
          </label>
          <div className="gap-modo-row">
            <select
              className="gap-modo-select"
              value={gapModo}
              onChange={e => { setGapModo(e.target.value); setGapMin(0) }}
            >
              <option value="pct">%</option>
              <option value="pts">Puntos</option>
            </select>
            {gapModo === 'pct' ? (
              <div className="filtro-gap-sizes">
                {GAP_SIZES.map(g => (
                  <button
                    key={g}
                    className={`gap-chip ${gapMin === g ? 'activo' : ''}`}
                    onClick={() => setGapMin(g)}
                  >{g === 0 ? 'Todos' : `${g}%`}</button>
                ))}
              </div>
            ) : (
              <input
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                className="filtro-input-puntos"
                placeholder="0 = cualquiera"
                value={gapMin === 0 ? '' : gapMin}
                onChange={e => setGapMin(e.target.value === '' ? 0 : parseFloat(e.target.value) || 0)}
              />
            )}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">Histórico</label>
          <div className="filtro-periodos">
            {PERIODOS.map(p => (
              <button
                key={p.meses}
                className={`periodo-chip ${meses === p.meses ? 'activo' : ''}`}
                onClick={() => setMeses(p.meses)}
              >{p.label}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Evento económico
            {eventosActivos.size > 0 && (
              <button className="clear-eventos" onClick={() => setEventosActivos(new Set())}>
                × limpiar
              </button>
            )}
          </label>
          <div className="filtro-eventos">
            {EVENTOS_DEF.map(ev => (
              <button
                key={ev.id}
                className={`evento-chip ev-${ev.id.toLowerCase()} ${eventosActivos.has(ev.id) ? 'activo' : ''}`}
                onClick={() => toggleEvento(ev.id)}
                title={ev.title}
              >{ev.label}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Día especial
            {diasEspeciales.size > 0 && (
              <button className="clear-eventos" onClick={() => setDiasEspeciales(new Set())}>× limpiar</button>
            )}
          </label>
          <div className="filtro-dias-esp">
            {[
              { id: 'primerMes',  label: '1º mes',       title: 'Primer día de negociación del mes' },
              { id: 'ultimoMes',  label: 'Último mes',   title: 'Último día de negociación del mes' },
              { id: 'primerTrim', label: '1º trim.',      title: 'Primer día de negociación del trimestre (ene/abr/jul/oct)' },
              { id: 'ultimoTrim', label: 'Último trim.', title: 'Último día de negociación del trimestre (mar/jun/sep/dic)' },
            ].map(d => (
              <button
                key={d.id}
                className={`dia-esp-chip ${diasEspeciales.has(d.id) ? 'activo' : ''}`}
                onClick={() => toggleDiaEspecial(d.id)}
                title={d.title}
              >{d.label}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Ir a fecha concreta
            {instrManual.size > 0 && (
              <button className="clear-eventos" onClick={() => setInstrManual(new Set())}>× limpiar</button>
            )}
          </label>
          <div className="fecha-manual-row">
            <input
              type="date"
              className="filtro-input-fecha"
              value={fechaManual}
              onChange={e => setFechaManual(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && irAFecha()}
            />
            <button
              className="btn-ir-fecha"
              onClick={irAFecha}
              disabled={!fechaManual}
            >Ver</button>
          </div>
          <div className="filtro-presets" style={{ marginTop: '0.4rem' }}>
            {PRESETS.map(p => (
              <button
                key={p.value}
                className={`chip ${instrManual.has(p.value) ? 'activo' : ''}`}
                onClick={() => toggleInstrManual(p.value)}
              >{p.label}</button>
            ))}
          </div>
          {instrManual.size > 0 && (
            <p className="instr-manual-hint">
              {instrManual.size === 1 ? '1 instrumento' : `${instrManual.size} instrumentos`} seleccionados
            </p>
          )}
        </div>

        <button
          className="btn-filtrar"
          onClick={buscar}
          disabled={cargando || dias.size === 0}
        >
          {cargando
            ? <><span className="spinner" /> Cargando…</>
            : '🔍  Filtrar sesiones'}
        </button>

        {resultado && (
          <div className="filtro-resumen">
            <strong>{sesionesVisibles.length}</strong>
            {sesionesVisibles.length !== resultado.total && (
              <span className="resumen-filtrado"> / {resultado.total}</span>
            )}
            {' '}sesión{sesionesVisibles.length !== 1 ? 'es' : ''} · {resultado.ticker}
            {resultado.fuente      && <span className="resumen-fuente"> · {resultado.fuente}</span>}
            {resultado.fechaInicio && <span className="resumen-desde"> · desde {resultado.fechaInicio}</span>}
          </div>
        )}

        {resultado && sesionesVisibles.length > 0 && (
          <button
            className="btn-exportar-ppt"
            onClick={exportarPPT}
            disabled={exportando}
          >
            {exportando
              ? <><span className="spinner" /> {exportProgreso
                    ? `Generando gráficos… ${exportProgreso.done}/${exportProgreso.total}`
                    : 'Generando PPT…'}</>
              : `📊  Exportar ${sesionesVisibles.length} gráficos a PPT`}
          </button>
        )}
      </div>

      {/* ── Resultados ── */}
      <div className="filtro-resultados">
        {error && <p className="error-global">{error}</p>}

        {resultado && sesionesVisibles.length === 0 && (
          <div className="filtro-vacio">
            Sin sesiones con esos filtros.
            {eventosActivos.size > 0 && ' Prueba quitando algún filtro de evento.'}
          </div>
        )}

        <div className={resultado && sesionesVisibles.length > 0 ? 'filtro-split' : ''}>

          {/* Lista de sesiones (solo cuando hay resultados del filtro) */}
          {resultado && sesionesVisibles.length > 0 && (
            <div className="sesiones-lista">
              {sesionsPagina.map(s => (
                <SesionCard
                  key={s.date}
                  sesion={s}
                  activo={seleccion?.date === s.date}
                  onClick={() => { setSeleccion(s); setVelasMulti({}); setFechaMulti(null) }}
                />
              ))}
              {totalPaginas > 1 && (
                <div className="paginacion">
                  <button
                    className="pag-btn"
                    onClick={() => setPagina(p => Math.max(0, p - 1))}
                    disabled={pagina === 0}
                  >← Anterior</button>
                  <span className="pag-info">{pagina + 1} / {totalPaginas}</span>
                  <button
                    className="pag-btn"
                    onClick={() => setPagina(p => Math.min(totalPaginas - 1, p + 1))}
                    disabled={pagina >= totalPaginas - 1}
                  >Siguiente →</button>
                </div>
              )}
            </div>
          )}

          {/* Detalle / gráfico (visible tanto para selecciones de lista como manuales) */}
          {seleccion && (
            <div className="sesion-detalle">
              <div className="sesion-detalle-header">
                <div className="sesion-detalle-titulo">
                  <span className="sesion-detalle-fecha">{seleccion.date}</span>
                  {seleccion.dayOfWeek && (
                    <span className="sesion-detalle-dia">{DIA_NOMBRE[seleccion.dayOfWeek]}</span>
                  )}
                  {seleccion.gapDir && (
                    <span className={`gap-pill ${seleccion.gapDir}`}>
                      {seleccion.gapDir === 'up' ? '▲' : '▼'}
                      {seleccion.gapPct > 0 ? ' +' : ' '}{seleccion.gapPct.toFixed(3)}%
                      {seleccion.prevClose != null && seleccion.openPrice != null && (
                        <span className="gap-pill-pts">
                          {' '}({seleccion.openPrice - seleccion.prevClose > 0 ? '+' : ''}
                          {(seleccion.openPrice - seleccion.prevClose).toFixed(2)} pts)
                        </span>
                      )}
                    </span>
                  )}
                  {seleccion.eventos?.map(e => (
                    <span key={e} className={`ev-badge ev-${e.toLowerCase()}`}>{e}</span>
                  ))}
                </div>
                {seleccion.prevClose != null && (
                  <div className="sesion-detalle-meta">
                    Cierre anterior&nbsp;
                    <strong>{seleccion.prevClose.toFixed(2)}</strong>
                    &nbsp;→ Apertura&nbsp;
                    <strong>{seleccion.openPrice.toFixed(2)}</strong>
                    {velas.length > 0 && (
                      <>&nbsp;·&nbsp;{velas.length} velas
                        {fuenteVelas && (
                          <span className={`fuente-tag ${fuenteVelas.startsWith('Duka') ? 'dukascopy' : fuenteVelas.startsWith('Stooq') ? 'stooq' : 'yahoo'}`}>
                            {fuenteVelas}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                )}
                {seleccion.prevClose == null && velas.length > 0 && (
                  <div className="sesion-detalle-meta">
                    {velas.length} velas
                    {fuenteVelas && (
                      <span className={`fuente-tag ${fuenteVelas.startsWith('Duka') ? 'dukascopy' : fuenteVelas.startsWith('Stooq') ? 'stooq' : 'yahoo'}`}>
                        {fuenteVelas}
                      </span>
                    )}
                  </div>
                )}
                <div className="tf-selector">
                  {[
                    { label: '1m',  duka: 'm1'  },
                    { label: '5m',  duka: 'm5'  },
                    { label: '15m', duka: 'm15' },
                    { label: '30m', duka: 'm30' },
                    { label: '1h',  duka: 'h1'  },
                  ].map(tf => (
                    <button
                      key={tf.duka}
                      className={`tf-chip ${timeframe === tf.duka ? 'activo' : ''}`}
                      onClick={() => setTimeframe(tf.duka)}
                    >{tf.label}</button>
                  ))}
                </div>
              </div>

              {cargandoVelas && (
                <div className="velas-cargando">
                  <span className="spinner" /> Cargando velas…
                  <button className="btn-cancelar-velas" onClick={cancelarVelas}>✕ Cancelar</button>
                </div>
              )}

              {!cargandoVelas && velas.length > 0 && (
                <>
                  {(fuenteVelas === 'Stooq 1d' || fuenteVelas === 'Dukascopy 1d') && (
                    <div className="filtro-vacio" style={{ marginBottom: '0.5rem', fontSize: '0.78rem' }}>
                      Sin datos intraday disponibles · mostrando barra diaria
                    </div>
                  )}
                  <GraficoVelas
                    velas={velas}
                    patrones={[]}
                    ticker={resultado?.ticker ?? ticker}
                    prevClose={seleccion.prevClose}
                    openPrice={seleccion.openPrice}
                    herramientas
                  />
                  <VelasTabla velas={velas} />
                </>
              )}

              {!cargandoVelas && velas.length === 0 && (() => {
                const tkr = resultado?.ticker ?? ticker
                const esAccion = !['XAUUSD','XAGUSD','USOIL','^GDAXI','^FTSE','^GSPC','^NDX','^DJI'].includes(tkr)
                return (
                  <div className="filtro-vacio">
                    {esAccion
                      ? <>Sin datos intraday para <strong>{tkr}</strong> en esta fecha.</>
                      : 'No hay datos intraday disponibles para esta fecha.'}
                  </div>
                )
              })()}
            </div>
          )}
        </div>

        {/* ── Multi-chart (fecha concreta con varios instrumentos) ── */}
        {Object.keys(velasMulti).length > 0 && (
          <div className="multi-charts-section">
            <div className="multi-charts-header">
              <span className="multi-charts-fecha">{fechaMulti}</span>
              <div className="tf-selector">
                {[
                  { label: '1m',  duka: 'm1'  },
                  { label: '5m',  duka: 'm5'  },
                  { label: '15m', duka: 'm15' },
                  { label: '30m', duka: 'm30' },
                  { label: '1h',  duka: 'h1'  },
                ].map(tf => (
                  <button
                    key={tf.duka}
                    className={`tf-chip ${timeframe === tf.duka ? 'activo' : ''}`}
                    onClick={() => setTimeframe(tf.duka)}
                  >{tf.label}</button>
                ))}
              </div>
              <button className="btn-ir-fecha" onClick={irAFecha} disabled={!fechaManual}>↺ Recargar</button>
            </div>
            <div className="multi-charts-grid">
              {Object.entries(velasMulti).map(([tkr, { velas: v, fuente, loading }]) => (
                <div key={tkr} className="multi-chart-item">
                  <div className="multi-chart-nombre">
                    {PRESETS.find(p => p.value === tkr)?.label ?? tkr}
                    {fuente && (
                      <span className={`fuente-tag ${fuente.startsWith('Duka') ? 'dukascopy' : 'yahoo'}`}>
                        {fuente}
                      </span>
                    )}
                  </div>
                  {loading ? (
                    <div className="velas-cargando"><span className="spinner" /> Cargando…</div>
                  ) : v.length > 0 ? (
                    <GraficoVelas velas={v} patrones={[]} ticker={tkr} />
                  ) : (
                    <div className="filtro-vacio">Sin datos para {fechaMulti}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function SesionCard({ sesion, activo, onClick }) {
  const up = sesion.gapDir === 'up'
  return (
    <div
      className={`sesion-card ${up ? 'up' : 'down'} ${activo ? 'activo' : ''}`}
      onClick={onClick}
    >
      <div className="sesion-card-izq">
        <span className="sesion-card-dia">{DIA_CORTO[sesion.dayOfWeek]}</span>
        <span className="sesion-card-fecha">{sesion.date}</span>
      </div>
      <div className={`sesion-card-gap ${up ? 'verde' : 'rojo'}`}>
        {up ? '▲' : '▼'} {sesion.gapPct > 0 ? '+' : ''}{sesion.gapPct.toFixed(3)}%
        <span className="sesion-card-gap-pts">
          {' '}({sesion.openPrice - sesion.prevClose > 0 ? '+' : ''}
          {(sesion.openPrice - sesion.prevClose).toFixed(2)})
        </span>
      </div>
      <div className="sesion-card-derecha">
        <div className="sesion-card-precios">
          {sesion.prevClose.toFixed(2)} → {sesion.openPrice.toFixed(2)}
        </div>
        {sesion.eventos?.length > 0 && (
          <div className="sesion-card-eventos">
            {sesion.eventos.map(e => (
              <span key={e} className={`ev-badge ev-${e.toLowerCase()}`}>{e}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function VelasTabla({ velas }) {
  const fmtHora = ts => new Date(ts * 1000).toLocaleTimeString('es-ES', {
    timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit',
  })
  return (
    <div className="velas-tabla-wrap">
      <table className="velas-tabla">
        <thead>
          <tr>
            <th>Hora</th><th>Open</th><th>High</th><th>Low</th><th>Close</th>
            <th>Rango</th><th>Dir</th>
          </tr>
        </thead>
        <tbody>
          {velas.map(v => {
            const alcista = v.close >= v.open
            return (
              <tr key={v.time} className={alcista ? 'fila-up' : 'fila-down'}>
                <td>{fmtHora(v.time)}</td>
                <td>{v.open.toFixed(2)}</td>
                <td>{v.high.toFixed(2)}</td>
                <td>{v.low.toFixed(2)}</td>
                <td><strong>{v.close.toFixed(2)}</strong></td>
                <td>{(v.high - v.low).toFixed(2)}</td>
                <td>{alcista ? '▲' : '▼'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
