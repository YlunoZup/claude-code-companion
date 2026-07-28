@echo off
setlocal enabledelayedexpansion

:: claude-multi-account installer for Windows CMD

echo.
echo   claude-multi-account installer
echo   --------------------------------
echo.

:: ── Check prerequisites ─────────────────────────────────────
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo   [ERR] Node.js is required but not found. Install from https://nodejs.org
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo   [ OK] Node.js found: %%v

where claude >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo   [WARN] Claude Code CLI not found in PATH. Make sure it's installed.
) else (
    echo   [ OK] Claude Code CLI found
)

:: ── Set paths ───────────────────────────────────────────────
set "PROFILES_DIR=%USERPROFILE%\.claude-profiles"
set "ACCOUNT2_DIR=%PROFILES_DIR%\account2"
set "CLAUDE_DIR=%USERPROFILE%\.claude"
set "SCRIPT_DIR=%~dp0"

:: ── Create directories ──────────────────────────────────────
echo.
echo   [INFO] Creating profile directories...
if not exist "%PROFILES_DIR%" mkdir "%PROFILES_DIR%"
if not exist "%ACCOUNT2_DIR%" mkdir "%ACCOUNT2_DIR%"
echo   [ OK] Created %PROFILES_DIR%
echo   [ OK] Created %ACCOUNT2_DIR%

:: ── Copy picker.mjs ─────────────────────────────────────────
echo   [INFO] Installing picker...
copy /Y "%SCRIPT_DIR%src\picker.mjs" "%PROFILES_DIR%\picker.mjs" >nul
echo   [ OK] Installed picker.mjs

:: ── Copy config (if not exists) ─────────────────────────────
if not exist "%PROFILES_DIR%\config.json" (
    copy /Y "%SCRIPT_DIR%config.example.json" "%PROFILES_DIR%\config.json" >nul
    echo   [ OK] Created config.json from template
) else (
    echo   [ OK] config.json already exists, skipping
)

:: ── Install statusline ────────────────────────────────────────
echo   [INFO] Installing statusline...
copy /Y "%SCRIPT_DIR%src\statusline.js" "%PROFILES_DIR%\statusline.js" >nul
echo   [ OK] Installed statusline.js

if not exist "%PROFILES_DIR%\claude-powerline.json" (
    copy /Y "%SCRIPT_DIR%config\claude-powerline.json" "%PROFILES_DIR%\claude-powerline.json" >nul
    echo   [ OK] Installed claude-powerline.json
) else (
    echo   [ OK] claude-powerline.json already exists, skipping
)

:: Check for claude-powerline
where claude-powerline >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo   [WARN] claude-powerline not found. Install it for statusline segments:
    echo     npm install -g claude-powerline
    echo.
) else (
    echo   [ OK] claude-powerline found
)

:: ── Configure statusline in settings.json ──────────────────────
echo   [INFO] Configuring statusline in Claude Code settings...

if exist "%CLAUDE_DIR%\settings.json" (
    node -e "var fs=require('fs'),p=process.argv[1],s={};try{s=JSON.parse(fs.readFileSync(p,'utf8'))}catch(e){}var h=require('os').homedir().replace(/\\/g,'/');s.statusLine={type:'command',command:'node '+h+'/.claude-profiles/statusline.js'};fs.writeFileSync(p,JSON.stringify(s,null,2)+'\n')" "%CLAUDE_DIR%\settings.json"
    echo   [ OK] Configured statusline in settings.json
)

if exist "%ACCOUNT2_DIR%\settings.json" (
    node -e "var fs=require('fs'),p=process.argv[1],s={};try{s=JSON.parse(fs.readFileSync(p,'utf8'))}catch(e){}var h=require('os').homedir().replace(/\\/g,'/');s.statusLine={type:'command',command:'node '+h+'/.claude-profiles/statusline.js'};fs.writeFileSync(p,JSON.stringify(s,null,2)+'\n')" "%ACCOUNT2_DIR%\settings.json"
    echo   [ OK] Configured statusline in account2/settings.json
)

:: ── Set up shared data (junctions from account2 -> .claude) ─
echo   [INFO] Setting up shared data for Account 2...

:: Share directories via junctions
for %%d in (projects todos statsig .statsig) do (
    if exist "%CLAUDE_DIR%\%%d" (
        if not exist "%ACCOUNT2_DIR%\%%d" (
            mklink /J "%ACCOUNT2_DIR%\%%d" "%CLAUDE_DIR%\%%d" >nul 2>nul
            if !ERRORLEVEL! equ 0 (
                echo   [ OK] Junction: %%d
            ) else (
                echo   [WARN] Could not create junction for %%d
            )
        )
    )
)

:: Ensure account2 has its own settings.json (not shared, for statusline)
if not exist "%ACCOUNT2_DIR%\settings.json" (
    echo {} > "%ACCOUNT2_DIR%\settings.json"
)

:: ── Install launcher script ─────────────────────────────────
echo   [INFO] Installing launcher script...

set "BIN_DIR=%USERPROFILE%\.local\bin"
if not "%~1"=="" set "BIN_DIR=%~1"

if not exist "%BIN_DIR%" mkdir "%BIN_DIR%"

copy /Y "%SCRIPT_DIR%bin\ccc.bat" "%BIN_DIR%\ccc.bat" >nul
echo   [ OK] Installed ccc.bat -^> %BIN_DIR%\ccc.bat

copy /Y "%SCRIPT_DIR%bin\ccc" "%BIN_DIR%\ccc" >nul
echo   [ OK] Installed ccc -^> %BIN_DIR%\ccc

:: ── Check PATH ──────────────────────────────────────────────
echo %PATH% | findstr /I /C:"%BIN_DIR%" >nul
if %ERRORLEVEL% neq 0 (
    echo.
    echo   [WARN] %BIN_DIR% is not in your PATH.
    echo.
    echo   Add it via System Settings ^> Environment Variables,
    echo   or run:
    echo.
    echo     setx PATH "%%PATH%%;%BIN_DIR%"
    echo.
)

:: ── Done ────────────────────────────────────────────────────
echo.
echo   Installation complete!
echo.
echo   Usage:
echo     ccc          Open account picker
echo     ccc 1        Launch with Account 1 (default)
echo     ccc 2        Launch with Account 2
echo     ccc 2 -c     Launch Account 2 in continue mode
echo.
echo   Statusline:
echo     Configured automatically. Your Claude Code sessions
echo     will show the account badge and powerline segments.
echo.
echo   First-time setup for Account 2:
echo     Run "ccc 2" and log in when prompted.
echo.

endlocal
