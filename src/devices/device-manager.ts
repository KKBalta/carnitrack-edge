/**
 * CarniTrack Edge Device Manager
 * 
 * Manages connected DP-401 scales lifecycle, status, and persistence.
 * 
 * Device States:
 * - unknown: New device, never connected
 * - online: TCP connected, recent heartbeat and activity
 * - idle: TCP connected, recent heartbeat, no weight events 5-30 min
 * - stale: TCP connected, heartbeat delayed (warning state)
 * - disconnected: No heartbeat for timeout period OR TCP disconnect
 * 
 * State Machine:
 * [New Connection] → REGISTERED → ONLINE ↔ IDLE ↔ STALE → DISCONNECTED
 *                                   ↑                         ↓
 *                                   └─────────────────────────┘
 *                                       (reconnect)
 */

import { getDatabase, nowISO, fromSqliteDate } from "../storage/database.ts";
import type { Device, DeviceStatus, DeviceType, DeviceRuntimeState } from "../types/index.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Device state change event */
export type DeviceEvent = 
  | "registered"     // New device first seen
  | "connected"      // Device connected (new or reconnection)
  | "online"         // Device is active and healthy
  | "idle"           // Device connected but no recent activity
  | "stale"          // Device heartbeat delayed
  | "disconnected"   // Device disconnected
  | "updated";       // Device info updated

/** Device event callback */
export type DeviceEventCallback = (device: DeviceRuntimeState, event: DeviceEvent) => void;

/** Device registration options */
export interface DeviceRegistrationOptions {
  socketId: string;
  scaleNumber: string;
  sourceIp: string;
  deviceType?: DeviceType;
}

