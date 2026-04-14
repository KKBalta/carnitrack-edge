@echo off
:: CarniTrack Edge — Windows Service Uninstaller
:: Run this script as Administrator.

set "SERVICE_NAME=CarniTrackEdge"

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

:: Check if service exists
sc query "%SERVICE_NAME%" >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo  Service "%SERVICE_NAME%" is not installed.
    echo.
    pause
    exit /b 0
)

echo.
echo  Stopping CarniTrack Edge service...
sc stop "%SERVICE_NAME%" >nul 2>&1
timeout /t 3 /nobreak >nul

echo  Removing service...
sc delete "%SERVICE_NAME%"

if %errorLevel% equ 0 (
    echo.
    echo  CarniTrack Edge service has been removed.
    echo  The application files are still on disk.
    echo.
) else (
    echo.
    echo  ERROR: Failed to remove service.
    echo.
)

pause
