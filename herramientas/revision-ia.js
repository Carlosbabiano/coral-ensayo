// Revisión asistida por IA de los compases dudosos de un borrador (Gestor de obras).
//
// Para un compás, recorta de la imagen de la página la caja de ese compás (con el anterior y el siguiente de la misma
// fila como contexto), prepara las figuras que leyó el escáner voz por voz (app/compases.js) y se lo manda todo a la
// API de Claude pidiendo, en JSON con el formato del editor (notasCompas), qué figuras hay de verdad en ese compás,
// una explicación corta en castellano y un nivel de confianza. La propuesta NO se aplica aquí: el gestor la enseña al
// director y solo se escribe en el XML (escribirCompas) cuando él pulsa «Aplicar».
//
// La clave de la API se lee de herramientas/clave-api.txt (archivo ignorado por git) o de ANTHROPIC_API_KEY.
// GESTOR_IA_SIMULADA=1 responde con una propuesta inventada sin consultar la API (para probar la interfaz).
// GESTOR_MODELO_IA=<id> cambia el modelo (por defecto claude-opus-5-5).
//
// Sin dependencias: la API se llama con fetch (Node 18+) y el recorte se hace con el motor de dibujo de Windows
// (System.Drawing desde PowerShell), igual que leerGris en posiciones-imagen.js.
//
// Uso suelto (pruebas): node herramientas/revision-ia.js <idBorrador> <compás> [--solo-recorte]
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const C = require('../app/compases.js');

const ARCHIVO_CLAVE = path.join(__dirname, 'clave-api.txt');
const MODELO = process.env.GESTOR_MODELO_IA || 'claude-opus-5-5';
const SIMULADA = !!process.env.GESTOR_IA_SIMULADA;
// Precios de la API en dólares por millón de tokens: [entrada, salida, lectura de caché, escritura de caché]
const PRECIOS = {
  'claude-opus-5-5': [4, 20, 0.2, 5], 'claude-opus-5': [5, 25, 0.5, 6.25], 'claude-opus-4-8': [5, 25, 0.5, 6.25], 'claude-opus-4-7': [5, 25, 0.5, 6.25],
  'claude-sonnet-5-5': [2, 10, 0.2, 2.5], 'claude-sonnet-5': [2, 10, 0.2, 2.5], 'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125], 'claude-fable-5-1': [10, 50, 0.25, 12.5],
};
// Tokens típicos de una revisión, para estimar el coste antes de la primera llamada (el recorte son unos 2000-4000
// tokens de imagen; la respuesta lleva además el razonamiento del modelo)
const TOKENS_TIPICOS = { entrada: 4500, salida: 3500 };

// ---------- Clave y estado ----------
function leerClave() {
  try { const t = fs.readFileSync(ARCHIVO_CLAVE, 'utf8').replace(/^﻿/, '').trim(); if (t) return t.split(/\r?\n/)[0].trim(); } catch {}
  return process.env.ANTHROPIC_API_KEY || null;
}
function precioDe(modelo) { return PRECIOS[modelo] || PRECIOS[Object.keys(PRECIOS).find(k => modelo && modelo.startsWith(k))] || PRECIOS['claude-opus-5-5']; }
function costeDe(uso, modelo) {
  if (!uso) return 0;
  const [pe, ps, pcl, pce] = precioDe(modelo);
  return ((uso.input_tokens || 0) * pe + (uso.output_tokens || 0) * ps + (uso.cache_read_input_tokens || 0) * pcl + (uso.cache_creation_input_tokens || 0) * pce) / 1e6;
}
function costeEstimado(modelo = MODELO) { const [pe, ps] = precioDe(modelo); return (TOKENS_TIPICOS.entrada * pe + TOKENS_TIPICOS.salida * ps) / 1e6; }
// Lo que la interfaz necesita saber antes de enseñar el botón
function estado() {
  return { clave: SIMULADA || !!leerClave(), archivoClave: ARCHIVO_CLAVE, modelo: MODELO, simulada: SIMULADA, costeEstimado: costeEstimado(), enMarcha: [...lotes.values()].some(l => l.estado === 'en marcha') };
}

// ---------- Errores con tipo (la interfaz enseña un estado distinto para cada uno) ----------
class ErrorIA extends Error { constructor(tipo, mensaje, codigo = 400) { super(mensaje); this.tipo = tipo; this.codigo = codigo; } }
const SIN_CLAVE = () => new ErrorIA('sin-clave', `No hay clave de la API de Claude. Crea el archivo ${ARCHIVO_CLAVE} con la clave (empieza por sk-ant-) en la primera línea y vuelve a pulsar. La clave se consigue en console.anthropic.com y no se guarda en el repositorio.`, 428);

