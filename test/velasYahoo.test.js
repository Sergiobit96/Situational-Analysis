// Tests de las velas de Yahoo como reserva para el MFE/MAE (server/velas-yahoo.js)
import test from 'node:test'
import assert from 'node:assert/strict'

import { parsearCsvYahoo, velasYahooDeOperacion, desfaseDelDia } from '../server/velas-yahoo.js'
import { calcularExcursion } from '../server/excursiones.js'

const utc = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000
// Las horas del diario son hora de pared de Madrid guardada como si fuera UTC
const madrid = utc

// Sesión de cinco velas del 2-feb-2026 (invierno: 09:00 Madrid = 08:00 UTC)
const CSV = [
  'Date;Time;Open;High;Low;Close;Source',
  '2026-02-02;9:00;100;101;99;100.5;Yahoo',
  '2026-02-02;9:01;100.5;103;100;102;Yahoo',
  '2026-02-02;9:02;102;106;101;105;Yahoo',
  '2026-02-02;9:03;105;105;97;98;Yahoo',
  '2026-02-02;9:04;98;99;96;97;Yahoo',
  '',
].join('\r\n')

const dax = (cambios = {}) => ({
  producto: 'Germany 40', ticker: '^GDAXI', direccion: 'LONG',
  openTime: madrid(2026, 2, 2, 9, 1, 20), openPrice: 101,
  closeTime: madrid(2026, 2, 2, 9, 3, 40), closePrice: 99, puntos: -2,
  ...cambios,
})

test('lee el CSV de recoger_yahoo.py y pasa la hora de Madrid a UTC', () => {
  const velas = parsearCsvYahoo(CSV)
  assert.equal(velas.length, 5)
  assert.deepEqual(velas[0], { time: utc(2026, 2, 2, 8, 0), open: 100, high: 101, low: 99, close: 100.5 })
  const verano = parsearCsvYahoo('2026-07-01;15:30;1;2;0;1;Yahoo')
  assert.equal(verano[0].time, utc(2026, 7, 1, 13, 30))
})

test('da las velas del tramo cuando lo cubren entero, y sirven para el MFE/MAE', () => {
  const velas = velasYahooDeOperacion(parsearCsvYahoo(CSV), dax())
  assert.deepEqual(velas.map(v => v.time), [utc(2026, 2, 2, 8, 1), utc(2026, 2, 2, 8, 2), utc(2026, 2, 2, 8, 3)])
  const r = calcularExcursion(dax(), velas)
  assert.equal(r.mfe, 5)    // máximo 106
  assert.equal(r.mae, -4)   // mínimo 97
})

test('si la operación se sale de las velas que hay, no se mide a medias', () => {
  const tarde = dax({ closeTime: madrid(2026, 2, 2, 9, 6) })
  assert.equal(velasYahooDeOperacion(parsearCsvYahoo(CSV), tarde), null)
  const pronto = dax({ openTime: madrid(2026, 2, 2, 8, 59) })
  assert.equal(velasYahooDeOperacion(parsearCsvYahoo(CSV), pronto), null)
})

test('un hueco de más de 5 min dentro del tramo la deja sin medir', () => {
  const conHueco = CSV.replace('2026-02-02;9:01', '2026-02-02;8:50')
  const larga = dax({ openTime: madrid(2026, 2, 2, 8, 50), closeTime: madrid(2026, 2, 2, 9, 4) })
  assert.equal(velasYahooDeOperacion(parsearCsvYahoo(conHueco), larga), null)
})

test('el desfase del día es la mediana de lo que se separan tus ejecuciones del centro de su vela', () => {
  const velas = parsearCsvYahoo(CSV)
  const ejecuciones = [
    { time: utc(2026, 2, 2, 8, 0, 30), precio: 110 },   // centro 100
    { time: utc(2026, 2, 2, 8, 1, 10), precio: 112 },   // centro 101.5
    { time: utc(2026, 2, 2, 8, 2, 50), precio: 113 },   // centro 103.5
    { time: utc(2026, 2, 2, 9, 0), precio: 999 },       // sin vela: no cuenta
  ]
  assert.equal(desfaseDelDia(velas, ejecuciones), 10)
})

test('al Dow se le corrige el desfase y al DAX no', () => {
  const velas = parsearCsvYahoo(CSV)
  const ejecuciones = [{ time: utc(2026, 2, 2, 8, 1, 10), precio: 121.5 }]   // centro 101.5 → +20
  const dow = velasYahooDeOperacion(velas, dax({ producto: 'Wall Street 30', ticker: '^DJI' }), ejecuciones)
  assert.equal(dow[0].high, 123)
  const delDax = velasYahooDeOperacion(velas, dax(), ejecuciones)
  assert.equal(delDax[0].high, 103)
})
