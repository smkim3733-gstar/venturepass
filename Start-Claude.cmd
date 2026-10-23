@echo off
cd /d "%~dp0"
if exist "%USERPROFILE%\.local\bin\claude.exe" (
  "%USERPROFILE%\.local\bin\claude.exe"
) else (
  where claude >nul 2>nul
  if errorlevel 1 (
    echo Install Claude Code first: https://code.claude.com/docs/en/setup
    pause
    exit /b 1
  )
  call claude
)
