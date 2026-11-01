// Calcula dónde está cada compás dentro de las imágenes de las páginas, mirando la propia imagen:
// detecta los pentagramas (líneas horizontales largas), los agrupa en sistemas (unidos por la
// barra vertical inicial) y busca las líneas divisorias (verticales que cruzan todos los
// pentagramas del sistema). Es mucho más exacto que estimarlo desde la maquetación de Audiveris.
// Uso: node herramientas/posiciones-imagen.js <escaner.xml> <salida.pos.json> <pagina1.png> [pagina2.png ...]
// Salida: { paginas, compases: [ { p, x0, x1, y0, y1 } ] }  (fracción del ancho/alto de la página)
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');

// Imagen → gris (Uint8Array w*h) con el motor de dibujo de Windows (sin instalar nada)
function leerGris(archivo) {
  const raw = path.join(os.tmpdir(), 'gris-' + process.pid + '-' + Date.now() + '.raw');
  const ps = `
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile('${path.resolve(archivo).replace(/'/g, "''")}')
$w = $bmp.Width; $h = $bmp.Height
$rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
$d = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$bytes = New-Object byte[] ($d.Stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($d.Scan0, $bytes, 0, $bytes.Length)
$bmp.UnlockBits($d); $bmp.Dispose()
$fs = [System.IO.File]::Create('${raw.replace(/'/g, "''")}')
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([int32]$w); $bw.Write([int32]$h); $bw.Write([int32]$d.Stride); $bw.Write($bytes); $bw.Close()`;
  const tmp = path.join(os.tmpdir(), 'gris-' + process.pid + '-' + Date.now() + '.ps1');
  fs.writeFileSync(tmp, '﻿' + ps, 'utf8');
  try {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], { stdio: 'pipe', timeout: 120000 });
    const b = fs.readFileSync(raw);
    const w = b.readInt32LE(0), h = b.readInt32LE(4), stride = b.readInt32LE(8);
    const g = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) { const o = 12 + y * stride; for (let x = 0; x < w; x++) { const i = o + x * 3; g[y * w + x] = (b[i] + b[i + 1] + b[i + 2]) / 3; } }
    if (!w || !h) throw new Error('no se ha podido leer la imagen ' + path.basename(archivo));
    return { w, h, g };
  } finally { try { fs.unlinkSync(tmp); } catch {} try { fs.unlinkSync(raw); } catch {} }
}

// Un escaneo puede estar algo torcido: las líneas del pentagrama cambian de fila a lo largo del ancho y no se
// detectan. Se estima la inclinación (la que deja las filas más "concentradas" de tinta) y se endereza con un
// cizallamiento vertical (para ángulos pequeños equivale a girar). Devuelve la imagen enderezada y la
// pendiente t (píxeles de bajada por píxel de avance) para deshacerlo en las cajas.
function enderezar(img) {
  const { w, h, g } = img, cx = w / 2;
  const cizallar = t => {
    const g2 = new Uint8Array(w * h).fill(255);
    for (let y2 = 0; y2 < h; y2++) for (let x = 0; x < w; x++) { const y = Math.round(y2 + (x - cx) * t); if (y >= 0 && y < h) g2[y2 * w + x] = g[y * w + x]; }
    return { w, h, g: g2, t };
  };
  // la inclinación buena es la que más filas deja con una raya larga (las líneas del pentagrama enteras)
  const puntuacion = t => lineasLargas(cizallar(t)).reduce((s, l) => s + (l.x1 - l.x0), 0);
  const base = puntuacion(0);
  let mejorT = 0, mejorS = base;
  for (let grados = -2; grados <= 2.001; grados += 0.1) {
    if (Math.abs(grados) < 0.05) continue;
    const t = Math.tan(grados * Math.PI / 180); const s = puntuacion(t); if (s > mejorS) { mejorS = s; mejorT = t; }
  }
  for (let t = mejorT - 0.0012; t <= mejorT + 0.00121; t += 0.0004) { const s = puntuacion(t); if (s > mejorS) { mejorS = s; mejorT = t; } }
  // solo merece la pena si mejora claramente (una página casi recta se deja como está: el cizallamiento mete escalones)
  if (mejorT === 0 || mejorS < base * 1.15) return { ...img, t: 0 };
  return cizallar(mejorT);
}

const OSCURO = 185; // umbral de "tinta": en los escaneos las líneas del pentagrama son finas y grisáceas
const TINTA = 130;  // tinta franca (negro), sin el difuminado de los bordes
const COBERTURA = +(process.env.POSICIONES_COBERTURA || 0.9); // parte del pentagrama que ha de cubrir una divisoria (en un escaneo puede salir con huecos)

