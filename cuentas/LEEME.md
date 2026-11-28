# Cuentas de la coral

App de contabilidad de la Coral Villa de Mengíbar: libro de ingresos y gastos, justificantes, tesorería (caja y bancos), presupuestos, facturas, recibos firmados, subvenciones y memoria económica anual.

**Modo de pruebas** hasta el 1 de enero: el administrador puede borrar todos los datos de prueba desde Ajustes; «Empezar de verdad» lo desactiva para siempre.

- **Dirección:** https://carlosbabiano.github.io/coral-cuentas/
- **Datos:** Supabase, organización gratuita «Coral Villa de Mengíbar», proyecto `bwemeufrpgilidcqdayj` (Fráncfort).
- **Permisos:** administrador (todo, también usuarios), tesorero (apunta y corrige) y junta (solo consulta). Lo garantizan las reglas de la base de datos, no solo la app.
- **Nada se borra:** los apuntes se anulan, y todo cambio queda en el historial.

## Archivos

- `index.html`, `estilos.css`, `app.js`, `config.js`: la app (sin compilar, se publica tal cual).
- `supabase/001_base.sql`: tablas, permisos y almacén de justificantes.
- `supabase/002_facturas.sql`: clientes, presupuestos, facturas y rectificativas (numeración, cobro, bloqueo de facturas emitidas).
- `supabase/003_modo_pruebas.sql`: borrado de datos de prueba y paso a uso real.
- `supabase/006_presupuesto_anual.sql`: presupuesto por categorías para el año siguiente (sale en la memoria y, al año siguiente, su cumplimiento).
- `supabase/005_subvenciones.sql`: subvenciones (cobros enlazados, gastos justificados, documentos) y textos de la memoria anual.
- `supabase/004_recibos.sql`: recibos de pago y de cobro firmados en pantalla (se apuntan solos en el libro; no se modifican, se anulan).
- `supabase/functions/usuarios/`: alta de usuarios y contraseñas (necesita permisos de servidor).
- `.github/workflows/latido.yml`: cada 3 días llama a la base de datos para que el plan gratuito no se pause.
- `publicar.js`: publica la carpeta en GitHub Pages → `node cuentas/publicar.js`.

## Cambios en la base de datos

Con la herramienta de Supabase ya iniciada en este PC:

```
npx supabase db query --remote=bwemeufrpgilidcqdayj --file archivo.sql
npx supabase functions deploy usuarios --remote=bwemeufrpgilidcqdayj --no-verify-jwt --use-api
```
