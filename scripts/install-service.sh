#!/bin/bash
# CarniTrack Edge — Linux systemd Service Installer
# Run with: sudo bash install-service.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EDGE_BIN="$SCRIPT_DIR/carnitrack-edge"
SERVICE_FILE="/etc/systemd/system/carnitrack-edge.service"

if [ "$(id -u)" -ne 0 ]; then
    echo ""
    echo "  ERROR: This script must be run as root (use sudo)."
    echo ""
    exit 1
fi

if [ ! -f "$EDGE_BIN" ]; then
    echo ""
    echo "  ERROR: carnitrack-edge binary not found in $SCRIPT_DIR"
    echo "  Make sure this script is in the same folder as the binary."
    echo ""
    exit 1
fi

chmod +x "$EDGE_BIN"

mkdir -p "$SCRIPT_DIR/data" "$SCRIPT_DIR/logs" "$SCRIPT_DIR/generated"

echo ""
echo "  ========================================================"
echo "   CarniTrack Edge — Installing systemd Service"
echo "  ========================================================"
echo ""
echo "   Binary:      $EDGE_BIN"
echo "   Service:     carnitrack-edge.service"
echo "   Start Type:  Automatic (after network)"
echo ""

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=CarniTrack Edge Service
Documentation=https://github.com/carnitrack/edge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$EDGE_BIN
WorkingDirectory=$SCRIPT_DIR
Restart=always
RestartSec=5
StandardOutput=append:$SCRIPT_DIR/logs/service.log
StandardError=append:$SCRIPT_DIR/logs/service-error.log

# Resource limits
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable carnitrack-edge.service
systemctl start carnitrack-edge.service

echo ""
echo "  ========================================================"
echo "   SUCCESS!"
echo "  ========================================================"
echo ""
echo "   CarniTrack Edge is now running as a systemd service."
echo "   It will start automatically on boot."
echo ""
echo "   Dashboard:  http://localhost:3000"
echo ""
echo "   Useful commands:"
echo "     Status:    sudo systemctl status carnitrack-edge"
echo "     Logs:      sudo journalctl -u carnitrack-edge -f"
echo "     Stop:      sudo systemctl stop carnitrack-edge"
echo "     Restart:   sudo systemctl restart carnitrack-edge"
echo "     Uninstall: sudo bash $SCRIPT_DIR/uninstall-service.sh"
echo ""
