// Todo lo necesario para preparar una obra (MusicXML del Escáner Musical + PDF), retocarla y meterla en la app.
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
const AUDIVERIS = 'C:\\Program Files\\Audiveris\\Audiveris.exe';
const IDIOMA_OCR = process.env.LETRA_IDIOMA || 'spa+eng'; // idiomas para leer la letra (spa, ita, fra, lat, eng)

const NOMBRES_VOCES = ['Soprano', 'Mezzosoprano', 'Contralto', 'Tenor', 'Barítono', 'Bajo', 'Solista femenina', 'Solista masculino', 'Voz', 'Piano'];
const NOMBRES_CONOCIDOS = /solista|soprano|alto|contralto|tenor|bajo|bass|mezzo|bar[ií]tono|voz\s*\d|piano|órgano|organo/i;
const SEMITONOS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NOTAS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

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

// Silencios normales (redonda, blanca, negra…) que suman una duración dada, en XML
// Pentagrama de una parte doble que no tiene ni una nota (solo silencios): 1, 2 o null si los dos suenan
function pentagramaVacio(cuerpo) {
  const notas = { 1: 0, 2: 0 };
  for (const [n] of cuerpo.matchAll(/<note(?:\s[^>]*)?>[\s\S]*?<\/note>/g)) if (/<pitch>/.test(n)) notas[+((n.match(/<staff>(\d+)/) || [, 1])[1])]++;
  return notas[1] && !notas[2] ? 2 : notas[2] && !notas[1] ? 1 : null;
}
// Deja una parte doble con solo el pentagrama que suena (el otro, vacío, se quita); la parte conserva su id
function quitarPentagramaVacio(xml, id, vacio) {
  xml = separarPentagramas(xml, id);
  const id2 = id + 'B';
  const sobra = vacio === 2 ? id2 : id;
  xml = xml.replace(new RegExp(`<part id="${sobra}">[\\s\\S]*?</part>\\s*`), '').replace(new RegExp(`<score-part id="${sobra}">[\\s\\S]*?</score-part>\\s*`), '');
  if (vacio === 1) xml = xml.replace(new RegExp(`id="${id2}(-[^"]*)?"`, 'g'), (m, suf) => `id="${id}${suf || ''}"`);
  return xml;
}

function silenciosDe(dur, div, voz, staff) {
  const figuras = [[4, 'whole'], [2, 'half'], [1, 'quarter'], [0.5, 'eighth'], [0.25, '16th'], [0.125, '32nd']];
  let resto = dur, out = '';
  const nota = (d, tipo) => `<note><rest/><duration>${d}</duration><voice>${voz}</voice>${tipo ? '<type>' + tipo + '</type>' : ''}${staff ? '<staff>' + staff + '</staff>' : ''}</note>`;
  for (const [negras, tipo] of figuras) { const d = Math.round(negras * div); if (d < 1) break; while (resto >= d) { out += nota(d, tipo); resto -= d; } }
  if (resto > 0) out += nota(resto, '');
  return out;
}

