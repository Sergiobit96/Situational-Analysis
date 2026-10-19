// ── Vigilancia del servidor ──────────────────────────────────────────────────────────
// Que un bot se quede parado sin que nadie se entere es lo peor que puede pasar aquí:
//   · el latido de cada bot: cada vuelta de su bucle (cada 5 s) apunta la hora. Si un bot en
//     marcha lleva más de `umbralMs` sin completar una vuelta (una petición a IG que se queda
//     colgada deja su cola esperando), avisa una vez, y otra cuando vuelve; si se paran varios
//     a la vez (lo normal, si es IG), en un solo mensaje. /healthz/bots lo enseña y da 503, para
//     un vigilante de fuera (si el proceso muere, nadie avisa desde dentro);
//   · los errores sin capturar del proceso: avisan, el mismo como mucho cada 10 min;
//   · lo que se bloquea el bucle de eventos: la web y los bots comparten proceso, así que una
//     petición pesada retrasa la vuelta de los bots. Medido el 19-oct-2026 en local, 0,5 s en el
//     peor caso (un filtro de gaps de 10 años); aquí queda a la vista por si un día crece.

import { monitorEventLoopDelay } from 'perf_hooks'

// "SRS", "SRS y Tortugas", "SRS, Rule of 4 y Tortugas"
const enumerar = nombres => (nombres.length < 2 ? nombres.join('') : `${nombres.slice(0, -1).join(', ')} y ${nombres.at(-1)}`)

// "2 min", "1 h", "1 h 5 min"
export function duracion(ms) {
  const min = Math.max(1, Math.round(ms / 60_000))
  if (min < 60) return `${min} min`
  return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`
}

// `bots`: { nombre: () => ({ enMarcha, desde, ultimaVuelta }) }, con las horas en ms; el nombre
// es el de su chip en la pestaña Bots (SRS, Rule of 4, Tortugas)
export function crearVigilancia({ bots, avisar = () => {}, ahora = Date.now, umbralMs = 120_000 }) {
  const parados = new Map()   // nombre → desde cuándo está parado

  function estado() {
    const t = ahora()
    const lista = Object.entries(bots).map(([nombre, latido]) => {
      const { enMarcha, desde, ultimaVuelta } = latido()
      if (!enMarcha) return { nombre, enMarcha: false, segundosSinVuelta: null, parado: false }
      const sinVuelta = t - (ultimaVuelta ?? desde ?? t)
      return { nombre, enMarcha: true, segundosSinVuelta: Math.round(sinVuelta / 1000), parado: sinVuelta > umbralMs }
    })
    return { ok: lista.every(b => !b.parado), bots: lista }
  }

  function revisar() {
    const t = ahora()
    const e = estado()
    const nuevos = e.bots.filter(b => b.parado && !parados.has(b.nombre))
    const vuelven = e.bots.filter(b => !b.parado && parados.has(b.nombre))
    if (nuevos.length) {
      for (const b of nuevos) parados.set(b.nombre, t - b.segundosSinVuelta * 1000)
      const uno = nuevos.length === 1
      const cuanto = duracion(Math.max(...nuevos.map(b => b.segundosSinVuelta)) * 1000)
      avisar([
        `⚠️ ${uno ? 'El bot' : 'Los bots'} ${enumerar(nuevos.map(b => b.nombre))} ${uno ? 'lleva' : 'llevan'} ${cuanto} ${uno ? 'parado' : 'parados'}, seguramente porque IG no contesta.`,
        'Mientras siga así no abriré ni cerraré operaciones. Los stops que ya están puestos en IG siguen funcionando.',
        'Te aviso cuando vuelva.',
      ].join('\n'))
    }
    if (vuelven.length) {
      const uno = vuelven.length === 1
      const cuanto = duracion(Math.max(...vuelven.map(b => t - parados.get(b.nombre))))
      for (const b of vuelven) parados.delete(b.nombre)
      avisar(`✅ ${uno ? 'El bot' : 'Los bots'} ${enumerar(vuelven.map(b => b.nombre))} ${uno ? 'vuelve' : 'vuelven'} a funcionar, tras ${cuanto} ${uno ? 'parado' : 'parados'}.`)
    }
    return e
  }

  return { estado, revisar }
}

// Avisa de un error, pero el mismo texto como mucho una vez cada `cadaMs`: una promesa que
// falla en cada petición no debe inundar Telegram. Devuelve si ha avisado.
export function crearAvisoErrores({ avisar = () => {}, ahora = Date.now, cadaMs = 10 * 60_000, maxTextos = 100 }) {
  const ultimo = new Map()
  return function avisarError(texto) {
    const t = ahora()
    if (t - (ultimo.get(texto) ?? -Infinity) < cadaMs) return false
    if (ultimo.size >= maxTextos) ultimo.clear()
    ultimo.set(texto, t)
    avisar(texto)
    return true
  }
}

// Lo que se ha retrasado el bucle de eventos, en ms: lo peor de los últimos 5-10 min (va por
// tramos de `tramoMs`) y lo peor desde que arrancó el servidor
export function medirBucle({ tramoMs = 5 * 60_000 } = {}) {
  const h = monitorEventLoopDelay({ resolution: 20 })
  h.enable()
  let peorTramoAnterior = 0
  let peorTotal = 0
  setInterval(() => {
    peorTramoAnterior = h.max / 1e6
    peorTotal = Math.max(peorTotal, peorTramoAnterior)
    h.reset()
  }, tramoMs).unref()
  return () => {
    const tramo = h.max / 1e6
    return {
      peorRecienteMs: Math.round(Math.max(tramo, peorTramoAnterior)),
      peorDesdeArranqueMs: Math.round(Math.max(peorTotal, tramo)),
    }
  }
}
