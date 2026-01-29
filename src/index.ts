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
import { initWebSocketClient, getWebSocketClient, destroyWebSocketClient } from "./cloud/index.ts";
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
      
      // Notify Cloud via WebSocket (device_connected)
      const wsClient = getWebSocketClient();
      if (wsClient) {
        wsClient.send({
          type: "device_connected",
          payload: {
            deviceId: device.deviceId,
            globalDeviceId: device.globalDeviceId || device.deviceId,
            sourceIp: meta.remoteAddress,
            deviceType: device.deviceType,
          },
        });
      }
      
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
        
        // Forward heartbeat to Cloud (for monitoring dashboard)
        const wsClient = getWebSocketClient();
        if (wsClient && wsClient.isConnected()) {
          wsClient.send({
            type: "device_heartbeat",
            payload: {
              deviceId: device.deviceId,
              globalDeviceId: device.globalDeviceId || device.deviceId,
              status: device.status,
              heartbeatCount: device.heartbeatCount,
              timestamp: new Date().toISOString(),
            },
          });
        }
      } else {
        console.log(`[TCP] ♥ Heartbeat from unregistered socket ${socketId}`);
      }
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
  
  // Notify Cloud via WebSocket (device_disconnected)
  const wsClient = getWebSocketClient();
  if (wsClient) {
    wsClient.send({
      type: "device_disconnected",
      payload: {
        deviceId: deviceId,
        reason: reason,
        timestamp: new Date().toISOString(),
      },
    });
  }
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
  // Cloud WebSocket Connection
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("[INIT] Initializing Cloud WebSocket connection...");
  
  const wsClient = initWebSocketClient({
    url: config.websocket.url,
    edgeIdentity: state.edgeId ? {
      edgeId: state.edgeId,
      siteId: state.siteId || "",
      siteName: state.siteName || "",
      registeredAt: new Date(),
    } : null,
    autoConnect: false, // We'll connect after setup
    queueWhenDisconnected: true,
  });
  
  // Set up WebSocket event handlers
  wsClient.on("connected", () => {
    console.log("[CLOUD] ✓ Connected to Cloud");
    state.cloudConnection = "connected";
    state.offlineMode = false;
  });
  
  wsClient.on("disconnected", (data: { reason?: string; code?: number }) => {
    console.log(`[CLOUD] Disconnected from Cloud: ${data.reason || "unknown"}`);
    state.cloudConnection = "disconnected";
    state.offlineMode = true;
  });
  
  wsClient.on("reconnecting", (data: { attempt: number; delay: number }) => {
    console.log(`[CLOUD] Reconnecting... (attempt #${data.attempt}, next in ${data.delay / 1000}s)`);
    state.cloudConnection = "reconnecting";
  });
  
  wsClient.on("error", (data: { error: string }) => {
    console.error(`[CLOUD] Error: ${data.error}`);
    state.cloudConnection = "error";
  });
  
  wsClient.on("state_change", (data: { previousStatus: string; currentStatus: CloudConnectionState }) => {
    state.cloudConnection = data.currentStatus;
  });
  
  // Handle incoming messages from Cloud
  wsClient.onMessage("session_started", (payload) => {
    console.log(`[CLOUD] ← Session started: ${JSON.stringify(payload)}`);
    // TODO: Cache session locally - Issue #5
  });
  
  wsClient.onMessage("session_ended", (payload) => {
    console.log(`[CLOUD] ← Session ended: ${JSON.stringify(payload)}`);
    // TODO: Remove from session cache - Issue #5
  });
  
  wsClient.onMessage("plu_updated", (payload) => {
    console.log(`[CLOUD] ← PLU updated: ${JSON.stringify(payload)}`);
    // TODO: Update local PLU cache
  });
  
  wsClient.onMessage("config_update", (payload) => {
    console.log(`[CLOUD] ← Config update: ${JSON.stringify(payload)}`);
    // TODO: Apply configuration changes
  });
  
  // Start connection attempt
  console.log(`[CLOUD] Connecting to: ${config.websocket.url}`);
  wsClient.connect();
  
  // Start in offline mode until connected
  state.cloudConnection = wsClient.getStatus();
  state.offlineMode = !wsClient.isConnected();

  // ─────────────────────────────────────────────────────────────────────────────
  // Start HTTP Server (Admin Dashboard & API)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("[INIT] Starting HTTP server for Admin Dashboard & API...");
  
  httpServer = Bun.serve({
    port: config.http.port,
    hostname: config.http.host,
    
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      
      // API Routes
      if (path.startsWith("/api/")) {
        return await handleApi(req, path);
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
  
  console.log("[SHUTDOWN] Closing WebSocket connection...");
  destroyWebSocketClient();
  
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

async function handleApi(req: Request, path: string): Promise<Response> {
  const deviceManager = getDeviceManager();
  
  // GET /api/status - System status
  if (path === "/api/status" && req.method === "GET") {
    const wsClient = getWebSocketClient();
    const wsState = wsClient?.getState();
    
    return Response.json({
      success: true,
      data: {
        edgeId: state.edgeId,
        siteId: state.siteId,
        siteName: state.siteName,
        devices: deviceManager.getStatusSummary(),
        activeSessions: 0, // TODO: Count from cache - Issue #5
        pendingOfflineBatches: 0, // TODO: Count from database - Issue #7
        pendingEventSync: wsClient?.getQueueSize() || 0,
        cloudConnection: state.cloudConnection,
        offlineMode: state.offlineMode,
        pluUpdateNeeded: false,
        uptime: (Date.now() - state.startedAt.getTime()) / 1000,
        version: "0.3.0",
        tcp: tcpServer?.getStats() || null,
        websocket: wsState ? {
          status: wsState.status,
          lastConnected: wsState.lastConnected?.toISOString() || null,
          lastError: wsState.lastError,
          reconnectAttempts: wsState.reconnectAttempts,
          queuedMessages: wsClient?.getQueueSize() || 0,
        } : null,
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
        displayName: device.displayName,
        location: device.location,
        deviceType: device.deviceType,
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
  
  // PUT /api/devices/:deviceId - Update device config (rename, location, etc.)
  const deviceUpdateMatch = path.match(/^\/api\/devices\/([A-Za-z0-9-]+)$/);
  if (deviceUpdateMatch && req.method === "PUT") {
    const deviceId = deviceUpdateMatch[1];
    
    try {
      const body = await req.json() as {
        displayName?: string | null;
        location?: string | null;
        deviceType?: string;
      };
      
      const success = deviceManager.updateDeviceConfig(deviceId, {
        displayName: body.displayName,
        location: body.location,
        deviceType: body.deviceType as "disassembly" | "retail" | "receiving" | undefined,
      });
      
      if (!success) {
        return Response.json({ success: false, error: "Device not found" }, { status: 404 });
      }
      
      const device = deviceManager.getDevice(deviceId);
      return Response.json({
        success: true,
        data: device ? {
          deviceId: device.deviceId,
          globalDeviceId: device.globalDeviceId,
          displayName: device.displayName,
          location: device.location,
          deviceType: device.deviceType,
          status: device.status,
        } : null,
      });
    } catch (e) {
      return Response.json({ success: false, error: "Invalid request body" }, { status: 400 });
    }
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
      transition: background 0.2s;
    }
    .device-item:hover { background: var(--bg-card); }
    
    .device-status { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .device-status.online { background: var(--accent-green); }
    .device-status.idle { background: var(--accent-blue); }
    .device-status.stale { background: var(--accent-orange); }
    .device-status.disconnected { background: var(--accent-red); }
    
    .device-info { flex: 1; min-width: 0; }
    .device-name { font-weight: 600; font-size: 0.85rem; display: flex; align-items: center; gap: 0.5rem; }
    .device-name .device-id { color: var(--text-secondary); font-weight: 400; font-size: 0.75rem; }
    .device-meta { font-size: 0.7rem; color: var(--text-secondary); margin-top: 0.25rem; }
    .device-location { color: var(--accent-blue); }
    .device-stats { display: flex; gap: 1rem; margin-top: 0.25rem; }
    .device-stats span { font-size: 0.65rem; color: var(--text-muted); }
    
    .device-actions { display: flex; gap: 0.5rem; }
    .btn-edit {
      background: transparent;
      border: 1px solid var(--border-color);
      color: var(--text-secondary);
      padding: 0.35rem 0.6rem;
      border-radius: 4px;
      font-size: 0.7rem;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.2s;
    }
    .btn-edit:hover { background: var(--bg-card); color: var(--text-primary); border-color: var(--accent-blue); }
    
    .empty-state { text-align: center; padding: 2rem; color: var(--text-secondary); }
    .empty-icon { font-size: 2rem; margin-bottom: 0.75rem; opacity: 0.5; }
    .empty-text { font-size: 0.8rem; }
    
    /* Modal */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.7);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .modal-overlay.open { display: flex; }
    .modal {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 1.5rem;
      width: 90%;
      max-width: 400px;
    }
    .modal-title { font-size: 1rem; font-weight: 600; margin-bottom: 1rem; }
    .form-group { margin-bottom: 1rem; }
    .form-label { display: block; font-size: 0.7rem; color: var(--text-secondary); margin-bottom: 0.35rem; text-transform: uppercase; letter-spacing: 0.5px; }
    .form-input {
      width: 100%;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      padding: 0.6rem 0.8rem;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 0.85rem;
    }
    .form-input:focus { outline: none; border-color: var(--accent-blue); }
    .form-hint { font-size: 0.65rem; color: var(--text-muted); margin-top: 0.25rem; }
    .modal-actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1.25rem; }
    .btn {
      padding: 0.5rem 1rem;
      border-radius: 4px;
      font-size: 0.8rem;
      cursor: pointer;
      font-family: inherit;
      font-weight: 600;
      transition: all 0.2s;
    }
    .btn-cancel { background: transparent; border: 1px solid var(--border-color); color: var(--text-secondary); }
    .btn-cancel:hover { background: var(--bg-secondary); color: var(--text-primary); }
    .btn-primary { background: var(--accent-green-muted); border: none; color: var(--text-primary); }
    .btn-primary:hover { background: var(--accent-green); }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    
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
  
  <!-- Edit Device Modal -->
  <div class="modal-overlay" id="edit-modal">
    <div class="modal">
      <div class="modal-title">📝 Cihaz Düzenle</div>
      <form id="edit-form">
        <input type="hidden" id="edit-device-id">
        <div class="form-group">
          <label class="form-label">Cihaz Adı</label>
          <input type="text" class="form-input" id="edit-display-name" placeholder="örn: Sakat Tartısı">
          <div class="form-hint">Kullanıcı dostu isim (boş bırakılabilir)</div>
        </div>
        <div class="form-group">
          <label class="form-label">Konum</label>
          <input type="text" class="form-input" id="edit-location" placeholder="örn: Kesimhane A Bölümü">
          <div class="form-hint">Cihazın fiziksel konumu</div>
        </div>
        <div class="form-group">
          <label class="form-label">Tip</label>
          <select class="form-input" id="edit-device-type">
            <option value="disassembly">Parçalama (Disassembly)</option>
            <option value="retail">Perakende (Retail)</option>
            <option value="receiving">Kabul (Receiving)</option>
          </select>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-cancel" onclick="closeModal()">İptal</button>
          <button type="submit" class="btn btn-primary" id="save-btn">Kaydet</button>
        </div>
      </form>
    </div>
  </div>
  
  <script>
    let devices = [];
    
    async function update() {
      try {
        // Fetch status for stats
        const statusRes = await fetch('/api/status');
        const { data: statusData } = await statusRes.json();
        
        // Fetch detailed device info
        const devRes = await fetch('/api/devices');
        const { data: devData } = await devRes.json();
        devices = devData || [];
        
        const devCount = devices.filter(d => d.tcpConnected).length;
        document.getElementById('device-count').textContent = devCount;
        document.getElementById('session-count').textContent = statusData.activeSessions;
        document.getElementById('pending-count').textContent = statusData.pendingEventSync;
        document.getElementById('batch-count').textContent = statusData.pendingOfflineBatches;
        
        const dot = document.getElementById('cloud-dot');
        const status = document.getElementById('cloud-status');
        const badge = document.getElementById('mode-badge');
        
        if (statusData.cloudConnection === 'connected') {
          dot.className = 'status-dot online';
          status.textContent = 'Cloud: Connected';
          badge.className = 'badge badge-online';
          badge.textContent = 'ONLINE';
        } else {
          dot.className = 'status-dot offline';
          status.textContent = 'Cloud: ' + statusData.cloudConnection;
          badge.className = 'badge badge-offline';
          badge.textContent = 'OFFLINE';
        }
        
        document.getElementById('edge-id').textContent = statusData.edgeId 
          ? 'Edge: ' + statusData.edgeId.substring(0, 8) + '...'
          : 'Edge: Not Registered';
        
        renderDevices();
        
        if (statusData.tcp) {
          document.getElementById('tcp-stats').innerHTML = 
            'Connections: ' + statusData.tcp.connectionCount + ' | Total: ' + statusData.tcp.totalConnections + ' | Received: ' + formatBytes(statusData.tcp.totalBytesReceived);
        }
      } catch (e) { console.error('Update failed:', e); }
    }
    
    function renderDevices() {
      const list = document.getElementById('device-list');
      if (devices.length === 0) {
        list.innerHTML = '<div class="empty-state"><div class="empty-icon">📡</div><div class="empty-text">Waiting for scale connections...</div></div>';
        return;
      }
      
      list.innerHTML = devices.map(d => {
        const name = d.displayName || d.deviceId;
        const showId = d.displayName ? '<span class="device-id">(' + d.deviceId + ')</span>' : '';
        const location = d.location ? '<span class="device-location">📍 ' + d.location + '</span>' : '';
        const stats = '<div class="device-stats"><span>💓 ' + d.heartbeatCount + '</span><span>📦 ' + d.eventCount + '</span></div>';
        
        return '<div class="device-item">' +
          '<div class="device-status ' + d.status + '"></div>' +
          '<div class="device-info">' +
            '<div class="device-name">' + name + ' ' + showId + '</div>' +
            '<div class="device-meta">' + (location || 'Durum: ' + d.status) + '</div>' +
            stats +
          '</div>' +
          '<div class="device-actions">' +
            '<button class="btn-edit" onclick="editDevice(\\'' + d.deviceId + '\\')">✏️ Düzenle</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }
    
    function editDevice(deviceId) {
      const device = devices.find(d => d.deviceId === deviceId);
      if (!device) return;
      
      document.getElementById('edit-device-id').value = deviceId;
      document.getElementById('edit-display-name').value = device.displayName || '';
      document.getElementById('edit-location').value = device.location || '';
      document.getElementById('edit-device-type').value = device.deviceType || 'disassembly';
      
      document.getElementById('edit-modal').classList.add('open');
    }
    
    function closeModal() {
      document.getElementById('edit-modal').classList.remove('open');
    }
    
    document.getElementById('edit-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('save-btn');
      btn.disabled = true;
      btn.textContent = 'Kaydediliyor...';
      
      try {
        const deviceId = document.getElementById('edit-device-id').value;
        const res = await fetch('/api/devices/' + deviceId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            displayName: document.getElementById('edit-display-name').value || null,
            location: document.getElementById('edit-location').value || null,
            deviceType: document.getElementById('edit-device-type').value,
          })
        });
        
        if (res.ok) {
          closeModal();
          await update();
        } else {
          alert('Kaydetme başarısız!');
        }
      } catch (err) {
        alert('Hata: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Kaydet';
      }
    });
    
    // Close modal on overlay click
    document.getElementById('edit-modal').addEventListener('click', (e) => {
      if (e.target.id === 'edit-modal') closeModal();
    });
    
    // Close modal on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });
    
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
