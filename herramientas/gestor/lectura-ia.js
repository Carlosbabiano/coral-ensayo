// Leer la partitura con IA: la parte de la página del gestor (la del servidor está en herramientas/lectura-ia.js).
// index.html llama a LecturaIA.pintarEleccion(b) cuando un borrador con solo el PDF está sin preparar (elegir Audiveris o
// IA, con el coste estimado), a LecturaIA.pintarProgreso(b) mientras la IA lee (barra, coste y botón «Parar»), a
// LecturaIA.actualizar(m) con cada aviso SSE de tipo 'lectura-ia' y a LecturaIA.informeHtml(b) en el panel de una obra
// lista. Usa de index.html: $, api, esc, seleccionar, tiempoLegible.
(function () {
  const CSS = `
  :root { --lia-fondo: #f5f7fb; --lia-radio: 10px; --lia-espacio: 12px; }
  .lia-opciones { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--lia-espacio); margin-top: 8px; }
  .lia-opcion { border: 1px solid var(--line); border-radius: var(--lia-radio); padding: 12px 14px; background: var(--lia-fondo); display: flex; flex-direction: column; gap: 8px; }
  .lia-opcion h5 { margin: 0; font-size: 15px; }
  .lia-opcion .lia-detalle { font-size: 13px; color: var(--muted); line-height: 1.45; }
  .lia-opcion .acciones { margin: 4px 0 0; }
  .lia-coste { font-weight: 600; }
  .lia-esqueleto { display: inline-block; min-width: 140px; height: 1em; border-radius: 6px; vertical-align: middle; background: linear-gradient(90deg, #e6e8ee 25%, #fff 50%, #e6e8ee 75%); background-size: 200% 100%; animation: lia-brillo 1.4s ease-in-out infinite; }
  @keyframes lia-brillo { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) { .lia-esqueleto { animation: none; } }
  .lia-progreso { margin-top: 10px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--lia-radio); background: var(--lia-fondo); }
  .lia-progreso .barra { margin: 8px 0 6px; }
  .lia-progreso .lia-linea { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 12px; font-size: 13px; color: var(--muted); }
  .lia-opcion select { max-width: 100%; }
  .lia-opcion button:focus-visible, .lia-progreso button:focus-visible { outline: 3px solid #e39b2c; outline-offset: 2px; }`;
  const estilo = document.createElement('style'); estilo.textContent = CSS; document.head.appendChild(estilo);

  const dinero = n => (+n || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $';
  let estadoIA = null;
  async function cargarEstado() { try { estadoIA = await api('/api/lectura-ia'); } catch { estadoIA = null; } return estadoIA; }
  const modeloGuardado = () => { try { return localStorage.getItem('lecturaIA:modelo'); } catch { return null; } };
  const guardarModelo = m => { try { localStorage.setItem('lecturaIA:modelo', m); } catch {} };
  const nombreModelo = id => { const m = estadoIA && estadoIA.modelos.find(x => x.id === id); return m ? m.nombre : id || 'la IA'; };

  // ---------- Elegir cómo leer las notas (borrador con solo el PDF, sin preparar) ----------
  async function pintarEleccion(b) {
    const cont = $('iaEleccion'); if (!cont) return;
    const vigente = () => $('iaEleccion') === cont;
    cont.innerHTML = `<div class="tarjeta"><h4>¿Cómo leer las notas del PDF?</h4><div class="ayuda"><span class="progreso"></span> Comprobando qué hay disponible…</div></div>`;
    await cargarEstado();
    if (!vigente()) return;
    const e = estadoIA || { audiveris: false, clave: false, modelos: [], predeterminado: '' };
    const modelo = e.modelos.some(m => m.id === modeloGuardado()) ? modeloGuardado() : e.predeterminado;
    let html = `<div class="tarjeta"><h4>¿Cómo leer las notas del PDF?</h4>
      <div class="ayuda">No hay XML del Escáner Musical, así que las notas hay que sacarlas de la imagen del PDF. Las dos lecturas dejan la obra lista para revisar en el gestor, con la página original y los compases localizados.</div>
      <div class="lia-opciones">
        <div class="lia-opcion"><h5>Leer con Audiveris</h5>
          <div class="lia-detalle"><strong>Gratis</strong>, en este PC. Tarda uno o dos minutos por página la primera vez. Lee bien las partituras impresas limpias; con escaneos flojos, acordes cifrados o anotaciones a mano se pierde.${e.audiveris ? '' : '<br><span style="color:var(--bad)">Audiveris no está instalado en este PC.</span>'}</div>
          <div class="acciones"><button id="liaAudiveris" ${e.audiveris ? '' : 'disabled'}>Leer con Audiveris</button></div>
        </div>
        <div class="lia-opcion"><h5>Leer con IA</h5>
          <div class="lia-detalle">La API de Claude mira cada sistema de la partitura y escribe las notas y la letra. Cuesta dinero (se paga por consulta) y necesita internet. Se envían a Claude solo las imágenes de la partitura.${e.simulada ? ' <strong>Modo simulado</strong>: no se consulta la API.' : ''}</div>
          ${e.clave ? `<label class="ayuda">Modelo <select id="liaModelo">${e.modelos.map(m => `<option value="${esc(m.id)}" ${m.id === modelo ? 'selected' : ''}>${esc(m.nombre)} (${esc(m.detalle)})</option>`).join('')}</select></label>
          <div class="lia-detalle" id="liaCoste" role="status" aria-live="polite">Coste estimado: <span class="lia-esqueleto" aria-label="calculando"></span><br>Mirando las páginas para contar los compases…</div>
          <div class="acciones"><button class="principal" id="liaLeer" disabled>Leer con IA</button></div>`
          : `<div class="aviso">Falta la clave de la API de Claude. Crea el archivo <code>${esc(e.archivoClave || 'herramientas/clave-api.txt')}</code> con la clave en su primera línea (se consigue en console.anthropic.com; el archivo no se sube al repositorio) y vuelve a abrir este borrador.</div>`}
        </div>
      </div></div>`;
    cont.innerHTML = html;
    $('liaAudiveris') && ($('liaAudiveris').onclick = () => empezar(b, 'audiveris', null));
    const sel = $('liaModelo'), btn = $('liaLeer');
    if (!sel) return;
    let analisis = null;
    const pintarCoste = () => {
      const c = $('liaCoste'); if (!c || !analisis) return;
      const est = analisis.estimaciones && analisis.estimaciones[sel.value];
      c.innerHTML = est ? `Coste estimado: <span class="lia-coste">unos ${dinero(est.coste)}</span> con ${esc(nombreModelo(sel.value))} · ${analisis.consultas} consultas para ${analisis.compases} compases en ${analisis.paginas} página${analisis.paginas === 1 ? '' : 's'}. El coste real se anota en el informe.` : 'No se ha podido estimar el coste con este modelo.';
      btn.textContent = est ? `Leer con IA (unos ${dinero(est.coste)})` : 'Leer con IA';
      btn.disabled = false;
    };
    sel.onchange = () => { guardarModelo(sel.value); pintarCoste(); };
    btn.onclick = () => empezar(b, 'ia', sel.value);
    try {
      analisis = await api(`/api/borradores/${b.id}/lectura-ia/analizar`, { method: 'POST' });
      if (!vigente()) return;
      pintarCoste();
    } catch (err) {
      if (!vigente()) return;
      const c = $('liaCoste');
      if (c) c.innerHTML = `<span style="color:var(--bad)">No se ha podido mirar el PDF para estimar el coste: ${esc(err.message)}</span>`;
      btn.disabled = true;
    }
  }
  async function empezar(b, metodo, modelo) {
    for (const el of document.querySelectorAll('#iaEleccion button')) el.disabled = true;
    try { await api(`/api/borradores/${b.id}/preparar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metodo, modelo }) }); seleccionar(b.id); }
    catch (e) { alert(e.message); pintarEleccion(b); }
  }

  // ---------- Progreso mientras la IA lee ----------
  let ultimoAvance = null; // el último aviso recibido, por si el panel se vuelve a pintar
  function pintarProgreso(b) {
    const cont = $('iaProgreso'); if (!cont) return;
    cont.innerHTML = `<div class="lia-progreso" role="status" aria-live="polite">
      <div><strong>Leyendo la partitura con la IA</strong> (<span id="liaModeloNombre">${esc(nombreModelo(b.modeloIA))}</span>). Puedes seguir usando el gestor; si paras, lo ya leído se guarda y no se paga otra vez.</div>
      <div class="barra" id="liaBarra" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div></div></div>
      <div class="lia-linea"><span id="liaTexto">Preparando las imágenes…</span><span id="liaCuenta"></span></div>
      <div class="acciones"><button class="mini peligro" id="liaParar">Parar la lectura</button></div></div>`;
    $('liaParar').onclick = async () => { $('liaParar').disabled = true; $('liaParar').textContent = 'Parando…'; try { await api(`/api/borradores/${b.id}/preparar/parar`, { method: 'POST' }); } catch (e) { alert(e.message); $('liaParar').disabled = false; $('liaParar').textContent = 'Parar la lectura'; } };
    const previo = ultimoAvance && ultimoAvance.id === b.id ? ultimoAvance : b.progresoIA;
    if (previo) actualizar({ ...previo, id: b.id });
    if (!estadoIA) cargarEstado().then(() => { const t = $('liaModeloNombre'); if (t) t.textContent = nombreModelo(b.modeloIA); });
  }
  function actualizar(m) {
    ultimoAvance = { ...m, id: m.id || (window.borradorActual && borradorActual.id) };
    const barra = $('liaBarra'); if (!barra) return;
    const pct = m.total ? Math.round(100 * m.hechas / m.total) : 0;
    barra.firstElementChild.style.width = pct + '%'; barra.setAttribute('aria-valuenow', pct);
    $('liaTexto').textContent = m.texto || '';
    $('liaCuenta').textContent = `${m.hechas} de ${m.total} consultas · ${dinero(m.coste)} hasta ahora`;
  }

  // ---------- Informe de una obra leída con IA ----------
  function informeHtml(b) {
    const l = b.lecturaIA; if (!l) return '';
    const dudosos = (b.sospechosos || []).length;
    return `<div class="aviso">La partitura la ha leído <strong>la IA</strong> (${esc(l.modelo || 'Claude')}) del PDF, sin XML del Escáner Musical: ${l.consultas} consultas en ${tiempoLegible(l.segundos || 0)}, coste real <strong>${dinero(l.coste)}</strong>${l.cacheadas ? ` (${l.cacheadas} recuperadas de una lectura anterior, sin coste)` : ''}. ${dudosos ? `Quedan <strong>${dudosos} compás${dudosos === 1 ? '' : 'es'} dudoso${dudosos === 1 ? '' : 's'}</strong> de ${l.compases}: revísalos abajo con la página al lado.` : `Los ${l.compases} compases cuadran.`} Comprueba también la letra y las alteraciones.</div>`;
  }

  window.LecturaIA = { pintarEleccion, pintarProgreso, actualizar, informeHtml };
})();
