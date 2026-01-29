/**
 * CarniTrack Edge Type Definitions
 * 
 * Core types for devices, sessions, events, and cloud communication.
 * 
 * Architecture v3.0 (Cloud-Centric):
 * - Sessions managed by Cloud, Edge caches active sessions
 * - Events streamed to Cloud via WebSocket
 * - Offline batches for events captured without Cloud connection
 */

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE CONFIG TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Edge configuration keys */
export type EdgeConfigKey = 
  | "edge_id"           // UUID assigned by Cloud during registration
  | "site_id"           // Site this Edge belongs to
  | "site_name"         // Human-readable site name
  | "registered_at"     // When Edge was registered with Cloud
  | "last_cloud_sync";  // Last successful Cloud communication

/** Edge identity info */
export interface EdgeIdentity {
  edgeId: string;
  siteId: string;
  siteName: string;
  registeredAt: Date;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEVICE TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Device health status - based on heartbeat and activity */
export type DeviceStatus = 
  | "online"        // TCP connected, recent heartbeat, recent activity
  | "idle"          // TCP connected, recent heartbeat, no weight events 5-30 min
  | "stale"         // TCP connected, recent heartbeat, no weight events > 30 min
  | "disconnected"  // No heartbeat for 60+ seconds
  | "unknown";      // New device, not yet connected

/** Device type based on usage */
export type DeviceType = "disassembly" | "retail" | "receiving";

/** Registered scale device */
export interface Device {
  /** Local device ID from WiFi registration packet (e.g., "SCALE-01") */
  deviceId: string;
  
  /** Global unique ID across all sites (e.g., "SITE01-SCALE-01") */
  globalDeviceId: string | null;
  
  /** Human-readable name (e.g., "Kesimhane Terazi 1") */
  displayName: string | null;
  
  /** Last known IP address (for reference only) */
  sourceIp: string | null;
  
  /** Physical location (e.g., "Kesimhane A Bölümü") */
  location: string | null;
  
  /** Device usage type */
  deviceType: DeviceType;
  
  // Health status
  /** Current health status */
  status: DeviceStatus;
  
  /** Whether TCP connection is active */
  tcpConnected: boolean;
  
  /** Last heartbeat received (from "HB" packets) */
  lastHeartbeatAt: Date | null;
  
  /** Last weight event received */
  lastEventAt: Date | null;
  
  /** Total heartbeats received since connected */
  heartbeatCount: number;
  
  /** Total weight events received since connected */
  eventCount: number;
  
  /** When TCP connection was established */
  connectedAt: Date | null;
  
  // Configuration
  /** Flag for new devices needing admin configuration */
  needsConfig: boolean;
  
  /** Work hours start (HH:MM) */
  workHoursStart: string;
  
  /** Work hours end (HH:MM) */
  workHoursEnd: string;
  
  // Cloud registration
  /** Whether Cloud knows about this device */
  cloudRegistered: boolean;
  
  /** When device was registered with Cloud */
  cloudRegisteredAt: Date | null;
  
  // Metadata
  /** First time device was seen */
  firstSeenAt: Date | null;
  
  /** Record creation time */
  createdAt: Date;
}

/** Runtime device state (in-memory) */
export interface DeviceRuntimeState {
  deviceId: string;
  globalDeviceId: string | null;
  /** Custom display name (e.g., "Sakat Tartısı", "Kesimhane Terazi 1") */
  displayName: string | null;
  /** Physical location (e.g., "Kesimhane A Bölümü") */
  location: string | null;
  /** Device type for categorization */
  deviceType: DeviceType;
  status: DeviceStatus;
  tcpConnected: boolean;
  lastHeartbeatAt: Date | null;
  lastEventAt: Date | null;
  heartbeatCount: number;
  eventCount: number;
  connectedAt: Date | null;
  sourceIp: string | null;
  /** Current TCP socket ID (for sending data) */
  socketId: string | null;
  /** Current active session ID from Cloud (if any) */
  activeCloudSessionId: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION TYPES (Cloud-Managed, Edge-Cached)
// ═══════════════════════════════════════════════════════════════════════════════

/** Session status (controlled by Cloud) */
export type SessionStatus = "active" | "paused";

/** 
 * Active session cache entry
 * Edge caches active sessions from Cloud for offline reference
 */
export interface SessionCache {
  /** Cloud-assigned session ID (UUID) - source of truth */
  cloudSessionId: string;
  
  /** Local device ID this session is for */
  deviceId: string;
  
  /** Cloud animal ID (UUID) */
  animalId: string | null;
  
  /** Animal ear tag for display (e.g., "A-123") */
  animalTag: string | null;
  
  /** Animal species (e.g., "Dana", "Kuzu", "Koyun") */
  animalSpecies: string | null;
  
  /** Operator who started the session */
  operatorId: string | null;
  
