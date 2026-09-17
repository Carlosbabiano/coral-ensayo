// Calcula dónde está cada compás dentro de las páginas del PDF, a partir del MusicXML de Audiveris
// (que trae la maquetación de la página) y lo asocia a los compases del XML del escáner.
// Uso: node herramientas/posiciones.js <escaner.xml> <audiveris.xml> <salida.pos.json>
// Salida: { paginas, compases: [ { p, x0, x1, y0, y1 } ] }  (coordenadas como fracción del ancho/alto de página)
const fs = require('fs');
const { leerPartes, alinear } = require('./letra.js');

function num(re, s, def) { const m = s.match(re); return m ? +m[1] : def; }

function geometria(audXml) {
  const defaults = (audXml.match(/<defaults>[\s\S]*?<\/defaults>/) || [''])[0];
  const W = num(/<page-width>([\d.]+)/, defaults, 1200), H = num(/<page-height>([\d.]+)/, defaults, 1700);
  const margen = (defaults.match(/<page-margins[^>]*>[\s\S]*?<\/page-margins>/) || [''])[0];
  const L = num(/<left-margin>([\d.]+)/, margen, 0), T = num(/<top-margin>([\d.]+)/, margen, 0);

  // Compases de cada parte, en orden, con su <print> si lo hay
  const partes = [...audXml.matchAll(/<part id="([^"]+)">([\s\S]*?)<\/part>/g)].map(m => ({
    id: m[1],
    medidas: [...m[2].matchAll(/<measure number="([^"]+)"([^>]*)>([\s\S]*?)<\/measure>/g)].map(x => ({
      numero: x[1], width: num(/width="([\d.]+)"/, x[2], 0), print: (x[3].match(/<print[^>]*>[\s\S]*?<\/print>|<print[^>]*\/>/) || [''])[0],
    })),
  }));
  const P1 = partes[0].medidas;
  const cajas = []; let pagina = 0, sysLeft = L, x = L, sysTop = T, sysBottom = T + 40, prevBottom = 0;
  for (let i = 0; i < P1.length; i++) {
    const m = P1[i];
    const nuevaPagina = /new-page="yes"/.test(m.print), nuevoSistema = nuevaPagina || /new-system="yes"/.test(m.print) || i === 0;
    if (nuevaPagina) { pagina++; prevBottom = 0; }
    if (nuevoSistema) {
      const sl = num(/<left-margin>([\d.]+)/, m.print, 0);
      sysLeft = L + sl; x = sysLeft;
      const tsd = m.print.match(/<top-system-distance>([\d.]+)/), sd = m.print.match(/<system-distance>([\d.]+)/);
      if (tsd && (i === 0 || nuevaPagina || !prevBottom)) sysTop = T + +tsd[1];
      else if (sd) sysTop = prevBottom + +sd[1];
      else sysTop = prevBottom + 120;
      // altura del sistema: pentagramas de todas las partes
      let bottom = sysTop + 40;
      for (let k = 1; k < partes.length; k++) {
        const mk = partes[k].medidas[i]; const d = mk ? num(/<staff-distance>([\d.]+)/, mk.print, 60) : 60;
        bottom += d + 40;
      }
      sysBottom = bottom; prevBottom = bottom;
    }
    cajas.push({ p: pagina, x0: x / W, x1: (x + m.width) / W, y0: (sysTop - 20) / H, y1: (sysBottom + 45) / H });
    x += m.width;
  }
  return { paginas: pagina + 1, cajas };
}

function posiciones(escXml, audXml) {
  const { paginas, cajas } = geometria(audXml);
  // Correspondencia compás del escáner -> compás de Audiveris, por alineación de notas de la primera voz
  const E = leerPartes(escXml)[0], A = leerPartes(audXml)[0];
  const numerosA = [...new Set(A.tokens.map(t => t.compas))];
  const idxA = Object.fromEntries(numerosA.map((n, i) => [n, i]));
  const numerosE = [...new Set(E.tokens.map(t => t.compas))];
  const votos = {};
  for (const [ia, ja] of alinear(E.tokens, A.tokens).pares) {
    const ce = E.tokens[ia].compas, ca = idxA[A.tokens[ja].compas];
    (votos[ce] = votos[ce] || {})[ca] = (votos[ce][ca] || 0) + 1;
  }
  let ultimo = 0;
  const compases = numerosE.map((ce, i) => {
    const v = votos[ce]; let j = v ? +Object.entries(v).sort((a, b) => b[1] - a[1])[0][0] : Math.min(ultimo + 1, cajas.length - 1);
    if (!v && i === 0) j = 0;
    ultimo = j;
    return cajas[Math.min(j, cajas.length - 1)];
  });
  return { paginas, compases };
}

if (require.main === module) {
  const [esc, aud, out] = process.argv.slice(2);
  if (!out) { console.log('Uso: node posiciones.js escaner.xml audiveris.xml salida.pos.json'); process.exit(1); }
  const r = posiciones(fs.readFileSync(esc, 'utf8'), fs.readFileSync(aud, 'utf8'));
  fs.writeFileSync(out, JSON.stringify(r));
  console.log(`${r.compases.length} compases en ${r.paginas} página(s)`);
}
module.exports = { posiciones };
