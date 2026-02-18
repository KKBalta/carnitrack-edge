/**
 * CarniTrack Edge Database Setup
 * 
 * SQLite database initialization and schema management.
 * Uses Bun's native bun:sqlite for synchronous, high-performance operations.
 * 
 * Architecture v3.0 (Cloud-Centric):
 * - Sessions are managed by Cloud, Edge only caches active sessions
 * - Events captured locally, streamed to Cloud via WebSocket
 * - Offline batches group events when Cloud is unreachable
 * - Edge identity stored locally for multi-site support
 */

import { Database } from "bun:sqlite";
import { config } from "../config.ts";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE SCHEMA v3.0 (Cloud-Centric)
// ═══════════════════════════════════════════════════════════════════════════════

const SCHEMA = `
-- ═══════════════════════════════════════════════════════════════════════════════
-- EDGE CONFIG TABLE
-- Stores Edge identity and registration info
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS edge_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- DEVICES TABLE
-- Scales identified by registration packet (e.g., "SCALE-01")
-- global_device_id provides unique identity across all sites
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,           -- Local ID from WiFi module (e.g., "SCALE-01")
    global_device_id TEXT UNIQUE,         -- Site-prefixed ID (e.g., "SITE01-SCALE-01")
    display_name TEXT,                    -- Human readable (e.g., "Kesimhane Terazi 1")
    source_ip TEXT,                       -- For reference/debugging only
    location TEXT,                        -- "Kesimhane A Bölümü"
    device_type TEXT DEFAULT 'disassembly', -- disassembly, retail, receiving
    
    -- Health status (hardware heartbeat aware)
    status TEXT DEFAULT 'unknown',        -- online, idle, stale, disconnected
    tcp_connected INTEGER DEFAULT 0,
    last_heartbeat_at TEXT,               -- From "HB" packets (every 30s)
    last_event_at TEXT,                   -- From weight events
    heartbeat_count INTEGER DEFAULT 0,
    event_count INTEGER DEFAULT 0,
    connected_at TEXT,                    -- When TCP connected
    
    -- Configuration
    needs_config INTEGER DEFAULT 1,       -- Flag for new devices
    work_hours_start TEXT DEFAULT '06:00',
    work_hours_end TEXT DEFAULT '18:00',
    
    -- Cloud registration
    cloud_registered INTEGER DEFAULT 0,   -- Whether Cloud knows about this device
    cloud_registered_at TEXT,
    
    -- Metadata
    first_seen_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- ACTIVE SESSIONS CACHE TABLE
-- Caches active sessions received from Cloud
-- Edge does NOT manage session lifecycle - Cloud does
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS active_sessions_cache (
    cloud_session_id TEXT PRIMARY KEY,    -- UUID from Cloud (source of truth)
    device_id TEXT NOT NULL,              -- Local device ID this session is for
    animal_id TEXT,                       -- Cloud animal UUID
    animal_tag TEXT,                      -- Ear tag for display (e.g., "A-123")
    animal_species TEXT,                  -- "Dana", "Kuzu", "Koyun"
    operator_id TEXT,                     -- Who started the session (from Cloud)
    
    status TEXT DEFAULT 'active',         -- active, paused (from Cloud)
    
    -- Cache metadata
    cached_at TEXT NOT NULL,              -- When we received this from Cloud
    last_updated_at TEXT,                 -- Last Cloud update
    expires_at TEXT,                      -- Cache expiry (4 hours after last update)
    
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- OFFLINE BATCHES TABLE
-- Groups events captured when Cloud is unreachable
-- These batches need reconciliation when connection is restored
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS offline_batches (
    id TEXT PRIMARY KEY,                  -- UUID
    device_id TEXT NOT NULL,              -- Which device generated these events
    
    started_at TEXT NOT NULL,             -- When offline mode started
    ended_at TEXT,                        -- When connection restored (batch closed)
    
    event_count INTEGER DEFAULT 0,        -- Number of events in batch
    total_weight_grams INTEGER DEFAULT 0, -- Sum of weights for reference
    
    -- Reconciliation status
    reconciliation_status TEXT DEFAULT 'pending', -- pending, in_progress, reconciled, failed
    cloud_session_id TEXT,                -- Assigned during reconciliation
    reconciled_at TEXT,
    reconciled_by TEXT,                   -- Operator who reconciled
    notes TEXT,                           -- Reconciliation notes
    
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- EVENTS TABLE
-- Individual weighing/print events from scales
-- Now supports offline mode and Cloud sync status
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,                  -- Local UUID
    device_id TEXT NOT NULL,              -- From TCP connection's registration
    
    -- Session linkage (Cloud-centric)
    cloud_session_id TEXT,                -- From active_sessions_cache (NULL if offline)
    offline_mode INTEGER DEFAULT 0,       -- 1 if captured while Cloud unreachable
    offline_batch_id TEXT,                -- Groups offline events for reconciliation
    
    -- Event data from scale
    plu_code TEXT,
    product_name TEXT,
    weight_grams INTEGER,
    tare_grams INTEGER DEFAULT 0,  -- Tare weight (dara) in grams
    barcode TEXT,
    
    -- Timestamps
    scale_timestamp TEXT,                 -- Timestamp from scale
    received_at TEXT NOT NULL,            -- When Edge received the event
    source_ip TEXT,                       -- For debugging only
    raw_data TEXT,                        -- Raw TCP data received
    
    -- Cloud sync status
    sync_status TEXT DEFAULT 'pending',   -- pending, streaming, synced, failed
    cloud_id TEXT,                        -- Cloud-assigned ID after sync
    synced_at TEXT,                       -- When successfully synced
    sync_attempts INTEGER DEFAULT 0,      -- Retry counter
    last_sync_error TEXT,                 -- Last error message if failed
    
    FOREIGN KEY (device_id) REFERENCES devices(device_id),
    FOREIGN KEY (cloud_session_id) REFERENCES active_sessions_cache(cloud_session_id),
    FOREIGN KEY (offline_batch_id) REFERENCES offline_batches(id)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- PLU CACHE TABLE
-- PLU catalog cached from Cloud
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS plu_cache (
    plu_code TEXT PRIMARY KEY,
    name TEXT,
    name_turkish TEXT,                    -- For label (max 16 chars)
    barcode TEXT,
    price_cents INTEGER,
    unit_type TEXT,                       -- 'kg' or 'piece'
    tare_grams INTEGER DEFAULT 0,
    category TEXT,
    is_active INTEGER DEFAULT 1,
    cloud_updated_at TEXT,
    local_updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- PLU VERSIONS TABLE
-- Track generated PLU file versions
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS plu_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,                -- ISO timestamp
    generated_at TEXT NOT NULL,
    file_hash TEXT,                       -- MD5 of generated file
    item_count INTEGER,
    downloaded_by_operator INTEGER DEFAULT 0
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- CLOUD CONNECTION LOG
-- Audit trail of Cloud connectivity for debugging
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cloud_connection_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,             -- connected, disconnected, reconnecting, error
    timestamp TEXT NOT NULL,
    details TEXT,                         -- JSON with additional info
    duration_ms INTEGER                   -- For disconnected events: how long we were connected
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- SYNC QUEUE TABLE (Legacy - kept for fallback)
-- Used if WebSocket streaming fails and we need batch upload
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT,                     -- 'event', 'device'
    entity_id TEXT,
    action TEXT,                          -- 'create', 'update'
    payload TEXT,                         -- JSON
    priority INTEGER DEFAULT 0,           -- Higher = more urgent
    attempts INTEGER DEFAULT 0,
    last_attempt_at TEXT,
    last_error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════════════════════

-- Devices
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
CREATE INDEX IF NOT EXISTS idx_devices_global_id ON devices(global_device_id);

-- Active sessions cache
CREATE INDEX IF NOT EXISTS idx_sessions_cache_device ON active_sessions_cache(device_id);
CREATE INDEX IF NOT EXISTS idx_sessions_cache_status ON active_sessions_cache(status);
CREATE INDEX IF NOT EXISTS idx_sessions_cache_expires ON active_sessions_cache(expires_at);

-- Offline batches
CREATE INDEX IF NOT EXISTS idx_offline_batches_device ON offline_batches(device_id);
CREATE INDEX IF NOT EXISTS idx_offline_batches_status ON offline_batches(reconciliation_status);
CREATE INDEX IF NOT EXISTS idx_offline_batches_pending ON offline_batches(reconciliation_status) 
    WHERE reconciliation_status = 'pending';

-- Events
CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id);
CREATE INDEX IF NOT EXISTS idx_events_cloud_session ON events(cloud_session_id);
CREATE INDEX IF NOT EXISTS idx_events_offline_batch ON events(offline_batch_id);
CREATE INDEX IF NOT EXISTS idx_events_sync_status ON events(sync_status);
CREATE INDEX IF NOT EXISTS idx_events_pending_sync ON events(sync_status) 
    WHERE sync_status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_events_offline ON events(offline_mode) 
    WHERE offline_mode = 1;
CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at);

-- Sync queue
CREATE INDEX IF NOT EXISTS idx_sync_queue_pending ON sync_queue(attempts, priority) 
    WHERE attempts < 3;

-- Deduplication index (device + timestamp + plu + weight)
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedup 
    ON events(device_id, scale_timestamp, plu_code, weight_grams);
`;

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