// Líneas horizontales largas de la página (las de los pentagramas): { y, yIni, yFin, x0, x1 }
function lineasLargas(img) {
  const { w, h, g } = img;
  const minLargo = w * 0.25;
  // filas con una raya continua larga (los textos no forman rayas continuas); en un escaneo la raya puede
  // salir a trozos, así que también vale una fila con más de la mitad de tinta entre su primer y último trazo
  const filas = [];
  for (let y = 0; y < h; y++) {
    let mejor = 0, ini = -1, run = 0, hueco = 0, mIni = 0, mFin = 0, o = y * w, tinta = 0, primero = -1, ultimo = -1;
    for (let x = 0; x < w; x++) {
      if (g[o + x] < OSCURO) { tinta++; if (primero < 0) primero = x; ultimo = x; if (ini < 0) ini = x; run = x - ini + 1; hueco = 0; if (run > mejor) { mejor = run; mIni = ini; mFin = x; } }
      else if (ini >= 0 && ++hueco > 4) { ini = -1; }
    }
    if (mejor >= minLargo) filas.push({ y, x0: mIni, x1: mFin });
    else if (tinta >= w * 0.4 && tinta >= (ultimo - primero) * 0.6) filas.push({ y, x0: primero, x1: ultimo });
  }
  // filas contiguas → líneas
  const lineas = [];
  for (const f of filas) {
    const u = lineas[lineas.length - 1];
    if (u && f.y - u.yFin <= 1) { u.yFin = f.y; u.x0 = Math.min(u.x0, f.x0); u.x1 = Math.max(u.x1, f.x1); }
    else lineas.push({ yIni: f.y, yFin: f.y, x0: f.x0, x1: f.x1 });
  }
  // en un escaneo una línea puede salir partida en dos o tres filas casi seguidas: se funden
  const fund = [];
  for (const l of lineas) {
    const u = fund[fund.length - 1];
    if (u && l.yIni - u.yFin <= 3) { u.yFin = l.yFin; u.x0 = Math.min(u.x0, l.x0); u.x1 = Math.max(u.x1, l.x1); }
    else fund.push(l);
  }
  for (const l of fund) l.y = (l.yIni + l.yFin) / 2;
  return fund;
}

// Pentagramas de una página: grupos de 5 líneas largas seguidas a distancia regular
function pentagramas(img) {
  const { w } = img, lineas = lineasLargas(img);
  const pents = [];
  for (let i = 0; i + 4 < lineas.length;) {
    const q = lineas.slice(i, i + 5), gaps = [];
    for (let k = 1; k < 5; k++) gaps.push(q[k].y - q[k - 1].y);
    const med = gaps.slice().sort((a, b) => a - b)[2];
    const regular = med >= w / 400 && med <= w / 40 && gaps.every(d => d >= med * 0.7 && d <= med * 1.3);
    if (regular) {
      pents.push({ y1: q[0].y, y5: q[4].y, esp: med, alto: q[4].y - q[0].y, lineas: q.map(l => l.y), grosor: Math.max(...q.map(l => l.yFin - l.yIni + 1)), x0: Math.min(...q.map(l => l.x0)), x1: Math.max(...q.map(l => l.x1)) });
      i += 5;
      continue;
    }
    // escaneo con una línea perdida: 4 líneas seguidas con hueco regular, o con un hueco doble en medio
    if (i + 3 < lineas.length) {
      const q4 = lineas.slice(i, i + 4), g4 = [];
      for (let k = 1; k < 4; k++) g4.push(q4[k].y - q4[k - 1].y);
      const m4 = g4.slice().sort((a, b) => a - b)[1];
      const dobles = g4.filter(d => d >= m4 * 1.7 && d <= m4 * 2.3).length, simples = g4.filter(d => d >= m4 * 0.7 && d <= m4 * 1.3).length;
      if (m4 >= w / 400 && m4 <= w / 40 && ((dobles === 1 && simples === 2) || (simples === 3 && !(i + 4 < lineas.length && lineas[i + 4].y - q4[3].y <= m4 * 1.3)))) {
        const alto = simples === 3 ? m4 * 4 : q4[3].y - q4[0].y, esp = alto / 4;
        pents.push({ y1: q4[0].y, y5: q4[0].y + alto, esp, alto, lineas: [0, 1, 2, 3, 4].map(k => q4[0].y + k * esp), grosor: Math.max(...q4.map(l => l.yFin - l.yIni + 1)), x0: Math.min(...q4.map(l => l.x0)), x1: Math.max(...q4.map(l => l.x1)) });
        i += 4;
        continue;
      }
    }
    i++;
  }
  return pents;
}

// ¿Columna x oscura (con tolerancia ±tol columnas) en al menos "min" de las filas [ya, yb]?
function columnaOscura(img, x, ya, yb, tol, min) {
  const { w, g } = img; let n = 0, t = 0;
  for (let y = Math.max(0, ya); y <= Math.min(img.h - 1, yb); y++) {
    t++;
    for (let dx = -tol; dx <= tol; dx++) { const xx = x + dx; if (xx >= 0 && xx < w && g[y * w + xx] < OSCURO) { n++; break; } }
  }
  return t > 0 && n / t >= min;
}

