// ── Clave del bot y de IG en producción ──────────────────────────────────────────────
// En producción el servidor está en internet: sin esto, cualquiera que conociera la URL
// podría encender el bot, lanzar ensayos o gastar el cupo de histórico de IG. Todo lo de IG
// y del bot pide la cabecera X-Bot-Token (o ?token=, para el EventSource, que no manda
// cabeceras) igual a BOT_TOKEN. Sin BOT_TOKEN, en producción no pasa nada. En local, libre.
//
// Contra quien pruebe claves a ciegas: cada dirección puede equivocarse con MALAS_POR_ORIGEN
// claves distintas cada VENTANA, y entre todas las direcciones con MALAS_EN_TOTAL. Pasado eso,
// la dirección (o todo el mundo) queda bloqueada BLOQUEO, aunque luego acierte, y se avisa por
// Telegram. Repetir la misma clave mala no cuenta: eso es la pestaña Bot con una clave vieja
// guardada, no alguien probando. Los bots no pasan por aquí: siguen operando igual.

import { createHash, timingSafeEqual } from 'crypto'
import { isIPv6 } from 'net'

const VENTANA          = 15 * 60_000
const BLOQUEO          = 60 * 60_000
const MALAS_POR_ORIGEN = 10
const MALAS_EN_TOTAL   = 100
const ORIGENES_MAX     = 10_000

// Se comparan los resúmenes, que miden siempre lo mismo: comparar las claves tal cual dejaba
// ver por el tiempo de respuesta si la probada tenía la longitud buena
const resumen = texto => createHash('sha256').update(texto).digest()

// De dónde viene la petición. Una conexión IPv6 suele tener un /64 entero para ella sola: se
// cuenta por el /64, o cambiar de dirección daría intentos nuevos sin fin
export function origenDe(req) {
  const ip = String(req.ip ?? '').replace(/^::ffff:/, '')
  if (!isIPv6(ip)) return ip
  const [izq, der] = ip.split('::')
  const a = izq ? izq.split(':') : [], b = der ? der.split(':') : []
  const grupos = der === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b]
  return `${grupos.slice(0, 4).join(':')}::/64`
}

function crearContador(max) {
  let desde = 0, malas = new Set(), hasta = 0
  return {
    bloqueado: t => t < hasta,
    caducado: t => t >= hasta && t - desde > VENTANA,
    // apunta una clave mala; true si con ella se pasa del máximo y queda bloqueado
    apuntar(clave, t) {
      if (t - desde > VENTANA) { desde = t; malas = new Set() }
      malas.add(clave)
      if (malas.size <= max) return false
      hasta = t + BLOQUEO
      malas = new Set()
      return true
    },
  }
}

export function crearClaveBot({ token = '', produccion = false, ahora = Date.now, avisar = () => {} }) {
  const esperada  = resumen(token)
  const porOrigen = new Map()
  const total     = crearContador(MALAS_EN_TOTAL)
  const aviso = texto => {
    console.warn(`[clave-bot] ${texto}`)
    Promise.resolve().then(() => avisar(texto)).catch(() => {})
  }

  function apuntarMala(origen, clave, t) {
    if (!porOrigen.has(origen)) {
      // muchas direcciones distintas no deben llenar la memoria: primero se olvidan las que ya
      // no cuentan, y si ni así, la más antigua
      if (porOrigen.size >= ORIGENES_MAX) for (const [o, c] of porOrigen) if (c.caducado(t)) porOrigen.delete(o)
      if (porOrigen.size >= ORIGENES_MAX) porOrigen.delete(porOrigen.keys().next().value)
      porOrigen.set(origen, crearContador(MALAS_POR_ORIGEN))
    }
    if (porOrigen.get(origen).apuntar(clave, t)) {
      aviso(`🔒 Alguien ha probado más de ${MALAS_POR_ORIGEN} claves del bot equivocadas desde ${origen}: esa dirección no puede usar la pestaña Bot ni IG durante una hora. Los bots siguen operando. Si eras tú, mira la clave guardada en la pestaña Bot.`)
    }
    if (total.apuntar(clave, t)) {
      aviso(`🔒 Se han probado más de ${MALAS_EN_TOTAL} claves del bot equivocadas en un cuarto de hora, desde varias direcciones: nadie puede usar la pestaña Bot ni IG durante una hora, ni con la clave buena. Los bots siguen operando. Si se repite, pon en Railway una BOT_TOKEN más larga.`)
    }
  }

  // 'ok', 'sin-token' (falta BOT_TOKEN en el servidor), 'bloqueado' o 'mal'
  function comprobar(req) {
    if (!produccion) return 'ok'
    if (!token) return 'sin-token'
    const t = ahora()
    const origen = origenDe(req)
    if (total.bloqueado(t) || porOrigen.get(origen)?.bloqueado(t)) return 'bloqueado'
    const dada = String(req.get?.('x-bot-token') ?? req.query?.token ?? '')
    const suya = resumen(dada)
    if (timingSafeEqual(suya, esperada)) return 'ok'
    // sin clave no es probar: es la web sin la clave guardada todavía
    if (dada) apuntarMala(origen, suya.toString('hex'), t)
    return 'mal'
  }

  // Deja pasar con la clave buena; si no, contesta él y devuelve false
  function exigir(req, res) {
    const r = comprobar(req)
    if (r === 'ok') return true
    if (r === 'sin-token') res.status(503).json({ error: 'Falta BOT_TOKEN en el servidor', necesitaClave: true })
    else if (r === 'bloqueado') res.status(429).json({ error: 'Demasiadas claves equivocadas: vuelve a probar dentro de una hora', necesitaClave: true })
    else res.status(401).json({ error: 'Clave del bot incorrecta', necesitaClave: true })
    return false
  }

  return {
    valida: req => comprobar(req) === 'ok',
    exigir,
    middleware: (req, res, next) => { if (exigir(req, res)) next() },
  }
}
