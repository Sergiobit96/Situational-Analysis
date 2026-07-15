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

function buscarFilaCabeceraDiario(filas) {
  return filas.findIndex(f => f?.includes('-EXIT-') && f?.includes('-ENTRY-'))
}

const MES_ENTRE_PARENTESIS = /\((Jan|Feb|Mar|Apr|May|Jun|June|Jul|Aug|Sep|Oct|Nov|Dec)\)/i

// El bróker usa variantes del mismo instrumento según el tipo de contrato ("Silver" vs
// "Silver (Variable Spreads)", "Germany 40" vs "Germany 40 - Future (Dec)"...): sin
// normalizar, cada variante aparecía como un producto distinto y el filtro de
// instrumento (y el ticker de PRODUCTO_A_TICKER) solo pillaba una de ellas.
function normalizarProducto(nombre) {
  return nombre
    .replace(/\s*-\s*(Rolling\s+)?Future\b/i, '')
    .replace(MES_ENTRE_PARENTESIS, '')
    .replace(/\s*\(Variable Spreads\)/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Hoja del diario "DAY <año>.xlsx": cabecera con marcadores -ENTRY-/-EXIT- y una fila
// ACTION==='TRADE' por operación.
function parseHojaDiario(filas, iCab) {
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

    const producto = normalizarProducto(fila[iProduct]?.toString().trim() ?? '')
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
  return trades
}

function esCabeceraHistorial(fila) {
  return Array.isArray(fila) && fila.includes('Transaction.Date') && fila.includes('Open.Period')
}

// Hoja de tipo "Historial de transacciones" (export de cuenta completo, no el diario
// día a día): cabecera en la primera fila con columnas Transaction.Date/Open.Period/
// Opening/Closing/P.L. El bróker etiquetó las operaciones como ACTION==='TRADE' hasta
// mediados de 2023 y como 'Trade Payable'/'Trade Receivable' (según si cerraron en
// pérdida o beneficio) a partir de esa fecha — se tratan todas como la misma operación.
function parseHojaHistorial(filas) {
  const ACCIONES_TRADE = new Set(['TRADE', 'Trade Payable', 'Trade Receivable'])
  const cab      = filas[0]
  const col      = nombre => cab.indexOf(nombre)
  const iFecha   = col('Transaction.Date')
  const iAction  = col('Action')
  const iDesc    = col('Description')
  const iAmount  = col('Amount')
  const iEntry   = col('Open.Period')
  const iOpen    = col('Opening')
  const iClose   = col('Closing')
  const iPL      = col('P.L')

  const trades = []
  for (let i = 1; i < filas.length; i++) {
    const fila = filas[i]
    if (!fila || !ACCIONES_TRADE.has(fila[iAction])) continue

    const openTime  = celdaATimestamp(fila[iEntry])
    const closeTime = celdaATimestamp(fila[iFecha])
    const openPrice  = parseFloat(fila[iOpen])
    const closePrice = parseFloat(fila[iClose])
    const pl = parseFloat(fila[iPL])
    if (openTime == null || closeTime == null || isNaN(openPrice) || isNaN(closePrice) || isNaN(pl)) continue

    // No hay columna de dirección explícita: se infiere comparando el signo del P&L
    // con el del movimiento de precio (mismo signo → compra, signo contrario → venta).
    const diff = closePrice - openPrice
    const direccion = (pl === 0 || diff === 0) ? null : ((pl > 0) === (diff > 0) ? 'Buy' : 'Sell')
    const size = iAmount !== -1 ? parseFloat(fila[iAmount]) : NaN
    const producto = normalizarProducto(fila[iDesc]?.toString().trim() ?? '')

    trades.push({
      producto,
      ticker:    PRODUCTO_A_TICKER[producto] ?? null,
      direccion,
      size:      !isNaN(size) ? size : null,
      openTime, openPrice,
      closeTime, closePrice,
      // "Puntos" = movimiento de precio en positivo-si-hay-beneficio, no el P&L en
      // divisa: se deshace el tamaño de la posición (P.L / Amount) para que sea
      // comparable con las operaciones del formato diario.
      puntos: !isNaN(size) && size !== 0 ? pl / size : (direccion === 'Sell' ? -diff : diff),
    })
  }
  return trades
}

// Admite dos formatos de export, detectados por el contenido de cada hoja (no por su
// nombre): el diario "DAY <año>.xlsx" (una hoja por año, cabecera -ENTRY-/-EXIT-) y el
// "Historial de transacciones" de la cuenta completa (una única hoja con años mezclados,
// cabecera Transaction.Date/Open.Period). Se recorren todas las hojas del libro y se usa
// cualquiera que encaje con alguno de los dos formatos, ignorando el resto (p.ej. hojas
// de resumen/pivote); así un mismo archivo o varios subidos por separado pueden traer
// cualquier combinación de años.
// Import dinámico: xlsx solo se descarga cuando de verdad se sube un archivo,
// en vez de engordar el bundle principal de la app para todo el mundo.
export async function parseTradesXLSX(arrayBuffer) {
  const XLSX = await import('xlsx')
  // Sin cellDates: las celdas de fecha llegan como número de serie de Excel (no como
  // Date), para poder convertirlas nosotros mismos con celdaATimestamp() de forma fiable.
  const wb = XLSX.read(arrayBuffer, { type: 'array' })

  const trades = []
  let algunaHojaReconocida = false
  for (const nombreHoja of wb.SheetNames) {
    const ws    = wb.Sheets[nombreHoja]
    const filas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null })

    const iCab = buscarFilaCabeceraDiario(filas)
    if (iCab !== -1) {
      algunaHojaReconocida = true
      trades.push(...parseHojaDiario(filas, iCab))
      continue
    }
    if (esCabeceraHistorial(filas[0])) {
      algunaHojaReconocida = true
      trades.push(...parseHojaHistorial(filas))
    }
  }

  if (!algunaHojaReconocida) {
    throw new Error('No se encontró ninguna hoja con formato de operaciones reconocido (columnas -ENTRY-/-EXIT- o Transaction.Date/Open.Period)')
  }

  trades.sort((a, b) => a.openTime - b.openTime)
  return trades
}

export const fmtFechaTS = ts => new Date(ts * 1000).toISOString().slice(0, 10)
export const fmtHoraTS  = ts => new Date(ts * 1000).toISOString().slice(11, 19)
