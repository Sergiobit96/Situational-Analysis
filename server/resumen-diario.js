// ── Resumen del día por Telegram ────────────────────────────────────────────────────────
// De lunes a viernes a las 23:15 de Madrid (cerrado ya Nueva York y el día de las materias
// primas, que acaba a las 17:00 de allí), un mensaje con lo que ha dejado el día cada bot, el
// saldo de la cuenta y su caída desde el máximo, y lo que queda abierto con lo que se perdería
// si saltaran todos los stops. El máximo del saldo y el último día mandado se guardan en disco.

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { fechaEnZona } from './zonas.js'

const ZONA = 'Europe/Madrid'
const HORA = 23 * 60 + 15
const euros = x => `${x > 0.5 ? '+' : x < -0.5 ? '−' : ''}${Math.abs(Math.round(x)).toLocaleString('es-ES')} €`
const saldoTexto = x => `${Math.round(x).toLocaleString('es-ES')} €`
const minutoEnZona = (t, zona) => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: zona, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t * 1000))
  return Number(p.find(x => x.type === 'hour').value) * 60 + Number(p.find(x => x.type === 'minute').value)
}
const diaLargo = t => new Date(t * 1000).toLocaleDateString('es-ES', { timeZone: ZONA, weekday: 'long', day: 'numeric', month: 'long' })

// Lo que dejó hoy (fecha de Madrid) cada bot: `bots`: [{ nombre, cerradasHoy(fecha) → [eur] }]
// `posiciones`: las de la cartera ([{ bot, riesgoEur }]); `cuenta`: { saldo } o null
export function textoResumen({ t, bots, posiciones, cuenta, pico }) {
  const fecha = fechaEnZona(t, ZONA)
  const lineas = [`📊 Resumen del día, ${diaLargo(t)}`]
  if (cuenta?.saldo != null) {
    const caida = pico > 0 ? 100 * (cuenta.saldo / pico - 1) : 0
    lineas.push(`Cuenta: ${saldoTexto(cuenta.saldo)}${caida < -0.05 ? ` (${caida.toFixed(1).replace('.', ',')} % desde el máximo de ${saldoTexto(pico)})` : ' (en máximos)'}`)
  }
  const porBot = bots.map(b => {
    let eur = []
    try { eur = b.cerradasHoy(fecha) } catch { /* un bot roto no tumba el resumen */ }
    return { nombre: b.nombre, n: eur.length, total: eur.reduce((s, x) => s + x, 0) }
  })
  const total = porBot.reduce((s, b) => s + b.total, 0)
  const conAlgo = porBot.filter(b => b.n)
  lineas.push(`Hoy: ${conAlgo.length ? euros(total) : 'ninguna operación cerrada'}`)
  for (const b of conAlgo) lineas.push(`  ${b.nombre}: ${euros(b.total)} (${b.n} ${b.n === 1 ? 'cerrada' : 'cerradas'})`)
  const abiertas = posiciones.length
  if (!abiertas) lineas.push('Nada abierto')
  else {
    const riesgo = posiciones.reduce((s, p) => s + (p.riesgoEur ?? 0), 0)
    lineas.push(`Abierto: ${abiertas} ${abiertas === 1 ? 'posición' : 'posiciones'}, ${saldoTexto(riesgo)} en riesgo hasta los stops`)
    const grupos = new Map()
    for (const p of posiciones) {
      const g = grupos.get(p.bot) ?? { n: 0, riesgo: 0 }
      g.n++; g.riesgo += p.riesgoEur ?? 0
      grupos.set(p.bot, g)
    }
    lineas.push(`  ${[...grupos].map(([bot, g]) => `${bot}: ${g.n} (${saldoTexto(g.riesgo)})`).join(', ')}`)
  }
  return lineas.join('\n')
}

export function crearResumenDiario({ ig, cartera, bots, archivo = null, avisar = () => {}, log = console.log, ahora = () => Math.floor(Date.now() / 1000) }) {
  let guardado = { pico: null, ultimo: null }
  try { guardado = { ...guardado, ...JSON.parse(readFileSync(archivo, 'utf8')) } } catch { /* primera vez */ }
  const guardar = () => {
    if (!archivo) return
    try {
      writeFileSync(`${archivo}.tmp`, JSON.stringify(guardado))
      renameSync(`${archivo}.tmp`, archivo)
    } catch (err) { log(`[resumen] no se ha podido guardar: ${err.message}`) }
  }
  let reloj = null

  async function mandar() {
    const t = ahora()
    const cuenta = await ig.operar.cuenta().catch(() => null)
    if (cuenta?.saldo != null) guardado.pico = Math.max(guardado.pico ?? cuenta.saldo, cuenta.saldo)
    const texto = textoResumen({ t, bots, posiciones: cartera.estado().posiciones, cuenta, pico: guardado.pico })
    guardado.ultimo = fechaEnZona(t, ZONA)
    guardar()
    try { await avisar(texto) } catch { /* el aviso es lo de menos */ }
    return texto
  }

  // ¿toca? De lunes a viernes, pasada la hora, y una vez al día
  async function mirar() {
    const t = ahora()
    const dow = new Date(`${fechaEnZona(t, ZONA)}T12:00:00Z`).getUTCDay()
    if (dow === 0 || dow === 6 || minutoEnZona(t, ZONA) < HORA || guardado.ultimo === fechaEnZona(t, ZONA)) return null
    return mandar()
  }

  return {
    mirar, mandar,
    iniciar() {
      clearInterval(reloj)
      reloj = setInterval(() => mirar().catch(err => log(`[resumen] ${err.message}`)), 60_000)
      reloj.unref?.()
    },
    parar() { clearInterval(reloj); reloj = null },
  }
}
