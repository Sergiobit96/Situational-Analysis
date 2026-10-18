// Herramientas de dibujo sobre el gráfico de velas (línea de tendencia, retroceso de
// Fibonacci, ray horizontal) construidas sobre la Primitives API de lightweight-charts v5.
// Interacción: clic-arrastrar para crear, arrastrar extremos/línea para editar,
// clic para seleccionar + Supr/Retroceso para borrar.

const HANDLE_RADIUS = 5
const HIT_TOLERANCE = 6
// Niveles de retroceso (0–1) + niveles de extensión (>1), proyectados con el mismo
// ancho acotado que el retroceso (nunca se extienden infinitamente hacia el borde)
const FIB_RETRACEMENT_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
const FIB_EXTENSION_LEVELS   = [1.272, 1.618, 2, 2.618]
const FIB_LEVELS = [...FIB_RETRACEMENT_LEVELS, ...FIB_EXTENSION_LEVELS]

// Un color distinto por nivel, para diferenciarlos de un vistazo (como en TradingView)
const FIB_COLORS = {
  0:     '#787b86',
  0.236: '#f85149',
  0.382: '#f97316',
  0.5:   '#eab308',
  0.618: '#3fb950',
  0.786: '#3b82f6',
  1:     '#7c3aed',
  1.272: '#06b6d4',
  1.618: '#ec4899',
  2:     '#a855f7',
  2.618: '#f43f5e',
}

const COLOR_POR_TIPO = { trendline: '#7c3aed', fib: '#f59e0b', ray: '#3b82f6' }

function distanciaASegmento(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

// ── Hora <-> posición, también entre velas y fuera de los datos ──
// Los dibujos se guardan por hora y precio y se pintan en cualquier temporalidad: una línea
// trazada en 15 min tiene sus puntos a mitad de una vela de 1 h, y uno anterior al
// histórico cargado cae a la izquierda de la primera vela. timeToCoordinate solo resuelve
// horas que son exactamente una vela (y logicalToCoordinate devuelve 0 con índices no
// enteros), así que la posición se interpola entre las dos velas que rodean la hora y,
// fuera de los datos, se prolonga con el paso de la temporalidad.

// Paso de la temporalidad: el hueco más corto entre las últimas velas (los más largos son
// noches y fines de semana)
export function pasoDe(tiempos) {
  let paso = Infinity
  for (let i = Math.max(1, tiempos.length - 50); i < tiempos.length; i++) {
    const d = tiempos[i] - tiempos[i - 1]
    if (d > 0 && d < paso) paso = d
  }
  return Number.isFinite(paso) ? paso : 60
}

// Dónde cae una hora respecto a las velas: entre la vela `i` y la siguiente (a una fracción
// `frac` del camino), o `barras` velas más allá de la del borde (`borde`) si queda fuera
export function ubicarTiempo(tiempos, t, paso) {
  const n = tiempos.length
  if (n === 0) return null
  if (t < tiempos[0])     return { borde: 0,     barras: (t - tiempos[0]) / paso }
  if (t > tiempos[n - 1]) return { borde: n - 1, barras: (t - tiempos[n - 1]) / paso }
  let lo = 0, hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (tiempos[mid] <= t) lo = mid
    else hi = mid - 1
  }
  if (tiempos[lo] === t) return { i: lo, frac: 0 }
  return { i: lo, frac: (t - tiempos[lo]) / (tiempos[lo + 1] - tiempos[lo]) }
}

