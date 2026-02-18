/**
 * CarniTrack Cloud - Mock REST Server
 * 
 * A mock REST API server for testing the Edge REST client.
 * Simulates Cloud behavior for development and testing.
 * 
 * Run with: bun run src/cloud/mock-rest-server.ts
 * 
 * Endpoints (no duplicated /edge/; prefix /api/v1/edge/):
 * - GET  /api/v1/edge/sessions?device_ids=...
 * - POST /api/v1/edge/events
 * - POST /api/v1/edge/events/batch
 * - GET  /api/v1/edge/config
 * - POST /api/v1/edge/register
 * - POST /api/v1/edge/devices/status
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = Number(process.env.MOCK_REST_PORT) || 4000;
const HOST = process.env.MOCK_REST_HOST || "0.0.0.0";
const EDGE_API_URL = process.env.EDGE_API_URL || "http://localhost:3000";

// ═══════════════════════════════════════════════════════════════════════════════
// IN-MEMORY DATA STORES
// ═══════════════════════════════════════════════════════════════════════════════

interface Session {
  cloudSessionId: string;
  deviceId: string;
  animalId: string;
  animalTag: string;
  animalSpecies: string;
  operatorId: string;
  status: "active" | "paused";
  startedAt: Date;
}

interface ReceivedEvent {
  cloudEventId: string;
  localEventId: string;
  deviceId: string;
  pluCode: string;
  productName: string;
  weightGrams: number;
  barcode: string;
  scaleTimestamp: string;
  receivedAt: Date;
  cloudSessionId?: string;
  offlineBatchId?: string;
}

interface RegisteredEdge {
  edgeId: string;
  siteId: string;
  siteName: string;
  version: string;
  registeredAt: Date;
  lastSeen: Date;
}

// Data stores
const sessions = new Map<string, Session>();
const events: ReceivedEvent[] = [];
const registeredEdges = new Map<string, RegisteredEdge>();
let eventIdCounter = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function generateId(prefix: string = "cloud"): string {
  return `${prefix}-${Date.now()}-${++eventIdCounter}`;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_REGEX.test(value.trim());
}

function log(message: string, data?: unknown): void {
  const timestamp = new Date().toISOString().substring(11, 23);
  if (data) {
    console.log(`[${timestamp}] [MOCK-REST] ${message}`, JSON.stringify(data, null, 2));
  } else {
    console.log(`[${timestamp}] [MOCK-REST] ${message}`);
  }
}

function formatWeight(grams: number): string {
  if (grams >= 1000) {
    return `${(grams / 1000).toFixed(2)} kg`;
  }
  return `${grams} g`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REQUEST HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

async function handleGetSessions(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const deviceIds = url.searchParams.get("device_ids")?.split(",") || [];
  
  log(`GET /edge/sessions for devices: ${deviceIds.join(", ")}`);
  
  const activeSessions = Array.from(sessions.values())
    .filter(s => deviceIds.includes(s.deviceId) && s.status === "active")
    .map(s => ({
      cloudSessionId: s.cloudSessionId,
      deviceId: s.deviceId,
      animalId: s.animalId,
      animalTag: s.animalTag,
      animalSpecies: s.animalSpecies,
      operatorId: s.operatorId,
      status: s.status,
    }));
  
  log(`  → Returning ${activeSessions.length} active sessions`);
  
  return Response.json({ sessions: activeSessions });
}

async function handlePostEvent(req: Request): Promise<Response> {
  try {
    const body = await req.json() as {
      localEventId: string;
      deviceId: string;
      pluCode: string;
      productName: string;
      weightGrams: number;
      barcode: string;
      scaleTimestamp: string;
      cloudSessionId?: string;
      offlineBatchId?: string;
    };
    
    const cloudEventId = generateId("evt");
    
    const event: ReceivedEvent = {
      cloudEventId,
      localEventId: body.localEventId,
      deviceId: body.deviceId,
      pluCode: body.pluCode,
      productName: body.productName,
      weightGrams: body.weightGrams,
      barcode: body.barcode,
      scaleTimestamp: body.scaleTimestamp,
      receivedAt: new Date(),
      cloudSessionId: body.cloudSessionId,
      offlineBatchId: body.offlineBatchId,
    };
    
    events.push(event);
    
    log(`✓ EVENT RECEIVED:`);
    console.log(`   ┌─────────────────────────────────────────────────────────┐`);
    console.log(`   │  Device:    ${body.deviceId.padEnd(44)}│`);
    console.log(`   │  PLU:       ${body.pluCode.padEnd(44)}│`);
    console.log(`   │  Product:   ${body.productName.trim().padEnd(44)}│`);
    console.log(`   │  Weight:    ${formatWeight(body.weightGrams).padEnd(44)}│`);
    console.log(`   │  Barcode:   ${body.barcode.padEnd(44)}│`);
    console.log(`   │  Local ID:  ${body.localEventId.substring(0, 36).padEnd(44)}│`);
    console.log(`   │  Cloud ID:  ${cloudEventId.padEnd(44)}│`);
    if (body.cloudSessionId) {
      console.log(`   │  Session:   ${body.cloudSessionId.substring(0, 36).padEnd(44)}│`);
    }
    if (body.offlineBatchId) {
      console.log(`   │  Batch:     ${body.offlineBatchId.substring(0, 36).padEnd(44)}│`);
    }
    console.log(`   └─────────────────────────────────────────────────────────┘`);
    
    return Response.json({
      cloudEventId,
      status: "accepted",
    });
  } catch (error) {
    log(`✗ Error processing event: ${error}`);
    return Response.json({ error: String(error) }, { status: 400 });
  }
}

async function handlePostEventBatch(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { events: Array<{
      localEventId: string;
      deviceId: string;
      pluCode: string;
      productName: string;
      weightGrams: number;
      barcode: string;
      scaleTimestamp: string;
      cloudSessionId?: string;
      offlineBatchId?: string;
    }> };
    
    log(`BATCH RECEIVED: ${body.events.length} events`);
    
    const results = body.events.map(evt => {
      const cloudEventId = generateId("evt");
      
      events.push({
        cloudEventId,
        localEventId: evt.localEventId,
        deviceId: evt.deviceId,
        pluCode: evt.pluCode,
        productName: evt.productName,
        weightGrams: evt.weightGrams,
        barcode: evt.barcode,
        scaleTimestamp: evt.scaleTimestamp,
        receivedAt: new Date(),
        cloudSessionId: evt.cloudSessionId,
        offlineBatchId: evt.offlineBatchId,
      });
      
      console.log(`   ✓ ${evt.deviceId} | ${evt.pluCode} | ${evt.productName.trim()} | ${formatWeight(evt.weightGrams)}`);
      
      return {
        localEventId: evt.localEventId,
        cloudEventId,
        status: "accepted" as const,
      };
    });
    
    return Response.json({ results });
  } catch (error) {
    log(`✗ Error processing batch: ${error}`);
    return Response.json({ error: String(error) }, { status: 400 });
  }
}

async function handlePostRegister(req: Request): Promise<Response> {
  try {
    const body = await req.json() as {
      edgeId?: string | null;
      siteId?: string;
      siteName?: string;
      version: string;
      capabilities: string[];
    };

    const siteId = body.siteId || "site-001";
    const siteName = body.siteName || "Test Site";
    let edgeId: string;

    if (body.edgeId != null && body.edgeId !== "") {
      if (!isValidUuid(body.edgeId)) {
        log(`✗ Register: invalid edgeId format (must be UUID): ${body.edgeId}`);
        return Response.json(
          { error: "Invalid edgeId format; must be a valid UUID" },
          { status: 400 }
        );
      }
      edgeId = body.edgeId;
    } else {
      edgeId = crypto.randomUUID();
    }

    const existingEdge = registeredEdges.get(edgeId);
    if (existingEdge) {
      existingEdge.lastSeen = new Date();
      existingEdge.version = body.version;
      registeredEdges.set(edgeId, existingEdge);
      log(`✓ EDGE RE-REGISTERED: ${edgeId} (${siteName})`);
    } else {
      registeredEdges.set(edgeId, {
        edgeId,
        siteId,
        siteName,
        version: body.version,
        registeredAt: new Date(),
        lastSeen: new Date(),
      });
      log(`✓ EDGE REGISTERED: ${edgeId} (${siteName})`);
    }

    return Response.json({
      edgeId,
      siteId,
      siteName,
      config: {
        sessionPollIntervalMs: 5000,
        heartbeatIntervalMs: 30000,
        workHoursStart: "06:00",
        workHoursEnd: "18:00",
      },
    });
  } catch (error) {
    log(`✗ Error registering: ${error}`);
    return Response.json({ error: String(error) }, { status: 400 });
  }
}

async function handleGetConfig(req: Request): Promise<Response> {
  const edgeId = req.headers.get("X-Edge-Id");
  log(`GET /edge/config for edge: ${edgeId || "unknown"}`);
  
  return Response.json({
    edgeId: edgeId || "unregistered",
    sessionPollIntervalMs: 5000,
    heartbeatIntervalMs: 30000,
    workHoursStart: "06:00",
    workHoursEnd: "18:00",
    timezone: "Europe/Istanbul",
  });
}

async function handlePostDeviceStatus(req: Request): Promise<Response> {
  try {
    const body = await req.json() as {
      deviceId: string;
      status: string;
      heartbeatCount: number;
      eventCount: number;
    };
    
    log(`DEVICE STATUS: ${body.deviceId} - ${body.status} (HB: ${body.heartbeatCount}, Events: ${body.eventCount})`);
    
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN API (for testing)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleAdminCreateSession(req: Request): Promise<Response> {
  try {
    const body = await req.json() as {
      deviceId: string;
      animalTag?: string;
      animalSpecies?: string;
      operatorId?: string;
    };
    
    const sessionId = generateId("session");
    
    const session: Session = {
      cloudSessionId: sessionId,
      deviceId: body.deviceId,
      animalId: generateId("animal"),
      animalTag: body.animalTag || `TAG-${Math.floor(Math.random() * 1000)}`,
      animalSpecies: body.animalSpecies || "Dana",
      operatorId: body.operatorId || "operator-001",
      status: "active",
      startedAt: new Date(),
    };
    
    sessions.set(sessionId, session);
    
    log(`✓ SESSION CREATED: ${sessionId} for device ${body.deviceId}`);
    console.log(`   Animal Tag: ${session.animalTag} | Species: ${session.animalSpecies}`);
    
    return Response.json({ success: true, session });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}

async function handleAdminEndSession(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { sessionId: string };
    
    const session = sessions.get(body.sessionId);
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    
    sessions.delete(body.sessionId);
    
    log(`✓ SESSION ENDED: ${body.sessionId}`);
    
    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}

async function handleAdminGetEvents(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const hours = Number(url.searchParams.get("hours")) || null;
  const limit = Number(url.searchParams.get("limit")) || 50;
  
  let filteredEvents = events;
  
  // Filter by time if requested (e.g., only show events from last N hours)
  if (hours) {
    const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    filteredEvents = events.filter(e => e.receivedAt >= cutoffTime);
  }
  
  // Return last N events (most recent first)
  const recentEvents = filteredEvents.slice(-limit).reverse();
  
  return Response.json({
    totalEvents: events.length,
    filteredEvents: filteredEvents.length,
    events: recentEvents,
  });
}

async function handleAdminClearEvents(): Promise<Response> {
  const beforeCount = events.length;
  events.length = 0; // Clear all events
  eventIdCounter = 0; // Reset counter
  
  log(`✓ Cleared ${beforeCount} events from memory`);
  
  return Response.json({
    success: true,
    cleared: beforeCount,
    message: `Cleared ${beforeCount} events`,
  });
}

async function handleAdminGetStats(): Promise<Response> {
  const totalWeight = events.reduce((sum, e) => sum + e.weightGrams, 0);
  const deviceStats = new Map<string, { events: number; weight: number }>();
  
  for (const event of events) {
    const stats = deviceStats.get(event.deviceId) || { events: 0, weight: 0 };
    stats.events++;
    stats.weight += event.weightGrams;
    deviceStats.set(event.deviceId, stats);
  }
  
  return Response.json({
    totalEvents: events.length,
    totalWeight: formatWeight(totalWeight),
    totalWeightGrams: totalWeight,
    activeSessions: sessions.size,
    registeredEdges: registeredEdges.size,
    deviceStats: Object.fromEntries(deviceStats),
  });
}

async function handleAdminListSessions(): Promise<Response> {
  const sessionList = Array.from(sessions.values()).map(s => ({
    cloudSessionId: s.cloudSessionId,
    deviceId: s.deviceId,
    animalId: s.animalId,
    animalTag: s.animalTag,
    animalSpecies: s.animalSpecies,
    operatorId: s.operatorId,
    status: s.status,
    startedAt: s.startedAt.toISOString(),
  }));
  
  return Response.json({ sessions: sessionList });
}

async function handleAdminListEdges(): Promise<Response> {
  const edgesList = Array.from(registeredEdges.values()).map(e => ({
    edgeId: e.edgeId,
    siteId: e.siteId,
    siteName: e.siteName,
    version: e.version,
    registeredAt: e.registeredAt.toISOString(),
    lastSeen: e.lastSeen.toISOString(),
  }));
  
  return Response.json({ edges: edgesList });
}

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE API PROXY (to avoid CORS issues)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Proxy endpoint to fetch devices from Edge API
 * This avoids CORS issues when the browser tries to fetch from Edge directly
 */
