import { useEffect, useState, useCallback } from 'react'
import { conClaveBot, guardarClaveBot } from './claveBot'
import { peorHastaStops } from './tortugas'
import { rupturaMasCercana, acumulado } from './botCalculos'
import { Canal, Medidor, CurvaResultados, BarraResultado } from './botVisual'
import './Bot.css'

// Pestaña Bot Tortugas: el bot de las tortugas que opera en la demo de IG
// (server/bot-tortugas.js), con las posiciones abiertas de un día para otro. Enseña los
// niveles de cada índice para su sesión, las posiciones con su pirámide, los límites de
// cartera, las operaciones cerradas, el registro y la configuración. En producción el
// servidor pide la misma clave que la pestaña Bot SRS.

const num = (n, dec = 1) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec }))
const eur = n => (n == null ? '—' : `${n > 0 ? '+' : ''}${num(n, 0)} €`)
const conSigno = (n, dec = 1) => (n == null ? '—' : `${n > 0 ? '+' : ''}${num(n, dec)}`)
// Un precio con los decimales que pide su tamaño: las divisas, con 5 (como en el servidor)
const decimalesPara = x => { const a = Math.abs(x ?? 0); return a >= 1000 ? 1 : a >= 100 ? 2 : a >= 10 ? 3 : 5 }
const px = n => (n == null ? '—' : num(n, decimalesPara(n)))
const tono = n => (n == null ? '' : n > 0 ? 'bot-pos' : n < 0 ? 'bot-neg' : '')
const fechaHora = ts => new Date(ts * 1000).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const horaEvento = iso => new Date(iso).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const dir = lado => (lado === 'largo' ? 1 : -1)

async function pedir(url, opciones = {}) {
  const r = await fetch(url, { ...opciones, headers: conClaveBot(opciones.headers) })
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
  if (!r.ok || j.error) {
    const err = new Error(j.error ?? `HTTP ${r.status}`)
    err.necesitaClave = !!j.necesitaClave
    throw err
  }
  return j
}

// Lo que gana o pierde una posición a `precio` y lo que perdería si salta su stop, en euros
function cuentasDe(pos, precio) {
  const vivas = pos.unidades.filter(u => !u.salida)
  const enEur = x => x * pos.valorPunto * pos.cambioAEur
  return {
    abierto: precio == null ? null : enEur(vivas.reduce((s, u) => s + u.tamano * dir(pos.lado) * (precio - u.entrada), 0)),
    alStop: pos.stop == null ? null : enEur(vivas.reduce((s, u) => s + u.tamano * dir(pos.lado) * (pos.stop - u.entrada), 0)),
    contratos: vivas.reduce((s, u) => s + u.tamano, 0),
    medio: vivas.reduce((s, u) => s + u.tamano * u.entrada, 0) / vivas.reduce((s, u) => s + u.tamano, 0),
  }
}

