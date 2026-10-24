@echo off
:: Claude Code Account Switcher (Windows CMD)
:: Usage: ccc [args...]    - pick an account (who it is signed in as, live usage)
::        ccc N [args...]  - launches directly with Account N
::        ccc help         - every command: list, add, login, logout, rename,
::                           remove, repair
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

if /i "%ARG1%"=="help" goto :help
if /i "%ARG1%"=="-h" goto :help
if /i "%ARG1%"=="--help" goto :help
if /i "%ARG1%"=="list" goto :list
if /i "%ARG1%"=="ls" goto :list
if /i "%ARG1%"=="status" goto :list
if /i "%ARG1%"=="add" goto :add
if /i "%ARG1%"=="rename" goto :rename
if /i "%ARG1%"=="remove" goto :remove
if /i "%ARG1%"=="rm" goto :remove
if /i "%ARG1%"=="repair" goto :repair
if /i "%ARG1%"=="login" goto :login
if /i "%ARG1%"=="relogin" goto :login
if /i "%ARG1%"=="logout" goto :logout

echo %ARG1%| findstr /r "^-*[0-9][0-9]*$" >nul 2>nul
if errorlevel 1 goto :picker
goto :quickswitch

:: ── ccc help ──────────────────────────────────────────────
:help
node "%PROFILES_LIB%" help
exit /b %ERRORLEVEL%

:: ── ccc list — every account with its live usage ───────────
:list
if not exist "%PICKER%" (
    echo   %PICKER% is missing. Re-run the installer:  install.bat
    exit /b 1
)
node "%PICKER%" --list
exit /b %ERRORLEVEL%

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
echo   Run "ccc login !NEXT!" to sign it in.
echo.
exit /b 0

:: ── ccc rename ^<n^> ^<name^> ─────────────────────────────────
:rename
call :take_slot
if errorlevel 1 goto :rename_usage
if not defined MORE goto :rename_usage
set "CC_ACCOUNT_NAME=!MORE!"
node "%PROFILES_LIB%" rename-account !SLOT!
exit /b !ERRORLEVEL!
:rename_usage
echo   Usage: ccc rename ^<number^> ^<new name^>
exit /b 1

:: ── ccc remove ^<n^> — off the list; its folder is kept ──────
:remove
call :take_slot
if errorlevel 1 (
    echo   Usage: ccc remove ^<number^>
    exit /b 1
)
node "%PROFILES_LIB%" remove-account !SLOT!
exit /b !ERRORLEVEL!

:: ── ccc repair [n] ──────────────────────────────────────────
:repair
if not defined REST (
    node "%PROFILES_LIB%" repair
    exit /b !ERRORLEVEL!
)
call :take_slot
if errorlevel 1 (
    echo   Usage: ccc repair [number]
    exit /b 1
)
node "%PROFILES_LIB%" repair !SLOT!
exit /b !ERRORLEVEL!

:: ── ccc login^|logout ^<n^> — Claude Code's own sign-in, for that slot
:login
set "AUTH_ACTION=login"
goto :auth
:logout
set "AUTH_ACTION=logout"
:auth
call :take_slot
if errorlevel 1 (
    echo   Usage: ccc !AUTH_ACTION! ^<number^>   ^(ccc list shows the numbers^)
    exit /b 1
)
for /f "delims=" %%d in ('node "%PROFILES_LIB%" resolve-account !SLOT!') do set "TARGET=%%d"
if not defined TARGET (
    echo   Error: could not resolve account !SLOT!.
    exit /b 1
)
call :launch "!TARGET!" "auth !AUTH_ACTION! !MORE!"
exit /b !ERRORLEVEL!

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
::
:: Each profile also gets its statusLine wired before launch, as in the bash
:: launcher: a profile created by logging in for the first time never gets one.
:: Comments stay out of the block below, where cmd.exe misreads them.
:launch
set "TARGET_DIR=%~1"
set "LAUNCH_ARGS=%~2"

if "%TARGET_DIR%"=="__DEFAULT__" (
    set "CLAUDE_CONFIG_DIR="
    node "%PROFILES_LIB%" ensure-statusline "%USERPROFILE%\.claude\settings.json" >nul 2>nul
) else (
    node "%PROFILES_LIB%" ensure-shared-projects "%TARGET_DIR%" >nul 2>nul
    node "%PROFILES_LIB%" ensure-statusline "%TARGET_DIR%\settings.json" >nul 2>nul
    set "CLAUDE_CONFIG_DIR=%TARGET_DIR%"
)

call claude %LAUNCH_ARGS%
exit /b %ERRORLEVEL%

:: ── The account number a command acts on ───────────────────
:: Splits REST into SLOT, the number (a leading dash is dropped, as ccc -2 has
:: always allowed), and MORE, whatever follows it. Fails when there is no
:: number, so the caller can print its own usage line.
:take_slot
set "SLOT="
set "MORE="
for /f "tokens=1,*" %%a in ("!REST!") do (
    set "SLOT=%%a"
    set "MORE=%%b"
)
if not defined SLOT exit /b 1
set "SLOT=!SLOT:-=!"
echo !SLOT!| findstr /r "^[0-9][0-9]*$" >nul 2>nul
if errorlevel 1 exit /b 1
exit /b 0
