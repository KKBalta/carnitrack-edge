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
import { ScaleParser, getAckResponse, toParsedScaleEvent } from "./devices/scale-parser.ts";
import type { ParsedPacket } from "./devices/scale-parser.ts";
import { initDeviceManager, getDeviceManager } from "./devices/device-manager.ts";
import type { CloudConnectionState } from "./types/index.ts";

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
  startedAt: new Date(),
};

// References to servers for graceful shutdown
let tcpServer: TCPServer | null = null;
let httpServer: ReturnType<typeof Bun.serve> | null = null;

// Scale packet parser (handles TCP stream buffering)
const scaleParser = new ScaleParser();

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
 * Uses ScaleParser for proper TCP stream buffering and packet parsing
 */
function handleTCPData(socketId: string, data: Buffer, meta: SocketMeta): void {
  // Parse incoming data using the ScaleParser (handles buffering, partial packets)
  const result = scaleParser.parse(socketId, data);
  
  // Log any parse errors
  for (const error of result.errors) {
    console.warn(`[TCP] Parse error: ${error.reason} on line ${error.index}: ${error.line}`);
  }
  
  // Process each parsed packet
  for (const packet of result.packets) {
    handleParsedPacket(socketId, packet, meta);
  }
}

/**
 * Handle a single parsed packet from the scale
 */
