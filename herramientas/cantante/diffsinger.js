// El cantante: convierte una pista (notas con letra) en audio con una voz DiffSinger, siguiendo el mismo camino que
// OpenUtau: fonemas → modelo de duraciones (dónde empieza cada fonema) → modelo de tono (la curva que cantaría una
// persona) → modelo acústico (espectrograma) → vocoder (onda). Se canta frase a frase (entre silencios) y se mezcla.
const ort = require('onnxruntime-node');
const { Fonetizador } = require('./g2p.js');

const CABEZA = 8, COLA = 8;            // cuadros de silencio antes y después de cada frase (como OpenUtau)
const RELLENO_MS = 500;                // sitio para las consonantes de arranque de la frase
const PASOS_ACUSTICO = 20, PASOS_TONO = 10, PROFUNDIDAD = 1.0;

const redondeoBanco = x => { const r = Math.round(x); return Math.abs(x - Math.trunc(x)) === 0.5 && r % 2 !== 0 ? r - 1 : r; };
// Duraciones en ms → cuadros, acumulando para no perder el sitio (DurationsMsToFrames de OpenUtau)
function msACuadros(duraciones, frameMs) {
  const out = []; let acum = 0, prev = 0;
  for (const d of duraciones) { acum += d; const f = redondeoBanco(acum / frameMs + 0.5); out.push(f - prev); prev = f; }
  return out;
}
const t64 = (arr, dims) => new ort.Tensor('int64', BigInt64Array.from(arr.map(x => BigInt(Math.round(x)))), dims);
const t32 = (arr, dims) => new ort.Tensor('float32', Float32Array.from(arr), dims);
const tBool = (arr, dims) => new ort.Tensor('bool', Uint8Array.from(arr.map(x => (x ? 1 : 0))), dims);
const midiAHz = m => 440 * Math.pow(2, (m - 69) / 12);

class Cantante {
  constructor(voz, { rutaDiccionario, log = () => {} } = {}) {
    this.voz = voz;
    this.fonetizador = new Fonetizador({ rutaDiccionario, voz: { fonemas: voz.fonemas, reemplazos: voz.reemplazos, diccionarioVoz: voz.diccionarioVoz, tipos: voz.tipos } });
    this.log = log;
  }

  // ---------- 1. Notas → palabras → frases ----------
  // notas: [{ q, durQ, midi, letra: {texto, palabra, indice, total} | null }] (posiciones en negras); bpm; idioma 'es' | 'la'
  palabras(notas, bpm) {
    const ms = q => q * 60000 / bpm;
    const ordenadas = [...notas].filter(n => n.durQ > 0).sort((a, b) => a.q - b.q);
    const palabras = [];
    let actual = null;
    for (let i = 0; i < ordenadas.length; i++) {
      const n = ordenadas[i], sig = ordenadas[i + 1];
      let durQ = n.durQ; if (sig && n.q + durQ > sig.q) durQ = sig.q - n.q; if (durQ <= 0) continue;
      const nota = { tMs: ms(n.q), durMs: ms(durQ), finMs: ms(n.q + durQ), midi: n.midi, extension: false };
      const l = n.letra, texto = l && String(l.texto || '').replace(/[^\p{L}]/gu, '');
      const palabra = l && String(l.palabra || texto).replace(/[^\p{L}]/gu, '');
      const contigua = actual && Math.abs(actual.notas[actual.notas.length - 1].finMs - nota.tMs) < 1;
      if (!texto) { // sin letra: alarga la sílaba anterior (melisma)
        if (actual && contigua) { nota.extension = true; actual.notas.push(nota); }
        else { actual = { texto: 'a', notas: [nota] }; palabras.push(actual); } // sin letra ninguna: "a"
      } else if (l.indice > 0 && actual && contigua && actual.texto === palabra && actual.silabasEsperadas < (l.total || 1)) {
        actual.notas.push(nota); actual.silabasEsperadas++;
      } else {
        actual = { texto: palabra || texto, notas: [nota], silabasEsperadas: 1 };
        palabras.push(actual);
      }
    }
    for (const p of palabras) if (p.silabasEsperadas === undefined) p.silabasEsperadas = 1;
    return palabras;
  }
  frases(palabras, maxMs = 40000) {
    const frases = []; let f = null;
    for (const p of palabras) {
      const ini = p.notas[0].tMs, finAnt = f ? f.palabras[f.palabras.length - 1].notas.slice(-1)[0].finMs : null;
      if (f && Math.abs(finAnt - ini) < 1 && (p.notas.slice(-1)[0].finMs - f.palabras[0].notas[0].tMs) < maxMs) f.palabras.push(p);
      else { f = { palabras: [p] }; frases.push(f); }
    }
    return frases;
  }

