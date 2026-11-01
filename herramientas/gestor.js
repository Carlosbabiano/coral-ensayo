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
const canto = require('./canto.js');

const PUERTO = +process.env.PUERTO || 5180;
const DIR_GESTOR = path.join(__dirname, 'gestor');
const DIR_BORRADORES = path.join(obra.RAIZ, 'borradores');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.xml': 'application/xml; charset=utf-8', '.musicxml': 'application/xml; charset=utf-8', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

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
  // Si los compases de la página se corrigieron a mano, se conservan (el detector no se vuelve a pasar si siguen cuadrando)
  const previas = leerPosiciones(b);
  const posicionesManuales = previas && previas.manual ? previas : null;
  fs.rmSync(dirSalida, { recursive: true, force: true });

  const cabecera = b.origen === 'entrada' ? ['Recogido de la carpeta Entrada: ' + archivos.join(' + ')] : [];
  Object.assign(b, { estado: 'preparando', log: cabecera, error: null, entrada: null, avisos: [], partes: [], sospechosos: [], tempo: null, pdf: pdf ? path.basename(pdf) : null });
  guardarBorrador(b);
  trabajando.add(id);
  const registrar = linea => { b.log.push(linea); guardarBorrador(b); emitir(id, { tipo: 'log', linea }); };
  registrar('== ' + xml + (pdf ? ' + ' + path.basename(pdf) : ' (sin PDF)') + ' ==');
  const w = new Worker(path.join(__dirname, 'gestor-trabajo.js'), { workerData: { xml: path.join(dirEntrada, xml), pdf, dirSalida, posicionesManuales } });
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
  if (ajustes.ensayo !== undefined) b.entrada.ensayo = !!ajustes.ensayo;
  b.partes = b.partes.filter(p => !(ajustes.quitar || []).includes(p.id)).map(p => ({ ...p, nombre: (ajustes.nombres || {})[p.id] || p.nombre }));
  b.tempo = obra.tempoDe(xml);
  b.sospechosos = obra.sospechososDe(xml);
  b.log.push('Ajustes aplicados: ' + JSON.stringify(ajustes));
  guardarBorrador(b);
  return b;
}

// ---------- Revisar un compás: lo que hay escrito, voz por voz, y dónde está en la página ----------
function xmlDe(b) { return fs.readFileSync(path.join(dirDe(b.id), 'partituras', b.entrada.archivo), 'utf8'); }
function detalleCompas(id, numero) {
  const b = leerBorrador(id);
  if (!b || b.estado !== 'listo') throw new Error('El borrador no está listo');
  const voces = obra.detalleCompas(xmlDe(b), numero);
  if (!voces.length) throw new Error('No existe el compás ' + numero);
  let posicion = null, pagina = null;
  if (b.entrada.posiciones && b.entrada.paginas) {
    try {
      const pos = JSON.parse(fs.readFileSync(path.join(dirDe(id), 'partituras', b.entrada.posiciones), 'utf8'));
      posicion = pos.compases[+numero - 1] || null;
      if (posicion) pagina = b.entrada.paginas[posicion.p] || null;
    } catch {}
  }
  return { numero: +numero, voces, edicion: obra.notasCompas(xmlDe(b), numero), posicion, pagina, sospechoso: b.sospechosos.includes(String(numero)) };
}
function guardarNotas(id, numero, { voz, numVoz, notas }) {
  const b = leerBorrador(id);
  if (!b || b.estado !== 'listo') throw new Error('El borrador no está listo');
  if (!Array.isArray(notas) || notas.length > 64) throw new Error('Notas no válidas');
  const ruta = path.join(dirDe(id), 'partituras', b.entrada.archivo);
  const xml = obra.escribirCompas(fs.readFileSync(ruta, 'utf8'), voz, numero, notas, +numVoz || 1);
  fs.writeFileSync(ruta, xml);
  b.sospechosos = obra.sospechososDe(xml);
  const nombre = (b.partes.find(p => p.id === voz) || {}).nombre || voz;
  b.log.push(`Compás ${numero}, ${nombre}: notas editadas a mano en el gestor (${notas.length} figuras).`);
  guardarBorrador(b);
  return b;
}
function cambiarCompas(id, numero, { beats, bt, restaurar }) {
  const b = leerBorrador(id);
  if (!b || b.estado !== 'listo') throw new Error('El borrador no está listo');
  if (!(+beats >= 1 && +beats <= 32) || ![1, 2, 4, 8, 16].includes(+bt)) throw new Error('Indicación de compás no válida');
  const ruta = path.join(dirDe(id), 'partituras', b.entrada.archivo);
  const xml = obra.fijarCompas(fs.readFileSync(ruta, 'utf8'), numero, +beats, +bt, restaurar !== false);
  fs.writeFileSync(ruta, xml);
  b.sospechosos = obra.sospechososDe(xml);
  b.log.push(`Compás ${numero} puesto en ${beats}/${bt}` + (restaurar !== false ? ' (el siguiente vuelve al compás anterior)' : ''));
  guardarBorrador(b);
  return b;
}

