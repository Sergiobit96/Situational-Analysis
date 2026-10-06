import { madridOffsetAt, londresOffsetAt } from './timezone'

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
//
// La celda guarda la hora de pared de Londres, CON su cambio de horario (GMT en invierno,
// BST en verano): comprobado cruzando 144 entradas y salidas con las velas de 15 min, donde
// el precio cae dentro del rango de su vela en el 87% de los casos con este criterio y solo
// en el 22% si se toma la celda como UTC en verano. Por eso primero se deshace el desfase
// de Londres para tener UTC real y luego se suma el de Madrid (CET/CEST), que es el mismo
// desplazamiento con el que el chart pinta las velas.
const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30)

function celdaATimestamp(serial) {
  if (typeof serial !== 'number' || isNaN(serial)) return null
  const pared = Math.floor((EXCEL_EPOCH_UTC_MS + serial * 86400000) / 1000)
  // el desfase se mira con la hora de pared: solo diferiría dentro de la hora del cambio
  // de horario, de madrugada y con los mercados cerrados
  const utc = pared - londresOffsetAt(pared)
  return utc + madridOffsetAt(utc)
}

function buscarFilaCabeceraDiario(filas) {
  return filas.findIndex(f => f?.includes('-EXIT-') && f?.includes('-ENTRY-'))
}

// Cuánto hay que dividir el precio del diario para llevarlo a la escala del gráfico. El
// bróker cotiza la plata multiplicada por 100 (6.406,5 en el diario = 64,065 $/onza en
// XAGUSD), así que sin esto las marcas de esas operaciones se salían del gráfico y las
// velas quedaban aplastadas. Medido contra las velas: la razón es 99,6 de mediana en plata
// y 1,00 en oro, DAX y FTSE, que por eso no aparecen aquí.
export const FACTOR_PRECIO = { XAGUSD: 100 }

// Cuánto vale un punto respecto al tamaño de la posición, para el PNL en dinero del diario,
// que no trae columna de importe. El oro se cotiza "per 0.1", así que su punto vale 10× el
// tamaño. Comprobado contra el P.L real del bróker en el historial: con este factor,
// puntos × |tamaño| coincide con su importe en el 97,7% de las operaciones de 2026 (el
// resto baila unos céntimos porque el diario redondea la diferencia a un decimal).
const MULTIPLICADOR_PNL = { 'Gold (per 0.1)': 10 }

function pnlDelDiario(producto, puntos, size) {
  if (!Number.isFinite(size) || !Number.isFinite(puntos)) return null
  return puntos * Math.abs(size) * (MULTIPLICADOR_PNL[producto] ?? 1)
}

// PNL de una operación ya parseada. Las guardadas antes de que el parser lo calculara no
// traen el campo, así que se reconstruye con el tamaño en lugar de obligar a recargarlas.
export function pnlDeTrade(t) {
  if (Number.isFinite(t?.pnl)) return t.pnl
  return pnlDelDiario(t?.producto, t?.puntos, t?.size)
}

// Nombre de producto → token de instrumento usado en los nombres de archivo de las
// capturas locales ("Separados/DD-M-YY_TOKEN.jpg"), para poder cruzar cada operación
// con su foto vía /api/fotos del servidor local.
export const PRODUCTO_A_INSTRUMENTO = {
  'Germany 40':       'DAX',
  'UK 100':           'FTSE',
  'Wall Street 30':   'DOW',
  'US Tech 100':      'NASDAQ',
  'US 500 (Per 1.0)': 'SP500',
  'Gold (per 0.1)':   'GOLD',
  'Silver':           'SILVER',
}

