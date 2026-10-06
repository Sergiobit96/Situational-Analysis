import { useState, useEffect, useRef, useCallback } from 'react'
import { CATEGORIAS_HORROR } from './parseTrades'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'

const ICONOS = {
  pdf: '📕', ppt: '📊', pptx: '📊', xls: '📈', xlsx: '📈',
  doc: '📄', docx: '📄', csv: '📑', txt: '📝', zip: '🗜️', rar: '🗜️',
  mp4: '🎬', mov: '🎬', avi: '🎬',
}

function extension(nombre) {
  const i = nombre.lastIndexOf('.')
  return i === -1 ? '' : nombre.slice(i + 1).toLowerCase()
}

function formatBytes(b) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

function formatFecha(ms) {
  return new Date(ms).toLocaleDateString('es-ES', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// De qué trade del archivo es el archivo, legible: la clave es '2026-08-11_GOLD' para las
// capturas fechadas y '2023#0408' para las numeradas de 2022-2023.
function tradeDeClave(clave) {
  if (!clave) return null
  if (clave.includes('#')) {
    const [anio, numero] = clave.split('#')
    return `${anio} · #${numero}`
  }
  const [fecha, instrumento] = clave.split('_')
  const [anio, mes, dia]     = fecha.split('-')
  return `${dia}/${mes}/${anio}${instrumento ? ` · ${instrumento}` : ''}`
}

// Un book es una carpeta de archivos sueltos: el de Horror guarda los errores y el de Glory
// los trades bien hechos. Los dos usan los mismos endpoints con ?book=.
export default function Book({ book = 'horror', nombre = 'Book of Horror', icono = '📕' }) {
  const [archivos, setArchivos] = useState([])
  const [carpeta,  setCarpeta]  = useState('')
  const [cargando, setCargando] = useState(true)
  const [subiendo, setSubiendo] = useState(false)
  const [error,    setError]    = useState(null)
  const [aviso,    setAviso]    = useState(null)
  const [dragging, setDragging] = useState(false)
  const [zoom,     setZoom]     = useState(null)
  const [editando, setEditando] = useState(null)   // id del archivo cuyo nombre se está editando
  const inputRef = useRef(null)

  const urlArchivo = useCallback(
    (id, descargar = false) =>
      `${API}/api/books/archivo?book=${book}&id=${encodeURIComponent(id)}${descargar ? '&descargar=1' : ''}`,
    [book],
  )

  const cargarLista = useCallback(() => {
    fetch(`${API}/api/books/lista?book=${book}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) throw new Error(data.error)
        setArchivos(data.archivos)
        setCarpeta(data.carpeta)
        setError(null)
      })
      .catch(err => setError(err.message))
      .finally(() => setCargando(false))
  }, [book])

  // Cada book se monta en su propia pestaña (con su key), así que no hay lista que heredar
  useEffect(() => { cargarLista() }, [cargarLista])

  const subir = useCallback(async files => {
    const lista = [...files]
    if (lista.length === 0) return
    const form = new FormData()
    for (const f of lista) form.append('archivos', f)

    setSubiendo(true)
    setError(null)
    setAviso(null)
    try {
      const res  = await fetch(`${API}/api/books/subir?book=${book}`, { method: 'POST', body: form })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setAviso(`${data.subidos.length} archivo(s) subido(s): ${data.subidos.join(', ')}`)
      cargarLista()
    } catch (err) {
      setError(`No se pudo subir: ${err.message}`)
    } finally {
      setSubiendo(false)
    }
  }, [book, cargarLista])

  const borrar = useCallback(async archivo => {
    if (!window.confirm(`¿Quitar "${archivo.nombre}" del ${nombre}?\n\nSe mueve a la subcarpeta "papelera", no se destruye.`)) return
    setError(null)
    setAviso(null)
    try {
      const res  = await fetch(`${API}/api/books/archivo?book=${book}&id=${encodeURIComponent(archivo.id)}`, { method: 'DELETE' })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setArchivos(prev => prev.filter(a => a.id !== archivo.id))
      setAviso(`"${archivo.nombre}" movido a la papelera`)
    } catch (err) {
      setError(`No se pudo borrar: ${err.message}`)
    }
  }, [book, nombre])

  const renombrar = useCallback(async (archivo, nombreNuevo) => {
    const limpio = nombreNuevo.trim()
    setEditando(null)
    if (!limpio || limpio === archivo.nombre) return
    setError(null)
    setAviso(null)
    try {
      const res = await fetch(`${API}/api/books/archivo?book=${book}&id=${encodeURIComponent(archivo.id)}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ nombre: limpio }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setArchivos(prev => prev.map(a => (a.id === archivo.id
        ? { ...a, id: data.id, nombre: data.nombre, clave: data.clave, comentario: data.comentario, cats: data.cats }
        : a)))
      setAviso(`Renombrado a "${data.nombre}"`)
    } catch (err) {
      setError(`No se pudo renombrar: ${err.message}`)
    }
  }, [book])

  const onDrop = useCallback(e => {
    e.preventDefault()
    setDragging(false)
    subir(e.dataTransfer.files)
  }, [subir])

  const onFileInput = e => {
    subir(e.target.files)
    e.target.value = ''
  }

  useEffect(() => {
    if (!zoom) return
    const onKeyDown = e => { if (e.key === 'Escape') setZoom(null) }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [zoom])

  return (
    <div className="fotos-page">
      <div
        className={`drop-zone ${dragging ? 'dragging' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
      >
        <input ref={inputRef} type="file" multiple hidden onChange={onFileInput} />
        <div className="drop-icon">{icono}</div>
        <div className="drop-text">
          {subiendo
            ? 'Subiendo…'
            : dragging
              ? 'Suelta los archivos aquí'
              : `Arrastra capturas, PPTX o PDF del ${nombre}, o haz clic para seleccionar`}
        </div>
        <div className="drop-hint">
          Se guardan en {carpeta || `la carpeta del ${nombre}`} · máx. 20 archivos de 200 MB por subida
          <br />
          Desde <strong>Diario → Trades comentados</strong> se añaden con un solo clic, y ahí llega
          también su comentario
        </div>
      </div>

      {error && <div className="fotos-error">{error}</div>}
      {aviso && <div className="horror-aviso">{aviso}</div>}

      <div className="fotos-toolbar">
        <span className="fotos-total">
          {cargando ? 'Cargando archivos…' : `${archivos.length} archivo(s) en el ${nombre}`}
        </span>
        <button
          className="clear-eventos"
          onClick={() => { setCargando(true); cargarLista() }}
          disabled={cargando}
        >↻ actualizar</button>
      </div>

      {!cargando && archivos.length === 0 && !error && (
        <div className="fotos-placeholder">Todavía no has subido nada al {nombre}</div>
      )}

      <div className="horror-archivos">
        {archivos.map(a => (
          <div key={a.id} className="horror-archivo">
            {a.esImagen ? (
              <img
                className="horror-thumb"
                src={urlArchivo(a.id)}
                alt={a.nombre}
                onClick={() => setZoom(a)}
                title="Clic para agrandar"
              />
            ) : (
              <a
                className="horror-thumb horror-thumb-doc"
                href={urlArchivo(a.id, true)}
              >{ICONOS[extension(a.nombre)] ?? '📎'}</a>
            )}
            {editando === a.id ? (
              <input
                className="horror-nombre-input"
                defaultValue={a.nombre}
                autoFocus
                onFocus={e => e.target.select()}
                onBlur={e => renombrar(a, e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') e.target.blur()
                  // restaurar el original antes del blur deja el guardado en nada
                  if (e.key === 'Escape') { e.target.value = a.nombre; e.target.blur() }
                }}
              />
            ) : (
              <div
                className="horror-nombre"
                title={`${a.nombre}\n(doble clic para renombrar)`}
                onDoubleClick={() => setEditando(a.id)}
              >{a.nombre}</div>
            )}

            {/* comentario y etiquetas son los del trade: el comentario se escribe en
                Diario → Trades comentados y las etiquetas en Operaciones */}
            {a.clave && <span className="book-trade">{tradeDeClave(a.clave)}</span>}

            {a.cats?.length > 0 && (
              <div className="horror-badges-cell">
                {a.cats.map(n => {
                  const cat = CATEGORIAS_HORROR.find(c => c.n === n)
                  return (
                    <span key={n} className="horror-badge" title={cat?.nombre ?? `Categoría ${n}`}>
                      #{n} {cat?.corto ?? ''}
                    </span>
                  )
                })}
              </div>
            )}
            {a.comentario ? (
              <p className="book-comentario" title="Se edita en Diario → Trades comentados">{a.comentario}</p>
            ) : (
              <p className="book-comentario vacio">
                {a.clave ? 'Sin comentario' : 'Sin comentario · no enlaza con ningún trade del archivo'}
              </p>
            )}

            <div className="horror-pie">
              <span className="horror-meta">{formatBytes(a.bytes)} · {formatFecha(a.modificado)}</span>
              <span className="horror-acciones">
                <button className="horror-accion" onClick={() => setEditando(a.id)} title="Renombrar">✏️</button>
                <button className="horror-accion horror-borrar" onClick={() => borrar(a)} title="Mover a la papelera">🗑</button>
              </span>
            </div>
          </div>
        ))}
      </div>

      {zoom && (
        <div className="fotos-lightbox" onClick={() => setZoom(null)}>
          <button className="fotos-lightbox-cerrar" onClick={() => setZoom(null)} title="Cerrar (Esc)">×</button>
          <div className="ts-zoom" onClick={e => e.stopPropagation()}>
            <img className="fotos-lightbox-img" src={urlArchivo(zoom.id)} alt={zoom.nombre} />
            {zoom.comentario && (
              <div className="ts-zoom-pie">
                <span className="ts-zoom-tit">{zoom.nombre}</span>
                <p className="book-comentario">{zoom.comentario}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
