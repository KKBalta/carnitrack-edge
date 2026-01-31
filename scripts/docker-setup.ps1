# ═══════════════════════════════════════════════════════════════════════════════
# CarniTrack Edge - Docker Setup & Run Script (PowerShell)
# ═══════════════════════════════════════════════════════════════════════════════
#
# This script automates the Docker testing environment setup for Windows.
#
# WHAT IT DOES:
#   1. Detects your local IP address automatically
#   2. Starts the mock REST server (for testing)
#   3. Builds and starts the Edge service in Docker
#   4. Shows logs and connection information
#
# PREREQUISITES:
#   - Docker Desktop installed and running
#   - Bun installed (for mock server)
#   - Static IP assigned to your machine (recommended for production)
#
# USAGE:
#   .\docker-setup.ps1 start    # Start everything
#   .\docker-setup.ps1 stop     # Stop everything
#   .\docker-setup.ps1 help     # Show all commands
#
# ═══════════════════════════════════════════════════════════════════════════════

param(
    [Parameter(Position=0)]
    [ValidateSet('start', 'stop', 'restart', 'logs', 'status', 'mock', 'edge', 'info', 'build', 'clean', 'shell', 'backup', 'help')]
    [string]$Command = 'help'
)

# ─────────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────────
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
Set-Location $ProjectDir

# PID file location
$MockPidFile = "$env:TEMP\carnitrack-mock-server.pid"
$MockLogFile = "$env:TEMP\carnitrack-mock-server.log"

# ─────────────────────────────────────────────────────────────────────────────────
# Utility Functions
# ─────────────────────────────────────────────────────────────────────────────────

function Write-ColorOutput {
    param(
        [string]$Message,
        [string]$Color = "White"
    )
    Write-Host $Message -ForegroundColor $Color
}

function Print-Banner {
    Write-Host ""
    Write-Host "╔═══════════════════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "║                                                                               ║" -ForegroundColor Cyan
    Write-Host "║   ██████╗ █████╗ ██████╗ ███╗   ██╗██╗████████╗██████╗  █████╗  ██████╗██╗  ██║" -ForegroundColor Cyan
    Write-Host "║  ██╔════╝██╔══██╗██╔══██╗████╗  ██║██║╚══██╔══╝██╔══██╗██╔══██╗██╔════╝██║ ██╔╝║" -ForegroundColor Cyan
    Write-Host "║  ██║     ███████║██████╔╝██╔██╗ ██║██║   ██║   ██████╔╝███████║██║     █████╔╝ ║" -ForegroundColor Cyan
    Write-Host "║  ██║     ██╔══██║██╔══██╗██║╚██╗██║██║   ██║   ██╔══██╗██╔══██║██║     ██╔═██╗ ║" -ForegroundColor Cyan
    Write-Host "║  ╚██████╗██║  ██║██║  ██║██║ ╚████║██║   ██║   ██║  ██║██║  ██║╚██████╗██║  ██╗║" -ForegroundColor Cyan
    Write-Host "║   ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝║" -ForegroundColor Cyan
    Write-Host "║                                                                               ║" -ForegroundColor Cyan
    Write-Host "║                    Docker Setup & Run Script (Windows)                        ║" -ForegroundColor Cyan
    Write-Host "║                                                                               ║" -ForegroundColor Cyan
    Write-Host "╚═══════════════════════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
}

function Get-LocalIP {
    # Get the first non-loopback IPv4 address
    $ip = (Get-NetIPAddress -AddressFamily IPv4 | 
           Where-Object { $_.IPAddress -ne "127.0.0.1" -and $_.PrefixOrigin -ne "WellKnown" } | 
           Select-Object -First 1).IPAddress
    
    if (-not $ip) {
        # Fallback: try to get from network adapters
        $ip = (Get-NetIPConfiguration | 
               Where-Object { $_.IPv4DefaultGateway -ne $null } | 
               Select-Object -First 1).IPv4Address.IPAddress
    }
    
    if (-not $ip) {
        $ip = "127.0.0.1"
    }
    
    return $ip
}

function Test-PortInUse {
    param([int]$Port)
    
    try {
        $connections = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
        return ($null -ne $connections)
    }
    catch {
        return $false
    }
}

