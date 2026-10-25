// Sube a GitHub los charts de G:\Mi unidad\CHARTS y las capturas de G:\Mi unidad\Trading
// <año>\Trades, a la rama "charts" del repo (no a main, para que Railway no se redespliegue
// cada día). La pestaña Charts de la app los lee de ahí. Lo de CHARTS va a la raíz de la rama
// y cada Trades a "Trading <año>/Trades".
//
// Usa un repo git propio fuera de Drive (CHARTS_GIT) cuyas carpetas de trabajo son las de Drive,
// así no se copia nada ni se escribe nada dentro de Drive. Solo sube lo nuevo o cambiado: lo
// que se borre en Drive se queda en GitHub (nunca se sube un borrado). Hace un commit por
// carpeta (NASDAQ, DAX, Weekly, Trading 2026/Trades...) y empuja después de cada uno, para
// que las subidas grandes vayan por partes.
//
// Uso: node scripts/subir-charts.mjs
// Lo lanza cada día la tarea programada "Subir charts". CHARTS_DIR, TRADES_DIR, CHARTS_GIT y
// CHARTS_RAMA cambian las carpetas, el repo local y la rama (y CHARTS_REMOTO el repo de
// GitHub). Apunta lo que hace en subir-charts.log, en CHARTS_GIT.

import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const RAIZ    = join(dirname(fileURLToPath(import.meta.url)), '..')

const DIR     = process.env.CHARTS_DIR  || 'G:\\Mi unidad\\CHARTS'
// donde están las carpetas Trading <año>, cada una con su Trades
const DRIVE   = process.env.TRADES_DIR  || dirname(DIR)
const GIT_DIR = process.env.CHARTS_GIT  || 'C:\\Users\\Sergio\\Documents\\charts-git'
const RAMA    = process.env.CHARTS_RAMA || 'charts'
const REMOTO  = process.env.CHARTS_REMOTO || 'https://github.com/Sergiobit96/Situational-Analysis.git'

// lo que Drive y Windows dejan en las carpetas y no son charts
const EXCLUIR = ['desktop.ini', '*.db', '~$*', '*.tmp', '.tmp.drive*', '*.lnk']
// para que Vercel no intente construir la rama (no tiene la app, solo imágenes)
const VERCEL_JSON = '{ "git": { "deploymentEnabled": false } }\n'

function apuntar(texto) {
  const linea = `${new Date().toISOString()} ${texto}`
  console.log(linea)
  try { appendFileSync(join(GIT_DIR, 'subir-charts.log'), `${linea}\n`) } catch { /* sin log */ }
}

// `arbol` es la carpeta de trabajo de ese comando: CHARTS para sus carpetas, y la raíz de
// Drive para las Trading <año>/Trades. Las dos van al mismo índice; como solo se añade (nunca
// se sube un borrado), que a cada árbol le falten los archivos del otro no importa.
function git(args, { arbol = DIR, ...opciones } = {}) {
  return execFileSync('git', ['--git-dir', GIT_DIR, '--work-tree', arbol, ...args], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...opciones,
  }).trim()
}

const tieneCommits = () => {
  try { git(['rev-parse', '--verify', '--quiet', 'HEAD']); return true } catch { return false }
}

// La primera vez crea el repo local y, si la rama ya está en GitHub (por ejemplo desde
// otro PC o tras borrar CHARTS_GIT), parte de ella para no rehacer la historia.
function preparar() {
  if (!existsSync(join(GIT_DIR, 'HEAD'))) {
    execFileSync('git', ['init', '--bare', '--quiet', GIT_DIR])
    git(['config', 'core.bare', 'false'])
    git(['config', 'core.autocrlf', 'false'])
    git(['config', 'core.quotepath', 'false'])
    git(['remote', 'add', 'origin', REMOTO])
    git(['symbolic-ref', 'HEAD', `refs/heads/${RAMA}`])
    // el mismo autor que los commits de la app (no hay identidad global de git en este PC)
    for (const clave of ['user.name', 'user.email']) {
      try { git(['config', clave, execFileSync('git', ['-C', RAIZ, 'config', clave], { encoding: 'utf8' }).trim()]) }
      catch { /* sin ella el commit avisará */ }
    }
    apuntar(`repo local creado en ${GIT_DIR}`)
  }
  mkdirSync(join(GIT_DIR, 'info'), { recursive: true })
  writeFileSync(join(GIT_DIR, 'info', 'exclude'), `${EXCLUIR.join('\n')}\n`)

  if (!tieneCommits() && git(['ls-remote', '--heads', 'origin', RAMA])) {
    git(['fetch', '--quiet', 'origin', RAMA])
    git(['reset', '--quiet', 'FETCH_HEAD'])
    apuntar(`partiendo de origin/${RAMA}`)
  }
  // vercel.json va en la rama aunque no esté en CHARTS: se mete directamente en el índice
  if (!git(['ls-files', '--', 'vercel.json'])) {
    const blob = git(['hash-object', '-w', '--stdin'], { input: VERCEL_JSON })
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},vercel.json`])
  }
}

// También sube lo que se quedó sin subir en una vuelta anterior (si falló la red)
function empujar() {
  git(['push', '--quiet', 'origin', `HEAD:refs/heads/${RAMA}`], { timeout: 30 * 60_000 })
}

function main() {
  if (!existsSync(DIR)) { apuntar(`no encuentro ${DIR}`); process.exit(1) }
  preparar()

  // primero lo suelto en la raíz, luego cada carpeta por separado
  const entradas = readdirSync(DIR, { withFileTypes: true })
  // git no deja añadir por su nombre un archivo ignorado (desktop.ini), así que se quitan antes
  const sueltos = entradas.filter(e => e.isFile()).map(e => e.name)
  let ignorados = []
  try { ignorados = git(['check-ignore', '--', ...sueltos]).split('\n') } catch { /* ninguno */ }
  // las capturas de los trades de cada año, en la rama como "Trading <año>/Trades/..."
  const trades = readdirSync(DRIVE, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^Trading \d{4}$/.test(e.name) && existsSync(join(DRIVE, e.name, 'Trades')))
    .map(e => [`${e.name}/Trades`, [`${e.name}/Trades`], DRIVE])
  const grupos = [
    ['raíz', sueltos.filter(n => !ignorados.includes(n)), DIR],
    ...entradas.filter(e => e.isDirectory()).map(e => [e.name, [e.name], DIR]),
    ...trades,
  ].filter(([, rutas]) => rutas.length)

  let subidos = 0
  let fallos  = 0
  for (const [nombre, rutas, arbol] of grupos) {
    try {
      git(['add', '--ignore-removal', '--', ...rutas], { arbol })
      const cambiados = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean)
      if (cambiados.length === 0) continue
      const hoy = new Date().toISOString().slice(0, 10)
      git(['commit', '--quiet', '-m', `Charts ${hoy}: ${nombre} (${cambiados.length} archivos)`])
      empujar()
      subidos += cambiados.length
      apuntar(`${nombre}: ${cambiados.length} archivos subidos`)
    } catch (err) {
      fallos++
      apuntar(`${nombre}: ${String(err.stderr || err.message).trim()}`)
    }
  }
  if (fallos === 0 && tieneCommits()) {
    try { empujar() } catch (err) { fallos++; apuntar(`push: ${String(err.stderr || err.message).trim()}`) }
  }
  if (subidos === 0 && fallos === 0) apuntar('nada nuevo')
  process.exit(fallos ? 1 : 0)
}

main()
