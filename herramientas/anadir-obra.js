// Añade una obra (MusicXML del Escáner Musical) a la app.
// Uso:  node herramientas/anadir-obra.js "ruta/a/Obra.xml" [otra.xml ...]
//   - Pone nombre a las voces (Soprano, Contralto, Tenor, Bajo) según su tesitura
//   - Avisa de compases con duración sospechosa
//   - Copia el archivo a app/partituras/ y lo añade a lista.json
//   - Sube la versión de la caché (sw.js) para que los móviles reciban la obra nueva
//   - Guarda el cambio en git (si hay repositorio)
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
const DIR_PARTITURAS = path.join(RAIZ, 'app', 'partituras');
const LISTA = path.join(DIR_PARTITURAS, 'lista.json');
const SW = path.join(RAIZ, 'app', 'sw.js');

const archivos = process.argv.slice(2);
if (!archivos.length) { console.log('Arrastra uno o varios archivos .xml sobre "Añadir obra.cmd".'); process.exit(1); }

const NOMBRES_CONOCIDOS = /soprano|alto|contralto|tenor|bajo|bass|mezzo|bar[ií]tono|voz\s*\d|piano|órgano|organo/i;
const SEMITONOS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NOTAS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function analizarParte(cuerpo) {
  // Tesitura media, clave y compases de duración sospechosa
  let div = 1, beats = 4, bt = 4, suma = 0, n = 0, clave = '', malos = [];
  for (const [, num, m] of cuerpo.matchAll(/<measure number="([^"]+)"[^>]*>([\s\S]*?)<\/measure>/g)) {
    const d = m.match(/<divisions>(\d+)/); if (d) div = +d[1];
    const b = m.match(/<beats>(\d+)<\/beats>\s*<beat-type>(\d+)/); if (b) { beats = +b[1]; bt = +b[2]; }
    const c = m.match(/<clef>\s*<sign>(\w)<\/sign>/); if (c && !clave) clave = c[1];
    const esperado = div * 4 * beats / bt;
    const porVoz = {};
    for (const [nota] of m.matchAll(/<note>[\s\S]*?<\/note>/g)) {
      const v = (nota.match(/<voice>(\d+)/) || [, '1'])[1];
      if (!/<chord/.test(nota)) porVoz[v] = (porVoz[v] || 0) + +(nota.match(/<duration>(\d+)/) || [, 0])[1];
      const p = nota.match(/<step>(\w)<\/step>\s*(?:<alter>(-?\d+)<\/alter>)?\s*<octave>(\d)/);
      if (p && !/<rest/.test(nota)) { suma += 12 * (+p[3] + 1) + SEMITONOS[p[1]] + (+(p[2] || 0)); n++; }
    }
    for (const v in porVoz) if (porVoz[v] !== esperado) malos.push(num);
  }
  return { media: n ? suma / n : 60, clave, malos: [...new Set(malos)] };
}

function nombresPorTesitura(partes) {
  // De la más aguda a la más grave
  const orden = [...partes].sort((a, b) => b.media - a.media);
  const n = orden.length;
  const asignados = new Map();
  orden.forEach((p, i) => {
    let nombre;
    if (n === 4) nombre = ['Soprano', 'Contralto', 'Tenor', 'Bajo'][i];
    else if (n === 3) nombre = i < 2 ? ['Soprano', 'Contralto'][i] : (p.clave === 'F' ? 'Bajo' : 'Tenor');
    else if (n === 2) nombre = i === 0 ? 'Soprano' : (p.clave === 'F' ? 'Bajo' : 'Contralto');
    else if (n === 1) nombre = 'Voz';
    else nombre = 'Voz ' + (i + 1);
    asignados.set(p.id, nombre);
  });
  return asignados;
}

function limpiarNombreArchivo(titulo) {
  return titulo.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'Obra';
}