function crearEscala(chart, series) {
  // series.data() rehace el array en cada llamada: las horas se guardan y se refrescan
  // cuando cambian los datos (la pestaña Gráfico añade páginas de histórico sobre la marcha)
  let tiempos = []
  let paso = 60
  const refrescar = () => {
    tiempos = series.data().map(v => v.time)
    paso    = pasoDe(tiempos)
  }
  refrescar()
  series.subscribeDataChanged(refrescar)

  return {
    x(time) {
      const u = ubicarTiempo(tiempos, time, paso)
      if (!u) return null
      const escala = chart.timeScale()
      if (u.barras !== undefined) {
        const xBorde = escala.timeToCoordinate(tiempos[u.borde])
        const anchoBarra = escala.logicalToCoordinate(1) - escala.logicalToCoordinate(0)
        return xBorde == null ? null : xBorde + u.barras * anchoBarra
      }
      const x0 = escala.timeToCoordinate(tiempos[u.i])
      if (x0 == null || u.frac === 0) return x0
      const x1 = escala.timeToCoordinate(tiempos[u.i + 1])
      return x1 == null ? x0 : x0 + u.frac * (x1 - x0)
    },
    // Hora de la vela bajo x; más allá de los datos, la que tendría contando velas desde el borde
    tiempo(x) {
      const escala = chart.timeScale()
      const t = escala.coordinateToTime(x)
      if (t != null || tiempos.length === 0) return t
      const indice = escala.coordinateToLogical(x)
      if (indice == null) return null
      const ultima  = tiempos[tiempos.length - 1]
      const iUltima = escala.timeToIndex(ultima, false)
      if (iUltima != null && indice > iUltima) return ultima + (indice - iUltima) * paso
      const iPrimera = escala.timeToIndex(tiempos[0], false)
      if (iPrimera != null && indice < iPrimera) return tiempos[0] + (indice - iPrimera) * paso
      return null
    },
    dispose() { series.unsubscribeDataChanged(refrescar) },
  }
}

// ── Primitives: convierten {time,price} <-> coordenadas de pantalla y dibujan ──
class BaseDrawingPrimitive {
  constructor(drawing, escala, onAttached) {
    this._drawing    = drawing
    this._escala     = escala
    this._onAttached = onAttached
    this._chart = null
    this._series = null
  }
  attached({ chart, series, requestUpdate }) {
    this._chart = chart
    this._series = series
    this._onAttached?.(requestUpdate)
  }
  detached() { this._chart = null; this._series = null }
  updateAllViews() {}
  _coord(p) {
    if (!this._chart || !this._series || p == null) return null
    const x = this._escala.x(p.time)
    const y = this._series.priceToCoordinate(p.price)
    if (x == null || y == null) return null
    return { x, y }
  }
  paneViews() {
    return [{
      renderer: () => ({
        draw: target => target.useMediaCoordinateSpace(scope => this._draw(scope.context, scope.mediaSize)),
      }),
    }]
  }
  _drawHandle(ctx, x, y) {
    ctx.beginPath()
    ctx.arc(x, y, HANDLE_RADIUS, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = this._drawing.color
    ctx.lineWidth = 2
    ctx.fill()
    ctx.stroke()
  }
}

class TrendLinePrimitive extends BaseDrawingPrimitive {
  _draw(ctx) {
    const a = this._coord(this._drawing.p1)
    const b = this._coord(this._drawing.p2)
    if (!a || !b) return
    ctx.save()
    ctx.strokeStyle = this._drawing.color
    ctx.lineWidth = this._drawing.selected ? 2.5 : 1.5
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
    if (this._drawing.selected) { this._drawHandle(ctx, a.x, a.y); this._drawHandle(ctx, b.x, b.y) }
    ctx.restore()
  }
}

class RayPrimitive extends BaseDrawingPrimitive {
  _draw(ctx, size) {
    const a = this._coord(this._drawing.p1)
    if (!a) return
    ctx.save()
    ctx.strokeStyle = this._drawing.color
    ctx.lineWidth = this._drawing.selected ? 2.5 : 1.5
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(size.width, a.y)
    ctx.stroke()
    ctx.font = '11px sans-serif'
    ctx.textBaseline = 'bottom'
    ctx.fillStyle = this._drawing.color
    ctx.fillText(this._drawing.p1.price.toFixed(2), a.x + 6, a.y - 3)
    if (this._drawing.selected) this._drawHandle(ctx, a.x, a.y)
    ctx.restore()
  }
}

class FibonacciPrimitive extends BaseDrawingPrimitive {
  // Sin esto, lightweight-charts solo autoescala el eje de precios a las velas visibles:
  // los niveles de extensión (que caen fuera del rango A-B) quedarían dibujados fuera
  // del área visible. Esto le pide a la librería que amplíe el rango para incluirlos siempre.
  autoscaleInfo() {
    const { price: priceA } = this._drawing.p1
    const { price: priceB } = this._drawing.p2 ?? {}
    if (priceA == null || priceB == null) return null
    const prices = FIB_LEVELS.map(level => priceA + (priceB - priceA) * level)
    return { priceRange: { minValue: Math.min(...prices), maxValue: Math.max(...prices) } }
  }
  _draw(ctx) {
    const a = this._coord(this._drawing.p1)
    const b = this._coord(this._drawing.p2)
    if (!a || !b) return
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x)
    const { price: priceA } = this._drawing.p1
    const { price: priceB } = this._drawing.p2
    ctx.save()
    ctx.font = '11px sans-serif'
    ctx.textBaseline = 'middle'
    for (const level of FIB_LEVELS) {
      const price = priceA + (priceB - priceA) * level
      const y = this._series.priceToCoordinate(price)
      if (y == null) continue
      const color = FIB_COLORS[level] ?? this._drawing.color
      ctx.strokeStyle = color
      ctx.globalAlpha = 0.85
      ctx.lineWidth = level === 0 || level === 1 ? 2.5 : 1.75
      ctx.beginPath()
      ctx.moveTo(x1, y)
      ctx.lineTo(x2, y)
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.fillStyle = color
      ctx.fillText(`${(level * 100).toFixed(1)}%  ${price.toFixed(2)}`, x2 + 4, y)
    }
    if (this._drawing.selected) { this._drawHandle(ctx, a.x, a.y); this._drawHandle(ctx, b.x, b.y) }
    ctx.restore()
  }
}

