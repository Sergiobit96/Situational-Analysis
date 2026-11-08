// Los campos grandes que casi nunca cambian (el historial del SRS, los eventos de las
// tortugas…) solo viajan cuando cambian: el servidor manda la firma de cada uno
// (server/firmas.js) y, si en la siguiente petición le devolvemos la misma, no lo repite.

// `url` con las firmas de la respuesta anterior
export function conFirmas(url, previo) {
  const firmas = Object.entries(previo?.firmas ?? {}).filter(([campo]) => previo[campo] !== undefined)
  if (!firmas.length) return url
  const q = new URLSearchParams(firmas.map(([campo, f]) => [`f_${campo}`, f]))
  return `${url}${url.includes('?') ? '&' : '?'}${q}`
}

// La respuesta nueva con lo que el servidor no ha repetido sacado de la anterior (el mismo
// objeto: así no se recalcula lo que depende de él)
export function juntarFirmas(nuevo, previo) {
  if (!nuevo?.firmas) return nuevo
  const junto = { ...nuevo }
  for (const [campo, f] of Object.entries(nuevo.firmas)) {
    if (junto[campo] === undefined && previo?.firmas?.[campo] === f) junto[campo] = previo[campo]
  }
  return junto
}
