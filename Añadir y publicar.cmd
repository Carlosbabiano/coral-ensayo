@echo off
chcp 65001 >nul
cd /d "%~dp0"
if "%~1"=="" (
  echo Arrastra sobre este icono el .xml del Escaner Musical y el .pdf de la obra (juntos).
  echo Se anadiran a la app y se publicaran para todo el coro.
  pause
  exit /b
)
node "herramientas/anadir-obra.js" %*
if errorlevel 1 (
  echo.
  echo No se ha anadido ninguna obra, asi que no se publica nada.
  pause
  exit /b
)
echo.
echo ---- Publicando para el coro... ----
node "herramientas/publicar.js"
echo.
pause
