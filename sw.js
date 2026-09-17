// Service worker: guarda la app, las partituras y los sonidos para funcionar sin conexión.
const VERSION = 'coral-v10';
const BASE = ['./', './index.html', './manifest.json', './icono-192.png', './icono-512.png', './icono-512-maskable.png', './apple-touch-icon.png', './partituras/lista.json'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(BASE);
    // Todas las obras de la lista
    try {
      const lista = await (await fetch('./partituras/lista.json', { cache: 'no-store' })).json();
      await cache.addAll(lista.map(o => './partituras/' + o.archivo));
    } catch (err) { console.warn('No se pudieron precargar las partituras', err); }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const propio = url.origin === self.location.origin;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    if (propio) {
      // Archivos de la app: primero red (para recibir actualizaciones), si falla, caché
      try {
        const r = await fetch(e.request);
        if (r.ok) cache.put(e.request, r.clone());
        return r;
      } catch { return (await cache.match(e.request, { ignoreSearch: true })) || Response.error(); }
    }
    // Librerías y sonidos externos: primero caché, si no está, red y se guarda
    const hit = await cache.match(e.request);
    if (hit) return hit;
    const r = await fetch(e.request);
    if (r.ok || r.type === 'opaque') cache.put(e.request, r.clone());
    return r;
  })());
});
