/**
 * Comprehensive tests for Event Processor
 * 
 * Tests event capture, session tagging, offline batch handling,
 * and database persistence.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { initEventProcessor, destroyEventProcessor, getEventProcessor } from "../src/devices/event-processor.ts";
import { initDatabase, closeDatabase, getDatabase, toSqliteDate } from "../src/storage/database.ts";
import { initDeviceManager } from "../src/devices/device-manager.ts";
import { initSessionCacheManager, destroySessionCacheManager } from "../src/sessions/session-cache.ts";
import { initOfflineBatchManager, destroyOfflineBatchManager } from "../src/cloud/offline-batch-manager.ts";
import { initRestClient, destroyRestClient, getRestClient } from "../src/cloud/index.ts";
import type { WeighingEvent, SessionCache } from "../src/types/index.ts";
import type { WeighingEventData } from "../src/devices/scale-parser.ts";

describe("Event Processor", () => {
  beforeEach(() => {
    // Initialize all dependencies
    initDatabase();
    initDeviceManager();
    initSessionCacheManager();
    initOfflineBatchManager();
    initRestClient({ autoStart: false, queueWhenOffline: true });
    initEventProcessor();
    
    const db = getDatabase();
    // Clean up test data
    db.prepare(`DELETE FROM events`).run();
    db.prepare(`DELETE FROM active_sessions_cache`).run();
    db.prepare(`DELETE FROM offline_batches`).run();
    db.prepare(`DELETE FROM devices`).run();
    
    // Create test devices
    db.prepare(`
      INSERT INTO devices (device_id, status, tcp_connected)
      VALUES ('SCALE-01', 'online', 1), ('SCALE-02', 'online', 1)
    `).run();
  });

  afterEach(() => {
    // Cleanup
    destroyEventProcessor();
    destroyOfflineBatchManager();
    destroySessionCacheManager();
    destroyRestClient();
    // DeviceManager doesn't have a destroy function
    closeDatabase();
  });

  describe("processWeighingEvent", () => {
    it("should process and store a weighing event", () => {
      const processor = getEventProcessor();
      const db = getDatabase();
      const restClient = getRestClient();
      
      // Mock REST client as online to prevent offline mode
      const originalIsOnline = restClient!.isOnline.bind(restClient);
      restClient!.isOnline = mock(() => true);
      
      const eventData: WeighingEventData = {
        pluCode: "00001",
        productName: "KIYMA",
        weightGrams: 2500,
        barcode: "2000001025004",
        timestamp: new Date("2026-01-30T10:30:00Z"),
        time: "10:30:00",
        date: "30.01.2026",
        code: "000",
        operator: "MEHMET",
        value1: "0000015000",
        value2: "0000037500",
        flags: [],
        company: "TEST COMPANY",
        rawData: "00001,10:30:00,30.01.2026,KIYMA,2000001025004,000,MEHMET,0000025000,0000015000,0000037500",
      };

      const event = processor.processWeighingEvent(eventData, "SCALE-01", "192.168.1.100");

      expect(event).not.toBeNull();
      expect(event.id).toBeTruthy();
      expect(event.deviceId).toBe("SCALE-01");
      expect(event.pluCode).toBe("00001");
      expect(event.productName).toBe("KIYMA");
      expect(event.weightGrams).toBe(2500);
      expect(event.barcode).toBe("2000001025004");
      expect(event.syncStatus).toBe("pending");
      expect(event.offlineMode).toBe(false);
      expect(event.offlineBatchId).toBeNull();

      // Verify stored in database
      const stored = db.prepare(`
        SELECT * FROM events WHERE id = ?
      `).get(event.id) as any;
      
      expect(stored).not.toBeNull();
      expect(stored.device_id).toBe("SCALE-01");
      expect(stored.plu_code).toBe("00001");
      expect(stored.weight_grams).toBe(2500);
      
      // Restore original method
      restClient!.isOnline = originalIsOnline;
    });

    it("should tag event with active session when available", () => {
      const processor = getEventProcessor();
      const sessionCache = require("../src/sessions/session-cache.ts").getSessionCacheManager();
      const restClient = getRestClient();
      
      // Mock REST client as online to prevent offline mode
      const originalIsOnline = restClient!.isOnline.bind(restClient);
      restClient!.isOnline = mock(() => true);
      
      // Create active session
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
      
      sessionCache.handleSessionStart(session);

      const eventData: WeighingEventData = {
        pluCode: "00001",
        productName: "KIYMA",
        weightGrams: 2500,
        barcode: "2000001025004",
        timestamp: new Date(),
        time: "10:30:00",
        date: "30.01.2026",
        code: "000",
        operator: "MEHMET",
        value1: "0000015000",
        value2: "0000037500",
        flags: [],
        company: "TEST COMPANY",
        rawData: "test",
      };

      const event = processor.processWeighingEvent(eventData, "SCALE-01");

      expect(event.cloudSessionId).toBe("session-123");
      expect(event.offlineMode).toBe(false);
      
      // Restore original method
      restClient!.isOnline = originalIsOnline;
    });

    it("should create offline batch when cloud is disconnected", () => {
      const processor = getEventProcessor();
      const restClient = getRestClient();
      
      // Mock REST client to return offline status
      const originalIsOnline = restClient!.isOnline.bind(restClient);
      restClient!.isOnline = mock(() => false);

      const eventData: WeighingEventData = {
        pluCode: "00001",
        productName: "KIYMA",
        weightGrams: 2500,
        barcode: "2000001025004",
        timestamp: new Date(),
        time: "10:30:00",
        date: "30.01.2026",
        code: "000",
        operator: "MEHMET",
        value1: "0000015000",
        value2: "0000037500",
        flags: [],
        company: "TEST COMPANY",
        rawData: "test",
      };

      const event = processor.processWeighingEvent(eventData, "SCALE-01");

      expect(event.offlineMode).toBe(true);
      expect(event.offlineBatchId).not.toBeNull();
      expect(event.cloudSessionId).toBeNull();

      // Restore original method
      restClient!.isOnline = originalIsOnline;
    });

    it("should prevent duplicate events", () => {
      const processor = getEventProcessor();
      const db = getDatabase();
      
      const eventData: WeighingEventData = {
        pluCode: "00001",
        productName: "KIYMA",
        weightGrams: 2500,
        barcode: "2000001025004",
        timestamp: new Date("2026-01-30T10:30:00Z"),
        time: "10:30:00",
        date: "30.01.2026",
        code: "000",
        operator: "MEHMET",
        value1: "0000015000",
        value2: "0000037500",
        flags: [],
        company: "TEST COMPANY",
        rawData: "test",
      };

      // Process first event
      const event1 = processor.processWeighingEvent(eventData, "SCALE-01");
      
      // Try to process duplicate
      expect(() => {
        processor.processWeighingEvent(eventData, "SCALE-01");
      }).toThrow();

      // Verify only one event stored
      const count = db.prepare(`
        SELECT COUNT(*) as count FROM events WHERE device_id = ? AND plu_code = ? AND weight_grams = ?
      `).get("SCALE-01", "00001", 2500) as { count: number };
      
      expect(count.count).toBe(1);
    });
  });

  describe("event system", () => {
    it("should emit event:captured event when event is processed", () => {
      const processor = getEventProcessor();
      let eventReceived = false;
      let receivedEvent: WeighingEvent | null = null;

      processor.on("event:captured", (event) => {
        eventReceived = true;
        receivedEvent = event;
      });

      const eventData: WeighingEventData = {
        pluCode: "00001",
        productName: "KIYMA",
        weightGrams: 2500,
        barcode: "2000001025004",
        timestamp: new Date(),
        time: "10:30:00",
        date: "30.01.2026",
        code: "000",
        operator: "MEHMET",
        value1: "0000015000",
        value2: "0000037500",
        flags: [],
        company: "TEST COMPANY",
        rawData: "test",
      };

      processor.processWeighingEvent(eventData, "SCALE-01");

      expect(eventReceived).toBe(true);
      expect(receivedEvent).not.toBeNull();
      expect(receivedEvent?.pluCode).toBe("00001");
    });
  });

  describe("getEvent", () => {
    it("should retrieve event by ID", () => {
      const processor = getEventProcessor();
      
      const eventData: WeighingEventData = {
        pluCode: "00001",
        productName: "KIYMA",
        weightGrams: 2500,
        barcode: "2000001025004",
        timestamp: new Date(),
        time: "10:30:00",
        date: "30.01.2026",
        code: "000",
        operator: "MEHMET",
        value1: "0000015000",
        value2: "0000037500",
        flags: [],
        company: "TEST COMPANY",
        rawData: "test",
      };

      const created = processor.processWeighingEvent(eventData, "SCALE-01");
      const retrieved = processor.getEvent(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.pluCode).toBe("00001");
    });

    it("should return null for non-existent event", () => {
      const processor = getEventProcessor();
      const retrieved = processor.getEvent("non-existent-id");
      expect(retrieved).toBeNull();
    });
  });

  describe("getEventsByDevice", () => {
    it("should retrieve events for a specific device", () => {
      const processor = getEventProcessor();
      
      const eventData1: WeighingEventData = {
        pluCode: "00001",
        productName: "KIYMA",
        weightGrams: 2500,
        barcode: "2000001025004",
        timestamp: new Date(),
        time: "10:30:00",
        date: "30.01.2026",
        code: "000",
        operator: "MEHMET",
        value1: "0000015000",
        value2: "0000037500",
        flags: [],
        company: "TEST COMPANY",
        rawData: "test1",
      };

      const eventData2: WeighingEventData = {
        pluCode: "00002",
        productName: "KUŞBAŞI",
        weightGrams: 1800,
        barcode: "2000002018004",
        timestamp: new Date(),
        time: "10:31:00",
        date: "30.01.2026",
        code: "000",
        operator: "MEHMET",
        value1: "0000015000",
        value2: "0000027000",
        flags: [],
        company: "TEST COMPANY",
        rawData: "test2",
      };

      processor.processWeighingEvent(eventData1, "SCALE-01");
      processor.processWeighingEvent(eventData2, "SCALE-01");
      processor.processWeighingEvent(eventData1, "SCALE-02"); // Different device

      const events = processor.getEventsByDevice("SCALE-01", 10);

      expect(events.length).toBe(2);
      expect(events.every(e => e.deviceId === "SCALE-01")).toBe(true);
    });
  });

  describe("updateEventSyncStatus", () => {
    it("should update event sync status", () => {
      const processor = getEventProcessor();
      
      const eventData: WeighingEventData = {
        pluCode: "00001",
        productName: "KIYMA",
        weightGrams: 2500,
        barcode: "2000001025004",
        timestamp: new Date(),
        time: "10:30:00",
        date: "30.01.2026",
        code: "000",
        operator: "MEHMET",
        value1: "0000015000",
        value2: "0000037500",
        flags: [],
        company: "TEST COMPANY",
        rawData: "test",
      };

      const event = processor.processWeighingEvent(eventData, "SCALE-01");
      expect(event.syncStatus).toBe("pending");

      processor.updateEventSyncStatus(event.id, "synced", "cloud-event-123");

      const updated = processor.getEvent(event.id);
      expect(updated?.syncStatus).toBe("synced");
      expect(updated?.cloudId).toBe("cloud-event-123");
      expect(updated?.syncedAt).not.toBeNull();
    });

    it("should handle sync failure", () => {
      const processor = getEventProcessor();
      
      const eventData: WeighingEventData = {
        pluCode: "00001",
        productName: "KIYMA",
        weightGrams: 2500,
        barcode: "2000001025004",
        timestamp: new Date(),
        time: "10:30:00",
        date: "30.01.2026",
        code: "000",
        operator: "MEHMET",
        value1: "0000015000",
        value2: "0000037500",
        flags: [],
        company: "TEST COMPANY",
        rawData: "test",
      };

      const event = processor.processWeighingEvent(eventData, "SCALE-01");

      processor.updateEventSyncStatus(event.id, "failed", null, "Network error");

      const updated = processor.getEvent(event.id);
      expect(updated?.syncStatus).toBe("failed");
      expect(updated?.lastSyncError).toBe("Network error");
      expect(updated?.syncAttempts).toBeGreaterThan(0);
    });
  });
});
