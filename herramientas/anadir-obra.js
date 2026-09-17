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

const { transplantar } = require('./letra.js');
const { posiciones } = require('./posiciones.js');
const AUDIVERIS = 'C:\\Program Files\\Audiveris\\Audiveris.exe';
const IDIOMA_OCR = process.env.LETRA_IDIOMA || 'spa+eng'; // idiomas para leer la letra (spa, ita, fra, lat, eng)

// Argumentos: archivos .xml/.musicxml (notas) y .pdf (letra y página original). Se emparejan por nombre.
const clave = f => path.basename(f).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const entradas = process.argv.slice(2);
const xmls = entradas.filter(f => /\.(xml|musicxml)$/i.test(f));
const pdfs = entradas.filter(f => /\.pdf$/i.test(f));
if (!xmls.length && !pdfs.length) { console.log('Arrastra uno o varios archivos .xml del Escáner Musical (y, si lo tienes, el .pdf de la obra) sobre "Añadir obra.cmd".'); process.exit(1); }
function pdfPara(xml) {
  const k = clave(xml);
  const dado = pdfs.find(p => clave(p) === k); if (dado) return dado;
  // Si no se ha arrastrado, se busca un PDF con el mismo nombre junto al XML o en la carpeta pdf/
  for (const dir of [path.dirname(xml), path.join(RAIZ, 'pdf')]) {
    try { const f = fs.readdirSync(dir).find(n => /\.pdf$/i.test(n) && clave(n) === k); if (f) return path.join(dir, f); } catch {}
  }
  return null;
}
for (const p of pdfs) if (!xmls.some(x => clave(x) === clave(p))) console.log(`Aviso: ${path.basename(p)} no tiene un .xml con el mismo nombre; la letra se saca del PDF pero las notas hacen falta del escáner.`);
const archivos = xmls;

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
    for (const [nota] of m.matchAll(/<note(?:\s[^>]*)?>[\s\S]*?<\/note>/g)) {
      const v = (nota.match(/<voice>(\d+)/) || [, '1'])[1];
      if (!/<chord/.test(nota)) porVoz[v] = (porVoz[v] || 0) + +(nota.match(/<duration>(\d+)/) || [, 0])[1];
      const p = nota.match(/<step>(\w)<\/step>\s*(?:<alter>(-?\d+)<\/alter>)?\s*<octave>(\d)/);
      if (p && !/<rest/.test(nota)) { suma += 12 * (+p[3] + 1) + SEMITONOS[p[1]] + (+(p[2] || 0)); n++; }
    }
    const sumas = Object.values(porVoz);
    if (sumas.length && !sumas.some(s => s === esperado)) malos.push(num);
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

