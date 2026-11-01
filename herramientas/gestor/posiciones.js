// Editor de los compases en la página original (Gestor de obras).
// Enseña cada página del borrador con las cajas del pos.json dibujadas y numeradas, y deja corregirlas a mano cuando el
// detector automático falla: arrastrar divisorias y bordes, partir o fundir cajas, unir, partir o quitar filas (sistemas).
// Tras cada cambio los compases se renumeran en orden de lectura y se comparan con los del XML. Guardar manda las FILAS
// al servidor (POST /api/borradores/<id>/posiciones), que las valida y escribe el pos.json con "manual": true.
//
// Estado: ep = { b, paginas: [archivo], compasesXml: [{ num, barra, cambio }], filas: [{ id, p, y0, y1, x: [...], omitidas: Set }],
//               historial: [filas], futuro: [filas], sucio, armado (esperando un toque para crear una fila), cargando, error }
// Las coordenadas son fracciones del ancho y del alto de la página (como en el pos.json). Usa `api` y `esc` de la página del gestor.
(function () {
const $ = id => document.getElementById(id);
const MIN_ANCHO = 0.006, MIN_ALTO = 0.02, PASO = 0.002, PASO_GRANDE = 0.01, MAX_HISTORIAL = 200;
let ep = null, siguienteId = 1, toque = null, menuAbierto = null;

const clonar = filas => filas.map(f => ({ ...f, x: [...f.x], omitidas: new Set(f.omitidas) }));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const nuevaFila = (p, y0, y1, x, omitidas) => ({ id: siguienteId++, p, y0, y1, x: [...x], omitidas: new Set(omitidas || []) });

// ---------- Filas a partir del pos.json ----------
// Si el archivo trae filas (guardado desde aquí) se usan; si no, se agrupan las cajas del detector por página y por solape
// vertical, se quitan las repetidas y las divisorias salen de sus bordes
function filasDesde(pos) {
  if (!pos) return [];
  if (Array.isArray(pos.filas) && pos.filas.length) return pos.filas.map(f => nuevaFila(f.p, f.y0, f.y1, f.x, f.omitidas));
  const grupos = [];
  for (const c of pos.compases || []) {
    if (!c) continue;
    let g = grupos.find(g => g.p === c.p && Math.min(g.y1, c.y1) - Math.max(g.y0, c.y0) > 0.5 * Math.min(g.y1 - g.y0, c.y1 - c.y0));
    if (!g) { g = { p: c.p, y0: c.y0, y1: c.y1, xs: [] }; grupos.push(g); }
    g.y0 = Math.min(g.y0, c.y0); g.y1 = Math.max(g.y1, c.y1); g.xs.push(c.x0, c.x1);
  }
  return grupos.map(g => {
    const x = [];
    for (const v of g.xs.sort((a, b) => a - b)) if (!x.length || v - x[x.length - 1] > 0.004) x.push(v);
    return nuevaFila(g.p, g.y0, g.y1, x);
  });
}
const ordenadas = () => [...ep.filas].sort((a, b) => a.p - b.p || a.y0 - b.y0);

// ---------- Numeración en orden de lectura y resumen contra el XML ----------
function numerar() {
  let n = 0; const rangos = {};
  for (const f of ordenadas()) {
    f.numeros = [];
    for (let k = 0; k < f.x.length - 1; k++) {
      if (f.omitidas.has(k)) { f.numeros.push(null); continue; }
      n++; f.numeros.push(n);
      const r = rangos[f.p] || (rangos[f.p] = { desde: n, hasta: n, omitidas: 0 }); r.hasta = n;
    }
    for (const k of f.omitidas) if (k < f.x.length - 1) (rangos[f.p] || (rangos[f.p] = { desde: 0, hasta: 0, omitidas: 0 })).omitidas++;
  }
  return { total: n, rangos };
}
// Texto corto del compás del XML para la etiqueta: «18‖» si termina en doble barra o barra final, «9♩» si cambia de compás
function marcaXml(n) {
  const c = ep.compasesXml[n - 1]; if (!c) return '';
  return (c.barra ? '‖' : '') + (c.cambio ? '·' : '');
}
function renumerar() {
  const { total, rangos } = numerar();
  const nXml = ep.compasesXml.length;
  for (const f of ep.filas) {
    const el = elementoFila(f); if (!el) continue;
    el.querySelectorAll('.ep-num').forEach((b, k) => {
      const n = f.numeros[k];
      b.textContent = n ? n + marcaXml(n) : '—';
      b.title = n ? `Compás ${n}` + (marcaXml(n).includes('‖') ? ' (en el XML termina con doble barra)' : '') + '. Toca para marcar que no está en el XML' : 'Esta caja no cuenta (no está en el XML). Toca para volver a contarla';
      b.setAttribute('aria-label', (n ? `Compás ${n}` : 'Caja sin compás') + ', caja ' + (k + 1) + ' de la fila');
      b.parentElement.classList.toggle('omitida', !n);
      if (n && n > nXml) b.parentElement.classList.add('sobra'); else b.parentElement.classList.remove('sobra');
    });
    el.querySelectorAll('.ep-mano.v').forEach((m, k) => m.setAttribute('aria-label', etiquetaMano(f, k)));
  }
  ep.paginas.forEach((_, p) => {
    const r = rangos[p], el = document.querySelector(`[data-rango="${p}"]`); if (!el) return;
    el.textContent = !r || !r.hasta ? '· sin compases' : `· compases ${r.desde}${r.hasta > r.desde ? '–' + r.hasta : ''}` + (r.omitidas ? ` (${r.omitidas} caja${r.omitidas > 1 ? 's' : ''} fuera del XML)` : '');
  });
  const res = $('epResumen');
  const dif = total - nXml;
  res.textContent = `${total} compases en la página · ${nXml} en el XML` + (dif === 0 ? ' ✓ cuadran' : dif > 0 ? ` · sobran ${dif}: funde cajas o márcalas como fuera del XML` : ` · faltan ${-dif}: parte cajas o añade filas`);
  res.className = 'ep-resumen ' + (dif === 0 ? 'bien' : 'mal');
  $('epGuardar').disabled = dif !== 0 || !ep.filas.length;
  $('epGuardar').title = dif === 0 ? 'Guardar en el borrador (Ctrl+S)' : 'Para guardar, la página tiene que tener tantos compases como el XML';
  $('epDeshacer').disabled = !ep.historial.length; $('epRehacer').disabled = !ep.futuro.length;
}
function etiquetaMano(f, k) {
  const n = f.x.length - 1;
  if (k === 0) return `Borde izquierdo de la fila (compás ${f.numeros && f.numeros[0] || 'sin número'}). Flechas para mover, Supr quita la primera caja`;
  if (k === n) return `Borde derecho de la fila (compás ${f.numeros && f.numeros[n - 1] || 'sin número'}). Flechas para mover, Supr quita la última caja`;
  return `Divisoria entre los compases ${f.numeros && f.numeros[k - 1] || '?'} y ${f.numeros && f.numeros[k] || '?'}. Flechas para mover, Supr funde los dos`;
}

// ---------- Dibujo ----------
function crearDialogo() {
  if ($('editorPos')) return $('editorPos');
  const d = document.createElement('dialog');
  d.id = 'editorPos'; d.className = 'editorPos'; d.setAttribute('aria-labelledby', 'epTitulo');
  d.innerHTML = `
    <header class="ep-cab">
      <div class="ep-titulo"><h3 id="epTitulo">Compases en la página</h3><div id="epResumen" class="ep-resumen" aria-live="polite"></div></div>
      <div class="ep-acciones" role="toolbar" aria-label="Acciones del editor">
        <button type="button" class="mini" id="epDeshacer" disabled title="Deshacer (Ctrl+Z)">Deshacer</button>
        <button type="button" class="mini" id="epRehacer" disabled title="Rehacer (Ctrl+Y)">Rehacer</button>
        <button type="button" class="mini" id="epNuevaFila" aria-pressed="false" title="Añade una fila (un sistema) donde toques en la página">Nueva fila</button>
        <span class="hueco"></span>
        <button type="button" id="epCerrar">Cerrar</button>
        <button type="button" class="principal" id="epGuardar">Guardar posiciones</button>
      </div>
    </header>
    <div id="epEstado" class="ep-estado" role="status" aria-live="polite"></div>
    <div id="epCuerpo" class="ep-cuerpo"></div>
    <footer class="ep-ayuda">
      <strong>Cómo se corrige:</strong> toca dentro de una caja para partirla en dos · toca una divisoria para fundir las dos cajas (en los extremos, quita la caja) ·
      arrastra divisorias y bordes para ajustarlos (con el teclado: Tab hasta la divisoria, flechas y Supr; Mayús mueve más) ·
      toca el número de una caja si ese compás no está en el XML · el botón de la izquierda de cada fila la une con la de abajo, la parte en dos o la quita ·
      <strong>‖</strong> señala los compases que en el XML terminan con doble barra o barra final: deben caer al final de una sección.
    </footer>`;
  document.body.appendChild(d);
  $('epCerrar').onclick = cerrar;
  $('epGuardar').onclick = guardar;
  $('epDeshacer').onclick = deshacer;
  $('epRehacer').onclick = rehacer;
  $('epNuevaFila').onclick = () => armar(!ep.armado);
  d.addEventListener('cancel', ev => { ev.preventDefault(); if (menuAbierto) return cerrarMenu(); if (ep && ep.armado) return armar(false); cerrar(); });
  // Los atajos se escuchan en el documento: tras repintar, el foco puede haberse quedado en el cuerpo de la página
  document.addEventListener('keydown', ev => {
    if (!ep || !d.open || (ev.target.closest && ev.target.closest('input, textarea, select'))) return;
    const z = ev.key === 'z' || ev.key === 'Z', y = ev.key === 'y' || ev.key === 'Y', s = ev.key === 's' || ev.key === 'S';
    if ((ev.ctrlKey || ev.metaKey) && z && !ev.shiftKey) { ev.preventDefault(); deshacer(); }
    else if ((ev.ctrlKey || ev.metaKey) && (y || (z && ev.shiftKey))) { ev.preventDefault(); rehacer(); }
    else if ((ev.ctrlKey || ev.metaKey) && s) { ev.preventDefault(); if (!$('epGuardar').disabled) guardar(); }
  });
  d.addEventListener('click', ev => { if (menuAbierto && !ev.target.closest('.ep-menu, .ep-etiqueta')) cerrarMenu(); });
  return d;
}
function estado(texto, clase = '') { const e = $('epEstado'); if (!e) return; e.className = 'ep-estado ' + clase; e.innerHTML = (clase === 'progreso' ? '<span class="progreso"></span> ' : '') + esc(texto); }

function pintarTodo() {
  const cuerpo = $('epCuerpo');
  if (ep.cargando) { cuerpo.innerHTML = '<div class="ep-esqueleto" role="status" aria-label="Cargando las páginas"></div>'; $('epResumen').textContent = 'Cargando las páginas…'; return; }
  if (ep.error) { cuerpo.innerHTML = `<div class="ep-vacio"><p>No se han podido cargar las páginas: ${esc(ep.error)}</p><button type="button" id="epReintentar">Volver a intentarlo</button></div>`; $('epReintentar').onclick = cargar; $('epResumen').textContent = ''; return; }
  let html = '';
  ep.paginas.forEach((archivo, p) => {
    html += `<section class="ep-pagina" data-p="${p}"><h4>Página ${p + 1} <span class="ep-rango" data-rango="${p}"></span></h4>
      <div class="ep-lienzo"><div class="ep-margen" data-margen="${p}"></div>
      <div class="ep-hoja"><img src="/borrador/${ep.b.id}/partituras/${encodeURIComponent(archivo)}?t=${ep.t}" alt="Página ${p + 1} de la partitura" decoding="async"><div class="ep-capa" data-p="${p}"></div></div></div></section>`;
  });
  cuerpo.innerHTML = html;
  for (const capa of cuerpo.querySelectorAll('.ep-capa')) {
    capa.addEventListener('pointerdown', ev => {
      const mano = ev.target.closest('.ep-mano');
      if (mano) return empezarArrastre(ev, mano, filaDeElemento(mano));
      if (ev.target.closest('.ep-num')) return;
      toque = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
    });
    capa.addEventListener('pointerup', ev => {
      if (!toque || toque.id !== ev.pointerId) return;
      const movido = Math.hypot(ev.clientX - toque.x, ev.clientY - toque.y) > 6; toque = null;
      if (movido || ev.target.closest('.ep-mano, .ep-num')) return;
      tocarPagina(+capa.dataset.p, fraccion(capa, ev));
    });
  }
  pintarFilas();
}
// Qué tenía el foco dentro de las páginas (para devolvérselo tras repintar, que destruye los elementos)
function focoActual() {
  const a = document.activeElement; if (!a || !a.closest || !a.closest('#epCuerpo')) return null;
  const filaEl = a.closest('[data-fila]'); if (!filaEl) return null;
  return { fila: +filaEl.dataset.fila, mano: a.classList.contains('ep-mano') ? a.dataset.tipo : null, k: +a.dataset.k || 0, num: a.classList.contains('ep-num'), etiqueta: a.classList.contains('ep-etiqueta') };
}
function restaurarFoco(f) {
  if (!f) return;
  const fila = ep.filas.find(x => x.id === f.fila), el = fila && elementoFila(fila);
  let objetivo = null;
  if (!el) objetivo = null;
  else if (f.etiqueta) objetivo = document.querySelector(`#epCuerpo .ep-etiqueta[data-fila="${f.fila}"]`);
  else if (f.num) { const bs = el.querySelectorAll('.ep-num'); objetivo = bs[Math.min(f.k, bs.length - 1)]; }
  else if (f.mano === 'v') { const ms = el.querySelectorAll('.ep-mano.v'); objetivo = ms[Math.min(f.k, ms.length - 1)]; }
  else if (f.mano) objetivo = el.querySelector('.ep-mano.' + f.mano);
  try { (objetivo || $('epDeshacer')).focus({ preventScroll: true }); } catch {}
}
function pintarFilas() {
  const foco = focoActual();
  numerar();
  for (const capa of document.querySelectorAll('#epCuerpo .ep-capa')) capa.innerHTML = '';
  for (const m of document.querySelectorAll('#epCuerpo .ep-margen')) m.innerHTML = '';
  if (!ep.filas.length && ep.paginas.length) estado('No hay ninguna caja todavía. Pulsa «Nueva fila» y toca en la página donde va cada sistema; luego parte la fila en compases tocando dentro.', 'aviso');
  const porPagina = {};
  for (const f of ordenadas()) {
    const capa = document.querySelector(`#epCuerpo .ep-capa[data-p="${f.p}"]`), margen = document.querySelector(`#epCuerpo .ep-margen[data-margen="${f.p}"]`);
    if (!capa) continue;
    const indice = porPagina[f.p] = (porPagina[f.p] || 0) + 1;
    const n = f.x.length - 1;
    const el = document.createElement('div'); el.className = 'ep-fila'; el.dataset.fila = f.id;
    let html = '';
    for (let k = 0; k < n; k++) html += `<div class="ep-caja"><button type="button" class="ep-num" data-k="${k}"></button></div>`;
    for (let k = 0; k <= n; k++) html += `<div class="ep-mano v${k === 0 || k === n ? ' extremo' : ''}" data-tipo="v" data-k="${k}" tabindex="0" role="slider" aria-orientation="horizontal"></div>`;
    html += `<div class="ep-mano h arriba" data-tipo="arriba" tabindex="0" role="slider" aria-orientation="vertical" aria-label="Borde superior de la fila ${indice}. Flechas arriba y abajo para moverlo"></div>
      <div class="ep-mano h abajo" data-tipo="abajo" tabindex="0" role="slider" aria-orientation="vertical" aria-label="Borde inferior de la fila ${indice}. Flechas arriba y abajo para moverlo"></div>`;
    el.innerHTML = html;
    for (const b of el.querySelectorAll('.ep-num')) b.onclick = () => alternarOmitida(f, +b.dataset.k);
    for (const m of el.querySelectorAll('.ep-mano')) m.addEventListener('keydown', ev => teclaMano(ev, f, m));
    capa.appendChild(el);
    const et = document.createElement('button'); et.type = 'button'; et.className = 'ep-etiqueta mini'; et.dataset.fila = f.id; et.textContent = 'F' + indice;
    et.title = `Fila ${indice} de la página ${f.p + 1}: ${n} caja${n === 1 ? '' : 's'}. Toca para ver las opciones; arrastra para mover la fila`;
    et.setAttribute('aria-label', `Fila ${indice} de la página ${f.p + 1}, ${n} cajas. Opciones de la fila`);
    et.setAttribute('aria-haspopup', 'menu');
    et.addEventListener('pointerdown', ev => empezarArrastre(ev, et, f, 'mover'));
    et.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); abrirMenu(f, et); } });
    margen.appendChild(et);
    colocarFila(f);
  }
  renumerar();
  restaurarFoco(foco);
}
const elementoFila = f => document.querySelector(`#epCuerpo .ep-fila[data-fila="${f.id}"]`);
const filaDeElemento = el => ep.filas.find(f => f.id === +el.closest('[data-fila]').dataset.fila);
function colocarFila(f) {
  const el = elementoFila(f); if (!el) return;
  const n = f.x.length - 1, W = f.x[n] - f.x[0] || 1e-6;
  Object.assign(el.style, { left: f.x[0] * 100 + '%', width: W * 100 + '%', top: f.y0 * 100 + '%', height: (f.y1 - f.y0) * 100 + '%' });
  el.querySelectorAll('.ep-caja').forEach((c, k) => { c.style.left = (f.x[k] - f.x[0]) / W * 100 + '%'; c.style.width = (f.x[k + 1] - f.x[k]) / W * 100 + '%'; });
  el.querySelectorAll('.ep-mano.v').forEach((m, k) => { m.style.left = (f.x[k] - f.x[0]) / W * 100 + '%'; m.setAttribute('aria-valuenow', Math.round(f.x[k] * 1000) / 10); m.setAttribute('aria-valuetext', `${Math.round(f.x[k] * 100)} % del ancho`); });
  const arriba = el.querySelector('.ep-mano.arriba'), abajo = el.querySelector('.ep-mano.abajo');
  arriba.setAttribute('aria-valuenow', Math.round(f.y0 * 1000) / 10); arriba.setAttribute('aria-valuetext', `${Math.round(f.y0 * 100)} % del alto`);
  abajo.setAttribute('aria-valuenow', Math.round(f.y1 * 1000) / 10); abajo.setAttribute('aria-valuetext', `${Math.round(f.y1 * 100)} % del alto`);
  const et = document.querySelector(`#epCuerpo .ep-etiqueta[data-fila="${f.id}"]`); if (et) et.style.top = f.y0 * 100 + '%';
}
function fraccion(capa, ev) {
  const r = capa.getBoundingClientRect();
  return { fx: clamp((ev.clientX - r.left) / r.width, 0, 1), fy: clamp((ev.clientY - r.top) / r.height, 0, 1) };
}
const capaDe = p => document.querySelector(`#epCuerpo .ep-capa[data-p="${p}"]`);

