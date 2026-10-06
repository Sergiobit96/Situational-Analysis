// ── Transporte para las descargas de Dukascopy ────────────────────────────────
// dukascopy-node lleva la URL del datafeed fija en el bundle (`URL_ROOT`, sin opción
// de configurarla) y descarga con el `fetch` global; tampoco expone su `fetcherFn`
// a través de `getHistoricalRates`. Envolver `globalThis.fetch` es, por tanto, el
// único punto donde se puede cambiar el transporte sin parchear node_modules.
//
// Por qué hace falta: desde algunas redes el puerto 443 de datafeed.dukascopy.com se
// queda a ratos en timeout de conexión mientras el 80 sigue respondiendo con normalidad
// (no es un bloqueo permanente: va y viene, de ahí que el modo se reevalúe cada media
// hora en vez de fijarse al arrancar). Los .bi5 son ficheros públicos de datos de
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

// Lo que se mide aquí es el transporte, no el contenido: si el servidor contesta
// cualquier cosa —incluido un 404 o un 429— es que el 443 está abierto y HTTP no
// arreglaría nada. Solo un fallo de conexión (timeout, rechazo, error de TLS)
// justifica bajar a texto claro.
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

export function instalarTransporteDukascopy() {
  const fetchOriginal = globalThis.fetch

  // Resolver el transporte ya, al arrancar: si la sonda se dejara para la primera
  // descarga real, esos segundos saldrían del presupuesto de esa petición y la
  // empujarían al timeout justo cuando el usuario está esperando el gráfico.
  resolverModo(fetchOriginal).catch(() => {})

  globalThis.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url
    // Todo lo que no sea el datafeed de Dukascopy pasa de largo sin tocarse
    if (typeof url !== 'string' || !url.startsWith(HTTPS_PREFIX)) return fetchOriginal(input, init)

    const destino = (await resolverModo(fetchOriginal)) === 'http'
      ? HTTP_PREFIX + url.slice(HTTPS_PREFIX.length)
      : url

    return descargarConEsperaSi429(fetchOriginal, destino, init)
  }
}

// El feed limita las peticiones por IP con bastante mano dura: una ráfaga de ficheros
// (el histórico de años son decenas) devuelve 429 durante unos segundos. Esperar un poco
// y reintentar recupera la descarga; insistir sin pausa solo alarga el bloqueo.
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
function avisarThrottling() {
  if (Date.now() - ultimoAvisoThrottling < AVISO_THROTTLING_MS) return
  ultimoAvisoThrottling = Date.now()
  console.warn('[Dukascopy] 429: el feed está limitando las peticiones de esta IP; los datos llegarán incompletos hasta que se levante')
}

// Estado actual del transporte (para logs/diagnóstico)
export const estadoTransporteDukascopy = () => ({
  modo:      modo ?? 'sin determinar',
  evaluadoHace: modo ? Math.round((Date.now() - modoTs) / 1000) : null,
})
