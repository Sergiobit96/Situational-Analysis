// Tests de la cola de descargas del feed (server/cola-feed.js): baja de una en una, lo
// último encargado pasa delante, frena ante un 429 y descansa si la IP está penalizada
import test from 'node:test'
import assert from 'node:assert/strict'

import { crearColaFeed } from '../server/cola-feed.js'

// Una cola con el reloj y las esperas de mentira: cada espera se apunta y vuelve al momento.
// `respuestas` dice qué devuelve cada clave (una lista se consume intento a intento).
function colaDePrueba(respuestas = {}, opciones = {}) {
  const bajadas = [], esperas = []
  const cola = crearColaFeed({
    bajar: async ({ clave }) => {
      bajadas.push(clave)
      const r = respuestas[clave]
      return Array.isArray(r) ? (r.length > 1 ? r.shift() : r[0]) : (r ?? 'ok')
    },
    espera: async ms => { esperas.push(ms) },
    ...opciones,
  })
  return { cola, bajadas, esperas }
}

const items = (...claves) => claves.map(clave => ({ clave }))
// deja que el trabajador vacíe la cola (todas las esperas son instantáneas)
const terminar = async cola => { while (cola.estado().enCola) await new Promise(r => setTimeout(r, 0)) }

test('baja todo lo encargado, una vez cada clave', async () => {
  const { cola, bajadas } = colaDePrueba()
  cola.encolar(items('a', 'b', 'a', 'c'))
  await terminar(cola)
  assert.deepEqual(bajadas, ['a', 'b', 'c'])
})

test('lo último encargado pasa delante de lo que esperaba', async () => {
  let soltar
  const { cola, bajadas } = colaDePrueba({}, {
    bajar: async ({ clave }) => {
      bajadas.push(clave)
      if (clave === 'a') await new Promise(r => { soltar = r })
      return 'ok'
    },
  })
  cola.encolar(items('a', 'b', 'c'))    // 'a' ya está bajando
  cola.encolar(items('d', 'c'))
  assert.ok(cola.pendiente('c') && cola.pendiente('d'))
  soltar()
  await terminar(cola)
  assert.deepEqual(bajadas, ['a', 'd', 'c', 'b'])
})

test('un día vacío no se vuelve a pedir en unas horas, pero luego sí', async () => {
  let reloj = 0
  const { cola, bajadas } = colaDePrueba({ festivo: 'vacio' }, { ahora: () => reloj })
  cola.encolar(items('festivo', 'b'))
  await terminar(cola)
  cola.encolar(items('festivo'))
  await terminar(cola)
  assert.deepEqual(bajadas, ['festivo', 'b'])
  assert.ok(cola.sinDatos('festivo'))
  reloj += 7 * 60 * 60_000
  assert.equal(cola.sinDatos('festivo'), false)
  cola.encolar(items('festivo'))
  await terminar(cola)
  assert.deepEqual(bajadas, ['festivo', 'b', 'festivo'])
})

test('lo que ya estaba guardado no gasta pausa', async () => {
  const { cola, esperas } = colaDePrueba({ a: 'cache', b: 'cache' })
  cola.encolar(items('a', 'b'))
  await terminar(cola)
  assert.deepEqual(esperas, [])
})

test('un 429 deja la sesión en la cola, frena el ritmo y la reintenta', async () => {
  const { cola, bajadas, esperas } = colaDePrueba({ a: ['limitado', 'ok'] })
  cola.encolar(items('a', 'b'))
  await terminar(cola)
  assert.deepEqual(bajadas, ['a', 'a', 'b'])
  assert.equal(esperas[0], 15_000)       // tras el 429, al menos la espera larga
  assert.equal(esperas[1], 1_800)        // y la pausa entre ficheros ha subido x1,5
  assert.equal(cola.sinDatos('a'), false)
})

test('con la IP penalizada descansa veinte minutos antes de seguir', async () => {
  const { cola, esperas } = colaDePrueba({ a: [...Array(8).fill('limitado'), 'ok'] })
  cola.encolar(items('a'))
  await terminar(cola)
  assert.ok(esperas.includes(20 * 60_000))
})

test('una sesión que falla cinco veces se deja, y se reintenta si se vuelve a pedir', async () => {
  const { cola, bajadas } = colaDePrueba({ rota: ['fallo', 'fallo', 'fallo', 'fallo', 'fallo', 'ok'] })
  cola.encolar(items('rota', 'b'))
  await terminar(cola)
  assert.ok(cola.sinDatos('rota'))
  assert.deepEqual(bajadas.filter(c => c === 'rota').length, 5)
  cola.encolar(items('rota'))
  assert.equal(cola.sinDatos('rota'), false)
  await terminar(cola)
  assert.equal(bajadas.at(-1), 'rota')
})
