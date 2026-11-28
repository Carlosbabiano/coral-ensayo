# Cuentas de la coral

App de contabilidad de la Coral Villa de Mengíbar: libro de ingresos y gastos, justificantes y tesorería (caja y bancos).

- **Dirección:** https://carlosbabiano.github.io/coral-cuentas/
- **Datos:** Supabase, organización gratuita «Coral Villa de Mengíbar», proyecto `bwemeufrpgilidcqdayj` (Fráncfort).
- **Permisos:** administrador (todo, también usuarios), tesorero (apunta y corrige) y junta (solo consulta). Lo garantizan las reglas de la base de datos, no solo la app.
- **Nada se borra:** los apuntes se anulan, y todo cambio queda en el historial.

## Archivos

- `index.html`, `estilos.css`, `app.js`, `config.js`: la app (sin compilar, se publica tal cual).
- `supabase/001_base.sql`: tablas, permisos y almacén de justificantes.
- `supabase/functions/usuarios/`: alta de usuarios y contraseñas (necesita permisos de servidor).
- `.github/workflows/latido.yml`: cada 3 días llama a la base de datos para que el plan gratuito no se pause.
- `publicar.js`: publica la carpeta en GitHub Pages → `node cuentas/publicar.js`.

## Cambios en la base de datos

Con la herramienta de Supabase ya iniciada en este PC:

```
npx supabase db query --remote=bwemeufrpgilidcqdayj --file archivo.sql
npx supabase functions deploy usuarios --remote=bwemeufrpgilidcqdayj --no-verify-jwt --use-api
```