/** Database row type */
interface DeviceRow {
  device_id: string;
  global_device_id: string | null;
  display_name: string | null;
  source_ip: string | null;
  location: string | null;
  device_type: string;
  status: string;
  tcp_connected: number;
  last_heartbeat_at: string | null;
  last_event_at: string | null;
  heartbeat_count: number;
  event_count: number;
  connected_at: string | null;
  needs_config: number;
  work_hours_start: string;
  work_hours_end: string;
  cloud_registered: number;
  cloud_registered_at: string | null;
  first_seen_at: string | null;
  created_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEVICE MANAGER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class DeviceManager {
  /** In-memory device states (deviceId → runtime state) */
  private devices: Map<string, DeviceRuntimeState> = new Map();
  
  /** Socket to device mapping (socketId → deviceId) */
  private socketToDevice: Map<string, string> = new Map();
  
  /** Event listeners */
  private listeners: Map<DeviceEvent, Set<DeviceEventCallback>> = new Map();
  
  /** Site ID for generating global device IDs */
  private siteId: string | null = null;
  
  constructor() {
    // Initialize listener maps
    const events: DeviceEvent[] = ["registered", "connected", "online", "idle", "stale", "disconnected", "updated"];
    for (const event of events) {
      this.listeners.set(event, new Set());
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════════
  
  /**
   * Initialize the device manager
   * Loads known devices from database into memory
   */
  initialize(siteId: string | null = null): void {
    this.siteId = siteId;
    
    console.log("[DeviceManager] Initializing...");
    
    // Clear existing devices before loading
    this.devices.clear();
    this.socketToDevice.clear();
    
    // Load all devices from database
    const db = getDatabase();
    const rows = db.prepare("SELECT * FROM devices").all() as DeviceRow[];
    
    for (const row of rows) {
      const runtimeState = this.rowToRuntimeState(row);
      // All loaded devices start as disconnected until they connect
      runtimeState.status = "disconnected";
      runtimeState.tcpConnected = false;
      this.devices.set(row.device_id, runtimeState);
    }
    
    console.log(`[DeviceManager] Loaded ${rows.length} devices from database`);
    console.log(`[DeviceManager] Site ID: ${this.siteId || "Not set"}`);
  }
  
  /**
   * Set the site ID (for generating global device IDs)
   */
  setSiteId(siteId: string): void {
    this.siteId = siteId;
    console.log(`[DeviceManager] Site ID set to: ${siteId}`);
  }

  /**
   * Get the current site ID
   */
  getSiteId(): string | null {
    return this.siteId;
  }
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // DEVICE LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════════════
  
  /**
   * Register a device when SCALE-XX packet is received
   * Handles both new device registration and reconnection
   */
  registerDevice(options: DeviceRegistrationOptions): DeviceRuntimeState {
    const { socketId, scaleNumber, sourceIp, deviceType = "disassembly" } = options;
    const deviceId = `SCALE-${scaleNumber.padStart(2, "0")}`;
    const now = new Date();
    
    // Check if device already exists
    const existingDevice = this.devices.get(deviceId);
    
    if (existingDevice) {
      // ─────────────────────────────────────────────────────────────────────────
      // RECONNECTION - Update existing device
      // ─────────────────────────────────────────────────────────────────────────
      
      // Clean up old socket mapping if different socket
      if (existingDevice.socketId && existingDevice.socketId !== socketId) {
        this.socketToDevice.delete(existingDevice.socketId);
      }
      
      // Update runtime state
      existingDevice.socketId = socketId;
      existingDevice.sourceIp = sourceIp;
      existingDevice.tcpConnected = true;
      existingDevice.status = "online";
      existingDevice.lastHeartbeatAt = now;
      existingDevice.connectedAt = now;
      existingDevice.heartbeatCount++;
      
      // Update socket mapping
      this.socketToDevice.set(socketId, deviceId);
      
      // Persist to database
      this.updateDeviceInDatabase(deviceId, {
        source_ip: sourceIp,
        tcp_connected: 1,
        status: "online",
        last_heartbeat_at: nowISO(),
        connected_at: nowISO(),
        heartbeat_count: existingDevice.heartbeatCount,
      });
      
      const name = existingDevice.displayName || deviceId;
      console.log(`[DeviceManager] ↻ Device reconnected: ${name} (${deviceId}) from ${sourceIp}`);
      this.emit("connected", existingDevice);
      
      return existingDevice;
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // NEW DEVICE REGISTRATION
    // ─────────────────────────────────────────────────────────────────────────
    
    // Generate global device ID
    const globalDeviceId = this.siteId ? `${this.siteId}-${deviceId}` : deviceId;
    
    // Create runtime state
    const runtimeState: DeviceRuntimeState = {
      deviceId,
      globalDeviceId,
      displayName: null, // Will be set via API
      location: null, // Will be set via API
      deviceType,
      status: "online",
      tcpConnected: true,
      lastHeartbeatAt: now,
      lastEventAt: null,
      heartbeatCount: 1,
      eventCount: 0,
      connectedAt: now,
      sourceIp,
      socketId,
      activeCloudSessionId: null,
    };
    
    // Store in memory
    this.devices.set(deviceId, runtimeState);
    this.socketToDevice.set(socketId, deviceId);
    
    // Persist to database
    this.insertDeviceInDatabase({
      device_id: deviceId,
      global_device_id: globalDeviceId,
      source_ip: sourceIp,
      device_type: deviceType,
      status: "online",
      tcp_connected: 1,
      last_heartbeat_at: nowISO(),
      connected_at: nowISO(),
      first_seen_at: nowISO(),
      heartbeat_count: 1,
      event_count: 0,
    });
    
    console.log(`[DeviceManager] ✓ New device registered: ${deviceId} (global: ${globalDeviceId}) from ${sourceIp}`);
    this.emit("registered", runtimeState);
    this.emit("connected", runtimeState);
    
    return runtimeState;
  }
  
  /**
   * Update device on heartbeat received
   */
  updateHeartbeat(socketId: string): DeviceRuntimeState | null {
    const deviceId = this.socketToDevice.get(socketId);
    if (!deviceId) {
      return null;
    }
    
    const device = this.devices.get(deviceId);
    if (!device) {
      return null;
    }
    
    const now = new Date();
    const previousStatus = device.status;
    
    // Update state
    device.lastHeartbeatAt = now;
    device.heartbeatCount++;
    
    // Restore to online if was stale
    if (device.status === "stale") {
      device.status = "online";
    }
    
    // Check if should be idle (no events for 5+ minutes)
    if (device.status === "online" && device.lastEventAt) {
      const timeSinceEvent = now.getTime() - device.lastEventAt.getTime();
      if (timeSinceEvent > 5 * 60 * 1000) { // 5 minutes
        device.status = "idle";
      }
    }
    
    // Persist to database (batch update to reduce writes)
    this.updateDeviceInDatabase(deviceId, {
      last_heartbeat_at: nowISO(),
      heartbeat_count: device.heartbeatCount,
      status: device.status,
    });
    
    // Emit state change if status changed
    if (previousStatus !== device.status) {
      this.emit(device.status as DeviceEvent, device);
    }
    
    return device;
  }
  
  /**
   * Update device on weighing event received
   */
  updateOnEvent(socketId: string): DeviceRuntimeState | null {
    const deviceId = this.socketToDevice.get(socketId);
    if (!deviceId) {
      return null;
    }
    
    const device = this.devices.get(deviceId);
    if (!device) {
      return null;
    }
    
    const now = new Date();
    const previousStatus = device.status;
    
    // Update state
    device.lastEventAt = now;
    device.eventCount++;
    
    // Event received means device is active
    if (device.status === "idle" || device.status === "stale") {
      device.status = "online";
    }
    
    // Persist to database
    this.updateDeviceInDatabase(deviceId, {
      last_event_at: nowISO(),
      event_count: device.eventCount,
      status: device.status,
    });
    
    // Emit state change if status changed
    if (previousStatus !== device.status) {
      this.emit("online", device);
    }
    
    return device;
  }
  
  /**
   * Mark device as disconnected
   */
  disconnectDevice(socketId: string, reason: string): DeviceRuntimeState | null {
    const deviceId = this.socketToDevice.get(socketId);
    if (!deviceId) {
      // Unknown socket, just clean up
      this.socketToDevice.delete(socketId);
      return null;
    }
    
    const device = this.devices.get(deviceId);
    if (!device) {
      this.socketToDevice.delete(socketId);
      return null;
    }
    
    // Update state
    device.tcpConnected = false;
    device.status = "disconnected";
    device.socketId = null;
    
    // Clean up socket mapping
    this.socketToDevice.delete(socketId);
    
    // Persist to database
    this.updateDeviceInDatabase(deviceId, {
      tcp_connected: 0,
      status: "disconnected",
    });
    
    console.log(`[DeviceManager] ✗ Device disconnected: ${deviceId} - ${reason}`);
    this.emit("disconnected", device);
    
    return device;
  }
  
  /**
   * Mark device as stale (heartbeat timeout warning)
   */
  markAsStale(deviceId: string): DeviceRuntimeState | null {
    const device = this.devices.get(deviceId);
    if (!device || device.status === "disconnected") {
      return null;
    }
    
    if (device.status !== "stale") {
      device.status = "stale";
      
      // Persist to database
      this.updateDeviceInDatabase(deviceId, {
        status: "stale",
      });
      
      console.log(`[DeviceManager] ⚠ Device stale: ${deviceId}`);
      this.emit("stale", device);
    }
    
    return device;
  }
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // QUERIES
  // ═══════════════════════════════════════════════════════════════════════════════
  
  /**
   * Get device by socket ID
   */
  getDeviceBySocketId(socketId: string): DeviceRuntimeState | null {
    const deviceId = this.socketToDevice.get(socketId);
    return deviceId ? this.devices.get(deviceId) || null : null;
  }
  
  /**
   * Get device by device ID
   */
  getDevice(deviceId: string): DeviceRuntimeState | null {
    return this.devices.get(deviceId) || null;
  }
  
  /**
   * Get device by scale number (e.g., "01" → "SCALE-01")
   */
  getDeviceByScaleNumber(scaleNumber: string): DeviceRuntimeState | null {
    const deviceId = `SCALE-${scaleNumber.padStart(2, "0")}`;
    return this.devices.get(deviceId) || null;
  }
  
  /**
   * Get all devices
   */
  getAllDevices(): DeviceRuntimeState[] {
    return Array.from(this.devices.values());
  }
  
  /**
   * Get active (connected) devices
   */
  getActiveDevices(): DeviceRuntimeState[] {
    return Array.from(this.devices.values()).filter(d => d.tcpConnected);
  }
  
  /**
   * Get devices by status
   */
  getDevicesByStatus(status: DeviceStatus): DeviceRuntimeState[] {
    return Array.from(this.devices.values()).filter(d => d.status === status);
  }
  
  /**
   * Get device count
   */
  getDeviceCount(): number {
    return this.devices.size;
  }
  
  /**
   * Get connected device count
   */
  getConnectedCount(): number {
    return Array.from(this.devices.values()).filter(d => d.tcpConnected).length;
  }
  
  /**
   * Get device ID from socket ID
   */
  getDeviceIdFromSocket(socketId: string): string | null {
    return this.socketToDevice.get(socketId) || null;
  }
  
  /**
   * Get socket ID from device ID
   */
  getSocketIdFromDevice(deviceId: string): string | null {
    const device = this.devices.get(deviceId);
    return device?.tcpConnected ? device.socketId : null;
  }
  
  /**
   * Check if device is connected
   */
  isConnected(deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    return device?.tcpConnected ?? false;
  }
  
  /**
   * Get devices summary for status API
   */
  getStatusSummary(): Record<string, DeviceStatus> {
    const summary: Record<string, DeviceStatus> = {};
    for (const [deviceId, device] of this.devices) {
      summary[deviceId] = device.status;
    }
    return summary;
  }
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // SESSION MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════════
  
  /**
   * Set active session for device
   */
  setActiveSession(deviceId: string, cloudSessionId: string | null): void {
    const device = this.devices.get(deviceId);
    if (device) {
      device.activeCloudSessionId = cloudSessionId;
      this.emit("updated", device);
    }
  }
  
  /**
   * Get active session ID for device
   */
  getActiveSession(deviceId: string): string | null {
    const device = this.devices.get(deviceId);
    return device?.activeCloudSessionId || null;
  }
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // EVENTS
  // ═══════════════════════════════════════════════════════════════════════════════
  
  /**
   * Subscribe to device events
   */
  on(event: DeviceEvent, callback: DeviceEventCallback): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.add(callback);
    }
  }
  
  /**
   * Unsubscribe from device events
   */
  off(event: DeviceEvent, callback: DeviceEventCallback): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.delete(callback);
    }
  }
  
