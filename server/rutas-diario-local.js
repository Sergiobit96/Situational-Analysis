// ── El diario de trading en local: fotos de los trades, charts, Book of Horror y de Glory,
// el diario de operaciones y sus comentarios, el de fortalezas y las revisiones con Claude
// (del día y de un backtest). Casi todo lee y escribe en Google Drive (PHOTOS_DIR).
// Sacado de server/index.js: devuelve lo que usa el resto del servidor.

import { limpiarDiario, totalDiario } from './diario-fortalezas.js'
import { createHash } from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, copyFileSync } from 'fs'
import { join, dirname, relative, resolve, sep, basename, extname } from 'path'
import multer from 'multer'

export function registrarDiarioLocal({ DISK_CACHE_DIR, PRODUCCION, app, claveBot }) {
  // ── Fotos de trades (solo local — lee las carpetas Trading<año> de Google Drive) ──
  const PHOTOS_ROOT = process.env.PHOTOS_DIR || 'G:\\Mi unidad'
  const IMG_EXT      = /\.(jpe?g|png)$/i

  // Cada año guarda las capturas en una carpeta distinta con convenciones distintas. En todos
  // manda la subcarpeta "Separados" (el recorte por instrumento) cuando existe, y la captura
  // del día completo solo entra para los días que aún no se han separado a mano
  const PHOTO_YEARS = [
    { year: 2022, dir: 'Trading 2022\\Trades 2022' },
    { year: 2023, dir: 'Trading 2023\\DAY' },
    { year: 2024, dir: 'Trading 2024\\Trades' },
    { year: 2025, dir: 'Trading 2025\\Trades' },
    { year: 2026, dir: 'Trading 2026\\Trades' },
  ]

  function walkImages(dir, excludeDirNamed) {
    let out = []
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (excludeDirNamed && e.name.toLowerCase() === excludeDirNamed.toLowerCase()) continue
        out = out.concat(walkImages(full, excludeDirNamed))
      } else if (IMG_EXT.test(e.name)) {
        out.push(full)
      }
    }
    return out
  }

  // Las capturas de un año para la pestaña Fotos, contando cada trade una sola vez. Hay tres
  // formas de acabar con el mismo trade dos veces en Drive y las tres se descartan aquí:
  //   · la subcarpeta "collage", que es copia exacta de las capturas del día completo;
  //   · el día completo de un día que ya está recortado por instrumento en "Separados";
  //   · el mismo archivo guardado en dos carpetas: 2023 lo tiene en TODOS y en su mes, y 2025
  //     en "Trades/<mes>" y otra vez en "Trades/2025/<mes>". Se queda el primero que aparece.
  // Esto solo se hacía con 2026, así que 2023, 2024 y 2025 salían repetidos en el catálogo
  // (y con ellos el trade aleatorio, sus filtros y sus recuentos).
  function capturasFotos(dir, year) {
    const todas      = walkImages(dir, 'collage')
    const esSeparada = p => basename(dirname(p)).toLowerCase() === 'separados'
    const fechasSeparadas = new Set(
      todas.filter(esSeparada).map(p => parseFotoInfo({ year, path: p }).fecha).filter(Boolean)
    )

    const vistos = new Set()
    const out    = []
    for (const path of todas) {
      const { fecha, instrumento, numero } = parseFotoInfo({ year, path })
      if (!esSeparada(path) && fecha && fechasSeparadas.has(fecha)) continue
      const clave = fecha ? `${fecha}|${instrumento ?? ''}` : `${year}#${numero}`
      if (vistos.has(clave)) continue
      vistos.add(clave)
      out.push(path)
    }
    return out
  }

  let _photoIndex   = null
  let _photoIndexTs = 0
  function getPhotoIndex() {
    if (_photoIndex && Date.now() - _photoIndexTs < 10 * 60_000) return _photoIndex
    const all = []
    for (const { year, dir } of PHOTO_YEARS) {
      for (const path of capturasFotos(join(PHOTOS_ROOT, dir), year)) all.push({ year, path })
    }
    _photoIndex   = all
    _photoIndexTs = Date.now()
    console.log(`[fotos] índice construido: ${all.length} imágenes`)
    return _photoIndex
  }

  // Erratas conocidas en los nombres de archivo de origen (carpetas "Separados")
  const INSTRUMENTO_ALIAS = { NADSAQ: 'NASDAQ' }

  // Extrae fecha/instrumento del nombre de archivo: "DD-M-YY.ext" o "DD-M-YY_INSTRUMENTO.ext"
  // (2022/2023 usan numeración secuencial sin fecha, ej. "0001.png")
  function parseFotoInfo({ year, path }) {
    const stem = basename(path).replace(/\.[^.]+$/, '')
    const m = stem.match(/^(\d{1,2})-(\d{1,2})-(\d{2})(?:_(.+))?$/)
    if (m) {
      const [, d, mo, yy] = m
      const instrumentoRaw = m[4]?.toUpperCase() ?? null
      const instrumento = instrumentoRaw ? (INSTRUMENTO_ALIAS[instrumentoRaw] ?? instrumentoRaw) : null
      return { year, fecha: `20${yy}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`, instrumento, numero: null }
    }
    return { year, fecha: null, instrumento: null, numero: stem }
  }

  function photoToDTO(pick) {
    const rel  = relative(PHOTOS_ROOT, pick.path)
    const info = parseFotoInfo(pick)
    const anio = info.fecha ? info.fecha.slice(0, 4) : String(pick.year)
    return {
      id: Buffer.from(rel).toString('base64url'),
      ...info,
      // La misma clave que usa Trades comentados: así la pestaña Fotos comparte comentario,
      // etiquetas y revisado con el resto de la app en vez de llevar los suyos aparte.
      clave: claveTrade({ rel, fecha: info.fecha, instrumento: info.instrumento, anio, numero: info.numero }),
    }
  }

  app.get('/api/fotos/aleatoria', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
    try {
      const idx = getPhotoIndex()
      if (idx.length === 0) return res.status(404).json({ error: 'Sin fotos disponibles' })
      const pick = idx[Math.floor(Math.random() * idx.length)]
      res.json({ total: idx.length, ...photoToDTO(pick) })
    } catch (err) {
      console.error('[fotos/aleatoria]', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // Catálogo completo (sin bytes de imagen) para que el cliente filtre por fecha/instrumento/resultado
  app.get('/api/fotos/lista', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
    try {
      const idx = getPhotoIndex()
      res.json({ total: idx.length, fotos: idx.map(photoToDTO) })
    } catch (err) {
      console.error('[fotos/lista]', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  app.get('/api/fotos/archivo', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).end()
    try {
      const rel  = Buffer.from(req.query.id ?? '', 'base64url').toString('utf8')
      const abs  = resolve(join(PHOTOS_ROOT, rel))
      const root = resolve(PHOTOS_ROOT) + sep
      if (!abs.startsWith(root)) return res.status(400).end()
      res.sendFile(abs)
    } catch {
      res.status(400).end()
    }
  })

  // ── Charts (G:\Mi unidad\CHARTS y las Trading <año>\Trades): scripts/subir-charts.mjs los
  // sube cada día a la rama "charts" del repo en GitHub, y de ahí los lee el servidor online.
  // En local, si está la carpeta, se leen directamente de Drive con las mismas rutas que en la
  // rama (CHARTS en la raíz, cada Trades en "Trading <año>/Trades"). Solo lectura: no hay ruta
  // para borrar ni cambiar.
  const CHARTS_DIR  = process.env.CHARTS_DIR  || 'G:\\Mi unidad\\CHARTS'
  const CHARTS_REPO = process.env.CHARTS_REPO || 'Sergiobit96/Situational-Analysis'
  const CHARTS_RAMA = process.env.CHARTS_RAMA || 'charts'
  const CHART_EXT   = /\.(jpe?g|png|webp|gif)$/i
  const TRADES_RUTA = /^Trading \d{4}\/Trades\//

  // en local, dónde está en Drive un chart de la lista
  const chartEnDisco = ruta => TRADES_RUTA.test(ruta)
    ? join(PHOTOS_ROOT, ...ruta.split('/'))
    : join(CHARTS_DIR, ...ruta.split('/'))

  let _charts = null   // { ts, lista: [{ ruta, bytes }], origen }
  async function getCharts() {
    if (_charts && Date.now() - _charts.ts < 10 * 60_000) return _charts
    let lista, origen
    if (!PRODUCCION && existsSync(CHARTS_DIR)) {
      const trades = readdirSync(PHOTOS_ROOT, { withFileTypes: true })
        .filter(e => e.isDirectory() && /^Trading \d{4}$/.test(e.name))
        .map(e => join(PHOTOS_ROOT, e.name, 'Trades'))
      lista = [
        ...walkImages(CHARTS_DIR).map(p => [CHARTS_DIR, p]),
        ...trades.flatMap(dir => walkImages(dir).map(p => [PHOTOS_ROOT, p])),
      ]
        .filter(([, p]) => CHART_EXT.test(p))
        .map(([base, p]) => ({ ruta: relative(base, p).split(sep).join('/'), bytes: statSync(p).size }))
      origen = 'local'
    } else {
      // GITHUB_TOKEN es opcional: sin él GitHub deja 60 consultas por hora, que con la caché sobran
      const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'situational-analysis' }
      if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
      const r = await fetch(`https://api.github.com/repos/${CHARTS_REPO}/git/trees/${CHARTS_RAMA}?recursive=1`,
        { headers, signal: AbortSignal.timeout(30_000) })
      if (!r.ok) throw new Error(`GitHub HTTP ${r.status}`)
      const j = await r.json()
      lista = j.tree.filter(e => e.type === 'blob' && CHART_EXT.test(e.path)).map(e => ({ ruta: e.path, bytes: e.size }))
      origen = 'github'
    }
    lista.sort((a, b) => a.ruta.localeCompare(b.ruta, 'es', { numeric: true }))
    _charts = { ts: Date.now(), lista, origen }
    return _charts
  }

  app.get('/api/charts/lista', async (_req, res) => {
    try {
      const { lista, origen, ts } = await getCharts()
      res.json({ total: lista.length, origen, actualizado: ts, charts: lista })
    } catch (err) {
      console.error('[charts/lista]', err.message)
      res.status(502).json({ error: `No se pudo leer la lista de charts: ${err.message}` })
    }
  })

  app.get('/api/charts/archivo', async (req, res) => {
    try {
      const ruta = String(req.query.ruta ?? '')
      if (!ruta || !CHART_EXT.test(ruta) || ruta.split('/').some(t => t === '..' || t === '')) return res.status(400).end()
      const { lista, origen } = await getCharts()
      if (!lista.some(c => c.ruta === ruta)) return res.status(404).end()
      if (origen === 'local') return res.sendFile(resolve(chartEnDisco(ruta)))
      const url = `https://raw.githubusercontent.com/${CHARTS_REPO}/${CHARTS_RAMA}/${ruta.split('/').map(encodeURIComponent).join('/')}`
      res.set('Cache-Control', 'public, max-age=86400').redirect(302, url)
    } catch (err) {
      console.error('[charts/archivo]', err.message)
      res.status(502).end()
    }
  })

  // ── Books de trades (solo local): el Book of Horror de los errores y el Book of Glory
  // de los trades bien hechos. Los dos son la misma carpeta de archivos sueltos y comparten
  // endpoints; ?book= elige cuál, y sin parámetro se entiende el de Horror.
  const HORROR_DIR     = process.env.HORROR_DIR || join(PHOTOS_ROOT, 'Book of Horror')
  const GLORY_DIR      = process.env.GLORY_DIR  || join(PHOTOS_ROOT, 'Book of Glory')
  const HORROR_IMG_EXT = /\.(jpe?g|png|gif|webp)$/i
  const PAPELERA       = 'papelera'

  const BOOKS = {
    horror: { id: 'horror', nombre: 'Book of Horror', dir: HORROR_DIR },
    glory:  { id: 'glory',  nombre: 'Book of Glory',  dir: GLORY_DIR },
  }

  function bookDe(req) {
    return BOOKS[String(req.query.book ?? 'horror').toLowerCase()] ?? null
  }

  // De qué trade del archivo es un archivo del book, para poder mostrar su comentario. No basta
  // con la convención de nombres: al book se han ido copiando capturas con el nombre puesto a
  // mano ("Gold_11-8-2026.jpg" es el GOLD del 11-8-26), así que si el nombre lleva la fecha y el
  // instrumento se busca el trade que cuadre, en el orden que sea y con el año de 2 o 4 cifras.
  // Devuelve null solo cuando de verdad no hay un trade del archivo detrás.
  function claveDesdeNombre(nombre) {
    const stem   = basename(nombre).replace(/\.[^.]+$/, '')
    const claves = clavesDelArchivo()

    // 1) convención del archivo: DD-M-YY[_INSTRUMENTO]. El nombre ya identifica el trade,
    // así que vale aunque no haya captura suya en Separados: puede ser el gráfico que la app
    // guardó desde Operaciones para un día que todavía no se ha exportado.
    const { fecha, instrumento } = parseFotoInfo({ year: null, path: nombre })
    if (fecha) return claveTrade({ rel: nombre, fecha, instrumento })

    // 2) numeradas de 2022-2023, que la propia app copia como AAAA_NNNN
    const num = stem.match(/^(\d{4})_(\d+)$/)
    if (num) return `${num[1]}#${num[2]}`

    // 3) nombre puesto a mano: la fecha en cualquier posición y el instrumento suelto
    const m = stem.match(/(\d{1,2})[-_. ](\d{1,2})[-_. ](\d{4}|\d{2})(?!\d)/)
    if (m) {
      const [, d, mo, y] = m
      const dia        = `${y.length === 4 ? y : `20${y}`}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
      const enMayuscula = stem.toUpperCase()
      const candidatas = [...claves].filter(c => c.startsWith(`${dia}_`))
      const acertada   = candidatas.find(c => {
        const inst = c.slice(dia.length + 1)
        return inst && enMayuscula.includes(inst)
      })
      if (acertada) return acertada
      // un solo trade ese día: no hay con qué confundirlo aunque el nombre no diga el instrumento
      if (candidatas.length === 1) return candidatas[0]
    }

    return null
  }

  // Qué trades están ya en cada book, para que el botón de un clic aparezca marcado
  function clavesEnBooks() {
    const mapa = {}
    for (const [id, book] of Object.entries(BOOKS)) {
      const claves = new Set()
      try {
        for (const e of readdirSync(book.dir, { withFileTypes: true })) {
          if (!e.isFile()) continue
          const clave = claveDesdeNombre(e.name)
          if (clave) claves.add(clave)
        }
      } catch { /* ese book todavía no existe */ }
      mapa[id] = claves
    }
    return mapa
  }

  const bookUpload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        const book = bookDe(req)
        if (!book) return cb(new Error('Book desconocido'))
        try { mkdirSync(book.dir, { recursive: true }); cb(null, book.dir) }
        catch (err) { cb(err) }
      },
      filename: (req, file, cb) => {
        const book = bookDe(req)
        if (!book) return cb(new Error('Book desconocido'))
        // basename ya descarta cualquier componente de ruta del nombre original
        const limpio = basename(file.originalname).replace(/[<>:"/|?*]/g, '_').trim() || 'archivo'
        cb(null, existsSync(join(book.dir, limpio)) ? `${Date.now()}_${limpio}` : limpio)
      },
    }),
    limits: { fileSize: 200 * 1024 * 1024, files: 20 },
  }).array('archivos', 20)

  app.post('/api/books/subir', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
    if (!bookDe(req)) return res.status(400).json({ error: 'Book desconocido' })
    bookUpload(req, res, err => {
      if (err) {
        console.error('[books/subir]', err.message)
        return res.status(400).json({ error: err.message })
      }
      res.json({ subidos: (req.files ?? []).map(f => f.filename) })
    })
  })

  app.get('/api/books/lista', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
    const book = bookDe(req)
    if (!book) return res.status(400).json({ error: 'Book desconocido' })
    try {
      mkdirSync(book.dir, { recursive: true })
      const comentarios = leerComentariosTrades()
      const archivos = readdirSync(book.dir, { withFileTypes: true })
        .filter(e => e.isFile())
        .map(e => {
          const { size, mtimeMs } = statSync(join(book.dir, e.name))
          const clave = claveDesdeNombre(e.name)
          return {
            id:         Buffer.from(e.name).toString('base64url'),
            nombre:     e.name,
            bytes:      size,
            modificado: mtimeMs,
            esImagen:   HORROR_IMG_EXT.test(e.name),
            // comentario y etiquetas son los del trade, los mismos de Trades comentados
            clave,
            comentario: clave ? anotacionDe(comentarios, clave).texto : '',
            cats:       clave ? anotacionDe(comentarios, clave).cats  : [],
          }
        })
        .sort((a, b) => b.modificado - a.modificado)
      res.json({ book: book.id, nombre: book.nombre, carpeta: book.dir, total: archivos.length, archivos })
    } catch (err) {
      console.error('[books/lista]', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // La captura que se manda a un book. Normalmente es un trade del archivo, pero desde
  // Operaciones se manda la que se está mirando, que puede ser la del día completo (sin
  // recorte por instrumento) y por tanto no estar en el archivo de trades comentados: en ese
  // caso vale con que sea una foto del catálogo, el mismo que alimenta la pestaña Fotos.
  function capturaParaBook(rel) {
    const delArchivo = getTradesIndex().find(c => relative(PHOTOS_ROOT, c.path) === rel)
    if (delArchivo) return delArchivo
    const delCatalogo = getPhotoIndex().find(p => relative(PHOTOS_ROOT, p.path) === rel)
    return delCatalogo ? { path: delCatalogo.path, year: delCatalogo.year, mesCarpeta: null } : null
  }

  // Añadir a un book con un solo clic desde Trades comentados: se copia la captura, la
  // original se queda donde estaba. El nombre conserva la identidad del trade para que el
  // book pueda mostrar su comentario.
  app.post('/api/books/copiar', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
    const book = bookDe(req)
    if (!book) return res.status(400).json({ error: 'Book desconocido' })
    try {
      const rel     = Buffer.from(String(req.query.id ?? ''), 'base64url').toString('utf8')
      const captura = capturaParaBook(rel)
      if (!captura) return res.status(404).json({ error: 'Esa captura no está en las carpetas de trading' })

      const comentarios = leerComentariosTrades()
      const trade  = tradeDTO(captura, comentarios, clavesEnBooks())
      const nombre = trade.fecha ? trade.nombre : `${trade.anio}_${trade.numero}${extname(trade.nombre)}`
      mkdirSync(book.dir, { recursive: true })
      const destino  = join(book.dir, nombre)
      const yaEstaba = existsSync(destino)
      if (!yaEstaba) copyFileSync(captura.path, destino)

      res.json({
        book:   book.id,
        nombre: book.nombre,
        archivo: nombre,
        yaEstaba,
        trade:  tradeDTO(captura, comentarios, clavesEnBooks()),
      })
    } catch (err) {
      console.error('[books/copiar]', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // Nombre de archivo para un trade, en la convención del archivo de capturas, para que el
  // book pueda seguir sabiendo de qué trade es: '2026-09-25_SILVER' -> '25-9-26_SILVER.png'
  // y '2023#0408' -> '2023_0408.png'.
  function nombreDesdeClave(clave) {
    const numerado = clave.match(/^(\d{4})#(\d+)$/)
    if (numerado) return `${numerado[1]}_${numerado[2]}.png`
    const m = clave.match(/^(\d{4})-(\d{2})-(\d{2})_(.*)$/)
    if (!m) return null
    const [, anio, mes, dia, instrumento] = m
    const base = `${dia}-${Number(mes)}-${anio.slice(2)}`
    return instrumento ? `${base}_${instrumento}.png` : `${base}.png`
  }

  // Mandar un trade al book cuando no hay captura suya en Drive: se guarda el gráfico que
  // pinta la propia app, con marcas de entrada y salida incluidas.
  app.post('/api/books/grafico', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
    const book = bookDe(req)
    if (!book) return res.status(400).json({ error: 'Book desconocido' })
    try {
      const clave  = String(req.query.clave ?? '').trim()
      const nombre = clave && clave.length <= 100 ? nombreDesdeClave(clave) : null
      if (!nombre) return res.status(400).json({ error: 'Clave de trade no válida' })

      const m = String(req.body?.imagen ?? '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/)
      if (!m) return res.status(400).json({ error: 'La imagen no llegó en PNG' })
      const bytes = Buffer.from(m[1], 'base64')
      if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) {
        return res.status(400).json({ error: 'Imagen vacía o demasiado grande' })
      }

      mkdirSync(book.dir, { recursive: true })
      const destino  = join(book.dir, nombre)
      const yaEstaba = existsSync(destino)
      if (!yaEstaba) writeFileSync(destino, bytes)
      res.json({ book: book.id, nombre: book.nombre, archivo: nombre, yaEstaba, clave })
    } catch (err) {
      console.error('[books/grafico]', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // Borrado: el archivo no se elimina, se mueve a la subcarpeta "papelera" para poder
  // recuperarlo a mano si el clic fue un accidente
  app.delete('/api/books/archivo', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
    const book = bookDe(req)
    if (!book) return res.status(400).json({ error: 'Book desconocido' })
    try {
      const nombre = Buffer.from(req.query.id ?? '', 'base64url').toString('utf8')
      const abs    = resolve(join(book.dir, nombre))
      if (dirname(abs) !== resolve(book.dir)) return res.status(400).json({ error: 'Ruta no permitida' })
      if (!existsSync(abs)) return res.status(404).json({ error: 'El archivo ya no existe' })

      const papelera = join(book.dir, PAPELERA)
      mkdirSync(papelera, { recursive: true })
      const destino = join(papelera, existsSync(join(papelera, nombre)) ? `${Date.now()}_${nombre}` : nombre)
      renameSync(abs, destino)
      res.json({ borrado: nombre, papelera: destino })
    } catch (err) {
      console.error('[books/borrar]', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // Renombrar: si el nombre nuevo llega sin extensión se conserva la del original
  app.patch('/api/books/archivo', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
    const book = bookDe(req)
    if (!book) return res.status(400).json({ error: 'Book desconocido' })
    try {
      const nombre = Buffer.from(req.query.id ?? '', 'base64url').toString('utf8')
      const abs    = resolve(join(book.dir, nombre))
      if (dirname(abs) !== resolve(book.dir)) return res.status(400).json({ error: 'Ruta no permitida' })
      if (!existsSync(abs)) return res.status(404).json({ error: 'El archivo ya no existe' })

      let limpio = basename(String(req.body?.nombre ?? '')).replace(/[<>:"/\\|?*]/g, '_').trim()
      if (!limpio || limpio === '.' || limpio === '..') return res.status(400).json({ error: 'Nombre no válido' })
      const ext = extname(nombre)
      if (ext && !extname(limpio)) limpio += ext

      const destino = resolve(join(book.dir, limpio))
      if (dirname(destino) !== resolve(book.dir)) return res.status(400).json({ error: 'Ruta no permitida' })
      if (destino === abs) return res.json({ nombre: limpio, id: Buffer.from(limpio).toString('base64url') })
      // en Windows el disco no distingue mayúsculas: cambiar solo la caja no es una colisión
      if (destino.toLowerCase() !== abs.toLowerCase() && existsSync(destino)) {
        return res.status(409).json({ error: `Ya existe un archivo llamado "${limpio}"` })
      }

      renameSync(abs, destino)
      // el nombre nuevo puede apuntar a otro trade (o a ninguno): se devuelve la anotación
      // que le corresponde ahora, para que la tarjeta no siga enseñando la anterior
      const clave     = claveDesdeNombre(limpio)
      const anotacion = clave ? anotacionDe(leerComentariosTrades(), clave) : null
      res.json({
        nombre:     limpio,
        id:         Buffer.from(limpio).toString('base64url'),
        clave,
        comentario: anotacion?.texto ?? '',
        cats:       anotacion?.cats ?? [],
      })
    } catch (err) {
      console.error('[books/renombrar]', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  app.get('/api/books/archivo', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).end()
    const book = bookDe(req)
    if (!book) return res.status(400).end()
    try {
      const nombre = Buffer.from(req.query.id ?? '', 'base64url').toString('utf8')
      const abs    = resolve(join(book.dir, nombre))
      if (dirname(abs) !== resolve(book.dir)) return res.status(400).end()
      if (req.query.descargar === '1') return res.download(abs)
      res.sendFile(abs)
    } catch {
      res.status(400).end()
    }
  })

  // ── Trades comentados: las capturas que ya están en Drive (solo local) ──
  // Aquí no se sube nada: se recorre el archivo de cada año y a cada trade se le engancha un
  // comentario. Los comentarios viven en su propio JSON junto a las fotos, así que respaldar
  // la carpeta de Drive respalda también lo escrito.
  const TRADES_COMENTARIOS_PATH = process.env.TRADES_COMENTARIOS || join(PHOTOS_ROOT, 'Comentarios trades.json')

  function leerComentariosTrades() {
    try {
      const data = JSON.parse(readFileSync(TRADES_COMENTARIOS_PATH, 'utf8'))
      return data?.comentarios && typeof data.comentarios === 'object' ? data.comentarios : {}
    } catch {
      return {}   // todavía no existe, o quedó ilegible: se parte de cero
    }
  }

  // Escritura atómica (tmp + rename): un corte a medias dejaría todos los comentarios
  // en un JSON truncado. Las capturas no se tocan nunca.
  function guardarComentariosTrades(comentarios) {
    const tmp = `${TRADES_COMENTARIOS_PATH}.tmp`
    writeFileSync(tmp, JSON.stringify({ comentarios }, null, 2))
    renameSync(tmp, TRADES_COMENTARIOS_PATH)
  }

  // ── El diario de operaciones (solo local) ──
  // Hasta ahora las operaciones vivían solo en localStorage del navegador: limpiar los datos
  // del sitio, o cambiar de navegador, era perderlas. Aquí se guardan junto a los comentarios,
  // con la misma escritura atómica (fichero temporal y rename) para que un corte a media
  // escritura no deje el JSON a medias. El navegador sigue teniendo su copia como caché.
  const TRADES_PATH = process.env.TRADES_DIARIO || join(PHOTOS_ROOT, 'Diario operaciones.json')

  function leerTradesDiario() {
    try {
      const d = JSON.parse(readFileSync(TRADES_PATH, 'utf8'))
      return Array.isArray(d?.trades) ? d.trades : []
    } catch { return [] }
  }

  app.get('/api/trades', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
    try {
      const trades = leerTradesDiario()
      res.json({ archivo: TRADES_PATH, total: trades.length, trades })
    } catch (err) {
      console.error('[trades]', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  app.put('/api/trades', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
    try {
      const trades = req.body?.trades
      if (!Array.isArray(trades)) return res.status(400).json({ error: 'Se esperaba { trades: [...] }' })
      // Una lista vacía casi siempre es un error del cliente (un render antes de cargar), y
      // sobreescribiría años de diario: se rechaza salvo que se pida vaciar a propósito.
      const previas = leerTradesDiario()
      if (trades.length === 0 && previas.length > 0 && req.query.vaciar !== '1') {
        return res.status(409).json({ error: `Hay ${previas.length} operaciones guardadas; para borrarlas, vaciar=1` })
      }
      const tmp = `${TRADES_PATH}.tmp`
      writeFileSync(tmp, JSON.stringify({ actualizado: Date.now(), trades }))
      renameSync(tmp, TRADES_PATH)
      res.json({ archivo: TRADES_PATH, total: trades.length })
    } catch (err) {
      console.error('[trades]', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // ── Diario de fortalezas y debilidades (pestaña Diario, solo local) ──
  // Como el de operaciones: vivía solo en el navegador y limpiar los datos del sitio lo
  // borraba. Ahora va a un JSON en Drive y el navegador se queda la copia como caché.
  const DIARIO_FD_PATH = process.env.DIARIO_FORTALEZAS || join(PHOTOS_ROOT, 'Diario fortalezas.json')

  function leerDiarioFd() {
    try { return limpiarDiario(JSON.parse(readFileSync(DIARIO_FD_PATH, 'utf8'))) }
    catch { return { fortalezas: [], debilidades: [] } }
  }

  app.get('/api/diario-fortalezas', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
    res.json({ archivo: DIARIO_FD_PATH, ...leerDiarioFd() })
  })

  app.put('/api/diario-fortalezas', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
    try {
      let diario
      try { diario = limpiarDiario(req.body) } catch (err) { return res.status(400).json({ error: err.message }) }
      // Vaciarlo entero casi siempre es un cliente que aún no había cargado: se rechaza salvo
      // que se pida a propósito (al borrar la última entrada)
      const previas = totalDiario(leerDiarioFd())
      if (totalDiario(diario) === 0 && previas > 0 && req.query.vaciar !== '1') {
        return res.status(409).json({ error: `Hay ${previas} entradas guardadas; para borrarlas todas, vaciar=1` })
      }
      const tmp = `${DIARIO_FD_PATH}.tmp`
      writeFileSync(tmp, JSON.stringify({ actualizado: Date.now(), ...diario }, null, 2))
      renameSync(tmp, DIARIO_FD_PATH)
      res.json({ archivo: DIARIO_FD_PATH, total: totalDiario(diario) })
    } catch (err) {
      console.error('[diario-fortalezas]', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // ── Revisión del día con Claude (solo local) ──
  // El navegador arma el expediente del día (expedienteDelDia en src/estadisticas.js: las
  // operaciones con su MFE/MAE, los comentarios, las etiquetas del Book of Horror y lo
  // habitual del historial) y aquí solo se le pasa a Claude y se guarda lo que escribe, para no
  // pagar dos veces la misma revisión. La clave va en ANTHROPIC_API_KEY de server/.env.
  const REVISIONES_PATH = process.env.REVISIONES_DIA || join(PHOTOS_ROOT, 'Revisiones dia.json')
  const MODELO_REVISION = 'claude-opus-5-5'

  // $ por millón de tokens (entrada, salida), para enseñar lo que costó cada revisión. La de
  // respaldo solo entra si Claude Opus 5.5 rechaza la petición.
  const PRECIO_POR_MTOK = { 'claude-opus-5-5': [4, 20], 'claude-opus-4-8': [5, 25] }

  const PROMPT_REVISION = `Eres quien revisa el diario de un trader discrecional de CFD de índices (DAX, FTSE, Dow, Nasdaq, S&P) y metales, que opera en TradeNation desde Madrid. Te paso el expediente de un día: sus operaciones con la hora de entrada y de salida (hora de Madrid), el resultado en puntos y en euros, el MFE y el MAE de cada una (lo más que llegó a ir ganando y perdiendo mientras estuvo abierta, en puntos), sus comentarios, los errores de proceso que él mismo etiquetó (las categorías de su "Book of Horror") y sus cifras habituales de todo el historial.

Escribe una revisión breve del día, en español y de tú, para leerla al acabar la sesión:
- Juzga el proceso, no el resultado: un día en verde puede estar mal operado y uno en rojo bien operado.
- Compara con lo habitual solo cuando la diferencia sea clara, y da la cifra.
- Cita las operaciones por instrumento y hora.
- No inventes nada que no esté en el expediente. Si falta algo para opinar (por ejemplo, no hay comentarios), dilo en una línea.
- El MFE y el MAE salen de otra fuente de precios y tienen 1-3 puntos de margen, más si vienen de Yahoo: no saques conclusiones de diferencias menores que eso.

Texto plano, sin títulos ni negritas, en cuatro bloques cortos separados por una línea en blanco: qué pasó; qué fue distinto de lo habitual; lo mejor y lo peor del proceso, con la operación concreta; y una sola cosa a vigilar en la próxima sesión. Como mucho 220 palabras.`

  let clienteClaude = null
  // Se crea al primer uso: sin clave, el constructor lanza, y el resto del servidor no la necesita
  const claude = () => (clienteClaude ??= new Anthropic())

  // Lo que escribe Claude con un prompt y un expediente, con el modelo que contestó y lo que
  // costó. Si la rechaza o llega cortada, lanza un ErrorRevision con el mensaje para la pantalla.
  class ErrorRevision extends Error {}

  async function escribirRevision(system, contenido) {
    const respuesta = await claude().beta.messages.create({
      model: MODELO_REVISION,
      max_tokens: 16000,
      // el pensamiento adaptativo va siempre activo en este modelo; el esfuerzo por defecto es
      // medium, y para juzgar operaciones compensa uno más
      output_config: { effort: 'high' },
      // si Claude Opus 5.5 rechaza la petición, la repite Claude Opus 4.8 en la misma llamada
      betas: ['server-side-fallback-2026-06-01'],
      fallbacks: [{ model: 'claude-opus-4-8' }],
      system,
      messages: [{ role: 'user', content: contenido }],
    })

    if (respuesta.stop_reason === 'refusal') throw new ErrorRevision('Claude no ha querido hacer esta revisión')
    const texto = respuesta.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
    if (!texto || respuesta.stop_reason === 'max_tokens') throw new ErrorRevision('La revisión llegó vacía o cortada; prueba otra vez')

    const { input_tokens: entrada = 0, output_tokens: salida = 0 } = respuesta.usage ?? {}
    const [pe, ps] = PRECIO_POR_MTOK[respuesta.model] ?? PRECIO_POR_MTOK[MODELO_REVISION]
    return {
      texto,
      modelo: respuesta.model,
      generada: new Date().toISOString(),
      tokens: { entrada, salida },
      usd: Math.round((entrada * pe + salida * ps) / 1e6 * 10000) / 10000,
    }
  }

  function responderErrorRevision(res, err, etiqueta) {
    console.error(`[${etiqueta}]`, err.message)
    if (err instanceof ErrorRevision) return res.status(502).json({ error: err.message })
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(401).json({ error: 'La clave de Anthropic de server/.env no es válida' })
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Anthropic está limitando las peticiones; prueba en un minuto' })
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return res.status(502).json({ error: 'No se pudo conectar con Anthropic' })
    }
    if (err instanceof Anthropic.APIError) {
      return res.status(502).json({ error: `Anthropic respondió ${err.status}: ${err.message}` })
    }
    // sin ANTHROPIC_API_KEY el SDK lanza al crear el cliente
    res.status(500).json({ error: process.env.ANTHROPIC_API_KEY ? err.message : 'Falta ANTHROPIC_API_KEY en server/.env' })
  }

  function leerRevisiones(ruta) {
    try {
      const d = JSON.parse(readFileSync(ruta, 'utf8'))
      return d?.revisiones && typeof d.revisiones === 'object' ? d.revisiones : {}
    } catch {
      return {}
    }
  }

  function guardarRevision(ruta, clave, revision) {
    const revisiones = { ...leerRevisiones(ruta), [clave]: revision }
    const tmp = `${ruta}.tmp`
    writeFileSync(tmp, JSON.stringify({ revisiones }, null, 2))
    renameSync(tmp, ruta)
  }

  const FECHA_VALIDA = /^\d{4}-\d{2}-\d{2}$/

  app.get('/api/revision-dia', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
    const fecha = String(req.query.fecha ?? '')
    if (!FECHA_VALIDA.test(fecha)) return res.status(400).json({ error: 'fecha con formato AAAA-MM-DD' })
    res.json({ revision: leerRevisiones(REVISIONES_PATH)[fecha] ?? null })
  })

  app.post('/api/revision-dia', async (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
    const { fecha, expediente } = req.body ?? {}
    if (!FECHA_VALIDA.test(String(fecha ?? ''))) return res.status(400).json({ error: 'fecha con formato AAAA-MM-DD' })
    if (!expediente || !Array.isArray(expediente.operaciones) || expediente.operaciones.length === 0) {
      return res.status(400).json({ error: 'Ese día no tiene operaciones que revisar' })
    }

    try {
      const revision = await escribirRevision(PROMPT_REVISION, `Expediente del día:\n\n${JSON.stringify(expediente, null, 2)}`)
      guardarRevision(REVISIONES_PATH, fecha, revision)
      res.json({ revision })
    } catch (err) {
      responderErrorRevision(res, err, 'revision-dia')
    }
  })

  // ── Revisión de un backtest con Claude ──
  // Como la del día: el navegador arma el expediente (expedienteBacktest en src/tortugas.js) y
  // aquí se le pasa a Claude y se guarda. Cada revisión va con los ajustes del backtest (la
  // `clave` de la pestaña, que aquí se resume en un hash), así que al volver a esos ajustes sale
  // la que ya se pagó, aunque desde entonces haya más sesiones (la pestaña lo avisa).
  // En producción va con la clave del bot, para que nadie más gaste la de Anthropic, y las
  // revisiones se guardan en el volumen de Railway.
  const REVISIONES_BACKTEST_PATH = process.env.REVISIONES_BACKTEST
    || (PRODUCCION ? join(existsSync('/data') ? '/data' : DISK_CACHE_DIR, 'revisiones-backtest.json') : join(PHOTOS_ROOT, 'Revisiones backtest.json'))

  const PROMPT_REVISION_BACKTEST = `Eres quien revisa los backtests de un trader que opera CFD desde Madrid con IG y quiere llevar a un bot el sistema de las tortugas de Richard Dennis, adaptado: velas diarias, rupturas de 20 o 55 sesiones (sistema 1, sistema 2 o los dos juntos), unidades del tamaño con el que 1 N (el ATR de Wilder de 20 sesiones) cuesta un % fijo del capital, una unidad más cada ½ N a favor hasta un máximo, stop común a 2 N de la última, salida en el canal contrario de 10 o 20 sesiones, límites de unidades por grupo y por sentido, y con financiación overnight, spread y deslizamiento. Te paso el expediente de un backtest: los ajustes, el resultado, la rentabilidad de cada año, las peores caídas, las dos mitades del periodo, cuánto del resultado sale de las mejores operaciones, el desglose por mercado (o por sector y acción), por pirámide, por lado y por motivo de salida, a veces las variantes cercanas de ajustes y las limitaciones de los datos.

Tu trabajo es decir si el resultado es sólido o frágil, no optimizarlo. Escribe en español y de tú:
- Busca de qué depende el resultado: pocas operaciones, unos pocos años, un mercado o grupo, un lado, las pirámides completas. Da las cifras.
- Compara las dos mitades del periodo. Si hay variantes, mira si la de arriba gana por poco a las cercanas (señal de ajuste a la historia) o si el resultado aguanta en todas.
- Juzga el riesgo: la peor caída, cuánto tiempo bajo el máximo, el apalancamiento, y si un particular aguantaría operarlo así. Compara con comprar y mantener de cada mercado cuando ayude.
- Mira cuánto se comen la financiación, las comisiones y el deslizamiento.
- Ten en cuenta las limitaciones de los datos que vienen en el expediente; menciona solo las que cambien la conclusión.
- No inventes nada que no esté en el expediente. Los € por mercado, lado o pirámide llevan el interés compuesto, así que pesan más los años recientes; para comparar, usa los % del capital cuando los haya.

Texto plano, sin títulos ni negritas, en cinco bloques cortos separados por una línea en blanco: el veredicto en dos frases con las cifras clave; de dónde sale el resultado; lo que lo hace frágil; el riesgo de operarlo; y una o dos pruebas concretas para hacer en la pestaña (cambiar un ajuste, quitar un mercado, mover el año de inicio...) que confirmarían o desmontarían la conclusión. Como mucho 350 palabras.`

  // Las estrategias intradía de la pestaña (SRS, Rule of 4, primera vela de 1 h, first bar
  // negative) van por el mismo camino, con su propio prompt: el `tipo` lo elige.
  const PROMPT_REVISION_INTRADIA = `Eres quien revisa los backtests intradía de un trader que opera CFD de índices desde Madrid con IG y quiere llevar a un bot alguna de estas estrategias de rotura: el máximo y el mínimo de una vela concreta de la sesión (la segunda de 15 min, la primera hora, la primera de 5 min, la cuarta de 10 min tras el FOMC) forman un bracket, se entra en la primera rotura con el stop al otro lado (o a mitad de la vela), a veces con vuelta de la posición al saltar el stop, break even, pirámide u objetivo, y lo que sigue abierto se cierra con la sesión. Te paso el expediente de un backtest: la estrategia, las sesiones analizadas, los ajustes, el resultado en puntos del instrumento y en R (el riesgo inicial de cada día), el año a año, las dos mitades del periodo, el drawdown, la concentración en las mejores sesiones, el desglose por lado, por salida, por pirámide y por día de la semana, la robustez con los otros stops y volúmenes en las mismas sesiones y las limitaciones de los datos.

Tu trabajo es decir si la ventaja es sólida o frágil, no optimizarla. Escribe en español y de tú:
- Mira primero cuántas operaciones hay: con pocas, dilo y no saques conclusiones fuertes.
- Busca de qué depende el resultado: unas pocas sesiones, un año, un lado, un día de la semana, las pirámides. Da las cifras.
- Compara las dos mitades y el año a año. Mira si la configuración puesta gana por poco a las otras combinaciones de stop y volumen (señal de ajuste a la historia) o si el resultado aguanta en todas.
- Si se filtran sesiones (color de la primera vela, apertura respecto a ayer, días de la semana), recuerda que cada filtro reduce la muestra y suma riesgo de casualidad.
- Juzga si el resultado medio por operación aguanta el spread y el deslizamiento reales de un CFD de índice si los costes del expediente están a cero, y cuánta racha perdedora y drawdown habría que aguantar.
- No inventes nada que no esté en el expediente.

Texto plano, sin títulos ni negritas, en cinco bloques cortos separados por una línea en blanco: el veredicto en dos frases con las cifras clave; de dónde sale el resultado; lo que lo hace frágil; lo que costaría operarlo (costes, rachas, drawdown); y una o dos pruebas concretas para hacer en la pestaña (cambiar un ajuste, otro instrumento, otro periodo, poner costes...) que confirmarían o desmontarían la conclusión. Como mucho 350 palabras.`

  const PROMPTS_BACKTEST = {
    tortugas: [PROMPT_REVISION_BACKTEST, 'Expediente del backtest'],
    intradia: [PROMPT_REVISION_INTRADIA, 'Expediente del backtest intradía'],
  }

  const MAX_CLAVE_BACKTEST = 20_000
  // las de las tortugas conservan el id de antes de que hubiera tipos
  const idBacktest = (clave, tipo = 'tortugas') =>
    createHash('sha256').update(tipo === 'tortugas' ? clave : `${tipo}|${clave}`).digest('hex').slice(0, 16)

  app.get('/api/revision-backtest', claveBot.middleware, (req, res) => {
    const clave = String(req.query.clave ?? '')
    const tipo = String(req.query.tipo ?? 'tortugas')
    if (!clave || clave.length > MAX_CLAVE_BACKTEST) return res.status(400).json({ error: 'falta la clave del backtest' })
    if (!Object.hasOwn(PROMPTS_BACKTEST, tipo)) return res.status(400).json({ error: 'tipo de backtest desconocido' })
    res.json({ revision: leerRevisiones(REVISIONES_BACKTEST_PATH)[idBacktest(clave, tipo)] ?? null })
  })

  app.post('/api/revision-backtest', claveBot.middleware, async (req, res) => {
    const { clave, expediente, tipo = 'tortugas' } = req.body ?? {}
    if (typeof clave !== 'string' || !clave || clave.length > MAX_CLAVE_BACKTEST) {
      return res.status(400).json({ error: 'falta la clave del backtest' })
    }
    if (!Object.hasOwn(PROMPTS_BACKTEST, tipo)) return res.status(400).json({ error: 'tipo de backtest desconocido' })
    if (!expediente?.resultado || !expediente.periodo?.hasta) {
      return res.status(400).json({ error: 'El backtest no tiene resultado que revisar' })
    }

    try {
      const revision = {
        ...await escribirRevision(PROMPTS_BACKTEST[tipo][0], `${PROMPTS_BACKTEST[tipo][1]}:\n\n${JSON.stringify(expediente, null, 2)}`),
        // para que el JSON se pueda leer a mano, y para avisar cuando el backtest tenga más sesiones
        universo: expediente.universo,
        configuracion: expediente.configuracion,
        datosHasta: expediente.periodo.hasta,
        conVariantes: Array.isArray(expediente.variantes),
      }
      guardarRevision(REVISIONES_BACKTEST_PATH, idBacktest(clave, tipo), revision)
      res.json({ revision })
    } catch (err) {
      responderErrorRevision(res, err, 'revision-backtest')
    }
  })

  // Lo que hay escrito sobre un trade: su comentario, sus etiquetas (las 13 categorías del
  // Book of Horror, por número) y si ya está revisado. Todo en la misma anotación, para que
  // respaldar ese JSON respalde el trabajo entero.
  const CATEGORIAS_BOH = 13

  function normalizaCats(v) {
    if (!Array.isArray(v)) return []
    const nums = v.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= CATEGORIAS_BOH)
    return [...new Set(nums)].sort((a, b) => a - b)
  }

  function anotacionDe(comentarios, clave) {
    const a = comentarios[clave]
    return {
      texto:       typeof a?.texto === 'string' ? a.texto : '',
      cats:        normalizaCats(a?.cats),
      revisado:    a?.revisado === true,
      actualizado: Number.isFinite(a?.actualizado) ? a.actualizado : null,
    }
  }

  // Una anotación que se queda sin comentario, sin etiquetas y sin revisar se borra del
  // JSON en lugar de dejar una entrada vacía
  function guardarAnotacion(comentarios, clave, anotacion) {
    const limpia = {
      texto:    String(anotacion.texto ?? '').trim(),
      cats:     normalizaCats(anotacion.cats),
      revisado: anotacion.revisado === true,
    }
    if (!limpia.texto && limpia.cats.length === 0 && !limpia.revisado) delete comentarios[clave]
    else comentarios[clave] = { ...limpia, actualizado: Date.now() }
    guardarComentariosTrades(comentarios)
    return anotacionDe(comentarios, clave)
  }

  // El comentario se guarda por trade, no por ruta: de 2024 en adelante la captura se llama
  // por su fecha e instrumento, y en 2022-2023 por el número de operación. Eso identifica al
  // trade aunque el archivo se reexporte con otra extensión o cambie de carpeta.
  function claveTrade({ rel, fecha, instrumento, anio, numero }) {
    if (fecha)  return `${fecha}_${instrumento ?? ''}`
    if (numero) return `${anio}#${numero}`
    return rel.split(sep).join('/')
  }

  // Las capturas de un año. Si tiene subcarpetas "Separados" (2024 en adelante) mandan ellas,
  // que es el recorte por instrumento; si no las tiene (2022 y 2023, numeradas), entra todo.
  // 2023 guarda la misma captura en la carpeta de su mes y en TODOS: se cuenta una sola vez,
  // y la carpeta del mes es lo único que le pone mes a un nombre que no lleva fecha.
  function capturasDelAnio(base, year) {
    const todas     = walkImages(base, 'collage')
    const separadas = todas.filter(p => basename(dirname(p)).toLowerCase() === 'separados')

    const mesPorNombre = new Map()
    for (const p of todas) {
      const m = basename(dirname(p)).match(/^(\d{1,2})-/)
      if (m) mesPorNombre.set(basename(p), m[1].padStart(2, '0'))
    }

    const vistos = new Set()
    const out    = []
    for (const path of (separadas.length > 0 ? separadas : todas)) {
      const nombre = basename(path)
      if (vistos.has(nombre)) continue   // el mismo número en la carpeta del mes y en TODOS
      vistos.add(nombre)
      out.push({ path, year, mesCarpeta: mesPorNombre.get(nombre) ?? null })
    }
    return out
  }

  // PHOTO_YEARS ya sabe dónde vive el archivo de cada año (lo usa la pestaña Fotos). Cualquier
  // otro "Trading <año>" entra solo si tiene carpetas Separados, para no arrastrar las capturas
  // de Revision, Scenarios o SWING, que no son trades del diario.
  function capturasTrades() {
    const out    = []
    const vistos = new Set()
    for (const { year, dir } of PHOTO_YEARS) {
      vistos.add(year)
      out.push(...capturasDelAnio(join(PHOTOS_ROOT, dir), year))
    }

    let entradas
    try { entradas = readdirSync(PHOTOS_ROOT, { withFileTypes: true }) } catch { entradas = [] }
    for (const e of entradas) {
      const m = e.isDirectory() ? e.name.match(/^Trading\s*(\d{4})$/i) : null
      if (!m || vistos.has(Number(m[1]))) continue
      const base = join(PHOTOS_ROOT, e.name)
      const tieneSeparados = walkImages(base, 'collage')
        .some(p => basename(dirname(p)).toLowerCase() === 'separados')
      if (tieneSeparados) out.push(...capturasDelAnio(base, Number(m[1])))
    }
    return out
  }

  // El recorrido de Drive es lo caro (cientos de carpetas), no los comentarios: se cachea la
  // lista de archivos y el JSON de comentarios se relee en cada petición, que es un solo fichero.
  let _tradesIndex   = null
  let _tradesIndexTs = 0
  function getTradesIndex(refrescar = false) {
    if (!refrescar && _tradesIndex && Date.now() - _tradesIndexTs < 10 * 60_000) return _tradesIndex
    _tradesIndex   = capturasTrades()
    _tradesIndexTs = Date.now()
    console.log(`[trades-comentados] índice construido: ${_tradesIndex.length} capturas`)
    return _tradesIndex
  }

  // Las claves de todos los trades del archivo. Es lo que permite decir si un archivo de un
  // book es de un trade conocido o vino de fuera. Se cachea con el mismo índice de capturas.
  let _clavesArchivo   = null
  let _clavesArchivoTs = 0
  function clavesDelArchivo() {
    const capturas = getTradesIndex()
    if (_clavesArchivo && _clavesArchivoTs === _tradesIndexTs) return _clavesArchivo
    _clavesArchivo   = new Set(capturas.map(c => tradeDTO(c, {}).clave))
    _clavesArchivoTs = _tradesIndexTs
    return _clavesArchivo
  }

  function tradeDTO(captura, comentarios, enBooks) {
    const rel = relative(PHOTOS_ROOT, captura.path)
    const { fecha, instrumento, numero } = parseFotoInfo({ year: captura.year, path: captura.path })
    const anio       = fecha ? fecha.slice(0, 4) : String(captura.year)
    const mes        = fecha ? fecha.slice(5, 7) : captura.mesCarpeta
    const clave      = claveTrade({ rel, fecha, instrumento, anio, numero })
    const anotacion  = anotacionDe(comentarios, clave)
    return {
      // mismo id que sirve /api/fotos/archivo, que ya sabe entregar cualquier foto de Drive
      id:          Buffer.from(rel).toString('base64url'),
      clave,
      nombre:      basename(captura.path),
      anio,
      mes,
      fecha,
      instrumento,
      numero,
      comentario:  anotacion.texto,
      cats:        anotacion.cats,
      revisado:    anotacion.revisado,
      actualizado: anotacion.actualizado,
      // en qué books ya está esta captura, para el botón de un clic
      books:       Object.entries(enBooks ?? {}).filter(([, claves]) => claves.has(clave)).map(([id]) => id),
    }
  }

  // Lo más reciente primero; dentro de un mes, por fecha e instrumento, y las capturas
  // numeradas (2022-2023) por su número, que es su orden real.
  function ordenTrades(a, b) {
    return b.anio.localeCompare(a.anio)
      || (b.mes ?? '00').localeCompare(a.mes ?? '00')
      || (b.fecha ?? '').localeCompare(a.fecha ?? '')
      || (a.instrumento ?? '').localeCompare(b.instrumento ?? '')
      || (a.numero ?? '').localeCompare(b.numero ?? '')
  }

  app.get('/api/trades-comentados/lista', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
    try {
      const comentarios = leerComentariosTrades()
      const enBooks     = clavesEnBooks()
      const trades = getTradesIndex(req.query.refrescar === '1')
        .map(c => tradeDTO(c, comentarios, enBooks))
        .sort(ordenTrades)
      res.json({
        carpeta:    PHOTOS_ROOT,
        archivo:    TRADES_COMENTARIOS_PATH,
        total:      trades.length,
        comentados: trades.filter(t => t.comentario).length,
        trades,
      })
    } catch (err) {
      console.error('[trades-comentados/lista]', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // Comentar un trade. Un comentario vacío borra la entrada del JSON en lugar de dejar basura.
  app.put('/api/trades-comentados/comentario', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
    try {
      const rel = Buffer.from(String(req.query.id ?? ''), 'base64url').toString('utf8')
      // solo se comenta lo que está en el índice, así un id no puede apuntar fuera del archivo
      const captura = getTradesIndex().find(c => relative(PHOTOS_ROOT, c.path) === rel)
      if (!captura) return res.status(404).json({ error: 'Esa captura no está en el archivo de trades' })

      const texto       = String(req.body?.comentario ?? '').trim()
      const comentarios = leerComentariosTrades()
      const { clave }   = tradeDTO(captura, comentarios, clavesEnBooks())
      // se conservan las etiquetas: el comentario es solo una parte de la anotación
      guardarAnotacion(comentarios, clave, { ...anotacionDe(comentarios, clave), texto })

      res.json({ trade: tradeDTO(captura, comentarios, clavesEnBooks()) })
    } catch (err) {
      console.error('[trades-comentados/comentario]', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // Etiquetas de los trades, para pintarlas en Operaciones sin pedir la lista entera
  app.get('/api/trades-comentados/etiquetas', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
    try {
      const comentarios = leerComentariosTrades()
      const anotaciones = {}
      for (const clave of Object.keys(comentarios)) {
        const { texto, cats, revisado } = anotacionDe(comentarios, clave)
        if (texto || cats.length || revisado) anotaciones[clave] = { texto, cats, revisado }
      }
      res.json({ archivo: TRADES_COMENTARIOS_PATH, anotaciones })
    } catch (err) {
      console.error('[trades-comentados/etiquetas]', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // Anotar un trade desde Operaciones: comentario, etiquetas y revisado. Va por clave de
  // trade y no por captura, para poder anotarlo aunque ese día no tenga captura en Drive.
  // Lo que no venga en el cuerpo se queda como estaba.
  app.put('/api/trades-comentados/etiquetas', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
    try {
      const clave = String(req.query.clave ?? '').trim()
      if (!clave || clave.length > 100) return res.status(400).json({ error: 'Clave de trade no válida' })

      const comentarios = leerComentariosTrades()
      const anterior    = anotacionDe(comentarios, clave)
      const anotacion   = guardarAnotacion(comentarios, clave, {
        texto:    req.body?.comentario ?? anterior.texto,
        cats:     req.body?.cats ?? anterior.cats,
        revisado: req.body?.revisado ?? anterior.revisado,
      })
      res.json({ clave, ...anotacion })
    } catch (err) {
      console.error('[trades-comentados/etiquetas]', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  return { PHOTOS_ROOT, leerTradesDiario }
}
