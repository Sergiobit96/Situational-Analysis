// Tests del bot de las tortugas en acciones (server/bot-tortugas-acciones.js), con una Alpaca de mentira
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { crearBotTortugasAcciones, nivelesSistema, accionesUnidad, rompe } from '../server/bot-tortugas-acciones.js'

// lunes 2-nov-2026, 9:31 de Nueva York (ya sin el horario de verano: UTC−5)
const LUNES_0931 = Date.UTC(2026, 10, 2, 14, 31) / 1000

// Velas diarias de días laborables hasta el viernes 30-oct-2026: un rango de 99 a 101 y las
// últimas 10 de 104 a 105 (máximo de 20 y de 55, 105; mínimo de 10, 104; de 20, 99; N ≈ 1,4)
function velasDe() {
  const fechas = []
  for (let t = Date.UTC(2026, 9, 30); fechas.length < 150; t -= 86_400_000) {
    const d = new Date(t).getUTCDay()
    if (d !== 0 && d !== 6) fechas.unshift(new Date(t).toISOString().slice(0, 10))
  }
  return fechas.map((date, i) => (i >= 140
    ? { date, open: 104.5, high: 105, low: 104, close: 104.5 }
    : { date, open: 100, high: 101, low: 99, close: 100 }))
}

function alpacaDeMentira({ equity = 100_000 } = {}) {
  const a = {
    ahora: LUNES_0931, abierto: true, px: {}, qty: {}, ordenes: new Map(), enviadas: [], n: 0,
    reloj: async () => ({ abierto: a.abierto, proximaApertura: '2026-11-03T09:30:00-05:00', proximoCierre: '2026-11-02T16:00:00-05:00' }),
    cuenta: async () => ({ paper: true, equity, poderCompra: 4 * equity }),
    posiciones: async () => Object.entries(a.qty).filter(([, q]) => q).map(([simbolo, q]) => ({ simbolo, lado: q > 0 ? 'largo' : 'corto', cantidad: Math.abs(q) })),
    ordenesAbiertas: async () => [...a.ordenes.values()].filter(o => o.estado === 'new'),
    dias: async (desde, hasta) => ['2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03'].filter(d => d >= desde && d <= hasta),
    operables: async () => ({ AAA: { cortos: true }, BBB: { cortos: true } }),
    precios: async simbolos => Object.fromEntries(simbolos.filter(s => a.px[s]).map(s => [s, { precio: a.px[s] }])),
    orden: async id => ({ ...a.ordenes.get(id) }),
    cancelarOrden: async id => { const o = a.ordenes.get(id); if (o.estado === 'new') o.estado = 'canceled' },
    enviarOrden: async (o, { prefijo }) => {
      const id = `o${++a.n}`
      a.enviadas.push({ ...o, prefijo })
      // como Alpaca: nada con otra pendiente del lado contrario en el mismo símbolo
      if ([...a.ordenes.values()].some(x => x.estado === 'new' && x.simbolo === o.simbolo && x.lado !== o.lado)) throw new Error('Alpaca 403: potential wash trade detected')
      if ((o.tipo ?? 'market') === 'market') {
        const p = a.px[o.simbolo]
        a.qty[o.simbolo] = (a.qty[o.simbolo] ?? 0) + (o.lado === 'compra' ? 1 : -1) * o.cantidad
        a.ordenes.set(id, { id, simbolo: o.simbolo, lado: o.lado, estado: 'filled', rellena: o.cantidad, precioMedio: p })
      } else a.ordenes.set(id, { id, simbolo: o.simbolo, lado: o.lado, tipo: 'stop', estado: 'new', stop: o.stop, cantidad: o.cantidad })
      return { id }
    },
    cerrarPosicion: async simbolo => {
      for (const o of a.ordenes.values()) if (o.simbolo === simbolo && o.estado === 'new') o.estado = 'canceled'
      const q = a.qty[simbolo]
      a.qty[simbolo] = 0
      const id = `o${++a.n}`
      a.ordenes.set(id, { id, simbolo, lado: q > 0 ? 'venta' : 'compra', estado: 'filled', rellena: Math.abs(q), precioMedio: a.px[simbolo] })
      return { id }
    },
    // salta el stop de una acción al precio de su stop
    saltarStop: simbolo => {
      const o = [...a.ordenes.values()].find(x => x.simbolo === simbolo && x.estado === 'new')
      o.estado = 'filled'; o.precioMedio = o.stop; o.rellena = o.cantidad
      a.qty[simbolo] = 0
    },
  }
  return a
}

