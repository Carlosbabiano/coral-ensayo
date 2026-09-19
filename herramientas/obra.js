// Todo lo necesario para preparar una obra (MusicXML del Escáner Musical + PDF), retocarla y meterla en la app.
// Lo usan "Añadir obra.cmd" (anadir-obra.js) y el Gestor de obras (gestor.js).
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { execSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
const DIR_APP = path.join(RAIZ, 'app');
const DIR_PARTITURAS = path.join(DIR_APP, 'partituras');
const LISTA = path.join(DIR_PARTITURAS, 'lista.json');
const SW = path.join(DIR_APP, 'sw.js');
const DIR_PDF = path.join(RAIZ, 'pdf');
const CACHE_AUDIVERIS = path.join(__dirname, 'cache', 'audiveris');

const { transplantar } = require('./letra.js');
const { posiciones } = require('./posiciones.js');
const { generarPaginas } = require('./paginas.js');
const AUDIVERIS = 'C:\\Program Files\\Audiveris\\Audiveris.exe';
const IDIOMA_OCR = process.env.LETRA_IDIOMA || 'spa+eng'; // idiomas para leer la letra (spa, ita, fra, lat, eng)

const NOMBRES_VOCES = ['Soprano', 'Mezzosoprano', 'Contralto', 'Tenor', 'Barítono', 'Bajo', 'Voz', 'Piano'];
const NOMBRES_CONOCIDOS = /soprano|alto|contralto|tenor|bajo|bass|mezzo|bar[ií]tono|voz\s*\d|piano|órgano|organo/i;
const SEMITONOS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NOTAS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Nombre "clave" de un archivo para emparejar XML y PDF: sin extensión, minúsculas, solo letras y números
const clave = f => path.basename(f).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Busca el PDF que corresponde a un XML: entre los dados, junto al XML o en la carpeta pdf/
function pdfPara(xml, pdfs = []) {
  const k = clave(xml);
  const dado = pdfs.find(p => clave(p) === k); if (dado) return dado;
  for (const dir of [path.dirname(xml), DIR_PDF]) {
    try { const f = fs.readdirSync(dir).find(n => /\.pdf$/i.test(n) && clave(n) === k); if (f) return path.join(dir, f); } catch {}
  }
  return null;
}

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

// Pasa el PDF por Audiveris (notas + letra + maquetación) y devuelve su MusicXML.
// El resultado se guarda en herramientas/cache/audiveris/ para no repetir la lectura (tarda minutos) con el mismo PDF.
function leerConAudiveris(pdf, log = console.log) {
  const buf = fs.readFileSync(pdf);
  const huella = crypto.createHash('sha1').update(buf).update(IDIOMA_OCR).digest('hex');
  const enCache = path.join(CACHE_AUDIVERIS, huella + '.xml');
  if (fs.existsSync(enCache)) { log('  lectura del PDF recuperada de la caché (ya se leyó antes con Audiveris)'); return fs.readFileSync(enCache, 'utf8'); }
  if (!fs.existsSync(AUDIVERIS)) throw new Error('Audiveris no está instalado (' + AUDIVERIS + ')');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'audiveris-'));
  log('  leyendo el PDF con Audiveris (puede tardar un par de minutos)...');
  execSync(`"${AUDIVERIS}" -batch -export -constant org.audiveris.omr.text.Language.defaultSpecification=${IDIOMA_OCR} -output "${tmp}" -- "${path.resolve(pdf)}"`, { stdio: 'ignore', timeout: 15 * 60 * 1000 });
  const mxl = fs.readdirSync(tmp).find(f => /\.mxl$/i.test(f));
  if (!mxl) throw new Error('Audiveris no ha generado ningún archivo');
  const zip = path.join(tmp, 'salida.zip'); fs.copyFileSync(path.join(tmp, mxl), zip);
  execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zip}' -DestinationPath '${path.join(tmp, 'x')}' -Force"`, { stdio: 'ignore' });
  const buscar = d => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { const r = buscar(p); if (r) return r; } else if (/\.xml$/i.test(f) && f !== 'container.xml') return p; } return null; };
  const xmlPath = buscar(path.join(tmp, 'x'));
  if (!xmlPath) throw new Error('No se encuentra el MusicXML dentro del .mxl');
  const xml = fs.readFileSync(xmlPath, 'utf8');
  try { fs.mkdirSync(CACHE_AUDIVERIS, { recursive: true }); fs.writeFileSync(enCache, xml); } catch {}
  return xml;
}

