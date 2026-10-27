// Antes de subir a main (git pre-push, en .githooks): cada push a main redespliega Railway y
// reinicia los bots, que pierden el directo de la sesión en curso (el bracket y el gráfico de
// la pestaña empiezan en la hora del reinicio). Pregunta a producción y para el push si alguna
// sesión encendida del SRS o de la Rule of 4 está abierta, o si queda alguna posición suya
// entre manos. Las tortugas no cuentan: sus sesiones son de 24 h y al arrancar recuperan lo suyo.
//
// Saltárselo: PUSH_FORZAR=1 git push …   (o git push --no-verify)
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const URL_API = process.env.PUSH_API ?? 'https://situational-analysis.vercel.app/api/bot'
const BOTS = [['SRS', ''], ['Rule of 4', '/rule-of-4']]
const TERMINADOS = new Set(['terminado', 'sin-operar'])

// Solo importa main: git pasa por stdin "<ref local> <sha> <ref remota> <sha>" por cada rama
const entrada = readFileSync(0, 'utf8')
if (!entrada.split('\n').some(l => l.split(' ')[2] === 'refs/heads/main')) process.exit(0)
if (process.env.PUSH_FORZAR === '1') {
  console.error('antes-de-push: PUSH_FORZAR=1, no miro las sesiones de los bots')
  process.exit(0)
}

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const token = (() => {
  try { return readFileSync(join(raiz, 'server', '.env'), 'utf8').match(/^BOT_TOKEN=(.*)$/m)?.[1].trim().replace(/^"|"$/g, '') }
  catch { return null }
})()

const hora = t => new Date(t * 1000).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' })
const ahora = Date.now() / 1000
const motivos = []
let libre = 0
for (const [nombre, ruta] of BOTS) {
  let j
  try {
    const r = await fetch(URL_API + ruta, { headers: token ? { 'X-Bot-Token': token } : {}, signal: AbortSignal.timeout(15_000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    j = await r.json()
  } catch (err) {
    motivos.push(`no he podido preguntar al bot ${nombre} (${err.message})`)
    continue
  }
  if (!j.config?.activo) continue
  const vistos = new Set()
  for (const s of j.sesiones ?? []) {
    if (!s.encendido || !s.hoy || ahora < s.hoy.abre || ahora >= s.hoy.cierra) continue
    vistos.add(s.ticker)
    motivos.push(`${nombre}: sesión de ${s.nombre} abierta hasta las ${hora(s.hoy.cierra)} de Madrid`)
    libre = Math.max(libre, s.hoy.cierra)
  }
  for (const d of j.hoy ?? []) {
    if (TERMINADOS.has(d.estado)) continue
    if (vistos.has(d.ticker)) continue
    // una sesión que aún no ha abierto (el Nikkei de mañana, esperando su bracket) no tiene nada que perder
    if (d.abre != null && ahora < d.abre && !/posicion/.test(d.estado)) continue
    motivos.push(`${nombre}: ${d.ticker} sigue ${d.estado}`)
    libre = Math.max(libre, d.cierra ?? 0)
  }
}

if (!motivos.length) process.exit(0)
console.error('\nNo subo a main: el push reinicia los bots en Railway.')
for (const m of motivos) console.error(`  · ${m}`)
if (libre > ahora) console.error(`Hasta las ${hora(libre)} de Madrid no hay hueco.`)
console.error("Si hay que subir igualmente: PUSH_FORZAR=1 git push … (en PowerShell: $env:PUSH_FORZAR='1'; git push …)\n")
process.exit(1)
