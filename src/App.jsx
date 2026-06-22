import { useState } from 'react'
import FiltroGap from './FiltroGap'
import SubirDatos from './SubirDatos'
import Calendario from './Calendario'
import Pipeline from './Pipeline'
import './App.css'

const TABS = [
  { id: 'gap',      label: 'Gap Filter' },
  { id: 'datos',    label: 'Subir datos' },
  { id: 'cal',      label: 'Calendario' },
  { id: 'pipeline', label: '▶ Pipeline' },
]

export default function App() {
  const [tab, setTab] = useState('gap')
  return (
    <div className="app">
      <header className="app-header">
        <div className="header-top">
          <h1>📊 Gap Filter</h1>
          <p className="subtitulo">Velas 15 min · Filtro de gaps · SP500 · Nasdaq · DAX</p>
        </div>
        <nav className="tab-nav">
          {TABS.map(t => (
            <button
              key={t.id}
              className={`tab-btn ${tab === t.id ? 'activo' : ''}`}
              onClick={() => setTab(t.id)}
            >{t.label}</button>
          ))}
        </nav>
      </header>
      {tab === 'gap'      && <FiltroGap />}
      {tab === 'datos'    && <SubirDatos />}
      {tab === 'cal'      && <Calendario />}
      {tab === 'pipeline' && <Pipeline />}
    </div>
  )
}
