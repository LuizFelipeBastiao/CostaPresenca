@echo off
setlocal
cd /d "%~dp0"
title Agendador Automatico - CostaPresenca

echo ============================================================
echo   CONFIGURADOR DE AGENDAMENTO DIARIO - COSTA PRESENCA
echo ============================================================
echo.
echo Este utilitario cria uma tarefa agendada no Windows para executar
echo a esteira de dados (coleta, analise e previa de faltas) diariamente.
echo.

set TASK_NAME=CostaPresenca_ColetaDiaria
set SCRIPT_PATH=%~dp0executar_coleta.bat
set HORARIO=17:30

echo Horario padrao sugerido: %HORARIO% (fim do turno da tarde)
echo Para alterar, digite o novo horario no formato HH:MM (ou pressione ENTER para 17:30):
set /p HORARIO_INPUT=Horario [%HORARIO%]: 

if not "%HORARIO_INPUT%"=="" set HORARIO=%HORARIO_INPUT%

echo.
echo Criando a tarefa agendada "%TASK_NAME%" para as %HORARIO% todos os dias...
schtasks /create /tn "%TASK_NAME%" /tr "\"%SCRIPT_PATH%\"" /sc daily /st %HORARIO% /f

if %errorlevel% equ 0 (
    echo.
    echo ============================================================
    echo [SUCESSO] Tarefa agendada configurada com exito!
    echo O Windows executara a esteira todos os dias as %HORARIO%.
    echo ============================================================
) else (
    echo.
    echo [AVISO] Nao foi possivel criar a tarefa diretamente.
    echo Dica: Execute este arquivo clicando com o botao direito e escolhendo
    echo "Executar como Administrador".
)

echo.
pause
