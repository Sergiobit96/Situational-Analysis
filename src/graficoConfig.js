// Lo que comparten la pestaña Gráfico (Grafico.jsx) y cada uno de sus paneles
// (PanelGrafico.jsx): temporalidades, fuentes de datos y de qué serie son los dibujos.
// Va aparte porque un archivo de componentes solo debe exportar componentes (recarga en
// caliente de Vite).
import { INSTRUMENTOS } from './intradayApi'

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
  { id: 'yahoo', label: 'Yahoo',     title: 'Contado de los índices (oro, plata y petróleo, con el futuro). Hasta 30 días a 1m, 60 días de 5 a 30m, 2 años en 1h y 4h, y el diario completo' },
  { id: 'csv',   label: 'CSV cash',  title: 'Tu CSV del DAX cash a 5 min: solo sesión, desde 2009' },
  { id: 'ig',    label: 'IG en directo', title: 'Precios de IG (su CFD) con la última vela moviéndose en directo. Necesita las claves de IG en server/.env' },
]

// Las que solo existen en local: el CSV está en tu disco y la conexión con IG la abre tu servidor
const SOLO_LOCAL = new Set(['csv', 'ig'])

// Yahoo no da el spot de estos: los sirve con el futuro (GC=F, SI=F y CL=F en el servidor)
const CON_FUTURO_EN_YAHOO = new Set(['XAUUSD', 'XAGUSD', 'USOIL'])

// Los dibujos van con la serie de precios, no con la fuente: el CSV y Yahoo dan el mismo
// contado del DAX (coinciden al céntimo) y los comparten; el CFD de Dukascopy y los futuros
// de Yahoo cotizan a otro precio y llevan los suyos.
export function claveDibujosDe(ticker, fuente) {
  if (fuente === 'duka') return ticker
  if (fuente === 'ig') return `${ticker}@ig`
  if (fuente === 'yahoo' && CON_FUTURO_EN_YAHOO.has(ticker)) return `${ticker}@futuro`
  return `${ticker}@contado`
}

// Fuentes que tiene un instrumento: el CSV del DAX cash solo existe en local y solo para el DAX
export function fuentesDe(ticker) {
  const hayCsv = import.meta.env.DEV && ticker === '^GDAXI'
  return FUENTES.filter(f => (!SOLO_LOCAL.has(f.id) || import.meta.env.DEV) && (f.id !== 'csv' || hayCsv))
}

// Lo que de verdad pinta un panel con su configuración guardada: sin la fuente elegida,
// Dukascopy; con el CSV, que va a 5 min, 1 min pasa a 5
export function configDe({ ticker, tf, fuente }) {
  const f = fuentesDe(ticker).some(x => x.id === fuente) ? fuente : 'duka'
  return { ticker, fuente: f, tf: f === 'csv' && tf === 'm1' ? 'm5' : tf }
}

export const nombreDe = ticker => INSTRUMENTOS.find(i => i.value === ticker)?.label ?? ticker
