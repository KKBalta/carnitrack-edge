/**
 * CarniTrack Cloud - Mock WebSocket Server
 * 
 * A simple mock WebSocket server for testing the Edge WebSocket client.
 * Simulates Cloud behavior for development and testing.
 * 
 * Run with: bun run src/cloud/mock-server.ts
 * 
 * Features:
 * - Accepts Edge connections
 * - Responds to registration
 * - Sends session start/end messages
 * - Acknowledges events
 * - Sends periodic pings
 * 
 * @see GitHub Issue #4
 */

import type { CloudMessage, CloudToEdgeMessageType, SessionStartedPayload } from "../types/index.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = Number(process.env.MOCK_WS_PORT) || 3001;
const HOST = process.env.MOCK_WS_HOST || "0.0.0.0";

// ═══════════════════════════════════════════════════════════════════════════════
// MOCK DATA
// ═══════════════════════════════════════════════════════════════════════════════

const mockSessions: Map<string, { deviceId: string; animalTag: string }> = new Map();
let messageIdCounter = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function generateId(): string {
  return `mock-${Date.now()}-${++messageIdCounter}`;
}

function createMessage<T>(type: CloudToEdgeMessageType, payload: T): CloudMessage<T> {
  return {
    type,
    payload,
    timestamp: new Date().toISOString(),
    messageId: generateId(),
  };
}

