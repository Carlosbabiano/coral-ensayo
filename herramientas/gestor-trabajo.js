// Hilo de trabajo del Gestor de obras: prepara una obra sin bloquear el servidor (Audiveris tarda minutos, y la lectura
// con IA también). Tareas (workerData.tarea):
//  - 'analizar': mira las páginas del PDF para contar filas y compases y estimar el coste de leerla con IA (sin API)
//  - (sin tarea): prepara la obra; si workerData.lecturaIA viene con { dirTrabajo, modelo }, antes lee la partitura con la
//    IA (avisa del avance con mensajes 'avance' y se para si el servidor manda { tipo: 'cancelar' })
const { parentPort, workerData } = require('worker_threads');
const obra = require('./obra.js');

const log = linea => parentPort.postMessage({ tipo: 'log', linea });
(async () => {
  try {
    if (workerData.tarea === 'analizar') {
      const lecturaIA = require('./lectura-ia.js');
      const a = lecturaIA.analizar({ pdf: workerData.pdf, dirTrabajo: workerData.dirTrabajo, log });
      parentPort.postMessage({ tipo: 'fin', resultado: { paginas: a.paginas.length, filas: a.filas.length, compases: a.compases, consultas: a.consultas + 1, estimaciones: lecturaIA.estimaciones(a) } });
      return;
    }
    let extra = {};
    if (workerData.lecturaIA) {
      const lecturaIA = require('./lectura-ia.js');
      let cancelar = false;
      parentPort.on('message', m => { if (m && m.tipo === 'cancelar') cancelar = true; });
      const r = await lecturaIA.leer({ pdf: workerData.pdf, dirTrabajo: workerData.lecturaIA.dirTrabajo, modelo: workerData.lecturaIA.modelo, log, avance: x => parentPort.postMessage({ tipo: 'avance', ...x }), cancelado: () => cancelar });
      extra = { xmlTexto: r.xml, posicionesDadas: r.posiciones, paginasDadas: r.paginas, lecturaIA: { modelo: r.modelo, coste: r.coste, uso: r.uso, consultas: r.consultas, cacheadas: r.cacheadas, compases: r.compases, dudosos: r.dudosos, segundos: r.segundos, avisos: r.avisos } };
    }
    const r = obra.prepararObra({ ...workerData, ...extra, log });
    parentPort.postMessage({ tipo: 'fin', resultado: r });
  } catch (e) {
    parentPort.postMessage({ tipo: 'error', mensaje: e.message, tipoError: e.tipo || null });
  }
})();