// ---------- Datos de un borrador (solo lectura; obra.json lo escribe el gestor) ----------
function datosBorrador(dir) {
  const b = JSON.parse(fs.readFileSync(path.join(dir, 'obra.json'), 'utf8'));
  if (b.estado !== 'listo' || !b.entrada) throw new ErrorIA('borrador', 'El borrador no está listo');
  const partituras = path.join(dir, 'partituras');
  const xml = fs.readFileSync(path.join(partituras, b.entrada.archivo), 'utf8');
  let posiciones = null;
  if (b.entrada.posiciones && b.entrada.paginas) { try { posiciones = JSON.parse(fs.readFileSync(path.join(partituras, b.entrada.posiciones), 'utf8')); } catch {} }
  return { b, xml, posiciones, partituras, paginas: b.entrada.paginas || [], partes: b.partes || [] };
}

// ---------- Contexto musical del compás: clave y armadura de cada parte, indicación de compás ----------
const NOMBRE_CLAVE = { G: 'clave de Sol', F: 'clave de Fa', C: 'clave de Do', percussion: 'clave de percusión', TAB: 'tablatura' };
function textoArmadura(fifths) {
  const n = Math.abs(fifths);
  if (!n) return 'sin alteraciones';
  const notas = fifths > 0 ? ['Fa♯', 'Do♯', 'Sol♯', 'Re♯', 'La♯', 'Mi♯', 'Si♯'] : ['Si♭', 'Mi♭', 'La♭', 'Re♭', 'Sol♭', 'Do♭', 'Fa♭'];
  return `${n} ${fifths > 0 ? 'sostenido' : 'bemol'}${n > 1 ? (fifths > 0 ? 's' : 'es') : ''} (${notas.slice(0, n).join(', ')})`;
}
function contextoPartes(xml, numero) {
  const nombres = Object.fromEntries(C.leerPartes(xml).map(p => [p.id, p.nombre]));
  const partes = [];
  for (const [, id, cuerpo] of xml.matchAll(/<part id="([^"]+)">([\s\S]*?)<\/part>/g)) {
    let clave = null, fifths = 0, beats = 4, bt = 4;
    for (const [, num, m] of cuerpo.matchAll(/<measure number="([^"]+)"[^>]*>([\s\S]*?)<\/measure>/g)) {
      const f = m.match(/<fifths>(-?\d+)/); if (f) fifths = +f[1];
      const b = m.match(/<beats>(\d+)<\/beats>\s*<beat-type>(\d+)/); if (b) { beats = +b[1]; bt = +b[2]; }
      const cl = m.match(/<clef(?:\s+number="1")?[^>]*>\s*<sign>([^<]+)<\/sign>(?:\s*<line>(\d)<\/line>)?(?:\s*<clef-octave-change>(-?\d)<\/clef-octave-change>)?/);
      if (cl) clave = { sign: cl[1], line: cl[2] ? +cl[2] : null, octava: cl[3] ? +cl[3] : 0 };
      if (num === String(numero)) break;
    }
    let textoClave = clave ? (NOMBRE_CLAVE[clave.sign] || 'clave ' + clave.sign) : 'clave desconocida';
    if (clave && clave.sign === 'C' && clave.line) textoClave += ' en ' + clave.line + 'ª';
    if (clave && clave.octava) textoClave += clave.octava < 0 ? ' con 8 abajo (suena una octava más grave: escribe las notas una octava más bajas de como se leerían en clave de Sol normal)' : ' con 8 arriba';
    partes.push({ id, nombre: nombres[id] || id, clave: textoClave, armadura: textoArmadura(fifths), fifths, beats, bt });
  }
  return partes;
}

