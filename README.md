# Coral Villa de Mengíbar · Ensayo por voces

Aplicación web para ensayar: muestra la partitura (o la página original del PDF) y reproduce la voz
elegida (Soprano, Contralto, Tenor o Bajo) destacada sobre las demás, con la marca del compás
sincronizada, control de tempo y repetición de compases. Se instala en el móvil y funciona sin conexión.

Publicada en: https://carlosbabiano.github.io/coral-ensayo/

## Carpetas
- `app/` — la aplicación (lo que se publica en GitHub Pages).
- `app/partituras/` — obras: MusicXML (`.xml`), PDF original (`.pdf`), posiciones de compases (`.pos.json`) e índice `lista.json`.
- `pdf/` — PDF originales de las obras.
- `herramientas/` — scripts (Node): `anadir-obra.js`, `letra.js`, `posiciones.js`, `publicar.js`.
- `guia/` — guía para corregir notas en MuseScore.

## Añadir una obra
1. Exportar el MusicXML (`.xml`, sin comprimir) desde Escáner Musical.
2. Arrastrar el `.xml` **y el `.pdf`** de la obra sobre `Añadir y publicar.cmd` (si el PDF tiene el mismo
   nombre y está en `pdf/` o junto al XML, se encuentra solo).
3. El programa: nombra las voces, revisa los compases, lee el PDF con Audiveris para sacar la letra y la
   posición de cada compás en la página, lo mete todo en la app y publica.

Requisitos en el PC: Node, MuseScore 4 (opcional, para corregir), Audiveris 5 con los idiomas de
Tesseract (eng, spa, ita, fra, lat) en `%APPDATA%\AudiverisLtd\audiveris\config\tessdata`.
Para obras en otro idioma: `set LETRA_IDIOMA=ita+eng` antes de ejecutar (por defecto `spa+eng`).