async function handleEdgeProxyDevices(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const onlineOnly = url.searchParams.get("online") === "true";
  const edgeUrl = `${EDGE_API_URL}/api/devices${onlineOnly ? "?online=true" : ""}`;
  
  log(`[PROXY] Fetching devices from Edge: ${edgeUrl}`);
  
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  
  try {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
    
    const response = await fetch(edgeUrl, {
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
      },
    });
    
    if (timeoutId) clearTimeout(timeoutId);
    
    if (!response.ok) {
      log(`[PROXY] Edge API returned ${response.status}: ${response.statusText}`);
      return Response.json({
        success: false,
        error: `Edge API returned ${response.status}: ${response.statusText}`,
        edgeUrl,
        status: response.status,
      }, { status: response.status });
    }
    
    const data = await response.json();
    log(`[PROXY] ✓ Successfully fetched ${data.data?.length || 0} devices from Edge`);
    
    return Response.json({
      success: true,
      data: data.data || [],
      edgeUrl,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`[PROXY] ✗ Failed to fetch from Edge: ${errorMessage}`);
    
    // Provide helpful error messages
    let userMessage = errorMessage;
    if (errorMessage.includes("ECONNREFUSED") || errorMessage.includes("Failed to fetch")) {
      userMessage = `Cannot connect to Edge at ${EDGE_API_URL}. Make sure Edge is running.`;
    } else if (errorMessage.includes("aborted")) {
      userMessage = `Request to Edge timed out. Edge may be slow or unresponsive.`;
    }
    
    return Response.json({
      success: false,
      error: userMessage,
      edgeUrl,
      details: errorMessage,
    }, { status: 503 });
  }
}

