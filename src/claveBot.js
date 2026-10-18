// La clave del bot (BOT_TOKEN de Railway): en producción el servidor la pide para todo lo de
// IG y del bot (server/clave-bot.js); en local no hace falta. Se mete una vez en la pestaña
// Bot y se guarda en este navegador. La usan la pestaña Bot y la fuente IG del Gráfico.

const CLAVE = 'sa.bot.token'

export function leerClaveBot() {
  try { return localStorage.getItem(CLAVE) ?? '' } catch { return '' }
}

export function guardarClaveBot(clave) {
  try { localStorage.setItem(CLAVE, clave) } catch { /* sin almacenamiento */ }
}

// Las cabeceras de una petición a lo de IG o del bot, con la clave
export const conClaveBot = (cabeceras = {}) => ({ ...cabeceras, 'X-Bot-Token': leerClaveBot() })

// El EventSource no manda cabeceras: la clave va en la URL (?token=), que el servidor también acepta
export const urlConClaveBot = url => {
  const clave = leerClaveBot()
  return clave ? `${url}${url.includes('?') ? '&' : '?'}${new URLSearchParams({ token: clave })}` : url
}

// Hay IG en el navegador: en local siempre; en producción, con la clave del bot guardada
export const hayIg = () => import.meta.env.DEV || !!leerClaveBot()
