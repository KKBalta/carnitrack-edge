/**
 * CarniTrack Edge Service
 * 
 * Main entry point for the Edge service.
 * 
 * Architecture v3.0 (Cloud-Centric):
 * 
 * This service:
 * - Accepts TCP connections from DP-401 scales
 * - Parses registration packets ("SCALE-XX") and heartbeats ("HB")
 * - Captures weighing events and stores locally
 * - Streams events to Cloud via WebSocket (2-3 sec latency)
 * - Caches active sessions from Cloud (sessions managed by Cloud)
 * - Operates in offline mode when Cloud is unreachable
 * - Groups offline events into batches for later reconciliation
 * - Provides minimal admin dashboard for debugging/monitoring
 * 
 * Key differences from v2:
 * - Sessions are NO LONGER managed by Edge
 * - Operators start sessions from Phone App via Cloud
 * - Edge receives session info via WebSocket push
 * - Offline events are captured with batch ID for later matching
 */

import { config } from "./config.ts";
import { initDatabase, closeDatabase, getEdgeConfig, getAllEdgeConfig } from "./storage/database.ts";
import type { CloudConnectionState, DeviceStatus } from "./types/index.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// RUNTIME STATE
// ═══════════════════════════════════════════════════════════════════════════════

interface EdgeState {
  /** Edge identity (from database after registration) */
  edgeId: string | null;
  siteId: string | null;
  siteName: string | null;
  
  /** Cloud connection state */
  cloudConnection: CloudConnectionState;
  
  /** Whether we're in offline mode */
  offlineMode: boolean;
  
  /** Current offline batch ID (if in offline mode) */
  currentOfflineBatchId: string | null;
  
  /** Connected devices (deviceId → runtime state) */
  devices: Map<string, {
    sourceIp: string;
    status: DeviceStatus;
    tcpConnected: boolean;
    lastHeartbeatAt: Date | null;
    lastEventAt: Date | null;
    activeCloudSessionId: string | null;
  }>;
  
  /** Startup time */
  startedAt: Date;
}

const state: EdgeState = {
  edgeId: null,
  siteId: null,
  siteName: null,
  cloudConnection: "disconnected",
  offlineMode: false,
  currentOfflineBatchId: null,
  devices: new Map(),
  startedAt: new Date(),
};

// ═══════════════════════════════════════════════════════════════════════════════
// BANNER
// ═══════════════════════════════════════════════════════════════════════════════

