# CarniTrack Edge Service

**Meat Traceability System • DP-401 Scale Integration • Cloud-Centric v3.0**

The Edge service is the on-premise component of CarniTrack that runs at meat processing facilities. It connects to DP-401 industrial scales, captures weighing events, and streams them to the Cloud in real-time. Sessions are managed by the Cloud, not the Edge.

## 🏗️ Architecture Overview (v3.0 Cloud-Centric)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                                    CARNITRACK v3.0                                    │
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                       │
│   📱 Phone App                    ☁️ Cloud                        🏭 Edge             │
│   ┌─────────────┐                ┌─────────────┐                 ┌─────────────┐     │
│   │  Operator   │    REST/SSE    │   Django    │    WebSocket    │   Bun.js    │     │
│   │  Start/End  │───────────────►│   Postgres  │◄───────────────►│   SQLite    │     │
│   │  Sessions   │◄───────────────│   Session   │                 │   Events    │     │
│   └─────────────┘                │   Manager   │                 └──────┬──────┘     │
│                                  └─────────────┘                        │TCP         │
│                                         │                               │            │
│                                         │ Push Session                  ▼            │
│                                         └─────────────────────►   ┌─────────┐        │
│                                                                   │ SCALE-01│        │
│   Key: Edge does NOT manage sessions                              │ SCALE-02│        │
│        Cloud is source of truth                                   │ SCALE-03│        │
│        Edge caches sessions for offline                           └─────────┘        │
│                                                                                       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## ✨ Features

| Feature | Description |
|---------|-------------|
| **📡 TCP Server** | Accepts connections from DP-401 scales via WiFi module |
| **❤️ Health Monitoring** | Hardware heartbeat tracking (HB every 30s) |
| **📝 Device Registration** | Auto-identification via SCALE-XX packets |
| **⚖️ Event Capture** | Real-time weight event parsing and storage |
| **🔄 WebSocket Streaming** | Real-time events to Cloud (2-3 sec latency) |
| **📴 Offline Resilience** | Batch events when Cloud unreachable |
| **🔗 Session Cache** | Cloud sessions cached locally |
| **🛠️ Admin Dashboard** | Minimal UI for debugging/monitoring |

## 🚀 Quick Start

### Option 1: Docker (Recommended)

```bash
# Clone the repository
git clone https://github.com/KKBalta/carnitrack-edge.git
cd carnitrack-edge

# Copy and configure environment
cp .env.example .env
# Edit .env with your site details

# Start with Docker Compose
docker compose up -d

# View logs
docker compose logs -f carnitrack-edge
```

### Option 2: Local Development

```bash
# Clone the repository
git clone https://github.com/KKBalta/carnitrack-edge.git
cd carnitrack-edge

# Install dependencies
bun install

# Start development server
bun run dev
```

## 🐳 Docker Deployment

### Build and Run

```bash
# Build the image
docker build -t carnitrack-edge .

# Run with environment variables
docker run -d \
  --name carnitrack-edge \
  -p 3000:3000 \
  -p 3001:3001 \
  -v carnitrack-data:/app/data \
  -e EDGE_SITE_ID=site-001 \
  -e EDGE_SITE_NAME="Main Facility" \
  -e CLOUD_WS_URL=wss://api.carnitrack.cloud/edge/ws \
  -e CLOUD_API_KEY=your-api-key \
  carnitrack-edge
```

### Docker Compose (Recommended)

```bash
# Start services
docker compose up -d

# Stop services
docker compose down

# View logs
docker compose logs -f

# Restart after config change
docker compose up -d --force-recreate
```

### Persistent Data

Data is stored in Docker volumes:
- `carnitrack-edge-data` - SQLite database (CRITICAL)
- `carnitrack-edge-logs` - Application logs
- `carnitrack-edge-generated` - Generated PLU files

```bash
# Backup database
docker run --rm -v carnitrack-edge-data:/data -v $(pwd):/backup alpine \
  cp /data/carnitrack.db /backup/carnitrack-backup.db

# List volumes
docker volume ls | grep carnitrack
```

## ⚙️ Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| **Edge Identity** |
| `EDGE_SITE_ID` | - | Site ID (required for registration) |
| `EDGE_SITE_NAME` | - | Human-readable site name |
| **Cloud Connection** |
| `CLOUD_WS_URL` | `wss://api.carnitrack.cloud/edge/ws` | WebSocket endpoint |
| `CLOUD_API_URL` | `https://api.carnitrack.cloud` | REST API endpoint |
| `CLOUD_API_KEY` | - | API key for authentication |
| **Servers** |
| `TCP_PORT` | `3001` | Port for scale connections |
| `HTTP_PORT` | `3000` | Port for admin dashboard |
| **Database** |
| `DATABASE_PATH` | `./data/carnitrack.db` | SQLite database path |
| **Logging** |
| `LOG_LEVEL` | `info` | debug, info, warn, error |

