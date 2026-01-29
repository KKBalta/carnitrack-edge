/**
 * Comprehensive tests for Offline Batch Manager
 * 
 * Tests batch creation, event counting, reconciliation status,
 * and batch lifecycle management.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initOfflineBatchManager, destroyOfflineBatchManager, getOfflineBatchManager } from "../src/cloud/offline-batch-manager.ts";
import { initDatabase, closeDatabase, getDatabase, toSqliteDate } from "../src/storage/database.ts";
import { initDeviceManager } from "../src/devices/device-manager.ts";
import type { OfflineBatch } from "../src/types/index.ts";

describe("Offline Batch Manager", () => {
  beforeEach(() => {
    initDatabase();
    initDeviceManager();
    initOfflineBatchManager();
    
    const db = getDatabase();
    // Clean up test data (delete in order to respect foreign keys)
    db.prepare(`DELETE FROM events`).run();
    db.prepare(`DELETE FROM offline_batches`).run();
    db.prepare(`DELETE FROM active_sessions_cache`).run();
    db.prepare(`DELETE FROM devices`).run();
    
    // Create test device
    db.prepare(`
      INSERT INTO devices (device_id, status, tcp_connected)
      VALUES ('SCALE-01', 'online', 1)
    `).run();
  });

  afterEach(() => {
    destroyOfflineBatchManager();
    // DeviceManager doesn't have a destroy function
    closeDatabase();
  });

  describe("startBatch", () => {
    it("should create a new offline batch", () => {
      const manager = getOfflineBatchManager();
      
      const batch = manager.startBatch("SCALE-01");
      
      expect(batch).not.toBeNull();
      expect(batch.id).toBeTruthy();
      expect(batch.deviceId).toBe("SCALE-01");
      expect(batch.startedAt).toBeInstanceOf(Date);
      expect(batch.endedAt).toBeNull();
      expect(batch.eventCount).toBe(0);
      expect(batch.totalWeightGrams).toBe(0);
      expect(batch.reconciliationStatus).toBe("pending");
      
      // Verify stored in database
      const db = getDatabase();
      const stored = db.prepare(`SELECT * FROM offline_batches WHERE id = ?`).get(batch.id) as any;
      expect(stored).not.toBeNull();
      expect(stored.device_id).toBe("SCALE-01");
    });

    it("should emit batch:started event", () => {
      const manager = getOfflineBatchManager();
      let eventReceived = false;
      let receivedBatch: OfflineBatch | null = null;
      
      manager.on("batch:started", (batch) => {
        eventReceived = true;
        receivedBatch = batch;
      });
      
      const batch = manager.startBatch("SCALE-01");
      
      expect(eventReceived).toBe(true);
      expect(receivedBatch?.id).toBe(batch.id);
    });

    it("should handle multiple batches for different devices", () => {
      const manager = getOfflineBatchManager();
      const db = getDatabase();
      
      // Create second device
      db.prepare(`INSERT INTO devices (device_id, status, tcp_connected) VALUES ('SCALE-02', 'online', 1)`).run();
      
      const batch1 = manager.startBatch("SCALE-01");
      const batch2 = manager.startBatch("SCALE-02");
      
      expect(batch1.deviceId).toBe("SCALE-01");
      expect(batch2.deviceId).toBe("SCALE-02");
      expect(batch1.id).not.toBe(batch2.id);
    });
  });

  describe("getCurrentBatch", () => {
    it("should return current active batch", () => {
      const manager = getOfflineBatchManager();
      
      const batch = manager.startBatch("SCALE-01");
      const current = manager.getCurrentBatch();
      
      expect(current).not.toBeNull();
      expect(current?.id).toBe(batch.id);
    });

    it("should return null when no active batch", () => {
      const manager = getOfflineBatchManager();
      
      const current = manager.getCurrentBatch();
      expect(current).toBeNull();
    });
  });

  describe("incrementEventCount", () => {
    it("should increment event count and total weight", () => {
      const manager = getOfflineBatchManager();
      
      const batch = manager.startBatch("SCALE-01");
      expect(batch.eventCount).toBe(0);
      expect(batch.totalWeightGrams).toBe(0);
      
      manager.incrementEventCount(batch.id, 2500);
      manager.incrementEventCount(batch.id, 1800);
      
      const updated = manager.getBatchById(batch.id);
      expect(updated?.eventCount).toBe(2);
      expect(updated?.totalWeightGrams).toBe(4300);
    });

    it("should update database when incrementing", () => {
      const manager = getOfflineBatchManager();
      const db = getDatabase();
      
      const batch = manager.startBatch("SCALE-01");
      manager.incrementEventCount(batch.id, 2500);
      
      const stored = db.prepare(`SELECT event_count, total_weight_grams FROM offline_batches WHERE id = ?`).get(batch.id) as any;
      expect(stored.event_count).toBe(1);
      expect(stored.total_weight_grams).toBe(2500);
    });
  });

  describe("endBatch", () => {
    it("should end an active batch", () => {
      const manager = getOfflineBatchManager();
      
      const batch = manager.startBatch("SCALE-01");
      manager.incrementEventCount(batch.id, 2500);
      
      const ended = manager.endBatch(batch.id);
      
      expect(ended).not.toBeNull();
      expect(ended?.endedAt).not.toBeNull();
      expect(ended?.eventCount).toBe(1);
      
      // Current batch should be null after ending
      expect(manager.getCurrentBatch()).toBeNull();
    });

    it("should emit batch:ended event", () => {
      const manager = getOfflineBatchManager();
      let eventReceived = false;
      let receivedBatch: OfflineBatch | null = null;
      
      manager.on("batch:ended", (batch) => {
        eventReceived = true;
        receivedBatch = batch;
      });
      
      const batch = manager.startBatch("SCALE-01");
      manager.endBatch(batch.id);
      
      expect(eventReceived).toBe(true);
      expect(receivedBatch?.id).toBe(batch.id);
    });

    it("should return null for non-existent batch", () => {
      const manager = getOfflineBatchManager();
      
      const result = manager.endBatch("non-existent-id");
      expect(result).toBeNull();
    });
  });

  describe("getBatchById", () => {
    it("should retrieve batch by ID", () => {
      const manager = getOfflineBatchManager();
      
      const batch = manager.startBatch("SCALE-01");
      const retrieved = manager.getBatchById(batch.id);
      
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(batch.id);
      expect(retrieved?.deviceId).toBe("SCALE-01");
    });

    it("should return null for non-existent batch", () => {
      const manager = getOfflineBatchManager();
      
      const retrieved = manager.getBatchById("non-existent-id");
      expect(retrieved).toBeNull();
    });
  });

  describe("getPendingBatches", () => {
    it("should return all pending batches", () => {
      const manager = getOfflineBatchManager();
      
      const batch1 = manager.startBatch("SCALE-01");
      manager.incrementEventCount(batch1.id, 2500);
      manager.endBatch(batch1.id);
      
      const batch2 = manager.startBatch("SCALE-01");
      manager.incrementEventCount(batch2.id, 1800);
      manager.endBatch(batch2.id);
      
      const pending = manager.getPendingBatches();
      
      expect(pending.length).toBe(2);
      expect(pending.every(b => b.reconciliationStatus === "pending")).toBe(true);
    });

    it("should return empty array when no pending batches", () => {
      const manager = getOfflineBatchManager();
      
      const pending = manager.getPendingBatches();
      expect(pending.length).toBe(0);
    });
  });

  describe("updateReconciliationStatus", () => {
    it("should update batch reconciliation status", () => {
      const manager = getOfflineBatchManager();
      
      const batch = manager.startBatch("SCALE-01");
      manager.endBatch(batch.id);
      
      manager.updateReconciliationStatus(batch.id, "reconciled", {
        cloudSessionId: "session-123",
        reconciledBy: "operator-456",
        notes: "Manually reconciled",
      });
      
      const updated = manager.getBatchById(batch.id);
      expect(updated?.reconciliationStatus).toBe("reconciled");
      expect(updated?.cloudSessionId).toBe("session-123");
      expect(updated?.reconciledBy).toBe("operator-456");
      expect(updated?.notes).toBe("Manually reconciled");
      expect(updated?.reconciledAt).not.toBeNull();
    });

    it("should handle in_progress status", () => {
      const manager = getOfflineBatchManager();
      
      const batch = manager.startBatch("SCALE-01");
      manager.endBatch(batch.id);
      
      manager.updateReconciliationStatus(batch.id, "in_progress");
      
      const updated = manager.getBatchById(batch.id);
      expect(updated?.reconciliationStatus).toBe("in_progress");
    });
  });

  describe("loadActiveBatch", () => {
    it("should load active batch from database on initialization", () => {
      const manager = getOfflineBatchManager();
      const db = getDatabase();
      
      // Create an active batch directly in database
      const batchId = "test-batch-123";
      db.prepare(`
        INSERT INTO offline_batches (id, device_id, started_at, event_count, total_weight_grams, reconciliation_status)
        VALUES (?, ?, ?, 0, 0, 'pending')
      `).run(batchId, "SCALE-01", toSqliteDate(new Date()));
      
      // Create new manager instance (simulates restart)
      destroyOfflineBatchManager();
      initOfflineBatchManager();
      
      const newManager = getOfflineBatchManager();
      const current = newManager.getCurrentBatch();
      
      // Should load the active batch
      expect(current).not.toBeNull();
    });
  });

  describe("getBatchesByDevice", () => {
    it("should return batches for a specific device", () => {
      const manager = getOfflineBatchManager();
      const db = getDatabase();
      
      // Create second device
      db.prepare(`INSERT INTO devices (device_id, status, tcp_connected) VALUES ('SCALE-02', 'online', 1)`).run();
      
      const batch1 = manager.startBatch("SCALE-01");
      manager.endBatch(batch1.id);
      
      const batch2 = manager.startBatch("SCALE-02");
      manager.endBatch(batch2.id);
      
      const batches = manager.getBatchesByDevice("SCALE-01");
      
      expect(batches.length).toBe(1);
      expect(batches[0].deviceId).toBe("SCALE-01");
    });
  });
});
