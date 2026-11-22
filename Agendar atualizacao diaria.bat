@echo off
rem Cria (ou atualiza) a tarefa do Windows que coleta os dados do Power BI todo dia.
rem Basta rodar uma vez em cada computador.
cd /d "%~dp0"
call "%~dp0CostaPresenca.bat" --agendar
