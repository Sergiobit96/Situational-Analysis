// Dibujos de la pestaña Gráfico: viven en el servidor (un JSON en Drive, solo en local) y el
// navegador guarda una copia. La copia es la que manda cuando el servidor no los tiene: en
// producción, o si no responde. Así, si falla la lectura, lo que se guarde después parte de
// la copia y no de una lista vacía que borraría los del servidor.

const COPIA = 'sa.dibujos'

function leerCopias() {
  try { return JSON.parse(localStorage.getItem(COPIA)) ?? {} } catch { return {} }
}
function guardarCopia(clave, dibujos) {
  try {
    const copias = leerCopias()
    if (dibujos.length) copias[clave] = dibujos
    else delete copias[clave]
    localStorage.setItem(COPIA, JSON.stringify(copias))
  } catch { /* sin almacenamiento: queda el servidor */ }
}

export async function leerDibujos(clave, signal) {
  try {
    const r = await fetch(`/api/dibujos?${new URLSearchParams({ clave })}`, { signal })
    if (r.ok) {
      const { dibujos } = await r.json()
      guardarCopia(clave, dibujos)
      return dibujos
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err
  }
  return leerCopias()[clave] ?? []
}

// Las escrituras van en fila: dos cambios seguidos no pueden llegar al servidor al revés y
// dejar guardado el anterior
let cola = Promise.resolve()

export function guardarDibujos(clave, dibujos) {
  guardarCopia(clave, dibujos)
  const envio = cola.catch(() => {}).then(async () => {
    const r = await fetch('/api/dibujos', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clave, dibujos }),
    })
    if (r.status === 404) return   // producción: no hay Drive, queda la copia del navegador
    if (!r.ok) {
      const { error } = await r.json().catch(() => ({}))
      throw new Error(error ?? `HTTP ${r.status}`)
    }
  })
  cola = envio
  return envio
}
