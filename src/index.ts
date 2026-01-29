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
 */

import { config } from "./config.ts";
import { initDatabase, closeDatabase, getAllEdgeConfig } from "./storage/database.ts";
import { TCPServer, setGlobalTCPServer } from "./devices/tcp-server.ts";
import type { SocketMeta } from "./devices/tcp-server.ts";
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
    socketId: string;
    sourceIp: string;
    status: DeviceStatus;
    tcpConnected: boolean;
    lastHeartbeatAt: Date | null;
    lastEventAt: Date | null;
    activeCloudSessionId: string | null;
  }>;
  
  /** Socket to device mapping (socketId → deviceId) */
  socketToDevice: Map<string, string>;
  
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
  socketToDevice: new Map(),
  startedAt: new Date(),
};

// References to servers for graceful shutdown
let tcpServer: TCPServer | null = null;
let httpServer: ReturnType<typeof Bun.serve> | null = null;

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
// TCP EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle new TCP connection from scale
 */
function handleTCPConnection(socketId: string, meta: SocketMeta): void {
  console.log(`[TCP] New connection: ${socketId} from ${meta.remoteAddress}`);
}

/**
 * Handle data received from scale
 */
function handleTCPData(socketId: string, data: Buffer, meta: SocketMeta): void {
  // Convert buffer to string and split by lines (handle multiple messages)
  const rawData = data.toString("utf-8");
  const messages = rawData.split(/\r?\n/).filter((msg: string) => msg.trim());
  
  for (const message of messages) {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) continue;
    
    console.log(`[TCP] Received from ${meta.deviceId || meta.remoteAddress}: ${trimmedMessage.substring(0, 100)}`);
    
    // ─────────────────────────────────────────────────────────────────────────
    // Check for registration packet (e.g., "SCALE-01")
    // ─────────────────────────────────────────────────────────────────────────
    if (config.heartbeat.registrationPattern.test(trimmedMessage)) {
      const deviceId = trimmedMessage;
      
      // Update socket metadata with device ID
      if (tcpServer) {
        tcpServer.updateSocketMeta(socketId, { deviceId });
      }
      
      // Track socket → device mapping
      state.socketToDevice.set(socketId, deviceId);
      
      // Update or create device state
      const existingDevice = state.devices.get(deviceId);
      if (existingDevice) {
        // Reconnection - update existing device
        existingDevice.socketId = socketId;
        existingDevice.sourceIp = meta.remoteAddress;
        existingDevice.tcpConnected = true;
        existingDevice.status = "online";
        existingDevice.lastHeartbeatAt = new Date();
        console.log(`[TCP] Device reconnected: ${deviceId}`);
      } else {
        // New device registration
        state.devices.set(deviceId, {
          socketId,
          sourceIp: meta.remoteAddress,
          status: "online",
          tcpConnected: true,
          lastHeartbeatAt: new Date(),
          lastEventAt: null,
          activeCloudSessionId: null,
        });
        console.log(`[TCP] ✓ Device registered: ${deviceId} from ${meta.remoteAddress}`);
      }
      
      // TODO: Notify Cloud via WebSocket (device_connected) - Issue #4
      // TODO: Check for active session in cache - Issue #5
      // TODO: Persist device to database - Issue #3
      
      continue;
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // Check for heartbeat ("HB")
    // ─────────────────────────────────────────────────────────────────────────
    if (trimmedMessage === config.heartbeat.heartbeatString) {
      const deviceId = meta.deviceId || state.socketToDevice.get(socketId);
      
      if (deviceId && state.devices.has(deviceId)) {
        const device = state.devices.get(deviceId)!;
        device.lastHeartbeatAt = new Date();
        device.status = "online";
        console.log(`[TCP] ♥ Heartbeat from ${deviceId}`);
      } else {
        console.log(`[TCP] ♥ Heartbeat from unregistered socket ${socketId}`);
      }
      
      // TODO: Forward heartbeat to Cloud (for monitoring dashboard) - Issue #4
      
      continue;
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // Check for "KONTROLLU AKTAR OK?" prompt (scale protocol)
    // ─────────────────────────────────────────────────────────────────────────
    if (trimmedMessage.includes("KONTROLLU AKTAR OK?")) {
      console.log(`[TCP] Scale prompt received, sending OK`);
      if (tcpServer) {
        tcpServer.send(socketId, "OK\n");
      }
      continue;
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // Otherwise it's a weighing event
    // ─────────────────────────────────────────────────────────────────────────
    const deviceId = meta.deviceId || state.socketToDevice.get(socketId);
    console.log(`[TCP] ⚖️  Weight event from ${deviceId || "unknown"}`);
    console.log(`[TCP]    Raw: ${trimmedMessage.substring(0, 150)}${trimmedMessage.length > 150 ? "..." : ""}`);
    
    // Update device last event time
    if (deviceId && state.devices.has(deviceId)) {
      const device = state.devices.get(deviceId)!;
      device.lastEventAt = new Date();
    }
    
    // TODO: Parse event data (DP-401 format) - Issue #2
    // TODO: Check for active session in cache - Issue #5
    // TODO: If offline mode, create/add to offline batch - Issue #7
    // TODO: Store event locally - Issue #6
    // TODO: Stream to Cloud via WebSocket (if connected) - Issue #8
    
    // Send acknowledgment
    if (tcpServer) {
      tcpServer.send(socketId, "OK\n");
    }
  }
}

/**
 * Handle TCP socket disconnection
 */
function handleTCPDisconnect(socketId: string, meta: SocketMeta, reason: string): void {
  const deviceId = meta.deviceId || state.socketToDevice.get(socketId);
  
  console.log(`[TCP] Connection closed: ${deviceId || socketId} - ${reason}`);
  
  // Clean up socket → device mapping
  state.socketToDevice.delete(socketId);
  
  // Update device status
  if (deviceId && state.devices.has(deviceId)) {
    const device = state.devices.get(deviceId)!;
    device.tcpConnected = false;
    device.status = "disconnected";
    
    // TODO: Notify Cloud via WebSocket (device_disconnected) - Issue #4
  }
}

/**
 * Handle TCP socket error
 */
function handleTCPError(socketId: string, meta: SocketMeta | null, error: Error): void {
  const deviceId = meta?.deviceId || state.socketToDevice.get(socketId);
  console.error(`[TCP] Error on ${deviceId || socketId}:`, error.message);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log(BANNER);
  console.log(`[MAIN] Starting CarniTrack Edge Service...`);
  console.log(`[MAIN] Version: 0.3.0 (Cloud-Centric)`);
  console.log(`[MAIN] Runtime: Bun ${Bun.version}`);
  console.log("");
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Initialize Database
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("[INIT] Initializing database...");
  initDatabase();
  console.log(`[INIT] ✓ Database ready at: ${config.database.path}`);
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Load Edge Identity (from database)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("[INIT] Loading Edge identity...");
  const edgeConfig = getAllEdgeConfig();
  state.edgeId = edgeConfig.edge_id || null;
  state.siteId = edgeConfig.site_id || null;
  state.siteName = edgeConfig.site_name || null;
  
  if (state.edgeId) {
    console.log(`[INIT] ✓ Edge ID: ${state.edgeId}`);
    console.log(`[INIT] ✓ Site: ${state.siteName || state.siteId || "Unknown"}`);
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
  
  tcpServer = new TCPServer({
    onConnection: handleTCPConnection,
    onData: handleTCPData,
    onDisconnect: handleTCPDisconnect,
    onError: handleTCPError,
  });
  
  await tcpServer.start();
  setGlobalTCPServer(tcpServer);
  
  console.log(`[INIT] ✓ TCP Server listening on ${config.tcp.host}:${config.tcp.port}`);

  // ─────────────────────────────────────────────────────────────────────────────
  // Cloud WebSocket Connection (Placeholder - Issue #4)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("[INIT] Cloud WebSocket connection...");
  console.log(`[CLOUD] ⚠️  WebSocket connector not yet implemented (Issue #4)`);
  console.log(`[CLOUD]    Will connect to: ${config.websocket.url}`);
  state.cloudConnection = "disconnected";
  state.offlineMode = true; // Start in offline mode until connected

  // ─────────────────────────────────────────────────────────────────────────────
  // Start HTTP Server (Admin Dashboard & API)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("[INIT] Starting HTTP server for Admin Dashboard & API...");
  
  httpServer = Bun.serve({
    port: config.http.port,
    hostname: config.http.host,
    
    fetch(req: Request): Response {
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
          tcpConnections: tcpServer?.connectionCount || 0,
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
  
  console.log(`[INIT] ✓ HTTP Server listening on http://${config.http.host}:${config.http.port}`);

  // ─────────────────────────────────────────────────────────────────────────────
  // Start Heartbeat Monitor
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("[INIT] Starting heartbeat monitor...");
  startHeartbeatMonitor();
  console.log(`[INIT] ✓ Heartbeat monitor active (checking every ${config.heartbeat.checkIntervalMs / 1000}s)`);

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
  process.on("SIGINT", async () => {
    console.log("\n[MAIN] Received SIGINT, shutting down gracefully...");
    await shutdown();
  });
  
  process.on("SIGTERM", async () => {
    console.log("\n[MAIN] Received SIGTERM, shutting down gracefully...");
    await shutdown();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEARTBEAT MONITOR
// ═══════════════════════════════════════════════════════════════════════════════

let heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;

function startHeartbeatMonitor(): void {
  heartbeatIntervalId = setInterval(() => {
    const now = Date.now();
    const timeoutThreshold = config.heartbeat.timeoutMs;
    
    for (const [deviceId, device] of state.devices) {
      if (!device.tcpConnected) continue;
      
      const lastHB = device.lastHeartbeatAt?.getTime() || 0;
      const timeSinceHB = now - lastHB;
      
      if (timeSinceHB > timeoutThreshold) {
        // Device missed too many heartbeats
        if (device.status !== "disconnected") {
          console.log(`[MONITOR] ⚠️  Device ${deviceId} heartbeat timeout (${Math.round(timeSinceHB / 1000)}s)`);
          device.status = "disconnected";
          
          // Close the socket connection
          if (tcpServer && device.socketId) {
            tcpServer.closeSocket(device.socketId, "Heartbeat timeout");
          }
        }
      } else if (timeSinceHB > timeoutThreshold / 2) {
        // Device is getting stale
        if (device.status === "online") {
          console.log(`[MONITOR] Device ${deviceId} heartbeat delayed (${Math.round(timeSinceHB / 1000)}s)`);
          device.status = "stale";
        }
      }
    }
  }, config.heartbeat.checkIntervalMs);
}

function stopHeartbeatMonitor(): void {
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════════

async function shutdown(): Promise<void> {
  console.log("[SHUTDOWN] Stopping heartbeat monitor...");
  stopHeartbeatMonitor();
  
  console.log("[SHUTDOWN] Closing TCP server...");
  if (tcpServer) {
    await tcpServer.stop();
  }
  
  console.log("[SHUTDOWN] Closing HTTP server...");
  if (httpServer) {
    httpServer.stop();
  }
  
  console.log("[SHUTDOWN] Closing database...");
  closeDatabase();
  
  console.log("[SHUTDOWN] Goodbye! 👋");
  process.exit(0);
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
        activeSessions: 0, // TODO: Count from cache - Issue #5
        pendingOfflineBatches: 0, // TODO: Count from database - Issue #7
        pendingEventSync: 0, // TODO: Count from database - Issue #8
        cloudConnection: state.cloudConnection,
        offlineMode: state.offlineMode,
        pluUpdateNeeded: false,
        uptime: (Date.now() - state.startedAt.getTime()) / 1000,
        version: "0.3.0",
        tcp: tcpServer?.getStats() || null,
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
        lastHeartbeatAt: device.lastHeartbeatAt?.toISOString() || null,
        lastEventAt: device.lastEventAt?.toISOString() || null,
      })),
    });
  }
  
  // GET /api/tcp/connections - List active TCP connections
  if (path === "/api/tcp/connections" && req.method === "GET") {
    const connections = tcpServer?.getActiveConnections() || new Map();
    return Response.json({
      success: true,
      data: Array.from(connections.entries()).map(([socketId, meta]) => ({
        socketId,
        deviceId: meta.deviceId,
        remoteAddress: meta.remoteAddress,
        connectedAt: meta.connectedAt.toISOString(),
        lastDataAt: meta.lastDataAt?.toISOString() || null,
      })),
    });
  }
  
  // GET /api/tcp/stats - TCP server statistics
  if (path === "/api/tcp/stats" && req.method === "GET") {
    return Response.json({
      success: true,
      data: tcpServer?.getStats() || null,
    });
  }
  
  // GET /api/sessions - List cached sessions (Placeholder - Issue #5)
  if (path === "/api/sessions" && req.method === "GET") {
    return Response.json({
      success: true,
      data: [],
    });
  }
  
  // GET /api/events - List recent events (Placeholder - Issue #6)
  if (path === "/api/events" && req.method === "GET") {
    return Response.json({
      success: true,
      data: [],
    });
  }
  
  // GET /api/offline-batches - List offline batches (Placeholder - Issue #7)
  if (path === "/api/offline-batches" && req.method === "GET") {
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
    }
    
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
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
    
    .header-left { display: flex; align-items: center; gap: 1rem; }
    
    .logo { font-size: 1.25rem; font-weight: 700; color: var(--accent-green); }
    .logo span { color: var(--text-primary); }
    
    .badge {
      font-size: 0.65rem;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge-admin { background: var(--accent-yellow); color: var(--bg-primary); }
    .badge-offline { background: var(--accent-orange); color: var(--bg-primary); }
    .badge-online { background: var(--accent-green-muted); color: var(--text-primary); }
    
    .header-right { display: flex; align-items: center; gap: 1rem; font-size: 0.75rem; color: var(--text-secondary); }
    
    .connection-status { display: flex; align-items: center; gap: 0.5rem; }
    
    .status-dot { width: 8px; height: 8px; border-radius: 50%; }
    .status-dot.online { background: var(--accent-green); }
    .status-dot.offline { background: var(--accent-orange); animation: pulse 2s ease-in-out infinite; }
    
    main {
      flex: 1;
      padding: 1.5rem;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1rem;
      max-width: 1600px;
      margin: 0 auto;
      width: 100%;
    }
    
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 1.25rem;
    }
    
    .card-title {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-secondary);
      margin-bottom: 1rem;
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
    
    .stat-value { font-size: 2.5rem; font-weight: 700; line-height: 1; }
    .stat-value.warning { color: var(--accent-yellow); }
    .stat-label { font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.5rem; }
    
    .device-list { display: flex; flex-direction: column; gap: 0.5rem; }
    
    .device-item {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem;
      background: var(--bg-secondary);
      border-radius: 6px;
    }
    
    .device-status { width: 8px; height: 8px; border-radius: 50%; }
    .device-status.online { background: var(--accent-green); }
    .device-status.stale { background: var(--accent-orange); }
    .device-status.disconnected { background: var(--accent-red); }
    
    .device-info { flex: 1; }
    .device-name { font-weight: 600; font-size: 0.85rem; }
    .device-meta { font-size: 0.7rem; color: var(--text-secondary); }
    
    .empty-state { text-align: center; padding: 2rem; color: var(--text-secondary); }
    .empty-icon { font-size: 2rem; margin-bottom: 0.75rem; opacity: 0.5; }
    .empty-text { font-size: 0.8rem; }
    
    .card-wide { grid-column: span 2; }
    @media (max-width: 768px) { .card-wide { grid-column: span 1; } }
    
    footer {
      background: var(--bg-secondary);
      border-top: 1px solid var(--border-color);
      padding: 0.75rem 2rem;
      text-align: center;
      font-size: 0.65rem;
      color: var(--text-muted);
    }
    
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  </style>
</head>
<body>
  <header>
    <div class="header-left">
      <div class="logo">CARNI<span>TRACK</span></div>
      <span class="badge badge-admin">Admin</span>
      <span class="badge badge-offline" id="mode-badge">OFFLINE</span>
    </div>
    <div class="header-right">
      <div class="connection-status">
        <span class="status-dot offline" id="cloud-dot"></span>
        <span id="cloud-status">Cloud: Disconnected</span>
      </div>
      <div id="edge-id">Edge: -</div>
    </div>
  </header>
  
  <main>
    <div class="card">
      <div class="card-title">Connected Scales</div>
      <div class="stat-value" id="device-count">0</div>
      <div class="stat-label">devices online</div>
    </div>
    
    <div class="card">
      <div class="card-title">Active Sessions</div>
      <div class="stat-value" id="session-count">0</div>
      <div class="stat-label">from cloud cache</div>
    </div>
    
    <div class="card">
      <div class="card-title">Pending Sync</div>
      <div class="stat-value warning" id="pending-count">0</div>
      <div class="stat-label">events waiting</div>
    </div>
    
    <div class="card">
      <div class="card-title">Offline Batches</div>
      <div class="stat-value" id="batch-count">0</div>
      <div class="stat-label">awaiting reconciliation</div>
    </div>
    
    <div class="card card-wide">
      <div class="card-title">Devices</div>
      <div class="device-list" id="device-list">
        <div class="empty-state">
          <div class="empty-icon">📡</div>
          <div class="empty-text">Waiting for scale connections...</div>
        </div>
      </div>
    </div>
    
    <div class="card card-wide">
      <div class="card-title">TCP Stats</div>
      <div id="tcp-stats" style="font-size: 0.8rem; color: var(--text-secondary);">Loading...</div>
    </div>
  </main>
  
  <footer>CarniTrack Edge v0.3.0 • Admin Dashboard • Refresh: 3s</footer>
  
  <script>
    async function update() {
      try {
        const res = await fetch('/api/status');
        const { data } = await res.json();
        
        const devCount = Object.keys(data.devices).length;
        document.getElementById('device-count').textContent = devCount;
        document.getElementById('session-count').textContent = data.activeSessions;
        document.getElementById('pending-count').textContent = data.pendingEventSync;
        document.getElementById('batch-count').textContent = data.pendingOfflineBatches;
        
        const dot = document.getElementById('cloud-dot');
        const status = document.getElementById('cloud-status');
        const badge = document.getElementById('mode-badge');
        
        if (data.cloudConnection === 'connected') {
          dot.className = 'status-dot online';
          status.textContent = 'Cloud: Connected';
          badge.className = 'badge badge-online';
          badge.textContent = 'ONLINE';
        } else {
          dot.className = 'status-dot offline';
          status.textContent = 'Cloud: ' + data.cloudConnection;
          badge.className = 'badge badge-offline';
          badge.textContent = 'OFFLINE';
        }
        
        document.getElementById('edge-id').textContent = data.edgeId 
          ? 'Edge: ' + data.edgeId.substring(0, 8) + '...'
          : 'Edge: Not Registered';
        
        const list = document.getElementById('device-list');
        if (devCount === 0) {
          list.innerHTML = '<div class="empty-state"><div class="empty-icon">📡</div><div class="empty-text">Waiting for scale connections...</div></div>';
        } else {
          list.innerHTML = Object.entries(data.devices).map(([id, st]) => 
            '<div class="device-item"><div class="device-status ' + st + '"></div><div class="device-info"><div class="device-name">' + id + '</div><div class="device-meta">Status: ' + st + '</div></div></div>'
          ).join('');
        }
        
        if (data.tcp) {
          document.getElementById('tcp-stats').innerHTML = 
            'Connections: ' + data.tcp.connectionCount + ' | Total: ' + data.tcp.totalConnections + ' | Received: ' + formatBytes(data.tcp.totalBytesReceived);
        }
      } catch (e) { console.error('Update failed:', e); }
    }
    
    function formatBytes(b) {
      if (!b) return '0 B';
      const k = 1024, s = ['B','KB','MB'];
      const i = Math.floor(Math.log(b) / Math.log(k));
      return (b / Math.pow(k, i)).toFixed(1) + ' ' + s[i];
    }
    
    update();
    setInterval(update, 3000);
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
