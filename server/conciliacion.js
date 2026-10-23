// ── Conciliación con IG ─────────────────────────────────────────────────────────────────
// Cada bot sigue sus posiciones, pero lo que manda es lo que hay en IG. Cada media hora se
// comparan las posiciones abiertas de la cuenta con lo que cada bot cree tener (lo que registra
// en la cartera, server/cartera.js) y se avisa por Telegram de lo que no cuadra:
//   · una posición con la referencia de un bot que ningún bot sigue (huérfana: nadie la cierra);
//   · una que un bot cree abierta y en IG ya no está;
//   · una con otro stop o con otro tamaño en IG que en el bot.
// Una diferencia tiene que verse en dos revisiones seguidas para avisar: una orden a medio
// confirmar, o un stop que acaba de saltar, cuadran solos en unos segundos. Cada diferencia se
// avisa una vez, y cuando se arregla, también.

const CADA_MS = 30 * 60_000
const PREFIJOS_BOT = ['SRS-', 'R4-', 'FBN-', 'TOR1-', 'TOR2-']
const deBot = ref => !!ref && PREFIJOS_BOT.some(p => ref.startsWith(p)) && !ref.includes('ENSAYO')
const casiIgual = (a, b) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 2e-5)   // lo que se pierde al pasar el precio a la escala de IG

// Las diferencias entre lo de los bots (`posiciones`: [{ bot, ticker, unidades }]) y lo de IG
// (`abiertas`: [{ dealId, ticker, tamano, stop, referencia }]), cada una con una clave estable
export function diferencias(posiciones, abiertas) {
  const enIg = new Map(abiertas.map(p => [p.dealId, p]))
  const conocidas = new Set()
  const salen = []
  for (const p of posiciones) {
    for (const u of p.unidades ?? []) {
      conocidas.add(u.dealId)
      const ig = enIg.get(u.dealId)
      if (!ig) { salen.push({ clave: `falta|${u.dealId}`, texto: `${p.bot} cree que tiene abierta una posición de ${p.ticker} (${u.dealId}) que en IG ya no está` }); continue }
      if (u.stop != null && ig.stop != null && !casiIgual(ig.stop, u.stop)) {
        salen.push({ clave: `stop|${u.dealId}|${u.stop}|${ig.stop}`, texto: `${p.bot}, ${p.ticker} (${u.dealId}): el stop en IG está en ${ig.stop} y el bot lo tiene en ${u.stop}` })
      }
      if (ig.stop == null && u.stop != null) {
        salen.push({ clave: `sinstop|${u.dealId}`, texto: `${p.bot}, ${p.ticker} (${u.dealId}): en IG no tiene stop, y el bot lo tiene en ${u.stop}` })
      }
      if (u.tamano != null && ig.tamano != null && !casiIgual(ig.tamano, u.tamano)) {
        salen.push({ clave: `tamano|${u.dealId}|${u.tamano}|${ig.tamano}`, texto: `${p.bot}, ${p.ticker} (${u.dealId}): en IG son ${ig.tamano} contratos y el bot cuenta ${u.tamano}` })
      }
    }
  }
  for (const ig of abiertas) {
    if (deBot(ig.referencia) && !conocidas.has(ig.dealId)) {
      salen.push({ clave: `huerfana|${ig.dealId}`, texto: `En IG hay una posición de ${ig.ticker ?? '?'} (${ig.referencia}, ${ig.dealId}) que ningún bot sigue: nadie la cerrará` })
    }
  }
  return salen
}

export function crearConciliacion({ ig, cartera, avisar = () => {}, log = console.log, cadaMs = CADA_MS }) {
  let vistas = new Map()      // clave → texto, de la revisión anterior
  const avisadas = new Map()  // clave → texto, las que ya se han avisado
  const estado = { ultima: null, error: null, pendientes: [] }
  let reloj = null

  async function revisar() {
    let ahora
    try {
      ahora = diferencias(cartera.estado().posiciones, await ig.operar.posiciones())
    } catch (err) {
      if (estado.error !== err.message) log(`[conciliación] no se ha podido revisar: ${err.message}`)
      estado.error = err.message
      return null
    }
    estado.error = null
    estado.ultima = new Date().toISOString()
    const actuales = new Map(ahora.map(d => [d.clave, d.texto]))
    const nuevas = [...actuales].filter(([k]) => vistas.has(k) && !avisadas.has(k))
    const arregladas = [...avisadas].filter(([k]) => !actuales.has(k))
    for (const [k, t] of nuevas) avisadas.set(k, t)
    for (const [k] of arregladas) avisadas.delete(k)
    vistas = actuales
    estado.pendientes = [...avisadas.values()]
    const lineas = [
      ...nuevas.map(([, t]) => `⚠️ ${t}`),
      ...arregladas.map(([, t]) => `✅ Ya cuadra: ${t}`),
    ]
    if (lineas.length) {
      log(`[conciliación] ${lineas.join(' | ')}`)
      try { Promise.resolve(avisar(`Conciliación con IG\n${lineas.join('\n')}`)).catch(() => {}) } catch { /* el aviso es lo de menos */ }
    }
    return { nuevas: nuevas.length, arregladas: arregladas.length, diferencias: ahora.length }
  }

  return {
    revisar,
    iniciar() {
      clearInterval(reloj)
      reloj = setInterval(revisar, cadaMs)
      reloj.unref?.()
      // la primera, pasados unos minutos: al arrancar, los bots aún están recuperando sus posiciones
      setTimeout(revisar, 5 * 60_000).unref?.()
    },
    parar() { clearInterval(reloj); reloj = null },
    estado: () => ({ ...estado }),
  }
}
