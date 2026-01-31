#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# CarniTrack Edge - Docker Setup & Run Script
# ═══════════════════════════════════════════════════════════════════════════════
#
# This script automates the Docker testing environment setup.
#
# WHAT IT DOES:
#   1. Detects your local IP address automatically
#   2. Starts the mock REST server (for testing)
#   3. Builds and starts the Edge service in Docker
#   4. Shows logs and connection information
#
# PREREQUISITES:
#   - Docker and Docker Compose installed
#   - Bun installed (for mock server)
#   - Static IP assigned to your machine (recommended for production)
#
# ═══════════════════════════════════════════════════════════════════════════════

set -e

# ─────────────────────────────────────────────────────────────────────────────────
# Colors and formatting
# ─────────────────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ─────────────────────────────────────────────────────────────────────────────────
# Get script and project directories
# ─────────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# ─────────────────────────────────────────────────────────────────────────────────
# Utility functions
# ─────────────────────────────────────────────────────────────────────────────────

print_banner() {
    echo -e "${CYAN}"
    echo "╔═══════════════════════════════════════════════════════════════════════════════╗"
    echo "║                                                                               ║"
    echo "║   ██████╗ █████╗ ██████╗ ███╗   ██╗██╗████████╗██████╗  █████╗  ██████╗██╗  ██║"
    echo "║  ██╔════╝██╔══██╗██╔══██╗████╗  ██║██║╚══██╔══╝██╔══██╗██╔══██╗██╔════╝██║ ██╔╝║"
    echo "║  ██║     ███████║██████╔╝██╔██╗ ██║██║   ██║   ██████╔╝███████║██║     █████╔╝ ║"
    echo "║  ██║     ██╔══██║██╔══██╗██║╚██╗██║██║   ██║   ██╔══██╗██╔══██║██║     ██╔═██╗ ║"
    echo "║  ╚██████╗██║  ██║██║  ██║██║ ╚████║██║   ██║   ██║  ██║██║  ██║╚██████╗██║  ██╗║"
    echo "║   ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝║"
    echo "║                                                                               ║"
    echo "║                    Docker Setup & Run Script                                  ║"
    echo "║                                                                               ║"
    echo "╚═══════════════════════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

# Get the local IP address
get_local_ip() {
    local ip=""
    
    # macOS
    if command -v ifconfig &> /dev/null; then
        ip=$(ifconfig | grep "inet " | grep -v "127.0.0.1" | head -1 | awk '{print $2}')
    fi
    
    # Linux fallback
    if [ -z "$ip" ] && command -v ip &> /dev/null; then
        ip=$(ip -4 addr show | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | grep -v "127.0.0.1" | head -1)
    fi
    
    # hostname fallback
    if [ -z "$ip" ] && command -v hostname &> /dev/null; then
        ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    fi
    
    echo "${ip:-127.0.0.1}"
}

# Check if a port is in use
is_port_in_use() {
    local port=$1
    if command -v lsof &> /dev/null; then
        lsof -i ":$port" &> /dev/null
        return $?
    elif command -v netstat &> /dev/null; then
        netstat -an | grep ":$port " | grep -q LISTEN
        return $?
    fi
    return 1
}

# Check if Docker is running
check_docker() {
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}ERROR: Docker is not installed${NC}"
        echo "Please install Docker Desktop from https://www.docker.com/products/docker-desktop"
        exit 1
    fi
    
    if ! docker info &> /dev/null; then
        echo -e "${RED}ERROR: Docker daemon is not running${NC}"
        echo "Please start Docker Desktop and try again"
        exit 1
    fi
}

# Check if Bun is installed
check_bun() {
    if ! command -v bun &> /dev/null; then
        echo -e "${RED}ERROR: Bun is not installed${NC}"
        echo "Please install Bun from https://bun.sh"
        exit 1
    fi
}

