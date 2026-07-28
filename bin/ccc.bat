@echo off
setlocal enabledelayedexpansion

set "PROFILES_DIR=%USERPROFILE%\.claude-profiles"
set "CONFIG=%PROFILES_DIR%\config.json"
set "ARG1=%~1"

:: ── ccc add [name] — add a new account ─────────────────────
if /i "%ARG1%"=="add" (
    shift
    set "CUSTOM_NAME=%~2 %~3 %~4 %~5"
    :: Trim trailing spaces
    for /f "tokens=*" %%a in ("!CUSTOM_NAME!") do set "CUSTOM_NAME=%%a"

    :: Find next account number
    for /f "delims=" %%n in ('node -e "var fs=require('fs');var c={accounts:{}};try{c=JSON.parse(fs.readFileSync('%CONFIG:\=/%','utf8'))}catch(e){}var k=Object.keys(c.accounts).map(Number).filter(function(n){return !isNaN(n)});console.log(Math.max.apply(null,k.concat([0]))+1)" 2^>nul') do set "NEXT=%%n"

    if not defined NEXT (
        echo   Error: could not determine next account number.
        exit /b 1
    )

    set "DIR_NAME=account!NEXT!"
    set "ACCT_DIR=%PROFILES_DIR%\!DIR_NAME!"

    :: Prompt for name if not provided
    if "!CUSTOM_NAME!"=="" (
        set /p "CUSTOM_NAME=  Account name [Account !NEXT!]: "
        if "!CUSTOM_NAME!"=="" set "CUSTOM_NAME=Account !NEXT!"
    )

    :: Create directory
    if not exist "!ACCT_DIR!" mkdir "!ACCT_DIR!"

    :: Add to config.json. The name goes through the environment rather than
    :: string interpolation, so a name containing quotes cannot break the script.
    set "CC_CONFIG=%CONFIG:\=/%"
    set "CC_KEY=!NEXT!"
    set "CC_NAME=!CUSTOM_NAME!"
    set "CC_DIR=!DIR_NAME!"
    node -e "var fs=require('fs');var c={accounts:{}};try{c=JSON.parse(fs.readFileSync(process.env.CC_CONFIG,'utf8'))}catch(e){}c.accounts[process.env.CC_KEY]={name:process.env.CC_NAME,configDir:process.env.CC_DIR};fs.writeFileSync(process.env.CC_CONFIG,JSON.stringify(c,null,2)+'\n')" 2>nul

    :: Create settings.json with statusline
    node -e "var fs=require('fs'),h=require('os').homedir().replace(/\\/g,'/');var s={statusLine:{type:'command',command:'node '+h+'/.claude-profiles/statusline.js'}};fs.writeFileSync('!ACCT_DIR:\=/!/settings.json',JSON.stringify(s,null,2)+'\n')" 2>nul

    :: Share one session history with the default profile, the same way the
    :: installer does. Without this the new account gets an isolated history and
    :: /resume cannot see sessions started on the other accounts.
    if not exist "!ACCT_DIR!\projects" (
        if not exist "%USERPROFILE%\.claude\projects" mkdir "%USERPROFILE%\.claude\projects"
        mklink /J "!ACCT_DIR!\projects" "%USERPROFILE%\.claude\projects" >nul 2>nul
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
)

:: ── ccc ^<number^> — quick-switch ────────────────────────────
echo %ARG1%| findstr /r "^-*[0-9][0-9]*$" >nul 2>nul
if %ERRORLEVEL% equ 0 goto quickswitch
goto picker

:quickswitch
set "ACCT=%ARG1:-=%"
shift

if "%ACCT%"=="1" (
    endlocal
    set "CLAUDE_CONFIG_DIR="
    claude %1 %2 %3 %4 %5 %6 %7 %8 %9
    goto :eof
)

:: Look up configDir from config.json
for /f "delims=" %%d in ('node -e "try{var c=JSON.parse(require('fs').readFileSync('%CONFIG:\=/%','utf8'));var a=c.accounts['%ACCT%'];if(a&&a.configDir)process.stdout.write(a.configDir);else if(a)process.stdout.write('__DEFAULT__')}catch{}" 2^>nul') do set "CFGDIR=%%d"

if "%CFGDIR%"=="__DEFAULT__" (
    endlocal
    set "CLAUDE_CONFIG_DIR="
    claude %1 %2 %3 %4 %5 %6 %7 %8 %9
    goto :eof
)

if not "%CFGDIR%"=="" (
    if not exist "%USERPROFILE%\.claude-profiles\%CFGDIR%" mkdir "%USERPROFILE%\.claude-profiles\%CFGDIR%" >nul 2>nul
    if not exist "%USERPROFILE%\.claude-profiles\%CFGDIR%\projects" mklink /J "%USERPROFILE%\.claude-profiles\%CFGDIR%\projects" "%USERPROFILE%\.claude\projects" >nul 2>nul
    endlocal
    set "CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-profiles\%CFGDIR%"
    claude %1 %2 %3 %4 %5 %6 %7 %8 %9
    goto :eof
)

:: Fallback: assume accountN directory
if not exist "%USERPROFILE%\.claude-profiles\account%ACCT%" mkdir "%USERPROFILE%\.claude-profiles\account%ACCT%" >nul 2>nul
if not exist "%USERPROFILE%\.claude-profiles\account%ACCT%\projects" mklink /J "%USERPROFILE%\.claude-profiles\account%ACCT%\projects" "%USERPROFILE%\.claude\projects" >nul 2>nul
endlocal
set "CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-profiles\account%ACCT%"
claude %1 %2 %3 %4 %5 %6 %7 %8 %9
goto :eof

:picker
for /f "delims=" %%i in ('node "%PROFILES_DIR%\picker.mjs"') do set "PROFILE_PATH=%%i"
if "%PROFILE_PATH%"=="" goto :eof
if "%PROFILE_PATH%"=="__DEFAULT__" (
    endlocal
    set "CLAUDE_CONFIG_DIR="
) else (
    if not exist "%PROFILE_PATH%" mkdir "%PROFILE_PATH%" >nul 2>nul
    if not exist "%PROFILE_PATH%\projects" mklink /J "%PROFILE_PATH%\projects" "%USERPROFILE%\.claude\projects" >nul 2>nul
    endlocal
    set "CLAUDE_CONFIG_DIR=%PROFILE_PATH%"
)
claude %*
