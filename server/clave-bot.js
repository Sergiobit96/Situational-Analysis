// ── Clave del bot y de IG en producción ──────────────────────────────────────────────
// En producción el servidor está en internet: sin esto, cualquiera que conociera la URL
// podría encender el bot, lanzar ensayos o gastar el cupo de histórico de IG. Todo lo de IG
// y del bot pide la cabecera X-Bot-Token (o ?token=, para el EventSource, que no manda
// cabeceras) igual a BOT_TOKEN. Sin BOT_TOKEN, en producción no pasa nada. En local, libre.

import { timingSafeEqual } from 'crypto'

export function crearClaveBot({ token = '', produccion = false }) {
  function valida(req) {
    if (!produccion) return true
    const dada = String(req.get?.('x-bot-token') ?? req.query?.token ?? '')
    if (!token || dada.length !== token.length) return false
    return timingSafeEqual(Buffer.from(dada), Buffer.from(token))
  }
  function middleware(req, res, next) {
    if (valida(req)) return next()
    res.status(token ? 401 : 503).json({ error: token ? 'Clave del bot incorrecta' : 'Falta BOT_TOKEN en el servidor', necesitaClave: true })
  }
  return { valida, middleware }
}
