@echo off
setlocal
cd /d "%~dp0"
title CostaPresenca - Painel de Frequencia Escolar

echo ============================================================
echo   COSTA PRESENCA - PAINEL DA SECRETARIA E GESTAO ESCOLAR
echo ============================================================
echo.
echo [1/2] Iniciando o servidor local...

rem Abre o navegador padrao no painel apos 2 segundos
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

rem Inicia o servidor Node.js
call npm start

pause