// Las categorías del "Book of Horror": errores de PROCESO (no de resultado). Las 12
// primeras, tal cual están tituladas en la hoja "Scenarios" del diario de Google Sheets;
// la 13 solo existe en la app.
export const CATEGORIAS_HORROR = [
  { n: 1,  nombre: 'Adding aggressively and waiting', corto: 'Adding aggressively' },
  { n: 2,  nombre: 'Adding and letting it run and it quickly reverses', corto: 'Add + reversa rápida' },
  { n: 3,  nombre: 'Adding and not letting it run enough', corto: 'Add, corta pronto' },
  { n: 4,  nombre: 'Being afraid to add', corto: 'Miedo a añadir' },
  { n: 5,  nombre: 'Getting stopped out very frequently', corto: 'Stops frecuentes' },
  { n: 6,  nombre: 'Trade goes nowhere for too long', corto: 'No va a ningún lado' },
  { n: 7,  nombre: 'Being unable to pull the trigger and missing a good trade', corto: 'No apretar el gatillo' },
  { n: 8,  nombre: 'Adding too aggressively', corto: 'Adding muy agresivo' },
  { n: 9,  nombre: 'Not accepting the risk and exiting for no reason', corto: 'Salir sin motivo' },
  { n: 10, nombre: 'Stopped by 1 point', corto: 'Stop por 1 punto' },
  { n: 11, nombre: 'Flip the switch', corto: 'Flip the switch' },
  { n: 12, nombre: 'Not exiting manually and waiting for the stop to trigger when feeling incorrect', corto: 'No salir manualmente' },
  { n: 13, nombre: 'Entering with double the position size and getting stopped out', corto: 'Doble tamaño + stop' },
]

// La hoja "Scenarios" tiene una columna por categoría (cabecera "#1 ...", "#2 ...", etc.)
// y en cada columna, los números de sesión ("D53" → 53) que el usuario clasificó ahí.
function esCabeceraScenarios(fila) {
  if (!Array.isArray(fila)) return false
  const conNumero = fila.filter(c => typeof c === 'string' && /^#\d+/.test(c.trim()))
  return conNumero.length >= 3
}

// Devuelve { [numeroDeSesion]: [1, 8] } (una sesión puede estar en varias categorías)
function parseHojaScenarios(filas) {
  const iCab = filas.findIndex(esCabeceraScenarios)
  if (iCab === -1) return {}
  const cab = filas[iCab]
  const colACategoria = {}
  cab.forEach((c, i) => {
    const m = typeof c === 'string' && c.trim().match(/^#(\d+)/)
    if (m) {
      const n = parseInt(m[1], 10)
      if (n >= 1 && n <= CATEGORIAS_HORROR.length) colACategoria[i] = n
    }
  })

  const mapa = {}
  for (let i = iCab + 1; i < filas.length; i++) {
    const fila = filas[i]
    if (!fila) continue
    for (const [colStr, catN] of Object.entries(colACategoria)) {
      const valor = fila[Number(colStr)]
      const num = typeof valor === 'number' ? valor
        : (typeof valor === 'string' && /^\d+$/.test(valor.trim())) ? parseInt(valor, 10)
        : null
      if (num == null) continue
      if (!mapa[num]) mapa[num] = []
      if (!mapa[num].includes(catN)) mapa[num].push(catN)
    }
  }
  return mapa
}

// Años a los que NO se les aplica la clasificación de la hoja "Scenarios". La pestaña de
// DAY 2025 y la de DAY 2026 son copia una de otra —los mismos 25 números de sesión, hasta
// el mismo "NXT 68"—, así que esos números no son de 2025 y pintaban en sus operaciones
// etiquetas de otro año. Las de 2025 se dejan sin categoría hasta que se clasifiquen desde
// la propia app (Operaciones → Etiquetas), que las guarda por trade y no por nº de sesión.
const SIN_SCENARIOS = new Set([2025])

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
  const iSesion  = col('#')

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
    const size   = iSize !== -1 ? parseFloat(fila[iSize]) : null
    const puntos = iDif !== -1 && !isNaN(parseFloat(fila[iDif])) ? parseFloat(fila[iDif]) : closePrice - openPrice
    trades.push({
      producto,
      ticker:    PRODUCTO_A_TICKER[producto] ?? null,
      direccion: fila[iDir] ?? null,
      size,
      sesion:    iSesion !== -1 ? (fila[iSesion] ?? null) : null,
      categorias: [],
      openTime, openPrice,
      closeTime, closePrice,
      puntos,
      // el diario no tiene columna de importe: se reconstruye con el tamaño
      pnl: pnlDelDiario(producto, puntos, size),
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
      sesion:    null,
      categorias: [],
      openTime, openPrice,
      closeTime, closePrice,
      pnl: pl,   // aquí sí viene el importe real de la cuenta
      // "Puntos" = movimiento de precio en positivo-si-hay-beneficio, no el P&L en
      // divisa: se deshace el tamaño de la posición (P.L / Amount) para que sea
      // comparable con las operaciones del formato diario.
      puntos: !isNaN(size) && size !== 0 ? pl / size : (direccion === 'Sell' ? -diff : diff),
    })
  }
  return trades
}

