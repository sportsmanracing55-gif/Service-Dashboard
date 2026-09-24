@echo off
rem Starts the Preston Mazda Customer Enquiry Tracker. Keep this window open.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Download the LTS version from https://nodejs.org and run this again. & pause & exit /b 1)
if not exist config.json (echo No config.json found - copy config.example.json to config.json and fill it in. Starting with defaults... & timeout /t 5 >nul)
node server.js
pause
