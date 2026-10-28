// ── Los zips del histórico de Dukascopy, al día en el disco del servidor online ──
// El workflow «Bajar histórico» de Sergiobit96/dukascopy-historico deja cada noche en su
// release «historico» un .zip por instrumento con los CSV de 1 min por mes. Aquí se bajan
// los que hayan cambiado a <dir>\<instrumento>.zip, de uno en uno y en streaming (sin
// cargarlos en memoria), y server/historico-dukascopy.js lee los meses de dentro.
//
// Antes de bajar uno se mira que quepa en el volumen con margen; si no, se deja y queda
// dicho en el estado. Un zip a medias nunca se ve: se baja a .tmp y se renombra al final.

import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

const REPO = 'Sergiobit96/dukascopy-historico'
const CADA_MS = 6 * 60 * 60_000
const PRIMERA_TRAS_MS = 2 * 60_000   // que el arranque (bots, IG) vaya antes
const MARGEN_LIBRE = 1024 ** 3       // lo que se deja libre en el volumen tras bajar un zip

export function crearSincronizacionHistorico(dir, { repo = REPO, log = console } = {}) {
  const ESTADO = join(dir, 'estado.json')
  let estado = { zips: {}, ultima: null, error: null }
  try { estado = { ...estado, ...JSON.parse(readFileSync(ESTADO, 'utf8')) } } catch { /* primera vez */ }
  let enMarcha = false

  const guardar = () => { try { writeFileSync(ESTADO, JSON.stringify(estado, null, 2)) } catch { /* no crítico */ } }

  async function sincronizar() {
    if (enMarcha) return
    enMarcha = true
    try {
      mkdirSync(dir, { recursive: true })
      const r = await fetch(`https://api.github.com/repos/${repo}/releases/tags/historico`, { headers: { Accept: 'application/vnd.github+json' } })
      if (!r.ok) throw new Error(`GitHub contesta ${r.status} al pedir el release`)
      const { assets = [] } = await r.json()
      for (const a of assets) {
        const instrumento = a.name.replace(/\.zip$/, '')
        if (!/^[a-z0-9]+$/.test(instrumento) || a.size < 1024) continue
        const visto = estado.zips[instrumento]
        if (visto?.actualizado === a.updated_at) continue
        const { bavail, bsize } = statfsSync(dir)
        const libre = bavail * bsize + (visto?.bytes ?? 0)
        if (libre < a.size + MARGEN_LIBRE) {
          estado.zips[instrumento] = { ...visto, sinSitio: `faltan ${((a.size + MARGEN_LIBRE - libre) / 1024 ** 2).toFixed(0)} MB` }
          log.warn(`[histórico] ${instrumento}: no cabe en el volumen (${(libre / 1024 ** 2).toFixed(0)} MB libres)`)
          continue
        }
        const destino = join(dir, `${instrumento}.zip`)
        const t0 = Date.now()
        try {
          const z = await fetch(a.browser_download_url)
          if (!z.ok || !z.body) throw new Error(`descarga ${z.status}`)
          await pipeline(Readable.fromWeb(z.body), createWriteStream(`${destino}.tmp`))
          renameSync(`${destino}.tmp`, destino)
        } catch (err) {
          rmSync(`${destino}.tmp`, { force: true })
          throw new Error(`${instrumento}: ${err.message}`)
        }
        estado.zips[instrumento] = { actualizado: a.updated_at, bytes: a.size, bajado: new Date().toISOString() }
        guardar()
        log.log(`[histórico] ${instrumento}: ${(a.size / 1024 ** 2).toFixed(0)} MB en ${((Date.now() - t0) / 1000).toFixed(0)} s`)
      }
      estado.ultima = new Date().toISOString()
      estado.error = null
    } catch (err) {
      estado.error = err.message
      log.warn(`[histórico] ${err.message}`)
    } finally {
      enMarcha = false
      guardar()
    }
  }

  return {
    iniciar() {
      setTimeout(sincronizar, PRIMERA_TRAS_MS).unref()
      setInterval(sincronizar, CADA_MS).unref()
    },
    sincronizar,
    estado: () => ({ ...estado, enMarcha }),
  }
}
