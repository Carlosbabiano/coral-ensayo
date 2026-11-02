// Leer la partitura con IA (Gestor de obras): el MusicXML de una obra a partir del PDF solo, con la API de Claude en vez
// de con Audiveris.
//
// Cómo funciona:
//  1. analizar(): las páginas del PDF pasan a imágenes (paginas.js) y en cada una se buscan los pentagramas, los sistemas y
//     las divisorias con lo que ya hay en posiciones-imagen.js (sin XML). De ahí salen las filas (sistemas) con sus cajas
//     (compases) y, con ellas, cuántas consultas harán falta y lo que costarán. Esto no consulta la API: sirve para enseñar
//     el coste antes de empezar. Se guarda en <dirTrabajo>/analisis.json.
//  2. leer(): una primera consulta con la primera página («vista general»: título, pentagramas por sistema, nombre y clave
//     de cada voz, armadura, compás), y después una consulta por cada tramo de fila: se recorta cada pentagrama del tramo
//     (una imagen por voz, con los compases numerados en naranja en una franja blanca y las divisorias marcadas) y el
//     modelo devuelve, con un esquema JSON estricto, las figuras de cada compás y voz (altura, figura, puntillo, ligaduras,
//     silencios, letra, acordes y voz 2). Las respuestas se guardan en <dirTrabajo>/respuestas/ para no pagar dos veces.
//  3. construirXml(): con todo eso se monta un MusicXML partwise (divisiones, atributos en el primer compás y donde cambien,
//     <backup> para la voz 2, barras finales y dobles, anacrusas con implicit="yes") y las posiciones de cada compás en la
//     página, que ya se conocen y no hace falta volver a detectar.
//  El gestor pasa el XML por la misma preparación que el de Audiveris (obra.prepararObra con xmlTexto).
//
// La clave de la API se lee de herramientas/clave-api.txt o de ANTHROPIC_API_KEY (igual que revision-ia.js).
// GESTOR_IA_SIMULADA=1 responde con una partitura inventada sin consultar la API (para probar la interfaz).
// GESTOR_MODELO_LECTURA=<id> cambia el modelo predeterminado.
//
// Uso suelto: node herramientas/lectura-ia.js <obra.pdf> [carpeta-salida] [--modelo <id>] [--solo-analisis]
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), { execFileSync } = require('child_process');
const PI = require('./posiciones-imagen.js');
const { generarPaginas } = require('./paginas.js');
const R = require('./revision-ia.js'); // clave, precios y errores con tipo

const SIMULADA = !!process.env.GESTOR_IA_SIMULADA;
// Modelos que se ofrecen en el gestor, del más capaz al más barato
const MODELOS = [
  { id: 'claude-sonnet-5-5', nombre: 'Claude Sonnet 5.5', detalle: 'recomendado: lee igual de bien y cuesta menos' },
  { id: 'claude-opus-5-5', nombre: 'Claude Opus 5.5', detalle: 'el más capaz, más caro' },
  { id: 'claude-haiku-5-5', nombre: 'Claude Haiku 5.5', detalle: 'el más barato, menos fiable' },
];
// Predeterminado Sonnet 5.5: en Tres morillas y Si la nieve resbala leyó igual de bien que Opus 5.5 (100 % y 94 % de las
// notas frente a 99 % y 94-95 %) por dos tercios del precio
const MODELO_PREDETERMINADO = process.env.GESTOR_MODELO_LECTURA || 'claude-sonnet-5-5';
const ANCHO_PAGINA = 1600;   // las imágenes de página de la app (y las que mira el detector de compases)
const ANCHO_ALTA = 3200;     // las imágenes de las que se recortan los pentagramas para el modelo (el doble de detalle)
const LADO_MAX = 1568;       // la API reduce las imágenes con un lado mayor que esto: no merece la pena mandar más
const ANCHO_ETIQUETA = 10;   // espacios de pentagrama a la izquierda del principio de la fila donde van las etiquetas de las voces (S., A., Tenor, Órgano…)
const ANCHO_CLAVE = 11 + ANCHO_ETIQUETA; // lo que se pega a la izquierda de los tramos que no empiezan la fila: etiqueta, clave y armadura
const ESCALA_MAX = 2.5;      // un escaneo flojo se amplía hasta aquí: no añade detalle, pero el modelo lee mejor los símbolos grandes
const RECORTE_VERSION = 3;   // cambia si cambia la forma de recortar: las respuestas guardadas de otra versión no sirven
const ESP_OBJETIVO = 22;     // píxeles entre líneas del pentagrama en los recortes: con eso el modelo lee bien alteraciones y puntillos
// Escala de los recortes de una fila respecto a la imagen de página: la que deja el pentagrama a ESP_OBJETIVO, sin pasar
// de la que da la imagen de alta resolución (más píxeles no son más detalle)
const escalaFila = (a, f) => Math.min(Math.max(a.escalas[f.p], ESCALA_MAX), Math.max(1, ESP_OBJETIVO / f.esp));
const MAX_COMPASES = 6;      // compases por consulta como mucho (la respuesta crece con compases × voces)
const DIVISIONES = 48;       // divisiones por negra del XML (admite fusas con puntillo y tresillos)
const CONCURRENCIA = 2;
// Tokens típicos por consulta para estimar el coste antes de empezar, medidos en Tres morillas y Si la nieve resbala con
// Opus 5.5 y Sonnet 5.5 (la salida lleva además el razonamiento del modelo; el prompt del sistema, unos 4300 tokens, se
// lee de la caché en cada tramo). El coste real sale en el informe de cada lectura.
const TOKENS_TIPICOS = { vistaEntrada: 4800, vistaSalida: 400, fijoEntrada: 300, imagenEntrada: 730, cacheTramo: 4300, fijoSalida: 900, porCompasVoz: 450 };
const FIGURAS = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125 };
const NOMBRE_CLAVE = { G: 'clave de Sol', F: 'clave de Fa', C: 'clave de Do' };

