// Service worker: guarda la app, las partituras y los sonidos para funcionar sin conexión.
//
// Tres almacenes:
//  - VERSION (coral-vNNN): la app en sí (página, iconos, compases.js…). Cambia con cada publicación.
//  - OBRAS: partituras, páginas, posiciones, voces cantadas y muestras de vocales. NO se borra al actualizar la app:
//    solo se cambia lo que ha cambiado (según partituras/huellas.json) y la copia vieja se queda hasta que la nueva
//    está entera. Antes todo iba en VERSION y cada publicación lo borraba: si en ese momento no había buena conexión,
//    la tablet se quedaba sin partituras.
//  - EXTERNOS: librerías y sonidos de internet (OpenSheetMusicDisplay, smplr, soundfonts). Tampoco se borra.
const VERSION = 'coral-v172';
const OBRAS = 'coral-obras';
const EXTERNOS = 'coral-externos';
const BASE = ['./', './index.html', './compases.js', './manifest.json', './icono-192.png', './icono-512.png', './icono-512-maskable.png', './apple-touch-icon.png', './pantalla.mp4', './partituras/lista.json'];
const LIBRERIAS = ['https://cdn.jsdelivr.net/npm/opensheetmusicdisplay@1/build/opensheetmusicdisplay.min.js', 'https://cdn.jsdelivr.net/npm/opensheetmusicdisplay@1.9.7/build/opensheetmusicdisplay.min.js', 'https://cdn.jsdelivr.net/npm/smplr/+esm'];
const PLAZO_RED = 4000; // ms: con una wifi que no lleva a internet, no dejar la app colgada esperando

const absoluta = r => { const u = new URL(r, self.registration.scope); u.search = ''; u.hash = ''; return u.href; };
const deObras = u => u.origin === self.location.origin && /\/(partituras|voces)\//.test(u.pathname) && !/\/partituras\/(lista|huellas)\.json$/.test(u.pathname);

// Instalación: todo o nada. Si falta algún archivo de la app, esta versión no se instala y el dispositivo sigue con la
// que tenía (antes se instalaba a medias)
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    try {
      const cache = await caches.open(VERSION);
      await cache.addAll(BASE.map(f => new Request(f, { cache: 'no-cache' })));
    } catch (err) { await caches.delete(VERSION); throw err; }
    // Librerías de internet: si ya están, no se tocan; si no, se intentan (sin bloquear la instalación)
    const ext = await caches.open(EXTERNOS);
    for (const u of LIBRERIAS) { if (!(await ext.match(u))) { try { const r = await fetch(u); if (r.ok) await ext.put(u, r); } catch {} } }
    self.skipWaiting();
  })());
});

// Activación: las versiones viejas guardaban también partituras y sonidos; se pasan a los almacenes fijos antes de borrarlas
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const obras = await caches.open(OBRAS), ext = await caches.open(EXTERNOS);
    for (const k of await caches.keys()) {
      if (k === VERSION || k === OBRAS || k === EXTERNOS) continue;
      if (/^coral-v\d+$/.test(k)) {
        const vieja = await caches.open(k);
        for (const req of await vieja.keys()) {
          const u = new URL(req.url), destino = deObras(u) ? obras : u.origin !== self.location.origin ? ext : null;
          if (!destino) continue;
          const clave = deObras(u) ? absoluta(req.url) : req;
          if (!(await destino.match(clave))) { const r = await vieja.match(req); if (r) await destino.put(clave, r); }
        }
      }
      await caches.delete(k);
    }
    await self.clients.claim();
    sincronizar(); // en segundo plano
  })());
});

// ---------- Obras guardadas en el dispositivo ----------
let huellasConocidas = null;   // { url absoluta: huella } de la última huellas.json leída
let estado = { obras: 0, guardadas: 0, sinGuardar: [], descargando: false, fallos: 0, sinDatos: true };
let sincronizando = null;

async function avisar() {
  for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage({ tipo: 'obras', ...estado });
}

async function conPlazo(url, ms) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { cache: 'no-cache', signal: c.signal }); } finally { clearTimeout(t); }
}