  /** Session status from Cloud */
  status: SessionStatus;
  
  /** When we cached this session */
  cachedAt: Date;
  
  /** Last update from Cloud */
  lastUpdatedAt: Date | null;
  
  /** When this cache entry expires */
  expiresAt: Date;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OFFLINE BATCH TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Offline batch reconciliation status */
export type ReconciliationStatus = 
  | "pending"      // Waiting for operator to assign to session
  | "in_progress"  // Being processed by Cloud
  | "reconciled"   // Successfully matched to session
  | "failed";      // Could not be reconciled

/** 
 * Offline batch - groups events captured without Cloud connection
 * These need reconciliation once connection is restored
 */
export interface OfflineBatch {
  /** Batch ID (UUID) */
  id: string;
  
  /** Device that generated these events */
  deviceId: string;
  
  /** When offline mode started */
  startedAt: Date;
  
  /** When connection restored (batch closed) */
  endedAt: Date | null;
  
  /** Number of events in batch */
  eventCount: number;
  
  /** Sum of weights for reference */
  totalWeightGrams: number;
  
  /** Reconciliation status */
  reconciliationStatus: ReconciliationStatus;
  
  /** Cloud session ID (assigned during reconciliation) */
  cloudSessionId: string | null;
  
  /** When reconciled */
  reconciledAt: Date | null;
  
  /** Operator who reconciled */
  reconciledBy: string | null;
  
  /** Reconciliation notes */
  notes: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Event sync status */
export type EventSyncStatus = 
  | "pending"    // Not yet sent to Cloud
  | "streaming"  // Currently being sent via WebSocket
  | "synced"     // Successfully synced to Cloud
  | "failed";    // Failed to sync (will retry)

/** Individual weighing/print event from scale */
export interface WeighingEvent {
  /** Local event ID (UUID) */
  id: string;
  
  /** Device ID (from TCP connection's registration) */
  deviceId: string;
  
  // Session linkage (Cloud-centric)
  /** Cloud session ID (from cache, NULL if offline) */
  cloudSessionId: string | null;
  
  /** Whether captured while Cloud was unreachable */
  offlineMode: boolean;
  
  /** Offline batch ID (groups offline events for reconciliation) */
  offlineBatchId: string | null;
  
  // Event data from scale
  /** PLU code (e.g., "00001") */
  pluCode: string;
  
  /** Product name from scale (e.g., "KIYMA") */
  productName: string;
  
  /** Weight in grams */
  weightGrams: number;
  
  /** Generated barcode */
  barcode: string;
  
  // Timestamps
  /** Timestamp from scale */
  scaleTimestamp: Date;
  
  /** When Edge received the event */
  receivedAt: Date;
  
  /** Source IP (for debugging) */
  sourceIp: string | null;
  
  /** Raw TCP data received */
  rawData: string;
  
  // Cloud sync status
  /** Current sync status */
  syncStatus: EventSyncStatus;
  
  /** Cloud-assigned ID after sync */
  cloudId: string | null;
  
  /** When successfully synced */
  syncedAt: Date | null;
  
  /** Number of sync attempts */
  syncAttempts: number;
  
  /** Last sync error message */
  lastSyncError: string | null;
}

/** Parsed event data from DP-401 TCP stream */
export interface ParsedScaleEvent {
  pluCode: string;
  productName: string;
  weightGrams: number;
  barcode: string;
  timestamp: string;
  operator?: string;
  rawData: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLU TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Unit type for products */
export type UnitType = "kg" | "piece";

/** PLU (Price Look-Up) item for scale catalog */
export interface PLUItem {
  /** PLU code (e.g., "00001") */
  pluCode: string;
  
  /** Product name */
  name: string;
  
  /** Turkish name for label (max 16 chars) */
  nameTurkish: string;
  
  /** Barcode */
  barcode: string;
  
  /** Price in cents (kuruş) - e.g., 15000 = 150.00 TL */
  priceCents: number;
  
  /** Unit type (kg or piece) */
  unitType: UnitType;
  
  /** Tare weight in grams */
  tareGrams: number;
  
  /** Product category (e.g., "Dana", "Kuzu", "Sakatat") */
  category: string;
  
  /** Whether item is active */
  isActive: boolean;
  
  /** Last update from cloud */
  cloudUpdatedAt: Date | null;
  