function limpiarNombreArchivo(titulo) {
  return titulo.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'Obra';
}

// Voces de un MusicXML: [{ id, nombre }]
function leerPartes(xml) {
  return [...xml.matchAll(/<score-part id="([^"]+)">([\s\S]*?)<\/score-part>/g)].map(([, id, cab]) => ({ id, nombre: (cab.match(/<part-name>([^<]*)/) || [, ''])[1].trim() }));
}

function tituloDe(xml) { return (xml.match(/<work-title>([^<]*)/) || [, ''])[1].trim(); }

// Tempo escrito en la partitura (♩ por minuto), o null si no hay
function tempoDe(xml) {
  const s = xml.match(/<sound[^>]*tempo="([\d.]+)"/); if (s) return Math.round(+s[1]);
  const p = xml.match(/<per-minute>([\d.]+)/); if (p) return Math.round(+p[1]);
  return null;
}

const escapar = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Cambia título, nombres de voces, quita voces y fija el tempo. Devuelve el XML nuevo.
function editarObra(xml, { titulo, nombres = {}, quitar = [], tempo } = {}) {
  if (titulo && titulo.trim()) {
    const t = escapar(titulo.trim());
    xml = /<work-title>/.test(xml) ? xml.replace(/<work-title>[^<]*<\/work-title>/, `<work-title>${t}</work-title>`)
      : xml.replace(/<score-partwise[^>]*>/, m => `${m}\n\t<work>\n\t\t<work-title>${t}</work-title>\n\t</work>`);
  }
  for (const id of quitar) {
    xml = xml.replace(new RegExp(`<part id="${id}">[\\s\\S]*?</part>\\s*`), '').replace(new RegExp(`<score-part id="${id}">[\\s\\S]*?</score-part>\\s*`), '');
  }
  for (const [id, nombre] of Object.entries(nombres)) {
    if (!nombre || !nombre.trim() || quitar.includes(id)) continue;
    const n = escapar(nombre.trim());
    const a = xml.indexOf(`<score-part id="${id}">`); if (a < 0) continue;
    const b = xml.indexOf('</score-part>', a);
    let cab = xml.slice(a, b).replace(/<part-name>[^<]*/, '<part-name>' + n).replace(/<instrument-name>[^<]*/, '<instrument-name>' + n);
    if (!/<part-name>/.test(cab)) cab = cab.replace(/(<score-part id="[^"]+">)/, `$1\n\t\t\t<part-name>${n}</part-name>`);
    xml = xml.slice(0, a) + cab + xml.slice(b);
  }
  if (tempo && +tempo >= 20 && +tempo <= 300) {
    const bpm = Math.round(+tempo);
    if (/<sound[^>]*tempo="/.test(xml) || /<per-minute>/.test(xml)) {
      xml = xml.replace(/(<sound[^>]*tempo=")[\d.]+(")/, `$1${bpm}$2`).replace(/<per-minute>[\d.]+<\/per-minute>/, `<per-minute>${bpm}</per-minute>`).replace(/(<beat-unit>)[a-z]+(<\/beat-unit>)/, '$1quarter$2');
    } else {
      // No había tempo: se añade al principio del primer compás de la primera voz
      const dir = `\n\t\t\t<direction placement="above">\n\t\t\t\t<direction-type>\n\t\t\t\t\t<metronome>\n\t\t\t\t\t\t<beat-unit>quarter</beat-unit>\n\t\t\t\t\t\t<per-minute>${bpm}</per-minute>\n\t\t\t\t\t</metronome>\n\t\t\t\t</direction-type>\n\t\t\t\t<sound tempo="${bpm}"/>\n\t\t\t</direction>`;
      xml = xml.replace(/(<part id="[^"]+">(?:\s|<!--[\s\S]*?-->)*<measure[^>]*>[\s\S]*?)(<\/attributes>|(?=<note))/, (m, a, b) => b === '</attributes>' ? a + b + dir : a + dir);
    }
  }
  return xml;
}

// ---------- Revisión de compases ----------
const FIGURAS = { maxima: 'máxima', long: 'longa', breve: 'cuadrada', whole: 'redonda', half: 'blanca', quarter: 'negra', eighth: 'corchea', '16th': 'semicorchea', '32nd': 'fusa', '64th': 'semifusa' };
const NOMBRES_NOTAS = { C: 'Do', D: 'Re', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' };
const RE_PARTE = /<part id="([^"]+)">([\s\S]*?)<\/part>/g;
const RE_COMPAS = /<measure number="([^"]+)"[^>]*>([\s\S]*?)<\/measure>/g;
const RE_NOTA = /<note(?:\s[^>]*)?>[\s\S]*?<\/note>/g;