// Lee huellas.json (red y, si no hay, la copia guardada). Si el servidor aún no la tiene, la monta con lista.json sin huellas
async function leerHuellas() {
  const app = await caches.open(VERSION);
  for (const nombre of ['huellas.json', 'lista.json']) {
    const url = absoluta('./partituras/' + nombre);
    let r = null, deRed = false;
    try { r = await conPlazo(url, 10000); if (r.ok) { await app.put(url, r.clone()); deRed = true; } else r = null; } catch {}
    if (!r) r = (await app.match(url)) || (await caches.match(url));
    if (!r) continue;
    try {
      const datos = await r.json();
      if (nombre === 'huellas.json') return { ...datos, deRed };
      // Sin huellas: cualquier copia guardada vale
      const archivos = o => [o.sinVoces ? null : o.archivo, o.posiciones, ...(o.paginas || []), ...(o.canto || []).flatMap(c => [c.archivo, c.consonantes])].filter(Boolean);
      return { obras: datos.map(o => ({ titulo: o.titulo, archivos: Object.fromEntries(archivos(o).map(a => ['partituras/' + a, null])) })), comunes: {}, deRed: false };
    } catch {}
  }
  return null;
}

function sincronizar() {
  if (!sincronizando) sincronizando = hacerSincronizacion().catch(err => console.warn('No se pudieron guardar las obras', err)).finally(() => { sincronizando = null; });
  return sincronizando;
}

async function hacerSincronizacion() {
  const h = await leerHuellas();
  if (!h) { estado = { ...estado, descargando: false }; return avisar(); }
  const obras = await caches.open(OBRAS);
  const todos = {}; // url absoluta -> huella
  for (const o of h.obras) for (const [r, hu] of Object.entries(o.archivos)) todos[absoluta('./' + r)] = hu;
  for (const [r, hu] of Object.entries(h.comunes || {})) todos[absoluta('./' + r)] = hu;
  huellasConocidas = todos;

  // Obras retiradas: fuera (solo si la lista es la del servidor, no una copia vieja)
  if (h.deRed) for (const req of await obras.keys()) if (!(absoluta(req.url) in todos)) await obras.delete(req);

  // Qué falta y qué ha cambiado. Lo que falta va primero: una obra que no está no se puede abrir sin conexión, una
  // copia vieja sí. Las copias sin huella (de versiones anteriores de la app) se comprueban aquí mismo calculando su
  // huella, sin volver a bajarlas (antes se bajaban las 24 obras enteras y lo que faltaba quedaba para el final)
  const presente = async url => !!(await obras.match(url));
  const faltan = [], cambiadas = [];
  for (const [url, hu] of Object.entries(todos)) {
    const r = await obras.match(url);
    if (!r) { faltan.push([url, hu]); continue; }
    if (!hu || r.headers.get('x-huella') === hu) continue;
    if (!r.headers.get('x-huella')) {
      try { const datos = await r.blob(); if ((await huellaDe(datos)) === hu) { await obras.put(url, conCabecera(datos, r, hu)); continue; } } catch {}
    }
    cambiadas.push([url, hu]);
  }
  // Primero los archivos de las obras con menos cosas por bajar: así se completan obras enteras cuanto antes
  const pesoObra = {};
  for (const o of h.obras) { const urls = Object.keys(o.archivos).map(r => absoluta('./' + r)); const n = urls.filter(u => faltan.some(([f]) => f === u)).length; for (const u of urls) pesoObra[u] = n; }
  faltan.sort((a, b) => (pesoObra[a[0]] ?? 1e9) - (pesoObra[b[0]] ?? 1e9));
  const pendientes = [...faltan, ...cambiadas];

  // Qué obras están enteras en el dispositivo; de las que no, se avisa a la app con su partitura (para marcarlas)
  const repasar = async () => {
    let g = 0; const sinGuardar = [];
    for (const o of h.obras) {
      let ok = true; for (const r of Object.keys(o.archivos)) if (!(await presente(absoluta('./' + r)))) { ok = false; break; }
      if (ok) g++; else { const xml = Object.keys(o.archivos).find(r => r.endsWith('.xml')); sinGuardar.push(xml ? xml.replace(/^partituras\//, '') : o.titulo); }
    }
    return { guardadas: g, sinGuardar };
  };
  estado = { obras: h.obras.length, ...(await repasar()), descargando: pendientes.length > 0, fallos: 0, sinDatos: false };
  await avisar();
  if (!pendientes.length) return;

  // Descarga de 4 en 4. Cada archivo nuevo sustituye al viejo solo cuando ha llegado entero
  let i = 0, fallos = 0, hechos = 0;
  const trabajador = async () => {
    while (i < pendientes.length) {
      const [url, hu] = pendientes[i++];
      try {
        const r = await conPlazo(url, 60000);
        if (!r.ok) throw new Error(r.status);
        await obras.put(url, await conHuella(r, hu));
      } catch { fallos++; }
      if (++hechos % 4 === 0) { Object.assign(estado, await repasar(), { fallos }); await avisar(); }
    }
  };
  await Promise.all([trabajador(), trabajador(), trabajador(), trabajador()]);
  estado = { ...estado, ...(await repasar()), descargando: false, fallos };
  await avisar();
}

// Huella de un archivo: las 12 primeras cifras de su SHA-1, igual que la calcula el programa de publicar (obra.js)
async function huellaDe(blob) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-1', await blob.arrayBuffer()));
  return [...d].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}
function conCabecera(datos, r, hu) {
  const cab = new Headers(r.headers); cab.set('x-huella', hu);
  return new Response(datos, { status: r.status, statusText: r.statusText, headers: cab });
}

async function conHuella(r, hu) {
  return hu ? conCabecera(await r.blob(), r, hu) : r;
}

// La app pide el estado al abrirse (y entonces se retoma la descarga si quedó a medias) y al pulsar «Descargar ahora»
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.tipo === 'descargar') e.waitUntil(sincronizar());
  else if (d.tipo === 'estado') e.waitUntil(estado.sinDatos ? sincronizar() : avisar());
});

