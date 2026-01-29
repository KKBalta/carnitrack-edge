# CarniTrack + DP-401 Scalable Architecture v3.0

## ⚡ Architecture Philosophy: Cloud-Centric Design

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    CLOUD-CENTRIC ARCHITECTURE (v3.0)                            │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  KEY PRINCIPLE: Cloud is the source of truth, Edge is a smart relay            │
│                                                                                  │
│  OPERATOR'S PHONE                 EDGE (Bun)                    CLOUD (Django)  │
│  ┌─────────────────┐             ┌─────────────────┐           ┌─────────────┐  │
│  │                 │             │                 │           │             │  │
│  │ Start Session ──┼─────────────┼─────────────────┼──────────►│ Create      │  │
│  │ (Phone App)     │   REST      │                 │ WebSocket │ Session     │  │
│  │                 │             │                 │◄──────────│ Push to     │  │
│  │ View Events ◄───┼─────────────┼─────────────────┼───────────│ Edge        │  │
│  │ (Real-time)     │             │                 │           │             │  │
│  │                 │             │  Capture Events │           │             │  │
│  │ End Session ────┼─────────────┼─────────────────┼──────────►│ Close       │  │
│  │                 │             │  Stream to Cloud│──────────►│ Session     │  │
│  └─────────────────┘             │                 │  (2-3s)   │             │  │
│                                  │  Offline Buffer │           │             │  │
│  ┌─────────────────┐             │  ┌───────────┐  │           │             │  │
│  │ DP-401 Scales   │             │  │ SQLite    │  │           │             │  │
│  │                 │────TCP─────►│  │ - Events  │  │           │             │  │
│  │ SCALE-01        │   :8899     │  │ - Queue   │  │           │             │  │
│  │ SCALE-02        │             │  └───────────┘  │           │             │  │
│  └─────────────────┘             └─────────────────┘           └─────────────┘  │
│                                                                                  │
│  BENEFITS:                                                                       │
│  ✅ Single source of truth (Cloud)                                              │
│  ✅ Sessions controlled via phone app (anywhere)                                │
│  ✅ Real-time event visibility (2-3s latency)                                   │
│  ✅ Offline resilience (events captured even without internet)                  │
│  ✅ Multi-site scalability (one Cloud, many Edges)                              │
│  ✅ Simplified Edge (no complex session state machine)                          │
│  ✅ No local UI needed (minimal admin dashboard only)                           │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Why Cloud-Centric?

| Aspect | Edge-Centric (Old) | Cloud-Centric (New) |
|--------|-------------------|---------------------|
| Session Creation | Local Edge UI | Phone App via Cloud |
| Session State Machine | Complex logic in Edge | Cloud handles all state |
| Event Visibility | Local only, then sync | Real-time in Cloud |
| Operator Experience | Must be at Edge PC | Use phone anywhere at site |
| Multi-Site | Each site independent | Central management |
| Offline | Full operation | Capture events, reconcile later |

---

## 1. Device Reality Check

### DP-401 Characteristics (Important!)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           DP-401 DEVICE ANATOMY                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│    ┌─────────────────────────────────────────────────────────────────────┐      │
│    │                         DP-401 UNIT                                 │      │
│    │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────┐  │      │
│    │  │   SCALE     │  │  EMBEDDED   │  │  THERMAL    │  │   WiFi     │  │      │
│    │  │   SENSOR    │──│  FIRMWARE   │──│  PRINTER    │  │   MODULE   │  │      │
│    │  │             │  │  (ROM/Chip) │  │             │  │  (Rongta)  │  │      │
│    │  └─────────────┘  └──────┬──────┘  └─────────────┘  └─────┬──────┘  │      │
│    │                          │                                 │        │      │
│    │                   ┌──────┴──────┐                  ┌──────┴──────┐  │      │
│    │                   │  USB PORT   │                  │ SERIAL PORT │  │      │
│    │                   │  (Storage)  │                  │ (Data Out)  │  │      │
│    │                   └──────┬──────┘                  └─────────────┘  │      │
│    │                          │                                          │      │
│    └──────────────────────────┼──────────────────────────────────────────┘      │
│                               │                                                 │
│                        ┌──────┴──────┐                                          │
│                        │ USB FLASH   │  ◄── DATA STORAGE ONLY                   │
│                        │ DISK        │      (NOT executable code)               │
│                        │             │                                          │
│                        │ ├─ plu.txt        (Product catalog - text)             │
│                        │ ├─ system.txt     (Operators, text fields)             │
│                        │ ├─ RP80VI_001.bin (Label template - TSPL script)       │
│                        │ └─ t_agirlik.txt  (Weight statistics - runtime log)    │
│                        └─────────────┘                                          │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 Internal Architecture (Deep Dive)

**The DP-401 does NOT run code from the USB flash disk.** Here's what's actually happening:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    WHERE CODE RUNS vs WHERE DATA LIVES                          │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  EMBEDDED FIRMWARE (Internal ROM/Flash on Microcontroller)                      │
│  ════════════════════════════════════════════════════════                       │
│  │                                                                              │
│  │  ┌────────────────────────────────────────────────────────────────────┐     │
│  │  │  Compiled Code (Runs on device boot) - CANNOT BE MODIFIED          │     │
│  │  │                                                                     │     │
│  │  │  • Weight processing logic (load cell → display)                   │     │
│  │  │  • TSPL label interpreter (parses .bin templates)                  │     │
│  │  │  • UI logic (keypad input, LCD display)                            │     │
│  │  │  • File I/O handlers (read plu.txt, write t_agirlik.txt)          │     │
│  │  │  • Serial communication (sends events to WiFi module)              │     │
│  │  │  • Barcode generation                                              │     │
│  │  └────────────────────────────────────────────────────────────────────┘     │
│  │                                                                              │
│  USB FLASH DISK (External Storage - Data Only)                                  │
│  ═════════════════════════════════════════════                                  │
│  │                                                                              │
│  │  ┌────────────────────────────────────────────────────────────────────┐     │
│  │  │  plu.txt - Product database (firmware reads at startup/on-demand)  │     │
│  │  │                                                                     │     │
│  │  │  Format: Fixed-width, tilde-delimited, Windows-1254 encoding       │     │
│  │  │  00001~KIYMA           ~000~0~0000015000~0~...                     │     │
│  │  └────────────────────────────────────────────────────────────────────┘     │
│  │                                                                              │
│  │  ┌────────────────────────────────────────────────────────────────────┐     │
│  │  │  RP80VI_001.bin - Label template (TSPL printer language)           │     │
│  │  └────────────────────────────────────────────────────────────────────┘     │
│  │                                                                              │
│  │  ┌────────────────────────────────────────────────────────────────────┐     │
│  │  │  system.txt - Configuration (operators, text fields)               │     │
│  │  └────────────────────────────────────────────────────────────────────┘     │
│  │                                                                              │
│  │  ┌────────────────────────────────────────────────────────────────────┐     │
│  │  │  t_agirlik.txt - Runtime log (firmware WRITES here)                │     │
│  │  └────────────────────────────────────────────────────────────────────┘     │
│  │                                                                              │
└──┴──────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 WiFi Module Architecture (Critical Understanding)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│              WiFi MODULE IS A SEPARATE COMPONENT (Serial-to-TCP Bridge)         │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│                    DP-401 Internal                      External                 │
│                                                                                  │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐   │
│  │   USB Port  │     │  Firmware   │     │ Serial Port │     │ WiFi Module │   │
│  │             │     │             │     │  (UART)     │     │  (Rongta)   │   │
│  │  ┌───────┐  │     │  Sends      │     │             │     │             │   │
│  │  │ Flash │◄─┼─────│  print      │─────┼─────────────┼────►│ TCP Client  │   │
│  │  │ Disk  │  │     │  events     │     │  TX/RX      │     │ → Edge:8899 │   │
│  │  └───────┘  │     │  via serial │     │  9600 baud  │     │             │   │
│  │             │     │             │     │             │     │  Bridges    │   │
│  │  READS:     │     │             │     │             │     │  serial ↔   │   │
│  │  plu.txt    │     │             │     │             │     │  TCP/IP     │   │
│  │  system.txt │     │             │     │             │     │             │   │
│  │  *.bin      │     │             │     │             │     │  NO ACCESS  │   │
│  │             │     │             │     │             │     │  TO USB!    │   │
│  │  WRITES:    │     │             │     │             │     │             │   │
│  │  t_agirlik  │     │             │     │             │     │             │   │
│  │             │     │             │     │             │     │             │   │
│  └─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘   │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Key Insight:** The WiFi module has NO ACCESS to the USB flash disk. It only bridges
the serial port (which carries print events) to TCP.