// ¿La columna x lleva pegada una cabeza de nota (o algo ancho) dentro del pentagrama? Una plica que cruce el
// pentagrama entero se distingue de una divisoria porque en alguna fila (fuera de las líneas) el trazo es ancho
// En cada fila (fuera de las líneas del pentagrama) el trazo que pasa por x debe ser estrecho y tener blanco
// a ambos lados: una cabeza de nota pegada a la plica, o una cifra de compás, lo ensanchan por un lado.
// Se mira también algo por encima y por debajo del pentagrama, donde pueden estar las cabezas de una
// plica que lo cruza entero (en esas filas una divisoria está en blanco, y no cuenta).
// En modo "estricto" (para decidir qué pentagramas forman sistema) casi no se tolera nada alrededor.
function tieneCabeza(img, x0, p, estricto) {
  const { w, g } = img, esp = p.esp, maxAncho = esp * 0.75, margen = Math.max(2, Math.round(esp * (estricto ? 1.0 : 0.5)));
  const cercaLinea = Math.ceil(p.grosor / 2) + 1; // las filas de las propias líneas (en un escaneo salen a trozos, no se puede fiar de su anchura)
  // Una ligadura que cruza la divisoria la ensancha solo en 2-4 filas; una cabeza de nota o una cifra, en muchas más
  let malas = 0; const maxMalas = esp * (estricto ? 0.15 : 0.4);
  const esBarra = {}; // columnas vecinas que son a su vez una raya vertical (barra doble): no ensucian
  const vecinoLimpio = c => { if (esBarra[c] === undefined) esBarra[c] = columnaOscura(img, c, Math.round(p.y1), Math.round(p.y5), 0, 0.85); return esBarra[c]; };
  for (let y = Math.max(0, Math.round(p.y1 - esp * 1.3)); y <= Math.min(img.h - 1, Math.round(p.y5 + esp * 1.3)); y++) {
    if (p.lineas.some(ly => Math.abs(y - ly) <= cercaLinea)) continue;
    const o = y * w;
    // la columna oscura más cercana (el trazo puede ir 1-2 px al lado del centro calculado)
    let x = -1;
    for (const dx of [0, -1, 1, -2, 2]) { const xx = x0 + dx; if (xx >= 0 && xx < w && g[o + xx] < OSCURO) { x = xx; break; } }
    if (x < 0) continue; // en esta fila está en blanco (hueco del trazo): no dice nada
    // el trazo se sigue solo por tinta franca (TINTA): el difuminado gris junto a una línea del pentagrama no cuenta
    let a = x, b = x;
    while (a > 0 && g[o + a - 1] < TINTA) a--;
    while (b < w - 1 && g[o + b + 1] < TINTA) b++;
    const ancho = b - a + 1;
    if (ancho >= esp * 3) continue; // es una línea del pentagrama (o una barra de corcheas): no dice nada
    if (ancho > maxAncho) { if (++malas > maxMalas) return true; continue; }
    if (y < p.y1 || y > p.y5) continue; // fuera del pentagrama solo cuenta la anchura: una divisoria que sigue por el hueco pasa junto a la letra
    let sucio = 0;
    for (let d = 2; d <= margen; d++) {
      if (a - d >= 0 && g[o + a - d] < TINTA && !vecinoLimpio(a - d)) sucio++;
      if (b + d < w && g[o + b + d] < TINTA && !vecinoLimpio(b + d)) sucio++;
    }
    if (sucio > 1 && ++malas > maxMalas) return true;
  }
  return cabezaEnLosExtremos(img, x0, p);
}

// Una plica acaba en su cabeza: abajo a la izquierda (plica hacia arriba) o arriba a la derecha (plica hacia
// abajo). Se busca el final del trazo vertical y se mide la tinta en ese rincón; una divisoria acaba en la
// línea del pentagrama, donde solo hay la propia línea (poca tinta).
function cabezaEnLosExtremos(img, xc, p) {
  const { w, h, g } = img, esp = p.esp;
  // la columna del trazo de verdad: la más oscura a lo largo del pentagrama entre las vecinas del centro calculado
  let x0 = xc, mejor = -1;
  for (let xx = Math.max(0, xc - 2); xx <= Math.min(w - 1, xc + 2); xx++) {
    let n = 0; for (let y = Math.round(p.y1); y <= Math.round(p.y5); y++) if (g[y * w + xx] < OSCURO) n++;
    if (n > mejor) { mejor = n; x0 = xx; }
  }
  const oscuro = y => { const o = y * w; for (let dx = -1; dx <= 1; dx++) { const xx = x0 + dx; if (xx >= 0 && xx < w && g[o + xx] < OSCURO) return true; } return false; };
  const medio = Math.round((p.y1 + p.y5) / 2);
  let arriba = medio, abajo = medio, huecos = 0;
  for (let y = medio; y >= Math.max(0, p.y1 - esp * 3); y--) { if (oscuro(y)) { arriba = y; huecos = 0; } else if (++huecos > 2) break; }
  huecos = 0;
  for (let y = medio; y <= Math.min(h - 1, p.y5 + esp * 3); y++) { if (oscuro(y)) { abajo = y; huecos = 0; } else if (++huecos > 2) break; }
  const tinta = (xa, xb, ya, yb) => {
    let n = 0, t = 0;
    for (let y = Math.max(0, ya); y <= Math.min(h - 1, yb); y++) for (let x = Math.max(0, xa); x <= Math.min(w - 1, xb); x++) { t++; if (g[y * w + x] < TINTA) n++; }
    return t ? n / t : 0;
  };
  const r = Math.round(esp * 1.3), d = Math.round(esp * 0.6);
  if (tinta(x0 - r, x0 - 2, abajo - d, abajo + Math.round(esp * 0.4)) > 0.35) return true; // cabeza abajo a la izquierda
  if (tinta(x0 + 2, x0 + r, arriba - Math.round(esp * 0.4), arriba + d) > 0.35) return true; // cabeza arriba a la derecha
  return false;
}