// Detecta el formato de cada hoja por su contenido (no por su nombre) y arma la lista de
// operaciones: el diario "DAY <año>" (una hoja por año, cabecera -ENTRY-/-EXIT-), el
// "Historial de transacciones" de la cuenta completa (cabecera Transaction.Date/Open.Period)
// y la hoja "Scenarios" del Book of Horror, que no aporta operaciones directamente sino el
// cruce sesión→categoría que se aplica al final sobre las del diario.
// Compartido entre parseTradesXLSX (hojas de un .xlsx subido) y parseTradesDesdeAPI (hojas
// leídas directamente de Google Sheets vía el servidor local).
function hojasATrades(listaDeFilas) {
  const trades = []
  let scenariosMapa = {}
  let algunaHojaReconocida = false

  for (const filas of listaDeFilas) {
    const iCab = buscarFilaCabeceraDiario(filas)
    if (iCab !== -1) {
      algunaHojaReconocida = true
      trades.push(...parseHojaDiario(filas, iCab))
      continue
    }
    if (esCabeceraHistorial(filas[0])) {
      algunaHojaReconocida = true
      trades.push(...parseHojaHistorial(filas))
      continue
    }
    // Hoja "Scenarios" del Book of Horror (mismo libro que el diario): mapea número
    // de sesión ("D53" → 53) a las categorías de error de proceso ya clasificadas.
    const mapaHoja = parseHojaScenarios(filas)
    if (Object.keys(mapaHoja).length) {
      scenariosMapa = { ...scenariosMapa, ...mapaHoja }
    }
  }

  if (!algunaHojaReconocida) {
    throw new Error('No se encontró ninguna hoja con formato de operaciones reconocido (columnas -ENTRY-/-EXIT- o Transaction.Date/Open.Period)')
  }

  // Cruce sesión → categorías: solo aplica a las filas del diario, que sí llevan el
  // número de sesión ("#" → "D53"); el historial de cuenta no lo tiene.
  if (Object.keys(scenariosMapa).length) {
    for (const t of trades) {
      const m = typeof t.sesion === 'string' && t.sesion.match(/^D(\d+)$/)
      if (!m) continue
      if (SIN_SCENARIOS.has(new Date(t.openTime * 1000).getUTCFullYear())) continue
      const nums = scenariosMapa[parseInt(m[1], 10)]
      if (nums?.length) t.categorias = nums.map(n => CATEGORIAS_HORROR[n - 1])
    }
  }

  trades.sort((a, b) => a.openTime - b.openTime)
  return trades
}

// Import dinámico: xlsx solo se descarga cuando de verdad se sube un archivo,
// en vez de engordar el bundle principal de la app para todo el mundo.
export async function parseTradesXLSX(arrayBuffer) {
  const XLSX = await import('xlsx')
  // Sin cellDates: las celdas de fecha llegan como número de serie de Excel (no como
  // Date), para poder convertirlas nosotros mismos con celdaATimestamp() de forma fiable.
  const wb = XLSX.read(arrayBuffer, { type: 'array' })
  const listaDeFilas = wb.SheetNames.map(nombreHoja =>
    XLSX.utils.sheet_to_json(wb.Sheets[nombreHoja], { header: 1, raw: true, defval: null })
  )
  return hojasATrades(listaDeFilas)
}

// Mismo diario, pero leído directamente de Google Sheets vía el servidor local
// (endpoint /api/day-trades) en vez de tener que exportar y subir el .xlsx a mano.
export function parseTradesDesdeAPI({ log, scenarios }) {
  return hojasATrades([log, scenarios ?? []])
}

export const fmtFechaTS = ts => new Date(ts * 1000).toISOString().slice(0, 10)
export const fmtHoraTS  = ts => new Date(ts * 1000).toISOString().slice(11, 19)
