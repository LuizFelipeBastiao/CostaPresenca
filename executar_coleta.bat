@echo off
setlocal

cd /d "C:\Nestjs\TMP\SCRAPER"
echo ============================================================
echo   COLETOR BI ESCOLAR - EXECUCAO AUTOMATIZADA
echo ============================================================

echo.
echo [1/4] Coleta de todos os relatorios habilitados...
call npm run collect:all
if %errorlevel% neq 0 (
    echo [ERRO] Falha na coleta de relatorios.
    exit /b %errorlevel%
)

echo.
echo [2/4] Extracao analitica do Pre-Conselho...
call npm run collect:pre-conselho
if %errorlevel% neq 0 (
    echo [AVISO] Falha na extracao do Pre-Conselho. Prosseguindo...
)

echo.
echo [3/4] Extracao nominal de presenca e faltas...
call npm run collect:presente-alunos
if %errorlevel% neq 0 (
    echo [AVISO] Falha na extracao de presenca nominal. Prosseguindo...
)

echo.
echo [4/4] Gerando consolidacao executiva...
call npm run consolidate
if %errorlevel% neq 0 (
    echo [ERRO] Falha na consolidacao dos dados.
    exit /b %errorlevel%
)

echo.
echo ============================================================
echo   COLETA E CONSOLIDACAO CONCLUIDAS COM SUCESSO!
echo ============================================================