function Test-Docker {
    # Check if docker command exists
    $dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $dockerCmd) {
        Write-Host "ERROR: Docker is not installed" -ForegroundColor Red
        Write-Host "Please install Docker Desktop from https://www.docker.com/products/docker-desktop"
        exit 1
    }
    
    # Check if Docker daemon is running
    try {
        docker info 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Docker not running"
        }
    }
    catch {
        Write-Host "ERROR: Docker daemon is not running" -ForegroundColor Red
        Write-Host "Please start Docker Desktop and try again"
        exit 1
    }
}

function Test-Bun {
    $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
    if (-not $bunCmd) {
        Write-Host "ERROR: Bun is not installed" -ForegroundColor Red
        Write-Host "Please install Bun from https://bun.sh"
        exit 1
    }
}

function Show-Usage {
    Write-Host "Usage: " -NoNewline -ForegroundColor White
    Write-Host ".\docker-setup.ps1 <command>" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Commands:" -ForegroundColor White
    Write-Host "  start       Start everything (mock server + Docker Edge)"
    Write-Host "  stop        Stop everything"
    Write-Host "  restart     Restart everything"
    Write-Host "  logs        Show Edge container logs"
    Write-Host "  status      Show status of all services"
    Write-Host "  mock        Start only the mock server (foreground)"
    Write-Host "  edge        Start only the Docker Edge (mock must be running)"
    Write-Host "  info        Show network and connection information"
    Write-Host "  build       Build Docker image only"
    Write-Host "  clean       Stop and remove containers, volumes, and networks"
    Write-Host "  shell       Open shell in running container"
    Write-Host "  backup      Backup SQLite database"
    Write-Host "  help        Show this help message"
    Write-Host ""
    Write-Host "Quick Start:" -ForegroundColor White
    Write-Host "  .\docker-setup.ps1 start    # Starts everything automatically" -ForegroundColor Cyan
    Write-Host ""
}

function Show-NetworkInfo {
    $ip = Get-LocalIP
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════════════════════════════" -ForegroundColor Green
    Write-Host "                         NETWORK INFORMATION                                   " -ForegroundColor Green
    Write-Host "═══════════════════════════════════════════════════════════════════════════════" -ForegroundColor Green
    Write-Host ""
    Write-Host "Your Machine IP:         " -NoNewline -ForegroundColor White
    Write-Host $ip -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Scale Configuration:" -ForegroundColor White
    Write-Host "  Configure DP-401 scales to connect to: " -NoNewline
    Write-Host "${ip}:8899" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Admin Dashboard:" -ForegroundColor White
    Write-Host "  Open in browser: " -NoNewline
    Write-Host "http://${ip}:3000" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Mock Server Dashboard:" -ForegroundColor White
    Write-Host "  Open in browser: " -NoNewline
    Write-Host "http://${ip}:4000" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Health Check:" -ForegroundColor White
    Write-Host "  curl " -NoNewline
    Write-Host "http://localhost:3000/health" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "API Status:" -ForegroundColor White
    Write-Host "  curl " -NoNewline
    Write-Host "http://localhost:3000/api/status" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════════════════════════════" -ForegroundColor Green
    Write-Host ""
    Write-Host "NETWORKING NOTE:" -ForegroundColor Yellow
    Write-Host "  Docker automatically handles port forwarding. Scales connect to your"
    Write-Host "  machine's IP ($ip) on port 8899, and Docker routes the traffic to"
    Write-Host "  the container. No special network configuration needed!"
    Write-Host ""
    Write-Host "FIREWALL:" -ForegroundColor Yellow
    Write-Host "  Make sure Windows Firewall allows incoming connections on:"
    Write-Host "    - Port 8899 (TCP - Scale connections)"
    Write-Host "    - Port 3000 (HTTP - Admin dashboard)"
    Write-Host "    - Port 4000 (HTTP - Mock server, testing only)"
    Write-Host ""
}

function Test-ContainerRunning {
    $containers = docker ps --format '{{.Names}}' 2>$null
    return ($containers -match "carnitrack-edge-test")
}

# ─────────────────────────────────────────────────────────────────────────────────
# Main Commands
# ─────────────────────────────────────────────────────────────────────────────────

