// Páginas de un PDF escaneado: si el PDF es un escaneo (una foto JPEG por página), las fotos se sacan tal cual, sin volver
// a dibujar la página. Lo usan el gestor del PC (herramientas/paginas.js) y el gestor del móvil (app/gestor/).
// Trabaja sobre los bytes del PDF (Uint8Array; en Node, un Buffer también lo es). Sin dependencias.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.PaginasPdf = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {

// Bytes → texto latin1 (un carácter por byte: las posiciones en el texto son las mismas que en los bytes)
function aTexto(bytes, a = 0, b = bytes.length) {
  let s = '';
  for (let i = a; i < b; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(b, i + 8192)));
  return s;
}

function contarPaginas(bytes) {
  const s = aTexto(bytes);
  const m = s.match(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/); if (m) return +m[1];
  return (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
}

// Escaneos: las imágenes JPEG incrustadas (subarrays de bytes), o null si no hay exactamente una foto grande por página
function extraerJpegs(bytes, paginas) {
  const texto = aTexto(bytes);
  const out = []; let i = 0;
  while ((i = texto.indexOf('/DCTDecode', i)) >= 0) {
    const s = texto.indexOf('stream', i); if (s < 0) break;
    const st = bytes[s + 6] === 13 ? s + 8 : s + 7; const e = texto.indexOf('endstream', st);
    const cab = texto.slice(Math.max(0, i - 400), s);
    const w = +(cab.match(/\/Width\s+(\d+)/) || [, 0])[1], h = +(cab.match(/\/Height\s+(\d+)/) || [, 0])[1];
    const jpg = bytes.subarray(st, e < 0 ? bytes.length - 1 : e);
    if (jpg[0] === 0xFF && jpg[1] === 0xD8 && w > 600 && h > 600) out.push(jpg);
    if (e < 0) break;
    i = e;
  }
  return out.length === paginas ? out : null; // solo vale si hay exactamente una foto por página
}

return { contarPaginas, extraerJpegs };
});
