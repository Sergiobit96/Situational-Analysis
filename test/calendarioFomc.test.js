// Tests del calendario del FOMC al día con la Reserva Federal (server/fomc.js y
// server/calendario-fomc.js), con una página de mentira con la forma de la de verdad
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { FOMC, parsearCalendarioFed, combinarCalendario, usarCalendarioFed, diasFomc, esDiaFomc } from '../server/fomc.js'
import { crearCalendarioFomc } from '../server/calendario-fomc.js'
import { sesionRuleOf4, proximaRuleOf4 } from '../server/bot-srs.js'

const fila = (mes, dias) => `
        <div class="row fomc-meeting" ">
            <div class="fomc-meeting__month col-xs-5 col-sm-3 col-md-2"><strong>${mes}</strong></div>
            <div class="fomc-meeting__date col-xs-4 col-sm-9 col-md-10 col-lg-1">${dias}</div>
            <div class="col-xs-12 col-md-4 col-lg-2"><a href="/x.htm">Statement:</a></div>
        </div>`
const panel = (anio, filas) => `<div class="panel panel-default"><div class="panel-heading"><h4><a id="${anio}">${anio} FOMC Meetings</a></h4></div>${filas.map(f => fila(...f)).join('')}</div>`
const ANIO_2027 = [['January', '26-27'], ['March', '16-17*'], ['April', '27-28'], ['June', '8-9*'], ['July', '27-28'], ['September', '14-15*'], ['October', '26-27'], ['December', '7-8*']]
const pagina = (...paneles) => `<html><body>${paneles.join('\n')}</body></html>`

test('lee de la página el último día de cada reunión ordinaria, también las que cruzan de mes', () => {
  const html = pagina(
    panel(2025, [['January', '28-29'], ['July', '29-30'], ['August', '22 (notation vote)'], ['October', '28-29']]),
    panel(2024, [['Apr/May', '30-1'], ['November', '6-7']]),
    panel(2023, [['Jan/Feb', '31-1'], ['Oct/Nov', '31-1'], ['March', '16 (unscheduled)']]),
    panel(2027, ANIO_2027),
  )
  assert.deepEqual(parsearCalendarioFed(html), [
    '2023-02-01', '2023-11-01', '2024-05-01', '2024-11-07', '2025-01-29', '2025-07-30', '2025-10-29',
    '2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09', '2027-07-28', '2027-09-15', '2027-10-27', '2027-12-08',
  ])
  assert.deepEqual(parsearCalendarioFed('<html>otra cosa</html>'), [])
})

test('un año que la página trae entero manda sobre la lista; uno a medias solo suma', () => {
  const base = ['2026-01-28', '2026-03-18', '2026-12-09']
  // 2026 entero en la página, con una reunión movida del 9 al 16 de diciembre
  const fed2026 = ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-12-16']
  assert.deepEqual(combinarCalendario(base, fed2026), fed2026)
  // de 2027 solo dos reuniones (la página leída a medias): se suman, sin quitar nada
  assert.deepEqual(combinarCalendario(base, ['2027-01-27', '2027-03-17']), [...base, '2027-01-27', '2027-03-17'])
  assert.deepEqual(combinarCalendario(base, []), base)
})

function fedFalsa(respuestas) {
  const pedidas = []
  const fetchFn = async url => {
    pedidas.push(url)
    const r = respuestas.shift()
    if (r instanceof Error) throw r
    return { ok: r.status === 200, status: r.status, text: async () => r.html }
  }
  return { fetchFn, pedidas }
}

test('se pone al día con la página: guarda lo leído, avisa de las reuniones nuevas y el bot ya las tiene', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fomc-'))
  const archivo = join(dir, 'fomc-calendario.json')
  const avisos = []
  const { fetchFn, pedidas } = fedFalsa([{ status: 200, html: pagina(panel(2027, ANIO_2027)) }])
  const ahora = () => new Date('2026-10-19T12:00:00Z')
  try {
    usarCalendarioFed([])
    assert.equal(diasFomc().at(-1), '2026-12-09')
    assert.equal(sesionRuleOf4('^NDX', Date.UTC(2027, 0, 27, 20) / 1000), null)

    const cal = crearCalendarioFomc({ archivo, fetchFn, log: () => {}, avisar: x => avisos.push(x), ahora })
    const nuevas = await cal.actualizar()
    assert.match(pedidas[0], /federalreserve\.gov\/monetarypolicy\/fomccalendars\.htm/)
    assert.equal(nuevas.length, 8)
    assert.equal(diasFomc().at(-1), '2027-12-08')
    assert.ok(esDiaFomc('2027-06-09'))
    // el bot de la Rule of 4 ya tiene la sesión: 14:00 de Nueva York, en invierno las 19:00 UTC
    assert.equal(sesionRuleOf4('^NDX', Date.UTC(2027, 0, 27, 20) / 1000).abre, Date.UTC(2027, 0, 27, 19) / 1000)
    assert.equal(proximaRuleOf4('^NDX', Date.UTC(2026, 11, 10) / 1000), Date.UTC(2027, 0, 27, 19) / 1000)
    assert.equal(avisos.length, 1)
    assert.match(avisos[0], /^Rule of 4 · Calendario del FOMC al día: 8 reuniones nuevas \(27 ene 2027,/)
    const guardado = JSON.parse(readFileSync(archivo, 'utf8'))
    assert.equal(guardado.fechas.length, 8)
    const e = cal.estado()
    assert.equal(e.hasta, '2027-12-08')
    assert.deepEqual(e.proximas, ['2026-10-28', '2026-12-09', '2027-01-27'])
    assert.equal(e.error, null)

    // otro arranque, con la página caída: empieza con lo guardado
    usarCalendarioFed([])
    const { fetchFn: caida } = fedFalsa([new Error('fetch failed')])
    const otra = crearCalendarioFomc({ archivo, fetchFn: caida, log: () => {}, ahora })
    assert.equal(diasFomc().at(-1), '2027-12-08')
    assert.equal(await otra.actualizar(), null)
    assert.equal(otra.estado().error, 'fetch failed')
    assert.equal(diasFomc().at(-1), '2027-12-08')
  } finally {
    usarCalendarioFed([])
    rmSync(dir, { recursive: true, force: true })
  }
})

test('una página rara (sin reuniones o con error) no toca el calendario', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fomc-'))
  try {
    usarCalendarioFed([])
    const { fetchFn } = fedFalsa([{ status: 200, html: '<html>mantenimiento</html>' }, { status: 503, html: '' }])
    const cal = crearCalendarioFomc({ archivo: join(dir, 'f.json'), fetchFn, log: () => {} })
    assert.equal(await cal.actualizar(), null)
    assert.match(cal.estado().error, /solo trae 0 reuniones/)
    assert.equal(await cal.actualizar(), null)
    assert.match(cal.estado().error, /HTTP 503/)
    assert.deepEqual(diasFomc(), FOMC)
  } finally {
    usarCalendarioFed([])
    rmSync(dir, { recursive: true, force: true })
  }
})
