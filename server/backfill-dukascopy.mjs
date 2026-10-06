// ── Descarga masiva del histórico de Dukascopy ────────────────────────────────
// El servidor pide las velas de un día cuando alguien abre ese gráfico, y si en ese
// momento el feed está limitando peticiones (429) la sesión cae al fallback de Yahoo.
// Este script hace el trabajo al revés: baja el histórico entero con antelación y sin
// prisa, para que después TODA fecha se sirva del disco y no dependa del feed.
//
// Lo que guarda son los .bi5 tal cual, en la misma carpeta y con el mismo nombre que
// usa la caché de dukascopy-node, así que el servidor los aprovecha sin cambios. Un
// fichero de día (BID_candles_min_1.bi5) es el origen de m1, m5, m15 y m30 —la
// agregación es local—, de modo que una sola descarga cubre los cuatro timeframes.
//
//   node server/backfill-dukascopy.mjs --desde=2020-01-01 --simular
//   node server/backfill-dukascopy.mjs --desde=2020-01-01
//   node server/backfill-dukascopy.mjs --desde=2024-01-01 --instrumentos=deuidxeur,usa500idxusd
//
// Es reanudable: lo ya descargado se salta, así que se puede cortar con Ctrl+C y
// volver a lanzarlo cuando sea.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { instrumentMetaData } from 'dukascopy-node'
import { instalarTransporteDukascopy } from './dukascopy-transport.js'

instalarTransporteDukascopy()

const __dirname = dirname(fileURLToPath(import.meta.url))
const RAW_DIR   = join(__dirname, '.duka-cache', 'bi5')
const SIN_DATOS = join(__dirname, '.duka-cache', 'backfill-sin-datos.json')
const URL_ROOT  = 'https://datafeed.dukascopy.com/datafeed'

// Los mismos instrumentos que sirve el servidor (YF_TO_DUKASCOPY en index.js)
const INSTRUMENTOS = [
  'usa500idxusd', 'usatechidxusd', 'usa30idxusd', 'deuidxeur', 'gbridxgbp',
  'ussc2000idxusd', 'jpnidxjpy', 'xauusd', 'xagusd', 'usoususd',
]

// ── Ritmo ────────────────────────────────────────────────────────────────────
// Medido sobre el terreno: el feed no aguanta un ritmo fijo durante horas. No es un
// límite por segundo sino algo parecido a una cuota por ventana —a ~0,8 ficheros/s
// empieza a devolver 429 a los pocos cientos—, así que la pausa no se fija: sube en
// cuanto aparece un 429 y baja poco a poco mientras todo va bien, hasta dar con el
// ritmo que el feed tolera en ese momento.
const PAUSA_MS_POR_DEFECTO = 1_200
const PAUSA_MAX_MS         = 15_000
const ACIERTOS_PARA_ACELERAR = 50

// Esperas ante un 429 en un fichero concreto. Cortas a propósito: si la cuota está
// agotada, plantarse ocho minutos en un fichero no la recupera y para la descarga
// entera. Mejor saltarlo y recogerlo en la siguiente pasada.
const ESPERAS_429_MS = [15_000, 45_000, 90_000]

// Cuando el 429 deja de ser puntual y pasa a ser todo, es que la IP está penalizada:
// ahí no hay ritmo que valga, solo esperar. Seguir pidiendo en ese estado gasta el plan
// acumulando fallos y, probablemente, alarga el castigo. Se para en seco y se reintenta
// más tarde, cada vez con más margen.
const FALLOS_SEGUIDOS_PARA_PARAR = 8
const DESCANSOS_LARGOS_MS        = [20 * 60_000, 45 * 60_000, 90 * 60_000]

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  })
)

const hoy      = new Date().toISOString().slice(0, 10)
const desde    = args.desde ?? '2020-01-01'
const hasta    = args.hasta ?? new Date(Date.now() - 86400_000).toISOString().slice(0, 10)
const simular  = Boolean(args.simular)
const pausaMs  = Number(args.pausa ?? PAUSA_MS_POR_DEFECTO)
const elegidos = args.instrumentos && args.instrumentos !== 'all'
  ? String(args.instrumentos).split(',').map(s => s.trim().toLowerCase())
  : INSTRUMENTOS