class ErrorLectura extends R.ErrorIA {}
const ps1 = s => s.replace(/'/g, "''");
// Tipo real de la imagen por sus primeros bytes: las tiras son PNG, pero la vista general manda la página tal cual,
// que en un escaneo es JPEG (y la API rechaza un JPEG declarado como PNG)
const tipoImagen = buf => buf && buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : 'image/png';
// Ancho y alto de un PNG o JPEG leyendo solo su cabecera
function dimensiones(archivo) {
  const b = fs.readFileSync(archivo);
  if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  let i = 2;
  while (i + 9 < b.length && b[i] === 0xFF) {
    const marca = b[i + 1], largo = b.readUInt16BE(i + 2);
    if (marca >= 0xC0 && marca <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marca)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + largo;
  }
  throw new ErrorLectura('imagen', 'No se ha podido leer el tamaño de la imagen ' + path.basename(archivo));
}
const huellaDe = pdf => crypto.createHash('sha1').update(fs.readFileSync(pdf)).digest('hex').slice(0, 16);

// ---------- 1. Análisis de las páginas (sin API) ----------
// Devuelve { huella, paginas, alta, escalaAlta, filas: [{ p, w, h, t, y1, y5, esp, x0, x1, pents: [{ y1, y5, esp }], cajas: [{ xa, xb, limite }] }], compases, consultas }
function analizar({ pdf, dirTrabajo, nPartes = null, log = () => {} }) {
  fs.mkdirSync(dirTrabajo, { recursive: true });
  const huella = huellaDe(pdf);
  const archivo = path.join(dirTrabajo, 'analisis.json');
  let previo = null; try { previo = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch {}
  const vigente = previo && previo.huella === huella && Array.isArray(previo.paginas) && previo.paginas.every(f => fs.existsSync(path.join(dirTrabajo, f)));
  if (vigente && (previo.nPartes || null) === (nPartes || null)) return previo;
  let paginas, alta;
  if (vigente) { paginas = previo.paginas; alta = previo.alta; }
  else {
    log('  Convirtiendo las páginas del PDF en imágenes…');
    paginas = generarPaginas(pdf, dirTrabajo, 'pagina', ANCHO_PAGINA);
    if (!paginas.length) throw new ErrorLectura('pdf', 'El PDF no tiene páginas que se puedan convertir en imagen.');
    // Un escaneo (fotos JPEG) ya viene con toda su resolución; un PDF normal se dibuja además al doble de ancho
    alta = /\.jpg$/i.test(paginas[0]) ? paginas : generarPaginas(pdf, dirTrabajo, 'alta', ANCHO_ALTA);
  }
  log('  Buscando los pentagramas, los sistemas y los compases de cada página…');
  const filas = [];
  const escalas = []; // ancho de la imagen de alta resolución entre el de la imagen de página, por página
  paginas.forEach((f, p) => {
    const img = PI.enderezar(PI.leerGris(path.join(dirTrabajo, f)));
    escalas.push(alta === paginas ? 1 : dimensiones(path.join(dirTrabajo, alta[p])).w / img.w);
    const pents = PI.pentagramas(img);
    const sis = PI.sistemas(img, pents, nPartes || Infinity);
    const cuenta = [];
    for (const s of sis) {
      const cajas = PI.compasesDePagina(img, s);
      cuenta.push(cajas.length);
      if (!cajas.length) continue;
      filas.push({ p, w: img.w, h: img.h, t: img.t || 0, y1: s.y1, y5: s.y5, esp: s.esp, x0: s.x0, x1: s.x1, pents: s.pents.map(q => ({ y1: q.y1, y5: q.y5, esp: q.esp })), cajas: cajas.map(c => ({ xa: c.xa, xb: c.xb, limite: c.limite || null })) });
    }
    log(`  página ${p + 1}: ${pents.length} pentagramas, ${sis.length} sistema(s), compases por sistema ${cuenta.join('+') || 0}`);
  });
  if (!filas.length) throw new ErrorLectura('sin-pentagramas', 'No se han encontrado pentagramas en las páginas del PDF: puede que la imagen sea muy borrosa, esté muy torcida o no sea una partitura.');
  const a = { huella, nPartes: nPartes || null, paginas, alta, escalas, filas, compases: filas.reduce((n, f) => n + f.cajas.length, 0) };
  a.consultas = planificar(a).length;
  fs.writeFileSync(archivo, JSON.stringify(a));
  return a;
}

// Tramos de fila que caben en una consulta: la imagen de cada pentagrama no debe pasar de LADO_MAX píxeles de ancho (en la
// imagen de alta resolución) ni de MAX_COMPASES compases. Devuelve [{ k, fila, p, desde, hasta, numero, xIni, xFin }]
function planificar(a) {
  const consultas = [];
  let numero = 1;
  a.filas.forEach((f, fi) => {
    const margen = f.esp * 1.5;
    for (let i = 0; i < f.cajas.length;) {
      const inicio = i === 0 ? Math.min(f.x0, f.cajas[0].xa) : f.cajas[i].xa;
      let j = i;
      const conClave = (i > 0 ? ANCHO_CLAVE : ANCHO_ETIQUETA) * f.esp; // delante van las etiquetas de las voces (y, si el tramo no empieza la fila, la clave y la armadura)
      while (j + 1 < f.cajas.length && j + 1 - i < MAX_COMPASES && (f.cajas[j + 1].xb - inicio + 2 * margen + conClave) * escalaFila(a, f) <= LADO_MAX) j++;
      consultas.push({ k: consultas.length, fila: fi, p: f.p, desde: i, hasta: j, numero, xIni: inicio, xFin: f.cajas[j].xb });
      numero += j - i + 1; i = j + 1;
    }
  });
  return consultas;
}

// Coste estimado de leer la obra con un modelo: { consultas, coste, compases }
function estimar(a, modelo = MODELO_PREDETERMINADO, nVocesPorFila = null) {
  const plan = planificar(a);
  const [pe, ps, pcl, pce] = R.precioDe(modelo);
  const T = TOKENS_TIPICOS;
  let entrada = T.vistaEntrada, salida = T.vistaSalida, cache = 0;
  for (const c of plan) {
    const f = a.filas[c.fila], nP = nVocesPorFila || f.pents.length, nC = c.hasta - c.desde + 1;
    entrada += T.fijoEntrada + nP * T.imagenEntrada; cache += T.cacheTramo; // el prompt del sistema se lee de la caché
    salida += T.fijoSalida + nP * nC * T.porCompasVoz;
  }
  return { consultas: plan.length + 1, compases: a.compases, coste: (entrada * pe + salida * ps + cache * pcl + T.cacheTramo * pce) / 1e6, tokens: { entrada, salida } };
}
function estimaciones(a) { return Object.fromEntries(MODELOS.map(m => [m.id, estimar(a, m.id)])); }

// Lo que la interfaz necesita saber: clave, modelos y predeterminado
function estado() {
  return { clave: SIMULADA || !!R.leerClave(), archivoClave: R.ARCHIVO_CLAVE, modelos: MODELOS, predeterminado: MODELOS.some(m => m.id === MODELO_PREDETERMINADO) ? MODELO_PREDETERMINADO : MODELOS[0].id, simulada: SIMULADA };
}

// ---------- 2. Recortes: una imagen por pentagrama del tramo, con los compases numerados ----------
// Devuelve [{ png, ancho, alto }] en el orden de los pentagramas de la fila (solo los índices pedidos)
function recortarTiras(a, dirTrabajo, c, indices) {
  const f = a.filas[c.fila], esc = a.escalas[f.p];
  const ruta = path.join(dirTrabajo, a.alta[f.p]);
  const margen = f.esp * 1.5;
  // el primer tramo de la fila empieza en el margen izquierdo, donde están las etiquetas de las voces
  const xa = Math.max(0, c.xIni - (c.desde === 0 ? ANCHO_ETIQUETA * f.esp : margen)), xb = Math.min(f.w, c.xFin + margen);
  // Si el tramo no empieza la fila, delante va el principio de la fila (clave y armadura), separado por una franja gris
  const clave = c.desde > 0 ? { xa: Math.max(0, f.x0 - ANCHO_ETIQUETA * f.esp), xb: Math.min(f.w, f.x0 + (ANCHO_CLAVE - ANCHO_ETIQUETA - 0.5) * f.esp) } : null;
  const anchoClave = clave ? clave.xb - clave.xa : 0, HUECO = 14;
  const s = Math.min(escalaFila(a, f) / esc, LADO_MAX / ((xb - xa + anchoClave) * esc)); // reducción sobre la imagen de alta resolución (un compás solo demasiado ancho se reduce más)
  const cx = f.w / 2, t = f.t, dMin = Math.min((xa - cx) * t, (xb - cx) * t), dMax = Math.max((xa - cx) * t, (xb - cx) * t);
  const BANDA = 30;
  const tiras = indices.map(i => {
    const q = f.pents[i], ant = f.pents[i - 1], sig = f.pents[i + 1];
    const arriba = q.y1 - (ant ? Math.min(3.5 * q.esp, (q.y1 - ant.y5) * 0.5) : 5 * q.esp); // encima del primero va el tempo
    const abajo = q.y5 + Math.min(8 * q.esp, sig ? (sig.y1 - q.y5) - q.esp : 1e9);
    return { ya: Math.max(0, arriba + dMin), yb: Math.min(f.h, abajo + dMax) };
  });
  const barras = []; for (let i = c.desde; i <= c.hasta; i++) barras.push(f.cajas[i].xa); barras.push(f.cajas[c.hasta].xb);
  const numeros = []; for (let i = c.desde; i <= c.hasta; i++) numeros.push({ n: c.numero + i - c.desde, x: (f.cajas[i].xa + f.cajas[i].xb) / 2 });
  const base = path.join(os.tmpdir(), `tira-${process.pid}-${Date.now()}-${c.k}`);
  const salidas = tiras.map((_, i) => `${base}-${i}.png`);
  const ps = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Bitmap]::FromFile('${ps1(path.resolve(ruta))}')
$e = ${esc}; $s = ${s}
$xa = ${xa}; $xb = ${xb}; $cxa = ${clave ? clave.xa : 0}; $cw = ${anchoClave}; $desp = ${clave ? 1 : 0}
$gris = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 190, 190, 190), 2)
$font = [System.Drawing.Font]::new('Arial', 15, [System.Drawing.FontStyle]::Bold)
$naranja = [System.Drawing.Color]::FromArgb(235, 227, 120, 20)
$brush = [System.Drawing.SolidBrush]::new($naranja)
$pen = [System.Drawing.Pen]::new($naranja, 3)
$fmt = [System.Drawing.StringFormat]::new(); $fmt.Alignment = [System.Drawing.StringAlignment]::Center
${tiras.map((tr, i) => `
$ya = ${tr.ya}; $yb = ${tr.yb}
$nh = [int][math]::Round(($yb - $ya) * $e * $s); $wc = [int][math]::Round($cw * $e * $s); $off = $desp * ($wc + ${HUECO}); $nw = [int][math]::Round(($xb - $xa) * $e * $s) + $off
$dst = [System.Drawing.Bitmap]::new($nw, ($nh + ${BANDA}), [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($dst)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$g.Clear([System.Drawing.Color]::White)
$g.DrawImage($src, [System.Drawing.Rectangle]::new($off, ${BANDA}, $nw - $off, $nh), [System.Drawing.Rectangle]::new([int][math]::Round($xa * $e), [int][math]::Round($ya * $e), [int][math]::Round(($xb - $xa) * $e), [int][math]::Round(($yb - $ya) * $e)), [System.Drawing.GraphicsUnit]::Pixel)
if ($desp) { $g.DrawImage($src, [System.Drawing.Rectangle]::new(0, ${BANDA}, $wc, $nh), [System.Drawing.Rectangle]::new([int][math]::Round($cxa * $e), [int][math]::Round($ya * $e), [int][math]::Round($cw * $e), [int][math]::Round(($yb - $ya) * $e)), [System.Drawing.GraphicsUnit]::Pixel); $g.FillRectangle([System.Drawing.Brushes]::White, $wc, 0, ${HUECO}, $nh + ${BANDA}); $g.DrawLine($gris, $wc + ${HUECO / 2}, 0, $wc + ${HUECO / 2}, $nh + ${BANDA}) }
${barras.map(bx => `$x = $off + [int][math]::Round((${bx} - $xa) * $e * $s); $g.DrawLine($pen, $x, 0, $x, $nh + ${BANDA})`).join('\n')}
${numeros.map(nu => `$g.DrawString('${nu.n}', $font, $brush, [single]($off + (${nu.x} - $xa) * $e * $s), [single]4, $fmt)`).join('\n')}
$g.Dispose()
$dst.Save('${ps1(salidas[i])}', [System.Drawing.Imaging.ImageFormat]::Png); $dst.Dispose()
Write-Output "$nw $($nh + ${BANDA})"`).join('\n')}
$src.Dispose()`;
  const tmp = base + '.ps1';
  fs.writeFileSync(tmp, '﻿' + ps, 'utf8');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], { stdio: 'pipe', timeout: 180000 }).toString().trim().split(/\r?\n/);
    return salidas.map((ruta, i) => {
      const [ancho, alto] = (out[i] || '').split(/\s+/).map(Number);
      const png = fs.readFileSync(ruta);
      if (!png.length || !ancho) throw new Error('el recorte ha salido vacío');
      return { png, ancho, alto };
    });
  } catch (e) {
    throw new ErrorLectura('recorte', 'No se ha podido recortar la página ' + (f.p + 1) + ': ' + (e.stderr ? e.stderr.toString().split('\n')[0] : e.message), 500);
  } finally { try { fs.unlinkSync(tmp); } catch {} for (const r of salidas) { try { fs.unlinkSync(r); } catch {} } }
}

// ---------- Esquemas JSON ----------
const CLAVE = { type: 'object', additionalProperties: false, required: ['sign', 'line', 'octava'], properties: { sign: { type: 'string', enum: ['G', 'F', 'C'] }, line: { type: 'integer', enum: [1, 2, 3, 4, 5] }, octava: { type: 'integer', enum: [-1, 0, 1] } } };
const ESQUEMA_VISTA = {
  type: 'object', additionalProperties: false, required: ['titulo', 'compositor', 'pentagramasPorSistema', 'pentagramasVarian', 'pentagramas', 'indicacion', 'tempo', 'anacrusa', 'avisos'],
  properties: {
    titulo: { type: 'string' }, compositor: { type: 'string' }, pentagramasPorSistema: { type: 'integer' }, pentagramasVarian: { type: 'boolean' },
    pentagramas: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['nombre', 'tipo', 'clave', 'armadura'], properties: {
      nombre: { type: 'string' }, tipo: { type: 'string', enum: ['coro', 'solista', 'instrumento'] }, clave: CLAVE, armadura: { type: 'integer' } } } },
    indicacion: { type: 'string' }, tempo: { type: 'integer' }, anacrusa: { type: 'boolean' }, avisos: { type: 'string' },
  },
};
const NOTA = { type: 'object', additionalProperties: false,
  required: ['silencio', 'step', 'alter', 'octave', 'type', 'dot', 'acorde', 'ligaEmpieza', 'ligaTermina', 'tresillo', 'letra'],
  properties: {
    silencio: { type: 'boolean' },
    step: { type: 'string', enum: ['C', 'D', 'E', 'F', 'G', 'A', 'B'] }, alter: { type: 'integer', enum: [-2, -1, 0, 1, 2] }, octave: { type: 'integer', enum: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
    type: { type: 'string', enum: ['whole', 'half', 'quarter', 'eighth', '16th', '32nd'] }, dot: { type: 'integer', enum: [0, 1, 2] },
    acorde: { type: 'boolean' }, ligaEmpieza: { type: 'boolean' }, ligaTermina: { type: 'boolean' }, tresillo: { type: 'boolean' },
    letra: { type: 'string' },
  } };
const ESQUEMA_TRAMO = {
  type: 'object', additionalProperties: false, required: ['pentagramas', 'tempo', 'avisos'],
  properties: {
    pentagramas: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['voz', 'tipo', 'voz2Nombre', 'clave', 'armadura', 'compases'], properties: {
      voz: { type: 'string' }, tipo: { type: 'string', enum: ['coro', 'solista', 'instrumento'] }, voz2Nombre: { type: 'string' }, clave: CLAVE, armadura: { type: 'integer' },
      compases: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['numero', 'abarca', 'indicacion', 'barra', 'anacrusa', 'notas', 'voz2'], properties: {
        numero: { type: 'integer' }, abarca: { type: 'integer' }, indicacion: { type: 'string' }, barra: { type: 'string', enum: ['normal', 'doble', 'final'] }, anacrusa: { type: 'boolean' },
        notas: { type: 'array', items: NOTA }, voz2: { type: 'array', items: NOTA } } } } } } },
    tempo: { type: 'integer' }, avisos: { type: 'string' },
  },
};

// ---------- Textos para el modelo ----------
const SISTEMA_VISTA = `Eres un copista experto en notación musical coral. Te dan la imagen de la primera página de una partitura (impresa o escaneada, a veces con anotaciones a mano) y tienes que describir su estructura en el JSON pedido, para que después se transcriba sistema a sistema.

