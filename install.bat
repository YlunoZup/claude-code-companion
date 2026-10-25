@echo off
setlocal enabledelayedexpansion

:: Claude Code Companion installer for Windows CMD

echo.
echo   Claude Code Companion installer
echo   --------------------------------
echo.

:: ── Check prerequisites ─────────────────────────────────────
where node >nul 2>nul
if errorlevel 1 (
    echo   [ERR] Node.js is required but not found. Install from https://nodejs.org
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo   [ OK] Node.js found: %%v

where claude >nul 2>nul
if errorlevel 1 (
    echo   [WARN] Claude Code CLI not found in PATH. Make sure it's installed.
) else (
    echo   [ OK] Claude Code CLI found
)

:: ── Set paths ───────────────────────────────────────────────
set "PROFILES_DIR=%USERPROFILE%\.claude-profiles"
set "ACCOUNT2_DIR=%PROFILES_DIR%\account2"
set "CLAUDE_DIR=%USERPROFILE%\.claude"
set "SCRIPT_DIR=%~dp0"
set "PROFILES_LIB=%PROFILES_DIR%\profiles.cjs"

:: ── Resolve the install destination before touching anything ─
:: An unwritable or bogus destination stops the run here, rather than halfway
:: through after settings.json has already been rewritten.
set "BIN_DIR=%USERPROFILE%\.local\bin"
if not "%~1"=="" set "BIN_DIR=%~1"

if not exist "!BIN_DIR!" mkdir "!BIN_DIR!" 2>nul
if not exist "!BIN_DIR!" (
    echo   [ERR] Cannot create the install directory: !BIN_DIR!
    exit /b 1
)

:: ── Create directories ──────────────────────────────────────
echo.
echo   [INFO] Creating profile directories...
if not exist "%PROFILES_DIR%" mkdir "%PROFILES_DIR%"
if not exist "%PROFILES_DIR%" (
    echo   [ERR] Could not create %PROFILES_DIR%
    exit /b 1
)
if not exist "%ACCOUNT2_DIR%" mkdir "%ACCOUNT2_DIR%"
if not exist "%ACCOUNT2_DIR%" (
    echo   [ERR] Could not create %ACCOUNT2_DIR%
    exit /b 1
)
echo   [ OK] Created %PROFILES_DIR%
echo   [ OK] Created %ACCOUNT2_DIR%

:: ── Install the shared profile library ──────────────────────
:: Everything below calls into this file, so it lands first.
echo   [INFO] Installing profile library...
copy /Y "%SCRIPT_DIR%src\profiles.cjs" "%PROFILES_LIB%" >nul
if errorlevel 1 (
    echo   [ERR] Could not install profiles.cjs
    exit /b 1
)
echo   [ OK] Installed profiles.cjs

:: statusline.js is CommonJS with a .js extension. Without this marker an
:: unrelated %USERPROFILE%\package.json declaring {"type":"module"} would make
:: Node parse it as ESM and the statusline would fail on every refresh.
> "%PROFILES_DIR%\package.json" echo {"type": "commonjs"}

:: ── Copy picker.mjs, and usage.cjs which it reads live usage with ──
echo   [INFO] Installing picker...
copy /Y "%SCRIPT_DIR%src\usage.cjs" "%PROFILES_DIR%\usage.cjs" >nul
if errorlevel 1 (
    echo   [ERR] Could not install usage.cjs
    exit /b 1
)
copy /Y "%SCRIPT_DIR%src\picker.mjs" "%PROFILES_DIR%\picker.mjs" >nul
if errorlevel 1 (
    echo   [ERR] Could not install picker.mjs
    exit /b 1
)
echo   [ OK] Installed picker.mjs

:: ── The GPT models: the ChatGPT sign-in, and the router that serves them ──
echo   [INFO] Installing GPT support...
for %%f in (chatgpt.cjs translate.cjs router.cjs) do (
    copy /Y "%SCRIPT_DIR%src\%%f" "%PROFILES_DIR%\%%f" >nul
    if errorlevel 1 (
        echo   [ERR] Could not install %%f
        exit /b 1
    )
)
echo   [ OK] Installed chatgpt.cjs, translate.cjs and router.cjs

:: ── Copy config (if not exists) ─────────────────────────────
if not exist "%PROFILES_DIR%\config.json" (
    copy /Y "%SCRIPT_DIR%config.example.json" "%PROFILES_DIR%\config.json" >nul
    if errorlevel 1 (
        echo   [ERR] Could not create config.json
        exit /b 1
    )
    echo   [ OK] Created config.json from template
) else (
    echo   [ OK] config.json already exists, skipping
)

:: ── Install statusline ────────────────────────────────────────
echo   [INFO] Installing statusline...
copy /Y "%SCRIPT_DIR%src\statusline.js" "%PROFILES_DIR%\statusline.js" >nul
if errorlevel 1 (
    echo   [ERR] Could not install statusline.js
    exit /b 1
)
echo   [ OK] Installed statusline.js

:: ── Configure statusline in settings.json ──────────────────────
:: profiles.cjs creates the file when it is absent and merges the statusLine key
:: when it is not, preserving every other setting. The old code checked for the
:: file before it had been created, so account 2 never got a statusline at all.
echo   [INFO] Configuring statusline in Claude Code settings...

if not exist "%CLAUDE_DIR%" mkdir "%CLAUDE_DIR%"
call :configure_statusline "%CLAUDE_DIR%\settings.json" "settings.json"
call :configure_statusline "%ACCOUNT2_DIR%\settings.json" "account2\settings.json"

:: ── Set up shared data (account2 -> .claude) ────────────────
echo   [INFO] Setting up shared data for Account 2...

:: profiles.cjs creates a junction (no administrator rights needed) and never
:: replaces whatever is already at the destination — a real directory there
:: holds that account's session transcripts.
for %%d in (projects todos statsig .statsig) do (
    if exist "%CLAUDE_DIR%\%%d" (
        for /f "delims=" %%r in ('node "%PROFILES_LIB%" ensure-link "%ACCOUNT2_DIR%\%%d" "%CLAUDE_DIR%\%%d"') do (
            if "%%r"=="linked" (
                echo   [ OK] Shared: %%d
            ) else if "%%r"=="already-linked" (
                echo   [ OK] Shared: %%d ^(already linked^)
            ) else if "%%r"=="exists" (
                echo   [WARN] %%d already exists in account2 — leaving it as it is
            ) else (
                echo   [WARN] Could not share %%d
            )
        )
    )
)

:: ── Install launcher script ─────────────────────────────────
echo   [INFO] Installing launcher script...

copy /Y "%SCRIPT_DIR%bin\ccc.bat" "!BIN_DIR!\ccc.bat" >nul
if errorlevel 1 (
    echo   [ERR] Could not install ccc.bat to !BIN_DIR!
    exit /b 1
)
echo   [ OK] Installed ccc.bat -^> !BIN_DIR!\ccc.bat

copy /Y "%SCRIPT_DIR%bin\ccc" "!BIN_DIR!\ccc" >nul
if errorlevel 1 (
    echo   [ERR] Could not install ccc to !BIN_DIR!
    exit /b 1
)
echo   [ OK] Installed ccc -^> !BIN_DIR!\ccc

:: Clean up the shadowing launcher left by earlier versions of this installer,
:: the same way install.sh does.
if exist "!BIN_DIR!\cc" (
    findstr /C:"Claude Code Account Switcher" "!BIN_DIR!\cc" >nul 2>nul
    if not errorlevel 1 (
        del /q "!BIN_DIR!\cc" >nul 2>nul
        del /q "!BIN_DIR!\cc.bat" >nul 2>nul
        echo   [ OK] Removed the old 'cc' launcher ^(it shadowed the system C compiler^)
    )
)

:: ── Check PATH ──────────────────────────────────────────────
:: !BIN_DIR!, not %BIN_DIR%: a path containing ")" — anything under
:: "C:\Program Files (x86)" — would otherwise close this block early.
echo %PATH% | findstr /I /C:"!BIN_DIR!" >nul
if errorlevel 1 (
    echo.
    echo   [WARN] !BIN_DIR! is not in your PATH.
    echo.
    echo   Add it via System Settings ^> Environment Variables ^> Path.
    echo.
    echo   Avoid "setx PATH" for this: it collapses the machine and user PATH
    echo   into one user variable and truncates it at 1024 characters.
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
echo     Configured automatically. Your Claude Code sessions will show
echo     the account, model, git branch, directory and context usage.
echo.
echo   First-time setup for Account 2:
echo     Run "ccc 2" and log in when prompted.
echo.

endlocal
exit /b 0

:: ── Helpers ─────────────────────────────────────────────────
:configure_statusline
node "%PROFILES_LIB%" apply-statusline "%~1"
if errorlevel 1 (
    echo   [WARN] Left %~2 alone — it exists but could not be parsed as JSON
) else (
    echo   [ OK] Configured statusline in %~2
)
exit /b 0
