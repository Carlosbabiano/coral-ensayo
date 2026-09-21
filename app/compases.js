// Lectura y reescritura de compases de un MusicXML. Lo usan el Gestor de obras (Node) y la app publicada (navegador, modo Corregir).
// Sin dependencias: solo expresiones regulares sobre el texto del XML.
//
// Filosofía: al guardar un compás NO se regenera desde cero; cada nota original se "parchea" (altura, figura,
// puntillo, ligadura de unión, letra, acorde) y todo lo demás que llevaba (acentos, calderones, ligaduras de
// expresión, tresillos, plicas, barras) se conserva. Las notas nuevas se crean; las quitadas se borran.
// Soporta varias voces en el mismo pentagrama (<backup>), acordes (<chord/>) y adornos (<grace/>).
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.Compases = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {

// Voces (partes) de un MusicXML: [{ id, nombre }]
function leerPartes(xml) {
  return [...xml.matchAll(/<score-part id="([^"]+)">([\s\S]*?)<\/score-part>/g)].map(([, id, cab]) => ({ id, nombre: (cab.match(/<part-name>([^<]*)/) || [, ''])[1].trim() }));
}
const escapar = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const desescapar = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

const FIGURAS = { maxima: 'máxima', long: 'longa', breve: 'cuadrada', whole: 'redonda', half: 'blanca', quarter: 'negra', eighth: 'corchea', '16th': 'semicorchea', '32nd': 'fusa', '64th': 'semifusa' };
const FIGURA_NEGRAS = { maxima: 32, long: 16, breve: 8, whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125, '64th': 0.0625 };
const NOMBRES_NOTAS = { C: 'Do', D: 'Re', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' };
const SEMITONO = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const DIV_EDITOR = 8;
const RE_PARTE = /<part id="([^"]+)">([\s\S]*?)<\/part>/g;
const RE_COMPAS = /<measure number="([^"]+)"[^>]*>([\s\S]*?)<\/measure>/g;
const RE_NOTA = /<note(?:\s[^>]*)?>[\s\S]*?<\/note>/g;
// Elementos de primer nivel dentro de un compás (no se anidan entre sí)
const RE_ELEMENTO = /<(note|backup|forward|attributes|direction|barline|print|sound|harmony|figured-bass|grouping|link|bookmark)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)|<!--[\s\S]*?-->/g;

const midiDe = n => 12 * (+n.octave + 1) + SEMITONO[n.step] + (+n.alter || 0);
// Duración en negras de una figura editada (con puntillos y tresillo)
function negrasDe(n, esperado) {
  if (n.adorno) return 0;
  if (n.silencio && n.compasEntero) return esperado;
  const base = FIGURA_NEGRAS[n.type]; if (!base) return +n.negras || 0;
  const puntos = n.dot === 2 ? 1.75 : n.dot === 1 ? 1.5 : 1;
  const tres = n.tresillo ? n.tresillo.normal / n.tresillo.actual : 1;
  return base * puntos * tres;
}

