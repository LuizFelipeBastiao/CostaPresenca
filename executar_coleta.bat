@echo off
setlocal

cd /d "%~dp0"
echo ============================================================
echo   COLETOR BI ESCOLAR - EXECUCAO AUTOMATIZADA
echo ============================================================

echo.
echo [1/5] Coleta de todos os relatorios habilitados...
call npm run collect:all
if %errorlevel% neq 0 (
    echo [ERRO] Falha na coleta de relatorios.
    exit /b %errorlevel%
)

echo.
echo [2/5] Extracao analitica do Pre-Conselho...
call npm run collect:pre-conselho
if %errorlevel% neq 0 (
    echo [AVISO] Falha na extracao do Pre-Conselho. Prosseguindo...
)

echo.
echo [3/5] Extracao nominal de presenca e faltas...
call npm run collect:presente-alunos
if %errorlevel% neq 0 (
    echo [AVISO] Falha na extracao de presenca nominal. Prosseguindo...
)

echo.
echo [4/5] Gerando consolidacao executiva...
call npm run consolidate
if %errorlevel% neq 0 (
    echo [ERRO] Falha na consolidacao dos dados.
    exit /b %errorlevel%
)

echo.
echo [5/5] Previa das notificacoes aos responsaveis (nao envia)...
call npm run notificar
if %errorlevel% neq 0 (
    echo [AVISO] Falha ao gerar a previa de notificacoes.
)
rem Para enviar de verdade, troque "call npm run notificar" por:
rem call npm run notificar -- --execute

echo.
echo ============================================================
echo   COLETA E CONSOLIDACAO CONCLUIDAS COM SUCESSO!
echo ============================================================