// ---------- Compases en la página original: posiciones corregidas a mano ----------
// El pos.json del borrador: { paginas, compases: [{ p, x0, x1, y0, y1 }], manual?, filas? }. El gestor edita FILAS
// ({ p, y0, y1, x: [divisorias de izquierda a derecha], omitidas: [cajas que están en la página pero no en el XML] })
// y el servidor deriva las cajas en orden de lectura (página, fila de arriba abajo, caja de izquierda a derecha).
const rutaPosiciones = b => b && b.entrada && b.entrada.posiciones ? path.join(dirDe(b.id), 'partituras', b.entrada.posiciones) : null;
function leerPosiciones(b) { const r = rutaPosiciones(b); if (!r) return null; try { return JSON.parse(fs.readFileSync(r, 'utf8')); } catch { return null; } }
// Resumen para la tarjeta del gestor: si están corregidas a mano, cuántas hay y cuántos compases tiene el XML
function infoPosiciones(b) {
  if (!b || b.estado !== 'listo' || !b.entrada || !b.entrada.paginas) return null;
  const pos = leerPosiciones(b);
  let nXml = null; try { nXml = obra.compasesDe(xmlDe(b)).length; } catch {}
  return { manual: !!(pos && pos.manual), n: pos && Array.isArray(pos.compases) ? pos.compases.length : 0, nXml, incompleto: !pos || !!pos.incompleto || !(pos.compases || []).length };
}
const conInfo = b => b && b.estado === 'listo' && b.entrada ? { ...b, posicionesInfo: infoPosiciones(b) } : b;
function datosPosiciones(id) {
  const b = leerBorrador(id);
  if (!b || b.estado !== 'listo') throw new Error('El borrador no está listo');
  if (!b.entrada.paginas || !b.entrada.paginas.length) throw new Error('La obra no tiene página original (hace falta el PDF)');
  return { paginas: b.entrada.paginas, posiciones: leerPosiciones(b), compases: obra.compasesDe(xmlDe(b)) };
}
// Comprueba las filas y las convierte en cajas. Lanza un error en castellano si algo no cuadra.
function construirPosiciones(filas, nPaginas) {
  if (!Array.isArray(filas)) throw new Error('Faltan las filas de compases');
  const num = v => typeof v === 'number' && isFinite(v);
  const r4 = v => Math.round(v * 1e4) / 1e4;
  const limpias = filas.map((f, i) => {
    const donde = `Fila ${i + 1}` + (f && Number.isInteger(f.p) ? ` de la página ${f.p + 1}` : '');
    if (!f || !Number.isInteger(f.p) || f.p < 0 || f.p >= nPaginas) throw new Error(`${donde}: la página no existe en la obra`);
    if (!num(f.y0) || !num(f.y1) || f.y0 < 0 || f.y1 > 1 || f.y1 - f.y0 < 0.01) throw new Error(`${donde}: el alto se sale de la página`);
    if (!Array.isArray(f.x) || f.x.length < 2) throw new Error(`${donde}: no tiene ninguna caja`);
    const x = f.x.map(v => r4(+v));
    for (let k = 0; k < x.length; k++) {
      if (!num(x[k]) || x[k] < 0 || x[k] > 1) throw new Error(`${donde}: una divisoria se sale de la página`);
      if (k && x[k] - x[k - 1] < 0.003) throw new Error(`${donde}: dos divisorias se pisan (un compás sin ancho)`);
    }
    const omitidas = [...new Set((f.omitidas || []).map(Number))].filter(k => Number.isInteger(k) && k >= 0 && k < x.length - 1).sort((a, b) => a - b);
    return { p: f.p, y0: r4(f.y0), y1: r4(f.y1), x, omitidas };
  });
  limpias.sort((a, b) => a.p - b.p || a.y0 - b.y0);
  const compases = [];
  for (const f of limpias) for (let k = 0; k < f.x.length - 1; k++) if (!f.omitidas.includes(k)) compases.push({ p: f.p, x0: f.x[k], x1: f.x[k + 1], y0: f.y0, y1: f.y1 });
  return { filas: limpias, compases };
}
function guardarPosiciones(id, { filas }) {
  const b = leerBorrador(id);
  if (!b || b.estado !== 'listo') throw new Error('El borrador no está listo');
  if (!b.entrada.paginas || !b.entrada.paginas.length) throw new Error('La obra no tiene página original');
  const { filas: f, compases } = construirPosiciones(filas, b.entrada.paginas.length);
  const n = obra.compasesDe(xmlDe(b)).length;
  if (compases.length !== n) throw new Error(compases.length > n ? `En la página hay ${compases.length} compases y el XML tiene ${n}: sobran ${compases.length - n}. Funde cajas (toca una divisoria) o márcalas como «no está en el XML».` : `En la página hay ${compases.length} compases y el XML tiene ${n}: faltan ${n - compases.length}. Parte cajas (toca dentro de una) o añade la fila que falte.`);
  if (!b.entrada.posiciones) b.entrada.posiciones = b.entrada.archivo.replace(/\.xml$/i, '') + '.pos.json';
  fs.writeFileSync(rutaPosiciones(b), JSON.stringify({ paginas: b.entrada.paginas.length, manual: true, compases, filas: f }));
  b.log.push(`Compases en la página corregidos a mano: ${compases.length} compases en ${f.length} fila(s).`);
  guardarBorrador(b);
  return b;
}

