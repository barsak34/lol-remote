@echo off
title LoL Remote - Agente Local
echo ========================================================
echo              Iniciando LoL Remote Agent                 
echo ========================================================
cd /d "%~dp0"

REM Verificar dependencias necesarias
if not exist "local-agent\node_modules\@supabase" (
    if not exist "web-app\node_modules\@supabase" (
        echo [LoL Remote] Instalando dependencias por primera vez...
        cd local-agent
        call npm install
        cd ..
    )
)

node local-agent\agent.mjs %*
pause
