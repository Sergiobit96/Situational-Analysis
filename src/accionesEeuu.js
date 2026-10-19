// Las acciones del S&P 500 para las tortugas (pestaña Estrategias): de lo que manda el
// servidor (server/acciones-eeuu.js) a lo que usa el motor (src/tortugas.js).

import { prepararColumnas } from './tortugas.js'

// IG, CFD de acciones de EE. UU.: 2 centavos por acción y 15 $ como mínimo por orden, acciones
// enteras y el spread del mercado de contado (unos 4 puntos básicos de media en el S&P 500)
export const COMISION_ACCIONES_EEUU = { porAccion: 0.02, minimo: 15 }
const SPREAD_ACCIONES = 0.0004

// Lo que el motor necesita saber de una acción del universo ({ ticker, nombre, sector, alta })
export const infoAccion = a => ({
  id: a.ticker, ticker: a.ticker, nombre: a.nombre, grupo: a.sector, alta: a.alta,
  zona: 'America/New_York', cierre: '16:00', desde: '1900-01-01',
  spread: SPREAD_ACCIONES, dividendo: 0, comision: COMISION_ACCIONES_EEUU, lote: 1,
})

// Las fechas, por día desde 1970: todas las acciones comparten calendario, así que cada fecha
// se escribe una vez y las 500 series apuntan al mismo texto (son millones de velas)
const fechas = []
const fechaDe = dia => (fechas[dia] ??= new Date(dia * 86_400_000).toISOString().slice(0, 10))

// La serie codificada ({ f0, dd, dec, p, div, sp }) en columnas: la primera fecha y los días
// entre una y otra; por vela, cuatro enteros (apertura − cierre anterior, máximo − el mayor de
// apertura y cierre, el menor de los dos − mínimo y cierre − apertura) con `dec` decimales;
// los dividendos como [índice, importe] y los splits como [índice, acciones nuevas por vieja].
// Es la inversa de codificarSerie del servidor.
//
// Los precios de Yahoo están ajustados por los splits que vinieron después: Apple valía 35 $
// en 1990, pero en la serie sale a 0,31 porque desde entonces cada acción se ha partido en 112.
// `f` dice cuántas acciones de la serie eran una de verdad ese día (el producto de los splits
// posteriores): con él, el motor cuenta la comisión por acción y las acciones enteras en
// acciones de las de entonces. `div` va solo con los días que hay dividendo.
export function decodificarColumnas({ f0, dd, dec, p, div, sp }) {
  const n = p.length / 4, f = 10 ** dec
  const cols = { fechas: new Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), div: null, f: null }
  let dia = f0 ? Math.round(Date.parse(`${f0}T00:00:00Z`) / 86_400_000) : 0, cierre = 0
  for (let i = 0; i < n; i++) {
    if (i) dia += dd[i - 1]
    const o = cierre + p[4 * i], c = o + p[4 * i + 3]
    cols.fechas[i] = fechaDe(dia)
    cols.o[i] = o / f
    cols.h[i] = (Math.max(o, c) + p[4 * i + 1]) / f
    cols.l[i] = (Math.min(o, c) - p[4 * i + 2]) / f
    cols.c[i] = c / f
    cierre = c
  }
  if (div?.length) cols.div = Object.fromEntries(div.filter(([i]) => i < n))
  if (sp?.length) {
    const split = new Map(sp)
    cols.f = new Float64Array(n)
    let x = 1
    for (let i = n - 1; i >= 0; i--) {
      cols.f[i] = x
      x *= split.get(i) ?? 1
    }
  }
  return cols
}

// Lo mismo en velas ({ date, open, high, low, close, div?, f? })
export function decodificarSerie(serie) {
  const cols = decodificarColumnas(serie)
  return cols.fechas.map((date, i) => ({
    date, open: cols.o[i], high: cols.h[i], low: cols.l[i], close: cols.c[i],
    ...(cols.div?.[i] ? { div: cols.div[i] } : {}), ...(cols.f && cols.f[i] !== 1 ? { f: cols.f[i] } : {}),
  }))
}

// Una acción lista para el motor, sin pasar por velas (con 500 acciones serían millones de
// objetos) y con las series en Float32Array
export const prepararAccion = (accion, serie) => prepararColumnas(infoAccion(accion), decodificarColumnas(serie), { compacto: true })
