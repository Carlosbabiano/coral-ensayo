// Letra → fonemas para el cantante sintético (DiffSinger).
// Castellano: primero el diccionario de la voz (dsdict-es), luego el diccionario de OpenUtau (23.000 palabras)
// y, si la palabra no está, reglas de pronunciación. Latín (eclesiástico, "a la italiana"): solo reglas.
// Los fonemas se expresan en el juego del G2P español de OpenUtau (a b B ch d D e f g G gn i I k l ll m n o p r rr s t u U w x y Y z)
// y después se traducen al juego de la voz con su tabla de "replacements". Los fonemas que no existen en ese juego
// (los propios del latín: ch de "coeli", "jh" de "regina", "sh" de "scio", "ts" de "gratia", "v") van marcados con "@"
// y pasan tal cual a la voz.
const fs = require('fs');

const VOCALES_G2P = new Set(['a', 'e', 'i', 'o', 'u']);
const quitarAcentos = t => t.normalize('NFD').replace(/[̀-ͯ]/g, '');

// ---------- Diccionario de OpenUtau (dict.txt: "palabra  f o n e m a s") ----------
function cargarDiccionario(ruta) {
  const d = new Map();
  if (!ruta || !fs.existsSync(ruta)) return d;
  for (const linea of fs.readFileSync(ruta, 'utf8').split(/\r?\n/)) {
    const i = linea.indexOf('  '); if (i < 0) continue;
    const palabra = linea.slice(0, i).trim().toLowerCase(), fonemas = linea.slice(i + 2).trim().split(/\s+/);
    if (palabra && !d.has(palabra)) d.set(palabra, fonemas);
  }
  return d;
}

// ---------- Castellano por reglas ----------
const FUERTES = 'aeo';
function esVocalLetra(c) { return !!c && 'aeiouáéíóúü'.includes(c); }
const en = (conjunto, c) => !!c && conjunto.includes(c);
function reglasCastellano(palabra) {
  const w = palabra.toLowerCase().normalize('NFC').replace(/[^a-záéíóúüñ]/g, '');
  const out = [];
  const n = w.length;
  const plano = c => quitarAcentos(c);
  for (let i = 0; i < n; i++) {
    const c = w[i], ant = w[i - 1] || '', sig = w[i + 1] || '', sig2 = w[i + 2] || '';
    const pS = plano(sig), pA = plano(ant);
    const inicio = i === 0;
    const vocalSig = esVocalLetra(sig), vocalAnt = esVocalLetra(ant);
    switch (c) {
      case 'a': case 'e': case 'o': case 'á': case 'é': case 'ó': out.push(plano(c)); break;
      case 'í': out.push('i'); break;
      case 'ú': out.push('u'); break;
      case 'ü': out.push(vocalSig ? 'w' : 'u'); break;
      case 'i':
        if (vocalSig && !en('íú', sig)) {
          // i + vocal: semivocal (bien, cielo, dios, maría sin tilde → m a r y a)
          out.push('y');
        } else if (vocalAnt && en(FUERTES, pA) && !en('íú', ant)) out.push('I'); // ai, ei, oi
        else out.push('i');
        break;
      case 'u':
        if ((pA === 'q') || (pA === 'g' && en('ei', pS))) break; // u muda (que, qui, gue, gui)
        if (vocalSig && !en('íú', sig)) out.push('w');
        else if (vocalAnt && en(FUERTES, pA) && !en('íú', ant)) out.push('U');
        else out.push('u');
        break;
      case 'y':
        if (n === 1) out.push('i');
        else if (vocalSig) out.push('Y');
        else out.push(vocalAnt ? 'I' : 'i');
        break;
      case 'b': case 'v': out.push(inicio || en('mn', pA) ? 'b' : 'B'); break;
      case 'd': out.push(inicio || en('nl', pA) ? 'd' : 'D'); break;
      case 'g':
        if (en('ei', pS)) out.push('x');
        else if (pS === 'u' && en('ei', plano(sig2))) out.push(inicio || pA === 'n' ? 'g' : 'G');
        else out.push(inicio || pA === 'n' ? 'g' : 'G');
        break;
      case 'c':
        if (pS === 'h') { out.push('ch'); i++; }
        else if (en('ei', pS)) out.push('z');
        else out.push('k');
        break;
      case 'q': out.push('k'); break;
      case 'k': out.push('k'); break;
      case 'z': out.push('z'); break;
      case 's': out.push('s'); break;
      case 'x':
        if (inicio) out.push('s');
        else if (/^m[eé]xic|^oaxac|^texa/.test(w)) out.push('x');
        else { out.push('k'); out.push('s'); }
        break;
      case 'j': out.push('x'); break;
      case 'h': break;
      case 'ñ': out.push('gn'); break;
      case 'l':
        if (pS === 'l') { out.push('ll'); i++; } else out.push('l');
        break;
      case 'r':
        if (pS === 'r') { out.push('rr'); i++; }
        else out.push(inicio || pA === 'n' ? 'rr' : 'r');
        break;
      case 'm': out.push('m'); break;
      case 'n': out.push('n'); break;
      case 'p': out.push('p'); break;
      case 't': out.push('t'); break;
      case 'f': out.push('f'); break;
      case 'w': out.push('w'); break;
      default: break;
    }
  }
  return out;
}