async function botCon(a, config = {}) {
  const avisos = []
  const bot = crearBotTortugasAcciones({
    alpaca: a, archivo: join(mkdtempSync(join(tmpdir(), 'tor-acc-')), 'bot.json'),
    universo: [{ ticker: 'AAA', sector: 'Tecnología' }, { ticker: 'BBB', sector: 'Tecnología' }],
    velasDiarias: async () => ({ velas: { AAA: velasDe(), BBB: velasDe() }, fallos: {} }),
    ahora: () => a.ahora, log: () => {}, avisar: t => avisos.push(t), esperarMs: async () => {},
  })
  bot.cambiarConfig({ activo: true, ...config })
  await bot._paso()                        // la primera vuelta pide el plan, que va aparte
  await new Promise(r => setTimeout(r, 20))
  return { bot, avisos, niv: s => bot._datos().plan.niveles[s] }
}

test('los niveles de cada sistema, con y sin el filtro del S1', () => {
  const niv = { gano: true, alto: { 10: 103, 20: 105, 55: 110 }, bajo: { 10: 97, 20: 95, 55: 90 } }
  assert.deepEqual(nivelesSistema(niv, 1, false), { k: 20, entrada: { largo: 105, corto: 95 }, salida: { largo: 97, corto: 103 } })
  assert.equal(nivelesSistema(niv, 1, true).entrada.largo, 110)
  assert.equal(nivelesSistema({ ...niv, gano: false }, 1, true).entrada.largo, 105)
  assert.deepEqual(nivelesSistema(niv, 2, true), { k: 55, entrada: { largo: 110, corto: 90 }, salida: { largo: 95, corto: 105 } })
})

test('la unidad en acciones enteras, y una si cuesta como mucho el doble', () => {
  assert.equal(accionesUnidad(100, 3), 33)
  assert.equal(accionesUnidad(100, 150), 1)
  assert.equal(accionesUnidad(100, 250), 0)
})

test('rompe: al otro lado del nivel y como mucho ½ N, salvo a la apertura', () => {
  assert.equal(rompe(105.5, 105, 'largo', 2, false), true)
  assert.equal(rompe(106.5, 105, 'largo', 2, false), false)
  assert.equal(rompe(106.5, 105, 'largo', 2, true), true)
  assert.equal(rompe(104.9, 105, 'largo', 2, true), false)
  assert.equal(rompe(94, 95, 'corto', 2, false), true)
})

test('entra en la ruptura con su stop, añade cada ½ N y sale por el canal', async () => {
  const a = alpacaDeMentira()
  a.px = { AAA: 100, BBB: 100 }
  const { bot, avisos, niv } = await botCon(a, { sistemas: [1] })
  const { n, alto, bajo } = niv('AAA')
  assert.equal(alto[20], 105)
  assert.equal(bot._datos().plan.fecha, '2026-11-02')

  // ruptura del máximo de 20: compra una unidad y pone el stop a 2 N
  a.px.AAA = 105.1
  await bot._paso()
  const pos = bot._datos().posiciones.AAA
  const unidad = Math.floor(100_000 * 0.005 / 5 / n)   // 0,5 % entre el pico de 6 unidades (5 N)
  assert.equal(pos.unidades[0].acciones, unidad)
  assert.equal(pos.stop, Math.round((105.1 - 2 * n) * 100) / 100)
  assert.ok(a.enviadas[0].prefijo.startsWith('TA1-AAA-'))
  const stop1 = a.ordenes.get(pos.stopId)
  assert.deepEqual([stop1.estado, stop1.cantidad, stop1.stop], ['new', unidad, pos.stop])
  assert.match(avisos.at(-1), /Tortugas acciones S1 · AAA · Compro/)

  // ½ N a favor: quita el stop (Alpaca no deja comprar con él puesto), añade y pone otro por todo
  a.px.AAA = 105.1 + 0.5 * n + 0.01
  await bot._paso()
  assert.equal(pos.unidades.length, 2)
  assert.equal(stop1.estado, 'canceled')
  const stop2 = a.ordenes.get(bot._datos().posiciones.AAA.stopId)
  assert.equal(stop2.cantidad, 2 * unidad)
  assert.equal(stop2.stop, Math.round((a.px.AAA - 2 * n) * 100) / 100)

  // por debajo del mínimo de 10 (y por encima del stop): sale a mercado
  a.px.AAA = bajo[10] - 0.01
  assert.ok(a.px.AAA > stop2.stop)
  await bot._paso()
  assert.equal(bot._datos().posiciones.AAA, undefined)
  assert.equal(a.qty.AAA, 0)
  const op = bot._datos().operaciones[0]
  assert.deepEqual([op.motivo, op.unidades, op.acciones], ['canal', 2, 2 * unidad])
  assert.ok(op.resultado < 0)
})