  // ---------- 2. Fonemas de una palabra repartidos entre sus notas (ProcessWord de OpenUtau) ----------
  repartir(palabra, idioma) {
    const voz = this.voz;
    let fon = this.fonetizador.fonemas(palabra.texto, idioma);
    if (!fon.length) fon = ['a'].filter(f => voz.fonemas.has(f));
    const notasSilaba = palabra.notas.filter(n => !n.extension);
    // Si la partitura tiene más sílabas que vocales hay (hiato que el diccionario hizo diptongo), las semivocales pasan a vocales
    const promocion = { y: 'i', w: voz.reemplazos.u || 'u', I1: 'i', U1: voz.reemplazos.u || 'u', I: 'i', U: 'u', O1: 'o', V: 'i' };
    let nVocales = fon.filter(f => voz.esVocal(f)).length;
    for (let i = 0; i < fon.length && nVocales < notasSilaba.length; i++) {
      if (voz.esSemivocal(fon[i]) && promocion[fon[i]] && voz.fonemas.has(promocion[fon[i]])) { fon[i] = promocion[fon[i]]; nVocales++; }
    }
    const esV = fon.map(f => voz.esVocal(f)), esG = fon.map(f => voz.esSemivocal(f));
    const inicio = new Array(fon.length).fill(false);
    if (!esV.some(Boolean)) inicio[0] = true;
    for (let i = 0; i < fon.length; i++) if (esV[i]) { if (i >= 2 && esG[i - 1] && !esV[i - 2]) inicio[i - 1] = true; else inicio[i] = true; }
    // grupos: el 0 son las consonantes antes de la primera nota; después uno por nota con sílaba
    const grupos = [{ nota: null, fonemas: [] }];
    let k = 0;
    for (let i = 0; i < fon.length; i++) {
      if (inicio[i] && k < notasSilaba.length) { grupos.push({ nota: notasSilaba[k], fonemas: [] }); k++; }
      grupos[grupos.length - 1].fonemas.push(fon[i]);
    }
    return grupos;
  }

