// Publica la app en GitHub Pages (la primera vez crea el repositorio; después solo sube cambios).
// Uso: node herramientas/publicar.js [nombre-del-repositorio]
const { execSync } = require('child_process'), path = require('path');
const RAIZ = path.resolve(__dirname, '..');
// GIT_TERMINAL_PROMPT=0: si git no tiene credenciales, falla con mensaje en vez de quedarse esperando
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const sh = (c, silencio) => execSync(c, { cwd: RAIZ, stdio: silencio ? 'pipe' : 'inherit', encoding: 'utf8', env: ENV });
const out = c => sh(c, true).trim();

const nombre = process.argv[2] || 'coral-ensayo';
let remoto = '';
try { remoto = out('git remote get-url origin'); } catch {}

if (!remoto) {
  const usuario = out('gh api user -q .login');
  console.log(`Creando el repositorio público ${usuario}/${nombre} en GitHub...`);
  sh(`gh repo create ${nombre} --public --source . --remote origin --push`);
  remoto = out('git remote get-url origin');
} else {
  console.log('Subiendo cambios a ' + remoto);
  sh('git push origin main');
}

// La rama gh-pages contiene solo la carpeta app/ (es lo que se publica)
console.log('Publicando la carpeta app/ en GitHub Pages...');
try { sh('git branch -D gh-pages', true); } catch {}
sh('git subtree split --prefix app -b gh-pages', true);
sh('git push -f origin gh-pages:gh-pages', true);

const repo = remoto.replace(/\.git$/, '').split('/').slice(-2).join('/');
try {
  sh(`gh api -X POST repos/${repo}/pages -f build_type=legacy -f "source[branch]=gh-pages" -f "source[path]=/"`, true);
} catch { /* ya estaba activado */ }
const url = `https://${repo.split('/')[0].toLowerCase()}.github.io/${repo.split('/')[1]}/`;
console.log(`\nListo. La app estará disponible en 1-2 minutos en:\n\n   ${url}\n\nComparte esa dirección con el coro. En el móvil: abrirla y "Añadir a pantalla de inicio".`);