### 1.3 WiFi Module Built-in Features (Verified Working!)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    WIFI MODULE HEARTBEAT FEATURES                               │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  REGISTRATION PACKET (Device Identification)                                    │
│  ═══════════════════════════════════════════                                    │
│  • Enable: ON                                                                   │
│  • Data: "SCALE-01" (unique per device)                                        │
│  • Send Mode: "link" (send on connection)                                       │
│                                                                                  │
│  When scale connects to edge → immediately sends "SCALE-01"                    │
│  Edge knows which device connected without waiting for events!                  │
│                                                                                  │
│                                                                                  │
│  HEARTBEAT (Connection Health)                                                  │
│  ═════════════════════════════                                                  │
│  • Interval: 30 seconds                                                         │
│  • Data: "HB"                                                                   │
│                                                                                  │
│  Scale sends "HB" every 30 seconds → Edge confirms device is alive             │
│  Hardware-level, more reliable than software polling!                           │
│                                                                                  │
│                                                                                  │
│  CONNECTION SEQUENCE (Verified):                                                │
│  ═══════════════════════════════                                                │
│                                                                                  │
│  [Scale Power On]                                                               │
│       │                                                                         │
│       ▼                                                                         │
│  [WiFi Module Boots] ──► Connects to configured Edge IP:Port                   │
│       │                                                                         │
│       ▼                                                                         │
│  [TCP Connected] ──► Sends "SCALE-01" (registration packet)                    │
│       │                                                                         │
│       ▼                                                                         │
│  [Every 30s] ──► Sends "HB" (heartbeat)                                        │
│       │                                                                         │
│       ▼                                                                         │
│  [On Print] ──► Sends weight event data                                        │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**WiFi Module Configuration (per scale):**

| Setting | Value | Purpose |
|---------|-------|---------|
| Protocol | TCP-Client | Scale connects TO edge |
| Server Address | 192.168.1.112 | Edge computer IP (static) |
| Port | 8899 | Edge TCP server port |
| Register Package Enable | ON | Enable device ID packet |
| Register Package Data | SCALE-01 | Unique ID per device |
| Register Package Send Mode | link | Send on connection |
| Heartbeat Interval | 30 | Seconds between heartbeats |
| Heartbeat Data | HB | Heartbeat string |

### 1.4 Key Limitations

| Aspect | Reality |
|--------|---------|
| **Program Execution** | Runs from internal ROM/chip, NOT from USB |
| **USB Flash Disk** | Data storage only (plu, templates, logs) |
| **PLU Source** | Firmware reads from USB flash disk at startup |
| **WiFi Module** | Serial-to-TCP bridge only, no USB access |
| **TCP Capability** | Receive print events, send acknowledgments |
| **Programming** | Cannot be modified - closed embedded firmware |

### 1.5 Data Flow Capability

| Direction | Possible? | Method | Notes |
|-----------|-----------|--------|-------|
| Scale → Edge (Events) | ✅ YES | TCP via WiFi module | Working! |
| Edge → Scale (PLU) | ❌ NO via TCP | USB Flash Disk only | WiFi module can't access USB |
| Edge → Scale (Commands) | ⚠️ Limited | Serial commands | ACK works, others unknown |

---

## 2. Device Identification Strategy

### 2.1 Solution: Registration Packet from WiFi Module (VERIFIED!)

The WiFi module sends a **registration packet** immediately when it connects to the edge server.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                 REGISTRATION PACKET DEVICE IDENTIFICATION                        │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  WiFi Module Config (Scale 1):         WiFi Module Config (Scale 2):            │
│  ┌─────────────────────────┐            ┌─────────────────────────┐             │
│  │ Register Package: ON    │            │ Register Package: ON    │             │
│  │ Data: "SCALE-01"        │            │ Data: "SCALE-02"        │             │
│  │ Send Mode: link         │            │ Send Mode: link         │             │
│  └─────────────────────────┘            └─────────────────────────┘             │
│              │                                      │                            │
│              │ TCP Connect                          │ TCP Connect                │
│              ▼                                      ▼                            │
│  First message: "SCALE-01"             First message: "SCALE-02"                │
│              │                                      │                            │
│              └──────────────┬───────────────────────┘                            │
│                             │                                                    │
│                     ┌───────┴───────┐                                           │
│                     │ EDGE SERVER   │                                           │
│                     │ :8899         │                                           │
│                     │               │                                           │
│                     │ Identifies    │                                           │
│                     │ device by     │                                           │
│                     │ REGISTRATION  │                                           │
│                     │ PACKET        │                                           │
│                     └───────────────┘                                           │
│                                                                                  │
│  BENEFITS:                                                                       │
│  ✅ Instant identification on connect                                           │
│  ✅ Survives IP changes (DHCP)                                                  │
│  ✅ Hardware-level, handled by WiFi firmware                                    │
│  ✅ Combined with heartbeat for health monitoring                               │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Connection Architecture: Scales as TCP Clients

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│              SCALES CONNECT TO EDGE (TCP Client Mode) - VERIFIED WORKING        │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  WHY THIS ARCHITECTURE:                                                          │
│  ═════════════════════                                                           │
│  ✅ Edge has ONE fixed IP - scales connect to it                                │
│  ✅ Scale IPs can change freely (DHCP) - doesn't matter                         │
│  ✅ Built-in registration packet → device identification on connect             │
│  ✅ Built-in hardware heartbeat → reliable health monitoring                    │
│  ✅ Scales auto-reconnect if edge restarts                                      │
│  ✅ Simple edge code - just one TCP server listener                             │
│                                                                                  │
│                                                                                  │
│  CONNECTION FLOW:                                                                │
│  ════════════════                                                                │
│                                                                                  │
│  ┌─────────────┐                                                                │
│  │  SCALE-01   │──┐                                                             │
│  │  (any IP)   │  │                                                             │
│  └─────────────┘  │         ┌─────────────────────────────────┐                │
│                   │         │      EDGE TCP SERVER            │                │
│  ┌─────────────┐  ├────────►│      192.168.1.112:8899         │                │
│  │  SCALE-02   │──┤         │                                 │                │
│  │  (any IP)   │  │         │  • Accepts all connections      │                │
│  └─────────────┘  │         │  • Receives "SCALE-XX" on       │                │
│                   │         │    connect (registration)       │                │
│  ┌─────────────┐  │         │  • Receives "HB" every 30s      │                │
│  │  SCALE-03   │──┤         │  • Receives weight events       │                │
│  │  (any IP)   │  │         │                                 │                │
│  └─────────────┘  │         │  Single port handles ALL        │                │
│                   │         │  scales simultaneously          │                │
│  ┌─────────────┐  │         │                                 │                │
│  │  SCALE-04   │──┘         └─────────────────────────────────┘                │
│  │  (any IP)   │                                                               │
│  └─────────────┘                                                               │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. System Architecture (Cloud-Centric)

