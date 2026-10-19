import { useState, useRef, useCallback } from 'react'

// Gráficos de las pestañas de los bots (Bot.jsx y BotTortugas.jsx). SVG a mano, sin
// librería: son pocos elementos y así se dibujan con las mismas variables de color que el
// resto de la app (largo azul, corto naranja, ganancia verde, pérdida roja). Los valores que
// enseñan también están en texto al lado (fichas y tablas): el gráfico ayuda, no esconde.

const num = (n, dec) => n.toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec })
const horaMadrid = ts => new Date(ts * 1000).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' })
const fmtMadrid = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })

// El ancho del contenedor, para dibujar el SVG a tamaño real: así el texto del gráfico tiene
// el mismo tamaño que el del resto de la pestaña, sea cual sea el ancho de la ventana
function useAncho(inicial = 720) {
  const [ancho, setAncho] = useState(inicial)
  const observador = useRef(null)
  const ref = useCallback(el => {
    observador.current?.disconnect()
    if (!el) return
    observador.current = new ResizeObserver(([e]) => setAncho(Math.max(300, Math.round(e.contentRect.width))))
    observador.current.observe(el)
  }, [])
  return [ref, ancho]
}

// Segundos desde la medianoche de Madrid
function segundosDelDia(ts) {
  const p = Object.fromEntries(fmtMadrid.formatToParts(new Date(ts * 1000)).map(x => [x.type, x.value]))
  return Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second)
}

// Etiquetas de la derecha: por altura y separadas lo justo para no pisarse (con una raya
// hasta su nivel si hubo que moverlas)
function repartir(etiquetas, arriba, abajo, sep = 13) {
  const ord = [...etiquetas].sort((a, b) => a.y - b.y)
  ord.forEach((e, i) => { e.ly = Math.max(e.y, i ? ord[i - 1].ly + sep : arriba) })
  let tope = abajo
  for (let i = ord.length - 1; i >= 0; i--) {
    ord[i].ly = Math.min(ord[i].ly, tope)
    tope = ord[i].ly - sep
  }
  return ord
}

