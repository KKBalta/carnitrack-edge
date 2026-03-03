# CarniTrack Edge Service

**Meat Traceability System • DP-401 Scale Integration • Cloud-Centric v3.0**

The Edge service is the on-premise component of CarniTrack that runs at meat processing facilities. It connects to DP-401 industrial scales, captures weighing events, and streams them to the Cloud in real-time. Sessions are managed by the Cloud, not the Edge.

**Setup:** Run `bun scripts/create-env.ts` then `./scripts/docker-setup.sh prod`.

## 🏗️ Architecture Overview (v3.0 Cloud-Centric)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                                    CARNITRACK v3.0                                    │
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                       │
│   📱 Phone App                    ☁️ Cloud                        🏭 Edge             │
│   ┌─────────────┐                ┌─────────────┐                 ┌─────────────┐     │
│   │  Operator   │    REST/SSE   │   Backend   │    REST API     │   Bun.js    │     │
│   │  Start/End  │───────────────►│   Postgres  │◄───────────────►│   SQLite    │     │
│   │  Sessions   │◄───────────────│   Session   │   (poll + POST) │   Events    │     │
│   └─────────────┘                │   Manager   │                 └──────┬──────┘     │
│                                  └─────────────┘                        │ TCP :8899  │
│                                         │                               │            │
│                                         │ Sessions (poll)                ▼            │
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
| **🔄 REST Streaming** | Events to Cloud via REST API (batch + real-time POST) |
| **📴 Offline Resilience** | Batch events when Cloud unreachable |
| **🔗 Session Cache** | Cloud sessions cached locally |
| **🛠️ Admin Dashboard** | Minimal UI for debugging/monitoring |

## 🚀 How to Use

**Prerequisites:** [Bun](https://bun.sh) and [Docker](https://www.docker.com/products/docker-desktop).

### 1. Create environment file

Run the env generator with Bun (quick mode asks for `SITE_ID` and `EDGE_NAME`; you can add `REGISTRATION_TOKEN` later):

```bash
bun scripts/create-env.ts
```

Options:
- `bun scripts/create-env.ts --template` — generate template only (no prompts)
- `bun scripts/create-env.ts --full` — full interactive (all variables)
- `bun scripts/create-env.ts -o .env.local` — custom output file
- `bun scripts/create-env.ts -y` — skip overwrite confirmation

### 2. Run with Docker

Use the setup script to build and run everything:

```bash
./scripts/docker-setup.sh prod
```

That’s it. The script uses your `.env`, builds the image, and starts the Edge service in Docker.

**Useful commands:**

| Command | Description |
|--------|-------------|
| `./scripts/docker-setup.sh prod` | Deploy production Edge (uses `.env`) |
| `./scripts/docker-setup.sh prod-stop` | Stop production Edge |
| `./scripts/docker-setup.sh start` | Test mode: mock Cloud + Edge container |
| `./scripts/docker-setup.sh stop` | Stop test services |
| `./scripts/docker-setup.sh status` | Show service status |
| `./scripts/docker-setup.sh logs` | Follow Edge container logs |
| `./scripts/docker-setup.sh env` | Create/edit `.env` (test defaults) |
| `./scripts/docker-setup.sh help` | Show all commands |

### Local development (without Docker)

```bash
bun install
bun run dev
```

## 🐳 Docker Deployment

For normal use, create `.env` with `bun scripts/create-env.ts` then run `./scripts/docker-setup.sh prod`. For manual control:

### Build and Run (manual)

```bash
# After creating .env with: bun scripts/create-env.ts
docker build -t carnitrack-edge .
docker compose up -d
```

### Docker Compose

```bash
# Start (loads .env from project root)
docker compose up -d

# Stop
docker compose down

# View logs
docker compose logs -f carnitrack-edge

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

Environment variables are set in `.env`, created by `bun scripts/create-env.ts`. Main options:

| Variable | Default | Description |
|----------|---------|-------------|
| **Edge Identity** |
| `SITE_ID` | - | Site ID (required for Cloud registration) |
| `EDGE_NAME` | - | Human-readable edge/site name |
| `REGISTRATION_TOKEN` | - | Site registration token (can add later) |
| **Cloud Connection** |
| `CLOUD_API_URL` | (see create-env) | Cloud REST API base URL |
| **Servers** |
| `TCP_PORT` | `8899` | Port for scale connections |
| `HTTP_PORT` | `3000` | Port for admin dashboard |
| **Database** |
| `DB_PATH` | `data/carnitrack.db` | SQLite database path |
| **Logging** |
| `LOG_LEVEL` | `info` | debug, info, warn, error |

## 🔌 Scale WiFi Module Configuration

Configure each DP-401 scale's WiFi module:

| Setting | Value | Description |
|---------|-------|-------------|
| Protocol | **TCP-Client** | Scale connects TO edge |
| Server Address | **192.168.1.X** | Edge computer's IP |
| Port | **8899** | Edge TCP server port (`TCP_PORT`) |
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
│   ├── cloud/                # REST client to Cloud
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

1. **REST API** - Edge connects to Cloud via REST (`CLOUD_API_URL`); no WebSocket.
2. **Registration** - Edge registers with `SITE_ID` and optional `REGISTRATION_TOKEN`.
3. **Session Management** - Cloud manages sessions; Edge polls for active sessions and caches them.
4. **Event Streaming** - Events sent via REST POST; batch upload for offline backlog.
5. **Offline Batches** - Automatic batch creation and reconciliation when Cloud is unreachable.

### Quick Start for Cloud Developers

1. Expose REST API for Edge: registration, sessions (GET), event (POST), batch (POST).
2. Handle Edge registration (site/edge identity).
3. Provide active sessions endpoint for polling.
4. Accept event and batch POSTs; return acknowledgments.
5. Support offline batch upload and reconciliation.

See [CLOUD_INTEGRATION.md](CLOUD_INTEGRATION.md) for detailed implementation guide.

## 📜 License

Proprietary - CarniTrack Team