// Recorre los compases de cada parte llamando a f({ id, nombre, num, cuerpo, div, beats, bt, cambio })
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
// Lee una nota (texto XML) a un objeto
function leerNota(tok) {
  const p = tok.match(/<step>(\w)<\/step>\s*(?:<alter>(-?\d+)<\/alter>)?\s*<octave>(\d)/);
  const tm = tok.match(/<time-modification>[\s\S]*?<actual-notes>(\d+)<\/actual-notes>\s*<normal-notes>(\d+)<\/normal-notes>/);
  return {
    silencio: /<rest\b/.test(tok), compasEntero: /<rest measure="yes"/.test(tok),
    step: p ? p[1] : 'C', alter: p && p[2] ? +p[2] : 0, octave: p ? +p[3] : 4,
    duracion: +(tok.match(/<duration>(\d+)/) || [, 0])[1],
    type: (tok.match(/<type[^>]*>([^<]*)/) || [, ''])[1], dot: (tok.match(/<dot\s*\/>/g) || []).length,
    acorde: /<chord\s*\/>/.test(tok), adorno: /<grace\b/.test(tok),
    tresillo: tm ? { actual: +tm[1], normal: +tm[2] } : null,
    voz: +((tok.match(/<voice>(\d+)/) || [, 1])[1]),
    ligaEmpieza: /<tie type="start"/.test(tok), ligaTermina: /<tie type="stop"/.test(tok),
    letra: desescapar((tok.match(/<lyric[^>]*>[\s\S]*?<text>([^<]*)/) || [, ''])[1]), silaba: (tok.match(/<lyric[^>]*>[\s\S]*?<syllabic>([^<]*)/) || [, 'single'])[1],
    simbolos: [...tok.matchAll(/<(accent|staccato|tenuto|fermata|breath-mark|slur|marcato|strong-accent)\b/g)].map(m => m[1]),
  };
}
// Suma de duraciones (en negras) de la voz 1 de un compás
function sumaCompas(cuerpo, div) {
  let s = 0;
  for (const [n] of cuerpo.matchAll(RE_NOTA)) if (!/<chord/.test(n) && !/<grace\b/.test(n) && !/<voice>[2-9]/.test(n)) s += +(n.match(/<duration>(\d+)/) || [, 0])[1];
  return s / div;
}
// Sumas por voz de un compás: { 1: negras, 2: negras, ... }
function sumasPorVoz(cuerpo, div) {
  const s = {};
  for (const [n] of cuerpo.matchAll(RE_NOTA)) {
    if (/<chord/.test(n) || /<grace\b/.test(n)) continue;
    const v = +((n.match(/<voice>(\d+)/) || [, 1])[1]);
    s[v] = (s[v] || 0) + +(n.match(/<duration>(\d+)/) || [, 0])[1] / div;
  }
  return s;
}
// Números de compás en los que alguna voz no suma lo que marca el compás
function sospechososDe(xml) {
  const malos = new Set();
  recorrerCompases(xml, c => {
    const esperado = 4 * c.beats / c.bt;
    for (const s of Object.values(sumasPorVoz(c.cuerpo, c.div))) if (Math.abs(s - esperado) > 0.01) malos.add(c.num);
    if (!/<note\b/.test(c.cuerpo)) malos.add(c.num);
  });
  return [...malos];
}
// Lo que hay escrito en un compás, voz por voz (y voz 2 aparte si la hay), en palabras
function detalleCompas(xml, numero) {
  const voces = [];
  recorrerCompases(xml, c => {
    if (c.num !== String(numero)) return;
    const porVoz = {};
    for (const [tok] of c.cuerpo.matchAll(RE_NOTA)) {
      const n = leerNota(tok);
      const dur = n.duracion / c.div;
      const figura = (FIGURAS[n.type] || (dur ? dur + ' negras' : '?')) + ' con puntillo'.repeat(n.dot) + (n.tresillo ? ` (${n.tresillo.actual}:${n.tresillo.normal})` : '');
      let texto;
      if (n.silencio) texto = 'silencio de ' + figura;
      else {
        const alt = n.alter ? (n.alter > 0 ? '♯'.repeat(n.alter) : '♭'.repeat(-n.alter)) : '';
        texto = NOMBRES_NOTAS[n.step] + alt + n.octave + ' ' + figura;
        if (n.acorde) texto = '+ ' + texto;
        if (n.adorno) texto += ' (adorno)';
        if (n.ligaTermina) texto = '(ligada) ' + texto;
        if (n.ligaEmpieza) texto += ' ~';
      }
      if (n.letra) texto += ' «' + n.letra + '»';
      if (n.simbolos.length) texto += ' [' + [...new Set(n.simbolos)].join(', ') + ']';
      (porVoz[n.voz] = porVoz[n.voz] || []).push(texto);
    }
    const sumas = sumasPorVoz(c.cuerpo, c.div);
    const vozNums = Object.keys(porVoz).map(Number).sort((a, b) => a - b);
    if (!vozNums.length) vozNums.push(1);
    for (const v of vozNums) voces.push({ id: c.id, voz: v, nombre: c.nombre + (v > 1 ? ' (voz ' + v + ')' : ''), beats: c.beats, bt: c.bt, cambio: c.cambio, esperado: 4 * c.beats / c.bt, suma: sumas[v] || 0, notas: porVoz[v] || [] });
  });
  return voces;
}

