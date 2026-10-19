// ── Diario de fortalezas y debilidades (pestaña Diario) ──
// Se guarda en un JSON en Drive (G:\Mi unidad) a través del servidor local, como el diario
// de operaciones: el navegador se queda una copia como caché, y en producción, donde no hay
// Drive, solo esa. Aquí se valida lo que llega antes de escribirlo: solo entradas con texto,
// con los mismos campos que pinta src/DiarioFortalezas.jsx.
import { randomUUID } from 'crypto'

export const COLUMNAS_DIARIO = ['fortalezas', 'debilidades']
const MAX_ENTRADAS = 5000
const MAX_TEXTO = 5000
const MAX_ID = 100

const numeroONull = v => (Number.isFinite(v) ? v : null)

// Lanza si no son las dos listas; tira en silencio las entradas sin texto
export function limpiarDiario(data) {
  const out = {}
  for (const col of COLUMNAS_DIARIO) {
    const lista = data?.[col]
    if (!Array.isArray(lista)) throw new Error(`Falta la lista de ${col}`)
    if (lista.length > MAX_ENTRADAS) throw new Error(`Demasiadas ${col} (${lista.length})`)
    out[col] = lista
      .filter(e => e && typeof e.texto === 'string' && e.texto.trim())
      .map(e => ({
        id:      typeof e.id === 'string' && e.id && e.id.length <= MAX_ID ? e.id : randomUUID(),
        texto:   e.texto.trim().slice(0, MAX_TEXTO),
        creado:  Number.isFinite(e.creado) ? e.creado : Date.now(),
        editado: numeroONull(e.editado),
        movido:  numeroONull(e.movido),
        desde:   COLUMNAS_DIARIO.includes(e.desde) ? e.desde : null,
      }))
  }
  return out
}

export const totalDiario = d => COLUMNAS_DIARIO.reduce((s, col) => s + (d?.[col]?.length ?? 0), 0)
