@echo off
setlocal
cd /d "%~dp0"
title CostaPresenca - Sistema Escolar de Frequencia e Notificacoes

set "MODO=%~1"
set "ARG2=%~2"
set "MODO_COLETA_ONLY=0"

if /i "%MODO%"=="--ajuda" goto :AJUDA
if /i "%MODO%"=="-h" goto :AJUDA
if /i "%MODO%"=="/?" goto :AJUDA
if /i "%MODO%"=="--agendar" goto :AGENDAR

echo ============================================================
echo   COSTA PRESENCA - EXECUCAO UNIFICADA
echo ============================================================
echo.

rem 1. Verifica se o Node.js e o npm estao instalados
where node >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Node.js nao encontrado neste computador.
    echo Instale o Node.js 22 ou superior em https://nodejs.org e tente novamente.
    echo.
    pause
    exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
    echo [ERRO] npm nao encontrado neste computador.
    echo Reinstale o Node.js 22 ou superior em https://nodejs.org e tente novamente.
    echo.
    pause
    exit /b 1
)

rem 2. Preparacao automatica na primeira execucao
if not exist "node_modules" (
    echo [SETUP] Pasta node_modules nao encontrada. Instalando dependencias...
    call npm install
    if errorlevel 1 (
        echo [ERRO] Falha ao instalar dependencias com npm install.
        pause
        exit /b 1
    )
    echo.
)

if not exist "config\notificacoes.json" if exist "config\notificacoes.example.json" (
    echo [SETUP] Criando config\notificacoes.json a partir do modelo...
    copy /y "config\notificacoes.example.json" "config\notificacoes.json" >nul
)

if not exist "config\local.json" if exist "config\reports.example.json" (
    echo [SETUP] Criando config\local.json a partir do modelo...
    copy /y "config\reports.example.json" "config\local.json" >nul
)

if not exist ".env" if exist ".env.example" (
    echo [SETUP] Criando .env a partir do modelo...
    copy /y ".env.example" ".env" >nul
)

rem 3. Despacha modos especiais por argumento
if /i "%MODO%"=="--login" goto :LOGIN
if /i "%MODO%"=="--diagnostico" goto :DIAGNOSTICO
if /i "%MODO%"=="--painel" goto :ABRIR_PAINEL
if /i "%MODO%"=="--coleta" (
    set "MODO_COLETA_ONLY=1"
    goto :ESTEIRA
)
if not "%MODO%"=="" (
    echo [ERRO] Opcao desconhecida: %MODO%
    echo.
    call :MOSTRAR_AJUDA
    exit /b 1
)

rem ============================================================
rem   MODO PADRAO (duplo clique): EXECUTA TUDO DE UMA VEZ
rem   Coleta (se configurada) -> Consolidacao -> Previa -> Painel
rem ============================================================
:ESTEIRA
set "RODAR_POWERBI=0"
if exist "config\local.json" if exist ".auth\powerbi-profile" (
    findstr /c:"COLE-AQUI-A-URL-AUTORIZADA" "config\local.json" >nul 2>&1
    if errorlevel 1 set "RODAR_POWERBI=1"
)

if not "%RODAR_POWERBI%"=="1" goto :PULAR_POWERBI

echo [1/5] Coleta de todos os relatorios habilitados do Power BI...
call npm run collect:all
if errorlevel 1 echo [AVISO] Falha na coleta de relatorios. Prosseguindo com os dados locais...

echo.
echo [2/5] Extracao analitica do Pre-Conselho...
call npm run collect:pre-conselho
if errorlevel 1 echo [AVISO] Falha na extracao do Pre-Conselho. Prosseguindo...

echo.
echo [3/5] Extracao nominal de presenca e faltas...
call npm run collect:presente-alunos
if errorlevel 1 echo [AVISO] Falha na extracao de presenca nominal. Prosseguindo...
goto :APOS_POWERBI

:PULAR_POWERBI
echo [1-3/5] Coleta do Power BI ignorada ^(config\local.json ou login institucional ainda nao configurados^).
echo         Usando os arquivos CSV locais ja existentes em data\.
echo         Para ativar a coleta automatica, configure config\local.json e rode: CostaPresenca.bat --login

