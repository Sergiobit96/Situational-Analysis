import { useState, useEffect, useCallback } from 'react'
import { expedienteDelDia } from './estadisticas.js'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'

const fmtGenerada = iso => new Date(iso).toLocaleString('es-ES', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

// Revisión del día escrita por Claude: lee las operaciones de ese día con su MFE/MAE, tus
// comentarios y etiquetas, y lo compara con lo habitual. La escribe el servidor local
// (/api/revision-dia) y la guarda, así que cada día se paga una sola vez salvo que se vuelva
// a pedir.
export default function RevisionDia({ fecha, trades, anotaciones, resultados }) {
  // la guardada va con su fecha: al cambiar de día no se enseña la del anterior
  const [guardada, setGuardada] = useState({ fecha: null, revision: null })
  const [pidiendo, setPidiendo] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let vivo = true
    fetch(`${API}/api/revision-dia?fecha=${fecha}`)
      .then(r => r.json())
      .then(d => { if (vivo) setGuardada({ fecha, revision: d.revision ?? null }) })
      .catch(() => { if (vivo) setGuardada({ fecha, revision: null }) })
    return () => { vivo = false }
  }, [fecha])

  const pedir = useCallback(async () => {
    setPidiendo(true)
    setError(null)
    try {
      const expediente = expedienteDelDia(fecha, trades, { anotaciones, resultados })
      const res = await fetch(`${API}/api/revision-dia`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fecha, expediente }),
      })
      const d = await res.json()
      if (d.error) throw new Error(d.error)
      setGuardada({ fecha, revision: d.revision })
    } catch (err) {
      setError(`No se pudo escribir la revisión: ${err.message}`)
    } finally {
      setPidiendo(false)
    }
  }, [fecha, trades, anotaciones, resultados])

  const cargada  = guardada.fecha === fecha
  const revision = cargada ? guardada.revision : null

  return (
    <div className="ops-comentario ops-revision">
      <div className="ops-comentario-cabecera">
        <span className="ops-etiquetas-tit">Revisión del día con Claude</span>
        <span className="ops-comentario-clave">{fecha}</span>
        <span className="ops-etiquetas-guardar">
          <button
            className="diario-add"
            onClick={pedir}
            disabled={pidiendo || !cargada}
            title={revision
              ? 'Escribirla de nuevo, por ejemplo después de añadir comentarios o etiquetas (otra llamada de pago)'
              : 'Unos 5-10 céntimos por revisión; tarda unos 30 segundos'}
          >{pidiendo ? 'escribiendo… (unos 30 s)' : revision ? 'volver a pedir' : 'pedir revisión'}</button>
        </span>
      </div>

      {error && <div className="fotos-error">{error}</div>}

      {revision ? (
        <>
          <div className="ops-revision-texto">{revision.texto}</div>
          <div className="ops-revision-pie">
            {fmtGenerada(revision.generada)} · {revision.modelo}
            {Number.isFinite(revision.usd) && <> · {revision.usd.toLocaleString('es-ES', { maximumFractionDigits: 3 })} $</>}
          </div>
        </>
      ) : cargada && !pidiendo && (
        <p className="ops-revision-pie">
          Claude lee las operaciones de este día con su MFE y MAE, tus comentarios y etiquetas del
          Book of Horror, y lo compara con lo habitual de tu historial. Conviene pedirla después de
          comentar el día.
        </p>
      )}
    </div>
  )
}
