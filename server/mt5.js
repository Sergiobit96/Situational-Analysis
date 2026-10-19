// ── MetaTrader 5: velas de los CFD del bróker de tu terminal ─────────────────────────
// El paquete MetaTrader5 solo existe para Python en Windows: este módulo arranca
// server/mt5_puente.py la primera vez que hace falta y le habla por líneas JSON. Solo
// funciona en local, con el terminal instalado; en producción (Railway) no hay MT5.
//
// Con la cuenta de MetaQuotes-Demo (comprobado el 19-oct-2026): velas de 1 min desde
// 2017 en DAX, S&P y Dow, 2018 en el Russell, 2019 en el Nikkei, 2022 en el Nasdaq, 2004 en
// el oro y 2008 en la plata; la horaria, desde 2016. Siguen al contado en la sesión (S&P a
// 0,1 puntos de media, DAX a medio punto). Les faltan del 16-jul al 5-sep-2025, y del
// 4-oct-2024 al 6-ene-2025 el feed de los índices se quedó congelado (el puente quita esos
// días; en EE. UU. quedan algunos a medias). El FTSE (UK100) dejó de cotizar ahí en mayo de
// 2026 y no hay petróleo.
import { spawn as spawnReal } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const PUENTE = join(dirname(fileURLToPath(import.meta.url)), 'mt5_puente.py')

// Ticker de la app → símbolo de MetaQuotes-Demo. Con otro bróker cambian los nombres
// (GER40, NAS100…): MT5_SIMBOLOS en server/.env los sustituye.
export const SIMBOLOS_MT5 = {
  '^GDAXI': 'DE40',
  '^GSPC':  'US500',
  '^NDX':   'USTEC',
  '^DJI':   'US30',
  '^RUT':   'US2000',
  '^N225':  'JPN225',
  'XAUUSD': 'XAUUSD',
  'XAGUSD': 'XAGUSD',
}

// La primera petición arranca Python y, si no está abierto, el terminal: tarda
const ESPERA_PRIMERA_MS = 90_000
const ESPERA_MS = 30_000

export function crearMt5({ python = 'python', env = process.env, simbolos = SIMBOLOS_MT5, spawn = spawnReal, log = console.log } = {}) {
  let proc = null
  let siguienteId = 1
  let respondido = false   // el puente ya contestó alguna vez: el terminal está en marcha
  const pendientes = new Map()

  function arrancar() {
    const este = spawn(python, ['-X', 'utf8', '-u', PUENTE], { env, windowsHide: true })
    proc = este
    let resto = ''
    este.stdout.setEncoding('utf8')
    este.stdout.on('data', trozo => {
      resto += trozo
      let fin
      while ((fin = resto.indexOf('\n')) >= 0) {
        const linea = resto.slice(0, fin).trim()
        resto = resto.slice(fin + 1)
        if (!linea) continue
        let r
        try { r = JSON.parse(linea) } catch { log('[mt5] línea que no es JSON:', linea.slice(0, 200)); continue }
        const p = pendientes.get(r.id)
        if (!p) continue
        pendientes.delete(r.id)
        clearTimeout(p.reloj)
        respondido = true
        if (r.ok) p.resolver(r)
        else p.rechazar(new Error(r.error))
      }
    })
    let errores = ''
    este.stderr.setEncoding('utf8')
    este.stderr.on('data', t => { errores = (errores + t).slice(-2000) })
    // solo cuenta si sigue siendo el puente en uso (cerrar() o un relevo ya lo soltaron)
    const caido = motivo => {
      if (proc !== este) return
      proc = null
      respondido = false
      const err = new Error(/No module named .MetaTrader5/.test(errores)
        ? 'Falta el paquete de Python: pip install MetaTrader5'
        : `El puente de MetaTrader 5 se ha cerrado (${motivo})${errores ? `: ${errores.trim().split('\n').at(-1)}` : ''}`)
      for (const p of pendientes.values()) { clearTimeout(p.reloj); p.rechazar(err) }
      pendientes.clear()
    }
    // escribir a un puente ya cerrado da EPIPE en stdin: lo recoge el 'exit'
    este.stdin.on('error', () => {})
    este.on('error', err => caido(err.code === 'ENOENT' ? `no se encuentra ${python}` : err.message))
    este.on('exit', code => caido(`código ${code}`))
  }

  function pedir(op, datos = {}) {
    if (!proc) arrancar()
    const id = siguienteId++
    const espera = respondido ? ESPERA_MS : ESPERA_PRIMERA_MS
    return new Promise((resolver, rechazar) => {
      const reloj = setTimeout(() => {
        pendientes.delete(id)
        rechazar(new Error(`MetaTrader 5 no contesta en ${espera / 1000} s`))
      }, espera)
      pendientes.set(id, { resolver, rechazar, reloj })
      proc.stdin.write(JSON.stringify({ id, op, ...datos }) + '\n')
    })
  }

  return {
    simboloDe: ticker => simbolos[ticker] ?? null,

    // Velas con hora en [desde, hasta) en una temporalidad de MT5 (m1…h1), en UTC, y la
    // hora de la última anterior a `desde` (null: no hay más histórico)
    async pagina(ticker, tf, desde, hasta) {
      const simbolo = simbolos[ticker]
      if (!simbolo) throw new Error(`MetaTrader 5 no tiene ${ticker}`)
      const { velas, previa } = await pedir('pagina', { simbolo, tf, desde, hasta })
      return { velas, previa }
    },

    estado: () => pedir('estado'),

    cerrar() {
      const p = proc
      proc = null
      p?.kill()
    },
  }
}

// Los símbolos de server/.env (MT5_SIMBOLOS={"^GDAXI":"GER40",...}) encima de los de serie
export function simbolosDeEnv(texto) {
  if (!texto) return SIMBOLOS_MT5
  try { return { ...SIMBOLOS_MT5, ...JSON.parse(texto) } } catch { return SIMBOLOS_MT5 }
}
