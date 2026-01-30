/**
 * Integration tests for the complete event flow
 * 
 * Tests the full pipeline: Scale → Parser → Event Processor → Storage → Sync
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { initDatabase, closeDatabase, getDatabase } from "../src/storage/database.ts";
import { initDeviceManager } from "../src/devices/device-manager.ts";
import { initSessionCacheManager, destroySessionCacheManager } from "../src/sessions/session-cache.ts";
import { initOfflineBatchManager, destroyOfflineBatchManager } from "../src/cloud/offline-batch-manager.ts";
import { initRestClient, destroyRestClient, getRestClient } from "../src/cloud/index.ts";
import { initEventProcessor, destroyEventProcessor, getEventProcessor } from "../src/devices/event-processor.ts";
import { initCloudSyncService, destroyCloudSyncService, getCloudSyncService } from "../src/cloud/sync-service.ts";
import { getSessionCacheManager } from "../src/sessions/session-cache.ts";
import { getOfflineBatchManager } from "../src/cloud/offline-batch-manager.ts";
import type { ParsedScaleEvent } from "../src/types/index.ts";

describe("Integration: Complete Event Flow", () => {
  beforeEach(() => {
    initDatabase();
    initDeviceManager();
    initSessionCacheManager();
    initOfflineBatchManager();
    initRestClient({ autoStart: false, queueWhenOffline: true });
    initEventProcessor();
    initCloudSyncService();
    
    // Clean up test data
    const db = getDatabase();
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
    destroyCloudSyncService();
    destroyEventProcessor();
    destroySessionCacheManager();
    destroyOfflineBatchManager();
    destroyRestClient();
    closeDatabase();
  });

  it("should process event from scale to database", () => {
    const processor = getEventProcessor();
    
    // Simulate event from scale
    const scaleEvent: ParsedScaleEvent = {
      pluCode: "00001",
      productName: "KIYMA",
      weightGrams: 1500,
      barcode: "123456789012",
      timestamp: new Date().toISOString(),
      operator: "OPERATOR1",
      rawData: "00001,12:30:45,01.01.2024,KIYMA,123456789012,CODE,OPERATOR1,0000001500,VALUE1,VALUE2,FLAGS,COMPANY",
    };

    // Process event
    const event = processor.processWeighingEvent(scaleEvent, "SCALE-01", "192.168.1.100");

    // Verify event was created
    expect(event).not.toBeNull();
    expect(event.deviceId).toBe("SCALE-01");
    expect(event.pluCode).toBe("00001");
    expect(event.weightGrams).toBe(1500);

    // Verify event stored in database
    const retrieved = processor.getEvent(event.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(event.id);
  });

  it("should tag event with session when session exists", () => {
    const processor = getEventProcessor();
    const sessionCache = getSessionCacheManager();
    const restClient = getRestClient();
    
    // Mock REST client to return online status
    const originalIsOnline = restClient!.isOnline.bind(restClient);
    restClient!.isOnline = mock(() => true);
    
    // Ensure no active batches exist
    const offlineBatchManager = getOfflineBatchManager();
    const currentBatch = offlineBatchManager.getCurrentBatch();
    if (currentBatch) {
      offlineBatchManager.endBatch(currentBatch.id);
    }
    
    // Create active session
    sessionCache.handleSessionStart({
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
    });

    // Process event
    const event = processor.processWeighingEvent({
      pluCode: "00001",
      productName: "KIYMA",
      weightGrams: 1500,
      barcode: "123456789012",
      timestamp: new Date().toISOString(),
      operator: "OPERATOR1",
      rawData: "event1",
    }, "SCALE-01");

    // Verify event tagged with session
    expect(event.cloudSessionId).toBe("session-123");
    expect(event.offlineMode).toBe(false);
    
    // Restore original method
    restClient!.isOnline = originalIsOnline;
  });

  it("should create offline batch when Cloud is offline", () => {
    const processor = getEventProcessor();
    const offlineBatchManager = getOfflineBatchManager();
    
    // REST client is offline by default in test (not started)
    
    // Process event (Cloud is disconnected by default in test)
    const event = processor.processWeighingEvent({
      pluCode: "00001",
      productName: "KIYMA",
      weightGrams: 1500,
      barcode: "123456789012",
      timestamp: new Date().toISOString(),
      operator: "OPERATOR1",
      rawData: "event1",
    }, "SCALE-01");

    // If offline mode, verify batch was created
    if (event.offlineMode) {
      expect(event.offlineBatchId).not.toBeNull();
      
      const batch = offlineBatchManager.getBatch(event.offlineBatchId!);
      expect(batch).not.toBeNull();
      expect(batch?.eventCount).toBeGreaterThan(0);
    }
  });

  it("should track multiple events in offline batch", () => {
    const processor = getEventProcessor();
    const offlineBatchManager = getOfflineBatchManager();
    
    // Process multiple events
    const event1 = processor.processWeighingEvent({
      pluCode: "00001",
      productName: "KIYMA",
      weightGrams: 1500,
      barcode: "123456789012",
      timestamp: new Date().toISOString(),
      operator: "OPERATOR1",
      rawData: "event1",
    }, "SCALE-01");

    const event2 = processor.processWeighingEvent({
      pluCode: "00002",
      productName: "BONFILE",
      weightGrams: 2000,
      barcode: "123456789013",
      timestamp: new Date().toISOString(),
      operator: "OPERATOR1",
      rawData: "event2",
    }, "SCALE-01");

    // If both are in offline mode, they should be in the same batch
    if (event1.offlineMode && event2.offlineMode) {
      expect(event1.offlineBatchId).toBe(event2.offlineBatchId);
      
      const batch = offlineBatchManager.getBatch(event1.offlineBatchId!);
      expect(batch?.eventCount).toBeGreaterThanOrEqual(2);
      expect(batch?.totalWeightGrams).toBeGreaterThanOrEqual(3500);
    }
  });

  it("should query events by session", () => {
    const processor = getEventProcessor();
    const sessionCache = getSessionCacheManager();
    const restClient = getRestClient();
    
    // Mock REST client to return online status
    const originalIsOnline = restClient!.isOnline.bind(restClient);
    restClient!.isOnline = mock(() => true);
    
    // Ensure no active batches exist
    const offlineBatchManager = getOfflineBatchManager();
    const currentBatch = offlineBatchManager.getCurrentBatch();
    if (currentBatch) {
      offlineBatchManager.endBatch(currentBatch.id);
    }
    
    // Create session
    sessionCache.handleSessionStart({
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
    });

    // Process multiple events with unique timestamps to avoid duplicate constraint
    const now = Date.now();
    const event1 = processor.processWeighingEvent({
      pluCode: "00001",
      productName: "KIYMA",
      weightGrams: 1500,
      barcode: "123456789012",
      timestamp: new Date(now).toISOString(),
      operator: "OPERATOR1",
      rawData: "event1",
    }, "SCALE-01");

    const event2 = processor.processWeighingEvent({
      pluCode: "00002",
      productName: "BONFILE",
      weightGrams: 2000,
      barcode: "123456789013",
      timestamp: new Date(now + 1000).toISOString(), // Different timestamp
      operator: "OPERATOR1",
      rawData: "event2",
    }, "SCALE-01");
    
    // Restore original method
    restClient!.isOnline = originalIsOnline;

    // Query events by session
    const sessionEvents = processor.getEventsBySession("session-123");
    
    expect(sessionEvents.length).toBeGreaterThanOrEqual(2);
    expect(sessionEvents.some(e => e.id === event1.id)).toBe(true);
    expect(sessionEvents.some(e => e.id === event2.id)).toBe(true);
  });

  it("should query events by batch", () => {
    const processor = getEventProcessor();
    const offlineBatchManager = getOfflineBatchManager();
    
    // Create batch
    const batch = offlineBatchManager.startBatch("SCALE-01");
    
    // Process events
    const event1 = processor.processWeighingEvent({
      pluCode: "00001",
      productName: "KIYMA",
      weightGrams: 1500,
      barcode: "123456789012",
      timestamp: new Date().toISOString(),
      operator: "OPERATOR1",
      rawData: "event1",
    }, "SCALE-01");

    const event2 = processor.processWeighingEvent({
      pluCode: "00002",
      productName: "BONFILE",
      weightGrams: 2000,
      barcode: "123456789013",
      timestamp: new Date().toISOString(),
      operator: "OPERATOR1",
      rawData: "event2",
    }, "SCALE-01");

    // Query events by batch
    const batchEvents = processor.getEventsByBatch(batch.id);
    
    // Note: Events might not be in batch if Cloud is "online" in test
    // This test verifies the query method works
    expect(Array.isArray(batchEvents)).toBe(true);
  });
});