- titulo: el título de la obra tal como está escrito (sin el compositor). compositor: el autor, o "" si no consta.
- pentagramasPorSistema: cuántos pentagramas tiene cada sistema (cada fila de música) de esta página. Un coro a cuatro voces son 4; con piano de acompañamiento, 6 (los dos del piano cuentan). Si no todos los sistemas tienen los mismos, el del sistema más completo (el que más pentagramas tiene).
- pentagramasVarian: true si en esta página NO todos los sistemas tienen el mismo número de pentagramas (por ejemplo, un primer sistema con una sola voz y luego el coro entero, o un pentagrama de más cuando una voz se divide); false si todos tienen los mismos.
- pentagramas: los pentagramas del PRIMER sistema, de arriba abajo, uno por entrada. nombre: la voz, en castellano y con uno de estos nombres cuando encaje: Soprano, Mezzosoprano, Contralto, Tenor, Barítono, Bajo, Solista, Piano (las abreviaturas S., A., T., B., Cantus, Altus, Bassus… se traducen); si no hay nombre escrito, dedúcelo por la clave y la posición (sol, sol, sol con 8, fa = Soprano, Contralto, Tenor, Bajo). Dos voces en un mismo pentagrama (soprano y contralto juntas) son UN pentagrama con el nombre de la de arriba. tipo: coro para una voz del coro, solista para un solista, instrumento para piano, órgano u otro acompañamiento (cada pentagrama del piano es una entrada con tipo instrumento).
- clave de cada pentagrama: sign G (sol), F (fa) o C (do); line la línea de la clave (sol 2, fa 4, do 3 o 4); octava -1 si es clave de sol con un 8 debajo (tenor, suena una octava más grave), 0 normalmente.
- armadura: las alteraciones de la armadura en quintas: 1 sostenido = 1, 2 sostenidos = 2, 1 bemol = -1, 2 bemoles = -2… sin alteraciones = 0.
- indicacion: la indicación de compás del principio, como "4/4", "3/4", "6/8"; el compás partido (C con una raya) es "2/2" y el C solo es "4/4". Si no hay ninguna, "".
- tempo: la indicación metronómica del principio (♩ = 80) en negras por minuto; 0 si no hay.
- anacrusa: true si la obra empieza con un compás incompleto (anacrusa).
- avisos: una frase en castellano si hay algo que convenga saber (la página no es una partitura, hay varias obras, los pentagramas cambian de un sistema a otro…); si no, "".`;

const SISTEMA_TRAMO = `Eres un copista experto en notación musical coral. Te dan recortes de una partitura (impresa o escaneada, a veces con anotaciones a mano): una imagen por pentagrama de un mismo sistema, de arriba abajo, todas del mismo tramo de compases. Tu trabajo es transcribir esos compases, voz por voz, en el JSON pedido, con todas las notas, silencios, alteraciones, ligaduras y letra.

Cómo mirar las imágenes:
- Cada imagen es un pentagrama (una voz) con lo que hay encima (matices, tempo) y debajo (la letra). La franja blanca de arriba lleva, en naranja, el número de cada compás; las líneas naranjas verticales marcan dónde el programa cree que están las divisorias. Transcribe SOLO los compases numerados, en orden; lo que asome a los lados es contexto (ligaduras que entran o salen).
- A la izquierda de cada imagen está el margen de la fila, con la etiqueta de la voz si la hay (S., A., T., B., Sopr., Tenor, Órgano, Org.…). Si el tramo no empieza la fila, ese principio de fila (etiqueta, clave y armadura del pentagrama, y a veces la indicación de compás) va separado del tramo por una raya gris. Úsalo para saber qué voz es y leer las alturas; no es un compás que transcribir.
- El número y el orden de los pentagramas pueden cambiar de un sistema a otro (un solo, luego el coro entero, con o sin órgano): decide qué es cada pentagrama en ESTE sistema, por su etiqueta y, si no la hay, por la clave y la tesitura (sol, sol, sol con 8, fa = Soprano, Contralto, Tenor, Bajo; una sola voz en clave de sol con 8 es Tenor).
- Si una línea naranja no cae sobre una divisoria de verdad (parte un compás por la mitad), devuelve ese compás entero una sola vez, con abarca igual al número de tramos naranjas que ocupa (2 si ocupa dos). Si dentro de un tramo numerado hay en realidad dos compases (falta una línea naranja), devuelve dos entradas seguidas con el mismo numero. Lo normal es una entrada por número con abarca 1.
- Las anotaciones a mano (números, flechas, círculos, textos) no son notas: ignóralas.

