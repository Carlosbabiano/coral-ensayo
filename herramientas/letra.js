// Pasa la letra leída por Audiveris a un MusicXML del Escáner Musical (que lee mejor las notas).
// Uso: node herramientas/letra.js <escaner.xml> <audiveris.xml> <salida.xml>
// Alinea las notas de cada voz (por altura y duración) y copia cada sílaba a la nota correspondiente.
const fs = require('fs');

const N = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const RE_NOTE = /<note(?:\s[^>]*)?>[\s\S]*?<\/note>/g;
const BASURA = /^(p|pp|ppp|mp|mf|f|ff|fff|sfz|fp|cresc\.?|dim\.?|rit\.?|rall\.?|poco|molto|div\.?|unis\.?|tutti|solo|a tempo|\W*)$/i;
const ARREGLOS = [[/\bIl/g, 'll'], [/\bIn'/g, "m'"], [/\brn'/g, "m'"], [/\bIno\b/g, 'mo'], [/\bInos\b/g, 'mos'], [/\br1\b/g, 'ri'], [/\bVl\b/g, 'Vi'], [/\bvl\b/g, 'vi'], [/\bIlO\b/g, 'no'], [/\bnior\b/g, 'mor'], [/\bsieni\b/g, 'siem'], [/0/g, 'o'], [/1/g, 'l']];

function leerPartes(xml) {
  const partes = [];
  for (const m of xml.matchAll(/<part id="([^"]+)">([\s\S]*?)<\/part>/g)) {
    const [todo, id, cuerpo] = m; const inicio = m.index;
    let div = 1; const tokens = [];
    for (const mm of cuerpo.matchAll(/<measure number="([^"]+)"[^>]*>([\s\S]*?)<\/measure>/g)) {
      const d = mm[2].match(/<divisions>(\d+)/); if (d) div = +d[1];
      const baseMedida = inicio + todo.indexOf(mm[0], mm.index) ; // posición absoluta aproximada
      for (const n of mm[2].matchAll(RE_NOTE)) {
        const x = n[0];
        if (/<grace/.test(x) || /<chord/.test(x)) continue;
        const p = x.match(/<step>(\w)<\/step>\s*(?:<alter>(-?\d+)<\/alter>)?\s*<octave>(\d)/);
        const midi = p && !/<rest/.test(x) ? 12 * (+p[3] + 1) + N[p[1]] + (+(p[2] || 0)) : -1;
        const dur = +(x.match(/<duration>(\d+)/) || [, 0])[1] / div;
        const lyrics = [...x.matchAll(/<lyric[^>]*>[\s\S]*?<\/lyric>/g)].map(l => l[0]);
        const cont = /<tie type="stop"/.test(x) && !/<tie type="start"/.test(x);
        tokens.push({ midi, dur: +dur.toFixed(3), lyrics, cont, texto: x, compas: mm[1] });
      }
    }
    partes.push({ id, tokens });
  }
  return partes;
}

// Alineación global (Needleman-Wunsch) entre dos secuencias de notas
function alinear(A, B) {
  const n = A.length, m = B.length;
  const S = Array.from({ length: n + 1 }, () => new Float32Array(m + 1));
  const T = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  const GAP = -1.2;
  for (let i = 1; i <= n; i++) { S[i][0] = i * GAP; T[i][0] = 1; }
  for (let j = 1; j <= m; j++) { S[0][j] = j * GAP; T[0][j] = 2; }
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const a = A[i - 1], b = B[j - 1];
    let s;
    if (a.midi === b.midi) s = a.midi === -1 ? 1 : 2 + (a.dur === b.dur ? 1 : 0);
    else if (a.midi === -1 || b.midi === -1) s = -1.5;
    else if (Math.abs(a.midi - b.midi) === 12) s = 1.5; // error de octava típico del OMR
    else s = -1;
    const d = S[i - 1][j - 1] + s, u = S[i - 1][j] + GAP, l = S[i][j - 1] + GAP;
    if (d >= u && d >= l) { S[i][j] = d; T[i][j] = 0; } else if (u >= l) { S[i][j] = u; T[i][j] = 1; } else { S[i][j] = l; T[i][j] = 2; }
  }
  const pares = []; let i = n, j = m;
  while (i > 0 || j > 0) {
    const t = T[i][j];
    if (i > 0 && j > 0 && t === 0) { pares.push([i - 1, j - 1]); i--; j--; }
    else if (i > 0 && (j === 0 || t === 1)) i--; else j--;
  }
  return { score: S[n][m], pares: pares.reverse() };
}

