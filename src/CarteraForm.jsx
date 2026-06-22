import { useState, useRef } from 'react'

export default function CarteraForm({ label, color, cartera, onChange }) {
  const [ticker, setTicker]           = useState('')
  const [precioCompra, setPrecioCompra] = useState('')
  const [acciones, setAcciones]       = useState('')
  const [csvError, setCsvError]       = useState(null)
  const fileRef = useRef()

  const agregar = () => {
    const t = ticker.trim().toUpperCase()
    const p = parseFloat(precioCompra)
    const a = parseFloat(acciones)
    if (!t || isNaN(p) || p <= 0 || isNaN(a) || a <= 0) return
    onChange([...cartera, { ticker: t, precioCompra: p, acciones: a }])
    setTicker('')
    setPrecioCompra('')
    setAcciones('')
  }

  const eliminar = (i) => onChange(cartera.filter((_, idx) => idx !== i))

  const subirCSV = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    setCsvError(null)
    const formData = new FormData()
    formData.append('archivo', file)
    try {
      const res = await fetch('/api/subir-csv', { method: 'POST', body: formData })
      const texto = await res.text()
      if (!texto) throw new Error('El servidor no respondió')
      const data = JSON.parse(texto)
      if (!res.ok) throw new Error(data.error)
      onChange(data.cartera)
    } catch (err) {
      setCsvError(err.message)
    }
    e.target.value = ''
  }

  const valorInvertido = cartera.reduce((s, a) => s + a.precioCompra * a.acciones, 0)

  return (
    <div className="cartera-panel" style={{ '--color': color }}>
      <h2 className="cartera-titulo">{label}</h2>

      <div className="input-grid">
        <input
          className="input-ticker"
          placeholder="Ticker (ej: AAPL)"
          value={ticker}
          onChange={e => setTicker(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && agregar()}
        />
        <input
          className="input-numero"
          type="number"
          placeholder="Precio compra"
          min="0"
          value={precioCompra}
          onChange={e => setPrecioCompra(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && agregar()}
        />
        <input
          className="input-numero"
          type="number"
          placeholder="Nº acciones"
          min="0"
          value={acciones}
          onChange={e => setAcciones(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && agregar()}
        />
        <button className="btn-add" onClick={agregar}>+</button>
      </div>

      <ul className="activos-lista">
        {cartera.length === 0 && (
          <li className="lista-vacia">Sin posiciones todavía</li>
        )}
        {cartera.map((a, i) => (
          <li key={i} className="activo-item">
            <span className="activo-ticker">{a.ticker}</span>
            <span className="activo-detalle">{a.acciones} acc. × {a.precioCompra.toFixed(2)}</span>
            <span className="activo-valor">{(a.precioCompra * a.acciones).toLocaleString('es-ES', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}</span>
            <button className="btn-eliminar" onClick={() => eliminar(i)}>✕</button>
          </li>
        ))}
      </ul>

      {cartera.length > 0 && (
        <p className="invertido-total">
          Invertido: {valorInvertido.toLocaleString('es-ES', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}
        </p>
      )}

      <button className="btn-csv" onClick={() => fileRef.current.click()}>
        Subir CSV
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".csv"
        style={{ display: 'none' }}
        onChange={subirCSV}
      />
      {csvError && <p className="error-small">{csvError}</p>}
      <p className="csv-hint">CSV con columnas: <code>ticker</code>, <code>precioCompra</code>, <code>acciones</code></p>
    </div>
  )
}
