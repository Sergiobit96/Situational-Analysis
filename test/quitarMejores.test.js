// Tests de «sin las 5 mejores» (src/quitarMejores.js)
import test from 'node:test'
import assert from 'node:assert/strict'

import { lasMejores, tortugasSinLasMejores } from '../src/quitarMejores.js'

test('las mejores son las que más ganan, y nunca una que pierde', () => {
  const r = [3, -1, 8, 0, 5, 1, 2, 9, -4].map(x => ({ r: x }))
  assert.deepEqual(lasMejores(r, x => x.r).map(x => x.r), [9, 8, 5, 3, 2])
  assert.deepEqual(lasMejores(r, x => x.r, 2).map(x => x.r), [9, 8])
  assert.deepEqual(lasMejores([{ r: -1 }, { r: 2 }], x => x.r).map(x => x.r), [2])
})

test('tortugas: sin una operación de +10 %, la cuenta es 1,1 veces menor desde su salida', () => {
  const curva = ['2020-01-01', '2020-01-02', '2020-01-03', '2020-01-06', '2020-01-07']
    .map((date, k) => ({ date, valor: [100, 105, 110, 110, 121][k] }))
  const operaciones = [
    { entrada: '2020-01-01', salida: '2020-01-03', pctCapital: 10, neto: 10 },
    { entrada: '2020-01-06', salida: '2020-01-07', pctCapital: -2, neto: -2 },
  ]
  const { res, quitadas } = tortugasSinLasMejores({ curva, operaciones, exposicion: [] })
  assert.equal(quitadas.length, 1)                          // la que pierde se queda
  assert.deepEqual(res.operaciones, [operaciones[1]])
  const v = res.curva.map(p => p.valor)
  assert.equal(v[0], 100)
  assert.ok(Math.abs(v[1] - 105 / Math.sqrt(1.1)) < 1e-9)   // a mitad de la operación, media diferencia
  assert.ok(Math.abs(v[2] - 100) < 1e-9)
  assert.ok(Math.abs(v[4] - 110) < 1e-9)                    // lo de después, en proporción
})

test('tortugas: si no gana ninguna, no cambia nada', () => {
  const res0 = { curva: [{ date: '2020-01-01', valor: 1 }], operaciones: [{ pctCapital: -1 }] }
  assert.equal(tortugasSinLasMejores(res0).res, res0)
})