// ---------- Cambios con historial ----------
function cambiar(descripcion, fn, clase = '') {
  ep.historial.push(clonar(ep.filas)); if (ep.historial.length > MAX_HISTORIAL) ep.historial.shift();
  ep.futuro = [];
  fn();
  marcarSucio(); pintarFilas();
  if (descripcion) estado(descripcion + ' (Ctrl+Z deshace)', clase);
}
function marcarSucio() { ep.sucio = true; }
function deshacer() { if (!ep || !ep.historial.length) return; ep.futuro.push(clonar(ep.filas)); ep.filas = ep.historial.pop(); marcarSucio(); pintarFilas(); estado('Deshecho.'); }
function rehacer() { if (!ep || !ep.futuro.length) return; ep.historial.push(clonar(ep.filas)); ep.filas = ep.futuro.pop(); marcarSucio(); pintarFilas(); estado('Rehecho.'); }

// Toque en la página fuera de las manos: parte la caja tocada (o crea una fila si está armado «Nueva fila»)
function tocarPagina(p, { fx, fy }) {
  if (ep.armado) return crearFila(p, fy);
  const f = filaEn(p, fx, fy);
  if (!f) return estado('Ahí no hay ninguna fila. Para crear una, pulsa «Nueva fila» y toca donde va.', 'aviso');
  partirCaja(f, fx);
}
function filaEn(p, fx, fy) {
  const dentro = ep.filas.filter(f => f.p === p && fx >= f.x[0] && fx <= f.x[f.x.length - 1] && fy >= f.y0 && fy <= f.y1);
  return dentro.sort((a, b) => (a.y1 - a.y0) * (a.x[a.x.length - 1] - a.x[0]) - (b.y1 - b.y0) * (b.x[b.x.length - 1] - b.x[0]))[0] || null;
}
function desplazarOmitidas(f, desde, delta, quitar) {
  const nuevas = new Set();
  for (const k of f.omitidas) { if (quitar !== undefined && k === quitar) continue; nuevas.add(k >= desde ? k + delta : k); }
  f.omitidas = nuevas;
}
function partirCaja(f, fx) {
  const k = f.x.findIndex((v, i) => i < f.x.length - 1 && fx > v && fx < f.x[i + 1]); if (k < 0) return;
  if (fx - f.x[k] < MIN_ANCHO || f.x[k + 1] - fx < MIN_ANCHO) return estado('Demasiado cerca de una divisoria: toca más hacia el centro de la caja (o arrastra la divisoria).', 'aviso');
  const n = f.numeros[k];
  cambiar(n ? `Caja partida: ahora son los compases ${n} y ${n + 1}.` : 'Caja partida en dos.', () => { f.x.splice(k + 1, 0, fx); desplazarOmitidas(f, k + 1, 1); });
}
function fundir(f, k) {
  const n = f.x.length - 1;
  if (k === 0 || k === n) {
    if (n === 1) return estado('Es la única caja de la fila: para quitarla entera, usa el botón de la fila (a la izquierda) y «Quitar la fila».', 'aviso');
    const num = f.numeros[k === 0 ? 0 : n - 1];
    return cambiar(num ? `Caja del compás ${num} quitada.` : 'Caja quitada.', () => { if (k === 0) { f.x.shift(); desplazarOmitidas(f, 1, -1, 0); } else { f.x.pop(); desplazarOmitidas(f, n, 0, n - 1); } });
  }
  const a = f.numeros[k - 1], b = f.numeros[k];
  cambiar(a && b ? `Divisoria quitada: los compases ${a} y ${b} quedan fundidos en el ${a}.` : 'Divisoria quitada: las dos cajas quedan fundidas.', () => { f.x.splice(k, 1); desplazarOmitidas(f, k + 1, -1, k); });
}
function alternarOmitida(f, k) {
  const estaba = f.omitidas.has(k), n = f.numeros[k];
  cambiar(estaba ? 'La caja vuelve a contar como compás.' : `El compás ${n} de la página ya no cuenta: los siguientes se renumeran.`, () => { if (estaba) f.omitidas.delete(k); else f.omitidas.add(k); });
}
function armar(si) {
  ep.armado = si;
  $('epNuevaFila').setAttribute('aria-pressed', si ? 'true' : 'false'); $('epNuevaFila').classList.toggle('activa', si);
  for (const c of document.querySelectorAll('#epCuerpo .ep-capa')) c.classList.toggle('armada', si);
  estado(si ? 'Toca en la página a la altura donde va la fila nueva (Esc para cancelar).' : 'Fila nueva cancelada.', si ? 'aviso' : '');
}
function crearFila(p, fy) {
  armar(false);
  const enPagina = ep.filas.filter(f => f.p === p), cerca = enPagina.sort((a, b) => Math.abs((a.y0 + a.y1) / 2 - fy) - Math.abs((b.y0 + b.y1) / 2 - fy))[0];
  const h = cerca ? cerca.y1 - cerca.y0 : 0.18, y0 = clamp(fy - h / 2, 0, 1 - h);
  const x = cerca ? [...cerca.x] : [0.03, 0.97];
  cambiar(`Fila nueva en la página ${p + 1} con ${x.length - 1} caja${x.length === 2 ? '' : 's'}${cerca ? ' (copiadas de la fila más cercana)' : ''}: ajusta sus bordes y divisorias.`, () => { ep.filas.push(nuevaFila(p, y0, y0 + h, x)); });
}
function filaSiguiente(f) { return ordenadas().filter(g => g.p === f.p && g.y0 > f.y0)[0] || null; }
function unirAbajo(f) {
  const g = filaSiguiente(f); if (!g) return estado('No hay otra fila debajo en esta página.', 'aviso');
  cambiar('Filas unidas en una sola.', () => {
    const base = g.x.length > f.x.length && f.x.length === 2 ? g : f; // si la de arriba solo tiene una caja, manda la de abajo
    f.x = [...base.x]; f.omitidas = new Set(base.omitidas); f.y0 = Math.min(f.y0, g.y0); f.y1 = Math.max(f.y1, g.y1);
    ep.filas = ep.filas.filter(h => h !== g);
  });
}
function partirFila(f) {
  const mitad = (f.y0 + f.y1) / 2;
  if (f.y1 - f.y0 < MIN_ALTO * 3) return estado('La fila es demasiado baja para partirla.', 'aviso');
  cambiar('Fila partida en dos (con las mismas divisorias): ajusta los bordes de cada una.', () => { const y1 = f.y1; f.y1 = mitad - 0.004; ep.filas.push(nuevaFila(f.p, mitad + 0.004, y1, f.x, f.omitidas)); });
}
function duplicarDebajo(f) {
  const h = f.y1 - f.y0, y0 = clamp(f.y1 + 0.02, 0, 1 - h);
  cambiar('Fila copiada debajo: muévela arrastrando su botón y ajusta los bordes.', () => { ep.filas.push(nuevaFila(f.p, y0, y0 + h, f.x)); });
}
function quitarFila(f) { cambiar('Fila quitada.', () => { ep.filas = ep.filas.filter(h => h !== f); }); }

