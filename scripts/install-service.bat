@echo off
:: CarniTrack Edge — Windows Service Installer
:: Run this script as Administrator to install CarniTrack Edge as a Windows Service.
:: The service will start automatically on system boot.

setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "EDGE_EXE=%SCRIPT_DIR%carnitrack-edge.exe"
set "SERVICE_NAME=CarniTrackEdge"
set "DISPLAY_NAME=CarniTrack Edge Service"
set "LOG_DIR=%SCRIPT_DIR%logs"

:: Check for admin privileges
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo  ERROR: This script requires Administrator privileges.
    echo  Right-click and select "Run as administrator".
    echo.
    pause
    exit /b 1
)

:: Check if exe exists
if not exist "%EDGE_EXE%" (
    echo.
    echo  ERROR: carnitrack-edge.exe not found in %SCRIPT_DIR%
    echo  Make sure this script is in the same folder as the executable.
    echo.
    pause
    exit /b 1
)

:: Create logs directory
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

:: Check if service already exists
sc query "%SERVICE_NAME%" >nul 2>&1
if %errorLevel% equ 0 (
    echo.
    echo  Service "%SERVICE_NAME%" already exists.
    echo  Stopping existing service...
    sc stop "%SERVICE_NAME%" >nul 2>&1
    timeout /t 3 /nobreak >nul
    echo  Removing existing service...
    sc delete "%SERVICE_NAME%" >nul 2>&1
    timeout /t 2 /nobreak >nul
)

echo.
echo  ========================================================
echo   CarniTrack Edge — Installing Windows Service
echo  ========================================================
echo.
echo   Executable:  %EDGE_EXE%
echo   Service:     %SERVICE_NAME%
echo   Start Type:  Automatic
echo.

:: Create the Windows service
sc create "%SERVICE_NAME%" binPath= "\"%EDGE_EXE%\"" start= auto DisplayName= "%DISPLAY_NAME%"

if %errorLevel% neq 0 (
    echo.
    echo  ERROR: Failed to create service.
    echo.
    pause
    exit /b 1
)

:: Set service description
sc description "%SERVICE_NAME%" "CarniTrack Edge Service - Connects DP-401 scales and printers to CarniTrack Cloud."

:: Set recovery options: restart on first, second, and subsequent failures
sc failure "%SERVICE_NAME%" reset= 86400 actions= restart/5000/restart/10000/restart/30000

:: Start the service
echo  Starting service...
sc start "%SERVICE_NAME%"

if %errorLevel% neq 0 (
    echo.
    echo  WARNING: Service created but failed to start.
    echo  Check if port 3000 or 8899 is already in use.
    echo.
) else (
    echo.
    echo  ========================================================
    echo   SUCCESS!
    echo  ========================================================
    echo.
    echo   CarniTrack Edge is now running as a Windows Service.
    echo   It will start automatically when this computer boots.
    echo.
    echo   Dashboard:  http://localhost:3000
    echo.
    echo   To check status:  sc query %SERVICE_NAME%
    echo   To stop:          sc stop %SERVICE_NAME%
    echo   To uninstall:     Run uninstall-service.bat
    echo.
)

pause
