import { createHash } from 'crypto'

// Los campos grandes que casi nunca cambian (el historial del SRS, 340 kB; los eventos de las
// tortugas, 100 kB) no se repiten en cada refresco de la pestaña: van con su firma y, si la
// petición trae `f_<campo>` con la misma, el campo se queda fuera (src/firmas.js lo repone).
export function conFirmas(query, cuerpo, campos) {
  const firmas = {}
  const salida = { ...cuerpo }
  for (const campo of campos) {
    if (cuerpo[campo] === undefined) continue
    const f = createHash('sha1').update(JSON.stringify(cuerpo[campo])).digest('base64url').slice(0, 16)
    firmas[campo] = f
    if (query?.[`f_${campo}`] === f) delete salida[campo]
  }
  return { ...salida, firmas }
}