function Invoke-Start {
    Print-Banner
    Test-Docker
    Test-Bun
    
    $ip = Get-LocalIP
    
    Write-Host "Detected IP Address: " -NoNewline -ForegroundColor Yellow
    Write-Host $ip -ForegroundColor Cyan
    Write-Host ""
    
    # Check if mock server is already running
    if (Test-PortInUse 4000) {
        Write-Host "[OK] Mock server already running on port 4000" -ForegroundColor Green
    }
    else {
        Write-Host "Starting mock REST server in background..." -ForegroundColor Yellow
        
        # Start mock server as a background job
        $job = Start-Job -ScriptBlock {
            param($projectDir)
            Set-Location $projectDir
            & bun run src/cloud/mock-rest-server.ts 2>&1
        } -ArgumentList $ProjectDir
        
        # Save job ID
        $job.Id | Out-File -FilePath $MockPidFile -Force
        
        # Wait a bit for startup
        Start-Sleep -Seconds 3
        
        if (Test-PortInUse 4000) {
            Write-Host "[OK] Mock server started (Job ID: $($job.Id))" -ForegroundColor Green
        }
        else {
            Write-Host "[FAIL] Failed to start mock server" -ForegroundColor Red
            Write-Host "Check logs with: Get-Job -Id $($job.Id) | Receive-Job"
            exit 1
        }
    }
    
    Write-Host ""
    
    # Check if Edge container is already running
    if (Test-ContainerRunning) {
        Write-Host "[OK] Edge container already running" -ForegroundColor Green
    }
    else {
        Write-Host "Building and starting Edge container..." -ForegroundColor Yellow
        
        $env:HOST_IP = $ip
        docker compose -f docker-compose.test.yml up -d --build
        
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[OK] Edge container started" -ForegroundColor Green
        }
        else {
            Write-Host "[FAIL] Failed to start Edge container" -ForegroundColor Red
            exit 1
        }
    }
    
    Write-Host ""
    
    # Wait for health check
    Write-Host "Waiting for Edge service to be healthy..." -ForegroundColor Yellow
    $healthy = $false
    for ($i = 1; $i -le 30; $i++) {
        try {
            $response = Invoke-WebRequest -Uri "http://localhost:3000/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
            if ($response.StatusCode -eq 200) {
                $healthy = $true
                break
            }
        }
        catch {
            # Ignore and continue waiting
        }
        Write-Host "." -NoNewline
        Start-Sleep -Seconds 1
    }
    Write-Host ""
    
    if ($healthy) {
        Write-Host "[OK] Edge service is healthy!" -ForegroundColor Green
    }
    else {
        Write-Host "[WARNING] Health check timed out, service may still be starting..." -ForegroundColor Yellow
    }
    
    Show-NetworkInfo
    
    Write-Host "Everything is running!" -ForegroundColor Green
    Write-Host ""
    Write-Host "View logs:        " -NoNewline
    Write-Host ".\docker-setup.ps1 logs" -ForegroundColor Cyan
    Write-Host "Check status:     " -NoNewline
    Write-Host ".\docker-setup.ps1 status" -ForegroundColor Cyan
    Write-Host "Stop everything:  " -NoNewline
    Write-Host ".\docker-setup.ps1 stop" -ForegroundColor Cyan
    Write-Host ""
}

function Invoke-Stop {
    Write-Host "Stopping services..." -ForegroundColor Yellow
    
    # Stop Docker container
    if (Test-ContainerRunning) {
        Write-Host "Stopping Edge container..." -ForegroundColor Yellow
        docker compose -f docker-compose.test.yml down
        Write-Host "[OK] Edge container stopped" -ForegroundColor Green
    }
    else {
        Write-Host "Edge container not running" -ForegroundColor Blue
    }
    
    # Stop mock server (background job)
    if (Test-Path $MockPidFile) {
        $jobId = Get-Content $MockPidFile -ErrorAction SilentlyContinue
        if ($jobId) {
            try {
                $job = Get-Job -Id $jobId -ErrorAction SilentlyContinue
                if ($job) {
                    Write-Host "Stopping mock server (Job ID: $jobId)..." -ForegroundColor Yellow
                    Stop-Job -Id $jobId -ErrorAction SilentlyContinue
                    Remove-Job -Id $jobId -Force -ErrorAction SilentlyContinue
                    Write-Host "[OK] Mock server stopped" -ForegroundColor Green
                }
            }
            catch {
                # Job may not exist anymore
            }
        }
        Remove-Item $MockPidFile -Force -ErrorAction SilentlyContinue
    }
    
    # Also try to kill any bun processes running mock-rest-server
    Get-Process -Name "bun" -ErrorAction SilentlyContinue | 
        Where-Object { $_.CommandLine -match "mock-rest-server" } | 
        Stop-Process -Force -ErrorAction SilentlyContinue
    
    Write-Host ""
    Write-Host "All services stopped" -ForegroundColor Green
    Write-Host "Note: Data is preserved in Docker volumes" -ForegroundColor Blue
}