show_usage() {
    echo -e "${BOLD}Usage:${NC} $0 <command>"
    echo ""
    echo -e "${BOLD}Commands:${NC}"
    echo "  start       Start everything (mock server + Docker Edge)"
    echo "  stop        Stop everything"
    echo "  restart     Restart everything"
    echo "  logs        Show Edge container logs"
    echo "  status      Show status of all services"
    echo "  mock        Start only the mock server (foreground)"
    echo "  edge        Start only the Docker Edge (mock must be running)"
    echo "  info        Show network and connection information"
    echo "  build       Build Docker image only"
    echo "  clean       Stop and remove containers, volumes, and networks"
    echo "  shell       Open shell in running container"
    echo "  backup      Backup SQLite database"
    echo "  help        Show this help message"
    echo ""
    echo -e "${BOLD}Quick Start:${NC}"
    echo "  $0 start    # Starts everything automatically"
    echo ""
}

show_network_info() {
    local ip=$(get_local_ip)
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}                         NETWORK INFORMATION                                   ${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "${BOLD}Your Machine IP:${NC}         ${CYAN}$ip${NC}"
    echo ""
    echo -e "${BOLD}Scale Configuration:${NC}"
    echo -e "  Configure DP-401 scales to connect to: ${CYAN}$ip:8899${NC}"
    echo ""
    echo -e "${BOLD}Admin Dashboard:${NC}"
    echo -e "  Open in browser: ${CYAN}http://$ip:3000${NC}"
    echo ""
    echo -e "${BOLD}Mock Server Dashboard:${NC}"
    echo -e "  Open in browser: ${CYAN}http://$ip:4000${NC}"
    echo ""
    echo -e "${BOLD}Health Check:${NC}"
    echo -e "  curl ${CYAN}http://localhost:3000/health${NC}"
    echo ""
    echo -e "${BOLD}API Status:${NC}"
    echo -e "  curl ${CYAN}http://localhost:3000/api/status${NC}"
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "${YELLOW}NETWORKING NOTE:${NC}"
    echo "  Docker automatically handles port forwarding. Scales connect to your"
    echo "  machine's IP ($ip) on port 8899, and Docker routes the traffic to"
    echo "  the container. No special network configuration needed!"
    echo ""
    echo -e "${YELLOW}FIREWALL:${NC}"
    echo "  Make sure your firewall allows incoming connections on:"
    echo "    - Port 8899 (TCP - Scale connections)"
    echo "    - Port 3000 (HTTP - Admin dashboard)"
    echo "    - Port 4000 (HTTP - Mock server, testing only)"
    echo ""
}

# ─────────────────────────────────────────────────────────────────────────────────
# Main commands
# ─────────────────────────────────────────────────────────────────────────────────

cmd_start() {
    print_banner
    check_docker
    check_bun
    
    local ip=$(get_local_ip)
    
    echo -e "${YELLOW}Detected IP Address:${NC} ${CYAN}$ip${NC}"
    echo ""
    
    # Check if mock server is already running
    if is_port_in_use 4000; then
        echo -e "${GREEN}✓ Mock server already running on port 4000${NC}"
    else
        echo -e "${YELLOW}Starting mock REST server in background...${NC}"
        # Start mock server in background
        nohup bun run src/cloud/mock-rest-server.ts > /tmp/carnitrack-mock-server.log 2>&1 &
        MOCK_PID=$!
        echo $MOCK_PID > /tmp/carnitrack-mock-server.pid
        sleep 2
        
        if is_port_in_use 4000; then
            echo -e "${GREEN}✓ Mock server started (PID: $MOCK_PID)${NC}"
        else
            echo -e "${RED}✗ Failed to start mock server${NC}"
            echo "Check logs: cat /tmp/carnitrack-mock-server.log"
            exit 1
        fi
    fi
    
    echo ""
    
    # Check if Edge container is already running
    if docker ps --format '{{.Names}}' | grep -q "carnitrack-edge-test"; then
        echo -e "${GREEN}✓ Edge container already running${NC}"
    else
        echo -e "${YELLOW}Building and starting Edge container...${NC}"
        HOST_IP="$ip" docker compose -f docker-compose.test.yml up -d --build
        
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}✓ Edge container started${NC}"
        else
            echo -e "${RED}✗ Failed to start Edge container${NC}"
            exit 1
        fi
    fi
    
    echo ""
    
    # Wait for health check
    echo -e "${YELLOW}Waiting for Edge service to be healthy...${NC}"
    for i in {1..30}; do
        if curl -s http://localhost:3000/health > /dev/null 2>&1; then
            echo -e "${GREEN}✓ Edge service is healthy!${NC}"
            break
        fi
        sleep 1
        echo -n "."
    done
    echo ""
    
    show_network_info
    
    echo -e "${GREEN}${BOLD}Everything is running!${NC}"
    echo ""
    echo -e "View logs:        ${CYAN}$0 logs${NC}"
    echo -e "Check status:     ${CYAN}$0 status${NC}"
    echo -e "Stop everything:  ${CYAN}$0 stop${NC}"
    echo ""
}

