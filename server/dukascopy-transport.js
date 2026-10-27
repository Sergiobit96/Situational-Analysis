// ── Transporte para las descargas de Dukascopy ────────────────────────────────
// dukascopy-node lleva la URL del datafeed fija en el bundle (`URL_ROOT`, sin opción
// de configurarla) y descarga con el `fetch` global; tampoco expone su `fetcherFn`
// a través de `getHistoricalRates`. Envolver `globalThis.fetch` es, por tanto, el
// único punto donde se puede cambiar el transporte sin parchear node_modules.
//
// Por qué hace falta: desde algunas redes el puerto 443 de datafeed.dukascopy.com se
// queda a ratos en timeout de conexión mientras el 80 sigue respondiendo con normalidad
// (no es un bloqueo permanente: va y viene, de ahí que el modo se reevalúe cada media
// hora en vez de fijarse al arrancar). Y cuando conecta, a veces contesta 429 a todo
// mientras el 80 sirve los mismos ficheros sin problema (medido el 18-oct-2026: tres
// descargas por HTTPS acabaron en 429 y las tres por HTTP entraron enteras). Por eso una
// descarga que falla por HTTPS se repite al momento por HTTP y el modo cambia a HTTP sin
// esperar a la media hora. Los .bi5 son ficheros públicos de datos de
// mercado —sin credenciales, cookies ni cabeceras de sesión—, así que descargarlos por
// HTTP no expone nada; lo único que se pierde es la garantía de integridad del
// transporte, y solo en las redes donde HTTPS ya no era una opción. Donde HTTPS
// responde (Railway, y esta misma red la mayor parte del tiempo) se usa HTTPS.

const HOST         = 'datafeed.dukascopy.com'
const HTTPS_PREFIX = `https://${HOST}/`
const HTTP_PREFIX  = `http://${HOST}/`

// Fichero minúsculo (64 bytes) que sirve de sonda para saber si el 443 responde
const URL_SONDEO        = `${HTTPS_PREFIX}datafeed/EURUSD/metadata/HistoryStart.bi5`
const SONDEO_TIMEOUT_MS = 6_000
const REVALIDAR_MS      = 30 * 60_000   // la red puede cambiar: reevaluar cada media hora

let modo         = null   // 'https' | 'http' | null (sin determinar)
let modoTs       = 0
let determinando = null   // promesa compartida para que N descargas en paralelo sondeen una vez

// Lo que se mide aquí es solo si el 443 conecta: si el servidor contesta cualquier cosa
// —incluido un 404 o un 429— la sonda da HTTPS por bueno. Un 429 en los datos se trata
// después, descarga a descarga (ver el envoltorio de fetch).
async function determinarModo(fetchOriginal) {
  try {
    await fetchOriginal(URL_SONDEO, { signal: AbortSignal.timeout(SONDEO_TIMEOUT_MS) })
    return 'https'
  } catch (err) {
    console.warn(`[Dukascopy] no se puede conectar por HTTPS (${err.cause?.code ?? err.message}); pasando a HTTP`)
    return 'http'
  }
}

async function resolverModo(fetchOriginal) {
  if (modo && Date.now() - modoTs < REVALIDAR_MS) return modo
  if (!determinando) {
    determinando = determinarModo(fetchOriginal).then(m => {
      if (m !== modo) console.log(`[Dukascopy] transporte: ${m.toUpperCase()}`)
      modo = m
      modoTs = Date.now()
      determinando = null
      return m
    })
  }
  return determinando
}

