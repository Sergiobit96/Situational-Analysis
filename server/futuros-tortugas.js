// ── Los mercados de las tortugas (1983), para el backtest de la pestaña Estrategias ──
// Las tortugas de Richard Dennis operaban futuros de EE. UU. (las reglas que publicó Curtis
// Faith): bonos a 30 y 10 años, letras a 90 días y eurodólar; franco suizo, marco, libra,
// franco francés, yen y dólar canadiense; S&P 500; oro, plata y cobre; crudo, gasóleo de
// calefacción y gasolina sin plomo; café, cacao, azúcar y algodón. No operaban grano ni carne:
// Dennis ya iba al límite de posiciones en ellos. Aquí, con el futuro de hoy de cada uno en
// Yahoo (desde 2000): la gasolina RBOB hace de la sin plomo y el E-mini del S&P de 500. El
// eurodólar dejó de cotizar en 2023 y Yahoo ya no lo tiene, y las letras a 90 días no se
// negocian desde hace años: las letras salen del tipo a 3 meses (^IRX) como cotizaba su
// futuro, 100 menos el tipo. Las divisas van al contado, como el futuro (dólares por unidad de
// la otra moneda), con el euro por el marco y el franco francés: Yahoo pasa cada mes al
// contrato mensual, que casi no tiene volumen, y así no hay forma de ver el cambio. Al contado
// no hay vencimientos, pero tampoco el diferencial de tipos que lleva el precio del futuro.
//
// Yahoo da cada futuro «continuo»: el contrato más cercano, que salta al siguiente al vencer.
// Ese salto no es un movimiento del precio (en el oro, en torno a 1,5 ATR; en la gasolina,
// hasta 7 al pasar a la de verano) y daría rupturas y stops falsos, así que la serie se empalma
// hacia atrás: cada vela anterior a un cambio de contrato se multiplica por lo que el nuevo
// abrió sobre lo que cerró el viejo (en proporción, para que la N, el nominal y lo que se gana
// en N no cambien). El día del cambio lo dice el volumen (el del contrato que vence se queda
// en casi nada y el del nuevo es el normal), buscado solo en la ventana en que vence cada
// contrato: fuera de ella, un festivo da el mismo dibujo sin ser un cambio.

import { crearDiarioYahoo, recortarSerie } from './acciones-eeuu.js'

// Meses de los contratos y la ventana en que Yahoo pasa al siguiente: [mes relativo al del
// contrato, día] de principio a fin (comprobado con los cambios de 2025-2026 que se ven en el
// volumen). Los financieros, al vencer en su mes; los metales, en el primer aviso, al final
// del mes anterior; el crudo, hacia el 20 del mes anterior; gasóleo, gasolina y azúcar, el
// primer día del mes; café, cacao y algodón, a mitad de su mes. `salto`: cuánto tiene que
// crecer el volumen ese día; en los mensuales de energía basta un 20 % (con el doble se
// escapaban 3 o 4 cambios al año de los 12).
const TRIMESTRAL = [3, 6, 9, 12]
const MENSUAL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
const contratos = (meses, desde, hasta, salto = 2) => ({ meses, desde, hasta, salto })

