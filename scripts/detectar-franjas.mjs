// Detecta automáticamente los huecos en blanco (varias filas seguidas casi sin
// contenido) entre secciones de un collage con alturas variables, tipo los de
// 2024/2025 (sin línea divisoria limpia). Da un punto de corte sugerido por cada
// hueco, para luego ajustarlo a mano si hace falta.
//
// Uso: node scripts/detectar-franjas.mjs <archivo> [--min-hueco 30]

import sharp from 'sharp'

async function detectarHuecos(ruta, minHueco) {
  const { data, info } = await sharp(ruta).greyscale().raw().toBuffer({ resolveWithObject: true })
  const { width, height } = info
  const filas = []
  for (let y = 0; y < height; y++) {
    let suma = 0, n = 0
    for (let x = 0; x < width; x += 2) { suma += data[y * width + x]; n++ }
    filas.push(suma / n)
  }
  const huecos = []
  let inicio = -1
  for (let y = 0; y < height; y++) {
    if (filas[y] > 253.5) { if (inicio === -1) inicio = y }
    else { if (inicio !== -1 && y - inicio >= minHueco) huecos.push([inicio, y]); inicio = -1 }
  }
  if (inicio !== -1 && height - inicio >= minHueco) huecos.push([inicio, height])
  return { width, height, huecos }
}

async function main() {
  const args = process.argv.slice(2)
  const minIdx = args.indexOf('--min-hueco')
  const minHueco = minIdx !== -1 ? Number(args[minIdx + 1]) : 30
  const ruta = args.filter(a => a !== String(minHueco))[0]
  if (!ruta) {
    console.error('Uso: node scripts/detectar-franjas.mjs <archivo> [--min-hueco 30]')
    process.exit(1)
  }
  const { width, height, huecos } = await detectarHuecos(ruta, minHueco)
  console.log(`${ruta}  ${width}x${height}`)
  console.log('huecos en blanco (posibles cortes entre secciones):')
  huecos.forEach(([a, b]) => console.log(`  ${a}-${b}  (centro ${Math.round((a + b) / 2)}, largo ${b - a})`))
  console.log('cortes sugeridos:', [0, ...huecos.map(([a, b]) => Math.round((a + b) / 2)), height].join(','))
}

main()
