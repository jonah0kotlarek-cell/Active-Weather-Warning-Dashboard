@echo off
cd /d "%~dp0"
echo ============================================
echo  GR Active Warnings - Build Script
echo ============================================
echo.

:: Check Node is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo ERROR: Node.js not found. Download from https://nodejs.org
  pause
  exit /b 1
)

echo [1/3] Installing dependencies...
call npm install
if %errorlevel% neq 0 (
  echo ERROR: npm install failed.
  pause
  exit /b 1
)

echo.
echo [2/3] Building EXE (this may take 1-2 minutes)...
call npm run build
if %errorlevel% neq 0 (
  echo ERROR: Build failed.
  pause
  exit /b 1
)

echo.
echo [3/3] Done!
echo.
echo Your files are in the "dist" folder:
echo   - GR Active Warnings Setup.exe   (installer)
echo   - GR Active Warnings.exe         (portable, no install needed)
echo.
pause
