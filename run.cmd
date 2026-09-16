@echo off
title Crosby VW Label Studio
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this computer.
  echo   Install the LTS version from https://nodejs.org  then double-click this file again.
  echo.
  pause
  exit /b 1
)

echo Starting the Label Studio... your browser will open in a moment.
node tools\serve.mjs
echo.
echo The Label Studio has stopped.
pause