// Anchura real (en píxeles de tinta) del trazo vertical que pasa por x: mediana, entre las líneas del pentagrama,
// de la anchura del trazo oscuro más cercano a x en cada fila. Una divisoria normal mide 1-3 px; la barra final
// gruesa de un movimiento, medio espacio o más.
function anchoTrazo(img, x, p) {
  const { w, g } = img, anchos = [];
  for (let y = Math.round(p.y1); y <= Math.round(p.y5); y++) {
    if (p.lineas.some(ly => Math.abs(y - ly) <= Math.ceil(p.grosor / 2) + 1)) continue;
    const o = y * w; let xx = -1;
    for (const dx of [0, -1, 1, -2, 2]) { const c = x + dx; if (c >= 0 && c < w && g[o + c] < OSCURO) { xx = c; break; } }
    if (xx < 0) continue;
    let a = xx, b = xx;
    while (a > 0 && g[o + a - 1] < OSCURO) a--;
    while (b < w - 1 && g[o + b + 1] < OSCURO) b++;
    anchos.push(b - a + 1);
  }
  if (!anchos.length) return 0;
  anchos.sort((u, v) => u - v);
  return anchos[anchos.length >> 1];
}

// Candidatas a divisoria de un pentagrama: columnas oscuras que lo cruzan de la primera a la quinta línea
// sin llevar cabeza de nota pegada. Devuelve cada trazo (agrupando columnas contiguas): { x: centro, ancho }.
function trazosDePentagrama(img, p, estricto) {
  const cols = [];
  for (let x = Math.max(0, p.x0 - 2); x <= Math.min(img.w - 1, p.x1 + 2); x++) {
    if (columnaOscura(img, x, Math.round(p.y1), Math.round(p.y5), 2, COBERTURA) && !tieneCabeza(img, x, p, estricto)) cols.push(x);
  }
  const runs = [];
  for (const x of cols) { const u = runs[runs.length - 1]; if (u && x - u.b <= 2) u.b = x; else runs.push({ a: x, b: x }); }
  return runs.filter(r => r.b - r.a <= p.esp * 1.5 + 4).map(r => { const x = Math.round((r.a + r.b) / 2); return { x, ancho: anchoTrazo(img, x, p) }; }); // lo muy ancho no es una barra
}
const barrasDePentagrama = (img, p, estricto) => trazosDePentagrama(img, p, estricto).map(t => t.x);

// Divisorias interiores: sin la barra inicial ni la final, que coinciden en todos los sistemas de la página
const interiores = (xs, p) => xs.filter(x => x > p.x0 + p.esp * 2 && x < p.x1 - p.esp * 2);

// ¿Comparten divisorias (firmes, interiores) dos pentagramas? Los de un mismo sistema las tienen en las mismas columnas
function alineados(a, b) {
  const A = interiores(a.firmes, a), B = interiores(b.firmes, b);
  if (!A.length || !B.length) return false;
  const n = A.filter(x => B.some(y => Math.abs(x - y) <= a.esp * 0.6)).length;
  return n >= 3 || n >= Math.min(A.length, B.length) * 0.6;
}

// ¿Alguna divisoria sigue por el hueco entre los dos pentagramas? (piano con llave, coros con barras corridas)
function conectados(img, a, b) {
  const xs = [...a.firmes, ...b.firmes];
  // La barra inicial del sistema (y el corchete o la llave) une sus pentagramas por la izquierda; no siempre
  // entra entre las divisorias firmes (el corchete la ensucia), así que se miran también esas columnas
  for (let x = Math.min(a.x0, b.x0) - 3; x <= Math.max(a.x0, b.x0) + a.esp; x++) xs.push(x);
  // (no vale una columna oscura de arriba abajo de la página, ni una que siga oscura por encima del pentagrama
  // de arriba y a la vez por debajo del de abajo: la sombra del borde de un escaneo, que uniría sistemas distintos;
  // una divisoria o la barra inicial de un sistema de dos pentagramas acaba en ellos)
  const esp = a.esp;
  const sobra = x => columnaOscura(img, x, Math.round(a.y1 - esp * 4), Math.round(a.y1 - esp * 1.5), 2, 0.85) && columnaOscura(img, x, Math.round(b.y5 + esp * 1.5), Math.round(b.y5 + esp * 4), 2, 0.85);
  return xs.some(x => columnaOscura(img, Math.round(x), Math.round(a.y5 + 2), Math.round(b.y1 - 2), 2, 0.85) && !columnaOscura(img, Math.round(x), 0, img.h - 1, 2, 0.6) && !sobra(Math.round(x)));
}