function Invoke-Restart {
    Invoke-Stop
    Write-Host ""
    Start-Sleep -Seconds 2
    Invoke-Start
}

function Invoke-Logs {
    Write-Host "Following Edge container logs (Ctrl+C to stop)..." -ForegroundColor Yellow
    docker compose -f docker-compose.test.yml logs -f
}

function Invoke-Status {
    $ip = Get-LocalIP
    
    Write-Host ""
    Write-Host "Service Status:" -ForegroundColor White
    Write-Host "─────────────────────────────────────────────────────────"
    
    # Check mock server
    if (Test-PortInUse 4000) {
        Write-Host "Mock Server (port 4000):    " -NoNewline
        Write-Host "● Running" -ForegroundColor Green
    }
    else {
        Write-Host "Mock Server (port 4000):    " -NoNewline
        Write-Host "○ Stopped" -ForegroundColor Red
    }
    
    # Check Docker container
    if (Test-ContainerRunning) {
        try {
            $healthStatus = docker inspect --format='{{.State.Health.Status}}' carnitrack-edge-test 2>$null
            if ($healthStatus -eq "healthy") {
                Write-Host "Edge Container:             " -NoNewline
                Write-Host "● Running (healthy)" -ForegroundColor Green
            }
            else {
                Write-Host "Edge Container:             " -NoNewline
                Write-Host "● Running ($healthStatus)" -ForegroundColor Yellow
            }
        }
        catch {
            Write-Host "Edge Container:             " -NoNewline
            Write-Host "● Running" -ForegroundColor Green
        }
    }
    else {
        Write-Host "Edge Container:             " -NoNewline
        Write-Host "○ Stopped" -ForegroundColor Red
    }
    
    # Check TCP port
    if (Test-PortInUse 8899) {
        Write-Host "TCP Server (port 8899):     " -NoNewline
        Write-Host "● Listening" -ForegroundColor Green
    }
    else {
        Write-Host "TCP Server (port 8899):     " -NoNewline
        Write-Host "○ Not listening" -ForegroundColor Red
    }
    
    # Check HTTP port
    if (Test-PortInUse 3000) {
        Write-Host "HTTP Server (port 3000):    " -NoNewline
        Write-Host "● Listening" -ForegroundColor Green
    }
    else {
        Write-Host "HTTP Server (port 3000):    " -NoNewline
        Write-Host "○ Not listening" -ForegroundColor Red
    }
    
    Write-Host "─────────────────────────────────────────────────────────"
    Write-Host ""
    
    # Show health check if running
    if (Test-PortInUse 3000) {
        Write-Host "Health Check:" -ForegroundColor White
        try {
            $health = Invoke-RestMethod -Uri "http://localhost:3000/health" -TimeoutSec 5 -ErrorAction SilentlyContinue
            $health | ConvertTo-Json -Depth 3 | Write-Host
        }
        catch {
            Write-Host "Could not fetch health"
        }
        Write-Host ""
    }
    
    # Show quick info
    Write-Host "Connection Info:" -ForegroundColor White
    Write-Host "  Scales connect to: " -NoNewline
    Write-Host "${ip}:8899" -ForegroundColor Cyan
    Write-Host "  Admin Dashboard:   " -NoNewline
    Write-Host "http://${ip}:3000" -ForegroundColor Cyan
    Write-Host ""
}

function Invoke-Mock {
    Test-Bun
    Write-Host "Starting Mock REST Server (Ctrl+C to stop)..." -ForegroundColor Yellow
    Write-Host ""
    & bun run src/cloud/mock-rest-server.ts
}

