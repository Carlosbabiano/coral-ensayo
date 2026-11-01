// Compara nota a nota dos MusicXML de la misma obra (por ejemplo el del Escáner Musical y el que ha leído la IA o
// Audiveris): por cada voz y compás, altura, figura (con puntillo) y letra de la voz 1, en orden de lectura.
// Uso: node herramientas/pruebas/comparar-xml.js <referencia.xml> <leido.xml> [--detalle]
// Las voces se emparejan por orden (primera con primera…). Un compás cuenta como igual si todas sus notas lo son.
const fs = require('fs');

const SEMITONO = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const limpiar = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ']/g, '');

function leer(xml) {
  const nombres = [...xml.matchAll(/<score-part id="([^"]+)">[\s\S]*?<part-name>([^<]*)/g)].map(m => m[2].trim());
  const partes = [];
  for (const [, id, cuerpo] of xml.matchAll(/<part id="([^"]+)">([\s\S]*?)<\/part>/g)) {
    let div = 1; const compases = [];
    for (const [, num, m] of cuerpo.matchAll(/<measure number="([^"]+)"[^>]*>([\s\S]*?)<\/measure>/g)) {
      const d = m.match(/<divisions>(\d+)/); if (d) div = +d[1];
      const notas = [];
      for (const [n] of m.matchAll(/<note(?:\s[^>]*)?>[\s\S]*?<\/note>/g)) {
        if (/<grace\b/.test(n) || /<voice>[2-9]/.test(n)) continue;
        const p = n.match(/<step>(\w)<\/step>\s*(?:<alter>(-?\d+)<\/alter>)?\s*<octave>(\d)/);
        const midi = p && !/<rest/.test(n) ? 12 * (+p[3] + 1) + SEMITONO[p[1]] + (+(p[2] || 0)) : null;
        const dur = +(n.match(/<duration>(\d+)/) || [, 0])[1] / div;
        const letra = (n.match(/<lyric[^>]*>[\s\S]*?<text>([^<]*)/) || [, ''])[1];
        notas.push({ midi, dur: Math.round(dur * 1000) / 1000, letra: limpiar(letra), acorde: /<chord\s*\/>/.test(n) });
      }
      // Las notas de un acorde (divisi) se ordenan de grave a aguda: cada programa las escribe en un orden distinto y no es error
      const ordenadas = [];
      for (const n of notas) {
        if (n.acorde && ordenadas.length) { const g = ordenadas[ordenadas.length - 1]; g.push(n); g.sort((x, y) => (x.midi ?? -1) - (y.midi ?? -1)); } else ordenadas.push([n]);
      }
      compases.push({ num, notas: ordenadas.flat() });
    }
    partes.push({ id, nombre: nombres[partes.length] || id, compases });
  }
  return partes;
}
const nombreNota = m => m == null ? 'sil' : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][m % 12] + (Math.floor(m / 12) - 1);
const describir = n => `${nombreNota(n.midi)}·${n.dur}${n.letra ? '«' + n.letra + '»' : ''}`;

function comparar(ref, otro, detalle = false) {
  const A = leer(ref), B = leer(otro);
  const salida = [];
  const total = { compases: 0, compasesIguales: 0, notas: 0, notasIguales: 0, alturas: 0, figuras: 0, letras: 0, letrasIguales: 0 };
  const n = Math.min(A.length, B.length);
  salida.push(`Voces: ${A.length} en la referencia, ${B.length} en la lectura${A.length !== B.length ? ' (!)' : ''}. Compases: ${A[0] ? A[0].compases.length : 0} y ${B[0] ? B[0].compases.length : 0}.`);
  for (let v = 0; v < n; v++) {
    const a = A[v], b = B[v];
    const t = { compases: 0, compasesIguales: 0, notas: 0, notasIguales: 0, alturas: 0, figuras: 0, letras: 0, letrasIguales: 0 };
    const malos = [];
    const nc = Math.max(a.compases.length, b.compases.length);
    for (let c = 0; c < nc; c++) {
      const ca = a.compases[c], cb = b.compases[c];
      t.compases++;
      if (!ca || !cb) { malos.push(`c${c + 1}: ${!ca ? 'sobra en la lectura' : 'falta en la lectura'}`); if (ca) t.notas += ca.notas.length; continue; }
      let igual = ca.notas.length === cb.notas.length;
      const m = Math.max(ca.notas.length, cb.notas.length);
      const dif = [];
      for (let i = 0; i < m; i++) {
        const x = ca.notas[i], y = cb.notas[i];
        t.notas++;
        if (!x || !y) { igual = false; dif.push(`${i + 1}: ${x ? describir(x) + ' → nada' : 'nada → ' + describir(y)}`); continue; }
        const altura = x.midi === y.midi, figura = Math.abs(x.dur - y.dur) < 0.01;
        if (altura) t.alturas++; if (figura) t.figuras++;
        if (altura && figura) t.notasIguales++; else { igual = false; dif.push(`${i + 1}: ${describir(x)} → ${describir(y)}`); }
        if (x.letra) { t.letras++; if (x.letra === y.letra) t.letrasIguales++; }
      }
      if (igual) t.compasesIguales++; else malos.push(`c${c + 1}: ${dif.join(', ')}`);
    }
    for (const k of Object.keys(total)) total[k] += t[k];
    salida.push(`${a.nombre.padEnd(14)} compases ${t.compasesIguales}/${t.compases} iguales · notas ${t.notasIguales}/${t.notas} (altura ${t.alturas}, figura ${t.figuras}) · letra ${t.letrasIguales}/${t.letras}`);
    if (detalle) for (const l of malos) salida.push('    ' + l);
  }
  salida.push(`TOTAL          compases ${total.compasesIguales}/${total.compases} · notas ${total.notasIguales}/${total.notas} (${total.notas ? Math.round(100 * total.notasIguales / total.notas) : 0} %) · letra ${total.letrasIguales}/${total.letras} (${total.letras ? Math.round(100 * total.letrasIguales / total.letras) : 0} %)`);
  return { texto: salida.join('\n'), total };
}

module.exports = { comparar, leer };
if (require.main === module) {
  const [ref, otro] = process.argv.slice(2).filter(x => !x.startsWith('--'));
  if (!otro) { console.log('Uso: node herramientas/pruebas/comparar-xml.js <referencia.xml> <leido.xml> [--detalle]'); process.exit(1); }
  console.log(comparar(fs.readFileSync(ref, 'utf8'), fs.readFileSync(otro, 'utf8'), process.argv.includes('--detalle')).texto);
}
