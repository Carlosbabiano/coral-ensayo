// Publica la app en GitHub Pages (la primera vez crea el repositorio; después solo sube cambios).
// Uso: node herramientas/publicar.js [nombre-del-repositorio]
const { execSync } = require('child_process'), path = require('path');
const RAIZ = path.resolve(__dirname, '..');
// GIT_TERMINAL_PROMPT=0: si git no tiene credenciales, falla con mensaje en vez de quedarse esperando
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const sh = (c, silencio) => execSync(c, { cwd: RAIZ, stdio: silencio ? 'pipe' : 'inherit', encoding: 'utf8', env: ENV });
const out = c => sh(c, true).trim();

// --sin-comprobar: no espera a comprobar los archivos en internet (el gestor lo hace por su cuenta, en segundo plano)
const sinComprobar = process.argv.includes('--sin-comprobar');
const nombre = process.argv.slice(2).find(a => !a.startsWith('--')) || 'coral-ensayo';
let remoto = '';
try { remoto = out('git remote get-url origin'); } catch {}

if (!remoto) {
  const usuario = out('gh api user -q .login');
  console.log(`Creando el repositorio público ${usuario}/${nombre} en GitHub...`);
  sh(`gh repo create ${nombre} --public --source . --remote origin --push`);
  remoto = out('git remote get-url origin');
} else {
  // Antes de subir, lo que se haya cambiado desde el gestor del móvil (si no, el push fallaría o lo pisaría)
  const sinc = require('./sincronizar.js').traerCambios(console.log);
  if (sinc.estado === 'conflicto') { console.error('X ' + sinc.mensaje); process.exit(1); }
  console.log('Subiendo cambios a ' + remoto);
  sh('git push origin main');
}

// La rama gh-pages contiene solo la carpeta app/ (es lo que se publica). Se crea un commit nuevo con ese árbol tal
// cual, encima del último publicado: `git subtree split` recorría toda la historia y tardaba más a cada obra
// (más de un minuto con 170 commits)
console.log('Publicando la carpeta app/ en GitHub Pages...');
const arbol = out('git rev-parse HEAD:app');
let padre = '';
try { padre = out('git rev-parse origin/gh-pages'); } catch { try { padre = out('git rev-parse gh-pages'); } catch {} }
const commitPages = out(`git commit-tree ${arbol}${padre ? ' -p ' + padre : ''} -m "Publicar la app (${out('git rev-parse --short HEAD')})"`);
sh(`git push -f origin ${commitPages}:refs/heads/gh-pages`, true);
try { sh(`git branch -f gh-pages ${commitPages}`, true); } catch {}

const repo = remoto.replace(/\.git$/, '').split('/').slice(-2).join('/');
try {
  sh(`gh api -X POST repos/${repo}/pages -f build_type=legacy -f "source[branch]=gh-pages" -f "source[path]=/"`, true);
} catch { /* ya estaba activado */ }
const url = `https://${repo.split('/')[0].toLowerCase()}.github.io/${repo.split('/')[1]}/`;
console.log(`\nListo. La app estará disponible en 1-2 minutos en:\n\n   ${url}\n\nComparte esa dirección con el coro. En el móvil: abrirla y "Añadir a pantalla de inicio".`);

// Comprobación: que todos los archivos de las obras existan de verdad en internet (con el mismo nombre exacto)
if (!sinComprobar) (async () => {
  const lista = JSON.parse(require('fs').readFileSync(path.join(RAIZ, 'app', 'partituras', 'lista.json'), 'utf8'));
  const archivos = lista.flatMap(o => [o.archivo, o.posiciones, ...(o.paginas || [])].filter(Boolean));
  process.stdout.write('\nComprobando los archivos en internet (espera un par de minutos)...');
  await new Promise(r => setTimeout(r, 120000));
  const faltan = [];
  for (const f of archivos) { try { const r = await fetch(url + 'partituras/' + f + '?t=' + Date.now(), { method: 'HEAD' }); if (r.status !== 200) faltan.push(f); } catch { faltan.push(f); } }
  if (faltan.length) console.log(`\n! ATENCION: estos archivos no se encuentran en internet (revisa mayúsculas/minúsculas del nombre):\n  ${faltan.join('\n  ')}`);
  else console.log(` correcto: ${archivos.length} archivos disponibles.`);
})();
