#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# CarniTrack Edge - Docker Testing Script
# ═══════════════════════════════════════════════════════════════════════════════
#
# This script helps test the Edge service in Docker with the mock REST server.
#
# PREREQUISITES:
#   1. Docker and Docker Compose installed
#   2. Bun installed (for running mock server)
#   3. Static IP assigned to your machine (for scales to connect)
#
# ═══════════════════════════════════════════════════════════════════════════════

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo -e "${BLUE}"
echo "╔═══════════════════════════════════════════════════════════════════╗"
echo "║           CarniTrack Edge - Docker Test Environment               ║"
echo "╚═══════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Get machine's IP address
get_ip() {
    # Try different methods to get IP
    IP=$(ifconfig 2>/dev/null | grep "inet " | grep -v "127.0.0.1" | head -1 | awk '{print $2}')
    if [ -z "$IP" ]; then
        IP=$(ip -4 addr show 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | grep -v "127.0.0.1" | head -1)
    fi
    if [ -z "$IP" ]; then
        IP="<could not detect>"
    fi
    echo "$IP"
}

MACHINE_IP=$(get_ip)

show_usage() {
    echo -e "${YELLOW}Usage:${NC}"
    echo "  $0 <command>"
    echo ""
    echo -e "${YELLOW}Commands:${NC}"
    echo "  start       - Build and start Edge in Docker"
    echo "  stop        - Stop Edge container"
    echo "  logs        - Show Edge container logs"
    echo "  status      - Check Edge health and status"
    echo "  build       - Build Docker image only"
    echo "  mock        - Start mock REST server (run in separate terminal)"
    echo "  info        - Show network and connection info"
    echo "  backup      - Backup SQLite database from container"
    echo "  shell       - Open shell in running container"
    echo ""
    echo -e "${YELLOW}Quick Start:${NC}"
    echo "  1. Terminal 1: $0 mock       # Start mock server"
    echo "  2. Terminal 2: $0 start      # Start Edge in Docker"
    echo "  3. Terminal 2: $0 logs       # Watch logs"
    echo ""
}

show_info() {
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}                     NETWORK INFORMATION                           ${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "${YELLOW}Your Machine IP:${NC} ${BLUE}$MACHINE_IP${NC}"
    echo ""
    echo -e "${YELLOW}Scale Configuration:${NC}"
    echo -e "  Scales should connect to: ${BLUE}$MACHINE_IP:8899${NC}"
    echo ""
    echo -e "${YELLOW}Admin Dashboard:${NC}"
    echo -e "  Access at: ${BLUE}http://$MACHINE_IP:3000${NC}"
    echo -e "  Or local:  ${BLUE}http://localhost:3000${NC}"
    echo ""
    echo -e "${YELLOW}Mock Server Dashboard:${NC}"
    echo -e "  Access at: ${BLUE}http://$MACHINE_IP:4000${NC}"
    echo -e "  Or local:  ${BLUE}http://localhost:4000${NC}"
    echo ""
    echo -e "${YELLOW}Docker Volumes (Data Persistence):${NC}"
    echo -e "  Database:  carnitrack-edge-data"
    echo -e "  Logs:      carnitrack-edge-logs"
    echo -e "  Generated: carnitrack-edge-generated"
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════════${NC}"
}

case "${1:-}" in
    start)
        echo -e "${YELLOW}Building and starting Edge in Docker...${NC}"
        docker compose -f docker-compose.test.yml up -d --build
        echo ""
        echo -e "${GREEN}✓ Edge container started!${NC}"
        echo ""
        show_info
        echo -e "${YELLOW}View logs:${NC} $0 logs"
        ;;
    
    stop)
        echo -e "${YELLOW}Stopping Edge container...${NC}"
        docker compose -f docker-compose.test.yml down
        echo -e "${GREEN}✓ Container stopped${NC}"
        echo -e "${BLUE}Note: Data is preserved in Docker volumes${NC}"
        ;;
    
    logs)
        echo -e "${YELLOW}Following Edge container logs (Ctrl+C to stop)...${NC}"
        docker compose -f docker-compose.test.yml logs -f
        ;;
    
    status)
        echo -e "${YELLOW}Checking Edge status...${NC}"
        echo ""
        echo -e "${BLUE}Container status:${NC}"
        docker compose -f docker-compose.test.yml ps
        echo ""
        echo -e "${BLUE}Health check:${NC}"
        curl -s http://localhost:3000/health | python3 -m json.tool 2>/dev/null || curl -s http://localhost:3000/health
        echo ""
        ;;
    
    build)
        echo -e "${YELLOW}Building Docker image...${NC}"
        docker compose -f docker-compose.test.yml build
        echo -e "${GREEN}✓ Build complete${NC}"
        ;;
    
    mock)
        echo -e "${YELLOW}Starting Mock REST Server...${NC}"
        echo -e "${BLUE}Press Ctrl+C to stop${NC}"
        echo ""
        bun run src/cloud/mock-rest-server.ts
        ;;
    
    info)
        show_info
        ;;
    
    backup)
        BACKUP_FILE="backup-$(date +%Y%m%d-%H%M%S).db"
        echo -e "${YELLOW}Backing up database to $BACKUP_FILE...${NC}"
        docker cp carnitrack-edge-test:/app/data/carnitrack.db "./$BACKUP_FILE"
        echo -e "${GREEN}✓ Database backed up to $BACKUP_FILE${NC}"
        ;;
    
    shell)
        echo -e "${YELLOW}Opening shell in Edge container...${NC}"
        docker exec -it carnitrack-edge-test /bin/sh
        ;;
    
    *)
        show_usage
        ;;
esac
