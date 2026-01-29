# CarniTrack Edge Service

**Meat Traceability System • DP-401 Scale Integration**

The Edge service is the on-premise component of CarniTrack that runs at the butcher shop or meat processing plant. It connects to DP-401 industrial scales, captures weighing events, manages sessions linking events to animals, and syncs data to the cloud.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              CARNITRACK EDGE                                     │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│   DP-401 Scales                      Edge Service                  Cloud        │
│   ┌─────────┐                        ┌─────────────┐              ┌─────────┐   │
│   │ SCALE-01│──┐                     │             │              │         │   │
│   └─────────┘  │    TCP :8899        │  Bun.js     │    HTTPS     │ Django  │   │
│   ┌─────────┐  ├────────────────────►│  SQLite     │─────────────►│ Postgres│   │
│   │ SCALE-02│──┤    (WiFi Module)    │  Web UI     │              │         │   │
│   └─────────┘  │                     │             │              └─────────┘   │
│   ┌─────────┐  │                     └─────────────┘                            │
│   │ SCALE-03│──┘                           │                                    │
│   └─────────┘                              │                                    │
│                                            ▼                                    │
│                                     http://localhost:3000                       │
│                                     (Operator Web UI)                           │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Features

- **📡 TCP Server** - Accepts connections from DP-401 scales via WiFi module
- **❤️ Health Monitoring** - Hardware heartbeat tracking (HB every 30s)
- **📝 Registration Packets** - Device auto-identification (SCALE-XX)
- **⚖️ Event Capture** - Real-time weight event parsing and storage
- **🔗 Session Management** - Link events to animals for traceability
- **💾 Offline-First** - SQLite buffer for unreliable connectivity
- **☁️ Cloud Sync** - Batch upload to Django backend
- **🖥️ Web UI** - Operator dashboard for session management

## Prerequisites

- [Bun](https://bun.sh) >= 1.0.0
- DP-401 scales with WiFi modules configured as TCP clients

## Quick Start

```bash
# Install dependencies
bun install

# Start the service
bun run dev

# Or in production
bun run start
```

The service will start:
- **TCP Server** on port `8899` (for scale connections)
- **HTTP Server** on port `3000` (for web UI)

## Configuration

Configuration is via environment variables or `src/config.ts`:

| Variable | Default | Description |
|----------|---------|-------------|
| `TCP_PORT` | `8899` | Port for scale TCP connections |
| `TCP_HOST` | `0.0.0.0` | Host to bind TCP server |
| `HTTP_PORT` | `3000` | Port for web UI and API |
| `HTTP_HOST` | `0.0.0.0` | Host to bind HTTP server |
| `DB_PATH` | `./data/carnitrack.db` | SQLite database path |
| `LOG_LEVEL` | `info` | Logging level (debug, info, warn, error) |
| `CLOUD_API_URL` | - | Cloud API base URL |
| `CLOUD_API_KEY` | - | Site API key for authentication |

## Scale WiFi Module Configuration

Each DP-401 scale's WiFi module must be configured to connect to the Edge server:

| Setting | Value | Description |
|---------|-------|-------------|
| Protocol | **TCP-Client** | Scale connects TO edge |
| Server Address | **192.168.1.X** | Edge computer's IP |
| Port | **8899** | Edge TCP server port |
| Register Package Enable | **ON** | Enable device ID |
| Register Package Data | **SCALE-XX** | Unique per device (e.g., SCALE-01) |
| Register Package Send Mode | **link** | Send on connection |
| Heartbeat Interval | **30** | Seconds |
| Heartbeat Data | **HB** | Heartbeat string |

## Project Structure

```
carnitrack-edge/
├── src/
│   ├── index.ts              # Main entry point
│   ├── config.ts             # Configuration
│   ├── types/                # TypeScript type definitions
│   │   └── index.ts
│   │
│   ├── devices/              # Device management
│   │   ├── manager.ts        # DeviceManager class
│   │   ├── connection.ts     # TCP connection handling
│   │   └── parser.ts         # Event parsing
│   │
│   ├── sessions/             # Session management
│   │   ├── manager.ts        # SessionManager class
│   │   └── types.ts          # Session types
│   │
│   ├── storage/              # Data persistence
│   │   ├── database.ts       # SQLite setup
│   │   ├── events.ts         # Event repository
│   │   ├── sessions.ts       # Session repository
│   │   └── sync-queue.ts     # Offline sync queue
│   │
│   ├── cloud/                # Cloud synchronization
│   │   ├── client.ts         # Cloud API client
│   │   ├── sync.ts           # Sync service
│   │   └── auth.ts           # Authentication
│   │
│   ├── plu/                  # PLU file generation
│   │   ├── generator.ts      # Generate plu.txt
│   │   ├── parser.ts         # Parse cloud PLU
│   │   └── encoding.ts       # Windows-1254 encoding
│   │
│   ├── api/                  # HTTP API
│   │   ├── server.ts         # Bun.serve setup
│   │   ├── routes/
│   │   └── middleware/
│   │
│   └── ui/                   # Web UI
│       ├── index.html
│       └── assets/
│
├── data/                     # SQLite database
├── generated/                # Generated PLU files
├── logs/                     # Application logs
│
├── package.json
├── tsconfig.json
└── README.md
```

## API Endpoints

### Status & Health

```
GET /health              # Health check
GET /api/status          # System status
```

### Devices

```
GET /api/devices         # List all devices
POST /api/devices        # Register new device
POST /api/devices/:id/reconnect
```

### Sessions

```
GET /api/sessions        # List sessions
GET /api/sessions/active # Active sessions only
POST /api/sessions/start # Start new session
POST /api/sessions/:id/end
```

### Events

```
GET /api/events          # Query events
GET /api/events/stream   # Server-Sent Events (live)
```

### PLU Management

```
GET /api/plu             # View cached PLU catalog
GET /api/plu/status      # Check if update needed
GET /api/plu/generate    # Generate plu.txt file
GET /api/plu/download    # Download generated file
```

## Message Protocol

### Scale → Edge

1. **Registration** (on connect): `SCALE-01\n`
2. **Heartbeat** (every 30s): `HB\n`
3. **Weight Event**: `PLU,TIME,WEIGHT,BARCODE,...\n`

### Edge → Scale

1. **Acknowledgment**: `OK\n`

## Development

```bash
# Run with hot reload
bun run dev

# Type checking
bun run typecheck

# Run tests
bun test
```

## License

Proprietary - CarniTrack Team