/**
 * Proxy endpoint to check Edge status
 */
async function handleEdgeProxyStatus(req: Request): Promise<Response> {
  const edgeUrl = `${EDGE_API_URL}/api/status`;
  
  log(`[PROXY] Checking Edge status: ${edgeUrl}`);
  
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  
  try {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(edgeUrl, {
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
      },
    });
    
    if (timeoutId) clearTimeout(timeoutId);
    
    if (!response.ok) {
      return Response.json({
        success: false,
        error: `Edge API returned ${response.status}`,
        edgeUrl,
      }, { status: response.status });
    }
    
    const data = await response.json();
    log(`[PROXY] ✓ Edge status check successful`);
    
    return Response.json({
      success: true,
      data: data.data || data,
      edgeUrl,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`[PROXY] ✗ Edge status check failed: ${errorMessage}`);
    
    return Response.json({
      success: false,
      error: `Cannot connect to Edge: ${errorMessage}`,
      edgeUrl,
    }, { status: 503 });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN SERVER
// ═══════════════════════════════════════════════════════════════════════════════

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    
    // CORS headers for browser testing
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Edge-Id, X-Site-Id",
    };
    
    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    
    let response: Response;
    
    try {
      // Edge API endpoints (no duplicated /edge/; prefix /api/v1/edge/)
      if (path === "/api/v1/edge/sessions" && method === "GET") {
        response = await handleGetSessions(req);
      } else if (path === "/api/v1/edge/events" && method === "POST") {
        response = await handlePostEvent(req);
      } else if (path === "/api/v1/edge/events/batch" && method === "POST") {
        response = await handlePostEventBatch(req);
      } else if (path === "/api/v1/edge/register" && method === "POST") {
        response = await handlePostRegister(req);
      } else if (path === "/api/v1/edge/config" && method === "GET") {
        response = await handleGetConfig(req);
      } else if (path === "/api/v1/edge/devices/status" && method === "POST") {
        response = await handlePostDeviceStatus(req);
      }
      // Admin API endpoints
      else if (path === "/admin/session/start" && method === "POST") {
        response = await handleAdminCreateSession(req);
      } else if (path === "/admin/session/end" && method === "POST") {
        response = await handleAdminEndSession(req);
      } else if (path === "/admin/events" && method === "GET") {
        response = await handleAdminGetEvents(req);
      } else if (path === "/admin/events/clear" && method === "POST") {
        response = await handleAdminClearEvents();
      } else if (path === "/admin/stats" && method === "GET") {
        response = await handleAdminGetStats();
      } else if (path === "/admin/sessions" && method === "GET") {
        response = await handleAdminListSessions();
      } else if (path === "/admin/edges" && method === "GET") {
        response = await handleAdminListEdges();
      }
      // Edge API Proxy (to avoid CORS issues)
      else if (path === "/admin/edge-proxy/devices" && method === "GET") {
        response = await handleEdgeProxyDevices(req);
      } else if (path === "/admin/edge-proxy/status" && method === "GET") {
        response = await handleEdgeProxyStatus(req);
      }
      // Health check
      else if (path === "/health" && method === "GET") {
        response = Response.json({
          status: "ok",
          timestamp: new Date().toISOString(),
          events: events.length,
          sessions: sessions.size,
        });
      }
      // Help page
      else if (path === "/" || path === "/help") {
        response = new Response(getHelpHtml(), {
          headers: { "Content-Type": "text/html" },
        });
      }
      // API Testing UI
      else if (path === "/api-test") {
        response = new Response(getApiTestHtml(), {
          headers: { "Content-Type": "text/html" },
        });
      }
      // Not found
      else {
        log(`404: ${method} ${path}`);
        response = Response.json({ error: "Not found" }, { status: 404 });
      }
    } catch (error) {
      log(`Error handling ${method} ${path}: ${error}`);
      response = Response.json({ error: String(error) }, { status: 500 });
    }
    
    // Add CORS headers to response
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
    
    return new Response(response.body, {
      status: response.status,
      headers: newHeaders,
    });
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// API TESTING UI
// ═══════════════════════════════════════════════════════════════════════════════

function getApiTestHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API Tester - Mock Cloud Server</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    
    :root {
      --bg-dark: #0f172a;
      --bg-card: #1e293b;
      --bg-input: #334155;
      --border: #475569;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --success: #22c55e;
      --warning: #f59e0b;
      --danger: #ef4444;
      --info: #06b6d4;
    }
    
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: var(--bg-dark);
      color: var(--text);
      min-height: 100vh;
      padding: 1.5rem;
    }
    
    .container { max-width: 1600px; margin: 0 auto; }
    
    header {
      background: linear-gradient(135deg, #1e40af 0%, #7c3aed 100%);
      padding: 1.5rem 2rem;
      margin-bottom: 1.5rem;
      border-radius: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .logo { font-size: 1.5rem; font-weight: 700; display: flex; align-items: center; gap: 0.75rem; }
    .logo-icon { font-size: 2rem; }
    
    .nav-links { display: flex; gap: 1rem; }
    .nav-link {
      padding: 0.5rem 1rem;
      background: rgba(255,255,255,0.1);
      border-radius: 8px;
      text-decoration: none;
      color: white;
      font-size: 0.9rem;
      transition: background 0.2s;
    }
    .nav-link:hover { background: rgba(255,255,255,0.2); }
    .nav-link.active { background: rgba(255,255,255,0.3); }
    
    .main-grid {
      display: grid;
      grid-template-columns: 400px 1fr;
      gap: 1.5rem;
    }
    
    @media (max-width: 1200px) {
      .main-grid { grid-template-columns: 1fr; }
    }
    
    .card {
      background: var(--bg-card);
      border-radius: 12px;
      padding: 1.5rem;
      border: 1px solid var(--border);
    }
    
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
      padding-bottom: 0.75rem;
      border-bottom: 1px solid var(--border);
    }
    
    .card-title {
      font-size: 1rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    
    .form-group { margin-bottom: 1rem; }
    .form-label {
      display: block;
      font-size: 0.8rem;
      font-weight: 500;
      color: var(--text-muted);
      margin-bottom: 0.4rem;
    }
    
    .form-input, .form-select, .form-textarea {
      width: 100%;
      padding: 0.75rem 1rem;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 0.9rem;
      font-family: inherit;
      transition: border-color 0.2s;
    }
    
    .form-textarea {
      min-height: 200px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      resize: vertical;
    }
    
    .form-input:focus, .form-select:focus, .form-textarea:focus {
      outline: none;
      border-color: var(--accent);
    }
    
    .form-input::placeholder { color: var(--text-muted); }
    
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      font-size: 0.9rem;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.2s;
      border: none;
    }
    
    .btn-primary {
      background: var(--accent);
      color: white;
    }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    .btn-block { width: 100%; }
    
    .endpoint-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      max-height: calc(100vh - 300px);
      overflow-y: auto;
    }
    
    .endpoint-item {
      padding: 1rem;
      background: var(--bg-input);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
      border: 2px solid transparent;
    }
    
    .endpoint-item:hover {
      background: var(--bg-card);
      border-color: var(--border);
    }
    
    .endpoint-item.active {
      background: var(--bg-card);
      border-color: var(--accent);
    }
    
    .endpoint-method {
      display: inline-block;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
      margin-right: 0.5rem;
    }
    
    .method-get { background: var(--success); color: white; }
    .method-post { background: var(--accent); color: white; }
    .method-put { background: var(--warning); color: white; }
    .method-delete { background: var(--danger); color: white; }
    
    .endpoint-path {
      font-family: monospace;
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
    }
    
    .endpoint-desc {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
    }
    
    .response-section {
      margin-top: 1.5rem;
    }
    
    .response-header {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1rem;
    }
    
    .status-badge {
      padding: 0.4rem 0.8rem;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 600;
    }
    
    .status-2xx { background: var(--success); color: white; }
    .status-4xx { background: var(--danger); color: white; }
    .status-5xx { background: var(--danger); color: white; }
    
    .response-body {
      background: #0c0c0c;
      border-radius: 8px;
      padding: 1rem;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      overflow-x: auto;
      max-height: 500px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    
    .params-section {
      margin-top: 1rem;
    }
    
    .param-item {
      display: grid;
      grid-template-columns: 150px 1fr auto;
      gap: 0.5rem;
      align-items: center;
      margin-bottom: 0.5rem;
    }
    
    .param-remove {
      padding: 0.5rem;
      background: var(--danger);
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8rem;
    }
    
    .add-param {
      margin-top: 0.5rem;
      padding: 0.5rem;
      background: var(--bg-input);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.85rem;
      width: 100%;
    }
    
    .add-param:hover {
      background: var(--bg-card);
    }
    
    .headers-section {
      margin-top: 1rem;
    }
    
    .empty-state {
      text-align: center;
      padding: 3rem;
      color: var(--text-muted);
    }
    
    .empty-icon {
      font-size: 4rem;
      margin-bottom: 1rem;
      opacity: 0.5;
    }
    
    .loading {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid var(--text-muted);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    
    .toast {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      padding: 1rem 1.5rem;
      background: var(--success);
      color: white;
      border-radius: 8px;
      font-weight: 500;
      display: none;
      animation: slideIn 0.3s ease;
      z-index: 1000;
    }
    
    .toast.error { background: var(--danger); }
    .toast.show { display: block; }
    
    @keyframes slideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo">
        <span class="logo-icon">🧪</span>
        <div>API Tester</div>
      </div>
      <div class="nav-links">
        <a href="/" class="nav-link">Dashboard</a>
        <a href="/api-test" class="nav-link active">API Tester</a>
      </div>
    </header>
    
    <div class="main-grid">
      <!-- Endpoints List -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">📡 API Endpoints</div>
        </div>
        <div class="endpoint-list" id="endpoint-list"></div>
      </div>
      
      <!-- Request/Response Panel -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">⚡ Request Builder</div>
        </div>
        
        <div id="request-panel">
          <div class="empty-state">
            <div class="empty-icon">👉</div>
            <div>Select an endpoint to start testing</div>
          </div>
        </div>
      </div>
    </div>
  </div>
  
  <div class="toast" id="toast"></div>
  
  <script>
    const endpoints = [
      {
        id: 'get-sessions',
        method: 'GET',
        path: '/api/v1/edge/sessions',
        description: 'Get active sessions for devices',
        params: [
          { name: 'device_ids', type: 'query', value: 'SCALE-01,SCALE-02', required: true }
        ]
      },
      {
        id: 'post-event',
        method: 'POST',
        path: '/api/v1/edge/events',
        description: 'Post a single weighing event',
        body: {
          localEventId: 'evt-' + Date.now(),
          deviceId: 'SCALE-01',
          pluCode: '00001',
          productName: 'KIYMA',
          weightGrams: 1500,
          barcode: '8690123456789',
          scaleTimestamp: new Date().toISOString(),
          cloudSessionId: null,
          offlineBatchId: null
        }
      },
      {
        id: 'post-event-batch',
        method: 'POST',
        path: '/api/v1/edge/events/batch',
        description: 'Post a batch of events',
        body: {
          events: [
            {
              localEventId: 'evt-' + Date.now() + '-1',
              deviceId: 'SCALE-01',
              pluCode: '00001',
              productName: 'KIYMA',
              weightGrams: 1500,
              barcode: '8690123456789',
              scaleTimestamp: new Date().toISOString()
            },
            {
              localEventId: 'evt-' + Date.now() + '-2',
              deviceId: 'SCALE-01',
              pluCode: '00002',
              productName: 'BONFILE',
              weightGrams: 2000,
              barcode: '8690123456790',
              scaleTimestamp: new Date().toISOString()
            }
          ]
        }
      },
      {
        id: 'post-register',
        method: 'POST',
        path: '/api/v1/edge/register',
        description: 'Register Edge with Cloud',
        body: {
          edgeId: null,
          siteId: 'site-001',
          siteName: 'Test Site',
          version: '0.3.0',
          capabilities: ['rest', 'tcp']
        }
      },
      {
        id: 'get-config',
        method: 'GET',
        path: '/api/v1/edge/config',
        description: 'Get Edge configuration',
        headers: {
          'X-Edge-Id': '550e8400-e29b-41d4-a716-446655440000'
        }
      },
      {
        id: 'post-device-status',
        method: 'POST',
        path: '/api/v1/edge/devices/status',
        description: 'Post device status update',
        body: {
          deviceId: 'SCALE-01',
          status: 'online',
          heartbeatCount: 100,
          eventCount: 50
        }
      },
      {
        id: 'admin-stats',
        method: 'GET',
        path: '/admin/stats',
        description: 'Get system statistics'
      },
      {
        id: 'admin-events',
        method: 'GET',
        path: '/admin/events',
        description: 'Get recent events'
      },
      {
        id: 'admin-sessions',
        method: 'GET',
        path: '/admin/sessions',
        description: 'List all active sessions'
      },
      {
        id: 'admin-session-start',
        method: 'POST',
        path: '/admin/session/start',
        description: 'Create a new session',
        body: {
          deviceId: 'SCALE-01',
          animalTag: 'DANA-001',
          animalSpecies: 'Dana',
          operatorId: 'operator-001'
        }
      },
      {
        id: 'admin-session-end',
        method: 'POST',
        path: '/admin/session/end',
        description: 'End a session',
        body: {
          sessionId: 'session-xxx'
        }
      },
      {
        id: 'health',
        method: 'GET',
        path: '/health',
        description: 'Health check endpoint'
      },
      {
        id: 'edge-devices',
        method: 'GET',
        path: 'http://localhost:3000/api/devices',
        description: 'Get all devices from Edge',
        params: [
          { name: 'status', type: 'query', value: '', required: false },
          { name: 'online', type: 'query', value: 'true', required: false }
        ]
      },
      {
        id: 'edge-devices-online',
        method: 'GET',
        path: 'http://localhost:3000/api/devices',
        description: 'Get only online devices from Edge',
        params: [
          { name: 'online', type: 'query', value: 'true', required: false }
        ]
      },
      {
        id: 'edge-status',
        method: 'GET',
        path: 'http://localhost:3000/api/status',
        description: 'Get Edge system status'
      }
    ];
    
    let selectedEndpoint = null;
    
    function showToast(message, isError = false) {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.className = 'toast show' + (isError ? ' error' : '');
      setTimeout(() => toast.className = 'toast', 3000);
    }
    
    function renderEndpoints() {
      const list = document.getElementById('endpoint-list');
      list.innerHTML = endpoints.map(ep => \`
        <div class="endpoint-item" data-endpoint-id="\${ep.id}">
          <div>
            <span class="endpoint-method method-\${ep.method.toLowerCase()}">\${ep.method}</span>
            <span class="endpoint-path">\${ep.path}</span>
          </div>
          <div class="endpoint-desc">\${ep.description}</div>
        </div>
      \`).join('');
      
      list.querySelectorAll('.endpoint-item').forEach(item => {
        item.addEventListener('click', () => {
          const endpointId = item.dataset.endpointId;
          selectEndpoint(endpointId);
        });
      });
    }
    
    function selectEndpoint(endpointId) {
      selectedEndpoint = endpoints.find(ep => ep.id === endpointId);
      
      // Update active state
      document.querySelectorAll('.endpoint-item').forEach(item => {
        item.classList.toggle('active', item.dataset.endpointId === endpointId);
      });
      
      renderRequestPanel();
    }
    
    function renderRequestPanel() {
      if (!selectedEndpoint) return;
      
      const panel = document.getElementById('request-panel');
      const ep = selectedEndpoint;
      
      let paramsHtml = '';
      if (ep.params) {
        paramsHtml = \`
          <div class="params-section">
            <div class="form-label">Query Parameters</div>
            <div id="params-list">
              \${ep.params.map(p => \`
                <div class="param-item">
                  <input type="text" class="form-input" value="\${p.name}" readonly>
                  <input type="text" class="form-input" value="\${p.value || ''}" data-param-name="\${p.name}">
                  <button class="param-remove" onclick="removeParam(this)">×</button>
                </div>
              \`).join('')}
            </div>
            <button class="add-param" onclick="addParam()">+ Add Parameter</button>
          </div>
        \`;
      }
      
      let headersHtml = '';
      if (ep.headers || ep.method === 'POST' || ep.method === 'PUT') {
        const defaultHeaders = {
          'Content-Type': 'application/json',
          ...(ep.headers || {})
        };
        headersHtml = \`
          <div class="headers-section">
            <div class="form-label">Headers</div>
            <div id="headers-list">
              \${Object.entries(defaultHeaders).map(([k, v]) => \`
                <div class="param-item">
                  <input type="text" class="form-input" value="\${k}" data-header-name>
                  <input type="text" class="form-input" value="\${v}" data-header-value>
                  <button class="param-remove" onclick="removeHeader(this)">×</button>
                </div>
              \`).join('')}
            </div>
            <button class="add-param" onclick="addHeader()">+ Add Header</button>
          </div>
        \`;
      }
      
      let bodyHtml = '';
      if (ep.body && (ep.method === 'POST' || ep.method === 'PUT')) {
        bodyHtml = \`
          <div class="form-group">
            <label class="form-label">Request Body (JSON)</label>
            <textarea class="form-textarea" id="request-body">\${JSON.stringify(ep.body, null, 2)}</textarea>
          </div>
        \`;
      }
      
      panel.innerHTML = \`
        <div class="form-group">
          <label class="form-label">Method</label>
          <input type="text" class="form-input" value="\${ep.method}" readonly>
        </div>
        <div class="form-group">
          <label class="form-label">Path</label>
          <input type="text" class="form-input" value="\${ep.path}" id="request-path" readonly>
        </div>
        \${paramsHtml}
        \${headersHtml}
        \${bodyHtml}
        <button class="btn btn-primary btn-block" onclick="executeRequest()" id="execute-btn">
          <span>🚀</span> Execute Request
        </button>
        <div class="response-section" id="response-section" style="display: none;">
          <div class="response-header">
            <span class="status-badge" id="status-badge">200 OK</span>
            <span id="response-time"></span>
          </div>
          <div class="form-label">Response Body</div>
          <div class="response-body" id="response-body"></div>
        </div>
      \`;
    }
    
    function addParam() {
      const list = document.getElementById('params-list');
      const item = document.createElement('div');
      item.className = 'param-item';
      item.innerHTML = \`
        <input type="text" class="form-input" placeholder="name" data-param-name>
        <input type="text" class="form-input" placeholder="value" data-param-value>
        <button class="param-remove" onclick="removeParam(this)">×</button>
      \`;
      list.appendChild(item);
    }
    
    function removeParam(btn) {
      btn.closest('.param-item').remove();
    }
    
    function addHeader() {
      const list = document.getElementById('headers-list');
      const item = document.createElement('div');
      item.className = 'param-item';
      item.innerHTML = \`
        <input type="text" class="form-input" placeholder="Header name" data-header-name>
        <input type="text" class="form-input" placeholder="Header value" data-header-value>
        <button class="param-remove" onclick="removeHeader(this)">×</button>
      \`;
      list.appendChild(item);
    }
    
    function removeHeader(btn) {
      btn.closest('.param-item').remove();
    }
    
    async function executeRequest() {
      if (!selectedEndpoint) return;
      
      const btn = document.getElementById('execute-btn');
      btn.disabled = true;
      btn.innerHTML = '<span class="loading"></span> Executing...';
      
      const ep = selectedEndpoint;
      let url = ep.path;
      
      // Handle absolute URLs (for Edge API calls)
      const isAbsoluteUrl = url.startsWith('http://') || url.startsWith('https://');
      
      // Build query params
      if (ep.params || document.getElementById('params-list')) {
        const paramsList = document.getElementById('params-list');
        if (paramsList) {
          const params = Array.from(paramsList.querySelectorAll('.param-item'))
            .map(item => {
              const nameInput = item.querySelector('[data-param-name]');
              const valueInput = item.querySelector('[data-param-value]') || item.querySelector('input[type="text"]:last-child');
              const name = nameInput.value.trim();
              const value = valueInput.value.trim();
              return name && value ? \`\${name}=\${encodeURIComponent(value)}\` : null;
            })
            .filter(Boolean);
          if (params.length > 0) {
            url += '?' + params.join('&');
          }
        }
      }
      
      // Build headers
      const headers = {};
      const headersList = document.getElementById('headers-list');
      if (headersList) {
        Array.from(headersList.querySelectorAll('.param-item')).forEach(item => {
          const nameInput = item.querySelector('[data-header-name]');
          const valueInput = item.querySelector('[data-header-value]');
          const name = nameInput.value.trim();
          const value = valueInput.value.trim();
          if (name && value) {
            headers[name] = value;
          }
        });
      }
      
      // Build body
      let body = null;
      const bodyTextarea = document.getElementById('request-body');
      if (bodyTextarea) {
        try {
          body = JSON.parse(bodyTextarea.value);
        } catch (e) {
          showToast('Invalid JSON in request body', true);
          btn.disabled = false;
          btn.innerHTML = '<span>🚀</span> Execute Request';
          return;
        }
      }
      
      const startTime = Date.now();
      
      try {
        // Use absolute URL for Edge API, relative for mock server API
        const fetchUrl = isAbsoluteUrl ? url : url;
        
        const response = await fetch(fetchUrl, {
          method: ep.method,
          headers: headers,
          body: body ? JSON.stringify(body) : undefined
        });
        
        const endTime = Date.now();
        const duration = endTime - startTime;
        
        const responseText = await response.text();
        let responseJson;
        try {
          responseJson = JSON.parse(responseText);
        } catch {
          responseJson = responseText;
        }
        
        // Show response
        const responseSection = document.getElementById('response-section');
        responseSection.style.display = 'block';
        
        const statusBadge = document.getElementById('status-badge');
        statusBadge.textContent = \`\${response.status} \${response.statusText}\`;
        statusBadge.className = 'status-badge status-' + Math.floor(response.status / 100) + 'xx';
        
        document.getElementById('response-time').textContent = \`\${duration}ms\`;
        document.getElementById('response-body').textContent = JSON.stringify(responseJson, null, 2);
        
        if (response.ok) {
          showToast('Request successful');
        } else {
          showToast('Request failed', true);
        }
      } catch (error) {
        const responseSection = document.getElementById('response-section');
        responseSection.style.display = 'block';
        
        document.getElementById('status-badge').textContent = 'Error';
        document.getElementById('status-badge').className = 'status-badge status-5xx';
        document.getElementById('response-time').textContent = '';
        document.getElementById('response-body').textContent = error.message;
        
        showToast('Request error: ' + error.message, true);
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>🚀</span> Execute Request';
      }
    }
    
    // Initialize
    renderEndpoints();
  </script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELP PAGE
// ═══════════════════════════════════════════════════════════════════════════════

function getHelpHtml(): string {
  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mock Cloud - Admin Panel</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    
    :root {
      --bg-dark: #0f172a;
      --bg-card: #1e293b;
      --bg-input: #334155;
      --border: #475569;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --success: #22c55e;
      --warning: #f59e0b;
      --danger: #ef4444;
    }
    
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: var(--bg-dark);
      color: var(--text);
      min-height: 100vh;
    }
    
    .container { max-width: 1400px; margin: 0 auto; padding: 1.5rem; }
    
    header {
      background: linear-gradient(135deg, #1e40af 0%, #7c3aed 100%);
      padding: 1.5rem 2rem;
      margin-bottom: 1.5rem;
      border-radius: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .logo { font-size: 1.5rem; font-weight: 700; display: flex; align-items: center; gap: 0.75rem; }
    .logo-icon { font-size: 2rem; }
    .logo-sub { font-size: 0.75rem; font-weight: 400; opacity: 0.8; }
    
    .header-status { display: flex; gap: 1rem; font-size: 0.85rem; }
    .status-item { display: flex; align-items: center; gap: 0.5rem; background: rgba(255,255,255,0.1); padding: 0.5rem 1rem; border-radius: 8px; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); animation: pulse 2s infinite; }
    
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1.5rem; }
    .grid-wide { grid-column: span 2; }
    @media (max-width: 900px) { .grid-wide { grid-column: span 1; } }
    
    .card {
      background: var(--bg-card);
      border-radius: 12px;
      padding: 1.5rem;
      border: 1px solid var(--border);
    }
    
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
      padding-bottom: 0.75rem;
      border-bottom: 1px solid var(--border);
    }
    
    .card-title { font-size: 1rem; font-weight: 600; display: flex; align-items: center; gap: 0.5rem; }
    .card-title-icon { font-size: 1.25rem; }
    
    .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 1.5rem; }
    @media (max-width: 768px) { .stats-grid { grid-template-columns: repeat(2, 1fr); } }
    
    .stat-card {
      background: var(--bg-card);
      border-radius: 12px;
      padding: 1.25rem;
      text-align: center;
      border: 1px solid var(--border);
    }
    
    .stat-value { font-size: 2.5rem; font-weight: 700; color: var(--accent); }
    .stat-label { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem; }
    .stat-card.success .stat-value { color: var(--success); }
    .stat-card.warning .stat-value { color: var(--warning); }
    
    .form-group { margin-bottom: 1rem; }
    .form-label { display: block; font-size: 0.8rem; font-weight: 500; color: var(--text-muted); margin-bottom: 0.4rem; }
    .form-input, .form-select {
      width: 100%;
      padding: 0.75rem 1rem;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 0.9rem;
      font-family: inherit;
      transition: border-color 0.2s;
    }
    .form-input:focus, .form-select:focus { outline: none; border-color: var(--accent); }
    .form-input::placeholder { color: var(--text-muted); }
    
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      font-size: 0.9rem;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.2s;
      border: none;
    }
    
    .btn-primary { background: var(--accent); color: white; }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    
    .btn-success { background: var(--success); color: white; }
    .btn-success:hover { background: #16a34a; }
    
    .btn-danger { background: var(--danger); color: white; padding: 0.5rem 0.75rem; font-size: 0.8rem; }
    .btn-danger:hover { background: #dc2626; }
    
    .btn-sm { padding: 0.4rem 0.75rem; font-size: 0.8rem; }
    
    .btn-block { width: 100%; }
    
    .session-list { display: flex; flex-direction: column; gap: 0.75rem; max-height: 400px; overflow-y: auto; }
    
    .session-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem;
      background: var(--bg-input);
      border-radius: 8px;
      border-left: 4px solid var(--success);
    }
    
    .session-info { flex: 1; }
    .session-device { font-weight: 600; font-size: 0.95rem; }
    .session-meta { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem; }
    .session-tag { display: inline-block; background: var(--accent); color: white; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 500; margin-right: 0.5rem; }
    
    .event-list { display: flex; flex-direction: column; gap: 0.5rem; max-height: 500px; overflow-y: auto; }
    
    .event-item {
      display: grid;
      grid-template-columns: 100px 80px 1fr 100px 140px;
      gap: 1rem;
      align-items: center;
      padding: 0.75rem 1rem;
      background: var(--bg-input);
      border-radius: 8px;
      font-size: 0.85rem;
    }
    
    .event-device { font-weight: 600; color: var(--accent); }
    .event-plu { font-family: monospace; }
    .event-product { color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .event-weight { font-weight: 600; color: var(--success); text-align: right; }
    .event-time { color: var(--text-muted); font-size: 0.75rem; }
    
    .empty-state { text-align: center; padding: 2rem; color: var(--text-muted); }
    .empty-icon { font-size: 3rem; margin-bottom: 0.5rem; opacity: 0.5; }
    
    .toast {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      padding: 1rem 1.5rem;
      background: var(--success);
      color: white;
      border-radius: 8px;
      font-weight: 500;
      display: none;
      animation: slideIn 0.3s ease;
      z-index: 1000;
    }
    .toast.error { background: var(--danger); }
    .toast.show { display: block; }
    
    @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    
    .refresh-indicator { font-size: 0.75rem; color: var(--text-muted); }
    
    .loading {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    
    .terminal-help {
      background: #0c0c0c;
      border-radius: 8px;
      padding: 1rem;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      overflow-x: auto;
    }
    .terminal-help .comment { color: #6a9955; }
    .terminal-help .command { color: #dcdcaa; }
    .terminal-help .path { color: #ce9178; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo">
        <span class="logo-icon">☁️</span>
        <div>
          <div>Mock Cloud Server</div>
          <div class="logo-sub">CarniTrack Test Environment</div>
        </div>
      </div>
      <div style="display: flex; gap: 1rem; align-items: center;">
        <a href="/api-test" style="padding: 0.5rem 1rem; background: rgba(255,255,255,0.1); border-radius: 8px; text-decoration: none; color: white; font-size: 0.9rem;">🧪 API Tester</a>
        <div class="header-status">
          <div class="status-item">
            <span class="status-dot"></span>
            <span>Server Active</span>
          </div>
          <div class="status-item">
            <span>Port ${PORT}</span>
          </div>
        </div>
      </div>
    </header>
    
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value" id="stat-events">0</div>
        <div class="stat-label">Events Received</div>
      </div>
      <div class="stat-card success">
        <div class="stat-value" id="stat-sessions">0</div>
        <div class="stat-label">Active Sessions</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="stat-weight">0</div>
        <div class="stat-label">Total Weight (kg)</div>
      </div>
      <div class="stat-card warning">
        <div class="stat-value" id="stat-edges">0</div>
        <div class="stat-label">Registered Edges</div>
      </div>
    </div>
    
    <!-- Registered Edges Card -->
    <div class="card grid-wide">
      <div class="card-header">
        <div class="card-title"><span class="card-title-icon">🌐</span> Registered Edges</div>
        <span class="refresh-indicator">Auto-refresh: 3s</span>
      </div>
      <div id="edges-list" style="display: flex; flex-direction: column; gap: 0.75rem;">
        <div class="empty-state">
          <div class="empty-icon">🌐</div>
          <div>No edges registered yet</div>
        </div>
      </div>
    </div>
    
    <div class="grid">
      <!-- Create Session Card -->
      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="card-title-icon">➕</span> Create Session</div>
        </div>
        <form id="session-form">
          <div class="form-group">
            <label class="form-label">Device</label>
            <div style="display: flex; gap: 0.5rem; align-items: center;">
              <select class="form-select" id="device-id" style="flex: 1;">
                <option value="">Loading devices...</option>
              </select>
              <button type="button" class="btn btn-primary" onclick="refreshDevices()" id="refresh-devices-btn" style="padding: 0.75rem 1rem; white-space: nowrap;">
                🔄 Refresh
              </button>
            </div>
            <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;" id="device-status">
              Discovering devices from Edge...
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Animal Tag</label>
              <input type="text" class="form-input" id="animal-tag" placeholder="DANA-001" value="DANA-001">
            </div>
            <div class="form-group">
              <label class="form-label">Species</label>
              <select class="form-select" id="animal-species">
                <option value="Dana">Dana (Calf)</option>
                <option value="Sigir">Sigir (Cattle)</option>
                <option value="Kuzu">Kuzu (Lamb)</option>
                <option value="Koyun">Koyun (Sheep)</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Operator ID</label>
            <input type="text" class="form-input" id="operator-id" placeholder="operator-001" value="operator-001">
          </div>
          <button type="submit" class="btn btn-success btn-block" id="create-btn">
            <span>🚀</span> Start Session
          </button>
        </form>
      </div>
      
      <!-- Active Sessions Card -->
      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="card-title-icon">📋</span> Active Sessions</div>
          <span class="refresh-indicator">Auto-refresh: 3s</span>
        </div>
        <div class="session-list" id="session-list">
          <div class="empty-state">
            <div class="empty-icon">📭</div>
            <div>No active sessions</div>
          </div>
        </div>
      </div>
      
      <!-- Recent Events Card -->
      <div class="card grid-wide">
        <div class="card-header">
          <div class="card-title"><span class="card-title-icon">📊</span> Recent Events</div>
          <div style="display: flex; gap: 0.5rem; align-items: center;">
            <span class="refresh-indicator" id="event-count">0 events</span>
            <button class="btn btn-danger btn-sm" onclick="clearEvents()" style="padding: 0.4rem 0.75rem; font-size: 0.75rem;">Clear All</button>
          </div>
        </div>
        <div class="event-list" id="event-list">
          <div class="empty-state">
            <div class="empty-icon">📭</div>
            <div>No events received yet</div>
          </div>
        </div>
      </div>
      
      <!-- Terminal Commands Card -->
      <div class="card grid-wide">
        <div class="card-header">
          <div class="card-title"><span class="card-title-icon">💻</span> Terminal Commands</div>
        </div>
        <div class="terminal-help">
          <div class="comment"># Terminal 1 - Start Mock Cloud Server</div>
          <div><span class="command">cd</span> <span class="path">/Users/korkutkaanbalta/Documents/Carnitrack_EDGE</span></div>
          <div><span class="command">bun run</span> src/cloud/mock-rest-server.ts</div>
          <br>
          <div class="comment"># Terminal 2 - Start Edge Service (pointing to mock)</div>
          <div><span class="command">cd</span> <span class="path">/Users/korkutkaanbalta/Documents/Carnitrack_EDGE</span></div>
          <div><span class="command">CLOUD_API_URL=</span>http://localhost:${PORT}/api/v1/edge <span class="command">bun run</span> src/index.ts</div>
        </div>
      </div>
    </div>
  </div>
  
  <div class="toast" id="toast"></div>
  
  <script>
    // Toast notification
    function showToast(message, isError = false) {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.className = 'toast show' + (isError ? ' error' : '');
      setTimeout(() => toast.className = 'toast', 3000);
    }
    
    // Format weight
    function formatWeight(grams) {
      if (grams >= 1000) return (grams / 1000).toFixed(1) + ' kg';
      return grams + ' g';
    }
    
    // Format time
    function formatTime(dateStr) {
      const d = new Date(dateStr);
      return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    
    // Fetch and update stats
    async function updateStats() {
      try {
        const res = await fetch('/admin/stats');
        const data = await res.json();
        
        document.getElementById('stat-events').textContent = data.totalEvents;
        document.getElementById('stat-sessions').textContent = data.activeSessions;
        document.getElementById('stat-weight').textContent = (data.totalWeightGrams / 1000).toFixed(1);
        document.getElementById('stat-edges').textContent = data.registeredEdges;
      } catch (e) {
        console.error('Failed to fetch stats:', e);
      }
    }
    
    // Fetch and update registered edges
    async function updateEdges() {
      try {
        const res = await fetch('/admin/edges');
        const data = await res.json();
        const list = document.getElementById('edges-list');
        
        if (!data.edges || data.edges.length === 0) {
          list.innerHTML = '<div class="empty-state"><div class="empty-icon">🌐</div><div>No edges registered yet</div></div>';
          return;
        }
        
        list.innerHTML = data.edges.map(edge => \`
          <div class="session-item">
            <div class="session-info">
              <div class="session-device">\${edge.edgeId}</div>
              <div class="session-meta">
                <span class="session-tag">\${edge.siteId}</span>
                <span>\${edge.siteName}</span> • 
                <span>Version: \${edge.version}</span> • 
                <span>Registered: \${new Date(edge.registeredAt).toLocaleString()}</span> • 
                <span>Last seen: \${new Date(edge.lastSeen).toLocaleString()}</span>
              </div>
            </div>
          </div>
        \`).join('');
      } catch (e) {
        console.error('Failed to fetch edges:', e);
      }
    }
    
    // Fetch and update sessions
    async function updateSessions() {
      try {
        const res = await fetch('/admin/sessions');
        const data = await res.json();
        const list = document.getElementById('session-list');
        
        if (!data.sessions || data.sessions.length === 0) {
          list.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div>No active sessions</div></div>';
          return;
        }
        
        list.innerHTML = data.sessions.map(s => \`
          <div class="session-item">
            <div class="session-info">
              <div class="session-device">\${s.deviceId}</div>
              <div class="session-meta">
                <span class="session-tag">\${s.animalTag}</span>
                <span>\${s.animalSpecies}</span> • 
                <span>Operator: \${s.operatorId}</span>
              </div>
            </div>
            <button class="btn btn-danger btn-sm" onclick="endSession('\${s.cloudSessionId}')">End</button>
          </div>
        \`).join('');
      } catch (e) {
        console.error('Failed to fetch sessions:', e);
      }
    }
    
    // Fetch and update events
    async function updateEvents() {
      try {
        // Only show events from last hour to avoid showing old test data
        const res = await fetch('/admin/events?hours=1&limit=50');
        const data = await res.json();
        const list = document.getElementById('event-list');
        
        document.getElementById('event-count').textContent = data.filteredEvents + ' events (last hour)';
        
        if (!data.events || data.events.length === 0) {
          list.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div>No recent events (last hour)</div></div>';
          return;
        }
        
        // Events are already reversed (newest first)
        const events = data.events;
        
        list.innerHTML = events.map(e => \`
          <div class="event-item">
            <div class="event-device">\${e.deviceId}</div>
            <div class="event-plu">\${e.pluCode}</div>
            <div class="event-product">\${e.productName}</div>
            <div class="event-weight">\${formatWeight(e.weightGrams)}</div>
            <div class="event-time">\${formatTime(e.receivedAt)}</div>
          </div>
        \`).join('');
      } catch (e) {
        console.error('Failed to fetch events:', e);
      }
    }
    
    // Create session
    document.getElementById('session-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const deviceId = document.getElementById('device-id').value;
      
      if (!deviceId) {
        showToast('Please select a device', true);
        return;
      }
      
      const btn = document.getElementById('create-btn');
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span> Creating...';
      
      try {
        const res = await fetch('/admin/session/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId: deviceId,
            animalTag: document.getElementById('animal-tag').value,
            animalSpecies: document.getElementById('animal-species').value,
            operatorId: document.getElementById('operator-id').value,
          })
        });
        
        const data = await res.json();
        
        if (data.success) {
          showToast('Session created: ' + data.session.cloudSessionId);
          updateSessions();
          updateStats();
        } else {
          showToast('Failed: ' + (data.error || 'Unknown error'), true);
        }
      } catch (err) {
        showToast('Error: ' + err.message, true);
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>🚀</span> Start Session';
      }
    });
    
    // Clear all events
    async function clearEvents() {
      if (!confirm('Clear all events from mock server memory? This cannot be undone.')) return;
      
      try {
        const res = await fetch('/admin/events/clear', { method: 'POST' });
        const data = await res.json();
        
        if (data.success) {
          showToast('Cleared ' + data.cleared + ' events');
          updateEvents();
          updateStats();
        } else {
          showToast('Failed: ' + (data.error || 'Unknown error'), true);
        }
      } catch (err) {
        showToast('Error: ' + err.message, true);
      }
    }
    
    // End session
    async function endSession(sessionId) {
      if (!confirm('End this session?')) return;
      
      try {
        const res = await fetch('/admin/session/end', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId })
        });
        
        const data = await res.json();
        
        if (data.success) {
          showToast('Session ended');
          updateSessions();
          updateStats();
        } else {
          showToast('Failed: ' + (data.error || 'Unknown error'), true);
        }
      } catch (err) {
        showToast('Error: ' + err.message, true);
      }
    }
    
    // Device discovery
    let discoveredDevices = [];
    const EDGE_API_URL_DISPLAY = '${EDGE_API_URL}';
    
    async function refreshDevices() {
      const btn = document.getElementById('refresh-devices-btn');
      const status = document.getElementById('device-status');
      const select = document.getElementById('device-id');
      
      if (!btn || !status || !select) {
        console.error('Device discovery elements not found');
        return;
      }
      
      btn.disabled = true;
      btn.innerHTML = '<span class="loading"></span>';
      status.textContent = 'Discovering devices from Edge...';
      status.style.color = 'var(--text-muted)';
      
      try {
        // Use proxy endpoint to avoid CORS issues
        const res = await fetch('/admin/edge-proxy/devices?online=true');
        const data = await res.json();
        
        if (data.success && data.data) {
          discoveredDevices = data.data;
          
          // Clear and populate dropdown
          select.innerHTML = '';
          
          if (discoveredDevices.length === 0) {
            select.innerHTML = '<option value="">No online devices found</option>';
            status.textContent = 'No online devices found. Make sure Edge is running and devices are connected.';
            status.style.color = 'var(--warning)';
          } else {
            discoveredDevices.forEach(device => {
              const displayName = device.displayName || device.deviceId;
              const location = device.location ? ' (' + device.location + ')' : '';
              const statusText = device.status === 'online' ? '🟢' : device.status === 'idle' ? '🔵' : '🟡';
              const option = document.createElement('option');
              option.value = device.deviceId;
              option.textContent = \`\${statusText} \${displayName}\${location}\`;
              option.dataset.deviceId = device.deviceId;
              select.appendChild(option);
            });
            
            status.textContent = \`Found \${discoveredDevices.length} online device(s) from Edge at \${EDGE_API_URL_DISPLAY}\`;
            status.style.color = 'var(--success)';
          }
        } else {
          throw new Error(data.error || 'Failed to fetch devices');
        }
      } catch (err) {
        console.error('Failed to discover devices:', err);
        select.innerHTML = '<option value="">Error loading devices</option>';
        
        let errorMsg = err.message || 'Unknown error';
        if (err.message && err.message.includes('Cannot connect')) {
          errorMsg = \`Cannot connect to Edge at \${EDGE_API_URL_DISPLAY}. Make sure Edge is running: bun run src/index.ts\`;
        }
        
        status.innerHTML = \`<span style="color: var(--danger);">❌ Error: \${errorMsg}</span><br><span style="font-size: 0.7rem; color: var(--text-muted);">Check console for details</span>\`;
        status.style.color = 'var(--danger)';
      } finally {
        btn.disabled = false;
        btn.innerHTML = '🔄 Refresh';
      }
    }
    
    // Initial load and auto-refresh
    updateStats();
    updateSessions();
    updateEvents();
    updateEdges();
    refreshDevices(); // Discover devices on load
    
    setInterval(() => {
      updateStats();
      updateSessions();
      updateEvents();
      updateEdges();
    }, 3000);
    
    // Refresh devices every 10 seconds
    setInterval(() => {
      refreshDevices();
    }, 10000);
  </script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║                                                                               ║
║   ███╗   ███╗ ██████╗  ██████╗██╗  ██╗     ██████╗██╗      ██████╗ ██╗   ██╗  ║
║   ████╗ ████║██╔═══██╗██╔════╝██║ ██╔╝    ██╔════╝██║     ██╔═══██╗██║   ██║  ║
║   ██╔████╔██║██║   ██║██║     █████╔╝     ██║     ██║     ██║   ██║██║   ██║  ║
║   ██║╚██╔╝██║██║   ██║██║     ██╔═██╗     ██║     ██║     ██║   ██║██║   ██║  ║
║   ██║ ╚═╝ ██║╚██████╔╝╚██████╗██║  ██╗    ╚██████╗███████╗╚██████╔╝╚██████╔╝  ║
║   ╚═╝     ╚═╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝     ╚═════╝╚══════╝ ╚═════╝  ╚═════╝   ║
║                                                                               ║
║                        R E S T   M O C K   S E R V E R                        ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);
console.log(`[MOCK-REST] Server starting on http://${HOST}:${PORT}`);
console.log(`[MOCK-REST] Dashboard: http://localhost:${PORT}/`);
console.log(`[MOCK-REST] API Tester: http://localhost:${PORT}/api-test`);
console.log(`[MOCK-REST] Health check: http://localhost:${PORT}/health`);
console.log(`[MOCK-REST] Admin stats: http://localhost:${PORT}/admin/stats`);
console.log("");
console.log(`[MOCK-REST] ✓ Ready to receive events from Edge`);
console.log(`[MOCK-REST] Set REST_API_URL=http://localhost:${PORT}/api/v1/edge in your Edge config`);
console.log(`[MOCK-REST] Device discovery: Fetching from Edge API at ${EDGE_API_URL}`);
console.log(`[MOCK-REST] Set EDGE_API_URL env var to change Edge API URL (default: http://localhost:3000)`);
console.log("");