  /**
   * Emit device event
   */
  private emit(event: DeviceEvent, device: DeviceRuntimeState): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      for (const callback of listeners) {
        try {
          callback(device, event);
        } catch (error) {
          console.error(`[DeviceManager] Event listener error (${event}):`, error);
        }
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // DATABASE OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════════
  
  /**
   * Insert new device into database
   */
  private insertDeviceInDatabase(data: Partial<DeviceRow>): void {
    const db = getDatabase();
    
    db.prepare(`
      INSERT INTO devices (
        device_id, global_device_id, source_ip, device_type, status,
        tcp_connected, last_heartbeat_at, connected_at, first_seen_at,
        heartbeat_count, event_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      data.device_id ?? "",
      data.global_device_id ?? null,
      data.source_ip ?? null,
      data.device_type ?? "disassembly",
      data.status ?? "online",
      data.tcp_connected ?? 0,
      data.last_heartbeat_at ?? null,
      data.connected_at ?? null,
      data.first_seen_at ?? null,
      data.heartbeat_count ?? 0,
      data.event_count ?? 0,
    );
  }
  
  /**
   * Update device in database
   */
  private updateDeviceInDatabase(deviceId: string, updates: Partial<DeviceRow>): void {
    const db = getDatabase();
    
    // Build dynamic UPDATE query
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    
    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = ?`);
      values.push(value as string | number | null);
    }
    
    if (fields.length === 0) return;
    
    values.push(deviceId);
    
    db.prepare(`
      UPDATE devices SET ${fields.join(", ")} WHERE device_id = ?
    `).run(...values);
  }
  
