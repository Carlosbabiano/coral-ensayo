@echo off
chcp 65001 >nul
cd /d "%~dp0"
if "%~1"=="" (
  echo Arrastra uno o varios archivos .xml del Escaner Musical sobre este icono.
  pause
  exit /b
)
node "herramientas/anadir-obra.js" %*
echo.
pause