  /** Local cache update time */
  localUpdatedAt: Date;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLOUD CONNECTION TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Cloud connection state */
export type CloudConnectionState = 
  | "disconnected"   // Not connected
  | "connecting"     // Attempting to connect
  | "connected"      // WebSocket open, authenticated
  | "reconnecting"   // Lost connection, attempting to reconnect
  | "error";         // Connection error

/** Cloud connection log event type */
export type CloudConnectionEventType = 
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "error"
  | "authenticated";

/** Cloud connection log entry */
export interface CloudConnectionLogEntry {
  id: number;
  eventType: CloudConnectionEventType;
  timestamp: Date;
  details: Record<string, unknown> | null;
  durationMs: number | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET MESSAGE TYPES (Cloud ↔ Edge)
// ═══════════════════════════════════════════════════════════════════════════════

/** Message types from Cloud to Edge */
export type CloudToEdgeMessageType = 
  | "session_started"     // New session started on a device
  | "session_ended"       // Session ended
  | "session_paused"      // Session paused
  | "session_resumed"     // Session resumed
  | "plu_updated"         // PLU catalog updated
  | "event_ack"           // Acknowledgment of received event
  | "event_rejected"      // Event rejected (duplicate, invalid, etc.)
  | "config_update"       // Edge configuration changed
  | "ping"                // Keep-alive ping
  | "pong";               // Keep-alive pong response

/** Message types from Edge to Cloud */
export type EdgeToCloudMessageType = 
  | "register"            // Edge registration/hello
  | "device_connected"    // Scale connected to Edge
  | "device_disconnected" // Scale disconnected
  | "device_heartbeat"    // Scale heartbeat received
  | "event"               // New weighing event
  | "event_batch"         // Batch of events (for offline sync)
  | "offline_batch_start" // Starting offline mode
  | "offline_batch_end"   // Ending offline mode
  | "status"              // Edge status update
  | "ping"                // Keep-alive ping (Edge-initiated)
  | "pong";               // Keep-alive pong

/** Base message structure for Cloud ↔ Edge communication */
export interface CloudMessage<T = unknown> {
  /** Message type */
  type: CloudToEdgeMessageType | EdgeToCloudMessageType;
  
  /** Message payload */
  payload: T;
  
  /** Message timestamp */
  timestamp: string;
  
  /** Message ID for correlation */
  messageId: string;
  
  /** Edge ID (for Edge → Cloud messages) */
  edgeId?: string;
}

/** Session started message payload */
export interface SessionStartedPayload {
  cloudSessionId: string;
  deviceId: string;
  animalId: string;
  animalTag: string;
  animalSpecies: string;
  operatorId: string;
}

/** Session ended message payload */
export interface SessionEndedPayload {
  cloudSessionId: string;
  deviceId: string;
  reason: "completed" | "cancelled" | "timeout";
}

/** Event message payload (Edge → Cloud) */
export interface EventPayload {
  localEventId: string;
  deviceId: string;
  globalDeviceId: string;
  cloudSessionId: string | null;
  offlineMode: boolean;
  offlineBatchId: string | null;
  pluCode: string;
  productName: string;
  weightGrams: number;
  barcode: string;
  scaleTimestamp: string;
  receivedAt: string;
}

/** Event acknowledgment payload (Cloud → Edge) */
export interface EventAckPayload {
  localEventId: string;
  cloudEventId: string;
  status: "accepted" | "duplicate";
}

/** Device connection payload (Edge → Cloud) */
export interface DeviceConnectionPayload {
  deviceId: string;
  globalDeviceId: string;
  sourceIp: string;
  deviceType: DeviceType;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TCP MESSAGE TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Message type from scale TCP stream */
export type ScaleMessageType = 
  | "registration"  // Device ID on connect (e.g., "SCALE-01")
  | "heartbeat"     // "HB" every 30 seconds
  | "event"         // Weight/print event
  | "unknown";      // Unrecognized message

/** Parsed TCP message from scale */
export interface ScaleMessage {
  type: ScaleMessageType;
  raw: string;
  deviceId?: string;      // For registration messages
  event?: ParsedScaleEvent; // For event messages
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYNC QUEUE TYPES (Legacy/Fallback)
// ═══════════════════════════════════════════════════════════════════════════════

/** Sync queue item for batch upload fallback */
export interface SyncQueueItem {
  id: number;
  entityType: "event" | "device";
  entityId: string;
  action: "create" | "update";
  payload: string; // JSON
  priority: number;
  attempts: number;
  lastAttemptAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

// ═══════════════════════════════════════════════════════════════════════════════
// API RESPONSE TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Standard API response wrapper */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/** Status endpoint response */
export interface SystemStatus {
  /** Edge identity */
  edgeId: string | null;
  siteId: string | null;
  
  /** Device statuses */
  devices: Record<string, DeviceStatus>;
  
  /** Number of active session caches */
  activeSessions: number;
  
  /** Number of pending offline batches */
  pendingOfflineBatches: number;
  
  /** Number of events pending sync */
  pendingEventSync: number;
  
  /** Cloud connection state */
  cloudConnection: CloudConnectionState;
  
  /** Whether PLU update is available */
  pluUpdateNeeded: boolean;
  
  /** Service uptime in seconds */
  uptime: number;
  
  /** Service version */
  version: string;
}
