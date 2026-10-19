// Lo que comparten la pestaña Gráfico (Grafico.jsx) y cada uno de sus paneles
// (PanelGrafico.jsx): temporalidades, fuentes de datos y de qué serie son los dibujos.
// Va aparte porque un archivo de componentes solo debe exportar componentes (recarga en
// caliente de Vite).
import { INSTRUMENTOS } from './intradayApi'
import { hayIg } from './claveBot'

export const TEMPORALIDADES = [
  { id: 'm1',  label: '1m',  minutos: 1 },
  { id: 'm5',  label: '5m',  minutos: 5 },
  { id: 'm15', label: '15m', minutos: 15 },
  { id: 'm30', label: '30m', minutos: 30 },
  { id: 'h1',  label: '1h',  minutos: 60 },
  { id: 'h4',  label: '4h',  minutos: 240 },
  { id: 'd1',  label: 'D',   minutos: 1440 },
]

export const FUENTES = [
  { id: 'duka',  label: 'Dukascopy', title: 'CFD de Dukascopy: 24 h y años de histórico' },
  { id: 'mt5',   label: 'MT5',       title: 'CFD de tu MetaTrader 5 (MetaQuotes-Demo), solo en local: 24 h, a 1 min desde 2017 (Russell 2018, Nikkei 2019, Nasdaq 2022, oro 2004). Falta del 16-jul al 5-sep-2025 y de oct-2024 a ene-2025 hay días congelados. Sin FTSE ni petróleo' },
  { id: 'yahoo', label: 'Yahoo',     title: 'Contado de los índices (oro, plata y petróleo, con el futuro). Hasta 30 días a 1m, 60 días de 5 a 30m, 2 años en 1h y 4h, y el diario completo' },
  { id: 'csv',   label: 'CSV cash',  title: 'Tu CSV del DAX cash a 5 min: solo sesión, desde 2009' },
  { id: 'ig',    label: 'IG en directo', title: 'Precios de IG (su CFD) con la última vela moviéndose en directo. Necesita las claves de IG en server/.env' },
]

// Un mercado cualquiera de IG, abierto buscándolo: su ticker es `ig:` + su epic
// (ig:CS.D.EURUSD.CEC.IP) y solo se ve con la fuente IG. Los que se abren se
// guardan con su nombre para tenerlos a mano en el selector.
export const PREFIJO_IG = 'ig:'
export const esMercadoIg = ticker => typeof ticker === 'string' && ticker.startsWith(PREFIJO_IG)

const MERCADOS_IG = 'sa.grafico.ig'
const MAX_MERCADOS_IG = 30
let mercadosIg = null
export function mercadosIgGuardados() {
  if (!mercadosIg) {
    try { mercadosIg = JSON.parse(localStorage.getItem(MERCADOS_IG)) } catch { /* sin almacenamiento */ }
    if (!Array.isArray(mercadosIg)) mercadosIg = []
  }
  return mercadosIg
}
function escribirMercadosIg(lista) {
  mercadosIg = lista
  try { localStorage.setItem(MERCADOS_IG, JSON.stringify(lista)) } catch { /* sin almacenamiento */ }
  return lista
}
// El último abierto, el primero
export const recordarMercadoIg = ({ ticker, nombre }) =>
  escribirMercadosIg([{ ticker, nombre: nombre?.trim() || ticker.slice(PREFIJO_IG.length) }, ...mercadosIgGuardados().filter(m => m.ticker !== ticker)].slice(0, MAX_MERCADOS_IG))
export const olvidarMercadoIg = ticker => escribirMercadosIg(mercadosIgGuardados().filter(m => m.ticker !== ticker))

// Decimales de un mercado de IG según lo que cotiza: dos para índices, oro y acciones, y los
// que hagan falta en las divisas (EUR/USD 1,12388; USD/JPY 150,123)
export const decimalesDe = precio => (!(precio > 0) || precio >= 200 ? 2 : precio >= 20 ? 3 : precio >= 2 ? 4 : 5)


// Lo que tiene MetaQuotes-Demo (server/mt5.js): sin FTSE, que dejó de cotizar en mayo de 2026,
// ni petróleo
const CON_MT5 = new Set(['^GDAXI', '^GSPC', '^NDX', '^DJI', '^RUT', '^N225', 'XAUUSD', 'XAGUSD'])

// Yahoo no da el spot de estos: los sirve con el futuro (GC=F, SI=F y CL=F en el servidor)
const CON_FUTURO_EN_YAHOO = new Set(['XAUUSD', 'XAGUSD', 'USOIL'])

// Los dibujos van con la serie de precios, no con la fuente: el CSV y Yahoo dan el mismo
// contado del DAX (coinciden al céntimo) y los comparten; el CFD de Dukascopy y los futuros
// de Yahoo cotizan a otro precio y llevan los suyos. El CFD de MT5 comparte los de
// Dukascopy: los dos son CFD de 24 h sobre el contado, y MT5 lo sustituye mientras
// Dukascopy no responde.
export function claveDibujosDe(ticker, fuente) {
  if (fuente === 'duka' || fuente === 'mt5') return ticker
  if (fuente === 'ig') return `${ticker}@ig`
  if (fuente === 'yahoo' && CON_FUTURO_EN_YAHOO.has(ticker)) return `${ticker}@futuro`
  return `${ticker}@contado`
}

// Fuentes que tiene un instrumento: el CSV del DAX cash está en tu disco, así que solo existe
// en local y solo para el DAX; MT5, solo en local (el terminal está en este ordenador); IG,
// en local o con la clave del bot guardada (en producción el servidor la pide); un mercado
// suelto de IG, solo IG
export function fuentesDe(ticker) {
  const conIg = hayIg()
  if (esMercadoIg(ticker)) return conIg ? FUENTES.filter(f => f.id === 'ig') : []
  const hayCsv = import.meta.env.DEV && ticker === '^GDAXI'
  const hayMt5 = import.meta.env.DEV && CON_MT5.has(ticker)
  return FUENTES.filter(f => (f.id !== 'ig' || conIg) && (f.id !== 'csv' || hayCsv) && (f.id !== 'mt5' || hayMt5))
}

// Lo que de verdad pinta un panel con su configuración guardada: sin la fuente elegida, la
// primera que tenga (Dukascopy, o IG en un mercado suelto); con el CSV, que va a 5 min, 1 min
// pasa a 5
export function configDe({ ticker, tf, fuente }) {
  const disponibles = fuentesDe(ticker)
  // sin IG (en producción, sin la clave del bot) un mercado de IG no tiene con qué verse
  if (!disponibles.length) return { ticker: '^GDAXI', fuente: 'duka', tf }
  const f = disponibles.some(x => x.id === fuente) ? fuente : disponibles[0].id
  return { ticker, fuente: f, tf: f === 'csv' && tf === 'm1' ? 'm5' : tf }
}

export const nombreDe = ticker => INSTRUMENTOS.find(i => i.value === ticker)?.label
  ?? mercadosIgGuardados().find(m => m.ticker === ticker)?.nombre
  ?? (esMercadoIg(ticker) ? ticker.slice(PREFIJO_IG.length) : ticker)
