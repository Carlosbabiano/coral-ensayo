// Service worker: guarda la app, las partituras y los sonidos para funcionar sin conexión.
const VERSION = 'coral-v129';
const BASE = ['./', './index.html', './compases.js', './manifest.json', './icono-192.png', './icono-512.png', './icono-512-maskable.png', './apple-touch-icon.png', './pantalla.mp4', './partituras/lista.json'];

// Instalación: solo lo imprescindible (si un archivo fallara, la versión nueva no se instalaría nunca)
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    for (const f of BASE) { try { await cache.add(new Request(f, { cache: 'no-cache' })); } catch (err) { console.warn('No se pudo guardar', f, err); } }
    self.skipWaiting();
  })());
});

// Activación: borrar versiones viejas y, sin bloquear, ir guardando todas las obras
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
    precargarObras(); // en segundo plano
  })());
});

async function precargarObras() {
  try {
    const cache = await caches.open(VERSION);
    const lista = await (await fetch('./partituras/lista.json', { cache: 'no-store' })).json();
    const archivos = lista.flatMap(o => [o.archivo, o.posiciones, ...(o.paginas || []), ...(o.canto || []).flatMap(c => [c.archivo, c.consonantes])].filter(Boolean).map(a => './partituras/' + a));
    for (const f of archivos) {
      if (await cache.match(f)) continue;
      // no-cache: que el navegador no reutilice de su caché HTTP una página o partitura vieja con el mismo nombre
      try { await cache.add(new Request(f, { cache: 'no-cache' })); } catch (err) { console.warn('No se pudo precargar', f); }
    }
  } catch (err) { console.warn('No se pudieron precargar las obras', err); }
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const propio = url.origin === self.location.origin;
  // Archivos que cambian con cada versión (app e índice): primero red, si falla, caché. Se piden saltándose la caché
  // HTTP del navegador (GitHub Pages los sirve con 10 minutos de caducidad): si no, tras publicar se seguía viendo la página vieja
  const volatil = propio && (url.pathname.endsWith('/') || /\/(index\.html|manifest\.json|sw\.js|partituras\/lista\.json)$/.test(url.pathname));
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    if (volatil) {
      try {
        const r = await fetch(e.request.url, { cache: 'no-cache' });
        if (r.ok) cache.put(e.request, r.clone());
        return r;
      } catch { return (await cache.match(e.request, { ignoreSearch: true })) || Response.error(); }
    }
    // Partituras, imágenes, librerías y sonidos: primero caché (rápido y fiable), si no está, red y se guarda.
    // La primera vez de cada versión se pide comprobando con el servidor (no-cache): al actualizar una obra, sus
    // páginas y su partitura se llaman igual que antes, y el navegador las tenía guardadas hasta 10 minutos
    const hit = await cache.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    const r = await fetch(propio ? new Request(e.request, { cache: 'no-cache' }) : e.request);
    if (r.ok || r.type === 'opaque') cache.put(e.request, r.clone());
    return r;
  })());
});
