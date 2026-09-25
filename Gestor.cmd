@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Gestor de obras - Coral Villa de Mengibar
echo Arrancando el Gestor de obras... se abrira en el navegador.
echo Deja esta ventana abierta mientras lo uses; cierrala para parar.
echo.
if not exist "node_modules\ffmpeg-static\ffmpeg.exe" (
  echo Instalando el conversor de audio y el motor del cantante ^(solo la primera vez, hace falta internet^)...
  call npm install --no-audit --no-fund --loglevel=error
  echo.
)
node "herramientas/gestor.js"
pause
