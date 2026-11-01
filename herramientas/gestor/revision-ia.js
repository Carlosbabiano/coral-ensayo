// Revisión con IA de los compases dudosos: la parte de la página del gestor (la del servidor está en herramientas/revision-ia.js).
// index.html solo llama a RevisionIA.pintarLote(b) al pintar el panel del borrador y a RevisionIA.pintarCompas(b, d) al abrir
// la tarjeta de un compás; todo lo demás (botones, estados, propuesta, lote con progreso) vive aquí.
// Usa de index.html: $, api, esc, borradorActual, seleccionar, revisarCompas, pintarChips, compasEnRevision.
(function () {
  const CSS = `
  :root { --ia-mas: #eaf5ea; --ia-menos: #fdecec; --ia-mas-fg: #1e5c22; --ia-menos-fg: #8a1c16; --ia-fondo: #f5f7fb; --ia-radio: 10px; }
  .ia-caja { margin-top: 12px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--ia-radio); background: var(--ia-fondo); }
  .ia-cab { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; margin-bottom: 6px; }
  .ia-cab strong { font-size: 15px; }
  .ia-chip { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 12.5px; font-weight: 600; border: 1px solid transparent; }
  .ia-chip.bien { background: #eaf5ea; color: var(--ok); border-color: #bfe0c0; }
  .ia-chip.aviso { background: #fff7e6; color: var(--warn); border-color: #f3dcae; }
  .ia-chip.mal { background: #fdecec; color: var(--bad); border-color: #f0bcb9; }
  .ia-explica { margin: 6px 0 10px; }
  table.ia-comparar { border-collapse: collapse; width: 100%; font-size: 14px; }
  table.ia-comparar th { text-align: left; font-size: 12px; color: var(--muted); font-weight: 600; padding: 2px 8px 4px 0; }
  table.ia-comparar td { vertical-align: top; padding: 6px 8px 6px 0; border-top: 1px solid var(--line); }
  table.ia-comparar td:first-child { white-space: nowrap; }
  .ia-lista { margin: 0; padding: 0; list-style: none; }
  .ia-lista li { padding: 0 4px; border-radius: 4px; }
  .ia-lista li.mas { background: var(--ia-mas); color: var(--ia-mas-fg); }
  .ia-lista li.menos { background: var(--ia-menos); color: var(--ia-menos-fg); text-decoration: line-through; }
  .ia-vacio { color: var(--muted); font-style: italic; }
  .ia-caja details { margin-top: 8px; }
  .ia-caja details img { display: block; max-width: 100%; height: auto; margin-top: 6px; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
  .ia-espera { display: flex; gap: 10px; align-items: center; padding: 10px 0; color: var(--muted); }
  table.ia-resumen { border-collapse: collapse; width: 100%; font-size: 14px; margin-top: 8px; }
  table.ia-resumen td { padding: 5px 8px 5px 0; border-top: 1px solid var(--line); vertical-align: top; }
  table.ia-resumen td:first-child a { font-weight: 600; cursor: pointer; text-decoration: underline; color: var(--accent); }
  .ia-caja .barra { margin: 8px 0 4px; }
  .ia-caja .acciones { margin: 10px 0 0; }
  .ia-caja button:focus-visible, .ia-caja a:focus-visible { outline: 3px solid #e39b2c; outline-offset: 2px; }
  @media (max-width: 700px) { table.ia-comparar, table.ia-comparar thead, table.ia-comparar tr, table.ia-comparar td { display: block; } table.ia-comparar th { display: none; } table.ia-comparar td { border-top: 0; padding: 2px 0; } table.ia-comparar tr { border-top: 1px solid var(--line); padding: 6px 0; } }`;
  const estilo = document.createElement('style'); estilo.textContent = CSS; document.head.appendChild(estilo);

  let estadoIA = null;   // GET /api/revision-ia: clave, modelo, coste estimado
  let fuenteLote = null; // avisos del lote en marcha (SSE)
  const dinero = n => (+n || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 3 }) + ' $';
  const CONFIANZA = { alta: ['Confianza alta', 'bien'], media: ['Confianza media', 'aviso'], baja: ['Confianza baja', 'mal'] };
  const chipConfianza = c => { const [t, k] = CONFIANZA[c] || CONFIANZA.baja; return `<span class="ia-chip ${k}">${t}</span>`; };
  const plural = (n, uno, varios) => n === 1 ? uno : varios.replace('#', n);
  async function cargarEstado() { try { estadoIA = await api('/api/revision-ia'); } catch { estadoIA = null; } return estadoIA; }
  const sinClaveHtml = () => `<div class="aviso"><strong>Revisar con IA:</strong> falta la clave de la API de Claude. Crea el archivo <code>${esc(estadoIA.archivoClave)}</code> con la clave en su primera línea (se consigue en console.anthropic.com; el archivo no se sube al repositorio) y vuelve a cargar esta página.</div>`;
  const textoPrivacidad = () => `Se envía a Claude solo el recorte de la página de ese compás y sus figuras, nada más de la obra. Coste aproximado: ${dinero(estadoIA.costeEstimado)} por compás${estadoIA.simulada ? ' (modo simulado: no se consulta la API)' : ''}. No se cambia nada hasta que pulses «Aplicar».`;
  const privacidadHtml = () => `<span class="ayuda">${textoPrivacidad()}</span>`;
  function errorHtml(e, reintentar) {
    if (e.tipo === 'sin-clave') return sinClaveHtml();
    const titulo = e.tipo === 'sin-internet' ? 'Sin conexión' : e.tipo === 'sin-pagina' ? 'Sin imagen de la página' : 'La IA no ha podido revisar este compás';
    return `<div class="aviso mal" role="alert"><strong>${titulo}:</strong> ${esc(e.message)}${reintentar ? ` <button class="mini" id="${reintentar}">Reintentar</button>` : ''}</div>`;
  }

  // ---------- Tarjeta de un compás ----------
  async function pintarCompas(b, d) {
    const cont = $('iaCompas'); if (!cont) return;
    const vigente = () => $('iaCompas') === cont;
    if (!d.pagina || !d.posicion) { cont.innerHTML = '<div class="ayuda" style="margin-top:10px">Sin imagen de la página original no hay nada que la IA pueda mirar.</div>'; return; }
    cont.innerHTML = '<div class="ia-espera"><span class="progreso"></span> Comprobando la revisión con IA…</div>';
    await cargarEstado();
    if (!vigente()) return;
    if (!estadoIA) { cont.innerHTML = ''; return; }
    if (!estadoIA.clave) { cont.innerHTML = sinClaveHtml(); return; }
    let p = null;
    try { p = (await api(`/api/borradores/${b.id}/compas/${d.numero}/revisar`)).propuesta; } catch {}
    if (!vigente()) return;
    if (p) pintarPropuesta(cont, b, p); else pintarBoton(cont, b, d.numero);
  }
  function pintarBoton(cont, b, n) {
    cont.innerHTML = `<div class="acciones" style="margin:10px 0 0"><button class="principal" id="iaRevisar">Revisar con IA</button>${privacidadHtml()}</div>`;
    $('iaRevisar').onclick = () => pedir(cont, b, n);
  }
  async function pedir(cont, b, n) {
    cont.innerHTML = `<div class="ia-caja"><div class="ia-espera" role="status" aria-live="polite"><span class="progreso"></span> Preguntando a la IA por el compás ${n}… suele tardar entre 20 segundos y un minuto.</div></div>`;
    const vigente = () => $('iaCompas') === cont;
    try {
      const p = await api(`/api/borradores/${b.id}/compas/${n}/revisar`, { method: 'POST' });
      if (vigente()) pintarPropuesta(cont, b, p);
    } catch (e) {
      if (!vigente()) return;
      cont.innerHTML = errorHtml(e, 'iaReintentar');
      if ($('iaReintentar')) $('iaReintentar').onclick = () => pedir(cont, b, n);
    }
  }
  // Las figuras en dos listas: lo que leyó el escáner (tachado lo que desaparece) y lo que propone la IA (en verde lo nuevo)
  function listas(actuales, propuestas) {
    const cuenta = l => l.reduce((m, t) => (m[t] = (m[t] || 0) + 1, m), {});
    const enP = cuenta(propuestas), enA = cuenta(actuales);
    const marcar = (lista, otra, clase) => lista.length ? `<ul class="ia-lista">${lista.map(t => { const queda = otra[t] > 0; if (queda) otra[t]--; return `<li class="${queda ? '' : clase}">${esc(t)}</li>`; }).join('')}</ul>` : '<span class="ia-vacio">vacío</span>';
    return [marcar(actuales, enP, 'menos'), marcar(propuestas, enA, 'mas')];
  }
  function pintarPropuesta(cont, b, p) {
    const n = p.numero;
    const aplicables = p.voces.filter(v => v.cuadra && !v.igual && !v.sinPropuesta);
    let html = `<div class="ia-caja" aria-live="polite"><div class="ia-cab"><strong>Propuesta de la IA para el compás ${n}</strong> ${chipConfianza(p.confianza)}${p.aplicada ? ' <span class="ia-chip bien">Aplicada</span>' : ''}<span class="ayuda">${esc(p.modelo)} · ${dinero(p.coste)} · ${Math.round((p.duracion || 0) / 1000)} s</span></div>`;
    html += `<p class="ia-explica">${esc(p.explicacion)}</p>`;
    if (p.indicacion) { const [bt1, bt2] = p.indicacion.split('/'); html += `<div class="aviso">La IA ve en la página un compás de <strong>${esc(p.indicacion)}</strong>, distinto del que dice el XML. <button class="mini" id="iaCompas34" data-beats="${esc(bt1)}" data-bt="${esc(bt2)}">Poner ${esc(p.indicacion)} en este compás</button> <span class="ayuda">(el siguiente vuelve al compás de antes)</span></div>`; }
    for (const a of p.avisos || []) html += `<div class="aviso">${esc(a)}</div>`;
    html += `<table class="ia-comparar"><thead><tr><th>Voz</th><th>Lo que leyó el escáner</th><th>Lo que propone la IA</th></tr></thead><tbody>`;
    for (const v of p.voces) {
      const [la, lp] = listas(v.actuales || [], v.propuestas || []);
      const estado = v.sinPropuesta ? '<span class="ayuda">sin propuesta</span>' : v.igual ? '<span class="ayuda">sin cambios</span>' : v.cuadra ? `<span style="color:var(--ok);font-weight:600">cuadra: ${v.suma} de ${v.esperado} ✓</span>` : `<span style="color:var(--bad);font-weight:600">no cuadra: ${v.suma} de ${v.esperado}</span>`;
      html += `<tr><td><strong>${esc(v.nombre)}</strong><br>${estado}</td><td>${la}</td><td>${v.sinPropuesta ? '<span class="ia-vacio">—</span>' : lp}</td></tr>`;
    }
    html += `</tbody></table>`;
    html += `<details><summary class="ayuda">Lo que ha visto la IA (recorte enviado)</summary><img src="${p.recorte.imagen}" width="${p.recorte.ancho}" height="${p.recorte.alto}" alt="Recorte de la página con el compás ${n} dentro de un marco naranja"></details>`;
    if (p.aplicada) html += `<div class="acciones"><span class="ayuda">Las figuras de arriba ya son las del XML. Si algo no está bien, corrígelo con «Editar».</span><span class="hueco"></span><button class="mini" id="iaOtraVez">Volver a preguntar</button></div>`;
    else {
      const sinNada = !aplicables.length;
      const parcial = aplicables.length && aplicables.length < p.voces.filter(v => !v.igual && !v.sinPropuesta).length;
      html += `<div class="acciones"><button class="principal" id="iaAplicar" ${sinNada ? 'disabled' : ''} title="${sinNada ? 'No hay nada que aplicar' : 'Escribe en el XML las figuras propuestas'}">${parcial ? 'Aplicar las voces que cuadran' : 'Aplicar'}</button><button id="iaDescartar">Descartar</button>
        <span class="ayuda">${sinNada ? (p.cambia ? 'La propuesta no cuadra, así que no se aplica: corrige el compás con «Editar» mirando el recorte.' : 'La IA no propone cambios en las figuras.') : parcial ? 'Las voces que no cuadran se dejan como están.' : 'Lo aplicado queda anotado en el registro del borrador.'}</span>
        <span class="hueco"></span><button class="mini" id="iaOtraVez">Volver a preguntar</button></div>`;
    }
    html += `</div>`;
    cont.innerHTML = html;
    if ($('iaAplicar')) $('iaAplicar').onclick = () => aplicar(cont, b, n);
    if ($('iaDescartar')) $('iaDescartar').onclick = async () => { try { await api(`/api/borradores/${b.id}/compas/${n}/revisar/descartar`, { method: 'POST' }); } catch {} pintarBoton(cont, b, n); };
    if ($('iaOtraVez')) $('iaOtraVez').onclick = () => pedir(cont, b, n);
    if ($('iaCompas34')) $('iaCompas34').onclick = async () => {
      const bt = $('iaCompas34');
      try { await api(`/api/borradores/${b.id}/compas/${n}/tiempo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ beats: +bt.dataset.beats, bt: +bt.dataset.bt, restaurar: true }) }); await seleccionar(b.id); } catch (e) { alert(e.message); }
    };
  }
  async function aplicar(cont, b, n) {
    const bt = $('iaAplicar'); if (bt) { bt.disabled = true; bt.textContent = 'Aplicando…'; }
    try {
      const r = await api(`/api/borradores/${b.id}/compas/${n}/revisar/aplicar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      borradorActual.sospechosos = r.borrador.sospechosos; pintarChips();
      await seleccionar(b.id); // vuelve a dibujar el compás con las figuras nuevas y recarga la previsualización
    } catch (e) {
      alert(e.message);
      if ($('iaAplicar')) { $('iaAplicar').disabled = false; $('iaAplicar').textContent = 'Aplicar'; }
    }
  }

  // ---------- Todos los sospechosos de la obra, en segundo plano ----------
  async function pintarLote(b) {
    if (fuenteLote) { fuenteLote.close(); fuenteLote = null; }
    const cont = $('iaLote'); if (!cont || !b || b.estado !== 'listo' || !b.entrada || !b.entrada.paginas) return;
    const vigente = () => $('iaLote') === cont;
    await cargarEstado();
    if (!vigente() || !estadoIA) return;
    if (!estadoIA.clave) { if (b.sospechosos.length) cont.innerHTML = sinClaveHtml(); return; }
    let datos = { lote: null, propuestas: {} };
    try { datos = await api(`/api/borradores/${b.id}/revisar-todos`); } catch {}
    if (!vigente()) return;
    if (datos.lote && datos.lote.estado === 'en marcha') { pintarProgreso(cont, b, datos.lote); seguirLote(cont, b); }
    else if (datos.lote) pintarResumen(cont, b, datos.lote, datos.propuestas);
    else pintarBotonLote(cont, b); // las propuestas pedidas compás a compás se ven en la tarjeta de cada compás
  }
  function pintarBotonLote(cont, b) {
    const n = b.sospechosos.length;
    if (!n) { cont.innerHTML = ''; return; }
    cont.innerHTML = `<div class="acciones" style="margin:8px 0 0"><button id="iaTodos">Revisar todos con IA</button><span class="ayuda">${plural(n, 'Un compás', '# compases')} que no cuadran; unos ${dinero(estadoIA.costeEstimado * n)} en total. ${textoPrivacidad()}</span></div>`;
    $('iaTodos').onclick = async () => {
      $('iaTodos').disabled = true;
      try { const lote = await api(`/api/borradores/${b.id}/revisar-todos`, { method: 'POST' }); pintarProgreso(cont, b, lote); seguirLote(cont, b); }
      catch (e) { cont.innerHTML = errorHtml(e, 'iaLoteReintentar'); if ($('iaLoteReintentar')) $('iaLoteReintentar').onclick = () => pintarBotonLote(cont, b); }
    };
  }
  function pintarProgreso(cont, b, l) {
    const pct = l.total ? Math.round(100 * l.hechos / l.total) : 0;
    const ahora = l.enCurso.length ? ` (${plural(l.enCurso.length, 'ahora el ' + l.enCurso[0], 'ahora los ' + l.enCurso.join(' y '))})` : '';
    cont.innerHTML = `<div class="ia-caja" role="status" aria-live="polite"><div class="ia-cab"><span class="progreso"></span> <strong>Revisando con IA…</strong> <span>${l.hechos} de ${l.total} compases${ahora} · ${dinero(l.coste)} hasta ahora</span><span class="hueco" style="flex:1"></span><button class="mini peligro" id="iaParar">Parar</button></div>
      <div class="barra" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Compases revisados"><div style="width:${pct}%"></div></div>
      <span class="ayuda">Puedes seguir usando el gestor; las propuestas van apareciendo en la tarjeta de cada compás. Nada se aplica sin que lo pidas.</span></div>`;
    $('iaParar').onclick = async () => { $('iaParar').disabled = true; try { await api(`/api/borradores/${b.id}/revisar-todos/parar`, { method: 'POST' }); } catch (e) { alert(e.message); } };
  }
  function seguirLote(cont, b) {
    if (fuenteLote) fuenteLote.close();
    const f = fuenteLote = new EventSource(`/api/borradores/${b.id}/eventos`);
    f.onmessage = async ev => {
      const m = JSON.parse(ev.data);
      if (m.tipo !== 'ia' || $('iaLote') !== cont) return;
      if (m.lote.estado === 'en marcha') return pintarProgreso(cont, b, m.lote);
      f.close(); if (fuenteLote === f) fuenteLote = null;
      let propuestas = {}; try { propuestas = (await api(`/api/borradores/${b.id}/revisar-todos`)).propuestas; } catch {}
      if ($('iaLote') !== cont) return;
      pintarResumen(cont, b, m.lote, propuestas);
      // Si la tarjeta de un compás está abierta, que enseñe ya su propuesta
      if ($('iaCompas') && compasEnRevision) pintarCompas(borradorActual, { numero: compasEnRevision, pagina: true, posicion: true });
    };
    f.onerror = () => {};
  }
  function pintarResumen(cont, b, l, propuestas) {
    const numeros = l.numeros;
    const filas = numeros.map(n => ({ n, r: l.resultados[n], p: propuestas[n] }));
    const ok = filas.filter(f => f.p), errores = filas.filter(f => f.r && !f.r.ok);
    const aplicables = ok.filter(f => f.p.cuadra && f.p.cambia && !f.p.aplicada), aplicadas = ok.filter(f => f.p.aplicada), noCuadran = ok.filter(f => !f.p.cuadra), sinCambios = ok.filter(f => f.p.cuadra && !f.p.cambia && !f.p.aplicada);
    const quedan = b.sospechosos.length;
    let html = `<div class="ia-caja"><div class="ia-cab"><strong>Revisión con IA</strong><span>${plural(numeros.length, 'un compás revisado', '# compases revisados')} · ${dinero(l.coste)}${l.estado === 'cancelado' ? ' · parada antes de terminar' : ''}</span></div>`;
    const partes = [];
    if (aplicables.length) partes.push(`<strong>${plural(aplicables.length, 'una propuesta cuadra', '# propuestas cuadran')}</strong> y se pueden aplicar`);
    if (aplicadas.length) partes.push(plural(aplicadas.length, 'una ya aplicada', '# ya aplicadas'));
    if (noCuadran.length) partes.push(plural(noCuadran.length, 'una no cuadra (revísala a mano)', '# no cuadran (revísalas a mano)'));
    if (sinCambios.length) partes.push(plural(sinCambios.length, 'una sin cambios', '# sin cambios'));
    if (errores.length) partes.push(plural(errores.length, 'un error', '# errores'));
    html += `<div>${partes.join(' · ')}.</div>`;
    html += `<div class="${quedan ? 'ayuda' : ''}" style="margin-top:4px;${quedan ? '' : 'color:var(--ok);font-weight:600'}">${quedan ? plural(quedan, 'Queda un compás que no cuadra.', 'Quedan # compases que no cuadran.') : 'Ahora cuadran todos los compases.'}</div>`;
    html += `<table class="ia-resumen"><tbody>`;
    for (const f of filas) {
      let estado, texto = '';
      if (f.r && !f.r.ok) { estado = '<span class="ia-chip mal">Error</span>'; texto = esc(f.r.error); }
      else if (!f.p) { estado = '<span class="ayuda">sin revisar</span>'; }
      else { estado = chipConfianza(f.p.confianza) + ' ' + (f.p.aplicada ? '<span class="ia-chip bien">Aplicada</span>' : f.p.cuadra ? (f.p.cambia ? '<span class="ia-chip bien">Cuadra</span>' : '<span class="ia-chip aviso">Sin cambios</span>') : '<span class="ia-chip mal">No cuadra</span>'); texto = esc(f.p.explicacion) + (f.p.indicacion ? ` <strong>(ve un compás de ${esc(f.p.indicacion)})</strong>` : ''); }
      const boton = f.p && f.p.cuadra && f.p.cambia && !f.p.aplicada ? `<button class="mini" data-ia-aplicar="${f.n}">Aplicar</button>` : '';
      html += `<tr><td><a data-ia-ver="${f.n}" href="#" aria-label="Ver el compás ${f.n}">${f.n}</a></td><td style="white-space:nowrap">${estado}</td><td>${texto}</td><td>${boton}</td></tr>`;
    }
    html += `</tbody></table><div class="acciones">`;
    if (aplicables.length) html += `<button class="principal" id="iaAplicarTodas">Aplicar las ${aplicables.length === 1 ? 'que cuadra' : aplicables.length + ' que cuadran'}</button>`;
    if (b.sospechosos.length) html += `<button class="mini" id="iaOtraVuelta">Volver a revisar los que no cuadran</button>`;
    html += `<span class="hueco"></span><button class="mini" id="iaCerrarResumen">Quitar este resumen</button></div></div>`;
    cont.innerHTML = html;
    for (const a of cont.querySelectorAll('a[data-ia-ver]')) a.onclick = e => { e.preventDefault(); revisarCompas(+a.dataset.iaVer); };
    for (const bt of cont.querySelectorAll('button[data-ia-aplicar]')) bt.onclick = () => aplicarVarias(b, [+bt.dataset.iaAplicar]);
    if ($('iaAplicarTodas')) $('iaAplicarTodas').onclick = () => { if (confirm(`¿Aplicar las ${aplicables.length} propuestas que cuadran? Cada una queda anotada en el registro y puedes retocarlas después con «Editar».`)) aplicarVarias(b, aplicables.map(f => f.n)); };
    if ($('iaOtraVuelta')) $('iaOtraVuelta').onclick = async () => {
      $('iaOtraVuelta').disabled = true;
      try { const lote = await api(`/api/borradores/${b.id}/revisar-todos`, { method: 'POST' }); pintarProgreso(cont, b, lote); seguirLote(cont, b); } catch (e) { alert(e.message); pintarLote(b); }
    };
    if ($('iaCerrarResumen')) $('iaCerrarResumen').onclick = async () => { try { await api(`/api/borradores/${b.id}/revisar-todos/quitar`, { method: 'POST' }); } catch (e) { return alert(e.message); } pintarBotonLote(cont, b); };
  }
  async function aplicarVarias(b, numeros) {
    for (const bt of document.querySelectorAll('#iaLote button')) bt.disabled = true;
    const fallos = [];
    for (const n of numeros) { try { await api(`/api/borradores/${b.id}/compas/${n}/revisar/aplicar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) { fallos.push(`compás ${n}: ${e.message}`); } }
    if (fallos.length) alert('No se ha podido aplicar en:\n' + fallos.join('\n'));
    await seleccionar(b.id);
  }

  window.RevisionIA = { pintarCompas, pintarLote };
})();
