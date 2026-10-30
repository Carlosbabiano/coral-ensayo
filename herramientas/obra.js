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
const { posicionesImagen } = require('./posiciones-imagen.js');
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

// Elementos de primer nivel dentro de un compás (igual que en app/compases.js)
const RE_ELEMENTO_COMPAS = /<(note|backup|forward|attributes|direction|barline|print|sound|harmony|figured-bass|grouping|link|bookmark)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)|<!--[\s\S]*?-->/g;

// ¿Una parte de dos pentagramas parece un acompañamiento (piano, órgano) y no dos voces del coro escritas juntas?
// Dos voces del coro llevan una línea melódica por pentagrama; el piano lleva acordes (varias notas a la vez).
function pareceAcompanamiento(nombre, cuerpo) {
  if (/piano|órgano|organo|acomp|teclado|keyboard|clave|cémbalo|cembalo|arpa|harp|guitar/i.test(nombre)) return true;
  if (/<staves>\s*[3-9]/.test(cuerpo)) return true; // tres pentagramas o más: órgano
  if (/<lyric\b/.test(cuerpo)) return false; // lleva letra: son voces
  const notas = [...cuerpo.matchAll(/<note(?:\s[^>]*)?>[\s\S]*?<\/note>/g)].map(m => m[0]).filter(n => !/<rest\b/.test(n));
  const acordes = notas.filter(n => /<chord\s*\/>/.test(n)).length;
  return notas.length > 0 && acordes / notas.length > 0.03;
}