  /**
   * Convert database row to runtime state
   */
  private rowToRuntimeState(row: DeviceRow): DeviceRuntimeState {
    return {
      deviceId: row.device_id,
      globalDeviceId: row.global_device_id,
      displayName: row.display_name,
      location: row.location,
      deviceType: row.device_type as DeviceType,
      status: row.status as DeviceStatus,
      tcpConnected: row.tcp_connected === 1,
      lastHeartbeatAt: fromSqliteDate(row.last_heartbeat_at),
      lastEventAt: fromSqliteDate(row.last_event_at),
      heartbeatCount: row.heartbeat_count,
      eventCount: row.event_count,
      connectedAt: fromSqliteDate(row.connected_at),
      sourceIp: row.source_ip,
      socketId: null, // Will be set on connection
      activeCloudSessionId: null, // Will be set from session cache
    };
  }
  
  /**
   * Get full device record from database
   */
  getDeviceFromDatabase(deviceId: string): Device | null {
    const db = getDatabase();
    const row = db.prepare("SELECT * FROM devices WHERE device_id = ?").get(deviceId) as DeviceRow | undefined;
    
    if (!row) return null;
    
    return {
      deviceId: row.device_id,
      globalDeviceId: row.global_device_id,
      displayName: row.display_name,
      sourceIp: row.source_ip,
      location: row.location,
      deviceType: row.device_type as DeviceType,
      status: row.status as DeviceStatus,
      tcpConnected: row.tcp_connected === 1,
      lastHeartbeatAt: fromSqliteDate(row.last_heartbeat_at),
      lastEventAt: fromSqliteDate(row.last_event_at),
      heartbeatCount: row.heartbeat_count,
      eventCount: row.event_count,
      connectedAt: fromSqliteDate(row.connected_at),
      needsConfig: row.needs_config === 1,
      workHoursStart: row.work_hours_start,
      workHoursEnd: row.work_hours_end,
      cloudRegistered: row.cloud_registered === 1,
      cloudRegisteredAt: fromSqliteDate(row.cloud_registered_at),
      firstSeenAt: fromSqliteDate(row.first_seen_at),
      createdAt: new Date(row.created_at),
    };
  }
  
