#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# Start Mock REST Server
# ═══════════════════════════════════════════════════════════════════════════════
# 
# This script starts the mock REST server on your host machine.
# The Edge service running in Docker will connect to it via host.docker.internal
#
# Usage:
#   ./scripts/start-mock-server.sh
#
# The server will run on port 4000 by default.
# To change the port, set MOCK_REST_PORT environment variable:
#   MOCK_REST_PORT=5000 ./scripts/start-mock-server.sh
#
# ═══════════════════════════════════════════════════════════════════════════════

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

PORT=${MOCK_REST_PORT:-4000}
HOST=${MOCK_REST_HOST:-0.0.0.0}

echo -e "${BLUE}═══════════════════════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  CarniTrack Mock REST Server${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}Starting mock server on ${HOST}:${PORT}...${NC}"
echo ""
echo -e "${BLUE}The Edge service in Docker should connect to:${NC}"
echo -e "  ${GREEN}http://host.docker.internal:${PORT}/api/v1/edge${NC}"
echo ""
echo -e "${BLUE}To use this URL, set in your docker-compose.yml or .env:${NC}"
echo -e "  ${GREEN}CLOUD_API_URL=http://host.docker.internal:${PORT}/api/v1/edge${NC}"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop the server${NC}"
echo ""

# Check if port is already in use
if lsof -Pi :${PORT} -sTCP:LISTEN -t >/dev/null 2>&1 ; then
    echo -e "${RED}Error: Port ${PORT} is already in use${NC}"
    echo -e "${YELLOW}To use a different port, run:${NC}"
    echo -e "  ${GREEN}MOCK_REST_PORT=5000 ./scripts/start-mock-server.sh${NC}"
    exit 1
fi

# Start the mock server
bun run src/cloud/mock-rest-server.ts