let db: Database | null = null;

/**
 * Get the database instance (singleton)
 */
export function getDatabase(): Database {
  if (!db) {
    db = initDatabase();
  }
  return db;
}

/**
 * Initialize the database connection and schema
 */
export function initDatabase(): Database {
  const dbPath = config.database.path;
  
  // Ensure data directory exists
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
    console.log(`[DB] Created data directory: ${dbDir}`);
  }
  
  // Open database connection
  const database = new Database(dbPath, { create: true });
  
  // Enable WAL mode for better concurrent performance
  database.exec("PRAGMA journal_mode = WAL");
  
  // Enable foreign keys
  database.exec("PRAGMA foreign_keys = ON");
  
  // Run schema
  database.exec(SCHEMA);
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // MIGRATIONS: Add new columns to existing tables if they don't exist
  // ═══════════════════════════════════════════════════════════════════════════════
  
  // Migration: Add tare_grams column to events table (if it doesn't exist)
  try {
    // Check if column exists by trying to select it
    database.exec(`SELECT tare_grams FROM events LIMIT 1`);
  } catch (e) {
    // Column doesn't exist, add it
    console.log(`[DB] Adding tare_grams column to events table...`);
    database.exec(`ALTER TABLE events ADD COLUMN tare_grams INTEGER DEFAULT 0`);
    console.log(`[DB] ✓ Migration complete: tare_grams column added`);
  }
  
  // Store reference
  db = database;
  
  console.log(`[DB] Database initialized at: ${dbPath}`);
  console.log(`[DB] Schema version: 3.0 (Cloud-Centric)`);
  
  return database;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    console.log("[DB] Database connection closed");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE CONFIG HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get Edge configuration value
 */
export function getEdgeConfig(key: string): string | null {
  const db = getDatabase();
  const row = db.prepare("SELECT value FROM edge_config WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Set Edge configuration value
 */
export function setEdgeConfig(key: string, value: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO edge_config (key, value, updated_at) 
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, value);
}

/**
 * Delete Edge configuration value
 */
export function deleteEdgeConfig(key: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM edge_config WHERE key = ?").run(key);
}

/**
 * Get all Edge configuration
 */
export function getAllEdgeConfig(): Record<string, string> {
  const db = getDatabase();
  const rows = db.prepare("SELECT key, value FROM edge_config").all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert Date to ISO string for SQLite storage
 */
export function toSqliteDate(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

/**
 * Convert SQLite ISO string to Date
 */
export function fromSqliteDate(str: string | null): Date | null {
  return str ? new Date(str) : null;
}

/**
 * Generate a UUID v4
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Get current timestamp in ISO format
 */
export function nowISO(): string {
  return new Date().toISOString();
}

export default {
  getDatabase,
  initDatabase,
  closeDatabase,
  getEdgeConfig,
  setEdgeConfig,
  deleteEdgeConfig,
  getAllEdgeConfig,
  toSqliteDate,
  fromSqliteDate,
  generateId,
  nowISO,
};
