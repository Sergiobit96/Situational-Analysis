import { madridOffsetAt } from './timezone'

// ── Estrategia SRS: la 2ª vela de 15 min ───────────────────────────────────────
// El bracket es el máximo y el mínimo de la segunda vela de 15 min de la sesión.
// La primera solo sirve para saber cuál es la segunda. La regla es larga:
//   · se compra cuando el precio supera el máximo del bracket,
//   · se vende cuando toca el mínimo del bracket,
//   · y si no lo toca, la posición se cierra con la sesión.
// Como la venta está en el extremo opuesto al de la compra, 1R = el propio
// rango del bracket y una operación parada vale exactamente −1R.

// Tope de piernas por sesión con "flip the switch": como mucho una compra y una venta, o
// sea la entrada y una única vuelta. Un día de sierra podría encadenarlas sin fin, y eso
// deja de parecerse a lo que uno operaría de verdad.
const MAX_PIERNAS = 2

// Tope de añadidos de la pirámide: a partir de aquí la posición sería absurda para el
// tamaño de un bracket de 15 min.
const MAX_ANADIDOS = 5

// `piramide` admite un número —cada cuántas R se añade una unidad— o un booleano, que es
// como se llamaba cuando el paso era siempre de 1R.
const pasoPiramide = p => (typeof p === 'number' ? p : (p ? 1 : 0))

// Apertura que estudia la estrategia, en minutos desde medianoche de Madrid.
// Los instrumentos que cotizan 24 h (oro, plata, petróleo) no tienen apertura
// propia: se usa la de Nueva York, que es la que mueve su sesión.
export const SESIONES = {
  '^GDAXI': { open:  9 * 60,      close: 17 * 60 + 30, plaza: 'Fráncfort' },
  '^FTSE':  { open:  9 * 60,      close: 17 * 60 + 30, plaza: 'Londres'   },
  '^GSPC':  { open: 15 * 60 + 30, close: 22 * 60,      plaza: 'Nueva York' },
  '^NDX':   { open: 15 * 60 + 30, close: 22 * 60,      plaza: 'Nueva York' },
  '^DJI':   { open: 15 * 60 + 30, close: 22 * 60,      plaza: 'Nueva York' },
  '^RUT':   { open: 15 * 60 + 30, close: 22 * 60,      plaza: 'Nueva York' },
  '^N225':  { open:  1 * 60,      close:  8 * 60,      plaza: 'Tokio'      },
  'XAUUSD': { open: 15 * 60 + 30, close: 22 * 60,      plaza: 'Nueva York' },
  'XAGUSD': { open: 15 * 60 + 30, close: 22 * 60,      plaza: 'Nueva York' },
  'USOIL':  { open: 15 * 60 + 30, close: 22 * 60,      plaza: 'Nueva York' },
}

// Minutos desde medianoche Madrid de un timestamp UTC en segundos
const minutoMadrid = ts => Math.floor(((ts + madridOffsetAt(ts)) % 86400 + 86400) % 86400 / 60)

export const fmtMin = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

export const fmtPts = v =>
  v == null ? '—' : v.toLocaleString('es-ES', { maximumFractionDigits: Math.abs(v) < 10 ? 3 : 1 })