// Pentagramas → sistemas. Dos pentagramas seguidos van en el mismo sistema si están cerca (respecto al hueco
// típico de la página) y además sus divisorias coinciden o alguna cruza el hueco. Así el piano de ensayo entra
// en el sistema del coro (comparte divisorias) y dos líneas seguidas de un solo no se juntan (divisorias distintas).
// nPartes: voces del XML. Un sistema ya con tantos pentagramas solo admite otro si algo lo une de verdad (una barra
// que cruza el hueco): así una obra a una voz no junta dos líneas seguidas, y dos sistemas de coro con los
// compases igual de anchos (divisorias alineadas) no se funden en uno.
function sistemas(img, pents, nPartes = Infinity) {
  for (const p of pents) { p.trazos = trazosDePentagrama(img, p, false); p.barras = p.trazos.map(t => t.x); p.firmes = barrasDePentagrama(img, p, true); }
  const huecos = pents.slice(1).map((p, i) => p.y1 - pents[i].y5).sort((a, b) => a - b);
  const hueco = huecos.length ? huecos[Math.floor((huecos.length - 1) / 2)] : 0; // mediana: el hueco típico entre pentagramas de un sistema
  const cerca = (a, p) => (p.y1 - a.y5) <= hueco * 1.8 + a.esp;
  // sin divisorias limpias en uno de los dos (escaneo flojo, notas largas) solo queda la distancia: la típica de la página
  const sinDatos = (a, p) => (!interiores(a.firmes, a).length || !interiores(p.firmes, p).length) && (p.y1 - a.y5) <= hueco * 1.3;
  const grupos = [];
  pents.forEach((p, i) => {
    const u = grupos[grupos.length - 1];
    const a = u && u.pents[u.pents.length - 1];
    if (a && cerca(a, p) && (conectados(img, a, p) || (u.pents.length < nPartes && (alineados(a, p) || sinDatos(a, p))))) u.pents.push(p); else grupos.push({ pents: [p] });
  });
  for (const s of grupos) {
    s.y1 = s.pents[0].y1; s.y5 = s.pents[s.pents.length - 1].y5;
    s.x0 = Math.min(...s.pents.map(p => p.x0)); s.x1 = Math.max(...s.pents.map(p => p.x1));
    s.esp = s.pents.reduce((a, p) => a + p.esp, 0) / s.pents.length;
    s.barras = barras(img, s);
  }
  // Un grupo pegado al anterior con las mismas divisorias es su acompañamiento (piano de ensayo): no aporta compases.
  // Pero solo si tiene menos pentagramas que voces el XML, o algo lo une al sistema (la barra inicial): si no, dos
  // sistemas seguidos del coro con los compases igual de anchos se tomarían el uno por el acompañamiento del otro
  const out = [];
  for (const s of grupos) {
    const prev = out[out.length - 1];
    const ultimo = prev && prev.pents[prev.pents.length - 1];
    if (prev && cerca(ultimo, s.pents[0]) && (s.pents.length < nPartes || conectados(img, ultimo, s.pents[0]))) {
      const A = interiores(prev.barras, prev), B = interiores(s.barras, s);
      const n = A.filter(x => B.some(y => Math.abs(x - y) <= s.esp * 0.6)).length;
      if (A.length && B.length && n >= Math.max(A.length, B.length) * 0.8) { prev.duplicados = (prev.duplicados || 0) + 1; continue; }
    }
    out.push(s);
  }
  return out;
}

// Divisorias de un sistema: las columnas en que coinciden más de la mitad de sus pentagramas, y que no
// siguen por encima del primero ni por debajo del último (una plica que cruce el pentagrama entero sí sigue:
// por la cabeza o por la barra de corcheas). Las muy juntas (dobles, finales) se funden en una.
function barras(img, s) {
  // más de la mitad de los pentagramas: dos voces al unísono (tenor y bajo) alinean también sus plicas
  const esp = s.esp, n = s.pents.length, minVotos = Math.floor(n / 2) + 1;
  const todas = s.pents.flatMap(p => p.barras).sort((a, b) => a - b);
  const firmes = s.pents.flatMap(p => p.firmes);
  const grupos = [];
  for (const x of todas) { const u = grupos[grupos.length - 1]; if (u && x - u.fin <= esp * 0.6) { u.fin = x; u.xs.push(x); } else grupos.push({ fin: x, xs: [x] }); }
  const arriba = s.pents[0], abajo = s.pents[n - 1];
  // Cada grupo de columnas coincidentes es una candidata; se anota con sus votos y si se acepta (ok). Las
  // rechazadas se guardan también: si al final faltan compases respecto al XML, las mejores se recuperan.
  s.candidatas = [];
  for (const g of grupos) {
    const limpias = firmes.filter(x => x >= g.xs[0] - esp * 0.6 && x <= g.fin + esp * 0.6).length;
    const x = Math.round(g.xs.reduce((a, b) => a + b, 0) / g.xs.length);
    // justo tras el principio del sistema van la clave, la armadura y la cifra de compás, no una divisoria
    if (x > s.x0 + esp * 1.5 && x < s.x0 + esp * 11) continue;
    // barra final gruesa (en la mayoría de los pentagramas el trazo es ancho) o doble barra (dos trazos juntos)
    const enGrupo = s.pents.map(p => p.trazos.filter(t => t.x >= g.xs[0] - esp * 0.6 && t.x <= g.fin + esp * 0.6));
    const umbralGrueso = Math.max(3, esp * 0.3);
    const gruesa = enGrupo.filter(ts => ts.some(t => t.ancho >= umbralGrueso)).length >= Math.ceil(n / 2);
    const doble = enGrupo.filter(ts => ts.length >= 2).length >= Math.ceil(n / 2);
    const c = { x, votos: g.xs.length, limpias, ok: true, gruesa, doble };
    s.candidatas.push(c);
    if (g.xs.length < minVotos) { c.ok = false; continue; }
    // La mayoría no basta (dos voces homorrítmicas alinean sus plicas): en algún pentagrama ha de verse limpia
    // del todo, o si no, casi todos han de tenerla (una barra con notas pegadas en todas las voces)
    // (con un solo pentagrama no hay con quién votar ni casi nada "limpio" —ligaduras que cruzan—: vale lo normal)
    if (!limpias && n > 1 && (n < 4 || g.xs.length < n - 1)) { c.ok = false; continue; }
    // si no está clara en la mayoría, que al menos no siga por encima del primer pentagrama ni por debajo del
    // último (una plica sí sigue: por la cabeza o por la barra de corcheas); con votos de sobra no se mira,
    // porque ahí arriba o abajo puede haber texto ("Tempo I", matices) que la ensucie
    if (limpias < minVotos) {
      if (columnaOscura(img, x, Math.round(arriba.y1 - esp * 1.5), Math.round(arriba.y1 - esp * 0.7), 1, 0.5)) { c.ok = false; continue; }
      if (columnaOscura(img, x, Math.round(abajo.y5 + esp * 0.7), Math.round(abajo.y5 + esp * 1.5), 1, 0.5)) { c.ok = false; continue; }
    }
  }
  return barrasAceptadas(s);
}