// ---------- Editor: leer las notas de forma estructurada ----------
// Devuelve una entrada por (parte, voz): { id, voz, nombre, beats, bt, esperado, editable, notas: [...] }
// Cada nota lleva indiceXml (posición entre las <note> del compás de esa parte) y entrada (índice de "golpe" dentro
// de la voz: las notas de un acorde comparten entrada; los adornos no cuentan).
function notasCompas(xml, numero) {
  const voces = [];
  recorrerCompases(xml, c => {
    if (c.num !== String(numero)) return;
    const porVoz = {}; const entradas = {};
    [...c.cuerpo.matchAll(RE_NOTA)].forEach(([tok], indiceXml) => {
      const n = leerNota(tok);
      n.negras = n.duracion / c.div; n.indiceXml = indiceXml;
      delete n.duracion;
      if (!n.adorno) { if (!n.acorde) entradas[n.voz] = (entradas[n.voz] || 0) + 1; n.entrada = (entradas[n.voz] || 1) - 1; } else n.entrada = -1;
      (porVoz[n.voz] = porVoz[n.voz] || []).push(n);
    });
    const vozNums = Object.keys(porVoz).map(Number).sort((a, b) => a - b);
    if (!vozNums.length) vozNums.push(1);
    for (const v of vozNums) voces.push({ id: c.id, voz: v, nombre: c.nombre + (v > 1 ? ' (voz ' + v + ')' : ''), beats: c.beats, bt: c.bt, esperado: 4 * c.beats / c.bt, editable: true, notas: porVoz[v] || [] });
  });
  return voces;
}
// Renumera "entrada" tras insertar o borrar notas (para volver a seleccionar la nota en el dibujo)
function renumerar(notas) {
  let e = -1;
  for (const n of notas) { if (n.adorno) { n.entrada = -1; continue; } if (!n.acorde) e++; n.entrada = Math.max(0, e); }
  return notas;
}

