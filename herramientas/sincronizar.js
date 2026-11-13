// Trae a este ordenador los cambios hechos desde el gestor del móvil (app/gestor/), que se guardan directamente en
// GitHub. Lo usan el gestor al arrancar y publicar.js antes de subir: así el PC nunca pisa lo que se hizo en el móvil.
//
//  - Si aquí no hay nada nuevo: avanza hasta lo de GitHub (fast-forward).
//  - Si aquí también hay cambios sin subir: los pone encima de los del móvil (rebase). En los choques gana lo de aquí
//    (es lo más reciente en la mayoría de los casos) y después se rehacen la versión de caché y las huellas, que son
//    datos calculados.
//  - Sin conexión o sin repositorio: no hace nada y lo dice.
const { execSync } = require('child_process'), path = require('path');
const RAIZ = path.resolve(__dirname, '..');
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const git = (c, ms = 60000) => execSync('git ' + c, { cwd: RAIZ, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: ENV, timeout: ms }).trim();
const COMMIT = '-c user.name="Coral" -c user.email="ipadbabiano@gmail.com"';

// Devuelve { estado: 'al-dia' | 'traidos' | 'combinados' | 'sin-conexion' | 'conflicto', mensaje, n }
function traerCambios(log = () => {}) {
  try { git('rev-parse --is-inside-work-tree'); git('remote get-url origin'); } catch { return { estado: 'sin-conexion', mensaje: 'No hay repositorio de GitHub.' }; }
  let rama; try { rama = git('symbolic-ref --short HEAD'); } catch { return { estado: 'conflicto', mensaje: 'El repositorio no está en ninguna rama.' }; }
  if (rama !== 'main') return { estado: 'al-dia', mensaje: 'Rama ' + rama + ': no se traen cambios del móvil.' };
  try { git('fetch -q origin main', 30000); } catch { return { estado: 'sin-conexion', mensaje: 'Sin conexión con GitHub: no se han podido traer los cambios del móvil.' }; }
  const n = +git('rev-list --count HEAD..origin/main') || 0;
  if (!n) return { estado: 'al-dia', mensaje: 'Al día con GitHub.', n: 0 };
  const titulos = git('log --format=%s HEAD..origin/main').split('\n').filter(Boolean);
  const locales = +git('rev-list --count origin/main..HEAD') || 0;
  // Cambios a medio guardar en la carpeta (archivos sin commit): se apartan un momento con un commit temporal
  let temporal = false;
  if (git('status --porcelain --untracked-files=no -- app originales')) { git(`${COMMIT} commit -q -m "TEMPORAL sincronizar" -- app originales`); temporal = true; }
  const deshacerTemporal = () => { if (temporal) git('reset -q --soft HEAD~1'); };
  try {
    if (!locales && !temporal) {
      git('merge -q --ff-only origin/main');
      log(`Traídos ${n} cambio(s) hechos desde el móvil: ${titulos.join(' · ')}`);
      return { estado: 'traidos', mensaje: `Traídos ${n} cambio(s) del móvil.`, n };
    }
    try { git('rebase -q -X theirs origin/main', 120000); }
    catch (e) {
      try { git('rebase --abort'); } catch {}
      deshacerTemporal();
      return { estado: 'conflicto', mensaje: 'Hay cambios del móvil que chocan con los de este ordenador y no se han podido juntar solos. Pide ayuda antes de publicar.' };
    }
    // La versión de caché y las huellas se recalculan sobre el resultado (las dos ramas habían subido la versión)
    const obra = require('./obra.js');
    const v = obra.subirVersionCache();
    deshacerTemporal();
    if (!temporal) { try { git(`${COMMIT} commit -q -m "Juntar cambios del móvil (caché ${v})" -- app/sw.js app/partituras/huellas.json`); } catch {} }
    log(`Juntados ${n} cambio(s) del móvil con los de este ordenador: ${titulos.join(' · ')}`);
    return { estado: 'combinados', mensaje: `Juntados ${n} cambio(s) del móvil con los de este ordenador.`, n };
  } catch (e) {
    deshacerTemporal();
    return { estado: 'conflicto', mensaje: 'No se han podido traer los cambios del móvil: ' + (e.stderr || e.message || '').toString().trim().split('\n')[0] };
  }
}

module.exports = { traerCambios };
if (require.main === module) { const r = traerCambios(console.log); console.log(r.mensaje); process.exit(r.estado === 'conflicto' ? 1 : 0); }