// Separa una parte de dos pentagramas en dos partes de un pentagrama (la segunda con id + "B"), una voz del coro por
// pentagrama. Cada compás se reconstruye por pentagrama: las notas conservan su momento (con <forward>/<backup>), las
// voces se renumeran desde 1, cada pentagrama se queda con su clave, y las indicaciones (tempo, matices...) van al
// pentagrama que digan (o al primero). Devuelve el XML nuevo.
function separarPentagramas(xml, id) {
  const m = xml.match(new RegExp(`<part id="${id}">([\\s\\S]*?)</part>`)); if (!m) return xml;
  const id2 = id + 'B';
  const pentagramaDe = x => +((x.match(/<staff>(\d+)<\/staff>/) || [, 1])[1]);
  const sinPentagrama = x => x.replace(/\s*<staff>\d+<\/staff>/, '');
  const duracionDe = x => +((x.match(/<duration>(\d+)/) || [, 0])[1]);
  const atributosPara = (x, st) => {
    const a = x.replace(/\s*<staves>\d+<\/staves>/, '')
      .replace(/\s*<(clef|staff-details|transpose) number="(\d+)"[^>]*>[\s\S]*?<\/\1>/g, (todo, el, n) => +n === st ? todo.replace(` number="${n}"`, '') : '');
    return /<attributes>\s*<\/attributes>/.test(a) ? '' : a;
  };
  let div = 1, beats = 4, bt = 4;
  const compases = { 1: [], 2: [] };
  for (const [, ini, c, fin] of m[1].matchAll(/(<measure number="[^"]+"[^>]*>)([\s\S]*?)(<\/measure>)/g)) {
    const d = c.match(/<divisions>(\d+)/); if (d) div = +d[1];
    const b = c.match(/<beats>(\d+)<\/beats>\s*<beat-type>(\d+)/); if (b) { beats = +b[1]; bt = +b[2]; }
    // 1) cada elemento del compás, con el momento en que empieza y el pentagrama al que pertenece
    const eventos = { 1: [], 2: [] };
    let t = 0, orden = 0; const ultimoInicio = {};
    for (const mm of c.matchAll(RE_ELEMENTO_COMPAS)) {
      const tipo = mm[1] || 'comentario', x = mm[0]; orden++;
      if (tipo === 'note') {
        const st = eventos[pentagramaDe(x)] ? pentagramaDe(x) : 1;
        const acorde = /<chord\s*\/>/.test(x), dur = /<grace\b/.test(x) ? 0 : duracionDe(x);
        const inicio = acorde ? (ultimoInicio[st] || 0) : t;
        if (!acorde) { t = inicio + dur; ultimoInicio[st] = inicio; }
        eventos[st].push({ nota: true, inicio, dur, acorde, voz: +((x.match(/<voice>(\d+)/) || [, 1])[1]), xml: sinPentagrama(x), orden });
      } else if (tipo === 'backup') t -= duracionDe(x);
      else if (tipo === 'forward') t += duracionDe(x);
      else if (tipo === 'attributes') { for (const st of [1, 2]) { const a = atributosPara(x, st); if (a) eventos[st].push({ inicio: t, xml: a, orden }); } }
      else if (tipo === 'barline' || tipo === 'print') for (const st of [1, 2]) eventos[st].push({ inicio: t, xml: x, orden });
      else { const st = /<staff>/.test(x) && eventos[pentagramaDe(x)] ? pentagramaDe(x) : 1; eventos[st].push({ inicio: t, xml: sinPentagrama(x), orden }); }
    }
    // 2) el compás de cada pentagrama: voz por voz, en orden de tiempo
    for (const st of [1, 2]) {
      const evs = eventos[st];
      const vocesNum = [...new Set(evs.filter(e => e.nota).map(e => e.voz))].sort((a, b) => a - b);
      if (!vocesNum.length) vocesNum.push(1);
      const nuevaVoz = Object.fromEntries(vocesNum.map((v, i) => [v, i + 1]));
      const renumerar = x => x.replace(/<voice>(\d+)<\/voice>/g, (mm, v) => `<voice>${nuevaVoz[+v] || 1}</voice>`);
      let salida = '', cursor = 0;
      vocesNum.forEach((v, i) => {
        const lista = evs.filter(e => e.nota ? e.voz === v : i === 0).sort((a, b) => a.inicio - b.inicio || (a.nota ? 1 : 0) - (b.nota ? 1 : 0) || a.orden - b.orden);
        if (i > 0 && cursor > 0) { salida += `\n\t\t\t<backup>\n\t\t\t\t<duration>${cursor}</duration>\n\t\t\t</backup>`; cursor = 0; }
        for (const e of lista) {
          if (!e.acorde) {
            if (e.inicio > cursor) salida += `\n\t\t\t<forward>\n\t\t\t\t<duration>${e.inicio - cursor}</duration>\n\t\t\t</forward>`;
            else if (e.inicio < cursor) salida += `\n\t\t\t<backup>\n\t\t\t\t<duration>${cursor - e.inicio}</duration>\n\t\t\t</backup>`;
            cursor = e.inicio;
          }
          salida += '\n\t\t\t' + renumerar(e.xml);
          if (e.nota && !e.acorde) cursor = e.inicio + e.dur;
        }
      });
      if (!evs.some(e => e.nota)) salida += `\n\t\t\t<note>\n\t\t\t\t<rest measure="yes"/>\n\t\t\t\t<duration>${Math.round(div * 4 * beats / bt)}</duration>\n\t\t\t\t<voice>1</voice>\n\t\t\t\t<type>whole</type>\n\t\t\t</note>`;
      compases[st].push(ini + salida + '\n\t\t' + fin);
    }
  }
  const parte = st => `<part id="${st === 1 ? id : id2}">\n\t\t` + compases[st].join('\n\t\t') + '\n\t</part>';
  xml = xml.replace(m[0], () => parte(1) + '\n\t' + parte(2));
  // La cabecera (nombre, instrumento) se duplica para la parte nueva
  return xml.replace(new RegExp(`<score-part id="${id}">[\\s\\S]*?</score-part>`), cab => cab + '\n\t\t' + cab.replace(new RegExp(`id="${id}(-[^"]*)?"`, 'g'), (mm, suf) => `id="${id2}${suf || ''}"`));
}

function repararCompases(xml, avisos) {
  const partes = () => [...xml.matchAll(/<part id="([^"]+)">([\s\S]*?)<\/part>/g)];
  const medidas = cuerpo => [...cuerpo.matchAll(/<measure number="([^"]+)"[^>]*>([\s\S]*?)<\/measure>/g)];
  const sumaCompas = (m, div) => {
    let s = 0;
    for (const [n] of m.matchAll(/<note(?:\s[^>]*)?>[\s\S]*?<\/note>/g)) if (!/<chord/.test(n) && !/<voice>[2-9]/.test(n)) s += +(n.match(/<duration>(\d+)/) || [, 0])[1];
    return s / div;
  };

  // 1) Parte con dos pentagramas (clave de sol arriba y de fa abajo, con llave) junto a voces normales:
  //    - si cada pentagrama lleva una sola línea melódica (sin acordes) son dos voces del coro que el escáner ha
  //      juntado (tenor y bajo, por ejemplo): se separa en dos voces;
  //    - si lleva acordes, es el acompañamiento de piano: se quita (si hay al menos dos voces normales).
  const esDoble = cuerpo => /<clef number="2">|<staves>\s*[2-9]|<staff>2<\/staff>/.test(cuerpo);
  const nombreDe = id => ((xml.match(new RegExp(`<score-part id="${id}">[\\s\\S]*?</score-part>`)) || [''])[0].match(/<part-name>([^<]*)/) || [, ''])[1];
  const simples = partes().filter(([, , c]) => !esDoble(c)).length;
  for (const [todo, id, cuerpo] of partes()) {
    if (!esDoble(cuerpo)) continue;
    if (!pareceAcompanamiento(nombreDe(id), cuerpo)) {
      xml = separarPentagramas(xml, id);
      avisos.push(`La parte ${id} tenía dos pentagramas con una línea melódica en cada uno (por ejemplo tenor y bajo escritos juntos): se ha separado en dos voces (${id} y ${id}B).`);
    } else if (simples >= 2) {
      xml = xml.replace(todo, '').replace(new RegExp(`<score-part id="${id}">[\\s\\S]*?</score-part>\\s*`), '');
      avisos.push(`Se ha quitado una parte de dos pentagramas que parecía el acompañamiento de piano (${id}).`);
    } else {
      avisos.push(`La parte ${id} tiene dos pentagramas con acordes (acompañamiento); la app la tratará como una sola voz.`);
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

const { leerPartes, escapar, recorrerCompases, sumaCompas, sospechososDe, detalleCompas, notasCompas, escribirCompas, ponerTiempo, fijarCompas, FIGURA_NEGRAS } = require('../app/compases.js');

function tituloDe(xml) { return (xml.match(/<work-title>([^<]*)/) || [, ''])[1].trim(); }

// Tempo escrito en la partitura (♩ por minuto), o null si no hay
function tempoDe(xml) {
  const s = xml.match(/<sound[^>]*tempo="([\d.]+)"/); if (s) return Math.round(+s[1]);
  const p = xml.match(/<per-minute>([\d.]+)/); if (p) return Math.round(+p[1]);
  return null;
}


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
      if (/<lyric/.test(xml)) log('  el XML ya trae letra (por ejemplo una corrección devuelta): se conserva tal cual');
      else {
        const r = transplantar(xml, audXml);
        xml = r.salida;
        for (const l of r.informe) log('  letra ' + l);
      }
      entrada.paginas = generarPaginas(pdf, dirSalida, base);
      // Dónde está cada compás en la página: mirando la imagen (exacto); si no cuadra con el XML, con la
      // maquetación aproximada de Audiveris
      let pos;
      try { pos = posicionesImagen(xml, entrada.paginas.map(p => path.join(dirSalida, p)), log); log('  Compases localizados en la imagen de cada página.'); }
      catch (e) { log('  ! No se han podido localizar los compases en la imagen (' + e.message + '): se usa la maquetación de Audiveris, menos exacta.'); pos = posiciones(xml, audXml); }
      fs.writeFileSync(path.join(dirSalida, base + '.pos.json'), JSON.stringify(pos));
      entrada.posiciones = base + '.pos.json';
      log(`  Página original incorporada (${entrada.paginas.length} imagen(es)); vista "PDF original" disponible.`);
    } catch (e) { log('  ! No se ha podido sacar la letra del PDF: ' + e.message.split('\n')[0]); }
  } else log('  (sin PDF: la obra irá sin letra y sin vista de página original)');

  fs.writeFileSync(path.join(dirSalida, entrada.archivo), xml);
  return { entrada, avisos, partes: resumenPartes, sospechosos, tempo: tempoDe(xml), pdf };
}

function leerLista() { try { return JSON.parse(fs.readFileSync(LISTA, 'utf8')); } catch { return []; } }
// Todos los archivos de una obra de la lista: partitura, posiciones, páginas y voces cantadas
function archivosDe(o) { return [o.archivo, o.posiciones, ...(o.paginas || []), ...(o.canto || []).flatMap(c => [c.archivo, c.consonantes])].filter(Boolean); }
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
  else if (previa.paginas) { nueva.posiciones = previa.posiciones; nueva.paginas = previa.paginas; } // conserva la página original anterior si esta vez se ha dado el PDF
  // Voces cantadas: las del borrador si las trae (o [] si se han quitado); si no dice nada, se conservan las que ya había
  const copiar = [entrada.archivo, ...(entrada.paginas && entrada.posiciones ? [entrada.posiciones, ...entrada.paginas] : [])];
  if (Array.isArray(entrada.canto)) { if (entrada.canto.length) nueva.canto = entrada.canto; copiar.push(...entrada.canto.flatMap(c => [c.archivo, c.consonantes]).filter(Boolean)); }
  else if (previa.canto && previa.canto.length) nueva.canto = previa.canto;
  for (const f of copiar) {
    const origen = path.join(dirOrigen, f), destino = path.join(DIR_PARTITURAS, f);
    if (path.resolve(origen) !== path.resolve(destino)) fs.copyFileSync(origen, destino);
  }
  // MP3 de voces que ya no forman parte de la obra
  for (const c of previa.canto || []) for (const f of [c.archivo, c.consonantes]) if (f && !(nueva.canto || []).some(x => x.archivo === f || x.consonantes === f)) { try { fs.unlinkSync(path.join(DIR_PARTITURAS, f)); } catch {} }
  guardarLista([...lista.filter(o => o.archivo !== entrada.archivo), nueva]);
  return !!previa.archivo;
}

// Quita una obra de la app (lista y archivos)
function retirarDeApp(archivo) {
  const lista = leerLista();
  const obra = lista.find(o => o.archivo === archivo);
  if (!obra) throw new Error('Esa obra no está en la app: ' + archivo);
  for (const f of archivosDe(obra)) { try { fs.unlinkSync(path.join(DIR_PARTITURAS, f)); } catch {} }
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
  sospechososDe, detalleCompas, fijarCompas, notasCompas, escribirCompas, FIGURA_NEGRAS,
  leerLista, archivosDe, incorporarEnApp, retirarDeApp, subirVersionCache, versionCache, guardarEnGit, guardarPdf,
};