// Las candidatas aceptadas de un sistema, fundiendo lo que va pegado a una divisoria (barra gruesa final,
// cifra de compás): el primer trazo es la divisoria de verdad. Anota en s.limites las divisorias que cierran
// un tramo de la obra: barra final gruesa («final») o doble barra fina («doble»).
function barrasAceptadas(s) {
  const out = [];
  for (const c of s.candidatas) {
    if (!c.ok) continue;
    const u = out[out.length - 1];
    if (u && c.x - u.b <= s.esp * 3.5) { u.b = c.x; u.n++; u.gruesa = u.gruesa || c.gruesa; u.doble = u.doble || c.doble; }
    else out.push({ a: c.x, b: c.x, n: 1, gruesa: c.gruesa, doble: c.doble });
  }
  s.limites = new Map(out.filter(r => r.gruesa || r.doble || r.n >= 2).map(r => [r.a, r.gruesa ? 'final' : 'doble']));
  return out.map(r => r.a);
}

function compasesDePagina(img, s) {
  const bordes = s.barras.slice();
  if (!bordes.length || bordes[0] > s.x0 + s.esp * 1.5) bordes.unshift(s.x0); // sin barra inicial: el compás empieza donde el pentagrama
  // sin barra final (p. ej. solo la gruesa): acaba donde el pentagrama. Tras una barra final gruesa no hay más
  // compases aunque las líneas sigan (en un escaneo se alargan hasta la sombra del borde)
  const ultima = bordes[bordes.length - 1];
  if (ultima < s.x1 - s.esp * 4 && !(s.limites && s.limites.get(ultima) === 'final')) bordes.push(s.x1);
  const cajas = [];
  for (let i = 0; i + 1 < bordes.length; i++) {
    if (bordes[i + 1] - bordes[i] < s.esp * 4) continue; // un compás de verdad es más ancho: esto es una cifra de compás tras la barra, puntos de repetición…
    cajas.push({ xa: bordes[i], xb: bordes[i + 1], limite: (s.limites && s.limites.get(bordes[i + 1])) || null });
  }
  return cajas;
}

// Tramos del XML: dónde acaba cada movimiento o sección. Límites "firmes": compases cuya barra es final (gruesa)
// o doble (fina). Límites "blandos": cambios de compás o de tonalidad (el escáner a veces se come la barra
// final de un movimiento, pero el cambio de armadura o de cifra del siguiente sí lo escribe).
function limitesXml(parte) {
  const limites = [];
  const medidas = [...parte.matchAll(/<measure [^>]*>([\s\S]*?)<\/measure>/g)];
  medidas.forEach((m, i) => {
    const barras = [...m[1].matchAll(/<barline\b([^>]*)>([\s\S]*?)<\/barline>/g)].filter(b => !/location="left"/.test(b[1]));
    const estilos = barras.map(b => (b[2].match(/<bar-style>([^<]*)/) || [, ''])[1]);
    const tipo = estilos.some(e => /heavy/.test(e)) ? 'final' : estilos.some(e => e === 'light-light') ? 'doble' : null;
    if (tipo && i < medidas.length - 1) limites.push({ i, tipo });
    if (i > 0 && i < medidas.length - 1 && /<(time|key)\b/.test(m[1]) && !limites.some(l => l.i === i - 1)) limites.push({ i: i - 1, tipo: 'blando' });
  });
  limites.sort((a, b) => a.i - b.i);
  return { n: medidas.length, limites };
}

