// Mete una vela de 1 min que llega en directo en la serie del gráfico, sea cual sea su
// temporalidad (`segundos` por vela). Las horas van en hora de Madrid, como las pinta el
// gráfico, y `datos` se modifica en su sitio.
//
// Si cae dentro de la última vela, la amplía: máximo y mínimo se estiran y el cierre se
// mueve. Si cae después, abre una nueva contando periodos enteros desde la última, para
// seguir la misma rejilla que el histórico (la de 4 h y la diaria de cada fuente no
// empiezan donde empezarían contadas desde medianoche). Repetir una actualización no
// cambia nada, así que da igual que llegue dos veces.
//
// Devuelve la vela que hay que pasar a serie.update(), o null si la de 1 min es anterior
// a la última vela del gráfico.
export function meterVelaEnDirecto(datos, vela, segundos) {
  const ultima = datos[datos.length - 1]
  if (!ultima) {
    const nueva = { ...vela, time: Math.floor(vela.time / segundos) * segundos }
    datos.push(nueva)
    return nueva
  }
  if (vela.time < ultima.time) return null

  const periodos = Math.floor((vela.time - ultima.time) / segundos)
  if (periodos === 0) {
    const ampliada = {
      ...ultima,
      high:  Math.max(ultima.high, vela.high),
      low:   Math.min(ultima.low, vela.low),
      close: vela.close,
    }
    datos[datos.length - 1] = ampliada
    return ampliada
  }
  const nueva = { time: ultima.time + periodos * segundos, open: vela.open, high: vela.high, low: vela.low, close: vela.close }
  datos.push(nueva)
  return nueva
}
