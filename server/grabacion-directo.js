// ── Grabación del directo: las velas de 1 min de IG, a disco ─────────────────────────
// El streaming de IG da las velas de 1 min de cada mercado, pero tiempo-real.js solo las
// tiene en memoria (tres días) y las pierde al reiniciarse el servidor. Aquí se escriben a
// disco, un CSV por mercado y día de Madrid, para que el gráfico tenga histórico sin gastar
// el cupo semanal de IG (10.000 puntos, compartido con los bots). En Railway va al volumen
// /data, que sobrevive a los despliegues. Lo de antes de empezar a grabar sigue saliendo del
// histórico de IG.
//
// Además de las velas se apuntan los ratos en que cada mercado se estaba grabando (`tramos`):
// sin velas en un rato grabado es que el mercado estaba cerrado; fuera de los tramos no se
// sabe, y el gráfico se lo pide a IG. Un corte corto (un despliegue tarda un par de minutos)
// se da por grabado: falta alguna vela, pero no se gasta cupo por ella.
//
// Una vela se escribe cuando llega la del minuto siguiente, que es cuando ya no cambia, o
// dos minutos después de acabar si el mercado se para. Si luego llega una corrección de un
// minuto ya escrito, va en otra línea: al leer, la última de cada hora manda.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { agruparVelas, inicioDiaMadrid, offsetMadrid } from './velas-grafico.js'

const CADA_MS          = 30_000    // cada cuánto se escriben las velas paradas y se alargan los tramos
const CORTE_TOLERADO_S = 10 * 60   // un corte más corto se da por grabado
const ESPERA_CIERRE_S  = 120       // una vela sin sucesora se escribe dos minutos después de acabar
const DIAS_EN_MEMORIA  = 40        // días cerrados de 1 min que se quedan leídos

const fmtFecha = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' })
export const fechaMadrid = ts => fmtFecha.format(new Date(ts * 1000))

// ── Velas enteras de una temporalidad, en hora de Madrid (la rejilla de agruparVelas) ──

export function inicioCubo(t, minutos) {
  if (minutos >= 1440) return inicioDiaMadrid(t)
  const off = offsetMadrid(t)
  return Math.floor((t + off) / (minutos * 60)) * minutos * 60 - off
}

// El inicio de la primera vela entera que empieza en t o después
export function cuboDesde(t, minutos) {
  const ini = inicioCubo(t, minutos)
  if (ini === t) return t
  // la diaria: de la medianoche, 26 h más caen en el día siguiente aunque tenga 23 o 25 h
  return minutos >= 1440 ? inicioDiaMadrid(ini + 26 * 3600) : ini + minutos * 60
}

// Los tramos recortados a velas enteras de la temporalidad: la vela en la que empieza o acaba
// un tramo no está grabada entera. El que sigue abierto (fin infinito) llega hasta ahora.
export function tramosEnteros(tramos, minutos) {
  return tramos
    .map(([a, b]) => [cuboDesde(a, minutos), b === Infinity ? Infinity : inicioCubo(b, minutos)])
    .filter(([a, b]) => a < b)
}

// Añade [a, b) al final de los tramos; con un corte de menos de `tolerancia` desde el último,
// lo alarga
export function alargarTramos(tramos, a, b, tolerancia = CORTE_TOLERADO_S) {
  const ultimo = tramos[tramos.length - 1]
  if (ultimo && a <= ultimo[1] + tolerancia) ultimo[1] = Math.max(ultimo[1], b)
  else tramos.push([a, b])
  return tramos
}

// "time,open,high,low,close" por línea → velas ordenadas; de una hora repetida, la última
export function parsearCsvGrabado(texto) {
  const porHora = new Map()
  for (const linea of texto.split('\n')) {
    const [time, open, high, low, close] = linea.split(',').map(Number)
    if ([time, open, high, low, close].every(Number.isFinite)) porHora.set(time, { time, open, high, low, close })
  }
  return [...porHora.values()].sort((a, b) => a.time - b.time)
}

const lineaDe = v => `${v.time},${v.open},${v.high},${v.low},${v.close}\n`

