@echo off
rem Starts the Preston Mazda Customer Enquiry Log. Keep this window open while it runs.
cd /d "%~dp0"
set NODE=
if exist "%~dp0node\node.exe" set NODE=%~dp0node\node.exe
if not defined NODE if exist "%~dp0..\node\node.exe" set NODE=%~dp0..\node\node.exe
if not defined NODE for %%i in (node.exe) do if not "%%~$PATH:i"=="" set NODE=%%~$PATH:i
if not defined NODE (
  echo Node.js was not found.
  echo Either keep the "node" folder from the download next to this "tracker" folder,
  echo or install Node.js LTS from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if not exist config.json (
  echo No config.json found - copy config.example.json to config.json and fill it in.
  echo Starting with the default settings for now...
  timeout /t 5 >nul
)
echo Using "%NODE%"
"%NODE%" server.js
pause
