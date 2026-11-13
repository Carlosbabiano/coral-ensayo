// Todo lo necesario para preparar una obra (MusicXML del Escáner Musical + PDF, o el PDF solo leído con Audiveris),
// retocarla y meterla en la app.
// Lo usan "Añadir obra.cmd" (anadir-obra.js) y el Gestor de obras (gestor.js).
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { execSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
const DIR_APP = path.join(RAIZ, 'app');
const DIR_PARTITURAS = path.join(DIR_APP, 'partituras');
const LISTA = path.join(DIR_PARTITURAS, 'lista.json');
const SW = path.join(DIR_APP, 'sw.js');
const DIR_PDF = path.join(RAIZ, 'originales', 'pdf');
const CACHE_AUDIVERIS = path.join(__dirname, 'cache', 'audiveris');

const { posiciones } = require('./posiciones.js');
const { posicionesImagen } = require('./posiciones-imagen.js');
const { generarPaginas } = require('./paginas.js');
const AUDIVERIS = process.env.AUDIVERIS || 'C:\\Program Files\\Audiveris\\Audiveris.exe'; // AUDIVERIS=ruta si está instalado en otro sitio
const IDIOMA_OCR = process.env.LETRA_IDIOMA || 'spa+lat'; // idiomas para leer la letra (spa, lat, ita, fra, eng); solo los que Audiveris tenga instalados


// Nombre "clave" de un archivo para emparejar XML y PDF: sin extensión, minúsculas, solo letras y números
const clave = f => path.basename(f).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Busca el PDF que corresponde a un XML: entre los dados, junto al XML o en la carpeta originales/pdf/
function pdfPara(xml, pdfs = []) {
  const k = clave(xml);
  const dado = pdfs.find(p => clave(p) === k); if (dado) return dado;
  for (const dir of [path.dirname(xml), DIR_PDF]) {
    try { const f = fs.readdirSync(dir).find(n => /\.pdf$/i.test(n) && clave(n) === k); if (f) return path.join(dir, f); } catch {}
  }
  return null;
}


// ---------- Audiveris: las notas a partir del PDF ----------
// Si la obra llega sin el XML del Escáner Musical, las notas (y la letra) las lee Audiveris del PDF.
const hayAudiveris = () => fs.existsSync(AUDIVERIS);
const SIN_AUDIVERIS = 'Audiveris no está instalado en este PC, y sin él no se pueden sacar las notas del PDF solo. Instálalo desde https://audiveris.github.io/audiveris/ (en C:\\Program Files\\Audiveris) o añade el .xml del Escáner Musical junto al PDF.';
function comprobarAudiveris() { if (!hayAudiveris()) throw new Error(SIN_AUDIVERIS); }

// Pasa el PDF por Audiveris (notas + letra + maquetación) y devuelve { xml, segundos, cache } con su MusicXML sin comprimir.
// El resultado se guarda en herramientas/cache/audiveris/ para no repetir la lectura (tarda minutos) con el mismo PDF.
function leerConAudiveris(pdf, log = console.log) {
  const buf = fs.readFileSync(pdf);
  const huella = crypto.createHash('sha1').update(buf).update(IDIOMA_OCR).digest('hex');
  const enCache = path.join(CACHE_AUDIVERIS, huella + '.xml');
  if (fs.existsSync(enCache)) { log('  Lectura del PDF recuperada de la caché (ya se leyó antes con Audiveris).'); return { xml: fs.readFileSync(enCache, 'utf8'), segundos: 0, cache: true }; }
  comprobarAudiveris();
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'audiveris-'));
  log('  Leyendo el PDF con Audiveris (suele tardar uno o dos minutos por página)...');
  const inicio = Date.now();
  try { execSync(`"${AUDIVERIS}" -batch -export -constant org.audiveris.omr.text.Language.defaultSpecification=${IDIOMA_OCR} -output "${tmp}" -- "${path.resolve(pdf)}"`, { stdio: 'ignore', timeout: 15 * 60 * 1000 }); }
  catch (e) { throw new Error('Audiveris no ha podido leer el PDF' + motivoAudiveris(tmp) + '. Prueba a pasar la obra por el Escáner Musical y a añadir su .xml junto al PDF.'); }
  // Audiveris deja la exportación en una subcarpeta con el nombre de la obra: .mxl (MusicXML comprimido) o .xml según la versión y la configuración
  const buscar = (d, re) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { const r = buscar(p, re); if (r) return r; } else if (re.test(f) && f !== 'container.xml') return p; } return null; };
  let xmlPath = buscar(tmp, /\.(xml|musicxml)$/i);
  const mxl = buscar(tmp, /\.mxl$/i);
  if (!xmlPath && mxl) {
    const zip = path.join(tmp, 'salida.zip'); fs.copyFileSync(mxl, zip);
    execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zip}' -DestinationPath '${path.join(tmp, 'x')}' -Force"`, { stdio: 'ignore' });
    xmlPath = buscar(path.join(tmp, 'x'), /\.(xml|musicxml)$/i);
  }
  if (!xmlPath) throw new Error('Audiveris ha terminado sin generar la partitura' + motivoAudiveris(tmp) + '. Prueba a pasar la obra por el Escáner Musical y a añadir su .xml junto al PDF.');
  const xml = fs.readFileSync(xmlPath, 'utf8');
  if (!/<score-partwise/.test(xml)) throw new Error('Lo que ha generado Audiveris no es un MusicXML válido. Prueba con el .xml del Escáner Musical.');
  try { fs.mkdirSync(CACHE_AUDIVERIS, { recursive: true }); fs.writeFileSync(enCache, xml); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  return { xml, segundos: Math.round((Date.now() - inicio) / 1000), cache: false };
}

