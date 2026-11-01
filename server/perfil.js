// Perfil de CPU del servidor, para saber qué bloquea el bucle de eventos (lo que /healthz/bots
// enseña en «bucle»). Se enciende unos minutos (POST /api/bot/perfil) y deja un resumen: los
// tramos largos en que el proceso no paró de ejecutar JavaScript, con lo que más se ejecutaba
// en cada uno, y las funciones que más tiempo se llevan en total. El perfilador de V8 muestrea
// desde otro hilo, así que ve también los bloqueos.

import { Session } from 'inspector/promises'

const LIBRE = new Set(['(idle)'])
const NUESTRO = /\/(server|src|api)\//

// Lo de un frame que sirve para encontrarlo: función, archivo y línea (de 1 en adelante)
const donde = cf => {
  const archivo = (cf.url || '').replace(/^file:\/\/\/?/, '').replace(/.*\/(server|src|api|node_modules)\//, '$1/')
  return `${cf.functionName || '(anónima)'} ${archivo || '(nativo)'}${cf.url ? `:${cf.lineNumber + 1}` : ''}`
}

// El resumen de un perfil de V8 (`Profiler.stop`). `umbralMs`: desde cuánto un tramo seguido
// ejecutando cuenta como bloqueo.
export function resumirPerfil(profile, { umbralMs = 100, maxTramos = 10, inicio = 0 } = {}) {
  const nodos = new Map(profile.nodes.map(n => [n.id, n]))
  const padre = new Map()
  for (const n of profile.nodes) for (const h of n.children ?? []) padre.set(h, n.id)
  // la pila de un nodo, de la hoja a la raíz, con solo nuestro código si lo hay
  const pilas = new Map()
  const pilaDe = id => {
    if (pilas.has(id)) return pilas.get(id)
    const todo = []
    for (let x = id; x != null; x = padre.get(x)) {
      const cf = nodos.get(x).callFrame
      if (cf.functionName !== '(root)') todo.push(cf)
    }
    const propio = todo.filter(cf => NUESTRO.test(cf.url || '') && !/node_modules/.test(cf.url))
    const pila = { hoja: todo[0] ? donde(todo[0]) : '(raíz)', propio: propio.slice(0, 6).map(donde) }
    pilas.set(id, pila)
    return pila
  }

  const propioMs = new Map()
  const tramos = []
  let tramo = null
  let t = profile.startTime
  profile.samples.forEach((id, i) => {
    const dt = (profile.timeDeltas[i] ?? 0) / 1000
    t += profile.timeDeltas[i] ?? 0
    const cf = nodos.get(id).callFrame
    if (LIBRE.has(cf.functionName)) {
      if (tramo) { tramos.push(tramo); tramo = null }
      return
    }
    const p = pilaDe(id)
    propioMs.set(p.hoja, (propioMs.get(p.hoja) ?? 0) + dt)
    tramo ??= { desde: t, ms: 0, muestras: new Map() }
    tramo.ms += dt
    const clave = p.propio.join(' ← ') || p.hoja
    tramo.muestras.set(clave, (tramo.muestras.get(clave) ?? 0) + dt)
  })
  if (tramo) tramos.push(tramo)

  const base = inicio - profile.startTime / 1000   // de µs del perfil a ms de reloj
  const largos = tramos.filter(x => x.ms >= umbralMs).sort((a, b) => b.ms - a.ms).slice(0, maxTramos)
  const totalMs = (profile.endTime - profile.startTime) / 1000
  return {
    duracionS: Math.round(totalMs / 1000),
    ocupadoPct: Math.round(1000 * [...propioMs.values()].reduce((s, x) => s + x, 0) / totalMs) / 10,
    tramosLargos: largos.map(x => ({
      hora: inicio ? new Date(base + x.desde / 1000).toISOString() : null,
      ms: Math.round(x.ms),
      // lo que más se ejecutaba en el tramo (nuestro código, de dentro a fuera)
      que: [...x.muestras].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([pila, ms]) => ({ ms: Math.round(ms), pila })),
    })),
    masCaras: [...propioMs].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([f, ms]) => ({ ms: Math.round(ms), f })),
  }
}

// Un perfil a la vez: `empezar(segundos)` lo enciende y lo para solo; `estado()` da el último
export function crearPerfilador({ log = console.log } = {}) {
  let enCurso = null, ultimo = null, error = null
  async function empezar(segundos) {
    if (enCurso) throw new Error('Ya hay un perfil en marcha')
    const s = Math.min(900, Math.max(10, Math.round(Number(segundos) || 120)))
    const sesion = new Session()
    sesion.connect()
    await sesion.post('Profiler.enable')
    await sesion.post('Profiler.setSamplingInterval', { interval: 1000 })
    await sesion.post('Profiler.start')
    const inicio = Date.now()
    enCurso = { desde: new Date(inicio).toISOString(), segundos: s }
    error = null
    log(`[perfil] ${s} s de perfil de CPU`)
    setTimeout(async () => {
      try {
        const { profile } = await sesion.post('Profiler.stop')
        ultimo = { desde: enCurso.desde, ...resumirPerfil(profile, { inicio }) }
        log(`[perfil] hecho: ${ultimo.tramosLargos.length} tramos de 100 ms o más; el peor, ${ultimo.tramosLargos[0]?.ms ?? 0} ms`)
      } catch (err) { error = err.message } finally {
        enCurso = null
        sesion.disconnect()
      }
    }, s * 1000).unref()
    return estado()
  }
  const estado = () => ({ enCurso, error, ultimo })
  return { empezar, estado }
}