// ---------- Recorte del compás en la imagen de la página (System.Drawing) ----------
const MARGEN_X = 0.01, MARGEN_ARRIBA = 0.03, MARGEN_ABAJO = 0.035; // fracción de la página: arriba matices, abajo la letra
function cajasDelRecorte(cajas, numero) {
  const c = cajas[numero - 1];
  if (!c) return null;
  const mismaFila = o => o && o.p === c.p && Math.abs(o.y0 - c.y0) < 0.01;
  const ant = mismaFila(cajas[numero - 2]) ? cajas[numero - 2] : null, sig = mismaFila(cajas[numero]) ? cajas[numero] : null;
  const x0 = Math.max(0, Math.min(c.x0, ant ? ant.x0 : 1) - MARGEN_X), x1 = Math.min(1, Math.max(c.x1, sig ? sig.x1 : 0) + MARGEN_X);
  const y0 = Math.max(0, c.y0 - MARGEN_ARRIBA), y1 = Math.min(1, c.y1 + MARGEN_ABAJO);
  return { p: c.p, x0, x1, y0, y1, marco: { x0: c.x0, x1: c.x1 }, conAnterior: !!ant, conSiguiente: !!sig };
}
const ps1 = s => s.replace(/'/g, "''");
// Recorta la zona (fracciones de la página), la amplía para que el modelo lea bien las figuras y marca en naranja el
// compás que se pide. Devuelve { png (Buffer), ancho, alto, marco: { x0, x1 } en píxeles del recorte }.
function recortar(rutaImagen, zona) {
  const salida = path.join(os.tmpdir(), 'recorte-' + process.pid + '-' + Date.now() + '.png');
  const tmp = salida.replace(/\.png$/, '.ps1');
  const ps = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Bitmap]::FromFile('${ps1(path.resolve(rutaImagen))}')
$anchoPag = $src.Width; $altoPag = $src.Height
$x0 = [int][math]::Floor(${zona.x0} * $anchoPag); $x1 = [int][math]::Ceiling(${zona.x1} * $anchoPag)
$y0 = [int][math]::Floor(${zona.y0} * $altoPag); $y1 = [int][math]::Ceiling(${zona.y1} * $altoPag)
$w = [math]::Max(8, $x1 - $x0); $h = [math]::Max(8, $y1 - $y0)
# (En PowerShell las variables no distinguen mayúsculas: $w y $W serían la misma.) Lado mayor de 2400 px como mucho y unos 2,5 Mpx (lo que el modelo lee con detalle sin disparar los tokens)
$s = [math]::Min(3.0, [math]::Min(2400.0 / $w, [math]::Min(2400.0 / $h, [math]::Sqrt(2500000.0 / ($w * $h)))))
if ($s -lt 0.3) { $s = 0.3 }
$nw = [int][math]::Round($w * $s); $nh = [int][math]::Round($h * $s)
$dst = New-Object System.Drawing.Bitmap $nw, $nh, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($dst)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::White)
$g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $nw, $nh), (New-Object System.Drawing.Rectangle $x0, $y0, $w, $h), [System.Drawing.GraphicsUnit]::Pixel)
$mx0 = [int][math]::Round((${zona.marco.x0} * $anchoPag - $x0) * $s); $mx1 = [int][math]::Round((${zona.marco.x1} * $anchoPag - $x0) * $s)
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(235, 227, 155, 44)), 4
$g.DrawRectangle($pen, [math]::Max(2, $mx0), 2, [math]::Min($nw - 3, $mx1) - [math]::Max(2, $mx0), $nh - 5)
$g.Dispose(); $src.Dispose()
$dst.Save('${ps1(salida)}', [System.Drawing.Imaging.ImageFormat]::Png); $dst.Dispose()
Write-Output "$nw $nh $mx0 $mx1"`;
  fs.writeFileSync(tmp, '﻿' + ps, 'utf8');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], { stdio: 'pipe', timeout: 120000 }).toString().trim().split(/\s+/).map(Number);
    const png = fs.readFileSync(salida);
    if (!png.length || !out[0]) throw new Error('el recorte ha salido vacío');
    return { png, ancho: out[0], alto: out[1], marco: { x0: out[2], x1: out[3] } };
  } catch (e) {
    throw new ErrorIA('recorte', 'No se ha podido recortar la página: ' + (e.stderr ? e.stderr.toString().split('\n')[0] : e.message), 500);
  } finally { try { fs.unlinkSync(tmp); } catch {} try { fs.unlinkSync(salida); } catch {} }
}

// ---------- Texto para el modelo ----------
const SISTEMA = `Eres un copista experto en notación musical coral. Te dan el recorte de una partitura escaneada (impresa, a veces con anotaciones a mano) y, en texto, lo que un programa de reconocimiento óptico (el "escáner") creyó leer en un compás, voz por voz. En ese compás alguna voz no suma lo que marca la indicación de compás. Tu trabajo: mirar el recorte con cuidado y devolver las figuras que hay DE VERDAD en ese compás, en cada voz, en un JSON con el formato indicado.

Cómo mirar la imagen:
- El compás que se pide es el que está dentro del marco naranja. Lo de los lados es solo contexto (ligaduras que entran o salen, alteraciones de un compás antes, la indicación de compás).
- Los pentagramas del sistema van en el orden que se indica en el texto (de arriba abajo). Cada entrada id/voz del texto corresponde a un pentagrama (y, si hay dos voces en el mismo pentagrama, a las plicas hacia arriba = voz 1 y hacia abajo = voz 2).
- Las anotaciones a mano (números, flechas, círculos, textos) no son notas: ignóralas.

