// Gestor de obras: partir, unir, insertar y quitar compases desde la tarjeta «Compás n» (solo la interfaz; el cambio en
// el XML y en el pos.json lo hace el servidor con gestor-compases.js, que guarda una copia para deshacer).
// Usa las globales de index.html: api, $, esc, borradorActual, notaSel, compasEnRevision, seleccionar.
// Se dibuja dentro de #estructuraCompas cada vez que se enseña un compás (pintarEstructuraCompas(d)).
let ecAvisoPendiente = null; // mensaje que se enseña cuando la tarjeta se vuelve a pintar tras un cambio
let ecOcupado = false;

// Dónde empieza (en negras) la figura seleccionada en la previsualización, si está en este compás
function ecPosicionSeleccion(n) {
  const s = typeof notaSel !== 'undefined' && notaSel;
  if (!s || s.compas !== n || !s.notas || !s.notas[s.indice]) return null;
  let t = 0;
  for (let i = 0; i < s.indice; i++) { const x = s.notas[i]; if (!x.acorde && !x.adorno) t += +x.negras || 0; }
  return { negras: Math.round(t * 1000) / 1000, nombre: s.nombre, figura: s.indice + 1 };
}
function ecEstado(html, clase) {
  const el = $('ecEstado'); if (!el) return;
  el.className = html ? 'aviso ' + (clase || '') : ''; el.innerHTML = html || '';
  if (html) el.focus({ preventScroll: true });
}
function pintarEstructuraCompas(d) {
  const cont = $('estructuraCompas'); if (!cont || !d.voces.length) return;
  const n = d.numero, v0 = d.voces[0], b = borradorActual;
  const dura = Math.max(0, ...d.voces.map(v => +v.suma || 0)), esperado = v0.esperado;
  const sel = ecPosicionSeleccion(n);
  const corte = sel && sel.negras > 0 && sel.negras < dura ? sel.negras : dura > esperado + 0.01 ? esperado : Math.round(dura / 2 * 4) / 4;
  const puntos = b.deshacer || [], ultimo = puntos[puntos.length - 1];
  const sePuedePartir = dura > 0.25;
  cont.innerHTML = `<div class="estructura">
    <h5>Partir, unir, insertar o quitar el compás</h5>
    <div class="ayuda">Si el escáner juntó dos compases de la página en uno, pártelo; si partió uno en dos, únelos. Cambian todas las voces a la vez, los compases siguientes se renumeran y la marca sobre la página se ajusta. Siempre puedes deshacer.</div>
    <div class="acciones" style="margin:8px 0 0">
      <label>Partir en la negra <input type="number" id="ecCorte" min="0.25" max="${Math.max(0.25, dura - 0.25)}" step="0.25" value="${corte}" style="width:80px" ${sePuedePartir ? '' : 'disabled'}></label>
      <button id="ecPartir" ${sePuedePartir ? '' : 'disabled title="Este compás no tiene notas que repartir"'}>Partir aquí</button>
      <span class="ayuda">${sel && sel.negras > 0 ? `justo delante de la figura ${sel.figura} de ${esc(sel.nombre)}` : sePuedePartir ? `el compás dura ${dura} negras; toca una figura en la partitura para partir justo delante de ella` : ''}</span>
    </div>
    <div class="acciones" style="margin:8px 0 0">
      <button id="ecUnir">Unir con el siguiente</button>
      <button id="ecInsertarAntes">Insertar un compás antes</button>
      <button id="ecInsertarDespues">Insertar un compás después</button>
      <span class="hueco"></span>
      <button class="peligro" id="ecQuitar">Quitar el compás</button>
    </div>
    ${ultimo ? `<div class="acciones" style="margin:8px 0 0"><button class="mini" id="ecDeshacer">↶ Deshacer: ${esc(ultimo.descripcion)}</button><span class="ayuda">${puntos.length === 1 ? 'un cambio' : puntos.length + ' cambios'} de compases que se pueden deshacer</span></div>` : ''}
    <div id="ecEstado" role="status" aria-live="polite" tabindex="-1"></div></div>`;
  if (ecAvisoPendiente) { ecEstado(ecAvisoPendiente.texto, ecAvisoPendiente.clase); ecAvisoPendiente = null; }
  const corteElegido = () => { const v = +$('ecCorte').value; if (!(v > 0) || v >= dura) { ecEstado(`El corte tiene que estar entre 0 y ${dura} negras (lo que dura el compás).`, 'mal'); return null; } return v; };
  $('ecPartir').onclick = () => { const v = corteElegido(); if (v != null) ecAccion('partir', n, { enNegras: v }, null, `Compás ${n} partido en dos: ahora son el ${n} y el ${n + 1}.`); };
  $('ecCorte').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('ecPartir').click(); } };
  $('ecUnir').onclick = () => ecAccion('fundir', n, {}, `¿Unir el compás ${n} con el ${n + 1} en todas las voces? Los compases siguientes se renumeran. Podrás deshacerlo.`, `Compases ${n} y ${n + 1} unidos en el ${n}.`);
  $('ecInsertarAntes').onclick = () => ecAccion('insertar', n, { antes: true }, null, `Compás de silencio insertado: es el nuevo ${n}; el de antes pasa a ser el ${n + 1}.`);
  $('ecInsertarDespues').onclick = () => ecAccion('insertar', n, { antes: false }, null, `Compás de silencio insertado: es el nuevo ${n + 1}.`);
  $('ecQuitar').onclick = () => ecAccion('quitar', n, {}, `¿Quitar el compás ${n} en todas las voces? Los compases siguientes se renumeran. Podrás deshacerlo.`, `Compás ${n} quitado.`);
  if ($('ecDeshacer')) $('ecDeshacer').onclick = () => ecAccion('deshacer', n, {}, null, `Deshecho: ${ultimo.descripcion}.`);
}
// Manda la acción al servidor y recarga el borrador entero (previsualización, sospechosos, posiciones y esta tarjeta)
async function ecAccion(accion, n, datos, confirmacion, hecho) {
  if (ecOcupado) return;
  if (confirmacion && !confirm(confirmacion)) return;
  ecOcupado = true;
  for (const bt of document.querySelectorAll('#estructuraCompas button')) bt.disabled = true;
  ecEstado('<span class="progreso" style="width:12px;height:12px;border-width:2px"></span> Cambiando los compases y volviendo a dibujar la obra…', 'progreso');
  try {
    const ruta = accion === 'deshacer' ? `/api/borradores/${borradorActual.id}/compas/deshacer` : `/api/borradores/${borradorActual.id}/compas/${n}/${accion}`;
    const r = await api(ruta, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(datos || {}) });
    ecAvisoPendiente = r.aviso ? { texto: esc(hecho) + ' ' + esc(r.aviso), clase: 'mal' } : { texto: esc(hecho), clase: 'bien' };
    compasEnRevision = r.compas || n;
    ecOcupado = false;
    await seleccionar(borradorActual.id);
  } catch (e) {
    ecOcupado = false;
    for (const bt of document.querySelectorAll('#estructuraCompas button')) bt.disabled = false;
    ecEstado(esc(e.message), 'mal');
  }
}