// Causa del fallo de Audiveris, leída de su registro (.log) en la carpeta de salida; por ejemplo
// «Too large image: 21.000.000 pixels (vs 20.000.000 max)» cuando las páginas del PDF son demasiado grandes.
function motivoAudiveris(dir) {
  try {
    const buscarLog = d => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { const r = buscarLog(p); if (r) return r; } else if (/\.log$/i.test(f)) return p; } return null; };
    const log = buscarLog(dir); if (!log) return '';
    const lineas = fs.readFileSync(log, 'utf8').split(/\r?\n/);
    const inofensivo = /Language '[^']*' is not supported|Missing support for .* language|No target duration|StackRhythm error|please check time signatures/;
    const interno = lineas.find(l => /\bWARN\b/.test(l) && /Error processing stub/.test(l));
    if (interno) {
      const pagina = (interno.match(/\[[^\]#]*#(\d+)\]/) || [])[1];
      return ` (fallo interno de Audiveris${pagina ? ' en la página ' + pagina : ''}: no consigue entender los compases de esa página, suele pasar con escaneos torcidos o muy apretados)`;
    }
    const aviso = lineas.find(l => /\b(ERROR)\b/.test(l) && /\| /.test(l) && !inofensivo.test(l)) || lineas.find(l => /\b(WARN)\b/.test(l) && /\| /.test(l) && !inofensivo.test(l));
    if (!aviso) return '';
    let motivo = aviso.replace(/^.*\| /, '').trim();
    // Los fallos más corrientes, en castellano; los demás, tal como los cuenta Audiveris
    if (/Too large image/i.test(motivo)) motivo += '; las páginas del PDF tienen más píxeles de los que admite Audiveris';
    else if (/Error opening pdf|Could not load|Cannot (read|load)/i.test(motivo)) motivo = 'no ha podido abrir el PDF: puede estar dañado o protegido';
    else if (/No staff|no staves|No system/i.test(motivo)) motivo = 'no ha encontrado pentagramas en la página: puede que la imagen esté torcida o sea muy borrosa';
    return ' (' + motivo + ')';
  } catch { return ''; }
}


// Deja el MusicXML de Audiveris como el del Escáner Musical, con lo que la app necesita y nada más:
//  - fuera la maquetación de la página (<defaults>, <print>, anchos y posiciones), los textos sueltos (<credit>) y las
//    rutas del PC (<source>, <miscellaneous>); el título pasa a <work-title> (el texto más grande de la primera página);
//  - la letra se conserva (la app la usa para cantar y el gestor para corregirla), pero se quitan las «sílabas» que son
//    matices leídos como letra (p, mf…), se arreglan los errores típicos del OCR y los versos se numeran desde 1;
//  - si no ha leído ninguna indicación de compás (pasa con el compás partido), se deduce de lo que suman los compases.
// Devuelve { xml, avisos }.
function limpiarXmlAudiveris(xml) {
  const avisos = [];
  const letras = s => (s.match(/\p{L}/gu) || []).length;
  // Título: el texto más grande de los <credit> de la primera página; si no, el movement-title / work-title
  const creditos = [...xml.matchAll(/<credit(?:\s[^>]*)?>([\s\S]*?)<\/credit>/g)].filter(c => !/page="[2-9]/.test(c[0]))
    .map(c => ({ texto: (c[1].match(/<credit-words[^>]*>([^<]*)/) || [, ''])[1].trim(), tamano: +((c[1].match(/font-size="([\d.]+)"/) || [, 0])[1]), tipo: (c[1].match(/<credit-type>([^<]*)/) || [, ''])[1] }))
    .filter(c => letras(c.texto) >= 3 && c.tipo !== 'composer').sort((a, b) => b.tamano - a.tamano);
  let titulo = creditos.length ? creditos[0].texto : (xml.match(/<(?:movement|work)-title>([^<]*)/) || [, ''])[1].trim();
  titulo = titulo.replace(/\s+/g, ' ');
  if (titulo && titulo === titulo.toUpperCase() && letras(titulo) >= 3) titulo = titulo.charAt(0) + titulo.slice(1).toLowerCase(); // TÍTULO EN MAYÚSCULAS → Título en mayúsculas
  xml = xml.replace(/\s*<work>[\s\S]*?<\/work>/, '').replace(/\s*<movement-title>[^<]*<\/movement-title>/, '').replace(/\s*<movement-number>[^<]*<\/movement-number>/, '');
  if (titulo) xml = xml.replace(/<score-partwise[^>]*>/, m => `${m}\n\t<work>\n\t\t<work-title>${escapar(titulo)}</work-title>\n\t</work>`);
  // Autores que son restos del OCR («FIN», signos…): fuera
  xml = xml.replace(/\s*<creator[^>]*>([^<]*)<\/creator>/g, (m, t) => letras(t) >= 4 ? m : '');
  // Maquetación y rutas
  xml = xml.replace(/\s*<defaults>[\s\S]*?<\/defaults>/, '').replace(/\s*<credit(?:\s[^>]*)?>[\s\S]*?<\/credit>/g, '')
    .replace(/\s*<source>[^<]*<\/source>/, '').replace(/\s*<miscellaneous>[\s\S]*?<\/miscellaneous>/, '')
    .replace(/\s*<print(?:\s[^>]*)?>[\s\S]*?<\/print>/g, '').replace(/\s*<print(?:\s[^>]*)?\/>/g, '')
    .replace(/(<measure number="[^"]+")\s+width="[^"]*"/g, '$1')
    .replace(/\s+(?:default|relative)-[xy]="[^"]*"/g, '')
    .replace(/\s*<staff-details[^>]*>\s*<\/staff-details>/g, '').replace(/\s*<part-abbreviation>[^<]*<\/part-abbreviation>/g, '')
    .replace(/\s*<!--[= ]+-->/g, '');
  // Letra: fuera los matices leídos como sílabas, arreglos del OCR y versos numerados desde 1 en cada nota
  const { BASURA, ARREGLOS } = require('./letra.js');
  let matices = 0;
  xml = xml.replace(/<note(?:\s[^>]*)?>[\s\S]*?<\/note>/g, nota => {
    let k = 0;
    return nota.replace(/\s*<lyric\b([^>]*)>([\s\S]*?)<\/lyric>/g, (m, attrs, cuerpo) => {
      let texto = (cuerpo.match(/<text>([^<]*)<\/text>/) || [, ''])[1].trim();
      if (!texto || BASURA.test(texto)) { matices++; return ''; }
      texto = texto.replace(/[’‘´`]/g, "'"); // los arreglos esperan el apóstrofo recto (m'enamoran)
      for (const [re, por] of ARREGLOS) texto = texto.replace(re, por);
      k++;
      return m.replace(attrs, attrs.replace(/\s*number="[^"]*"/, '') + ` number="${k}"`).replace(/<text>[^<]*<\/text>/, `<text>${texto}</text>`);
    });
  });
  if (matices) avisos.push(`Audiveris había leído ${matices} matiz(es) o signo(s) como sílabas de la letra: se han quitado.`);
  // Sin indicación de compás en toda la obra: se deduce de lo que suman los compases de la primera voz
  if (!/<time\b/.test(xml)) {
    const parte = (xml.match(/<part id="[^"]+">([\s\S]*?)<\/part>/) || ['', ''])[1];
    let div = 1; const hist = {};
    for (const [, m] of parte.matchAll(/<measure number="[^"]+"[^>]*>([\s\S]*?)<\/measure>/g)) {
      const d = m.match(/<divisions>(\d+)/); if (d) div = +d[1];
      let s = 0; for (const [n] of m.matchAll(/<note(?:\s[^>]*)?>[\s\S]*?<\/note>/g)) if (!/<chord|<grace|<voice>[2-9]/.test(n)) s += +(n.match(/<duration>(\d+)/) || [, 0])[1];
      const q = (s / div).toFixed(2); hist[q] = (hist[q] || 0) + 1;
    }
    const negras = +(Object.entries(hist).sort((a, b) => b[1] - a[1])[0] || [0])[0];
    const tiempo = negras > 0 && Number.isInteger(negras) ? [negras, 4] : Number.isInteger(negras * 2) ? [negras * 2, 8] : null;
    if (tiempo) {
      const t = `<time>\n\t\t\t\t\t<beats>${tiempo[0]}</beats>\n\t\t\t\t\t<beat-type>${tiempo[1]}</beat-type>\n\t\t\t\t</time>`;
      xml = xml.replace(/<part id="[^"]+">[\s\S]*?<\/part>/g, p => p.replace(/<measure number="[^"]+"[^>]*>[\s\S]*?<\/measure>/, m => {
        if (/<attributes>/.test(m)) return m.replace(/(<attributes>[\s\S]*?)(<clef|<staff-details|<staves|<transpose|<\/attributes>)/, (a, b, c) => b + t + '\n\t\t\t\t' + c);
        return m.replace(/(<measure number="[^"]+"[^>]*>)/, `$1\n\t\t\t<attributes>\n\t\t\t\t${t}\n\t\t\t</attributes>`);
      }));
      avisos.push(`Audiveris no ha leído la indicación de compás (pasa con el compás partido): se ha puesto ${tiempo[0]}/${tiempo[1]}, que es lo que suman los compases. Compruébalo en la página.`);
    } else avisos.push('Audiveris no ha leído ninguna indicación de compás y no se ha podido deducir: la app supondrá 4/4.');
  }
  // Una parte por rótulo (Soprano… en el primer sistema, S.… en el resto) y tresillos sin el «3»: app/preparar-obra.js
  xml = juntarPartesPorRotulo(xml, avisos);
  xml = ponerTresillosNoLeidos(xml, avisos);
  xml = bajarTenorOctavado(xml, avisos);
  // Audiveris inventa a veces una segunda voz hecha solo de silencios: fuera. Si lleva alguna nota suelta se deja,
  // con aviso, para que el director decida (en «Voces» del gestor se puede quitar)
  const vacias = [], casiVacias = [];
  for (const v of vocesDe(xml)) {
    if (v.voz < 2) continue;
    if (!v.notas) { xml = quitarVoz(xml, v.id, v.voz); vacias.push(`${v.nombre || v.id} (voz ${v.voz}, ${v.silencios} silencios)`); }
    else if (v.notas <= 3) casiVacias.push(`${v.nombre || v.id} (voz ${v.voz}: ${v.notas} nota${v.notas === 1 ? '' : 's'} y ${v.silencios} silencios en ${v.compases} compases)`);
  }
  if (vacias.length) avisos.push(`Audiveris había puesto una segunda voz hecha solo de silencios en ${vacias.join(', ')}: se ha quitado.`);
  if (casiVacias.length) avisos.push(`Audiveris ha puesto una segunda voz casi vacía en ${casiVacias.join(', ')}. Si en la partitura no existe, quítala en «Voces».`);
  return { xml, avisos };
}


const { leerPartes, escapar, recorrerCompases, sumaCompas, sospechososDe, detalleCompas, notasCompas, escribirCompas, ponerTiempo, fijarCompas, FIGURA_NEGRAS, vocesDe, quitarVoz } = require('../app/compases.js');
// Reparación del XML, nombres de las voces, etc.: compartido con el gestor del móvil
const { NOMBRES_VOCES, NOMBRES_CONOCIDOS, SEMITONOS, NOTAS, analizarParte, nombresPorTesitura, huecosASilencios, recomponerPartesCorridas, repararCompases, nombreCanonico,
  bajarTenorOctavado, limpiarNombreArchivo, tituloDe, tempoDe, vocesExtraDe, editarObra, compasesDe, posicionesManualesValidas, prepararXml, juntarPartesPorRotulo, ponerTresillosNoLeidos } = require('../app/preparar-obra.js');


// Prepara una obra: repara el XML, nombra las voces, saca letra y página original del PDF y deja los archivos en dirSalida.
// Devuelve { entrada, avisos, partes, sospechosos, tempo }. Lanza un error con mensaje claro si el XML no vale.
// Posiciones (pos.json) de la obra publicada con ese nombre, solo si están corregidas a mano
function leerPosicionesPublicadas(base) {
  try { const p = JSON.parse(fs.readFileSync(path.join(DIR_PARTITURAS, base + '.pos.json'), 'utf8')); return p && p.manual ? p : null; } catch { return null; }
}
// ¿El pos.json tiene de verdad los compases colocados? (uno vacío o incompleto no sirve para la app)
function posicionesCompletas(ruta) {
  try { const p = JSON.parse(fs.readFileSync(ruta, 'utf8')); return !p.incompleto && Array.isArray(p.compases) && p.compases.length > 0; } catch { return false; }
}

// La obra puede llegar con el XML del Escáner Musical (y el PDF), o con el PDF solo: entonces las notas las lee Audiveris
// y el resultado trae audiveris: { segundos, cache }. O con el XML ya leído por la IA (lectura-ia.js) en xmlTexto, con las
// imágenes de página (paginasDadas, rutas) y las posiciones de los compases (posicionesDadas) que salieron de esa lectura;
// lecturaIA es su resumen (modelo, coste…) y se devuelve tal cual.
function prepararObra({ xml: rutaXml = null, xmlTexto = null, pdf: rutaPdf = null, dirSalida, posicionesManuales = null, posicionesDadas = null, paginasDadas = null, lecturaIA = null, log = console.log }) {
  let xml, xmlAudiveris = null, audiveris = null;
  const avisos = [];
  if (xmlTexto) {
    xml = xmlTexto;
    if (!/<score-partwise/.test(xml)) throw new Error('Lo que ha leído la IA no es un MusicXML válido.');
    if (lecturaIA && Array.isArray(lecturaIA.avisos)) avisos.push(...lecturaIA.avisos);
  } else if (rutaXml) {
    if (!fs.existsSync(rutaXml)) throw new Error('No existe el archivo ' + rutaXml);
    if (/\.mxl$/i.test(rutaXml)) throw new Error('Es un .mxl (comprimido). Exporta como .xml / .musicxml sin comprimir.');
    xml = fs.readFileSync(rutaXml, 'utf8');
    if (!/<score-partwise/.test(xml)) throw new Error('No parece un archivo MusicXML.');
  } else {
    if (!rutaPdf) throw new Error('Hace falta el PDF de la obra o el .xml del Escáner Musical.');
    if (!fs.existsSync(rutaPdf)) throw new Error('No existe el archivo ' + rutaPdf);
    comprobarAudiveris();
    log('  Sin XML del escáner: las notas las lee Audiveris del PDF.');
    const lectura = leerConAudiveris(rutaPdf, log);
    xmlAudiveris = lectura.xml;
    audiveris = { segundos: lectura.segundos, cache: lectura.cache };
    if (!lectura.cache) log(`  Audiveris ha leído el PDF en ${lectura.segundos < 60 ? lectura.segundos + ' s' : Math.floor(lectura.segundos / 60) + ' min ' + (lectura.segundos % 60) + ' s'}.`);
    const limpio = limpiarXmlAudiveris(xmlAudiveris);
    xml = limpio.xml; avisos.push(...limpio.avisos);
  }

  let titulo, resumenPartes, sospechosos;
  ({ xml, titulo, partes: resumenPartes, sospechosos } = prepararXml(xml, { nombreArchivo: rutaXml || rutaPdf, delEscaner: !xmlTexto && !!rutaXml, avisos, log }));

  // Letra y página original a partir del PDF (Audiveris)
  const base = limpiarNombreArchivo(titulo);
  const entrada = { titulo, archivo: base + '.xml' };
  fs.mkdirSync(dirSalida, { recursive: true });
  const pdf = rutaPdf || pdfPara(rutaXml);
  if (pdf) {
    // Página original: imágenes de las páginas y dónde está cada compás, mirando la imagen. Es lo que ve el coro.
    // La letra no se saca del PDF: el coro la lee en la página. Audiveris (lento, y a veces falla) solo se usa como
    // último recurso para situar los compases si la imagen no se deja leer.
    try {
      // Las imágenes de página ya hechas (la lectura con IA las necesitó antes) se copian; si no, se generan del PDF
      if (paginasDadas && paginasDadas.length && paginasDadas.every(r => fs.existsSync(r))) {
        for (const f of fs.readdirSync(dirSalida)) if (f.startsWith(base + '-p') && /\.(png|jpg)$/.test(f)) fs.unlinkSync(path.join(dirSalida, f));
        entrada.paginas = paginasDadas.map((ruta, i) => { const n = `${base}-p${i + 1}${path.extname(ruta).toLowerCase()}`; fs.copyFileSync(ruta, path.join(dirSalida, n)); return n; });
      } else entrada.paginas = generarPaginas(pdf, dirSalida, base);
      const nCompases = compasesDe(xml).length;
      // Posiciones corregidas a mano en el gestor (las del propio borrador al volver a prepararlo, o las de la obra ya
      // publicada con el mismo nombre): se conservan mientras cuadren con la obra, en vez de volver a pasar el detector
      let pos = posicionesManualesValidas([posicionesManuales, leerPosicionesPublicadas(base)], entrada.paginas.length, nCompases, log);
      if (pos) log('  Compases en la página: se conservan las posiciones corregidas a mano (no se vuelven a detectar).');
      else if (posicionesDadas && Array.isArray(posicionesDadas.compases) && posicionesDadas.compases.length === nCompases && posicionesDadas.paginas === entrada.paginas.length) {
        pos = posicionesDadas; log('  Compases en la página: los que localizó la lectura con IA (no se vuelven a detectar).');
      } else {
        if (posicionesDadas) log('  ! Las posiciones de la lectura con IA no cuadran con la obra: se vuelven a detectar.');
        try { pos = posicionesImagen(xml, entrada.paginas.map(p => path.join(dirSalida, p)), log); log('  Compases localizados en la imagen de cada página.'); }
        catch (e) {
          log('  ! No se han podido localizar los compases en la imagen (' + e.message + '): se intenta con la maquetación de Audiveris, menos exacta.');
          let audXml = xmlAudiveris; // si las notas ya salieron de Audiveris, su maquetación está a mano
          if (!audXml) { try { audXml = leerConAudiveris(pdf, log).xml; } catch (e2) { log('  ! ' + e2.message.split('\n')[0]); throw e; } }
          pos = posiciones(xml, audXml);
        }
      }
      fs.writeFileSync(path.join(dirSalida, base + '.pos.json'), JSON.stringify(pos));
      entrada.posiciones = base + '.pos.json';
      log(`  Página original incorporada (${entrada.paginas.length} imagen(es)); vista "PDF original" disponible.`);
    } catch (e) {
      if (entrada.paginas && entrada.paginas.length) {
        // Las páginas sí están: se guardan con unas posiciones vacías para colocar los compases a mano en el gestor
        // («Revisar compases en la página»). Hasta entonces la obra se publicaría sin página original.
        fs.writeFileSync(path.join(dirSalida, base + '.pos.json'), JSON.stringify({ paginas: entrada.paginas.length, compases: [], incompleto: true }));
        entrada.posiciones = base + '.pos.json';
        log('  ! No se han podido localizar los compases en la página (' + e.message.split('\n')[0] + '). Colócalos a mano en el gestor con «Revisar compases en la página»; hasta entonces la obra iría sin página original.');
      } else { delete entrada.paginas; delete entrada.posiciones; log('  ! No se ha podido incorporar la página original: ' + e.message.split('\n')[0]); }
    }
  } else log('  (sin PDF: la obra irá sin vista de página original)');

  fs.writeFileSync(path.join(dirSalida, entrada.archivo), xml);
  return { entrada, avisos, partes: resumenPartes, sospechosos, tempo: tempoDe(xml), pdf, audiveris, lecturaIA: lecturaIA ? { ...lecturaIA, avisos: undefined } : null };
}

function leerLista() { try { return JSON.parse(fs.readFileSync(LISTA, 'utf8')); } catch { return []; } }
// Todos los archivos de una obra de la lista: partitura, posiciones, páginas y voces cantadas
// Una obra «sin voces» (subida desde el móvil con solo el PDF) tiene páginas pero todavía no XML
function archivosDe(o) { return [o.sinVoces ? null : o.archivo, o.posiciones, ...(o.paginas || []), ...(o.canto || []).flatMap(c => [c.archivo, c.consonantes])].filter(Boolean); }
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
  // Marca «en ensayo»: la del borrador si dice algo; si no, se conserva la que tenía la obra publicada
  if (entrada.ensayo !== undefined ? entrada.ensayo : previa.ensayo) nueva.ensayo = true;
  // Página original: solo si las posiciones de los compases están de verdad (un pos.json vacío, pendiente de colocar a mano, no vale)
  const conPagina = !!(entrada.paginas && entrada.paginas.length && entrada.posiciones && posicionesCompletas(path.join(dirOrigen, entrada.posiciones)));
  if (conPagina) { nueva.posiciones = entrada.posiciones; nueva.paginas = entrada.paginas; }
  else if (previa.paginas) { nueva.posiciones = previa.posiciones; nueva.paginas = previa.paginas; } // conserva la página original anterior si esta vez se ha dado el PDF
  // Voces cantadas: las del borrador si las trae (o [] si se han quitado); si no dice nada, se conservan las que ya había
  const copiar = [entrada.archivo, ...(conPagina ? [entrada.posiciones, ...entrada.paginas] : [])];
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

// Marca o desmarca una obra publicada como «en ensayo» (en la app sale la primera, en su propio grupo)
function marcarEnsayo(archivo, ensayo) {
  const lista = leerLista();
  const o = lista.find(x => x.archivo === archivo);
  if (!o) throw new Error('Esa obra no está en la app: ' + archivo);
  if (ensayo) o.ensayo = true; else delete o.ensayo;
  guardarLista(lista);
  return o;
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
  escribirHuellas();
  return version;
}

// partituras/huellas.json: qué archivos tiene cada obra y una huella de su contenido. El service worker la usa para
// bajar a las tablets solo lo que ha cambiado, sin borrar lo que ya tenían (las páginas actualizadas se llaman igual)
function escribirHuellas() {
  const huella = f => { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 12); } catch { return null; } };
  const obras = leerLista().map(o => ({ titulo: o.titulo, archivos: Object.fromEntries(archivosDe(o).map(a => ['partituras/' + a, huella(path.join(DIR_PARTITURAS, a))]).filter(([, h]) => h)) }));
  const comunes = {};
  const DIR_VOCES = path.join(DIR_APP, 'voces');
  const recorrer = d => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const f = path.join(d, e.name); if (e.isDirectory()) recorrer(f); else comunes[path.relative(DIR_APP, f).split(path.sep).join('/')] = huella(f); } };
  recorrer(DIR_VOCES);
  fs.writeFileSync(path.join(DIR_PARTITURAS, 'huellas.json'), JSON.stringify({ obras, comunes }) + '\n');
}
function versionCache() { return (fs.readFileSync(SW, 'utf8').match(/coral-v\d+/) || ['?'])[0]; }

// Guarda los cambios de app/ en git, si hay repositorio. Devuelve true si se ha hecho un commit.
function guardarEnGit(mensaje) {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: RAIZ, stdio: 'ignore' });
    execSync('git add -A app originales', { cwd: RAIZ, stdio: 'ignore' });
    execSync(`git -c user.name="Coral" -c user.email="ipadbabiano@gmail.com" commit -q -m "${mensaje.replace(/"/g, "'")}"`, { cwd: RAIZ, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// Guarda una copia del PDF en originales/pdf/ (para poder regenerar la obra en el futuro)
function guardarPdf(rutaPdf, base) {
  if (!rutaPdf || !fs.existsSync(rutaPdf)) return null;
  fs.mkdirSync(DIR_PDF, { recursive: true });
  const destino = path.join(DIR_PDF, base + '.pdf');
  if (path.resolve(rutaPdf) !== path.resolve(destino)) fs.copyFileSync(rutaPdf, destino);
  return destino;
}

module.exports = { bajarTenorOctavado,
  RAIZ, DIR_APP, DIR_PARTITURAS, DIR_PDF, LISTA, NOMBRES_VOCES,
  clave, pdfPara, prepararObra, editarObra, huecosASilencios, leerPartes, tituloDe, tempoDe, limpiarNombreArchivo, vocesExtraDe,
  hayAudiveris, comprobarAudiveris, leerConAudiveris, limpiarXmlAudiveris, nombreCanonico,
  sospechososDe, detalleCompas, fijarCompas, notasCompas, escribirCompas, FIGURA_NEGRAS, repararCompases, recomponerPartesCorridas, compasesDe, posicionesCompletas,
  leerLista, archivosDe, incorporarEnApp, retirarDeApp, marcarEnsayo, subirVersionCache, escribirHuellas, versionCache, guardarEnGit, guardarPdf,
};
