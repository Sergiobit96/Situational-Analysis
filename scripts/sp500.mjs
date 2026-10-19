// Saca de Wikipedia la lista de empresas del S&P 500 (ticker, nombre, sector GICS y fecha en
// que entró en el índice) y la deja en server/sp500.json, que es el universo de las tortugas
// en acciones de EE. UU. (pestaña Estrategias). La lista es la de hoy: el backtest la usa con
// la fecha de entrada de cada una para no operar una acción antes de que estuviera en el índice.
//
// Uso: node scripts/sp500.mjs            (descarga la página)
//      node scripts/sp500.mjs pagina.html (lee una ya guardada)

import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')
const URL_WIKI = 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies'
const SECTORES = {
  'Communication Services': 'Comunicaciones',
  'Consumer Discretionary': 'Consumo discrecional',
  'Consumer Staples':       'Consumo básico',
  'Energy':                 'Energía',
  'Financials':             'Financiero',
  'Health Care':            'Salud',
  'Industrials':            'Industria',
  'Information Technology': 'Tecnología',
  'Materials':              'Materiales',
  'Real Estate':            'Inmobiliario',
  'Utilities':              'Servicios públicos',
}

const texto = html => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&nbsp;|&#160;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/\s+/g, ' ').trim()

const html = process.argv[2]
  ? readFileSync(process.argv[2], 'utf8')
  : await (await fetch(URL_WIKI, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } })).text()
const inicio = html.indexOf('id="constituents"')
if (inicio < 0) throw new Error('No está la tabla "constituents" en la página')
const tabla = html.slice(inicio, html.indexOf('</table>', inicio))

const acciones = []
for (const fila of tabla.split(/<tr[\s>]/).slice(1)) {
  const celdas = [...fila.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => texto(m[1]))
  if (celdas.length < 6) continue
  const [ticker, nombre, sectorIngles, , , alta] = celdas
  const sector = SECTORES[sectorIngles]
  if (!sector) throw new Error(`Sector desconocido: ${sectorIngles} (${ticker})`)
  acciones.push({ ticker, nombre, sector, alta: /^\d{4}-\d{2}-\d{2}$/.test(alta) ? alta : null })
}
if (acciones.length < 490) throw new Error(`Solo ${acciones.length} empresas: la tabla ha cambiado de formato`)
acciones.sort((a, b) => a.ticker.localeCompare(b.ticker))

const salida = { fuente: URL_WIKI, fecha: new Date().toISOString().slice(0, 10), acciones }
writeFileSync(join(RAIZ, 'server', 'sp500.json'), `${JSON.stringify(salida, null, 1)}\n`)
const sinFecha = acciones.filter(a => !a.alta).map(a => a.ticker)
console.log(`${acciones.length} empresas en ${new Set(acciones.map(a => a.sector)).size} sectores${sinFecha.length ? `; sin fecha de entrada: ${sinFecha.join(', ')}` : ''}`)