Convenciones del JSON (las mismas en todas las voces):
- voz: el nombre de la voz de ese pentagrama, en castellano y con uno de estos nombres cuando encaje: Soprano, Mezzosoprano, Contralto, Tenor, Barítono, Bajo, Solista (S./A./T./B., Cantus/Altus/Tenor/Bassus, Sopr./Contr./Ten./Bajo… se traducen); si no hay etiqueta, el que deduzcas por clave y tesitura. Si la obra es para dos coros (C. I / C. II, Coro I / Coro II) o la voz lleva número (S. I y S. II, Soprano 1 y 2), añade el número al nombre: «Soprano 1», «Soprano 2», «Tenor 2»… Para un instrumento, su nombre (Órgano, Piano…).
- tipo: coro para una voz del coro, solista para un solista, instrumento para órgano, piano, reducción o cualquier acompañamiento (pentagramas con llave, acordes y sin letra). Un pentagrama de instrumento se devuelve con compases [] (no se transcribe).
- voz2Nombre: si en el pentagrama cantan DOS voces distintas con plicas separadas (por ejemplo etiquetado «T/B» o «S/A», o tenor y bajo en el mismo pentagrama de fa), el nombre de la de abajo (la de las plicas hacia abajo), que va en voz2 de cada compás; "" en los demás casos (un divisi ocasional de la misma voz no es otra voz: va como acorde o en voz2 sin nombre).
- clave: la clave del pentagrama en estas imágenes (si no se ve ninguna, la que se te indica en el texto). sign G (sol), F (fa) o C (do); line la línea de la clave (sol 2, fa 4); octava -1 cuando es clave de sol con un 8 debajo (tenor), 0 normalmente.
- armadura: las alteraciones de la armadura en quintas: sostenidos positivos, bemoles negativos (1 bemol = -1, 2 sostenidos = 2, nada = 0).
- step/alter/octave: altura en notación científica con Do central = C octava 4. En clave de Sol la segunda línea es Sol4; en clave de Fa la cuarta línea es Fa3; en clave de Sol con 8 abajo todo suena (y se escribe aquí) una octava más grave de lo que se leería. alter es la alteración que SUENA: 1 sostenido, -1 bemol, 0 natural; incluye la de la armadura, las accidentales que arrastra el compás (una alteración vale hasta el final del compás para esa nota) y la de una nota ligada desde el compás anterior.
- type: whole (redonda), half (blanca), quarter (negra), eighth (corchea), 16th (semicorchea), 32nd (fusa). dot: puntillos (0, 1 o 2). tresillo: true si la figura forma parte de un tresillo (tres en el tiempo de dos).
- silencio: true para silencios (entonces step/alter/octave no importan: pon C, 0, 4). Un silencio de compás entero es type whole con silencio true, sea cual sea el compás.
- Las figuras van en orden de lectura, de izquierda a derecha. Las notas que suenan a la vez en la misma voz (acorde, divisi en una sola plica) van seguidas: la primera con acorde false y las demás con acorde true y la misma figura.
- Si en un pentagrama hay dos líneas rítmicas independientes (plicas arriba y abajo con ritmos distintos), la de arriba va en notas y la de abajo en voz2. Si van con el mismo ritmo, escríbelas como acordes en notas y deja voz2 vacío ([]). Normalmente voz2 queda vacío.
- ligaEmpieza/ligaTermina: ligadura de unión (misma altura, la segunda nota no se vuelve a atacar). Una ligadura que viene del compás anterior pone ligaTermina en la primera nota; una que sigue al siguiente pone ligaEmpieza en la última. Las ligaduras de expresión (notas distintas) no cuentan.
- letra: la sílaba escrita bajo la nota, con los guiones tal como van en la partitura: "Tres" (palabra entera), "mo-" (empieza una palabra), "-ri-" (sigue), "-llas" (la termina). Sin letra, "". Si hay varias estrofas (varias líneas de letra), solo la primera. Los silencios llevan "". Las notas ligadas o con una línea de prolongación (melisma) llevan "".
- indicacion: la indicación de compás si en ese compás aparece una nueva (por ejemplo "3/4"; el compás partido es "2/2"); si no cambia, "".
- barra: la barra que cierra el compás: "final" (gruesa: fin de la obra o del movimiento), "doble" (dos finas, o una barra de repetición), "normal" en los demás.
- anacrusa: true solo si el compás está incompleto a propósito: una anacrusa (al principio de la obra o tras una doble barra) o el compás que la completa. false en los demás.
- numero: el número naranja del compás. abarca: cuántos tramos naranjas ocupa (normalmente 1).
- tempo: la indicación metronómica (♩ = 80) si aparece en este tramo, en negras por minuto; 0 si no hay.
- avisos: una frase en castellano si hay algo que el director deba saber (una línea naranja mal puesta, un compás ilegible, un pentagrama que no es una voz del coro); si no, "".

