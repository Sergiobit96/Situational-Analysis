// Vigilante de fuera para producción: pregunta a /healthz/bots de Railway y avisa por Telegram
// cuando deja de responder o algún bot se para, y otra vez cuando se recupera. La vigilancia de
// dentro (server/vigilancia.js) no puede avisar si se cae el proceso entero: esto sí.
//
// Corre en este PC cada 5 min (tarea programada «Vigilar Situational Analysis»), así que solo
// vigila con el PC encendido. Avisa solo al cambiar de estado (lo recuerda en .vigilante.json,
// junto a este script) y da un segundo intento antes de dar por caído el servidor, para no
// avisar por un despliegue normal, que tarda menos de un minuto.
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const URL_SALUD = process.env.VIGILAR_URL ?? 'https://situational-analysis-production.up.railway.app/healthz/bots'
const aqui = dirname(fileURLToPath(import.meta.url))
const ESTADO = join(aqui, '.vigilante.json')
const env = readFileSync(join(aqui, '..', 'server', '.env'), 'utf8')
const token = env.match(/^TELEGRAM_TOKEN=(.*)$/m)?.[1].trim().replace(/^"|"$/g, '')
const chat = JSON.parse(readFileSync(process.env.TELEGRAM_CHAT ?? 'G:/Mi unidad/telegram.json', 'utf8')).id

async function mirar() {
  try {
    const r = await fetch(URL_SALUD, { signal: AbortSignal.timeout(20_000) })
    const j = await r.json().catch(() => null)
    if (r.ok) return { ok: true }
    const parados = j?.bots?.filter(b => b.parado).map(b => `${b.nombre} (${Math.round(b.segundosSinVuelta / 60)} min sin dar una vuelta)`) ?? []
    return { ok: false, motivo: parados.length ? `se ha parado ${parados.join(', ')}` : `responde con un error ${r.status}` }
  } catch (err) {
    const detalle = err.name === 'TimeoutError' ? 'no contesta en 20 s' : err.cause?.code ?? err.message
    return { ok: false, motivo: `no responde (${detalle})` }
  }
}

let ahora = await mirar()
if (!ahora.ok) {
  await new Promise(res => setTimeout(res, 90_000))
  ahora = await mirar()
}

let antes = { ok: true }
try { antes = JSON.parse(readFileSync(ESTADO, 'utf8')) } catch { /* primera vez */ }
writeFileSync(ESTADO, JSON.stringify({ ...ahora, hora: new Date().toISOString(), desde: ahora.ok === antes.ok ? antes.desde ?? new Date().toISOString() : new Date().toISOString() }))

// avisa solo al cambiar: de bien a mal, de mal a bien, o si el problema es otro
if (ahora.ok !== antes.ok || (!ahora.ok && ahora.motivo !== antes.motivo)) {
  const texto = ahora.ok
    ? 'Vuelvo a ver bien el servidor de producción: responde y los bots dan vueltas.'
    : `No veo bien el servidor de producción: ${ahora.motivo}. Mira primero el despliegue en Railway (¿se ha caído o está reiniciando?) y luego la vista Salud de la pestaña Bots.`
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: `Vigilante · ${texto}` }),
  })
  if (r.ok) console.log(texto)
  else { console.error(`Telegram: HTTP ${r.status}`); process.exitCode = 1 }
}