// `tickers()` da los mercados que se graban y `activo(ticker)`, si su streaming está dando
// velas ahora mismo: solo esos ratos cuentan como grabados.
export function crearGrabacion({ dir, tickers, activo, ahora = Date.now, log = console.log }) {
  const pendientes = new Map()   // ticker → { vela, escrita }: la última, que aún puede cambiar
  const tramosDe   = new Map()   // ticker → [[desde, hasta], …] en segundos UTC
  const abiertos   = new Set()   // mercados con su tramo en marcha desde este arranque
  const carpetas   = new Set()
  const dias       = new Map()   // fichero de un día cerrado → sus velas de 1 min (los últimos leídos)
  const agrupados  = new Map()   // fichero de un día cerrado → Map(minutos → velas)
  let errorEscritura = null
  let reloj = null

  const carpetaDe = ticker => join(dir, encodeURIComponent(ticker))
  const hoy = () => fechaMadrid(ahora() / 1000)

  function carpeta(ticker) {
    const c = carpetaDe(ticker)
    if (!carpetas.has(c)) { mkdirSync(c, { recursive: true }); carpetas.add(c) }
    return c
  }

  function fallo(err) {
    if (errorEscritura !== err.message) log('[grabación] no se puede escribir:', err.message)
    errorEscritura = err.message
  }

  function escribir(ticker, vela) {
    try {
      const fichero = join(carpeta(ticker), `${fechaMadrid(vela.time)}.csv`)
      appendFileSync(fichero, lineaDe(vela))
      // una corrección tardía de un día cerrado deja viejo lo que se tenía leído
      dias.delete(fichero)
      agrupados.delete(fichero)
      errorEscritura = null
    } catch (err) { fallo(err) }
  }

  function anotar(ticker, vela) {
    if (!Number.isFinite(vela?.time)) return
    const p = pendientes.get(ticker)
    if (!p || vela.time > p.vela.time) {
      if (p && !p.escrita) escribir(ticker, p.vela)
      pendientes.set(ticker, { vela, escrita: false })
    } else if (vela.time === p.vela.time) {
      p.vela = vela
      p.escrita = false
    } else {
      escribir(ticker, vela)
    }
  }

  function tramos(ticker) {
    if (!tramosDe.has(ticker)) {
      let t = []
      try { t = JSON.parse(readFileSync(join(carpetaDe(ticker), 'tramos.json'), 'utf8')) } catch { /* sin grabar aún */ }
      tramosDe.set(ticker, Array.isArray(t) ? t : [])
    }
    return tramosDe.get(ticker)
  }

  function guardarTramos(ticker, lista) {
    try {
      const fichero = join(carpeta(ticker), 'tramos.json')
      writeFileSync(`${fichero}.tmp`, JSON.stringify(lista))
      renameSync(`${fichero}.tmp`, fichero)
    } catch (err) { fallo(err) }
  }

  function paso() {
    const t = Math.floor(ahora() / 1000)
    for (const [ticker, p] of pendientes) {
      if (!p.escrita && p.vela.time + 60 + ESPERA_CIERRE_S <= t) {
        escribir(ticker, p.vela)
        p.escrita = true
      }
    }
    for (const ticker of tickers()) {
      if (!activo(ticker)) { abiertos.delete(ticker); continue }
      const lista = tramos(ticker)
      if (abiertos.has(ticker)) lista[lista.length - 1][1] = t
      else {
        // desde el minuto en curso: al suscribirse, IG manda su vela entera hasta ahora
        alargarTramos(lista, Math.floor(t / 60) * 60, t)
        abiertos.add(ticker)
      }
      guardarTramos(ticker, lista)
    }
  }

  function leerDia(fichero, cerrado) {
    if (cerrado && dias.has(fichero)) {
      const velas = dias.get(fichero)
      dias.delete(fichero)
      dias.set(fichero, velas)   // al final: es el último usado
      return velas
    }
    let velas = []
    try { velas = parsearCsvGrabado(readFileSync(fichero, 'utf8')) } catch { /* ese día no hay */ }
    if (cerrado) {
      dias.set(fichero, velas)
      if (dias.size > DIAS_EN_MEMORIA) dias.delete(dias.keys().next().value)
    }
    return velas
  }

  // Los ficheros de día de un mercado que tocan [desde, hasta)
  function diasEntre(ticker, desde, hasta) {
    const c = carpetaDe(ticker)
    let nombres = []
    try { nombres = readdirSync(c).filter(f => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort() } catch { /* sin grabar */ }
    const primero = fechaMadrid(desde), ultimo = fechaMadrid(hasta - 1)
    return nombres
      .map(f => ({ fecha: f.slice(0, 10), fichero: join(c, f) }))
      .filter(d => d.fecha >= primero && d.fecha <= ultimo)
  }

  // Velas de 1 min grabadas con hora en [desde, hasta), con la que aún se está haciendo
  function m1Entre(ticker, desde, hasta) {
    const out = []
    const deHoy = hoy()
    for (const { fecha, fichero } of diasEntre(ticker, desde, hasta)) {
      for (const v of leerDia(fichero, fecha < deHoy)) if (v.time >= desde && v.time < hasta) out.push(v)
    }
    const p = pendientes.get(ticker)?.vela
    if (p && p.time >= desde && p.time < hasta) {
      const ultima = out[out.length - 1]
      if (ultima?.time === p.time) out[out.length - 1] = p
      else if (!ultima || ultima.time < p.time) out.push(p)
    }
    return out
  }

  // Velas grabadas de `minutos` con hora en [desde, hasta). La de 4 h y la diaria cubren
  // meses por página: de los días cerrados se guardan ya agrupadas.
  function velas(ticker, minutos, desde, hasta) {
    if (minutos < 240) return agruparVelas(m1Entre(ticker, desde, hasta), minutos)
    const out = []
    const deHoy = hoy()
    for (const { fecha, fichero } of diasEntre(ticker, desde, hasta)) {
      if (fecha >= deHoy) continue
      let porMinutos = agrupados.get(fichero)
      if (!porMinutos) agrupados.set(fichero, porMinutos = new Map())
      if (!porMinutos.has(minutos)) porMinutos.set(minutos, agruparVelas(leerDia(fichero, true), minutos))
      out.push(...porMinutos.get(minutos))
    }
    const inicioHoy = inicioDiaMadrid(ahora() / 1000)
    if (hasta > inicioHoy) out.push(...agruparVelas(m1Entre(ticker, Math.max(desde, inicioHoy), hasta), minutos))
    return out.filter(v => v.time >= desde && v.time < hasta)
  }

  return {
    anotar,
    velas,
    m1Entre,

    // Los mercados que tienen algo grabado (una carpeta por mercado)
    mercados() {
      try {
        return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => decodeURIComponent(e.name))
      } catch { return [] }
    },

    // Los ratos grabados de un mercado; el que sigue en marcha, abierto hasta el infinito
    cubiertos(ticker) {
      const lista = tramos(ticker).map(([a, b]) => [a, b])
      if (abiertos.has(ticker) && lista.length) lista[lista.length - 1][1] = Infinity
      return lista
    },

    resumen() {
      const fecha = t => (Number.isFinite(t) ? new Date(t * 1000).toISOString() : null)
      return {
        dir,
        error: errorEscritura,
        mercados: Object.fromEntries(tickers().map(ticker => {
          const lista = tramos(ticker)
          return [ticker, {
            grabando: abiertos.has(ticker),
            desde: fecha(lista[0]?.[0]),
            tramos: lista.length,
            ultima: fecha(pendientes.get(ticker)?.vela.time),
          }]
        })),
      }
    },

    iniciar() {
      if (reloj) return
      try { mkdirSync(dir, { recursive: true }) } catch (err) { fallo(err) }
      reloj = setInterval(paso, CADA_MS)
      reloj.unref?.()
    },

    // Escribe lo pendiente (al apagar el servidor)
    cerrar() {
      clearInterval(reloj)
      reloj = null
      for (const [ticker, p] of pendientes) if (!p.escrita) { escribir(ticker, p.vela); p.escrita = true }
    },

    _paso: paso,
  }
}
