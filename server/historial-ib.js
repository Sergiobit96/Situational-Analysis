// Historial de la cuenta de IB (server/ib.js): lo que pasa con las órdenes y las ejecuciones,
// guardado en disco para que sobreviva a los reinicios (IB solo da las ejecuciones del día).
// Entradas, de la más nueva a la más vieja:
//   { tipo: 'ejecucion', hora, execId, orderId, referencia, simbolo, conId, lado, cantidad, precio, comision, moneda, realizado }
//   { tipo: 'puesta' | 'modificada' | 'cancelada' | 'rechazada', hora, orderId, referencia, simbolo, conId, lado, orden, cantidad, precio, origen, motivo }
// `origen` de una cancelación: 'servidor' si la pidió este servidor (un bot o la vista), 'fuera'
// si no (la app o la web de IB, otro cliente de la API o el propio IB).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'

const MAX = 5000

// la hora de una ejecución de IB («AAAAMMDD hh:mm:ss», a veces con la zona detrás) en ISO; sin
// zona, IB la da en la hora del Gateway, que en Railway es UTC
export function horaDeIB(h, ahora = Date.now()) {
  const m = /^(\d{4})(\d{2})(\d{2})[\s-]+(\d{2}):(\d{2}):(\d{2})(?:\s+(\S+))?/.exec(String(h ?? '').trim())
  if (!m) return new Date(ahora).toISOString()
  const [, a, mes, d, hh, mm, ss, zona] = m
  const utc = Date.UTC(+a, +mes - 1, +d, +hh, +mm, +ss)
  if (!zona || /^(UTC|GMT|Z)$/i.test(zona)) return new Date(utc).toISOString()
  try {
    // lo que marca esa zona en ese instante, para corregir la diferencia
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zona, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(utc)).map(x => [x.type, x.value]))
    const visto = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
    return new Date(utc - (visto - utc)).toISOString()
  } catch { return new Date(utc).toISOString() }
}

export function crearHistorialIB({ archivo = null, ahora = Date.now, max = MAX, log = console } = {}) {
  let entradas = []
  if (archivo && existsSync(archivo)) {
    try { entradas = JSON.parse(readFileSync(archivo, 'utf8')) } catch (err) { log.warn?.(`IB historial: no se puede leer ${archivo}: ${err.message}`) }
  }
  const ejecuciones = new Map(entradas.filter(x => x.tipo === 'ejecucion').map(x => [x.execId, x]))
  const comisiones = new Map()   // las que llegan antes que su ejecución
  let reloj = null

  function guardar() {
    if (!archivo || reloj) return
    reloj = setTimeout(() => {
      reloj = null
      try {
        mkdirSync(dirname(archivo), { recursive: true })
        writeFileSync(archivo, JSON.stringify(entradas))
      } catch (err) { log.warn?.(`IB historial: no se puede guardar: ${err.message}`) }
    }, 1000)
    reloj.unref?.()
  }
  function meter(x) {
    entradas.unshift(x)
    if (entradas.length > max) entradas.length = max
    guardar()
  }

  return {
    ejecucion({ execId, orderId, referencia, simbolo, conId, lado, cantidad, precio, hora }) {
      if (!execId || ejecuciones.has(execId)) return
      const x = {
        tipo: 'ejecucion', hora: horaDeIB(hora, ahora()), execId, orderId, referencia: referencia || null, simbolo, conId,
        lado: lado === 'BOT' ? 'compra' : lado === 'SLD' ? 'venta' : lado, cantidad: Number(cantidad), precio: Number(precio),
        comision: null, moneda: null, realizado: null, ...comisiones.get(execId),
      }
      comisiones.delete(execId)
      ejecuciones.set(execId, x)
      meter(x)
      // las que llegan tarde (al reconectar, IB manda las del día): en su sitio por la hora
      entradas.sort((a, b) => (a.hora < b.hora ? 1 : a.hora > b.hora ? -1 : 0))
    },
    comision({ execId, commission, currency, realizedPNL }) {
      // IB manda 1.7976931348623157E308 cuando no hay realizado
      const valido = n => (Number.isFinite(n) && Math.abs(n) < 1e100 ? n : null)
      const c = { comision: valido(commission), moneda: currency ?? null, realizado: valido(realizedPNL) }
      const x = ejecuciones.get(execId)
      if (!x) return void comisiones.set(execId, c)
      Object.assign(x, c)
      guardar()
    },
    orden(tipo, { orderId, referencia, simbolo, conId, lado, orden, cantidad, precio, origen = null, motivo = null }) {
      meter({ tipo, hora: new Date(ahora()).toISOString(), orderId, referencia: referencia || null, simbolo, conId, lado, orden, cantidad, precio, origen, motivo })
    },
    lista: (limite = 500) => entradas.slice(0, limite),
  }
}