function handleParsedPacket(socketId: string, packet: ParsedPacket, meta: SocketMeta): void {
  const deviceManager = getDeviceManager();
  
  switch (packet.type) {
    // ─────────────────────────────────────────────────────────────────────────
    // Registration packet (e.g., "SCALE-01")
    // ─────────────────────────────────────────────────────────────────────────
    case "registration": {
      const { deviceId, scaleNumber } = packet;
      console.log(`[TCP] Received from ${meta.remoteAddress}: ${packet.raw}`);
      
      // Update socket metadata with device ID
      if (tcpServer) {
        tcpServer.updateSocketMeta(socketId, { deviceId });
      }
      
      // Register device via DeviceManager (handles both new and reconnection)
      const device = deviceManager.registerDevice({
        socketId,
        scaleNumber,
        sourceIp: meta.remoteAddress,
      });
      
      console.log(`[TCP] ✓ Device registered: ${deviceId} (scale #${scaleNumber}) from ${meta.remoteAddress}`);
      console.log(`[TCP]    Global ID: ${device.globalDeviceId}`);
      
      // TODO: Notify Cloud via WebSocket (device_connected) - Issue #4
      // TODO: Check for active session in cache - Issue #5
      break;
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // Heartbeat ("HB")
    // ─────────────────────────────────────────────────────────────────────────
    case "heartbeat": {
      const device = deviceManager.updateHeartbeat(socketId);
      
      if (device) {
        console.log(`[TCP] ♥ Heartbeat from ${device.deviceId}`);
      } else {
        console.log(`[TCP] ♥ Heartbeat from unregistered socket ${socketId}`);
      }
      
      // TODO: Forward heartbeat to Cloud (for monitoring dashboard) - Issue #4
      break;
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // Acknowledgment request ("KONTROLLU AKTAR OK?")
    // ─────────────────────────────────────────────────────────────────────────
    case "ack_request": {
      console.log(`[TCP] Scale prompt received, sending OK`);
      if (tcpServer) {
        tcpServer.send(socketId, getAckResponse());
      }
      break;
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // Weighing event (parsed CSV data)
    // ─────────────────────────────────────────────────────────────────────────
    case "weighing_event": {
      const device = deviceManager.getDeviceBySocketId(socketId);
      const deviceId = device?.deviceId || meta.deviceId || "unknown";
      const eventData = packet.event;
      
      console.log(`[TCP] ⚖️  Weight event from ${deviceId}`);
      console.log(`[TCP]    PLU: ${eventData.pluCode} | Product: ${eventData.productName.trim()}`);
      console.log(`[TCP]    Weight: ${eventData.weightGrams}g | Barcode: ${eventData.barcode}`);
      console.log(`[TCP]    Time: ${eventData.time} ${eventData.date} | Operator: ${eventData.operator.trim()}`);
      
      // Update device last event time via DeviceManager
      deviceManager.updateOnEvent(socketId);
      
      // Convert to ParsedScaleEvent for further processing
      // This will be used by Event Processor (Issue #6) and Cloud Sync (Issue #8)
      const _parsedEvent = toParsedScaleEvent(eventData);
      void _parsedEvent; // Suppress unused warning until Issue #6 implemented
      
      // TODO: Check for active session in cache - Issue #5
      // TODO: If offline mode, create/add to offline batch - Issue #7
      // TODO: Store event locally (with session/batch linkage) - Issue #6
      // TODO: Stream to Cloud via WebSocket (if connected) - Issue #8
      
      // Send acknowledgment
      if (tcpServer) {
        tcpServer.send(socketId, getAckResponse());
      }
      break;
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // Unknown packet
    // ─────────────────────────────────────────────────────────────────────────
    case "unknown": {
      const device = deviceManager.getDeviceBySocketId(socketId);
      const deviceId = device?.deviceId || meta.deviceId || socketId;
      console.log(`[TCP] Unknown packet from ${deviceId}: ${packet.raw.substring(0, 100)}...`);
      console.log(`[TCP]    Reason: ${packet.reason}`);
      break;
    }
  }
}

/**
 * Handle TCP socket disconnection
 */
function handleTCPDisconnect(socketId: string, meta: SocketMeta, reason: string): void {
  const deviceManager = getDeviceManager();
  const device = deviceManager.getDeviceBySocketId(socketId);
  const deviceId = device?.deviceId || meta.deviceId || socketId;
  
  console.log(`[TCP] Connection closed: ${deviceId} - ${reason}`);
  
  // Clear parser buffer for this socket
  scaleParser.clearBuffer(socketId);
  
  // Disconnect device via DeviceManager
  deviceManager.disconnectDevice(socketId, reason);
  
  // TODO: Notify Cloud via WebSocket (device_disconnected) - Issue #4
}

/**
 * Handle TCP socket error
 */
function handleTCPError(socketId: string, meta: SocketMeta | null, error: Error): void {
  const deviceManager = getDeviceManager();
  const device = deviceManager.getDeviceBySocketId(socketId);
  const deviceId = device?.deviceId || meta?.deviceId || socketId;
  console.error(`[TCP] Error on ${deviceId}:`, error.message);
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
  // Initialize Device Manager
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("[INIT] Initializing Device Manager...");
  const deviceManager = initDeviceManager(state.siteId);
  console.log(`[INIT] ✓ Device Manager ready (${deviceManager.getDeviceCount()} devices loaded)`);
  
  // Set up device event listeners for logging
  deviceManager.on("registered", (device) => {
    console.log(`[DeviceEvent] New device registered: ${device.deviceId}`);
  });
  deviceManager.on("disconnected", (device) => {
    console.log(`[DeviceEvent] Device disconnected: ${device.deviceId}`);
  });
  deviceManager.on("stale", (device) => {
    console.log(`[DeviceEvent] Device stale: ${device.deviceId}`);
  });
  
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
    const deviceManager = getDeviceManager();
    const now = Date.now();
    const timeoutThreshold = config.heartbeat.timeoutMs;
    
    for (const device of deviceManager.getActiveDevices()) {
      const lastHB = device.lastHeartbeatAt?.getTime() || 0;
      const timeSinceHB = now - lastHB;
      
      if (timeSinceHB > timeoutThreshold) {
        // Device missed too many heartbeats
        if (device.status !== "disconnected") {
          console.log(`[MONITOR] ⚠️  Device ${device.deviceId} heartbeat timeout (${Math.round(timeSinceHB / 1000)}s)`);
          
          // Close the socket connection (this will trigger disconnect in DeviceManager)
          if (tcpServer && device.socketId) {
            tcpServer.closeSocket(device.socketId, "Heartbeat timeout");
          }
        }
      } else if (timeSinceHB > timeoutThreshold / 2) {
        // Device is getting stale
        if (device.status === "online" || device.status === "idle") {
          console.log(`[MONITOR] Device ${device.deviceId} heartbeat delayed (${Math.round(timeSinceHB / 1000)}s)`);
          deviceManager.markAsStale(device.deviceId);
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
  const deviceManager = getDeviceManager();
  
  // GET /api/status - System status
  if (path === "/api/status" && req.method === "GET") {
    return Response.json({
      success: true,
      data: {
        edgeId: state.edgeId,
        siteId: state.siteId,
        siteName: state.siteName,
        devices: deviceManager.getStatusSummary(),
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
      data: deviceManager.getAllDevices().map(device => ({
        deviceId: device.deviceId,
        globalDeviceId: device.globalDeviceId,
        status: device.status,
        tcpConnected: device.tcpConnected,
        sourceIp: device.sourceIp,
        heartbeatCount: device.heartbeatCount,
        eventCount: device.eventCount,
        activeCloudSessionId: device.activeCloudSessionId,
        lastHeartbeatAt: device.lastHeartbeatAt?.toISOString() || null,
        lastEventAt: device.lastEventAt?.toISOString() || null,
        connectedAt: device.connectedAt?.toISOString() || null,
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
