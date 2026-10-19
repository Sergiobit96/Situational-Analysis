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
//
// También da la última vela en directo: mientras algún gráfico siga un instrumento, se le
// pregunta al terminal cada segundo por sus dos últimas velas de 1 min y las que cambian van
// a tiempo-real.js, igual que las del streaming de IG. No hay cupo que gastar.
import { spawn as spawnReal } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { registrarVela } from './tiempo-real.js'

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

const CADA_MS       = 1000      // cada cuánto se pregunta por la vela en directo
const TRAS_ERROR_MS = 15_000    // con el terminal o Python caídos, sin martillear
// Una vela de 1 min de hace más de diez es de un mercado cerrado (el fin de semana, la pausa
// de los índices americanos): no se reparte como si fuera directo
const VIEJA_S = 10 * 60

export function crearMt5({
  python = 'python', env = process.env, simbolos = SIMBOLOS_MT5, spawn = spawnReal, log = console.log,
  registrar = registrarVela, ahora = Date.now,
} = {}) {
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

  // ── Directo ──
  const seguidos = new Map()   // ticker → gráficos que lo siguen
  const vistas   = new Map()   // ticker → Map(hora → 'o|h|l|c' de la última vela repartida)
  let reloj      = null
  let sondeando  = false
  let errorDirecto = null
  let ultimoSondeo = null

  async function sondear() {
    reloj = null
    if (!seguidos.size) return
    sondeando = true
    let espera = CADA_MS
    try {
      const tickers = [...seguidos.keys()]
      const { velas, errores } = await pedir('directo', { simbolos: tickers.map(t => simbolos[t]) })
      const viejas = ahora() / 1000 - VIEJA_S
      for (const ticker of tickers) {
        let vistasDe = vistas.get(ticker)
        if (!vistasDe) vistas.set(ticker, vistasDe = new Map())
        for (const v of velas[simbolos[ticker]] ?? []) {
          if (v.time < viejas) continue
          const clave = `${v.open}|${v.high}|${v.low}|${v.close}`
          if (vistasDe.get(v.time) === clave) continue
          vistasDe.set(v.time, clave)
          registrar('mt5', ticker, v)
        }
        // basta con recordar las últimas
        for (const t of [...vistasDe.keys()].sort((a, b) => a - b).slice(0, -4)) vistasDe.delete(t)
      }
      const fallos = Object.entries(errores ?? {})
      errorDirecto = fallos.length ? fallos.map(([s, e]) => `${s}: ${e}`).join('; ') : null
      ultimoSondeo = ahora()
    } catch (err) {
      if (err.message !== errorDirecto) log('[mt5] directo:', err.message)
      errorDirecto = err.message
      espera = TRAS_ERROR_MS
    } finally {
      sondeando = false
    }
    if (seguidos.size && !reloj) reloj = setTimeout(sondear, espera)
  }

  return {
    simboloDe: ticker => simbolos[ticker] ?? null,

    // Un gráfico empieza a seguir la vela en directo de un instrumento. Devuelve la función
    // que lo suelta; sin nadie siguiendo nada, se deja de preguntar al terminal.
    seguir(ticker) {
      if (!simbolos[ticker]) return () => {}
      seguidos.set(ticker, (seguidos.get(ticker) ?? 0) + 1)
      if (!reloj && !sondeando) sondear()
      let soltado = false
      return () => {
        if (soltado) return
        soltado = true
        const n = seguidos.get(ticker) - 1
        if (n > 0) { seguidos.set(ticker, n); return }
        seguidos.delete(ticker)
        vistas.delete(ticker)
        if (!seguidos.size) { clearTimeout(reloj); reloj = null }
      }
    },

    directo: () => ({
      siguiendo: Object.fromEntries(seguidos),
      ultimoSondeo: ultimoSondeo && new Date(ultimoSondeo).toISOString(),
      error: errorDirecto,
    }),

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
      seguidos.clear()
      clearTimeout(reloj)
      reloj = null
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
