// Calcula dónde está cada compás dentro de las imágenes de las páginas, mirando la propia imagen. El detector está en
// app/detector-compases.js (compartido con el gestor del móvil); aquí solo se lee cada página en gris con Windows.
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

const D = require('../app/detector-compases.js');
const { enderezar, pentagramas, sistemas, compasesDePagina, columnaOscura, tieneCabeza, lineasLargas } = D;

function posicionesImagen(escXml, imagenes, log = () => {}) {
  return D.posicionesDesdeGris(escXml, imagenes.map(leerGris), log);
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
module.exports = { posicionesImagen, leerGris, enderezar, pentagramas, sistemas, compasesDePagina, columnaOscura, tieneCabeza, lineasLargas };
