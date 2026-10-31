# Coral Villa de Mengíbar · Ensayo por voces

Aplicación web para ensayar: muestra la página original del PDF (la partitura dibujada a partir del MusicXML queda
para el gestor y el modo corregir) y reproduce la voz
elegida (Soprano, Contralto, Tenor o Bajo) destacada sobre las demás, con la marca del compás
sincronizada, control de tempo y repetición de compases. Se instala en el móvil y funciona sin conexión.

Publicada en: https://carlosbabiano.github.io/coral-ensayo/

## Carpetas
- `app/` — la aplicación (lo que se publica en GitHub Pages).
- `app/partituras/` — obras: MusicXML (`.xml`), PDF original (`.pdf`), posiciones de compases (`.pos.json`) e índice `lista.json`.
- `originales/` — material de partida de cada obra: `pdf/` (el PDF original; el gestor guarda ahí una copia al publicar)
  y `xml/` (el MusicXML tal como salió del Escáner Musical). Ahí está también el logo de la coral.
- `herramientas/` — scripts (Node): `gestor.js` (+ `gestor/index.html`), `obra.js`, `anadir-obra.js`, `letra.js`, `posiciones.js`, `paginas.js`, `publicar.js`.
- `borradores/` — obras en preparación en el gestor (no se publican).
- `Entrada/` — buzón: lo que se deje aquí (p. ej. desde el móvil vía Google Drive) aparece en el gestor para cargarlo.
  En `Entrada/pendientes/` esperan los PDF de obras todavía sin XML del escáner.
- `guia/` — guía para corregir notas en MuseScore.
- `archivo/` — cosas viejas fuera de git (pruebas de voz, salidas antiguas, copias repetidas); se puede vaciar sin miedo.

## Añadir una obra (con previsualización): Gestor.cmd
1. Exportar el MusicXML (`.xml`, sin comprimir) desde Escáner Musical.
2. Abrir `Gestor.cmd`: arranca un servidor local y abre el gestor en el navegador (http://localhost:5180).
3. Arrastrar el `.xml` **y el `.pdf`** de la obra a la zona de la página (o elegirlos con un clic). O, desde el
   móvil, compartirlos a Google Drive en la carpeta `Entrada/` del proyecto: el gestor los muestra con un botón
   «Cargar» por obra (si el XML no trae PDF, busca uno con el mismo nombre en `originales/pdf/`).
4. El gestor prepara la obra (nombra las voces, separa en dos voces las partes de dos pentagramas sin acordes —tenor y bajo
   escritos juntos, por ejemplo— y quita las que llevan acordes —el piano—, revisa los compases, convierte las páginas
   del PDF en imágenes y localiza en ellas cada compás) y la muestra en el mismo reproductor que usa el coro. La letra
   no se saca del PDF: el coro la lee en la página. Audiveris solo se usa como último recurso para situar los compases. Ahí se pueden cambiar el
   título, el nombre de cada voz, el tempo y quitar voces (por ejemplo el piano), y saltar a los compases dudosos.
5. «Publicar para el coro» la mete en la app, sube la versión de la caché, la guarda en git y la publica.
   «Retirar» quita una obra publicada. «En ensayo» marca una obra que se está ensayando: en la app sale la primera,
   en el grupo «En ensayo» del desplegable (y con ★); «Quitar de ensayo» la devuelve al repertorio. El borrador también
   lleva la casilla «En ensayo» para dejarla marcada al publicar. Los borradores viven en `borradores/` hasta que se publican o descartan.

Si alguna vez hace falta Audiveris, su lectura se guarda en `herramientas/cache/` para no repetirla.

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