function Invoke-Edge {
    Test-Docker
    
    $ip = Get-LocalIP
    
    if (-not (Test-PortInUse 4000)) {
        Write-Host "Warning: Mock server not running on port 4000" -ForegroundColor Yellow
        Write-Host "Edge will start in offline mode. Start mock server with: .\docker-setup.ps1 mock"
        Write-Host ""
    }
    
    Write-Host "Starting Edge container with IP: $ip" -ForegroundColor Yellow
    $env:HOST_IP = $ip
    docker compose -f docker-compose.test.yml up -d --build
    
    Write-Host ""
    Write-Host "Edge container started!" -ForegroundColor Green
    Write-Host "View logs: " -NoNewline
    Write-Host ".\docker-setup.ps1 logs" -ForegroundColor Cyan
}

function Invoke-Build {
    Test-Docker
    Write-Host "Building Docker image..." -ForegroundColor Yellow
    docker compose -f docker-compose.test.yml build
    Write-Host "[OK] Build complete" -ForegroundColor Green
}

function Invoke-Clean {
    Write-Host "Cleaning up Docker resources..." -ForegroundColor Yellow
    
    # Stop containers
    docker compose -f docker-compose.test.yml down -v --remove-orphans 2>$null
    
    # Remove volumes
    Write-Host "Removing volumes..." -ForegroundColor Yellow
    docker volume rm carnitrack-edge-data carnitrack-edge-logs carnitrack-edge-generated 2>$null
    
    # Stop mock server
    Get-Process -Name "bun" -ErrorAction SilentlyContinue | 
        Where-Object { $_.CommandLine -match "mock-rest-server" } | 
        Stop-Process -Force -ErrorAction SilentlyContinue
    
    # Cleanup temp files
    Remove-Item $MockPidFile -Force -ErrorAction SilentlyContinue
    Remove-Item $MockLogFile -Force -ErrorAction SilentlyContinue
    
    # Remove background jobs
    Get-Job | Where-Object { $_.Command -match "mock-rest-server" } | Remove-Job -Force -ErrorAction SilentlyContinue
    
    Write-Host "[OK] Cleanup complete" -ForegroundColor Green
    Write-Host "Warning: All data has been deleted!" -ForegroundColor Red
}

function Invoke-Shell {
    if (-not (Test-ContainerRunning)) {
        Write-Host "Edge container is not running" -ForegroundColor Red
        Write-Host "Start it with: .\docker-setup.ps1 start"
        exit 1
    }
    
    Write-Host "Opening shell in Edge container..." -ForegroundColor Yellow
    docker exec -it carnitrack-edge-test /bin/sh
}

function Invoke-Backup {
    if (-not (Test-ContainerRunning)) {
        Write-Host "Edge container is not running" -ForegroundColor Red
        Write-Host "Start it with: .\docker-setup.ps1 start"
        exit 1
    }
    
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupFile = "backup-$timestamp.db"
    
    Write-Host "Backing up database to $backupFile..." -ForegroundColor Yellow
    docker cp carnitrack-edge-test:/app/data/carnitrack.db "./$backupFile"
    Write-Host "[OK] Database backed up to $backupFile" -ForegroundColor Green
}

function Invoke-Info {
    Show-NetworkInfo
}

# ─────────────────────────────────────────────────────────────────────────────────
# Main Entry Point
# ─────────────────────────────────────────────────────────────────────────────────

switch ($Command) {
    'start'   { Invoke-Start }
    'stop'    { Invoke-Stop }
    'restart' { Invoke-Restart }
    'logs'    { Invoke-Logs }
    'status'  { Invoke-Status }
    'mock'    { Invoke-Mock }
    'edge'    { Invoke-Edge }
    'build'   { Invoke-Build }
    'clean'   { Invoke-Clean }
    'shell'   { Invoke-Shell }
    'backup'  { Invoke-Backup }
    'info'    { Invoke-Info }
    'help'    { 
        Print-Banner
        Show-Usage 
    }
    default   {
        Write-Host "Unknown command: $Command" -ForegroundColor Red
        Write-Host ""
        Show-Usage
        exit 1
    }
}
