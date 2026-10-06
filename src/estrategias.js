import { madridOffsetAt, nuevaYorkOffsetAt } from './timezone'
import { SESIONES } from './segundaVelaCore'
import { HORA_FOMC_NY } from './fomc'

// Las estrategias que se pueden probar en la pestaña. Todas usan el mismo motor
// (analizarSesion): lo único que cambia es qué vela se braquetea, de qué tamaño y desde qué
// momento del día se empieza a contar.
export const ESTRATEGIAS = [
  {
    id: 'segunda-vela',
    label: 'SRS',
    nota: 'SRS: braquetea la segunda vela de 15 min desde la apertura del instrumento',
    minutosVela: 15,
    nBracket: 2,
    etiquetaVela: '15 min',
    // la única con histórico propio: el CSV del DAX cash a 5 min desde 2009
    admiteCsv: true,
  },
  {
    id: 'rule-of-4',
    label: 'Rule of 4 (FOMC)',
    nota: 'braquetea la cuarta vela de 10 min desde el comunicado del FOMC, solo esos días',
    minutosVela: 10,
    nBracket: 4,
    etiquetaVela: '10 min',
    admiteCsv: false,
    soloFomc: true,
  },
  {
    id: 'primera-vela-1h',
    label: 'Primera vela de 1 h',
    nota: 'braquetea la primera hora de la sesión: compra por encima de su máximo y vende por debajo de su mínimo',
    minutosVela: 60,
    nBracket: 1,
    etiquetaVela: '1 h',
    admiteCsv: true,
  },
]

export const estrategiaDe = id => ESTRATEGIAS.find(e => e.id === id) ?? ESTRATEGIAS[0]

// Minutos desde medianoche de Madrid de un timestamp UTC
const minutosMadrid = ts => Math.floor(((ts + madridOffsetAt(ts)) % 86400 + 86400) % 86400 / 60)

// Instante UTC en el que son las HH:MM de Nueva York de ese día. El desfase se mira sobre
// una aproximación a la misma hora en UTC: los cambios de horario de Nueva York ocurren a
// las 2 de la madrugada, muy lejos de las 14:00, así que la aproximación ya cae en el lado
// bueno del salto.
export function instanteNY(fecha, minutosNY) {
  const [a, m, d] = fecha.split('-').map(Number)
  const tentativo = Date.UTC(a, m - 1, d, Math.floor(minutosNY / 60), minutosNY % 60) / 1000
  return tentativo - nuevaYorkOffsetAt(tentativo)
}

// Agrupa velas pequeñas en velas de `minutos`, con los cubos anclados en `desdeTs` (no en
// las horas en punto): la Rule of 4 cuenta sus velas de 10 min desde el comunicado, no
// desde las 20:00 del reloj.
export function agruparVelas(velas, minutos, desdeTs) {
  const paso  = minutos * 60
  const cubos = new Map()
  for (const v of velas) {
    if (v.time < desdeTs) continue
    const ini = desdeTs + Math.floor((v.time - desdeTs) / paso) * paso
    const g   = cubos.get(ini)
    if (!g) cubos.set(ini, { time: ini, open: v.open, high: v.high, low: v.low, close: v.close })
    else {
      g.high  = Math.max(g.high, v.high)
      g.low   = Math.min(g.low, v.low)
      g.close = v.close
    }
  }
  return [...cubos.values()].sort((a, b) => a.time - b.time)
}

// Las descargas llegan siempre en velas de 15 min, del feed o del CSV del DAX. Las
// estrategias que braquetean otra vela se las agrupan aquí, ancladas en la apertura de la
// sesión y no en las horas en punto: Nueva York abre a y media, así que las velas horarias
// del feed partirían la primera hora por la mitad. Las de 15 min se quedan como finas, que
// es sobre lo que se camina el recorrido.
export function prepararSesion(estr, ticker, velas15) {
  const ses = SESIONES[ticker]
  if (!ses || !velas15?.length || estr.minutosVela === 15) {
    return { velas: velas15, finas: null, ventana: null }
  }
  const apertura = velas15.find(v => minutosMadrid(v.time) >= ses.open)
  const ventana  = { ...ses, minutosVela: estr.minutosVela, nBracket: estr.nBracket }
  // sin apertura no hay nada que agrupar: se devuelven tal cual y el motor dirá por qué no vale
  if (!apertura) return { velas: velas15, finas: null, ventana }
  return {
    velas: agruparVelas(velas15, estr.minutosVela, apertura.time),
    finas: velas15,
    ventana,
  }
}

// La ventana que mira la Rule of 4 ese día: desde el comunicado hasta el cierre de Wall
// Street, dos horas más tarde.
export function ventanaRuleOf4(fecha) {
  const inicioTs = instanteNY(fecha, HORA_FOMC_NY)
  const open     = minutosMadrid(inicioTs)
  return {
    open,
    close: open + 120,
    minutosVela: 10,
    nBracket: 4,
    etiqueta: 'Ventana FOMC',
    plaza: 'Nueva York',
    inicioTs,
  }
}