  // ---------- 3. Una frase: duraciones de fonemas (modelo dsdur) ----------
  async fonemasConTiempo(frase, idioma) {
    const voz = this.voz, frameMs = voz.frameMs;
    const primera = frase.palabras[0].notas[0], ultima = frase.palabras[frase.palabras.length - 1].notas.slice(-1)[0];
    // grupos con posición: [cabeza SP + consonantes iniciales] [nota…] …, y el final
    const grupos = [{ posMs: primera.tMs - RELLENO_MS, tono: primera.midi, fonemas: ['SP'] }];
    const porPalabra = [];
    for (const p of frase.palabras) {
      const g = this.repartir(p, idioma);
      grupos[grupos.length - 1].fonemas.push(...g[0].fonemas);
      for (const x of g.slice(1)) grupos.push({ posMs: x.nota.tMs, tono: x.nota.midi, fonemas: x.fonemas });
      porPalabra.push(g);
    }
    grupos.push({ posMs: ultima.finMs, tono: ultima.midi, fonemas: [] });
    const fonemas = grupos.flatMap(g => g.fonemas);
    const tokens = fonemas.map(f => voz.token(f));
    const wordDiv = grupos.slice(0, -1).map(g => g.fonemas.length);
    const cuadro = ms => Math.trunc(ms / frameMs);
    const wordDur = grupos.slice(0, -1).map((g, i) => cuadro(grupos[i + 1].posMs) - cuadro(g.posMs));
    const ling = await voz.sesionLinguisticaDur();
    const entradasLing = { tokens: t64(tokens, [1, tokens.length]), word_div: t64(wordDiv, [1, wordDiv.length]), word_dur: t64(wordDur, [1, wordDur.length]) };
    if (voz.usaIdiomas) entradasLing.languages = t64(fonemas.map(f => (voz.idiomas || {})[f.includes('/') ? f.split('/')[0] : ''] || 0), [1, fonemas.length]);
    const salidaLing = await ling.run(entradasLing);
    const dur = await voz.sesionDur();
    const phMidi = grupos.slice(0, -1).flatMap(g => g.fonemas.map(() => g.tono));
    const entradasDur = { encoder_out: salidaLing.encoder_out, x_masks: salidaLing.x_masks, ph_midi: t64(phMidi, [1, phMidi.length]) };
    const emb = voz.embed(voz.cfgDur, voz.dir + '/dsdur');
    if (emb) { const e = new Float32Array(fonemas.length * voz.hidden); for (let i = 0; i < fonemas.length; i++) e.set(emb, i * voz.hidden); entradasDur.spk_embed = new ort.Tensor('float32', e, [1, fonemas.length, voz.hidden]); }
    const salidaDur = await dur.run(entradasDur);
    const durCuadros = Array.from(salidaDur.ph_dur_pred.data);
    // Alineación: las consonantes de arranque conservan su duración; cada grupo se estira para caber entre sus notas
    const acumulado = []; let s = 0; for (const g of grupos.slice(0, -1)) { acumulado.push(s); s += g.fonemas.length; }
    const puntos = grupos.slice(1).map((g, i) => ({ idx: acumulado[i + 1] !== undefined ? acumulado[i + 1] : s, ms: g.posMs }));
    const estirar = (dur, ratio, finMs) => { const total = dur.reduce((a, b) => a + b, 0) * ratio; let t = finMs - total; return dur.map(d => { const p = t; t += d * ratio; return p; }); };
    const posiciones = [];
    posiciones.push(...estirar(durCuadros.slice(1, puntos[0].idx), frameMs, puntos[0].ms));
    for (let i = 0; i + 1 < puntos.length; i++) {
      const tramo = durCuadros.slice(puntos[i].idx, puntos[i + 1].idx);
      const suma = tramo.reduce((a, b) => a + b, 0) || 1;
      posiciones.push(...estirar(tramo, (puntos[i + 1].ms - puntos[i].ms) / suma, puntos[i + 1].ms));
    }
    // fonemas reales (sin la SP de cabeza) con su posición y duración
    const reales = fonemas.slice(1);
    const fones = reales.map((f, i) => ({ fonema: f, tMs: posiciones[i], finMs: i + 1 < posiciones.length ? posiciones[i + 1] : ultima.finMs }));
    for (const f of fones) f.durMs = Math.max(f.finMs - f.tMs, frameMs * 0.5);
    // notas de la frase (para el modelo de tono)
    const notas = frase.palabras.flatMap(p => p.notas);
    return { fones, notas };
  }

