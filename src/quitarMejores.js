// «Quita las 5 mejores operaciones: ¿sigue ganando?». Si el resultado se va a cero o a
// negativo sin ellas, la ventaja depende de unos pocos días que puede que no se repitan, o
// que en real te pierdas. Sirve para las dos pestañas de Estrategias: en las intradía las
// mejores son las de más R, y en las tortugas las de más % del capital al entrar (en € una
// operación de 2020 pesa más que una de 1995 solo por el interés compuesto).

export const N_MEJORES = 5

// Las `n` de más `valor` que ganan (quitar una que pierde mejoraría el resultado), de mayor a
// menor
export function lasMejores(lista, valor, n = N_MEJORES) {
  return lista
    .filter(x => valor(x) > 0)
    .sort((a, b) => valor(b) - valor(a))
    .slice(0, n)
}

// El backtest de las tortugas sin sus `n` mejores operaciones cerradas. No se vuelve a
// simular (sin ellas cambiarían el filtro de la ruptura anterior y los límites de cartera):
// como cada unidad se dimensiona con el capital de ese momento, sin una operación que dejó un
// p % la cuenta sería (1 + p) veces más pequeña desde su salida, y todo lo que viene después
// también. Mientras está abierta, la diferencia se reparte por igual entre sus sesiones para
// no inventar un hueco el día de la salida (la curva ya iba subiendo con ella).
export function tortugasSinLasMejores(res, n = N_MEJORES) {
  const quitadas = lasMejores(res.operaciones, o => o.pctCapital, n)
  if (!quitadas.length) return { res, quitadas }
  const fuera = new Set(quitadas)
  const posicion = new Map(res.curva.map((p, k) => [p.date, k]))
  // índice en la curva de la primera sesión en o después de la fecha
  const indiceDe = fecha => posicion.get(fecha) ?? res.curva.findIndex(p => p.date >= fecha)
  const factor = res.curva.map(() => 1)
  for (const o of quitadas) {
    const a = indiceDe(o.entrada)
    let b = indiceDe(o.salida)
    if (b < 0) b = res.curva.length - 1
    const total = 1 + o.pctCapital / 100
    for (let k = Math.max(a, 0); k < res.curva.length; k++) {
      factor[k] *= k >= b ? total : total ** ((k - a) / (b - a))
    }
  }
  return {
    res: {
      ...res,
      curva: res.curva.map((p, k) => ({ ...p, valor: p.valor / factor[k] })),
      operaciones: res.operaciones.filter(o => !fuera.has(o)),
    },
    quitadas,
  }
}