## 🔌 Scale WiFi Module Configuration

Configure each DP-401 scale's WiFi module:

| Setting | Value | Description |
|---------|-------|-------------|
| Protocol | **TCP-Client** | Scale connects TO edge |
| Server Address | **192.168.1.X** | Edge computer's IP |
| Port | **3001** | Edge TCP server port |
| Register Package Enable | **ON** | Enable device ID |
| Register Package Data | **SCALE-XX** | Unique per device |
| Register Package Send Mode | **link** | Send on connection |
| Heartbeat Interval | **30** | Seconds |
| Heartbeat Data | **HB** | Heartbeat string |

## 📁 Project Structure

```
carnitrack-edge/
├── src/
│   ├── index.ts              # Main entry point
│   ├── config.ts             # Configuration
│   ├── types/                # TypeScript types
│   ├── devices/              # TCP server & device management
│   ├── sessions/             # Session cache (from Cloud)
│   ├── storage/              # SQLite database
│   ├── cloud/                # WebSocket client to Cloud
│   ├── plu/                  # PLU file generation
│   └── api/                  # Admin dashboard API
│
├── data/                     # SQLite database
├── logs/                     # Application logs
├── generated/                # Generated PLU files
│
├── Dockerfile                # Docker image definition
├── docker-compose.yml        # Docker Compose setup
├── package.json
├── tsconfig.json
└── README.md
```

## 🔄 Offline Operation

When Cloud is unreachable:

1. **Events Captured** - Continue capturing scale events
2. **Batch Created** - Events grouped into offline batch
3. **Stored Locally** - SQLite database
4. **Reconnection** - Batch uploaded when online
5. **Reconciliation** - Cloud matches orphaned events to animals

```
┌─────────────────────────────────────────────────────────────┐
│  OFFLINE MODE                                                │
├─────────────────────────────────────────────────────────────┤
│  Cloud Disconnected                                          │
│       ↓                                                      │
│  Create Offline Batch (batch_id: uuid)                       │
│       ↓                                                      │
│  Events → offline_batches table                              │
│       ↓                                                      │
│  Cloud Reconnected                                           │
│       ↓                                                      │
│  Upload batch → Cloud assigns to sessions                    │
│       ↓                                                      │
│  Mark batch synced                                           │
└─────────────────────────────────────────────────────────────┘
```

## 🛠️ Development

```bash
# Run with hot reload
bun run dev

# Type checking
bun run typecheck

# Database setup
bun run db:setup

# Run tests
bun test
```

## 📊 Admin Dashboard

Access at `http://localhost:3000`

- **Status** - Edge health, Cloud connection status
- **Devices** - Connected scales, heartbeat status
- **Events** - Recent events, sync status
- **Sessions** - Active sessions (cached from Cloud)
- **Database** - SQLite browser for debugging

## ☁️ Cloud Integration

### Documentation

- **[Cloud Integration Guide](CLOUD_INTEGRATION.md)** - Complete guide for integrating Edge with Cloud application
- **[Quick Reference](CLOUD_INTEGRATION_QUICKREF.md)** - Quick reference for common integration patterns

### Key Integration Points

1. **WebSocket Connection** - Edge connects to Cloud via WebSocket (`ws://your-cloud/edge`)
2. **Message Protocol** - Bidirectional message protocol for events, sessions, devices
3. **Session Management** - Cloud manages sessions, Edge caches for offline use
4. **Event Streaming** - Real-time event streaming with acknowledgments
5. **Offline Batches** - Automatic batch creation and reconciliation

### Quick Start for Cloud Developers

1. Set up WebSocket server on `/edge` endpoint
2. Handle Edge registration (`register` message)
3. Send active sessions on connection (`session_started` messages)
4. Process events (`event` messages) and acknowledge (`event_ack`)
5. Manage sessions (`session_started`, `session_ended`)
6. Handle offline batches (`offline_batch_end`)

See [CLOUD_INTEGRATION.md](CLOUD_INTEGRATION.md) for detailed implementation guide.

## 📜 License

Proprietary - CarniTrack Team
