import { useState, useEffect, useCallback } from 'react'
import './Tortugas.css'
import { conClaveBot, leerClaveBot } from './claveBot'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'

const fmtGenerada = iso => new Date(iso).toLocaleString('es-ES', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
})
const dia = f => f.split('-').reverse().join('/')

// Revisión del backtest escrita por Claude: si el resultado es sólido o frágil, de dónde sale,
// el riesgo de operarlo y qué probar. La escribe el servidor (/api/revision-backtest) y
// la guarda con los ajustes (`clave`), así que cada configuración se paga una sola vez salvo
// que se vuelva a pedir. El expediente también se puede copiar para pegarlo en una
// conversación con Claude. Sirve para las tortugas y para las intradía (`tipo`, que elige el
// prompt del servidor): `armar()` da el expediente, `hasta` la última sesión del backtest y
// `hayVariantes` si hay variantes comparadas de estos ajustes; `nota`, lo que lee Claude.
export default function RevisionBacktest({ clave, tipo = 'tortugas', armar, hasta, hayVariantes = false, nota }) {
  // la guardada y el error van con su clave: al cambiar un ajuste no se enseñan los de antes
  const [guardada, setGuardada] = useState({ clave: null, revision: null })
  const [pidiendo, setPidiendo] = useState(false)
  const [error, setError] = useState(null)
  const [copiado, setCopiado] = useState(false)
  // online la llamada va con la clave del bot, que se mete en la pestaña Bot: sin ella solo se
  // copia el expediente
  const conClaude = import.meta.env.DEV || !!leerClaveBot()

  useEffect(() => {
    if (!conClaude) return
    let vivo = true
    fetch(`${API}/api/revision-backtest?tipo=${tipo}&clave=${encodeURIComponent(clave)}`, { headers: conClaveBot() })
      .then(r => r.json())
      .then(d => { if (vivo) setGuardada({ clave, revision: d.revision ?? null }) })
      .catch(() => { if (vivo) setGuardada({ clave, revision: null }) })
    return () => { vivo = false }
  }, [clave, tipo, conClaude])

  const pedir = useCallback(async () => {
    setPidiendo(true)
    setError(null)
    try {
      const expediente = armar()
      const r = await fetch(`${API}/api/revision-backtest`, {
        method:  'POST',
        headers: conClaveBot({ 'Content-Type': 'application/json' }),
        body:    JSON.stringify({ tipo, clave, expediente }),
      })
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      setGuardada({ clave, revision: d.revision })
    } catch (err) {
      setError({ clave, texto: `No se pudo escribir la revisión: ${err.message}` })
    } finally {
      setPidiendo(false)
    }
  }, [clave, tipo, armar])

  const copiar = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(armar(), null, 2))
      setCopiado(true)
      setTimeout(() => setCopiado(false), 2000)
    } catch (err) {
      setError({ clave, texto: `No se pudo copiar: ${err.message}` })
    }
  }, [clave, armar])

  const cargada  = guardada.clave === clave
  const revision = cargada ? guardada.revision : null

  return (
    <div className="estr-resumen">
      <div className="tortugas-cabecera">
        <strong>Revisión con Claude</strong>
        <span className="tortugas-botones">
          {conClaude && (
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
          {(revision.datosHasta !== hasta || (hayVariantes && !revision.conVariantes)) && (
            <div className="ops-revision-pie">
              <strong>
                {revision.datosHasta !== hasta ? `El backtest ya llega al ${dia(hasta)}. ` : ''}
                {hayVariantes && !revision.conVariantes ? 'Ahora hay variantes comparadas, que esta revisión no vio. ' : ''}
              </strong>
              Vuelve a pedirla si quieres que lo tenga en cuenta.
            </div>
          )}
        </div>
      ) : (
        <p className="estr-nota">
          {conClaude
            ? nota
            : <>Para pedir la revisión con Claude, mete antes la clave del bot en la pestaña Bot. Sin ella puedes copiar
                el expediente (el resumen del backtest que lee Claude, en JSON) y pegarlo en una conversación con Claude.</>}
        </p>
      )}
    </div>
  )
}
