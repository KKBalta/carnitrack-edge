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

import { networkInterfaces } from "os";
import { existsSync } from "fs";
import { config } from "./config.ts";
import {
  initDatabase,
  closeDatabase,
  getAllEdgeConfig,
  setEdgeConfig,
  deleteEdgeConfig,
} from "./storage/database.ts";
import { TCPServer, setGlobalTCPServer } from "./devices/tcp-server.ts";
import type { SocketMeta } from "./devices/tcp-server.ts";
import { ScaleParser, getAckResponse } from "./devices/scale-parser.ts";
import type { ParsedPacket } from "./devices/scale-parser.ts";
import { initDeviceManager, getDeviceManager } from "./devices/device-manager.ts";
import { initEventProcessor, getEventProcessor, destroyEventProcessor } from "./devices/event-processor.ts";
import { initSessionCacheManager, getSessionCacheManager, destroySessionCacheManager } from "./sessions/index.ts";
import { 
  initRestClient, 
  getRestClient, 
  destroyRestClient,
  RestResponseError,
  initOfflineBatchManager,
  getOfflineBatchManager,
  destroyOfflineBatchManager,
  initCloudSyncService,
  getCloudSyncService,
  destroyCloudSyncService,
  updateCloudConfig,
  getHeartbeatIntervalMs,
  type HeartbeatPayload,
} from "./cloud/index.ts";
import type { CloudConnectionState, EdgeIdentity } from "./types/index.ts";
import { isValidUuid } from "./utils/uuid.ts";

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
// UTILITY: GET LOCAL IP ADDRESS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the local IP addresses of this machine
 * Returns all non-internal IPv4 addresses
 */
function getLocalIpAddresses(): string[] {
  const interfaces = networkInterfaces();
  const addresses: string[] = [];
  
  for (const name of Object.keys(interfaces)) {
    const nets = interfaces[name];
    if (!nets) continue;
    
    for (const net of nets) {
      // Skip internal (i.e., 127.0.0.1) and non-IPv4 addresses
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push(net.address);
      }
    }
  }
  
  return addresses;
}

/**
 * Get the primary local IP address (first non-internal IPv4)
 * If HOST_IP environment variable is set (useful in Docker), use that instead
 */
function getPrimaryLocalIp(): string {
  // Allow override via environment variable (useful for Docker containers)
  if (process.env.HOST_IP) {
    return process.env.HOST_IP;
  }
  const addresses = getLocalIpAddresses();
  return addresses[0] || '127.0.0.1';
}

/**
 * Check if we're likely running inside a Docker container (sync .dockerenv check only).
 * Uses fs.existsSync because Bun.file() does not throw when the file doesn't exist.
 */
function isRunningInDocker(): boolean {
  return existsSync("/.dockerenv");
}

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
async function handleTCPData(socketId: string, data: Buffer, meta: SocketMeta): Promise<void> {
  // Parse incoming data using the ScaleParser (handles buffering, partial packets)
  const result = scaleParser.parse(socketId, data);
  
  // Log any parse errors
  for (const error of result.errors) {
    console.warn(`[TCP] Parse error: ${error.reason} on line ${error.index}: ${error.line}`);
  }
  
  // Process each parsed packet (await so registration's poll completes before event)
  for (const packet of result.packets) {
    await handleParsedPacket(socketId, packet, meta);
  }
}

/**
 * Handle a single parsed packet from the scale
 */