// Empareja los límites del XML con los de la página, en orden, cuando los tramos que cierran tienen un número
// de compases parecido. Un límite sin pareja (una barra final que el escáner no escribió, o una que la imagen
// no ve) se ignora, y su tramo se junta con el siguiente. Devuelve los tramos emparejados: [{ xa, xb, ia, ib }]
// (compases del XML [xa, xb) y cajas de la página [ia, ib)).
function emparejarTramos(limXml, nXml, limImg, nImg) {
  const X = limXml.map(l => l.i + 1), I = limImg.map(l => l.i + 1); // número de compases hasta el límite inclusive
  const tol = (m, n) => Math.max(4, Math.round(0.1 * Math.max(m, n)));
  const parecidos = (m, n) => Math.abs(m - n) <= tol(m, n);
  const tramos = [];
  let i = 0, j = 0, px = 0, pi = 0;
  while (i < X.length && j < I.length) {
    const M = X[i] - px, N = I[j] - pi;
    if (parecidos(M, N)) { tramos.push({ xa: px, xb: X[i], ia: pi, ib: I[j] }); px = X[i]; pi = I[j]; i++; j++; continue; }
    const saltaX = i + 1 < X.length && parecidos(X[i + 1] - px, N), saltaI = j + 1 < I.length && parecidos(M, I[j + 1] - pi);
    if (saltaX && (!saltaI || Math.abs(X[i + 1] - px - N) <= Math.abs(M - (I[j + 1] - pi)))) i++;
    else if (saltaI) j++;
    else if (M < N) i++; else j++;
  }
  tramos.push({ xa: px, xb: nXml, ia: pi, ib: nImg });
  return tramos;
}