  // ---------- 4. Curva de tono (modelo dspitch) ----------
  async curvaTono(fones, notas, expresividad = 1) {
    const voz = this.voz, frameMs = voz.frameMs;
    const inicioMs = fones[0].tMs - CABEZA * frameMs;
    const segmentos = [{ f: 'SP', ms: CABEZA * frameMs, real: false }];
    fones.forEach((f, i) => { if (i > 0) { const hueco = f.tMs - fones[i - 1].finMs; if (hueco > 0) segmentos.push({ f: 'SP', ms: hueco, real: false }); } segmentos.push({ f: f.fonema, ms: f.durMs, real: true }); });
    segmentos.push({ f: 'SP', ms: COLA * frameMs, real: false });
    const phDur = msACuadros(segmentos.map(s => s.ms), frameMs);
    const totalCuadros = phDur.reduce((a, b) => a + b, 0);
    const tokens = segmentos.map(s => voz.token(s.f));
    let pitch = null;
    if (voz.cfgPitch && expresividad > 0) {
      const ling = await voz.sesionLinguisticaPitch();
      const entradasLing = { tokens: t64(tokens, [1, tokens.length]) };
      if (voz.cfgPitch.predict_dur) {
        const vocales = segmentos.map((s, i) => (s.real && voz.esVocal(s.f) ? i : -1)).filter(i => i >= 0);
        const ids = vocales.length ? vocales : [segmentos.length - 2];
        const wordDiv = [ids[0], ...ids.slice(1).map((v, i) => v - ids[i]), segmentos.length - ids[ids.length - 1]];
        const wordDur = []; let o = 0; for (const d of wordDiv) { let s = 0; for (let j = 0; j < d; j++) s += phDur[o + j]; wordDur.push(s); o += d; }
        entradasLing.word_div = t64(wordDiv, [1, wordDiv.length]); entradasLing.word_dur = t64(wordDur, [1, wordDur.length]);
      } else entradasLing.ph_dur = t64(phDur, [1, phDur.length]);
      const salidaLing = await ling.run(entradasLing);
      // notas con silencios entre medias, cabeza y cola
      const durNotas = [Math.max(0, notas[0].tMs - inicioMs)], midiNotas = [notas[0].midi], reposo = [true];
      let finAnt = notas[0].tMs;
      for (const n of notas) {
        const hueco = n.tMs - finAnt;
        if (hueco > 0) { durNotas.push(hueco); midiNotas.push(n.midi); reposo.push(true); }
        durNotas.push(n.durMs); midiNotas.push(n.midi); reposo.push(false);
        finAnt = n.finMs;
      }
      durNotas.push(COLA * frameMs); midiNotas.push(notas[notas.length - 1].midi); reposo.push(true);
      // los silencios toman el tono de la nota vecina
      for (let i = 0; i < reposo.length; i++) if (reposo[i]) {
        let j = i; while (j < reposo.length && reposo[j]) j++;
        const antes = i > 0 ? midiNotas[i - 1] : null, despues = j < reposo.length ? midiNotas[j] : null;
        const medio = Math.floor((i + j + 1) / 2);
        for (let k = i; k < j; k++) midiNotas[k] = (antes === null ? despues : despues === null ? antes : (k < medio ? antes : despues));
        i = j;
      }
      let noteDur = msACuadros(durNotas, frameMs);
      const delta = totalCuadros - noteDur.reduce((a, b) => a + b, 0); noteDur[noteDur.length - 1] += delta;
      for (let i = noteDur.length - 1; i >= 0 && noteDur[i] < 0; i--) { const d = -noteDur[i]; noteDur[i] = 0; if (i > 0) noteDur[i - 1] -= d; }
      const modelo = await voz.sesionPitch();
      const entradas = {
        encoder_out: salidaLing.encoder_out,
        ph_dur: t64(phDur, [1, phDur.length]),
        note_midi: t32(midiNotas, [1, midiNotas.length]),
        note_dur: t64(noteDur, [1, noteDur.length]),
        pitch: t32(new Array(totalCuadros).fill(60), [1, totalCuadros]),
        retake: tBool(new Array(totalCuadros).fill(true), [1, totalCuadros]),
      };
      const nombres = new Set(modelo.inputNames);
      if (nombres.has('note_rest')) entradas.note_rest = tBool(reposo, [1, reposo.length]);
      if (nombres.has('expr')) entradas.expr = t32(new Array(totalCuadros).fill(expresividad), [1, totalCuadros]);
      if (nombres.has('spk_embed')) { const emb = voz.embed(voz.cfgPitch, voz.dir + '/dspitch'); const e = new Float32Array(totalCuadros * voz.hidden); for (let i = 0; i < totalCuadros; i++) e.set(emb, i * voz.hidden); entradas.spk_embed = new ort.Tensor('float32', e, [1, totalCuadros, voz.hidden]); }
      if (nombres.has('steps')) entradas.steps = t64([PASOS_TONO], [1]);
      if (nombres.has('speedup')) entradas.speedup = t64([Math.max(1, Math.floor(1000 / PASOS_TONO))], [1]);
      const salida = await modelo.run(entradas);
      pitch = Array.from(salida.pitch_pred.data);
    }
    // sin modelo de tono (o como respaldo): tono de la nota con pequeñas transiciones
    if (!pitch) {
      pitch = new Array(totalCuadros).fill(notas[0].midi);
      for (let i = 0; i < totalCuadros; i++) { const t = inicioMs + i * frameMs; const n = notas.find(n => t >= n.tMs && t < n.finMs) || (t < notas[0].tMs ? notas[0] : notas[notas.length - 1]); pitch[i] = n.midi; }
      // tono recto, como el de un coro afinado: solo una transición mínima (~20 ms) entre notas, sin vibrato
      for (let i = 1; i < totalCuadros; i++) pitch[i] = pitch[i - 1] + (pitch[i] - pitch[i - 1]) * 0.6;
    }
    // en los cuadros de silencio (cabeza/cola/huecos) el tono no significa nada: se copia el del fonema vecino
    const real = []; segmentos.forEach((s, i) => { for (let k = 0; k < phDur[i]; k++) real.push(s.real); });
    let ult = null; for (let i = 0; i < totalCuadros; i++) { if (real[i]) ult = pitch[i]; else if (ult !== null) pitch[i] = ult; }
    let prim = null; for (let i = totalCuadros - 1; i >= 0; i--) { if (real[i]) prim = pitch[i]; else if (prim !== null && !real[i] && (i === 0 || !real[i - 1]) && pitch[i] === pitch[0]) pitch[i] = prim; }
    return { pitch, tokens, phDur, totalCuadros, inicioMs };
  }