// Recorre los compases de cada voz llamando a f(info) con { id, nombre, num, cuerpo, div, beats, bt, cambio }
function recorrerCompases(xml, f) {
  const nombres = Object.fromEntries(leerPartes(xml).map(p => [p.id, p.nombre]));
  for (const [, id, cuerpo] of xml.matchAll(RE_PARTE)) {
    let div = 1, beats = 4, bt = 4;
    for (const [, num, m] of cuerpo.matchAll(RE_COMPAS)) {
      const d = m.match(/<divisions>(\d+)/); if (d) div = +d[1];
      const b = m.match(/<beats>(\d+)<\/beats>\s*<beat-type>(\d+)/); if (b) { beats = +b[1]; bt = +b[2]; }
      f({ id, nombre: nombres[id] || id, num, cuerpo: m, div, beats, bt, cambio: !!b });
    }
  }
}
// Suma de duraciones (en negras) de la voz principal de un compás
function sumaCompas(cuerpo, div) {
  let s = 0;
  for (const [n] of cuerpo.matchAll(RE_NOTA)) if (!/<chord/.test(n) && !/<voice>[2-9]/.test(n)) s += +(n.match(/<duration>(\d+)/) || [, 0])[1];
  return s / div;
}
// Números de compás en los que alguna voz no suma lo que marca el compás
function sospechososDe(xml) {
  const malos = new Set();
  recorrerCompases(xml, c => { if (Math.abs(sumaCompas(c.cuerpo, c.div) - 4 * c.beats / c.bt) > 0.01) malos.add(c.num); });
  return [...malos];
}
// Lo que hay escrito en un compás, voz por voz, en palabras: para compararlo con la imagen de la página
function detalleCompas(xml, numero) {
  const voces = [];
  recorrerCompases(xml, c => {
    if (c.num !== String(numero)) return;
    const notas = [...c.cuerpo.matchAll(RE_NOTA)].map(([n]) => {
      const dur = +(n.match(/<duration>(\d+)/) || [, 0])[1] / c.div;
      const tipo = (n.match(/<type>([^<]*)/) || [, ''])[1];
      const puntos = (n.match(/<dot\s*\/>/g) || []).length;
      const figura = (FIGURAS[tipo] || (dur ? dur + ' negras' : '?')) + ' con puntillo'.repeat(puntos);
      const letra = (n.match(/<text>([^<]*)/) || [, ''])[1];
      let texto;
      if (/<rest/.test(n)) texto = 'silencio de ' + figura;
      else {
        const p = n.match(/<step>(\w)<\/step>\s*(?:<alter>(-?\d+)<\/alter>)?\s*<octave>(\d)/);
        const alt = p && p[2] ? (+p[2] > 0 ? '♯'.repeat(+p[2]) : '♭'.repeat(-p[2])) : '';
        texto = (p ? NOMBRES_NOTAS[p[1]] + alt + p[3] : '?') + ' ' + figura;
        if (/<chord/.test(n)) texto = '+ ' + texto;
        if (/<tie type="stop"/.test(n)) texto = '(ligada) ' + texto;
        if (/<tie type="start"/.test(n)) texto += ' ~';
      }
      if (letra) texto += ' «' + letra + '»';
      return texto;
    });
    voces.push({ id: c.id, nombre: c.nombre, beats: c.beats, bt: c.bt, cambio: c.cambio, esperado: 4 * c.beats / c.bt, suma: sumaCompas(c.cuerpo, c.div), notas });
  });
  return voces;
}
// Pone (o cambia) la indicación de compás dentro del cuerpo de un compás
function ponerTiempo(cuerpo, beats, bt) {
  const t = `<time><beats>${beats}</beats><beat-type>${bt}</beat-type></time>`;
  if (/<time[\s>]/.test(cuerpo)) return cuerpo.replace(/<time[^>]*>[\s\S]*?<\/time>/, t);
  if (/<attributes>/.test(cuerpo)) return cuerpo.replace(/(<attributes>)([\s\S]*?)(<\/attributes>)/, (a, o, b, c) => {
    if (/<\/key>/.test(b)) b = b.replace(/(<\/key>)/, '$1' + t);
    else if (/<clef/.test(b)) b = b.replace(/(<clef)/, t + '$1');
    else b += t;
    return o + b + c;
  });
  return '<attributes>' + t + '</attributes>' + cuerpo;
}
// Fija la indicación de compás de un compás (en todas las voces). Si restaurar, el compás siguiente vuelve al compás que había antes.
function fijarCompas(xml, numero, beats, bt, restaurar = true) {
  numero = String(numero);
  return xml.replace(RE_PARTE, parte => {
    let b0 = 4, t0 = 4, anteriorBeats = 4, anteriorBt = 4, tocado = false;
    return parte.replace(/(<measure number="([^"]+)"[^>]*>)([\s\S]*?)(<\/measure>)/g, (m, ini, num, cuerpo, fin) => {
      const b = cuerpo.match(/<beats>(\d+)<\/beats>\s*<beat-type>(\d+)/);
      if (num === numero) { anteriorBeats = b0; anteriorBt = t0; b0 = beats; t0 = bt; tocado = true; return ini + ponerTiempo(cuerpo, beats, bt) + fin; }
      if (tocado && restaurar) { tocado = false; if (!b) { b0 = anteriorBeats; t0 = anteriorBt; return ini + ponerTiempo(cuerpo, anteriorBeats, anteriorBt) + fin; } }
      if (b) { b0 = +b[1]; t0 = +b[2]; }
      return m;
    });
  });
}