// El escáner deja huecos <forward> (un trozo del compás sin nada) donde no ha leído notas. En una voz del coro eso
// es un silencio: se escribe como tal, para que se vea, cuadre el compás y el editor del gestor lo tenga en cuenta
// (si no, al añadir un silencio a mano las notas se desplazan). Si las notas de esa voz ya llenan el compás, el
// hueco sobra y se quita.
function huecosASilencios(xml) {
  return xml.replace(/<part id="[^"]+">[\s\S]*?<\/part>/g, parte => {
    let div = 1, beats = 4, bt = 4;
    return parte.replace(/(<measure number="[^"]+"[^>]*>)([\s\S]*?)(<\/measure>)/g, (m, ini, c, fin) => {
      const d = c.match(/<divisions>(\d+)/); if (d) div = +d[1];
      const b = c.match(/<beats>(\d+)<\/beats>\s*<beat-type>(\d+)/); if (b) { beats = +b[1]; bt = +b[2]; }
      if (!/<forward>/.test(c)) return m;
      const esperado = Math.round(div * 4 * beats / bt);
      const sumas = {};
      for (const [n] of c.matchAll(/<note(?:\s[^>]*)?>[\s\S]*?<\/note>/g)) {
        if (/<chord/.test(n) || /<grace\b/.test(n)) continue;
        const v = (n.match(/<voice>(\d+)/) || [, '1'])[1]; sumas[v] = (sumas[v] || 0) + +(n.match(/<duration>(\d+)/) || [, 0])[1];
      }
      const nuevo = c.replace(/<forward>\s*<duration>(\d+)<\/duration>\s*(?:<voice>(\d+)<\/voice>\s*)?(?:<staff>(\d+)<\/staff>\s*)?<\/forward>/g, (f, dur, voz, staff, offset) => {
        // la voz del hueco: la que diga; si no, la de la siguiente nota del compás (o la anterior)
        const sig = c.slice(offset + f.length).match(/<note(?:\s[^>]*)?>[\s\S]*?<voice>(\d+)/);
        const ant = c.slice(0, offset).match(/[\s\S]*<voice>(\d+)/);
        const v = voz || (sig ? sig[1] : ant ? ant[1] : '1');
        if ((sumas[v] || 0) >= esperado) return '';
        sumas[v] = (sumas[v] || 0) + +dur;
        return silenciosDe(+dur, div, v, staff);
      });
      return ini + nuevo + fin;
    });
  });
}