  /**
   * Update device configuration (display name, location, etc.)
   * Useful for giving devices friendly names like "Sakat Tartısı"
   */
  updateDeviceConfig(deviceId: string, updates: Partial<{
    displayName: string | null;
    location: string | null;
    deviceType: DeviceType;
    workHoursStart: string;
    workHoursEnd: string;
    needsConfig: boolean;
  }>): boolean {
    const device = this.devices.get(deviceId);
    if (!device) return false;
    
    const dbUpdates: Partial<DeviceRow> = {};
    
    // Update both in-memory state and database
    if (updates.displayName !== undefined) {
      device.displayName = updates.displayName;
      dbUpdates.display_name = updates.displayName;
    }
    if (updates.location !== undefined) {
      device.location = updates.location;
      dbUpdates.location = updates.location;
    }
    if (updates.deviceType !== undefined) {
      device.deviceType = updates.deviceType;
      dbUpdates.device_type = updates.deviceType;
    }
    if (updates.workHoursStart !== undefined) {
      dbUpdates.work_hours_start = updates.workHoursStart;
    }
    if (updates.workHoursEnd !== undefined) {
      dbUpdates.work_hours_end = updates.workHoursEnd;
    }
    if (updates.needsConfig !== undefined) {
      dbUpdates.needs_config = updates.needsConfig ? 1 : 0;
    }
    
    this.updateDeviceInDatabase(deviceId, dbUpdates);
    this.emit("updated", device);
    
    const name = device.displayName || deviceId;
    console.log(`[DeviceManager] Device config updated: ${name} (${deviceId})`);
    return true;
  }
  
  /**
   * Mark device as registered with Cloud
   */
  markCloudRegistered(deviceId: string): void {
    this.updateDeviceInDatabase(deviceId, {
      cloud_registered: 1,
      cloud_registered_at: nowISO(),
    });
    console.log(`[DeviceManager] Device marked as Cloud registered: ${deviceId}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // ALIASES FOR TEST COMPATIBILITY
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Alias for disconnectDevice (for test compatibility)
   */
  handleDisconnect(socketId: string, reason: string): DeviceRuntimeState | null {
    return this.disconnectDevice(socketId, reason);
  }

  /**
   * Alias for getDeviceBySocketId (for test compatibility)
   */
  getDeviceBySocket(socketId: string): DeviceRuntimeState | null {
    return this.getDeviceBySocketId(socketId);
  }

  /**
   * Alias for updateDeviceConfig (for test compatibility)
   */
  updateDeviceInfo(deviceId: string, updates: Partial<{
    displayName: string | null;
    location: string | null;
    deviceType: DeviceType;
  }>): boolean {
    return this.updateDeviceConfig(deviceId, updates);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════════════════

/** Global DeviceManager instance */
let deviceManagerInstance: DeviceManager | null = null;

/**
 * Get the global DeviceManager instance
 */
export function getDeviceManager(): DeviceManager {
  if (!deviceManagerInstance) {
    deviceManagerInstance = new DeviceManager();
  }
  return deviceManagerInstance;
}

/**
 * Initialize the global DeviceManager
 */
export function initDeviceManager(siteId: string | null = null): DeviceManager {
  const manager = getDeviceManager();
  manager.initialize(siteId);
  return manager;
}

export default {
  DeviceManager,
  getDeviceManager,
  initDeviceManager,
};