// ---------- Voces cantadas (canto sintético) ----------
// Carpeta borradores/<id>/canto/: proyectos para el sintetizador (uno por voz) y el audio que exporta el usuario
const dirCanto = id => path.join(dirDe(id), 'canto');
function estadoCantoDe(b) {
  const carpeta = canto.estadoCarpeta(dirCanto(b.id));
  return { carpeta: dirCanto(b.id), preparado: carpeta, actual: (b.entrada && b.entrada.canto) || [] };
}
const conCanto = b => b && { ...b, canto: estadoCantoDe(b) };
function prepararCanto(id, datos) {
  const b = leerBorrador(id);
  if (!b || b.estado !== 'listo') throw new Error('El borrador no está listo');
  datos.titulo = datos.titulo || b.entrada.titulo;
  const est = canto.prepararProyectos(dirCanto(id), datos);
  b.log.push(`Voces cantadas: preparados ${est.pistas.length} proyectos para el sintetizador (${est.pistas.map(p => p.nombre).join(', ')}).`);
  if (!datos.tempoConstante) b.log.push('Aviso: la obra cambia de tempo; el audio cantado puede descuadrarse en esos tramos.');
  guardarBorrador(b);
  abrirCarpeta(dirCanto(id));
  return conCanto(b);
}
function abrirCarpeta(dir) { try { spawn('explorer', [dir], { detached: true, stdio: 'ignore' }).unref(); } catch {} }
const incorporando = new Set();
async function incorporarCanto(id) {
  const b = leerBorrador(id);
  if (!b || b.estado !== 'listo') throw new Error('El borrador no está listo');
  if (incorporando.has(id)) throw new Error('Ya se está convirtiendo el audio');
  const est = canto.estadoCarpeta(dirCanto(id));
  if (!est) throw new Error('Primero hay que preparar los proyectos para el sintetizador');
  const listas = est.pistas.filter(p => p.audio);
  if (!listas.length) throw new Error('No hay ningún audio exportado en la carpeta ' + dirCanto(id) + ' (tiene que llamarse como la voz: ' + est.pistas.map(p => p.base + '.wav').join(', ') + ')');
  const base = b.entrada.archivo.replace(/\.xml$/i, '');
  const dirSalida = path.join(dirDe(id), 'partituras');
  const nuevas = [];
  incorporando.add(id);
  try {
    let consonantes = null;
    try { consonantes = await canto.consonantesDePistas(dirCanto(id), b.cantoIdioma); } catch (e) { b.log.push('(Sin tramos de consonantes: ' + e.message + ')'); }
    for (const p of listas) {
      const archivo = canto.archivoCanto(base, p.nombre);
      await canto.convertirAMp3(path.join(dirCanto(id), p.audio), path.join(dirSalida, archivo));
      const nueva = { parte: p.parte, sub: p.sub, nombre: p.nombre, archivo };
      if (consonantes && consonantes[p.nombre]) { nueva.consonantes = archivo.replace(/\.mp3$/, '.json'); fs.writeFileSync(path.join(dirSalida, nueva.consonantes), JSON.stringify(consonantes[p.nombre])); }
      nuevas.push(nueva);
    }
  } finally { incorporando.delete(id); }
  for (const c of b.entrada.canto || []) for (const f of [c.archivo, c.consonantes]) if (f && !nuevas.some(n => n.archivo === f || n.consonantes === f)) { try { fs.unlinkSync(path.join(dirSalida, f)); } catch {} }
  b.entrada.canto = nuevas;
  const faltan = est.pistas.filter(p => !p.audio).map(p => p.nombre);
  b.log.push(`Voces cantadas incorporadas: ${nuevas.map(n => n.nombre).join(', ')}.` + (faltan.length ? ' Faltan: ' + faltan.join(', ') + '.' : ''));
  guardarBorrador(b);
  return conCanto(b);
}
// El cantante automático: instalar la voz (una vez) y cantar un borrador, ambos en segundo plano con avisos por SSE
let instalandoVoz = false, cantando = null, cancelarCanto = false; // cantando = id del borrador
// Si el gestor se cerró a medio cantar, los borradores no deben quedarse marcados como "cantando"
for (const b of listarBorradores()) if (b.cantando) { b.cantando = false; b.log.push('(El gestor se cerró mientras cantaba: canto interrumpido.)'); guardarBorrador(b); }
async function instalarVozCantante() {
  if (instalandoVoz) throw new Error('Ya se está instalando la voz');
  instalandoVoz = true;
  const log = linea => emitir('cantante', { tipo: 'log', linea });
  try { await canto.instalarCantante(log); emitir('cantante', { tipo: 'fin', ok: true, estado: canto.estadoCantante() }); }
  catch (e) { log('X ' + e.message); emitir('cantante', { tipo: 'fin', ok: false, error: e.message }); }
  finally { instalandoVoz = false; }
}
function cantarBorrador(id, datos, idioma, estilo) {
  const b = leerBorrador(id);
  if (!b || b.estado !== 'listo') throw new Error('El borrador no está listo');
  if (cantando) throw new Error('Ya se está cantando otra obra; espera a que termine');
  const est = canto.estadoCantante();
  if (!est.voz || !est.diccionario) throw new Error('Primero hay que instalar la voz del cantante');
  datos.titulo = datos.titulo || b.entrada.titulo;
  cantando = id; cancelarCanto = false;
  b.cantando = true; b.cantoIdioma = idioma; b.log.push('Cantando la obra con el cantante automático (' + (idioma === 'la' ? 'latín' : 'castellano') + ')…'); guardarBorrador(b);
  const registrar = linea => { const bb = leerBorrador(id); if (bb) { bb.log.push(linea); guardarBorrador(bb); } emitir(id, { tipo: 'log', linea }); };
  (async () => {
    try {
      await canto.cantarPistas(dirCanto(id), datos, { idioma, estilo, log: registrar, alAvanzar: f => emitir(id, { tipo: 'avance', fraccion: f }), cancelado: () => cancelarCanto });
      registrar('Convirtiendo a MP3 e incorporando a la obra…');
      const bb = await incorporarCanto(id);
      registrar('Voces cantadas listas: elige el sonido «Voces cantadas» en la previsualización.');
      const fin = leerBorrador(id); fin.cantando = false; guardarBorrador(fin);
      emitir(id, { tipo: 'estado', borrador: conCanto(fin) });
    } catch (e) {
      registrar(e.message === 'Cancelado' ? 'Canto parado a petición tuya.' : 'X No se pudo cantar: ' + e.message);
      const fin = leerBorrador(id); if (fin) { fin.cantando = false; guardarBorrador(fin); emitir(id, { tipo: 'estado', borrador: conCanto(fin) }); }
    } finally { cantando = null; }
  })();
  return conCanto(leerBorrador(id));
}
// Añade (o recalcula) los tramos de consonantes de las voces ya incorporadas, sin volver a cantar ni convertir
async function consonantesCanto(id) {
  const b = leerBorrador(id);
  if (!b || b.estado !== 'listo') throw new Error('El borrador no está listo');
  if (!(b.entrada.canto || []).length) throw new Error('La obra no tiene voces cantadas');
  const consonantes = await canto.consonantesDePistas(dirCanto(id), b.cantoIdioma);
  if (!consonantes) throw new Error('No hay datos de la obra en la carpeta de canto (hace falta haber preparado o cantado con esta versión)');
  const dirSalida = path.join(dirDe(id), 'partituras');
  let n = 0;
  for (const c of b.entrada.canto) if (consonantes[c.nombre]) { c.consonantes = c.archivo.replace(/\.mp3$/, '.json'); fs.writeFileSync(path.join(dirSalida, c.consonantes), JSON.stringify(consonantes[c.nombre])); n++; }
  b.log.push('Tramos de consonantes añadidos a ' + n + ' voces cantadas.');
  guardarBorrador(b);
  return conCanto(b);
}
function quitarCanto(id) {
  const b = leerBorrador(id);
  if (!b || b.estado !== 'listo') throw new Error('El borrador no está listo');
  for (const c of b.entrada.canto || []) for (const f of [c.archivo, c.consonantes]) if (f) { try { fs.unlinkSync(path.join(dirDe(id), 'partituras', f)); } catch {} }
  b.entrada.canto = [];
  b.log.push('Voces cantadas quitadas: al publicar, la obra irá sin ellas.');
  guardarBorrador(b);
  return conCanto(b);
}

