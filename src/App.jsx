import { useState } from 'react'
import FiltroGap from './FiltroGap'
import SubirDatos from './SubirDatos'
import Calendario from './Calendario'
import Pipeline from './Pipeline'
import QuoteBar from './QuoteBar'
import './App.css'

const TABS = [
  { id: 'gap',      label: 'Gap Filter' },
  { id: 'datos',    label: 'Subir datos' },
  { id: 'cal',      label: 'Calendario' },
  ...( import.meta.env.DEV ? [{ id: 'pipeline', label: '▶ Pipeline' }] : []),
]

export default function App() {
  const [tab, setTab] = useState('gap')
  return (
    <div className="app">
      <header className="app-header">
        <div className="header-top">
          <h1>Situational Analysis</h1>
          <p className="subtitulo">Gap Filter · DAX · FTSE · S&amp;P · Nasdaq · DJ · Oro · Plata · Petróleo</p>
        </div>
        <QuoteBar />
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
