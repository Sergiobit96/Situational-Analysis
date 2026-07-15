// Reparte una imagen "collage" (varios charts de distintos instrumentos apilados en
// vertical, como los que ya pegas a mano) en una imagen independiente por instrumento,
// guardadas con el mismo nombre y carpeta "Separados" que ya usas para 2026.
//
// Uso:
//   node scripts/separar-collage.mjs <ruta-imagen> <fecha DD-M-YY> <INSTRUMENTO1> [INSTRUMENTO2] [...]
//   node scripts/separar-collage.mjs <ruta-imagen> <fecha DD-M-YY> <INSTRUMENTO1> [...] --limites 0,0.35,0.68,1
//
// Por defecto reparte la imagen en tantas franjas horizontales iguales como
// instrumentos se den (de arriba a abajo, en el orden en que los escribas). Si el
// collage no está repartido a partes iguales, pasa --limites con los cortes como
// fracción de la altura total (0 a 1, tantos números como instrumentos + 1).
//
// Ejemplo con la imagen de ejemplo (FTSE arriba, DOW en medio, NASDAQ abajo, 20 de junio):
//   node scripts/separar-collage.mjs "C:\ruta\collage.png" 20-6-26 FTSE DOW NASDAQ

import sharp from 'sharp'
import { mkdirSync, existsSync } from 'fs'
import { join, extname } from 'path'

const PHOTOS_ROOT = process.env.PHOTOS_DIR || 'G:\\Mi unidad'

const MES_NOMBRE = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

function carpetaAnio(anio) {
  // Mismas carpetas que ya lee el servidor en server/index.js (PHOTO_YEARS)
  if (anio === 2022) return 'Trading 2022\\Trades 2022'
  if (anio === 2023) return 'Trading 2023\\DAY'
  return `Trading ${anio}\\Trades`
}

function parseArgs(argv) {
  const limitesIdx = argv.indexOf('--limites')
  let limites = null
  let resto = argv
  if (limitesIdx !== -1) {
    limites = argv[limitesIdx + 1].split(',').map(Number)
    resto = [...argv.slice(0, limitesIdx), ...argv.slice(limitesIdx + 2)]
  }
  const [rutaImagen, fecha, ...instrumentos] = resto
  return { rutaImagen, fecha, instrumentos, limites }
}

async function main() {
  const { rutaImagen, fecha, instrumentos, limites } = parseArgs(process.argv.slice(2))

  if (!rutaImagen || !fecha || instrumentos.length === 0) {
    console.error('Uso: node scripts/separar-collage.mjs <ruta-imagen> <fecha DD-M-YY> <INSTRUMENTO1> [INSTRUMENTO2] [...] [--limites 0,0.33,0.66,1]')
    process.exit(1)
  }

  const m = fecha.match(/^(\d{1,2})-(\d{1,2})-(\d{2})$/)
  if (!m) {
    console.error(`Fecha "${fecha}" no tiene el formato DD-M-YY (ej. 20-6-26)`)
    process.exit(1)
  }
  const [, dia, mesNum, yy] = m
  const anio = 2000 + Number(yy)
  const mesCarpeta = `${Number(mesNum)}-${MES_NOMBRE[Number(mesNum)]}`

  const cortes = limites ?? instrumentos.map((_, i) => i / instrumentos.length).concat([1])
  if (cortes.length !== instrumentos.length + 1) {
    console.error(`--limites debe tener ${instrumentos.length + 1} números (instrumentos + 1), tiene ${cortes.length}`)
    process.exit(1)
  }

  const img = sharp(rutaImagen)
  const { width, height } = await img.metadata()
  if (!width || !height) throw new Error('No se pudo leer el tamaño de la imagen')

  const destino = join(PHOTOS_ROOT, carpetaAnio(anio), mesCarpeta, 'Separados')
  if (!existsSync(destino)) mkdirSync(destino, { recursive: true })

  const ext = extname(rutaImagen) || '.jpg'
  const diaPad = String(dia).padStart(2, '0')

  for (let i = 0; i < instrumentos.length; i++) {
    const top    = Math.round(cortes[i] * height)
    const bottom = Math.round(cortes[i + 1] * height)
    const nombreArchivo = `${diaPad}-${Number(mesNum)}-${yy}_${instrumentos[i].toUpperCase()}${ext}`
    const rutaSalida = join(destino, nombreArchivo)
    await sharp(rutaImagen)
      .extract({ left: 0, top, width, height: bottom - top })
      .toFile(rutaSalida)
    console.log(`✓ ${nombreArchivo}  (franja ${top}px-${bottom}px de ${height}px)`)
  }

  console.log(`\nGuardadas ${instrumentos.length} imágenes en: ${destino}`)
}

main().catch(err => { console.error(err.message); process.exit(1) })
