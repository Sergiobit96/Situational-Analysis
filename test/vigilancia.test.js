// Tests de la vigilancia del servidor (server/vigilancia.js)
import test from 'node:test'
import assert from 'node:assert/strict'

import { crearVigilancia, crearAvisoErrores, medirBucle, duracion } from '../server/vigilancia.js'

function reloj(t0 = 1_000_000) {
  let t = t0
  return { ahora: () => t, pasar: ms => { t += ms } }
}

test('un bot que da vueltas está bien; uno apagado no cuenta', () => {
  const r = reloj()
  const vigilancia = crearVigilancia({
    ahora: r.ahora,
    bots: {
      SRS: () => ({ enMarcha: true, desde: r.ahora() - 60_000, ultimaVuelta: r.ahora() - 4_000 }),
      Tortugas: () => ({ enMarcha: false, desde: null, ultimaVuelta: null }),
    },
  })
  const e = vigilancia.estado()
  assert.equal(e.ok, true)
  assert.deepEqual(e.bots.map(b => [b.nombre, b.segundosSinVuelta, b.parado]), [['SRS', 4, false], ['Tortugas', null, false]])
})

test('un bot colgado avisa una sola vez, y otra cuando vuelve', () => {
  const r = reloj()
  const avisos = []
  let ultimaVuelta = r.ahora()
  const vigilancia = crearVigilancia({
    ahora: r.ahora, avisar: t => avisos.push(t), umbralMs: 120_000,
    bots: { SRS: () => ({ enMarcha: true, desde: 0, ultimaVuelta }) },
  })
  r.pasar(119_000)
  assert.equal(vigilancia.revisar().ok, true)
  r.pasar(2_000)
  assert.equal(vigilancia.revisar().ok, false)
  r.pasar(30_000)
  vigilancia.revisar()
  assert.equal(avisos.length, 1)
  assert.equal(avisos[0], [
    '⚠️ El bot SRS lleva 2 min parado, seguramente porque IG no contesta.',
    'Mientras siga así no abriré ni cerraré operaciones. Los stops que ya están puestos en IG siguen funcionando.',
    'Te aviso cuando vuelva.',
  ].join('\n'))
  r.pasar(4 * 60_000)
  ultimaVuelta = r.ahora()
  assert.equal(vigilancia.revisar().ok, true)
  assert.equal(avisos.length, 2)
  assert.equal(avisos[1], '✅ El bot SRS vuelve a funcionar, tras 7 min parado.')
})

test('si se paran varios a la vez, un solo aviso para todos', () => {
  const r = reloj()
  const avisos = []
  let ultimaVuelta = r.ahora()
  const latido = () => ({ enMarcha: true, desde: 0, ultimaVuelta })
  const vigilancia = crearVigilancia({
    ahora: r.ahora, avisar: t => avisos.push(t),
    bots: { SRS: latido, 'Rule of 4': latido, Tortugas: latido },
  })
  r.pasar(150_000)
  vigilancia.revisar()
  assert.equal(avisos.length, 1)
  assert.match(avisos[0], /^⚠️ Los bots SRS, Rule of 4 y Tortugas llevan 3 min parados,/)
  r.pasar(60 * 60_000)
  ultimaVuelta = r.ahora()
  vigilancia.revisar()
  assert.equal(avisos[1], '✅ Los bots SRS, Rule of 4 y Tortugas vuelven a funcionar, tras 1 h 3 min parados.')
})

test('las duraciones se leen de un vistazo', () => {
  assert.deepEqual([20_000, 120_000, 3_600_000, 3_900_000].map(duracion), ['1 min', '2 min', '1 h', '1 h 5 min'])
})

test('sin ninguna vuelta todavía, cuenta desde que arrancó', () => {
  const r = reloj()
  const desde = r.ahora()
  const vigilancia = crearVigilancia({ ahora: r.ahora, bots: { SRS: () => ({ enMarcha: true, desde, ultimaVuelta: null }) } })
  r.pasar(150_000)
  assert.deepEqual(vigilancia.estado().bots[0], { nombre: 'SRS', enMarcha: true, segundosSinVuelta: 150, parado: true })
})

test('el mismo error avisa como mucho una vez cada 10 min; uno distinto, enseguida', () => {
  const r = reloj()
  const avisos = []
  const avisarError = crearAvisoErrores({ ahora: r.ahora, avisar: t => avisos.push(t) })
  assert.equal(avisarError('fallo A'), true)
  r.pasar(60_000)
  assert.equal(avisarError('fallo A'), false)
  assert.equal(avisarError('fallo B'), true)
  r.pasar(10 * 60_000)
  assert.equal(avisarError('fallo A'), true)
  assert.deepEqual(avisos, ['fallo A', 'fallo B', 'fallo A'])
})

test('la medida del bucle ve un bloqueo de 200 ms', async () => {
  const medida = medirBucle()
  await new Promise(r => setTimeout(r, 50))
  const fin = Date.now() + 200
  while (Date.now() < fin) { /* bloquea el bucle a propósito */ }
  await new Promise(r => setTimeout(r, 50))
  const { peorRecienteMs, peorDesdeArranqueMs } = medida()
  assert.ok(peorRecienteMs >= 150, `peorRecienteMs = ${peorRecienteMs}`)
  assert.ok(peorDesdeArranqueMs >= peorRecienteMs)
})
