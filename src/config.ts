/**
 * CarniTrack Edge Configuration
 * 
 * All configuration settings for the Edge service.
 * Values can be overridden via environment variables.
 * 
 * Architecture v3.0 (Cloud-Centric):
 * - Edge identity (edgeId, siteId) stored in database
 * - WebSocket connection to Cloud for real-time communication
 * - Sessions managed by Cloud, Edge caches active sessions
 */

import { join } from "path";

// Base paths
const PROJECT_ROOT = import.meta.dir ? join(import.meta.dir, "..") : process.cwd();

export const config = {
  // ═══════════════════════════════════════════════════════════════════════════
  // EDGE IDENTITY
  // Note: Actual values stored in database after registration with Cloud
  // These env vars are only used for initial registration
  // ═══════════════════════════════════════════════════════════════════════════
  edge: {
    /** Site ID for registration (from Cloud setup) */
    siteId: process.env.SITE_ID || "",
    
    /** Site registration token (for initial Cloud registration) */
    registrationToken: process.env.REGISTRATION_TOKEN || "",
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // TCP SERVER CONFIGURATION (Scale connections)
  // ═══════════════════════════════════════════════════════════════════════════
  tcp: {
    /** Port to listen for scale connections */
    port: Number(process.env.TCP_PORT) || 8899,
    
    /** Host to bind TCP server (0.0.0.0 for all interfaces) */
    host: process.env.TCP_HOST || "0.0.0.0",
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // HTTP SERVER CONFIGURATION (Admin Dashboard & API)
  // ═══════════════════════════════════════════════════════════════════════════
  http: {
    /** Port for admin dashboard and API */
    port: Number(process.env.HTTP_PORT) || 3000,
    
    /** Host to bind HTTP server */
    host: process.env.HTTP_HOST || "0.0.0.0",
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // DATABASE CONFIGURATION (SQLite)
  // ═══════════════════════════════════════════════════════════════════════════
  database: {
    /** Path to SQLite database file */
    path: process.env.DB_PATH || join(PROJECT_ROOT, "data", "carnitrack.db"),
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // WEBSOCKET CONFIGURATION (Cloud Connection)
  // Real-time bidirectional communication with Cloud
  // ═══════════════════════════════════════════════════════════════════════════
  websocket: {
    /** Cloud WebSocket URL */
    url: process.env.CLOUD_WS_URL || "wss://api.carnitrack.com/edge/ws",
    
    /** Initial reconnection delay (ms) */
    reconnectDelayMs: Number(process.env.WS_RECONNECT_DELAY_MS) || 1_000,
    
    /** Maximum reconnection delay with backoff (ms) */
    maxReconnectDelayMs: Number(process.env.WS_MAX_RECONNECT_DELAY_MS) || 30_000,
    
    /** Reconnection backoff multiplier */
    reconnectBackoffMultiplier: 1.5,
    
    /** Keep-alive ping interval (ms) */
    pingIntervalMs: Number(process.env.WS_PING_INTERVAL_MS) || 30_000,
    
    /** Ping timeout before considering connection dead (ms) */
    pingTimeoutMs: Number(process.env.WS_PING_TIMEOUT_MS) || 10_000,
    
    /** Max reconnection attempts (Infinity = keep trying forever) */
    maxReconnectAttempts: Infinity,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CLOUD API CONFIGURATION (REST fallback)
  // Used for registration, PLU sync, and batch uploads when WebSocket fails
  // ═══════════════════════════════════════════════════════════════════════════
  cloud: {
    /** Cloud API base URL */
    apiUrl: process.env.CLOUD_API_URL || "https://api.carnitrack.com/api/v1",
    
    /** Batch size for event uploads (fallback sync) */
    batchSize: Number(process.env.CLOUD_BATCH_SIZE) || 50,
    
    /** Fallback sync interval when WebSocket is down (ms) */
    fallbackSyncIntervalMs: Number(process.env.CLOUD_SYNC_INTERVAL_MS) || 30_000,
    
    /** Max retry attempts for failed API calls */
    maxRetries: 3,
    
    /** Delay between retries (ms) */
    retryDelayMs: 5_000,
    
    /** Request timeout (ms) */
    requestTimeoutMs: 30_000,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // HEARTBEAT & HEALTH MONITORING
  // ═══════════════════════════════════════════════════════════════════════════
  heartbeat: {
    /** Expected interval between device heartbeats (ms) - WiFi module sends every 30s */
    expectedIntervalMs: 30_000,
    
    /** Time without heartbeat before marking device disconnected (ms) - 2 missed HBs */
    timeoutMs: Number(process.env.HEARTBEAT_TIMEOUT_MS) || 60_000,
    
    /** Interval to check heartbeat status (ms) */
    checkIntervalMs: 15_000,
    
    /** Registration packet string pattern (device sends "SCALE-XX" on connect) */
    registrationPattern: /^SCALE-\d{2}$/,
    
    /** Heartbeat string from WiFi module */
    heartbeatString: "HB",
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTIVITY MONITORING (for operational awareness)
  // ═══════════════════════════════════════════════════════════════════════════
  activity: {
    /** Time without weight events before marking device "idle" (ms) */
    idleThresholdMs: Number(process.env.ACTIVITY_IDLE_MS) || 5 * 60 * 1000, // 5 min
    
    /** Time without weight events before marking device "stale" (ms) */
    staleThresholdMs: Number(process.env.ACTIVITY_STALE_MS) || 30 * 60 * 1000, // 30 min
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SESSION CACHE CONFIGURATION
  // Edge caches active sessions from Cloud (Cloud manages lifecycle)
  // ═══════════════════════════════════════════════════════════════════════════
  sessionCache: {
    /** How long to keep cached session valid without Cloud update (ms) */
    expiryMs: Number(process.env.SESSION_CACHE_EXPIRY_MS) || 4 * 60 * 60 * 1000, // 4 hours
    
    /** Interval to clean expired cache entries (ms) */
    cleanupIntervalMs: 15 * 60 * 1000, // 15 min
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // OFFLINE MODE CONFIGURATION
  // Settings for when Cloud is unreachable
  // ═══════════════════════════════════════════════════════════════════════════
  offline: {
    /** Time without Cloud connection before entering offline mode (ms) */
    offlineTriggerDelayMs: Number(process.env.OFFLINE_TRIGGER_DELAY_MS) || 5_000,
    
    /** Maximum events to store per offline batch before starting new batch */
    maxEventsPerBatch: Number(process.env.OFFLINE_MAX_EVENTS_PER_BATCH) || 1000,
    
    /** How long to keep offline batches before cleanup (days) */
    batchRetentionDays: Number(process.env.OFFLINE_BATCH_RETENTION_DAYS) || 30,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PLU GENERATION
  // ═══════════════════════════════════════════════════════════════════════════
  plu: {
    /** Output directory for generated PLU files */
    outputDir: process.env.PLU_OUTPUT_DIR || join(PROJECT_ROOT, "generated"),
    
    /** Default encoding for PLU files (Windows-1254 for Turkish) */
    encoding: "windows-1254" as const,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // WORK HOURS (for alert thresholds)
  // ═══════════════════════════════════════════════════════════════════════════
  workHours: {
    /** Work start time (HH:MM) */
    start: process.env.WORK_HOURS_START || "06:00",
    
    /** Work end time (HH:MM) */
    end: process.env.WORK_HOURS_END || "18:00",
    
    /** Timezone */
    timezone: process.env.TIMEZONE || "Europe/Istanbul",
    
    /** Work days (1=Mon, 7=Sun) */
    workDays: [1, 2, 3, 4, 5, 6], // Mon-Sat
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // LOGGING
  // ═══════════════════════════════════════════════════════════════════════════
  logging: {
    /** Log level: debug, info, warn, error */
    level: (process.env.LOG_LEVEL || "info") as "debug" | "info" | "warn" | "error",
    
    /** Enable console output */
    console: true,
    
    /** Log directory */
    dir: process.env.LOG_DIR || join(PROJECT_ROOT, "logs"),
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PATHS
  // ═══════════════════════════════════════════════════════════════════════════
  paths: {
    root: PROJECT_ROOT,
    data: join(PROJECT_ROOT, "data"),
    generated: join(PROJECT_ROOT, "generated"),
    logs: join(PROJECT_ROOT, "logs"),
    ui: join(PROJECT_ROOT, "src", "ui"),
  },
} as const;

export type Config = typeof config;
export default config;