cmd_stop() {
    echo -e "${YELLOW}Stopping services...${NC}"
    
    # Stop Docker container
    if docker ps --format '{{.Names}}' | grep -q "carnitrack-edge-test"; then
        echo -e "${YELLOW}Stopping Edge container...${NC}"
        docker compose -f docker-compose.test.yml down
        echo -e "${GREEN}✓ Edge container stopped${NC}"
    else
        echo -e "${BLUE}Edge container not running${NC}"
    fi
    
    # Stop mock server
    if [ -f /tmp/carnitrack-mock-server.pid ]; then
        MOCK_PID=$(cat /tmp/carnitrack-mock-server.pid)
        if ps -p $MOCK_PID > /dev/null 2>&1; then
            echo -e "${YELLOW}Stopping mock server (PID: $MOCK_PID)...${NC}"
            kill $MOCK_PID 2>/dev/null || true
            rm -f /tmp/carnitrack-mock-server.pid
            echo -e "${GREEN}✓ Mock server stopped${NC}"
        fi
    fi
    
    # Also try to kill any bun process running mock-rest-server
    pkill -f "mock-rest-server" 2>/dev/null || true
    
    echo ""
    echo -e "${GREEN}All services stopped${NC}"
    echo -e "${BLUE}Note: Data is preserved in Docker volumes${NC}"
}

cmd_restart() {
    cmd_stop
    echo ""
    sleep 2
    cmd_start
}

cmd_logs() {
    echo -e "${YELLOW}Following Edge container logs (Ctrl+C to stop)...${NC}"
    docker compose -f docker-compose.test.yml logs -f
}

cmd_status() {
    local ip=$(get_local_ip)
    
    echo ""
    echo -e "${BOLD}Service Status:${NC}"
    echo "─────────────────────────────────────────────────────────"
    
    # Check mock server
    if is_port_in_use 4000; then
        echo -e "Mock Server (port 4000):    ${GREEN}● Running${NC}"
    else
        echo -e "Mock Server (port 4000):    ${RED}○ Stopped${NC}"
    fi
    
    # Check Docker container
    if docker ps --format '{{.Names}}' | grep -q "carnitrack-edge-test"; then
        local container_status=$(docker inspect --format='{{.State.Health.Status}}' carnitrack-edge-test 2>/dev/null || echo "unknown")
        if [ "$container_status" = "healthy" ]; then
            echo -e "Edge Container:             ${GREEN}● Running (healthy)${NC}"
        else
            echo -e "Edge Container:             ${YELLOW}● Running ($container_status)${NC}"
        fi
    else
        echo -e "Edge Container:             ${RED}○ Stopped${NC}"
    fi
    
    # Check TCP port
    if is_port_in_use 8899; then
        echo -e "TCP Server (port 8899):     ${GREEN}● Listening${NC}"
    else
        echo -e "TCP Server (port 8899):     ${RED}○ Not listening${NC}"
    fi
    
    # Check HTTP port
    if is_port_in_use 3000; then
        echo -e "HTTP Server (port 3000):    ${GREEN}● Listening${NC}"
    else
        echo -e "HTTP Server (port 3000):    ${RED}○ Not listening${NC}"
    fi
    
    echo "─────────────────────────────────────────────────────────"
    echo ""
    
    # Show health check if running
    if is_port_in_use 3000; then
        echo -e "${BOLD}Health Check:${NC}"
        curl -s http://localhost:3000/health 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "Could not fetch health"
        echo ""
    fi
    
    # Show quick info
    echo -e "${BOLD}Connection Info:${NC}"
    echo -e "  Scales connect to: ${CYAN}$ip:8899${NC}"
    echo -e "  Admin Dashboard:   ${CYAN}http://$ip:3000${NC}"
    echo ""
}