function procesar(ruta) {
  console.log('\n== ' + path.basename(ruta) + ' ==');
  if (!fs.existsSync(ruta)) { console.log('  X No existe el archivo.'); return false; }
  if (/\.mxl$/i.test(ruta)) { console.log('  X Es un .mxl (comprimido). Exporta como .xml / .musicxml sin comprimir.'); return false; }
  let xml = fs.readFileSync(ruta, 'utf8');
  if (!/<score-partwise/.test(xml)) { console.log('  X No parece un archivo MusicXML.'); return false; }

  // Título: el del archivo XML, o el nombre del archivo si viene vacío/genérico
  let titulo = (xml.match(/<work-title>([^<]*)/) || [, ''])[1].trim();
  if (!titulo || /^(untitled|sin t[ií]tulo|score|partitura)$/i.test(titulo)) titulo = path.basename(ruta).replace(/\.[^.]+$/, '');
  titulo = titulo.replace(/_+/g, ' ').trim();
  if (!xml.includes('<work-title>')) xml = xml.replace(/<score-partwise[^>]*>/, m => `${m}\n\t<work>\n\t\t<work-title>${titulo}</work-title>\n\t</work>`);

  // Partes
  const partes = [];
  for (const [, id, cuerpo] of xml.matchAll(/<part id="([^"]+)">([\s\S]*?)<\/part>/g)) {
    const cab = (xml.match(new RegExp(`<score-part id="${id}">[\\s\\S]*?</score-part>`)) || [''])[0];
    const nombreActual = (cab.match(/<part-name>([^<]*)/) || [, ''])[1].trim();
    partes.push({ id, nombreActual, ...analizarParte(cuerpo) });
  }
  if (!partes.length) { console.log('  X No se han encontrado voces.'); return false; }

  const generico = partes.every(p => !NOMBRES_CONOCIDOS.test(p.nombreActual));
  const nombres = generico ? nombresPorTesitura(partes) : new Map(partes.map(p => [p.id, p.nombreActual || 'Voz']));
  for (const p of partes) {
    const n = nombres.get(p.id);
    const a = xml.indexOf(`<score-part id="${p.id}">`), b = xml.indexOf('</score-part>', a);
    let cab = xml.slice(a, b).replace(/<part-name>[^<]*/, '<part-name>' + n).replace(/<instrument-name>[^<]*/, '<instrument-name>' + n);
    if (!/<part-name>/.test(cab)) cab = cab.replace(/(<score-part id="[^"]+">)/, `$1\n\t\t\t<part-name>${n}</part-name>`);
    xml = xml.slice(0, a) + cab + xml.slice(b);
    const m = Math.round(p.media);
    console.log(`  ${n.padEnd(10)} (antes: ${p.nombreActual || 'sin nombre'} - tesitura media ${NOTAS[m % 12]}${Math.floor(m / 12) - 1}, clave ${p.clave || '?'})`);
  }
  const sospechosos = [...new Set(partes.flatMap(p => p.malos))];
  if (sospechosos.length) console.log(`  ! Compases con duración sospechosa (revísalos en el PDF): ${sospechosos.join(', ')}`);
  else console.log('  OK Todos los compases cuadran.');

  // Guardar en la app
  const archivo = limpiarNombreArchivo(titulo) + '.xml';
  fs.mkdirSync(DIR_PARTITURAS, { recursive: true });
  fs.writeFileSync(path.join(DIR_PARTITURAS, archivo), xml);
  let lista = [];
  try { lista = JSON.parse(fs.readFileSync(LISTA, 'utf8')); } catch {}
  const existia = lista.some(o => o.archivo === archivo);
  lista = lista.filter(o => o.archivo !== archivo);
  lista.push({ titulo, archivo });
  lista.sort((a, b) => a.titulo.localeCompare(b.titulo, 'es'));
  fs.writeFileSync(LISTA, JSON.stringify(lista, null, 2) + '\n');
  console.log(`  ${existia ? 'Actualizada' : 'Añadida'} "${titulo}" -> app/partituras/${archivo}`);
  return titulo;
}

const hechas = archivos.map(procesar).filter(Boolean);
if (!hechas.length) { console.log('\nNo se ha añadido ninguna obra.'); process.exit(1); }

// Nueva versión de la caché para que los móviles descarguen la lista nueva
let sw = fs.readFileSync(SW, 'utf8');
sw = sw.replace(/coral-v(\d+)/, (_, v) => 'coral-v' + (+v + 1));
fs.writeFileSync(SW, sw);

// Guardar en git, si hay repositorio
try {
  execSync('git rev-parse --is-inside-work-tree', { cwd: RAIZ, stdio: 'ignore' });
  execSync('git add -A app', { cwd: RAIZ, stdio: 'ignore' });
  execSync(`git -c user.name="Coral" -c user.email="ipadbabiano@gmail.com" commit -q -m "Añadir obra: ${hechas.join(', ')}"`, { cwd: RAIZ, stdio: 'ignore' });
  console.log('\nCambios guardados en el repositorio. Si la app está publicada, súbelos con "Publicar.cmd".');
} catch { console.log('\n(No se ha guardado en git: no hay cambios o no hay repositorio.)'); }
console.log(`\nListo: ${hechas.length} obra(s). Total en la app: ${JSON.parse(fs.readFileSync(LISTA, 'utf8')).length}.`);