function posicionesImagen(escXml, imagenes, log = () => {}) {
  const parte = (escXml.match(/<part id="[^"]+">([\s\S]*?)<\/part>/) || ['', ''])[1];
  const { n: nXml, limites: limXml } = limitesXml(parte);
  const nPartes = (escXml.match(/<score-part id=/g) || []).length || Infinity;
  const informe = [];
  const saltar = +(process.env.POSICIONES_SALTAR || 0); // compases del principio que están en la imagen pero no en el XML (p. ej. una espera de 8 compases que el escáner omitió)
  const paginas = imagenes.map((archivo, p) => {
    const img = enderezar(leerGris(archivo));
    const pents = pentagramas(img);
    const sis = sistemas(img, pents, nPartes);
    for (const s of sis) s.cajas = compasesDePagina(img, s);
    return { p, img, pents, sis };
  });
  // Todas las cajas de la obra, en orden de lectura (sin las que se mandan saltar)
  const cajasTodas = () => { const out = []; for (const pg of paginas) for (const s of pg.sis) for (const c of s.cajas) out.push({ pg, s, c }); return out.slice(saltar); };
  const limitesImagen = cajas => { const out = []; cajas.forEach(({ c }, k) => { if (c.limite && k < cajas.length - 1) out.push({ i: k, tipo: c.limite }); }); return out; };
  const puntos = c => c.votos * 10 + c.limpias * 5;
  const ajustes = [];
  // Recupera la candidata rechazada con más votos que parta una caja de las [desde, hasta) en dos trozos de anchura
  // razonable (vale con un solo voto si en ese pentagrama se ve limpia del todo: una divisoria con una ligadura
  // o un acorde encima en las demás voces)
  const recuperar = (desde, hasta) => {
    let mejor = null;
    cajasTodas().forEach(({ pg, s, c: caja }, k) => {
      if (k < desde || k >= hasta) return;
      for (const c of s.candidatas) {
        if (c.ok || (c.votos < 2 && !c.limpias)) continue;
        if (!(c.x > caja.xa + s.esp * 4 && c.x < caja.xb - s.esp * 4)) continue;
        if (!mejor || puntos(c) > puntos(mejor.c)) mejor = { pg, s, c };
      }
    });
    if (!mejor) return false;
    mejor.c.ok = true; mejor.s.barras = barrasAceptadas(mejor.s); mejor.s.cajas = compasesDePagina(mejor.pg.img, mejor.s);
    ajustes.push(`+1 en página ${mejor.pg.p + 1} (x=${mejor.c.x}, ${mejor.c.votos} votos)`);
    return true;
  };
  // Quita la candidata aceptada con menos votos de las cajas [desde, hasta)
  const quitar = (desde, hasta) => {
    let peor = null;
    cajasTodas().forEach(({ pg, s, c: caja }, k) => {
      if (k < desde || k >= hasta) return;
      for (const c of s.candidatas) {
        // solo las que ningún pentagrama ve limpias del todo (lo demás suele ser una divisoria de verdad con una plica pegada)
        if (!c.ok || c.limpias > 0 || c.votos >= s.pents.length || c.x <= s.x0 + s.esp * 1.5 || Math.abs(c.x - caja.xb) > 1) continue;
        if (!peor || puntos(c) < puntos(peor.c)) peor = { pg, s, c };
      }
    });
    if (!peor) return false;
    peor.c.ok = false; peor.s.barras = barrasAceptadas(peor.s); peor.s.cajas = compasesDePagina(peor.pg.img, peor.s);
    ajustes.push(`-1 en página ${peor.pg.p + 1} (x=${peor.c.x}, ${peor.c.votos} votos, ${peor.c.limpias} limpias)`);
    return true;
  };

  // La obra se cuadra tramo a tramo (movimiento a movimiento): las barras finales y dobles de la página se
  // emparejan con las del XML, y así un compás que el escáner se salte o invente no descoloca el resto de la obra.
  // En cada tramo, si faltan cajas se recuperan candidatas rechazadas; si sobran, se quitan las de menos votos.
  const tramosAhora = () => { const cajas = cajasTodas(); return { cajas, tramos: emparejarTramos(limXml, nXml, limitesImagen(cajas), cajas.length) }; };
  for (let guarda = 0; guarda < 60; guarda++) {
    const { tramos } = tramosAhora();
    const corto = tramos.find(t => (t.xb - t.xa) > (t.ib - t.ia));
    if (corto && recuperar(corto.ia, corto.ib)) continue;
    const largo = tramos.find(t => (t.xb - t.xa) < (t.ib - t.ia) && (t.ib - t.ia) - (t.xb - t.xa) > 0);
    if (largo && quitar(largo.ia, largo.ib)) continue;
    break;
  }
  const { cajas, tramos } = tramosAhora();
  const desajustes = [];
  const elegidas = []; // una caja por compás del XML
  for (const t of tramos) {
    const M = t.xb - t.xa, N = t.ib - t.ia, lista = cajas.slice(t.ia, t.ib);
    if (!M) continue;
    if (N === M) elegidas.push(...lista);
    else if (N > M) {
      // la página tiene compases que el XML no trae (el escáner se come la introducción instrumental antes de una
      // espera): se dan por saltados los primeros del tramo
      elegidas.push(...lista.slice(N - M));
      desajustes.push(`compases ${t.xa + 1}-${t.xb}: la página tiene ${N} y el XML ${M} (se dan por saltados los ${N - M} primeros de la página)`);
    } else if (N > 0) {
      // el XML trae compases de más: se reparten por el tramo, y la caja que toca a varios se parte entre ellos
      // (la marca sigue avanzando en vez de quedarse clavada; puede ir desviada en ese tramo)
      const cuantos = new Array(N).fill(0);
      for (let k = 0; k < M; k++) cuantos[Math.min(N - 1, Math.floor(k * N / M))]++;
      lista.forEach((caja, j) => {
        const g = cuantos[j], ancho = (caja.c.xb - caja.c.xa) / g;
        for (let i = 0; i < g; i++) elegidas.push({ ...caja, c: { ...caja.c, xa: caja.c.xa + i * ancho, xb: caja.c.xa + (i + 1) * ancho } });
      });
      desajustes.push(`compases ${t.xa + 1}-${t.xb}: la página tiene ${N} y el XML ${M} (la marca puede ir desviada en ese tramo)`);
    } else {
      // sin cajas para este tramo: se usa la última conocida
      const ultima = elegidas[elegidas.length - 1] || cajas[0];
      for (let k = 0; k < M; k++) elegidas.push(ultima);
      desajustes.push(`compases ${t.xa + 1}-${t.xb}: no se encuentran en la página`);
    }
  }
  const compases = elegidas.map(({ pg, s, c }) => {
    const { img } = pg, cx = img.w / 2, t = img.t;
    // deshacer el enderezado: la caja se estira lo que baje o suba la inclinación entre sus dos lados
    const ya = s.y1 - s.esp * 4, yb = s.y5 + s.esp * 6, da = (c.xa - cx) * t, db = (c.xb - cx) * t;
    return { p: pg.p, x0: c.xa / img.w, x1: c.xb / img.w, y0: Math.max(0, ya + Math.min(da, db)) / img.h, y1: Math.min(img.h, yb + Math.max(da, db)) / img.h };
  });
  for (const { p, img, pents, sis } of paginas) {
    const t = img.t;
    informe.push(`página ${p + 1}: ${t ? 'inclinación ' + (Math.atan(t) * 180 / Math.PI).toFixed(2) + '°, ' : ''}${pents.length} pentagramas, ${sis.length} sistemas, compases por sistema ${sis.map(s => s.cajas.length + (s.cajas.some(c => c.limite) ? '|' : '')).join('+') || 0}`);
  }
  if (ajustes.length) informe.push('ajustes para cuadrar con el XML: ' + ajustes.join(', '));
  informe.push(`la obra se ha cuadrado en ${tramos.length} tramo(s) (barras finales o dobles: ${limXml.filter(l => l.tipo !== 'blando').length} en el XML, ${limitesImagen(cajas).length} en la página)`);
  for (const d of desajustes) informe.push('! ' + d);
  for (const l of informe) log('  ' + l);
  if (compases.length !== nXml) throw new Error(`la imagen tiene ${cajas.length} compases y el XML ${nXml}`);
  return { paginas: imagenes.length, compases, desajustes };
}

if (require.main === module) {
  const [esc, out, ...imgs] = process.argv.slice(2);
  if (!imgs.length) { console.log('Uso: node posiciones-imagen.js escaner.xml salida.pos.json pagina1.png [pagina2.png ...]'); process.exit(1); }
  try {
    const r = posicionesImagen(fs.readFileSync(esc, 'utf8'), imgs, console.log);
    fs.writeFileSync(out, JSON.stringify(r));
    console.log(`${r.compases.length} compases en ${r.paginas} página(s)`);
  } catch (e) { console.error('! ' + e.message); process.exit(2); }
}
module.exports = { posicionesImagen, leerGris, pentagramas, sistemas, columnaOscura, tieneCabeza, lineasLargas };
