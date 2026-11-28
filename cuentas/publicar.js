// Publica la app de cuentas en GitHub Pages (repositorio Carlosbabiano/coral-cuentas).
// Copia la carpeta cuentas/ a un clon temporal FUERA de Google Drive (los temporales de git dentro de Drive dan problemas),
// hace commit si hay cambios y sube. La primera vez crea el repositorio y activa Pages.
// Uso: node cuentas/publicar.js
const { execSync } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const REPO = 'Carlosbabiano/coral-cuentas';
const ORIGEN = __dirname;
const DESTINO = path.join(os.tmpdir(), 'coral-cuentas-publicar');
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const sh = (c, cwd = DESTINO) => execSync(c, { cwd, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const NO_PUBLICAR = new Set(['publicar.js', 'LEEME.md', '.gitignore', '.temp']);

let existe = true;
try { sh(`gh repo view ${REPO} --json name`, ORIGEN); } catch { existe = false; }

fs.rmSync(DESTINO, { recursive: true, force: true });
if (existe) sh(`git clone --depth 1 https://github.com/${REPO}.git "${DESTINO}"`, os.tmpdir());
else { fs.mkdirSync(DESTINO); sh('git init -b main'); }

// Sustituye todo menos .git por el contenido actual de cuentas/
for (const f of fs.readdirSync(DESTINO)) if (f !== '.git') fs.rmSync(path.join(DESTINO, f), { recursive: true, force: true });
const copiar = (de, a) => {
  for (const f of fs.readdirSync(de)) {
    if ((de === ORIGEN || f === '.temp') && NO_PUBLICAR.has(f)) continue;
    const o = path.join(de, f), d = path.join(a, f);
    if (fs.statSync(o).isDirectory()) { fs.mkdirSync(d, { recursive: true }); copiar(o, d); } else fs.copyFileSync(o, d);
  }
};
copiar(ORIGEN, DESTINO);
fs.writeFileSync(path.join(DESTINO, '.nojekyll'), '');

sh('git add -A');
let hayCambios = true;
try { sh('git diff --cached --quiet'); hayCambios = false; } catch {}
if (!hayCambios) { console.log('No hay cambios que publicar.'); process.exit(0); }
sh('git commit -m "Publicar la app de cuentas"');

if (!existe) {
  console.log(`Creando el repositorio ${REPO}...`);
  sh(`gh repo create ${REPO} --public --source . --remote origin --push --description "Contabilidad de la Coral Villa de Mengíbar (los datos están en Supabase, no aquí)"`);
  try { sh(`gh api -X POST repos/${REPO}/pages -f build_type=legacy -f "source[branch]=main" -f "source[path]=/"`); } catch {}
} else {
  sh('git push origin main');
}
fs.rmSync(DESTINO, { recursive: true, force: true });
console.log(`\nPublicada. Estará disponible en 1-2 minutos en:\n\n   https://${REPO.split('/')[0].toLowerCase()}.github.io/${REPO.split('/')[1]}/\n`);
