// ── MFE / MAE de las operaciones del diario (solo local), con las velas de Dukascopy en
// disco y las de Yahoo y Stooq guardadas. Sacado de server/index.js.

import { dukascopyLimitando, revalidarTransporteDukascopy } from './dukascopy-transport.js'
import { VERSION_EXCURSION, claveExcursion, tramoDe, calcularExcursion, ladoDe, aUtc } from './excursiones.js'
import { INDICE_YAHOO, INDICE_YAHOO_CSV, DIARIOS_YAHOO, DIARIOS_STOOQ, parsearCsvYahoo, parsearDiarioYahoo, parsearDiarioStooq, velasYahooDeOperacion } from './velas-yahoo.js'
import { existsSync, readFileSync, writeFileSync, statSync, renameSync } from 'fs'
import { join } from 'path'

export function registrarExcursiones({ DISK_CACHE_DIR, DUKA_RAW_CACHE_DIR, DUKA_TIMEOUT_MS, PHOTOS_ROOT, YF_TO_DUKASCOPY, app, errDetalle, leerTradesDiario, obtenerTramoDukascopy }) {
  // ── MFE / MAE de las operaciones del diario (solo local) ──
  // Se calculan una vez con las velas de Dukascopy y se guardan junto al diario: la primera
  // pasada son ~1.900 días de velas de 1 min y, con el feed limitando por IP, tarda un rato.
  // Después solo se calculan las operaciones nuevas. La medida está en server/excursiones.js.
  const EXCURSIONES_PATH = process.env.EXCURSIONES_TRADES || join(PHOTOS_ROOT, 'Excursiones trades.json')

  let excursiones = null   // clave de operación → resultado; el cálculo escribe sobre este mismo objeto
  function excursionesActuales() {
    if (excursiones) return excursiones
    try {
      const d = JSON.parse(readFileSync(EXCURSIONES_PATH, 'utf8'))
      // lo de versiones anteriores se tira: con otra clave nunca volvería a encontrarse
      excursiones = Object.fromEntries(Object.entries(d?.resultados ?? {})
        .filter(([, r]) => r?.v === VERSION_EXCURSION))
    } catch {
      excursiones = {}
    }
    return excursiones
  }

  function guardarExcursiones() {
    const tmp = `${EXCURSIONES_PATH}.tmp`
    writeFileSync(tmp, JSON.stringify({ actualizado: Date.now(), resultados: excursionesActuales() }))
    renameSync(tmp, EXCURSIONES_PATH)
  }

  // Lo que falta: operaciones de un instrumento con velas sin resultado de esta versión, y las
  // que se quedaron sin lado si ahora se sabe (el del Amount del historial, oct 2026). Con
  // `reintentar`, también las que se quedaron sin velas y las medidas con Yahoo, por si
  // Dukascopy ya las sirve.
  function excursionesPendientes(reintentar = false) {
    const hechas = excursionesActuales()
    return leerTradesDiario().filter(t => {
      if (!YF_TO_DUKASCOPY[t.ticker]) return false
      const r = hechas[claveExcursion(t)]
      if (r?.v !== VERSION_EXCURSION) return true
      if (r.sinDatos === 'sin dirección') return ladoDe(t) != null
      return reintentar && (r.sinDatos === 'sin velas en el tramo' || r.fuente === 'yahoo')
    })
  }

  // Las velas de 1 y 5 min de Yahoo que deja cada mañana recoger_yahoo.py: la reserva cuando
  // Dukascopy no sirve un día que no tiene en caché (ver server/velas-yahoo.js) y, en el
  // gráfico de IG, para lo que IG no da. En el servidor online están en el volumen, adonde las
  // sube scripts/subir-yahoo.mjs (PUT /api/yahoo/:fichero).
  const YAHOO_DIR = process.env.YAHOO_DIR || process.env.YAHOO_1MIN_DIR
    || (process.env.NODE_ENV === 'production' ? (existsSync('/data') ? '/data/yahoo' : join(DISK_CACHE_DIR, 'yahoo')) : 'C:\\Users\\Sergio\\Documents\\Yahoo')
  const velasYahooCache = new Map()   // `${ticker}|${intervalo}` → { mtime, velas }
  function velasYahooLocales(ticker, intervalo = '1min', indices = INDICE_YAHOO) {
    const indice = indices[ticker]
    if (!indice) return null
    const file = join(YAHOO_DIR, `${indice}_${intervalo}.csv`)
    const clave = `${ticker}|${intervalo}`
    try {
      const mtime = statSync(file).mtimeMs
      const visto = velasYahooCache.get(clave)
      if (visto?.mtime === mtime) return visto.velas
      const velas = parsearCsvYahoo(readFileSync(file, 'utf8'))
      velasYahooCache.set(clave, { mtime, velas })
      return velas
    } catch {
      return null
    }
  }

  // Las diarias de Documents\Yahoo\diario (ver DIARIOS_YAHOO), con el mismo truco de caché
  const diariosYahooCache = new Map()   // id → { mtime, velas }
  function diarioYahooLocal(id) {
    const file = join(YAHOO_DIR, 'diario', `${id}_1d.csv`)
    try {
      const mtime = statSync(file).mtimeMs
      const visto = diariosYahooCache.get(id)
      if (visto?.mtime === mtime) return visto.velas
      const velas = parsearDiarioYahoo(readFileSync(file, 'utf8'))
      diariosYahooCache.set(id, { mtime, velas })
      return velas
    } catch {
      return null
    }
  }

  // Los CSV de Yahoo para analizar en Estrategias. Intradía: todas las velas de 1 o 5 min de un
  // índice (unos meses de sesiones de contado, en UTC); la pestaña las reparte por sesión.
  // Diario: la serie entera de un índice, para las tortugas.
  const faltaYahoo = fichero => (process.env.NODE_ENV === 'production'
    ? `El servidor online no tiene ${fichero}: súbelo con node scripts/subir-yahoo.mjs desde tu PC`
    : `No está ${fichero} en ${YAHOO_DIR}`)
  app.get('/api/yahoo-csv/intradia', (req, res) => {
    const ticker = String(req.query.ticker ?? '')
    const intervalo = req.query.intervalo === '1min' ? '1min' : '5min'
    const indice = INDICE_YAHOO_CSV[ticker]
    if (!indice) return res.status(400).json({ error: `No hay CSV de Yahoo de ${ticker}` })
    const velas = velasYahooLocales(ticker, intervalo, INDICE_YAHOO_CSV)
    if (!velas?.length) return res.status(404).json({ falta: true, error: faltaYahoo(`${indice}_${intervalo}.csv`) })
    res.json({ ticker, intervalo, velas })
  })
  app.get('/api/yahoo-csv/diario/:id', (req, res) => {
    const { id } = req.params
    if (!DIARIOS_YAHOO.includes(id)) return res.status(400).json({ error: `No hay CSV diario de ${id}` })
    const velas = diarioYahooLocal(id)
    if (!velas?.length) return res.status(404).json({ falta: true, error: faltaYahoo(`diario/${id}_1d.csv`) })
    res.json({ id, primera: velas[0].date, ultima: velas.at(-1).date, velas })
  })

  // Las diarias de Stooq de Documents\Stooq (ver DIARIOS_STOOQ), para comparar las tortugas con
  // las de Yahoo. En el servidor online, en el volumen, adonde las sube scripts/subir-yahoo.mjs.
  const STOOQ_DIR = process.env.STOOQ_DIR
    || (process.env.NODE_ENV === 'production' ? (existsSync('/data') ? '/data/stooq' : join(DISK_CACHE_DIR, 'stooq')) : 'C:\\Users\\Sergio\\Documents\\Stooq')
  const diariosStooqCache = new Map()   // id → { mtime, velas }
  function diarioStooqLocal(id) {
    const file = join(STOOQ_DIR, `${DIARIOS_STOOQ[id]}_d.csv`)
    try {
      const mtime = statSync(file).mtimeMs
      const visto = diariosStooqCache.get(id)
      if (visto?.mtime === mtime) return visto.velas
      const velas = parsearDiarioStooq(readFileSync(file, 'utf8'))
      diariosStooqCache.set(id, { mtime, velas })
      return velas
    } catch {
      return null
    }
  }
  app.get('/api/stooq/diario/:id', (req, res) => {
    const { id } = req.params
    if (!DIARIOS_STOOQ[id]) return res.status(400).json({ error: `No hay diario de Stooq de ${id}` })
    const velas = diarioStooqLocal(id)
    const fichero = `${DIARIOS_STOOQ[id]}_d.csv`
    if (!velas?.length) {
      return res.status(404).json({
        falta: true,
        error: process.env.NODE_ENV === 'production'
          ? `El servidor online no tiene ${fichero} de Stooq: súbelo con node scripts/subir-yahoo.mjs desde tu PC`
          : `No está ${fichero} en ${STOOQ_DIR}`,
      })
    }
    res.json({ id, primera: velas[0].date, ultima: velas.at(-1).date, velas })
  })

  // Si el fichero de 1 min de Dukascopy de ese día ya está en la caché de disco, se lee de ahí
  // aunque el feed esté cortado. Es el nombre que le pone dukascopy-node (el mes en base 0).
  function diaEnCacheDukascopy(instrument, ts) {
    const d = new Date(ts * 1000)
    const dos = n => String(n).padStart(2, '0')
    const nombre = `${instrument.toUpperCase()}-${d.getUTCFullYear()}-${dos(d.getUTCMonth())}-${dos(d.getUTCDate())}-BID_candles_min_1.bi5`
    return existsSync(join(DUKA_RAW_CACHE_DIR, nombre))
  }

  const excursionesEstado = {
    activo: false, total: 0, hechas: 0, sinDatos: 0, yahoo: 0, sinFuente: 0, error: null, inicio: null, fin: null,
  }

  // Cuando el feed corta (429 o caída) se espera y se reintenta la misma operación. Si sigue
  // cortado, en esa pasada ya no se le pide nada que no esté en caché: sale de Yahoo, y lo
  // que Yahoo no cubre queda pendiente para otra vez.
  const ESPERAS_EXCURSION_MS = [15_000, 60_000]

  async function calcularExcursiones(reintentar) {
    const resultados = excursionesActuales()
    const diario = leerTradesDiario()
    // de la más reciente a la más antigua: lo último que se ha operado es lo primero que se mira
    const pendientes = excursionesPendientes(reintentar).sort((a, b) => b.openTime - a.openTime)
    Object.assign(excursionesEstado, {
      activo: true, total: pendientes.length, hechas: 0, sinDatos: 0, yahoo: 0, sinFuente: 0,
      error: null, inicio: Date.now(), fin: null,
    })

    // Ejecuciones (entradas y salidas, en UTC) de cada día e instrumento, para medir el
    // desfase del CFD frente al contado de Yahoo. Las horas del diario van en hora de Madrid.
    const ejecuciones = new Map()
    for (const o of diario) {
      const clave = `${o.ticker}|${Math.floor(o.openTime / 86400)}`
      if (!ejecuciones.has(clave)) ejecuciones.set(clave, [])
      ejecuciones.get(clave).push(
        { time: aUtc(o.openTime), precio: o.openPrice },
        { time: aUtc(o.closeTime), precio: o.closePrice },
      )
    }
    const ejecucionesDe = t => ejecuciones.get(`${t.ticker}|${Math.floor(t.openTime / 86400)}`) ?? []

    // Las operaciones de un mismo día comparten fichero de Dukascopy: se lee una vez por
    // instrumento y día en vez de una vez por operación. Un día vacío no se guarda, para que
    // el reintento tras un 429 vuelva a pedirlo.
    let enMemoria = { clave: null, velas: [] }
    const velasDe = async (instrument, tramo) => {
      if (tramo.tf !== 'm1') return obtenerTramoDukascopy(instrument, tramo.tf, tramo.desde, tramo.hasta)
      const dia    = Math.floor(tramo.desde / 86400) * 86400
      // un segundo antes de medianoche: con la medianoche justa se bajaría también el día siguiente
      const finDia = Math.ceil(tramo.hasta / 86400) * 86400 - 1
      const clave  = `${instrument}|${dia}|${finDia}`
      if (enMemoria.clave === clave) return enMemoria.velas
      // un día de 1 min es uno o dos ficheros: el presupuesto de una consulta de un día basta
      const velas = await obtenerTramoDukascopy(instrument, 'm1', dia, finDia, DUKA_TIMEOUT_MS)
      if (velas.length > 0) enMemoria = { clave, velas }
      return velas
    }

    const velasDukascopy = async (instrument, tramo) => {
      for (let intento = 0; ; intento++) {
        try {
          const velas = await velasDe(instrument, tramo)
          // con el feed limitando, un tramo vacío no es "no hay datos" sino un fichero perdido
          if (velas.length === 0 && dukascopyLimitando()) throw new Error('Dukascopy está limitando las peticiones de esta IP (429)')
          return velas
        } catch (err) {
          if (intento >= ESPERAS_EXCURSION_MS.length) throw err
          // si el 443 se ha caído a media tarea, el reintento ya irá por HTTP
          revalidarTransporteDukascopy()
          console.warn(`[excursiones] ${errDetalle(err)}; reintento en ${ESPERAS_EXCURSION_MS[intento] / 1000} s`)
          await new Promise(r => setTimeout(r, ESPERAS_EXCURSION_MS[intento]))
        }
      }
    }

    let dukaCortado = null   // el error con el que Dukascopy dejó de servir en esta pasada
    let sinGuardar = 0
    try {
      for (const t of pendientes) {
        const instrument = YF_TO_DUKASCOPY[t.ticker]
        const tramo = tramoDe(t)
        const enCache = tramo.tf === 'm1' &&
          diaEnCacheDukascopy(instrument, tramo.desde) && diaEnCacheDukascopy(instrument, tramo.hasta - 1)
        excursionesEstado.hechas++

        let velas = null, fuente = 'dukascopy'
        if (enCache || !dukaCortado) {
          try {
            velas = await velasDukascopy(instrument, tramo)
          } catch (err) {
            dukaCortado = err
            console.warn(`[excursiones] Dukascopy no responde (${errDetalle(err)}); lo que no esté en caché sale de Yahoo`)
          }
        }
        // sin Dukascopy, o sin sus velas en ese tramo: las de Yahoo, si cubren la operación entera
        if (!velas?.length) {
          const yahoo = velasYahooDeOperacion(velasYahooLocales(t.ticker), t, ejecucionesDe(t))
          if (yahoo) { velas = yahoo; fuente = 'yahoo' }
        }
        // ni una ni otra: no se guarda nada y queda pendiente para otra pasada
        if (!velas) { excursionesEstado.sinFuente++; continue }

        const r = calcularExcursion(t, velas)
        const deYahoo = fuente === 'yahoo' && !r.sinDatos
        resultados[claveExcursion(t)] = { v: VERSION_EXCURSION, ...r, ...(deYahoo ? { fuente } : {}) }
        if (r.sinDatos) excursionesEstado.sinDatos++
        if (deYahoo) excursionesEstado.yahoo++
        if (++sinGuardar >= 50) { guardarExcursiones(); sinGuardar = 0 }
      }
      if (dukaCortado) {
        const quedan = excursionesEstado.sinFuente
        excursionesEstado.error = `Dukascopy no responde (${errDetalle(dukaCortado)})` +
          (quedan ? `; ${quedan} operaciones que Yahoo no cubre quedan pendientes` : '')
      }
    } catch (err) {
      excursionesEstado.error = errDetalle(err)
      console.error('[excursiones]', excursionesEstado.error)
    } finally {
      try { if (sinGuardar > 0) guardarExcursiones() } catch (err) { excursionesEstado.error = err.message }
      excursionesEstado.activo = false
      excursionesEstado.fin = Date.now()
      console.log(`[excursiones] ${excursionesEstado.hechas} de ${excursionesEstado.total} calculadas`)
    }
  }

  app.get('/api/excursiones', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
    res.json({ resultados: excursionesActuales(), estado: excursionesEstado })
  })

  app.get('/api/excursiones/estado', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
    const pendientes = excursionesEstado.activo
      ? excursionesEstado.total - excursionesEstado.hechas
      : excursionesPendientes().length
    res.json({ ...excursionesEstado, pendientes })
  })

  // Arranca el cálculo y responde al momento: el progreso se sigue con /api/excursiones/estado
  app.post('/api/excursiones/calcular', (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'No disponible en producción' })
    if (!excursionesEstado.activo) {
      calcularExcursiones(req.query.reintentar === '1').catch(err => console.error('[excursiones]', err))
    }
    res.json({ ...excursionesEstado, pendientes: excursionesEstado.total - excursionesEstado.hechas })
  })

  return { STOOQ_DIR, YAHOO_DIR, diaEnCacheDukascopy, velasYahooLocales }
}
