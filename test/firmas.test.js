import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conFirmas as firmar } from '../server/firmas.js'
import { conFirmas, juntarFirmas } from '../src/firmas.js'

test('un campo que no ha cambiado no se repite y el navegador lo repone', () => {
  const estado = { config: { a: 1 }, historial: [{ d: 1 }, { d: 2 }] }
  const primera = firmar({}, estado, ['historial'])
  assert.deepEqual(primera.historial, estado.historial)

  const url = conFirmas('/api/bot', primera)
  assert.match(url, /^\/api\/bot\?f_historial=/)
  const query = Object.fromEntries(new URL(url, 'http://x').searchParams)
  const segunda = firmar(query, estado, ['historial'])
  assert.equal(segunda.historial, undefined)
  const junta = juntarFirmas(segunda, primera)
  assert.equal(junta.historial, primera.historial)   // el mismo objeto

  const cambiado = firmar(query, { ...estado, historial: [{ d: 3 }] }, ['historial'])
  assert.deepEqual(juntarFirmas(cambiado, junta).historial, [{ d: 3 }])
})

test('sin respuesta anterior, la url va sin firmas', () => {
  assert.equal(conFirmas('/api/bot', null), '/api/bot')
  assert.equal(conFirmas('/api/bot?x=1', { firmas: { h: 'a' }, h: [] }), '/api/bot?x=1&f_h=a')
})