function repararCompases(xml, avisos) {
  const partes = () => [...xml.matchAll(/<part id="([^"]+)">([\s\S]*?)<\/part>/g)];
  const medidas = cuerpo => [...cuerpo.matchAll(/<measure number="([^"]+)"[^>]*>([\s\S]*?)<\/measure>/g)];
  const sumaCompas = (m, div) => {
    let s = 0;
    for (const [n] of m.matchAll(/<note(?:\s[^>]*)?>[\s\S]*?<\/note>/g)) if (!/<chord/.test(n) && !/<voice>[2-9]/.test(n)) s += +(n.match(/<duration>(\d+)/) || [, 0])[1];
    return s / div;
  };

  // 1) Parte con dos pentagramas (acompañamiento de piano) junto a voces normales: se quita.
  const esDoble = cuerpo => /<clef number="2">|<staves>\s*[2-9]|<staff>2<\/staff>/.test(cuerpo);
  const simples = partes().filter(([, , c]) => !esDoble(c)).length;
  for (const [todo, id, cuerpo] of partes()) {
    if (!esDoble(cuerpo)) continue;
    if (simples >= 2) {
      xml = xml.replace(todo, '').replace(new RegExp(`<score-part id="${id}">[\\s\\S]*?</score-part>\\s*`), '');
      avisos.push(`Se ha quitado una parte de dos pentagramas que parecía el acompañamiento de piano (${id}).`);
    } else {
      avisos.push(`La parte ${id} tiene dos pentagramas; la app la tratará como una sola voz.`);
    }
  }

  // 2) Indicación de compás que falta en una voz pero está en otra, en el mismo compás: se copia.
  const tiemposPorCompas = {};
  for (const [, , cuerpo] of partes())
    for (const [, num, m] of medidas(cuerpo)) { const t = m.match(/<time[^>]*>[\s\S]*?<\/time>/); if (t && !tiemposPorCompas[num]) tiemposPorCompas[num] = t[0]; }
  xml = xml.replace(/<part id="[^"]+">[\s\S]*?<\/part>/g, parte =>
    parte.replace(/(<measure number="([^"]+)"[^>]*>)([\s\S]*?)(<\/measure>)/g, (m, ini, num, cuerpo, fin) => {
      const t = tiemposPorCompas[num];
      if (!t || /<time/.test(cuerpo)) return m;
      if (/<attributes>/.test(cuerpo)) {
        cuerpo = cuerpo.replace(/(<attributes>)([\s\S]*?)(<\/attributes>)/, (a, o, b, c) => {
          if (/<\/key>/.test(b)) b = b.replace(/(<\/key>)/, '$1' + t);
          else if (/<clef>/.test(b)) b = b.replace(/(<clef>)/, t + '$1');
          else b += t;
          return o + b + c;
        });
      } else cuerpo = '<attributes>' + t + '</attributes>' + cuerpo;
      return ini + cuerpo + fin;
    }));

  // 3) Una sola indicación de compás en toda la obra que no coincide con lo que suman los compases: se corrige.
  const todosTiempos = [...xml.matchAll(/<beats>(\d+)<\/beats>\s*<beat-type>(\d+)<\/beat-type>/g)];
  const distintos = new Set(todosTiempos.map(t => t[1] + '/' + t[2]));
  if (distintos.size === 1) {
    const [beats, bt] = [...distintos][0].split('/').map(Number);
    const hist = {}; let total = 0;
    for (const [, , cuerpo] of partes()) {
      let div = 1;
      for (const [, , m] of medidas(cuerpo)) { const d = m.match(/<divisions>(\d+)/); if (d) div = +d[1]; const q = sumaCompas(m, div).toFixed(2); hist[q] = (hist[q] || 0) + 1; total++; }
    }
    const [valor, veces] = Object.entries(hist).sort((a, b) => b[1] - a[1])[0] || [];
    const real = +valor;
    if (total && veces / total >= 0.8 && Math.abs(real - 4 * beats / bt) > 0.01 && real > 0) {
      const nuevo = Number.isInteger(real) ? [real, 4] : Number.isInteger(real * 2) ? [real * 2, 8] : null;
      if (nuevo) {
        xml = xml.replace(/<beats>\d+<\/beats>(\s*)<beat-type>\d+<\/beat-type>/g, `<beats>${nuevo[0]}</beats>$1<beat-type>${nuevo[1]}</beat-type>`);
        avisos.push(`El escáner puso compás de ${beats}/${bt} pero los compases suman ${nuevo[0]}/${nuevo[1]}: corregido.`);
      }
    }
  }

  // 4) Silencio de compás entero con duración incorrecta: se ajusta a la duración del compás
  xml = xml.replace(/<part id="[^"]+">[\s\S]*?<\/part>/g, parte => {
    let div = 1, beats = 4, bt = 4;
    return parte.replace(/<measure number="[^"]+"[^>]*>[\s\S]*?<\/measure>/g, m => {
      const d = m.match(/<divisions>(\d+)/); if (d) div = +d[1];
      const b = m.match(/<beats>(\d+)<\/beats>\s*<beat-type>(\d+)/); if (b) { beats = +b[1]; bt = +b[2]; }
      const notas = [...m.matchAll(/<note(?:\s[^>]*)?>[\s\S]*?<\/note>/g)];
      if (notas.length === 1 && /<rest/.test(notas[0][0]) && /<type>whole<\/type>/.test(notas[0][0])) {
        const dur = Math.round(div * 4 * beats / bt);
        return m.replace(notas[0][0], notas[0][0].replace(/<rest\s*\/>/, '<rest measure="yes"/>').replace(/<duration>\d+/, '<duration>' + dur));
      }
      return m;
    });
  });
  return xml;
}