// ---------- Arrastre (divisorias, bordes y mover la fila) ----------
function empezarArrastre(ev, mano, f, tipo = mano.dataset.tipo) {
  if (ev.button !== undefined && ev.button !== 0) return;
  ev.preventDefault();
  const capa = capaDe(f.p), k = +mano.dataset.k, antes = clonar(ep.filas), inicio = fraccion(capa, ev), y0i = f.y0, y1i = f.y1;
  let movido = false;
  const mover = e => {
    if (!movido && Math.hypot(e.clientX - ev.clientX, e.clientY - ev.clientY) < 4) return;
    movido = true;
    const { fx, fy } = fraccion(capa, e);
    if (tipo === 'v') f.x[k] = limitarX(f, k, fx);
    else if (tipo === 'arriba') f.y0 = clamp(fy, 0, f.y1 - MIN_ALTO);
    else if (tipo === 'abajo') f.y1 = clamp(fy, f.y0 + MIN_ALTO, 1);
    else if (tipo === 'mover') { const h = y1i - y0i; f.y0 = clamp(y0i + (fy - inicio.fy), 0, 1 - h); f.y1 = f.y0 + h; }
    colocarFila(f);
  };
  const soltar = () => {
    mano.removeEventListener('pointermove', mover); mano.removeEventListener('pointerup', soltar); mano.removeEventListener('pointercancel', soltar);
    try { mano.releasePointerCapture(ev.pointerId); } catch {}
    if (movido) { ep.historial.push(antes); if (ep.historial.length > MAX_HISTORIAL) ep.historial.shift(); ep.futuro = []; marcarSucio(); pintarFilas(); estado(tipo === 'v' ? 'Divisoria movida.' : tipo === 'mover' ? 'Fila movida.' : 'Borde movido.'); }
    else if (tipo === 'v') fundir(f, k);
    else if (tipo === 'mover') abrirMenu(f, mano);
  };
  try { mano.setPointerCapture(ev.pointerId); } catch {}
  mano.addEventListener('pointermove', mover); mano.addEventListener('pointerup', soltar); mano.addEventListener('pointercancel', soltar);
}
function limitarX(f, k, fx) {
  const n = f.x.length - 1;
  const min = k === 0 ? 0 : f.x[k - 1] + MIN_ANCHO, max = k === n ? 1 : f.x[k + 1] - MIN_ANCHO;
  return clamp(fx, min, max);
}
// Teclado sobre una divisoria o un borde: flechas mueven (Mayús: más), Supr funde o quita
function teclaMano(ev, f, mano) {
  const tipo = mano.dataset.tipo, k = +mano.dataset.k, paso = ev.shiftKey ? PASO_GRANDE : PASO;
  let d = 0;
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') d = -paso; else if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') d = paso;
  else if ((ev.key === 'Delete' || ev.key === 'Backspace') && tipo === 'v') { ev.preventDefault(); const n = f.x.length - 1; fundir(f, k); enfocarMano(f, Math.min(k, Math.max(0, n - 1))); return; }
  else return;
  if ((tipo === 'v') !== (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) return;
  ev.preventDefault();
  // Las pulsaciones seguidas sobre la misma mano son un solo paso del historial
  const clave = f.id + ':' + tipo + ':' + k;
  if (!ep.ultimaTecla || ep.ultimaTecla.clave !== clave || Date.now() - ep.ultimaTecla.t > 1500) { ep.historial.push(clonar(ep.filas)); ep.futuro = []; }
  ep.ultimaTecla = { clave, t: Date.now() };
  if (tipo === 'v') f.x[k] = limitarX(f, k, f.x[k] + d);
  else if (tipo === 'arriba') f.y0 = clamp(f.y0 + d, 0, f.y1 - MIN_ALTO);
  else f.y1 = clamp(f.y1 + d, f.y0 + MIN_ALTO, 1);
  marcarSucio(); colocarFila(f); renumerar();
}
function enfocarMano(f, k) { const el = elementoFila(f); const m = el && el.querySelectorAll('.ep-mano.v')[k]; if (m) m.focus(); }