Comprueba antes de responder que, en cada compás y voz, la suma de las figuras (sin contar las notas con acorde true) es la que marca la indicación de compás, salvo en una anacrusa. Devuelve exactamente un pentagrama por imagen, en el mismo orden (los de instrumento también, con compases []), y todos los compases numerados en cada voz del coro.`;

// Con las notas alteradas por su nombre: Sonnet olvidaba a veces el Re♭ de una armadura de cuatro bemoles
function textoArmadura(fifths) {
  const n = Math.abs(fifths || 0);
  if (!n) return 'sin alteraciones';
  const notas = fifths > 0 ? ['Fa♯', 'Do♯', 'Sol♯', 'Re♯', 'La♯', 'Mi♯', 'Si♯'] : ['Si♭', 'Mi♭', 'La♭', 'Re♭', 'Sol♭', 'Do♭', 'Fa♭'];
  return `${n} ${fifths > 0 ? 'sostenido' : 'bemol'}${n > 1 ? (fifths > 0 ? 's' : 'es') : ''} (${notas.slice(0, Math.min(7, n)).join(', ')}: toda nota de esos nombres suena alterada salvo que lleve becuadro)`;
}
function textoClave(c) {
  if (!c) return 'clave desconocida';
  let t = NOMBRE_CLAVE[c.sign] || 'clave ' + c.sign;
  if (c.sign === 'C' && c.line) t += ' en ' + c.line + 'ª';
  if (c.octava < 0) t += ' con 8 debajo (suena una octava más grave)';
  if (c.octava > 0) t += ' con 8 encima';
  return t;
}
const negrasDeIndicacion = ind => { const m = /^(\d+)\/(\d+)$/.exec(ind || ''); return m ? 4 * +m[1] / +m[2] : 4; };

// Texto de una consulta de tramo: obra, compases, pentagramas (con la voz que se cree que es cada uno) y lo que se pide
function textoTramo({ titulo, c, plan, fila, sugeridas, indicacion }) {
  const nC = c.hasta - c.desde + 1;
  let t = `Obra: «${titulo || 'sin título'}». Consulta ${c.k + 1} de ${plan.length}: compases ${c.numero} a ${c.numero + nC - 1} (sistema de la página ${c.p + 1}, ${nC} compás${nC === 1 ? '' : 'es'} numerado${nC === 1 ? '' : 's'}).\n`;
  t += `Indicación de compás vigente: ${indicacion || 'desconocida'}${indicacion ? ` (caben ${negrasDeIndicacion(indicacion)} negras por compás)` : ''}.\n`;
  t += `Imágenes, de arriba abajo (una por pentagrama de este sistema, ${fila.pents.length} en total):\n`;
  for (let i = 0; i < fila.pents.length; i++) {
    const s = sugeridas && sugeridas[i];
    t += s ? ` ${i + 1}. probablemente ${s.nombre}${s.tipo === 'instrumento' ? ' (instrumento)' : ''} — ${textoClave(s.clave)}, armadura: ${textoArmadura(s.armadura)}\n` : ` ${i + 1}. (voz por identificar: mira la etiqueta del margen izquierdo, la clave y la tesitura)\n`;
  }
  if (!sugeridas) t += `(Este sistema tiene ${fila.pents.length} pentagramas; el primero de la obra tenía ${fila.nVista}: la plantilla cambia, así que identifica cada pentagrama por su etiqueta, clave y tesitura.)\n`;
  t += `\nDevuelve los ${nC} compases numerados de cada voz del coro (${fila.pents.length} entradas en pentagramas, en el mismo orden que las imágenes; los instrumentos con compases []), con su letra.`;
  return t;
}

// ---------- Llamada a la API (en streaming: las respuestas son largas) ----------
const CON_FALLBACK = m => /^claude-(opus|sonnet|fable)-5/.test(m);
async function llamar({ clave, modelo, sistema, imagenes, texto, esquema, maxTokens = 32000, effort = 'high', senal }) {
  const cuerpo = {
    model: modelo, max_tokens: maxTokens, stream: true,
    system: [{ type: 'text', text: sistema, cache_control: { type: 'ephemeral' } }],
    output_config: { effort, format: { type: 'json_schema', schema: esquema } },
    messages: [{ role: 'user', content: [...imagenes.map(png => ({ type: 'image', source: { type: 'base64', media_type: tipoImagen(png), data: png.toString('base64') } })), { type: 'text', text: texto }] }],
  };
  if (CON_FALLBACK(modelo)) cuerpo.fallbacks = 'default';
  const control = new AbortController();
  let temporizador = null;
  const reloj = () => { clearTimeout(temporizador); temporizador = setTimeout(() => control.abort(new Error('sin-respuesta')), 180000); };
  const alCancelar = () => control.abort(new Error('cancelado'));
  if (senal) { if (senal.aborted) throw new ErrorLectura('cancelado', 'Lectura parada.', 499); senal.addEventListener('abort', alCancelar, { once: true }); }
  let r;
  try {
    reloj();
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: control.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': clave, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
      body: JSON.stringify(cuerpo),
    });
  } catch (e) {
    clearTimeout(temporizador);
    if (senal && senal.aborted) throw new ErrorLectura('cancelado', 'Lectura parada.', 499);
    if (control.signal.aborted) throw new ErrorLectura('api', 'El modelo ha tardado demasiado en responder. Vuelve a intentarlo.', 504);
    const codigo = e && e.cause && e.cause.code;
    if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(codigo) || /fetch failed/i.test(e.message)) throw new ErrorLectura('sin-internet', 'No hay conexión a internet (o la red corta el acceso a api.anthropic.com). La lectura con IA necesita internet; el resto del gestor funciona igual.', 503);
    throw new ErrorLectura('api', 'No se ha podido hablar con la API: ' + e.message, 502);
  }
  if (!r.ok) {
    clearTimeout(temporizador);
    const datos = await r.json().catch(() => ({}));
    const msg = (datos.error && datos.error.message) || ('error ' + r.status);
    if (r.status === 401) throw new ErrorLectura('sin-clave', `La API no acepta la clave de ${R.ARCHIVO_CLAVE} (${msg}). Comprueba que está entera y vigente.`, 401);
    if (r.status === 402 || r.status === 403) throw new ErrorLectura('api', 'La cuenta de la API no permite la petición (saldo o permisos): ' + msg, r.status);
    if (r.status === 404) throw new ErrorLectura('api', `El modelo ${modelo} no está disponible para esta cuenta (${msg}). Elige otro modelo.`, 404);
    if (r.status === 429) throw new ErrorLectura('api', 'Demasiadas peticiones seguidas a la API: espera un minuto y vuelve a intentarlo.', 429);
    if (r.status === 413) throw new ErrorLectura('api', 'Las imágenes son demasiado grandes para la API: ' + msg, 413);
    if (r.status >= 500) throw new ErrorLectura('api', 'El servicio de Claude está saturado o caído ahora mismo (' + r.status + '). Vuelve a intentarlo en un minuto.', 503);
    throw new ErrorLectura('api', 'La API ha rechazado la petición: ' + msg, 502);
  }
  // Eventos SSE: message_start (uso de entrada), content_block_delta (texto), message_delta (parada y uso de salida)
  let texto_ = '', uso = {}, parada = null, detalles = null, modeloResp = modelo, resto = '';
  const decoder = new TextDecoder();
  const procesar = bloque => {
    let evento = null, datos = '';
    for (const l of bloque.split(/\r?\n/)) { if (l.startsWith('event:')) evento = l.slice(6).trim(); else if (l.startsWith('data:')) datos += l.slice(5).trim(); }
    if (!datos) return;
    let d; try { d = JSON.parse(datos); } catch { return; }
    if (evento === 'message_start' && d.message) { Object.assign(uso, d.message.usage || {}); modeloResp = d.message.model || modelo; }
    else if (evento === 'content_block_delta' && d.delta && d.delta.type === 'text_delta') texto_ += d.delta.text;
    else if (evento === 'message_delta') { if (d.delta) { parada = d.delta.stop_reason || parada; detalles = d.delta.stop_details || detalles; } for (const [k, v] of Object.entries(d.usage || {})) if (v != null) uso[k] = v; }
    else if (evento === 'error' || d.type === 'error') throw new ErrorLectura('api', 'La API ha devuelto un error a mitad de la respuesta: ' + ((d.error && d.error.message) || 'desconocido'), 502);
  };
  try {
    const lector = r.body.getReader();
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      reloj();
      resto += decoder.decode(value, { stream: true });
      const partes = resto.split(/\r?\n\r?\n/); resto = partes.pop();
      for (const p of partes) procesar(p);
    }
    if (resto.trim()) procesar(resto);
  } catch (e) {
    if (e instanceof ErrorLectura) throw e;
    if (senal && senal.aborted) throw new ErrorLectura('cancelado', 'Lectura parada.', 499);
    if (control.signal.aborted) throw new ErrorLectura('api', 'La respuesta del modelo se ha quedado a medias (sin datos durante tres minutos). Vuelve a intentarlo.', 504);
    throw new ErrorLectura('api', 'Se ha cortado la respuesta de la API: ' + e.message, 502);
  } finally { clearTimeout(temporizador); if (senal) senal.removeEventListener('abort', alCancelar); }
  if (parada === 'refusal') throw new ErrorLectura('api', 'El modelo ha declinado responder a esta petición' + (detalles && detalles.explanation ? ': ' + detalles.explanation : '.'), 502);
  if (parada === 'max_tokens') throw new ErrorLectura('api', 'La respuesta del modelo se ha cortado por longitud (el tramo tiene demasiadas notas).', 502);
  let json;
  try { json = JSON.parse(texto_); } catch { throw new ErrorLectura('api', 'La respuesta del modelo no es un JSON válido.', 502); }
  return { json, uso, modelo: modeloResp };
}

// ---------- Respuestas simuladas (GESTOR_IA_SIMULADA=1) ----------
const espera = ms => new Promise(ok => setTimeout(ok, ms));
const NOMBRES_SIMULADOS = ['Soprano', 'Contralto', 'Tenor', 'Bajo', 'Voz 5', 'Voz 6'];
function simularVista(a) {
  const n = Math.max(1, Math.min(6, Math.round(a.filas.reduce((s, f) => s + f.pents.length, 0) / a.filas.length)));
  const pentagramas = NOMBRES_SIMULADOS.slice(0, n).map((nombre, i) => ({ nombre, tipo: 'coro', clave: i === n - 1 && n > 1 ? { sign: 'F', line: 4, octava: 0 } : { sign: 'G', line: 2, octava: nombre === 'Tenor' ? -1 : 0 }, armadura: 0 }));
  return { json: { titulo: 'Obra simulada', compositor: '', pentagramasPorSistema: n, pentagramasVarian: false, pentagramas, indicacion: '4/4', tempo: 80, anacrusa: false, avisos: 'Respuesta simulada (GESTOR_IA_SIMULADA=1): no se ha consultado la API.' }, uso: {}, modelo: 'simulado' };
}
function simularTramo({ c, sugeridas, indicacion }) {
  const negras = negrasDeIndicacion(indicacion || '4/4');
  const ESCALA = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const pentagramas = sugeridas.map((s, si) => {
    const compases = [];
    for (let n = c.numero; n <= c.numero + c.hasta - c.desde; n++) {
      const notas = [];
      for (let q = 0; q < Math.floor(negras); q++) notas.push({ silencio: false, step: ESCALA[(n + q + si * 2) % 7], alter: 0, octave: s.clave && s.clave.sign === 'F' ? 3 : 4, type: 'quarter', dot: 0, acorde: false, ligaEmpieza: false, ligaTermina: false, tresillo: false, letra: ['la', 'le', 'li', 'lo'][q % 4] });
      compases.push({ numero: n, abarca: 1, indicacion: '', barra: 'normal', anacrusa: false, notas, voz2: [] });
    }
    return { voz: s.nombre, tipo: 'coro', voz2Nombre: '', clave: s.clave, armadura: s.armadura || 0, compases };
  });
  return { json: { pentagramas, tempo: 0, avisos: '' }, uso: {}, modelo: 'simulado' };
}

// ---------- 3. Del JSON al MusicXML ----------
const escapar = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ACC = { 1: 'sharp', 2: 'double-sharp', '-1': 'flat', '-2': 'flat-flat', 0: 'natural' };
const SOSTENIDOS = ['F', 'C', 'G', 'D', 'A', 'E', 'B'], BEMOLES = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
function alteracionDeArmadura(fifths, step) {
  if (fifths > 0) return SOSTENIDOS.slice(0, Math.min(7, fifths)).includes(step) ? 1 : 0;
  if (fifths < 0) return BEMOLES.slice(0, Math.min(7, -fifths)).includes(step) ? -1 : 0;
  return 0;
}
const negrasDeNota = n => (FIGURAS[n.type] || 1) * (n.dot === 2 ? 1.75 : n.dot === 1 ? 1.5 : 1) * (n.tresillo ? 2 / 3 : 1);
// "mo-" → begin, "-ri-" → middle, "-llas" → end, "Tres" → single. Las líneas de prolongación (_) no son letra.
function silabaDe(letra) {
  let t = String(letra || '').replace(/[_—–]+/g, '').trim();
  const ini = /^-\s*/.test(t), fin = /\s*-$/.test(t);
  t = t.replace(/^-\s*/, '').replace(/\s*-$/, '').trim();
  if (!t) return null;
  return { texto: t, silabica: ini && fin ? 'middle' : ini ? 'end' : fin ? 'begin' : 'single' };
}
// Una nota del modelo → XML (o null si no vale). acordeValido: hay una nota anterior en la voz a la que pegarse
function xmlDeNota(n, voz, fifths, acordeValido, alteradas) {
  if (!FIGURAS[n.type]) return null;
  const silencio = !!n.silencio;
  if (!silencio && !/^[A-G]$/.test(n.step || '')) return null;
  const dur = n.entero ? n.duracionEntera : Math.round(negrasDeNota(n) * DIVISIONES);
  const acorde = !silencio && !!n.acorde && acordeValido;
  const alter = silencio ? 0 : Math.max(-2, Math.min(2, +n.alter || 0)), octave = silencio ? 4 : Math.max(0, Math.min(8, +n.octave || 4));
  let s = '<note>' + (acorde ? '<chord/>' : '');
  s += silencio ? (n.entero ? '<rest measure="yes"/>' : '<rest/>') : `<pitch><step>${n.step}</step><alter>${alter}</alter><octave>${octave}</octave></pitch>`;
  s += `<duration>${dur}</duration>`;
  const ligas = silencio ? [] : [n.ligaTermina && 'stop', n.ligaEmpieza && 'start'].filter(Boolean);
  s += ligas.map(t => `<tie type="${t}"/>`).join('');
  s += `<voice>${voz}</voice><type>${n.type}</type>` + '<dot/>'.repeat(Math.max(0, Math.min(2, +n.dot || 0)));
  if (!silencio) {
    // alteración escrita: cuando la que suena no es la de la armadura (o la que ya lleva esa nota en el compás)
    const k = n.step + octave, previa = alteradas.has(k) ? alteradas.get(k) : alteracionDeArmadura(fifths, n.step);
    if (alter !== previa && !n.ligaTermina) s += `<accidental>${ACC[alter]}</accidental>`;
    alteradas.set(k, alter);
  }
  if (n.tresillo) s += '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>';
  s += '<staff>1</staff>';
  if (ligas.length) s += '<notations>' + ligas.map(t => `<tied type="${t}"/>`).join('') + '</notations>';
  const sil = silencio ? null : silabaDe(n.letra);
  if (sil) s += `<lyric number="1" placement="below"><syllabic>${sil.silabica}</syllabic><text>${escapar(sil.texto)}</text></lyric>`;
  return { xml: s + '</note>', dur: acorde ? 0 : dur };
}
const nombreNormal = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// Nombre de voz en castellano a partir de lo que diga el modelo (S., Alto, Bassus, Org.…); null si es un instrumento
const RANGO_VOZ = { Solista: 0, Soprano: 1, Mezzosoprano: 2, Contralto: 3, Tenor: 4, Barítono: 5, Bajo: 6 };
function nombreVoz(nombre) {
  let n = String(nombre || '').split('/')[0].trim().replace(/[.:]+$/, '').toLowerCase(); // «T/B»: la primera; la segunda va en voz2Nombre
  if (!n) return 'Voz';
  // número de la voz o del coro al final («soprano ii», «s. 2», «sopr. i»): se conserva como « 2», « 1»…
  const num = (n.match(/\s(i{1,3}|iv|[1-4])[º°.]?$/) || [])[1];
  const sufijo = num ? ' ' + ({ i: 1, ii: 2, iii: 3, iv: 4 }[num] || +num) : '';
  if (num) n = n.slice(0, n.length - num.length).trim().replace(/[\s.:º°]+$/, '');
  const con = x => x === null ? null : x + sufijo;
  if (/piano|órgano|organo|organ\b|org\b|teclado|reducci|acomp|clave\b|cembalo|arpa|guitar|instrum/.test(n)) return null;
  if (/mezzo/.test(n)) return con('Mezzosoprano');
  if (/^(s|sop|sopr|soprano|sopranos|cantus|canto|superius|discantus|c)$/.test(n) || /soprano|cantus|superius/.test(n)) return con('Soprano');
  if (/^(a|alt|alto|altos|altus|contralto|contraltos|contr)$/.test(n) || /contralto|altus|^alto\b/.test(n)) return con('Contralto');
  if (/^(t|ten|tenor|tenore|tenores)$/.test(n) || /tenor/.test(n)) return con('Tenor');
  if (/bar[ií]ton/.test(n)) return con('Barítono');
  if (/^(b|bajo|bajos|bass|basso|bassus|baixo)$/.test(n) || /\bbajo\b|\bbass|basso/.test(n)) return con('Bajo');
  if (/^solo\b|solista|^sol$/.test(n)) return con('Solista');
  return String(nombre).trim().charAt(0).toUpperCase() + String(nombre).trim().slice(1);
}
// Los pentagramas que devuelve el modelo para un tramo → [{ nombre, datos }], solo las voces del coro: un pentagrama con dos
// voces nombradas (voz2Nombre) se desdobla en dos, y un nombre repetido en el mismo sistema se numera
function vocesDelTramo(pentagramasModelo) {
  const out = [];
  for (const pm of pentagramasModelo || []) {
    if (pm.tipo === 'instrumento') continue;
    const nombre = nombreVoz(pm.voz); if (!nombre) continue;
    const segunda = pm.voz2Nombre ? nombreVoz(pm.voz2Nombre) : null;
    if (segunda && segunda !== nombre && (pm.compases || []).some(c => Array.isArray(c.voz2) && c.voz2.length)) {
      out.push({ nombre, datos: { ...pm, compases: (pm.compases || []).map(c => ({ ...c, voz2: [] })) } });
      out.push({ nombre: segunda, datos: { ...pm, voz: segunda, compases: (pm.compases || []).map(c => ({ ...c, notas: c.voz2 || [], voz2: [] })) } });
    } else out.push({ nombre, datos: pm });
  }
  const vistos = {};
  for (const o of out) { vistos[o.nombre] = (vistos[o.nombre] || 0) + 1; if (vistos[o.nombre] > 1) o.nombre += ' ' + vistos[o.nombre]; }
  return out;
}

// Monta el MusicXML y las posiciones a partir de la vista general y las respuestas de cada consulta.
// Devuelve { xml, posiciones: { paginas, compases }, avisos, compases, dudosos }
function construirXml({ vista, plan, respuestas, a }) {
  const avisos = [];
  // Las partes se van creando según las voces que el modelo ve en cada sistema (la plantilla puede cambiar a mitad de
  // obra); al final se ordenan de aguda a grave (Solista, Soprano… Bajo, y las demás por orden de aparición)
  const porNombre = new Map();
  const parteDe = (nombre, datos) => {
    if (!porNombre.has(nombre)) porNombre.set(nombre, { id: 'P' + (porNombre.size + 1), nombre, clave: datos.clave, armadura: Number.isInteger(datos.armadura) ? datos.armadura : 0, orden: porNombre.size });
    return porNombre.get(nombre);
  };
  if (vista.avisos) avisos.push('Vista general: ' + vista.avisos);
  // 1) Las medidas finales, con la estructura decidida por mayoría entre los pentagramas de cada consulta
  const medidas = []; // { k, fila, cajas: [{ i, f0, f1 }], voces: { [id]: entrada }, k }
  for (const c of plan) {
    const r = respuestas[c.k];
    if (!r) { avisos.push(`Falta la respuesta de la consulta ${c.k + 1} (compases ${c.numero}–${c.numero + c.hasta - c.desde}).`); for (let i = c.desde; i <= c.hasta; i++) medidas.push({ k: c.k, fila: c.fila, cajas: [{ i, f0: 0, f1: 1 }], voces: {} }); continue; }
    if (r.avisos) avisos.push(`Compases ${c.numero}–${c.numero + c.hasta - c.desde}: ${r.avisos}`);
    const asignados = vocesDelTramo(r.pentagramas).map(v => ({ parte: parteDe(v.nombre, v.datos), datos: v.datos }));
    if (!asignados.length) { avisos.push(`Sistema de la página ${c.p + 1} (tramo ${c.numero}): la IA no ha visto ninguna voz del coro (solo instrumentos); no aporta compases.`); continue; }
    const ultimo = c.numero + c.hasta - c.desde;
    let n = c.numero;
    while (n <= ultimo) {
      let total = 0, unen = 0, partenEn = [];
      let maxAbarca = 1;
      for (const s of asignados) {
        const e = (s.datos.compases || []).filter(x => +x.numero === n);
        if (!e.length) continue; total++;
        if (+e[0].abarca >= 2 && e.length === 1) { unen++; maxAbarca = Math.max(maxAbarca, Math.min(+e[0].abarca, ultimo - n + 1)); }
        if (e.length >= 2) partenEn.push(e.length);
      }
      const abarca = total && unen > total / 2 ? maxAbarca : 1;
      const trozos = abarca === 1 && total && partenEn.length > total / 2 ? Math.min(...partenEn) : 1;
      if (abarca > 1) avisos.push(`Compás ${n}: la divisoria detectada en la página no era real; se han unido ${abarca} tramos en un compás.`);
      if (trozos > 1) avisos.push(`Tramo ${n} de la página: contiene ${trozos} compases que el detector había juntado.`);
      for (let tr = 0; tr < trozos; tr++) {
        const cajas = [];
        for (let q = 0; q < abarca; q++) cajas.push({ i: c.desde + (n - c.numero) + q, f0: trozos > 1 ? tr / trozos : 0, f1: trozos > 1 ? (tr + 1) / trozos : 1 });
        const m = { k: c.k, fila: c.fila, cajas, voces: {} };
        for (const s of asignados) {
          const propias = (s.datos.compases || []).filter(x => +x.numero >= n && +x.numero < n + abarca);
          let entrada = null;
          if (trozos > 1) entrada = propias[tr] || (tr === 0 ? propias[0] : null);
          else if (propias.length === 1) entrada = propias[0];
          else if (propias.length > 1) entrada = { ...propias[0], notas: propias.flatMap(x => x.notas || []), voz2: propias.flatMap(x => x.voz2 || []) }; // dijo varios compases donde la mayoría ve uno
          if (entrada) m.voces[s.parte.id] = { ...entrada, clave: s.datos.clave, armadura: s.datos.armadura };
        }
        medidas.push(m);
      }
      n += abarca;
    }
    if (r.tempo > 0 && !vista.tempo) vista.tempo = r.tempo;
  }
  const rango = p => { const r = RANGO_VOZ[p.nombre.replace(/ \d+$/, '')]; return r === undefined ? 7 + p.orden : r; };
  const numero = p => +((p.nombre.match(/ (\d+)$/) || [])[1] || 0);
  const partes = [...porNombre.values()].sort((x, y) => rango(x) - rango(y) || numero(x) - numero(y) || x.orden - y.orden).map((p, i) => ({ ...p, id: 'P' + (i + 1), viejoId: p.id }));
  if (!partes.length) throw new ErrorLectura('sin-voces', 'La IA no ha encontrado ninguna voz del coro en la partitura (solo instrumentos).');
  for (const m of medidas) { const voces = {}; for (const p of partes) if (m.voces[p.viejoId]) voces[p.id] = m.voces[p.viejoId]; m.voces = voces; }
  // 2) Decisiones por compás (mayoría entre voces): indicación, barra, anacrusa
  const mayoria = (m, f) => { const votos = {}; for (const v of Object.values(m.voces)) { const x = f(v); if (x != null && x !== '') votos[x] = (votos[x] || 0) + 1; } const mejor = Object.entries(votos).sort((p, q) => q[1] - p[1])[0]; return mejor ? mejor[0] : null; };
  let indicacion = /^\d+\/\d+$/.test(vista.indicacion || '') ? vista.indicacion : null;
  if (!indicacion) { const primera = medidas.map(m => mayoria(m, v => /^\d+\/\d+$/.test(v.indicacion || '') ? v.indicacion : null)).find(Boolean); indicacion = primera || '4/4'; if (!primera) avisos.push('No se ha leído la indicación de compás: se supone 4/4.'); }
  medidas.forEach((m, i) => {
    const nueva = mayoria(m, v => /^\d+\/\d+$/.test(v.indicacion || '') ? v.indicacion : null);
    m.cambiaCompas = !!(nueva && nueva !== indicacion) || i === 0;
    if (nueva && nueva !== indicacion) indicacion = nueva;
    m.indicacion = indicacion;
    const caja = a.filas[m.fila].cajas[m.cajas[m.cajas.length - 1].i];
    const barra = mayoria(m, v => v.barra);
    m.barra = (caja && caja.limite === 'final') || barra === 'final' ? 'final' : (barra === 'doble' || (caja && caja.limite === 'doble')) ? 'doble' : null;
    if (m.barra === 'final' && i < medidas.length - 1 && !medidas.slice(i + 1).some(x => Object.keys(x.voces).length)) m.barra = 'final';
    const votosAnacrusa = Object.values(m.voces).filter(v => v.anacrusa).length;
    m.anacrusa = votosAnacrusa > 0 && votosAnacrusa >= Object.keys(m.voces).length / 2;
  });
  // 3) El XML
  const [beats0, bt0] = (medidas[0] ? medidas[0].indicacion : '4/4').split('/').map(Number);
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n<score-partwise version="3.1">\n`;
  xml += `\t<work>\n\t\t<work-title>${escapar(vista.titulo || 'Obra')}</work-title>\n\t</work>\n\t<identification>\n${vista.compositor ? `\t\t<creator type="composer">${escapar(vista.compositor)}</creator>\n` : ''}\t\t<encoding>\n\t\t\t<software>Gestor de obras · lectura con IA (${escapar(vista.modelo || 'Claude')})</software>\n\t\t\t<encoding-date>${new Date().toISOString().slice(0, 10)}</encoding-date>\n\t\t</encoding>\n\t</identification>\n`;
  xml += '\t<part-list>\n' + partes.map((p, i) => `\t\t<score-part id="${p.id}">\n\t\t\t<part-name>${escapar(p.nombre)}</part-name>\n\t\t\t<score-instrument id="${p.id}-I1">\n\t\t\t\t<instrument-name>${escapar(p.nombre)}</instrument-name>\n\t\t\t</score-instrument>\n\t\t\t<midi-instrument id="${p.id}-I1">\n\t\t\t\t<midi-channel>${Math.min(16, i + 1)}</midi-channel>\n\t\t\t\t<midi-program>53</midi-program>\n\t\t\t</midi-instrument>\n\t\t</score-part>`).join('\n') + '\n\t</part-list>\n';
  let dudosos = 0;
  const dudososSet = new Set();
  for (const p of partes) {
    let fifths = p.armadura, clave = p.clave || { sign: 'G', line: 2, octava: 0 }, kVisto = -1;
    xml += `\t<part id="${p.id}">\n`;
    medidas.forEach((m, i) => {
      const v = m.voces[p.id] || null;
      const [beats, bt] = m.indicacion.split('/').map(Number);
      const esperado = Math.round(DIVISIONES * 4 * beats / bt);
      let atributos = '';
      if (i === 0) atributos += `<divisions>${DIVISIONES}</divisions>`;
      // armadura y clave: las que diga el modelo para este pentagrama en esta consulta, si cambian
      if (v && m.k !== kVisto) {
        kVisto = m.k;
        const nf = Number.isInteger(v.armadura) && Math.abs(v.armadura) <= 7 ? v.armadura : fifths;
        if (i === 0 || nf !== fifths) { fifths = nf; atributos += `<key><fifths>${fifths}</fifths></key>`; }
      } else if (i === 0) atributos += `<key><fifths>${fifths}</fifths></key>`;
      if (m.cambiaCompas) atributos += `<time${m.indicacion === '2/2' ? ' symbol="cut"' : ''}><beats>${beats}</beats><beat-type>${bt}</beat-type></time>`;
      const nc = v && v.clave && ['G', 'F', 'C'].includes(v.clave.sign) ? v.clave : null;
      if (i === 0 || (nc && (nc.sign !== clave.sign || +nc.line !== +clave.line || (+nc.octava || 0) !== (+clave.octava || 0)))) {
        if (nc) clave = nc;
        atributos += `<clef><sign>${clave.sign}</sign><line>${clave.line || (clave.sign === 'F' ? 4 : clave.sign === 'C' ? 3 : 2)}</line>${clave.octava ? `<clef-octave-change>${clave.octava}</clef-octave-change>` : ''}</clef>`;
      }
      let cuerpo = atributos ? `\t\t\t<attributes>${atributos}</attributes>\n` : '';
      if (i === 0 && p === partes[0] && vista.tempo > 0) cuerpo += `\t\t\t<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${vista.tempo}</per-minute></metronome></direction-type><sound tempo="${vista.tempo}"/></direction>\n`;
      const alteradas = new Map();
      let suma1 = 0, notas1 = '';
      // un solo silencio de redonda es el silencio de compás entero, dure lo que dure el compás
      const esEntero = lista => Array.isArray(lista) && lista.length === 1 && lista[0].silencio && lista[0].type === 'whole' && !lista[0].dot;
      const entero = { silencio: true, step: 'C', alter: 0, octave: 4, type: 'whole', dot: 0, acorde: false, ligaEmpieza: false, ligaTermina: false, tresillo: false, letra: '', entero: true, duracionEntera: esperado };
      if (v && esEntero(v.notas)) v.notas = [entero];
      for (const n of (v && v.notas) || []) { const x = xmlDeNota(n, 1, fifths, suma1 > 0, alteradas); if (x) { notas1 += '\t\t\t' + x.xml + '\n'; suma1 += x.dur; } }
      if (!notas1) { notas1 = `\t\t\t<note><rest measure="yes"/><duration>${esperado}</duration><voice>1</voice><type>whole</type><staff>1</staff></note>\n`; suma1 = esperado; } // una voz que no canta en ese sistema descansa
      cuerpo += notas1;
      if (v && Array.isArray(v.voz2) && v.voz2.length) {
        let suma2 = 0, notas2 = '';
        const alteradas2 = new Map(alteradas);
        if (esEntero(v.voz2)) v.voz2 = [entero];
        for (const n of v.voz2) { const x = xmlDeNota(n, 2, fifths, suma2 > 0, alteradas2); if (x) { notas2 += '\t\t\t' + x.xml + '\n'; suma2 += x.dur; } }
        if (notas2) { cuerpo += `\t\t\t<backup><duration>${suma1}</duration></backup>\n` + notas2; if (suma2 !== esperado && !(m.anacrusa && suma2 < esperado)) dudososSet.add(i + 1); }
      }
      if (suma1 !== esperado && !(m.anacrusa && suma1 < esperado)) dudososSet.add(i + 1);
      if (m.barra) cuerpo += `\t\t\t<barline location="right"><bar-style>${m.barra === 'final' ? 'light-heavy' : 'light-light'}</bar-style></barline>\n`;
      xml += `\t\t<measure number="${i + 1}"${m.anacrusa ? ' implicit="yes"' : ''}>\n${cuerpo}\t\t</measure>\n`;
    });
    xml += '\t</part>\n';
  }
  xml += '</score-partwise>\n';
  dudosos = dudososSet.size;
  // 4) Posiciones de cada compás en la página (fracciones), deshaciendo el enderezado como posiciones-imagen.js
  const compases = medidas.map(m => {
    const f = a.filas[m.fila], cx = f.w / 2, t = f.t;
    const xa = Math.min(...m.cajas.map(c => { const caja = f.cajas[c.i]; return caja.xa + (caja.xb - caja.xa) * c.f0; }));
    const xb = Math.max(...m.cajas.map(c => { const caja = f.cajas[c.i]; return caja.xa + (caja.xb - caja.xa) * c.f1; }));
    const ya = f.y1 - f.esp * 4, yb = f.y5 + f.esp * 6, da = (xa - cx) * t, db = (xb - cx) * t;
    return { p: f.p, x0: xa / f.w, x1: xb / f.w, y0: Math.max(0, ya + Math.min(da, db)) / f.h, y1: Math.min(f.h, yb + Math.max(da, db)) / f.h };
  });
  return { xml, posiciones: { paginas: a.paginas.length, compases, origen: 'lectura-ia' }, avisos, compases: medidas.length, dudosos, partes: partes.map(p => p.nombre) };
}

