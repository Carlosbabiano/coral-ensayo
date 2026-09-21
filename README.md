# Coral Villa de Mengíbar · Ensayo por voces

Aplicación web para ensayar: muestra la partitura (o la página original del PDF) y reproduce la voz
elegida (Soprano, Contralto, Tenor o Bajo) destacada sobre las demás, con la marca del compás
sincronizada, control de tempo y repetición de compases. Se instala en el móvil y funciona sin conexión.

Publicada en: https://carlosbabiano.github.io/coral-ensayo/

## Carpetas
- `app/` — la aplicación (lo que se publica en GitHub Pages).
- `app/partituras/` — obras: MusicXML (`.xml`), PDF original (`.pdf`), posiciones de compases (`.pos.json`) e índice `lista.json`.
- `pdf/` — PDF originales de las obras.
- `herramientas/` — scripts (Node): `gestor.js` (+ `gestor/index.html`), `obra.js`, `anadir-obra.js`, `letra.js`, `posiciones.js`, `paginas.js`, `publicar.js`.
- `borradores/` — obras en preparación en el gestor (no se publican).
- `Entrada/` — buzón: lo que se deje aquí (p. ej. desde el móvil vía Google Drive) aparece en el gestor para cargarlo.
- `guia/` — guía para corregir notas en MuseScore.

## Añadir una obra (con previsualización): Gestor.cmd
1. Exportar el MusicXML (`.xml`, sin comprimir) desde Escáner Musical.
2. Abrir `Gestor.cmd`: arranca un servidor local y abre el gestor en el navegador (http://localhost:5180).
3. Arrastrar el `.xml` **y el `.pdf`** de la obra a la zona de la página (o elegirlos con un clic). O, desde el
   móvil, compartirlos a Google Drive en la carpeta `Entrada/` del proyecto: el gestor los muestra con un botón
   «Cargar» por obra (si el XML no trae PDF, busca uno con el mismo nombre en `pdf/`).
4. El gestor prepara la obra (nombra las voces, revisa los compases, lee el PDF con Audiveris para la letra y
   la posición de cada compás) y la muestra en el mismo reproductor que usa el coro. Ahí se pueden cambiar el
   título, el nombre de cada voz, el tempo y quitar voces (por ejemplo el piano), y saltar a los compases dudosos.
5. «Publicar para el coro» la mete en la app, sube la versión de la caché, la guarda en git y la publica.
   «Retirar» quita una obra publicada. Los borradores viven en `borradores/` hasta que se publican o descartan.

La lectura de cada PDF con Audiveris se guarda en `herramientas/cache/`, así que repetir una obra es instantáneo.

## Modo corregir (para el director)
Abrir la app con `?corregir=1` al final de la dirección (https://carlosbabiano.github.io/coral-ensayo/?corregir=1).
Tocar una nota la selecciona y suena; con la barra (o el teclado en el PC) se sube o baja, se cambia la figura, el puntillo,
la alteración o la ligadura, se borra o se añade otra detrás. Los cambios se guardan en el navegador hasta pulsar
«Enviar corrección», que comparte el XML corregido (Google Drive → carpeta `Entrada/`, WhatsApp, correo…). En el gestor,
«Cargar» esa corrección la prepara conservando su letra; se revisa y se publica. La lógica de compases está en
`app/compases.js`, compartida entre el gestor (Node) y la app (navegador).

## Añadir una obra sin previsualizar (el método antiguo)
Arrastrar el `.xml` y el `.pdf` sobre `Añadir y publicar.cmd` (o `Añadir obra.cmd` y después `Publicar.cmd`).

Requisitos en el PC: Node, MuseScore 4 (opcional, para corregir), Audiveris 5 con los idiomas de
Tesseract (eng, spa, ita, fra, lat) en `%APPDATA%\AudiverisLtd\audiveris\config\tessdata`.
Para obras en otro idioma: `set LETRA_IDIOMA=ita+eng` antes de ejecutar (por defecto `spa+eng`).
