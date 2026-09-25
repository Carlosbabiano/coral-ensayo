// Carga de una voz DiffSinger (formato de OpenUtau): configuraciones, fonemas, diccionarios, "embeds" de los modos
// de voz y sesiones ONNX (que se crean cuando hacen falta).
const fs = require('fs'), path = require('path');
const YAML = require('yaml');

// Los dsdict de las voces no siempre son YAML válido (números con comas sin comillas, etc.): se leen línea a línea.
function leerDsDict(texto) {
  const simbolos = {}, entradas = new Map(), reemplazos = {};
  const desentrecomillar = s => s.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  for (const linea of texto.split(/\r?\n/)) {
    let m;
    if ((m = linea.match(/^\s*-\s*\{\s*symbol:\s*(.+?),\s*type:\s*([\w-]+)\s*\}/))) simbolos[desentrecomillar(m[1])] = m[2];
    else if ((m = linea.match(/^\s*-\s*\{\s*grapheme:\s*(.+?),\s*phonemes:\s*\[(.*?)\]\s*\}/))) {
      const g = desentrecomillar(m[1]).toLowerCase();
      if (!entradas.has(g)) entradas.set(g, m[2].split(',').map(x => desentrecomillar(x)).filter(Boolean));
    } else if ((m = linea.match(/^\s*-\s*\{\s*from:\s*(.+?),\s*to:\s*(.+?)\s*\}/))) reemplazos[desentrecomillar(m[1])] = desentrecomillar(m[2]);
  }
  return { simbolos, entradas, reemplazos };
}

function leerYaml(ruta) { return YAML.parse(fs.readFileSync(ruta, 'utf8'), { uniqueKeys: false }) || {}; }

class Voz {
  constructor(dir) {
    this.dir = dir;
    this.nombre = path.basename(dir);
    const cfg = this.cfg = leerYaml(path.join(dir, 'dsconfig.yaml'));
    this.cfgDur = fs.existsSync(path.join(dir, 'dsdur', 'dsconfig.yaml')) ? leerYaml(path.join(dir, 'dsdur', 'dsconfig.yaml')) : null;
    this.cfgPitch = fs.existsSync(path.join(dir, 'dspitch', 'dsconfig.yaml')) ? leerYaml(path.join(dir, 'dspitch', 'dsconfig.yaml')) : null;
    this.cfgVariance = fs.existsSync(path.join(dir, 'dsvariance', 'dsconfig.yaml')) ? leerYaml(path.join(dir, 'dsvariance', 'dsconfig.yaml')) : null;
    if (!this.cfgDur) throw new Error('La voz no tiene modelo de duraciones (dsdur): no sirve para cantar letra');
    this.sampleRate = cfg.sample_rate || 44100; this.hop = cfg.hop_size || 512;
    this.frameMs = 1000 * this.hop / this.sampleRate;
    this.hidden = cfg.hidden_size || 256;
    // Fonemas → índice
    const lineas = fs.readFileSync(path.join(dir, cfg.phonemes || 'dsmain/phonemes.txt'), 'utf8').split(/\r?\n/);
    this.tokens = {}; lineas.forEach((l, i) => { if (l !== '' || i === 0) this.tokens[l] = i; });
    delete this.tokens['']; this.fonemas = new Set(Object.keys(this.tokens));
    // Diccionarios (tipos de fonema, palabras en castellano, reemplazos)
    const dDur = path.join(dir, 'dsdur');
    const base = fs.existsSync(path.join(dDur, 'dsdict.yaml')) ? leerDsDict(fs.readFileSync(path.join(dDur, 'dsdict.yaml'), 'utf8')) : { simbolos: {}, entradas: new Map(), reemplazos: {} };
    const es = fs.existsSync(path.join(dDur, 'dsdict-es.yaml')) ? leerDsDict(fs.readFileSync(path.join(dDur, 'dsdict-es.yaml'), 'utf8')) : base;
    this.tipos = { ...base.simbolos, ...es.simbolos, SP: 'vowel', AP: 'vowel' };
    this.diccionarioVoz = es.entradas;
    this.reemplazos = es.reemplazos;
    this.usaIdiomas = !!cfg.use_lang_id;
    this.idiomas = this.usaIdiomas && cfg.languages ? JSON.parse(fs.readFileSync(path.join(dir, cfg.languages), 'utf8')) : null;
    // Vocoder: el propio de la voz o uno externo (carpeta de dependencias)
    const dv = path.join(dir, 'dsvocoder');
    if (fs.existsSync(path.join(dv, 'vocoder.yaml'))) { this.cfgVocoder = leerYaml(path.join(dv, 'vocoder.yaml')); this.dirVocoder = dv; }
    else this.cfgVocoder = null;
    this.sesiones = {};
    this.cacheEmb = {};
  }
  // El vocoder externo (nsf_hifigan) se busca en una carpeta de dependencias si la voz no trae el suyo
  usarVocoderExterno(dirDependencias) {
    if (this.cfgVocoder) return;
    const d = path.join(dirDependencias, this.cfg.vocoder || '');
    if (!fs.existsSync(path.join(d, 'vocoder.yaml'))) throw new Error('Falta el vocoder ' + (this.cfg.vocoder || '?') + ' en ' + dirDependencias);
    this.cfgVocoder = leerYaml(path.join(d, 'vocoder.yaml')); this.dirVocoder = d;
  }
  esVocal(f) { return this.tipos[f] === 'vowel'; }
  esSemivocal(f) { const t = this.tipos[f]; return t === 'semivowel' || t === 'liquid'; }
  token(f) { const t = this.tokens[f]; if (t === undefined) throw new Error('La voz no conoce el fonema "' + f + '"'); return t; }
  // Modo de voz por defecto (el primero) de cada modelo; speakers son rutas relativas a la carpeta del modelo
  embed(cfg, dirModelo, indice = 0) {
    if (!cfg.speakers || !cfg.speakers.length) return null;
    const ruta = path.join(dirModelo, cfg.speakers[Math.min(indice, cfg.speakers.length - 1)] + '.emb');
    if (this.cacheEmb[ruta]) return this.cacheEmb[ruta];
    const b = fs.readFileSync(ruta);
    const v = new Float32Array(this.hidden); for (let i = 0; i < this.hidden; i++) v[i] = b.readFloatLE(i * 4);
    return (this.cacheEmb[ruta] = v);
  }
  async sesion(clave, ruta) {
    if (!this.sesiones[clave]) { const ort = require('onnxruntime-node'); this.sesiones[clave] = await ort.InferenceSession.create(ruta, { graphOptimizationLevel: 'all' }); }
    return this.sesiones[clave];
  }
  sesionLinguisticaDur() { return this.sesion('lingDur', path.join(this.dir, 'dsdur', this.cfgDur.linguistic)); }
  sesionDur() { return this.sesion('dur', path.join(this.dir, 'dsdur', this.cfgDur.dur)); }
  sesionLinguisticaPitch() { return this.sesion('lingPitch', path.join(this.dir, 'dspitch', this.cfgPitch.linguistic)); }
  sesionPitch() { return this.sesion('pitch', path.join(this.dir, 'dspitch', this.cfgPitch.pitch)); }
  sesionAcustica() { return this.sesion('acoustic', path.join(this.dir, this.cfg.acoustic)); }
  sesionVocoder() { return this.sesion('vocoder', path.join(this.dirVocoder, this.cfgVocoder.model)); }
  liberar() { for (const k of Object.keys(this.sesiones)) { try { this.sesiones[k].release(); } catch {} } this.sesiones = {}; }
}

module.exports = { Voz, leerDsDict };
