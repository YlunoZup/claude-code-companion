@echo off
:: Claude Code Account Switcher (Windows CMD)
:: Usage: ccc [args...]    - launches claude with account picker
::        ccc N [args...]  - launches directly with Account N
::        ccc add [name]   - add a new account
::
:: Everything that touches config.json or settings.json goes through
:: profiles.cjs. Nothing on this page embeds JavaScript source, which is what
:: used to make `!` inside a node -e snippet get eaten by delayed expansion.

setlocal enabledelayedexpansion

set "PROFILES_DIR=%USERPROFILE%\.claude-profiles"
set "PROFILES_LIB=%PROFILES_DIR%\profiles.cjs"
set "PICKER=%PROFILES_DIR%\picker.mjs"

where node >nul 2>nul
if errorlevel 1 (
    echo   Node.js is required but was not found in PATH. Install it from https://nodejs.org
    exit /b 1
)
if not exist "%PROFILES_LIB%" (
    echo   %PROFILES_LIB% is missing. Re-run the installer:  install.bat
    exit /b 1
)

set "ARG1=%~1"

:: Everything after the first argument, forwarded to claude verbatim. The old
:: "%1 %2 ... %9" form silently dropped everything past the ninth.
set "REST="
for /f "tokens=1,*" %%a in ("%*") do set "REST=%%b"

if /i "%ARG1%"=="add" goto :add

echo %ARG1%| findstr /r "^-*[0-9][0-9]*$" >nul 2>nul
if errorlevel 1 goto :picker
goto :quickswitch

:: ── ccc add [name] — add a new account ─────────────────────
:add
set "CUSTOM_NAME=%REST%"

for /f "delims=" %%n in ('node "%PROFILES_LIB%" next-account-number') do set "NEXT=%%n"
if not defined NEXT (
    echo   Error: could not determine the next account number.
    exit /b 1
)

if not defined CUSTOM_NAME set /p "CUSTOM_NAME=  Account name [Account !NEXT!]: "
if not defined CUSTOM_NAME set "CUSTOM_NAME=Account !NEXT!"

:: The name travels through the environment, so quotes in it cannot break
:: anything, and the config path never leaves profiles.cjs.
set "CC_ACCOUNT_NAME=!CUSTOM_NAME!"
for /f "delims=" %%d in ('node "%PROFILES_LIB%" add-account !NEXT!') do set "ACCT_DIR=%%d"
if not defined ACCT_DIR (
    echo   Error: could not create the account. config.json was left unchanged.
    exit /b 1
)

echo.
echo   Account !NEXT! added!
echo.
echo   Name:      !CUSTOM_NAME!
echo   Directory:  !ACCT_DIR!
echo.
echo   Run "ccc !NEXT!" to log in and start using it.
echo.
exit /b 0

:: ── ccc ^<number^> — quick-switch ────────────────────────────
:quickswitch
set "ACCT=%ARG1:-=%"

:: config.json decides which slot is the default profile — the same rule the
:: bash launcher follows. Slot 1 is not hardcoded here any more.
for /f "delims=" %%d in ('node "%PROFILES_LIB%" resolve-account !ACCT!') do set "TARGET=%%d"
if not defined TARGET (
    echo   Error: could not resolve account !ACCT!.
    exit /b 1
)

call :launch "!TARGET!" "!REST!"
exit /b !ERRORLEVEL!

:: ── ccc — interactive picker ────────────────────────────────
:picker
if not exist "%PICKER%" (
    echo   %PICKER% is missing. Re-run the installer:  install.bat
    exit /b 1
)

for /f "delims=" %%i in ('node "%PICKER%"') do set "PROFILE_PATH=%%i"
if not defined PROFILE_PATH exit /b 0

call :launch "!PROFILE_PATH!" "%*"
exit /b !ERRORLEVEL!

:: ── Launch claude with the right profile ────────────────────
:: CLAUDE_CONFIG_DIR is set inside this setlocal scope and claude is called from
:: inside it too, so the child sees it and the caller's CMD session does not
:: keep it afterwards. The old code ran endlocal *before* the set, which leaked
:: the variable into the calling session and rebound every later bare `claude`.
:launch
set "TARGET_DIR=%~1"
set "LAUNCH_ARGS=%~2"

if "%TARGET_DIR%"=="__DEFAULT__" (
    set "CLAUDE_CONFIG_DIR="
) else (
    node "%PROFILES_LIB%" ensure-shared-projects "%TARGET_DIR%" >nul 2>nul
    set "CLAUDE_CONFIG_DIR=%TARGET_DIR%"
)

call claude %LAUNCH_ARGS%
exit /b %ERRORLEVEL%
