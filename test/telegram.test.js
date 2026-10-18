// Tests de los avisos por Telegram (server/telegram.js), con un Telegram de mentira
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { crearTelegram } from '../server/telegram.js'

// Contesta a cada método lo que diga la prueba (por defecto, ok) y apunta las llamadas
function telegramFalso(respuestas = {}) {
  const llamadas = []
  const fetchFn = async (url, opciones) => {
    const metodo = url.split('/').at(-1)
    llamadas.push({ url, metodo, cuerpo: JSON.parse(opciones.body) })
    const r = respuestas[metodo] ?? { ok: true, result: {} }
    return { status: r.ok ? 200 : 400, json: async () => r }
  }
  return { fetchFn, llamadas }
}

test('sin token o sin chat no avisa ni llama a Telegram', async () => {
  const f = telegramFalso()
  assert.equal(await crearTelegram({ fetchFn: f.fetchFn }).enviar('hola'), false)
  assert.equal(await crearTelegram({ token: 't', fetchFn: f.fetchFn }).enviar('hola'), false)
  assert.equal(f.llamadas.length, 0)
})

test('conectar busca el chat entre los mensajes del bot, lo guarda y manda una prueba', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-'))
  const archivo = join(dir, 'telegram.json')
  const f = telegramFalso({
    getUpdates: { ok: true, result: [
      { message: { chat: { id: -100, type: 'group', title: 'Otro' } } },
      { message: { chat: { id: 42, type: 'private', first_name: 'Sergio' } } },
    ] },
  })
  try {
    const tg = crearTelegram({ token: 'SECRETO', archivo, fetchFn: f.fetchFn, log: () => {} })
    assert.deepEqual(await tg.conectar(), { token: true, conectado: true, nombre: 'Sergio' })
    assert.deepEqual(f.llamadas.map(l => l.metodo), ['getUpdates', 'sendMessage'])
    assert.equal(f.llamadas[1].cuerpo.chat_id, '42')
    assert.equal(JSON.parse(readFileSync(archivo, 'utf8')).id, '42')

    // al volver a arrancar el servidor lo lee del fichero y avisa sin buscarlo
    const otro = crearTelegram({ token: 'SECRETO', archivo, fetchFn: f.fetchFn, log: () => {} })
    assert.equal(await otro.enviar('DAX · Dentro a 25502'), true)
    assert.equal(f.llamadas.at(-1).url, 'https://api.telegram.org/botSECRETO/sendMessage')
    assert.deepEqual(f.llamadas.at(-1).cuerpo, { chat_id: '42', text: 'DAX · Dentro a 25502', disable_web_page_preview: true })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('si nadie le ha escrito al bot, o falta el token, conectar lo dice', async () => {
  const f = telegramFalso({ getUpdates: { ok: true, result: [] } })
  await assert.rejects(crearTelegram({ token: 't', fetchFn: f.fetchFn }).conectar(), /pulsa Iniciar/)
  await assert.rejects(crearTelegram({ fetchFn: f.fetchFn }).conectar(), /Falta TELEGRAM_TOKEN/)
})

test('un aviso que falla no para a los siguientes, salen en orden, y manda el chat de la variable', async () => {
  let fallar = true
  const enviados = []
  const fetchFn = async (url, opciones) => {
    if (fallar) { fallar = false; return { status: 502, json: async () => ({ ok: false, description: 'Bad Gateway' }) } }
    enviados.push(JSON.parse(opciones.body))
    return { status: 200, json: async () => ({ ok: true, result: {} }) }
  }
  const logs = []
  const tg = crearTelegram({ token: 'SECRETO', chatId: 7, fetchFn, log: t => logs.push(t) })
  assert.deepEqual(await Promise.all([tg.enviar('uno'), tg.enviar('dos'), tg.enviar('tres')]), [false, true, true])
  assert.deepEqual(enviados.map(c => [c.chat_id, c.text]), [['7', 'dos'], ['7', 'tres']])
  assert.match(logs[0], /Bad Gateway/)
  assert.ok(!logs.join(' ').includes('SECRETO'), 'el token no sale en los logs')
})
