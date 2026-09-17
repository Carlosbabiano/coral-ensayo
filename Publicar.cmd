@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Esto publica la app en internet (GitHub Pages) con tu cuenta de GitHub.
echo Si es la primera vez, creara un repositorio PUBLICO llamado coral-ensayo.
echo.
choice /c SN /m "Continuar (S/N)?"
if errorlevel 2 exit /b
node "herramientas/publicar.js" %*
echo.
pause
