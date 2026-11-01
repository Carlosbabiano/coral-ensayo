// Gestor: partir, unir, insertar y quitar compases de un borrador (en todas las voces), con deshacer.
// Cada acción guarda antes una copia del XML y del pos.json en borradores/<id>/deshacer/ y apunta el punto en
// b.deshacer: [{ clave, descripcion, fecha, compas, archivo }]; «deshacer» restaura el último y lo quita de la lista.
// Las cajas del pos.json (una por compás) se parten o funden a la vez que los compases (posiciones-compases.js).
const fs = require('fs'), path = require('path');
const C = require('../app/compases.js');
const cajas = require('./posiciones-compases.js');
const MAX_DESHACER = 20;

// ctx: { leerBorrador, guardarBorrador, dirDe, rutaPosiciones, leerPosiciones, resumen }
module.exports = function (ctx) {
  const rutaXml = b => path.join(ctx.dirDe(b.id), 'partituras', b.entrada.archivo);
  const dirDeshacer = id => path.join(ctx.dirDe(id), 'deshacer');
  const listo = id => { const b = ctx.leerBorrador(id); if (!b || b.estado !== 'listo') throw new Error('El borrador no está listo'); return b; };

  function guardarPunto(b, descripcion, compas) {
    const dir = dirDeshacer(b.id); fs.mkdirSync(dir, { recursive: true });
    const clave = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    fs.copyFileSync(rutaXml(b), path.join(dir, clave + '.xml'));
    const rp = ctx.rutaPosiciones(b); if (rp && fs.existsSync(rp)) fs.copyFileSync(rp, path.join(dir, clave + '.pos.json'));
    b.deshacer = [...(b.deshacer || []), { clave, descripcion, fecha: new Date().toISOString(), compas, archivo: b.entrada.archivo }];
    for (const viejo of b.deshacer.splice(0, Math.max(0, b.deshacer.length - MAX_DESHACER))) borrarPunto(b.id, viejo);
  }
  function borrarPunto(id, p) { for (const ext of ['.xml', '.pos.json']) try { fs.unlinkSync(path.join(dirDeshacer(id), p.clave + ext)); } catch {} }

  // accion: partir | fundir | insertar | quitar; datos: { enNegras } para partir, { antes } para insertar
  function cambiar(id, numero, accion, datos = {}) {
    const b = listo(id);
    const n = +numero; if (!(n >= 1)) throw new Error('Número de compás no válido');
    const xml = fs.readFileSync(rutaXml(b), 'utf8');
    const total = (C.leerPartes(xml).length ? [...(xml.match(/<part id="[^"]+">[\s\S]*?<\/part>/) || [''])[0].matchAll(/<measure number=/g)] : []).length;
    let nuevo, pos = ctx.leerPosiciones(b), descripcion, aviso = null, compas = n;
    if (accion === 'partir') {
      const en = +datos.enNegras, d = C.duracionCompas(xml, n);
      nuevo = C.partirCompas(xml, n, en);
      pos = cajas.partirCaja(pos, n - 1, d && d.dura ? en / d.dura : 0.5);
      descripcion = `partir el compás ${n} en la negra ${en}`;
    } else if (accion === 'fundir') {
      nuevo = C.fundirCompases(xml, n);
      pos = cajas.fundirCajas(pos, n - 1);
      descripcion = `unir el compás ${n} con el ${n + 1}`;
      const d = C.duracionCompas(nuevo, n);
      if (d && Math.abs(d.dura - d.esperado) > 0.01) aviso = `El compás ${n} unido dura ${d.dura} negras y está en ${d.beats}/${d.bt}, donde caben ${d.esperado}: cámbiale la indicación de compás o corrige sus notas.`;
    } else if (accion === 'insertar') {
      const antes = !!datos.antes;
      nuevo = C.insertarCompas(xml, n, antes);
      pos = cajas.insertarCaja(pos, n - 1, antes);
      compas = antes ? n : n + 1;
      descripcion = `insertar un compás ${antes ? 'antes' : 'después'} del ${n}`;
    } else if (accion === 'quitar') {
      nuevo = C.quitarCompas(xml, n);
      pos = cajas.quitarCaja(pos, n - 1);
      compas = Math.max(1, Math.min(n, total - 1));
      descripcion = `quitar el compás ${n}`;
    } else throw new Error('Acción desconocida');
    guardarPunto(b, descripcion, n);
    fs.writeFileSync(rutaXml(b), nuevo);
    const rp = ctx.rutaPosiciones(b);
    if (rp && pos) fs.writeFileSync(rp, JSON.stringify(pos));
    b.sospechosos = C.sospechososDe(nuevo);
    b.log.push(`Compases: ${descripcion} (en todas las voces; los siguientes se renumeran).` + (aviso ? ' ' + aviso : ''));
    ctx.guardarBorrador(b);
    return { ...ctx.resumen(b), compas, aviso };
  }

  // Vuelve al estado anterior a la última acción (XML y pos.json)
  function deshacer(id) {
    const b = listo(id);
    const p = (b.deshacer || []).slice(-1)[0];
    if (!p) throw new Error('No hay nada que deshacer');
    if (p.archivo !== b.entrada.archivo) { b.deshacer = []; ctx.guardarBorrador(b); throw new Error('La obra se volvió a preparar después de ese cambio: ya no se puede deshacer'); }
    const dir = dirDeshacer(b.id), xmlViejo = path.join(dir, p.clave + '.xml'), posViejo = path.join(dir, p.clave + '.pos.json');
    if (!fs.existsSync(xmlViejo)) { b.deshacer = b.deshacer.filter(x => x !== p); ctx.guardarBorrador(b); throw new Error('No se encuentra la copia anterior del XML'); }
    fs.copyFileSync(xmlViejo, rutaXml(b));
    const rp = ctx.rutaPosiciones(b);
    if (rp && fs.existsSync(posViejo)) fs.copyFileSync(posViejo, rp);
    b.deshacer = b.deshacer.filter(x => x.clave !== p.clave);
    borrarPunto(b.id, p);
    b.sospechosos = C.sospechososDe(fs.readFileSync(rutaXml(b), 'utf8'));
    b.log.push(`Deshecho: ${p.descripcion}.`);
    ctx.guardarBorrador(b);
    return { ...ctx.resumen(b), compas: p.compas, aviso: null };
  }

  return { cambiar, deshacer };
};
