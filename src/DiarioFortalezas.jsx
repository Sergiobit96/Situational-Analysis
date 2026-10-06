import { useState, useEffect, useCallback, useRef } from 'react'

const STORAGE_KEY = 'abcd_diario_v1'

// Las dos listas del diario. `pareja` apunta a la otra columna para poder mover
// una entrada de lado (una debilidad corregida pasa a fortaleza sin reescribirla).
const COLUMNAS = [
  {
    id: 'fortalezas',
    pareja: 'debilidades',
    label: 'Fortalezas',
    icono: '💪',
    clase: 'verde',
    placeholder: 'Ej.: respeto el stop inicial sin moverlo',
    vacio: 'Apunta lo que ya haces bien y quieres repetir',
  },
  {
    id: 'debilidades',
    pareja: 'fortalezas',
    label: 'Debilidades',
    icono: '⚠️',
    clase: 'roja',
    placeholder: 'Ej.: entro antes de que cierre la vela',
    vacio: 'Apunta el error que se te repite, con tus palabras exactas',
  },
]

const VACIO = { fortalezas: [], debilidades: [] }

function nuevoId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// Solo se aceptan entradas con texto: así un JSON importado a mano o un guardado
// a medias no mete tarjetas fantasma en la lista.
function saneaLista(lista) {
  if (!Array.isArray(lista)) return []
  return lista
    .filter(e => e && typeof e.texto === 'string' && e.texto.trim())
    .map(e => ({
      id:      typeof e.id === 'string' ? e.id : nuevoId(),
      texto:   e.texto.trim(),
      creado:  Number.isFinite(e.creado)  ? e.creado  : Date.now(),
      editado: Number.isFinite(e.editado) ? e.editado : null,
      movido:  Number.isFinite(e.movido)  ? e.movido  : null,
      desde:   e.desde === 'fortalezas' || e.desde === 'debilidades' ? e.desde : null,
    }))
}

function leerGuardado() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return VACIO
    const data = JSON.parse(raw)
    return { fortalezas: saneaLista(data?.fortalezas), debilidades: saneaLista(data?.debilidades) }
  } catch {
    return VACIO
  }
}