test('si salta el stop en Alpaca, la operación se cierra al precio del stop', async () => {
  const a = alpacaDeMentira()
  a.px = { AAA: 105.2 }
  const { bot } = await botCon(a, { sistemas: [1] })
  await bot._paso()
  const { stop } = bot._datos().posiciones.AAA
  a.saltarStop('AAA')
  await bot._paso()
  const op = bot._datos().operaciones[0]
  assert.deepEqual([op.motivo, op.salida], ['stop', stop])
})

test('si el stop desaparece, lo vuelve a poner', async () => {
  const a = alpacaDeMentira()
  a.px = { AAA: 105.2 }
  const { bot } = await botCon(a, { sistemas: [1] })
  await bot._paso()
  const pos = bot._datos().posiciones.AAA
  a.ordenes.get(pos.stopId).estado = 'canceled'
  await bot._paso()
  assert.equal(a.ordenes.get(pos.stopId).estado, 'new')
})

test('una acción la lleva un solo sistema', async () => {
  const a = alpacaDeMentira()
  a.px = { AAA: 105.2 }
  const { bot } = await botCon(a, { sistemas: [1, 2], filtroS1: false })
  await bot._paso()
  assert.equal(bot._datos().posiciones.AAA.sistema, 1)
  assert.equal(a.enviadas.filter(o => (o.tipo ?? 'market') === 'market').length, 1)
})

test('lejos del nivel no persigue la ruptura, salvo a la apertura', async () => {
  const a = alpacaDeMentira()
  a.px = { AAA: 100 }
  const { bot, niv } = await botCon(a, { sistemas: [1] })
  a.ahora += 10 * 60   // 9:41
  a.px.AAA = 105 + niv('AAA').n
  await bot._paso()
  assert.equal(bot._datos().posiciones.AAA, undefined)
  assert.match(bot._datos().sinEntrar[0].motivo, /pasó sin verla/)

  const b = alpacaDeMentira()
  b.px = { AAA: 100 }
  const otro = await botCon(b, { sistemas: [1] })
  b.px.AAA = 105 + otro.niv('AAA').n   // un hueco a las 9:31
  await otro.bot._paso()
  assert.ok(otro.bot._datos().posiciones.AAA)
})

test('respeta el límite por sector', async () => {
  const a = alpacaDeMentira()
  a.px = { AAA: 105.1, BBB: 105.1 }
  const { bot } = await botCon(a, { sistemas: [1], maxGrupo: 1 })
  await bot._paso()
  assert.equal(Object.keys(bot._datos().posiciones).length, 1)
  assert.match(bot._datos().sinEntrar[0].motivo, /límite de 1 unidades en Tecnología/)
})

test('apagado no entra, pero sigue cuidando los stops', async () => {
  const a = alpacaDeMentira()
  a.px = { AAA: 105.2 }
  const { bot } = await botCon(a, { sistemas: [1] })
  await bot._paso()
  bot.cambiarConfig({ activo: false })
  const pos = bot._datos().posiciones.AAA
  a.ordenes.get(pos.stopId).estado = 'canceled'
  a.px.BBB = 105.2
  await bot._paso()
  assert.equal(a.ordenes.get(pos.stopId).estado, 'new')
  assert.equal(bot._datos().posiciones.BBB, undefined)
})

test('cortos solo con lados ambos o cortos', async () => {
  const a = alpacaDeMentira()
  a.px = { AAA: 100 }
  const { bot, niv } = await botCon(a, { sistemas: [1], lados: 'ambos' })
  a.px.AAA = niv('AAA').bajo[20] - 0.01
  await bot._paso()
  assert.equal(bot._datos().posiciones.AAA.lado, 'corto')
  assert.ok(a.qty.AAA < 0)
})
