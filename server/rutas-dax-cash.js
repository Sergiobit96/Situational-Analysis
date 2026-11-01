// ── Histórico del DAX cash desde el CSV de 5 min (solo local). Sacado de server/index.js:
// `olvidarVelasDax` vacía las velas agrupadas que guarda la pestaña Gráfico.

import express from 'express'
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync, renameSync } from 'fs'
import { join, dirname } from 'path'

export function registrarDaxCash({ DISK_CACHE_DIR, app, claveBot, olvidarVelasDax }) {
  // ── Histórico del DAX cash desde el CSV de 5 min (solo local) ──
  // El usuario mantiene un CSV de DAX cash a 5 minutos desde 2009 ("el Excel"): sirve para
  // probar las estrategias sobre 17 años en vez de sobre las últimas sesiones del feed, que
  // además limita por IP. Aquí se agrega a velas de 15 min de sesión (09:00-17:30 Berlín) y
  // se cachea en disco, porque parsear 453.000 filas en cada arranque no tiene sentido.
  // En local, el de Descargas; en producción, el que se sube desde la pestaña Estrategias (PUT
  // /api/dax-historico/csv) al volumen, para que no pase por el repositorio, que es público.
  const DAX_CSV   = process.env.DAX_CSV || (process.env.NODE_ENV === 'production'
    ? join(existsSync('/data') ? '/data' : '/tmp', 'dax-5m.csv')
    : 'C:\\Users\\Sergio\\Downloads\\DAX CASH MARKET DATA 5min from Feb 2009.csv')
  const DAX_CACHE = join(DISK_CACHE_DIR, 'dax15m.json')

  // Hora de Berlín -> epoch UTC. El desfase se calcula por día (no fijo) porque marzo y
  // octubre cambian la hora, y la app trabaja siempre con timestamps UTC.
  function epochBerlin(anio, mes, dia, minutos) {
    const tentativo = Date.UTC(anio, mes - 1, dia, Math.floor(minutos / 60), minutos % 60) / 1000
    const d     = new Date(tentativo * 1000)
    const local = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }))
    const utc   = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }))
    return tentativo - Math.round((local - utc) / 1000)
  }

  function construirSesionesDax() {
    const crudo = readFileSync(DAX_CSV, 'utf8')
    const porDia = new Map()
    // las de 5 min se guardan aparte: solo se sirven cuando hacen falta para deshacer el
    // empate de una vela de 15 que toca los dos extremos del bracket
    const finasPorDia = new Map()
    for (const linea of crudo.split(/\r?\n/)) {
      if (!linea || linea.startsWith('Date;') || linea.startsWith(';')) continue
      const [fecha, hora, o, h, l, c] = linea.split(';')
      if (!fecha || !hora) continue
      const [hh, mm] = hora.split(':').map(Number)
      const minuto = hh * 60 + mm
      if (minuto < 9 * 60 || minuto >= 17 * 60 + 30) continue   // solo sesión regular
      const open = Number(o), high = Number(h), low = Number(l), close = Number(c)
      if (!Number.isFinite(open) || !Number.isFinite(close)) continue

      if (!porDia.has(fecha)) porDia.set(fecha, new Map())
      if (!finasPorDia.has(fecha)) finasPorDia.set(fecha, [])
      finasPorDia.get(fecha).push({ min: minuto, open, high, low, close })
      const cubos = porDia.get(fecha)
      const ini   = minuto - (minuto % 15)
      const v     = cubos.get(ini)
      if (!v) cubos.set(ini, { min: ini, open, high, low, close })
      else {
        v.high  = Math.max(v.high, high)
        v.low   = Math.min(v.low, low)
        v.close = close
      }
    }

    const sesiones = []
    for (const [fecha, cubos] of porDia) {
      if (cubos.size < 3) continue   // sin dos velas de bracket más una de rotura no hay nada
      const [anio, mes, dia] = fecha.split('-').map(Number)
      // el desfase de Berlín, una vez por día (al mediodía): el cambio de hora es de madrugada y
      // no cae nunca en la sesión. Calcularlo en cada vela con epochBerlin costaba minuto y medio.
      const medianoche = Date.UTC(anio, mes - 1, dia) / 1000
      const desfase = epochBerlin(anio, mes, dia, 12 * 60) - (medianoche + 12 * 3600)
      const enBerlin = min => medianoche + min * 60 + desfase
      const velas = [...cubos.values()]
        .sort((a, b) => a.min - b.min)
        .map(v => ({ time: enBerlin(v.min), open: v.open, high: v.high, low: v.low, close: v.close }))
      const finas = (finasPorDia.get(fecha) ?? [])
        .sort((a, b) => a.min - b.min)
        .map(v => ({ time: enBerlin(v.min), open: v.open, high: v.high, low: v.low, close: v.close }))
      sesiones.push({ date: fecha, velas, finas })
    }
    sesiones.sort((a, b) => a.date.localeCompare(b.date))
    return sesiones
  }

  let _daxSesiones = null
  function getSesionesDax() {
    if (_daxSesiones) return _daxSesiones
    const st    = statSync(DAX_CSV)
    const firma = `${st.size}-${Math.round(st.mtimeMs)}`
    try {
      const cache = JSON.parse(readFileSync(DAX_CACHE, 'utf8'))
      if (cache.firma === firma) {
        _daxSesiones = cache.sesiones
        console.log(`[dax] ${_daxSesiones.length} sesiones desde la caché`)
        return _daxSesiones
      }
    } catch { /* sin caché válida: se reconstruye */ }

    const t0 = Date.now()
    _daxSesiones = construirSesionesDax()
    console.log(`[dax] ${_daxSesiones.length} sesiones construidas del CSV en ${Date.now() - t0} ms`)
    try { writeFileSync(DAX_CACHE, JSON.stringify({ firma, sesiones: _daxSesiones })) } catch { /* no crítico */ }
    return _daxSesiones
  }

  app.get('/api/dax-historico', (req, res) => {
    try {
      if (!existsSync(DAX_CSV)) {
        return res.status(404).json({ falta: true, error: process.env.NODE_ENV === 'production'
          ? 'El servidor online aún no tiene el CSV del DAX: súbelo aquí debajo'
          : `No se encuentra el CSV: ${DAX_CSV}` })
      }
      const todas = getSesionesDax()
      const desde = String(req.query.desde ?? '')
      const hasta = String(req.query.hasta ?? '')
      const conFinas = req.query.finas === '1'
      // las estrategias de velas de 5 min (First bar negative) las quieren como velas, y sin
      // cargar además con las de 15
      const en5m = req.query.velas === '5m'
      const soloEstas = String(req.query.dias ?? '').split(',').filter(Boolean)
      const filtro = new Set(soloEstas)
      const sesiones = todas
        .filter(s => (!desde || s.date >= desde) && (!hasta || s.date <= hasta))
        .filter(s => filtro.size === 0 || filtro.has(s.date))
        // las de 5 min pesan el triple: solo van si se piden, y normalmente para unos días
        .map(s => (conFinas ? s : en5m ? { date: s.date, velas: s.finas } : { date: s.date, velas: s.velas }))
      res.json({
        archivo: DAX_CSV,
        primera: todas[0]?.date ?? null,
        ultima:  todas[todas.length - 1]?.date ?? null,
        total:   sesiones.length,
        sesiones,
      })
    } catch (err) {
      console.error('[dax-historico]', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // Sube el CSV del DAX al servidor (lo manda la pestaña Estrategias, con la clave del bot). Antes
  // de cambiarlo por el que hubiera, se comprueba que trae velas.
  app.put('/api/dax-historico/csv', claveBot.middleware, express.text({ type: () => true, limit: '80mb' }), (req, res) => {
    const texto = typeof req.body === 'string' ? req.body : ''
    const muestra = texto.slice(0, 200_000).split(/\r?\n/)
    if (muestra.filter(l => /^\d{4}-\d{2}-\d{2};\d{1,2}:\d{2};[\d.]+;[\d.]+;[\d.]+;[\d.]+/.test(l)).length < 100) {
      return res.status(400).json({ error: 'No parece el CSV del DAX (Date;Time;Open;High;Low;Close, separado por ;)' })
    }
    try {
      mkdirSync(dirname(DAX_CSV), { recursive: true })
      writeFileSync(`${DAX_CSV}.tmp`, texto)
      renameSync(`${DAX_CSV}.tmp`, DAX_CSV)
      _daxSesiones = null
      olvidarVelasDax()
      const sesiones = getSesionesDax()
      res.json({ ok: true, sesiones: sesiones.length, primera: sesiones[0]?.date ?? null, ultima: sesiones.at(-1)?.date ?? null })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return { DAX_CSV, getSesionesDax }
}
