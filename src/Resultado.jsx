const fmt = {
  pct:  (n) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%',
  usd:  (n) => n.toLocaleString('es-ES', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }),
  usd0: (n) => n.toLocaleString('es-ES', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }),
}

export default function Resultado({ data }) {
  const { A, B, ganadora } = data
  const mejor = ganadora === 'A' ? A : B
  const peor  = ganadora === 'A' ? B : A

  return (
    <div className="resultado">
      <div className={`ganadora-banner banner-${ganadora.toLowerCase()}`}>
        🏆 Gana la Cartera {ganadora} &nbsp;·&nbsp;
        {fmt.pct(mejor.retornoTotal)} &nbsp;·&nbsp;
        {fmt.usd(mejor.gananciaTotal)}
        {' '}vs{' '}
        {fmt.pct(peor.retornoTotal)}
      </div>

      <div className="resultado-carteras">
        <PanelResultado label="Cartera A" data={A} ganadora={ganadora === 'A'} color="var(--color-a)" />
        <PanelResultado label="Cartera B" data={B} ganadora={ganadora === 'B'} color="var(--color-b)" />
      </div>
    </div>
  )
}

function PanelResultado({ label, data, ganadora, color }) {
  return (
    <div className={`resultado-panel ${ganadora ? 'ganadora' : 'perdedora'}`} style={{ '--color': color }}>
      <div className="resultado-header">
        <h3>{label}</h3>
        <div className="resultado-nums">
          <span className={`retorno-total ${data.retornoTotal >= 0 ? 'pos' : 'neg'}`}>
            {fmt.pct(data.retornoTotal)}
          </span>
          <span className={`ganancia-total ${data.gananciaTotal >= 0 ? 'pos' : 'neg'}`}>
            {fmt.usd(data.gananciaTotal)}
          </span>
        </div>
      </div>

      <div className="resultado-resumen">
        <span>Invertido: {fmt.usd0(data.valorTotalInicial)}</span>
        <span>Actual: {fmt.usd0(data.valorTotalActual)}</span>
      </div>

      <table className="activos-tabla">
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Compra</th>
            <th>Actual</th>
            <th>Retorno</th>
            <th>Acciones</th>
            <th>Ganancia</th>
          </tr>
        </thead>
        <tbody>
          {data.activos.map((a, i) => (
            <tr key={i}>
              <td>
                <span className="ticker-cell">{a.ticker}</span>
                <span className="nombre-cell">{a.nombre !== a.ticker ? a.nombre : ''}</span>
              </td>
              <td>{fmt.usd(a.precioCompra)}</td>
              <td>{fmt.usd(a.precio)}</td>
              <td className={a.retorno >= 0 ? 'pos' : 'neg'}>{fmt.pct(a.retorno)}</td>
              <td>{a.acciones}</td>
              <td className={a.ganancia >= 0 ? 'pos' : 'neg'}>{fmt.usd(a.ganancia)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