const BANNER = `
╔═══════════════════════════════════════════════════════════════════════════════╗
║                                                                               ║
║   ██████╗ █████╗ ██████╗ ███╗   ██╗██╗████████╗██████╗  █████╗  ██████╗██╗  ██║
║  ██╔════╝██╔══██╗██╔══██╗████╗  ██║██║╚══██╔══╝██╔══██╗██╔══██╗██╔════╝██║ ██╔╝║
║  ██║     ███████║██████╔╝██╔██╗ ██║██║   ██║   ██████╔╝███████║██║     █████╔╝ ║
║  ██║     ██╔══██║██╔══██╗██║╚██╗██║██║   ██║   ██╔══██╗██╔══██║██║     ██╔═██╗ ║
║  ╚██████╗██║  ██║██║  ██║██║ ╚████║██║   ██║   ██║  ██║██║  ██║╚██████╗██║  ██╗║
║   ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝║
║                                                                               ║
║                           E D G E   S E R V I C E                             ║
║                                                                               ║
║                    Meat Traceability • Cloud-Centric v3.0                     ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`;

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log(BANNER);
  console.log(`[MAIN] Starting CarniTrack Edge Service...`);
  console.log(`[MAIN] Version: 0.2.0 (Cloud-Centric)`);
  console.log(`[MAIN] Runtime: Bun ${Bun.version}`);
  console.log("");
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Initialize Database
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("[INIT] Initializing database...");
  const db = initDatabase();
  console.log(`[INIT] Database ready at: ${config.database.path}`);
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Load Edge Identity (from database)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("[INIT] Loading Edge identity...");
  const edgeConfig = getAllEdgeConfig();
  state.edgeId = edgeConfig.edge_id || null;
  state.siteId = edgeConfig.site_id || null;
  state.siteName = edgeConfig.site_name || null;
  
  if (state.edgeId) {
    console.log(`[INIT] Edge ID: ${state.edgeId}`);
    console.log(`[INIT] Site: ${state.siteName || state.siteId || "Unknown"}`);
  } else {
    console.log(`[INIT] ⚠️  Edge not yet registered with Cloud`);
    console.log(`[INIT]    Will register on first Cloud connection`);
  }
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Configuration Summary
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("");
  console.log("┌─────────────────────────────────────────────────────────────────┐");
  console.log("│                      CONFIGURATION                              │");
  console.log("├─────────────────────────────────────────────────────────────────┤");
  console.log(`│  TCP Server:     ${config.tcp.host}:${config.tcp.port.toString().padEnd(37)}│`);
  console.log(`│  HTTP Server:    ${config.http.host}:${config.http.port.toString().padEnd(37)}│`);
  console.log(`│  WebSocket:      ${config.websocket.url.substring(0, 43).padEnd(43)}│`);
  console.log(`│  Database:       ${config.database.path.substring(0, 43).padEnd(43)}│`);
  console.log(`│  Log Level:      ${config.logging.level.padEnd(45)}│`);
  console.log(`│  Work Hours:     ${config.workHours.start} - ${config.workHours.end} (${config.workHours.timezone})`.padEnd(66) + "│");
  console.log("└─────────────────────────────────────────────────────────────────┘");
  console.log("");

  // ─────────────────────────────────────────────────────────────────────────────
  // Start TCP Server (Scale Connections)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("[INIT] Starting TCP server for scale connections...");
  
  const tcpServer = Bun.listen({
    hostname: config.tcp.host,
    port: config.tcp.port,
    socket: {
      open(socket) {
        const remoteAddress = socket.remoteAddress;
        console.log(`[TCP] New connection from ${remoteAddress}`);
        
        // Store socket state
        // @ts-ignore - Bun socket data property
        socket.data = {
          deviceId: null,
          buffer: "",
          remoteAddress,
        };
      },
      
      data(socket, data) {
        // @ts-ignore
        const socketState = socket.data;
        const message = data.toString().trim();
        
        console.log(`[TCP] Received from ${socketState.remoteAddress}: ${message}`);
        
        // Check for registration packet (e.g., "SCALE-01")
        if (config.heartbeat.registrationPattern.test(message)) {
          socketState.deviceId = message;
          console.log(`[TCP] Device registered: ${message}`);
          
          // Update runtime state
          state.devices.set(message, {
            sourceIp: socketState.remoteAddress,
            status: "online",
            tcpConnected: true,
            lastHeartbeatAt: new Date(),
            lastEventAt: null,
            activeCloudSessionId: null,
          });
          
          // TODO: Notify Cloud via WebSocket (device_connected)
          // TODO: Check for active session in cache
          
          return;
        }
        
        // Check for heartbeat
        if (message === config.heartbeat.heartbeatString) {
          console.log(`[TCP] Heartbeat from ${socketState.deviceId || socketState.remoteAddress}`);
          
          // Update runtime state
          if (socketState.deviceId && state.devices.has(socketState.deviceId)) {
            const device = state.devices.get(socketState.deviceId)!;
            device.lastHeartbeatAt = new Date();
            device.status = "online";
          }
          
          // TODO: Forward heartbeat to Cloud (for monitoring)
          
          return;
        }
        
        // Otherwise it's a weight event
        console.log(`[TCP] Weight event from ${socketState.deviceId || socketState.remoteAddress}`);
        
        // TODO: Parse event data (DP-401 format)
        // TODO: Check for active session in cache
        // TODO: If offline mode, create/add to offline batch
        // TODO: Store event locally
        // TODO: Stream to Cloud via WebSocket (if connected)
        
        // Send acknowledgment
        socket.write("OK\n");
      },
      
      close(socket) {
        // @ts-ignore
        const socketState = socket.data;
        console.log(`[TCP] Connection closed: ${socketState.deviceId || socketState.remoteAddress}`);
        
        // Update runtime state
        if (socketState.deviceId && state.devices.has(socketState.deviceId)) {
          const device = state.devices.get(socketState.deviceId)!;
          device.tcpConnected = false;
          device.status = "disconnected";
        }
        
        // TODO: Notify Cloud via WebSocket (device_disconnected)
      },
      
      error(socket, error) {
        // @ts-ignore
        const socketState = socket.data;
        console.error(`[TCP] Error on ${socketState?.deviceId || socketState?.remoteAddress}:`, error);
      },
    },
  });
  
  console.log(`[TCP] ✓ Server listening on ${config.tcp.host}:${config.tcp.port}`);

  // ─────────────────────────────────────────────────────────────────────────────
  // TODO: Start Cloud WebSocket Connection
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("[INIT] Cloud WebSocket connection...");
  console.log(`[CLOUD] ⚠️  WebSocket connector not yet implemented`);
  console.log(`[CLOUD]    Will connect to: ${config.websocket.url}`);
  state.cloudConnection = "disconnected";
  state.offlineMode = true; // Start in offline mode until connected
  
  // TODO: Implement CloudConnector class in src/cloud/connector.ts
  // - Connect to WebSocket
  // - Handle authentication
  // - Receive session updates
  // - Stream events
  // - Handle reconnection with backoff

  // ─────────────────────────────────────────────────────────────────────────────
  // Start HTTP Server (Admin Dashboard & API)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("[INIT] Starting HTTP server for Admin Dashboard & API...");
  
  const httpServer = Bun.serve({
    port: config.http.port,
    hostname: config.http.host,
    
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      
      // API Routes
      if (path.startsWith("/api/")) {
        return handleApi(req, path);
      }
      
      // Health check
      if (path === "/health") {
        return Response.json({ 
          status: "ok", 
          timestamp: new Date().toISOString(),
          edgeId: state.edgeId,
          cloudConnection: state.cloudConnection,
          offlineMode: state.offlineMode,
        });
      }
      
      // Admin Dashboard
      if (path === "/" || path === "/index.html") {
        return new Response(getAdminDashboardHtml(), {
          headers: { "Content-Type": "text/html" },
        });
      }
      
      // 404
      return new Response("Not Found", { status: 404 });
    },
  });
  
  console.log(`[HTTP] ✓ Server listening on http://${config.http.host}:${config.http.port}`);

  // ─────────────────────────────────────────────────────────────────────────────
  // Startup Complete
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("");
  console.log("╔═══════════════════════════════════════════════════════════════════╗");
  console.log("║                                                                   ║");
  console.log("║   ✓ CarniTrack Edge Service READY                                 ║");
  console.log("║                                                                   ║");
  console.log(`║   📡 Scales connect to:  tcp://${config.tcp.host}:${config.tcp.port}`.padEnd(68) + "║");
  console.log(`║   🌐 Admin Dashboard:    http://localhost:${config.http.port}`.padEnd(68) + "║");
  console.log(`║   ☁️  Cloud Status:       ${state.cloudConnection.toUpperCase()}`.padEnd(68) + "║");
  console.log("║                                                                   ║");
  if (state.offlineMode) {
    console.log("║   ⚠️  OFFLINE MODE - Events will be batched for later sync        ║");
  } else {
    console.log("║   ✓ ONLINE - Events streaming to Cloud in real-time              ║");
  }
  console.log("║                                                                   ║");
  console.log("║   Waiting for scale connections...                                ║");
  console.log("║                                                                   ║");
  console.log("╚═══════════════════════════════════════════════════════════════════╝");
  console.log("");

  // ─────────────────────────────────────────────────────────────────────────────
  // Graceful Shutdown
  // ─────────────────────────────────────────────────────────────────────────────
  process.on("SIGINT", () => {
    console.log("\n[MAIN] Received SIGINT, shutting down gracefully...");
    tcpServer.stop();
    httpServer.stop();
    // TODO: Close WebSocket connection
    closeDatabase();
    console.log("[MAIN] Goodbye!");
    process.exit(0);
  });
  
  process.on("SIGTERM", () => {
    console.log("\n[MAIN] Received SIGTERM, shutting down gracefully...");
    tcpServer.stop();
    httpServer.stop();
    // TODO: Close WebSocket connection
    closeDatabase();
    process.exit(0);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// API HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

function handleApi(req: Request, path: string): Response {
  // GET /api/status - System status
  if (path === "/api/status" && req.method === "GET") {
    return Response.json({
      success: true,
      data: {
        edgeId: state.edgeId,
        siteId: state.siteId,
        siteName: state.siteName,
        devices: Object.fromEntries(
          Array.from(state.devices.entries()).map(([id, d]) => [id, d.status])
        ),
        activeSessions: 0, // TODO: Count from cache
        pendingOfflineBatches: 0, // TODO: Count from database
        pendingEventSync: 0, // TODO: Count from database
        cloudConnection: state.cloudConnection,
        offlineMode: state.offlineMode,
        pluUpdateNeeded: false,
        uptime: (Date.now() - state.startedAt.getTime()) / 1000,
        version: "0.2.0",
      },
    });
  }
  
  // GET /api/devices - List devices
  if (path === "/api/devices" && req.method === "GET") {
    return Response.json({
      success: true,
      data: Array.from(state.devices.entries()).map(([id, device]) => ({
        deviceId: id,
        ...device,
      })),
    });
  }
  
  // GET /api/sessions - List cached sessions
  if (path === "/api/sessions" && req.method === "GET") {
    // TODO: Query active_sessions_cache table
    return Response.json({
      success: true,
      data: [],
    });
  }
  
  // GET /api/events - List recent events
  if (path === "/api/events" && req.method === "GET") {
    // TODO: Query events table with pagination
    return Response.json({
      success: true,
      data: [],
    });
  }
  
  // GET /api/offline-batches - List offline batches
  if (path === "/api/offline-batches" && req.method === "GET") {
    // TODO: Query offline_batches table
    return Response.json({
      success: true,
      data: [],
    });
  }
  
  // GET /api/config - Get Edge configuration
  if (path === "/api/config" && req.method === "GET") {
    return Response.json({
      success: true,
      data: getAllEdgeConfig(),
    });
  }
  
  return Response.json({ success: false, error: "Not found" }, { status: 404 });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN DASHBOARD HTML
// Minimal dashboard for monitoring and debugging
// ═══════════════════════════════════════════════════════════════════════════════

function getAdminDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CarniTrack Edge - Admin</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap');
    
    :root {
      --bg-primary: #0d1117;
      --bg-secondary: #161b22;
      --bg-card: #21262d;
      --bg-hover: #30363d;
      --text-primary: #f0f6fc;
      --text-secondary: #8b949e;
      --text-muted: #6e7681;
      --accent-green: #3fb950;
      --accent-green-muted: #238636;
      --accent-yellow: #d29922;
      --accent-orange: #db6d28;
      --accent-red: #f85149;
      --accent-blue: #58a6ff;
      --border-color: #30363d;
      --border-muted: #21262d;
    }
    
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: 'JetBrains Mono', monospace;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    
    header {
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
      padding: 1rem 2rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    
    .header-left {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    
    .logo {
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--accent-green);
    }
    
    .logo span {
      color: var(--text-primary);
    }
    
    .badge {
      font-size: 0.65rem;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .badge-admin {
      background: var(--accent-yellow);
      color: var(--bg-primary);
    }
    
    .badge-offline {
      background: var(--accent-orange);
      color: var(--bg-primary);
    }
    
    .badge-online {
      background: var(--accent-green-muted);
      color: var(--text-primary);
    }
    
    .header-right {
      display: flex;
      align-items: center;
      gap: 1rem;
      font-size: 0.75rem;
      color: var(--text-secondary);
    }
    
    .connection-status {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    
    .status-dot.online { background: var(--accent-green); }
    .status-dot.offline { background: var(--accent-orange); animation: pulse 2s ease-in-out infinite; }
    .status-dot.disconnected { background: var(--accent-red); }
    
    main {
      flex: 1;
      padding: 1.5rem;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1rem;
      max-width: 1800px;
      margin: 0 auto;
      width: 100%;
    }
    
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 1.25rem;
    }
    
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1rem;
    }
    
    .card-title {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    
    .card-title::before {
      content: '';
      display: inline-block;
      width: 6px;
      height: 6px;
      background: var(--accent-blue);
      border-radius: 2px;
    }
    
    .stat-value {
      font-size: 2.5rem;
      font-weight: 700;
      line-height: 1;
      color: var(--text-primary);
    }
    
    .stat-value.warning { color: var(--accent-yellow); }
    .stat-value.danger { color: var(--accent-red); }
    .stat-value.success { color: var(--accent-green); }
    
    .stat-label {
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-top: 0.5rem;
    }
    
    .device-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    
    .device-item {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem;
      background: var(--bg-secondary);
      border-radius: 6px;
      border: 1px solid var(--border-muted);
    }
    
    .device-status {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    
    .device-status.online { background: var(--accent-green); }
    .device-status.idle { background: var(--accent-yellow); }
    .device-status.disconnected { background: var(--accent-red); }
    .device-status.unknown { background: var(--text-muted); }
    
    .device-info {
      flex: 1;
      min-width: 0;
    }
    
    .device-name {
      font-weight: 600;
      font-size: 0.85rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .device-meta {
      font-size: 0.7rem;
      color: var(--text-secondary);
    }
    
    .empty-state {
      text-align: center;
      padding: 2rem;
      color: var(--text-secondary);
    }
    
    .empty-icon {
      font-size: 2rem;
      margin-bottom: 0.75rem;
      opacity: 0.5;
    }
    
    .empty-text {
      font-size: 0.8rem;
    }
    
    .card-wide {
      grid-column: span 2;
    }
    
    @media (max-width: 768px) {
      .card-wide {
        grid-column: span 1;
      }
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.75rem;
    }
    
    th, td {
      padding: 0.5rem;
      text-align: left;
      border-bottom: 1px solid var(--border-muted);
    }
    
    th {
      color: var(--text-secondary);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 0.65rem;
      letter-spacing: 0.5px;
    }
    
    footer {
      background: var(--bg-secondary);
      border-top: 1px solid var(--border-color);
      padding: 0.75rem 2rem;
      text-align: center;
      font-size: 0.65rem;
      color: var(--text-muted);
    }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-left">
      <div class="logo">CARNI<span>TRACK</span></div>
      <span class="badge badge-admin">Admin Dashboard</span>
      <span class="badge badge-offline" id="mode-badge">OFFLINE MODE</span>
    </div>
    <div class="header-right">
      <div class="connection-status">
        <span class="status-dot offline" id="cloud-dot"></span>
        <span id="cloud-status">Cloud: Disconnected</span>
      </div>
      <div id="edge-id">Edge: Not Registered</div>
    </div>
  </header>
  
  <main>
    <div class="card">
      <div class="card-header">
        <div class="card-title">Connected Scales</div>
      </div>
      <div class="stat-value" id="device-count">0</div>
      <div class="stat-label">devices online</div>
    </div>
    
    <div class="card">
      <div class="card-header">
        <div class="card-title">Active Sessions</div>
      </div>
      <div class="stat-value" id="session-count">0</div>
      <div class="stat-label">from cloud cache</div>
    </div>
    
    <div class="card">
      <div class="card-header">
        <div class="card-title">Pending Sync</div>
      </div>
      <div class="stat-value warning" id="pending-count">0</div>
      <div class="stat-label">events waiting</div>
    </div>
    
    <div class="card">
      <div class="card-header">
        <div class="card-title">Offline Batches</div>
      </div>
      <div class="stat-value" id="batch-count">0</div>
      <div class="stat-label">awaiting reconciliation</div>
    </div>
    
    <div class="card card-wide">
      <div class="card-header">
        <div class="card-title">Devices</div>
      </div>
      <div class="device-list" id="device-list">
        <div class="empty-state">
          <div class="empty-icon">📡</div>
          <div class="empty-text">Waiting for scale connections...</div>
          <div class="empty-text" style="margin-top: 0.5rem; color: var(--text-muted);">
            tcp://${config.tcp.host}:${config.tcp.port}
          </div>
        </div>
      </div>
    </div>
    
    <div class="card card-wide">
      <div class="card-header">
        <div class="card-title">Recent Events</div>
      </div>
      <div id="events-container">
        <div class="empty-state">
          <div class="empty-icon">⚖️</div>
          <div class="empty-text">No events yet</div>
        </div>
      </div>
    </div>
  </main>
  
  <footer>
    CarniTrack Edge v0.2.0 (Cloud-Centric) • Admin Dashboard • Refresh: 3s
  </footer>
  
  <script>
    async function updateDashboard() {
      try {
        const res = await fetch('/api/status');
        const { data } = await res.json();
        
        // Update stats
        const deviceCount = Object.keys(data.devices).length;
        document.getElementById('device-count').textContent = deviceCount;
        document.getElementById('session-count').textContent = data.activeSessions;
        document.getElementById('pending-count').textContent = data.pendingEventSync;
        document.getElementById('batch-count').textContent = data.pendingOfflineBatches;
        
        // Update cloud status
        const cloudDot = document.getElementById('cloud-dot');
        const cloudStatus = document.getElementById('cloud-status');
        const modeBadge = document.getElementById('mode-badge');
        
        if (data.cloudConnection === 'connected') {
          cloudDot.className = 'status-dot online';
          cloudStatus.textContent = 'Cloud: Connected';
          modeBadge.className = 'badge badge-online';
          modeBadge.textContent = 'ONLINE';
        } else {
          cloudDot.className = 'status-dot offline';
          cloudStatus.textContent = 'Cloud: ' + data.cloudConnection;
          modeBadge.className = 'badge badge-offline';
          modeBadge.textContent = 'OFFLINE MODE';
        }
        
        // Update edge ID
        const edgeIdEl = document.getElementById('edge-id');
        edgeIdEl.textContent = data.edgeId 
          ? 'Edge: ' + data.edgeId.substring(0, 8) + '...'
          : 'Edge: Not Registered';
        
        // Update device list
        const deviceList = document.getElementById('device-list');
        if (deviceCount === 0) {
          deviceList.innerHTML = \`
            <div class="empty-state">
              <div class="empty-icon">📡</div>
              <div class="empty-text">Waiting for scale connections...</div>
            </div>
          \`;
        } else {
          deviceList.innerHTML = Object.entries(data.devices).map(([id, status]) => \`
            <div class="device-item">
              <div class="device-status \${status}"></div>
              <div class="device-info">
                <div class="device-name">\${id}</div>
                <div class="device-meta">Status: \${status}</div>
              </div>
            </div>
          \`).join('');
        }
      } catch (e) {
        console.error('Dashboard update failed:', e);
      }
    }
    
    updateDashboard();
    setInterval(updateDashboard, 3000);
  </script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUN
// ═══════════════════════════════════════════════════════════════════════════════

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