// ── Bot SRS: la sesión en velas de 15 min con el bracket, las entradas, el stop y el
// siguiente añadido. La sesión entera de ancho, así que lo que falta queda a la derecha. ──
export function GraficoSesion({ velas = [], abre, cierra, minutos = 15, bracket, piernas = [], stop, be, siguiente, precio, ahora, decimales = 1 }) {
  const [sobre, setSobre] = useState(null)
  const [refAncho, W] = useAncho()
  const H = 240
  const M = { l: 4, r: 112, t: 12, b: 22 }
  const ancho = W - M.l - M.r
  const alto = H - M.t - M.b
  const paso = minutos * 60
  const n = Math.max(1, Math.round((cierra - abre) / paso))
  const slot = ancho / n
  const indice = t => Math.min(n - 1, Math.max(0, Math.floor((t - abre) / paso)))
  const xBorde = t => M.l + Math.min(n, Math.max(0, (t - abre) / paso)) * slot
  const xCentro = t => M.l + (indice(t) + 0.5) * slot
  const fin = M.l + ancho

  const vs = velas.map(([time, open, high, low, close]) => ({ time, open, high, low, close }))
  const unidades = piernas.flatMap(p => (p.unidades ?? []).map(u => ({ ...u, lado: p.lado })))
  const abierta = piernas.at(-1) && !piernas.at(-1).salida
  const enCurso = Number.isFinite(ahora) && ahora >= abre && ahora < cierra
  const niveles = [
    ...vs.flatMap(v => [v.high, v.low]), bracket?.high, bracket?.low,
    ...unidades.flatMap(u => [u.entrada, u.salida?.nivel]),
    abierta ? stop : null, abierta ? siguiente : null, enCurso ? precio : null,
  ].filter(Number.isFinite)
  if (!niveles.length) return <p className="bot-nota">Sin velas todavía: el gráfico sale al empezar la sesión.</p>

  let lo = Math.min(...niveles)
  let hi = Math.max(...niveles)
  const margen = (hi - lo || Math.abs(hi) * 0.001 || 1) * 0.08
  lo -= margen
  hi += margen
  const y = p => M.t + ((hi - p) / (hi - lo)) * alto
  const fmt = p => num(p, decimales)
  const bw = Math.max(2, Math.min(slot * 0.62, 12))

  // horas en punto de Madrid (los cambios de hora caen en hora en punto, así que basta UTC)
  const pxHora = (3600 / paso) * slot
  const cadaH = pxHora >= 64 ? 1 : pxHora >= 32 ? 2 : 3
  const marcas = []
  for (let t = Math.ceil(abre / 3600) * 3600; t <= cierra; t += 3600) {
    if (Math.floor(segundosDelDia(t) / 3600) % cadaH === 0) marcas.push(t)
  }

  const primera = unidades[0]
  const ultima = unidades.at(-1)
  const ladoActual = piernas.at(-1)?.lado
  const etiquetas = []
  if (bracket) {
    etiquetas.push({ y: y(bracket.high), texto: `${fmt(bracket.high)}`, clase: 'bracket' })
    etiquetas.push({ y: y(bracket.low), texto: `${fmt(bracket.low)}`, clase: 'bracket' })
  }
  if (abierta && Number.isFinite(stop)) etiquetas.push({ y: y(stop), texto: `stop ${fmt(stop)}${be ? ' · BE' : ''}`, clase: 'stop' })
  if (abierta && Number.isFinite(siguiente)) etiquetas.push({ y: y(siguiente), texto: `+1 en ${fmt(siguiente)}`, clase: ladoActual })
  if (enCurso && Number.isFinite(precio)) etiquetas.push({ y: y(precio), texto: `ahora ${fmt(precio)}`, clase: 'ahora' })
  const colocadas = repartir(etiquetas, M.t + 4, M.t + alto)

  const hover = sobre != null ? vs.find(v => indice(v.time) === sobre) : null
  const resumen = `Sesión en velas de ${minutos} minutos${bracket ? `, bracket de ${fmt(bracket.low)} a ${fmt(bracket.high)}` : ''}${unidades.length ? `, ${unidades.length} entradas` : ''}${abierta && Number.isFinite(stop) ? `, stop en ${fmt(stop)}` : ''}`

  return (
    <div className="bv-grafico" ref={refAncho} onPointerLeave={() => setSobre(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={resumen}>
        {/* horas */}
        {marcas.map(t => (
          <g key={t}>
            <line className="bv-rejilla" x1={xBorde(t)} x2={xBorde(t)} y1={M.t} y2={M.t + alto} />
            <text className="bv-eje" x={xBorde(t)} y={H - 6} textAnchor="middle">{horaMadrid(t)}</text>
          </g>
        ))}

        {/* bracket: la banda desde su vela hasta el final, que es donde se puede romper */}
        {bracket && (
          <g>
            <rect className="bv-bracket" x={xBorde(bracket.vela)} y={y(bracket.high)} width={fin - xBorde(bracket.vela)} height={Math.max(1, y(bracket.low) - y(bracket.high))} />
            <line className="bv-bracket-linea" x1={xBorde(bracket.vela)} x2={fin} y1={y(bracket.high)} y2={y(bracket.high)} />
            <line className="bv-bracket-linea" x1={xBorde(bracket.vela)} x2={fin} y1={y(bracket.low)} y2={y(bracket.low)} />
          </g>
        )}

        {/* velas */}
        {vs.map(v => {
          const x = xCentro(v.time)
          const sube = v.close >= v.open
          const top = y(Math.max(v.open, v.close))
          return (
            <g key={v.time} className={sube ? 'bv-vela-sube' : 'bv-vela-baja'}>
              <line x1={x} x2={x} y1={y(v.high)} y2={y(v.low)} />
              <rect x={x - bw / 2} y={top} width={bw} height={Math.max(1, y(Math.min(v.open, v.close)) - top)} rx={1} />
            </g>
          )
        })}

        {/* ahora */}
        {enCurso && <line className="bv-ahora" x1={xBorde(ahora)} x2={xBorde(ahora)} y1={M.t} y2={M.t + alto} />}

        {/* stop y siguiente añadido, desde la primera entrada y la última */}
        {abierta && primera && Number.isFinite(stop) && (
          <line className="bv-stop" x1={xCentro(primera.hora)} x2={fin} y1={y(stop)} y2={y(stop)} />
        )}
        {abierta && ultima && Number.isFinite(siguiente) && (
          <line className={`bv-siguiente ${ladoActual}`} x1={xCentro(ultima.hora)} x2={fin} y1={y(siguiente)} y2={y(siguiente)} />
        )}

        {/* salidas (cuadrado) y entradas (punto, más grande cuanto más contratos) */}
        {unidades.filter(u => u.salida && Number.isFinite(u.salida.hora)).map(u => (
          <rect key={`s-${u.dealId ?? u.hora}`} className="bv-salida" x={xCentro(u.salida.hora) - 4} y={y(u.salida.nivel) - 4} width={8} height={8} rx={1.5} />
        ))}
        {unidades.map(u => {
          const mayor = Math.max(...unidades.map(x => x.tamano))
          return <circle key={`e-${u.dealId ?? u.hora}`} className={`bv-entrada ${u.lado}`} cx={xCentro(u.hora)} cy={y(u.entrada)} r={3.5 + 2 * Math.sqrt(u.tamano / mayor)} />
        })}

        {/* etiquetas a la derecha */}
        {colocadas.map((e, i) => (
          <g key={i} className={`bv-etiqueta ${e.clase ?? ''}`}>
            {/* la raya, del color del nivel, va de su altura a la de la etiqueta: hace de clave y de guía */}
            <line className="bv-guia" x1={fin + 1} x2={fin + 8} y1={e.y} y2={e.ly} />
            <text x={fin + 11} y={e.ly + 3.5}>{e.texto}</text>
          </g>
        ))}

        {/* cruz del ratón y zonas para pasar por encima de cada vela */}
        {sobre != null && <line className="bv-cruz" x1={M.l + (sobre + 0.5) * slot} x2={M.l + (sobre + 0.5) * slot} y1={M.t} y2={M.t + alto} />}
        {Array.from({ length: n }, (_, i) => (
          <rect key={i} x={M.l + i * slot} y={M.t} width={slot} height={alto} fill="transparent" onPointerEnter={() => setSobre(i)} />
        ))}
      </svg>
      {hover && (
        <div className="bv-tooltip" style={{ left: `${((M.l + (sobre + 0.5) * slot) / W) * 100}%` }}>
          <b>{horaMadrid(hover.time)}</b>
          <span>A {fmt(hover.open)}</span><span>M {fmt(hover.high)}</span><span>m {fmt(hover.low)}</span><span>C <b>{fmt(hover.close)}</b></span>
        </div>
      )}
    </div>
  )
}

// La pirámide: una pieza por posición posible, llenas las abiertas
export function Piramide({ n, max, lado }) {
  return (
    <span className="bv-piramide" title={`${n} de ${max} posiciones abiertas`}>
      {Array.from({ length: max }, (_, i) => <span key={i} className={`bv-pieza ${i < n ? `llena ${lado}` : ''}`} />)}
      <span className="bv-piramide-txt">{n} de {max}</span>
    </span>
  )
}

// ── Bot SRS: las sesiones del día en una línea de 24 h de Madrid, con la hora actual ──
// `filas`: [{ clave, nombre, abre, cierra, clase, derecha, control }]; `clase` colorea la barra
export function LineaDelDia({ filas, ahora }) {
  const inicio = ahora - segundosDelDia(ahora)
  const pct = t => Math.min(100, Math.max(0, ((t - inicio) / 86400) * 100))
  const horas = [0, 3, 6, 9, 12, 15, 18, 21, 24]
  return (
    <div className="bv-dia">
      <div className="bv-dia-fila bv-dia-eje">
        <span />
        <div className="bv-dia-pista">
          {horas.map(h => <span key={h} className="bv-dia-hora" style={{ left: `${(h / 24) * 100}%` }}>{String(h).padStart(2, '0')}</span>)}
        </div>
        <span />
      </div>
      {filas.map(f => (
        <div key={f.clave} className="bv-dia-fila">
          <span className="bv-dia-nombre">{f.control}{f.nombre}</span>
          <div className="bv-dia-pista">
            {horas.map(h => <span key={h} className="bv-dia-rejilla" style={{ left: `${(h / 24) * 100}%` }} />)}
            {f.abre != null && (
              <span className={`bv-dia-barra ${f.clase ?? ''}`} style={{ left: `${pct(f.abre)}%`, width: `${Math.max(0.8, pct(f.cierra) - pct(f.abre))}%` }}
                title={`${horaMadrid(f.abre)} – ${horaMadrid(f.cierra)}`} />
            )}
            <span className="bv-dia-ahora" style={{ left: `${pct(ahora)}%` }} />
          </div>
          <span className="bv-dia-derecha">{f.derecha}</span>
        </div>
      ))}
    </div>
  )
}

// Un valor contra su límite: la pista es un tono suave del mismo color, y el relleno pasa
// a ámbar y a rojo al acercarse al límite. Con `filas`, varias barras en la misma tarjeta
// (cada una con su nombre), p. ej. las unidades largas y cortas de un sistema.
function Barra({ valor, max, etiqueta, umbrales }) {
  const r = max > 0 && Number.isFinite(valor) ? Math.min(1, Math.max(0, valor / max)) : 0
  const nivel = r >= umbrales[1] ? 'alto' : r >= umbrales[0] ? 'medio' : ''
  return (
    <div className="bv-medidor-pista" role="meter" aria-valuenow={valor} aria-valuemin={0} aria-valuemax={max} aria-label={etiqueta}>
      <span className={`bv-medidor-relleno ${nivel}`} style={{ width: `${r * 100}%` }} />
    </div>
  )
}

export function Medidor({ etiqueta, valor, max, texto, sub, filas, umbrales = [0.75, 0.9] }) {
  return (
    <div className="bv-medidor">
      {filas ? <>
        <div className="bv-medidor-cab"><span>{etiqueta}</span></div>
        {filas.map(f => (
          <div key={f.nombre} className="bv-medidor-fila">
            <span>{f.nombre}</span>
            <Barra valor={f.valor} max={f.max} etiqueta={`${etiqueta} · ${f.nombre}`} umbrales={umbrales} />
            <b>{f.texto}</b>
          </div>
        ))}
      </> : <>
        <div className="bv-medidor-cab"><span>{etiqueta}</span><b>{texto}</b></div>
        <Barra valor={valor} max={max} etiqueta={etiqueta} umbrales={umbrales} />
      </>}
      {sub && <small>{sub}</small>}
    </div>
  )
}

// ── Bot Tortugas: dónde está el precio dentro de sus canales ──
// La pista es el canal de 55 sesiones (el del Sistema 2) y la parte clara, el de 20 (el del
// Sistema 1). Arriba, los niveles de compra; abajo, los de venta; el punto es el precio, y
// con posición, la raya roja es su stop.
export function Canal({ plan, precio, posiciones = {}, lados = 'ambos', fmt }) {
  const s1 = plan?.sistemas?.[1]
  const s2 = plan?.sistemas?.[2]
  if (!s1 || !s2 || !Number.isFinite(precio)) return null
  const stops = Object.values(posiciones).filter(Boolean).map(p => p.stop).filter(Number.isFinite)
  const todos = [s1.entrada.largo.nivel, s1.entrada.corto.nivel, s2.entrada.largo.nivel, s2.entrada.corto.nivel, precio, ...stops]
  let lo = Math.min(...todos)
  let hi = Math.max(...todos)
  const m = (hi - lo || Math.abs(hi) * 0.001) * 0.05
  lo -= m
  hi += m
  const W = 200, H = 34, L = 5, R = 5
  const x = p => L + ((p - lo) / (hi - lo)) * (W - L - R)
  const compra = lados !== 'cortos'
  const venta = lados !== 'largos'
  const titulo = [
    compra && `compra S1 ${fmt(s1.entrada.largo.nivel)} · S2 ${fmt(s2.entrada.largo.nivel)}`,
    venta && `venta S1 ${fmt(s1.entrada.corto.nivel)} · S2 ${fmt(s2.entrada.corto.nivel)}`,
    `precio ${fmt(precio)}`,
  ].filter(Boolean).join(' · ')
  return (
    <svg className="bv-canal" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={titulo}>
      <title>{titulo}</title>
      <rect className="bv-canal-55" x={x(s2.entrada.corto.nivel)} y={14} width={Math.max(1, x(s2.entrada.largo.nivel) - x(s2.entrada.corto.nivel))} height={6} rx={3} />
      <rect className="bv-canal-20" x={x(s1.entrada.corto.nivel)} y={14} width={Math.max(1, x(s1.entrada.largo.nivel) - x(s1.entrada.corto.nivel))} height={6} rx={3} />
      {compra && <line className="bv-canal-marca largo" x1={x(s1.entrada.largo.nivel)} x2={x(s1.entrada.largo.nivel)} y1={7} y2={14} />}
      {compra && <line className="bv-canal-marca largo" x1={x(s2.entrada.largo.nivel)} x2={x(s2.entrada.largo.nivel)} y1={3} y2={14} />}
      {venta && <line className="bv-canal-marca corto" x1={x(s1.entrada.corto.nivel)} x2={x(s1.entrada.corto.nivel)} y1={20} y2={27} />}
      {venta && <line className="bv-canal-marca corto" x1={x(s2.entrada.corto.nivel)} x2={x(s2.entrada.corto.nivel)} y1={20} y2={31} />}
      {stops.map((s, i) => <line key={i} className="bv-canal-stop" x1={x(s)} x2={x(s)} y1={10} y2={24} />)}
      <circle className="bv-canal-precio" cx={x(precio)} cy={17} r={4.5} />
    </svg>
  )
}

// ── Resultado acumulado (una línea, con el cero de referencia) ──
// `puntos`: [{ etiqueta, valor, acumulado }] en orden
export function CurvaResultados({ puntos, unidad = '€' }) {
  const [sobre, setSobre] = useState(null)
  const [refAncho, W] = useAncho()
  if (puntos.length < 2) return null
  const H = 180
  const M = { l: 52, r: 16, t: 12, b: 22 }
  const ancho = W - M.l - M.r
  const alto = H - M.t - M.b
  const vals = puntos.map(p => p.acumulado)
  let lo = Math.min(0, ...vals)
  let hi = Math.max(0, ...vals)
  if (hi === lo) hi = lo + 1
  // marcas redondas del eje
  const bruto = (hi - lo) / 3
  const mag = 10 ** Math.floor(Math.log10(bruto))
  const pasoEje = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= bruto)
  lo = Math.floor(lo / pasoEje) * pasoEje
  hi = Math.ceil(hi / pasoEje) * pasoEje
  const marcas = []
  for (let v = lo; v <= hi + pasoEje / 2; v += pasoEje) marcas.push(v)
  const x = i => M.l + (puntos.length === 1 ? ancho / 2 : (i / (puntos.length - 1)) * ancho)
  const y = v => M.t + ((hi - v) / (hi - lo)) * alto
  const linea = puntos.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.acumulado).toFixed(1)}`).join('')
  const area = `${linea}L${x(puntos.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`
  const ultimo = puntos.at(-1)
  const tono = ultimo.acumulado >= 0 ? 'sube' : 'baja'
  const fmtV = v => `${v > 0 ? '+' : ''}${num(v, 0)} ${unidad}`
  const p = sobre != null ? puntos[sobre] : null
  return (
    <div className="bv-grafico" ref={refAncho} onPointerLeave={() => setSobre(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Resultado acumulado: ${fmtV(ultimo.acumulado)} en ${puntos.length} operaciones`}>
        {marcas.map(v => (
          <g key={v}>
            <line className={v === 0 ? 'bv-cero' : 'bv-rejilla'} x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} />
            <text className="bv-eje" x={M.l - 6} y={y(v) + 3.5} textAnchor="end">{num(v, 0)}</text>
          </g>
        ))}
        <path className={`bv-area ${tono}`} d={area} />
        <path className={`bv-linea ${tono}`} d={linea} />
        <circle className={`bv-punto ${tono}`} cx={x(puntos.length - 1)} cy={y(ultimo.acumulado)} r={4.5} />
        <text className="bv-eje" x={M.l} y={H - 6}>{puntos[0].etiqueta}</text>
        <text className="bv-eje" x={W - M.r} y={H - 6} textAnchor="end">{ultimo.etiqueta}</text>
        {p && <line className="bv-cruz" x1={x(sobre)} x2={x(sobre)} y1={M.t} y2={M.t + alto} />}
        {p && <circle className={`bv-punto ${p.acumulado >= 0 ? 'sube' : 'baja'}`} cx={x(sobre)} cy={y(p.acumulado)} r={4.5} />}
        {puntos.map((_, i) => {
          const a = i ? (x(i - 1) + x(i)) / 2 : M.l
          const b = i < puntos.length - 1 ? (x(i) + x(i + 1)) / 2 : W - M.r
          return <rect key={i} x={a} y={M.t} width={b - a} height={alto} fill="transparent" onPointerEnter={() => setSobre(i)} />
        })}
      </svg>
      {p && (
        <div className="bv-tooltip" style={{ left: `${(x(sobre) / W) * 100}%` }}>
          <b>{fmtV(p.acumulado)}</b><span>{p.etiqueta}</span><span>esta: {fmtV(p.valor)}</span>
        </div>
      )}
    </div>
  )
}

// Un resultado como barra a izquierda (pérdida) o derecha (ganancia) de un cero común
export function BarraResultado({ valor, max }) {
  if (!Number.isFinite(valor) || !(max > 0)) return null
  const r = Math.min(1, Math.abs(valor) / max) * 50
  return (
    <span className="bv-barra" aria-hidden="true">
      <span className={`bv-barra-relleno ${valor >= 0 ? 'sube' : 'baja'}`} style={valor >= 0 ? { left: '50%', width: `${r}%` } : { right: '50%', width: `${r}%` }} />
    </span>
  )
}

