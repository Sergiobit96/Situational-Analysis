const fmt = {
  usd:  n => '$' + n.toFixed(2),
  pct:  n => n.toFixed(2) + '%',
  num:  n => n.toLocaleString('es-ES'),
}

export default function SetupOperacion({ patron, capital, idx }) {
  const { tipo, A, B, C, D, ratioBC, ratioCD, entrada, stop, target1, target2, posicion, rr1, rr2 } = patron
  const esBullish = tipo === 'bullish'

  return (
    <div className={`setup-card ${esBullish ? 'setup-long' : 'setup-short'}`}>
      <div className="setup-header">
        <span className={`setup-badge ${esBullish ? 'long' : 'short'}`}>
          {esBullish ? '▲ LONG' : '▼ SHORT'}
        </span>
        <span className="setup-patron">Patrón ABCD #{idx + 1}</span>
        <span className="setup-ratios">BC/AB: {ratioBC.toFixed(3)} · CD/AB: {ratioCD.toFixed(3)}</span>
      </div>

      <div className="setup-niveles">
        <Nivel label="Entrada"  valor={fmt.usd(entrada)}  color="var(--accent-entry)" />
        <Nivel label="Stop"     valor={fmt.usd(stop)}     color="var(--red)" sub={`-${fmt.usd(Math.abs(entrada - stop))} por acción`} />
        <Nivel label="Target 1" valor={fmt.usd(target1)}  color="var(--green-light)" sub={`R/R ${rr1}:1`} />
        <Nivel label="Target 2" valor={fmt.usd(target2)}  color="var(--green)" sub={`R/R ${rr2}:1`} />
      </div>

      {posicion && (
        <div className="setup-posicion">
          <h4>Gestión del riesgo <span className="riesgo-badge">2.5% max</span></h4>
          <div className="posicion-grid">
            <PosItem label="Acciones"       valor={fmt.num(posicion.acciones)} />
            <PosItem label="Capital usado"  valor={fmt.usd(posicion.capitalNecesario)} />
            <PosItem label="Riesgo/acción"  valor={fmt.usd(posicion.riesgoPorAccion)} />
            <PosItem label="Riesgo total"   valor={fmt.usd(posicion.riesgoTotal)} color="var(--red)" />
            <PosItem label="% de capital"   valor={fmt.pct(posicion.riesgoRealPct)} color="var(--red)" />
          </div>
          <p className="posicion-nota">
            Capital disponible: ${capital.toLocaleString()} · Stop siempre en {fmt.usd(stop)}
          </p>
        </div>
      )}

      <div className="setup-puntos">
        <PuntoABCD letra="A" precio={A.price} tipo={A.tipo} />
        <PuntoABCD letra="B" precio={B.price} tipo={B.tipo} />
        <PuntoABCD letra="C" precio={C.price} tipo={C.tipo} />
        <PuntoABCD letra="D" precio={D.price} tipo={D.tipo} highlight />
      </div>
    </div>
  )
}

function Nivel({ label, valor, color, sub }) {
  return (
    <div className="nivel-item">
      <span className="nivel-label">{label}</span>
      <span className="nivel-valor" style={{ color }}>{valor}</span>
      {sub && <span className="nivel-sub">{sub}</span>}
    </div>
  )
}

function PosItem({ label, valor, color }) {
  return (
    <div className="pos-item">
      <span className="pos-label">{label}</span>
      <span className="pos-valor" style={color ? { color } : {}}>{valor}</span>
    </div>
  )
}

function PuntoABCD({ letra, precio, tipo, highlight }) {
  return (
    <div className={`abcd-punto ${highlight ? 'abcd-highlight' : ''}`}>
      <span className="abcd-letra">{letra}</span>
      <span className="abcd-precio">${precio.toFixed(2)}</span>
      <span className="abcd-tipo">{tipo === 'H' ? '↑ máx' : '↓ mín'}</span>
    </div>
  )
}