  // ---------- 5. Modelo acústico + vocoder ----------
  async sintetizar({ pitch, tokens, phDur, totalCuadros }, { genero = 0, velocidad = 1, transposicion = 0 } = {}) {
    const voz = this.voz;
    const f0 = Float32Array.from(pitch.map(m => midiAHz(m + transposicion)));
    const acustico = await voz.sesionAcustica();
    const nombres = new Set(acustico.inputNames);
    const entradas = { tokens: t64(tokens, [1, tokens.length]), durations: t64(phDur, [1, phDur.length]), f0: new ort.Tensor('float32', f0, [1, totalCuadros]) };
    const cfg = voz.cfg;
    if (cfg.use_continuous_acceleration) {
      if (cfg.use_variable_depth || cfg.use_shallow_diffusion) entradas.depth = t32([Math.min(PROFUNDIDAD, cfg.max_depth || 1)], [1]);
      entradas.steps = t64([PASOS_ACUSTICO], [1]);
    } else {
      let speedup;
      if (cfg.use_variable_depth || cfg.use_shallow_diffusion) { let d = Math.round(Math.min(PROFUNDIDAD, (cfg.max_depth || 1000) / 1000) * 1000); speedup = Math.max(1, Math.floor(d / PASOS_ACUSTICO)); d = Math.floor(d / speedup) * speedup; entradas.depth = t64([d], [1]); }
      else { speedup = Math.max(1, Math.floor(1000 / PASOS_ACUSTICO)); while (1000 % speedup !== 0 && speedup > 1) speedup--; }
      entradas.speedup = t64([speedup], [1]);
    }
    if (nombres.has('languages')) entradas.languages = t64(new Array(tokens.length).fill(0), [1, tokens.length]);
    if (nombres.has('spk_embed')) { const emb = voz.embed(voz.cfg, voz.dir); const e = new Float32Array(totalCuadros * voz.hidden); for (let i = 0; i < totalCuadros; i++) e.set(emb, i * voz.hidden); entradas.spk_embed = new ort.Tensor('float32', e, [1, totalCuadros, voz.hidden]); }
    if (nombres.has('gender')) {
      // GENC de OpenUtau: 100 = 12 semitonos de formantes; positivo = más grave
      const rango = (cfg.augmentation_args && cfg.augmentation_args.random_pitch_shifting && cfg.augmentation_args.random_pitch_shifting.range) || [-12, 12];
      const escala = genero < 0 ? (rango[1] ? 12 / rango[1] / 100 : 0) : (rango[0] ? -12 / rango[0] / 100 : 0);
      entradas.gender = t32(new Array(totalCuadros).fill(-genero * escala), [1, totalCuadros]);
    }
    if (nombres.has('velocity')) entradas.velocity = t32(new Array(totalCuadros).fill(velocidad), [1, totalCuadros]);
    const mel = (await acustico.run(entradas)).mel;
    const vocoder = await voz.sesionVocoder();
    const melDatos = mel.data;
    if (voz.cfgVocoder.mel_base && cfg.mel_base && String(voz.cfgVocoder.mel_base) !== String(cfg.mel_base)) { const k = String(voz.cfgVocoder.mel_base) === 'e' ? 2.30259 : 0.434294; for (let i = 0; i < melDatos.length; i++) melDatos[i] *= k; }
    const onda = (await vocoder.run({ mel, f0: entradas.f0 })).waveform;
    return Float32Array.from(onda.data);
  }

