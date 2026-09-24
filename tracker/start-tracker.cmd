@echo off
rem Starts the Preston Mazda Customer Enquiry Log. Keep this window open while it runs.
cd /d "%~dp0"
set NODE=
if exist "%~dp0node\node.exe" set NODE=%~dp0node\node.exe
if not defined NODE if exist "%~dp0..\node\node.exe" set NODE=%~dp0..\node\node.exe
rem Also accept the official portable download unzipped as-is (node-v22.x.x-win-x64) next to this folder.
if not defined NODE for /d %%d in ("%~dp0..\node-v*-win-x64" "%~dp0node-v*-win-x64") do if not defined NODE if exist "%%~d\node.exe" set NODE=%%~d\node.exe
if not defined NODE for %%i in (node.exe) do if not "%%~$PATH:i"=="" set NODE=%%~$PATH:i
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set NODE=%ProgramFiles%\nodejs\node.exe
if not defined NODE if exist "%LocalAppData%\Programs\nodejs\node.exe" set NODE=%LocalAppData%\Programs\nodejs\node.exe
if not defined NODE (
  echo Node.js was not found. (start-tracker.cmd v2)
  echo Looked in: %~dp0node, the folder above this one, and any node-v*-win-x64 folder there.
  echo Download the "Windows Binary (.zip)" from https://nodejs.org/en/download and
  echo unzip it next to this "tracker" folder (a folder like node-v22.22.2-win-x64),
  echo or install Node.js LTS from the same page, then run this again.
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