### 3.1 Component Hierarchy

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              SYSTEM LAYERS                                       │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  LAYER 5: OPERATOR INTERFACE                                                    │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │  Mobile Phone App (React Native / Flutter)                                │  │
│  │  - Start/end sessions (via Cloud API)                                    │  │
│  │  - View real-time events (via Cloud WebSocket/SSE)                       │  │
│  │  - Select animals for session                                            │  │
│  │  - View session history                                                  │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                      ▲                                          │
│                                      │ REST + WebSocket/SSE                     │
│                                      ▼                                          │
│  LAYER 4: CLOUD                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │  Django + PostgreSQL (GCP Cloud Run)                                      │  │
│  │  - Multi-tenant (multiple sites/shops)                                    │  │
│  │  - Animal registry                                                        │  │
│  │  - PLU master catalog                                                     │  │
│  │  - SESSION MANAGEMENT (source of truth)                                   │  │
│  │  - WebSocket hub for real-time communication                              │  │
│  │  - Reports & analytics                                                    │  │
│  │  - User management                                                        │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                      ▲                                          │
│                                      │ WebSocket (bi-directional)               │
│                                      ▼                                          │
│  LAYER 3: EDGE SERVICE (Per Site)                                               │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │  Bun + SQLite (Windows PC / Linux)                                        │  │
│  │  - Device manager (all scales)                                            │  │
│  │  - Event capture & buffering                                              │  │
│  │  - Receive session assignments from Cloud                                 │  │
│  │  - Stream events to Cloud (real-time)                                     │  │
│  │  - Offline resilience (orphaned events)                                   │  │
│  │  - PLU file generator (for USB)                                           │  │
│  │  - Minimal admin dashboard (SQL viewer)                                   │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                      ▲                                          │
│                                      │ TCP :8899                                │
│                                      ▼                                          │
│  LAYER 2: NETWORK (WiFi Modules - TCP Clients)                                  │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │  Serial-to-TCP bridges (READ ONLY - cannot write to USB)                  │  │
│  │  - All configured as TCP-Client → connect to Edge:8899                    │  │
│  │  - Registration packet identifies device on connect                       │  │
│  │  - Hardware heartbeat every 30 seconds                                    │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                      ▲                                          │
│                                      │ Serial                                   │
│                                      ▼                                          │
│  LAYER 1: DEVICES (DP-401 Units)                                                │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │  Embedded scale/printer units                                             │  │
│  │  - Read PLU from USB flash (at boot)                                      │  │
│  │  - Weigh products                                                         │  │
│  │  - Print labels                                                           │  │
│  │  - Send events via serial                                                 │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Edge Service Architecture (Cloud-Centric)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    EDGE SERVICE (Bun) - CLOUD-CENTRIC                           │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                    TCP SERVER (Bun.listen :8899)                         │    │
│  │                                                                          │    │
│  │  Accepts all incoming connections from scales                            │    │
│  │  • On connect: Wait for registration packet ("SCALE-XX")                 │    │
│  │  • On "HB": Update heartbeat timestamp, report to Cloud                  │    │
│  │  • On event: Parse, tag with session, store, stream to Cloud            │    │
│  │  • On disconnect: Mark device disconnected, notify Cloud                 │    │
│  │                                                                          │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                      │                                          │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                    CLOUD SYNC CLIENT (WebSocket)                         │    │
│  │                                                                          │    │
│  │  Maintains persistent WebSocket connection to Cloud                      │    │
│  │                                                                          │    │
│  │  RECEIVES FROM CLOUD:                    SENDS TO CLOUD:                 │    │
│  │  ┌─────────────────────┐                ┌─────────────────────┐         │    │
│  │  │ • session_started   │                │ • event (real-time) │         │    │
│  │  │ • session_ended     │                │ • device_status     │         │    │
│  │  │ • plu_updated       │                │ • heartbeat_status  │         │    │
│  │  │ • config_update     │                │ • sync_request      │         │    │
│  │  └─────────────────────┘                └─────────────────────┘         │    │
│  │                                                                          │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                      │                                          │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                           MAIN PROCESS                                   │    │
│  │                                                                          │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │    │
│  │  │  DEVICE      │  │  SESSION     │  │   EVENT      │  │  OFFLINE   │  │    │
│  │  │  MANAGER     │  │  CACHE       │  │   ROUTER     │  │  HANDLER   │  │    │
│  │  │              │  │              │  │              │  │            │  │    │
│  │  │ - Track HB   │  │ - Cache from │  │ - Parse      │  │ - Detect   │  │    │
│  │  │ - Track conn │  │   Cloud      │  │ - Tag with   │  │   offline  │  │    │
│  │  │ - Status     │  │ - Lookup     │  │   session    │  │ - Batch    │  │    │
│  │  │ - Report     │  │   device →   │  │ - Store      │  │   orphaned │  │    │
│  │  │   to Cloud   │  │   session    │  │ - Stream     │  │ - Sync on  │  │    │
│  │  │              │  │              │  │              │  │   reconnect│  │    │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘  │    │
│  │         │                 │                 │                 │         │    │
│  │         └─────────────────┴─────────────────┴─────────────────┘         │    │
│  │                                    │                                    │    │
│  │                            ┌───────┴───────┐                           │    │
│  │                            │   SQLite DB   │                           │    │
│  │                            │               │                           │    │
│  │                            │ - devices     │                           │    │
│  │                            │ - events      │                           │    │
│  │                            │ - sessions    │  (cache from Cloud)       │    │
│  │                            │ - offline_    │                           │    │
│  │                            │   batches     │                           │    │
│  │                            │ - plu_cache   │                           │    │
│  │                            └───────────────┘                           │    │
│  │                                                                          │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                    MINIMAL ADMIN DASHBOARD (Bun.serve :3000)             │    │
│  │                                                                          │    │
│  │  http://localhost:3000/admin                                             │    │
│  │                                                                          │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │    │
│  │  │  Status      │  │  Devices     │  │  Events      │  │  SQL       │  │    │
│  │  │              │  │              │  │  Log         │  │  Viewer    │  │    │
│  │  │ - Cloud conn │  │ - Online     │  │ - Recent     │  │ - Query    │  │    │
│  │  │ - Pending    │  │ - Heartbeats │  │ - Orphaned   │  │   tables   │  │    │
│  │  │   sync       │  │ - Status     │  │ - Pending    │  │ - Debug    │  │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘  └────────────┘  │    │
│  │                                                                          │    │
│  │  NOTE: NO session management here - Cloud only!                          │    │
│  │                                                                          │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Edge Responsibilities (Cloud-Centric)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    EDGE SERVICE RESPONSIBILITIES                                │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ✅ CORE (Always):                                                              │
│  ─────────────────                                                              │
│  • TCP Server on :8899 - accept scale connections                              │
│  • Parse registration packets ("SCALE-XX")                                      │
│  • Track heartbeats ("HB" every 30s)                                           │
│  • Parse weight events                                                          │
│  • Store ALL events in SQLite (offline resilience)                             │
│  • Report device status to Cloud                                               │
│                                                                                  │
│  ✅ WHEN ONLINE:                                                                │
│  ────────────────                                                               │
│  • Maintain WebSocket connection to Cloud                                       │
│  • Receive session assignments (Cloud → Edge)                                  │
│  • Cache active sessions locally                                               │
│  • Tag events with session_id                                                  │
│  • Stream events to Cloud (2-3s latency)                                       │
│                                                                                  │
│  ✅ WHEN OFFLINE:                                                               │
│  ─────────────────                                                              │
│  • Detect Cloud unreachable                                                    │
│  • Continue capturing events (session_id = NULL)                               │
│  • Group orphaned events by offline_batch_id                                   │
│  • Queue for sync when back online                                             │
│                                                                                  │
│  ✅ ON RECONNECTION:                                                            │
│  ───────────────────                                                            │
│  • Upload all pending/orphaned events to Cloud                                 │
│  • Receive current session state from Cloud                                    │
│  • Resume normal operation                                                     │
│                                                                                  │
│  ⚠️ MINIMAL ADMIN UI:                                                          │
│  ─────────────────────                                                          │
│  • /admin - Status overview                                                    │
│  • /admin/devices - Device status                                              │
│  • /admin/events - Recent events log                                           │
│  • /admin/sql - SQLite viewer (debug)                                          │
│  • NO session management (Cloud only)                                          │
│                                                                                  │
│  ❌ NOT RESPONSIBLE FOR:                                                        │
│  ────────────────────────                                                       │
│  • Session creation/management (Cloud does this)                               │
│  • Animal registry (Cloud does this)                                           │
│  • User authentication (Cloud does this)                                       │
│  • Full operator UI (Phone app via Cloud)                                      │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Cloud ↔ Edge Communication