Convenciones del JSON:
- step/alter/octave: altura en notación científica con Do central = C octava 4. En clave de Sol la segunda línea es Sol4; en clave de Fa la cuarta línea es Fa3; en clave de Sol con 8 abajo, todo una octava más grave. alter es la alteración que SUENA: 1 sostenido, -1 bemol, 0 natural; incluye la de la armadura y las accidentales que arrastra el compás (y una ligadura desde el compás anterior).
- type: whole (redonda), half (blanca), quarter (negra), eighth (corchea), 16th (semicorchea), 32nd (fusa). dot: puntillos (0, 1 o 2).
- silencio: true para silencios (entonces step/alter/octave no importan: pon C, 0, 4). compasEntero: true solo para el silencio de compás entero.
- Las figuras van en orden de lectura, de izquierda a derecha. Las notas que suenan a la vez en la misma voz (acorde, divisi en una sola plica) van seguidas: la primera con acorde:false y las demás con acorde:true y la misma figura.
- Si en un pentagrama hay dos líneas rítmicas independientes (plicas arriba y abajo con ritmos distintos), la de arriba es la voz 1 y la de abajo la voz 2. Si van con el mismo ritmo, escríbelas como acordes en la voz 1 y deja la voz 2 vacía. Devuelve TODAS las entradas id/voz que se te listan (una voz puede quedar con notas: []), y ninguna más.
- ligaEmpieza/ligaTermina: ligadura de unión (misma altura, la segunda nota no se vuelve a atacar). Una ligadura que viene del compás anterior pone ligaTermina en la primera nota; una que sigue al compás siguiente pone ligaEmpieza en la última. Las ligaduras de expresión (notas distintas) no cuentan.
- letra: la sílaba escrita bajo la nota, y silaba: single (palabra entera), begin (primera sílaba, lleva guion detrás), middle, end. Si el escáner ya traía letra en la nota equivalente, cópiala tal cual salvo error evidente. Los silencios llevan letra "".
- origen: el índice (el número que precede a cada figura en la lista del escáner, dentro de esa misma voz) de la figura leída que corresponde a esta nota, para conservar sus detalles (acentos, calderones, ligaduras de expresión). null si es una nota que el escáner no tenía. No repitas un origen.
- indicacion: si en la imagen el compás lleva otra indicación de compás distinta de la que se dice (por ejemplo un 3/4 que el escáner no leyó), escríbela como "3/4"; si no, "".
- explicacion: una a tres frases en castellano, para el director del coro, diciendo qué sobra o qué falta respecto a lo que leyó el escáner (por ejemplo "El escáner dejó el divisi de la contralto a medias: la segunda nota del acorde faltaba en los dos últimos tiempos"). Si lo que leyó el escáner es correcto y el problema es otro (la indicación de compás, un compás incompleto de anacrusa, un calderón), dilo.
- confianza: alta si se lee con claridad y las figuras suman lo que marca el compás; media si has tenido que interpretar algo; baja si la imagen no se ve bien o no estás seguro.

