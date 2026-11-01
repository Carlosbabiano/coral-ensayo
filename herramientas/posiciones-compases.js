// Mantiene el pos.json (dónde está cada compás en la página original) al partir, fundir, insertar o quitar compases
// del XML desde el gestor: una caja por compás del XML, así que hay que partir o fundir también las cajas.
// El pos.json: { paginas, compases: [{ p, x0, x1, y0, y1 }], manual?, filas?: [{ p, y0, y1, x: [divisorias], omitidas }] }
// Si trae filas (corregido a mano), se editan las filas y las cajas se derivan de ellas, como hace el gestor al guardar.
// Las funciones devuelven el pos.json nuevo (o el mismo si no hay cajas que tocar); i es el índice de la caja (0 = compás 1).
const r4 = v => Math.round(v * 1e4) / 1e4;

// Cajas de unas filas, en orden de lectura (como construirPosiciones en gestor.js)
function cajasDe(filas) {
  const cajas = [];
  for (const f of [...filas].sort((a, b) => a.p - b.p || a.y0 - b.y0)) for (let k = 0; k < f.x.length - 1; k++) if (!(f.omitidas || []).includes(k)) cajas.push({ p: f.p, x0: f.x[k], x1: f.x[k + 1], y0: f.y0, y1: f.y1 });
  return cajas;
}
// Localiza la caja i entre las filas: { f (fila), k (hueco dentro de la fila) }
function localizar(filas, i) {
  let n = 0;
  for (const f of [...filas].sort((a, b) => a.p - b.p || a.y0 - b.y0)) for (let k = 0; k < f.x.length - 1; k++) { if ((f.omitidas || []).includes(k)) continue; if (n === i) return { f, k }; n++; }
  return null;
}
// Desplaza los índices de las cajas omitidas de una fila a partir de un hueco
const desplazar = (f, desde, delta) => { f.omitidas = (f.omitidas || []).map(k => k >= desde ? k + delta : k).filter(k => k >= 0); };
const mismaFila = (a, b) => a && b && a.p === b.p && Math.abs(a.y0 - b.y0) < 0.005 && Math.abs(a.y1 - b.y1) < 0.005;
const clonar = pos => JSON.parse(JSON.stringify(pos));
const conFilas = pos => Array.isArray(pos.filas) && pos.filas.length > 0;
const terminar = pos => { if (conFilas(pos)) { pos.filas = pos.filas.filter(f => f.x.length >= 2); pos.compases = cajasDe(pos.filas); } return pos; };

// Parte la caja i en dos por la proporción r (0..1) de su ancho
function partirCaja(pos, i, r) {
  if (!pos || !Array.isArray(pos.compases) || !pos.compases[i]) return pos;
  pos = clonar(pos); r = Math.min(0.9, Math.max(0.1, +r || 0.5));
  if (conFilas(pos)) {
    const d = localizar(pos.filas, i); if (!d) return pos;
    const x = r4(d.f.x[d.k] + (d.f.x[d.k + 1] - d.f.x[d.k]) * r);
    desplazar(d.f, d.k + 1, 1); d.f.x.splice(d.k + 1, 0, x);
  } else {
    const c = pos.compases[i], x = r4(c.x0 + (c.x1 - c.x0) * r);
    pos.compases.splice(i, 1, { ...c, x1: x }, { ...c, x0: x });
  }
  return terminar(pos);
}
// Funde la caja i con la siguiente (si están en la misma fila; si no, la del compás unido es la primera y la otra desaparece)
function fundirCajas(pos, i) {
  if (!pos || !Array.isArray(pos.compases) || !pos.compases[i] || !pos.compases[i + 1]) return pos;
  pos = clonar(pos);
  if (conFilas(pos)) {
    const a = localizar(pos.filas, i), b = localizar(pos.filas, i + 1); if (!a || !b) return pos;
    if (a.f === b.f && b.k === a.k + 1) { a.f.x.splice(a.k + 1, 1); desplazar(a.f, a.k + 1, -1); }
    else quitarHueco(b); // en otra fila: esa caja deja de contar
  } else {
    const a = pos.compases[i], b = pos.compases[i + 1];
    pos.compases.splice(i, 2, mismaFila(a, b) ? { ...a, x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1) } : a);
  }
  return terminar(pos);
}
// Quita un hueco de una fila (la caja desaparece; si era la única, la fila entera)
function quitarHueco({ f, k }) {
  if (f.x.length <= 2) { f.x = []; return; }
  if (k === 0 || k === f.x.length - 2) { f.x.splice(k === 0 ? 0 : f.x.length - 1, 1); desplazar(f, k === 0 ? 1 : k, k === 0 ? -1 : 0); if (k !== 0) f.omitidas = (f.omitidas || []).filter(o => o < f.x.length - 1); }
  else { f.x.splice(k + 1, 1); desplazar(f, k + 1, -1); } // se funde con la de la derecha
}
// Inserta una caja nueva antes (antes = true) o después de la caja i, partiendo esa en dos mitades
function insertarCaja(pos, i, antes) { return partirCaja(pos, i, 0.5); }
// Quita la caja i: se funde con la anterior de su fila (o con la siguiente si es la primera)
function quitarCaja(pos, i) {
  if (!pos || !Array.isArray(pos.compases) || !pos.compases[i]) return pos;
  if (pos.compases.length < 2) return pos;
  if (i > 0 && mismaFila(pos.compases[i - 1], pos.compases[i])) return fundirCajas(pos, i - 1);
  if (pos.compases[i + 1] && mismaFila(pos.compases[i], pos.compases[i + 1])) return fundirCajas(pos, i);
  pos = clonar(pos);
  if (conFilas(pos)) { const d = localizar(pos.filas, i); if (d) quitarHueco(d); pos.filas = pos.filas.filter(f => f.x.length >= 2); }
  else pos.compases.splice(i, 1);
  return terminar(pos);
}

module.exports = { partirCaja, fundirCajas, insertarCaja, quitarCaja, cajasDe };
