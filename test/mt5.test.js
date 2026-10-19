// Tests del cliente de MetaTrader 5 (server/mt5.js) con un puente de Python de mentira
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

import { crearMt5, simbolosDeEnv, SIMBOLOS_MT5 } from '../server/mt5.js'

// Un proceso falso: lo que el cliente escribe en stdin lo contesta `responder` por stdout
// (null: no contesta). Apunta cuántas veces se arrancó.
function puenteFalso(responder) {
  const procesos = []
  const spawn = () => {
    const p = new EventEmitter()
    p.stdout = new PassThrough()
    p.stderr = new PassThrough()
    p.stdin = new PassThrough()
    p.kill = () => p.emit('exit', null)
    let resto = ''
    p.stdin.setEncoding('utf8')
    p.stdin.on('data', t => {
      resto += t
      let fin
      while ((fin = resto.indexOf('\n')) >= 0) {
        const pet = JSON.parse(resto.slice(0, fin))
        resto = resto.slice(fin + 1)
        const r = responder(pet, p)
        if (r) p.stdout.write(JSON.stringify({ id: pet.id, ...r }) + '\n')
      }
    })
    procesos.push(p)
    return p
  }
  return { spawn, procesos }
}

test('pide una página con el símbolo del bróker y devuelve velas y previa', async () => {
  const peticiones = []
  const { spawn, procesos } = puenteFalso(pet => {
    peticiones.push(pet)
    return { ok: true, velas: [{ time: 100, open: 1, high: 2, low: 0.5, close: 1.5 }], previa: 40 }
  })
  const mt5 = crearMt5({ spawn, log: () => {} })
  const r = await mt5.pagina('^GDAXI', 'm1', 60, 200)
  assert.deepEqual(r, { velas: [{ time: 100, open: 1, high: 2, low: 0.5, close: 1.5 }], previa: 40 })
  assert.equal(peticiones[0].op, 'pagina')
  assert.equal(peticiones[0].simbolo, 'DE40')
  assert.equal(peticiones[0].tf, 'm1')
  // la segunda va por el mismo proceso
  await mt5.pagina('^NDX', 'm5', 0, 10)
  assert.equal(peticiones[1].simbolo, 'USTEC')
  assert.equal(procesos.length, 1)
})

test('un ticker sin símbolo en MT5 falla sin arrancar Python', async () => {
  const { spawn, procesos } = puenteFalso(() => ({ ok: true }))
  const mt5 = crearMt5({ spawn, log: () => {} })
  assert.equal(mt5.simboloDe('^FTSE'), null)
  await assert.rejects(mt5.pagina('^FTSE', 'm1', 0, 10), /no tiene \^FTSE/)
  assert.equal(procesos.length, 0)
})

test('las respuestas se casan por id aunque lleguen desordenadas', async () => {
  const guardadas = []
  const { spawn } = puenteFalso((pet, p) => {
    guardadas.push(pet)
    if (guardadas.length < 2) return null
    // contesta las dos al revés
    for (const g of guardadas.reverse()) p.stdout.write(JSON.stringify({ id: g.id, ok: true, velas: [], previa: g.desde }) + '\n')
    return null
  })
  const mt5 = crearMt5({ spawn, log: () => {} })
  const [a, b] = await Promise.all([mt5.pagina('^GDAXI', 'm1', 1, 2), mt5.pagina('^GDAXI', 'm1', 3, 4)])
  assert.equal(a.previa, 1)
  assert.equal(b.previa, 3)
})

test('un error del puente llega como error de la petición', async () => {
  const { spawn } = puenteFalso(() => ({ ok: false, error: 'MetaTrader 5 no arranca: (-6, Authorization failed)' }))
  const mt5 = crearMt5({ spawn, log: () => {} })
  await assert.rejects(mt5.pagina('^GDAXI', 'm1', 0, 10), /Authorization failed/)
})

test('si Python se cae sin el paquete, lo dice; la siguiente petición arranca otro', async () => {
  let vez = 0
  const { spawn, procesos } = puenteFalso((pet, p) => {
    vez++
    if (vez === 1) {
      p.stderr.write("ModuleNotFoundError: No module named 'MetaTrader5'\n")
      setImmediate(() => p.emit('exit', 1))
      return null
    }
    return { ok: true, velas: [], previa: null }
  })
  const mt5 = crearMt5({ spawn, log: () => {} })
  await assert.rejects(mt5.pagina('^GDAXI', 'm1', 0, 10), /pip install MetaTrader5/)
  const r = await mt5.pagina('^GDAXI', 'm1', 0, 10)
  assert.equal(r.previa, null)
  assert.equal(procesos.length, 2)
})

test('los símbolos de server/.env se suman a los de serie', () => {
  assert.equal(simbolosDeEnv(undefined), SIMBOLOS_MT5)
  assert.equal(simbolosDeEnv('no es json'), SIMBOLOS_MT5)
  const s = simbolosDeEnv('{"^GDAXI":"GER40","^FTSE":"UK100"}')
  assert.equal(s['^GDAXI'], 'GER40')
  assert.equal(s['^FTSE'], 'UK100')
  assert.equal(s['^NDX'], 'USTEC')
})

