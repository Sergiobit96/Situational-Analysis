// Tests de la clave del bot en producción (server/clave-bot.js)
import test from 'node:test'
import assert from 'node:assert/strict'

import { crearClaveBot, origenDe } from '../server/clave-bot.js'

const pedido = ({ cabecera, token, ip = '203.0.113.7' } = {}) => ({ ip, get: k => (k === 'x-bot-token' ? cabecera : undefined), query: token ? { token } : {} })
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

// Un reloj que se adelanta a mano y una clave de producción que apunta sus avisos
function enProduccion() {
  const reloj = { t: 1_000_000 }
  const avisos = []
  const clave = crearClaveBot({ token: 'secreto-largo', produccion: true, ahora: () => reloj.t, avisar: texto => avisos.push(texto) })
  return { clave, reloj, avisos }
}
const probarMalas = (clave, n, ip, prefijo = 'mala') => {
  for (let i = 0; i < n; i++) pasar(clave, pedido({ cabecera: `${prefijo}-${i}`, ip }))
}

test('más de 10 claves malas distintas bloquean esa dirección una hora, aunque luego acierte', async () => {
  const { clave, reloj, avisos } = enProduccion()
  probarMalas(clave, 10, '198.51.100.1')
  assert.equal(pasar(clave, pedido({ cabecera: 'secreto-largo', ip: '198.51.100.1' })).siguio, true)
  probarMalas(clave, 1, '198.51.100.1', 'otra')
  const r = pasar(clave, pedido({ cabecera: 'secreto-largo', ip: '198.51.100.1' }))
  assert.equal(r.siguio, false)
  assert.equal(r.codigo, 429)
  // las demás direcciones siguen entrando
  assert.equal(pasar(clave, pedido({ cabecera: 'secreto-largo', ip: '198.51.100.2' })).siguio, true)
  await Promise.resolve()
  assert.equal(avisos.length, 1)
  assert.match(avisos[0], /198\.51\.100\.1/)
  reloj.t += 60 * 60_000
  assert.equal(pasar(clave, pedido({ cabecera: 'secreto-largo', ip: '198.51.100.1' })).siguio, true)
})

test('repetir la misma clave mala, o no mandar ninguna, no bloquea', () => {
  const { clave } = enProduccion()
  for (let i = 0; i < 50; i++) pasar(clave, pedido({ cabecera: 'clave-vieja' }))
  for (let i = 0; i < 50; i++) pasar(clave, pedido({ cabecera: '' }))
  assert.equal(pasar(clave, pedido({ cabecera: 'secreto-largo' })).siguio, true)
})

test('las claves malas de hace más de un cuarto de hora ya no cuentan', () => {
  const { clave, reloj } = enProduccion()
  probarMalas(clave, 10, '198.51.100.1')
  reloj.t += 16 * 60_000
  probarMalas(clave, 10, '198.51.100.1', 'luego')
  assert.equal(pasar(clave, pedido({ cabecera: 'secreto-largo', ip: '198.51.100.1' })).siguio, true)
})

test('más de 100 claves malas entre muchas direcciones bloquean a todo el mundo', async () => {
  const { clave, avisos } = enProduccion()
  for (let ip = 0; ip <= 100; ip++) probarMalas(clave, 1, `192.0.2.${ip}`, `ip${ip}`)
  const r = pasar(clave, pedido({ cabecera: 'secreto-largo', ip: '198.51.100.9' }))
  assert.equal(r.codigo, 429)
  await Promise.resolve()
  assert.equal(avisos.length, 1)
  assert.match(avisos[0], /nadie puede/)
})

test('las IPv6 cuentan por su /64, y las IPv4 dentro de IPv6 como IPv4', () => {
  assert.equal(origenDe({ ip: '2001:db8:1:2:aaaa::1' }), '2001:db8:1:2::/64')
  assert.equal(origenDe({ ip: '2001:db8:1:2:bbbb:cccc:dddd:eeee' }), '2001:db8:1:2::/64')
  assert.equal(origenDe({ ip: '2001:db8::5' }), '2001:db8:0:0::/64')
  assert.equal(origenDe({ ip: '::ffff:198.51.100.1' }), '198.51.100.1')
  assert.equal(origenDe({ ip: '198.51.100.1' }), '198.51.100.1')
})
