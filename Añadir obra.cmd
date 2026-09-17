@echo off
chcp 65001 >nul
cd /d "%~dp0"
if "%~1"=="" (
  echo Arrastra sobre este icono el .xml del Escaner Musical y el .pdf de la obra (juntos).
  pause
  exit /b
)
node "herramientas/anadir-obra.js" %*
echo.
pause
