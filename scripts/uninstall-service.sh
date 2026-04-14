#!/bin/bash
# CarniTrack Edge — Linux systemd Service Uninstaller
# Run with: sudo bash uninstall-service.sh

set -e

SERVICE_FILE="/etc/systemd/system/carnitrack-edge.service"

if [ "$(id -u)" -ne 0 ]; then
    echo ""
    echo "  ERROR: This script must be run as root (use sudo)."
    echo ""
    exit 1
fi

if [ ! -f "$SERVICE_FILE" ]; then
    echo ""
    echo "  Service carnitrack-edge is not installed."
    echo ""
    exit 0
fi

echo ""
echo "  Stopping CarniTrack Edge service..."
systemctl stop carnitrack-edge.service 2>/dev/null || true
systemctl disable carnitrack-edge.service 2>/dev/null || true

rm -f "$SERVICE_FILE"
systemctl daemon-reload

echo ""
echo "  CarniTrack Edge service has been removed."
echo "  Application files are still on disk."
echo ""