:APOS_POWERBI
echo.
echo [4/5] Gerando consolidacao executiva e Painel de Busca Ativa...
call npm run consolidate
if errorlevel 1 echo [AVISO] Falha na consolidacao dos dados. Prosseguindo...

echo.
echo [5/5] Gerando previa das notificacoes aos responsaveis ^(modo seguro, nao envia^)...
call npm run notificar
if errorlevel 1 echo [AVISO] Nao foi possivel gerar a previa agora ^(verifique se ha CSV de presenca em data\presente-alunos^).

if "%MODO_COLETA_ONLY%"=="1" (
    echo.
    echo ============================================================
    echo   ESTEIRA CONCLUIDA!
    echo ============================================================
    exit /b 0
)

:ABRIR_PAINEL
echo.
echo ============================================================
echo   INICIANDO PAINEL WEB DA SECRETARIA (http://localhost:3000)
echo ============================================================
echo.
echo O navegador sera aberto automaticamente em 2 segundos.
echo Mantenha esta janela aberta enquanto estiver usando o painel.
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"
call npm start

pause
exit /b 0

:LOGIN
echo [LOGIN] Abrindo o navegador para login institucional e MFA no Power BI...
call npm run login -- --config config/local.json
pause
exit /b %errorlevel%

:DIAGNOSTICO
echo [DIAGNOSTICO] Conferindo integracao com a WhatsApp Cloud API...
call npm run whatsapp:diagnostico
exit /b %errorlevel%

:AGENDAR
echo ============================================================
echo   CONFIGURADOR DE AGENDAMENTO DIARIO - COSTA PRESENCA
echo ============================================================
echo.
echo Cria uma tarefa agendada no Windows para rodar a coleta,
echo consolidacao e previa de faltas automaticamente todos os dias.
echo.

set "TASK_NAME=CostaPresenca_ColetaDiaria"
set "SCRIPT_PATH=%~dp0CostaPresenca.bat"
set "HORARIO=17:30"

if not "%ARG2%"=="" (
    set "HORARIO=%ARG2%"
    goto :AGENDAR_CRIAR
)

echo Horario padrao sugerido: 17:30 ^(fim do turno da tarde^)
echo Digite o horario no formato HH:MM ou pressione ENTER para 17:30:
set "HORARIO_INPUT="
set /p "HORARIO_INPUT=Horario [17:30]: "
if not "%HORARIO_INPUT%"=="" set "HORARIO=%HORARIO_INPUT%"

:AGENDAR_CRIAR

echo.
echo Criando tarefa agendada "%TASK_NAME%" para as %HORARIO% todos os dias...
schtasks /create /tn "%TASK_NAME%" /tr "\"%SCRIPT_PATH%\" --coleta" /sc daily /st %HORARIO% /f

if errorlevel 1 (
    echo.
    echo [AVISO] Nao foi possivel criar a tarefa diretamente.
    echo Dica: execute o Prompt como Administrador e rode: CostaPresenca.bat --agendar
    pause
    exit /b 1
)

echo.
echo ============================================================
echo [SUCESSO] Tarefa agendada configurada para as %HORARIO%!
echo ============================================================
echo.
pause
exit /b 0

:AJUDA
call :MOSTRAR_AJUDA
exit /b 0

:MOSTRAR_AJUDA
echo Uso: CostaPresenca.bat [opcao]
echo.
echo Sem opcoes ^(duplo clique^):
echo   Executa tudo de uma vez: prepara o ambiente, coleta dados do Power BI
echo   ^(se configurado^), consolida Busca Ativa, gera previa e abre o Painel Web.
echo.
echo Opcoes disponiveis:
echo   --painel              Abre direto o Painel Web ^(http://localhost:3000^)
echo   --coleta              Roda somente coleta + consolidacao + previa ^(sem abrir painel^)
echo   --agendar [HH:MM]     Agenda a coleta diaria no Windows ^(padrao: 17:30^)
echo   --login               Abre o Edge para login institucional/MFA no Power BI
echo   --diagnostico         Confere credenciais, numero e template da WhatsApp Cloud API
echo   --ajuda               Mostra esta ajuda
echo.
exit /b 0
