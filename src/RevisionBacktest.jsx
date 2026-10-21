import { useState, useEffect, useCallback } from 'react'
import { expedienteBacktest } from './tortugas'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'
// la clave de Anthropic solo está en el servidor local: online solo se copia el expediente
const CON_CLAUDE = import.meta.env.DEV

const fmtGenerada = iso => new Date(iso).toLocaleString('es-ES', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
})
const dia = f => f.split('-').reverse().join('/')

// Revisión del backtest escrita por Claude: si el resultado es sólido o frágil, de dónde sale,
// el riesgo de operarlo y qué probar. La escribe el servidor local (/api/revision-backtest) y
// la guarda con los ajustes (`clave`), así que cada configuración se paga una sola vez salvo
// que se vuelva a pedir. El expediente también se puede copiar para pegarlo en una
// conversación con Claude. `variantes`: las de «Comparar variantes», solo si son de estos ajustes.
export default function RevisionBacktest({ clave, res, universo, variantes }) {
  // la guardada y el error van con su clave: al cambiar un ajuste no se enseñan los de antes
  const [guardada, setGuardada] = useState({ clave: null, revision: null })
  const [pidiendo, setPidiendo] = useState(false)
  const [error, setError] = useState(null)
  const [copiado, setCopiado] = useState(false)

  useEffect(() => {
    if (!CON_CLAUDE) return
    let vivo = true
    fetch(`${API}/api/revision-backtest?clave=${encodeURIComponent(clave)}`)
      .then(r => r.json())
      .then(d => { if (vivo) setGuardada({ clave, revision: d.revision ?? null }) })
      .catch(() => { if (vivo) setGuardada({ clave, revision: null }) })
    return () => { vivo = false }
  }, [clave])

  const pedir = useCallback(async () => {
    setPidiendo(true)
    setError(null)
    try {
      const expediente = expedienteBacktest(res, { universo, variantes })
      const r = await fetch(`${API}/api/revision-backtest`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ clave, expediente }),
      })
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      setGuardada({ clave, revision: d.revision })
    } catch (err) {
      setError({ clave, texto: `No se pudo escribir la revisión: ${err.message}` })
    } finally {
      setPidiendo(false)
    }
  }, [clave, res, universo, variantes])

  const copiar = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(expedienteBacktest(res, { universo, variantes }), null, 2))
      setCopiado(true)
      setTimeout(() => setCopiado(false), 2000)
    } catch (err) {
      setError({ clave, texto: `No se pudo copiar: ${err.message}` })
    }
  }, [clave, res, universo, variantes])

  const cargada  = guardada.clave === clave
  const revision = cargada ? guardada.revision : null
  const hasta    = res.curva.at(-1).date

  return (
    <div className="estr-resumen">
      <div className="tortugas-cabecera">
        <strong>Revisión con Claude</strong>
        <span className="tortugas-botones">
          {CON_CLAUDE && (
            <button
              className="chip"
              onClick={pedir}
              disabled={pidiendo || !cargada}
              title={revision
                ? 'Escribirla de nuevo, por ejemplo con las sesiones nuevas o después de comparar variantes (otra llamada de pago)'
                : 'Unos 10-20 céntimos por revisión; tarda menos de un minuto'}
            >{pidiendo ? 'Escribiendo… (menos de un minuto)' : revision ? 'Volver a pedir' : 'Pedir revisión'}</button>
          )}
          <button className="chip" onClick={copiar}
            title="Lo mismo que lee Claude, en JSON, para pegarlo en una conversación">{copiado ? 'Copiado' : 'Copiar expediente'}</button>
        </span>
      </div>

      {error?.clave === clave && <div className="error-global">{error.texto}</div>}

      {revision ? (
        <div className="tortugas-revision">
          <div className="ops-revision-texto">{revision.texto}</div>
          <div className="ops-revision-pie">
            {fmtGenerada(revision.generada)} · {revision.modelo}
            {Number.isFinite(revision.usd) && <> · {revision.usd.toLocaleString('es-ES', { maximumFractionDigits: 3 })} $</>}
            {' · '}con datos hasta el {dia(revision.datosHasta)}{revision.conVariantes ? ' y las variantes' : ''}
          </div>
          {(revision.datosHasta !== hasta || (variantes && !revision.conVariantes)) && (
            <div className="ops-revision-pie">
              <strong>
                {revision.datosHasta !== hasta ? `El backtest ya llega al ${dia(hasta)}. ` : ''}
                {variantes && !revision.conVariantes ? 'Ahora hay variantes comparadas, que esta revisión no vio. ' : ''}
              </strong>
              Vuelve a pedirla si quieres que lo tenga en cuenta.
            </div>
          )}
        </div>
      ) : (
        <p className="estr-nota">
          {CON_CLAUDE
            ? <>Claude lee el resumen, los años, las peores caídas, las dos mitades del periodo, de dónde sale el
                beneficio (mercados, pirámide, lados, las mejores operaciones) y las limitaciones de los datos, y dice si
                el resultado es sólido o frágil y qué probar para comprobarlo. Si antes pulsas <strong>Comparar
                variantes</strong>, también las tiene en cuenta para juzgar si estos ajustes están hechos a medida de la historia.</>
            : <>La revisión con Claude solo está con el servidor local. Aquí puedes copiar el expediente (el resumen del
                backtest que lee Claude, en JSON) y pegarlo en una conversación con Claude.</>}
        </p>
      )}
    </div>
  )
}
