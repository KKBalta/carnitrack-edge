/**
 * Tests for Session Cache Manager
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initSessionCacheManager, destroySessionCacheManager, getSessionCacheManager } from "../src/sessions/session-cache.ts";
import { initDatabase, closeDatabase, getDatabase, toSqliteDate } from "../src/storage/database.ts";
import { initDeviceManager } from "../src/devices/device-manager.ts";
import type { SessionCache } from "../src/types/index.ts";

describe("Session Cache Manager", () => {
  beforeEach(() => {
    // Initialize database
    initDatabase();
    // Initialize device manager (needed for foreign key constraint)
    initDeviceManager();
    const db = getDatabase();
    // Clean up any existing test data (delete in order to respect foreign keys)
    db.prepare(`DELETE FROM events`).run();
    db.prepare(`DELETE FROM offline_batches`).run();
    db.prepare(`DELETE FROM active_sessions_cache`).run();
    db.prepare(`DELETE FROM devices`).run();
    // Create test devices
    db.prepare(`
      INSERT INTO devices (device_id, status, tcp_connected)
      VALUES ('SCALE-01', 'online', 0), ('SCALE-02', 'online', 0), ('SCALE-99', 'online', 0)
    `).run();
    // Initialize session cache manager
    initSessionCacheManager();
  });

  afterEach(() => {
    // Cleanup
    destroySessionCacheManager();
    closeDatabase();
  });

  describe("handleSessionStart", () => {
    it("should cache a new session", () => {
      const manager = getSessionCacheManager();
      
      const session: SessionCache = {
        cloudSessionId: "session-123",
        deviceId: "SCALE-01",
        animalId: "animal-456",
        animalTag: "A-123",
        animalSpecies: "Dana",
        operatorId: "op-789",
        status: "active",
        cachedAt: new Date(),
        lastUpdatedAt: null,
        expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
      };

      manager.handleSessionStart(session);

      const cached = manager.getSessionById("session-123");
      expect(cached).not.toBeNull();
      expect(cached?.cloudSessionId).toBe("session-123");
      expect(cached?.deviceId).toBe("SCALE-01");
      expect(cached?.animalTag).toBe("A-123");
    });

    it("should update existing session if already cached", () => {
      const manager = getSessionCacheManager();
      
      const session1: SessionCache = {
        cloudSessionId: "session-123",
        deviceId: "SCALE-01",
        animalId: "animal-456",
        animalTag: "A-123",
        animalSpecies: "Dana",
        operatorId: "op-789",
        status: "active",
        cachedAt: new Date(),
        lastUpdatedAt: null,
        expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
      };

      manager.handleSessionStart(session1);

      const session2: SessionCache = {
        ...session1,
        animalTag: "A-456", // Updated tag
        status: "paused",
      };

      manager.handleSessionStart(session2);

      const cached = manager.getSessionById("session-123");
      expect(cached?.animalTag).toBe("A-456");
      expect(cached?.status).toBe("paused");
    });
  });

  describe("handleSessionUpdate", () => {
    it("should update session fields", () => {
      const manager = getSessionCacheManager();
      
      const session: SessionCache = {
        cloudSessionId: "session-123",
        deviceId: "SCALE-01",
        animalId: "animal-456",
        animalTag: "A-123",
        animalSpecies: "Dana",
        operatorId: "op-789",
        status: "active",
        cachedAt: new Date(),
        lastUpdatedAt: null,
        expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
      };

      manager.handleSessionStart(session);
      manager.handleSessionUpdate("session-123", { status: "paused" });

      const updated = manager.getSessionById("session-123");
      expect(updated?.status).toBe("paused");
    });
  });

  describe("handleSessionEnd", () => {
    it("should remove session from cache", () => {
      const manager = getSessionCacheManager();
      
      const session: SessionCache = {
        cloudSessionId: "session-123",
        deviceId: "SCALE-01",
        animalId: "animal-456",
        animalTag: "A-123",
        animalSpecies: "Dana",
        operatorId: "op-789",
        status: "active",
        cachedAt: new Date(),
        lastUpdatedAt: null,
        expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
      };

      manager.handleSessionStart(session);
      manager.handleSessionEnd("session-123", "completed");

      const cached = manager.getSessionById("session-123");
      expect(cached).toBeNull();
    });
  });

  describe("getActiveSessionForDevice", () => {
    it("should return active session for device", () => {
      const manager = getSessionCacheManager();
      
      const session: SessionCache = {
        cloudSessionId: "session-123",
        deviceId: "SCALE-01",
        animalId: "animal-456",
        animalTag: "A-123",
        animalSpecies: "Dana",
        operatorId: "op-789",
        status: "active",
        cachedAt: new Date(),
        lastUpdatedAt: null,
        expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
      };

      manager.handleSessionStart(session);

      const active = manager.getActiveSessionForDevice("SCALE-01");
      expect(active).not.toBeNull();
      expect(active?.cloudSessionId).toBe("session-123");
    });

    it("should return null if no active session for device", () => {
      const manager = getSessionCacheManager();
      
      const active = manager.getActiveSessionForDevice("SCALE-99");
      expect(active).toBeNull();
    });

    it("should return null for expired sessions", () => {
      const manager = getSessionCacheManager();
      const db = getDatabase();
      
      // Directly insert an expired session (bypassing handleSessionStart which refreshes expiry)
      const expiredAt = new Date(Date.now() - 1 * 60 * 60 * 1000); // Expired 1 hour ago
      const cachedAt = new Date(Date.now() - 5 * 60 * 60 * 1000); // 5 hours ago
      
      // Delete any existing session first, then insert expired one
      db.prepare(`DELETE FROM active_sessions_cache WHERE cloud_session_id = ?`).run("session-expired-123");
      
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
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "session-expired-123",
        "SCALE-01",
        "animal-456",
        "A-123",
        "Dana",
        "op-789",
        "active",
        toSqliteDate(cachedAt),
        toSqliteDate(expiredAt)
      );

      const active = manager.getActiveSessionForDevice("SCALE-01");
      expect(active).toBeNull();
    });
  });

  describe("cleanExpiredSessions", () => {
    it("should remove expired sessions", () => {
      const manager = getSessionCacheManager();
      const db = getDatabase();
      
      // Directly insert expired session (bypassing handleSessionStart which refreshes expiry)
      const expiredAt = new Date(Date.now() - 1 * 60 * 60 * 1000); // Expired
      const cachedAt = new Date(Date.now() - 5 * 60 * 60 * 1000);
      
      // Delete any existing session first, then insert expired one
      db.prepare(`DELETE FROM active_sessions_cache WHERE cloud_session_id = ?`).run("session-expired");
      
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
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "session-expired",
        "SCALE-01",
        "animal-456",
        "A-123",
        "Dana",
        "op-789",
        "active",
        toSqliteDate(cachedAt),
        toSqliteDate(expiredAt)
      );

      // Create valid session using handleSessionStart
      const validSession: SessionCache = {
        cloudSessionId: "session-valid",
        deviceId: "SCALE-02",
        animalId: "animal-789",
        animalTag: "B-456",
        animalSpecies: "Kuzu",
        operatorId: "op-123",
        status: "active",
        cachedAt: new Date(),
        lastUpdatedAt: null,
        expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000), // Valid
      };

      manager.handleSessionStart(validSession);

      const removed = manager.cleanExpiredSessions();
      expect(removed).toBe(1);

      expect(manager.getSessionById("session-expired")).toBeNull();
      expect(manager.getSessionById("session-valid")).not.toBeNull();
    });
  });

  describe("event system", () => {
    it("should emit session:cached event", () => {
      const manager = getSessionCacheManager();
      let eventReceived = false;
      let receivedSession: SessionCache | null = null;

      manager.on("session:cached", (session) => {
        eventReceived = true;
        receivedSession = session;
      });

      const session: SessionCache = {
        cloudSessionId: "session-123",
        deviceId: "SCALE-01",
        animalId: "animal-456",
        animalTag: "A-123",
        animalSpecies: "Dana",
        operatorId: "op-789",
        status: "active",
        cachedAt: new Date(),
        lastUpdatedAt: null,
        expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
      };

      manager.handleSessionStart(session);

      expect(eventReceived).toBe(true);
      expect(receivedSession?.cloudSessionId).toBe("session-123");
    });
  });
});
