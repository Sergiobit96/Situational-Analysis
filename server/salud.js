// ── Salud del servidor, de un vistazo (GET /api/bot/salud y la vista Salud de la pestaña Bots) ──
// Junta lo que antes había que ir a buscar a varios sitios: si los bots dan vueltas, la sesión y
// el streaming de IG, el cupo semanal de histórico, las fuentes de reserva, el calendario del
// FOMC, Telegram y la conciliación con IG. `avisosDeSalud` lo convierte en una lista de cosas que
// mirar, de peor a mejor: 'mal' (algo no funciona) u 'ojo' (funciona, pero conviene saberlo).

const MIN = 60_000

export function avisosDeSalud(s, ahoraMs = Date.now()) {
  const avisos = []
  const mal = texto => avisos.push({ nivel: 'mal', texto })
  const ojo = texto => avisos.push({ nivel: 'ojo', texto })

  for (const b of s.bots?.bots ?? []) {
    if (b.parado) mal(`El bot ${b.nombre} lleva ${Math.round(b.segundosSinVuelta / 60)} min sin dar una vuelta`)
  }
  if (s.bucle?.peorRecienteMs > 2000) ojo(`El bucle de eventos se ha bloqueado hasta ${(s.bucle.peorRecienteMs / 1000).toFixed(1)} s en los últimos minutos`)

  const ig = s.ig
  if (!ig) mal('IG no está configurado en este servidor')
  else {
    if (ig.sesion !== 'abierta') mal(`La sesión de IG está ${ig.sesion}${ig.error ? `: ${ig.error}` : ''}`)
    if (!/^CONNECTED/.test(ig.streaming ?? '')) mal(`El streaming de IG está ${ig.streaming ?? 'sin conectar'}: los bots no ven el precio`)
    const quedan = ig.cupo?.remainingAllowance
    if (quedan === 0) ojo('Agotado el cupo semanal de histórico de IG: las materias primas de las tortugas tiran de la reserva o se quedan sin plan')
    else if (quedan != null && quedan < 5000) ojo(`Quedan ${quedan} puntos del cupo semanal de histórico de IG`)
  }

  if (s.fuentes?.dukascopy?.limitando) ojo('Dukascopy está limitando las peticiones (429)')
  if (s.servidor?.opera && s.fuentes?.twelveData && !s.fuentes.twelveData.clave) ojo('Falta TWELVEDATA_API_KEY: el oro de las tortugas no tiene la reserva de Twelve Data')

  const cal = s.calendarioFomc
  if (cal?.error) ojo(`No se ha podido leer el calendario del FOMC de la Fed: ${cal.error}`)
  else if (cal?.actualizado && ahoraMs - Date.parse(cal.actualizado) > 3 * 24 * 60 * MIN) ojo('El calendario del FOMC lleva más de 3 días sin ponerse al día')

  if (s.servidor?.opera) {
    if (!s.telegram?.token) mal('Falta TELEGRAM_TOKEN: los bots no pueden avisar')
    else if (!s.telegram.conectado) ojo('Telegram no está conectado (botón «Conectar Telegram» del SRS)')
  }

  const con = s.conciliacion
  if (con?.error) ojo(`La conciliación con IG ha fallado: ${con.error}`)
  if (con?.pendientes?.length) mal(`${con.pendientes.length} diferencia${con.pendientes.length > 1 ? 's' : ''} entre lo que creen los bots y lo que hay en IG`)

  if (s.noticias?.error) ojo(`El calendario de noticias falla: ${s.noticias.error}`)
  if (s.grabacion?.error) ojo(`La grabación del directo no puede escribir: ${s.grabacion.error}`)

  return avisos.sort((a, b) => (a.nivel === b.nivel ? 0 : a.nivel === 'mal' ? -1 : 1))
}
