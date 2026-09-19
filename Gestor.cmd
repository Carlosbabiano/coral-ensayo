@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Gestor de obras - Coral Villa de Mengibar
echo Arrancando el Gestor de obras... se abrira en el navegador.
echo Deja esta ventana abierta mientras lo uses; cierrala para parar.
echo.
node "herramientas/gestor.js"
pause