// Un puente que contesta a `directo` con lo que diga `velasDe` en cada consulta
function puenteDirecto(velasDe) {
  const consultas = []
  const { spawn } = puenteFalso(pet => {
    if (pet.op !== 'directo') return { ok: true }
    consultas.push(pet.simbolos)
    return { ok: true, velas: velasDe(consultas.length, pet.simbolos), errores: {} }
  })
  return { spawn, consultas }
}
// deja que el puente falso conteste (setImmediate: setTimeout va con el reloj de mentira)
const vaciar = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)) }
const AHORA = 1_800_000_000_000
const vela = (time, close) => ({ time, open: 10, high: Math.max(10, close), low: Math.min(10, close), close })

test('en directo reparte las velas de 1 min que cambian y deja de preguntar al soltarse', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const t0 = AHORA / 1000 - 30
  const respuestas = [
    { DE40: [vela(t0 - 60, 9), vela(t0, 11)] },
    { DE40: [vela(t0 - 60, 9), vela(t0, 11)] },    // igual que antes: nada
    { DE40: [vela(t0 - 60, 9), vela(t0, 12)] },    // se mueve la que se está haciendo
  ]
  const { spawn, consultas } = puenteDirecto(n => respuestas[Math.min(n, respuestas.length) - 1])
  const repartidas = []
  const mt5 = crearMt5({ spawn, log: () => {}, ahora: () => AHORA, registrar: (f, tk, v) => repartidas.push([f, tk, v.time, v.close]) })

  const soltar = mt5.seguir('^GDAXI')
  await vaciar()
  assert.deepEqual(consultas, [['DE40']])
  assert.deepEqual(repartidas, [['mt5', '^GDAXI', t0 - 60, 9], ['mt5', '^GDAXI', t0, 11]])

  t.mock.timers.tick(1000); await vaciar()
  assert.equal(consultas.length, 2)
  assert.equal(repartidas.length, 2)

  t.mock.timers.tick(1000); await vaciar()
  assert.deepEqual(repartidas.at(-1), ['mt5', '^GDAXI', t0, 12])

  soltar()
  t.mock.timers.tick(5000); await vaciar()
  assert.equal(consultas.length, 3)
  assert.deepEqual(mt5.directo().siguiendo, {})
})

test('en directo no reparte las velas de un mercado cerrado ni sigue lo que MT5 no tiene', async () => {
  const viejo = AHORA / 1000 - 3600
  const { spawn, consultas } = puenteDirecto(() => ({ DE40: [vela(viejo - 60, 9), vela(viejo, 11)] }))
  const repartidas = []
  const mt5 = crearMt5({ spawn, log: () => {}, ahora: () => AHORA, registrar: (...a) => repartidas.push(a) })
  mt5.seguir('^FTSE')()
  assert.equal(consultas.length, 0)
  const soltar = mt5.seguir('^GDAXI')
  await vaciar()
  soltar()
  assert.equal(consultas.length, 1)
  assert.equal(repartidas.length, 0)
  mt5.cerrar()
})

test('dos gráficos del mismo instrumento van en una sola consulta y hasta soltar los dos no se para', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { spawn, consultas } = puenteDirecto(() => ({}))
  const mt5 = crearMt5({ spawn, log: () => {}, ahora: () => AHORA, registrar: () => {} })
  const a = mt5.seguir('^GDAXI')
  const b = mt5.seguir('^GDAXI')
  const c = mt5.seguir('^NDX')
  await vaciar()
  t.mock.timers.tick(1000); await vaciar()
  assert.deepEqual(consultas.at(-1), ['DE40', 'USTEC'])
  a(); a(); c()
  assert.deepEqual(mt5.directo().siguiendo, { '^GDAXI': 1 })
  t.mock.timers.tick(1000); await vaciar()
  assert.deepEqual(consultas.at(-1), ['DE40'])
  b()
  const antes = consultas.length
  t.mock.timers.tick(5000); await vaciar()
  assert.equal(consultas.length, antes)
})

test('con el puente fallando, el directo espera 15 s antes de volver a preguntar', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let veces = 0
  const { spawn } = puenteFalso(pet => { if (pet.op === 'directo') veces++; return { ok: false, error: 'terminal cerrado' } })
  const mt5 = crearMt5({ spawn, log: () => {}, ahora: () => AHORA, registrar: () => {} })
  const soltar = mt5.seguir('^GDAXI')
  await vaciar()
  assert.equal(veces, 1)
  assert.equal(mt5.directo().error, 'terminal cerrado')
  t.mock.timers.tick(5000); await vaciar()
  assert.equal(veces, 1)
  t.mock.timers.tick(10_000); await vaciar()
  assert.equal(veces, 2)
  soltar()
})
