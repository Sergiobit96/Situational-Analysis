// ── Avisos por Telegram ──────────────────────────────────────────────────────────────
// El bot SRS cuenta por aquí lo que hace: entradas, añadidos, stops, salidas, errores y
// cambios de configuración. Hace falta un bot de Telegram propio (se crea con @BotFather, que
// da su token) y la variable TELEGRAM_TOKEN en el servidor. El chat al que escribir se
// averigua solo: basta con abrir el bot en Telegram, pulsar Iniciar y después «Conectar
// Telegram» en la pestaña Bot, que lo busca entre los mensajes que ha recibido el bot y lo
// guarda junto al registro del bot. Si está TELEGRAM_CHAT_ID, manda ese.
// Los avisos que llegan con pocos segundos de diferencia salen juntos en un solo mensaje.
// El token va en la URL de la API de Telegram: nunca se escribe en los logs.

import { readFileSync, writeFileSync, renameSync } from 'fs'

const API = 'https://api.telegram.org'
const MAX_TEXTO = 4000        // Telegram no admite mensajes de más de 4096 caracteres
const MAX_AVISO = 1500        // un aviso suelto no se come el mensaje entero
const JUNTAR_MS = 5_000       // los avisos que llegan seguidos (un arranque, una entrada y su stop) van en un mensaje
const JUNTAR_MAX_MS = 20_000  // …pero ninguno espera más que esto

const escapar = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// «Rule of 4 · Nasdaq · Dentro a 21000» → cabecera «Rule of 4 · Nasdaq» y texto «Dentro a 21000»
export function partirAviso(aviso) {
  const [primera, ...resto] = String(aviso).slice(0, MAX_AVISO).split('\n')
  const trozos = primera.split(' · ')
  return { cabecera: trozos.slice(0, -1).join(' · '), texto: [trozos.at(-1), ...resto].join('\n') }
}

// El icono de cada aviso, por lo que dice; los que ya traen el suyo (⚠️, ✅, 🔴…) se quedan con él.
// Las entradas, salidas y errores van además en negrita.
const ICONOS = [
  [/^\p{Extended_Pictographic}/u, '', false],
  [/^error|rechaza|no he podido|no se pueden|no llegó|no deja|revísala/i, '❌', true],
  [/^(fuera|salió|salieron) /i, '🏁', true],
  [/^(dentro|compra|venta|añadida|pirámide)[ :]/i, '🟢', true],
  [/stop/i, '🛑', false],
  [/no se opera|no se entra|no entra|no se añade|sin plan/i, '⏸️', false],
  [/arrancado/i, '🚀', false],
  [/apagado/i, '⏹️', false],
  [/^plan\b|^bracket\b|^ruptura\b/i, '📋', false],
]
function linea(texto) {
  const [, icono = '🔹', negrita = false] = ICONOS.find(([re]) => re.test(texto)) ?? []
  const [primera, ...resto] = escapar(texto).split('\n')
  return [`${icono ? `${icono} ` : ''}${negrita ? `<b>${primera}</b>` : primera}`, ...resto].join('\n')
}

// Los avisos de un lote, en HTML de Telegram: juntos los del mismo bot y mercado, bajo su
// cabecera en negrita, en el orden en que llegaron. Si no caben en un mensaje, en varios.
export function formatearAvisos(avisos) {
  const grupos = new Map()
  for (const { cabecera, texto } of avisos.map(partirAviso)) {
    if (!grupos.has(cabecera)) grupos.set(cabecera, [])
    grupos.get(cabecera).push(linea(texto))
  }
  const mensajes = []
  let actual = ''
  for (const [cabecera, lineas] of grupos) {
    const titulo = cabecera ? `<b>📌 ${escapar(cabecera.toUpperCase())}</b>` : ''
    let enGrupo = false
    for (const l of lineas) {
      const trozo = enGrupo ? `\n${l}` : `${actual ? '\n\n' : ''}${titulo ? `${titulo}\n` : ''}${l}`
      if (actual && actual.length + trozo.length > MAX_TEXTO) {
        mensajes.push(actual)
        actual = `${titulo ? `${titulo}\n` : ''}${l}`
      } else actual += trozo
      enGrupo = true
    }
  }
  if (actual) mensajes.push(actual)
  return mensajes
}

export function crearTelegram({ token = '', chatId = '', archivo = null, fetchFn = fetch, log = console.log, juntarMs = JUNTAR_MS, juntarMaxMs = JUNTAR_MAX_MS }) {
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

  // Los avisos que llegan seguidos se juntan en un mensaje (o en los menos posibles), que
  // salen en orden y de uno en uno; uno que falla no para a los siguientes. Cada `enviar`
  // devuelve si salió su mensaje.
  let cola = Promise.resolve()
  let pendientes = []
  let primero = 0
  let temporizador = null
  function enviar(texto) {
    if (!token || !chat) return Promise.resolve(false)
    return new Promise(resolver => {
      if (!pendientes.length) primero = Date.now()
      pendientes.push({ texto, resolver })
      clearTimeout(temporizador)
      temporizador = setTimeout(soltar, Math.max(0, Math.min(juntarMs, primero + juntarMaxMs - Date.now())))
    })
  }
  function soltar() {
    const lote = pendientes
    pendientes = []
    const hecho = cola.then(async () => {
      let bien = true
      for (const text of formatearAvisos(lote.map(p => p.texto))) {
        try { await llamar('sendMessage', { chat_id: chat.id, text, parse_mode: 'HTML', disable_web_page_preview: true }) }
        catch (err) { log(`[telegram] no se ha podido avisar: ${err.message}`); bien = false }
      }
      return bien
    })
    cola = hecho
    hecho.then(bien => { for (const p of lote) p.resolver(bien) })
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
