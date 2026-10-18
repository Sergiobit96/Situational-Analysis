// Tests de las estadísticas de las operaciones reales (src/estadisticas.js)
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  unidadesDe, resumen, desglose, DESGLOSES, MIN_MUESTRA,
  excursionesPorInstrumento, eficienciaDeSalida, claveDeExcursion, percentil, mediana,
} from '../src/estadisticas.js'

// Hora de pared de Madrid guardada como si fuera UTC, igual que en el diario
const madrid = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000

let n = 0
const op = (pnl, cambios = {}) => {
  n++
  const openTime = cambios.openTime ?? madrid(2026, 2, 2, 9, 0) + n * 600
  return {
    producto: 'Germany 40', ticker: '^GDAXI', direccion: 'LONG', categorias: [],
    openPrice: 100, closePrice: 100 + pnl, puntos: pnl, pnl,
    openTime, closeTime: openTime + 300,
    ...cambios,
  }
}
const desgloseDe = (id, unidades) => {
  const d = DESGLOSES.find(x => x.id === id)
  return desglose(unidades, d.clave, d)
}

test('resumen: acierto, profit factor, esperanza y ratio', () => {
  const r = resumen(unidadesDe([op(100), op(-50), op(-20), op(30), op(0)]))
  assert.equal(r.n, 5)
  assert.equal(r.ganadoras, 2)
  assert.equal(r.perdedoras, 2)
  assert.equal(r.empates, 1)
  assert.equal(r.acierto, 40)
  assert.equal(r.total, 60)
  assert.equal(r.media, 12)
  assert.equal(r.profitFactor, 130 / 70)
  assert.equal(r.ratio, 65 / 35)
  assert.equal(r.mediana, 0)
  assert.equal(r.mejor, 100)
  assert.equal(r.peor, -50)
})

test('sin ninguna pérdida el profit factor es infinito, y sin nada no hay', () => {
  assert.equal(resumen(unidadesDe([op(10), op(5)])).profitFactor, Infinity)
  assert.equal(resumen([]).profitFactor, null)
  assert.equal(resumen([]).acierto, null)
})

test('en puntos cuenta lo que dice el diario, no el importe', () => {
  const r = resumen(unidadesDe([op(10, { pnl: 250 })], { medida: 'puntos' }))
  assert.equal(r.total, 10)
})

test('por sesión suma las piernas del mismo día e instrumento y junta sus etiquetas', () => {
  const dia = madrid(2026, 3, 4, 9, 0)
  const trades = [
    op(40, { openTime: dia, categorias: [{ n: 1 }] }),
    op(-10, { openTime: dia + 900, direccion: 'SHORT' }),
    op(5, { openTime: dia + 1800, producto: 'UK 100' }),
  ]
  const anotaciones = { '2026-03-04_DAX': { cats: [8] } }
  const sesiones = unidadesDe(trades, { modo: 'sesion', anotaciones })
  assert.equal(sesiones.length, 2)
  const dax = sesiones.find(s => s.producto === 'Germany 40')
  assert.equal(dax.valor, 30)
  assert.equal(dax.piernas, 2)
  assert.equal(dax.lado, 'ambos')
  assert.deepEqual([...dax.cats].sort(), [1, 8])
})

test('las franjas van en hora de Madrid, de media hora en media hora', () => {
  const filas = desgloseDe('franja', unidadesDe([
    op(10, { openTime: madrid(2026, 2, 2, 9, 5) }),
    op(-5, { openTime: madrid(2026, 2, 2, 9, 29) }),
    op(7, { openTime: madrid(2026, 2, 2, 15, 31) }),
  ]))
  assert.deepEqual(filas.map(f => [f.etiqueta, f.n, f.total]), [
    ['09:00–09:30', 2, 5],
    ['15:30–16:00', 1, 7],
  ])
})

test(`los grupos de menos de ${MIN_MUESTRA} salen marcados como poca muestra`, () => {
  const muchas = Array.from({ length: MIN_MUESTRA }, () => op(1, { openTime: madrid(2026, 2, 2, 10, 0) }))
  const filas = desgloseDe('franja', unidadesDe([...muchas, op(1, { openTime: madrid(2026, 2, 2, 16, 0) })]))
  assert.deepEqual(filas.map(f => f.poca), [false, true])
})

test('una sesión con dos errores del Book of Horror cuenta en los dos, y lo no etiquetado va al final', () => {
  const filas = desgloseDe('categoria', unidadesDe([
    op(-30, { categorias: [{ n: 5 }, { n: 2 }] }),
    op(20),
  ]))
  assert.deepEqual(filas.map(f => [f.clave, f.total]), [[2, -30], [5, -30], [0, 20]])
  assert.equal(filas[2].etiqueta, 'Sin etiqueta')
})

test('los días de la semana empiezan en lunes', () => {
  const filas = desgloseDe('dia', unidadesDe([
    op(1, { openTime: madrid(2026, 2, 8, 10) }),   // domingo
    op(1, { openTime: madrid(2026, 2, 2, 10) }),   // lunes
  ]))
  assert.deepEqual(filas.map(f => f.etiqueta), ['Lunes', 'Domingo'])
})

test('MFE/MAE por instrumento: medianas, eficiencia de salida y perdedoras que iban ganando', () => {
  const a = op(10), b = op(4), c = op(-6), d = op(-6)
  const resultados = {
    [claveDeExcursion(a)]: { mfe: 20, mae: -2, realizado: 10 },
    [claveDeExcursion(b)]: { mfe: 5,  mae: -8, realizado: 4 },
    [claveDeExcursion(c)]: { mfe: 7,  mae: -6, realizado: -6 },   // llegó a ir +7 y perdió 6
    [claveDeExcursion(d)]: { mfe: 1,  mae: -9, realizado: -6 },
  }
  const [fila] = excursionesPorInstrumento([a, b, c, d, op(3)], resultados)
  assert.equal(fila.n, 4)
  assert.equal(fila.mfeMediano, 6)
  assert.equal(fila.maeMediano, -7)
  assert.equal(fila.eficiencia, (50 + 80) / 2)
  assert.equal(fila.maeGanadorasP90, -8)
  assert.equal(fila.perdedorasQueIbanGanando, 50)
  assert.equal(eficienciaDeSalida([a, b], resultados).eficiencia, 65)
})

test('lo que no tiene velas no entra en el MFE/MAE', () => {
  const a = op(10)
  assert.deepEqual(excursionesPorInstrumento([a], { [claveDeExcursion(a)]: { sinDatos: 'sin velas en el tramo' } }), [])
})

test('mediana y percentil', () => {
  assert.equal(mediana([3, 1, 2]), 2)
  assert.equal(mediana([4, 1, 2, 3]), 2.5)
  assert.equal(percentil([-10, -1, -3, -5, -2], 0.1), -10)
  assert.equal(mediana([]), null)
})
