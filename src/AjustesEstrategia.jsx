// Piezas comunes de los filtros de Estrategias (EstrategiaSegundaVela y EstrategiaTortugas).
// Los filtros van por bloques numerados: el primero dice qué datos se bajan y se aplica con
// el botón; los demás se recalculan al momento sobre lo ya bajado. Cada bloque lo dice en su
// cabecera, para no tener que adivinar qué cambios piden volver a pulsar.

export function Bloque({ n, titulo, nota, children }) {
  return (
    <section className="estr-bloque">
      <div className="estr-bloque-cabecera">
        <span className="estr-bloque-num" aria-hidden="true">{n}</span>
        <div>
          <h3 className="estr-bloque-titulo">{titulo}</h3>
          {nota && <p className="estr-bloque-nota">{nota}</p>}
        </div>
      </div>
      {children}
    </section>
  )
}

// Lo que se está viendo, encima de los resultados: de dónde salen (`base`) y los ajustes que
// no están en su valor por defecto, cada uno con su × para volver a él
export function AjustesPuestos({ base, ajustes, onRestablecer }) {
  return (
    <div className="estr-ajustes">
      {base && <span className="estr-ajustes-base">{base}</span>}
      {ajustes.length > 0 && (
        <div className="gf-activos">
          {ajustes.map(a => (
            <button key={a.id} className="gf-activo" onClick={a.quitar} title="Volver al valor por defecto">
              {a.texto}<span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}
      {ajustes.length > 1 && <button className="pag-btn" onClick={onRestablecer}>Valores por defecto</button>}
    </div>
  )
}