// Analiza una sesión ya descargada en velas del tamaño que pida la estrategia.
// Devuelve { valido: false, motivo } cuando los datos no permiten leer la
// apertura (fallback a h1/diaria, festivo a medias, sesión incompleta…).
// `modo` decide la operativa: 'largo' solo compra por encima de la vela del bracket, 'ambos'
// añade la venta por debajo —manda el extremo que se rompa antes—, 'flip' además da la vuelta
// a la posición cuando salta el stop (flip the switch). La regla de base es siempre la
// rotura: hacia arriba se compra y hacia abajo se vende.
// `stopPct` dice dónde va el stop como fracción del rango del bracket: 1 lo pone en el
// extremo contrario (lo de siempre, 1R = el rango entero) y 0,5 a mitad de vela. Con él
// cambia el tamaño de la R, y con la R el disparador del break even y el paso de la pirámide.
// `tamanoAnadido` es lo que mete cada unidad de la pirámide: 1, o 0,5 para añadir de media
// en media. La entrada vale siempre 1. Cuanto más pequeños los añadidos, menos se desplaza
// el precio medio de la posición hacia el precio actual — y como el stop del conjunto se
// pone justo en ese precio medio, acaba quedando más lejos y la operación respira más.
// `beR` mueve el stop a la entrada (break even) en cuanto el precio recorre esas R a
// favor; null lo deja fijo en el extremo contrario del bracket.
// `tpPct` cierra la posición cuando su resultado acumulado —la suma de TODAS las unidades
// abiertas— llega a ese porcentaje del índice (3,5% = 700 puntos con el DAX en 20.000);
// null la deja correr hasta el stop o el cierre de la sesión. Con una sola unidad equivale
// a pedirle al índice ese recorrido; con la pirámide llega mucho antes, porque cada unidad
// añadida aporta lo suyo al acumulado.
// `velasFinas` (5 min) es opcional: el bracket sigue saliendo de las velas grandes, pero el
// recorrido posterior se camina sobre ellas, que es lo que permite saber qué extremo se
// rompió antes cuando una vela toca los dos y no se sabe si la operación ganó o perdió.
// `ventana` cambia qué se braquetea: por defecto, la 2ª vela de 15 min desde la apertura del
// instrumento, pero recibiendo { open, close, minutosVela, nBracket } se puede braquetear
// otra vela de otro tamaño en otro tramo del día — es lo que usa la Rule of 4, que coge la
// cuarta vela de 10 min desde que sale la noticia del FOMC.
export function analizarSesion({ velas, ticker, modo = 'largo', beR = null, piramide = false, tpPct = null, stopPct = 1, tamanoAnadido = 1, velasFinas = null, finasEtiqueta = '5m', ventana = null }) {
  const ses = ventana ?? SESIONES[ticker]
  if (!ses)           return { valido: false, motivo: 'Instrumento sin apertura definida' }
  if (!velas?.length) return { valido: false, motivo: 'Sin velas' }

  const minutosVela = ses.minutosVela ?? 15
  const paso        = minutosVela * 60
  const nBracket    = ses.nBracket ?? 2

  const enSesion = velas
    .map(v => ({ ...v, min: minutoMadrid(v.time) }))
    .filter(v => v.min >= ses.open && v.min < ses.close)

  const c1 = enSesion[0]
  const c2 = enSesion[nBracket - 1]        // la vela que forma el bracket
  if (!c2)                 return { valido: false, motivo: `La sesión no llega a ${nBracket} velas` }
  if (c1.min !== ses.open) return { valido: false, motivo: `Los datos empiezan a las ${fmtMin(c1.min)}` }
  if (c2.time - c1.time !== (nBracket - 1) * paso) {
    return { valido: false, motivo: `Las velas no son de ${minutosVela} min` }
  }

  const high  = c2.high
  const low   = c2.low
  const rango = high - low
  if (!(rango > 0)) return { valido: false, motivo: 'Rango del bracket nulo' }

  // A partir del bracket se camina sobre las velas finas si las hay
  const finas = velasFinas?.length
    ? velasFinas
        .map(v => ({ ...v, min: minutoMadrid(v.time) }))
        .filter(v => v.min >= ses.open && v.min < ses.close && v.time >= c2.time + paso)
        .sort((a, b) => a.time - b.time)
    : null
  const resolucion = finas?.length ? finasEtiqueta : `${minutosVela}m`

  const resto   = finas?.length ? finas : enSesion.slice(nBracket)
  const ultima  = resto[resto.length - 1] ?? enSesion[enSesion.length - 1]
  const cierre15 = enSesion[enSesion.length - 1]
  const parcial = cierre15.min + minutosVela < ses.close   // la sesión aún no ha terminado

  const comun = {
    valido: true,
    apertura: c1.open, high, low, rango,
    rangoPct: rango / c2.open * 100,
    // color de las dos primeras velas tal como se pintan: blanca cierra por encima de
    // su apertura, negra por debajo
    dir1: c1.close >= c1.open ? 'alcista' : 'bajista',
    dir2: c2.close >= c2.open ? 'alcista' : 'bajista',
    velaBracket: c2.time, velaPrevia: c1.time,
    velasSesion: enSesion.length, parcial, resolucion,
    ventana: ses, minutosVela, nBracket, tamanoAnadido,
    cierreSesion: cierre15.close,
  }

  // Rotura que abre la operación: por arriba se compra y por abajo se vende, mandando el
  // extremo que se rompa antes. En "largo" solo cuenta el máximo.
  const buscaCorto = modo !== 'largo'
  const iEntrada = resto.findIndex(v => v.high > high || (buscaCorto && v.low < low))
  if (iEntrada === -1) {
    return {
      ...comun,
      lado: null, entrada: null, salida: null, flip: null, piernas: [], ambigua: false,
      resultadoPts: null, resultadoTotalPts: null, mfePts: null, maePts: null,
      resultadoR: null, resultadoTotalR: null, mfeR: null, maeR: null,
      tocaAbajoAntes: resto.some(v => v.low <= low),
      resultado: 'sin-entrada',
    }
  }

  const velaEntrada = resto[iEntrada]
  const lado = velaEntrada.high > high ? 'largo' : 'corto'
  // Una vela que entra y toca el stop no dice en qué orden pasó: se lee como la operación
  // que salta en esa misma vela (lo que no infla el resultado) y se marca como ambigua para
  // resolverla con velas más finas. Con el stop al 50% pasa más a menudo, porque el nivel
  // cae dentro de la propia vela del bracket.
  const nivelStop = lado === 'largo' ? high - rango * stopPct : low + rango * stopPct
  const ambigua = lado === 'largo' ? velaEntrada.low <= nivelStop : velaEntrada.high >= nivelStop

  // Flip the switch: el stop de una pierna es exactamente el nivel de entrada de la
  // contraria, así que al saltar se da la vuelta y se sigue dentro del mercado hasta el
  // cierre. Es lo que hace que el lado que no se activó al principio entre igualmente si
  // el precio rompe su nivel más tarde en el día.
  const piernas = []
  let desde = iEntrada
  let ladoActual = lado
  while (true) {
    const p = simularPierna({
      resto, desde, lado: ladoActual, high, low, rango, ultima, ses, beR, piramide, tpPct, stopPct, tamanoAnadido,
      // una pierna abierta al saltar el stop de la anterior no puede morir en esa misma
      // vela: dentro de 15 min no se sabe el orden y encadenaría vueltas irreales
      stopDesde: piernas.length ? desde + 1 : desde,
    })
    piernas.push(p)
    // con el stop a media vela el nivel donde salta ya no es la entrada del lado contrario,
    // así que darle la vuelta ahí sería entrar a un precio que el mercado no está tocando
    if (modo !== 'flip' || stopPct !== 1) break
    if (p.salida.motivo !== 'bracket' || piernas.length >= MAX_PIERNAS) break
    if (p.iSalida >= resto.length - 1) break   // la vuelta caería ya fuera de la sesión
    desde      = p.iSalida
    ladoActual = ladoActual === 'largo' ? 'corto' : 'largo'
  }

  const pierna = piernas[0]
  const vueltas = piernas.slice(1).map(p => ({
    lado: p.lado, entrada: p.entrada, salida: p.salida,
    resultadoPts: p.resultadoPts, resultadoR: p.resultadoR,
    unidades: p.unidades, volumen: p.volumen, anadidos: p.anadidos, objetivo: p.objetivo,
  }))
  const resultadoTotalR   = piernas.reduce((n, p) => n + p.resultadoR, 0)
  const resultadoTotalPts = piernas.reduce((n, p) => n + p.resultadoPts, 0)

  return {
    ...comun,
    lado,
    entrada: pierna.entrada,
    salida:  pierna.salida,
    unidades: pierna.unidades,
    volumen: pierna.volumen,
    anadidos: pierna.anadidos,
    objetivo: pierna.objetivo,
    resultadoPts: pierna.resultadoPts,
    mfePts: pierna.mfePts,
    maePts: pierna.maePts,
    resultadoR: pierna.resultadoR,
    mfeR: pierna.mfeR,
    maeR: pierna.maeR,
    ambigua,
    piernas: vueltas,
    flip: vueltas[0] ?? null,   // la primera vuelta, que es la que resume la tarjeta
    resultadoTotalPts,
    resultadoTotalR,
    tocaAbajoAntes: resto.slice(0, iEntrada).some(v => v.low <= low),
    resultado: resultadoTotalR > 0 ? 'ganada' : 'perdida',
  }
}

