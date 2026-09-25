// Descarga e instala lo que necesita el cantante sintético (una sola vez, ~560 MB):
//  - la voz "Hoshino Hanami ~AIdol~" para DiffSinger (gratuita, canta en español y latín; licencia Team L❤VE)
//  - el diccionario de pronunciación española de OpenUtau (g2p-es)
// Todo va a herramientas/cache/voces/ (fuera de git).
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');

const VOZ = {
  nombre: 'hanami',
  pagina: 'https://www.mediafire.com/file/ks3hpb5zldabo3s/Hoshino_Hanami_%257EAIdol%257E_for_DiffSinger_v1.0.zip/file',
  creditos: 'Hoshino Hanami ~AIdol~ for DiffSinger v1.0, de LotteV / Team L❤VE (https://lottev.moe). Licencia Team L❤VE Voicebank License (uso libre con atribución).',
};
const G2P = ['dict.txt', 'phones.txt', 'g2p.onnx'].map(f => ({ f, url: 'https://raw.githubusercontent.com/stakira/OpenUtau/master/OpenUtau.Core/G2p/Data/g2p-es.zip' }));

function estado(dirCache) {
  const voz = path.join(dirCache, VOZ.nombre);
  return {
    voz: fs.existsSync(path.join(voz, 'dsconfig.yaml')) && fs.existsSync(path.join(voz, 'dsmain', 'acoustic.onnx')),
    diccionario: fs.existsSync(path.join(dirCache, 'g2p-es', 'dict.txt')),
    dirVoz: voz, dirDiccionario: path.join(dirCache, 'g2p-es'), creditos: VOZ.creditos,
  };
}

async function descargar(url, destino, log, cabeceras = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...cabeceras }, redirect: 'follow' });
  if (!r.ok) throw new Error('No se pudo descargar ' + url + ' (' + r.status + ')');
  const total = +r.headers.get('content-length') || 0;
  const tmp = destino + '.parte';
  const out = fs.createWriteStream(tmp);
  let leido = 0, ultimo = 0;
  for await (const trozo of r.body) {
    out.write(trozo); leido += trozo.length;
    if (log && total && leido - ultimo > 20e6) { ultimo = leido; log(`  descargados ${(leido / 1e6).toFixed(0)} de ${(total / 1e6).toFixed(0)} MB`); }
  }
  await new Promise((ok, mal) => { out.end(); out.on('finish', ok); out.on('error', mal); });
  fs.renameSync(tmp, destino);
  return destino;
}

function descomprimir(zip, dir, log) {
  fs.mkdirSync(dir, { recursive: true });
  // tar.exe (bsdtar) viene con Windows 10/11 y sabe abrir zip
  try { execFileSync('tar', ['-xf', zip, '-C', dir], { stdio: 'ignore' }); }
  catch { execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`], { stdio: 'ignore' }); }
}

async function instalar(dirCache, log = console.log) {
  fs.mkdirSync(dirCache, { recursive: true });
  const est = estado(dirCache);
  if (!est.diccionario) {
    log('Descargando el diccionario de pronunciación española (2 MB)…');
    const zip = path.join(dirCache, 'g2p-es.zip');
    await descargar(G2P[0].url, zip, log);
    descomprimir(zip, path.join(dirCache, 'g2p-es'), log);
    fs.unlinkSync(zip);
  }
  if (!est.voz) {
    const zip = path.join(dirCache, VOZ.nombre + '.zip');
    if (!fs.existsSync(zip)) {
      log('Descargando la voz Hoshino Hanami (550 MB, solo esta vez)…');
      // MediaFire: la página trae el enlace directo de descarga
      const pagina = await (await fetch(VOZ.pagina, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
      const m = pagina.match(/https:\/\/download[0-9]*\.mediafire\.com\/[^"' ]+/);
      if (!m) throw new Error('No se encontró el enlace de descarga de la voz en MediaFire; inténtalo más tarde');
      await descargar(m[0], zip, log);
    }
    log('Descomprimiendo la voz…');
    const tmp = path.join(dirCache, 'tmp-' + VOZ.nombre);
    fs.rmSync(tmp, { recursive: true, force: true });
    descomprimir(zip, tmp, log);
    const dentro = fs.readdirSync(tmp).map(n => path.join(tmp, n)).find(p => fs.existsSync(path.join(p, 'dsconfig.yaml'))) || (fs.existsSync(path.join(tmp, 'dsconfig.yaml')) ? tmp : null);
    if (!dentro) throw new Error('El zip de la voz no tiene la estructura esperada');
    fs.rmSync(path.join(dirCache, VOZ.nombre), { recursive: true, force: true });
    fs.renameSync(dentro, path.join(dirCache, VOZ.nombre));
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.unlinkSync(zip);
    log('Voz instalada.');
  }
  return estado(dirCache);
}

module.exports = { estado, instalar, VOZ };