function log(message: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString().substring(11, 23);
  console.log(`[${timestamp}] [MOCK] ${message}`, ...args);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BANNER
// ═══════════════════════════════════════════════════════════════════════════════

const BANNER = `
╔═══════════════════════════════════════════════════════════════════════════════╗
║                                                                               ║
║   ██████╗██╗      ██████╗ ██╗   ██╗██████╗     ███╗   ███╗ ██████╗  ██████╗██╗   ██║
║  ██╔════╝██║     ██╔═══██╗██║   ██║██╔══██╗    ████╗ ████║██╔═══██╗██╔════╝██║  ██╔╝║
║  ██║     ██║     ██║   ██║██║   ██║██║  ██║    ██╔████╔██║██║   ██║██║     █████╔╝ ║
║  ██║     ██║     ██║   ██║██║   ██║██║  ██║    ██║╚██╔╝██║██║   ██║██║     ██╔═██╗ ║
║  ╚██████╗███████╗╚██████╔╝╚██████╔╝██████╔╝    ██║ ╚═╝ ██║╚██████╔╝╚██████╗██║  ██╗║
║   ╚═════╝╚══════╝ ╚═════╝  ╚═════╝ ╚═════╝     ╚═╝     ╚═╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝║
║                                                                               ║
║                        M O C K   S E R V E R                                  ║
║                                                                               ║
║                    For Testing Edge WebSocket Client                          ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`;

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET SERVER
// ═══════════════════════════════════════════════════════════════════════════════

interface EdgeConnection {
  edgeId: string | null;
  siteId: string | null;
  connectedAt: Date;
  lastMessageAt: Date;
}

const connections = new Map<WebSocket, EdgeConnection>();

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  
  fetch(req, server) {
    const url = new URL(req.url);
    
    // WebSocket upgrade for /edge/ws path
    if (url.pathname === "/edge/ws" || url.pathname === "/edge" || url.pathname === "/") {
      const edgeId = req.headers.get("X-Edge-Id");
      const siteId = req.headers.get("X-Site-Id");
      
      log(`Upgrade request from Edge: ${edgeId || "unregistered"}`);
      
      const success = server.upgrade(req, {
        data: { edgeId, siteId },
      });
      
      if (success) {
        return undefined;
      }
      
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    
    // Health check
    if (url.pathname === "/health") {
      return Response.json({ 
        status: "ok", 
        connections: connections.size,
        timestamp: new Date().toISOString(),
      });
    }
    
    // API to trigger session start (for testing)
    if (url.pathname === "/api/test/session/start" && req.method === "POST") {
      return handleTestSessionStart(req);
    }
    
    // API to trigger session end (for testing)
    if (url.pathname === "/api/test/session/end" && req.method === "POST") {
      return handleTestSessionEnd(req);
    }
    
    // API to send custom message (for testing)
    if (url.pathname === "/api/test/message" && req.method === "POST") {
      return handleTestMessage(req);
    }
    
    // API to list connections
    if (url.pathname === "/api/connections" && req.method === "GET") {
      const connList = Array.from(connections.entries()).map(([, conn]) => ({
        edgeId: conn.edgeId,
        siteId: conn.siteId,
        connectedAt: conn.connectedAt.toISOString(),
        lastMessageAt: conn.lastMessageAt.toISOString(),
      }));
      return Response.json({ connections: connList });
    }
    
    // Help page
    if (url.pathname === "/help") {
      return new Response(getHelpHtml(), { 
        headers: { "Content-Type": "text/html" },
      });
    }
    
    return new Response("Not Found", { status: 404 });
  },
  
  websocket: {
    open(ws) {
      const data = ws.data as { edgeId?: string; siteId?: string };
      
      connections.set(ws as unknown as WebSocket, {
        edgeId: data.edgeId || null,
        siteId: data.siteId || null,
        connectedAt: new Date(),
        lastMessageAt: new Date(),
      });
      
      log(`✓ Edge connected: ${data.edgeId || "unregistered"} (${connections.size} total)`);
    },
    
    message(ws, message) {
      const conn = connections.get(ws as unknown as WebSocket);
      if (conn) {
        conn.lastMessageAt = new Date();
      }
      
      try {
        const text = typeof message === "string" ? message : message.toString();
        const msg = JSON.parse(text) as CloudMessage;
        
        handleEdgeMessage(ws as unknown as WebSocket, msg, conn);
      } catch (err) {
        log(`Failed to parse message: ${err}`);
      }
    },
    
    close(ws, code, reason) {
      const conn = connections.get(ws as unknown as WebSocket);
      log(`Edge disconnected: ${conn?.edgeId || "unknown"} (code=${code}, reason=${reason})`);
      connections.delete(ws as unknown as WebSocket);
    },
    
    error(ws, error) {
      log(`WebSocket error: ${error}`);
    },
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

function handleEdgeMessage(ws: WebSocket, msg: CloudMessage, conn: EdgeConnection | undefined): void {
  log(`← Received: ${msg.type}`);
  
  switch (msg.type) {
    case "register":
      handleRegister(ws, msg, conn);
      break;
      
    case "event":
      handleEvent(ws, msg);
      break;
      
    case "event_batch":
      handleEventBatch(ws, msg);
      break;
      
    case "device_connected":
      handleDeviceConnected(ws, msg);
      break;
      
    case "device_disconnected":
      handleDeviceDisconnected(ws, msg);
      break;
      
    case "device_heartbeat":
      // Just acknowledge
      log(`  Device heartbeat received`);
      break;
      
    case "ping":
      // Respond to Edge ping with pong
      sendToEdge(ws, { type: "pong" as CloudToEdgeMessageType, payload: {} });
      break;
      
    case "pong":
      // Keep-alive response from Edge
      break;
      
    case "status":
      log(`  Edge status update`);
      break;
      
    case "offline_batch_start":
      log(`  Offline batch started: ${JSON.stringify(msg.payload)}`);
      break;
      
    case "offline_batch_end":
      log(`  Offline batch ended: ${JSON.stringify(msg.payload)}`);
      break;
      
    default:
      log(`  Unknown message type: ${msg.type}`);
  }
}

function handleRegister(ws: WebSocket, msg: CloudMessage, conn: EdgeConnection | undefined): void {
  const payload = msg.payload as { edgeId?: string; siteId?: string; version?: string };
  
  log(`  Registration from Edge:`);
  log(`    Edge ID: ${payload.edgeId || "not assigned"}`);
  log(`    Site ID: ${payload.siteId || "not assigned"}`);
  log(`    Version: ${payload.version || "unknown"}`);
  
  // Update connection info
  if (conn) {
    conn.edgeId = payload.edgeId || conn.edgeId;
    conn.siteId = payload.siteId || conn.siteId;
  }
  
  // If Edge doesn't have an ID, assign one (simulating Cloud registration)
  const assignedEdgeId = payload.edgeId || `edge-${Date.now()}`;
  const assignedSiteId = payload.siteId || "mock-site-001";
  
  // Send registration acknowledgment
  const response = createMessage("config_update", {
    edgeId: assignedEdgeId,
    siteId: assignedSiteId,
    siteName: "Mock Test Site",
    registrationStatus: "registered",
  });
  
  sendToEdge(ws, response);
  log(`→ Sent registration confirmation`);
}

function handleEvent(ws: WebSocket, msg: CloudMessage): void {
  const payload = msg.payload as { localEventId: string; deviceId: string; weightGrams: number };
  
  log(`  Event from ${payload.deviceId}: ${payload.weightGrams}g`);
  
  // Send acknowledgment
  const ack = createMessage("event_ack", {
    localEventId: payload.localEventId,
    cloudEventId: generateId(),
    status: "accepted",
  });
  
  sendToEdge(ws, ack);
  log(`→ Sent event acknowledgment`);
}

function handleEventBatch(ws: WebSocket, msg: CloudMessage): void {
  const payload = msg.payload as { events: unknown[]; batchId: string };
  
  log(`  Event batch: ${payload.events.length} events (batch: ${payload.batchId})`);
  
  // Acknowledge each event
  for (const event of payload.events as { localEventId: string }[]) {
    const ack = createMessage("event_ack", {
      localEventId: event.localEventId,
      cloudEventId: generateId(),
      status: "accepted",
    });
    sendToEdge(ws, ack);
  }
  
  log(`→ Sent ${payload.events.length} acknowledgments`);
}

function handleDeviceConnected(ws: WebSocket, msg: CloudMessage): void {
  const payload = msg.payload as { deviceId: string; globalDeviceId: string };
  log(`  Device connected: ${payload.deviceId} (${payload.globalDeviceId})`);
}

function handleDeviceDisconnected(ws: WebSocket, msg: CloudMessage): void {
  const payload = msg.payload as { deviceId: string };
  log(`  Device disconnected: ${payload.deviceId}`);
}

function sendToEdge(ws: WebSocket, message: CloudMessage): void {
  try {
    // @ts-expect-error - Bun WebSocket API difference
    ws.send(JSON.stringify(message));
  } catch (err) {
    log(`Failed to send message: ${err}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST API HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

async function handleTestSessionStart(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { deviceId: string; animalTag?: string };
    const sessionId = generateId();
    
    mockSessions.set(sessionId, {
      deviceId: body.deviceId,
      animalTag: body.animalTag || `A-${Math.floor(Math.random() * 1000)}`,
    });
    
    const payload: SessionStartedPayload = {
      cloudSessionId: sessionId,
      deviceId: body.deviceId,
      animalId: generateId(),
      animalTag: mockSessions.get(sessionId)!.animalTag,
      animalSpecies: "Dana",
      operatorId: "mock-operator",
    };
    
    const message = createMessage("session_started", payload);
    
    // Broadcast to all connected edges
    for (const [ws] of connections) {
      sendToEdge(ws, message);
    }
    
    log(`→ Broadcast session_started for ${body.deviceId}`);
    
    return Response.json({ 
      success: true, 
      sessionId,
      message: "Session started broadcast sent",
    });
  } catch (err) {
    return Response.json({ success: false, error: String(err) }, { status: 400 });
  }
}

async function handleTestSessionEnd(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { sessionId: string; reason?: string };
    
    const session = mockSessions.get(body.sessionId);
    if (!session) {
      return Response.json({ success: false, error: "Session not found" }, { status: 404 });
    }
    
    const message = createMessage("session_ended", {
      cloudSessionId: body.sessionId,
      deviceId: session.deviceId,
      reason: body.reason || "completed",
    });
    
    // Broadcast to all connected edges
    for (const [ws] of connections) {
      sendToEdge(ws, message);
    }
    
    mockSessions.delete(body.sessionId);
    log(`→ Broadcast session_ended for ${body.sessionId}`);
    
    return Response.json({ 
      success: true, 
      message: "Session ended broadcast sent",
    });
  } catch (err) {
    return Response.json({ success: false, error: String(err) }, { status: 400 });
  }
}

async function handleTestMessage(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { type: CloudToEdgeMessageType; payload: unknown };
    
    const message = createMessage(body.type, body.payload);
    
    // Broadcast to all connected edges
    for (const [ws] of connections) {
      sendToEdge(ws, message);
    }
    
    log(`→ Broadcast custom message: ${body.type}`);
    
    return Response.json({ 
      success: true, 
      message: `Message type ${body.type} broadcast sent`,
    });
  } catch (err) {
    return Response.json({ success: false, error: String(err) }, { status: 400 });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELP PAGE
// ═══════════════════════════════════════════════════════════════════════════════

function getHelpHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Mock Cloud Server - Help</title>
  <style>
    body { font-family: monospace; background: #1a1a2e; color: #eee; padding: 2rem; max-width: 800px; margin: 0 auto; }
    h1 { color: #3fb950; }
    h2 { color: #58a6ff; margin-top: 2rem; }
    code { background: #21262d; padding: 0.2rem 0.5rem; border-radius: 4px; }
    pre { background: #21262d; padding: 1rem; border-radius: 8px; overflow-x: auto; }
    .endpoint { margin: 1rem 0; padding: 1rem; background: #161b22; border-radius: 8px; border-left: 3px solid #3fb950; }
    .method { color: #3fb950; font-weight: bold; }
  </style>
</head>
<body>
  <h1>🧪 Mock Cloud Server</h1>
  <p>This server simulates the CarniTrack Cloud for testing the Edge WebSocket client.</p>
  
  <h2>WebSocket Endpoint</h2>
  <div class="endpoint">
    <span class="method">WS</span> <code>ws://localhost:${PORT}/edge/ws</code>
    <p>Connect your Edge client here for testing.</p>
  </div>
  
  <h2>Test APIs</h2>
  
  <div class="endpoint">
    <span class="method">POST</span> <code>/api/test/session/start</code>
    <p>Trigger a session_started message to all connected Edges.</p>
    <pre>curl -X POST http://localhost:${PORT}/api/test/session/start \\
  -H "Content-Type: application/json" \\
  -d '{"deviceId": "SCALE-01", "animalTag": "A-123"}'</pre>
  </div>
  
  <div class="endpoint">
    <span class="method">POST</span> <code>/api/test/session/end</code>
    <p>Trigger a session_ended message.</p>
    <pre>curl -X POST http://localhost:${PORT}/api/test/session/end \\
  -H "Content-Type: application/json" \\
  -d '{"sessionId": "mock-xxx", "reason": "completed"}'</pre>
  </div>
  
  <div class="endpoint">
    <span class="method">POST</span> <code>/api/test/message</code>
    <p>Send a custom message to all Edges.</p>
    <pre>curl -X POST http://localhost:${PORT}/api/test/message \\
  -H "Content-Type: application/json" \\
  -d '{"type": "ping", "payload": {}}'</pre>
  </div>
  
  <div class="endpoint">
    <span class="method">GET</span> <code>/api/connections</code>
    <p>List all connected Edges.</p>
    <pre>curl http://localhost:${PORT}/api/connections</pre>
  </div>
  
  <div class="endpoint">
    <span class="method">GET</span> <code>/health</code>
    <p>Health check endpoint.</p>
  </div>
  
  <h2>Environment Variables</h2>
  <pre>MOCK_WS_PORT=${PORT}  # WebSocket server port
MOCK_WS_HOST=${HOST}  # Server host</pre>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

console.log(BANNER);
console.log(`[MOCK] Mock Cloud WebSocket Server starting...`);
console.log(`[MOCK] ✓ Server listening on ws://${HOST}:${PORT}/edge/ws`);
console.log(`[MOCK] ✓ Help page: http://localhost:${PORT}/help`);
console.log(`[MOCK] ✓ Health check: http://localhost:${PORT}/health`);
console.log("");
console.log(`[MOCK] Waiting for Edge connections...`);
console.log("");

// Periodic status log
setInterval(() => {
  if (connections.size > 0) {
    log(`Active connections: ${connections.size}`);
  }
}, 60000);
