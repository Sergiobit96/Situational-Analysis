// Trae a Documents\Dukascopy\historico lo que ha bajado el workflow «Bajar histórico» del repo
// Sergiobit96/dukascopy-historico: un .zip por instrumento en el release «historico», con
// <instrumento>/<AAAA-MM>.csv dentro (mismo formato que scripts/bajar-dukascopy-todo.mjs).
//
//   node scripts/bajar-zips-github.mjs                 todos los zips con algo dentro
//   node scripts/bajar-zips-github.mjs eurusd xauusd   solo esos
//
// No pisa lo que ya está bien en local: un mes se copia solo si aquí falta, o si quedó a medias
// (su CSV se escribió antes de cerrarse el mes) y el del zip es más nuevo; así entra cada día
// el mes en curso. Un zip que no ha cambiado desde la última vez no se vuelve a bajar
// (historico\.zips-github.json). La tarea «Traer Dukascopy de GitHub» lo lanza cada mañana,
// después de la ejecución diaria del workflow (04:30 UTC).
import { execFileSync } from 'child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const REPO = 'Sergiobit96/dukascopy-historico'
const BASE = join(process.env.DUKASCOPY_DIR || 'C:\\Users\\Sergio\\Documents\\Dukascopy', 'historico')
const ESTADO = join(BASE, '.zips-github.json')
const ZIP_VACIO = 1024   // los zips de instrumentos sin nada bajado aún pesan unos bytes

// Mismo criterio que bajar-dukascopy-todo.mjs: hecho si se escribió tras acabar el mes
function finDelMes(mes) {
  const [a, m] = mes.split('-').map(Number)
  return Date.UTC(a, m, 1)
}
const mesHecho = (mtimeMs, mes) => mtimeMs > finDelMes(mes) + 60 * 60_000
const mtime = ruta => { try { return statSync(ruta).mtimeMs } catch { return null } }

const pedidos = process.argv.slice(2).map(s => s.toLowerCase())
let estado = {}
try { estado = JSON.parse(readFileSync(ESTADO, 'utf8')) } catch { /* primera vez */ }

const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/historico`, { headers: { Accept: 'application/vnd.github+json' } })
if (!resp.ok) { console.error(`GitHub contesta ${resp.status} al pedir el release`); process.exit(1) }
const { assets } = await resp.json()

mkdirSync(BASE, { recursive: true })
for (const a of assets) {
  const instrumento = a.name.replace(/\.zip$/, '')
  if (!/^[a-z0-9]+$/.test(instrumento)) continue
  if (pedidos.length && !pedidos.includes(instrumento)) continue
  if (a.size < ZIP_VACIO) { console.log(`${instrumento}: el zip aún está vacío`); continue }
  if (estado[instrumento] === a.updated_at) { console.log(`${instrumento}: sin cambios desde la última vez`); continue }

  // El zip se baja y se abre en una carpeta temporal nueva; de ahí solo se copian los CSV
  // con nombre de mes de ese instrumento.
  const tmp = mkdtempSync(join(tmpdir(), 'zip-dukascopy-'))
  try {
    process.stdout.write(`${instrumento}: bajando ${(a.size / 1048576).toFixed(0)} MB… `)
    const r = await fetch(a.browser_download_url)
    if (!r.ok) throw new Error(`descarga ${r.status}`)
    const zip = join(tmp, 'z.zip')
    writeFileSync(zip, Buffer.from(await r.arrayBuffer()))
    const dentro = join(tmp, 'x')
    mkdirSync(dentro)
    execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dentro])   // el tar de Windows (bsdtar; el GNU de Git Bash no abre .zip) conserva las fechas

    const origen = join(dentro, instrumento)
    const destino = join(BASE, instrumento)
    mkdirSync(destino, { recursive: true })
    let copiados = 0, iguales = 0, vacios = 0
    for (const f of readdirSync(origen)) {
      const mes = f.match(/^(\d{4}-\d{2})\.csv$/)?.[1]
      if (!mes) continue
      const de = join(origen, f), a_ = join(destino, f)
      const tZip = mtime(de), tLocal = mtime(a_)
      if (tLocal != null && mesHecho(tLocal, mes)) { iguales++; continue }   // el local ya vale
      if (tLocal != null && tZip <= tLocal) { iguales++; continue }          // a medias, pero el local es igual o más nuevo
      copyFileSync(de, `${a_}.tmp`)
      utimesSync(`${a_}.tmp`, new Date(), new Date(tZip))        // conserva la fecha: sigue contando como hecho
      renameSync(`${a_}.tmp`, a_)
      if (statSync(a_).size === 0) vacios++
      copiados++
    }
    console.log(`${copiados} meses copiados${vacios ? ` (${vacios} sin velas)` : ''}, ${iguales} ya estaban`)
    estado[instrumento] = a.updated_at
    writeFileSync(ESTADO, JSON.stringify(estado, null, 2))
  } catch (err) {
    console.log(`falla: ${err.message}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
