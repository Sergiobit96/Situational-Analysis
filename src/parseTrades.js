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

// Las celdas de fecha de Excel llegan como Date cuyos campos UTC coinciden con los
// valores literales de la hoja. El diario registra en hora de Londres (UK), una hora
// por detrás de Madrid, así que se suma 1h para que encaje con el resto del chart,
// que ya muestra las velas en "hora de Madrid" vía un desplazamiento similar.
const LONDRES_A_MADRID_SEGUNDOS = 3600

function celdaATimestamp(valor) {
  if (!(valor instanceof Date) || isNaN(valor)) return null
  return Math.floor(Date.UTC(
    valor.getUTCFullYear(), valor.getUTCMonth(), valor.getUTCDate(),
    valor.getUTCHours(), valor.getUTCMinutes(), valor.getUTCSeconds(),
  ) / 1000) + LONDRES_A_MADRID_SEGUNDOS
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
  const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true })

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
