// ── El calendario del FOMC, al día con la Reserva Federal ──────────────────────────────
// La lista de server/fomc.js se acaba (llegaba a diciembre de 2026); sin reuniones nuevas, el
// bot de la Rule of 4 se quedaría sin sesiones. Al arrancar y una vez al día se lee la página
// del calendario de la Reserva Federal, que publica el año siguiente con meses de antelación,
// y lo leído se guarda en disco (en producción, en el volumen): si un día la página no
// contesta, sigue valiendo lo de la última vez. Las reuniones nuevas se avisan por Telegram.
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { parsearCalendarioFed, usarCalendarioFed, diasFomc } from './fomc.js'

export const URL_CALENDARIO_FED = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'
const CADA_MS = 24 * 3600_000
const TRAS_ERROR_MS = 3600_000

const corta = f => new Date(`${f}T12:00:00Z`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

export function crearCalendarioFomc({ archivo, fetchFn = fetch, log = console.log, avisar = () => {}, ahora = () => new Date() }) {
  const estado = { actualizado: null, leidas: 0, error: null }
  let reloj = null

  // lo de la última vez, para empezar con ello aunque la página no conteste
  try {
    const guardado = JSON.parse(readFileSync(archivo, 'utf8'))
    if (Array.isArray(guardado.fechas)) {
      usarCalendarioFed(guardado.fechas)
      Object.assign(estado, { actualizado: guardado.actualizado ?? null, leidas: guardado.fechas.length })
    }
  } catch { /* primera vez */ }

  async function actualizar() {
    try {
      const r = await fetchFn(URL_CALENDARIO_FED, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'text/html' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!r.ok) throw new Error(`la Reserva Federal contesta HTTP ${r.status}`)
      const fechas = parsearCalendarioFed(await r.text())
      if (fechas.length < 8) throw new Error(`la página del calendario solo trae ${fechas.length} reuniones: ¿ha cambiado de formato?`)
      const hoy = ahora().toISOString().slice(0, 10)
      const antes = new Set(diasFomc())
      usarCalendarioFed(fechas)
      const nuevas = diasFomc().filter(f => f >= hoy && !antes.has(f))
      Object.assign(estado, { actualizado: ahora().toISOString(), leidas: fechas.length, error: null })
      try {
        writeFileSync(`${archivo}.tmp`, JSON.stringify({ actualizado: estado.actualizado, fuente: URL_CALENDARIO_FED, fechas }, null, 2))
        renameSync(`${archivo}.tmp`, archivo)
      } catch (err) { log(`[fomc] no se ha podido guardar el calendario: ${err.message}`) }
      if (nuevas.length) {
        const texto = `Calendario del FOMC al día: ${nuevas.length === 1 ? 'una reunión nueva' : `${nuevas.length} reuniones nuevas`} (${nuevas.map(corta).join(', ')})`
        log(`[fomc] ${texto}`)
        try { Promise.resolve(avisar(`Rule of 4 · ${texto}`)).catch(() => {}) } catch { /* el aviso es lo de menos */ }
      }
      return nuevas
    } catch (err) {
      if (estado.error !== err.message) log(`[fomc] no se ha podido leer el calendario: ${err.message}`)
      estado.error = err.message
      return null
    }
  }

  function programar(ms) {
    clearTimeout(reloj)
    reloj = setTimeout(async () => programar((await actualizar()) ? CADA_MS : TRAS_ERROR_MS), ms)
    reloj.unref?.()
  }

  return {
    actualizar,
    // ahora y después una vez al día (a la hora si falla)
    iniciar() {
      actualizar().then(nuevas => programar(nuevas ? CADA_MS : TRAS_ERROR_MS))
    },
    parar() { clearTimeout(reloj); reloj = null },
    estado() {
      const hoy = ahora().toISOString().slice(0, 10)
      const futuras = diasFomc().filter(f => f >= hoy)
      return { ...estado, fuente: URL_CALENDARIO_FED, hasta: diasFomc().at(-1) ?? null, proximas: futuras.slice(0, 3), quedan: futuras.length }
    },
  }
}