// ---------- Publicar ----------
// Cada publicación lleva su número. Su registro se guarda para reenviarlo a la ventana de progreso que se conecte
// (o se vuelva a conectar) mientras dura; la ventana pide el número de SU publicación, para no recibir el de la anterior
let publicando = false, publicacion = { id: 0, registro: [], fin: null, pasos: [], paso: -1, inicioPaso: 0, tiempos: {} };
const registrar = linea => { publicacion.registro.push(linea); emitir('publicacion', { tipo: 'log', id: publicacion.id, linea }); };
// Pasos de una publicación, para la barra de progreso de la ventana. Lo que tardó cada paso la última vez se guarda
// en herramientas/cache/publicacion.json y sirve para estimar lo que queda (si no hay dato, una duración típica).
const PASOS = { preparar: 'Preparando los archivos de la app', git: 'Guardando en el repositorio', subir: 'Subiendo los cambios a GitHub', paginas: 'Publicando la app en GitHub Pages' };
const DURACION_TIPICA = { preparar: 5, git: 10, subir: 30, paginas: 20 };
const ARCHIVO_TIEMPOS = path.join(__dirname, 'cache', 'publicacion.json');
let tiemposPublicacion = {};
try { tiemposPublicacion = JSON.parse(fs.readFileSync(ARCHIVO_TIEMPOS, 'utf8')); } catch {}
function empezarPublicacion(claves = ['preparar', 'git', 'subir', 'paginas']) {
  if (publicando) throw new Error('Ya hay una publicación en marcha');
  publicando = true;
  const pasos = claves.map(clave => ({ clave, nombre: PASOS[clave], estimado: tiemposPublicacion[clave] || DURACION_TIPICA[clave] }));
  publicacion = { id: publicacion.id + 1, registro: [], fin: null, pasos, paso: -1, inicioPaso: 0, tiempos: {} };
  return publicacion.id;
}
// Lo que se manda a la ventana para la barra: el paso en curso y cuánto lleva
const eventoPaso = () => ({ tipo: 'paso', id: publicacion.id, paso: publicacion.paso, pasos: publicacion.pasos, transcurrido: publicacion.inicioPaso ? (Date.now() - publicacion.inicioPaso) / 1000 : 0 });
function cerrarPaso() {
  if (publicacion.paso < 0 || !publicacion.inicioPaso) return;
  publicacion.tiempos[publicacion.pasos[publicacion.paso].clave] = Math.max(1, Math.round((Date.now() - publicacion.inicioPaso) / 1000));
}
function paso(clave) {
  const i = publicacion.pasos.findIndex(p => p.clave === clave);
  if (i < 0 || i === publicacion.paso) return;
  cerrarPaso();
  publicacion.paso = i; publicacion.inicioPaso = Date.now();
  emitir('publicacion', eventoPaso());
}
// Al acabar bien se recuerdan los tiempos de esta vez para estimar la siguiente
function guardarTiempos() {
  cerrarPaso();
  tiemposPublicacion = { ...tiemposPublicacion, ...publicacion.tiempos };
  try { fs.mkdirSync(path.dirname(ARCHIVO_TIEMPOS), { recursive: true }); fs.writeFileSync(ARCHIVO_TIEMPOS, JSON.stringify(tiemposPublicacion)); } catch {}
}
// Las tres funciones que publican devuelven el número de la publicación, para que la ventana de progreso la siga
function publicarBorrador(id) {
  const b = leerBorrador(id);
  if (!b || b.estado !== 'listo') throw new Error('El borrador no está listo');
  const idPub = empezarPublicacion();
  const dirSalida = path.join(dirDe(id), 'partituras');
  try {
    paso('preparar');
    const existia = obra.incorporarEnApp(b.entrada, dirSalida);
    const base = b.entrada.archivo.replace(/\.xml$/, '');
    const pdfEntrada = b.pdf ? path.join(dirDe(id), 'entrada', b.pdf) : null;
    if (pdfEntrada && fs.existsSync(pdfEntrada)) obra.guardarPdf(pdfEntrada, base);
    const version = obra.subirVersionCache();
    registrar(`${existia ? 'Actualizada' : 'Añadida'} "${b.entrada.titulo}" en la app (caché ${version}).`);
    paso('git');
    if (obra.guardarEnGit((existia ? 'Actualizar obra: ' : 'Añadir obra: ') + b.entrada.titulo)) registrar('Guardado en el repositorio.');
    else registrar('(No se ha guardado en git: no hay cambios o no hay repositorio.)');
  } catch (e) { publicando = false; throw e; }
  subirAInternet(() => { fs.rmSync(dirDe(id), { recursive: true, force: true }); });
  return idPub;
}
// Crea un borrador a partir de una obra ya publicada (para retocarla y volver a publicarla encima)
function borradorDesdePublicada(archivo) {
  const o = obra.leerLista().find(x => x.archivo === archivo);
  if (!o) throw new Error('Esa obra no está en la app: ' + archivo);
  const id = nuevoId();
  const dirSalida = path.join(dirDe(id), 'partituras');
  fs.mkdirSync(path.join(dirDe(id), 'entrada'), { recursive: true });
  fs.mkdirSync(dirSalida, { recursive: true });
  for (const f of obra.archivosDe(o)) fs.copyFileSync(path.join(obra.DIR_PARTITURAS, f), path.join(dirSalida, f));
  const xml = fs.readFileSync(path.join(dirSalida, o.archivo), 'utf8');
  const partes = obra.leerPartes(xml).map(p => ({ id: p.id, nombre: p.nombre, nombreActual: p.nombre, tesitura: '', clave: '' }));
  const entrada = { titulo: o.titulo, archivo: o.archivo };
  if (o.posiciones && o.paginas) { entrada.posiciones = o.posiciones; entrada.paginas = o.paginas; }
  if (o.canto && o.canto.length) entrada.canto = o.canto;
  if (o.ensayo) entrada.ensayo = true;
  const pdf = obra.pdfPara(path.join(obra.DIR_PDF, o.archivo.replace(/\.xml$/, '.pdf')));
  const b = { id, creado: new Date().toISOString(), estado: 'listo', archivos: [o.archivo], origen: 'publicada', entrada, avisos: [], partes, sospechosos: obra.sospechososDe(xml), tempo: obra.tempoDe(xml), pdf: pdf ? path.basename(pdf) : null, log: ['Borrador creado a partir de la obra publicada «' + o.titulo + '». Al publicar, la sustituirá.'] };
  guardarBorrador(b);
  return id;
}
function retirarObra(archivo) {
  const idPub = empezarPublicacion();
  try {
    paso('preparar');
    const o = obra.retirarDeApp(archivo);
    const version = obra.subirVersionCache();
    registrar(`Retirada "${o.titulo}" de la app (caché ${version}).`);
    paso('git');
    if (obra.guardarEnGit('Retirar obra: ' + o.titulo)) registrar('Guardado en el repositorio.');
  } catch (e) { publicando = false; throw e; }
  subirAInternet();
  return idPub;
}
// Pone o quita la marca «en ensayo» de una obra publicada y lo publica para el coro
// (No se publica en el momento: el cambio queda guardado en git y el gestor avisa de que hay cambios sin publicar.)
function marcarEnsayo(archivo, ensayo) {
  if (publicando) throw new Error('Espera a que termine la publicación en marcha');
  const o = obra.marcarEnsayo(archivo, ensayo);
  obra.subirVersionCache();
  obra.guardarEnGit((ensayo ? 'En ensayo: ' : 'Fuera de ensayo: ') + o.titulo);
  return o;
}
// Cambios guardados en git que todavía no se han subido a internet (0 si no hay repositorio remoto)
function cambiosSinPublicar() {
  try { return +require('child_process').execSync('git rev-list --count origin/main..HEAD', { cwd: obra.RAIZ, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 0; } catch { return 0; }
}
// Publica en internet lo que haya pendiente
function publicarPendiente() {
  const idPub = empezarPublicacion(['subir', 'paginas']);
  registrar('Publicando los cambios pendientes...');
  subirAInternet();
  return idPub;
}
// Sube con publicar.js sin esperar a su comprobación de internet (dos minutos): la publicación termina en cuanto
// está subida y la comprobación la hace el gestor aparte, en segundo plano, sin bloquear la siguiente acción
function subirAInternet(alAcabar = () => {}) {
  const fin = ok => { if (ok && !process.env.GESTOR_SIN_INTERNET) guardarTiempos(); publicando = false; publicacion.fin = { tipo: 'fin', id: publicacion.id, ok }; if (ok) alAcabar(); emitir('publicacion', publicacion.fin); if (ok && !process.env.GESTOR_SIN_INTERNET) comprobarEnInternet(); };
  if (process.env.GESTOR_SIN_INTERNET) {
    // Modo de prueba: los dos pasos de internet se simulan con una pequeña espera, para ver la barra
    registrar('(Modo de prueba: no se sube a internet.)');
    paso('subir'); return setTimeout(() => { paso('paginas'); setTimeout(() => fin(true), 1500); }, 1500);
  }
  registrar('Publicando en internet...');
  paso('subir');
  const p = spawn(process.execPath, [path.join(__dirname, 'publicar.js'), '--sin-comprobar'], { cwd: obra.RAIZ, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  let resto = '';
  // publicar.js va contando lo que hace; por sus líneas se sabe en qué paso está
  const trocear = chunk => { resto += chunk.toString('utf8'); const lineas = resto.split(/\r?\n/); resto = lineas.pop(); for (const l of lineas) if (l.trim()) { if (l.startsWith('Publicando la carpeta app/')) paso('paginas'); registrar(l); } };
  p.stdout.on('data', trocear); p.stderr.on('data', trocear);
  p.on('close', code => { if (resto.trim()) registrar(resto); registrar(code === 0 ? 'Publicación terminada.' : 'X La publicación ha fallado (código ' + code + ').'); fin(code === 0); });
  p.on('error', e => { registrar('X No se pudo ejecutar la publicación: ' + e.message); fin(false); });
}
// Tras publicar, comprueba en segundo plano (GitHub Pages tarda un par de minutos en servir lo nuevo) que todos los
// archivos de las obras estén de verdad en internet con ese nombre exacto; el resultado se enseña en el gestor
let comprobacion = null; // { estado: 'comprobando' | 'bien' | 'faltan', archivos, faltan, hora }
function urlPublicada() {
  try {
    const remoto = require('child_process').execSync('git remote get-url origin', { cwd: obra.RAIZ, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const [usuario, repo] = remoto.replace(/\.git$/, '').split('/').slice(-2);
    return `https://${usuario.toLowerCase()}.github.io/${repo}/`;
  } catch { return null; }
}
async function comprobarEnInternet() {
  const url = urlPublicada(); if (!url) return;
  const archivos = obra.leerLista().flatMap(o => [o.archivo, o.posiciones, ...(o.paginas || [])].filter(Boolean));
  const mia = comprobacion = { estado: 'comprobando', archivos: archivos.length, faltan: [], hora: Date.now() };
  await new Promise(r => setTimeout(r, 120000));
  if (comprobacion !== mia) return; // ha empezado otra publicación después; manda su comprobación
  for (const f of archivos) { try { const r = await fetch(url + 'partituras/' + f + '?t=' + Date.now(), { method: 'HEAD' }); if (r.status !== 200) mia.faltan.push(f); } catch { mia.faltan.push(f); } }
  mia.estado = mia.faltan.length ? 'faltan' : 'bien'; mia.hora = Date.now();
}

// ---------- Carpeta de entrada (Google Drive) ----------
// Lo que se deje en Entrada/ (por ejemplo compartido desde el móvil a Google Drive) se muestra en el gestor
// y se carga a mano con el botón "Cargar": el XML crea el borrador y, si hay un PDF con el mismo nombre, va con él.
const DIR_ENTRADA = path.join(obra.RAIZ, 'Entrada');
fs.mkdirSync(DIR_ENTRADA, { recursive: true });
function listarEntrada() {
  let nombres = [];
  try { nombres = fs.readdirSync(DIR_ENTRADA).filter(n => /.(xml|musicxml|pdf)$/i.test(n) && !n.startsWith('~') && !n.startsWith('.')); } catch {}
  const pdfs = nombres.filter(n => /.pdf$/i.test(n));
  const xmls = nombres.filter(n => /.(xml|musicxml)$/i.test(n)).map(xml => ({ xml, pdf: pdfs.find(p => obra.clave(p) === obra.clave(xml)) || null }));
  const sueltos = pdfs.filter(p => !xmls.some(x => x.pdf === p));
  return { ruta: DIR_ENTRADA, obras: xmls, pdfsSueltos: sueltos };
}
function cargarDeEntrada(xml) {
  xml = path.basename(xml);
  const entrada = listarEntrada().obras.find(o => o.xml === xml);
  if (!entrada) throw new Error('No está en la carpeta Entrada: ' + xml);
  const id = nuevoId();
  const dirEntrada = path.join(dirDe(id), 'entrada');
  fs.mkdirSync(dirEntrada, { recursive: true });
  const archivos = [];
  for (const f of [entrada.xml, entrada.pdf].filter(Boolean)) {
    const origen = path.join(DIR_ENTRADA, f), destino = path.join(dirEntrada, f);
    try { fs.renameSync(origen, destino); } catch { fs.copyFileSync(origen, destino); fs.unlinkSync(origen); }
    archivos.push(f);
  }
  const b = { id, creado: new Date().toISOString(), estado: 'nuevo', archivos, log: [], origen: 'entrada' };
  guardarBorrador(b);
  procesar(id);
  return id;
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
      return json(res, { borradores: listarBorradores().map(resumen), publicadas: obra.leerLista(), publicando, publicacion: publicando ? publicacion.id : null, comprobacion, sinPublicar: cambiosSinPublicar(), version: obra.versionCache(), raiz: obra.RAIZ, preparando: [...trabajando], entrada: listarEntrada(), cantante: { ...canto.estadoCantante(), instalando: instalandoVoz, cantando } });
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
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)$/)) && req.method === 'GET') {
      const b = leerBorrador(m[1]); if (!b) return json(res, { error: 'No existe' }, 404);
      // Recalcular los compases sospechosos con el motor actual (los borradores preparados con versiones anteriores pueden traer una lista vieja)
      if (b.estado === 'listo' && b.entrada) { try { const nuevos = obra.sospechososDe(xmlDe(b)); if (JSON.stringify(nuevos) !== JSON.stringify(b.sospechosos)) { b.sospechosos = nuevos; guardarBorrador(b); } } catch {} }
      return json(res, conInfo(conCanto(b)));
    }
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)\/posiciones$/)) && req.method === 'GET') {
      try { return json(res, datosPosiciones(m[1])); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)\/posiciones$/)) && req.method === 'POST') {
      try { return json(res, resumen(conInfo(guardarPosiciones(m[1], JSON.parse((await leerCuerpo(req)).toString('utf8') || '{}'))))); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)\/canto\/preparar$/)) && req.method === 'POST') {
      try { return json(res, prepararCanto(m[1], JSON.parse((await leerCuerpo(req)).toString('utf8') || '{}'))); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)\/canto\/abrir$/)) && req.method === 'POST') {
      if (!idValido(m[1])) return json(res, { error: 'No existe' }, 404);
      fs.mkdirSync(dirCanto(m[1]), { recursive: true }); abrirCarpeta(dirCanto(m[1])); return json(res, { ok: true });
    }
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)\/canto\/incorporar$/)) && req.method === 'POST') {
      try { return json(res, await incorporarCanto(m[1])); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if (ruta === '/api/cantante/instalar' && req.method === 'POST') {
      try { instalarVozCantante(); return json(res, { ok: true }); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if (ruta === '/api/cantante/eventos' && req.method === 'GET') return suscribir('cantante', res);
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)\/canto\/parar$/)) && req.method === 'POST') {
      if (cantando !== m[1]) return json(res, { error: 'Ese borrador no se está cantando' }, 400);
      cancelarCanto = true; return json(res, { ok: true });
    }
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)\/canto\/cantar$/)) && req.method === 'POST') {
      try { const cuerpo = JSON.parse((await leerCuerpo(req)).toString('utf8') || '{}'); return json(res, cantarBorrador(m[1], cuerpo.datos || {}, cuerpo.idioma, cuerpo.estilo)); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)\/canto\/idioma$/)) && req.method === 'POST') {
      try { const cuerpo = JSON.parse((await leerCuerpo(req)).toString('utf8') || '{}'); return json(res, { idioma: canto.detectarIdioma(cuerpo) }); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)\/canto\/consonantes$/)) && req.method === 'POST') {
      try { return json(res, await consonantesCanto(m[1])); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)\/canto\/quitar$/)) && req.method === 'POST') {
      try { return json(res, quitarCanto(m[1])); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)\/ajustes$/)) && req.method === 'POST') {
      try { return json(res, resumen(ajustar(m[1], JSON.parse((await leerCuerpo(req)).toString('utf8') || '{}')))); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)\/compas\/(\d+)$/)) && req.method === 'GET') {
      try { return json(res, detalleCompas(m[1], m[2])); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)\/compas\/(\d+)\/notas$/)) && req.method === 'POST') {
      try { return json(res, resumen(guardarNotas(m[1], m[2], JSON.parse((await leerCuerpo(req)).toString('utf8') || '{}')))); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)\/compas\/(\d+)\/tiempo$/)) && req.method === 'POST') {
      try { return json(res, resumen(cambiarCompas(m[1], m[2], JSON.parse((await leerCuerpo(req)).toString('utf8') || '{}')))); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)\/publicar$/)) && req.method === 'POST') {
      try { return json(res, { ok: true, id: publicarBorrador(m[1]) }); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if ((m = ruta.match(/^\/api\/borradores\/([^/]+)$/)) && req.method === 'DELETE') {
      const id = m[1]; if (!idValido(id) || trabajando.has(id)) return json(res, { error: 'No se puede borrar ahora' }, 400);
      fs.rmSync(dirDe(id), { recursive: true, force: true });
      return json(res, { ok: true });
    }
    if ((m = ruta.match(/^\/api\/publicadas\/([^/]+)\/borrador$/)) && req.method === 'POST') {
      try { return json(res, { id: borradorDesdePublicada(decodeURIComponent(m[1])) }); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if (ruta === '/api/publicar' && req.method === 'POST') {
      try { return json(res, { ok: true, id: publicarPendiente() }); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if ((m = ruta.match(/^\/api\/publicadas\/([^/]+)\/ensayo$/)) && req.method === 'POST') {
      try { const cuerpo = JSON.parse((await leerCuerpo(req)).toString('utf8') || '{}'); marcarEnsayo(m[1], !!cuerpo.ensayo); return json(res, { ok: true }); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if ((m = ruta.match(/^\/api\/publicadas\/([^/]+)\/retirar$/)) && req.method === 'POST') {
      try { return json(res, { ok: true, id: retirarObra(m[1]) }); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if (ruta === '/api/entrada/cargar' && req.method === 'POST') {
      try { const { xml } = JSON.parse((await leerCuerpo(req)).toString('utf8') || '{}'); return json(res, { id: cargarDeEntrada(xml) }); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if (ruta === '/api/publicacion/eventos' && req.method === 'GET') {
      // Solo se reenvía el registro de la publicación que pide la ventana (?id=); el de una anterior ya no le sirve
      const id = +url.searchParams.get('id');
      suscribir('publicacion', res);
      if (id !== publicacion.id) { res.write('data: ' + JSON.stringify({ tipo: 'fin', id, ok: false, linea: 'No hay registro de esa publicación.' }) + '\n\n'); return; }
      for (const linea of publicacion.registro) res.write('data: ' + JSON.stringify({ tipo: 'log', id, linea }) + '\n\n');
      if (publicacion.paso >= 0 && !publicacion.fin) res.write('data: ' + JSON.stringify(eventoPaso()) + '\n\n');
      if (publicacion.fin) res.write('data: ' + JSON.stringify(publicacion.fin) + '\n\n');
      return;
    }

    // Latido de la página (ver «Apagado» más abajo) y cierre desde el botón «Cerrar el gestor»
    if (ruta === '/api/latido' && req.method === 'POST') { ultimoLatido = Date.now(); return json(res, { ok: true, ocupado: ocupado() }); }
    if (ruta === '/api/salir' && req.method === 'POST') {
      if (ocupado()) return json(res, { error: 'Hay un trabajo en marcha (una publicación, una obra preparándose, la comprobación en internet o el cantante). Espera a que termine.' }, 409);
      console.log('Cerrado desde la página.');
      json(res, { ok: true }); setTimeout(() => process.exit(0), 300); return;
    }

    res.writeHead(404); res.end('No encontrado');
  } catch (e) {
    console.error(e);
    try { json(res, { error: e.message }, 500); } catch {}
  }
});

// ---------- Apagado ----------
// Abierto desde Gestor.vbs no hay ventana de consola que cerrar: la página manda un latido mientras está abierta y el
// servidor se apaga solo unos minutos después de cerrarse la última pestaña (o si nunca llegó a abrirse ninguna),
// nunca con un trabajo en marcha. GESTOR_SIN_APAGADO=1 lo desactiva (pruebas automáticas).
const arranque = Date.now();
let ultimoLatido = 0;
const ocupado = () => publicando || trabajando.size > 0 || instalandoVoz || !!cantando || !!(comprobacion && comprobacion.estado === 'comprobando');
const SIN_LATIDO_MS = 3 * 60 * 1000;
if (!process.env.GESTOR_SIN_APAGADO) setInterval(() => {
  if (Date.now() - Math.max(ultimoLatido, arranque) > SIN_LATIDO_MS && !ocupado()) { console.log('Sin ninguna pestaña del gestor abierta: se cierra.'); process.exit(0); }
}, 30 * 1000).unref();

servidor.listen(PUERTO, '127.0.0.1', () => {
  const direccion = `http://localhost:${PUERTO}/`;
  console.log('Gestor de obras en ' + direccion + '   (se apaga solo al cerrar la pestaña; también puedes cerrar esta ventana)');
  if (!process.env.GESTOR_SIN_NAVEGADOR) spawn('cmd', ['/c', 'start', '', direccion], { detached: true, stdio: 'ignore' }).unref();
});