  // ---------- Pista completa → muestras (44,1 kHz mono) ----------
  async cantarPista({ notas, bpm, idioma = 'es', genero = 0, transposicion = 0, expresividad = 1, alAvanzar = () => {}, cancelado = () => false }) {
    const voz = this.voz, sr = voz.sampleRate;
    const palabras = this.palabras(notas, bpm);
    if (!palabras.length) return new Float32Array(0);
    const frases = this.frases(palabras);
    const finMs = Math.max(...palabras.map(p => p.notas.slice(-1)[0].finMs)) + 1500;
    const mezcla = new Float32Array(Math.ceil(finMs / 1000 * sr));
    let i = 0;
    for (const frase of frases) {
      if (cancelado()) throw new Error('Cancelado');
      i++;
      const texto = frase.palabras.map(p => p.texto).join(' ');
      const t0 = Date.now();
      const { fones, notas: notasFrase } = await this.fonemasConTiempo(frase, idioma);
      const t1 = Date.now();
      const curva = await this.curvaTono(fones, notasFrase, expresividad);
      const t2 = Date.now();
      const onda = await this.sintetizar(curva, { genero, transposicion });
      const t3 = Date.now();
      const inicio = Math.round(curva.inicioMs / 1000 * sr);
      for (let k = 0; k < onda.length; k++) { const p = inicio + k; if (p >= 0 && p < mezcla.length) mezcla[p] += onda[k]; }
      this.log(`  frase ${i}/${frases.length} (${(fones[0].tMs / 1000).toFixed(1)} s): ${texto.slice(0, 60)}  [${((t1 - t0) / 1000).toFixed(1)}+${((t2 - t1) / 1000).toFixed(1)}+${((t3 - t2) / 1000).toFixed(1)} s]`);
      alAvanzar(i / frases.length);
    }
    let pico = 0; for (const x of mezcla) pico = Math.max(pico, Math.abs(x));
    if (pico > 0.95) for (let k = 0; k < mezcla.length; k++) mezcla[k] *= 0.95 / pico;
    return mezcla;
  }
}

function escribirWav(ruta, muestras, sr = 44100) {
  const fs = require('fs');
  const out = Buffer.alloc(44 + muestras.length * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + muestras.length * 2, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sr, 24); out.writeUInt32LE(sr * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(muestras.length * 2, 40);
  for (let i = 0; i < muestras.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(muestras[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(ruta, out);
}

module.exports = { Cantante, escribirWav };