export const MERCADOS_1983 = [
  { id: 'ZB',  simbolo: 'ZB=F',  nombre: 'Bono 30 años',    original: 'Bono del Tesoro a 30 años', grupo: 'Tipos de interés', contratos: contratos(TRIMESTRAL, [0, 14], [0, 26]) },
  { id: 'ZN',  simbolo: 'ZN=F',  nombre: 'Nota 10 años',    original: 'Nota del Tesoro a 10 años', grupo: 'Tipos de interés', contratos: contratos(TRIMESTRAL, [0, 14], [0, 26]) },
  { id: 'TB',  simbolo: '^IRX',  nombre: 'Letras 90 días',  original: 'Letras del Tesoro a 90 días y eurodólar', grupo: 'Tipos de interés', tipo: true },
  { id: 'CHF', simbolo: 'CHFUSD=X', nombre: 'Franco suizo', original: 'Franco suizo', grupo: 'Divisas', contado: true },
  { id: 'EUR', simbolo: 'EURUSD=X', nombre: 'Euro', original: 'Marco alemán y franco francés', grupo: 'Divisas', contado: true },
  { id: 'GBP', simbolo: 'GBPUSD=X', nombre: 'Libra', original: 'Libra esterlina', grupo: 'Divisas', contado: true },
  { id: 'JPY', simbolo: 'JPYUSD=X', nombre: 'Yen', original: 'Yen', grupo: 'Divisas', contado: true },
  { id: 'CAD', simbolo: 'CADUSD=X', nombre: 'Dólar canadiense', original: 'Dólar canadiense', grupo: 'Divisas', contado: true },
  { id: 'ES',  simbolo: 'ES=F',  nombre: 'S&P 500',         original: 'S&P 500', grupo: 'Índices', contratos: contratos(TRIMESTRAL, [0, 12], [0, 23]) },
  { id: 'GC',  simbolo: 'GC=F',  nombre: 'Oro',             original: 'Oro', grupo: 'Metales', contratos: contratos([2, 4, 6, 8, 10, 12], [-1, 20], [0, 3]) },
  { id: 'SI',  simbolo: 'SI=F',  nombre: 'Plata',           original: 'Plata', grupo: 'Metales', contratos: contratos([3, 5, 7, 9, 12], [-1, 20], [0, 3]) },
  { id: 'HG',  simbolo: 'HG=F',  nombre: 'Cobre',           original: 'Cobre', grupo: 'Metales', contratos: contratos([3, 5, 7, 9, 12], [-1, 20], [0, 3]) },
  { id: 'CL',  simbolo: 'CL=F',  nombre: 'Crudo',           original: 'Crudo', grupo: 'Energía', contratos: contratos(MENSUAL, [-1, 14], [-1, 25], 1.2) },
  { id: 'HO',  simbolo: 'HO=F',  nombre: 'Gasóleo',         original: 'Gasóleo de calefacción', grupo: 'Energía', contratos: contratos(MENSUAL, [-1, 24], [0, 4], 1.2) },
  { id: 'RB',  simbolo: 'RB=F',  nombre: 'Gasolina',        original: 'Gasolina sin plomo', grupo: 'Energía', contratos: contratos(MENSUAL, [-1, 24], [0, 4], 1.2) },
  { id: 'KC',  simbolo: 'KC=F',  nombre: 'Café',            original: 'Café', grupo: 'Blandas', contratos: contratos([3, 5, 7, 9, 12], [0, 12], [0, 24]) },
  { id: 'CC',  simbolo: 'CC=F',  nombre: 'Cacao',           original: 'Cacao', grupo: 'Blandas', contratos: contratos([3, 5, 7, 9, 12], [0, 10], [0, 22]) },
  { id: 'SB',  simbolo: 'SB=F',  nombre: 'Azúcar',          original: 'Azúcar', grupo: 'Blandas', contratos: contratos([3, 5, 7, 10], [-1, 24], [0, 4]) },
  { id: 'CT',  simbolo: 'CT=F',  nombre: 'Algodón',         original: 'Algodón', grupo: 'Blandas', contratos: contratos([3, 5, 7, 10, 12], [0, 3], [0, 14]) },
]
const POR_ID = new Map(MERCADOS_1983.map(m => [m.id, m]))

const CIERRE_FUTUROS = 17 * 60 + 15   // la sesión del día acaba a las 17:00 de Nueva York
const VOLUMEN_NORMAL = 0.3            // el día del cambio, el volumen llega al menos al 30 % de la mediana de las 20 sesiones anteriores

// La ventana [desde, hasta] (YYYY-MM-DD) del contrato de `mes` de `anio`
export function ventana(c, anio, mes) {
  const en = ([rel, dia]) => {
    const primero = new Date(Date.UTC(anio, mes - 1 + rel, 1))
    const diasDelMes = new Date(Date.UTC(primero.getUTCFullYear(), primero.getUTCMonth() + 1, 0)).getUTCDate()
    return new Date(Date.UTC(primero.getUTCFullYear(), primero.getUTCMonth(), Math.min(dia, diasDelMes))).toISOString().slice(0, 10)
  }
  return [en(c.desde), en(c.hasta)]
}
const mediana = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0 }