### 4.1 WebSocket Protocol

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    WEBSOCKET COMMUNICATION PROTOCOL                             │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  CONNECTION ESTABLISHMENT:                                                       │
│  ═════════════════════════                                                       │
│                                                                                  │
│  Edge                                           Cloud                            │
│    │                                              │                             │
│    │──── WSS Connect ────────────────────────────►│                             │
│    │     wss://carnitrack.app/edge/ws             │                             │
│    │     Authorization: Bearer {jwt}              │                             │
│    │     X-Edge-ID: edge-001                      │                             │
│    │                                              │                             │
│    │◄─── Connection Accepted ─────────────────────│                             │
│    │                                              │                             │
│    │◄─── initial_state ──────────────────────────│                             │
│    │     {                                        │                             │
│    │       "type": "initial_state",              │                             │
│    │       "active_sessions": [...],              │                             │
│    │       "devices": [...]                       │                             │
│    │     }                                        │                             │
│    │                                              │                             │
│                                                                                  │
│  CLOUD → EDGE MESSAGES:                                                         │
│  ══════════════════════                                                         │
│                                                                                  │
│  1. Session Started (Cloud pushes new session)                                  │
│  {                                                                               │
│    "type": "session_started",                                                   │
│    "session_id": "uuid-123",                                                    │
│    "device_id": "SCALE-01",                                                     │
│    "animal_id": "uuid-456",                                                     │
│    "animal_tag": "A-124",                                                       │
│    "animal_species": "Kuzu",                                                    │
│    "operator": "MEHMET",                                                        │
│    "started_at": "2026-01-29T10:30:00Z"                                        │
│  }                                                                               │
│                                                                                  │
│  2. Session Ended (Cloud closes session)                                        │
│  {                                                                               │
│    "type": "session_ended",                                                     │
│    "session_id": "uuid-123",                                                    │
│    "ended_at": "2026-01-29T11:45:00Z",                                         │
│    "reason": "completed"                                                        │
│  }                                                                               │
│                                                                                  │
│  3. PLU Updated (Cloud has new PLU catalog)                                     │
│  {                                                                               │
│    "type": "plu_updated",                                                       │
│    "version": "2026-01-29T08:00:00Z"                                           │
│  }                                                                               │
│                                                                                  │
│                                                                                  │
│  EDGE → CLOUD MESSAGES:                                                         │
│  ══════════════════════                                                         │
│                                                                                  │
│  1. Weight Event (Real-time streaming)                                          │
│  {                                                                               │
│    "type": "event",                                                             │
│    "edge_event_id": "uuid-789",                                                 │
│    "device_id": "SCALE-01",                                                     │
│    "session_id": "uuid-123",        // NULL if offline/orphaned                │
│    "plu_code": "00001",                                                         │
│    "product_name": "KIYMA",                                                     │
│    "weight_grams": 2500,                                                        │
│    "barcode": "2000001025004",                                                  │
│    "scale_timestamp": "2026-01-29T10:31:05",                                   │
│    "received_at": "2026-01-29T10:31:05.500Z",                                  │
│    "offline_batch_id": null                                                     │
│  }                                                                               │
│                                                                                  │
│  2. Device Status Update                                                        │
│  {                                                                               │
│    "type": "device_status",                                                     │
│    "device_id": "SCALE-01",                                                     │
│    "status": "online",              // online, idle, disconnected              │
│    "last_heartbeat_at": "2026-01-29T10:31:00Z",                                │
│    "last_event_at": "2026-01-29T10:31:05Z"                                     │
│  }                                                                               │
│                                                                                  │
│  3. Offline Batch Sync Request                                                  │
│  {                                                                               │
│    "type": "sync_request",                                                      │
│    "offline_batches": [                                                         │
│      {                                                                          │
│        "batch_id": "offline-2026-01-29-1422",                                  │
│        "started_at": "2026-01-29T14:22:00Z",                                   │
│        "ended_at": "2026-01-29T15:45:00Z",                                     │
│        "event_count": 15,                                                       │
│        "device_id": "SCALE-01"                                                  │
│      }                                                                          │
│    ]                                                                            │
│  }                                                                               │
│                                                                                  │
│                                                                                  │
│  HEARTBEAT / KEEPALIVE:                                                         │
│  ══════════════════════                                                         │
│                                                                                  │
│  Edge sends ping every 30 seconds                                               │
│  Cloud responds with pong                                                       │
│  If no pong within 60s → reconnect                                             │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Event Latency Target

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    EVENT LATENCY BREAKDOWN (Target: 2-3 seconds)                │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  Scale Prints Label                                                              │
│       │                                                                         │
│       │  ~10ms (Serial to WiFi module)                                         │
│       ▼                                                                         │
│  WiFi Module Sends TCP                                                          │
│       │                                                                         │
│       │  ~50ms (Local network to Edge)                                         │
│       ▼                                                                         │
│  Edge Receives Event                                                            │
│       │                                                                         │
│       │  ~10ms (Parse & store in SQLite)                                       │
│       ▼                                                                         │
│  Edge Sends via WebSocket                                                       │
│       │                                                                         │
│       │  ~500-2000ms (Satellite internet to Cloud)                             │
│       ▼                                                                         │
│  Cloud Receives & Stores                                                        │
│       │                                                                         │
│       │  ~100ms (PostgreSQL insert)                                            │
│       ▼                                                                         │
│  Cloud Pushes to Phone App                                                      │
│       │                                                                         │
│       │  ~200-500ms (WebSocket/SSE to phone)                                   │
│       ▼                                                                         │
│  Operator Sees Event                                                            │
│                                                                                  │
│  ─────────────────────────────────────────────────────────                      │
│  TOTAL: 1-3 seconds (mostly satellite latency)                                  │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Offline Resilience Strategy

