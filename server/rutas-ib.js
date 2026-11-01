// ── Interactive Brokers (server/ib.js): estado de la conexión, la cuenta, sus posiciones y
// órdenes, y órdenes a mano. Bajo /api/bot para que en producción pida la misma clave, aunque
// allí no hay IB_PORT y contesta que no está configurado. Ningún bot opera aquí todavía.

import { crearIB } from './ib.js'

export function registrarIB({ app }) {
  const ib = crearIB({
    host: process.env.IB_HOST || '127.0.0.1', port: process.env.IB_PORT,
    clientId: process.env.IB_CLIENT_ID || 17, real: process.env.IB_REAL === '1',
  })
  const conIB = hacer => async (req, res) => {
    if (!ib) return res.status(404).json({ error: 'IB no está configurado (falta IB_PORT: 4002 para el IB Gateway paper, 7497 para la TWS paper)' })
    try { res.json(await hacer(req)) }
    catch (err) { res.status(/no válid|Falta|tiene que|necesita|es real|No conozco|No hay ninguna/.test(err.message) ? 400 : 503).json({ error: err.message }) }
  }
  app.get('/api/bot/ib', conIB(() => ib.estado()))
  app.post('/api/bot/ib/orden', conIB(req => ib.enviarOrden(req.body ?? {})))
  app.delete('/api/bot/ib/orden/:id', conIB(req => ib.cancelarOrden(req.params.id)))
  app.delete('/api/bot/ib/posicion/:conId', conIB(req => ib.cerrarPosicion(req.params.conId)))
  return { ib }
}