// ---------- Partes corridas por el escáner ----------
// Cuando a mitad de obra el sistema gana un pentagrama (entra un solista encima del coro) o lo pierde, el escáner
// reparte los pentagramas por su posición, así que desde ese compás cada parte pasa a llevar la música de la de
// encima (o de la de debajo). Se nota en que varias partes cambian de clave a la vez y cada una toma justo la clave
// (y la tesitura) de su vecina, y en que la última parte está vacía a un lado del corte. Aquí se detecta y se
// recompone cada voz real empalmando sus tramos; donde una voz aún no existe (o ya ha acabado) van silencios.
function recomponerPartesCorridas(xml, avisos) {
  const RE_M = /<measure number="([^"]+)"([^>]*)>([\s\S]*?)<\/measure>/g;
  const partes = [...xml.matchAll(/<part id="([^"]+)">([\s\S]*?)<\/part>/g)].map(m => ({ id: m[1], compases: [...m[2].matchAll(RE_M)].map(c => ({ num: c[1], attrs: c[2], cuerpo: c[3] })) }));
  const k = partes.length, total = partes[0] && partes[0].compases.length;
  if (k < 3 || !total || partes.some(p => p.compases.length !== total)) return xml;
  const normal = c => c.replace(/\s+/g, '');
  // Por parte y compás: clave en vigor (texto normalizado y el elemento tal cual), si trae cambio de clave, notas y altura media
  const info = partes.map(p => {
    let clave = '', bruto = ''; const filas = [];
    p.compases.forEach(c => {
      const m = c.cuerpo.match(/<clef(?:\s[^>]*)?>([\s\S]*?)<\/clef>/);
      const cambia = !!(m && normal(m[1]) !== clave);
      if (m) { clave = normal(m[1]); bruto = m[0]; }
      let n = 0, suma = 0, primera = null, ultima = null;
      for (const [nota] of c.cuerpo.matchAll(/<note(?:\s[^>]*)?>[\s\S]*?<\/note>/g)) {
        const t = nota.match(/<step>(\w)<\/step>\s*(?:<alter>(-?\d+)<\/alter>)?\s*<octave>(\d)/);
        if (t && !/<rest/.test(nota)) { const midi = 12 * (+t[3] + 1) + SEMITONOS[t[1]] + (+(t[2] || 0)); n++; suma += midi; if (primera == null) primera = midi; ultima = midi; }
      }
      filas.push({ clave, bruto, cambia, n, suma, primera, ultima });
    });
    return filas;
  });
  const vacia = (p, a, b) => info[p].slice(a, b).every(f => !f.n); // sin notas en [a, b)
  const media = (p, a, b) => { let n = 0, s = 0; for (const f of info[p].slice(a, b)) { n += f.n; s += f.suma; } return n ? s / n : null; };
  const cl = (p, i) => info[p][i].clave;
  // Última nota de la parte p antes del compás i y primera desde i (mirando hasta cuatro compases), para medir el salto
  const ultimaAntes = (p, i) => { for (let j = i - 1; j >= Math.max(0, i - 4); j--) if (info[p][j].ultima != null) return info[p][j].ultima; return null; };
  const primeraDesde = (p, i) => { for (let j = i; j < Math.min(total, i + 4); j++) if (info[p][j].primera != null) return info[p][j].primera; return null; };

  // Pistas reales (voces), en orden vertical. Cada una: tramos [{ desde, xml }] (xml = índice de parte del escáner, o null).
  // "activas" son las que suenan en el tramo actual: la de la posición r lee la parte r del escáner.
  const todas = Array.from({ length: k }, (_, r) => ({ id: partes[r].id, tramos: [{ desde: 0, xml: r }] }));
  const activas = todas.slice(); const cortes = [];
  for (let i = 1; i < total; i++) {
    if (info.filter(f => f[i].cambia).length < 2) continue;
    // Partes del final que todavía no han sonado no cuentan como activas (son el hueco que deja el corrimiento)
    while (activas.length > 1) {
      const u = activas[activas.length - 1];
      if (!(u.tramos.length === 1 && u.tramos[0].desde === 0 && vacia(activas.length - 1, 0, i))) break;
      activas.pop(); todas.splice(todas.indexOf(u), 1);
    }
    const n = activas.length, candidatos = [];
    // Hipótesis "baja": entra un pentagrama en la posición q; las partes de debajo toman la música de la de encima
    if (n < k && vacia(n, 0, i)) {
      for (let q = 0; q < n; q++) {
        if (n - q < 2) continue;
        let bien = true;
        for (let p = 0; p < q && bien; p++) bien = cl(p, i) === cl(p, i - 1);
        for (let p = q + 1; p <= n && bien; p++) bien = cl(p, i) === cl(p - 1, i - 1);
        if (bien) candidatos.push({ tipo: 'baja', q });
      }
    }
    // Hipótesis "sube": desaparece el pentagrama q; las partes de debajo suben una posición
    if (n >= 3 && vacia(n - 1, i, total)) {
      for (let q = 0; q < n - 1; q++) {
        if (n - 1 - q < 2) continue;
        let bien = true;
        for (let p = 0; p < q && bien; p++) bien = cl(p, i) === cl(p, i - 1);
        for (let p = q; p < n - 1 && bien; p++) bien = cl(p, i) === cl(p + 1, i - 1);
        if (bien) candidatos.push({ tipo: 'sube', q });
      }
    }
    if (!candidatos.length) continue;
    // Elegir la hipótesis por el salto melódico en el empalme: con el reparto correcto, cada voz sigue su camino
    // (intervalos pequeños entre la última nota antes del corte y la primera después); con el reparto del escáner,
    // o con otro reparto, se comparan voces distintas y los saltos son mayores. Si dejarlo como está salta menos, no se toca.
    const saltoMedio = pares => { let s = 0, c = 0; for (const [a, b] of pares) { const u = ultimaAntes(a, i), v = primeraDesde(b, i); if (u != null && v != null) { s += Math.abs(u - v); c++; } } return c ? s / c : null; };
    const paresDe = c => { const pares = []; for (let r = 0; r < n; r++) { if (r < c.q) pares.push([r, r]); else if (c.tipo === 'baja') pares.push([r, r + 1]); else if (r > c.q) pares.push([r, r - 1]); } return pares; };
    const sinCorte = saltoMedio(Array.from({ length: n }, (_, r) => [r, r]));
    for (const c of candidatos) {
      c.salto = saltoMedio(paresDe(c));
      // Tesitura, solo para desempatar: lo que lleva cada parte corrida se parece más a lo que llevaba su vecina que a lo suyo
      let a = 0, d = 0;
      const desp = c.tipo === 'baja' ? 1 : -1, ini = c.tipo === 'baja' ? c.q + 1 : c.q, hasta = c.tipo === 'baja' ? n : n - 2;
      for (let p = ini; p <= hasta && p < k; p++) {
        const despues = media(p, i, total), vecina = media(p - desp, 0, i), propia = media(p, 0, i);
        if (despues == null || vecina == null || propia == null) continue;
        if (Math.abs(despues - vecina) < Math.abs(despues - propia)) a++; else if (Math.abs(despues - vecina) > Math.abs(despues - propia)) d++;
      }
      c.puntos = a - d;
    }
    const validos = candidatos.filter(c => c.salto != null && (sinCorte == null || c.salto < sinCorte));
    if (!validos.length) continue;
    validos.sort((x, y) => x.salto - y.salto || y.puntos - x.puntos || x.q - y.q);
    const c = validos[0];
    const num = partes[0].compases[i].num;
    if (c.tipo === 'baja') {
      for (let r = c.q; r < n; r++) activas[r].tramos.push({ desde: i, xml: r + 1 });
      const nueva = { id: null, tramos: [{ desde: 0, xml: null }, { desde: i, xml: c.q }] };
      todas.splice(c.q < n ? todas.indexOf(activas[c.q]) : todas.length, 0, nueva);
      activas.splice(c.q, 0, nueva);
      avisos.push(`A partir del compás ${num} la página tiene un pentagrama más (entra una voz en la posición ${c.q + 1}) y el escáner había corrido las partes de debajo una posición: se han recompuesto las voces.`);
    } else {
      activas[c.q].tramos.push({ desde: i, xml: null });
      for (let r = c.q + 1; r < n; r++) activas[r].tramos.push({ desde: i, xml: r - 1 });
      activas.splice(c.q, 1);
      avisos.push(`A partir del compás ${num} desaparece el pentagrama ${c.q + 1} y el escáner había subido las partes de debajo una posición: se han recompuesto las voces.`);
    }
    cortes.push(i);
  }
  if (!cortes.length) return xml;

  // Reconstruir el XML: una parte por pista, empalmando tramos
  const tramoEn = (pista, j) => { let t = pista.tramos[0]; for (const x of pista.tramos) if (x.desde <= j) t = x; return t; };
  const claveDePista = pista => { const t = pista.tramos.find(x => x.xml != null); return t ? info[t.xml][t.desde].bruto : ''; };
  const usados = new Set(partes.map(p => p.id)); let siguiente = k + 1;
  const nuevoId = () => { let id; do { id = 'P' + siguiente++; } while (usados.has(id)); usados.add(id); return id; };
  const cuerpos = [], cabeceras = [];
  todas.forEach((pista, orden) => {
    const id = pista.id || nuevoId();
    let div = 1, beats = 4, bt = 4, claveActual = '';
    const salida = [];
    for (let j = 0; j < total; j++) {
      const ref = partes[0].compases[j];
      const d = ref.cuerpo.match(/<divisions>(\d+)/); if (d) div = +d[1];
      const b = ref.cuerpo.match(/<beats>(\d+)<\/beats>\s*<beat-type>(\d+)/); if (b) { beats = +b[1]; bt = +b[2]; }
      const t = tramoEn(pista, j);
      let attrs = ref.attrs, cuerpo;
      if (t.xml == null) {
        // Silencio de compás entero con los atributos del primer pentagrama, pero con la clave propia de esta voz
        let at = (ref.cuerpo.match(/<attributes>[\s\S]*?<\/attributes>/) || [''])[0];
        const clave = claveDePista(pista);
        if (clave) {
          if (/<clef/.test(at)) at = at.replace(/<clef(?:\s[^>]*)?>[\s\S]*?<\/clef>/, clave);
          else if (j === t.desde) at = at ? at.replace('</attributes>', clave + '</attributes>') : '<attributes>' + clave + '</attributes>';
          claveActual = normal(clave.match(/<clef(?:\s[^>]*)?>([\s\S]*?)<\/clef>/)[1]);
        }
        cuerpo = `\n${at ? '\t\t\t' + at + '\n' : ''}\t\t\t<note><rest measure="yes"/><duration>${Math.round(div * 4 * beats / bt)}</duration><voice>1</voice><type>whole</type></note>\n\t\t`;
      } else {
        const c = partes[t.xml].compases[j]; attrs = c.attrs; cuerpo = c.cuerpo;
        const f = info[t.xml][j];
        if (j === t.desde && j > 0 && f.cambia && f.clave === claveActual) cuerpo = cuerpo.replace(/\s*<clef(?:\s[^>]*)?>[\s\S]*?<\/clef>/, ''); // clave repetida en el empalme
        claveActual = f.clave || claveActual;
      }
      salida.push(`\t\t<measure number="${ref.num}"${attrs}>${cuerpo}</measure>`);
    }
    cuerpos.push(`\t<part id="${id}">\n${salida.join('\n')}\n\t</part>`);
    const original = pista.id && (xml.match(new RegExp(`<score-part id="${pista.id}">[\\s\\S]*?</score-part>`)) || [''])[0];
    if (original) cabeceras.push(original);
    else {
      const plantilla = (xml.match(/<score-part id="[^"]+">[\s\S]*?<\/score-part>/) || [''])[0];
      const nombre = orden === 0 ? 'Solista' : 'Voz ' + (orden + 1);
      cabeceras.push(plantilla.replace(/id="[^"]+"/g, `id="${id}"`).replace(/<part-name>[^<]*<\/part-name>/, `<part-name>${nombre}</part-name>`).replace(/<instrument-name>[^<]*<\/instrument-name>/, `<instrument-name>${nombre}</instrument-name>`).replace(/<midi-channel>\d+/, `<midi-channel>${Math.min(16, orden + 1)}`));
    }
  });
  const ini = xml.indexOf('<part-list>'), finLista = xml.indexOf('</part-list>') + '</part-list>'.length;
  const primeraParte = xml.indexOf('<part id=', finLista), cola = xml.slice(xml.lastIndexOf('</part>') + '</part>'.length);
  return xml.slice(0, ini) + '<part-list>\n\t\t' + cabeceras.join('\n\t\t') + '\n\t</part-list>' + xml.slice(finLista, primeraParte) + cuerpos.join('\n') + cola;
}

function repararCompases(xml, avisos) {
  // 0) Partes corridas por un pentagrama que entra o sale a mitad de obra: se recomponen antes de nada
  xml = recomponerPartesCorridas(xml, avisos);
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
    // Uno de los dos pentagramas no tiene ni una nota (una canción escrita en sistema de piano con el bajo vacío): se queda el otro
    const vacio = pentagramaVacio(cuerpo);
    if (vacio) {
      xml = quitarPentagramaVacio(xml, id, vacio);
      avisos.push(`La parte ${id} tenía dos pentagramas y el ${vacio === 2 ? 'de abajo' : 'de arriba'} estaba vacío (solo silencios): se ha quitado y queda una voz de un pentagrama.`);
      continue;
    }
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

  // 1b) Huecos del escáner (<forward>) → silencios
  const huecos = (xml.match(/<forward>/g) || []).length;
  if (huecos) { xml = huecosASilencios(xml); avisos.push(`El escáner dejó ${huecos} hueco(s) sin notas en algún compás: se han escrito como silencios (revisa esos compases).`); }

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
  try { execSync(`"${AUDIVERIS}" -batch -export -constant org.audiveris.omr.text.Language.defaultSpecification=${IDIOMA_OCR} -output "${tmp}" -- "${path.resolve(pdf)}"`, { stdio: 'ignore', timeout: 15 * 60 * 1000 }); }
  catch (e) { throw new Error('Audiveris no ha podido leer el PDF' + motivoAudiveris(tmp)); }
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

// Causa del fallo de Audiveris, leída de su registro (.log) en la carpeta de salida; por ejemplo
// «Too large image: 21.000.000 pixels (vs 20.000.000 max)» cuando las páginas del PDF son demasiado grandes.
function motivoAudiveris(dir) {
  try {
    const log = fs.readdirSync(dir).find(f => /\.log$/i.test(f)); if (!log) return '';
    const lineas = fs.readFileSync(path.join(dir, log), 'utf8').split(/\r?\n/);
    const aviso = lineas.find(l => /\b(WARN|ERROR)\b/.test(l) && /\| /.test(l));
    if (!aviso) return '';
    let motivo = aviso.replace(/^.*\| /, '').trim();
    if (/Too large image/i.test(motivo)) motivo += '; las páginas del PDF tienen más píxeles de los que admite Audiveris';
    return ' (' + motivo + ')';
  } catch { return ''; }
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

  // Nombres: si ninguna parte trae nombre conocido, por tesitura (Soprano, Contralto…); si alguna sí (por ejemplo el
  // Solista que añade recomponerPartesCorridas), las demás se numeran por su posición en la página (Voz 2, Voz 3…)
  const generico = partes.every(p => !NOMBRES_CONOCIDOS.test(p.nombreActual));
  const nombres = generico ? nombresPorTesitura(partes) : new Map(partes.map((p, i) => [p.id, NOMBRES_CONOCIDOS.test(p.nombreActual) ? p.nombreActual : 'Voz ' + (i + 1)]));
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
    // Página original: imágenes de las páginas y dónde está cada compás, mirando la imagen. Es lo que ve el coro.
    // La letra no se saca del PDF: el coro la lee en la página. Audiveris (lento, y a veces falla) solo se usa como
    // último recurso para situar los compases si la imagen no se deja leer.
    try {
      entrada.paginas = generarPaginas(pdf, dirSalida, base);
      let pos;
      try { pos = posicionesImagen(xml, entrada.paginas.map(p => path.join(dirSalida, p)), log); log('  Compases localizados en la imagen de cada página.'); }
      catch (e) {
        log('  ! No se han podido localizar los compases en la imagen (' + e.message + '): se intenta con la maquetación de Audiveris, menos exacta.');
        let audXml;
        try { audXml = leerConAudiveris(pdf, log); } catch (e2) { log('  ! ' + e2.message.split('\n')[0]); throw e; }
        pos = posiciones(xml, audXml);
      }
      fs.writeFileSync(path.join(dirSalida, base + '.pos.json'), JSON.stringify(pos));
      entrada.posiciones = base + '.pos.json';
      log(`  Página original incorporada (${entrada.paginas.length} imagen(es)); vista "PDF original" disponible.`);
    } catch (e) { delete entrada.paginas; delete entrada.posiciones; log('  ! No se ha podido incorporar la página original: ' + e.message.split('\n')[0]); }
  } else log('  (sin PDF: la obra irá sin vista de página original)');

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
  // Marca «en ensayo»: la del borrador si dice algo; si no, se conserva la que tenía la obra publicada
  if (entrada.ensayo !== undefined ? entrada.ensayo : previa.ensayo) nueva.ensayo = true;
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
  return version;
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

module.exports = {
  RAIZ, DIR_APP, DIR_PARTITURAS, DIR_PDF, LISTA, NOMBRES_VOCES,
  clave, pdfPara, prepararObra, editarObra, huecosASilencios, leerPartes, tituloDe, tempoDe, limpiarNombreArchivo,
  sospechososDe, detalleCompas, fijarCompas, notasCompas, escribirCompas, FIGURA_NEGRAS, repararCompases, recomponerPartesCorridas,
  leerLista, archivosDe, incorporarEnApp, retirarDeApp, marcarEnsayo, subirVersionCache, versionCache, guardarEnGit, guardarPdf,
};
