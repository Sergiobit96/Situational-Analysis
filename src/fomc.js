// Días en los que el FOMC publica su decisión: el día final de cada reunión ordinaria, tal
// como los lista la Reserva Federal (federalreserve.gov/monetarypolicy/fomccalendars.htm y
// las páginas históricas de cada año).
//
// Empieza en 2013 a propósito: ese año el comunicado pasó a salir siempre a las 14:00 de
// Nueva York. Antes salía a las 14:15, y en 2011-2012 a las 12:30 los días con rueda de
// prensa, así que "la cuarta vela de 10 min desde la noticia" caería en otra hora y los
// resultados no serían comparables.
//
// Quedan fuera las votaciones por escrito y las reuniones no programadas por teléfono
// (16/10/2013, 4/3/2014, 11/10/2019, los acuerdos de marzo y agosto de 2020, 22/8/2025) y
// el recorte de emergencia del domingo 15/3/2020: en ninguna hubo comunicado a las 14:00
// que braquetear.
export const FOMC = [
  '2013-01-30', '2013-03-20', '2013-05-01', '2013-06-19', '2013-07-31', '2013-09-18', '2013-10-30', '2013-12-18',
  '2014-01-29', '2014-03-19', '2014-04-30', '2014-06-18', '2014-07-30', '2014-09-17', '2014-10-29', '2014-12-17',
  '2015-01-28', '2015-03-18', '2015-04-29', '2015-06-17', '2015-07-29', '2015-09-17', '2015-10-28', '2015-12-16',
  '2016-01-27', '2016-03-16', '2016-04-27', '2016-06-15', '2016-07-27', '2016-09-21', '2016-11-02', '2016-12-14',
  '2017-02-01', '2017-03-15', '2017-05-03', '2017-06-14', '2017-07-26', '2017-09-20', '2017-11-01', '2017-12-13',
  '2018-01-31', '2018-03-21', '2018-05-02', '2018-06-13', '2018-08-01', '2018-09-26', '2018-11-08', '2018-12-19',
  '2019-01-30', '2019-03-20', '2019-05-01', '2019-06-19', '2019-07-31', '2019-09-18', '2019-10-30', '2019-12-11',
  '2020-01-29', '2020-04-29', '2020-06-10', '2020-07-29', '2020-09-16', '2020-11-05', '2020-12-16',
  '2021-01-27', '2021-03-17', '2021-04-28', '2021-06-16', '2021-07-28', '2021-09-22', '2021-11-03', '2021-12-15',
  '2022-01-26', '2022-03-16', '2022-05-04', '2022-06-15', '2022-07-27', '2022-09-21', '2022-11-02', '2022-12-14',
  '2023-02-01', '2023-03-22', '2023-05-03', '2023-06-14', '2023-07-26', '2023-09-20', '2023-11-01', '2023-12-13',
  '2024-01-31', '2024-03-20', '2024-05-01', '2024-06-12', '2024-07-31', '2024-09-18', '2024-11-07', '2024-12-18',
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
]

// El comunicado sale a las 14:00 de Nueva York, que es lo que hay que anclar: Madrid y
// Nueva York no cambian la hora el mismo fin de semana, así que un par de semanas al año
// esas 14:00 no son las 20:00 de Madrid sino las 19:00 o las 21:00.
export const HORA_FOMC_NY = 14 * 60

export const ANIOS_FOMC = [...new Set(FOMC.map(f => Number(f.slice(0, 4))))]
