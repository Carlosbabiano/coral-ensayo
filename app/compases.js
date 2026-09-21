// Lectura y reescritura de compases de un MusicXML. Lo usan el Gestor de obras (Node) y la app publicada (navegador, modo Corregir).
// Sin dependencias: solo expresiones regulares sobre el texto del XML.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.Compases = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {

// Voces de un MusicXML: [{ id, nombre }]
function leerPartes(xml) {
  return [...xml.matchAll(/<score-part id="([^"]+)">([\s\S]*?)<\/score-part>/g)].map(([, id, cab]) => ({ id, nombre: (cab.match(/<part-name>([^<]*)/) || [, ''])[1].trim() }));
}

const escapar = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
// ---------- Editor de compás: leer las notas de una voz de forma estructurada y volver a escribirlas ----------
const FIGURA_NEGRAS = { breve: 8, whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125 };
const DIV_EDITOR = 8; // divisiones por negra al reescribir: llega hasta la fusa con puntillo
function notasCompas(xml, numero) {
  const voces = [];
  recorrerCompases(xml, c => {
    if (c.num !== String(numero)) return;
    // Con tresillos, notas de adorno o varias voces en el mismo pentagrama el editor no se atreve: mejor MuseScore
    const editable = !/<time-modification|<grace|<backup|<voice>[2-9]/.test(c.cuerpo);
    const notas = [...c.cuerpo.matchAll(RE_NOTA)].map(([n]) => {
      const p = n.match(/<step>(\w)<\/step>\s*(?:<alter>(-?\d+)<\/alter>)?\s*<octave>(\d)/);
      return {
        silencio: /<rest/.test(n), compasEntero: /<rest measure="yes"/.test(n),
        step: p ? p[1] : 'C', alter: p && p[2] ? +p[2] : 0, octave: p ? +p[3] : 4,
        negras: +(n.match(/<duration>(\d+)/) || [, 0])[1] / c.div,
        type: (n.match(/<type>([^<]*)/) || [, ''])[1], dot: (n.match(/<dot\s*\/>/g) || []).length,
        acorde: /<chord/.test(n), ligaEmpieza: /<tie type="start"/.test(n), ligaTermina: /<tie type="stop"/.test(n),
        letra: (n.match(/<text>([^<]*)/) || [, ''])[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'), silaba: (n.match(/<syllabic>([^<]*)/) || [, 'single'])[1],
      };
    });
    voces.push({ id: c.id, nombre: c.nombre, beats: c.beats, bt: c.bt, esperado: 4 * c.beats / c.bt, editable, notas });
  });
  return voces;
}
function ponerDivisiones(cuerpo, v) {
  if (/<attributes>[\s\S]*?<divisions>/.test(cuerpo)) return cuerpo.replace(/<divisions>\d+<\/divisions>/, `<divisions>${v}</divisions>`);
  if (/<attributes>/.test(cuerpo)) return cuerpo.replace('<attributes>', `<attributes><divisions>${v}</divisions>`);
  return `<attributes><divisions>${v}</divisions></attributes>` + cuerpo;
}
function xmlDeNota(n, esperado) {
  if (!FIGURA_NEGRAS[n.type] && !(n.silencio && n.compasEntero)) throw new Error('Figura no válida: ' + n.type);
  const dot = Math.min(2, Math.max(0, +n.dot || 0));
  let negras = n.silencio && n.compasEntero ? esperado : FIGURA_NEGRAS[n.type] * (dot === 1 ? 1.5 : dot === 2 ? 1.75 : 1);
  const dur = Math.round(negras * DIV_EDITOR);
  const ligas = [n.ligaTermina && 'stop', n.ligaEmpieza && 'start'].filter(Boolean);
  let s = '<note>' + (n.acorde && !n.silencio ? '<chord/>' : '');
  if (n.silencio) s += n.compasEntero ? '<rest measure="yes"/>' : '<rest/>';
  else {
    if (!/^[A-G]$/.test(n.step) || !(n.octave >= 0 && n.octave <= 9) || !(n.alter >= -2 && n.alter <= 2)) throw new Error('Nota no válida');
    s += `<pitch><step>${n.step}</step><alter>${+n.alter || 0}</alter><octave>${+n.octave}</octave></pitch>`;
  }
  s += `<duration>${dur}</duration>` + ligas.map(t => `<tie type="${t}"/>`).join('') + `<voice>1</voice><type>${n.silencio && n.compasEntero ? 'whole' : n.type}</type>` + '<dot/>'.repeat(dot);
  if (!n.silencio && +n.alter) s += `<accidental>${{ 1: 'sharp', 2: 'double-sharp', '-1': 'flat', '-2': 'flat-flat' }[+n.alter]}</accidental>`;
  s += '<staff>1</staff>';
  if (ligas.length) s += '<notations>' + ligas.map(t => `<tied type="${t}"/>`).join('') + '</notations>';
  if (n.letra && !n.silencio) s += `<lyric number="1" placement="below"><syllabic>${['single', 'begin', 'middle', 'end'].includes(n.silaba) ? n.silaba : 'single'}</syllabic><text>${escapar(String(n.letra))}</text></lyric>`;
  return s + '</note>';
}
// Sustituye las notas de una voz en un compás (conserva atributos, direcciones y barras). Devuelve el XML nuevo.
function escribirCompas(xml, partId, numero, notas) {
  numero = String(numero);
  let hecho = false;
  const nuevo = xml.replace(RE_PARTE, (todo, id, cuerpo) => {
    if (id !== partId) return todo;
    let div = 1, beats = 4, bt = 4, arreglarSiguiente = false;
    const c2 = cuerpo.replace(/(<measure number="([^"]+)"[^>]*>)([\s\S]*?)(<\/measure>)/g, (m, ini, num, c, fin) => {
      const d = c.match(/<divisions>(\d+)/);
      if (arreglarSiguiente) { arreglarSiguiente = false; if (!d) return ini + ponerDivisiones(c, div) + fin; } // el siguiente hereda las divisiones antiguas de forma explícita
      if (d) div = +d[1];
      const b = c.match(/<beats>(\d+)<\/beats>\s*<beat-type>(\d+)/); if (b) { beats = +b[1]; bt = +b[2]; }
      if (num !== numero) return m;
      hecho = true; arreglarSiguiente = true;
      const esperado = 4 * beats / bt;
      const attrs = ponerDivisiones((c.match(/<attributes>[\s\S]*?<\/attributes>/) || [''])[0], DIV_EDITOR);
      const barraIzq = (c.match(/<barline location="left">[\s\S]*?<\/barline>/) || [''])[0];
      const barraDer = (c.match(/<barline location="right">[\s\S]*?<\/barline>/) || [''])[0];
      const direcciones = (c.match(/<direction[\s>][\s\S]*?<\/direction>/g) || []).join('');
      return ini + barraIzq + attrs + direcciones + notas.map(n => xmlDeNota(n, esperado)).join('') + barraDer + fin;
    });
    return `<part id="${id}">` + c2 + '</part>';
  });
  if (!hecho) throw new Error('No existe el compás ' + numero + ' en la voz ' + partId);
  return nuevo;
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


return { leerPartes, escapar, recorrerCompases, sumaCompas, sospechososDe, detalleCompas, notasCompas, escribirCompas, ponerTiempo, fijarCompas, FIGURA_NEGRAS, FIGURAS, NOMBRES_NOTAS, DIV_EDITOR };
});
