// Tests de la validación del diario de fortalezas y debilidades (server/diario-fortalezas.js)
import test from 'node:test'
import assert from 'node:assert/strict'

import { limpiarDiario, totalDiario } from '../server/diario-fortalezas.js'

test('se queda con las entradas con texto y sus campos', () => {
  const d = limpiarDiario({
    fortalezas: [
      { id: 'a', texto: '  respeto el stop  ', creado: 1, editado: 2, movido: 3, desde: 'debilidades', sobra: 'x' },
      { id: 'b', texto: '   ' },
      null,
    ],
    debilidades: [{ id: 'c', texto: 'entro antes de que cierre la vela', creado: 5, desde: 'otra' }],
  })
  assert.deepEqual(d.fortalezas, [{ id: 'a', texto: 'respeto el stop', creado: 1, editado: 2, movido: 3, desde: 'debilidades' }])
  assert.deepEqual(d.debilidades, [{ id: 'c', texto: 'entro antes de que cierre la vela', creado: 5, editado: null, movido: null, desde: null }])
  assert.equal(totalDiario(d), 2)
})

test('a una entrada sin id o sin fecha se le ponen', () => {
  const d = limpiarDiario({ fortalezas: [{ texto: 'paciencia' }], debilidades: [] })
  assert.equal(typeof d.fortalezas[0].id, 'string')
  assert.ok(d.fortalezas[0].id.length > 10)
  assert.ok(Number.isFinite(d.fortalezas[0].creado))
})

test('sin las dos listas no se acepta', () => {
  assert.throws(() => limpiarDiario({ fortalezas: [] }), /debilidades/)
  assert.throws(() => limpiarDiario(null), /fortalezas/)
  assert.throws(() => limpiarDiario({ fortalezas: 'x', debilidades: [] }), /fortalezas/)
})
