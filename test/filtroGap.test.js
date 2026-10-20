// Tests de los filtros del Gap Filter (src/filtroGapCore.js):
//   npm test
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FILTROS_INICIALES, fechasEspeciales, filtrarSesiones, contarOpciones, hayFiltros,
} from '../src/filtroGapCore.js'

// Una sesión como las que manda /api/gap-filter
const sesion = (date, dayOfWeek, gapPct, puntos, eventos = []) => ({
  date, dayOfWeek, gapPct, gapDir: gapPct >= 0 ? 'up' : 'down',
  prevClose: 1000, openPrice: 1000 + puntos, eventos,
})

// Del jueves 26 de febrero al martes 3 de marzo de 2026; el 25 da el cierre de la primera
const SESIONES = [
  sesion('2026-02-26', 4,  0.6,   6, ['CPI']),
  sesion('2026-02-27', 5, -0.2,  -2),
  sesion('2026-03-02', 1,  1.2,  12, ['FOMC']),
  sesion('2026-03-03', 2, -0.8,  -8, ['FESTIVO']),
]
const ESP = fechasEspeciales(SESIONES, '2026-02-25', '2026-10')

const con = cambios => ({ ...FILTROS_INICIALES, ...cambios })
const fechas = lista => lista.map(s => s.date)

test('sin filtros pasan todas', () => {
  assert.deepEqual(fechas(filtrarSesiones(SESIONES, FILTROS_INICIALES, ESP)), fechas(SESIONES))
  assert.equal(hayFiltros(FILTROS_INICIALES), false)
})

test('primer y último día de negociación del mes y del trimestre', () => {
  assert.ok(ESP.ultimoMes.has('2026-02-27'))
  assert.ok(ESP.primerMes.has('2026-03-02'))
  // marzo no abre trimestre: los abren enero, abril, julio y octubre
  assert.equal(ESP.primerTrim.size, 0)
  // el 25 de febrero es el primero que hay del mes, no la primera sesión del periodo
  assert.ok(!ESP.primerMes.has('2026-02-26'))
})

test('el mes en curso no tiene último día todavía', () => {
  const esp = fechasEspeciales(SESIONES, '2026-02-25', '2026-03')
  assert.ok(!esp.ultimoMes.has('2026-03-03'))
  assert.ok(esp.ultimoMes.has('2026-02-27'))
})

test('días de la semana, dirección y gap mínimo a la vez', () => {
  const f = con({ dias: new Set([1, 2, 4]), dir: 'up', gapMin: 1 })
  assert.deepEqual(fechas(filtrarSesiones(SESIONES, f, ESP)), ['2026-03-02'])
})

test('el gap mínimo vale en los dos sentidos y en puntos', () => {
  assert.deepEqual(fechas(filtrarSesiones(SESIONES, con({ gapMin: 0.7 }), ESP)), ['2026-03-02', '2026-03-03'])
  assert.deepEqual(fechas(filtrarSesiones(SESIONES, con({ gapMin: 6, gapModo: 'pts' }), ESP)),
    ['2026-02-26', '2026-03-02', '2026-03-03'])
})

test('dentro de un grupo basta con una opción', () => {
  const f = con({ eventos: new Set(['CPI', 'FOMC']) })
  assert.deepEqual(fechas(filtrarSesiones(SESIONES, f, ESP)), ['2026-02-26', '2026-03-02'])
  const g = con({ diasEsp: new Set(['ultimoMes', 'festivo']) })
  assert.deepEqual(fechas(filtrarSesiones(SESIONES, g, ESP)), ['2026-02-27', '2026-03-03'])
})

test('cada opción cuenta con los demás grupos, no con su propio grupo', () => {
  const f = con({ dir: 'down', dias: new Set([5]) })
  const c = contarOpciones(SESIONES, f, ESP, {
    umbrales: [0, 0.5], eventos: ['CPI', 'FOMC'], diasEsp: ['festivo'],
  })
  // a la baja: el viernes 27 y el martes 3, sea cual sea el día marcado
  assert.deepEqual(c.dias, { 1: 0, 2: 1, 3: 0, 4: 0, 5: 1 })
  // el viernes: uno a la baja y ninguno al alza
  assert.deepEqual(c.dir, { both: 1, up: 0, down: 1 })
  assert.deepEqual(c.gap, { 0: 1, 0.5: 0 })
  assert.deepEqual(c.eventos, { CPI: 0, FOMC: 0 })
  assert.deepEqual(c.diasEsp, { festivo: 0 })
})

test('hay filtros en cuanto uno cambia', () => {
  assert.equal(hayFiltros(con({ dias: new Set([1]) })), true)
  assert.equal(hayFiltros(con({ gapMin: 0.25 })), true)
  assert.equal(hayFiltros(con({ eventos: new Set(['NFP']) })), true)
})