// ---------- Editor: escribir ----------
function ponerDivisiones(cuerpo, v) {
  if (/<attributes>[\s\S]*?<divisions>/.test(cuerpo)) return cuerpo.replace(/<divisions>\d+<\/divisions>/, `<divisions>${v}</divisions>`);
  if (/<attributes>/.test(cuerpo)) return cuerpo.replace('<attributes>', `<attributes><divisions>${v}</divisions>`);
  return `<attributes><divisions>${v}</divisions></attributes>` + cuerpo;
}
const ACC = { 1: 'sharp', 2: 'double-sharp', '-1': 'flat', '-2': 'flat-flat' };
function validar(n) {
  if (!n.silencio && (!/^[A-G]$/.test(n.step) || !(n.octave >= 0 && n.octave <= 9) || !(n.alter >= -2 && n.alter <= 2))) throw new Error('Nota no válida');
  if (!n.adorno && !(n.silencio && n.compasEntero) && !FIGURA_NEGRAS[n.type]) throw new Error('Figura no válida: ' + n.type);
}
// Nota nueva en XML
function xmlDeNota(n, dur, voz) {
  validar(n);
  const dot = Math.min(2, Math.max(0, +n.dot || 0));
  const ligas = [n.ligaTermina && 'stop', n.ligaEmpieza && 'start'].filter(Boolean);
  let s = '<note>' + (n.adorno ? '<grace/>' : '') + (n.acorde && !n.silencio ? '<chord/>' : '');
  s += n.silencio ? (n.compasEntero ? '<rest measure="yes"/>' : '<rest/>') : `<pitch><step>${n.step}</step><alter>${+n.alter || 0}</alter><octave>${+n.octave}</octave></pitch>`;
  if (!n.adorno) s += `<duration>${dur}</duration>`;
  s += ligas.map(t => `<tie type="${t}"/>`).join('') + `<voice>${voz}</voice><type>${n.silencio && n.compasEntero ? 'whole' : n.type}</type>` + '<dot/>'.repeat(dot);
  if (!n.silencio && +n.alter) s += `<accidental>${ACC[+n.alter]}</accidental>`;
  if (n.tresillo) s += `<time-modification><actual-notes>${n.tresillo.actual}</actual-notes><normal-notes>${n.tresillo.normal}</normal-notes></time-modification>`;
  s += '<staff>1</staff>';
  if (ligas.length) s += '<notations>' + ligas.map(t => `<tied type="${t}"/>`).join('') + '</notations>';
  if (n.letra && !n.silencio) s += `<lyric number="1" placement="below"><syllabic>${['single', 'begin', 'middle', 'end'].includes(n.silaba) ? n.silaba : 'single'}</syllabic><text>${escapar(n.letra)}</text></lyric>`;
  return s + '</note>';
}
// Parchea una nota existente conservando todo lo que no se edita
function parchearNota(tok, n, dur, voz) {
  validar(n);
  let t = tok;
  const inicio = /(<note\b[^>]*>\s*(?:<grace\b[^>]*\/>\s*)?(?:<cue\s*\/>\s*)?(?:<chord\s*\/>\s*)?)/;
  // acorde
  t = t.replace(/<chord\s*\/>\s*/, '');
  if (n.acorde && !n.silencio) t = t.replace(/(<note\b[^>]*>\s*(?:<grace\b[^>]*\/>\s*)?)/, '$1<chord/>');
  // altura o silencio
  const pitchXml = n.silencio ? (n.compasEntero ? '<rest measure="yes"/>' : '<rest/>') : `<pitch><step>${n.step}</step><alter>${+n.alter || 0}</alter><octave>${+n.octave}</octave></pitch>`;
  if (/<pitch>/.test(t)) t = t.replace(/<pitch>[\s\S]*?<\/pitch>/, pitchXml);
  else if (/<rest\b/.test(t)) t = t.replace(/<rest\b[^>]*\/>|<rest\b[^>]*>[\s\S]*?<\/rest>/, pitchXml);
  else t = t.replace(inicio, '$1' + pitchXml);
  // duración
  if (!n.adorno) { if (/<duration>/.test(t)) t = t.replace(/<duration>\d+<\/duration>/, `<duration>${dur}</duration>`); else t = t.replace(/(<\/pitch>|<rest[^>]*\/>)/, `$1<duration>${dur}</duration>`); }
  // voz
  if (/<voice>/.test(t)) t = t.replace(/<voice>\d+<\/voice>/, `<voice>${voz}</voice>`); else t = t.replace(/(<\/duration>|<\/pitch>|<rest[^>]*\/>)/, `$1<voice>${voz}</voice>`);
  // figura
  const tipo = n.silencio && n.compasEntero ? 'whole' : n.type;
  if (/<type\b/.test(t)) t = t.replace(/<type\b[^>]*>[^<]*<\/type>/, `<type>${tipo}</type>`); else t = t.replace(/(<voice>\d+<\/voice>)/, `$1<type>${tipo}</type>`);
  // puntillos
  t = t.replace(/<dot\s*\/>\s*/g, '');
  const dot = n.silencio && n.compasEntero ? 0 : Math.min(2, Math.max(0, +n.dot || 0));
  if (dot) t = t.replace(/(<\/type>)/, '$1' + '<dot/>'.repeat(dot));
  // alteración escrita
  t = t.replace(/<accidental\b[^>]*>[^<]*<\/accidental>\s*/, '');
  if (!n.silencio && +n.alter) t = t.replace(/(<\/type>(?:<dot\/>)*)/, `$1<accidental>${ACC[+n.alter]}</accidental>`);
  // ligadura de unión
  t = t.replace(/<tie\b[^>]*\/>\s*/g, '').replace(/<tied\b[^>]*\/>\s*/g, '');
  const ligas = n.silencio ? [] : [n.ligaTermina && 'stop', n.ligaEmpieza && 'start'].filter(Boolean);
  if (ligas.length) {
    t = t.replace(/(<\/duration>)/, '$1' + ligas.map(l => `<tie type="${l}"/>`).join(''));
    const tied = ligas.map(l => `<tied type="${l}"/>`).join('');
    if (/<notations>/.test(t)) t = t.replace(/<notations>/, '<notations>' + tied); else t = t.replace(/(<lyric\b|<\/note>)/, `<notations>${tied}</notations>$1`);
  }
  t = t.replace(/<notations>\s*<\/notations>\s*/, '');
  // letra (solo la primera línea de letra)
  if (n.silencio || !n.letra) t = t.replace(/<lyric\b(?:\s[^>]*)?>[\s\S]*?<\/lyric>\s*/, m => (n.silencio || !n.letra) ? '' : m);
  else {
    const sil = ['single', 'begin', 'middle', 'end'].includes(n.silaba) ? n.silaba : 'single';
    if (/<lyric\b/.test(t)) t = t.replace(/(<lyric\b(?:\s[^>]*)?>)([\s\S]*?)(<\/lyric>)/, (m, a, b, c) => {
      b = /<syllabic>/.test(b) ? b.replace(/<syllabic>[^<]*<\/syllabic>/, `<syllabic>${sil}</syllabic>`) : `<syllabic>${sil}</syllabic>` + b;
      b = /<text>/.test(b) ? b.replace(/<text>[^<]*<\/text>/, `<text>${escapar(n.letra)}</text>`) : b + `<text>${escapar(n.letra)}</text>`;
      return a + b + c;
    });
    else t = t.replace(/<\/note>$/, `<lyric number="1" placement="below"><syllabic>${sil}</syllabic><text>${escapar(n.letra)}</text></lyric></note>`);
  }
  return t;
}
// Sustituye las notas de una voz (numVoz) de una parte en un compás. Devuelve el XML nuevo.
function escribirCompas(xml, partId, numero, notas, numVoz = 1) {
  numero = String(numero); numVoz = +numVoz || 1;
  let hecho = false;
  const nuevo = xml.replace(RE_PARTE, (todo, id, cuerpo) => {
    if (id !== partId) return todo;
    let div = 1, beats = 4, bt = 4, arreglarSiguiente = false, divAntes = 1;
    const c2 = cuerpo.replace(/(<measure number="([^"]+)"[^>]*>)([\s\S]*?)(<\/measure>)/g, (m, ini, num, c, fin) => {
      const d = c.match(/<divisions>(\d+)/);
      if (arreglarSiguiente) { arreglarSiguiente = false; if (!d) return ini + ponerDivisiones(c, divAntes) + fin; }
      if (d) div = +d[1];
      const b = c.match(/<beats>(\d+)<\/beats>\s*<beat-type>(\d+)/); if (b) { beats = +b[1]; bt = +b[2]; }
      if (num !== numero) return m;
      hecho = true; arreglarSiguiente = true; divAntes = div;
      const esperado = 4 * beats / bt;
      // 1) trocear el compás en elementos
      const elementos = []; let ultimo = 0;
      for (const mm of c.matchAll(RE_ELEMENTO)) { if (mm.index > ultimo) elementos.push({ tipo: 'texto', xml: c.slice(ultimo, mm.index) }); elementos.push({ tipo: mm[1] || 'comentario', xml: mm[0] }); ultimo = mm.index + mm[0].length; }
      if (ultimo < c.length) elementos.push({ tipo: 'texto', xml: c.slice(ultimo) });
      const notasXml = elementos.filter(e => e.tipo === 'note'); notasXml.forEach((e, i) => { e.indiceXml = i; e.voz = +((e.xml.match(/<voice>(\d+)/) || [, 1])[1]); });
      // 2) divisiones necesarias para las figuras nuevas
      let k = 1;
      for (const n of notas) { const neg = negrasDe(n, esperado); for (const kk of [1, 2, 4, 8, 16, 32]) { if (Math.abs(neg * div * kk - Math.round(neg * div * kk)) < 1e-6) { k = Math.max(k, kk); break; } } }
      if (k > 1) {
        for (const e of elementos) if (['note', 'backup', 'forward'].includes(e.tipo)) e.xml = e.xml.replace(/<duration>(\d+)<\/duration>/, (mm, v) => `<duration>${+v * k}</duration>`);
        const attrs = elementos.find(e => e.tipo === 'attributes');
        if (attrs) attrs.xml = ponerDivisiones(attrs.xml, div * k); else elementos.unshift({ tipo: 'attributes', xml: `<attributes><divisions>${div * k}</divisions></attributes>` });
        div *= k;
      }
      // 3) notas nuevas de esta voz: parcheadas o creadas
      const propias = notasXml.filter(e => e.voz === numVoz);
      const nuevas = notas.map(n => {
        const dur = Math.round(negrasDe(n, esperado) * div);
        const orig = n.indiceXml !== undefined && n.indiceXml !== null ? notasXml[n.indiceXml] : null;
        return { tipo: 'note', xml: orig && orig.voz === numVoz ? parchearNota(orig.xml, n, dur, numVoz) : xmlDeNota(n, dur, numVoz), voz: numVoz };
      });
      // 4) sustituir: quitar las notas viejas de la voz e insertar las nuevas donde estaba la primera
      let pos = propias.length ? elementos.indexOf(propias[0]) : -1;
      const resto = elementos.filter(e => !(e.tipo === 'note' && e.voz === numVoz));
      if (pos < 0) {
        if (numVoz === 1) { pos = resto.findIndex(e => e.tipo === 'note' || e.tipo === 'backup' || e.tipo === 'barline' && /location="right"/.test(e.xml)); if (pos < 0) pos = resto.length; }
        else { pos = resto.findIndex(e => e.tipo === 'barline' && /location="right"/.test(e.xml)); if (pos < 0) pos = resto.length; resto.splice(pos, 0, { tipo: 'backup', xml: '<backup><duration>0</duration></backup>' }); pos++; }
      } else pos = resto.indexOf(elementos.slice(0, elementos.indexOf(propias[0])).reverse().find(e => resto.includes(e))) + 1;
      resto.splice(pos, 0, ...nuevas);
      // 5) recalcular los <backup> (vuelven al principio del compás)
      let t = 0;
      for (const e of resto) {
        if (e.tipo === 'note') { if (!/<chord\s*\/>/.test(e.xml) && !/<grace\b/.test(e.xml)) t += +(e.xml.match(/<duration>(\d+)/) || [, 0])[1]; }
        else if (e.tipo === 'forward') t += +(e.xml.match(/<duration>(\d+)/) || [, 0])[1];
        else if (e.tipo === 'backup') { e.xml = `<backup><duration>${t}</duration></backup>`; t = 0; }
      }
      return ini + resto.map(e => e.xml).join('') + fin;
    });
    return `<part id="${id}">` + c2 + '</part>';
  });
  if (!hecho) throw new Error('No existe el compás ' + numero + ' en la voz ' + partId);
  return nuevo;
}

// ---------- Indicación de compás ----------
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
// Fija la indicación de compás de un compás (en todas las voces). Si restaurar, el siguiente vuelve al compás que había antes.
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

return { leerPartes, escapar, recorrerCompases, sumaCompas, sumasPorVoz, sospechososDe, detalleCompas, notasCompas, renumerar, negrasDe, midiDe, escribirCompas, ponerTiempo, fijarCompas, FIGURA_NEGRAS, FIGURAS, NOMBRES_NOTAS, DIV_EDITOR };
});
