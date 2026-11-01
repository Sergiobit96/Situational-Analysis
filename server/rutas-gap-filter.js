// ── Gap Filter y su exportación a PowerPoint (pestaña Gap Filter, solo en local) ──
// Sacado de server/index.js: registrarGapFilter pone las rutas en `app`; lo demás llega como
// dependencias.

import express from 'express'
import { getEventIndex, getEventosEnFecha } from './eventos.js'
import PptxGenJS from 'pptxgenjs'

export function registrarGapFilter({ ANIOS_DIARIAS, DUKASCOPY_DAILY, app, claveBot, getMadridDate, getMadridDay, obtenerVelasDiarias }) {
  // ── Gap Filter ─────────────────────────────────────────────────────────────
  app.get('/api/gap-filter', async (req, res) => {
    try {
      const ticker  = req.query.ticker ?? '^GDAXI'
      const dias    = req.query.dias ? req.query.dias.split(',').map(Number) : [1,2,3,4,5]
      const dir     = req.query.dir  ?? 'both'
      const gapMin  = parseFloat(req.query.gapMin ?? 0)
      const gapModo = req.query.gapModo === 'pts' ? 'pts' : 'pct'
      const meses   = Math.min(12 * ANIOS_DIARIAS, Math.max(1, parseInt(req.query.meses ?? 12, 10)))
      const diasEsp = req.query.diasEsp ? new Set(req.query.diasEsp.split(',')) : null

      const diarias = await obtenerVelasDiarias(ticker)

      // Filtrar al periodo solicitado
      const cutoff  = Date.now() / 1000 - meses * 31 * 86400
      const periodo = diarias.filter(v => v.time >= cutoff)

      const evIdx    = await getEventIndex()
      const sesiones = []

      for (let i = 1; i < periodo.length; i++) {
        const curr = periodo[i]
        const prev = periodo[i - 1]

        const gapPts    = curr.open - prev.close
        const gapPct    = gapPts / prev.close * 100
        const gapDir    = gapPct >= 0 ? 'up' : 'down'
        const date      = getMadridDate(curr.time)
        const dayOfWeek = getMadridDay(curr.time)
        const gapMedido = gapModo === 'pts' ? gapPts : gapPct

        // Festivo de mercado: hueco de días naturales entre velas mayor que un
        // fin de semana normal ⇒ se saltó al menos un día hábil por festivo.
        // Se detecta por instrumento a partir de sus propias velas (sin depender
        // de un calendario de festivos por país), así vale para cualquier ticker.
        const gapDiasCal   = Math.round((curr.time - prev.time) / 86400)
        const gapEsperado  = dayOfWeek === 1 ? 3 : 1
        const esPostFestivo = gapDiasCal > gapEsperado

        const eventos = [...getEventosEnFecha(evIdx, date)]
        if (esPostFestivo) eventos.push('FESTIVO')

        if (!dias.includes(dayOfWeek))            continue
        if (dir !== 'both' && gapDir !== dir)      continue
        if (Math.abs(gapMedido) < gapMin - 0.001) continue

        sesiones.push({
          date, dayOfWeek,
          gapPct:    parseFloat(gapPct.toFixed(3)),
          gapDir,
          prevClose: prev.close,
          // rango del día anterior: con él se puede mirar si la sesión abre fuera de lo que
          // hizo ayer, que es otro de los filtros de Estrategias
          prevHigh:  prev.high,
          prevLow:   prev.low,
          openPrice: curr.open,
          eventos,
        })
      }

      // Filtro días especiales (primer/último día de negociación del mes o trimestre)
      let sesionesFiltradas = sesiones
      if (diasEsp && diasEsp.size > 0) {
        // Construir conjuntos de fechas especiales a partir del periodo completo
        const byMes = {}
        for (const v of periodo) {
          const date = getMadridDate(v.time)
          const key  = date.slice(0, 7)
          if (!byMes[key]) byMes[key] = []
          byMes[key].push(date)
        }
        const primerMes  = new Set()
        const ultimoMes  = new Set()
        const primerTrim = new Set()
        const ultimoTrim = new Set()
        const inicioTrim = new Set(['01','04','07','10'])
        const finTrim    = new Set(['03','06','09','12'])
        for (const [key, fechas] of Object.entries(byMes)) {
          const ord = [...fechas].sort()
          const mes = key.slice(5, 7)
          primerMes.add(ord[0])
          ultimoMes.add(ord[ord.length - 1])
          if (inicioTrim.has(mes)) primerTrim.add(ord[0])
          if (finTrim.has(mes))    ultimoTrim.add(ord[ord.length - 1])
        }
        sesionesFiltradas = sesiones.filter(s =>
          (diasEsp.has('primerMes')  && primerMes.has(s.date))  ||
          (diasEsp.has('ultimoMes')  && ultimoMes.has(s.date))  ||
          (diasEsp.has('primerTrim') && primerTrim.has(s.date)) ||
          (diasEsp.has('ultimoTrim') && ultimoTrim.has(s.date)) ||
          (diasEsp.has('festivo')   && s.eventos.includes('FESTIVO'))
        )
      }

      const fechaInicio  = periodo[0] ? getMadridDate(periodo[0].time) : null
      const periodoLabel = meses >= 12 ? `${meses / 12}a` : `${meses}m`
      const fuenteDiaria = DUKASCOPY_DAILY[ticker]
        ? `Dukascopy · ${periodoLabel}`
        : `Stooq 1d · ${periodoLabel}`
      res.json({ ticker, sesiones: sesionesFiltradas, total: sesionesFiltradas.length, fuente: fuenteDiaria, fechaInicio })
    } catch (err) {
      console.error('[gap-filter]', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // ── Exportar coincidencias del Gap Filter a PowerPoint ────────────────────
  // Agrupa todas las sesiones que coinciden con el filtro actual (recibidas ya
  // filtradas desde el cliente, cada una con su gráfico de velas ya capturado
  // en PNG) en un único .pptx: portada, resumen estadístico agrupado y un
  // slide por coincidencia con su gráfico intradía.
  const DIA_NOMBRE_PPT = { 1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves', 5: 'Viernes' }

  // En producción pide la clave del bot: es la única ruta abierta que acepta 50 MB
  app.post('/api/export-ppt', claveBot.middleware, express.json({ limit: '50mb' }), async (req, res) => {
    try {
      const { ticker, sesiones, filtros } = req.body
      if (!Array.isArray(sesiones) || sesiones.length === 0)
        return res.status(400).json({ error: 'Sin coincidencias que exportar' })

      const arriba = sesiones.filter(s => s.gapDir === 'up').length
      const abajo  = sesiones.length - arriba
      const avgGap = sesiones.reduce((a, s) => a + Math.abs(s.gapPct ?? 0), 0) / sesiones.length
      const porDia = {}
      for (const s of sesiones) porDia[s.dayOfWeek] = (porDia[s.dayOfWeek] ?? 0) + 1

      const pptx = new PptxGenJS()
      pptx.defineLayout({ name: 'WIDE', width: 13.33, height: 7.5 })
      pptx.layout = 'WIDE'

      // ── Portada ──
      const portada = pptx.addSlide()
      portada.background = { color: '0F172A' }
      portada.addText('Situational Analysis', { x: 0.6, y: 0.7, fontSize: 32, bold: true, color: 'FFFFFF' })
      portada.addText(`${ticker} · ${sesiones.length} coincidencias`, { x: 0.6, y: 1.5, fontSize: 20, color: '93C5FD' })
      if (filtros) {
        const resumenFiltros = [
          filtros.dias            && `Días: ${filtros.dias}`,
          filtros.dir              && `Dirección: ${filtros.dir}`,
          filtros.gapMin != null   && `Gap mínimo: ${filtros.gapMin === 0 ? 'cualquiera' : filtros.gapMin + (filtros.gapModo === 'pts' ? ' pts' : '%')}`,
          filtros.periodo          && `Periodo: ${filtros.periodo}`,
        ].filter(Boolean).join('   ·   ')
        if (resumenFiltros) portada.addText(resumenFiltros, { x: 0.6, y: 2.3, fontSize: 13, color: 'CBD5E1' })
      }

      // ── Resumen agrupado ──
      const resumenSlide = pptx.addSlide()
      resumenSlide.addText('Resumen agrupado', { x: 0.5, y: 0.4, fontSize: 24, bold: true, color: '0F172A' })
      resumenSlide.addText(
        `Total coincidencias: ${sesiones.length}\n` +
        `Gaps al alza: ${arriba}   ·   Gaps a la baja: ${abajo}\n` +
        `Gap medio (valor absoluto): ${avgGap.toFixed(3)}%`,
        { x: 0.5, y: 1.2, fontSize: 15, color: '334155', lineSpacingMultiple: 1.4 }
      )
      const filasDia = [
        [{ text: 'Día', options: { bold: true } }, { text: 'Nº coincidencias', options: { bold: true } }],
        ...Object.entries(porDia)
          .sort(([a], [b]) => a - b)
          .map(([d, n]) => [DIA_NOMBRE_PPT[d] ?? d, String(n)]),
      ]
      resumenSlide.addTable(filasDia, {
        x: 0.5, y: 2.9, w: 5, fontSize: 13,
        border: { type: 'solid', color: 'CBD5E1', pt: 0.5 },
        autoPage: false,
      })

      // ── Detalle: un slide por coincidencia con su gráfico intradía ──
      for (const s of sesiones) {
        const slide    = pptx.addSlide()
        const gapColor = s.gapDir === 'up' ? '3FB950' : 'F85149'
        const gapPts   = s.prevClose != null && s.openPrice != null ? s.openPrice - s.prevClose : null
        const gapText  = s.gapPct != null
          ? `${s.gapPct > 0 ? '+' : ''}${s.gapPct.toFixed(3)}%` + (gapPts != null ? `  (${gapPts > 0 ? '+' : ''}${gapPts.toFixed(2)} pts)` : '')
          : ''

        slide.addText([
          { text: `${s.date ?? ''}   `,                      options: { bold: true, color: '0F172A', fontSize: 16 } },
          { text: `${DIA_NOMBRE_PPT[s.dayOfWeek] ?? ''}   `, options: { color: '64748B', fontSize: 14 } },
          { text: gapText,                                    options: { bold: true, color: gapColor, fontSize: 16 } },
          { text: `   Cierre ant. ${s.prevClose != null ? s.prevClose.toFixed(2) : '–'} → Apertura ${s.openPrice != null ? s.openPrice.toFixed(2) : '–'}`, options: { color: '64748B', fontSize: 13 } },
          ...(s.eventos?.length ? [{ text: `   ${s.eventos.join(', ')}`, options: { color: '7C3AED', fontSize: 13, bold: true } }] : []),
        ], { x: 0.5, y: 0.3, w: 12.3, h: 0.6 })

        if (s.imagen) {
          slide.addImage({ data: s.imagen, x: 1.0, y: 1.05, w: 11.33, h: 6.375 })
        } else {
          slide.addText('Sin datos intraday disponibles para esta sesión', {
            x: 1.0, y: 3.7, w: 11.33, h: 0.6, align: 'center', color: '94A3B8', fontSize: 16, italic: true,
          })
        }
      }

      const buffer = await pptx.write({ outputType: 'nodebuffer' })
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
      res.setHeader('Content-Disposition', `attachment; filename="situational-analysis-${ticker}.pptx"`)
      res.send(buffer)
    } catch (err) {
      console.error('[export-ppt]', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  return {  }
}
