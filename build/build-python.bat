@echo off
REM ── Build Python OCR Server for Rikai ──────────────────────────────
REM
REM This bundles ocr_server.py + manga-ocr + PyTorch into a directory
REM with a standalone executable that Electron can launch in production mode.
REM
REM Usage:
REM     build\build-python.bat
REM
REM Output: build\dist\ocr_server\ (ocr_server.exe + _internal/)

echo.
echo ========================================
echo  Rikai Python OCR Server - Build
echo ========================================
echo.

REM Find Python
where python >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo ERROR: Python not found in PATH
    exit /b 1
)

REM Find PyInstaller
python -c "import PyInstaller" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo Installing PyInstaller...
    pip install pyinstaller
)

echo Building ocr_server.exe...
echo This may take several minutes (PyTorch is large)...
echo.

python -m PyInstaller ^
    --name ocr_server ^
    --onedir ^
    --noconfirm ^
    --clean ^
    --hidden-import=manga_ocr ^
    --hidden-import=transformers ^
    --hidden-import=torch ^
    --hidden-import=PIL ^
    --hidden-import=fugashi ^
    --hidden-import=unidic_lite ^
    --hidden-import=safetensors ^
    --collect-all manga_ocr ^
    --collect-all transformers ^
    --collect-all torch ^
    --distpath build/dist ^
    --workpath build/build ^
    --specpath build ^
    server/ocr_server.py

if %ERRORLEVEL% neq 0 (
    echo.
    echo BUILD FAILED
    exit /b 1
)

echo.
echo ========================================
echo  Build complete!
echo  Output: build\dist\ocr_server\ocr_server.exe + _internal/
echo ========================================
echo.
