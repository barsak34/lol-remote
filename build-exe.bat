@echo off
echo Compilando LoL-Remote.exe standalone (Windows Tray App con Icono Hextech)...
"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll /target:winexe /win32icon:"standalone\app.ico" /out:"LoL-Remote.exe" "standalone\LoLRemote.cs"
echo [OK] LoL-Remote.exe compilado con exito.
pause
