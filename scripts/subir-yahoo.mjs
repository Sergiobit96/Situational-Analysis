// Sube al servidor online las velas de Yahoo que recoger_yahoo.py deja cada mañana en
// Documents\Yahoo (la sesión de contado de los índices, a 1 y 5 min, y las diarias de diario\).
// El servidor las usa en el gráfico de IG para lo que IG no da cuando se acaba su cupo semanal
// de histórico, y la pestaña Estrategias para analizar con ellas. Va
// como último paso de la tarea "Recoger Yahoo 1min", detrás de las dos de Python.
//
// También sube las diarias de Stooq de Documents\Stooq, para comparar con ellas las tortugas,
// después de añadirles los días que les falten (scripts/actualizar-stooq.mjs).
//
// Uso: node scripts/subir-yahoo.mjs
// La clave es BOT_TOKEN de server/.env. YAHOO_DIR, STOOQ_DIR y SERVIDOR cambian las carpetas y el destino.
// Apunta lo que hace en subir-yahoo.log, en la misma carpeta que los CSV.

import { appendFileSync, existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { actualizarStooq } from './actualizar-stooq.mjs'

const RAIZ     = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR      = process.env.YAHOO_DIR || 'C:\\Users\\Sergio\\Documents\\Yahoo'
const STOOQ_DIR = process.env.STOOQ_DIR || 'C:\\Users\\Sergio\\Documents\\Stooq'
const SERVIDOR = process.env.SERVIDOR || 'https://situational-analysis-production.up.railway.app'
// los índices que el servidor sabe leer (INDICE_YAHOO_CSV y DIARIOS_YAHOO en server/velas-yahoo.js)
const INDICES  = ['DAX', 'FTSE', 'SPX', 'NDX', 'DJI', 'RUT', 'N225']
const DIARIOS  = ['N225', 'HSI', 'DAX', 'FTSE', 'SPX', 'NDX', 'DJI', 'RUT', 'IRX']
// los de Stooq (DIARIOS_STOOQ en server/velas-yahoo.js)
const STOOQ    = ['^jp', '^dax', '^uklc', '^sp', '^dow', 'nasdaq']

function apuntar(texto) {
  const linea = `${new Date().toISOString()} ${texto}`
  console.log(linea)
  try { appendFileSync(join(DIR, 'subir-yahoo.log'), `${linea}\n`) } catch { /* sin log */ }
}

function claveBot() {
  const env = readFileSync(join(RAIZ, 'server', '.env'), 'utf8')
  const linea = env.split(/\r?\n/).find(l => l.startsWith('BOT_TOKEN='))
  return linea?.slice('BOT_TOKEN='.length).trim().replace(/^["']|["']$/g, '') ?? ''
}

async function main() {
  const token = claveBot()
  if (!token) { apuntar('falta BOT_TOKEN en server/.env'); process.exit(1) }
  let fallos = 0
  try { await actualizarStooq({ apuntar }) } catch (err) { apuntar(`stooq: ${err.message}`) }
  // [nombre en el log, ruta en el PC, ruta en el servidor]
  const ficheros = [
    ...INDICES.flatMap(indice => ['1min', '5min'].map(intervalo => `${indice}_${intervalo}.csv`)),
    ...DIARIOS.map(id => `diario/${id}_1d.csv`),
  ].map(f => [f, join(DIR, ...f.split('/')), `yahoo/${f}`])
    .concat(STOOQ.map(f => [`stooq/${f}_d.csv`, join(STOOQ_DIR, `${f}_d.csv`), `stooq/${encodeURIComponent(`${f}_d.csv`)}`]))
  for (const [fichero, ruta, destino] of ficheros) {
    if (!existsSync(ruta)) { apuntar(`${fichero}: no está en ${dirname(ruta)}`); continue }
    try {
      const r = await fetch(`${SERVIDOR}/api/${destino}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/csv', 'X-Bot-Token': token },
        body: readFileSync(ruta, 'utf8'),
        signal: AbortSignal.timeout(120_000),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      apuntar(`${fichero}: ${j.velas} velas subidas`)
    } catch (err) {
      fallos++
      apuntar(`${fichero}: ${err.message}`)
    }
  }
  process.exit(fallos ? 1 : 0)
}

main()