// Prepara una obra: repara el XML, nombra las voces, saca letra y página original del PDF y deja los archivos en dirSalida.
// Devuelve { entrada, avisos, partes, sospechosos, tempo }. Lanza un error con mensaje claro si el XML no vale.
function prepararObra({ xml: rutaXml, pdf: rutaPdf = null, dirSalida, log = console.log }) {
  if (!fs.existsSync(rutaXml)) throw new Error('No existe el archivo ' + rutaXml);
  if (/\.mxl$/i.test(rutaXml)) throw new Error('Es un .mxl (comprimido). Exporta como .xml / .musicxml sin comprimir.');
  let xml = fs.readFileSync(rutaXml, 'utf8');
  if (!/<score-partwise/.test(xml)) throw new Error('No parece un archivo MusicXML.');

  // Título: el del archivo XML, o el nombre del archivo si viene vacío/genérico
  let titulo = tituloDe(xml);
  if (!titulo || /^(untitled|sin t[ií]tulo|score|partitura)$/i.test(titulo)) titulo = path.basename(rutaXml).replace(/\.[^.]+$/, '');
  titulo = titulo.replace(/_+/g, ' ').trim();
  xml = editarObra(xml, { titulo });

  const avisos = [];
  xml = repararCompases(xml, avisos);
  for (const av of avisos) log('  * ' + av);

  // Partes
  const partes = [];
  for (const [, id, cuerpo] of xml.matchAll(/<part id="([^"]+)">([\s\S]*?)<\/part>/g)) {
    const cab = (xml.match(new RegExp(`<score-part id="${id}">[\\s\\S]*?</score-part>`)) || [''])[0];
    const nombreActual = (cab.match(/<part-name>([^<]*)/) || [, ''])[1].trim();
    partes.push({ id, nombreActual, ...analizarParte(cuerpo) });
  }
  if (!partes.length) throw new Error('No se han encontrado voces en el archivo.');

  const generico = partes.every(p => !NOMBRES_CONOCIDOS.test(p.nombreActual));
  const nombres = generico ? nombresPorTesitura(partes) : new Map(partes.map(p => [p.id, p.nombreActual || 'Voz']));
  xml = editarObra(xml, { nombres: Object.fromEntries(nombres) });
  const resumenPartes = partes.map(p => {
    const m = Math.round(p.media);
    const tesitura = NOTAS[m % 12] + (Math.floor(m / 12) - 1);
    log(`  ${nombres.get(p.id).padEnd(10)} (antes: ${p.nombreActual || 'sin nombre'} - tesitura media ${tesitura}, clave ${p.clave || '?'})`);
    return { id: p.id, nombre: nombres.get(p.id), nombreActual: p.nombreActual, tesitura, clave: p.clave || '?' };
  });
  // Mismo criterio que al revisar después: cualquier voz cuyas figuras no sumen el compás (también si está vacía)
  const sospechosos = sospechososDe(xml);
  if (sospechosos.length) log(`  ! Compases con duración sospechosa (revísalos en el PDF): ${sospechosos.join(', ')}`);
  else log('  OK Todos los compases cuadran.');

  // Letra y página original a partir del PDF (Audiveris)
  const base = limpiarNombreArchivo(titulo);
  const entrada = { titulo, archivo: base + '.xml' };
  fs.mkdirSync(dirSalida, { recursive: true });
  const pdf = rutaPdf || pdfPara(rutaXml);
  if (pdf) {
    try {
      const audXml = leerConAudiveris(pdf, log);
      const r = transplantar(xml, audXml);
      xml = r.salida;
      for (const l of r.informe) log('  letra ' + l);
      const pos = posiciones(xml, audXml);
      fs.writeFileSync(path.join(dirSalida, base + '.pos.json'), JSON.stringify(pos));
      entrada.paginas = generarPaginas(pdf, dirSalida, base);
      entrada.posiciones = base + '.pos.json';
      log(`  Página original incorporada (${entrada.paginas.length} imagen(es)); vista "PDF original" disponible.`);
    } catch (e) { log('  ! No se ha podido sacar la letra del PDF: ' + e.message.split('\n')[0]); }
  } else log('  (sin PDF: la obra irá sin letra y sin vista de página original)');

  fs.writeFileSync(path.join(dirSalida, entrada.archivo), xml);
  return { entrada, avisos, partes: resumenPartes, sospechosos, tempo: tempoDe(xml), pdf };
}

