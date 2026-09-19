// Gestor de obras: servidor local para añadir partituras con previsualización antes de publicar.
// Uso: node herramientas/gestor.js   (o "Gestor.cmd"). Abre http://localhost:5180 en el navegador.
//
// Carpetas:  borradores/<id>/entrada/     archivos tal como se subieron (xml, pdf)
//            borradores/<id>/partituras/  obra preparada (xml con letra, pos.json, imágenes de página)
//            borradores/<id>/obra.json    estado, avisos, voces, registro
// Rutas web: /                         la página del gestor
//            /borrador/<id>/            la app de verdad mostrando solo ese borrador (previsualización)
//            /app/                      la app tal como está en el PC (lo publicado + lo pendiente de publicar)
const http = require('http'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const obra = require('./obra.js');

const PUERTO = +process.env.PUERTO || 5180;
const DIR_GESTOR = path.join(__dirname, 'gestor');
const DIR_BORRADORES = path.join(obra.RAIZ, 'borradores');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.xml': 'application/xml; charset=utf-8', '.musicxml': 'application/xml; charset=utf-8', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

fs.mkdirSync(DIR_BORRADORES, { recursive: true });

// ---------- Borradores ----------
const idValido = id => /^[a-z0-9-]{3,60}$/.test(id);
const dirDe = id => path.join(DIR_BORRADORES, id);
const rutaObraJson = id => path.join(dirDe(id), 'obra.json');
function leerBorrador(id) { try { return JSON.parse(fs.readFileSync(rutaObraJson(id), 'utf8')); } catch { return null; } }
function guardarBorrador(b) { fs.writeFileSync(rutaObraJson(b.id), JSON.stringify(b, null, 2)); }
function listarBorradores() {
  return fs.readdirSync(DIR_BORRADORES).map(leerBorrador).filter(Boolean).sort((a, b) => b.creado.localeCompare(a.creado));
}
function nuevoId() {
  const t = new Date();
  const fecha = t.toISOString().slice(0, 19).replace(/[-:T]/g, '').slice(2);
  return 'b' + fecha + Math.random().toString(36).slice(2, 5);
}

// ---------- Avisos en directo (Server-Sent Events) ----------
const oyentes = new Map(); // canal -> Set(res)
function suscribir(canal, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(':ok\n\n');
  if (!oyentes.has(canal)) oyentes.set(canal, new Set());
  oyentes.get(canal).add(res);
  res.on('close', () => oyentes.get(canal)?.delete(res));
}
function emitir(canal, datos) {
  for (const res of oyentes.get(canal) || []) res.write('data: ' + JSON.stringify(datos) + '\n\n');
}

// ---------- Preparar una obra (en un hilo aparte) ----------
const trabajando = new Set();
function procesar(id) {
  const b = leerBorrador(id);
  if (!b) throw new Error('No existe el borrador');
  if (trabajando.has(id)) throw new Error('Ya se está preparando');
  const dirEntrada = path.join(dirDe(id), 'entrada');
  const archivos = fs.existsSync(dirEntrada) ? fs.readdirSync(dirEntrada) : [];
  const xml = archivos.find(f => /\.(xml|musicxml)$/i.test(f));
  if (!xml) throw new Error('Hace falta el archivo .xml del Escáner Musical (el PDF solo no vale: las notas salen del escáner).');
  const pdfSubido = archivos.find(f => /\.pdf$/i.test(f));
  const pdf = pdfSubido ? path.join(dirEntrada, pdfSubido) : obra.pdfPara(path.join(dirEntrada, xml));
  const dirSalida = path.join(dirDe(id), 'partituras');
  fs.rmSync(dirSalida, { recursive: true, force: true });

  Object.assign(b, { estado: 'preparando', log: [], error: null, entrada: null, avisos: [], partes: [], sospechosos: [], tempo: null, pdf: pdf ? path.basename(pdf) : null });
  guardarBorrador(b);
  trabajando.add(id);
  const registrar = linea => { b.log.push(linea); guardarBorrador(b); emitir(id, { tipo: 'log', linea }); };
  registrar('== ' + xml + (pdf ? ' + ' + path.basename(pdf) : ' (sin PDF)') + ' ==');
  const w = new Worker(path.join(__dirname, 'gestor-trabajo.js'), { workerData: { xml: path.join(dirEntrada, xml), pdf, dirSalida } });
  const terminar = () => { trabajando.delete(id); guardarBorrador(b); emitir(id, { tipo: 'estado', borrador: b }); };
  w.on('message', m => {
    if (m.tipo === 'log') registrar(m.linea);
    else if (m.tipo === 'fin') {
      const r = m.resultado;
      Object.assign(b, { estado: 'listo', entrada: r.entrada, avisos: r.avisos, partes: r.partes, sospechosos: r.sospechosos, tempo: r.tempo });
      registrar('Lista para revisar.');
      terminar();
    } else if (m.tipo === 'error') { b.estado = 'error'; b.error = m.mensaje; registrar('X ' + m.mensaje); terminar(); }
  });
  w.on('error', e => { b.estado = 'error'; b.error = e.message; registrar('X ' + e.message); terminar(); });
  w.on('exit', code => { if (trabajando.has(id)) { b.estado = 'error'; b.error = 'El proceso terminó de forma inesperada (' + code + ')'; terminar(); } });
}

// ---------- Ajustes (título, voces, tempo) sobre el XML ya preparado ----------
function ajustar(id, ajustes) {
  const b = leerBorrador(id);
  if (!b || b.estado !== 'listo') throw new Error('El borrador no está listo');
  const ruta = path.join(dirDe(id), 'partituras', b.entrada.archivo);
  let xml = fs.readFileSync(ruta, 'utf8');
  xml = obra.editarObra(xml, { titulo: ajustes.titulo, nombres: ajustes.nombres || {}, quitar: ajustes.quitar || [], tempo: ajustes.tempo });
  fs.writeFileSync(ruta, xml);
  if (ajustes.titulo && ajustes.titulo.trim()) b.entrada.titulo = ajustes.titulo.trim();
  b.partes = b.partes.filter(p => !(ajustes.quitar || []).includes(p.id)).map(p => ({ ...p, nombre: (ajustes.nombres || {})[p.id] || p.nombre }));
  b.tempo = obra.tempoDe(xml);
  b.log.push('Ajustes aplicados: ' + JSON.stringify(ajustes));
  guardarBorrador(b);
  return b;
}

// ---------- Publicar ----------
let publicando = false;
function publicarBorrador(id) {
  const b = leerBorrador(id);
  if (!b || b.estado !== 'listo') throw new Error('El borrador no está listo');
  if (publicando) throw new Error('Ya hay una publicación en marcha');
  publicando = true;
  const registrar = linea => emitir('publicacion', { tipo: 'log', linea });
  const dirSalida = path.join(dirDe(id), 'partituras');
  try {
    const existia = obra.incorporarEnApp(b.entrada, dirSalida);
    const base = b.entrada.archivo.replace(/\.xml$/, '');
    const pdfEntrada = b.pdf ? path.join(dirDe(id), 'entrada', b.pdf) : null;
    if (pdfEntrada && fs.existsSync(pdfEntrada)) obra.guardarPdf(pdfEntrada, base);
    const version = obra.subirVersionCache();
    registrar(`${existia ? 'Actualizada' : 'Añadida'} "${b.entrada.titulo}" en la app (caché ${version}).`);
    if (obra.guardarEnGit((existia ? 'Actualizar obra: ' : 'Añadir obra: ') + b.entrada.titulo)) registrar('Guardado en el repositorio.');
    else registrar('(No se ha guardado en git: no hay cambios o no hay repositorio.)');
  } catch (e) { publicando = false; throw e; }
  subirAInternet(() => { fs.rmSync(dirDe(id), { recursive: true, force: true }); });
}
function retirarObra(archivo) {
  if (publicando) throw new Error('Ya hay una publicación en marcha');
  publicando = true;
  const registrar = linea => emitir('publicacion', { tipo: 'log', linea });
  try {
    const o = obra.retirarDeApp(archivo);
    const version = obra.subirVersionCache();
    registrar(`Retirada "${o.titulo}" de la app (caché ${version}).`);
    if (obra.guardarEnGit('Retirar obra: ' + o.titulo)) registrar('Guardado en el repositorio.');
  } catch (e) { publicando = false; throw e; }
  subirAInternet();
}
function subirAInternet(alAcabar = () => {}) {
  const registrar = linea => emitir('publicacion', { tipo: 'log', linea });
  const fin = ok => { publicando = false; if (ok) alAcabar(); emitir('publicacion', { tipo: 'fin', ok }); };
  if (process.env.GESTOR_SIN_INTERNET) { registrar('(Modo de prueba: no se sube a internet.)'); return setTimeout(() => fin(true), 500); }
  registrar('Publicando en internet...');
  const p = spawn(process.execPath, [path.join(__dirname, 'publicar.js')], { cwd: obra.RAIZ, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  let resto = '';
  const trocear = chunk => { resto += chunk.toString('utf8'); const lineas = resto.split(/\r?\n/); resto = lineas.pop(); for (const l of lineas) if (l.trim()) registrar(l); };
  p.stdout.on('data', trocear); p.stderr.on('data', trocear);
  p.on('close', code => { if (resto.trim()) registrar(resto); registrar(code === 0 ? 'Publicación terminada.' : 'X La publicación ha fallado (código ' + code + ').'); fin(code === 0); });
  p.on('error', e => { registrar('X No se pudo ejecutar la publicación: ' + e.message); fin(false); });
}

// ---------- Servidor ----------
function enviarArchivo(res, ruta) {
  if (!fs.existsSync(ruta) || fs.statSync(ruta).isDirectory()) { res.writeHead(404); return res.end('No encontrado'); }
  res.writeHead(200, { 'Content-Type': TIPOS[path.extname(ruta).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(ruta).pipe(res);
}
function json(res, datos, codigo = 200) { res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(datos)); }
function leerCuerpo(req) { return new Promise((ok, mal) => { const trozos = []; req.on('data', t => trozos.push(t)); req.on('end', () => ok(Buffer.concat(trozos))); req.on('error', mal); }); }
const seguro = p => !p.split(/[\\/]/).some(s => s === '..');
const resumen = b => b && { ...b, log: undefined, lineasLog: b.log?.length || 0 };

const servidor = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const ruta = decodeURIComponent(url.pathname);
    if (!seguro(ruta)) { res.writeHead(400); return res.end(); }
    let m;

    // Página del gestor
    if (ruta === '/' || ruta === '/index.html') return enviarArchivo(res, path.join(DIR_GESTOR, 'index.html'));
    if ((m = ruta.match(/^\/gestor\/(.+)$/))) return enviarArchivo(res, path.join(DIR_GESTOR, m[1]));

    // La app tal como está en el PC
    if ((m = ruta.match(/^\/app\/(.*)$/))) { if (m[1] === 'sw.js') { res.writeHead(404); return res.end(); } return enviarArchivo(res, path.join(obra.DIR_APP, m[1] || 'index.html')); }

    // Previsualización de un borrador: la app con una lista de una sola obra
    if ((m = ruta.match(/^\/borrador\/([^/]+)\/(.*)$/))) {
      const [, id, resto] = m;
      if (!idValido(id)) { res.writeHead(404); return res.end(); }
      if (resto === 'partituras/lista.json') { const b = leerBorrador(id); return b && b.entrada ? json(res, [b.entrada]) : json(res, [], 404); }
      if (resto.startsWith('partituras/')) return enviarArchivo(res, path.join(dirDe(id), resto));
      if (resto === 'sw.js') { res.writeHead(404); return res.end(); }
      return enviarArchivo(res, path.join(obra.DIR_APP, resto || 'index.html'));
    }
    if ((m = ruta.match(/^\/borrador\/([^/]+)$/))) { res.writeHead(302, { Location: ruta + '/' }); return res.end(); }

    // API
    if (ruta === '/api/estado' && req.method === 'GET') {
      return json(res, { borradores: listarBorradores().map(resumen), publicadas: obra.leerLista(), publicando, version: obra.versionCache(), raiz: obra.RAIZ, preparando: [...trabajando] });
    }
    if (ruta === '/api/borradores' && req.method === 'POST') {
      const id = nuevoId();
      fs.mkdirSync(path.join(dirDe(id), 'entrada'), { recursive: true });
      const b = { id, creado: new Date().toISOString(), estado: 'nuevo', archivos: [], log: [] };
      guardarBorrador(b);
      return json(res, b);
    }
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)\/archivos$/)) && req.method === 'POST') {
      const id = m[1]; const b = leerBorrador(id); if (!b || !idValido(id)) return json(res, { error: 'No existe el borrador' }, 404);
      const nombre = path.basename(url.searchParams.get('nombre') || '');
      if (!/\.(xml|musicxml|pdf)$/i.test(nombre)) return json(res, { error: 'Solo se admiten archivos .xml / .musicxml del escáner y .pdf' }, 400);
      const cuerpo = await leerCuerpo(req);
      fs.writeFileSync(path.join(dirDe(id), 'entrada', nombre), cuerpo);
      b.archivos = [...new Set([...b.archivos, nombre])]; guardarBorrador(b);
      return json(res, resumen(b));
    }
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)\/preparar$/)) && req.method === 'POST') {
      try { procesar(m[1]); return json(res, { ok: true }); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)\/eventos$/)) && req.method === 'GET') return suscribir(m[1], res);
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)$/)) && req.method === 'GET') { const b = leerBorrador(m[1]); return b ? json(res, b) : json(res, { error: 'No existe' }, 404); }
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)\/ajustes$/)) && req.method === 'POST') {
      try { return json(res, resumen(ajustar(m[1], JSON.parse((await leerCuerpo(req)).toString('utf8') || '{}')))); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)\/publicar$/)) && req.method === 'POST') {
      try { publicarBorrador(m[1]); return json(res, { ok: true }); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)$/)) && req.method === 'DELETE') {
      const id = m[1]; if (!idValido(id) || trabajando.has(id)) return json(res, { error: 'No se puede borrar ahora' }, 400);
      fs.rmSync(dirDe(id), { recursive: true, force: true });
      return json(res, { ok: true });
    }
    if ((m = ruta.match(/^\/api\/publicadas\/([^/]+)\/retirar$/)) && req.method === 'POST') {
      try { retirarObra(m[1]); return json(res, { ok: true }); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if (ruta === '/api/publicacion/eventos' && req.method === 'GET') return suscribir('publicacion', res);

    res.writeHead(404); res.end('No encontrado');
  } catch (e) {
    console.error(e);
    try { json(res, { error: e.message }, 500); } catch {}
  }
});

servidor.listen(PUERTO, '127.0.0.1', () => {
  const direccion = `http://localhost:${PUERTO}/`;
  console.log('Gestor de obras en ' + direccion + '   (cierra esta ventana para pararlo)');
  if (!process.env.GESTOR_SIN_NAVEGADOR) spawn('cmd', ['/c', 'start', '', direccion], { detached: true, stdio: 'ignore' }).unref();
});
