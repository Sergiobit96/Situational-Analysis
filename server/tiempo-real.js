// ── Precios en tiempo real para la pestaña Gráfico ────────────────────────────────
// Velas de 1 min por fuente e instrumento, alimentadas por quien tenga precios en directo
// (de momento IG), y su reparto a los gráficos abiertos por SSE. Este módulo no sabe nada
// de IG: la fuente solo llama a registrarVela con cada actualización.
//
// Se reparten velas de 1 min tal cual, no la temporalidad del gráfico: el navegador ya
// tiene la última vela completa (la del histórico) y le basta con ampliar su máximo y su
// mínimo y mover el cierre. Agrupar aquí exigiría tener en memoria toda la vela de 4 h o
// del día en curso, y del rato anterior a arrancar el servidor no hay nada.

const MAX_VELAS = 3 * 1440        // tres días de velas de 1 min por instrumento
const AL_CONECTAR = 5             // velas que recibe un gráfico al conectarse, para cubrir el hueco con su histórico

const series  = new Map()         // `${fuente}|${ticker}` → { velas, actualizado }
const oyentes = new Set()         // { fuente, ticker, enviar }

export function registrarVela(fuente, ticker, vela) {
  const clave = `${fuente}|${ticker}`
  let s = series.get(clave)
  if (!s) series.set(clave, s = { velas: [], actualizado: 0 })
  const { velas } = s

  const ultima = velas[velas.length - 1]
  if (!ultima || vela.time > ultima.time) velas.push(vela)
  else if (vela.time === ultima.time) velas[velas.length - 1] = vela
  else {
    // la actualización final de un minuto que ya se cerró: se corrige en su sitio
    const i = velas.findLastIndex(v => v.time === vela.time)
    if (i === -1) return
    velas[i] = vela
  }
  if (velas.length > MAX_VELAS) velas.splice(0, velas.length - MAX_VELAS)
  s.actualizado = Date.now()

  for (const o of oyentes) if (o.fuente === fuente && o.ticker === ticker) o.enviar([vela])
}

export function ultimasVelas(fuente, ticker, n = AL_CONECTAR) {
  return series.get(`${fuente}|${ticker}`)?.velas.slice(-n) ?? []
}

export function resumenTiempoReal() {
  return [...series].map(([clave, s]) => {
    const [fuente, ticker] = clave.split('|')
    const ultima = s.velas[s.velas.length - 1]
    return { fuente, ticker, velas: s.velas.length, ultima, hace: Math.round((Date.now() - s.actualizado) / 1000) }
  })
}

// Avisa a una función de cada vela que llegue de una fuente e instrumento (lo usa el bot).
// Devuelve la función que deja de avisar.
export function escuchar(fuente, ticker, alLlegar) {
  const oyente = { fuente, ticker, enviar: alLlegar }
  oyentes.add(oyente)
  return () => oyentes.delete(oyente)
}

// Conecta un gráfico (una respuesta SSE de Express) a una fuente e instrumento. Devuelve la
// función que lo desconecta.
export function suscribir(res, fuente, ticker) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const enviar = velas => res.write(`event: velas\ndata: ${JSON.stringify(velas)}\n\n`)
  const oyente = { fuente, ticker, enviar }
  oyentes.add(oyente)
  enviar(ultimasVelas(fuente, ticker))

  // un comentario cada 20 s: sin él, algún proxy da la conexión por muerta en los ratos sin precios
  const latido = setInterval(() => res.write(': latido\n\n'), 20_000)
  return () => {
    clearInterval(latido)
    oyentes.delete(oyente)
  }
}
