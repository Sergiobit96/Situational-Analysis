import { useSyncExternalStore, useCallback } from 'react'
import { londresOffsetAt } from './timezone.js'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'

const STORAGE_KEY = 'abcd_trades_v1'
const TZ_KEY      = 'abcd_trades_tz_v2'    // marca de que ya se corrigió la hora guardada
const CATS_KEY    = 'abcd_trades_cats2025' // marca de que ya se limpiaron las etiquetas de 2025

// Las operaciones guardadas antes del arreglo de zona horaria llevan 1h de más en verano:
// se parsearon tomando la celda del diario (hora de pared de Londres) como UTC. Aquí se
// les quita esa hora una sola vez, para no obligar a volver a sincronizar y subir los
// .xlsx de los años que no están conectados a Google Sheets.
function corregirHoraVieja(trades) {
  return trades.map(t => {
    const enVerano = ts => Number.isFinite(ts) && londresOffsetAt(ts) !== 0
    return {
      ...t,
      openTime:  enVerano(t.openTime)  ? t.openTime  - 3600 : t.openTime,
      closeTime: enVerano(t.closeTime) ? t.closeTime - 3600 : t.closeTime,
    }
  })
}

// Las operaciones de 2025 guardadas antes llevan pegadas las categorías de la hoja
// "Scenarios", que resultó ser una copia de la de otro año (ver SIN_SCENARIOS en
// parseTrades). Se les quitan una sola vez para no tener que borrar y recargar todo.
function quitarEtiquetas2025(trades) {
  return trades.map(t => (
    Number.isFinite(t.openTime) && new Date(t.openTime * 1000).getUTCFullYear() === 2025
      ? { ...t, categorias: [] }
      : t
  ))
}

function leerAlmacenadas() {
  try {
    const raw       = localStorage.getItem(STORAGE_KEY)
    const guardadas = raw ? JSON.parse(raw) : []
    let trades  = Array.isArray(guardadas) ? guardadas : []
    let tocadas = false

    if (!localStorage.getItem(TZ_KEY)) {
      trades = corregirHoraVieja(trades)
      localStorage.setItem(TZ_KEY, String(Date.now()))
      tocadas = true
    }
    if (!localStorage.getItem(CATS_KEY)) {
      trades = quitarEtiquetas2025(trades)
      localStorage.setItem(CATS_KEY, String(Date.now()))
      tocadas = true
    }
    if (tocadas && trades.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(trades))
    return trades
  } catch {
    return []
  }
}

// Copia en memoria compartida por todas las pestañas de la app: la que se monta después ve
// lo último aunque localStorage no haya podido guardarlo (cuota llena), y las que ya están
// abiertas se repintan al cambiar, en vez de quedarse con lo que leyeron al montarse.
let enMemoria = null
const actuales = () => (enMemoria ??= leerAlmacenadas())
const oyentes  = new Set()
const avisar   = () => oyentes.forEach(fn => fn())
const suscribir = fn => { oyentes.add(fn); return () => oyentes.delete(fn) }

function guardarEnDisco(trades) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(trades)) } catch { /* cuota llena, no crítico */ }
}

// ── Copia en el servidor ──
// El diario es lo único que vivía solo en el navegador: limpiar los datos del sitio lo
// borraba. Ahora manda el JSON del servidor y localStorage queda como caché, que es lo que
// pinta la primera vez mientras llega la respuesta (y lo único que hay en producción, donde
// estos endpoints no existen).
let sincronizando = null

async function sincronizarConServidor() {
  if (!import.meta.env.DEV) return
  try {
    const res = await fetch(`${API}/api/trades`)
    if (!res.ok) return
    const { trades } = await res.json()

    if (Array.isArray(trades) && trades.length > 0) {
      enMemoria = trades
      guardarEnDisco(trades)
      avisar()
      return
    }
    // El servidor aún no tiene nada: se sube lo que haya en el navegador (una sola vez)
    const locales = actuales()
    if (locales.length > 0) await subirAlServidor(locales)
  } catch { /* sin servidor local se sigue con lo del navegador */ }
}

async function subirAlServidor(trades) {
  if (!import.meta.env.DEV) return
  try {
    await fetch(`${API}/api/trades`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ trades }),
    })
  } catch { /* se queda en el navegador hasta la próxima */ }
}

// Operaciones parseadas del diario Excel. Se guardan en el servidor (JSON junto a los
// comentarios) y en localStorage como caché, para que estén disponibles en cualquier
// pestaña de la app y sobrevivan a limpiar el navegador.
// setTrades admite tanto un array como un actualizador funcional (prev => next), igual
// que el setState nativo de React, para poder fusionar varias fuentes sin condiciones
// de carrera cuando se sincronizan varios años a la vez.
// Se guarda fuera del actualizador de React a propósito: React no lo ejecuta si el
// componente ya se desmontó, y salir de Operaciones antes de que acabara la sincronización
// (tarda 2-3 s) tiraba el resultado sin guardarlo.
export function useTrades() {
  const trades = useSyncExternalStore(suscribir, actuales)

  // una sola vez por carga de la app, no por componente que use el hook
  sincronizando ??= sincronizarConServidor()

  const setTrades = useCallback(nuevas => {
    const siguiente = typeof nuevas === 'function' ? nuevas(actuales()) : nuevas
    enMemoria = siguiente
    guardarEnDisco(siguiente)
    avisar()
    subirAlServidor(siguiente)
  }, [])

  return [trades, setTrades]
}
