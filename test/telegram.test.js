// Tests de los avisos por Telegram (server/telegram.js), con un Telegram de mentira
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { crearTelegram, formatearAvisos } from '../server/telegram.js'

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
    const otro = crearTelegram({ token: 'SECRETO', archivo, fetchFn: f.fetchFn, log: () => {}, juntarMs: 0 })
    assert.equal(await otro.enviar('DAX · Dentro a 25502'), true)
    assert.equal(f.llamadas.at(-1).url, 'https://api.telegram.org/botSECRETO/sendMessage')
    assert.deepEqual(f.llamadas.at(-1).cuerpo, { chat_id: '42', text: '<b>📌 DAX</b>\n🟢 <b>Dentro a 25502</b>', parse_mode: 'HTML', disable_web_page_preview: true })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('si nadie le ha escrito al bot, o falta el token, conectar lo dice', async () => {
  const f = telegramFalso({ getUpdates: { ok: true, result: [] } })
  await assert.rejects(crearTelegram({ token: 't', fetchFn: f.fetchFn }).conectar(), /pulsa Iniciar/)
  await assert.rejects(crearTelegram({ fetchFn: f.fetchFn }).conectar(), /Falta TELEGRAM_TOKEN/)
})

test('un mensaje que falla no para a los siguientes, salen en orden, y manda el chat de la variable', async () => {
  let fallar = true
  const enviados = []
  const fetchFn = async (url, opciones) => {
    if (fallar) { fallar = false; return { status: 502, json: async () => ({ ok: false, description: 'Bad Gateway' }) } }
    enviados.push(JSON.parse(opciones.body))
    return { status: 200, json: async () => ({ ok: true, result: {} }) }
  }
  const logs = []
  const tg = crearTelegram({ token: 'SECRETO', chatId: 7, fetchFn, log: t => logs.push(t), juntarMs: 0 })
  assert.equal(await tg.enviar('uno'), false)
  assert.deepEqual(await Promise.all([tg.enviar('dos'), tg.enviar('tres')]), [true, true])
  assert.deepEqual(enviados.map(c => [c.chat_id, c.text]), [['7', '🔹 dos\n🔹 tres']])
  assert.match(logs[0], /Bad Gateway/)
  assert.ok(!logs.join(' ').includes('SECRETO'), 'el token no sale en los logs')
})

test('los avisos seguidos van en un solo mensaje, juntos por bot y mercado', async () => {
  const f = telegramFalso()
  const tg = crearTelegram({ token: 't', chatId: 1, fetchFn: f.fetchFn, juntarMs: 20 })
  await Promise.all([
    tg.enviar('DAX · Bracket 100.0 – 110.0 (10.0 puntos, 0.05%)'),
    tg.enviar('Rule of 4 · Nasdaq · Dentro a 21000 (+0.5 puntos sobre el nivel)'),
    tg.enviar('DAX · Fuera a 105 (stop): -5.0 puntos'),
    tg.enviar('✅ El bot SRS vuelve a funcionar <ya>'),
  ])
  assert.equal(f.llamadas.length, 1)
  assert.equal(f.llamadas[0].cuerpo.text, [
    '<b>📌 DAX</b>',
    '📋 Bracket 100.0 – 110.0 (10.0 puntos, 0.05%)',
    '🏁 <b>Fuera a 105 (stop): -5.0 puntos</b>',
    '',
    '<b>📌 RULE OF 4 · NASDAQ</b>',
    '🟢 <b>Dentro a 21000 (+0.5 puntos sobre el nivel)</b>',
    '',
    '✅ El bot SRS vuelve a funcionar &lt;ya&gt;',
  ].join('\n'))
})

test('si no caben en un mensaje, van en varios y repiten la cabecera', () => {
  const largo = 'x'.repeat(1400)
  const mensajes = formatearAvisos([1, 2, 3, 4].map(() => `DAX · ${largo}`))
  assert.equal(mensajes.length, 2)
  assert.ok(mensajes.every(m => m.startsWith('<b>📌 DAX</b>\n') && m.length <= 4000))
})
