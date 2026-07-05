// Herramientas de dibujo sobre el gráfico de velas (línea de tendencia, retroceso de
// Fibonacci, ray horizontal) construidas sobre la Primitives API de lightweight-charts v5.
// Interacción: clic-arrastrar para crear, arrastrar extremos/línea para editar,
// clic para seleccionar + Supr/Retroceso para borrar.

const HANDLE_RADIUS = 5
const HIT_TOLERANCE = 6
const FIB_LEVELS    = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]

// Un color distinto por nivel, para diferenciarlos de un vistazo (como en TradingView)
const FIB_COLORS = {
  0:     '#787b86',
  0.236: '#f85149',
  0.382: '#f97316',
  0.5:   '#eab308',
  0.618: '#3fb950',
  0.786: '#3b82f6',
  1:     '#7c3aed',
}

const COLOR_POR_TIPO = { trendline: '#7c3aed', fib: '#f59e0b', ray: '#3b82f6' }

function distanciaASegmento(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

// ── Primitives: convierten {time,price} <-> coordenadas de pantalla y dibujan ──
class BaseDrawingPrimitive {
  constructor(drawing, onAttached) {
    this._drawing    = drawing
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
    const x = this._chart.timeScale().timeToCoordinate(p.time)
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
      ctx.lineWidth = level === 0 || level === 1 ? 1.5 : 1
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

// ── Controlador: gestiona modo activo, colección de dibujos e interacción de ratón ──
export function crearHerramientasDibujo({ chart, series, container, onModeChange }) {
  const drawings   = []
  const primitives = new Map()
  let modo = 'cursor'
  let selectedId = null
  let mouseDownState = null
  let requestUpdateFn = null
  let nextId = 1

  const puntoDesdeCoord = (x, y) => {
    const time  = chart.timeScale().coordinateToTime(x)
    const price = series.coordinateToPrice(y)
    return time == null || price == null ? null : { time, price }
  }

  // El arrastre con el ratón para crear/editar dibujos no debe además panear el gráfico
  // (comportamiento nativo de lightweight-charts), así que se desactiva solo mientras
  // hay una herramienta de dibujo activa o se está arrastrando un dibujo existente;
  // en modo cursor sin arrastre, el pan normal del gráfico sigue funcionando.
  const panActivado = activo => chart.applyOptions({ handleScroll: { pressedMouseMove: activo } })

  function requestUpdateAll() { requestUpdateFn?.() }

  function attachPrimitiveFor(drawing) {
    const primitive = new CTOR_POR_TIPO[drawing.type](drawing, fn => { requestUpdateFn = fn })
    series.attachPrimitive(primitive)
    primitives.set(drawing.id, primitive)
  }

  function removeDrawing(id) {
    const primitive = primitives.get(id)
    if (primitive) { series.detachPrimitive(primitive); primitives.delete(id) }
    const idx = drawings.findIndex(d => d.id === id)
    if (idx !== -1) drawings.splice(idx, 1)
    if (selectedId === id) selectedId = null
  }

  function clearAll() {
    [...primitives.keys()].forEach(removeDrawing)
    requestUpdateAll()
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
        const cx = chart.timeScale().timeToCoordinate(p.time)
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
      const ax = chart.timeScale().timeToCoordinate(d.p1.time)
      const ay = series.priceToCoordinate(d.p1.price)
      if (ax == null || ay == null) continue

      if (d.type === 'ray') {
        if (Math.abs(y - ay) <= HIT_TOLERANCE && x >= ax - HIT_TOLERANCE) return d.id
        continue
      }

      const bx = chart.timeScale().timeToCoordinate(d.p2.time)
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
        const cx = chart.timeScale().timeToCoordinate(orig.time)
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
    if (mouseDownState?.kind === 'new') {
      selectDrawing(mouseDownState.id)
      setMode('cursor')
    } else if (mouseDownState && modo === 'cursor') {
      panActivado(true)
    }
    mouseDownState = null
  }

  function onKeyDown(e) {
    if (!(e.key === 'Delete' || e.key === 'Backspace') || selectedId == null) return
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    removeDrawing(selectedId)
    requestUpdateAll()
  }

  container.addEventListener('mousedown', onMouseDown)
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  window.addEventListener('keydown', onKeyDown)

  onModeChange?.(modo)

  return {
    setMode,
    clearAll,
    dispose() {
      container.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('keydown', onKeyDown)
      clearAll()
    },
  }
}
