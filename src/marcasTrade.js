// Dónde se pinta en el gráfico cada entrada y salida del diario.
//
// Las operaciones se ejecutaron con los precios del bróker y las velas son de otro
// proveedor (Dukascopy). Entre los dos hay pequeñas diferencias: en 2026 la mayor fue del
// 0,074 % del precio (Nasdaq; Dow 0,067 %, DAX 0,037 %, UK 100 0,035 %), con lo que algunas
// marcas quedaban flotando fuera de su vela. Hasta TOLERANCIA_PEGADO la marca se pega al
// máximo o al mínimo de la vela; más allá se deja en su precio, porque una diferencia así
// ya dice algo de los datos (una hora mal, otro instrumento) y no hay que esconderla.
export const TOLERANCIA_PEGADO = 0.001

// Separación entre velas: la menor de las primeras, para que un hueco (la noche, un
// festivo) no la agrande
export function pasoDeVelas(velas) {
  let paso = Infinity
  for (let k = 1; k < Math.min(velas.length, 50); k++) {
    const d = velas[k].time - velas[k - 1].time
    if (d > 0 && d < paso) paso = d
  }
  return Number.isFinite(paso) ? paso : 60
}

// La vela (en orden por `time`) dentro de la que cae el instante t, o null si cae antes de
// la primera, después de la última o en un hueco sin velas
export function velaQueContiene(velas, paso, t) {
  let lo = 0, hi = velas.length - 1, k = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (velas[mid].time <= t) { k = mid; lo = mid + 1 }
    else hi = mid - 1
  }
  return k >= 0 && t - velas[k].time < paso ? velas[k] : null
}

// La marca va sobre la vela que contiene su hora (no entre dos velas, que la dejaba junto
// a la siguiente) y, si se sale de ella por poco, pegada a su extremo
export function pegarAVela(velas, paso, t, precio) {
  const v = velaQueContiene(velas, paso, t)
  if (!v) return { time: t, price: precio }
  const fuera = precio > v.high ? precio - v.high : precio < v.low ? v.low - precio : 0
  const pegar = fuera > 0 && fuera <= TOLERANCIA_PEGADO * precio
  return { time: v.time, price: pegar ? Math.min(Math.max(precio, v.low), v.high) : precio }
}
