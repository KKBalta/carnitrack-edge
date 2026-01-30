/**
 * CarniTrack Edge - Session Cache Manager
 * 
 * Caches active sessions pushed from Cloud for event tagging.
 * Sessions are NOT created on Edge - Cloud manages the lifecycle.
 * Edge only caches active sessions for offline reference.
 * 
 * @see GitHub Issue #5
 */

import { getDatabase } from "../storage/database.ts";
import { toSqliteDate, fromSqliteDate } from "../storage/database.ts";
import { config } from "../config.ts";
import type { SessionCache, SessionStatus } from "../types/index.ts";
import type { RestClient } from "../cloud/rest-client.ts";
import type { DeviceManager } from "../devices/device-manager.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Event types emitted by Session Cache Manager */
type SessionCacheEvent = 
  | "session:cached"
  | "session:updated"
  | "session:expired"
  | "session:ended";

/** Event callback signature */
type EventCallback = (session: SessionCache) => void;

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION CACHE MANAGER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class SessionCacheManager {
  private eventListeners: Map<SessionCacheEvent, Set<EventCallback>> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private restClient: RestClient | null = null;
  private deviceManager: DeviceManager | null = null;

  constructor() {
    // Start periodic cleanup of expired sessions
    this.startCleanupTimer();
  }

  /**
   * Set REST client for polling (called from main initialization)
   */
  setRestClient(client: RestClient | null): void {
    this.restClient = client;
  }

  /**
   * Set device manager for getting device IDs (called from main initialization)
   */
  setDeviceManager(manager: DeviceManager | null): void {
    this.deviceManager = manager;
  }

  /**
   * Start polling for active sessions from Cloud
   */
  startPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    this.pollTimer = setInterval(() => {
      this.pollSessions().catch(error => {
        console.error("[SessionCache] Poll error:", error);
      });
    }, config.rest.sessionPollIntervalMs);

    // Poll immediately
    this.pollSessions().catch(error => {
      console.error("[SessionCache] Initial poll error:", error);
    });
  }

  /**
   * Stop polling
   */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Poll Cloud for active sessions and update cache
   */
  private async pollSessions(): Promise<void> {
    if (!this.restClient || !this.deviceManager) {
      return;
    }

    // Get all active device IDs
    const devices = this.deviceManager.getActiveDevices();
    const deviceIds = devices.map(d => d.deviceId);

    if (deviceIds.length === 0) {
      return;
    }

    try {
      const response = await this.restClient.getSessions(deviceIds);
      const cloudSessions = response.sessions || [];

      // Get current cached sessions
      const cachedSessions = this.getAllActiveSessions();
      const cachedSessionMap = new Map(
        cachedSessions.map(s => [s.cloudSessionId, s])
      );

      // Process sessions from Cloud
      const cloudSessionIds = new Set<string>();
      for (const cloudSession of cloudSessions) {
        cloudSessionIds.add(cloudSession.cloudSessionId);

        const cached = cachedSessionMap.get(cloudSession.cloudSessionId);
        
        if (!cached) {
          // New session - cache it
          this.handleSessionStart({
            cloudSessionId: cloudSession.cloudSessionId,
            deviceId: cloudSession.deviceId,
            animalId: cloudSession.animalId ?? null,
            animalTag: cloudSession.animalTag ?? null,
            animalSpecies: cloudSession.animalSpecies ?? null,
            operatorId: cloudSession.operatorId ?? null,
            status: cloudSession.status,
            cachedAt: new Date(),
            lastUpdatedAt: null,
            expiresAt: new Date(),
          });
        } else {
          // Existing session - check for updates
          const needsUpdate = 
            cached.deviceId !== cloudSession.deviceId ||
            cached.animalId !== (cloudSession.animalId ?? null) ||
            cached.animalTag !== (cloudSession.animalTag ?? null) ||
            cached.animalSpecies !== (cloudSession.animalSpecies ?? null) ||
            cached.operatorId !== (cloudSession.operatorId ?? null) ||
            cached.status !== cloudSession.status;

          if (needsUpdate) {
            this.handleSessionUpdate(cloudSession.cloudSessionId, {
              deviceId: cloudSession.deviceId,
              animalId: cloudSession.animalId ?? null,
              animalTag: cloudSession.animalTag ?? null,
              animalSpecies: cloudSession.animalSpecies ?? null,
              operatorId: cloudSession.operatorId ?? null,
              status: cloudSession.status,
            });
          }
        }
      }

      // Remove sessions that are no longer active in Cloud
      for (const cached of cachedSessions) {
        if (!cloudSessionIds.has(cached.cloudSessionId)) {
          this.handleSessionEnd(cached.cloudSessionId, "ended");
        }
      }
    } catch (error) {
      console.error("[SessionCache] Failed to poll sessions:", error);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLOUD PUSH HANDLERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle session start from Cloud
   * Cloud pushes new active session to Edge
   */
  handleSessionStart(session: SessionCache): void {
    const db = getDatabase();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.sessionCache.expiryMs);

    // Insert or update session cache
    db.prepare(`
      INSERT INTO active_sessions_cache (
        cloud_session_id,
        device_id,
        animal_id,
        animal_tag,
        animal_species,
        operator_id,
        status,
        cached_at,
        last_updated_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cloud_session_id) DO UPDATE SET
        device_id = excluded.device_id,
        animal_id = excluded.animal_id,
        animal_tag = excluded.animal_tag,
        animal_species = excluded.animal_species,
        operator_id = excluded.operator_id,
        status = excluded.status,
        last_updated_at = excluded.last_updated_at,
        expires_at = excluded.expires_at
    `).run(
      session.cloudSessionId,
      session.deviceId,
      session.animalId ?? null,
      session.animalTag ?? null,
      session.animalSpecies ?? null,
      session.operatorId ?? null,
      session.status,
      toSqliteDate(now),
      toSqliteDate(now),
      toSqliteDate(expiresAt)
    );

    // Emit event
    this.emit("session:cached", session);
  }

  /**
   * Handle session update from Cloud
   * Cloud updates session metadata (e.g., pause/resume)
   */
  handleSessionUpdate(cloudSessionId: string, changes: Partial<SessionCache>): void {
    const db = getDatabase();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.sessionCache.expiryMs);

    // Build update query dynamically
    const updates: string[] = [];
    const values: unknown[] = [];

    if (changes.deviceId !== undefined) {
      updates.push("device_id = ?");
      values.push(changes.deviceId);
    }
    if (changes.animalId !== undefined) {
      updates.push("animal_id = ?");
      values.push(changes.animalId ?? null);
    }
    if (changes.animalTag !== undefined) {
      updates.push("animal_tag = ?");
      values.push(changes.animalTag ?? null);
    }
    if (changes.animalSpecies !== undefined) {
      updates.push("animal_species = ?");
      values.push(changes.animalSpecies ?? null);
    }
    if (changes.operatorId !== undefined) {
      updates.push("operator_id = ?");
      values.push(changes.operatorId ?? null);
    }
    if (changes.status !== undefined) {
      updates.push("status = ?");
      values.push(changes.status);
    }

    // Always update last_updated_at and expires_at
    updates.push("last_updated_at = ?");
    values.push(toSqliteDate(now));
    updates.push("expires_at = ?");
    values.push(toSqliteDate(expiresAt));

    values.push(cloudSessionId);

    if (updates.length > 2) { // More than just last_updated_at and expires_at
      db.prepare(`
        UPDATE active_sessions_cache
        SET ${updates.join(", ")}
        WHERE cloud_session_id = ?
      `).run(...values);

      // Fetch updated session and emit event
      const updated = this.getSessionById(cloudSessionId);
      if (updated) {
        this.emit("session:updated", updated);
      }
    }
  }

  /**
   * Handle session end from Cloud
   * Cloud notifies Edge that session is complete
   */
  handleSessionEnd(cloudSessionId: string, reason: string): void {
    const db = getDatabase();
    
    // Get session before deleting
    const session = this.getSessionById(cloudSessionId);
    
    // First, unlink any events that reference this session
    // This is necessary because events table has a foreign key constraint
    db.prepare(`
      UPDATE events 
      SET cloud_session_id = NULL 
      WHERE cloud_session_id = ?
    `).run(cloudSessionId);
    
    // Remove from cache
    db.prepare(`
      DELETE FROM active_sessions_cache
      WHERE cloud_session_id = ?
    `).run(cloudSessionId);

    // Emit event
    if (session) {
      this.emit("session:ended", session);
      console.log(`[SessionCache] Session ended: ${cloudSessionId} (${reason})`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // QUERIES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get session by Cloud session ID
   */
  getSessionById(cloudSessionId: string): SessionCache | null {
    const db = getDatabase();
    const row = db.prepare(`
      SELECT 
        cloud_session_id,
        device_id,
        animal_id,
        animal_tag,
        animal_species,
        operator_id,
        status,
        cached_at,
        last_updated_at,
        expires_at
      FROM active_sessions_cache
      WHERE cloud_session_id = ?
    `).get(cloudSessionId) as {
      cloud_session_id: string;
      device_id: string;
      animal_id: string | null;
      animal_tag: string | null;
      animal_species: string | null;
      operator_id: string | null;
      status: SessionStatus;
      cached_at: string;
      last_updated_at: string | null;
      expires_at: string;
    } | undefined;

    if (!row) {
      return null;
    }

    return {
      cloudSessionId: row.cloud_session_id,
      deviceId: row.device_id,
      animalId: row.animal_id ?? null,
      animalTag: row.animal_tag ?? null,
      animalSpecies: row.animal_species ?? null,
      operatorId: row.operator_id ?? null,
      status: row.status,
      cachedAt: fromSqliteDate(row.cached_at)!,
      lastUpdatedAt: fromSqliteDate(row.last_updated_at),
      expiresAt: fromSqliteDate(row.expires_at)!,
    };
  }

  /**
   * Get active session for a specific device
   * Used by Event Processor to tag events with session ID
   */
  getActiveSessionForDevice(deviceId: string): SessionCache | null {
    const db = getDatabase();
    const now = new Date().toISOString();
    
    const row = db.prepare(`
      SELECT 
        cloud_session_id,
        device_id,
        animal_id,
        animal_tag,
        animal_species,
        operator_id,
        status,
        cached_at,
        last_updated_at,
        expires_at
      FROM active_sessions_cache
      WHERE device_id = ?
        AND status = 'active'
        AND expires_at > ?
      ORDER BY cached_at DESC
      LIMIT 1
    `).get(deviceId, now) as {
      cloud_session_id: string;
      device_id: string;
      animal_id: string | null;
      animal_tag: string | null;
      animal_species: string | null;
      operator_id: string | null;
      status: SessionStatus;
      cached_at: string;
      last_updated_at: string | null;
      expires_at: string;
    } | undefined;

    if (!row) {
      return null;
    }

    return {
      cloudSessionId: row.cloud_session_id,
      deviceId: row.device_id,
      animalId: row.animal_id ?? null,
      animalTag: row.animal_tag ?? null,
      animalSpecies: row.animal_species ?? null,
      operatorId: row.operator_id ?? null,
      status: row.status,
      cachedAt: fromSqliteDate(row.cached_at)!,
      lastUpdatedAt: fromSqliteDate(row.last_updated_at),
      expiresAt: fromSqliteDate(row.expires_at)!,
    };
  }

  /**
   * Get all active sessions
   */
  getAllActiveSessions(): SessionCache[] {
    const db = getDatabase();
    const now = new Date().toISOString();
    
    const rows = db.prepare(`
      SELECT 
        cloud_session_id,
        device_id,
        animal_id,
        animal_tag,
        animal_species,
        operator_id,
        status,
        cached_at,
        last_updated_at,
        expires_at
      FROM active_sessions_cache
      WHERE expires_at > ?
      ORDER BY cached_at DESC
    `).all(now) as Array<{
      cloud_session_id: string;
      device_id: string;
      animal_id: string | null;
      animal_tag: string | null;
      animal_species: string | null;
      operator_id: string | null;
      status: SessionStatus;
      cached_at: string;
      last_updated_at: string | null;
      expires_at: string;
    }>;

    return rows.map(row => ({
      cloudSessionId: row.cloud_session_id,
      deviceId: row.device_id,
      animalId: row.animal_id ?? null,
      animalTag: row.animal_tag ?? null,
      animalSpecies: row.animal_species ?? null,
      operatorId: row.operator_id ?? null,
      status: row.status,
      cachedAt: fromSqliteDate(row.cached_at)!,
      lastUpdatedAt: fromSqliteDate(row.last_updated_at),
      expiresAt: fromSqliteDate(row.expires_at)!,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAINTENANCE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Clean expired sessions from cache
   * Returns count of removed sessions
   */
  cleanExpiredSessions(): number {
    const db = getDatabase();
    const now = new Date().toISOString();
    
    // Get expired sessions before deleting (for events)
    const expired = db.prepare(`
      SELECT 
        cloud_session_id,
        device_id,
        animal_id,
        animal_tag,
        animal_species,
        operator_id,
        status,
        cached_at,
        last_updated_at,
        expires_at
      FROM active_sessions_cache
      WHERE expires_at <= ?
    `).all(now) as Array<{
      cloud_session_id: string;
      device_id: string;
      animal_id: string | null;
      animal_tag: string | null;
      animal_species: string | null;
      operator_id: string | null;
      status: SessionStatus;
      cached_at: string;
      last_updated_at: string | null;
      expires_at: string;
    }>;

    // First, unlink any events that reference expired sessions
    // This is necessary because events table has a foreign key constraint
    for (const row of expired) {
      db.prepare(`
        UPDATE events 
        SET cloud_session_id = NULL 
        WHERE cloud_session_id = ?
      `).run(row.cloud_session_id);
    }

    // Delete expired sessions
    const result = db.prepare(`
      DELETE FROM active_sessions_cache
      WHERE expires_at <= ?
    `).run(now);

    // Emit events for expired sessions
    expired.forEach(row => {
      const session: SessionCache = {
        cloudSessionId: row.cloud_session_id,
        deviceId: row.device_id,
        animalId: row.animal_id ?? null,
        animalTag: row.animal_tag ?? null,
        animalSpecies: row.animal_species ?? null,
        operatorId: row.operator_id ?? null,
        status: row.status,
        cachedAt: fromSqliteDate(row.cached_at)!,
        lastUpdatedAt: fromSqliteDate(row.last_updated_at),
        expiresAt: fromSqliteDate(row.expires_at)!,
      };
      this.emit("session:expired", session);
    });

    return result.changes;
  }

  /**
   * Refresh session TTL (extend expiry)
   */
  refreshSessionTTL(cloudSessionId: string, newExpiry: Date): void {
    const db = getDatabase();
    
    db.prepare(`
      UPDATE active_sessions_cache
      SET expires_at = ?
      WHERE cloud_session_id = ?
    `).run(toSqliteDate(newExpiry), cloudSessionId);
  }

  /**
   * Start periodic cleanup timer
   */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = setInterval(() => {
      const removed = this.cleanExpiredSessions();
      if (removed > 0) {
        console.log(`[SessionCache] Cleaned ${removed} expired session(s)`);
      }
    }, config.sessionCache.cleanupIntervalMs);
  }

  /**
   * Stop cleanup timer and polling (for shutdown)
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.stopPolling();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENT SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Subscribe to session cache events
   */
  on(event: SessionCacheEvent, callback: EventCallback): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(callback);
  }

  /**
   * Unsubscribe from session cache events
   */
  off(event: SessionCacheEvent, callback: EventCallback): void {
    this.eventListeners.get(event)?.delete(callback);
  }

  /**
   * Emit event to all listeners
   */
  private emit(event: SessionCacheEvent, session: SessionCache): void {
    this.eventListeners.get(event)?.forEach(callback => {
      try {
        callback(session);
      } catch (error) {
        console.error(`[SessionCache] Error in event listener for ${event}:`, error);
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════════════════

let sessionCacheManager: SessionCacheManager | null = null;

/**
 * Initialize session cache manager
 */
export function initSessionCacheManager(): SessionCacheManager {
  if (!sessionCacheManager) {
    sessionCacheManager = new SessionCacheManager();
    console.log("[SessionCache] Initialized");
  }
  return sessionCacheManager;
}

/**
 * Get session cache manager instance
 */
export function getSessionCacheManager(): SessionCacheManager {
  if (!sessionCacheManager) {
    return initSessionCacheManager();
  }
  return sessionCacheManager;
}

/**
 * Destroy session cache manager (for shutdown)
 */
export function destroySessionCacheManager(): void {
  if (sessionCacheManager) {
    sessionCacheManager.stop();
    sessionCacheManager = null;
    console.log("[SessionCache] Destroyed");
  }
}