async function handleParsedPacket(socketId: string, packet: ParsedPacket, meta: SocketMeta): Promise<void> {
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
      
      console.log(
        `[TCP] ✓ Device connected (deviceId=${deviceId}, edgeId=${state.edgeId ?? "—"}, globalId=${device.globalDeviceId ?? "—"}) from ${meta.remoteAddress}`
      );
      
      // Poll sessions immediately so we have the latest session before the first event arrives
      // (send-scale-event sends registration + event in quick succession)
      const sessionCache = getSessionCacheManager();
      try {
        await sessionCache.pollNow();
        const sessionAfterPoll = sessionCache.getActiveSessionForDevice(deviceId);
        if (sessionAfterPoll) {
          console.log(`[TCP]    Session cached for ${deviceId}: ${sessionAfterPoll.cloudSessionId}`);
        } else {
          console.log(`[TCP]    No session found for ${deviceId} after poll (create session on Cloud first)`);
        }
      } catch (err) {
        console.warn("[TCP] Immediate session poll failed:", err);
      }
      
      // Notify Cloud via REST API (device_connected)
      const restClient = getRestClient();
      if (restClient && restClient.isOnline()) {
        restClient.postDeviceStatus({
          deviceId: device.deviceId,
          status: device.status,
          heartbeatCount: device.heartbeatCount,
          eventCount: device.eventCount,
          globalDeviceId: device.globalDeviceId || device.deviceId,
          sourceIp: meta.remoteAddress,
          deviceType: device.deviceType,
        }).catch(error => {
          console.error("[TCP] Failed to post device status:", error);
        });
      }
      
      // Check for active session in cache
      const activeSession = sessionCache.getActiveSessionForDevice(deviceId);
      if (activeSession) {
        console.log(`[TCP]    Active session: ${activeSession.cloudSessionId}`);
      }
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
        const restClient = getRestClient();
        if (restClient && restClient.isOnline()) {
          restClient.postDeviceStatus({
            deviceId: device.deviceId,
            status: device.status,
            heartbeatCount: device.heartbeatCount,
            eventCount: device.eventCount,
            globalDeviceId: device.globalDeviceId || device.deviceId,
            timestamp: new Date().toISOString(),
          }).catch(error => {
            console.error("[TCP] Failed to post device heartbeat:", error);
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
      console.log(`[TCP]    Weight: ${eventData.weightGrams}g | Tare: ${eventData.tareGrams}g | Barcode: ${eventData.barcode}`);
      console.log(`[TCP]    Time: ${eventData.time} ${eventData.date} | Operator: ${eventData.operator.trim()}`);
      
      // Update device last event time via DeviceManager
      deviceManager.updateOnEvent(socketId);
      
      // Process weighing event through Event Processor
      // This handles session tagging, offline batch management, and local storage
      // Deduplication prevents processing the same event twice (scale sends once for weight, once for print)
      const eventProcessor = getEventProcessor();
      const processedEvent = eventProcessor.processWeighingEvent(
        eventData,
        deviceId,
        meta.remoteAddress
      );
      
      // Check if event was skipped due to deduplication
      if (!processedEvent) {
        console.log(`[TCP]    ⚠️  Event skipped (duplicate detected)`);
        // Still send acknowledgment to scale
        if (tcpServer) {
          tcpServer.send(socketId, getAckResponse());
        }
        break;
      }
      
      console.log(
        `[TCP] Event stored (localEventId=${processedEvent.id}, deviceId=${deviceId}, cloudSessionId=${processedEvent.cloudSessionId ?? "—"}, offlineBatchId=${processedEvent.offlineBatchId ?? "—"})`
      );
      
      // Event Processor emits "event:captured" which CloudSyncService listens to
      // CloudSyncService will automatically stream the event if Cloud is connected
      
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
  
  console.log(`[TCP] Device disconnected (deviceId=${deviceId}, reason=${reason}, edgeId=${state.edgeId ?? "—"})`);
  
  // Clear parser buffer for this socket
  scaleParser.clearBuffer(socketId);
  
  // Disconnect device via DeviceManager
  deviceManager.disconnectDevice(socketId, reason);
  
  // Notify Cloud via REST API (device_disconnected)
  const restClient = getRestClient();
  if (restClient && restClient.isOnline()) {
    restClient.postDeviceStatus({
      deviceId: deviceId,
      status: "disconnected",
      heartbeatCount: 0,
      eventCount: 0,
      reason: reason,
      timestamp: new Date().toISOString(),
    }).catch(error => {
      console.error("[TCP] Failed to post device disconnect:", error);
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
// EDGE REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Perform Edge registration with Cloud
 */
function clearStoredEdgeIdentity(): void {
  deleteEdgeConfig("edge_id");
  deleteEdgeConfig("site_id");
  deleteEdgeConfig("site_name");
  deleteEdgeConfig("registered_at");
  deleteEdgeConfig("cloud_config");

  state.edgeId = null;
  state.siteId = null;
  state.siteName = null;
}

function getCurrentEdgeIdentity(): EdgeIdentity | null {
  if (!state.edgeId || !isValidUuid(state.edgeId)) {
    return null;
  }

  return {
    edgeId: state.edgeId,
    siteId: state.siteId || "",
    siteName: state.siteName || "",
    registeredAt: new Date(),
  };
}

const MAX_REGISTRATION_ATTEMPTS = 2;
const REGISTRATION_RETRY_DELAY_MS = 2_000;

async function performEdgeRegistration(
  restClient: ReturnType<typeof getRestClient>,
  reason: "startup" | "missing_or_invalid" | "auth_recovery" = "startup"
): Promise<EdgeIdentity> {
  if (!restClient) {
    throw new Error("REST client not available");
  }

  console.log(`[REGISTRATION] Registering Edge with Cloud (reason=${reason})...`);
  if (config.edge.name) {
    console.log(`[REGISTRATION] Edge Name: ${config.edge.name}`);
  }

  const buildRegistrationPayload = (edgeId: string | null) => ({
    edgeId,
    siteId: config.edge.siteId || state.siteId || null,
    siteName: config.edge.name || (config.edge.siteId ? `Site ${config.edge.siteId}` : state.siteName || null),
    version: "0.3.0",
    capabilities: ["rest", "tcp"],
  });

  let attempt = 0;
  let lastError: unknown;

  while (attempt < MAX_REGISTRATION_ATTEMPTS) {
    attempt++;
    try {
      const existingEdgeId = state.edgeId && isValidUuid(state.edgeId) ? state.edgeId : null;
      const registrationData = buildRegistrationPayload(existingEdgeId);
      const response = await restClient.register(registrationData);

      // Store Edge identity atomically
      setEdgeConfig("edge_id", response.edgeId);
      setEdgeConfig("site_id", response.siteId);
      setEdgeConfig("site_name", response.siteName);
      setEdgeConfig("registered_at", new Date().toISOString());
      setEdgeConfig("cloud_config", JSON.stringify(response.config || {}));
      updateCloudConfig((response.config as Record<string, unknown>) || {});

      state.edgeId = response.edgeId;
      state.siteId = response.siteId;
      state.siteName = response.siteName;

      restClient.setEdgeIdentity({
        edgeId: response.edgeId,
        siteId: response.siteId,
        siteName: response.siteName,
        registeredAt: new Date(),
      });

      console.log(`[REGISTRATION] ✓ Edge registered successfully (edgeId=${response.edgeId})`);
      console.log(`[REGISTRATION]   Endpoint: ${restClient.getEdgeApiBase()}`);
      console.log(`[REGISTRATION]   Site: ${response.siteId} / ${response.siteName}`);
      return {
        edgeId: response.edgeId,
        siteId: response.siteId,
        siteName: response.siteName,
        registeredAt: new Date(),
      };
    } catch (error) {
      lastError = error;

      if (error instanceof RestResponseError) {
        const bodyLower = (error.bodyText || "").toLowerCase();
        const isInvalidEdgeId = error.status === 400 && (bodyLower.includes("edge") || bodyLower.includes("uuid") || bodyLower.includes("invalid"));
        const isEdgeNotFound = error.status === 404 || bodyLower.includes("edge not found") || bodyLower.includes("not found");

        if (isInvalidEdgeId || isEdgeNotFound) {
          console.warn(`[REGISTRATION] Backend ${error.status}: ${error.bodyText?.slice(0, 100) || "—"}. Clearing local edgeId and retrying as first registration.`);
          clearStoredEdgeIdentity();
          restClient.clearEdgeIdentity();
          if (attempt < MAX_REGISTRATION_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, REGISTRATION_RETRY_DELAY_MS));
            continue;
          }
        }
      }

      console.error(`[REGISTRATION] ✗ Registration failed (reason=${reason}, attempt=${attempt}, edgeId=${state.edgeId ?? "—"}): ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  console.error(`[REGISTRATION] ✗ Registration failed after ${MAX_REGISTRATION_ATTEMPTS} attempts`);
  throw lastError;
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
  const storedEdgeId = edgeConfig.edge_id || null;
  state.siteId = edgeConfig.site_id || null;
  state.siteName = edgeConfig.site_name || null;
  state.edgeId = storedEdgeId;

  if (storedEdgeId && !isValidUuid(storedEdgeId)) {
    console.warn(`[INIT] ⚠️ Invalid local edgeId detected (${storedEdgeId}). Clearing and re-registering.`);
    clearStoredEdgeIdentity();
  }
  
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
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Initialize Session Cache Manager (Issue #5)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("[INIT] Initializing Session Cache Manager...");
  initSessionCacheManager();
  console.log("[INIT] ✓ Session Cache Manager ready");
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Initialize Event Processor (Issue #6)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("[INIT] Initializing Event Processor...");
  initEventProcessor();
  console.log("[INIT] ✓ Event Processor ready");
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Initialize Offline Batch Manager (Issue #7)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("[INIT] Initializing Offline Batch Manager...");
  initOfflineBatchManager();
  console.log("[INIT] ✓ Offline Batch Manager ready");
  
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
  const localIp = getPrimaryLocalIp();
  const allLocalIps = getLocalIpAddresses();
  
  console.log("");
  console.log("┌─────────────────────────────────────────────────────────────────┐");
  console.log("│                      CONFIGURATION                              │");
  console.log("├─────────────────────────────────────────────────────────────────┤");
  console.log(`│  Local IP:       ${localIp.padEnd(45)}│`);
  console.log(`│  TCP Server:     ${config.tcp.host}:${config.tcp.port.toString().padEnd(37)}│`);
  console.log(`│  HTTP Server:    ${config.http.host}:${config.http.port.toString().padEnd(37)}│`);
  console.log(`│  REST API:       ${config.rest.apiUrl.substring(0, 43).padEnd(43)}│`);
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
  // Cloud REST Client Connection
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("[INIT] Initializing Cloud REST client...");

  let restClient: ReturnType<typeof initRestClient>;
  const ensureEdgeIdentity = async (
    reason: "missing_or_invalid" | "auth_recovery"
  ): Promise<EdgeIdentity> => {
    if (reason === "auth_recovery") {
      console.warn("[REGISTRATION] Backend reported invalid/unknown edge. Clearing local edge identity before re-register.");
      clearStoredEdgeIdentity();
      restClient.clearEdgeIdentity();
    } else if (state.edgeId && !isValidUuid(state.edgeId)) {
      console.warn(`[REGISTRATION] Invalid local edgeId replaced: ${state.edgeId}`);
      clearStoredEdgeIdentity();
      restClient.clearEdgeIdentity();
    }

    const currentIdentity = getCurrentEdgeIdentity();
    if (currentIdentity) {
      return currentIdentity;
    }

    return performEdgeRegistration(restClient, reason);
  };

  restClient = initRestClient({
    apiUrl: config.rest.apiUrl,
    edgeIdentity: getCurrentEdgeIdentity(),
    ensureEdgeIdentity,
    autoStart: false,
    queueWhenOffline: true,
  });

  // Bootstrap strict UUID edge identity before normal Cloud activity.
  if (!state.edgeId || !isValidUuid(state.edgeId)) {
    try {
      await ensureEdgeIdentity("missing_or_invalid");
      console.log("[INIT] ✓ Edge identity bootstrap complete");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[INIT] Edge identity bootstrap failed: ${msg}`);
      console.log("[INIT] Continuing startup; registration will retry on Cloud requests.");
    }
  }
  
  // Set up REST client event handlers
  const offlineBatchManager = getOfflineBatchManager();
  
  restClient.on("connected", async () => {
    console.log("[CLOUD] ✓ Connected to Cloud");
    state.cloudConnection = "connected";
    state.offlineMode = false;
    
    // Register Edge if not already registered or malformed.
    if (!state.edgeId || !isValidUuid(state.edgeId)) {
      console.log("[CLOUD] Edge not registered, attempting registration...");
      try {
        await ensureEdgeIdentity("missing_or_invalid");
      } catch (error) {
        console.error("[CLOUD] Registration failed:", error);
      }
    }
    
    // Refresh runtime config from Cloud (sessionPollIntervalMs, heartbeatIntervalMs, etc.)
    try {
      const cloudConfig = await restClient.getConfig();
      updateCloudConfig(cloudConfig as Record<string, unknown>);
    } catch (err) {
      // Non-fatal; we keep previous config
    }
    
    // End any active offline batches when Cloud reconnects
    const activeBatches = offlineBatchManager.getActiveBatches();
    for (const batch of activeBatches) {
      offlineBatchManager.endBatch(batch.id);
      console.log(`[OfflineBatch] Ended batch ${batch.id} on Cloud reconnect`);
    }
  });
  
  restClient.on("disconnected", () => {
    console.log(`[CLOUD] Disconnected from Cloud`);
    state.cloudConnection = "disconnected";
    state.offlineMode = true;
    
    // Start offline batch for each active device when Cloud disconnects
    // Only create a new batch if one doesn't already exist for the device
    const deviceManager = getDeviceManager();
    const activeDevices = deviceManager.getActiveDevices();
    for (const device of activeDevices) {
      if (device.status === "online" || device.status === "idle") {
        // Check if there's already an active batch for this device
        const activeBatches = offlineBatchManager.getActiveBatches();
        const existingBatch = activeBatches.find(b => b.deviceId === device.deviceId);
        
        if (existingBatch) {
          console.log(`[OfflineBatch] Using existing batch ${existingBatch.id} for device ${device.deviceId}`);
        } else {
          const batch = offlineBatchManager.startBatch(device.deviceId);
          console.log(`[OfflineBatch] Started batch ${batch.id} for device ${device.deviceId}`);
        }
      }
    }
  });
  
  restClient.on("error", (data: { error: string }) => {
    console.error(`[CLOUD] Error: ${data.error}`);
    state.cloudConnection = "error";
  });
  
  restClient.on("state_change", (data: { previousStatus: string; currentStatus: CloudConnectionState }) => {
    state.cloudConnection = data.currentStatus;
  });
  
  // Set up session polling
  const sessionCache = getSessionCacheManager();
  sessionCache.setRestClient(restClient);
  sessionCache.setDeviceManager(deviceManager);
  sessionCache.startPolling();
  
  // Start aggregated heartbeat loop (POST /heartbeat)
  startAggregatedHeartbeatLoop();
  
  // Start connection check
  console.log(`[CLOUD] REST API URL: ${config.rest.apiUrl}`);
  restClient.start();
  
  // Start in offline mode until connected
  state.cloudConnection = restClient.getStatus();
  state.offlineMode = !restClient.isOnline();
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Initialize Cloud Sync Service
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("[INIT] Initializing Cloud Sync Service...");
  const syncService = initCloudSyncService();
  syncService.start();
  console.log("[INIT] ✓ Cloud Sync Service started");

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
  console.log(`║   🖥️  Local IP Address:   ${localIp}`.padEnd(68) + "║");
  console.log(`║   📡 Scales connect to:  ${localIp}:${config.tcp.port}`.padEnd(68) + "║");
  console.log(`║   🌐 Admin Dashboard:    http://${localIp}:${config.http.port}`.padEnd(68) + "║");
  console.log(`║   ☁️  Cloud Status:       ${state.cloudConnection.toUpperCase()}`.padEnd(68) + "║");
  console.log("║                                                                   ║");
  if (state.offlineMode) {
    console.log("║   ⚠️  OFFLINE MODE - Events will be batched for later sync        ║");
  } else {
    console.log("║   ✓ ONLINE - Events streaming to Cloud in real-time              ║");
  }
  console.log("║                                                                   ║");
  // Show all network interfaces if multiple
  if (allLocalIps.length > 1) {
    console.log("║   📌 All Network Interfaces:                                      ║");
    for (const ip of allLocalIps) {
      console.log(`║      - ${ip}`.padEnd(68) + "║");
    }
    console.log("║                                                                   ║");
  }
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
// AGGREGATED HEARTBEAT (POST /heartbeat)
// ═══════════════════════════════════════════════════════════════════════════════

const EDGE_VERSION = "0.3.0";
const HEARTBEAT_MAX_RETRIES = 5;
const HEARTBEAT_BASE_DELAY_MS = 1000;
const HEARTBEAT_JITTER_FRACTION = 0.2;

let aggregatedHeartbeatTimeoutId: ReturnType<typeof setTimeout> | null = null;
let aggregatedHeartbeatActive = false;

function computeHealth(): "ok" | "degraded" | "error" {
  const restClient = getRestClient();
  if (!restClient?.isOnline()) return "error";
  const deviceManager = getDeviceManager();
  const all = deviceManager.getAllDevices();
  const disconnected = all.filter(d => d.status === "disconnected").length;
  const stale = all.filter(d => d.status === "stale").length;
  if (disconnected === all.length && all.length > 0) return "error";
  if (stale > 0 || disconnected > 0) return "degraded";
  return "ok";
}

function buildHeartbeatPayload(): HeartbeatPayload {
  const deviceManager = getDeviceManager();
  const devices = deviceManager.getAllDevices();
  const uptimeSec = Math.floor((Date.now() - state.startedAt.getTime()) / 1000);
  return {
    version: EDGE_VERSION,
    uptimeSec,
    health: computeHealth(),
    devices: devices.map(d => ({
      deviceId: d.deviceId,
      globalDeviceId: d.globalDeviceId ?? undefined,
      deviceType: d.deviceType,
      status: d.status,
      lastHeartbeatAt: d.lastHeartbeatAt?.toISOString() ?? new Date(0).toISOString(),
      lastEventAt: d.lastEventAt?.toISOString() ?? undefined,
    })),
  };
}

async function sendAggregatedHeartbeat(): Promise<boolean> {
  const restClient = getRestClient();
  if (!restClient || !state.edgeId || !isValidUuid(state.edgeId)) {
    return false;
  }
  const payload = buildHeartbeatPayload();
  try {
    const response = await restClient.postHeartbeat(payload);
    if (response.ok) {
      console.log(
        `[HEARTBEAT] ✓ POST /heartbeat ok (edgeId=${state.edgeId}, devices=${payload.devices.length}, health=${payload.health})`
      );
      return true;
    }
    return false;
  } catch (err) {
    console.warn(
      `[HEARTBEAT] ✗ POST /heartbeat failed (edgeId=${state.edgeId}): ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

function scheduleNextAggregatedHeartbeat(): void {
  if (!aggregatedHeartbeatActive) return;
  const intervalMs = getHeartbeatIntervalMs();
  aggregatedHeartbeatTimeoutId = setTimeout(async () => {
    aggregatedHeartbeatTimeoutId = null;
    if (!aggregatedHeartbeatActive) return;
    let success = await sendAggregatedHeartbeat();
    let retries = 0;
    while (!success && retries < HEARTBEAT_MAX_RETRIES && aggregatedHeartbeatActive) {
      const baseDelay = HEARTBEAT_BASE_DELAY_MS * Math.pow(2, retries);
      const jitter = baseDelay * HEARTBEAT_JITTER_FRACTION * (2 * Math.random() - 1);
      const delay = Math.max(0, Math.round(baseDelay + jitter));
      await new Promise(r => setTimeout(r, delay));
      retries++;
      success = await sendAggregatedHeartbeat();
    }
    if (aggregatedHeartbeatActive) {
      scheduleNextAggregatedHeartbeat();
    }
  }, intervalMs);
}

function startAggregatedHeartbeatLoop(): void {
  stopAggregatedHeartbeatLoop();
  aggregatedHeartbeatActive = true;
  const intervalMs = getHeartbeatIntervalMs();
  console.log(`[HEARTBEAT] Aggregated heartbeat loop started (interval ${intervalMs}ms, config-driven)`);
  scheduleNextAggregatedHeartbeat();
}

function stopAggregatedHeartbeatLoop(): void {
  aggregatedHeartbeatActive = false;
  if (aggregatedHeartbeatTimeoutId !== null) {
    clearTimeout(aggregatedHeartbeatTimeoutId);
    aggregatedHeartbeatTimeoutId = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEARTBEAT MONITOR (device TCP heartbeat timeout)
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
  console.log("[SHUTDOWN] Stopping aggregated heartbeat loop...");
  stopAggregatedHeartbeatLoop();
  
  console.log("[SHUTDOWN] Stopping heartbeat monitor...");
  stopHeartbeatMonitor();
  
  console.log("[SHUTDOWN] Stopping Cloud Sync Service...");
  destroyCloudSyncService();
  
  console.log("[SHUTDOWN] Destroying Event Processor...");
  destroyEventProcessor();
  
  console.log("[SHUTDOWN] Destroying Session Cache Manager...");
  destroySessionCacheManager();
  
  console.log("[SHUTDOWN] Destroying Offline Batch Manager...");
  destroyOfflineBatchManager();
  
  console.log("[SHUTDOWN] Stopping session polling...");
  const sessionCache = getSessionCacheManager();
  sessionCache.stopPolling();
  
  console.log("[SHUTDOWN] Closing REST client...");
  destroyRestClient();
  
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
    const restClient = getRestClient();
    const restState = restClient?.getState();
    
    return Response.json({
      success: true,
      data: {
        edgeId: state.edgeId,
        siteId: state.siteId,
        siteName: state.siteName,
        localIp: getPrimaryLocalIp(),
        allLocalIps: getLocalIpAddresses(),
        scaleConnectionAddress: `${getPrimaryLocalIp()}:${config.tcp.port}`,
        dashboardUrl: `http://${getPrimaryLocalIp()}:${config.http.port}`,
        devices: deviceManager.getStatusSummary(),
        activeSessions: getSessionCacheManager().getAllActiveSessions().length,
        pendingOfflineBatches: getOfflineBatchManager().getPendingSyncBatches().length,
        pendingEventSync: getCloudSyncService().getPendingCount(),
        cloudConnection: state.cloudConnection,
        offlineMode: state.offlineMode,
        pluUpdateNeeded: false,
        uptime: (Date.now() - state.startedAt.getTime()) / 1000,
        version: "0.3.0",
        tcp: tcpServer?.getStats() || null,
        rest: restState ? {
          status: restState.status,
          lastConnected: restState.lastConnected?.toISOString() || null,
          lastError: restState.lastError,
          consecutiveFailures: restState.consecutiveFailures,
          queuedRequests: restClient?.getQueueSize() || 0,
          isOnline: restClient?.isOnline() || false,
        } : null,
      },
    });
  }
  
  // GET /api/devices - List devices (with optional status filter)
  if (path === "/api/devices" && req.method === "GET") {
    const url = new URL(req.url);
    const statusFilter = url.searchParams.get("status"); // e.g., "online", "idle", "disconnected"
    const onlineOnly = url.searchParams.get("online") === "true"; // Filter for online devices only
    
    let devices = deviceManager.getAllDevices();
    
    // Apply filters
    if (onlineOnly) {
      devices = devices.filter(d => d.tcpConnected && (d.status === "online" || d.status === "idle"));
    } else if (statusFilter) {
      devices = devices.filter(d => d.status === statusFilter);
    }
    
    return Response.json({
      success: true,
      data: devices.map(device => ({
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
  
  // POST /api/register - Manually trigger Edge registration
  if (path === "/api/register" && req.method === "POST") {
    const restClient = getRestClient();
    if (!restClient) {
      return Response.json({
        success: false,
        error: "REST client not initialized",
      }, { status: 500 });
    }
    
    if (!restClient.isOnline()) {
      return Response.json({
        success: false,
        error: "Cloud not connected. Cannot register while offline.",
      }, { status: 503 });
    }
    
    try {
      await performEdgeRegistration(restClient);
      return Response.json({
        success: true,
        data: {
          edgeId: state.edgeId,
          siteId: state.siteId,
          siteName: state.siteName,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return Response.json({
        success: false,
        error: errorMessage,
      }, { status: 500 });
    }
  }
  
  // PUT /api/devices/:deviceId - Update device config (rename, location, etc.)
  const deviceUpdateMatch = path.match(/^\/api\/devices\/([A-Za-z0-9-]+)$/);
  if (deviceUpdateMatch && req.method === "PUT") {
    let deviceId = deviceUpdateMatch[1];
    
    // Normalize device ID to uppercase (device IDs are always uppercase like "SCALE-01")
    deviceId = deviceId.toUpperCase();
    
    try {
      const body = await req.json() as {
        displayName?: string | null;
        location?: string | null;
        deviceType?: string;
      };
      
      // Normalize empty strings to null (database expects null, not empty string)
      const normalizedDisplayName = body.displayName === "" ? null : body.displayName;
      const normalizedLocation = body.location === "" ? null : body.location;
      
      // Check if device exists before attempting update
      const existingDevice = deviceManager.getDevice(deviceId);
      if (!existingDevice) {
        return Response.json({ 
          success: false, 
          error: `Device not found: ${deviceId}. Make sure the device is registered first (it must send a SCALE-XX packet).`,
          availableDevices: deviceManager.getAllDevices().map(d => d.deviceId)
        }, { status: 404 });
      }
      
      const success = deviceManager.updateDeviceConfig(deviceId, {
        displayName: normalizedDisplayName,
        location: normalizedLocation,
        deviceType: body.deviceType as "disassembly" | "retail" | "receiving" | undefined,
      });
      
      if (!success) {
        return Response.json({ success: false, error: "Failed to update device config" }, { status: 500 });
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
      const errorMessage = e instanceof Error ? e.message : "Invalid request body";
      return Response.json({ success: false, error: errorMessage }, { status: 400 });
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
  
  // GET /api/sessions - List cached sessions
  if (path === "/api/sessions" && req.method === "GET") {
    const sessionCache = getSessionCacheManager();
    const sessions = sessionCache.getAllActiveSessions();
    
    return Response.json({
      success: true,
      data: sessions.map(session => ({
        cloudSessionId: session.cloudSessionId,
        deviceId: session.deviceId,
        animalId: session.animalId,
        animalTag: session.animalTag,
        animalSpecies: session.animalSpecies,
        operatorId: session.operatorId,
        status: session.status,
        cachedAt: session.cachedAt.toISOString(),
        lastUpdatedAt: session.lastUpdatedAt?.toISOString() || null,
        expiresAt: session.expiresAt.toISOString(),
      })),
    });
  }
  
  // GET /api/events - List recent events
  if (path === "/api/events" && req.method === "GET") {
    const eventProcessor = getEventProcessor();
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") || "100", 10);
    const deviceId = url.searchParams.get("deviceId") || null;
    const sessionId = url.searchParams.get("sessionId") || null;
    const batchId = url.searchParams.get("batchId") || null;
    
    let events;
    if (deviceId) {
      events = eventProcessor.getEventsByDevice(deviceId, limit);
    } else if (sessionId) {
      events = eventProcessor.getEventsBySession(sessionId);
    } else if (batchId) {
      events = eventProcessor.getEventsByBatch(batchId);
    } else {
      events = eventProcessor.getPendingEvents(limit);
    }
    
    return Response.json({
      success: true,
      data: events.map(event => ({
        id: event.id,
        deviceId: event.deviceId,
        cloudSessionId: event.cloudSessionId,
        offlineMode: event.offlineMode,
        offlineBatchId: event.offlineBatchId,
        pluCode: event.pluCode,
        productName: event.productName,
        weightGrams: event.weightGrams,
        barcode: event.barcode,
        scaleTimestamp: event.scaleTimestamp.toISOString(),
        receivedAt: event.receivedAt.toISOString(),
        sourceIp: event.sourceIp,
        syncStatus: event.syncStatus,
        cloudId: event.cloudId,
        syncedAt: event.syncedAt?.toISOString() || null,
        syncAttempts: event.syncAttempts,
        lastSyncError: event.lastSyncError,
      })),
    });
  }
  
  // GET /api/offline-batches - List offline batches
  if (path === "/api/offline-batches" && req.method === "GET") {
    const offlineBatchManager = getOfflineBatchManager();
    const url = new URL(req.url);
    const status = url.searchParams.get("status") || null;
    
    let batches;
    if (status === "pending") {
      batches = offlineBatchManager.getPendingSyncBatches();
    } else if (status === "active") {
      batches = offlineBatchManager.getActiveBatches();
    } else {
      // Return all batches (we'd need a method for this, but for now return pending)
      batches = offlineBatchManager.getPendingSyncBatches();
    }
    
    return Response.json({
      success: true,
      data: batches.map(batch => ({
        id: batch.id,
        deviceId: batch.deviceId,
        startedAt: batch.startedAt.toISOString(),
        endedAt: batch.endedAt?.toISOString() || null,
        eventCount: batch.eventCount,
        totalWeightGrams: batch.totalWeightGrams,
        reconciliationStatus: batch.reconciliationStatus,
        cloudSessionId: batch.cloudSessionId,
        reconciledAt: batch.reconciledAt?.toISOString() || null,
        reconciledBy: batch.reconciledBy,
        notes: batch.notes,
      })),
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