// Pasa el PDF por Audiveris (notas + letra + maquetación) y devuelve su MusicXML
function leerConAudiveris(pdf) {
  if (!fs.existsSync(AUDIVERIS)) throw new Error('Audiveris no está instalado (' + AUDIVERIS + ')');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'audiveris-'));
  console.log('  leyendo el PDF con Audiveris (puede tardar un par de minutos)...');
  execSync(`"${AUDIVERIS}" -batch -export -constant org.audiveris.omr.text.Language.defaultSpecification=${IDIOMA_OCR} -output "${tmp}" -- "${path.resolve(pdf)}"`, { stdio: 'ignore', timeout: 15 * 60 * 1000 });
  const mxl = fs.readdirSync(tmp).find(f => /\.mxl$/i.test(f));
  if (!mxl) throw new Error('Audiveris no ha generado ningún archivo');
  const zip = path.join(tmp, 'salida.zip'); fs.copyFileSync(path.join(tmp, mxl), zip);
  execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zip}' -DestinationPath '${path.join(tmp, 'x')}' -Force"`, { stdio: 'ignore' });
  const buscar = d => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { const r = buscar(p); if (r) return r; } else if (/\.xml$/i.test(f) && f !== 'container.xml') return p; } return null; };
  const xmlPath = buscar(path.join(tmp, 'x'));
  if (!xmlPath) throw new Error('No se encuentra el MusicXML dentro del .mxl');
  return fs.readFileSync(xmlPath, 'utf8');
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

  const avisos = [];
  xml = repararCompases(xml, avisos);
  for (const av of avisos) console.log("  * " + av);

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

  // Letra y página original a partir del PDF (Audiveris)
  const base = limpiarNombreArchivo(titulo);
  const entrada = { titulo, archivo: base + '.xml' };
  const pdf = pdfPara(ruta);
  if (pdf) {
    try {
      const audXml = leerConAudiveris(pdf);
      const r = transplantar(xml, audXml);
      xml = r.salida;
      for (const l of r.informe) console.log('  letra ' + l);
      const pos = posiciones(xml, audXml);
      fs.mkdirSync(DIR_PARTITURAS, { recursive: true });
      fs.writeFileSync(path.join(DIR_PARTITURAS, base + '.pos.json'), JSON.stringify(pos));
      fs.copyFileSync(pdf, path.join(DIR_PARTITURAS, base + '.pdf'));
      entrada.pdf = base + '.pdf'; entrada.posiciones = base + '.pos.json';
      console.log(`  PDF original incorporado (${pos.paginas} página(s)); vista "PDF original" disponible.`);
    } catch (e) { console.log('  ! No se ha podido sacar la letra del PDF: ' + e.message.split('\n')[0]); }
  } else console.log('  (sin PDF: la obra irá sin letra y sin vista de página original)');

  // Guardar en la app
  const archivo = entrada.archivo;
  fs.mkdirSync(DIR_PARTITURAS, { recursive: true });
  fs.writeFileSync(path.join(DIR_PARTITURAS, archivo), xml);
  let lista = [];
  try { lista = JSON.parse(fs.readFileSync(LISTA, 'utf8')); } catch {}
  const existia = lista.some(o => o.archivo === archivo);
  const previa = lista.find(o => o.archivo === archivo) || {};
  lista = lista.filter(o => o.archivo !== archivo);
  if (!entrada.pdf && previa.pdf) { entrada.pdf = previa.pdf; entrada.posiciones = previa.posiciones; } // conserva el PDF anterior si esta vez no se ha dado
  lista.push(entrada);
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
