// Hilo de trabajo del Gestor de obras: prepara una obra sin bloquear el servidor (Audiveris tarda minutos).
const { parentPort, workerData } = require('worker_threads');
const obra = require('./obra.js');

const log = linea => parentPort.postMessage({ tipo: 'log', linea });
try {
  const r = obra.prepararObra({ ...workerData, log });
  parentPort.postMessage({ tipo: 'fin', resultado: r });
} catch (e) {
  parentPort.postMessage({ tipo: 'error', mensaje: e.message });
}