cmd_mock() {
    check_bun
    echo -e "${YELLOW}Starting Mock REST Server (Ctrl+C to stop)...${NC}"
    echo ""
    bun run src/cloud/mock-rest-server.ts
}

cmd_edge() {
    check_docker
    
    local ip=$(get_local_ip)
    
    if ! is_port_in_use 4000; then
        echo -e "${YELLOW}Warning: Mock server not running on port 4000${NC}"
        echo "Edge will start in offline mode. Start mock server with: $0 mock"
        echo ""
    fi
    
    echo -e "${YELLOW}Starting Edge container with IP: $ip${NC}"
    HOST_IP="$ip" docker compose -f docker-compose.test.yml up -d --build
    
    echo ""
    echo -e "${GREEN}Edge container started!${NC}"
    echo -e "View logs: ${CYAN}$0 logs${NC}"
}

cmd_build() {
    check_docker
    echo -e "${YELLOW}Building Docker image...${NC}"
    docker compose -f docker-compose.test.yml build
    echo -e "${GREEN}✓ Build complete${NC}"
}

cmd_clean() {
    echo -e "${YELLOW}Cleaning up Docker resources...${NC}"
    
    # Stop containers
    docker compose -f docker-compose.test.yml down -v --remove-orphans 2>/dev/null || true
    
    # Remove volumes
    echo -e "${YELLOW}Removing volumes...${NC}"
    docker volume rm carnitrack-edge-data carnitrack-edge-logs carnitrack-edge-generated 2>/dev/null || true
    
    # Stop mock server
    pkill -f "mock-rest-server" 2>/dev/null || true
    rm -f /tmp/carnitrack-mock-server.pid /tmp/carnitrack-mock-server.log
    
    echo -e "${GREEN}✓ Cleanup complete${NC}"
    echo -e "${RED}Warning: All data has been deleted!${NC}"
}

cmd_shell() {
    if ! docker ps --format '{{.Names}}' | grep -q "carnitrack-edge-test"; then
        echo -e "${RED}Edge container is not running${NC}"
        echo "Start it with: $0 start"
        exit 1
    fi
    
    echo -e "${YELLOW}Opening shell in Edge container...${NC}"
    docker exec -it carnitrack-edge-test /bin/sh
}

cmd_backup() {
    if ! docker ps --format '{{.Names}}' | grep -q "carnitrack-edge-test"; then
        echo -e "${RED}Edge container is not running${NC}"
        echo "Start it with: $0 start"
        exit 1
    fi
    
    local backup_file="backup-$(date +%Y%m%d-%H%M%S).db"
    echo -e "${YELLOW}Backing up database to $backup_file...${NC}"
    docker cp carnitrack-edge-test:/app/data/carnitrack.db "./$backup_file"
    echo -e "${GREEN}✓ Database backed up to $backup_file${NC}"
}

cmd_info() {
    show_network_info
}

# ─────────────────────────────────────────────────────────────────────────────────
# Main entry point
# ─────────────────────────────────────────────────────────────────────────────────

case "${1:-help}" in
    start)
        cmd_start
        ;;
    stop)
        cmd_stop
        ;;
    restart)
        cmd_restart
        ;;
    logs)
        cmd_logs
        ;;
    status)
        cmd_status
        ;;
    mock)
        cmd_mock
        ;;
    edge)
        cmd_edge
        ;;
    build)
        cmd_build
        ;;
    clean)
        cmd_clean
        ;;
    shell)
        cmd_shell
        ;;
    backup)
        cmd_backup
        ;;
    info)
        cmd_info
        ;;
    help|--help|-h)
        print_banner
        show_usage
        ;;
    *)
        echo -e "${RED}Unknown command: $1${NC}"
        echo ""
        show_usage
        exit 1
        ;;
esac
