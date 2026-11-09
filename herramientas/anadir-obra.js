// Añade una obra (MusicXML del Escáner Musical) a la app, desde la línea de órdenes ("Añadir obra.cmd").
// Uso:  node herramientas/anadir-obra.js "ruta/a/Obra.xml" [Obra.pdf] [otra.xml ...]
//   - Pone nombre a las voces (Soprano, Contralto, Tenor, Bajo) según su tesitura
//   - Avisa de compases con duración sospechosa
//   - Saca letra y página original del PDF (Audiveris)
//   - Copia los archivos a app/partituras/ y los añade a lista.json
//   - Sube la versión de la caché (sw.js) para que los móviles reciban la obra nueva
//   - Guarda el cambio en git (si hay repositorio)
// Para hacerlo con previsualización, usa "Gestor.cmd".
const fs = require('fs'), path = require('path'), os = require('os');
const obra = require('./obra.js');

const entradas = process.argv.slice(2);
const xmls = entradas.filter(f => /\.(xml|musicxml)$/i.test(f));
const pdfs = entradas.filter(f => /\.pdf$/i.test(f));
if (!xmls.length && !pdfs.length) { console.log('Arrastra uno o varios archivos .xml del Escáner Musical (y, si lo tienes, el .pdf de la obra) sobre "Añadir obra.cmd".'); process.exit(1); }
for (const p of pdfs) if (!xmls.some(x => obra.clave(x) === obra.clave(p))) console.log(`Aviso: ${path.basename(p)} no tiene un .xml con el mismo nombre; la letra se saca del PDF pero las notas hacen falta del escáner.`);

const hechas = [];
for (const xml of xmls) {
  console.log('\n== ' + path.basename(xml) + ' ==');
  const dirSalida = fs.mkdtempSync(path.join(os.tmpdir(), 'obra-'));
  try {
    // Sin PDF la obra saldría sin la página original (el coro vería la partitura dibujada, sin letra): no se añade.
    // Además de los arrastrados, junto al XML y en originales/pdf, se busca en Entrada/ y Entrada/pendientes/
    const entrada = path.join(obra.RAIZ, 'Entrada');
    const pdf = obra.pdfPara(xml, pdfs) || obra.pdfPara(path.join(entrada, path.basename(xml))) || obra.pdfPara(path.join(entrada, 'pendientes', path.basename(xml)));
    if (!pdf) throw new Error(`No encuentro el PDF de "${path.basename(xml)}". Arrastra el XML y su PDF a la vez sobre "Añadir obra.cmd" (o ponles el mismo nombre): sin PDF el coro no vería la página original con la letra.`);
    const r = obra.prepararObra({ xml, pdf, dirSalida });
    const existia = obra.incorporarEnApp(r.entrada, dirSalida);
    obra.guardarPdf(r.pdf, r.entrada.archivo.replace(/\.xml$/, ''));
    console.log(`  ${existia ? 'Actualizada' : 'Añadida'} "${r.entrada.titulo}" -> app/partituras/${r.entrada.archivo}`);
    hechas.push(r.entrada.titulo);
  } catch (e) { console.log('  X ' + e.message); }
}
if (!hechas.length) { console.log('\nNo se ha añadido ninguna obra.'); process.exit(1); }

obra.subirVersionCache();
if (obra.guardarEnGit('Añadir obra: ' + hechas.join(', '))) console.log('\nCambios guardados en el repositorio. Si la app está publicada, súbelos con "Publicar.cmd".');
else console.log('\n(No se ha guardado en git: no hay cambios o no hay repositorio.)');
console.log(`\nListo: ${hechas.length} obra(s). Total en la app: ${obra.leerLista().length}.`);