### 5.1 Offline Detection & Handling

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    OFFLINE RESILIENCE STRATEGY                                   │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ONLINE MODE (Normal):                                                          │
│  ─────────────────────                                                          │
│                                                                                  │
│  1. Operator starts session from phone → Cloud creates session                  │
│  2. Cloud pushes session to Edge via WebSocket                                  │
│  3. Edge caches: device_id="SCALE-01" → session_id="uuid-123"                  │
│  4. Scale events arrive → tagged with session_id                                │
│  5. Events streamed to Cloud in real-time                                       │
│                                                                                  │
│                                                                                  │
│  OFFLINE MODE (Rare but Critical):                                              │
│  ─────────────────────────────────                                              │
│                                                                                  │
│  1. Edge detects: WebSocket disconnected, Cloud unreachable                     │
│  2. Status: OFFLINE_MODE = true                                                 │
│  3. Generate offline_batch_id: "offline-{timestamp}"                           │
│  4. Scale events still arrive...                                                │
│                                                                                  │
│     EVENT STORAGE (OFFLINE):                                                    │
│     ┌─────────────────────────────────────────────────────────────────────┐    │
│     │ INSERT INTO events (                                                 │    │
│     │   id,                                                                │    │
│     │   device_id,        -- "SCALE-01" (always known)                    │    │
│     │   session_id,       -- NULL (no session assigned)                   │    │
│     │   plu_code,                                                         │    │
│     │   weight_grams,                                                     │    │
│     │   scale_timestamp,                                                  │    │
│     │   received_at,                                                      │    │
│     │   sync_status,      -- "pending"                                    │    │
│     │   offline_mode,     -- 1                                            │    │
│     │   offline_batch_id  -- "offline-2026-01-29-1422"                    │    │
│     │ )                                                                    │    │
│     └─────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
│  5. Events continue to be captured with:                                        │
│     - device_id (known from registration packet)                               │
│     - session_id = NULL                                                        │
│     - offline_batch_id = timestamp-based batch identifier                      │
│                                                                                  │
│                                                                                  │
│  RECONNECTION (Back Online):                                                    │
│  ────────────────────────────                                                   │
│                                                                                  │
│  1. Edge reconnects to Cloud                                                    │
│  2. Edge sends: "I have X orphaned events from offline batches"                │
│  3. Cloud responds: "Send them"                                                 │
│  4. Edge uploads all orphaned events                                           │
│  5. Cloud creates "orphaned batch" record for admin review                     │
│                                                                                  │
│                                                                                  │
│  RECONCILIATION (Operator in Cloud UI):                                         │
│  ───────────────────────────────────────                                        │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  ⚠️ ORPHANED EVENTS NEED ASSIGNMENT                                     │   │
│  │                                                                          │   │
│  │  Batch: offline-2026-01-29-1422 (15 events from SCALE-01)              │   │
│  │  Time: 14:22 - 15:45                                                    │   │
│  │                                                                          │   │
│  │  Events:                                                                │   │
│  │  - 14:22:05  KIYMA      2.5 kg                                         │   │
│  │  - 14:23:12  KUŞBAŞI    1.8 kg                                         │   │
│  │  - 14:24:45  BUT        3.2 kg                                         │   │
│  │  - ... 12 more                                                         │   │
│  │                                                                          │   │
│  │  Assign to Animal: [A-124 Kuzu ▼]                                      │   │
│  │                                                                          │   │
│  │  [Link All to Animal]  [Create New Session]  [Keep Unlinked]           │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  6. Operator selects animal → Cloud creates session, links events              │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Session Management Flow (Cloud-Centric)

### 6.1 Operator Workflow (Phone App)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    OPERATOR WORKFLOW (Phone App → Cloud)                        │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ① OPEN PHONE APP                     ② SELECT SITE & DEVICE                   │
│  ┌─────────────────────────┐          ┌─────────────────────────┐              │
│  │ CarniTrack App          │          │ Site: Kasap Merkezi A   │              │
│  │                         │          │                         │              │
│  │ [Login with Cloud]      │          │ Devices:                │              │
│  │                         │          │ ○ SCALE-01 🟢 Online    │              │
│  │                         │          │ ● SCALE-02 🟢 Online ◄──│── Selected  │
│  └─────────────────────────┘          │ ○ SCALE-03 🟡 Idle      │              │
│                                       └─────────────────────────┘              │
│                                                                                  │
│  ③ SELECT ANIMAL                      ④ START SESSION                          │
│  ┌─────────────────────────┐          ┌─────────────────────────┐              │
│  │ Available Animals:      │          │ ✓ SESSION STARTED       │              │
│  │                         │          │                         │              │
│  │ ○ A-123 Dana 350kg      │──────────│ Device: SCALE-02        │              │
│  │ ● A-124 Kuzu 45kg  ◄────│          │ Animal: A-124 Kuzu      │              │
│  │ ○ A-125 Koyun 52kg      │          │ Started: 10:30          │              │
│  │                         │          │                         │              │
│  │ [Start Session]         │          │ Waiting for events...   │              │
│  └─────────────────────────┘          └─────────────────────────┘              │
│         │                                                                       │
│         │  POST /api/sessions                                                   │
│         │  { device: "SCALE-02", animal: "A-124" }                             │
│         │                                                                       │
│         ▼                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                              CLOUD                                       │   │
│  │  1. Create session in PostgreSQL                                         │   │
│  │  2. Push session to Edge via WebSocket                                   │   │
│  │  3. Return success to phone                                              │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│         │                                                                       │
│         │  WebSocket: session_started                                          │
│         ▼                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                              EDGE                                        │   │
│  │  1. Receive session assignment                                           │   │
│  │  2. Cache: SCALE-02 → session uuid-123                                  │   │
│  │  3. Ready to tag events                                                  │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  ⑤ WEIGHING (On DP-401)               ⑥ EVENTS VISIBLE IN REAL-TIME          │
│  ┌─────────────────────────┐          ┌─────────────────────────┐              │
│  │ Operator weighs cuts    │          │ Phone App:              │              │
│  │ and prints labels       │          │                         │              │
│  │                         │          │ SESSION: A-124 Kuzu     │              │
│  │ Scale → Edge → Cloud    │───2-3s──►│ ─────────────────────── │              │
│  │                         │          │ 10:31  KIYMA     2.5 kg │              │
│  │                         │          │ 10:32  KUŞBAŞI   1.8 kg │              │
│  │                         │          │ 10:33  BUT       3.2 kg │              │
│  │                         │          │                         │              │
│  │                         │          │ Total: 7.5 kg (3 cuts)  │              │
│  └─────────────────────────┘          └─────────────────────────┘              │
│                                                                                  │
│  ⑦ END SESSION (Phone)                ⑧ SUMMARY                                │
│  ┌─────────────────────────┐          ┌─────────────────────────┐              │
│  │                         │          │ Session Complete ✓      │              │
│  │ [End Session]           │──────────│                         │              │
│  │                         │          │ Animal: A-124 Kuzu      │              │
│  │                         │          │ Total: 42.5kg (15 cuts) │              │
│  │                         │          │ Duration: 45 min        │              │
│  │                         │          │                         │              │
│  │                         │          │ [View Report] [New]     │              │
│  └─────────────────────────┘          └─────────────────────────┘              │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Session State Machine (Cloud-Managed)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    SESSION STATE MACHINE (Cloud-Managed)                        │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│                              ┌─────────────┐                                    │
│                              │   PENDING   │                                    │
│                              │  (created)  │                                    │
│                              └──────┬──────┘                                    │
│                                     │ First event received                      │
│                                     ▼                                           │
│  ┌─────────────┐            ┌─────────────┐            ┌─────────────┐         │
│  │  CANCELLED  │◄───────────│   ACTIVE    │───────────►│  COMPLETED  │         │
│  │             │  Operator  │             │  Operator  │             │         │
│  └─────────────┘  cancel    └──────┬──────┘  end       └─────────────┘         │
│                                    │                                            │
│                                    │ Timeout (configurable)                     │
│                                    ▼                                            │
│                             ┌─────────────┐                                    │
│                             │ AUTO-CLOSED │                                    │
│                             │  (timeout)  │                                    │
│                             └─────────────┘                                    │
│                                                                                  │
│  NOTE: All state transitions happen in Cloud.                                   │
│        Edge just receives notifications and updates cache.                      │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Data Models