// ---------- Menú de la fila ----------
function abrirMenu(f, boton) {
  cerrarMenu();
  const menu = document.createElement('div'); menu.className = 'ep-menu'; menu.setAttribute('role', 'menu');
  const indice = ordenadas().filter(g => g.p === f.p).indexOf(f) + 1;
  const sig = filaSiguiente(f);
  menu.innerHTML = `<div class="ep-menu-titulo">Fila ${indice} · página ${f.p + 1} · ${f.x.length - 1} caja${f.x.length === 2 ? '' : 's'}</div>
    <button type="button" role="menuitem" data-a="unir" ${sig ? '' : 'disabled'}>Unir con la fila de abajo</button>
    <button type="button" role="menuitem" data-a="partir">Partir en dos filas</button>
    <button type="button" role="menuitem" data-a="duplicar">Copiar la fila debajo</button>
    <button type="button" role="menuitem" data-a="quitar" class="peligro">Quitar la fila</button>`;
  const r = boton.getBoundingClientRect();
  menu.style.left = Math.min(r.right + 6, window.innerWidth - 250) + 'px'; menu.style.top = Math.min(r.top, window.innerHeight - 200) + 'px';
  $('editorPos').appendChild(menu);
  menuAbierto = { menu, boton };
  for (const b of menu.querySelectorAll('button')) b.onclick = () => { const a = b.dataset.a; cerrarMenu(); ({ unir: unirAbajo, partir: partirFila, duplicar: duplicarDebajo, quitar: quitarFila })[a](f); };
  menu.addEventListener('keydown', ev => {
    const items = [...menu.querySelectorAll('button:not([disabled])')], i = items.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cerrarMenu(); }
  });
  menu.querySelector('button:not([disabled])').focus();
}
function cerrarMenu() { if (!menuAbierto) return; const { menu, boton } = menuAbierto; menuAbierto = null; menu.remove(); try { boton.focus(); } catch {} }

