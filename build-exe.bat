@echo off
echo Compilando LoL-Remote.exe standalone...
"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /r:System.dll /r:System.Web.Extensions.dll /out:"LoL-Remote.exe" "standalone\LoLRemote.cs"
echo [OK] LoL-Remote.exe compilado con exito (tamano: 26 KB).
pause
