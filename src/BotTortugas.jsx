import { useEffect, useState, useCallback, useMemo } from 'react'
import { conClaveBot, guardarClaveBot } from './claveBot'
import { peorHastaStops, nHastaStop } from './tortugas'
import { backtestPorTramos, tramosDeConfig, operacionesDelBot, compararTortugas } from './tortugasComparar'
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
  const [soloAbiertas, setSoloAbiertas] = useState(false)   // la tabla, solo con los mercados con posición

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

  const { config, mercados, operaciones, eventos, ig, opera, reglas, cambiosConfig = [] } = datos
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
    anadido: config.anadido ?? 1,
  })
  // riesgoPct es lo más que pierde una pirámide llena hasta su stop: 1 N por unidad cuesta eso
  // entre el peor punto de la pirámide (5 N con 4 o más unidades; 2,75 con añadidos de media)
  const picoN = Math.max(...Array.from({ length: Math.max(1, config.maxUnidades) }, (_, i) => nHastaStop(i + 1, reglas.stopN, reglas.pasoN, config.anadido ?? 1)))
  const porN = config.riesgoPct / picoN
  const peorPct = peor.n * porN * config.sistemas.length
  const alStopPct = saldo && abiertas.length ? (100 * -alStop) / saldo : 0

  // La tabla, por grupos (con su cabecera) o de la ruptura más cercana a la más lejana
  const cercania = m => rupturaMasCercana(m, config)?.n ?? Infinity
  const conPosicion = m => reglas.sistemas.some(s => m.posiciones[s])
  const enTabla = soloAbiertas ? mercados.filter(conPosicion) : mercados
  const bloques = (orden === 'cercania'
    ? [{ grupo: null, lista: [...enTabla].sort((a, b) => cercania(a) - cercania(b)) }]
    : grupos.map(g => ({ grupo: g, lista: enTabla.filter(m => m.grupo === g) }))
  ).filter(b => b.lista.length)
  const curva = acumulado([...operaciones].reverse().map(o => ({ etiqueta: `${o.cerrada} · ${nombre(o.ticker)}`, valor: o.resultadoEur ?? 0 })))
  const maxEur = Math.max(0, ...operaciones.map(o => Math.abs(o.resultadoEur ?? 0)))

  return (
    <div className="bot-page">
      <section className="bot-cabecera">
        <div>
          <div className={`bot-interruptor ${config.activo ? 'encendido' : ''}`}>{config.activo ? '● Encendido' : '○ Apagado'}</div>
          <p className="bot-nota">
            Tortugas · {sistemasTexto} · {ladosTexto} · pirámide llena hasta el stop = {num(config.riesgoPct, 2)}% del saldo (1 N por unidad = {num(porN, 2)}%){dosSistemas ? ' en cada entrada, de cualquier sistema' : ''} · demo de IG (dinero ficticio) · cuenta {ig.cuenta ?? '—'} · {ig.streaming}
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
            <button className={`estrategia-chip ${soloAbiertas ? 'activo' : ''}`} onClick={() => setSoloAbiertas(v => !v)}
              title="Enseña solo los mercados con alguna posición abierta">Solo posiciones abiertas{abiertas.length ? ` (${new Set(abiertas.map(p => p.ticker)).size})` : ''}</button>
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
            {bloques.length === 0 && (
              <tbody><tr><td colSpan={11} className="bot-nota">No hay ninguna posición abierta.</td></tr></tbody>
            )}
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

      <RealFrenteBacktest config={config} cambios={cambiosConfig} reglas={reglas} mercados={mercados} operaciones={operaciones} eventos={eventos} nombre={nombre} />

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
          <label>Pérdida máxima de una pirámide hasta el stop (% del saldo, en cada sistema)
            <input type="number" min="0.05" max="5" step="0.05" value={editando.riesgoPct} onChange={e => cambiar('riesgoPct', e.target.value)} />
          </label>
          <label>Tamaño de cada añadido
            <select value={editando.anadido ?? 1} onChange={e => cambiar('anadido', Number(e.target.value))}>
              <option value={1}>Una unidad, como las tortugas</option>
              <option value={0.5}>Media unidad</option>
            </select>
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
          <label>Noticias de alto impacto
            <select value={editando.margenNoticias ?? ''} onChange={e => cambiar('margenNoticias', e.target.value === '' ? null : Number(e.target.value))}>
              <option value="">No las mira</option>
              <option value={5}>No entra 5 min antes ni después</option>
              <option value={15}>No entra 15 min antes ni después</option>
              <option value={30}>No entra 30 min antes ni después</option>
              <option value={60}>No entra 1 h antes ni después</option>
            </select>
          </label>
        </div>
        <p className="bot-nota">
          Como las tortugas, juega los dos sistemas a la vez: el 1 entra al romper 20 sesiones y sale al romper 10 ({editando.filtroS1 ? 'con el filtro: si la ruptura anterior habría ganado, espera a la de 55' : 'sin el filtro de la ruptura anterior'}); el 2 entra en 55 y sale en 20.
          Cada entrada va con todo el capital, y cada sistema lleva sus propias posiciones y límites, así que con los dos llenos se arriesga el doble que con uno solo; el tope de nominal ({reglas.apalancamiento} veces el saldo) cuenta los dos.
          Pero van como uno: si los dos dan la señal a precios parecidos (el otro ya tiene en ese mercado una unidad del mismo sentido a menos de {num(reglas.pasoN, 1)} N), solo se ejecuta una vez.
          Ese % es lo más que pierde una pirámide si salta su stop, en su peor punto ({num(picoN, 1)} N con estas unidades): una unidad es el tamaño con el que un movimiento de 1 N (el ATR de 20 sesiones) cuesta un {num(porN, 2)}% del saldo; el stop va a {reglas.stopN} N del último relleno, así que una unidad recién entrada arriesga el doble.
          Con estos límites caben {peor.unidades} unidades por sentido en cada sistema: 1 N en contra de todas las de un sentido costaría un {num(peor.unidades * porN * config.sistemas.length, 1)}% del saldo, y si saltaran a la vez todos sus stops, hasta un {num(peorPct, 1)}%{config.lados === 'ambos' ? ' (con largos y cortos, cada sentido por su lado)' : ''}
          (no el doble, porque el stop de cada pirámide sube con cada añadido; sin contar los huecos, que pueden pasar el stop).
          El backtest usa 1 N por unidad = 0,2% (un 1% por pirámide llena de 6 unidades); las tortugas originales, 1 N = 1% (un 5% por pirámide). Si el mínimo de IG obliga a más del doble de lo que toca, ese índice no opera (sale en la columna Unidad).
          Pirámide: {(config.anadido ?? 1) === 1 ? 'una unidad' : 'media unidad'} más cada {num(reglas.pasoN, 1)} N a favor (con media, la unidad sale más grande y el riesgo máximo es el mismo), y el stop de todas sube a {reglas.stopN} N de la última. El stop lo guarda IG, así que también puede saltar fuera de la sesión;
          las entradas, los añadidos y la salida por el canal, solo dentro de ella y a mercado.
          Junto a una noticia de alto impacto (ForexFactory) de la divisa del mercado o del dólar no entra: espera a que pase. Y ninguna entrada se manda si, con ella, lo que se perdería al saltar a la vez todos los stops de los mercados que se mueven juntos (los índices de EE. UU., los europeos, el dólar…) en ese sentido, contando todos los bots, pasa del {datos.riesgoGrupoPct ?? 6}% del saldo.
          Los avisos van al mismo Telegram que el bot SRS (se conecta en esa pestaña), y los contratos son los mismos: el «Ensayo de órdenes» de esa pestaña los prueba. Un cambio de sistemas, filtro, lados, riesgo, unidades o añadido rehace los planes de todos los índices.
        </p>
        <button className="diario-boton" disabled={ocupado || !form} onClick={() => {
          const { sistemas, filtroS1, lados: l, riesgoPct, anadido, maxUnidades, maxGrupo, maxSentido, reduccionDD, margenNoticias } = form
          guardarConfig({ sistemas, filtroS1: !!filtroS1, lados: l, riesgoPct, anadido: anadido ?? 1, maxUnidades, maxGrupo, maxSentido, reduccionDD, margenNoticias: margenNoticias ?? null }).then(() => setForm(null))
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
  const s = dir(pos.lado)
  let nivel = pos.unidades.at(-1).entrada + s * d
  // una sola pasada en orden a favor: el nivel solo avanza (buscar otra vez cada vez podía no
  // terminar por el redondeo)
  for (const o of [...ocupados].sort((a, b) => s * (a - b))) if (Math.abs(o - nivel) < d) nivel = o + s * d
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
        const spViejo = !hoy ? m.salidaAnterior?.sistemas?.[s] ?? null : null
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
            <td>{sp && pos ? <>{px(salidaDe(pos, sp))}<small className="tor-sub">{salidaDe(pos, sp) === pos.stop ? 'stop' : `canal de ${sp.kSalida}`}</small></>
              : spViejo && pos ? <>{px(salidaDe(pos, spViejo))}<small className="tor-sub" title="Sin plan de hoy, la posición sale por el canal del último plan bueno">{salidaDe(pos, spViejo) === pos.stop ? 'stop' : `canal de ${spViejo.kSalida} del ${m.salidaAnterior.fecha}`}</small></>
              : sp && juega ? <small>canal de {sp.kSalida}</small> : '—'}</td>
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

// Lo que hizo el bot frente a lo que habría hecho el backtest con sus reglas sobre los mismos
// diarios (src/tortugasComparar.js). Los diarios se piden una vez (y con el botón), no en cada
// refresco: el backtest de todos los mercados no hace falta rehacerlo cada 5 s.
const QUIEN = { ambos: 'los dos', 'solo-bot': 'solo el bot', 'solo-backtest': 'solo el backtest' }

// El backtest de cada mercado, rehecho solo si cambian los diarios, los mercados o las reglas
function useBacktestDelBot(diarios, claveTickers, claveCfg) {
  return useMemo(() => {
    if (!diarios) return null
    const { stopN, paso, tramos } = JSON.parse(claveCfg)
    return claveTickers.split(',').filter(t => t && diarios[t]?.velas?.length).flatMap(t => backtestPorTramos(t, diarios[t].velas, tramos, { stopN, paso }))
  }, [diarios, claveTickers, claveCfg])
}

// Cómo se lee un tramo de configuración en la nota
const describirTramo = c => [
  c.sistemas.length > 1 ? 'los Sistemas 1 y 2 como uno' : `solo el Sistema ${c.sistemas[0]}`,
  ...(c.sistemas.includes(1) ? [`${c.filtroS1 ? 'con' : 'sin'} el filtro del S1`] : []),
  { largos: 'solo largos', cortos: 'solo cortos', ambos: 'largos y cortos' }[c.lados] ?? c.lados,
  `${c.maxUnidades} unidades`, ...(c.anadido === 0.5 ? ['añadidos de media unidad'] : []),
].join(', ')

function RealFrenteBacktest({ config, cambios, reglas, mercados, operaciones, eventos, nombre }) {
  const [diarios, setDiarios] = useState(null)
  const [error, setError] = useState(null)
  const [cargando, setCargando] = useState(false)
  const [desde, setDesde] = useState('')
  // El bot apunta desde el 29-oct-2026 cuándo cambia lo que juega el backtest (cambiosConfig);
  // un cambio del filtro del S1 de antes se puede fechar a mano, o forzarlo en todo el periodo
  const [filtroCambiado, setFiltroCambiado] = useState('')
  const [filtroElegido, setFiltroElegido] = useState(null)

  const cargar = useCallback(async () => {
    setCargando(true)
    try { setDiarios(await pedir('/api/bot/tortugas/diarios')); setError(null) } catch (err) { setError(err.message) } finally { setCargando(false) }
  }, [])
  useEffect(() => {
    const primera = setTimeout(cargar, 0)
    return () => clearTimeout(primera)
  }, [cargar])

  const reales = operacionesDelBot(operaciones, mercados)
  // los mercados que juega ahora y los que jugó: uno apagado después sigue contando lo que hizo
  const claveTickers = mercados
    .filter(m => m.encendido || Object.values(m.posiciones).some(Boolean) || operaciones.some(o => o.ticker === m.ticker))
    .map(m => m.ticker).join(',')
  const tickers = claveTickers.split(',').filter(Boolean)
  // sin su diario, un mercado no se compara: lo del bot contaría todo como «solo el bot»
  const conDiario = tickers.filter(t => diarios?.[t]?.velas?.length)
  const tramos = tramosDeConfig({ ...config, maxUnidades: Number(config.maxUnidades), anadido: config.anadido ?? 1, filtroS1: !!config.filtroS1 },
    cambios, { filtroCambiado: filtroCambiado || null, filtroS1: filtroElegido })
  const claveCfg = JSON.stringify({ tramos, stopN: reglas.stopN, paso: reglas.pasoN })
  const backtest = useBacktestDelBot(diarios, claveTickers, claveCfg)

  // El bot no apunta cuándo arrancó: por defecto, lo primero que apuntó (una operación, una
  // posición o el registro, que guarda los 300 últimos)
  const primerApunte = [
    ...operaciones.map(o => o.abierta),
    ...mercados.flatMap(m => Object.values(m.posiciones).filter(Boolean).map(p => p.abierta)),
    ...eventos.map(e => e.hora?.slice(0, 10)),
  ].filter(Boolean).sort()[0] ?? null
  const desdeUsado = desde || primerApunte
  const eurPorN = Object.fromEntries(mercados.filter(m => m.plan?.unidad?.eurPorN).map(m => [m.ticker, m.plan.unidad.eurPorN]))
  const cmp = backtest && desdeUsado ? compararTortugas(reales.filter(r => conDiario.includes(r.ticker)), backtest, { desde: desdeUsado, eurPorN }) : null
  const r = cmp?.resumen

  // de qué fuente salió cada diario, y los que faltan
  const fuentes = diarios ? tickers.reduce((acc, t) => {
    const f = diarios[t]?.error ? 'sin diario' : diarios[t]?.velas?.length ? diarios[t].fuente : 'sin diario'
    return { ...acc, [f]: [...(acc[f] ?? []), t] }
  }, {}) : {}
  const nTxt = (x, dec = 2) => (x == null ? '—' : `${conSigno(x, dec)} N`)

  return (
    <section className="bot-bloque">
      <div className="tor-cab-tabla">
        <h3>Real frente al backtest</h3>
        <div className="estrategias-nav tor-orden">
          <label className="bot-nota">Desde <input type="date" value={desdeUsado ?? ''} onChange={e => setDesde(e.target.value)} /></label>
          {desde && <button className="estrategia-chip" onClick={() => setDesde('')} title="Volver a la fecha del primer apunte del bot">Desde el primer apunte</button>}
          {filtroElegido == null && (
            <label className="bot-nota" title={`Si cambiaste el filtro del S1 antes del 29-oct-2026, el bot no lo apuntó: el día del cambio (ahora está ${config.filtroS1 ? 'encendido' : 'apagado'}; antes de esa fecha, al revés)`}>
              Filtro del S1 cambiado el <input type="date" value={filtroCambiado} onChange={e => setFiltroCambiado(e.target.value)} />
            </label>
          )}
          {[[null, 'Filtro como el bot'], [true, 'Siempre con filtro'], [false, 'Siempre sin filtro']].map(([v, txt]) => (
            <button key={txt} className={`estrategia-chip ${filtroElegido === v ? 'activo' : ''}`} onClick={() => setFiltroElegido(v)}>{txt}</button>
          ))}
          <button className="estrategia-chip" disabled={cargando} onClick={cargar}>{cargando ? 'Cargando…' : 'Volver a cargar los diarios'}</button>
        </div>
      </div>
      {error && <p className="bot-error">{error}</p>}
      {!cmp ? <p className="bot-nota">{!diarios ? (error ? '' : 'Cargando los diarios…') : 'El bot aún no ha apuntado nada: elige arriba desde cuándo comparar.'}</p> : (
        <>
          <div className="estr-tiles">
            <Tile label="Operaciones" valor={String(r.casadas + r.soloBot + r.soloBacktest)}
              sub={`${r.casadas} de los dos · ${r.soloBot} solo del bot · ${r.soloBacktest} solo del backtest`} />
            <Tile label="Bot" valor={nTxt(r.realN, 1)} tonoValor={tono(r.realN)} sub="en N de una unidad, con las abiertas al precio de ahora" />
            <Tile label="Backtest" valor={nTxt(r.backtestN, 1)} tonoValor={tono(r.backtestN)} sub="mismas reglas y diarios, sin costes ni límites de cartera" />
            <Tile label="Diferencia" valor={nTxt(r.difN, 1)} tonoValor={tono(r.difN)}
              sub={`${eur(r.difEur)}${r.sinEur ? ` (sin contar ${r.sinEur}: no tienen plan de unidad)` : ''} · ${nTxt(r.difCasadasN, 1)} en las de los dos, ${nTxt(r.difSueltasN, 1)} en las sueltas`} />
            <Tile label="Deslizamiento medio" valor={nTxt(r.deslizamientoMedioN)} tonoValor={tono(r.deslizamientoMedioN == null ? null : -r.deslizamientoMedioN)}
              sub="en la primera unidad, frente al relleno del backtest (positivo, peor)" />
          </div>
          {cmp.filas.length === 0 ? <p className="bot-nota">Desde el {desdeUsado} ninguno de los dos ha abierto nada.</p> : (
            <div className="velas-tabla-wrap">
              <table className="velas-tabla bot-tabla tor-todas tor-comparar">
                <thead>
                  <tr><th>Abierta</th><th>Mercado</th><th>Sistema</th><th>Lado</th><th>Quién</th><th>Entrada bot</th><th>Entrada backtest</th><th>Deslizamiento</th><th>Unidades</th><th>Bot</th><th>Backtest</th><th>Diferencia</th><th>€</th></tr>
                </thead>
                <tbody>
                  {cmp.filas.map((f, i) => {
                    const o = f.real ?? f.backtest
                    const abierta = x => (x?.enCurso ? ' (abierta)' : '')
                    return (
                      <tr key={i}>
                        <td>{o.abierta}</td>
                        <td className="bot-celda-texto">{nombre(f.ticker)}</td>
                        <td className="bot-celda-texto">S{f.sistema}</td>
                        <td className="bot-celda-texto">{f.lado === 'largo' ? 'Largo' : 'Corto'}{o.ruptura ? ` (${o.ruptura})` : ''}</td>
                        <td className={`bot-celda-texto ${f.tipo === 'ambos' ? '' : 'bot-neg'}`}>{QUIEN[f.tipo]}</td>
                        <td>{f.real ? px(f.real.entrada) : '—'}</td>
                        <td>{f.backtest ? px(f.backtest.entrada) : '—'}</td>
                        <td className={tono(f.deslizamientoN == null ? null : -f.deslizamientoN)}>{nTxt(f.deslizamientoN)}</td>
                        <td>{f.real?.unidades ?? '—'} / {f.backtest?.unidades ?? '—'}</td>
                        <td className={tono(f.real?.resultadoN)}>{f.real ? nTxt(f.real.resultadoN) : '—'}{abierta(f.real)}</td>
                        <td className={tono(f.backtest?.resultadoN)}>{f.backtest ? nTxt(f.backtest.resultadoN) : '—'}{abierta(f.backtest)}</td>
                        <td className={tono(f.difN)}>{nTxt(f.difN)}</td>
                        <td className={tono(f.difEur)}>{eur(f.difEur)}{f.eurAproximado && f.difEur != null ? ' (aprox.)' : ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="bot-nota">
            El backtest juega cada mercado por su cuenta con las reglas del bot (stop a {reglas.stopN} N y añadidos cada {num(reglas.pasoN, 1)} N;{' '}
            {tramos.length === 1 ? describirTramo(tramos[0].config)
              : tramos.map(t => `${t.desde ? `desde el ${t.desde}` : `antes del ${tramos[1].desde}`}, ${describirTramo(t.config)}`).join('; ')})
            sobre el mismo diario del que el bot saca sus niveles, sin costes, sin financiación y sin los límites de cartera ni de noticias: lo que el bot no abrió por esos límites sale como «solo el backtest».
            Cada operación del bot se empareja con la del backtest del mismo mercado, sistema y lado abierta a 4 días o menos; las demás las hizo solo uno de los dos y cuentan contra el otro como 0.
            Todo va en N de una unidad (los añadidos, en unidades de la primera), como el bot apunta sus resultados; en euros, con lo que vale 1 N de una unidad hoy (las del backtest solo, aproximado).
            Las del backtest de antes del {desdeUsado} no cuentan: el bot empezó plano.
            {tramos.length > 1 && 'Cada operación del backtest sigue las reglas del día en que se abrió, aunque cambien después. '}
            El bot apunta los cambios de su configuración desde el 29-oct-2026; uno del filtro del S1 de antes se puede fechar arriba.
            {diarios && <> Diarios (los mercados sin diario no se comparan): {Object.entries(fuentes).map(([f, ts]) => `${f}, ${ts.length}${f === 'sin diario' || f === 'IG (caché)' ? ` (${ts.map(nombre).join(', ')})` : ''}`).join(' · ')}.</>}
          </p>
        </>
      )}
    </section>
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
