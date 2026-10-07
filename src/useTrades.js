import { useSyncExternalStore, useCallback } from 'react'
import { londresOffsetAt } from './timezone'

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
const suscribir = fn => { oyentes.add(fn); return () => oyentes.delete(fn) }

// Operaciones parseadas del diario Excel, persistidas en localStorage (100% local:
// el archivo nunca sale del navegador) para que estén disponibles en cualquier pestaña.
// setTrades admite tanto un array como un actualizador funcional (prev => next), igual
// que el setState nativo de React, para poder fusionar varias fuentes sin condiciones
// de carrera cuando se sincronizan varios años a la vez.
// Se guarda fuera del actualizador de React a propósito: React no lo ejecuta si el
// componente ya se desmontó, y salir de Operaciones antes de que acabara la sincronización
// (tarda 2-3 s) tiraba el resultado sin guardarlo.
export function useTrades() {
  const trades = useSyncExternalStore(suscribir, actuales)

  const setTrades = useCallback(nuevas => {
    const siguiente = typeof nuevas === 'function' ? nuevas(actuales()) : nuevas
    enMemoria = siguiente
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(siguiente)) } catch { /* cuota llena, no crítico */ }
    oyentes.forEach(fn => fn())
  }, [])

  return [trades, setTrades]
}
