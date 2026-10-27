import { test } from 'node:test'
import assert from 'node:assert/strict'
import { avisosDeSalud } from '../server/salud.js'

const sano = () => ({
  servidor: { opera: true },
  bots: { ok: true, bots: [{ nombre: 'SRS', enMarcha: true, segundosSinVuelta: 4, parado: false }] },
  bucle: { peorRecienteMs: 40 },
  ig: { sesion: 'abierta', streaming: 'CONNECTED:WS-STREAMING', cupo: { remainingAllowance: 9000 } },
  fuentes: { dukascopy: { limitando: false }, twelveData: { clave: true } },
  calendarioFomc: { actualizado: '2026-10-27T12:00:00Z', error: null },
  telegram: { token: true, conectado: true },
  conciliacion: { error: null, pendientes: [] },
  noticias: { error: null },
  grabacion: { error: null },
})
const ahora = Date.parse('2026-10-27T15:00:00Z')

test('un servidor sano no da avisos', () => {
  assert.deepEqual(avisosDeSalud(sano(), ahora), [])
})

test('lo que no funciona va antes que lo que conviene saber', () => {
  const s = sano()
  s.ig.cupo.remainingAllowance = 0
  s.bots.bots[0] = { nombre: 'SRS', enMarcha: true, segundosSinVuelta: 300, parado: true }
  s.ig.streaming = 'DISCONNECTED'
  const a = avisosDeSalud(s, ahora)
  assert.deepEqual(a.map(x => x.nivel), ['mal', 'mal', 'ojo'])
  assert.match(a[0].texto, /SRS lleva 5 min/)
  assert.match(a[2].texto, /cupo semanal/)
})

test('Twelve Data y Telegram solo cuentan donde operan los bots', () => {
  const s = sano()
  s.fuentes.twelveData.clave = false
  s.telegram = { token: false, conectado: false }
  assert.equal(avisosDeSalud(s, ahora).length, 2)
  s.servidor.opera = false
  assert.deepEqual(avisosDeSalud(s, ahora), [])
})

test('un calendario del FOMC viejo o con error, y las diferencias con IG', () => {
  const s = sano()
  s.calendarioFomc.actualizado = '2026-10-20T00:00:00Z'
  s.conciliacion.pendientes = [{}, {}]
  const a = avisosDeSalud(s, ahora)
  assert.deepEqual(a.map(x => x.texto.slice(0, 20)), ['2 diferencias entre ', 'El calendario del FO'])
})
