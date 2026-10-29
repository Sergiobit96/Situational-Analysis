import { N_MEJORES } from './quitarMejores.js'

// Los chips de «sin las 5 mejores», encima del resumen, con lo que da cada cosa al lado para
// no tener que ir y volver
export default function SinMejores({ activo, onCambio, criterio, comparacion, quitadas }) {
  return (
    <div className="filtro-group">
      <label className="filtro-label">Prueba de las mejores</label>
      <div className="filtro-presets">
        <button className={`chip ${activo ? '' : 'activo'}`} onClick={() => onCambio(false)}>Todas las operaciones</button>
        <button className={`chip ${activo ? 'activo' : ''}`} onClick={() => onCambio(true)}
          title={`Quita las ${N_MEJORES} operaciones que más ganan (${criterio}) y recalcula todo lo de abajo`}
        >Sin las {N_MEJORES} mejores</button>
      </div>
      <p className="estr-explica">
        {comparacion}
        {activo && quitadas && <> Quitadas: {quitadas}.</>}
        {' '}Si sin ellas deja de ganar, el resultado depende de unos pocos días que pueden no repetirse o que en real te puedes perder.
      </p>
    </div>
  )
}
