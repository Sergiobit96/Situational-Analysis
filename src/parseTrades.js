import { madridOffsetAt } from './timezone'

// Nombre de producto (tal cual aparece en el diario) → ticker usado en el resto de la app
export const PRODUCTO_A_TICKER = {
  'Germany 40':         '^GDAXI',
  'US Tech 100':        '^NDX',
  'Wall Street 30':     '^DJI',
  'US 500 (Per 1.0)':   '^GSPC',
  'UK 100':             '^FTSE',
  'US 2000':            '^RUT',
  'Gold (per 0.1)':     'XAUUSD',
  'Silver':             'XAGUSD',
}

// El número de serie de Excel (días desde 1899-12-30) se convierte a mano en vez de
// usar la opción `cellDates` de la librería xlsx: para este archivo esa conversión
// desplazaba la hora casi 1h respecto al valor real de la celda (verificado contra
// openpyxl y contra la fórmula estándar de fecha de Excel).
// El diario registra en hora de Londres fija (sin cambio de horario, equivale a UTC),
// así que el valor reconstruido YA es UTC real; se le suma el desfase de Madrid
// (CET/CEST, variable según la época del año) para encajar con el resto del chart,
// que muestra las velas con ese mismo desplazamiento dinámico.
const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30)

function celdaATimestamp(serial) {
  if (typeof serial !== 'number' || isNaN(serial)) return null
  const utc = Math.floor((EXCEL_EPOCH_UTC_MS + serial * 86400000) / 1000)
  return utc + madridOffsetAt(utc)
}

function buscarFilaCabecera(filas) {
  return filas.findIndex(f => f?.includes('-EXIT-') && f?.includes('-ENTRY-'))
}

// Parsea el diario de operaciones tipo "DAY <año>.xlsx": localiza la hoja nombrada
// como un año (p.ej. "2026") y extrae cada fila de tipo TRADE (se ignoran las de
// financiación/rollover marcadas como FIN).
// Import dinámico: xlsx solo se descarga cuando de verdad se sube un archivo,
// en vez de engordar el bundle principal de la app para todo el mundo.
export async function parseTradesXLSX(arrayBuffer) {
  const XLSX = await import('xlsx')
  // Sin cellDates: las celdas de fecha llegan como número de serie de Excel (no como
  // Date), para poder convertirlas nosotros mismos con celdaATimestamp() de forma fiable.
  const wb = XLSX.read(arrayBuffer, { type: 'array' })

  const nombreHoja = wb.SheetNames.find(n => /^\d{4}$/.test(n.trim())) ?? wb.SheetNames[0]
  const ws   = wb.Sheets[nombreHoja]
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null })

  const iCab = buscarFilaCabecera(filas)
  if (iCab === -1) {
    throw new Error(`No se encontró la cabecera de operaciones (-EXIT-/-ENTRY-) en la hoja "${nombreHoja}"`)
  }

  const cab   = filas[iCab]
  const col   = nombre => cab.indexOf(nombre)
  const iExit    = col('-EXIT-')
  const iEntry   = col('-ENTRY-')
  const iAction  = col('ACTION')
  const iProduct = col('Product')
  const iOpen    = col('Open')
  const iClose   = col('Close')
  const iDir     = col('↑↓')
  const iDif     = col('DIF')
  const iSize    = col('Size')

  const trades = []
  for (let i = iCab + 1; i < filas.length; i++) {
    const fila = filas[i]
    if (!fila || fila[iAction] !== 'TRADE') continue

    const openTime  = celdaATimestamp(fila[iEntry])
    const closeTime = celdaATimestamp(fila[iExit])
    const openPrice  = parseFloat(fila[iOpen])
    const closePrice = parseFloat(fila[iClose])
    if (openTime == null || closeTime == null || isNaN(openPrice) || isNaN(closePrice)) continue

    const producto = fila[iProduct]?.toString().trim() ?? ''
    trades.push({
      producto,
      ticker:    PRODUCTO_A_TICKER[producto] ?? null,
      direccion: fila[iDir] ?? null,
      size:      iSize !== -1 ? parseFloat(fila[iSize]) : null,
      openTime, openPrice,
      closeTime, closePrice,
      puntos: iDif !== -1 && !isNaN(parseFloat(fila[iDif])) ? parseFloat(fila[iDif]) : closePrice - openPrice,
    })
  }

  trades.sort((a, b) => a.openTime - b.openTime)
  return trades
}

export const fmtFechaTS = ts => new Date(ts * 1000).toISOString().slice(0, 10)
export const fmtHoraTS  = ts => new Date(ts * 1000).toISOString().slice(11, 19)
