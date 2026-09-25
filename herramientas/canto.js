// Voces cantadas: a partir de los datos de la app (una pista por voz, con notas y letra) genera los proyectos
// para el sintetizador de canto (Synthesizer V: .svp; y .mid con letra para otros programas), y convierte el audio
// que exporta el sintetizador a MP3 para meterlo en la obra. Lo usa el Gestor de obras (gestor.js).
const fs = require('fs'), path = require('path'), { execFile } = require('child_process');

const NEGRA_SV = 705600000; // "blicks" por negra en Synthesizer V
const TICKS_MIDI = 480;     // ticks por negra en el MIDI
const EXT_AUDIO = /\.(wav|flac|aiff?|mp3|m4a|ogg)$/i;

// Texto de una sílaba o palabra tal como debe cantarse: sin puntuación ni comillas
const limpiar = t => String(t || '').normalize('NFC').replace(/[^\p{L}\p{M}'’]+/gu, '').trim();
// Nombre de archivo sin acentos ni espacios
const slug = t => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'voz';

// Notas de una pista ordenadas, sin solapes y con la letra que hay que escribir en cada una
// (Synthesizer V: la palabra entera en su primera sílaba, "+" en las siguientes, "-" cuando la nota alarga la sílaba anterior)
function notasPista(pista) {
  const notas = [...pista.notas].filter(n => n.durQ > 0).sort((a, b) => a.q - b.q);
  const salida = [];
  let palabraAbierta = null, hayLetra = false;
  for (let i = 0; i < notas.length; i++) {
    const n = notas[i], sig = notas[i + 1];
    let durQ = n.durQ;
    if (sig && n.q + durQ > sig.q) durQ = sig.q - n.q;
    if (durQ <= 0) continue;
    const l = n.letra;
    let sv, midi;
    if (!l || !limpiar(l.texto)) { sv = hayLetra ? '-' : 'a'; midi = hayLetra ? '' : 'a'; }
    else {
      const texto = limpiar(l.texto), palabra = limpiar(l.palabra) || texto, total = l.total || 1;
      if (total > 1 && palabra !== texto) {
        if (l.indice === 0) { sv = palabra; palabraAbierta = palabra; }
        else if (palabraAbierta === palabra) sv = '+';
        else { sv = texto; palabraAbierta = null; }
      } else { sv = texto; palabraAbierta = null; }
      midi = texto + (total > 1 && l.indice < total - 1 ? '-' : '');
      hayLetra = true;
    }
    salida.push({ q: n.q, durQ, midi: n.midi, sv, letraMidi: midi, compas: n.compas });
  }
  return salida;
}

function uuid() { return require('crypto').randomUUID(); }

// Proyecto de Synthesizer V (formato .svp, JSON) con una sola pista: sirve también para la edición gratuita
function svpDe({ titulo, bpm, compas, pista, notas }) {
  const grupo = uuid();
  const curva = () => ({ mode: 'cubic', points: [] });
  return {
    version: 113,
    time: { meter: [{ index: 0, numerator: (compas && compas.num) || 4, denominator: (compas && compas.den) || 4 }], tempo: [{ position: 0, bpm: +bpm || 80 }] },
    library: [],
    tracks: [{
      name: pista.nombre, dispColor: 'ff7db235', dispOrder: 0, renderEnabled: true,
      mixer: { gainDecibel: 0, pan: 0, mute: false, solo: false, display: true },
      mainGroup: {
        name: 'main', uuid: grupo,
        parameters: { pitchDelta: curva(), vibratoEnv: curva(), loudness: curva(), tension: curva(), breathiness: curva(), voicing: curva(), gender: curva() },
        notes: notas.map(n => ({ onset: Math.round(n.q * NEGRA_SV), duration: Math.round(n.durQ * NEGRA_SV), lyrics: n.sv, phonemes: '', pitch: n.midi, attributes: {}, musicalType: 'singing' })),
      },
      mainRef: {
        groupID: grupo, blickOffset: 0, pitchOffset: 0, isInstrumental: false,
        database: { name: '', language: 'spanish', phoneset: 'xsampa', languageOverride: 'spanish' },
        audio: { filename: '', duration: 0 }, dictionary: '', voice: {},
      },
      groups: [],
    }],
    renderConfig: { destination: './', filename: slug(pista.nombre), numChannels: 1, aspirationFormat: 'noAspiration', bitDepth: 16, sampleRate: 44100, exportMixDown: true },
  };
}

// MIDI (formato 0) con la letra en cada nota: lo leen ACE Studio, Vocaloid, OpenUtau, MuseScore…
function midiDe({ titulo, bpm, compas, pista, notas }) {
  const ev = []; // { tick, orden, bytes }
  const meta = (tick, tipo, datos, orden = 0) => ev.push({ tick, orden, bytes: [0xff, tipo, ...varint(datos.length), ...datos] });
  const texto = t => [...Buffer.from(t, 'latin1')];
  meta(0, 0x03, texto(pista.nombre));
  meta(0, 0x51, [(Math.round(60000000 / (+bpm || 80)) >> 16) & 255, (Math.round(60000000 / (+bpm || 80)) >> 8) & 255, Math.round(60000000 / (+bpm || 80)) & 255]);
  const num = (compas && compas.num) || 4, den = (compas && compas.den) || 4;
  meta(0, 0x58, [num, Math.round(Math.log2(den)), 24, 8]);
  for (const n of notas) {
    const t0 = Math.round(n.q * TICKS_MIDI), t1 = Math.round((n.q + n.durQ) * TICKS_MIDI) - 1;
    if (n.letraMidi) meta(t0, 0x05, texto(n.letraMidi), 1);
    ev.push({ tick: t0, orden: 2, bytes: [0x90, n.midi, 100] });
    ev.push({ tick: Math.max(t0 + 1, t1), orden: -1, bytes: [0x80, n.midi, 0] });
  }
  ev.sort((a, b) => a.tick - b.tick || a.orden - b.orden);
  const bytes = [];
  let ultimo = 0;
  for (const e of ev) { bytes.push(...varint(e.tick - ultimo), ...e.bytes); ultimo = e.tick; }
  bytes.push(0, 0xff, 0x2f, 0);
  const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return Buffer.from([...'MThd'].map(c => c.charCodeAt(0)).concat(u32(6), [0, 0, 0, 1, TICKS_MIDI >> 8, TICKS_MIDI & 255], [...'MTrk'].map(c => c.charCodeAt(0)), u32(bytes.length), bytes));
}
function varint(n) { const b = [n & 127]; while ((n >>= 7) > 0) b.unshift((n & 127) | 128); return b; }

const LEEME = ({ titulo, pistas, bpm, tempoConstante }) => `VOCES CANTADAS DE «${titulo}»
================================${'='.repeat(titulo.length)}

En esta carpeta hay, por cada voz, un proyecto para Synthesizer V (.svp) y un MIDI con la letra (.mid):
${pistas.map(p => `  - ${p.nombre}: ${p.svp}  (${p.notas} notas)`).join('\n')}

Tempo: ♩ = ${bpm}${tempoConstante ? '' : '  ¡OJO! La obra cambia de tempo por el camino: el audio puede descuadrarse con la barra en esos tramos.'}

QUÉ HACER
1. Abre Synthesizer V Studio 2 (la edición gratuita vale: solo permite una pista por proyecto, y por eso hay un proyecto por voz).
   Descarga: https://dreamtonics.com/synthesizerv/
2. Archivo → Abrir… → elige el .svp de una voz.
3. En el panel de la voz (a la derecha) elige la voz que va a cantar y comprueba que el idioma sea Español.
   Voces graves (Tenor, Bajo): elige una voz masculina; agudas (Soprano, Contralto): femenina.
   OJO: para exportar audio la voz tiene que tener licencia completa (las voces "de prueba" no exportan).
4. Render (panel de exportación) → Exportar. Deja el nombre que propone (es el nombre de la voz) y guarda el .wav
   EN ESTA MISMA CARPETA.
5. Repite con cada voz. Al terminar, vuelve al Gestor y pulsa «Incorporar las voces exportadas»:
   convierte los .wav a MP3, los mete en la obra y podrás oírlos en la previsualización antes de publicar.

Si usas otro programa de canto (ACE Studio, Vocaloid…), importa el .mid de cada voz: lleva las notas y la letra.
Exporta igualmente un archivo de audio por voz con el mismo nombre que el proyecto (${pistas[0] ? pistas[0].nombre + '.wav' : 'Soprano.wav'}, …).
`;

// Escribe los proyectos de todas las pistas en la carpeta dada. Devuelve el estado de la carpeta.
function prepararProyectos(dir, datos) {
  if (!datos || !Array.isArray(datos.pistas) || !datos.pistas.length) throw new Error('No hay voces que preparar');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/\.(svp|mid|txt)$/i.test(f)) fs.unlinkSync(path.join(dir, f));
  const hechas = [];
  for (const pista of datos.pistas) {
    const notas = notasPista(pista);
    if (!notas.length) continue;
    const base = slug(pista.nombre);
    const svp = base + '.svp', mid = base + '.mid';
    fs.writeFileSync(path.join(dir, svp), JSON.stringify(svpDe({ ...datos, pista, notas }), null, 1));
    fs.writeFileSync(path.join(dir, mid), midiDe({ ...datos, pista, notas }));
    hechas.push({ nombre: pista.nombre, parte: pista.parte, sub: pista.sub, base, svp, mid, notas: notas.length });
  }
  if (!hechas.length) throw new Error('Ninguna voz tiene notas');
  fs.writeFileSync(path.join(dir, 'pistas.json'), JSON.stringify({ titulo: datos.titulo, bpm: datos.bpm, tempoConstante: datos.tempoConstante, pistas: hechas }, null, 2));
  fs.writeFileSync(path.join(dir, 'LEEME.txt'), LEEME({ titulo: datos.titulo || 'la obra', pistas: hechas, bpm: datos.bpm, tempoConstante: datos.tempoConstante }));
  return estadoCarpeta(dir);
}

// Qué hay en la carpeta: por cada pista preparada, si ya está el audio exportado por el sintetizador
function estadoCarpeta(dir) {
  let info = null;
  try { info = JSON.parse(fs.readFileSync(path.join(dir, 'pistas.json'), 'utf8')); } catch { return null; }
  const archivos = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const audios = archivos.filter(f => EXT_AUDIO.test(f));
  const pistas = info.pistas.map(p => {
    const clave = p.base.toLowerCase();
    const audio = audios.find(a => a.replace(EXT_AUDIO, '').toLowerCase() === clave)
      || audios.find(a => a.replace(EXT_AUDIO, '').toLowerCase().replace(/[^a-z0-9]/g, '') === clave.replace(/[^a-z0-9]/g, ''))
      || audios.find(a => a.toLowerCase().startsWith(clave)) || null;
    return { ...p, audio };
  });
  // Una sola pista y un solo audio con otro nombre: es ese
  if (pistas.length === 1 && !pistas[0].audio && audios.length === 1) pistas[0].audio = audios[0];
  return { carpeta: dir, titulo: info.titulo, bpm: info.bpm, tempoConstante: info.tempoConstante, pistas, audiosSueltos: audios.filter(a => !pistas.some(p => p.audio === a)) };
}

function ffmpeg() {
  try { return require('ffmpeg-static'); }
  catch { throw new Error('Falta el conversor de audio (ffmpeg). Cierra el Gestor y vuelve a abrirlo con Gestor.cmd: lo instala solo la primera vez (hace falta internet).'); }
}
// Convierte el audio exportado a MP3 mono con el volumen igualado entre voces (mide el nivel medio y lo lleva a -18 dB)
function ejecutar(exe, args) {
  return new Promise((ok, mal) => {
    execFile(exe, args, { encoding: 'utf8', maxBuffer: 1 << 24, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !/volumedetect/.test(args.join(' '))) return mal(new Error((stderr || '').split(/\r?\n/).filter(Boolean).slice(-2).join(' ') || err.message));
      ok((stdout || '') + (stderr || ''));
    });
  });
}
async function convertirAMp3(origen, destino) {
  const exe = ffmpeg();
  const medida = await ejecutar(exe, ['-hide_banner', '-nostats', '-i', origen, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  const media = +(medida.match(/mean_volume:\s*(-?[\d.]+) dB/) || [, NaN])[1], pico = +(medida.match(/max_volume:\s*(-?[\d.]+) dB/) || [, NaN])[1];
  let ganancia = 0;
  if (!isNaN(media)) ganancia = Math.min(-18 - media, isNaN(pico) ? 40 : -1 - pico); // sin pasar de -1 dB de pico
  await ejecutar(exe, ['-y', '-hide_banner', '-loglevel', 'error', '-i', origen, '-vn', '-af', 'volume=' + ganancia.toFixed(2) + 'dB', '-ac', '1', '-ar', '44100', '-codec:a', 'libmp3lame', '-b:a', '96k', destino]);
  return destino;
}

// Nombre del MP3 de una voz dentro de la obra: <base de la obra>.canto.<voz>.mp3
const archivoCanto = (baseObra, nombrePista) => `${baseObra}.canto.${slug(nombrePista)}.mp3`;

module.exports = { notasPista, svpDe, midiDe, prepararProyectos, estadoCarpeta, convertirAMp3, archivoCanto, slug, EXT_AUDIO };