// ---------- Leer una obra entera ----------
// avance({ hechas, total, coste, texto }) va contando; cancelado() → true para parar entre consultas (la que esté en
// marcha se aborta). Devuelve { xml, posiciones, paginas (rutas completas), titulo, modelo, coste, uso, consultas, compases,
// dudosos, avisos, segundos, cacheadas }
async function leer({ pdf, dirTrabajo, modelo = MODELO_PREDETERMINADO, log = () => {}, avance = () => {}, cancelado = () => false }) {
  const inicio = Date.now();
  if (!MODELOS.some(m => m.id === modelo) && !SIMULADA) throw new ErrorLectura('modelo', 'Modelo desconocido: ' + modelo);
  const clave = SIMULADA ? 'simulada' : R.leerClave();
  if (!clave) throw R.SIN_CLAVE();
  if (!SIMULADA && process.env.GESTOR_SIN_INTERNET) throw new ErrorLectura('sin-internet', 'El gestor está en modo de prueba sin internet (GESTOR_SIN_INTERNET=1): no se consulta la API. Para probar la interfaz con una respuesta inventada, arranca con GESTOR_IA_SIMULADA=1.', 503);
  const control = new AbortController();
  const comprobar = () => { if (cancelado()) { control.abort(); throw new ErrorLectura('cancelado', 'Lectura parada a petición tuya.', 499); } };
  const dirResp = path.join(dirTrabajo, 'respuestas'); fs.mkdirSync(dirResp, { recursive: true });
  let a = analizar({ pdf, dirTrabajo, log });
  const uso = { entrada: 0, salida: 0, cacheLeida: 0, cacheEscrita: 0 }, sumarUso = u => { uso.entrada += u.input_tokens || 0; uso.salida += u.output_tokens || 0; uso.cacheLeida += u.cache_read_input_tokens || 0; uso.cacheEscrita += u.cache_creation_input_tokens || 0; };
  let coste = 0, cacheadas = 0;
  const archivoResp = nombre => path.join(dirResp, `${modelo}-${a.huella}-v${RECORTE_VERSION}-${nombre}.json`);
  const guardada = nombre => { try { return JSON.parse(fs.readFileSync(archivoResp(nombre), 'utf8')); } catch { return null; } };
  const guardar = (nombre, r) => { try { fs.writeFileSync(archivoResp(nombre), JSON.stringify(r)); } catch {} };
  const consultar = async (nombre, hacer) => {
    const previa = guardada(nombre);
    if (previa) { cacheadas++; return { ...previa, recuperada: true }; }
    comprobar();
    const r = await hacer();
    r.coste = R.costeDe(r.uso, r.modelo); coste += r.coste; sumarUso(r.uso || {});
    guardar(nombre, r);
    return r;
  };

  // Vista general: la primera página con pentagramas
  const total0 = a.consultas + 1;
  avance({ hechas: 0, total: total0, coste, texto: 'Mirando la primera página (título, voces, clave y compás)…' });
  log('  Consulta 1: vista general de la primera página (título, voces, claves, armadura y compás).');
  const pPrimera = a.filas[0].p;
  const vistaR = await consultar('vista', async () => {
    if (SIMULADA) { await espera(700); return simularVista(a); }
    const png = fs.readFileSync(path.join(dirTrabajo, a.paginas[pPrimera]));
    return llamar({ clave, modelo, sistema: SISTEMA_VISTA, imagenes: [png], texto: `Describe la estructura de esta partitura (archivo «${path.basename(pdf)}»).`, esquema: ESQUEMA_VISTA, maxTokens: 8000, effort: 'medium', senal: control.signal });
  });
  const vista = vistaR.json; vista.modelo = vistaR.modelo;
  // TÍTULO EN MAYÚSCULAS → Título en mayúsculas (como hace limpiarXmlAudiveris)
  vista.titulo = String(vista.titulo || '').replace(/\s+/g, ' ').trim();
  if (vista.titulo && vista.titulo === vista.titulo.toUpperCase() && (vista.titulo.match(/\p{L}/gu) || []).length >= 3) vista.titulo = vista.titulo.charAt(0) + vista.titulo.slice(1).toLowerCase();
  if (!Array.isArray(vista.pentagramas) || !vista.pentagramas.length) throw new ErrorLectura('sin-voces', 'La IA no ha reconocido los pentagramas de la primera página.');
  const voces = vista.pentagramas.filter(p => p.tipo !== 'instrumento');
  log(`  «${vista.titulo || '?'}»${vista.compositor ? ' (' + vista.compositor + ')' : ''}: ${vista.pentagramasPorSistema} pentagramas por sistema; voces: ${voces.map(v => v.nombre + ' (' + textoClave(v.clave) + ')').join(', ')}; compás ${vista.indicacion || '?'}, armadura ${textoArmadura(vista.pentagramas[0].armadura)}${vista.tempo ? ', ♩ = ' + vista.tempo : ''}.`);
  if (vista.avisos) log('  * ' + vista.avisos);
  // Si la primera página tiene otro número de pentagramas por sistema del que supuso el análisis, se vuelve a detectar.
  // Pero si el número cambia de un sistema a otro (un solo y luego el coro entero), no se fija ninguno: el detector
  // agrupa los pentagramas por lo que los une en la página. Con un número fijo pequeño (el del primer sistema) partía
  // cada sistema en trozos y la obra salía con el doble o el triple de compases
  const nPartes = vista.pentagramasVarian ? null : Math.max(1, +vista.pentagramasPorSistema || vista.pentagramas.length);
  if (vista.pentagramasVarian) log('  El número de pentagramas cambia de un sistema a otro: los sistemas se toman tal como los ve el detector, sin fijar un número.');
  if (!SIMULADA && (a.nPartes || null) !== nPartes) {
    const antes = a.compases;
    a = analizar({ pdf, dirTrabajo, nPartes, log });
    if (a.compases !== antes) log(`  ${nPartes ? 'Con ' + nPartes + ' pentagramas por sistema' : 'Sin fijar pentagramas por sistema'} el detector cuenta ${a.compases} compases (antes ${antes}).`);
  }
  const plan = planificar(a);
  const total = plan.length + 1;
  // La voz que corresponde a cada pentagrama de una fila: por posición respecto a la primera página (los pentagramas
  // de instrumentos se saltan y no se mandan). Si la fila tiene otro número de pentagramas, se mandan todos con los
  // nombres que se puedan y el modelo dice cuál es cada uno.
  // Se mandan todos los pentagramas de la fila (el modelo dice cuál es cada uno y deja los instrumentos sin transcribir);
  // si la fila tiene los mismos que el primer sistema de la obra, se le sugiere lo que vio la vista general
  const indicesYSugeridas = c => {
    const f = a.filas[c.fila];
    const indices = f.pents.map((_, i) => i);
    const sugeridas = f.pents.length === vista.pentagramas.length ? vista.pentagramas : null;
    return { indices, sugeridas };
  };
  for (const f of a.filas) f.nVista = vista.pentagramas.length;
  const respuestas = {};
  let indicacion = /^\d+\/\d+$/.test(vista.indicacion || '') ? vista.indicacion : '';
  let hechas = 1;
  avance({ hechas, total, coste, texto: `Leyendo ${plan.length} tramos de ${a.compases} compases…` });
  const cola = plan.slice();
  const obrero = async () => {
    while (cola.length) {
      comprobar();
      const c = cola.shift();
      const { indices, sugeridas } = indicesYSugeridas(c);
      const nC = c.hasta - c.desde + 1;
      const r = await consultar(`tramo-${c.k}-p${c.p}-${Math.round(c.xIni)}-${Math.round(c.xFin)}`, async () => { // el nombre lleva la geometría del tramo: si cambia el análisis, la respuesta guardada no vale
        if (SIMULADA) { await espera(900); return simularTramo({ c, sugeridas: sugeridas || a.filas[c.fila].pents.map((_, i) => ({ nombre: 'Voz ' + (i + 1), clave: null, armadura: 0 })), indicacion }); }
        const tiras = recortarTiras(a, dirTrabajo, c, indices);
        const texto = textoTramo({ titulo: vista.titulo, c, plan, fila: a.filas[c.fila], sugeridas, indicacion });
        return llamar({ clave, modelo, sistema: SISTEMA_TRAMO, imagenes: tiras.map(t => t.png), texto, esquema: ESQUEMA_TRAMO, maxTokens: 48000, effort: 'high', senal: control.signal });
      });
      respuestas[c.k] = r.json;
      // la indicación de compás que rija al final de este tramo sirve de contexto a los siguientes (si llegan después)
      for (const p of (r.json.pentagramas || []).slice(0, 1)) for (const m of p.compases || []) if (/^\d+\/\d+$/.test(m.indicacion || '')) indicacion = m.indicacion;
      hechas++;
      log(`  Consulta ${c.k + 2} de ${total}: compases ${c.numero}–${c.numero + nC - 1} (página ${c.p + 1})${r.recuperada ? ' (recuperada de una lectura anterior)' : r.coste ? `, ${r.coste.toFixed(3)} $` : ''}${r.json.avisos ? ' — ' + r.json.avisos : ''}.`);
      avance({ hechas, total, coste, texto: `Compases ${c.numero}–${c.numero + nC - 1} leídos (${hechas - 1} de ${plan.length} tramos).` });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, cola.length) }, obrero));
  const r = construirXml({ vista, plan, respuestas, a }); // sus avisos los enseña prepararObra
  const segundos = Math.round((Date.now() - inicio) / 1000);
  const informe = { modelo: vista.modelo, coste, uso, consultas: total, cacheadas, compases: r.compases, dudosos: r.dudosos, segundos, hora: new Date().toISOString(), titulo: vista.titulo };
  try { fs.writeFileSync(path.join(dirTrabajo, 'lectura.xml'), r.xml); fs.writeFileSync(path.join(dirTrabajo, 'lectura.pos.json'), JSON.stringify(r.posiciones)); fs.writeFileSync(path.join(dirTrabajo, 'informe.json'), JSON.stringify(informe, null, 1)); } catch {}
  log(`  Lectura con IA terminada: ${total} consultas${cacheadas ? ` (${cacheadas} recuperadas de una lectura anterior)` : ''}, ${r.compases} compases, ${r.dudosos} dudoso(s), coste ${coste.toFixed(2)} $ (${uso.entrada} tokens de entrada, ${uso.salida} de salida), ${segundos} s.`);
  return { xml: r.xml, posiciones: r.posiciones, paginas: a.paginas.map(f => path.join(dirTrabajo, f)), titulo: vista.titulo, modelo: vista.modelo, coste, uso, consultas: total, cacheadas, compases: r.compases, dudosos: r.dudosos, avisos: r.avisos, segundos, partes: r.partes };
}

