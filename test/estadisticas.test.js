// Tests de las estadísticas de las operaciones reales (src/estadisticas.js)
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  unidadesDe, resumen, desglose, DESGLOSES, MIN_MUESTRA,
  excursionesPorInstrumento, eficienciaDeSalida, claveDeExcursion, percentil, mediana,
  simular, cifrasDe, porAnio, contextoDeSesiones, desglosesDeContexto, expedienteDelDia,
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

// ── Simulador ──
// Un día con horas a mano: [hora de entrada, minutos abierta, euros]
const dia = (fecha, ops) => ops.map(([h, m, abierta, pnl], i) => {
  const [y, mo, d] = fecha.split('-').map(Number)
  const openTime = madrid(y, mo, d, h, m) + i   // + i: dos entradas no comparten segundo
  return op(pnl, { openTime, closeTime: openTime + abierta * 60, size: 1 })
})

test('el stop diario deja fuera el resto del día, aunque luego cierre en positivo una que seguía abierta', () => {
  const trades = dia('2026-03-02', [
    [9, 0, 120, 300],    // abierta hasta las 11:00, acaba +300
    [9, 10, 5, -400],    // cierra 9:15: lo cerrado baja a −400
    [9, 30, 5, -50],     // fuera por el stop (−400 ≤ −300)
    [12, 0, 5, 80],      // a las 12 lo cerrado ya sería −100, pero el día está parado
  ])
  const s = simular(trades, { stopDiario: 300 })
  assert.equal(cifrasDe(s.real).total, -70)
  assert.equal(cifrasDe(s.simulado).total, -100)
  assert.equal(s.quitadas.stopDiario, 2)
  assert.equal(s.diasCortados, 1)
})

test('máximo de operaciones, días fuera y franja horaria', () => {
  const lunes = dia('2026-03-02', [[9, 0, 5, 10], [9, 30, 5, 20], [10, 0, 5, 30]])
  const martes = dia('2026-03-03', [[16, 0, 5, 40]])
  assert.equal(cifrasDe(simular([...lunes, ...martes], { maxOperaciones: 2 }).simulado).total, 70)
  assert.equal(cifrasDe(simular([...lunes, ...martes], { diasFuera: [0] }).simulado).total, 40)
  assert.equal(cifrasDe(simular([...lunes, ...martes], { desde: '09:15', hasta: '15:30' }).simulado).total, 50)
})

test('el stop fijo usa el MAE: corta la perdedora grande y también la ganadora que pasó por él', () => {
  const [grande, ganadora, pequena] = dia('2026-03-02', [[9, 0, 5, -60], [9, 10, 5, 50], [9, 20, 5, -10]])
  const resultados = {
    [claveDeExcursion(grande)]:  { mfe: 5,  mae: -60, realizado: -60 },
    [claveDeExcursion(ganadora)]: { mfe: 60, mae: -45, realizado: 50 },
    [claveDeExcursion(pequena)]:  { mfe: 8,  mae: -12, realizado: -10 },
  }
  const s = simular([grande, ganadora, pequena], { stopFijo: 40 }, { medida: 'puntos', resultados })
  assert.deepEqual(s.simulado.map(u => u.valor), [-40, -40, -10])
  assert.equal(s.recortadas, 2)
})

test('el stop fijo en euros vale los puntos por el tamaño', () => {
  const [t] = dia('2026-03-02', [[9, 0, 5, -60]])
  const conTamano = { ...t, size: -2, puntos: -30 }
  const resultados = { [claveDeExcursion(conTamano)]: { mfe: 1, mae: -30, realizado: -30 } }
  assert.equal(simular([conTamano], { stopFijo: 20 }, { resultados }).simulado[0].valor, -40)
})

test('real frente a simulado, año a año', () => {
  const trades = [...dia('2025-03-03', [[9, 0, 5, -500], [10, 0, 5, -100]]), ...dia('2026-03-02', [[9, 0, 5, 30]])]
  const s = simular(trades, { stopDiario: 400 })
  assert.deepEqual(porAnio(s.real, s.simulado), [
    { anio: 2025, real: -600, simulado: -500 },
    { anio: 2026, real: 30, simulado: 30 },
  ])
})

// ── Contexto de mercado ──
const sesion = (date, cambios = {}) => ({
  date, gapPct: 0.6, prevClose: 100, prevHigh: 102, prevLow: 98, openPrice: 100.6, eventos: [], ...cambios,
})

test('contexto de cada sesión: apertura frente al rango de ayer y volatilidad relativa', () => {
  const previas = Array.from({ length: 12 }, (_, i) => sesion(`2026-01-${String(i + 1).padStart(2, '0')}`))
  const ctx = contextoDeSesiones([
    ...previas,
    sesion('2026-01-20', { openPrice: 103, prevHigh: 105, prevLow: 95, eventos: ['FOMC'] }),
  ])
  const c = ctx.get('2026-01-20')
  assert.equal(c.apertura, 'dentro')
  assert.equal(c.rangoRel, 10 / 4)
  assert.deepEqual(c.eventos, ['FOMC'])
  assert.equal(ctx.get('2026-01-01').rangoRel, null)   // sin días detrás con los que comparar
})

test('desgloses de contexto: tamaño del gap, lado frente al gap y eventos', () => {
  const [largo, corto] = dia('2026-03-02', [[9, 0, 5, 50], [9, 10, 5, -20]])
  const unidades = unidadesDe([largo, { ...corto, direccion: 'SHORT' }])
  const ctx = new Map([['2026-03-02', { gapPct: 0.6, apertura: 'encima', rangoRel: 1.5, eventos: ['NFP'] }]])
  const defs = desglosesDeContexto(u => (u.ticker === '^GDAXI' ? ctx.get(u.fecha) : null))
  const de = id => { const d = defs.find(x => x.id === id); return desglose(unidades, d.clave, d) }
  assert.deepEqual(de('gap').map(f => [f.etiqueta, f.n]), [['0,5 a 1%', 2]])
  assert.deepEqual(de('conGap').map(f => [f.etiqueta, f.total]).sort(), [['A favor del gap', 50], ['Contra el gap', -20]])
  assert.deepEqual(de('evento').map(f => f.etiqueta), ['Empleo de EE. UU. (NFP)'])
  assert.deepEqual(de('volatilidad').map(f => f.etiqueta), ['Ayer amplio (más de 1,25×)'])
})

// ── Expediente para la revisión ──
test('el expediente del día trae sus operaciones, las notas y lo habitual sin contar ese día', () => {
  const hoy = dia('2026-03-04', [[9, 5, 10, 40], [9, 30, 3, -15]])
  const antes = dia('2026-03-03', [[10, 0, 5, -5], [11, 0, 5, 25]])
  const anotaciones = { '2026-03-04_DAX': { texto: 'Entré tarde', cats: [9] } }
  const exp = expedienteDelDia('2026-03-04', [...antes, ...hoy], { anotaciones })
  assert.equal(exp.diaSemana, 'Miércoles')
  assert.deepEqual(exp.operaciones.map(o => [o.entrada, o.minutosAbierta, o.euros]), [['09:05:00', 10, 40], ['09:30:01', 3, -15]])
  assert.equal(exp.resumenDelDia.resultadoEur, 25)
  assert.equal(exp.habitual.resultadoEur, 20)
  assert.equal(exp.habitual.diasOperados, 1)
  assert.deepEqual(exp.anotaciones, [{
    instrumento: 'Germany 40',
    comentario: 'Entré tarde',
    erroresBookOfHorror: ['Not accepting the risk and exiting for no reason'],
  }])
})
