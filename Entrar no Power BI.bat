@echo off
rem Abre o Edge para entrar na conta institucional (com MFA) do Power BI.
rem Use quando a atualizacao dos dados avisar que a sessao expirou.
cd /d "%~dp0"
call "%~dp0CostaPresenca.bat" --login