// ---------- Latín eclesiástico (pronunciación romana, la habitual en los coros) ----------
function reglasLatin(palabra) {
  const w = quitarAcentos(palabra.toLowerCase()).replace(/[^a-z]/g, '').replace(/æ/g, 'ae').replace(/œ/g, 'oe');
  const out = [];
  const n = w.length;
  const V = 'aeiou'; const esV = c => !!c && V.includes(c);
  for (let i = 0; i < n; i++) {
    const c = w[i], ant = w[i - 1] || '', sig = w[i + 1] || '', sig2 = w[i + 2] || '';
    const inicio = i === 0;
    switch (c) {
      case 'a':
        if (sig === 'e') { out.push('e'); i++; }
        else if (sig === 'u') { out.push('a'); out.push('U'); i++; }
        else out.push('a');
        break;
      case 'o':
        if (sig === 'e') { out.push('e'); i++; }
        else out.push('o');
        break;
      case 'e':
        if (sig === 'u' && !/^(e|de|me|te|se)u/.test(w.slice(i - 1 < 0 ? 0 : i - 1)) && n > 2) { out.push('e'); out.push('U'); i++; }
        else out.push('e');
        break;
      case 'i':
        if (esV(sig) && (inicio || esV(ant))) out.push('y'); // Iesus, eius, alleluia
        else out.push('i');
        break;
      case 'j': out.push('y'); break;
      case 'u':
        if (ant === 'q' || (ant === 'g' && esV(sig) && sig !== 'u')) out.push('w');
        else out.push('u');
        break;
      case 'y': out.push('i'); break;
      case 'c':
        if (sig === 'h') { out.push('k'); i++; }
        else if (sig === 'c' && en('ei', sig2)) { out.push('t'); out.push('@ch'); i++; }
        else if (en('ei', sig) || (sig === 'a' && sig2 === 'e') || (sig === 'o' && sig2 === 'e')) out.push('@ch');
        else out.push('k');
        break;
      case 's':
        if (sig === 'c' && (en('ei', sig2) || (sig2 === 'a' && w[i + 3] === 'e'))) { out.push('@sh'); i++; }
        else out.push('s');
        break;
      case 'g':
        if (sig === 'n') { out.push('gn'); i++; }
        else if (en('ei', sig) || (sig === 'a' && sig2 === 'e')) out.push('@jh');
        else out.push('g');
        break;
      case 'h': break;
      case 'p':
        if (sig === 'h') { out.push('f'); i++; } else out.push('p');
        break;
      case 't':
        if (sig === 'h') { out.push('t'); i++; }
        else if (sig === 'i' && esV(sig2) && !en('stx', ant)) out.push('@ts'); // gratia, laetitia
        else out.push('t');
        break;
      case 'x':
        if (sig === 'c' && en('ei', sig2)) { out.push('k'); out.push('@sh'); i++; }
        else { out.push('k'); out.push('s'); }
        break;
      case 'z': out.push('@z'); break;
      case 'v': out.push('@v'); break;
      case 'b': out.push('b'); break;
      case 'd': out.push('d'); break;
      case 'f': out.push('f'); break;
      case 'k': out.push('k'); break;
      case 'l':
        if (sig === 'l') { out.push('l'); i++; } else out.push('l');
        break;
      case 'm': out.push('m'); break;
      case 'n': out.push('n'); break;
      case 'q': out.push('k'); break;
      case 'r':
        if (sig === 'r') { out.push('rr'); i++; } else out.push('r');
        break;
      case 'w': out.push('w'); break;
      default: break;
    }
  }
  return out;
}

