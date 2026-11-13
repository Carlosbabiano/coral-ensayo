// Convierte las páginas de un PDF en imágenes para la vista "PDF original" de la app.
//  - Si el PDF es un escaneo (una foto JPEG por página), se extraen las fotos tal cual.
//  - Si no, se dibuja cada página con el motor de PDF de Windows (sin instalar nada).
// Uso: node herramientas/paginas.js <obra.pdf> <carpeta-salida> <nombre-base>
// Devuelve (por consola, última línea) la lista JSON de archivos creados.
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');

// Escaneos (una foto JPEG por página): compartido con el gestor del móvil
const { contarPaginas, extraerJpegs } = require('../app/paginas-pdf.js');

// PDF normal: dibujar con Windows.Data.Pdf
function dibujarConWindows(pdf, dir, base, ancho) {
  const ps = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.RandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$ms = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }
$asOp = ($ms | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
$asAct = ($ms | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function Await($op, $type) { $t = $asOp.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(); $t.Result }
function AwaitAction($op) { $t = $asAct.Invoke($null, @($op)); $t.Wait() }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${pdf.replace(/'/g, "''")}')) ([Windows.Storage.StorageFile])
$doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$sf = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync('${dir.replace(/'/g, "''")}')) ([Windows.Storage.StorageFolder])
for ($i = 0; $i -lt $doc.PageCount; $i++) {
  $page = $doc.GetPage($i)
  $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions; $opts.DestinationWidth = ${ancho}
  $of = Await ($sf.CreateFileAsync("${base}-p$($i+1).png", [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
  $stream = Await ($of.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])
  AwaitAction ($page.RenderToStreamAsync($stream, $opts))
  $stream.Dispose(); $page.Dispose()
}
Write-Output $doc.PageCount`;
  const tmp = path.join(os.tmpdir(), 'paginas-' + Date.now() + '.ps1');
  fs.writeFileSync(tmp, '﻿' + ps, 'utf8');
  try {
    const n = +execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], { encoding: 'utf8', timeout: 10 * 60 * 1000 }).trim().split(/\s+/).pop();
    return Array.from({ length: n }, (_, i) => `${base}-p${i + 1}.png`);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

function generarPaginas(pdf, dir, base, ancho = 1600) {
  const buf = fs.readFileSync(pdf);
  const paginas = contarPaginas(buf);
  fs.mkdirSync(dir, { recursive: true });
  // Limpiar páginas anteriores de esta obra
  for (const f of fs.readdirSync(dir)) if (f.startsWith(base + '-p') && /\.(png|jpg)$/.test(f)) fs.unlinkSync(path.join(dir, f));
  const jpgs = paginas ? extraerJpegs(buf, paginas) : null;
  if (jpgs) {
    return jpgs.map((j, i) => { const n = `${base}-p${i + 1}.jpg`; fs.writeFileSync(path.join(dir, n), j); return n; });
  }
  return dibujarConWindows(path.resolve(pdf), path.resolve(dir), base, ancho);
}

if (require.main === module) {
  const [pdf, dir, base] = process.argv.slice(2);
  if (!base) { console.log('Uso: node paginas.js obra.pdf carpeta nombre-base'); process.exit(1); }
  const r = generarPaginas(pdf, dir, base);
  console.log(JSON.stringify(r));
}
module.exports = { generarPaginas };
