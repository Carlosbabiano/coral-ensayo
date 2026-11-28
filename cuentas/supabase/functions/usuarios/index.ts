// Gestión de usuarios de la contabilidad (necesita permisos de servidor, por eso no va en la app).
// Acciones:
//   estado          → { hayAdmin }                     (sin sesión: la pantalla de acceso lo usa)
//   primer-admin    → crea el primer administrador     (solo mientras no exista ninguno)
//   crear           → { email, nombre, rol, password } (solo admin)
//   cambiar         → { id, nombre?, rol?, activo? }   (solo admin)
//   restablecer     → { id, password }                 (solo admin)
// No se envían correos: el admin da de alta a cada persona con una contraseña provisional.
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const ROLES = ['admin', 'tesorero', 'junta'];

const respuesta = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const fallo = (mensaje: string, status = 400) => respuesta({ error: mensaje }, status);

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function hayAdmin() {
  const { count } = await admin.from('perfiles').select('id', { count: 'exact', head: true })
    .eq('rol', 'admin').eq('activo', true);
  return (count ?? 0) > 0;
}

async function quienLlama(req: Request) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  if (!data?.user) return null;
  const { data: perfil } = await admin.from('perfiles').select('*').eq('id', data.user.id).eq('activo', true).maybeSingle();
  return perfil;
}

function validarAlta(b: Record<string, unknown>) {
  const email = String(b.email || '').trim().toLowerCase();
  const nombre = String(b.nombre || '').trim();
  const password = String(b.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'El correo no parece válido.' };
  if (!nombre) return { error: 'Falta el nombre.' };
  if (password.length < 8) return { error: 'La contraseña debe tener al menos 8 caracteres.' };
  return { email, nombre, password };
}

async function crearUsuario(email: string, nombre: string, password: string, rol: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { nombre } });
  if (error) {
    if (/already|registered|exists/i.test(error.message)) return { error: 'Ya hay un usuario con ese correo.' };
    return { error: 'No se pudo crear el usuario: ' + error.message };
  }
  const { error: e2 } = await admin.from('perfiles').insert({ id: data.user.id, email, nombre, rol });
  if (e2) { await admin.auth.admin.deleteUser(data.user.id); return { error: 'No se pudo guardar el perfil.' }; }
  return { id: data.user.id };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fallo('Método no permitido', 405);
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { return fallo('Petición no válida'); }

  try {
    if (b.accion === 'estado') return respuesta({ hayAdmin: await hayAdmin() });

    if (b.accion === 'primer-admin') {
      if (await hayAdmin()) return fallo('Ya hay un administrador. Pídele que te dé de alta.', 403);
      const v = validarAlta(b);
      if ('error' in v) return fallo(v.error!);
      const r = await crearUsuario(v.email!, v.nombre!, v.password!, 'admin');
      return 'error' in r ? fallo(r.error!) : respuesta(r);
    }

    const yo = await quienLlama(req);
    if (!yo || yo.rol !== 'admin') return fallo('Solo el administrador puede gestionar usuarios.', 403);

    if (b.accion === 'crear') {
      const v = validarAlta(b);
      if ('error' in v) return fallo(v.error!);
      const rol = String(b.rol || '');
      if (!ROLES.includes(rol)) return fallo('Rol no válido.');
      const r = await crearUsuario(v.email!, v.nombre!, v.password!, rol);
      return 'error' in r ? fallo(r.error!) : respuesta(r);
    }

    if (b.accion === 'cambiar') {
      const id = String(b.id || '');
      const cambios: Record<string, unknown> = {};
      if (typeof b.nombre === 'string' && b.nombre.trim()) cambios.nombre = b.nombre.trim();
      if (typeof b.rol === 'string') { if (!ROLES.includes(b.rol)) return fallo('Rol no válido.'); cambios.rol = b.rol; }
      if (typeof b.activo === 'boolean') cambios.activo = b.activo;
      if (id === yo.id && (cambios.activo === false || (cambios.rol && cambios.rol !== 'admin'))) {
        return fallo('No puedes quitarte a ti mismo el acceso de administrador.');
      }
      const { error } = await admin.from('perfiles').update(cambios).eq('id', id);
      if (error) return fallo('No se pudo guardar el cambio.');
      // Al desactivar no hace falta cerrar su sesión: las reglas de la base de datos ya le niegan todo
      return respuesta({ ok: true });
    }

    if (b.accion === 'restablecer') {
      const password = String(b.password || '');
      if (password.length < 8) return fallo('La contraseña debe tener al menos 8 caracteres.');
      const { error } = await admin.auth.admin.updateUserById(String(b.id || ''), { password });
      if (error) return fallo('No se pudo cambiar la contraseña.');
      return respuesta({ ok: true });
    }

    return fallo('Acción desconocida.');
  } catch (e) {
    console.error(e);
    return fallo('Error inesperado en el servidor.', 500);
  }
});