const CTOR_POR_TIPO = { trendline: TrendLinePrimitive, ray: RayPrimitive, fib: FibonacciPrimitive }

// Botones de la barra de dibujo, compartidos por el gráfico de sesión y la pestaña Gráfico
export const HERRAMIENTAS_DIBUJO = [
  { id: 'cursor',    icon: '↖',   title: 'Cursor / seleccionar' },
  { id: 'trendline', icon: '╱',   title: 'Línea de tendencia' },
  { id: 'fib',       icon: 'Fib', title: 'Fibonacci (retroceso + extensión)' },
  { id: 'ray',       icon: '→',   title: 'Ray horizontal' },
]

// ── Controlador: gestiona modo activo, colección de dibujos e interacción de ratón ──
// `onChange` recibe la lista completa (ver exportar) cada vez que el usuario termina de
// crear, mover o borrar un dibujo; nunca al cargar los guardados ni al desmontar el gráfico,
// para que guardarla no pueda pisar lo que ya había con una lista vacía o a medias.
export function crearHerramientasDibujo({ chart, series, container, onModeChange, onChange }) {
  const drawings   = []
  const primitives = new Map()
  const escala     = crearEscala(chart, series)
  let modo = 'cursor'
  let selectedId = null
  let mouseDownState = null
  let requestUpdateFn = null
  let nextId = 1

  const puntoDesdeCoord = (x, y) => {
    const time  = escala.tiempo(x)
    const price = series.coordinateToPrice(y)
    return time == null || price == null ? null : { time, price }
  }

  // Lo que se guarda de cada dibujo: tipo, color y sus puntos (hora y precio)
  const exportar = () => drawings.map(({ type, color, p1, p2 }) => ({
    type, color, p1: { ...p1 }, p2: p2 ? { ...p2 } : null,
  }))
  const avisar = () => onChange?.(exportar())

  // El arrastre con el ratón para crear/editar dibujos no debe además panear el gráfico
  // (comportamiento nativo de lightweight-charts), así que se desactiva solo mientras
  // hay una herramienta de dibujo activa o se está arrastrando un dibujo existente;
  // en modo cursor sin arrastre, el pan normal del gráfico sigue funcionando.
  const panActivado = activo => chart.applyOptions({ handleScroll: { pressedMouseMove: activo } })

  function requestUpdateAll() { requestUpdateFn?.() }

  function attachPrimitiveFor(drawing) {
    const primitive = new CTOR_POR_TIPO[drawing.type](drawing, escala, fn => { requestUpdateFn = fn })
    series.attachPrimitive(primitive)
    primitives.set(drawing.id, primitive)
  }

  // Añade dibujos guardados (los que ya hubiera se quedan) sin avisar: no hay nada nuevo que guardar
  function cargar(lista) {
    for (const d of lista ?? []) {
      if (!CTOR_POR_TIPO[d?.type] || !d.p1 || (d.type !== 'ray' && !d.p2)) continue
      const drawing = {
        id: nextId++, type: d.type, color: d.color ?? COLOR_POR_TIPO[d.type],
        p1: { ...d.p1 }, p2: d.type === 'ray' ? null : { ...d.p2 }, selected: false,
      }
      drawings.push(drawing)
      attachPrimitiveFor(drawing)
    }
    requestUpdateAll()
  }

  function removeDrawing(id) {
    const primitive = primitives.get(id)
    if (primitive) { series.detachPrimitive(primitive); primitives.delete(id) }
    const idx = drawings.findIndex(d => d.id === id)
    if (idx !== -1) drawings.splice(idx, 1)
    if (selectedId === id) selectedId = null
  }

  function quitarTodos() {
    [...primitives.keys()].forEach(removeDrawing)
    requestUpdateAll()
  }

  // Borrado pedido por el usuario (la papelera): ese sí se guarda
  function clearAll() {
    quitarTodos()
    avisar()
  }

  function selectDrawing(id) {
    drawings.forEach(d => { d.selected = d.id === id })
    selectedId = id
    requestUpdateAll()
  }

  function setMode(m) {
    modo = m
    if (m !== 'cursor') selectDrawing(null)
    container.style.cursor = m === 'cursor' ? 'default' : 'crosshair'
    panActivado(m === 'cursor')
    onModeChange?.(m)
  }

  function hitTestHandles(x, y) {
    for (const d of drawings) {
      const puntos = d.type === 'ray' ? [['p1', d.p1]] : [['p1', d.p1], ['p2', d.p2]]
      for (const [nombre, p] of puntos) {
        const cx = escala.x(p.time)
        const cy = series.priceToCoordinate(p.price)
        if (cx == null || cy == null) continue
        if (Math.hypot(x - cx, y - cy) <= HANDLE_RADIUS + HIT_TOLERANCE) return { id: d.id, handle: nombre }
      }
    }
    return null
  }

  function hitTestLine(x, y) {
    for (let i = drawings.length - 1; i >= 0; i--) {
      const d = drawings[i]
      const ax = escala.x(d.p1.time)
      const ay = series.priceToCoordinate(d.p1.price)
      if (ax == null || ay == null) continue

      if (d.type === 'ray') {
        if (Math.abs(y - ay) <= HIT_TOLERANCE && x >= ax - HIT_TOLERANCE) return d.id
        continue
      }

      const bx = escala.x(d.p2.time)
      const by = series.priceToCoordinate(d.p2.price)
      if (bx == null || by == null) continue

      if (d.type === 'fib') {
        const x1 = Math.min(ax, bx), x2 = Math.max(ax, bx)
        const hit = FIB_LEVELS.some(level => {
          const price = d.p1.price + (d.p2.price - d.p1.price) * level
          const y2 = series.priceToCoordinate(price)
          return y2 != null && Math.abs(y - y2) <= HIT_TOLERANCE && x >= x1 - HIT_TOLERANCE && x <= x2 + HIT_TOLERANCE
        })
        if (hit) return d.id
        continue
      }

      if (distanciaASegmento(x, y, ax, ay, bx, by) <= HIT_TOLERANCE) return d.id
    }
    return null
  }

  function screenXY(e) {
    const rect = container.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function onMouseDown(e) {
    const { x, y } = screenXY(e)

    if (modo !== 'cursor') {
      const p1 = puntoDesdeCoord(x, y)
      if (!p1) return
      const id = nextId++
      const drawing = { id, type: modo, color: COLOR_POR_TIPO[modo], p1, p2: modo === 'ray' ? null : { ...p1 }, selected: false }
      drawings.push(drawing)
      attachPrimitiveFor(drawing)
      mouseDownState = { kind: 'new', id }
      requestUpdateAll()
      return
    }

    const handleHit = hitTestHandles(x, y)
    if (handleHit) {
      selectDrawing(handleHit.id)
      mouseDownState = { kind: 'handle', id: handleHit.id, handle: handleHit.handle }
      panActivado(false)
      return
    }
    const lineHit = hitTestLine(x, y)
    if (lineHit != null) {
      const d = drawings.find(dr => dr.id === lineHit)
      selectDrawing(lineHit)
      mouseDownState = { kind: 'move', id: lineHit, startX: x, startY: y, origP1: { ...d.p1 }, origP2: d.p2 ? { ...d.p2 } : null }
      panActivado(false)
      return
    }
    selectDrawing(null)
  }

  function actualizarCursorHover(x, y) {
    if (modo !== 'cursor') return
    const enHandle = hitTestHandles(x, y)
    const enLinea  = enHandle ? true : hitTestLine(x, y) != null
    container.style.cursor = enHandle ? 'grab' : enLinea ? 'move' : 'default'
  }

  function onMouseMove(e) {
    const { x, y } = screenXY(e)
    if (!mouseDownState) { actualizarCursorHover(x, y); return }

    const d = drawings.find(dr => dr.id === mouseDownState.id)
    if (!d) return
    mouseDownState.movido = true

    if (mouseDownState.kind === 'new') {
      const p = puntoDesdeCoord(x, y)
      if (!p) return
      if (d.type === 'ray') d.p1 = p
      else d.p2 = p
    } else if (mouseDownState.kind === 'handle') {
      const p = puntoDesdeCoord(x, y)
      if (!p) return
      d[mouseDownState.handle] = p
    } else if (mouseDownState.kind === 'move') {
      const dx = x - mouseDownState.startX
      const dy = y - mouseDownState.startY
      const mover = orig => {
        const cx = escala.x(orig.time)
        const cy = series.priceToCoordinate(orig.price)
        if (cx == null || cy == null) return null
        return puntoDesdeCoord(cx + dx, cy + dy)
      }
      const nuevoP1 = mover(mouseDownState.origP1)
      if (nuevoP1) d.p1 = nuevoP1
      if (mouseDownState.origP2) {
        const nuevoP2 = mover(mouseDownState.origP2)
        if (nuevoP2) d.p2 = nuevoP2
      }
    }
    requestUpdateAll()
  }

  function onMouseUp() {
    const estado = mouseDownState
    mouseDownState = null
    if (estado?.kind === 'new') {
      const d = drawings.find(dr => dr.id === estado.id)
      // Un clic sin arrastrar deja una línea o un Fibonacci de longitud cero, invisible y
      // que luego no hay forma de seleccionar: se descarta en vez de guardarlo
      const vacio = d && d.type !== 'ray' && d.p1.time === d.p2.time && d.p1.price === d.p2.price
      if (vacio) {
        removeDrawing(d.id)
        requestUpdateAll()
      } else {
        selectDrawing(estado.id)
        avisar()
      }
      setMode('cursor')
    } else if (estado && modo === 'cursor') {
      panActivado(true)
      if (estado.movido) avisar()
    }
  }

  function onKeyDown(e) {
    if (!(e.key === 'Delete' || e.key === 'Backspace') || selectedId == null) return
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    removeDrawing(selectedId)
    requestUpdateAll()
    avisar()
  }

  container.addEventListener('mousedown', onMouseDown)
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  window.addEventListener('keydown', onKeyDown)

  onModeChange?.(modo)

  return {
    setMode,
    clearAll,
    cargar,
    exportar,
    cuantos: () => drawings.length,
    dispose() {
      container.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('keydown', onKeyDown)
      escala.dispose()
      // sin avisar: desmontar el gráfico no es borrar los dibujos
      quitarTodos()
    },
  }
}