// Una pierna de la operación: entra al romper su extremo y sale al tocar el contrario
// (−1R) o, si no lo toca, al cierre de la sesión. 1R es el rango del bracket en los dos
// sentidos, porque entrada y stop están en los extremos opuestos.
function simularPierna({ resto, desde, lado, high, low, rango, ultima, ses, beR = null, stopDesde = desde, piramide = false, tpPct = null, stopPct = 1, tamanoAnadido = 1 }) {
  const paso    = pasoPiramide(piramide)
  const largo   = lado === 'largo'
  const entradaPrecio = largo ? high : low
  // Lo que se arriesga por unidad: el rango entero del bracket, o la fracción que se pida.
  // Es la R de todo lo demás: break even, pirámide y las cifras en R del resumen.
  const riesgo        = rango * stopPct
  const stopPrecio    = largo ? entradaPrecio - riesgo : entradaPrecio + riesgo
  // Objetivo opcional en puntos: ese porcentaje del índice en el momento de entrar, que es
  // lo que tiene que sumar el resultado de toda la posición para cerrarla.
  const objetivo = tpPct == null ? null : entradaPrecio * tpPct / 100
  const v0 = resto[desde]

  const entrada = {
    time:    v0.time,
    min:     v0.min,
    minutos: v0.min - ses.open,
    precio:  entradaPrecio,
  }

  let salida  = null
  let iSalida = resto.length - 1
  let mfe = 0
  let mae = 0
  let stop = stopPrecio      // puede subir a break even
  let beDesde = null         // vela a partir de la cual el stop ya está en la entrada
  // Pirámide: una unidad más cada vez que el precio recorre otro tramo de R a favor (una R,
  // dos R… según lo que se pida), y el stop de TODA la posición al precio medio ponderado,
  // que es donde el conjunto sale a cero.
  const unidades = [entradaPrecio]
  const pesos    = [1]       // la entrada va entera; cada añadido, lo que diga tamanoAnadido
  const anadidos = []        // dónde y a qué precio entró cada unidad de más
  let ultimoCubo5 = null     // tramo de 5 min en el que se añadió la última unidad

  for (let i = stopDesde; i < resto.length; i++) {
    const v = resto[i]
    if (largo ? v.low <= stop : v.high >= stop) {
      salida  = {
        time: v.time, min: v.min, precio: stop,
        motivo: beDesde != null ? 'breakeven' : 'bracket',
      }
      iSalida = i
      mae     = Math.max(mae, Math.abs(entradaPrecio - stop))
      break
    }
    const favor = largo ? v.high - entradaPrecio : entradaPrecio - v.low
    mfe = Math.max(mfe, favor)
    mae = Math.max(mae, largo ? entradaPrecio - v.low : v.high - entradaPrecio)

    // Toma de beneficios: lo que suman todas las unidades en el extremo favorable de la
    // vela. Se mira después del stop (si una vela llega a los dos manda el stop, que es la
    // lectura que no infla el resultado) y antes de añadir volumen, así que la vela que
    // alcanza el objetivo cierra la posición tal como estaba.
    if (objetivo != null) {
      const extremo   = largo ? v.high : v.low
      const acumulado = unidades.reduce((n, u, k) => n + pesos[k] * (largo ? extremo - u : u - extremo), 0)
      if (acumulado >= objetivo) {
        // precio al que el conjunto suma exactamente el objetivo, sin salirse de la vela:
        // por debajo del mínimo (o por encima del máximo) no habría habido con qué cerrar
        const suma    = unidades.reduce((n, u, k) => n + u * pesos[k], 0)
        const volumen = pesos.reduce((a, b) => a + b, 0)
        const exacto = largo
          ? (objetivo + suma) / volumen
          : (suma - objetivo) / volumen
        const precio = largo ? Math.max(exacto, v.low) : Math.min(exacto, v.high)
        salida  = { time: v.time, min: v.min, precio, motivo: 'objetivo' }
        iSalida = i
        break
      }
    }

    // Como mucho una unidad por cada vela de 5 minutos: aunque el precio recorra tres tramos
    // de golpe, en vivo solo da tiempo a una orden. Con velas de 15 min el tramo de 5 es
    // distinto en cada una, así que sale una por vela; con velas de 1 min, una de cada
    // cinco. El precio del añadido sigue siendo su nivel (entrada + n tramos), que es donde
    // estaría puesta la orden.
    if (paso > 0 && unidades.length <= MAX_ANADIDOS) {
      const cubo5 = Math.floor(v.time / 300)
      const salto = unidades.length * paso * riesgo
      if (cubo5 !== ultimoCubo5 && favor >= salto) {
        const precio = largo ? entradaPrecio + salto : entradaPrecio - salto
        unidades.push(precio)
        pesos.push(tamanoAnadido)
        anadidos.push({ time: v.time, min: v.min, precio, unidad: unidades.length, tamano: tamanoAnadido })
        ultimoCubo5 = cubo5
      }
      if (unidades.length > 1) {
        const medio = unidades.reduce((n, u, k) => n + u * pesos[k], 0) / pesos.reduce((a, b) => a + b, 0)
        // el stop solo se aprieta, nunca se afloja
        stop    = largo ? Math.max(stop, medio) : Math.min(stop, medio)
        beDesde = beDesde ?? i + 1
      }
    }

    // El stop se mueve a la entrada cuando el recorrido a favor llega al disparador, pero
    // solo a partir de la vela siguiente, por el mismo motivo.
    if (beR != null && beDesde == null && favor >= beR * riesgo) {
      beDesde = i + 1
      stop    = entradaPrecio
    }
  }
  if (!salida) salida = { time: ultima.time, min: ultima.min, precio: ultima.close, motivo: 'cierre' }

  // Con pirámide el resultado es el de todas las unidades abiertas, que es el sentido de
  // meter más volumen: cada una cuenta desde su propio precio de entrada y por lo que mete.
  const bruto = unidades.reduce((n, u, k) => n + pesos[k] * (largo ? salida.precio - u : u - salida.precio), 0)

  return {
    lado, entrada, salida, iSalida,
    objetivo,
    unidades: unidades.length,
    volumen: pesos.reduce((a, b) => a + b, 0),
    anadidos,
    // en puntos, que es como se lee en el gráfico; la versión en R se conserva porque el
    // bracket es distinto cada día y es lo que permite comparar sesiones entre sí
    resultadoPts: bruto,
    mfePts: mfe,
    maePts: Math.max(mae, 0),
    resultadoR: bruto / riesgo,
    mfeR: mfe / riesgo,
    maeR: Math.max(mae, 0) / riesgo,
  }
}