### 7.1 Edge Database (SQLite) - Cloud-Centric

```sql
-- ═══════════════════════════════════════════════════════════════════════════════
-- EDGE CONFIG TABLE
-- Identity and configuration for this edge instance
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS edge_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- Key values:
-- edge_id: "edge-001" (unique per installation)
-- site_id: "site-A" (assigned by cloud)
-- cloud_url: "wss://carnitrack.app/edge/ws"
-- api_key: "xxx" (for authentication)

-- ═══════════════════════════════════════════════════════════════════════════════
-- DEVICES TABLE
-- Devices identified by registration packet (e.g., "SCALE-01")
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,           -- "SCALE-01" (from WiFi module)
    global_device_id TEXT,                -- "edge-001:SCALE-01" (globally unique)
    display_name TEXT,                    -- "Kesimhane Terazi 1"
    source_ip TEXT,                       -- For reference/debugging
    location TEXT,
    device_type TEXT DEFAULT 'disassembly',
    
    -- Health status
    status TEXT DEFAULT 'unknown',        -- online, idle, stale, disconnected
    tcp_connected INTEGER DEFAULT 0,
    last_heartbeat_at TEXT,
    last_event_at TEXT,
    heartbeat_count INTEGER DEFAULT 0,
    event_count INTEGER DEFAULT 0,
    connected_at TEXT,
    
    -- Cloud sync
    cloud_synced INTEGER DEFAULT 0,
    cloud_device_id TEXT,                 -- UUID from cloud
    
    first_seen_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- ACTIVE SESSIONS CACHE
-- Cache of Cloud sessions, NOT source of truth
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS active_sessions_cache (
    session_id TEXT PRIMARY KEY,          -- Cloud session UUID
    device_id TEXT NOT NULL,              -- Which device this session is for
    animal_id TEXT,
    animal_tag TEXT,
    animal_species TEXT,
    operator TEXT,
    
    status TEXT DEFAULT 'active',         -- active, ended (local cache)
    
    received_at TEXT NOT NULL,            -- When Edge received from Cloud
    started_at TEXT,                      -- Cloud's start time
    
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
);

-- Only ONE active session per device at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_sessions_device 
    ON active_sessions_cache(device_id) WHERE status = 'active';

-- ═══════════════════════════════════════════════════════════════════════════════
-- EVENTS TABLE
-- All captured events (source of truth for event data)
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,                  -- Local UUID
    device_id TEXT NOT NULL,
    
    -- Session linkage (from Cloud or NULL if offline)
    session_id TEXT,                      -- Cloud session UUID (NULL if orphaned)
    
    -- Offline handling
    offline_mode INTEGER DEFAULT 0,       -- 1 if captured while offline
    offline_batch_id TEXT,                -- Groups orphaned events
    
    -- Event data
    plu_code TEXT,
    product_name TEXT,
    weight_grams INTEGER,
    unit_price_cents INTEGER,
    total_price_cents INTEGER,
    barcode TEXT,
    operator_code TEXT,
    
    -- Timestamps
    scale_timestamp TEXT,                 -- From scale
    received_at TEXT NOT NULL,            -- When Edge received
    
    -- Raw data
    source_ip TEXT,
    raw_data TEXT,
    
    -- Sync status
    sync_status TEXT DEFAULT 'pending',   -- pending, synced, failed
    cloud_event_id TEXT,                  -- UUID from Cloud after sync
    synced_at TEXT,
    sync_error TEXT,
    
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_events_sync_status ON events(sync_status);
CREATE INDEX IF NOT EXISTS idx_events_offline_batch ON events(offline_batch_id) 
    WHERE offline_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id);

-- Deduplication
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedup 
    ON events(device_id, scale_timestamp, plu_code, weight_grams);

-- ═══════════════════════════════════════════════════════════════════════════════
-- OFFLINE BATCHES TABLE
-- Track offline periods for reconciliation
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS offline_batches (
    batch_id TEXT PRIMARY KEY,            -- "offline-2026-01-29-1422"
    started_at TEXT NOT NULL,             -- When offline mode started
    ended_at TEXT,                        -- When back online
    event_count INTEGER DEFAULT 0,
    
    -- Reconciliation status
    status TEXT DEFAULT 'pending',        -- pending, uploaded, reconciled
    reconciled_session_id TEXT,           -- Cloud session linked to
    reconciled_at TEXT,
    reconciled_by TEXT
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- PLU CACHE TABLE
-- PLU catalog cached from cloud
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS plu_cache (
    plu_code TEXT PRIMARY KEY,
    name TEXT,
    name_turkish TEXT,
    barcode TEXT,
    price_cents INTEGER,
    unit_type TEXT,
    tare_grams INTEGER DEFAULT 0,
    category TEXT,
    is_active INTEGER DEFAULT 1,
    cloud_updated_at TEXT,
    local_updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- CLOUD CONNECTION LOG
-- Track connection status for debugging
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cloud_connection_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,             -- connected, disconnected, error
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
    details TEXT                          -- JSON with error details
);
```

### 7.2 Cloud Database (Django/PostgreSQL)

