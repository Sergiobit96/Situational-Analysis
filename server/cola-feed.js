// ── Cola de descargas del feed de Dukascopy ───────────────────────────────────
// Las estrategias piden cientos de sesiones que no están en caché, y el feed no aguanta
// ni una por segundo sostenida: pedirlas según llegan acababa en 429 a los pocos cientos,
// y desde ahí cada sesión caía al fallback de Yahoo o a la barra diaria, con las que la
// estrategia no tiene nada que analizar. Esta cola las baja de una en una al ritmo que
// el feed tolera —el mismo ajuste que server/backfill-dukascopy.mjs: frena en seco ante
// un 429, acelera despacio tras una buena racha y, si la IP está penalizada, descansa—,
// sin fallbacks. Lo bajado queda en la caché de disco, y la cola sigue trabajando aunque
// quien lo pidió ya se haya ido.
//
// `bajar(item)` hace una descarga y dice cómo fue:
//   'ok'        bajado del feed
//   'cache'     ya estaba guardado: no ha salido a la red, así que no hay pausa
//   'vacio'     el feed no tiene ese día (festivo): no se vuelve a pedir en unas horas
//   'limitado'  429 o feed cortado: se queda en la cola y se frena
//   'fallo'     otro error: también se reintenta, pero a los MAX_FALLOS_ITEM se deja

const PAUSA_MIN_MS           = 1_200
const PAUSA_MAX_MS           = 15_000
const ACIERTOS_PARA_ACELERAR = 50
const ESPERA_TRAS_FALLO_MS   = 15_000
// Cuando el 429 deja de ser puntual y pasa a ser todo, es que la IP está penalizada y
// seguir pidiendo solo alarga el castigo: se para en seco, cada vez con más margen
const FALLOS_SEGUIDOS_PARA_DESCANSAR = 8
const DESCANSOS_MS   = [20 * 60_000, 45 * 60_000, 90 * 60_000]
const MAX_FALLOS_ITEM = 5
const MAX_EN_COLA     = 5_000
// Un día vacío casi siempre es un festivo, pero dukascopy-node da por vacía cualquier
// respuesta que no sea 200, así que el apunte caduca en vez de durar para siempre
const SIN_DATOS_MS    = 6 * 60 * 60_000

const esperaReal = ms => new Promise(r => setTimeout(r, ms))

export function crearColaFeed({ bajar, espera = esperaReal, ahora = Date.now }) {
  let cola = []                          // items por orden de descarga, cada uno con su `clave`
  const vacios = new Map()               // clave -> cuándo se vio vacío
  const vacio = clave => ahora() - (vacios.get(clave) ?? -Infinity) < SIN_DATOS_MS
  const fallidas = new Set()             // se dejaron tras MAX_FALLOS_ITEM; solo hasta que se vuelvan a pedir
  const fallosDe = new Map()
  let pausa = PAUSA_MIN_MS, aciertos = 0, fallosSeguidos = 0, descansos = 0
  let descansoHasta = 0
  let trabajando = false

  // Lo encargado pasa delante de lo que hubiera, en su orden: quien espera ahora es quien
  // acaba de pedirlo. Lo que ya estaba en la cola no se duplica, solo se adelanta.
  function encolar(items) {
    const nuevos = new Map()
    for (const it of items) {
      if (vacio(it.clave) || nuevos.has(it.clave)) continue
      fallidas.delete(it.clave)
      nuevos.set(it.clave, cola.find(x => x.clave === it.clave) ?? it)
    }
    if (!nuevos.size) return
    cola = [...nuevos.values(), ...cola.filter(x => !nuevos.has(x.clave))].slice(0, MAX_EN_COLA)
    if (!trabajando) trabajar()
  }

  const quitar = item => {
    cola = cola.filter(x => x !== item)
    fallosDe.delete(item.clave)
  }

  async function trabajar() {
    trabajando = true
    try {
      while (cola.length) {
        if (fallosSeguidos >= FALLOS_SEGUIDOS_PARA_DESCANSAR) {
          const ms = DESCANSOS_MS[Math.min(descansos++, DESCANSOS_MS.length - 1)]
          descansoHasta = ahora() + ms
          await espera(ms)
          descansoHasta = 0
          fallosSeguidos = 0
          pausa = Math.max(pausa, 3_000)
        }

        // la cabeza puede cambiar mientras se descarga (otro encargo la adelanta), así que
        // el item se quita por identidad, no por posición
        const item = cola[0]
        let resultado
        try { resultado = await bajar(item) } catch { resultado = 'fallo' }

        if (resultado === 'cache') { quitar(item); continue }
        if (resultado === 'ok' || resultado === 'vacio') {
          quitar(item)
          fallosSeguidos = 0
          descansos = 0
          if (resultado === 'vacio') vacios.set(item.clave, ahora())
          if (++aciertos >= ACIERTOS_PARA_ACELERAR) {
            aciertos = 0
            pausa = Math.max(PAUSA_MIN_MS, Math.round(pausa * 0.9))
          }
          await espera(pausa)
          continue
        }

        fallosSeguidos++
        aciertos = 0
        pausa = Math.min(PAUSA_MAX_MS, Math.round(pausa * 1.5))
        // un 429 es cosa de la IP, no de esa sesión; solo los otros fallos cuentan para dejarla
        if (resultado !== 'limitado') {
          const n = (fallosDe.get(item.clave) ?? 0) + 1
          fallosDe.set(item.clave, n)
          if (n >= MAX_FALLOS_ITEM) { quitar(item); fallidas.add(item.clave) }
        }
        await espera(Math.max(pausa, ESPERA_TRAS_FALLO_MS))
      }
    } finally {
      trabajando = false
    }
  }

  return {
    encolar,
    pendiente: clave => cola.some(x => x.clave === clave),
    sinDatos:  clave => vacio(clave) || fallidas.has(clave),
    estado: () => ({ enCola: cola.length, pausaMs: pausa, descansoHasta: descansoHasta || null }),
  }
}