export default function BotTortugas() {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const [pideClave, setPideClave] = useState(false)
  const [clave, setClave] = useState('')
  const [form, setForm] = useState(null)
  const [ocupado, setOcupado] = useState(false)
  const [orden, setOrden] = useState('grupo')   // 'grupo' o 'cercania' (a la ruptura más cercana)

  const cargar = useCallback(async () => {
    try {
      setDatos(await pedir('/api/bot/tortugas'))
      setError(null)
      setPideClave(false)
    } catch (err) {
      setError(err.message)
      if (err.necesitaClave) setPideClave(true)
    }
  }, [])

  useEffect(() => {
    const primera = setTimeout(cargar, 0)
    const reloj = setInterval(cargar, 5000)
    return () => { clearTimeout(primera); clearInterval(reloj) }
  }, [cargar])

  const accion = async fn => {
    setOcupado(true)
    try { await fn(); await cargar() } catch (err) { setError(err.message) } finally { setOcupado(false) }
  }
  const guardarConfig = cambios => accion(() => pedir('/api/bot/tortugas/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cambios),
  }))
  const pararYCerrar = () => {
    if (!window.confirm('¿Apagar el bot de las tortugas y cerrar ahora todas sus posiciones?')) return
    accion(() => pedir('/api/bot/tortugas/parar', { method: 'POST' }))
  }

  if (pideClave) {
    return (
      <div className="bot-page">
        <section className="bot-bloque bot-clave">
          <h3>Clave del bot</h3>
          <p className="bot-nota">El servidor de producción pide la clave del bot (la variable BOT_TOKEN de Railway). Es la misma que la de la pestaña Bot SRS y se guarda en este navegador.</p>
          {error && <p className="bot-error">{error}</p>}
          <form onSubmit={e => { e.preventDefault(); guardarClaveBot(clave); cargar() }}>
            <input type="password" value={clave} onChange={e => setClave(e.target.value)} placeholder="Clave" autoComplete="current-password" />
            <button className="diario-boton" type="submit">Entrar</button>
          </form>
        </section>
      </div>
    )
  }
  if (!datos) {
    return <div className="bot-page">{error ? <p className="bot-error">{error}</p> : <p className="bot-nota">Cargando…</p>}</div>
  }

  const { config, mercados, operaciones, eventos, ig, opera, reglas } = datos
  const editando = form ?? config
  const cambiar = (campo, valor) => setForm({ ...editando, [campo]: valor })
  const nombre = t => mercados.find(m => m.ticker === t)?.nombre ?? t
  const totalEur = operaciones.reduce((s, o) => s + (o.resultadoEur ?? 0), 0)
  const ladosTexto = { largos: 'solo largos', ambos: 'largos y cortos', cortos: 'solo cortos' }[config.lados]
  const dosSistemas = config.sistemas.length > 1
  const sistemasTexto = dosSistemas ? 'Sistemas 1 y 2 a la vez' : `solo el Sistema ${config.sistemas[0]}`

  // Las posiciones abiertas de los dos sistemas, para los límites (que van por sistema) y el nominal (de todo)
  const abiertas = mercados.flatMap(m => reglas.sistemas.map(s => m.posiciones[s] && { ...m.posiciones[s], grupo: m.grupo })).filter(Boolean)
  const unidades = filtro => abiertas.filter(filtro).reduce((s, p) => s + p.unidades.filter(u => !u.salida).length, 0)
  const grupos = [...new Set(mercados.map(m => m.grupo))]
  const lados = config.lados === 'ambos' ? ['largo', 'corto'] : [config.lados === 'cortos' ? 'corto' : 'largo']
  const saldo = mercados.find(m => m.plan?.saldo)?.plan.saldo ?? null
  const nominal = abiertas.reduce((s, p) => s + p.unidades.filter(u => !u.salida).reduce((x, u) => x + u.tamano * u.entrada, 0) * p.valorPunto * p.cambioAEur, 0)
  const sistemasCartera = reglas.sistemas.filter(s => config.sistemas.includes(s) || abiertas.some(p => p.sistema === s))
  // Lo que se perdería ahora si saltaran todos los stops, y lo peor que permiten los límites: en
  // cada sistema, el peor reparto de las unidades que caben (el stop de una pirámide sube con
  // cada añadido); con los sistemas llenos, cada uno con todo el riesgo
  const alStop = abiertas.reduce((s, p) => s + (cuentasDe(p, null).alStop ?? 0), 0)
  const peor = peorHastaStops({
    grupos: Object.values(mercados.filter(m => m.encendido).reduce((n, m) => ({ ...n, [m.grupo]: (n[m.grupo] ?? 0) + 1 }), {})),
    maxUnidades: config.maxUnidades, maxGrupo: config.maxGrupo, maxSentido: config.maxSentido, stopN: reglas.stopN, paso: reglas.pasoN,
  })
  const peorPct = peor.n * config.riesgoPct * config.sistemas.length
  const alStopPct = saldo && abiertas.length ? (100 * -alStop) / saldo : 0

  // La tabla, por grupos (con su cabecera) o de la ruptura más cercana a la más lejana
  const cercania = m => rupturaMasCercana(m, config)?.n ?? Infinity
  const bloques = orden === 'cercania'
    ? [{ grupo: null, lista: [...mercados].sort((a, b) => cercania(a) - cercania(b)) }]
    : grupos.map(g => ({ grupo: g, lista: mercados.filter(m => m.grupo === g) }))
  const curva = acumulado([...operaciones].reverse().map(o => ({ etiqueta: `${o.cerrada} · ${nombre(o.ticker)}`, valor: o.resultadoEur ?? 0 })))
  const maxEur = Math.max(0, ...operaciones.map(o => Math.abs(o.resultadoEur ?? 0)))

  return (
    <div className="bot-page">
      <section className="bot-cabecera">
        <div>
          <div className={`bot-interruptor ${config.activo ? 'encendido' : ''}`}>{config.activo ? '● Encendido' : '○ Apagado'}</div>
          <p className="bot-nota">
            Tortugas · {sistemasTexto} · {ladosTexto} · 1 N por unidad = {num(config.riesgoPct, 2)}% del saldo{dosSistemas ? ' en cada entrada, de cualquier sistema' : ''} · demo de IG (dinero ficticio) · cuenta {ig.cuenta ?? '—'} · {ig.streaming}
          </p>
          {!opera && <p className="bot-aviso">Este servidor no opera (BOT_OPERA no es 1): el registro es el suyo, pero las órdenes las manda el servidor que tenga BOT_OPERA=1.</p>}
        </div>
        <div className="bot-botones">
          <button className="diario-boton" disabled={ocupado} onClick={() => guardarConfig({ activo: !config.activo })}>{config.activo ? 'Apagar' : 'Encender'}</button>
          <button className="diario-boton bot-peligro" disabled={ocupado} onClick={pararYCerrar}>Parar y cerrar todo</button>
        </div>
      </section>

      {error && <p className="bot-error">{error}</p>}

      <section className="bot-bloque">
        <h3>Cartera</h3>
        <div className="tor-medidores">
          {sistemasCartera.map(s => {
            const enGrupos = lados.flatMap(lado => grupos
              .map(g => ({ g, lado, n: unidades(p => p.sistema === s && p.grupo === g && p.lado === lado) }))
              .filter(x => x.n > 0))
            return (
              <Medidor key={s} etiqueta={`Sistema ${s} · unidades por sentido`}
                filas={lados.map(lado => {
                  const n = unidades(p => p.sistema === s && p.lado === lado)
                  return { nombre: lado === 'largo' ? 'largas' : 'cortas', valor: n, max: config.maxSentido, texto: `${n} de ${config.maxSentido}` }
                })}
                sub={enGrupos.length ? enGrupos.map(x => `${x.g} ${x.n}/${config.maxGrupo}${lados.length > 1 ? ` ${x.lado === 'largo' ? 'L' : 'C'}` : ''}`).join(' · ') : `ninguna abierta · máximo ${config.maxGrupo} por grupo`} />
            )
          })}
          <Medidor etiqueta="Si saltan los stops" valor={alStopPct} max={peorPct}
            texto={abiertas.length ? `${eur(alStop)}${saldo ? ` · ${num(alStopPct, 1)}%` : ''}` : '—'}
            sub={`lo peor con estos límites: −${num(peorPct, 1)}% del saldo${config.lados === 'ambos' ? ' por sentido' : ''}`} />
          <Medidor etiqueta="Nominal abierto" valor={saldo ? nominal / saldo : 0} max={reglas.apalancamiento}
            texto={`${num(nominal / 1000, 1)} mil €${saldo ? ` · ${num(nominal / saldo, 1)}×` : ''}`}
            sub={`máximo ${reglas.apalancamiento} veces el saldo, entre los dos sistemas`} />
        </div>
        <div className="estr-tiles">
          <Tile label="Saldo de la cuenta" valor={saldo ? `${num(saldo, 0)} €` : '—'}
            sub={datos.picoSaldo ? `máximo ${num(datos.picoSaldo, 0)} €${config.reduccionDD ? ' · −20% de unidad por cada −10%' : ''}` : ''} />
          <Tile label="Operaciones cerradas" valor={eur(operaciones.length ? totalEur : null)} tonoValor={tono(totalEur)}
            sub={`${operaciones.length} ${operaciones.length === 1 ? 'operación' : 'operaciones'} (demo)`} />
          <Tile label="Posiciones abiertas" valor={String(abiertas.length)}
            sub={abiertas.length ? `${unidades(() => true)} unidades en ${new Set(abiertas.map(p => p.ticker)).size} mercados` : 'ninguna'} />
        </div>
      </section>

      <section className="bot-bloque">
        <div className="tor-cab-tabla">
          <h3>Mercados</h3>
          <div className="estrategias-nav tor-orden">
            <button className={`estrategia-chip ${orden === 'grupo' ? 'activo' : ''}`} onClick={() => setOrden('grupo')}>Por grupo</button>
            <button className={`estrategia-chip ${orden === 'cercania' ? 'activo' : ''}`} onClick={() => setOrden('cercania')}>Más cerca de romper</button>
          </div>
        </div>
        <div className="velas-tabla-wrap tor-tabla-wrap">
          <table className="velas-tabla bot-tabla tor-tabla tor-todas">
            <thead>
              <tr>
                <th>Índice</th><th>Sesión</th><th className="tor-num">N</th><th className="tor-num">Precio</th><th>Canal</th><th>Unidad</th>
                <th>Sistema</th><th>Entrada</th><th>Salida</th><th>Posición</th><th className="tor-num">Abierto</th>
              </tr>
            </thead>
            {bloques.map(b => [
              b.grupo && (
                <tbody key={`g-${b.grupo}`} className="tor-grupo">
                  <tr><td colSpan={11}>{b.grupo}</td></tr>
                </tbody>
              ),
              ...b.lista.map(m => <FilasIndice key={m.ticker} m={m} config={config} ocupado={ocupado} reglas={reglas}
                alternar={si => guardarConfig({ instrumentos: { [m.ticker]: si } })} />),
            ])}
          </table>
        </div>
        <p className="bot-nota">
          Los niveles salen del diario de Yahoo de cada índice hasta la sesión anterior, como en el backtest; el precio es el de IG (el CFD de contado, que puede ir unos puntos separado del índice).
          Las divisas, del contado de Yahoo; las materias primas, del histórico de IG, y si IG se queda sin cupo, el oro y la plata, del contado de Twelve Data o Dukascopy (lo pone debajo de la N).
          En «Canal», la pista es el canal de 55 sesiones y la parte clara el de 20; las rayas azules de arriba son las compras (la corta, S1; la larga, S2), las naranjas de abajo las ventas, el punto el precio y una raya roja el stop de una posición abierta. Debajo, lo que le falta al precio para la ruptura más cercana (o para su stop, con posición), en N.
          Cada sistema lleva su posición: un índice puede tener una de cada. Antes de abrir, el plan es provisional: al abrir se rehace con el saldo de ese momento.
          «Abierto» es lo que va ganando la posición; debajo, lo que dejaría si saltara el stop ahora.
        </p>
      </section>

      <section className="bot-bloque">
        <h3>Operaciones cerradas</h3>
        {operaciones.length === 0 ? <p className="bot-nota">Todavía no ha cerrado ninguna.</p> : (
          <>
          <CurvaResultados puntos={curva} />
          <div className="velas-tabla-wrap">
            <table className="velas-tabla bot-tabla tor-todas">
              <thead>
                <tr><th>Cerrada</th><th>Índice</th><th>Sistema</th><th>Lado</th><th>Abierta</th><th>Unidades</th><th>Entrada media</th><th>Salida</th><th>Motivo</th><th>N</th><th>€</th></tr>
              </thead>
              <tbody>
                {operaciones.map(o => (
                  <tr key={`${o.ticker}-${o.sistema}-${o.cerradaHora}`}>
                    <td>{o.cerrada}</td>
                    <td className="bot-celda-texto">{nombre(o.ticker)}</td>
                    <td className="bot-celda-texto">{o.sistema ? `S${o.sistema}` : '—'}</td>
                    <td className="bot-celda-texto">{o.lado === 'largo' ? 'Largo' : 'Corto'}{o.ruptura ? ` (${o.ruptura})` : ''}</td>
                    <td>{o.abierta}</td>
                    <td>{o.unidades} · {num(o.contratos, 2)} c.</td>
                    <td>{px(o.entradaMedia)}</td>
                    <td>{px(o.salida)}{o.aproximado ? ' (aprox.)' : ''}</td>
                    <td className="bot-celda-texto">{o.motivo}</td>
                    <td className={tono(o.resultadoN)}>{conSigno(o.resultadoN, 2)}</td>
                    <td className={`bot-celda-barra ${tono(o.resultadoEur)}`}><BarraResultado valor={o.resultadoEur} max={maxEur} />{eur(o.resultadoEur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </section>

      <section className="bot-bloque">
        <h3>Registro</h3>
        {eventos.length === 0 ? <p className="bot-nota">Nada todavía.</p> : (
          <ul className="bot-eventos tor-eventos">
            {eventos.map((e, i) => <li key={i}><span className="bot-hora">{horaEvento(e.hora)}</span><b>{nombre(e.ticker)}{e.sistema ? ` · S${e.sistema}` : ''}</b> · {e.texto}</li>)}
          </ul>
        )}
      </section>

      <section className="bot-bloque">
        <h3>Configuración</h3>
        <div className="bot-form">
          <label>Sistemas
            <select value={editando.sistemas.join(',')} onChange={e => cambiar('sistemas', e.target.value.split(',').map(Number))}>
              <option value="1,2">Los dos a la vez, como uno y con todo el capital en cada entrada</option>
              <option value="1">Solo el 1: entra en 20, sale en 10</option>
              <option value="2">Solo el 2: entra en 55, sale en 20</option>
            </select>
          </label>
          <label>Filtro del Sistema 1
            <select value={editando.filtroS1 ? 'si' : 'no'} onChange={e => cambiar('filtroS1', e.target.value === 'si')}>
              <option value="no">No: entra en toda ruptura de 20</option>
              <option value="si">Sí: si la anterior habría ganado, espera a la de 55</option>
            </select>
          </label>
          <label>Lados
            <select value={editando.lados} onChange={e => cambiar('lados', e.target.value)}>
              <option value="largos">Solo largos</option>
              <option value="ambos">Largos y cortos</option>
              <option value="cortos">Solo cortos</option>
            </select>
          </label>
          <label>1 N por unidad (% del saldo, entre los sistemas)
            <input type="number" min="0.05" max="5" step="0.05" value={editando.riesgoPct} onChange={e => cambiar('riesgoPct', e.target.value)} />
          </label>
          <label>Unidades por índice y sistema
            <input type="number" min="1" max="10" step="1" value={editando.maxUnidades} onChange={e => cambiar('maxUnidades', e.target.value)} />
          </label>
          <label>Unidades por grupo y sentido (en cada sistema)
            <input type="number" min="1" max="30" step="1" value={editando.maxGrupo} onChange={e => cambiar('maxGrupo', e.target.value)} />
          </label>
          <label>Unidades por sentido (en cada sistema)
            <input type="number" min="1" max="50" step="1" value={editando.maxSentido} onChange={e => cambiar('maxSentido', e.target.value)} />
          </label>
          <label>Reducción por drawdown
            <select value={editando.reduccionDD ? 'si' : 'no'} onChange={e => cambiar('reduccionDD', e.target.value === 'si')}>
              <option value="si">Sí: −20% de capital por cada −10%</option>
              <option value="no">No</option>
            </select>
          </label>
        </div>
        <p className="bot-nota">
          Como las tortugas, juega los dos sistemas a la vez: el 1 entra al romper 20 sesiones y sale al romper 10 ({editando.filtroS1 ? 'con el filtro: si la ruptura anterior habría ganado, espera a la de 55' : 'sin el filtro de la ruptura anterior'}); el 2 entra en 55 y sale en 20.
          Cada entrada va con todo el capital, y cada sistema lleva sus propias posiciones y límites, así que con los dos llenos se arriesga el doble que con uno solo; el tope de nominal ({reglas.apalancamiento} veces el saldo) cuenta los dos.
          Pero van como uno: si los dos dan la señal a precios parecidos (el otro ya tiene en ese mercado una unidad del mismo sentido a menos de {num(reglas.pasoN, 1)} N), solo se ejecuta una vez.
          Una unidad es el tamaño con el que un movimiento de 1 N (el ATR de 20 sesiones) cuesta ese % del saldo; el stop va a {reglas.stopN} N del último relleno, así que una unidad recién entrada arriesga el doble.
          Con estos límites caben {peor.unidades} unidades por sentido en cada sistema: 1 N en contra de todas las de un sentido costaría un {num(peor.unidades * config.riesgoPct * config.sistemas.length, 1)}% del saldo, y si saltaran a la vez todos sus stops, hasta un {num(peorPct, 1)}%{config.lados === 'ambos' ? ' (con largos y cortos, cada sentido por su lado)' : ''}
          (no el doble, porque el stop de cada pirámide sube con cada añadido; sin contar los huecos, que pueden pasar el stop).
          El backtest usa un 0,2% repartido en 8 índices; las tortugas originales, un 1%. Si el mínimo de IG obliga a más del doble de lo que toca, ese índice no opera (sale en la columna Unidad).
          Pirámide: una unidad más cada {num(reglas.pasoN, 1)} N a favor, y el stop de todas sube a {reglas.stopN} N de la última. El stop lo guarda IG, así que también puede saltar fuera de la sesión;
          las entradas, los añadidos y la salida por el canal, solo dentro de ella y a mercado.
          Los avisos van al mismo Telegram que el bot SRS (se conecta en esa pestaña), y los contratos son los mismos: el «Ensayo de órdenes» de esa pestaña los prueba. Un cambio de sistemas, filtro, lados o riesgo rehace los planes de todos los índices.
        </p>
        <button className="diario-boton" disabled={ocupado || !form} onClick={() => {
          const { sistemas, filtroS1, lados: l, riesgoPct, maxUnidades, maxGrupo, maxSentido, reduccionDD } = form
          guardarConfig({ sistemas, filtroS1: !!filtroS1, lados: l, riesgoPct, maxUnidades, maxGrupo, maxSentido, reduccionDD }).then(() => setForm(null))
        }}>Guardar configuración</button>
      </section>
    </div>
  )
}

// Por dónde sale una posición: el canal de salida de su sistema o el stop, el que esté más cerca
function salidaDe(pos, sp) {
  const canal = sp.salida[pos.lado]
  if (pos.stop == null) return canal
  return pos.lado === 'largo' ? Math.max(canal, pos.stop) : Math.min(canal, pos.stop)
}

// Como en el bot: ½ N a favor desde el último relleno, saltando más allá de los precios en los
// que el otro sistema ya está en ese sentido (los dos van como uno)
function siguienteAnadido(pos, pasoN, ocupados) {
  const d = pasoN * pos.n0
  let nivel = pos.unidades.at(-1).entrada + dir(pos.lado) * d
  for (let o; (o = ocupados.find(x => Math.abs(x - nivel) < d)) != null;) nivel = o + dir(pos.lado) * d
  return nivel
}

const ocupadosPorOtro = (m, sistema, lado) => Object.entries(m.posiciones)
  .filter(([s, p]) => Number(s) !== sistema && p?.lado === lado)
  .flatMap(([, p]) => p.unidades.filter(u => !u.salida).map(u => u.entrada))

// Un índice: lo común (sesión, N, precio, unidad) una vez, y una fila por cada sistema que se
// juega o que tiene una posición abierta
function FilasIndice({ m, config, ocupado, reglas, alternar }) {
  const { plan } = m
  const hoy = plan && !plan.error ? plan : null
  const sistemas = reglas.sistemas.filter(s => config.sistemas.includes(s) || m.posiciones[s] || m.intentos[s])
  const filas = sistemas.length ? sistemas : [config.sistemas[0]]
  const n = filas.length
  const cercana = hoy ? rupturaMasCercana(m, config) : null
  return (
    <tbody className={`tor-indice-grupo ${m.encendido ? '' : 'tor-apagado'}`}>
      {filas.map((s, i) => {
        const pos = m.posiciones[s]
        const sp = hoy?.sistemas?.[s] ?? null
        const c = pos ? cuentasDe(pos, m.precio) : null
        const siguiente = pos ? siguienteAnadido(pos, reglas.pasoN, ocupadosPorOtro(m, s, pos.lado)) : null
        const juega = config.sistemas.includes(s)
        const entrada = !sp ? '—'
          : pos ? (pos.unidades.length < config.maxUnidades ? `añade en ${px(siguiente)}` : 'pirámide llena')
          : !juega ? 'no se juega'
          : [config.lados !== 'cortos' && `> ${px(sp.entrada.largo.nivel)}`, config.lados !== 'largos' && `< ${px(sp.entrada.corto.nivel)}`].filter(Boolean).join(' · ')
        return (
          <tr key={s}>
            {i === 0 && <>
              <td className="bot-celda-texto" rowSpan={n}>
                <label className="tor-indice">
                  <input type="checkbox" checked={m.encendido} disabled={ocupado} onChange={e => alternar(e.target.checked)} />
                  <span><b>{m.nombre}</b><small className="tor-sub">{m.grupo}</small></span>
                </label>
              </td>
              <td className="bot-celda-texto" rowSpan={n}>{m.enSesion ? <span className="bot-pos">abierta</span> : m.proxima ? `abre ${fechaHora(m.proxima)}` : '—'}</td>
              <td className="tor-num" rowSpan={n}>
                {hoy ? px(hoy.n) : '—'}
                {hoy?.respaldo && <small className="tor-sub" title="IG no da su histórico (sin cupo semanal): los niveles salen del contado de esta fuente">de {hoy.respaldo}</small>}
              </td>
              <td className="tor-num" rowSpan={n}>{px(m.precio)}</td>
              <td rowSpan={n}>
                {hoy ? <>
                  <Canal plan={hoy} precio={m.precio} posiciones={m.posiciones} lados={config.lados} fmt={px} />
                  {cercana && <small className={`tor-sub tor-cercana ${cercana.n <= 0.5 ? 'cerca' : ''}`}>
                    {cercana.n <= 0 ? `en la ruptura ${cercana.texto.replace(/^de |^del /, '')}` : `a ${num(cercana.n, 1)} N ${cercana.texto}`}
                  </small>}
                </> : '—'}
              </td>
              <td className="bot-celda-texto" rowSpan={n}>
                {!plan ? '—'
                  : plan.error ? <><span className="bot-neg">sin plan</span><small className="tor-sub tor-motivo">{plan.error}</small></>
                  : plan.unidad?.ok ? <>{num(plan.unidad.tamano, 2)} contratos<small className="tor-sub">{Math.round(plan.unidad.eurPorN)} € por N{plan.provisional ? ' · provisional' : ''}</small><small className="tor-sub tor-epic">{plan.unidad.epic}</small></>
                  : <><span className="bot-neg">no cabe</span><small className="tor-sub tor-motivo">{plan.unidad?.motivo}</small></>}
              </td>
            </>}
            <td className="bot-celda-texto"><b>S{s}</b></td>
            <td className="bot-celda-texto tor-entrada" title={sp ? `Canal de ${sp.k} sesiones${sp.filtro ? ': la ruptura de 20 anterior habría ganado, así que espera a la de 55' : ''}` : ''}>
              {entrada}{sp && !pos && juega ? <small> ({sp.k}{sp.filtro ? ', filtro' : ''})</small> : null}
            </td>
            <td>{sp && pos ? <>{px(salidaDe(pos, sp))}<small className="tor-sub">{salidaDe(pos, sp) === pos.stop ? 'stop' : `canal de ${sp.kSalida}`}</small></> : sp && juega ? <small>canal de {sp.kSalida}</small> : '—'}</td>
            <td className="bot-celda-texto">
              {pos ? <>{pos.lado === 'largo' ? 'Largo' : 'Corto'} ×{pos.unidades.length} · {num(c.contratos, 2)} c. a {px(c.medio)}<small className="tor-sub">stop {px(pos.stop)} · desde {pos.abierta}{pos.recuperada ? ' · recuperada' : ''}</small></>
                : m.intentos[s] ? 'mandando la orden…' : '—'}
            </td>
            <td className={`tor-num ${tono(c?.abierto)}`}>
              {c ? <>{eur(c.abierto)}<small className={`tor-sub ${tono(c.alStop)}`}>al stop {eur(c.alStop)}</small></> : '—'}
            </td>
          </tr>
        )
      })}
    </tbody>
  )
}

function Tile({ label, valor, sub, tonoValor = '' }) {
  return (
    <div className="estr-tile">
      <span className="estr-tile-label">{label}</span>
      <span className={`estr-tile-valor bot-tile-valor ${tonoValor}`}>{valor}</span>
      <span className="estr-tile-sub">{sub}</span>
    </div>
  )
}
