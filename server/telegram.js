// ── Avisos por Telegram ──────────────────────────────────────────────────────────────
// El bot SRS cuenta por aquí lo que hace: entradas, añadidos, stops, salidas, errores y
// cambios de configuración. Hace falta un bot de Telegram propio (se crea con @BotFather, que
// da su token) y la variable TELEGRAM_TOKEN en el servidor. El chat al que escribir se
// averigua solo: basta con abrir el bot en Telegram, pulsar Iniciar y después «Conectar
// Telegram» en la pestaña Bot, que lo busca entre los mensajes que ha recibido el bot y lo
// guarda junto al registro del bot. Si está TELEGRAM_CHAT_ID, manda ese.
// El token va en la URL de la API de Telegram: nunca se escribe en los logs.

import { readFileSync, writeFileSync, renameSync } from 'fs'

const API = 'https://api.telegram.org'
const MAX_TEXTO = 4000   // Telegram no admite mensajes de más de 4096 caracteres

export function crearTelegram({ token = '', chatId = '', archivo = null, fetchFn = fetch, log = console.log }) {
  let chat = chatId ? { id: String(chatId), nombre: null } : leer()

  function leer() {
    if (!archivo) return null
    try {
      const j = JSON.parse(readFileSync(archivo, 'utf8'))
      return j?.id ? j : null
    } catch { return null }
  }
  function guardar() {
    if (!archivo) return
    try {
      writeFileSync(`${archivo}.tmp`, JSON.stringify(chat))
      renameSync(`${archivo}.tmp`, archivo)
    } catch (err) { log(`[telegram] no se ha podido guardar el chat: ${err.message}`) }
  }

  async function llamar(metodo, cuerpo = {}) {
    const r = await fetchFn(`${API}/bot${token}/${metodo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(15_000),
    })
    const j = await r.json().catch(() => null)
    if (!j?.ok) throw new Error(j?.description ?? `HTTP ${r.status}`)
    return j.result
  }

  // Los avisos salen en orden y de uno en uno; uno que falla no para a los siguientes
  let cola = Promise.resolve()
  function enviar(texto) {
    if (!token || !chat) return Promise.resolve(false)
    const hecho = cola
      .then(() => llamar('sendMessage', { chat_id: chat.id, text: String(texto).slice(0, MAX_TEXTO), disable_web_page_preview: true }))
      .then(() => true, err => { log(`[telegram] no se ha podido avisar: ${err.message}`); return false })
    cola = hecho
    return hecho
  }

  // Busca el chat, si aún no lo tiene, y manda un mensaje de prueba
  async function conectar() {
    if (!token) throw new Error('Falta TELEGRAM_TOKEN en el servidor')
    if (!chat) {
      const novedades = await llamar('getUpdates', { allowed_updates: ['message'] })
      const c = novedades.map(u => u.message?.chat).filter(x => x?.type === 'private').at(-1)
      if (!c) throw new Error('No encuentro tu chat: abre tu bot en Telegram, pulsa Iniciar (o escríbele algo) y vuelve a pulsar Conectar')
      chat = { id: String(c.id), nombre: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || null }
      guardar()
    }
    await llamar('sendMessage', { chat_id: chat.id, text: 'Avisos del bot SRS conectados: aquí te contaré cada entrada, salida y cambio.' })
    return estado()
  }

  function estado() {
    return { token: !!token, conectado: !!chat, nombre: chat?.nombre ?? null }
  }

  return { enviar, conectar, estado }
}
