// ── Noticias de alto impacto ──────────────────────────────────────────────────────────
// Los bots no entran de X minutos antes a X minutos después de un dato de alto impacto (NFP,
// IPC, bancos centrales…) de la divisa del mercado o del dólar, que mueve a todos: en ese rato
// el precio salta y el deslizamiento se dispara. El calendario es el de ForexFactory (el mismo
// de la pestaña Calendario), que se lee al arrancar y cada hora; lo leído se guarda en disco por
// si un día no contesta. Solo frena las entradas: los stops y las salidas van siempre.

import { readFileSync, writeFileSync, renameSync } from 'fs'

const URL_FF = slug => `https://nfs.faireconomy.media/ff_calendar_${slug}.json`
const CADA_MS = 3600_000
const TRAS_ERROR_MS = 10 * 60_000   // ForexFactory limita mucho: tras un fallo, se reintenta a los 10 min
const GUARDAR_DIAS = 3   // las noticias pasadas se olvidan pasados estos días

// Las divisas cuyas noticias mueven cada mercado: la suya y el dólar
const MONEDA_INDICE = { '^N225': 'JPY', '^GDAXI': 'EUR', '^FTSE': 'GBP' }
export function monedasDe(ticker) {
  if (/^(EUR|GBP|USD|AUD|NZD|CAD|CHF|JPY){2}$/.test(ticker)) return [...new Set([ticker.slice(0, 3), ticker.slice(3), 'USD'])]
  return [...new Set([MONEDA_INDICE[ticker], 'USD'].filter(Boolean))]
}

// Del JSON de ForexFactory, las de alto impacto: { t (s), moneda, titulo }
export function parsearFf(lista) {
  return (Array.isArray(lista) ? lista : [])
    .filter(e => e?.impact === 'High' && e.country && e.date)
    .map(e => ({ t: Math.floor(Date.parse(e.date) / 1000), moneda: e.country, titulo: String(e.title ?? '') }))
    .filter(e => Number.isFinite(e.t))
}

const horaMadrid = t => new Date(t * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' })

export function crearNoticias({ archivo = null, fetchFn = fetch, log = console.log, ahora = () => Math.floor(Date.now() / 1000) } = {}) {
  let eventos = []
  const estado = { actualizado: null, error: null }
  // el JSON tal cual de esta semana y la siguiente, con todas las noticias: lo reutiliza la
  // pestaña Calendario (/api/ff-calendar) para no pedírselo dos veces a ForexFactory
  const crudo = { thisweek: null, nextweek: null, hora: 0 }
  let reloj = null

  try {
    const j = JSON.parse(readFileSync(archivo, 'utf8'))
    if (Array.isArray(j.eventos)) { eventos = j.eventos; estado.actualizado = j.actualizado ?? null }
  } catch { /* primera vez */ }

  // Junta lo leído con lo que ya tenía (la semana pasada ya no viene) y olvida lo viejo
  function usar(nuevos) {
    const clave = e => `${e.t}|${e.moneda}|${e.titulo}`
    const todos = new Map([...eventos, ...nuevos].map(e => [clave(e), e]))
    const desde = ahora() - GUARDAR_DIAS * 86400
    eventos = [...todos.values()].filter(e => e.t >= desde).sort((a, b) => a.t - b.t)
  }

  async function actualizar() {
    try {
      const leer = async slug => {
        const r = await fetchFn(URL_FF(slug), { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
        if (!r.ok) throw new Error(`ForexFactory contesta HTTP ${r.status}`)
        // si limita, contesta 200 con una página HTML
        const lista = await r.json().catch(() => { throw new Error('ForexFactory no da el calendario (¿limita las peticiones?)') })
        if (!Array.isArray(lista)) throw new Error('ForexFactory da algo que no es el calendario')
        return lista
      }
      const estaSemana = await leer('thisweek')
      if (!estaSemana.length) throw new Error('el calendario de esta semana viene vacío')
      // la siguiente solo la publica hacia el final de la semana: hasta entonces, 404
      const siguiente = await leer('nextweek').catch(() => null)
      Object.assign(crudo, { thisweek: estaSemana, nextweek: siguiente, hora: Date.now() })
      usar([...parsearFf(estaSemana), ...parsearFf(siguiente)])
      Object.assign(estado, { actualizado: new Date(ahora() * 1000).toISOString(), error: null })
      if (archivo) {
        try {
          writeFileSync(`${archivo}.tmp`, JSON.stringify({ actualizado: estado.actualizado, eventos }, null, 2))
          renameSync(`${archivo}.tmp`, archivo)
        } catch (err) { log(`[noticias] no se ha podido guardar: ${err.message}`) }
      }
      return true
    } catch (err) {
      if (estado.error !== err.message) log(`[noticias] no se ha podido leer el calendario: ${err.message}`)
      estado.error = err.message
      return false
    }
  }

  // La noticia que tapa la entrada en `ticker` en el instante `t` con `minutos` de margen a cada
  // lado, o null. Con varias, la que acaba de tapar más tarde. Da `hasta`: cuándo deja de tapar.
  function bloqueo(ticker, t, minutos) {
    if (!(minutos > 0)) return null
    const monedas = monedasDe(ticker)
    const margen = minutos * 60
    const tapan = eventos.filter(e => monedas.includes(e.moneda) && t >= e.t - margen && t < e.t + margen)
    if (!tapan.length) return null
    const e = tapan.at(-1)
    return { ...e, hasta: e.t + margen, texto: `${e.moneda} ${e.titulo} a las ${horaMadrid(e.t)}` }
  }

  return {
    actualizar,
    bloqueo,
    // ahora y después cada hora (a los 10 min si falla)
    iniciar() {
      const programar = ms => {
        clearTimeout(reloj)
        reloj = setTimeout(async () => programar((await actualizar()) ? CADA_MS : TRAS_ERROR_MS), ms)
        reloj.unref?.()
      }
      programar(0)
    },
    parar() { clearTimeout(reloj); reloj = null },
    // lo último leído, si tiene menos de `maxMs`: { thisweek, nextweek } (nextweek puede ser null)
    crudo: (maxMs = 2 * CADA_MS) => (crudo.thisweek && Date.now() - crudo.hora < maxMs ? { thisweek: crudo.thisweek, nextweek: crudo.nextweek } : null),
    estado: () => ({ ...estado, proximas: eventos.filter(e => e.t >= ahora()).slice(0, 5) }),
  }
}
