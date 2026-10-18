import { useState, useEffect } from 'react'
import FiltroGap from './FiltroGap'
import SubirDatos from './SubirDatos'
import Calendario from './Calendario'
import Pipeline from './Pipeline'
import QuoteBar from './QuoteBar'
import Operaciones from './Operaciones'
import Diario from './Diario'
import Seguimiento from './Seguimiento'
import Fotos from './Fotos'
import Book from './Book'
import Estrategias from './Estrategias.jsx'
import Grafico from './Grafico'
import Estadisticas from './Estadisticas.jsx'
import Bot from './Bot'
import './App.css'

// Trazos de iconos (24×24, estilo lineal) para la barra lateral
const ICONOS = {
  gap:      'M3 17l5-5 4 4 8-8M14 8h6v6',
  graf:     'M7 3v4M7 17v4M5 7h4v10H5zM17 5v3M17 15v4M15 8h4v7h-4z',
  cal:      'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4',
  estr:     'M12 3l8 4.5-8 4.5-8-4.5L12 3zM4 12l8 4.5 8-4.5M4 16.5L12 21l8-4.5',
  ops:      'M4 20V10M10 20V4M16 20v-7M22 20H2',
  diario:   'M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3V4zM5 17a3 3 0 013-3h11M9 8h6',
  seg:      'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  stats:    'M12 3v9h9a9 9 0 11-9-9zM15 3.5A9 9 0 0120.5 9H15z',
  bot:      'M5 9h14v10H5zM12 5v4M9 13h.01M15 13h.01M9 16h6M12 5a1 1 0 100-2 1 1 0 000 2z',
  datos:    'M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 002 2h12a2 2 0 002-2v-4',
  pipeline: 'M6 4l14 8-14 8V4z',
  fotos:    'M3 7h4l2-3h6l2 3h4v13H3zM12 17a4 4 0 100-8 4 4 0 000 8z',
  horror:   'M12 3l10 18H2L12 3zM12 10v5M12 18v.01',
  glory:    'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9L12 3z',
}

const GRUPOS = [
  { titulo: 'Mercado', tabs: [
    { id: 'gap',  label: 'Gap Filter' },
    { id: 'graf', label: 'Gráfico' },
    { id: 'cal',  label: 'Calendario' },
    { id: 'estr', label: 'Estrategias' },
  ] },
  { titulo: 'Trading', tabs: [
    { id: 'ops',    label: 'Operaciones' },
    { id: 'diario', label: 'Diario' },
    { id: 'seg',    label: 'Seguimiento' },
    { id: 'stats',  label: 'Estadísticas' },
    // el bot opera en la demo de IG desde el servidor (en la nube, con BOT_OPERA=1); en
    // producción la pestaña pide la clave del bot
    { id: 'bot', label: 'Bot SRS' },
  ] },
  { titulo: 'Datos', tabs: [
    { id: 'datos', label: 'Subir datos' },
  ] },
  ...( import.meta.env.DEV ? [
    { titulo: 'Local', tabs: [
      { id: 'pipeline', label: 'Pipeline' },
      { id: 'fotos',    label: 'Fotos' },
      { id: 'horror',   label: 'Book of Horror' },
      { id: 'glory',    label: 'Book of Glory' },
    ] },
  ] : []),
]

const TABS = GRUPOS.flatMap(g => g.tabs.map(t => ({ ...t, grupo: g.titulo })))

function Icono({ id }) {
  return (
    <svg className="nav-icono" viewBox="0 0 24 24" aria-hidden="true">
      <path d={ICONOS[id]} />
    </svg>
  )
}

function tabInicial() {
  const enUrl = window.location.hash.slice(1)
  if (TABS.some(t => t.id === enUrl)) return enUrl
  try {
    const guardada = localStorage.getItem('sa.tab')
    if (TABS.some(t => t.id === guardada)) return guardada
  } catch { /* sin almacenamiento */ }
  return 'gap'
}

export default function App() {
  const [tab, setTab] = useState(tabInicial)
  // Trade que Seguimiento pide abrir en Operaciones (fecha + producto)
  const [irATrade, setIrATrade] = useState(null)
  const actual = TABS.find(t => t.id === tab)

  useEffect(() => {
    try { localStorage.setItem('sa.tab', tab) } catch { /* sin almacenamiento */ }
    if (window.location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`)
  }, [tab])

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="marca">
          <span className="marca-logo" aria-hidden="true">SA</span>
          <div className="marca-texto">
            <strong>Situational Analysis</strong>
            <span>Trading desk</span>
          </div>
        </div>
        <nav className="nav" aria-label="Secciones">
          {GRUPOS.map(g => (
            <div key={g.titulo} className="nav-grupo">
              <div className="nav-grupo-titulo">{g.titulo}</div>
              {g.tabs.map(t => (
                <button
                  key={t.id}
                  className={`nav-item ${tab === t.id ? 'activo' : ''}`}
                  aria-current={tab === t.id ? 'page' : undefined}
                  onClick={() => setTab(t.id)}
                >
                  <Icono id={t.id} />
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-pie">
          <span className={`entorno ${import.meta.env.DEV ? 'dev' : 'prod'}`}>
            {import.meta.env.DEV ? 'Local' : 'Producción'}
          </span>
        </div>
      </aside>

      <div className="principal">
        <header className="topbar">
          <div className="topbar-titulo">
            <span className="topbar-grupo">{actual?.grupo}</span>
            <span className="topbar-sep">/</span>
            <h1>{actual?.label}</h1>
          </div>
          <QuoteBar />
        </header>

        <main className={`contenido ${tab === 'graf' ? 'contenido-ancho' : ''}`}>
          {tab === 'gap'      && <FiltroGap />}
          {tab === 'graf'     && <Grafico />}
          {tab === 'datos'    && <SubirDatos />}
          {tab === 'cal'      && <Calendario />}
          {tab === 'ops'      && <Operaciones abrir={irATrade} onAbierto={() => setIrATrade(null)} />}
          {tab === 'diario'   && <Diario />}
          {tab === 'seg'      && (
            <Seguimiento onIrATrade={p => { setIrATrade(p); setTab('ops') }} />
          )}
          {tab === 'estr'     && <Estrategias />}
          {tab === 'stats'    && <Estadisticas />}
          {tab === 'bot'      && <Bot />}
          {tab === 'pipeline' && <Pipeline />}
          {tab === 'fotos'    && <Fotos />}
          {tab === 'horror'   && <Book key="horror" book="horror" nombre="Book of Horror" icono="📕" />}
          {tab === 'glory'    && <Book key="glory"  book="glory"  nombre="Book of Glory"  icono="📗" />}
        </main>
      </div>
    </div>
  )
}