// ---------- Cargar, guardar y cerrar ----------
async function cargar() {
  ep.cargando = true; ep.error = null; pintarTodo();
  try {
    const r = await api(`/api/borradores/${ep.b.id}/posiciones`);
    ep.paginas = r.paginas; ep.compasesXml = r.compases; ep.filas = filasDesde(r.posiciones); ep.cargando = false;
    pintarTodo();
    if (ep.filas.length) estado(r.posiciones && r.posiciones.manual ? 'Posiciones corregidas a mano anteriormente. Comprueba que cada número cae en su compás.' : 'Posiciones del detector automático. Comprueba que cada número cae en su compás y corrige lo que no cuadre.');
  } catch (e) { ep.cargando = false; ep.error = e.message; pintarTodo(); }
}
async function guardar() {
  if (!ep || $('epGuardar').disabled) return;
  const filas = ordenadas().map(f => ({ p: f.p, y0: f.y0, y1: f.y1, x: f.x, omitidas: [...f.omitidas] }));
  $('epGuardar').disabled = true; estado('Guardando…', 'progreso');
  try {
    const r = await api(`/api/borradores/${ep.b.id}/posiciones`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filas }) });
    ep.sucio = false;
    const actual = typeof borradorActual !== 'undefined' ? borradorActual : null; // el borrador abierto en el gestor (variable de la página)
    if (actual && actual.id === ep.b.id) { actual.posicionesInfo = r.posicionesInfo; if (typeof window.pintarAvisoPosiciones === 'function') window.pintarAvisoPosiciones(); }
    let recargada = false;
    try { const w = $('previa') && $('previa').contentWindow; recargada = !!(w && w.recargarPosiciones && await w.recargarPosiciones()); } catch {}
    if (!recargada) { try { $('previa').contentWindow.location.reload(); } catch {} }
    estado('Guardado. La previsualización ya usa las posiciones nuevas: reproduce la obra y comprueba que la barra cae en el compás correcto.', 'bien');
  } catch (e) { estado('No se ha podido guardar: ' + e.message, 'mal'); }
  renumerar();
}
function cerrar() {
  if (!ep) return;
  if (ep.sucio && !confirm('Hay cambios sin guardar en las posiciones. ¿Cerrar sin guardarlos?')) return;
  cerrarMenu();
  const d = $('editorPos'); d.close(); $('epCuerpo').innerHTML = ''; ep = null;
  if (window.botonRevisarPaginas) { try { window.botonRevisarPaginas.focus(); } catch {} }
}
window.abrirEditorPosiciones = function (b, boton) {
  if (!b || !b.entrada || !b.entrada.paginas) return;
  window.botonRevisarPaginas = boton || null;
  // Se suelta la nota que hubiera seleccionada en la previsualización: las flechas y Supr son ahora del editor de páginas
  try { if (typeof notaSel !== 'undefined' && notaSel) { notaSel = null; if (typeof pintarBarraNota === 'function') pintarBarraNota(); } } catch {}
  const d = crearDialogo();
  ep = { b, t: Date.now(), paginas: [], compasesXml: [], filas: [], historial: [], futuro: [], sucio: false, armado: false, cargando: true, error: null };
  d.showModal();
  estado('');
  cargar();
};
// Texto de la tarjeta «Comprobaciones» sobre la página original y sus posiciones
window.avisoPosicionesHtml = function (b) {
  const info = b.posicionesInfo || {};
  const n = b.entrada.paginas.length, paginas = `${n} página${n === 1 ? '' : 's'}`;
  const boton = `<button type="button" class="mini" id="revisarPaginas">Revisar compases en la página</button>`;
  if (info.incompleto) return `<div class="aviso mal" id="avisoPosiciones">La página original (${paginas}) está, pero no se ha podido localizar en ella ningún compás. Colócalos a mano: ${boton} Hasta entonces, la obra se publicaría sin página original.</div>`;
  if (info.manual) return `<div class="aviso bien" id="avisoPosiciones">Página original sacada del PDF (${paginas}): es lo que verá el coro. Los compases están colocados a mano (${info.n} compases). ${boton}</div>`;
  const descuadre = info.nXml != null && info.n !== info.nXml ? ` <strong>La página tiene ${info.n} compases y el XML ${info.nXml}.</strong>` : '';
  return `<div class="aviso ${descuadre ? '' : 'bien'}" id="avisoPosiciones">Página original sacada del PDF (${paginas}): es lo que verá el coro. Los compases los ha localizado el detector automático.${descuadre} Si la marca no cae donde debe, corrígelos: ${boton}</div>`;
};
})();