function formatFecha(ms) {
  return new Date(ms).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function hoyISO() {
  const d   = new Date()
  const mes = String(d.getMonth() + 1).padStart(2, '0')
  const dia = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mes}-${dia}`
}

export default function DiarioFortalezas() {
  const [entradas, setEntradas] = useState(leerGuardado)
  const [borrador, setBorrador] = useState({ fortalezas: '', debilidades: '' })
  const [editando, setEditando] = useState(null)   // id de la entrada en edición
  const [aviso,    setAviso]    = useState(null)
  const importRef = useRef(null)

  // Persistencia en localStorage: el diario no sale nunca del navegador, igual que
  // las operaciones del Excel (useTrades). Copia de seguridad con exportar/importar.
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entradas)) } catch { /* cuota llena, no crítico */ }
  }, [entradas])

  const añadir = useCallback(col => {
    const texto = borrador[col].trim()
    if (!texto) return
    setEntradas(prev => ({
      ...prev,
      [col]: [{ id: nuevoId(), texto, creado: Date.now(), editado: null, movido: null, desde: null }, ...prev[col]],
    }))
    setBorrador(prev => ({ ...prev, [col]: '' }))
    setAviso(null)
  }, [borrador])

  const guardarEdicion = useCallback((col, entrada, textoNuevo) => {
    const limpio = textoNuevo.trim()
    setEditando(null)
    if (!limpio || limpio === entrada.texto) return
    setEntradas(prev => ({
      ...prev,
      [col]: prev[col].map(e => (e.id === entrada.id ? { ...e, texto: limpio, editado: Date.now() } : e)),
    }))
  }, [])

  const borrar = useCallback((col, entrada) => {
    if (!window.confirm(`¿Borrar esta entrada del diario?\n\n"${entrada.texto}"`)) return
    setEntradas(prev => ({ ...prev, [col]: prev[col].filter(e => e.id !== entrada.id) }))
  }, [])

  const mover = useCallback((col, destino, entrada) => {
    setEntradas(prev => ({
      ...prev,
      [col]:     prev[col].filter(e => e.id !== entrada.id),
      [destino]: [{ ...entrada, movido: Date.now(), desde: col }, ...prev[destino]],
    }))
  }, [])

  const exportar = useCallback(() => {
    const blob = new Blob([JSON.stringify(entradas, null, 2)], { type: 'application/json' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `diario-${hoyISO()}.json`
    a.click()
    URL.revokeObjectURL(url)
    setAviso('Diario exportado')
  }, [entradas])

  const importar = useCallback(async file => {
    if (!file) return
    try {
      const data   = JSON.parse(await file.text())
      const nuevas = { fortalezas: saneaLista(data?.fortalezas), debilidades: saneaLista(data?.debilidades) }
      if (nuevas.fortalezas.length === 0 && nuevas.debilidades.length === 0) {
        throw new Error('el archivo no contiene entradas')
      }
      // Fusión por id: importar dos veces la misma copia no duplica nada.
      let sumadas = 0
      setEntradas(prev => {
        const fusion = {}
        for (const col of ['fortalezas', 'debilidades']) {
          const vistos = new Set(prev[col].map(e => e.id))
          const extra  = nuevas[col].filter(e => !vistos.has(e.id))
          sumadas += extra.length
          fusion[col] = [...prev[col], ...extra].sort((a, b) => b.creado - a.creado)
        }
        return fusion
      })
      setAviso(sumadas === 0 ? 'Nada nuevo: ya tenías todas esas entradas' : `${sumadas} entrada(s) importada(s)`)
    } catch (err) {
      setAviso(`No se pudo importar: ${err.message}`)
    }
  }, [])

  const total = entradas.fortalezas.length + entradas.debilidades.length

  return (
    <div className="diario-page">
      <div className="diario-intro">
        <h2>Tus fortalezas y debilidades operando</h2>
        <p>
          Escríbelas tal cual las ves. Enter guarda la entrada (Shift+Enter hace un salto de línea)
          y doble clic sobre una la reescribe. Cuando corriges una debilidad, muévela a fortalezas
          con ⇄ y queda marcada como conquistada.
        </p>
      </div>

      <div className="diario-toolbar">
        <span className="diario-total">
          {total === 0
            ? 'Diario vacío'
            : `${total} entrada(s) · ${entradas.fortalezas.length} fortaleza(s) · ${entradas.debilidades.length} debilidad(es)`}
        </span>
        <span className="diario-toolbar-acciones">
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={e => { importar(e.target.files[0]); e.target.value = '' }}
          />
          <button className="diario-boton" onClick={() => importRef.current?.click()}>↥ importar</button>
          <button className="diario-boton" onClick={exportar} disabled={total === 0}>↧ exportar</button>
        </span>
      </div>

      {aviso && <div className="diario-aviso">{aviso}</div>}

      <div className="diario-grid">
        {COLUMNAS.map(col => {
          const otra = COLUMNAS.find(c => c.id === col.pareja)
          return (
            <section key={col.id} className={`diario-col ${col.clase}`}>
              <header className="diario-col-head">
                <h3>{col.icono} {col.label}</h3>
                <span className="diario-col-num">{entradas[col.id].length}</span>
              </header>

              <div className="diario-nueva">
                <textarea
                  className="diario-input"
                  rows={2}
                  placeholder={col.placeholder}
                  value={borrador[col.id]}
                  onChange={e => setBorrador(prev => ({ ...prev, [col.id]: e.target.value }))}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); añadir(col.id) }
                  }}
                />
                <button
                  className="diario-add"
                  onClick={() => añadir(col.id)}
                  disabled={!borrador[col.id].trim()}
                >+ añadir</button>
              </div>

              {entradas[col.id].length === 0 && (
                <div className="diario-placeholder">{col.vacio}</div>
              )}

              <ul className="diario-lista">
                {entradas[col.id].map(entrada => (
                  <li key={entrada.id} className="diario-entrada">
                    {editando === entrada.id ? (
                      <textarea
                        className="diario-edit"
                        rows={2}
                        defaultValue={entrada.texto}
                        autoFocus
                        onFocus={ev => ev.target.select()}
                        onBlur={ev => guardarEdicion(col.id, entrada, ev.target.value)}
                        onKeyDown={ev => {
                          if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); ev.target.blur() }
                          // restaurar el original antes del blur deja el guardado en nada
                          if (ev.key === 'Escape') { ev.target.value = entrada.texto; ev.target.blur() }
                        }}
                      />
                    ) : (
                      <div
                        className="diario-texto"
                        title="Doble clic para editar"
                        onDoubleClick={() => setEditando(entrada.id)}
                      >{entrada.texto}</div>
                    )}

                    <div className="diario-pie">
                      <span className="diario-meta">
                        {formatFecha(entrada.creado)}
                        {entrada.editado ? ' · editada' : ''}
                        {entrada.desde === 'debilidades' && <span className="diario-badge verde">conquistada</span>}
                        {entrada.desde === 'fortalezas'  && <span className="diario-badge roja">recaída</span>}
                      </span>
                      <span className="diario-acciones">
                        <button
                          className="diario-accion"
                          onClick={() => mover(col.id, col.pareja, entrada)}
                          title={`Mover a ${otra.label}`}
                        >⇄</button>
                        <button
                          className="diario-accion"
                          onClick={() => setEditando(entrada.id)}
                          title="Editar"
                        >✏️</button>
                        <button
                          className="diario-accion diario-borrar"
                          onClick={() => borrar(col.id, entrada)}
                          title="Borrar"
                        >🗑</button>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}
