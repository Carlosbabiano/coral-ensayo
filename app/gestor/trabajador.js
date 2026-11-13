// Trabajo pesado del gestor del móvil, fuera de la página para que no se congele: preparar el MusicXML y buscar los
// compases en las imágenes de las páginas. Usa exactamente el mismo código que el gestor del PC.
/* global importScripts, PrepararObra, DetectorCompases */
importScripts('../compases.js', '../preparar-obra.js', '../detector-compases.js');

self.onmessage = e => {
  const { id, tipo, datos } = e.data;
  const log = [];
  try {
    let r;
    if (tipo === 'xml') {
      // Lo mismo que hace prepararObra en el PC con el XML del Escáner Musical
      r = PrepararObra.prepararXml(datos.xml, { nombreArchivo: datos.nombreArchivo, delEscaner: true, log: l => log.push(l) });
      r.compases = PrepararObra.compasesDe(r.xml).length;
    } else if (tipo === 'detectar') {
      r = DetectorCompases.posicionesDesdeGris(datos.xml, datos.grises, l => log.push(l));
    } else if (tipo === 'editar') {
      const xml = PrepararObra.editarObra(datos.xml, datos.ajustes);
      r = { xml, tempo: PrepararObra.tempoDe(xml) };
    } else throw new Error('Tarea desconocida: ' + tipo);
    self.postMessage({ id, ok: true, r, log });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.message || String(err), log });
  }
};