function leerLista() { try { return JSON.parse(fs.readFileSync(LISTA, 'utf8')); } catch { return []; } }
function guardarLista(lista) {
  lista.sort((a, b) => a.titulo.localeCompare(b.titulo, 'es'));
  fs.mkdirSync(DIR_PARTITURAS, { recursive: true });
  fs.writeFileSync(LISTA, JSON.stringify(lista, null, 2) + '\n');
}

// Copia los archivos de una obra preparada (en dirOrigen) a app/partituras y la apunta en lista.json.
// Devuelve true si ya existía (actualización).
function incorporarEnApp(entrada, dirOrigen) {
  fs.mkdirSync(DIR_PARTITURAS, { recursive: true });
  const lista = leerLista();
  const previa = lista.find(o => o.archivo === entrada.archivo) || {};
  const nueva = { titulo: entrada.titulo, archivo: entrada.archivo };
  if (entrada.paginas && entrada.paginas.length && entrada.posiciones) { nueva.posiciones = entrada.posiciones; nueva.paginas = entrada.paginas; }
  else if (previa.paginas) { nueva.posiciones = previa.posiciones; nueva.paginas = previa.paginas; } // conserva la página original anterior si esta vez no se ha dado el PDF
  for (const f of [entrada.archivo, ...(entrada.paginas && entrada.posiciones ? [entrada.posiciones, ...entrada.paginas] : [])]) {
    fs.copyFileSync(path.join(dirOrigen, f), path.join(DIR_PARTITURAS, f));
  }
  guardarLista([...lista.filter(o => o.archivo !== entrada.archivo), nueva]);
  return !!previa.archivo;
}

