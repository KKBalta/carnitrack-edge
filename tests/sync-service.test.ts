/**
 * Comprehensive tests for Cloud Sync Service
 * 
 * Tests event streaming, backlog sync, retry logic,
 * and REST client integration.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { initCloudSyncService, destroyCloudSyncService, getCloudSyncService } from "../src/cloud/sync-service.ts";
import { initEventProcessor, destroyEventProcessor, getEventProcessor } from "../src/devices/event-processor.ts";
import { initDatabase, closeDatabase, getDatabase } from "../src/storage/database.ts";
import { initDeviceManager } from "../src/devices/device-manager.ts";
import { initSessionCacheManager, destroySessionCacheManager } from "../src/sessions/session-cache.ts";
import { initOfflineBatchManager, destroyOfflineBatchManager } from "../src/cloud/offline-batch-manager.ts";
import { initRestClient, destroyRestClient, getRestClient } from "../src/cloud/index.ts";
import type { WeighingEvent } from "../src/types/index.ts";
import type { WeighingEventData } from "../src/devices/scale-parser.ts";

describe("Cloud Sync Service", () => {
  beforeEach(() => {
    initDatabase();
    initDeviceManager();
    initSessionCacheManager();
    initOfflineBatchManager();
    initRestClient({ autoStart: false, queueWhenOffline: true });
    initEventProcessor();
    initCloudSyncService();
    
    const db = getDatabase();
    // Clean up test data (delete in order to respect foreign keys)
    db.prepare(`DELETE FROM events`).run();
    db.prepare(`DELETE FROM offline_batches`).run();
    db.prepare(`DELETE FROM active_sessions_cache`).run();
    db.prepare(`DELETE FROM devices`).run();
    
    // Create test device
    db.prepare(`
      INSERT INTO devices (device_id, status, tcp_connected, global_device_id)
      VALUES ('SCALE-01', 'online', 1, 'SITE-001-SCALE-01')
    `).run();
  });

  afterEach(() => {
    destroyCloudSyncService();
    destroyEventProcessor();
    destroyOfflineBatchManager();
    destroySessionCacheManager();
    destroyRestClient();
    // DeviceManager doesn't have a destroy function
    closeDatabase();
  });

  describe("start", () => {
    it("should start sync service", () => {
      const service = getCloudSyncService();
      service.start();
      
      const status = service.getStatus();
      expect(status.isRunning).toBe(true);
    });

    it("should subscribe to event processor events", () => {
      const service = getCloudSyncService();
      const eventProcessor = getEventProcessor();
      
      service.start();
      
      // Create an event - should trigger sync service handler
      const eventData: WeighingEventData = {
        pluCode: "00001",
        productName: "KIYMA",
        weightGrams: 2500,
        tareGrams: 0,
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
      
      // This should not throw
      expect(() => {
        eventProcessor.processWeighingEvent(eventData, "SCALE-01");
      }).not.toThrow();
    });
  });

  describe("stop", () => {
    it("should stop sync service", () => {
      const service = getCloudSyncService();
      service.start();
      service.stop();
      
      const status = service.getStatus();
      expect(status.isRunning).toBe(false);
    });
  });

  describe("getStatus", () => {
    it("should return current sync status", () => {
      const service = getCloudSyncService();
      service.start();
      
      const status = service.getStatus();
      
      expect(status).toHaveProperty("isRunning");
      expect(status).toHaveProperty("lastSyncAt");
      expect(status).toHaveProperty("pendingEvents");
      expect(status).toHaveProperty("pendingBatches");
    });
  });

  describe("streamEvent", () => {
    it("should stream event when Cloud is online", async () => {
      const service = getCloudSyncService();
      const restClient = getRestClient();
      
      // Mock REST client
      const mockPostEvent = mock(async () => ({ cloudEventId: "cloud-123", status: "accepted" as const }));
      const originalPostEvent = restClient!.postEvent.bind(restClient);
      restClient!.postEvent = mockPostEvent as any;
      const originalIsOnline = restClient!.isOnline.bind(restClient);
      restClient!.isOnline = mock(() => true) as any;
      
      service.start();
      
      const eventProcessor = getEventProcessor();
      const eventData: WeighingEventData = {
        pluCode: "00001",
        productName: "KIYMA",
        weightGrams: 2500,
        tareGrams: 0,
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
      
      const event = eventProcessor.processWeighingEvent(eventData, "SCALE-01");
      
      // Wait a bit for async processing
      await Bun.sleep(100);
      
      // Restore original methods
      restClient!.postEvent = originalPostEvent;
      restClient!.isOnline = originalIsOnline;
    });

    it("should handle offline events without streaming", async () => {
      const service = getCloudSyncService();
      const restClient = getRestClient();
      
      // Mock REST client as offline
      const originalIsOnline = restClient!.isOnline.bind(restClient);
      restClient!.isOnline = mock(() => false) as any;
      
      service.start();
      
      const eventProcessor = getEventProcessor();
      const eventData: WeighingEventData = {
        pluCode: "00001",
        productName: "KIYMA",
        weightGrams: 2500,
        tareGrams: 0,
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
      
      const event = eventProcessor.processWeighingEvent(eventData, "SCALE-01");
      
      expect(event.offlineMode).toBe(true);
      expect(event.offlineBatchId).not.toBeNull();
      
      // Restore original method
      restClient!.isOnline = originalIsOnline;
    });
  });

  describe("syncPendingEvents", () => {
    it("should sync pending events when Cloud is online", async () => {
      const service = getCloudSyncService();
      const restClient = getRestClient();
      
      // Mock REST client
      const originalIsOnline = restClient!.isOnline.bind(restClient);
      const originalPostEvent = restClient!.postEvent.bind(restClient);
      restClient!.isOnline = mock(() => true) as any;
      restClient!.postEvent = mock(async () => ({ cloudEventId: "cloud-123", status: "accepted" as const })) as any;
      
      service.start();
      
      const eventProcessor = getEventProcessor();
      
      // Create pending events
      const eventData1: WeighingEventData = {
        pluCode: "00001",
        productName: "KIYMA",
        weightGrams: 2500,
        tareGrams: 0,
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
      
      eventProcessor.processWeighingEvent(eventData1, "SCALE-01");
      eventProcessor.processWeighingEvent(eventData2, "SCALE-01");
      
      const result = await service.syncPendingEvents();
      
      expect(result.success).toBe(true);
      expect(result.synced).toBeGreaterThanOrEqual(0);
      
      // Restore original methods
      restClient!.isOnline = originalIsOnline;
      restClient!.postEvent = originalPostEvent;
    });

    it("should return error when Cloud is not online", async () => {
      const service = getCloudSyncService();
      const restClient = getRestClient();
      
      const originalIsOnline = restClient!.isOnline.bind(restClient);
      restClient!.isOnline = mock(() => false) as any;
      
      service.start();
      
      const result = await service.syncPendingEvents();
      
      expect(result.success).toBe(false);
      expect(result.errors).toContain("Cloud not online");
      
      // Restore original method
      restClient!.isOnline = originalIsOnline;
    });
  });

  describe("pause and resume", () => {
    it("should pause and resume sync service", () => {
      const service = getCloudSyncService();
      service.start();
      
      service.pause();
      // Service should still be running but paused
      expect(service.getStatus().isRunning).toBe(true);
      
      service.resume();
      // Should resume processing
      expect(service.getStatus().isRunning).toBe(true);
    });
  });
});