```python
# models.py

class Site(models.Model):
    """Multi-tenant: Different butcher shops/plants"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    name = models.CharField(max_length=200)
    address = models.TextField()
    api_key = models.CharField(max_length=100, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)


class EdgeDevice(models.Model):
    """Edge computers registered with Cloud"""
    id = models.CharField(primary_key=True, max_length=50)  # "edge-001"
    site = models.ForeignKey(Site, on_delete=models.CASCADE)
    name = models.CharField(max_length=200)
    is_online = models.BooleanField(default=False)
    last_seen_at = models.DateTimeField(null=True)
    websocket_connected = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)


class ScaleDevice(models.Model):
    """DP-401 scales connected to edges"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    edge = models.ForeignKey(EdgeDevice, on_delete=models.CASCADE)
    device_id = models.CharField(max_length=50)  # "SCALE-01"
    global_device_id = models.CharField(max_length=100, unique=True)  # "edge-001:SCALE-01"
    name = models.CharField(max_length=200)
    location = models.CharField(max_length=200)
    device_type = models.CharField(max_length=50)  # disassembly, retail
    is_active = models.BooleanField(default=True)
    status = models.CharField(max_length=50)  # online, offline, idle
    last_heartbeat_at = models.DateTimeField(null=True)
    last_event_at = models.DateTimeField(null=True)

    class Meta:
        unique_together = ['edge', 'device_id']


class Animal(models.Model):
    """Animal/carcass registry"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    site = models.ForeignKey(Site, on_delete=models.CASCADE)
    tag_number = models.CharField(max_length=50)
    species = models.CharField(max_length=50)
    breed = models.CharField(max_length=100, blank=True)
    carcass_weight_kg = models.DecimalField(max_digits=10, decimal_places=2, null=True)
    arrival_date = models.DateField()
    slaughter_date = models.DateField(null=True)
    status = models.CharField(max_length=50)
    metadata = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ['site', 'tag_number']


class DisassemblySession(models.Model):
    """Session linking scale events to animal - SOURCE OF TRUTH"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    site = models.ForeignKey(Site, on_delete=models.CASCADE)
    animal = models.ForeignKey(Animal, on_delete=models.SET_NULL, null=True)
    device = models.ForeignKey(ScaleDevice, on_delete=models.SET_NULL, null=True)
    operator = models.CharField(max_length=100)
    
    # State
    status = models.CharField(max_length=50)  # pending, active, completed, cancelled, auto_closed
    
    # Timestamps
    started_at = models.DateTimeField()
    ended_at = models.DateTimeField(null=True)
    last_event_at = models.DateTimeField(null=True)
    
    # Stats (updated in real-time)
    total_weight_grams = models.IntegerField(default=0)
    event_count = models.IntegerField(default=0)
    
    # Close reason
    close_reason = models.CharField(max_length=100, blank=True)
    
    notes = models.TextField(blank=True)


class WeighingEvent(models.Model):
    """Individual weighing/print events"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    site = models.ForeignKey(Site, on_delete=models.CASCADE)
    session = models.ForeignKey(DisassemblySession, on_delete=models.SET_NULL, null=True)
    device = models.ForeignKey(ScaleDevice, on_delete=models.SET_NULL, null=True)
    animal = models.ForeignKey(Animal, on_delete=models.SET_NULL, null=True)
    
    # Event data
    plu_code = models.CharField(max_length=10)
    product_name = models.CharField(max_length=100)
    weight_grams = models.IntegerField()
    barcode = models.CharField(max_length=50)
    operator = models.CharField(max_length=100, blank=True)
    
    # Timestamps
    scale_timestamp = models.DateTimeField()
    edge_received_at = models.DateTimeField()
    cloud_received_at = models.DateTimeField(auto_now_add=True)
    
    # Edge tracking
    edge_event_id = models.CharField(max_length=100)
    offline_batch_id = models.CharField(max_length=100, blank=True, null=True)
    
    # Raw data
    raw_data = models.TextField()

    class Meta:
        indexes = [
            models.Index(fields=['site', 'scale_timestamp']),
            models.Index(fields=['session']),
            models.Index(fields=['animal']),
            models.Index(fields=['offline_batch_id']),
        ]


class OrphanedBatch(models.Model):
    """Batches of events captured while offline, pending reconciliation"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    site = models.ForeignKey(Site, on_delete=models.CASCADE)
    edge = models.ForeignKey(EdgeDevice, on_delete=models.CASCADE)
    device = models.ForeignKey(ScaleDevice, on_delete=models.SET_NULL, null=True)
    
    batch_id = models.CharField(max_length=100)  # "offline-2026-01-29-1422"
    started_at = models.DateTimeField()
    ended_at = models.DateTimeField()
    event_count = models.IntegerField()
    
    # Reconciliation
    status = models.CharField(max_length=50)  # pending, reconciled, ignored
    reconciled_to_session = models.ForeignKey(DisassemblySession, on_delete=models.SET_NULL, null=True)
    reconciled_at = models.DateTimeField(null=True)
    reconciled_by = models.CharField(max_length=100, blank=True)


class PLUItem(models.Model):
    """Master product catalog"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    site = models.ForeignKey(Site, on_delete=models.CASCADE)
    plu_code = models.CharField(max_length=10)
    name = models.CharField(max_length=100)
    name_turkish = models.CharField(max_length=16)
    barcode = models.CharField(max_length=50)
    price_cents = models.IntegerField()
    unit_type = models.CharField(max_length=10)
    tare_grams = models.IntegerField(default=0)
    category = models.CharField(max_length=100)
    is_active = models.BooleanField(default=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        unique_together = ['site', 'plu_code']
```

---

## 8. API Design

### 8.1 Cloud REST API (for Phone App)

```yaml
# Authentication
POST /api/v1/auth/login/
  Request: { "email": "...", "password": "..." }
  Response: { "token": "jwt", "user": {...} }

# Sessions (Phone App creates/manages)
GET /api/v1/sessions/
  Query: ?status=active&site_id=...
  
POST /api/v1/sessions/
  Request:
    {
      "device_id": "uuid",          # ScaleDevice UUID
      "animal_id": "uuid",
      "operator": "MEHMET"
    }
  Response: { "id": "uuid", "status": "pending", ... }

PATCH /api/v1/sessions/{id}/
  Request: { "status": "completed" }

DELETE /api/v1/sessions/{id}/
  (Cancels session)

# Events (Real-time via SSE)
GET /api/v1/events/stream/
  Headers: Accept: text/event-stream
  Query: ?session_id=...
  
GET /api/v1/events/
  Query: ?session_id=...&limit=50

# Devices
GET /api/v1/devices/
  Query: ?site_id=...&status=online

# Animals
GET /api/v1/animals/
  Query: ?site_id=...&status=processing

# Orphaned Batches
GET /api/v1/orphaned-batches/
  Query: ?site_id=...&status=pending

POST /api/v1/orphaned-batches/{id}/reconcile/
  Request: { "animal_id": "uuid" }
```

### 8.2 Cloud WebSocket API (for Edge)

```yaml
# Edge connects to Cloud
WSS /edge/ws/
  Headers:
    Authorization: Bearer {edge_jwt}
    X-Edge-ID: edge-001

# Message types documented in Section 4.1
```

### 8.3 Edge Admin API (Minimal)

```yaml
# Status
GET /admin/api/status
  Response:
    {
      "edge_id": "edge-001",
      "cloud_connected": true,
      "devices": {
        "SCALE-01": { "status": "online", "last_hb": "..." }
      },
      "pending_sync": 5,
      "offline_mode": false
    }

# Devices
GET /admin/api/devices

# Events (recent)
GET /admin/api/events?limit=100

# SQL Query (debug)
POST /admin/api/sql
  Request: { "query": "SELECT * FROM events LIMIT 10" }
```

