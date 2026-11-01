// Tests del perfil de CPU (server/perfil.js)
import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from 'inspector/promises'

import { resumirPerfil } from '../server/perfil.js'

function bloquear(ms) {
  const hasta = Date.now() + ms
  let x = 0
  while (Date.now() < hasta) x += Math.sqrt(x + 1)
  return x
}

test('un bloqueo de 300 ms sale como tramo largo, con la función que lo causó', async () => {
  const sesion = new Session()
  sesion.connect()
  await sesion.post('Profiler.enable')
  await sesion.post('Profiler.setSamplingInterval', { interval: 1000 })
  await sesion.post('Profiler.start')
  const inicio = Date.now()
  await new Promise(r => setTimeout(r, 100))
  bloquear(300)
  await new Promise(r => setTimeout(r, 100))
  const { profile } = await sesion.post('Profiler.stop')
  sesion.disconnect()

  const r = resumirPerfil(profile, { inicio })
  assert.equal(r.tramosLargos.length, 1)
  const [t] = r.tramosLargos
  assert.ok(t.ms >= 250 && t.ms < 450, `${t.ms} ms`)
  assert.match(t.que[0].pila, /^bloquear .*perfil\.test\.js:\d+/)
  assert.ok(Math.abs(Date.parse(t.hora) - (inicio + 100)) < 150)
  assert.match(r.masCaras[0].f, /bloquear|sqrt|now/)
})