const mediana = arr => {
  if (arr.length === 0) return null
  const o = [...arr].sort((a, b) => a - b)
  const m = Math.floor(o.length / 2)
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2
}

const media = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null

// Estadísticas del conjunto. Todo lo que describe la operación (aciertos,
// resultado, salidas) se mide solo sobre los días en los que hubo compra.
export function resumir(analisis) {
  const val   = analisis.filter(a => a.valido)
  const ops   = val.filter(a => a.entrada)
  const pct   = (n, total) => total > 0 ? n / total * 100 : null
  // con flip, lo que cuenta es el resultado de la sesión entera (todas sus piernas)
  const erres  = ops.map(a => a.resultadoTotalR ?? a.resultadoR)
  const puntos = ops.map(a => a.resultadoTotalPts ?? a.resultadoPts)
  const ganado  = puntos.filter(p => p > 0).reduce((a, b) => a + b, 0)
  const perdido = Math.abs(puntos.filter(p => p < 0).reduce((a, b) => a + b, 0))

  return {
    n:            val.length,
    descartadas:  analisis.length - val.length,
    nOps:         ops.length,
    nCortos:      ops.filter(a => a.lado === 'corto').length,
    nFlips:       ops.filter(a => a.piernas?.length).length,
    vueltasMax:   ops.reduce((n, a) => Math.max(n, a.piernas?.length ?? 0), 0),
    pctEntrada:   pct(ops.length, val.length),
    pctGanadas:   pct(ops.filter(a => a.resultado === 'ganada').length, ops.length),
    pctVenta:     pct(ops.filter(a => a.salida.motivo === 'bracket').length, ops.length),
    pctBE:        pct(ops.filter(a => a.salida.motivo === 'breakeven').length, ops.length),
    pctObjetivo:  pct(ops.filter(a => a.salida.motivo === 'objetivo').length, ops.length),
    resultadoMed: media(erres),
    resultadoMdn: mediana(erres),
    totalR:       erres.length ? erres.reduce((a, b) => a + b, 0) : null,
    // Profit factor: lo ganado entre lo perdido, en puntos. Sin pérdidas no hay división
    // posible, así que se devuelve null y la interfaz lo pinta como ∞.
    ganadoPts:    ganado,
    perdidoPts:   perdido,
    profitFactor: perdido > 0 ? ganado / perdido : (ganado > 0 ? null : 0),
    resultadoMedPts: media(puntos),
    resultadoMdnPts: mediana(puntos),
    totalPts:        puntos.length ? puntos.reduce((a, b) => a + b, 0) : null,
    mfeMedPts:       mediana(ops.map(a => a.mfePts)),
    mfeMed:       mediana(ops.map(a => a.mfeR)),
    pct1R:        pct(ops.filter(a => a.mfeR >= 1).length, ops.length),
    pct2R:        pct(ops.filter(a => a.mfeR >= 2).length, ops.length),
    pctTocaAntes: pct(ops.filter(a => a.tocaAbajoAntes).length, ops.length),
    minutosMed:   mediana(ops.map(a => a.entrada.minutos)),
    rangoMedPts:  mediana(val.map(a => a.rango)),
    rangoMedPct:  mediana(val.map(a => a.rangoPct)),
  }
}
