@echo off
title LoL Remote - Agente Local
echo ========================================================
echo               Iniciando LoL Remote Agent                
echo ========================================================
cd /d "%~dp0"
node local-agent\agent.mjs
pause