// `bloqueado`: si devuelve true, no sale nada al feed y cada petición contesta como un 429
// (el servidor local lo usa mientras scripts/bajar-dukascopy-todo.mjs baja el histórico,
// para no gastarle el cupo de peticiones de la IP). Quien pide ve lo mismo que con el feed
// limitando: tira de la caché o de la reserva, y la cola de descargas espera.
export function instalarTransporteDukascopy({ bloqueado = null } = {}) {
  const fetchOriginal = globalThis.fetch

  // Resolver el transporte ya, al arrancar: si la sonda se dejara para la primera
  // descarga real, esos segundos saldrían del presupuesto de esa petición y la
  // empujarían al timeout justo cuando el usuario está esperando el gráfico.
  resolverModo(fetchOriginal).catch(() => {})

  globalThis.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url
    // Todo lo que no sea el datafeed de Dukascopy pasa de largo sin tocarse
    if (typeof url !== 'string' || !url.startsWith(HTTPS_PREFIX)) return fetchOriginal(input, init)
    if (bloqueado?.()) {
      ultimo429 = Date.now()
      return new Response('', { status: 429 })
    }

    const porHttp = HTTP_PREFIX + url.slice(HTTPS_PREFIX.length)
    if ((await resolverModo(fetchOriginal)) === 'http') return descargarConEsperaSi429(fetchOriginal, porHttp, init)

    // Por HTTPS, con salida a HTTP en cuanto falle. dukascopy-node no pone timeout propio,
    // así que sin este el intento esperaría los 10 s de conexión de Node por fichero.
    try {
      const resp = await fetchOriginal(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(HTTPS_TIMEOUT_MS) })
      if (resp.status !== 429) return resp
      resp.body?.cancel().catch(() => {})   // libera la conexión: el cuerpo del 429 no sirve
      pasarAHttp('responde 429')
    } catch (err) {
      if (init?.signal?.aborted) throw err   // lo ha cancelado quien pedía, no la red
      pasarAHttp(err.cause?.code ?? err.message)
    }
    return descargarConEsperaSi429(fetchOriginal, porHttp, init)
  }
}

// Margen para un fichero entero por HTTPS: son de unos KB y por HTTP tardan 2-4 s
const HTTPS_TIMEOUT_MS = 8_000

function pasarAHttp(motivo) {
  if (modo !== 'http') console.warn(`[Dukascopy] HTTPS falla (${motivo}); pasando a HTTP`)
  modo   = 'http'
  modoTs = Date.now()
}

// El feed también limita por HTTP: una ráfaga de ficheros (el histórico de años son
// decenas) devuelve 429 durante unos segundos. Esperar un poco y reintentar recupera la
// descarga; insistir sin pausa solo alarga el bloqueo.
const ESPERAS_429_MS = [1_500, 4_000]

async function descargarConEsperaSi429(fetchOriginal, url, init) {
  let resp = await fetchOriginal(url, init)
  for (const espera of ESPERAS_429_MS) {
    if (resp.status !== 429) return resp
    avisarThrottling()
    await new Promise(r => setTimeout(r, espera))
    resp = await fetchOriginal(url, init)
  }
  if (resp.status === 429) avisarThrottling()
  return resp
}

// dukascopy-node trata cualquier respuesta que no sea 200 como un fichero vacío, así que
// sin este aviso un bloqueo por exceso de peticiones se confunde con "no hay datos para
// esa fecha". Se limita a un aviso por minuto para no llenar el log.
const AVISO_THROTTLING_MS = 60_000
let ultimoAvisoThrottling = 0
let ultimo429 = 0
function avisarThrottling() {
  ultimo429 = Date.now()
  if (Date.now() - ultimoAvisoThrottling < AVISO_THROTTLING_MS) return
  ultimoAvisoThrottling = Date.now()
  console.warn('[Dukascopy] 429: el feed está limitando las peticiones de esta IP; los datos llegarán incompletos hasta que se levante')
}

// Si el feed ha contestado 429 hace poco. dukascopy-node lo acaba convirtiendo en un
// "Unknown error" que no dice nada, y con esto se puede explicar el fallo al usuario.
export const dukascopyLimitando = (ventanaMs = 2 * 60_000) => Date.now() - ultimo429 < ventanaMs

// Vuelve a sondear el 443 en la próxima descarga sin esperar a la media hora. Para quien
// ve una descarga colgada a media tarea larga (el cálculo de MFE/MAE): si el 443 se ha
// caído desde el último sondeo, la siguiente ya sale por HTTP en vez de agotar el timeout.
export function revalidarTransporteDukascopy() {
  modoTs = 0
}

// Estado actual del transporte (para logs/diagnóstico)
export const estadoTransporteDukascopy = () => ({
  modo:      modo ?? 'sin determinar',
  evaluadoHace: modo ? Math.round((Date.now() - modoTs) / 1000) : null,
})