---

## 9. Multi-Edge Scalability

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    MULTI-EDGE SCALABLE ARCHITECTURE                             │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  SITE A (Kasap Merkezi)          SITE B (Et Fabrikası)                         │
│  ┌─────────────────────┐         ┌─────────────────────┐                       │
│  │ EDGE-A              │         │ EDGE-B              │                       │
│  │ edge_id: "edge-001" │         │ edge_id: "edge-002" │                       │
│  │ site_id: "site-A"   │         │ site_id: "site-B"   │                       │
│  │                     │         │                     │                       │
│  │ ┌───────┐ ┌───────┐ │         │ ┌───────┐ ┌───────┐ │                       │
│  │ │SCALE01│ │SCALE02│ │         │ │SCALE01│ │SCALE02│ │                       │
│  │ └───────┘ └───────┘ │         │ └───────┘ └───────┘ │                       │
│  └──────────┬──────────┘         └──────────┬──────────┘                       │
│             │                               │                                   │
│             │ WebSocket                     │ WebSocket                         │
│             │                               │                                   │
│             └───────────────┬───────────────┘                                   │
│                             │                                                    │
│                     ┌───────┴───────┐                                           │
│                     │     CLOUD     │                                           │
│                     │               │                                           │
│                     │ WebSocket Hub │                                           │
│                     │               │                                           │
│                     │ Connections:  │                                           │
│                     │ edge-001 ── ✓ │                                           │
│                     │ edge-002 ── ✓ │                                           │
│                     │               │                                           │
│                     └───────────────┘                                           │
│                                                                                  │
│  DEVICE IDENTIFICATION (Globally Unique):                                       │
│  ────────────────────────────────────────                                       │
│                                                                                  │
│  Local:  "SCALE-01"                                                             │
│  Global: "edge-001:SCALE-01"                                                    │
│                                                                                  │
│  This allows same local device names across different sites                    │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 10. Implementation Phases

### Phase 1: Core Edge Service (TCP + Storage)
- [ ] TCP Server accepting scale connections
- [ ] Registration packet parsing
- [ ] Heartbeat tracking
- [ ] Event parsing and SQLite storage
- [ ] Basic CLI output

### Phase 2: Cloud Communication (WebSocket)
- [ ] WebSocket client to Cloud
- [ ] Receive session assignments
- [ ] Stream events to Cloud
- [ ] Device status reporting
- [ ] Reconnection handling

### Phase 3: Offline Resilience
- [ ] Offline detection
- [ ] Orphaned event batching
- [ ] Sync on reconnection
- [ ] Batch upload to Cloud

### Phase 4: Cloud Backend (Django)
- [ ] WebSocket hub for edges
- [ ] Session management API
- [ ] Event storage and streaming
- [ ] Orphaned batch reconciliation UI

### Phase 5: Phone App
- [ ] Session start/end
- [ ] Real-time event view
- [ ] Animal selection
- [ ] Device status view

### Phase 6: PLU Management
- [ ] PLU sync from Cloud to Edge
- [ ] PLU file generator
- [ ] Download endpoint

### Phase 7: Admin Dashboard (Edge)
- [ ] Status overview
- [ ] Device list
- [ ] Recent events
- [ ] SQL viewer

### Phase 8: Production
- [ ] Windows Service wrapper
- [ ] Error handling & logging
- [ ] Health checks
- [ ] Documentation

---

## 11. File Structure

```
carnitrack-edge/
├── src/
│   ├── index.ts              # Main entry point
│   ├── config.ts             # Configuration
│   │
│   ├── devices/
│   │   ├── manager.ts        # DeviceManager class
│   │   ├── tcp-server.ts     # TCP server for scales
│   │   ├── parser.ts         # Event parsing
│   │   └── heartbeat.ts      # Heartbeat tracking
│   │
│   ├── cloud/
│   │   ├── websocket.ts      # WebSocket client to Cloud
│   │   ├── session-cache.ts  # Cache Cloud sessions
│   │   ├── event-streamer.ts # Stream events to Cloud
│   │   └── offline.ts        # Offline handling
│   │
│   ├── storage/
│   │   ├── database.ts       # SQLite setup
│   │   ├── events.ts         # Event repository
│   │   ├── devices.ts        # Device repository
│   │   └── sessions.ts       # Session cache repository
│   │
│   ├── plu/
│   │   ├── generator.ts      # Generate plu.txt
│   │   ├── sync.ts           # Sync PLU from Cloud
│   │   └── encoding.ts       # Windows-1254 encoding
│   │
│   ├── api/
│   │   ├── server.ts         # Bun.serve for admin
│   │   └── routes/
│   │       ├── status.ts
│   │       ├── devices.ts
│   │       ├── events.ts
│   │       └── sql.ts
│   │
│   ├── admin/
│   │   ├── index.html        # Admin dashboard
│   │   └── assets/
│   │
│   └── types/
│       └── index.ts          # Type definitions
│
├── data/
│   └── carnitrack.db         # SQLite database
│
├── generated/
│   └── plu.txt               # Generated PLU files
│
├── logs/
│
├── package.json
├── tsconfig.json
└── README.md
```

---

## 12. Summary

### What We Know For Certain

| Aspect | Status | Notes |
|--------|--------|-------|
| TCP event capture | ✅ Working | Via WiFi module serial bridge |
| Event format parsing | ✅ Working | Comma-delimited, Turkish chars |
| Registration packet | ✅ VERIFIED | WiFi module sends device ID on connect |
| Hardware heartbeat | ✅ VERIFIED | WiFi module sends "HB" every 30s |
| TCP Client mode | ✅ VERIFIED | Scales connect TO edge server |
| PLU via TCP | ❌ Not possible | Must use USB flash disk |

### Key Architectural Decisions (v3.0)

1. **Cloud-Centric** - Sessions created/managed in Cloud, not Edge
2. **Phone App** - Operators use phone to start/end sessions
3. **WebSocket** - Real-time bi-directional Edge ↔ Cloud
4. **2-3s Latency** - Acceptable for event visibility
5. **Offline Resilience** - Events captured even when Cloud unreachable
6. **Orphaned Batches** - Offline events reconciled manually in Cloud
7. **Minimal Edge UI** - Admin dashboard only (SQL viewer, status)
8. **Multi-Edge Ready** - One Cloud, many Edges, globally unique device IDs

### Edge Role Summary

```
EDGE = Smart Relay
───────────────────
✅ Capture events from scales (TCP)
✅ Tag events with session (from Cloud cache)
✅ Stream events to Cloud (WebSocket)
✅ Buffer events when offline
✅ Report device health to Cloud
❌ NO session management (Cloud only)
❌ NO operator UI (Phone app via Cloud)
```

### Communication Architecture

```
Phone App ◄────── REST + SSE ──────► Cloud ◄────── WebSocket ──────► Edge ◄───── TCP ───── Scales
           (sessions, events)              (sessions, events)              (events)
```

---

*Document Version: 3.0 (Cloud-Centric)*
*Updated: January 2026*
*Status: Architecture Complete - Cloud-Centric, WebSocket, Offline Resilience*