// ---------- Traducción al juego de fonemas de la voz ----------
class Fonetizador {
  // voz: { fonemas: Set, reemplazos: {de: a}, diccionarioVoz: Map(palabra → [fonemas de la voz]), tipos: {fonema: tipo} }
  constructor({ rutaDiccionario, voz }) {
    this.dic = cargarDiccionario(rutaDiccionario);
    this.voz = voz;
    this.cache = new Map();
  }
  esVocal(f) { return this.voz.tipos[f] === 'vowel'; }
  esSemivocal(f) { const t = this.voz.tipos[f]; return t === 'semivowel' || t === 'liquid'; }
  // Fonemas "universales" → fonemas de la voz
  aVoz(simbolos) {
    const salida = [];
    for (let s of simbolos) {
      if (s.startsWith('@')) s = s.slice(1);
      else if (this.voz.reemplazos[s] !== undefined) s = this.voz.reemplazos[s];
      if (this.voz.fonemas.has(s)) { salida.push(s); continue; }
      // La voz no tiene ese fonema: aproximaciones
      const alternativas = { ch: ['ch', 'c', 'tx'], jh: ['jh', 'j', 'y'], sh: ['sh', 's'], ts: ['ts', 't'], v: ['v', 'b', 'bh'], z: ['z', 's'], w: ['w', 'u1', 'u'], y: ['y', 'j', 'i'], rr: ['rr', 'r', 'rx'], gn: ['ny', 'n'], x: ['x', 'h', 'hh'], I: ['I1', 'i'], U: ['U1', 'u'], ll: ['j', 'y', 'l'] };
      const alt = (alternativas[s] || []).find(a => this.voz.fonemas.has(a));
      if (alt) salida.push(alt);
      else if (this.voz.fonemas.has(s.replace(/\d+$/, ''))) salida.push(s.replace(/\d+$/, ''));
      else console.warn('Fonema sin equivalente en la voz:', s);
    }
    return salida;
  }
  // palabra (sin espacios) → fonemas de la voz
  fonemas(palabra, idioma = 'es') {
    // varias palabras en la misma nota ("sa y"): cada una por su lado
    const trozos = String(palabra).trim().split(/s+/).filter(Boolean);
    if (trozos.length > 1) return trozos.flatMap(t => this.fonemas(t, idioma));
    const clave = idioma + ':' + palabra.toLowerCase();
    if (this.cache.has(clave)) return this.cache.get(clave);
    const p = palabra.toLowerCase().normalize('NFC').replace(/[^\p{L}]/gu, '');
    let r;
    if (!p) r = [];
    else if (idioma === 'la') r = this.aVoz(reglasLatin(p));
    else {
      const enVoz = this.voz.diccionarioVoz.get(p) || this.voz.diccionarioVoz.get(quitarAcentos(p));
      if (enVoz) r = enVoz.filter(f => this.voz.fonemas.has(f));
      else {
        const enDic = this.dic.get(p) || this.dic.get(quitarAcentos(p));
        r = this.aVoz(enDic || reglasCastellano(p));
      }
    }
    this.cache.set(clave, r);
    return r;
  }
}

module.exports = { Fonetizador, reglasCastellano, reglasLatin, cargarDiccionario, quitarAcentos, VOCALES_G2P };
