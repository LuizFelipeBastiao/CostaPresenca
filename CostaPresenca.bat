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
rem    (o pacote qrcode entrou depois: quem ja tinha node_modules precisa reinstalar)
set "PRECISA_INSTALAR=0"
if not exist "node_modules" set "PRECISA_INSTALAR=1"
if not exist "node_modules\qrcode" set "PRECISA_INSTALAR=1"
if "%PRECISA_INSTALAR%"=="1" (
    echo [SETUP] Instalando dependencias ^(npm install^)...
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
if /i "%MODO%"=="--bot" goto :BOT
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

findstr /r /c:"\"enabled\": *true" "config\local.json" >nul 2>&1
if errorlevel 1 (
    echo [1/5] Nenhum relatorio generico habilitado em config\local.json. Pulando.
) else (
    echo [1/5] Coleta de todos os relatorios habilitados do Power BI...
    call npm run collect:all
    if errorlevel 1 echo [AVISO] Falha na coleta de relatorios. Prosseguindo com os dados locais...
)

echo.
findstr /c:"aprendizagem-parana" "config\local.json" >nul 2>&1
if errorlevel 1 (
    echo [2/5] Relatorio Aprendizagem Parana nao configurado em config\local.json. Pulando o Pre-Conselho.
) else (
    echo [2/5] Extracao analitica do Pre-Conselho...
    call npm run collect:pre-conselho
    if errorlevel 1 echo [AVISO] Falha na extracao do Pre-Conselho. Prosseguindo...
)

echo.
echo [3/5] Extracao nominal de presenca e faltas...
call npm run collect:presente-alunos
if errorlevel 1 (
    echo [AVISO] Falha na extracao de presenca nominal. Prosseguindo com os dados anteriores...
    echo         Se o Power BI pediu login, de dois cliques em "Entrar no Power BI.bat" e depois rode de novo.
)
goto :APOS_POWERBI

:PULAR_POWERBI
echo [1-3/5] Coleta do Power BI ignorada ^(config\local.json ou login institucional ainda nao configurados^).
echo         Usando os arquivos CSV locais ja existentes em data\.
echo         Para ativar a coleta automatica, configure config\local.json e de dois cliques em "Entrar no Power BI.bat".

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
call :LIGAR_BOT
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

:LIGAR_BOT
rem Liga o bot de cadastro e o tunel ngrok em janelas minimizadas, se estiverem
rem configurados e ainda nao estiverem rodando. Assim ninguem precisa digitar comandos.
findstr /r /c:"^WHATSAPP_APP_SECRET=[0-9a-zA-Z]" ".env" >nul 2>&1
if errorlevel 1 (
    echo [BOT] Bot do WhatsApp nao configurado ^(WHATSAPP_APP_SECRET vazio no .env^). Pulando.
    exit /b 0
)
netstat -ano | findstr /r /c:":3001 .*LISTENING" >nul 2>&1
if errorlevel 1 (
    echo [BOT] Ligando o bot do WhatsApp ^(janela minimizada "CostaPresenca - Bot WhatsApp"^)...
    start "CostaPresenca - Bot WhatsApp" /min cmd /k "npm run bot"
) else (
    echo [BOT] O bot do WhatsApp ja esta ligado.
)
set "NGROK_EXE="
if exist "%~dp0ngrok.exe" set "NGROK_EXE=%~dp0ngrok.exe"
if not defined NGROK_EXE for /f "delims=" %%N in ('where ngrok 2^>nul') do if not defined NGROK_EXE set "NGROK_EXE=%%N"
if not defined NGROK_EXE (
    echo [AVISO] ngrok nao encontrado: sem ele as mensagens dos pais nao chegam ao bot.
    echo         Coloque o ngrok.exe na pasta do CostaPresenca.
    exit /b 0
)
tasklist /fi "imagename eq ngrok.exe" 2>nul | find /i "ngrok.exe" >nul
if errorlevel 1 (
    echo [BOT] Ligando o tunel ngrok ^(janela minimizada "CostaPresenca - Tunel ngrok"^)...
    start "CostaPresenca - Tunel ngrok" /min "%NGROK_EXE%" http 3001
) else (
    echo [BOT] O tunel ngrok ja esta ligado.
)
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

:BOT
echo [BOT] Iniciando o bot de cadastro dos pais pelo WhatsApp ^(porta 3001^).
echo [BOT] O tunel ^(cloudflared/ngrok^) precisa estar apontando para http://localhost:3001
echo [BOT] Deixe esta janela aberta. Para parar: Ctrl+C.
echo.
call npm run bot
set "RC_BOT=%errorlevel%"
pause
exit /b %RC_BOT%

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
echo   --painel              Abre direto o Painel Web ^(http://localhost:3000^) e liga o bot
echo   --coleta              Roda somente coleta + consolidacao + previa ^(sem abrir painel^)
echo   --agendar [HH:MM]     Agenda a coleta diaria no Windows ^(padrao: 17:30^)
echo   --login               Abre o Edge para login institucional/MFA no Power BI
echo   --diagnostico         Confere credenciais, numero e template da WhatsApp Cloud API
echo   --bot                 Liga o bot que cadastra os pais pelo WhatsApp ^(porta 3001^)
echo   --ajuda               Mostra esta ajuda
echo.
exit /b 0