if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
  console.error('Fechas en formato YYYY-MM-DD: --desde=2020-01-01 --hasta=2026-09-15')
  process.exit(1)
}
if (hasta >= hoy) {
  console.error(`--hasta debe ser anterior a hoy (${hoy}): la sesión de hoy aún no ha cerrado`)
  process.exit(1)
}

const espera = ms => new Promise(r => setTimeout(r, ms))

// Nombre con el que dukascopy-node guarda y busca cada fichero: la URL sin la raíz y
// con las barras cambiadas por guiones. El mes va con base 0 (enero = 00).
function rutaFichero(instrument, fecha) {
  const [a, m, d] = fecha.split('-')
  const clave = `${instrument.toUpperCase()}/${a}/${String(Number(m) - 1).padStart(2, '0')}/${d}/BID_candles_min_1.bi5`
  return { url: `${URL_ROOT}/${clave}`, destino: join(RAW_DIR, clave.replace(/\//g, '-')) }
}

// Días sin datos (festivos, paradas del feed): se anotan para no volver a pedirlos en
// cada pasada. Sin esto, una reanudación repetiría todos los festivos del histórico.
function cargarSinDatos() {
  try { return new Set(JSON.parse(readFileSync(SIN_DATOS, 'utf8'))) } catch { return new Set() }
}
function guardarSinDatos(set) {
  try { writeFileSync(SIN_DATOS, JSON.stringify([...set])) } catch { /* no crítico */ }
}

// Fechas laborables del rango; el fin de semana no tiene fichero, no vale la pena pedirlo
function* fechasLaborables(inicio, fin) {
  for (let d = new Date(inicio + 'T00:00:00Z'); d <= new Date(fin + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) yield d.toISOString().slice(0, 10)
  }
}

// Dukascopy no tiene intradía anterior a cierta fecha en cada instrumento; pedirlo son
// peticiones desperdiciadas que además acercan el 429.
function inicioIntradia(instrument) {
  const inicio = instrumentMetaData[instrument]?.startDayForMinuteCandles
  return inicio ? new Date(inicio).toISOString().slice(0, 10) : '1990-01-01'
}

async function descargar(url) {
  let hubo429 = false
  for (let intento = 0; ; intento++) {
    const resp = await fetch(url)
    if (resp.status !== 429) return { resp, hubo429 }
    hubo429 = true
    if (intento >= ESPERAS_429_MS.length) return { resp, hubo429 }
    const pausa = ESPERAS_429_MS[intento]
    console.log(`   · 429: el feed está limitando; esperando ${pausa / 1000}s…`)
    await espera(pausa)
  }
}

async function main() {
  mkdirSync(RAW_DIR, { recursive: true })
  const sinDatos = cargarSinDatos()

  // Plan: qué queda por bajar de verdad, ya descontado lo que hay en disco
  const porInstrumento = []
  for (const instrument of elegidos) {
    if (!instrumentMetaData[instrument]) { console.warn(`instrumento desconocido: ${instrument}`); continue }
    const piso = inicioIntradia(instrument)
    const pendientes = []
    let yaEstan = 0, sinDatosPrevios = 0
    for (const fecha of fechasLaborables(desde < piso ? piso : desde, hasta)) {
      const { url, destino } = rutaFichero(instrument, fecha)
      if (existsSync(destino))                    { yaEstan++;         continue }
      if (sinDatos.has(`${instrument}|${fecha}`)) { sinDatosPrevios++; continue }
      pendientes.push({ instrument, fecha, url, destino })
    }
    console.log(`${instrument.padEnd(15)} intradía desde ${piso} · ${yaEstan} en disco · ${sinDatosPrevios} sin datos · ${pendientes.length} por bajar`)
    // De lo más reciente a lo más antiguo: son horas de descarga y puede cortarse en
    // cualquier momento, así que lo primero que tiene que quedar en disco es lo que
    // más se mira, no los años más viejos.
    pendientes.reverse()
    porInstrumento.push(pendientes)
  }

  // Intercalado entre instrumentos: avanzan todos a la vez y en cualquier punto hay la
  // misma profundidad en los diez, en vez de uno completo y nueve sin empezar.
  const plan = []
  for (let i = 0; porInstrumento.some(lista => i < lista.length); i++) {
    for (const lista of porInstrumento) if (i < lista.length) plan.push(lista[i])
  }

  const total = plan.length
  const horas = total * pausaMs / 3_600_000
  console.log(`\nTotal por descargar: ${total} ficheros · a ${pausaMs} ms cada uno ≈ ${horas < 1 ? Math.round(horas * 60) + ' min' : horas.toFixed(1) + ' h'}`)
  if (simular) { console.log('(--simular: no se descarga nada)'); return }
  if (total === 0) { console.log('Nada que hacer: el rango ya está completo en disco.'); return }

  let bajados = 0, vacios = 0, fallos = 0
  let pausaActual = pausaMs, aciertosSeguidos = 0
  let fallosSeguidos = 0, descansosLargos = 0
  const t0 = Date.now()

  for (const [i, { instrument, fecha, url, destino }] of plan.entries()) {
    // ¿Penalizados? Dormir hasta que se levante antes de seguir gastando el plan.
    if (fallosSeguidos >= FALLOS_SEGUIDOS_PARA_PARAR) {
      const descanso = DESCANSOS_LARGOS_MS[Math.min(descansosLargos, DESCANSOS_LARGOS_MS.length - 1)]
      console.log(`\n== ${fallosSeguidos} fallos seguidos: la IP está penalizada. Pausa de ${descanso / 60_000} min y seguimos (${i}/${total} hecho) ==\n`)
      await espera(descanso)
      descansosLargos++
      fallosSeguidos = 0
      pausaActual = Math.min(PAUSA_MAX_MS, Math.max(pausaActual, 3_000))
    }

    try {
      const { resp, hubo429 } = await descargar(url)

      // Ajuste del ritmo: frenar en seco ante un 429, y recuperar velocidad despacio
      // solo después de una buena racha sin incidencias.
      if (hubo429) {
        pausaActual = Math.min(PAUSA_MAX_MS, Math.round(pausaActual * 1.5))
        aciertosSeguidos = 0
      } else if (++aciertosSeguidos >= ACIERTOS_PARA_ACELERAR) {
        aciertosSeguidos = 0
        pausaActual = Math.max(pausaMs, Math.round(pausaActual * 0.9))
      }

      if (resp.status === 200) {
        fallosSeguidos = 0
        const buf = Buffer.from(await resp.arrayBuffer())
        if (buf.length > 0) {
          writeFileSync(destino, buf)
          bajados++
        } else {
          // 200 con 0 bytes = ese día no cotizó (festivo). Se anota y no se repite.
          sinDatos.add(`${instrument}|${fecha}`)
          vacios++
        }
      } else {
        fallos++; fallosSeguidos++
        if (fallos <= 5) console.warn(`   ! ${instrument} ${fecha}: HTTP ${resp.status}`)
      }
    } catch (err) {
      fallos++; fallosSeguidos++
      if (fallos <= 5) console.warn(`   ! ${instrument} ${fecha}: ${err.cause?.code ?? err.message}`)
    }

    if ((i + 1) % 100 === 0 || i + 1 === total) {
      const transcurrido = (Date.now() - t0) / 1000
      const restante     = (total - i - 1) * (transcurrido / (i + 1))
      guardarSinDatos(sinDatos)
      console.log(`[${i + 1}/${total}] ${bajados} bajados · ${vacios} sin datos · ${fallos} fallos · pausa ${pausaActual} ms · quedan ~${(restante / 60).toFixed(0)} min`)
    }
    await espera(pausaActual)
  }

  guardarSinDatos(sinDatos)
  console.log(`\nListo: ${bajados} ficheros nuevos, ${vacios} días sin datos, ${fallos} fallos en ${((Date.now() - t0) / 60000).toFixed(1)} min`)
  if (fallos > 0) console.log('Los fallos se reintentan solos la próxima vez que se lance (es reanudable).')
}

main().catch(err => { console.error(err); process.exit(1) })