Comprueba antes de responder que, en cada voz, la suma de las figuras (sin contar las notas con acorde:true) es la que cabe en el compás, salvo que la explicación diga por qué no.`;

function describir(n) {
  if (n.silencio) return n.compasEntero ? 'silencio de compás entero' : 'silencio de ' + (C.FIGURAS[n.type] || n.type) + ' con puntillo'.repeat(n.dot || 0);
  const alt = n.alter > 0 ? '♯'.repeat(n.alter) : n.alter < 0 ? '♭'.repeat(-n.alter) : '';
  let t = (n.acorde ? '+ ' : '') + C.NOMBRES_NOTAS[n.step] + alt + n.octave + ' ' + (C.FIGURAS[n.type] || n.type) + ' con puntillo'.repeat(n.dot || 0);
  if (n.tresillo) t += ` (${n.tresillo.actual}:${n.tresillo.normal})`;
  if (n.adorno) t += ' (adorno)';
  if (n.ligaTermina) t = '(ligada) ' + t;
  if (n.ligaEmpieza) t += ' ~';
  if (n.letra) t += ' «' + n.letra + '»';
  return t;
}
const sumaDe = (notas, esperado) => Math.round(notas.reduce((s, n) => s + (n.acorde ? 0 : C.negrasDe(n, esperado)), 0) * 1000) / 1000;

// Texto del compás: contexto, lo que leyó el escáner (con índices) y lo que se pide
function textoCompas(xml, numero, zona) {
  const primera = (C.leerPartes(xml)[0] || {}).id; let total = 0;
  C.recorrerCompases(xml, c => { if (c.id === primera) total++; });
  const detalle = C.detalleCompas(xml, numero), edicion = C.notasCompas(xml, numero);
  if (!detalle.length) throw new ErrorIA('compas', 'No existe el compás ' + numero, 404);
  const partes = contextoPartes(xml, numero);
  const v0 = detalle[0];
  let t = `Compás ${numero} de ${total}. Indicación de compás según el XML: ${v0.beats}/${v0.bt} (caben ${v0.esperado} negras por voz).\n`;
  t += `Pentagramas del sistema, de arriba abajo:\n`;
  partes.forEach((p, i) => { t += ` ${i + 1}. ${p.nombre} — id ${p.id}, ${p.clave}, armadura: ${p.armadura}\n`; });
  if (zona) t += `En el recorte, el compás ${numero} es el del marco naranja${zona.conAnterior && zona.conSiguiente ? `; a la izquierda está el ${numero - 1} y a la derecha el ${numero + 1}` : zona.conAnterior ? `; a la izquierda está el ${numero - 1}` : zona.conSiguiente ? `; a la derecha está el ${numero + 1}` : ''}.\n`;
  t += `\nLo que leyó el escáner en el compás ${numero} (índice: figura):\n`;
  for (const v of detalle) {
    const ed = edicion.find(e => e.id === v.id && e.voz === v.voz);
    const cuadra = Math.abs(v.suma - v.esperado) < 0.01;
    t += ` • ${v.nombre} — id ${v.id}, voz ${v.voz} — suma ${v.suma} negras de ${v.esperado} (${cuadra ? 'cuadra' : 'NO cuadra'})${ed && ed.notas.length ? ':' : ': vacío'}\n`;
    if (ed) ed.notas.forEach((n, i) => { t += `    ${i}: ${describir(n)}\n`; });
  }
  t += `\nDevuelve las figuras reales de cada una de esas ${detalle.length} entradas id/voz (aunque alguna quede vacía), la explicación y la confianza.`;
  return { texto: t, detalle, edicion };
}

const ESQUEMA = {
  type: 'object', additionalProperties: false, required: ['voces', 'indicacion', 'explicacion', 'confianza'],
  properties: {
    voces: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'voz', 'notas'], properties: {
      id: { type: 'string' }, voz: { type: 'integer' },
      notas: { type: 'array', items: { type: 'object', additionalProperties: false,
        required: ['silencio', 'compasEntero', 'step', 'alter', 'octave', 'type', 'dot', 'acorde', 'ligaEmpieza', 'ligaTermina', 'letra', 'silaba', 'origen'],
        properties: {
          silencio: { type: 'boolean' }, compasEntero: { type: 'boolean' },
          step: { type: 'string', enum: ['C', 'D', 'E', 'F', 'G', 'A', 'B'] }, alter: { type: 'integer', enum: [-2, -1, 0, 1, 2] }, octave: { type: 'integer', enum: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
          type: { type: 'string', enum: ['whole', 'half', 'quarter', 'eighth', '16th', '32nd'] }, dot: { type: 'integer', enum: [0, 1, 2] },
          acorde: { type: 'boolean' }, ligaEmpieza: { type: 'boolean' }, ligaTermina: { type: 'boolean' },
          letra: { type: 'string' }, silaba: { type: 'string', enum: ['single', 'begin', 'middle', 'end'] },
          origen: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        } } },
    } } },
    indicacion: { type: 'string' }, explicacion: { type: 'string' }, confianza: { type: 'string', enum: ['alta', 'media', 'baja'] },
  },
};

// ---------- Llamada a la API ----------
async function pedirAlModelo({ clave, png, texto }) {
  const cuerpo = {
    model: MODELO, max_tokens: 16000,
    system: [{ type: 'text', text: SISTEMA, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: 'high', format: { type: 'json_schema', schema: ESQUEMA } },
    fallbacks: 'default',
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }, { type: 'text', text: texto }] }],
  };
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(300000),
      headers: { 'content-type': 'application/json', 'x-api-key': clave, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
      body: JSON.stringify(cuerpo),
    });
  } catch (e) {
    const codigo = e && e.cause && e.cause.code;
    if (e.name === 'TimeoutError') throw new ErrorIA('api', 'El modelo ha tardado demasiado en responder (más de cinco minutos). Vuelve a intentarlo.', 504);
    if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(codigo) || /fetch failed/i.test(e.message)) throw new ErrorIA('sin-internet', 'No hay conexión a internet (o la red corta el acceso a api.anthropic.com). La revisión con IA necesita internet; el resto del gestor funciona igual.', 503);
    throw new ErrorIA('api', 'No se ha podido hablar con la API: ' + e.message, 502);
  }
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (datos.error && datos.error.message) || ('error ' + r.status);
    if (r.status === 401) throw new ErrorIA('sin-clave', `La API no acepta la clave de ${ARCHIVO_CLAVE} (${msg}). Comprueba que está entera y vigente.`, 401);
    if (r.status === 402 || r.status === 403) throw new ErrorIA('api', 'La cuenta de la API no permite la petición (saldo o permisos): ' + msg, r.status);
    if (r.status === 404) throw new ErrorIA('api', `El modelo ${MODELO} no está disponible para esta cuenta (${msg}). Se puede cambiar con la variable GESTOR_MODELO_IA.`, 404);
    if (r.status === 429) throw new ErrorIA('api', 'Demasiadas peticiones seguidas a la API: espera un minuto y vuelve a intentarlo.', 429);
    if (r.status === 413) throw new ErrorIA('api', 'El recorte es demasiado grande para la API: ' + msg, 413);
    if (r.status >= 500) throw new ErrorIA('api', 'El servicio de Claude está saturado o caído ahora mismo (' + r.status + '). Vuelve a intentarlo en un minuto.', 503);
    throw new ErrorIA('api', 'La API ha rechazado la petición: ' + msg, 502);
  }
  if (datos.stop_reason === 'refusal') throw new ErrorIA('api', 'El modelo ha declinado responder a esta petición' + (datos.stop_details && datos.stop_details.explanation ? ': ' + datos.stop_details.explanation : '.'), 502);
  if (datos.stop_reason === 'max_tokens') throw new ErrorIA('api', 'La respuesta del modelo se ha cortado por longitud. Vuelve a intentarlo.', 502);
  const bloque = (datos.content || []).find(b => b.type === 'text');
  if (!bloque) throw new ErrorIA('api', 'El modelo no ha devuelto texto.', 502);
  let json;
  try { json = JSON.parse(bloque.text); } catch { throw new ErrorIA('api', 'La respuesta del modelo no es un JSON válido.', 502); }
  return { json, uso: datos.usage || {}, modelo: datos.model || MODELO };
}

// Propuesta inventada para probar la interfaz sin clave ni internet: rellena con silencios lo que falta o recorta lo que sobra
function simular(edicion) {
  const voces = edicion.map(e => {
    const notas = e.notas.filter(n => !n.adorno).map((n, i) => ({ silencio: n.silencio, compasEntero: n.compasEntero, step: n.step, alter: n.alter, octave: n.octave, type: C.FIGURA_NEGRAS[n.type] ? n.type : 'quarter', dot: n.dot, acorde: n.acorde, ligaEmpieza: n.ligaEmpieza, ligaTermina: n.ligaTermina, letra: n.letra, silaba: n.silaba, origen: i }));
    let suma = sumaDe(notas, e.esperado);
    while (suma > e.esperado + 0.001 && notas.length) { notas.pop(); while (notas.length && notas[notas.length - 1].acorde) notas.pop(); suma = sumaDe(notas, e.esperado); }
    for (const [tipo, neg] of [['whole', 4], ['half', 2], ['quarter', 1], ['eighth', 0.5], ['16th', 0.25], ['32nd', 0.125]]) while (suma + neg <= e.esperado + 0.001) { notas.push({ silencio: true, compasEntero: false, step: 'C', alter: 0, octave: 4, type: tipo, dot: 0, acorde: false, ligaEmpieza: false, ligaTermina: false, letra: '', silaba: 'single', origen: null }); suma = sumaDe(notas, e.esperado); }
    return { id: e.id, voz: e.voz, notas };
  });
  return { json: { voces, indicacion: '', explicacion: 'Respuesta simulada para probar la interfaz (GESTOR_IA_SIMULADA=1): no se ha consultado la API. Se rellena con silencios lo que faltaba y se quita lo que sobraba.', confianza: 'baja' }, uso: { input_tokens: 0, output_tokens: 0 }, modelo: 'simulado' };
}

// ---------- De la respuesta del modelo al formato del editor ----------
function convertir(json, edicion) {
  const voces = [];
  const avisos = [];
  for (const e of edicion) {
    const prop = (json.voces || []).find(v => v.id === e.id && +v.voz === e.voz);
    const actuales = e.notas.map(describir);
    if (!prop) { avisos.push(`El modelo no ha dicho nada de ${e.nombre}.`); voces.push({ id: e.id, voz: e.voz, nombre: e.nombre, esperado: e.esperado, sinPropuesta: true, actuales, suma: sumaDe(e.notas, e.esperado) }); continue; }
    const usados = new Set();
    const notas = [];
    for (const n of prop.notas || []) {
      if (!['whole', 'half', 'quarter', 'eighth', '16th', '32nd'].includes(n.type) || !/^[A-G]$/.test(n.step || '')) continue;
      const origen = Number.isInteger(n.origen) && !usados.has(n.origen) ? e.notas[n.origen] : null;
      if (origen) usados.add(n.origen);
      const nota = {
        silencio: !!n.silencio, compasEntero: !!n.silencio && !!n.compasEntero,
        step: n.silencio ? 'C' : n.step, alter: n.silencio ? 0 : Math.max(-2, Math.min(2, +n.alter || 0)), octave: n.silencio ? 4 : Math.max(0, Math.min(9, +n.octave)),
        type: n.type, dot: Math.max(0, Math.min(2, +n.dot || 0)), acorde: !!n.acorde && !n.silencio && notas.length > 0, adorno: false,
        tresillo: origen && origen.tresillo && origen.type === n.type ? origen.tresillo : null, voz: e.voz,
        ligaEmpieza: !n.silencio && !!n.ligaEmpieza, ligaTermina: !n.silencio && !!n.ligaTermina,
        letra: n.silencio ? '' : String(n.letra || ''), silaba: ['single', 'begin', 'middle', 'end'].includes(n.silaba) ? n.silaba : 'single',
        simbolos: origen ? origen.simbolos : [],
      };
      if (origen && origen.indiceXml !== undefined) nota.indiceXml = origen.indiceXml;
      notas.push(nota);
    }
    C.renumerar(notas);
    const suma = sumaDe(notas, e.esperado), sumaActual = sumaDe(e.notas, e.esperado);
    const propuestas = notas.map(describir);
    voces.push({ id: e.id, voz: e.voz, nombre: e.nombre, esperado: e.esperado, notas, actuales, propuestas, suma, sumaActual, cuadra: Math.abs(suma - e.esperado) < 0.01, cuadraActual: Math.abs(sumaActual - e.esperado) < 0.01, igual: JSON.stringify(actuales) === JSON.stringify(propuestas) });
  }
  return { voces, avisos };
}

// ---------- Revisar un compás de un borrador ----------
// Devuelve la propuesta sin tocar nada: { numero, voces, explicacion, confianza, indicacion, recorte, uso, coste, modelo, duracion }
const propuestas = new Map(); // id del borrador -> Map(numero -> propuesta), para volver a enseñarlas sin pagar otra vez
async function revisar(dirBorrador, numero) {
  numero = +numero;
  const inicio = Date.now();
  const clave = SIMULADA ? 'simulada' : leerClave();
  if (!clave) throw SIN_CLAVE();
  if (!SIMULADA && process.env.GESTOR_SIN_INTERNET) throw new ErrorIA('sin-internet', 'El gestor está en modo de prueba sin internet (GESTOR_SIN_INTERNET=1): no se consulta la API. Para probar la interfaz con una respuesta inventada, arranca con GESTOR_IA_SIMULADA=1.', 503);
  const { b, xml, posiciones, partituras, paginas } = datosBorrador(dirBorrador);
  let zona = null, recorte = null;
  if (posiciones && Array.isArray(posiciones.compases) && paginas.length) {
    zona = cajasDelRecorte(posiciones.compases, numero);
    if (zona && paginas[zona.p]) recorte = recortar(path.join(partituras, paginas[zona.p]), zona);
  }
  if (!recorte) throw new ErrorIA('sin-pagina', 'Este compás no tiene imagen de la página original (hace falta el PDF y que los compases estén localizados en la página), y sin la imagen la IA no tiene nada que mirar.', 409);
  const { texto, edicion } = textoCompas(xml, numero, zona);
  const r = SIMULADA ? await new Promise(ok => setTimeout(() => ok(simular(edicion)), 1200)) : await pedirAlModelo({ clave, png: recorte.png, texto });
  const { voces, avisos } = convertir(r.json, edicion);
  const propuesta = {
    numero, titulo: b.entrada.titulo, voces, avisos,
    explicacion: String(r.json.explicacion || ''), confianza: ['alta', 'media', 'baja'].includes(r.json.confianza) ? r.json.confianza : 'baja', indicacion: /^\d+\/\d+$/.test(r.json.indicacion || '') ? r.json.indicacion : '',
    cuadra: voces.every(v => v.cuadra), cambia: voces.some(v => !v.igual && !v.sinPropuesta),
    recorte: { imagen: 'data:image/png;base64,' + recorte.png.toString('base64'), ancho: recorte.ancho, alto: recorte.alto, marco: recorte.marco },
    uso: { entrada: r.uso.input_tokens || 0, salida: r.uso.output_tokens || 0, cacheLeida: r.uso.cache_read_input_tokens || 0, cacheEscrita: r.uso.cache_creation_input_tokens || 0 },
    coste: costeDe(r.uso, r.modelo), modelo: r.modelo, duracion: Date.now() - inicio, hora: new Date().toISOString(), aplicada: false,
  };
  if (!propuestas.has(b.id)) propuestas.set(b.id, new Map());
  propuestas.get(b.id).set(numero, propuesta);
  return propuesta;
}
function propuestaGuardada(id, numero) { const m = propuestas.get(id); return m ? m.get(+numero) || null : null; }
// Propuestas que hay en memoria de un borrador, sin la imagen (para la lista)
function resumenPropuestas(id) {
  const m = propuestas.get(id); if (!m) return {};
  return Object.fromEntries([...m.values()].map(p => [p.numero, { numero: p.numero, confianza: p.confianza, cuadra: p.cuadra, cambia: p.cambia, explicacion: p.explicacion, coste: p.coste, aplicada: p.aplicada, indicacion: p.indicacion }]));
}
function olvidar(id, numero) { const m = propuestas.get(id); if (!m) return; if (numero === undefined) propuestas.delete(id); else m.delete(+numero); }

// ---------- Aplicar una propuesta (escribe en el XML lo que cuadra; el gestor guarda el archivo y el registro) ----------
function aplicar(xml, numero, voces, { soloCuadran = true } = {}) {
  const aplicadas = [], saltadas = [];
  for (const v of voces || []) {
    if (!Array.isArray(v.notas) || v.sinPropuesta) continue;
    if (soloCuadran && !v.cuadra) { saltadas.push(v.nombre); continue; }
    if (v.notas.length > 64) throw new ErrorIA('propuesta', 'La propuesta tiene demasiadas notas en ' + v.nombre);
    xml = C.escribirCompas(xml, v.id, numero, v.notas, v.voz);
    aplicadas.push(v.nombre);
  }
  return { xml, aplicadas, saltadas };
}
function marcarAplicada(id, numero) { const p = propuestaGuardada(id, numero); if (p) p.aplicada = true; }

// ---------- Revisar todos los sospechosos de una obra, en segundo plano, con avisos ----------
const lotes = new Map(); // id del borrador -> lote
const CONCURRENCIA = 2;
function estadoLote(id) {
  const l = lotes.get(id); if (!l) return null;
  return { estado: l.estado, total: l.numeros.length, hechos: l.hechos, enCurso: [...l.enCurso], resultados: l.resultados, coste: l.coste, inicio: l.inicio, fin: l.fin, numeros: l.numeros };
}
// revisarUno(numero) -> propuesta; emitir(datos) manda el avance a la página por SSE
function empezarLote(id, numeros, revisarUno, emitir) {
  if (lotes.get(id) && lotes.get(id).estado === 'en marcha') throw new ErrorIA('lote', 'Ya se están revisando los compases de esta obra');
  if (!numeros.length) throw new ErrorIA('lote', 'No hay compases sospechosos que revisar');
  if (!SIMULADA && !leerClave()) throw SIN_CLAVE();
  const l = { estado: 'en marcha', numeros: numeros.map(Number), hechos: 0, enCurso: new Set(), resultados: {}, coste: 0, inicio: Date.now(), fin: null, cancelar: false };
  lotes.set(id, l);
  const avisar = () => emitir({ tipo: 'ia', lote: estadoLote(id) });
  const cola = [...l.numeros];
  const obrero = async () => {
    while (cola.length && !l.cancelar) {
      const n = cola.shift();
      l.enCurso.add(n); avisar();
      try {
        const p = await revisarUno(n);
        l.resultados[n] = { ok: true, confianza: p.confianza, cuadra: p.cuadra, cambia: p.cambia, explicacion: p.explicacion, coste: p.coste, indicacion: p.indicacion };
        l.coste += p.coste;
      } catch (e) {
        l.resultados[n] = { ok: false, error: e.message, tipo: e.tipo || 'api' };
        // Sin clave o sin internet no tiene sentido seguir con los demás
        if (e.tipo === 'sin-clave' || e.tipo === 'sin-internet') { l.cancelar = true; l.motivo = e.message; }
      }
      l.enCurso.delete(n); l.hechos++; avisar();
    }
  };
  (async () => {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, cola.length) }, obrero));
    l.estado = l.cancelar ? 'cancelado' : 'terminado'; l.fin = Date.now();
    avisar();
  })();
  return estadoLote(id);
}
function cancelarLote(id) { const l = lotes.get(id); if (l && l.estado === 'en marcha') { l.cancelar = true; l.motivo = 'Parado a petición tuya.'; return true; } return false; }
// Quita el resumen de un lote terminado y las propuestas que trajo (las aplicadas ya están en el XML)
function olvidarLote(id) {
  const l = lotes.get(id);
  if (l && l.estado === 'en marcha') throw new ErrorIA('lote', 'La revisión sigue en marcha: párala primero');
  if (l) for (const n of l.numeros) olvidar(id, n);
  lotes.delete(id);
}
const enMarcha = () => [...lotes.values()].some(l => l.estado === 'en marcha');

module.exports = { estado, leerClave, revisar, aplicar, propuestaGuardada, resumenPropuestas, marcarAplicada, olvidar, empezarLote, estadoLote, cancelarLote, olvidarLote, enMarcha, costeDe, costeEstimado, ErrorIA, ARCHIVO_CLAVE, MODELO,
  // para pruebas
  recortar, cajasDelRecorte, textoCompas, convertir, contextoPartes, ESQUEMA, SISTEMA };

// ---------- Uso suelto: node herramientas/revision-ia.js <idBorrador> <compás> [--solo-recorte] ----------
if (require.main === module) {
  const [id, n, opcion] = process.argv.slice(2);
  if (!id || !n) { console.log('Uso: node herramientas/revision-ia.js <idBorrador> <compás> [--solo-recorte]'); process.exit(1); }
  const dir = path.join(__dirname, '..', 'borradores', id);
  const salida = path.join(__dirname, 'cache', 'revision-ia'); fs.mkdirSync(salida, { recursive: true });
  const { xml, posiciones, partituras, paginas } = datosBorrador(dir);
  const zona = cajasDelRecorte(posiciones.compases, +n);
  const rec = recortar(path.join(partituras, paginas[zona.p]), zona);
  fs.writeFileSync(path.join(salida, `compas-${n}.png`), rec.png);
  const { texto } = textoCompas(xml, +n, zona);
  console.log(`Recorte guardado en ${path.join(salida, `compas-${n}.png`)} (${rec.ancho}×${rec.alto}, unos ${Math.round(rec.ancho * rec.alto / 784)} tokens de imagen)\n`);
  console.log(texto);
  if (opcion === '--solo-recorte') process.exit(0);
  revisar(dir, +n).then(p => { const { recorte, ...resto } = p; console.log('\n' + JSON.stringify(resto, null, 1)); }).catch(e => { console.error('X ' + e.message); process.exit(1); });
}