// Los días en que la serie continua de Yahoo pasa al contrato siguiente: en cada ventana, el de
// mayor salto de volumen sobre el día anterior, si lo hay
export function cambiosDeContrato(velas, c) {
  const cambios = []
  if (velas.length < 25) return cambios
  const primero = Number(velas[0].date.slice(0, 4)), ultimo = Number(velas.at(-1).date.slice(0, 4))
  let k = 1
  for (let anio = primero; anio <= ultimo; anio++) {
    for (const mes of c.meses) {
      const [a, b] = ventana(c, anio, mes)
      while (k < velas.length && velas[k].date < a) k++
      let mejor = null
      for (let i = k; i < velas.length && velas[i].date <= b; i++) {
        if (i < 21) continue
        const antes = Math.max(velas[i - 1].volume, 1)
        const normal = mediana(velas.slice(i - 21, i - 1).map(v => v.volume))
        const salto = velas[i].volume / antes
        if (salto >= c.salto && velas[i].volume >= VOLUMEN_NORMAL * normal && (!mejor || salto > mejor.salto)) mejor = { i, salto }
      }
      if (mejor && cambios.at(-1) !== mejor.i) cambios.push(mejor.i)
    }
  }
  return cambios
}

// Empalma hacia atrás: las velas anteriores a cada cambio, multiplicadas por apertura del
// nuevo / cierre del viejo (acumulado). Fuera las que no tienen precio positivo (el crudo
// llegó a −37 $ el 20-abr-2020, el día antes de vencer el contrato de mayo).
export function empalmar(velasCrudas, c) {
  const velas = velasCrudas.filter(v => v.low > 0 && v.close > 0 && v.open > 0)
  const cambios = cambiosDeContrato(velas, c)
  const factor = new Array(velas.length).fill(1)
  let f = 1
  let j = cambios.length - 1
  for (let i = velas.length - 1; i >= 0; i--) {
    factor[i] = f
    if (j >= 0 && cambios[j] === i) {
      f *= velas[i].open / velas[i - 1].close
      j--
    }
  }
  return {
    velas: velas.map((v, i) => (factor[i] === 1 ? v : { ...v, open: v.open * factor[i], high: v.high * factor[i], low: v.low * factor[i], close: v.close * factor[i] })),
    cambios: cambios.map(i => ({ date: velas[i].date, salto: velas[i].open / velas[i - 1].close - 1 })),
  }
}

// Las letras a 90 días como cotizaba su futuro: 100 menos el tipo (el máximo del precio es el
// mínimo del tipo)
export const letrasDeTipo = velas => velas.map(v => ({ date: v.date, open: 100 - v.open, high: 100 - v.low, low: 100 - v.high, close: 100 - v.close, volume: 0 }))

const entreSemana = v => ![0, 6].includes(new Date(`${v.date}T12:00:00Z`).getUTCDay())

export function crearFuturosTortugas({ dir, pedirYahoo, ahora, log }) {
  const { serie } = crearDiarioYahoo({
    dir, pedirYahoo, ahora, log, version: 1,
    simbolo: id => POR_ID.get(id).simbolo,
    // las divisas, con la fecha de Londres y el día cerrado a medianoche; lo demás, a las 17:00 de Nueva York
    horario: id => (POR_ID.get(id).contado ? { zona: 'Europe/London', cierreMin: 24 * 60 } : { zona: 'America/New_York', cierreMin: CIERRE_FUTUROS }),
    preparar: (velas, id) => {
      const m = POR_ID.get(id)
      if (m.tipo) return { velas: letrasDeTipo(velas) }
      if (m.contado) return { velas: velas.filter(entreSemana) }
      const { velas: empalmadas, cambios } = empalmar(velas, m.contratos)
      return { velas: empalmadas, info: { cambios } }
    },
  })

  // Todos los mercados desde `desde` (con el calentamiento por delante), codificados
  async function series({ desde = '2000-01-01' } = {}) {
    const salida = [], fallos = [], avisos = []
    await Promise.all(MERCADOS_1983.map(async m => {
      try {
        const s = await serie(m.id)
        salida.push({ id: m.id, ...recortarSerie(s.serie, desde), cambios: s.info?.cambios?.length ?? 0 })
        if (s.aviso) avisos.push(`${m.nombre}: ${s.aviso}`)
      } catch (err) { fallos.push({ id: m.id, error: err.message }) }
    }))
    const orden = new Map(MERCADOS_1983.map((m, k) => [m.id, k]))
    salida.sort((a, b) => orden.get(a.id) - orden.get(b.id))
    return { mercados: MERCADOS_1983.map(m => ({ id: m.id, simbolo: m.simbolo, nombre: m.nombre, original: m.original, grupo: m.grupo })), series: salida, fallos, avisos }
  }

  return { series }
}