module.exports = { analizar, planificar, estimar, estimaciones, estado, leer, construirXml, recortarTiras, llamar, nombreVoz, vocesDelTramo, MODELOS, MODELO_PREDETERMINADO, ErrorLectura, SIMULADA,
  // para pruebas
  ESQUEMA_TRAMO, ESQUEMA_VISTA, SISTEMA_TRAMO, SISTEMA_VISTA, textoTramo, silabaDe, xmlDeNota };

// ---------- Uso suelto ----------
if (require.main === module) {
  const args = process.argv.slice(2);
  const opcion = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const sueltos = args.filter((x, i) => !x.startsWith('--') && args[i - 1] !== '--modelo');
  const [pdf, salida] = sueltos;
  if (!pdf) { console.log('Uso: node herramientas/lectura-ia.js <obra.pdf> [carpeta-salida] [--modelo <id>] [--solo-analisis] [--estimar]'); process.exit(1); }
  const dirTrabajo = salida || path.join(__dirname, 'cache', 'lectura-ia', path.basename(pdf).replace(/\.pdf$/i, ''));
  const modelo = opcion('--modelo') || MODELO_PREDETERMINADO;
  (async () => {
    try {
      const a = analizar({ pdf, dirTrabajo, log: console.log });
      console.log(`${a.filas.length} filas, ${a.compases} compases, ${a.consultas + 1} consultas.`);
      for (const m of MODELOS) { const e = estimar(a, m.id); console.log(`  ${m.nombre.padEnd(18)} ≈ ${e.coste.toFixed(2)} $`); }
      if (args.includes('--solo-recorte')) {
        // guarda las tiras de la primera consulta (o de la --consulta n) para mirarlas
        const k = +(opcion('--consulta') || 0), c = planificar(a)[k];
        const tiras = recortarTiras(a, dirTrabajo, c, a.filas[c.fila].pents.map((_, i) => i));
        tiras.forEach((t, i) => { const ruta = path.join(dirTrabajo, `tira-${k}-${i}.png`); fs.writeFileSync(ruta, t.png); console.log(`  ${ruta} (${t.ancho}×${t.alto}, unos ${Math.round(t.ancho * t.alto / 750)} tokens)`); });
        console.log(textoTramo({ titulo: '?', c, plan: planificar(a), fila: a.filas[c.fila], sugeridas: a.filas[c.fila].pents.map((_, i) => ({ nombre: 'Voz ' + (i + 1), clave: null, armadura: 0 })), indicacion: '' }));
        return;
      }
      if (args.includes('--solo-analisis') || args.includes('--estimar')) return;
      const r = await leer({ pdf, dirTrabajo, modelo, log: console.log, avance: x => console.log(`  [${x.hechas}/${x.total}] ${x.texto}`) });
      console.log(`XML en ${path.join(dirTrabajo, 'lectura.xml')} (${r.compases} compases, ${r.dudosos} dudosos, ${r.coste.toFixed(3)} $)`);
    } catch (e) { console.error('X ' + e.message); process.exit(1); }
  })();
}
