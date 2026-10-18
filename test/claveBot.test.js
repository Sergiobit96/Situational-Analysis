// Tests de la clave del bot en producción (server/clave-bot.js)
import test from 'node:test'
import assert from 'node:assert/strict'

import { crearClaveBot } from '../server/clave-bot.js'

const pedido = ({ cabecera, token } = {}) => ({ get: k => (k === 'x-bot-token' ? cabecera : undefined), query: token ? { token } : {} })
function respuesta() {
  const r = { codigo: null, cuerpo: null }
  r.status = c => { r.codigo = c; return r }
  r.json = j => { r.cuerpo = j; return r }
  return r
}
function pasar(clave, req) {
  const res = respuesta()
  let siguio = false
  clave.middleware(req, res, () => { siguio = true })
  return { siguio, ...res }
}

test('en local no pide nada', () => {
  assert.equal(pasar(crearClaveBot({ token: '', produccion: false }), pedido()).siguio, true)
})

test('en producción deja pasar solo con la clave, por cabecera o por ?token=', () => {
  const clave = crearClaveBot({ token: 'secreto-largo', produccion: true })
  assert.equal(pasar(clave, pedido({ cabecera: 'secreto-largo' })).siguio, true)
  assert.equal(pasar(clave, pedido({ token: 'secreto-largo' })).siguio, true)
  const mal = pasar(clave, pedido({ cabecera: 'secreto-larga' }))
  assert.equal(mal.siguio, false)
  assert.equal(mal.codigo, 401)
  assert.equal(mal.cuerpo.necesitaClave, true)
  assert.equal(pasar(clave, pedido()).codigo, 401)
  assert.equal(pasar(clave, pedido({ cabecera: 'corta' })).codigo, 401)
})

test('en producción sin BOT_TOKEN no pasa nada', () => {
  const r = pasar(crearClaveBot({ token: '', produccion: true }), pedido({ cabecera: '' }))
  assert.equal(r.siguio, false)
  assert.equal(r.codigo, 503)
  assert.match(r.cuerpo.error, /Falta BOT_TOKEN/)
})