// Quita una obra de la app (lista y archivos)
function retirarDeApp(archivo) {
  const lista = leerLista();
  const obra = lista.find(o => o.archivo === archivo);
  if (!obra) throw new Error('Esa obra no está en la app: ' + archivo);
  for (const f of [obra.archivo, obra.posiciones, ...(obra.paginas || [])].filter(Boolean)) { try { fs.unlinkSync(path.join(DIR_PARTITURAS, f)); } catch {} }
  guardarLista(lista.filter(o => o.archivo !== archivo));
  return obra;
}

// Nueva versión de la caché para que los móviles descarguen la lista nueva
function subirVersionCache() {
  let sw = fs.readFileSync(SW, 'utf8');
  let version = '';
  sw = sw.replace(/coral-v(\d+)/, (_, v) => (version = 'coral-v' + (+v + 1)));
  fs.writeFileSync(SW, sw);
  return version;
}
function versionCache() { return (fs.readFileSync(SW, 'utf8').match(/coral-v\d+/) || ['?'])[0]; }

// Guarda los cambios de app/ en git, si hay repositorio. Devuelve true si se ha hecho un commit.
function guardarEnGit(mensaje) {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: RAIZ, stdio: 'ignore' });
    execSync('git add -A app pdf', { cwd: RAIZ, stdio: 'ignore' });
    execSync(`git -c user.name="Coral" -c user.email="ipadbabiano@gmail.com" commit -q -m "${mensaje.replace(/"/g, "'")}"`, { cwd: RAIZ, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// Guarda una copia del PDF en pdf/ (para poder regenerar la obra en el futuro)
function guardarPdf(rutaPdf, base) {
  if (!rutaPdf || !fs.existsSync(rutaPdf)) return null;
  fs.mkdirSync(DIR_PDF, { recursive: true });
  const destino = path.join(DIR_PDF, base + '.pdf');
  if (path.resolve(rutaPdf) !== path.resolve(destino)) fs.copyFileSync(rutaPdf, destino);
  return destino;
}

module.exports = {
  RAIZ, DIR_APP, DIR_PARTITURAS, DIR_PDF, LISTA, NOMBRES_VOCES,
  clave, pdfPara, prepararObra, editarObra, leerPartes, tituloDe, tempoDe, limpiarNombreArchivo,
  sospechososDe, detalleCompas, fijarCompas,
  leerLista, incorporarEnApp, retirarDeApp, subirVersionCache, versionCache, guardarEnGit, guardarPdf,
};
