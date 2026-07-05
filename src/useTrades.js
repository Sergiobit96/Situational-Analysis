import { useState, useCallback } from 'react'

const STORAGE_KEY = 'abcd_trades_v1'

function leerAlmacenadas() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

// Operaciones parseadas del diario Excel, persistidas en localStorage (100% local:
// el archivo nunca sale del navegador) para que estén disponibles en cualquier pestaña.
export function useTrades() {
  const [trades, setTradesState] = useState(leerAlmacenadas)

  const setTrades = useCallback(nuevas => {
    setTradesState(nuevas)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(nuevas)) } catch { /* cuota llena, no crítico */ }
  }, [])

  return [trades, setTrades]
}