function limpiarLyric(l) {
  let t = (l.match(/<text>([^<]*)<\/text>/) || [, ''])[1].trim();
  if (BASURA.test(t) || /[0-9"«»#@*]/.test(t) && !/[aeiouáéíóú]/i.test(t)) return null;
  for (const [re, rep] of ARREGLOS) t = t.replace(re, rep);
  if (!t) return null;
  return l.replace(/<text>[^<]*<\/text>/, '<text>' + t.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</text>');
}

function transplantar(escXml, audXml) {
  const E = leerPartes(escXml), A = leerPartes(audXml);
  // Emparejar voces por mejor alineación (el orden de las partes puede diferir)
  const matriz = E.map(e => A.map(a => alinear(e.tokens, a.tokens).score));
  const usadasA = new Set(); const parejas = [];
  const cand = []; E.forEach((e, i) => A.forEach((a, j) => cand.push([matriz[i][j], i, j])));
  cand.sort((x, y) => y[0] - x[0]);
  const usadasE = new Set();
  for (const [s, i, j] of cand) { if (usadasE.has(i) || usadasA.has(j)) continue; usadasE.add(i); usadasA.add(j); parejas.push([i, j, s]); }

  let salida = escXml; const informe = [];
  for (const [i, j] of parejas.sort((x, y) => x[0] - y[0])) {
    const e = E[i], a = A[j];
    const { pares } = alinear(e.tokens, a.tokens);
    let copiadas = 0, perdidas = 0; const nuevos = new Map();
    const conLetra = new Set(pares.filter(([, jb]) => a.tokens[jb].lyrics.length).map(([, jb]) => jb));
    a.tokens.forEach((t, jb) => { if (t.lyrics.length && !conLetra.has(jb)) perdidas++; });
    for (const [ia, jb] of pares) {
      const te = e.tokens[ia], ta = a.tokens[jb];
      if (!ta.lyrics.length || te.midi === -1 || te.cont) continue;
      const ls = ta.lyrics.map(limpiarLyric).filter(Boolean);
      if (!ls.length) continue;
      nuevos.set(ia, ls); copiadas++;
    }
    // Normalizar números de estrofa (Audiveris a veces empieza en 2)
    const numeros = [...new Set([...nuevos.values()].flat().map(l => (l.match(/number="(\d+)"/) || [, '1'])[1]))].sort();
    const mapa = Object.fromEntries(numeros.map((v, k) => [v, String(k + 1)]));
    // Reescribir la parte del escáner
    const partRe = new RegExp(`(<part id="${e.id}">)([\\s\\S]*?)(</part>)`);
    salida = salida.replace(partRe, (m, ini, cuerpo, fin) => {
      let k = 0;
      cuerpo = cuerpo.replace(RE_NOTE, x => {
        if (/<grace/.test(x) || /<chord/.test(x)) return x;
        const idx = k++;
        x = x.replace(/<lyric[^>]*>[\s\S]*?<\/lyric>\s*/g, '');
        if (!nuevos.has(idx)) return x;
        const ls = nuevos.get(idx).map(l => l.replace(/number="(\d+)"/, (q, v) => `number="${mapa[v]}"`).replace(/ default-[xy]="[^"]*"/g, '').replace(/ relative-[xy]="[^"]*"/g, ''));
        return x.replace(/<\/note>$/, ls.join('') + '</note>');
      });
      return ini + cuerpo + fin;
    });
    const notasE = e.tokens.filter(t => t.midi !== -1 && !t.cont).length;
    informe.push(`${e.id} ← ${a.id}: ${copiadas} sílabas colocadas sobre ${notasE} notas` + (perdidas ? `, ${perdidas} sílabas sin sitio` : ''));
  }
  return { salida, informe };
}

if (require.main === module) {
  const [esc, aud, out] = process.argv.slice(2);
  if (!out) { console.log('Uso: node letra.js escaner.xml audiveris.xml salida.xml'); process.exit(1); }
  const { salida, informe } = transplantar(fs.readFileSync(esc, 'utf8'), fs.readFileSync(aud, 'utf8'));
  fs.writeFileSync(out, salida);
  console.log(informe.join('\n'));
}
module.exports = { transplantar };
