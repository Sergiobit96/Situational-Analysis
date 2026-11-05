// ── Interactive Brokers (server/ib.js): estado de la conexión, la cuenta, sus posiciones y
// órdenes, y órdenes a mano. Bajo /api/bot para que en producción pida la misma clave. En
// producción el Gateway es otro servicio de Railway (docs/ib-gateway-railway.md): IB_HOST con su
// dominio privado e IB_PORT=4004. Sin IB_PORT contesta que no está configurado. Ningún bot opera aquí.

import { crearIB } from './ib.js'
import { crearHistorialIB } from './historial-ib.js'

export function registrarIB({ app, avisar, archivoHistorial = null }) {
  const ib = crearIB({
    historial: crearHistorialIB({ archivo: archivoHistorial }),
    host: process.env.IB_HOST || '127.0.0.1', port: process.env.IB_PORT,
    clientId: process.env.IB_CLIENT_ID || 17, real: process.env.IB_REAL === '1', avisarCaida: avisar,
  })
  const conIB = hacer => async (req, res) => {
    if (!ib) return res.status(404).json({ error: 'IB no está configurado en este servidor (falta IB_PORT: 4002 para el IB Gateway paper de este PC, 4004 para el servicio ib-gateway de Railway)' })
    try { res.json(await hacer(req)) }
    catch (err) { res.status(/no válid|Falta|tiene que|necesita|es real|No conozco|No hay ninguna/.test(err.message) ? 400 : 503).json({ error: err.message }) }
  }
  app.get('/api/bot/ib', conIB(() => ib.estado()))
  app.get('/api/bot/ib/historial', conIB(req => ({ historial: ib.historial(Math.min(Number(req.query.limite) || 500, 5000)) })))
  app.post('/api/bot/ib/orden', conIB(req => ib.enviarOrden(req.body ?? {})))
  app.delete('/api/bot/ib/orden/:id', conIB(req => ib.cancelarOrden(req.params.id)))
  app.delete('/api/bot/ib/posicion/:conId', conIB(req => ib.cerrarPosicion(req.params.conId)))
  return { ib }
}
