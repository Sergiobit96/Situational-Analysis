// ── Filtros del Gap Filter ──────────────────────────────────────────────────
// El servidor (/api/gap-filter) manda todas las sesiones del periodo, sin filtrar, y los
// filtros se aplican aquí: así cambian al momento y cada opción puede decir cuántas
// sesiones quedarían si se marca.
//
// Dentro de un grupo de varias opciones (días, noticias, días especiales) basta con cumplir
// una; entre grupos se tienen que cumplir todos.

export const TODOS_LOS_DIAS = [1, 2, 3, 4, 5]

export const FILTROS_INICIALES = {
  dias:    new Set(TODOS_LOS_DIAS),
  dir:     'both',
  gapMin:  0,
  gapModo: 'pct',
  eventos: new Set(),
  diasEsp: new Set(),
}

// El gap que se mide: en % del cierre anterior o en puntos. El margen es el del servidor,
// que redondea el % a 3 decimales.
export const medidaGap = (s, gapModo) => (gapModo === 'pts' ? s.openPrice - s.prevClose : s.gapPct)
const pasaGap = (s, gapMin, gapModo) => Math.abs(medidaGap(s, gapModo)) >= gapMin - 0.001

const MESES_INICIO_TRIM = new Set(['01', '04', '07', '10'])
const MESES_FIN_TRIM    = new Set(['03', '06', '09', '12'])

// Primer y último día de negociación de cada mes y trimestre, con las fechas del periodo.
// `fechaInicio` es el día anterior a la primera sesión (la vela que da su cierre previo):
// cuenta para saber cuál es el primer día del mes, como en el servidor. El mes en curso no
// tiene último día todavía: la sesión de hoy no es la última del mes por ser la más reciente.
export function fechasEspeciales(sesiones, fechaInicio, mesActual) {
  const porMes = {}
  const fechas = fechaInicio ? [fechaInicio, ...sesiones.map(s => s.date)] : sesiones.map(s => s.date)
  for (const f of fechas) (porMes[f.slice(0, 7)] ??= []).push(f)

  const esp = { primerMes: new Set(), ultimoMes: new Set(), primerTrim: new Set(), ultimoTrim: new Set() }
  for (const [mes, lista] of Object.entries(porMes)) {
    const ord = [...lista].sort()
    const primero = ord[0], ultimo = ord[ord.length - 1]
    const mm = mes.slice(5, 7)
    esp.primerMes.add(primero)
    if (MESES_INICIO_TRIM.has(mm)) esp.primerTrim.add(primero)
    if (mes === mesActual) continue
    esp.ultimoMes.add(ultimo)
    if (MESES_FIN_TRIM.has(mm)) esp.ultimoTrim.add(ultimo)
  }
  return esp
}

const esDiaEspecial = (s, id, esp) =>
  id === 'festivo' ? Boolean(s.eventos?.includes('FESTIVO')) : Boolean(esp?.[id]?.has(s.date))

// Cada grupo de filtros por separado, para poder contar con todos menos uno
const GRUPOS = {
  dias:    (s, f)      => f.dias.has(s.dayOfWeek),
  dir:     (s, f)      => f.dir === 'both' || s.gapDir === f.dir,
  gap:     (s, f)      => pasaGap(s, f.gapMin, f.gapModo),
  eventos: (s, f)      => f.eventos.size === 0 || Boolean(s.eventos?.some(e => f.eventos.has(e))),
  diasEsp: (s, f, esp) => f.diasEsp.size === 0 || [...f.diasEsp].some(id => esDiaEspecial(s, id, esp)),
}

const cumpleSalvo = (s, f, esp, salvo) =>
  Object.entries(GRUPOS).every(([g, pasa]) => g === salvo || pasa(s, f, esp))

export const filtrarSesiones = (sesiones, f, esp) => sesiones.filter(s => cumpleSalvo(s, f, esp, null))

// Cuántas sesiones quedarían con cada opción: las que cumplen los demás grupos y esa opción.
// Es lo que sale al lado de cada botón; en los grupos de varias opciones no depende de qué
// otras del mismo grupo estén marcadas.
export function contarOpciones(sesiones, f, esp, { umbrales, eventos, diasEsp }) {
  const cuenta = (grupo, cumple) => sesiones.filter(s => cumpleSalvo(s, f, esp, grupo) && cumple(s)).length
  const porClave = (claves, grupo, cumple) => Object.fromEntries(claves.map(k => [k, cuenta(grupo, s => cumple(s, k))]))
  return {
    dias:    porClave(TODOS_LOS_DIAS, 'dias', (s, d) => s.dayOfWeek === d),
    dir:     porClave(['both', 'up', 'down'], 'dir', (s, d) => d === 'both' || s.gapDir === d),
    gap:     porClave(umbrales, 'gap', (s, g) => pasaGap(s, g, f.gapModo)),
    eventos: porClave(eventos, 'eventos', (s, e) => Boolean(s.eventos?.includes(e))),
    diasEsp: porClave(diasEsp, 'diasEsp', (s, id) => esDiaEspecial(s, id, esp)),
  }
}

export const hayFiltros = f =>
  f.dias.size !== TODOS_LOS_DIAS.length || f.dir !== 'both' || f.gapMin !== 0 ||
  f.eventos.size > 0 || f.diasEsp.size > 0