// ---------- Peticiones ----------
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const propio = url.origin === self.location.origin;
  // Archivos que cambian con cada versión (app e índice): primero red, si falla o tarda, caché. Se piden saltándose la
  // caché HTTP del navegador (GitHub Pages los sirve con 10 minutos de caducidad): si no, tras publicar se seguía viendo la página vieja
  const volatil = propio && (url.pathname.endsWith('/') || /\/(index\.html|manifest\.json|sw\.js|partituras\/(lista|huellas)\.json)$/.test(url.pathname));
  e.respondWith((async () => {
    if (volatil) {
      const app = await caches.open(VERSION);
      const guardada = async () => (await app.match(e.request, { ignoreSearch: true })) || (await caches.match(e.request, { ignoreSearch: true })) ||
        (e.request.mode === 'navigate' ? await app.match('./index.html') : null);
      try {
        const r = await conPlazo(e.request.url, PLAZO_RED);
        if (r.ok) app.put(e.request, r.clone());
        return r;
      } catch {
        const g = await guardada();
        if (g) return g;
        return fetch(e.request.url, { cache: 'no-cache' }).catch(() => Response.error());
      }
    }
    // Partituras, imágenes, librerías y sonidos: primero caché (rápido y fiable), si no está, red y se guarda.
    // La primera vez se pide comprobando con el servidor (no-cache): al actualizar una obra, sus páginas y su partitura
    // se llaman igual que antes, y el navegador las tenía guardadas hasta 10 minutos
    const obra = deObras(url);
    const hit = await caches.match(obra ? absoluta(e.request.url) : e.request, { ignoreSearch: true });
    if (hit) return hit;
    const r = await fetch(propio ? new Request(e.request, { cache: 'no-cache' }) : e.request);
    if (r.ok || r.type === 'opaque') {
      const copia = r.clone();
      e.waitUntil((async () => {
        if (obra) { const clave = absoluta(e.request.url); await (await caches.open(OBRAS)).put(clave, await conHuella(copia, huellasConocidas && huellasConocidas[clave])); }
        else await (await caches.open(propio ? VERSION : EXTERNOS)).put(e.request, copia);
      })().catch(() => {}));
    }
    return r;
  })());
});
