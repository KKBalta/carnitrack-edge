/**
 * CarniTrack Edge - Event Processor
 * 
 * Receives parsed weighing events, tags them with session or offline batch information,
 * and stores them in SQLite.
 * 
 * @see GitHub Issue #6
 */

import { getDatabase } from "../storage/database.ts";
import { toSqliteDate, fromSqliteDate, generateId } from "../storage/database.ts";
import { getSessionCacheManager } from "../sessions/session-cache.ts";
import { getOfflineBatchManager } from "../cloud/offline-batch-manager.ts";
import { getWebSocketClient } from "../cloud/index.ts";
import type { WeighingEvent, ParsedScaleEvent, EventSyncStatus } from "../types/index.ts";
import type { WeighingEventData } from "./scale-parser.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Event types emitted by Event Processor */
type EventProcessorEvent = 
  | "event:captured"
  | "event:synced"
  | "event:failed";

/** Event callback signature */
type EventCallback = (event: WeighingEvent) => void;

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT PROCESSOR CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class EventProcessor {
  private eventListeners: Map<EventProcessorEvent, Set<EventCallback>> = new Map();

  /**
   * Process a weighing event from scale
   * Tags with session/batch and stores in database
   */
  processWeighingEvent(
    eventData: WeighingEventData | ParsedScaleEvent,
    deviceId: string,
    sourceIp: string | null = null
  ): WeighingEvent {
    const db = getDatabase();
    const sessionCache = getSessionCacheManager();
    const offlineBatchManager = getOfflineBatchManager();
    const wsClient = getWebSocketClient();

    // Convert ParsedScaleEvent to WeighingEventData format if needed
    const parsedEvent: ParsedScaleEvent = this.normalizeEventData(eventData);
    
    // Generate event ID
    const eventId = generateId();
    const receivedAt = new Date();
    const scaleTimestamp = new Date(parsedEvent.timestamp);

    // Determine session and offline mode
    const session = sessionCache.getActiveSessionForDevice(deviceId);
    const cloudConnected = wsClient.getStatus() === "connected";
    const offlineMode = !cloudConnected;
    
    // Get or create offline batch if needed
    let offlineBatchId: string | null = null;
    if (offlineMode) {
      let currentBatch = offlineBatchManager.getCurrentBatch();
      if (!currentBatch) {
        // Start new batch for this device
        currentBatch = offlineBatchManager.startBatch(deviceId);
      }
      offlineBatchId = currentBatch.id;
      
      // Increment batch event count
      offlineBatchManager.incrementEventCount(offlineBatchId, parsedEvent.weightGrams);
    }

    // Create event object
    const event: WeighingEvent = {
      id: eventId,
      deviceId,
      cloudSessionId: session?.cloudSessionId ?? null,
      offlineMode,
      offlineBatchId,
      pluCode: parsedEvent.pluCode,
      productName: parsedEvent.productName,
      weightGrams: parsedEvent.weightGrams,
      barcode: parsedEvent.barcode,
      scaleTimestamp,
      receivedAt,
      sourceIp,
      rawData: parsedEvent.rawData,
      syncStatus: "pending",
      cloudId: null,
      syncedAt: null,
      syncAttempts: 0,
      lastSyncError: null,
    };

    // Store in database
    db.prepare(`
      INSERT INTO events (
        id,
        device_id,
        cloud_session_id,
        offline_mode,
        offline_batch_id,
        plu_code,
        product_name,
        weight_grams,
        barcode,
        scale_timestamp,
        received_at,
        source_ip,
        raw_data,
        sync_status,
        sync_attempts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.deviceId,
      event.cloudSessionId,
      event.offlineMode ? 1 : 0,
      event.offlineBatchId,
      event.pluCode,
      event.productName,
      event.weightGrams,
      event.barcode,
      toSqliteDate(event.scaleTimestamp),
      toSqliteDate(event.receivedAt),
      event.sourceIp,
      event.rawData,
      event.syncStatus,
      event.syncAttempts
    );

    // Emit event for downstream processing
    this.emit("event:captured", event);

    return event;
  }

  /**
   * Normalize event data to ParsedScaleEvent format
   */
  private normalizeEventData(
    eventData: WeighingEventData | ParsedScaleEvent
  ): ParsedScaleEvent {
    // If already ParsedScaleEvent, return as-is
    if ("timestamp" in eventData && typeof eventData.timestamp === "string") {
      return eventData as ParsedScaleEvent;
    }

    // Convert WeighingEventData to ParsedScaleEvent
    const data = eventData as WeighingEventData;
    return {
      pluCode: data.pluCode,
      productName: data.productName,
      weightGrams: data.weightGrams,
      barcode: data.barcode,
      timestamp: data.timestamp.toISOString(),
      operator: data.operator,
      rawData: data.rawData,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // QUERIES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get event by ID
   */
  getEvent(eventId: string): WeighingEvent | null {
    const db = getDatabase();
    const row = db.prepare(`
      SELECT 
        id,
        device_id,
        cloud_session_id,
        offline_mode,
        offline_batch_id,
        plu_code,
        product_name,
        weight_grams,
        barcode,
        scale_timestamp,
        received_at,
        source_ip,
        raw_data,
        sync_status,
        cloud_id,
        synced_at,
        sync_attempts,
        last_sync_error
      FROM events
      WHERE id = ?
    `).get(eventId) as {
      id: string;
      device_id: string;
      cloud_session_id: string | null;
      offline_mode: number;
      offline_batch_id: string | null;
      plu_code: string;
      product_name: string;
      weight_grams: number;
      barcode: string;
      scale_timestamp: string;
      received_at: string;
      source_ip: string | null;
      raw_data: string;
      sync_status: EventSyncStatus;
      cloud_id: string | null;
      synced_at: string | null;
      sync_attempts: number;
      last_sync_error: string | null;
    } | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      deviceId: row.device_id,
      cloudSessionId: row.cloud_session_id ?? null,
      offlineMode: row.offline_mode === 1,
      offlineBatchId: row.offline_batch_id ?? null,
      pluCode: row.plu_code,
      productName: row.product_name,
      weightGrams: row.weight_grams,
      barcode: row.barcode,
      scaleTimestamp: fromSqliteDate(row.scale_timestamp)!,
      receivedAt: fromSqliteDate(row.received_at)!,
      sourceIp: row.source_ip ?? null,
      rawData: row.raw_data,
      syncStatus: row.sync_status,
      cloudId: row.cloud_id ?? null,
      syncedAt: fromSqliteDate(row.synced_at),
      syncAttempts: row.sync_attempts,
      lastSyncError: row.last_sync_error ?? null,
    };
  }

  /**
   * Get events by Cloud session ID
   */
  getEventsBySession(cloudSessionId: string): WeighingEvent[] {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT 
        id,
        device_id,
        cloud_session_id,
        offline_mode,
        offline_batch_id,
        plu_code,
        product_name,
        weight_grams,
        barcode,
        scale_timestamp,
        received_at,
        source_ip,
        raw_data,
        sync_status,
        cloud_id,
        synced_at,
        sync_attempts,
        last_sync_error
      FROM events
      WHERE cloud_session_id = ?
      ORDER BY received_at ASC
    `).all(cloudSessionId) as Array<{
      id: string;
      device_id: string;
      cloud_session_id: string | null;
      offline_mode: number;
      offline_batch_id: string | null;
      plu_code: string;
      product_name: string;
      weight_grams: number;
      barcode: string;
      scale_timestamp: string;
      received_at: string;
      source_ip: string | null;
      raw_data: string;
      sync_status: EventSyncStatus;
      cloud_id: string | null;
      synced_at: string | null;
      sync_attempts: number;
      last_sync_error: string | null;
    }>;

    return rows.map(row => ({
      id: row.id,
      deviceId: row.device_id,
      cloudSessionId: row.cloud_session_id ?? null,
      offlineMode: row.offline_mode === 1,
      offlineBatchId: row.offline_batch_id ?? null,
      pluCode: row.plu_code,
      productName: row.product_name,
      weightGrams: row.weight_grams,
      barcode: row.barcode,
      scaleTimestamp: fromSqliteDate(row.scale_timestamp)!,
      receivedAt: fromSqliteDate(row.received_at)!,
      sourceIp: row.source_ip ?? null,
      rawData: row.raw_data,
      syncStatus: row.sync_status,
      cloudId: row.cloud_id ?? null,
      syncedAt: fromSqliteDate(row.synced_at),
      syncAttempts: row.sync_attempts,
      lastSyncError: row.last_sync_error ?? null,
    }));
  }

  /**
   * Get events by offline batch ID
   */
  getEventsByBatch(batchId: string): WeighingEvent[] {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT 
        id,
        device_id,
        cloud_session_id,
        offline_mode,
        offline_batch_id,
        plu_code,
        product_name,
        weight_grams,
        barcode,
        scale_timestamp,
        received_at,
        source_ip,
        raw_data,
        sync_status,
        cloud_id,
        synced_at,
        sync_attempts,
        last_sync_error
      FROM events
      WHERE offline_batch_id = ?
      ORDER BY received_at ASC
    `).all(batchId) as Array<{
      id: string;
      device_id: string;
      cloud_session_id: string | null;
      offline_mode: number;
      offline_batch_id: string | null;
      plu_code: string;
      product_name: string;
      weight_grams: number;
      barcode: string;
      scale_timestamp: string;
      received_at: string;
      source_ip: string | null;
      raw_data: string;
      sync_status: EventSyncStatus;
      cloud_id: string | null;
      synced_at: string | null;
      sync_attempts: number;
      last_sync_error: string | null;
    }>;

    return rows.map(row => ({
      id: row.id,
      deviceId: row.device_id,
      cloudSessionId: row.cloud_session_id ?? null,
      offlineMode: row.offline_mode === 1,
      offlineBatchId: row.offline_batch_id ?? null,
      pluCode: row.plu_code,
      productName: row.product_name,
      weightGrams: row.weight_grams,
      barcode: row.barcode,
      scaleTimestamp: fromSqliteDate(row.scale_timestamp)!,
      receivedAt: fromSqliteDate(row.received_at)!,
      sourceIp: row.source_ip ?? null,
      rawData: row.raw_data,
      syncStatus: row.sync_status,
      cloudId: row.cloud_id ?? null,
      syncedAt: fromSqliteDate(row.synced_at),
      syncAttempts: row.sync_attempts,
      lastSyncError: row.last_sync_error ?? null,
    }));
  }

  /**
   * Get events by device ID
   */
  getEventsByDevice(deviceId: string, limit: number = 100): WeighingEvent[] {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT 
        id,
        device_id,
        cloud_session_id,
        offline_mode,
        offline_batch_id,
        plu_code,
        product_name,
        weight_grams,
        barcode,
        scale_timestamp,
        received_at,
        source_ip,
        raw_data,
        sync_status,
        cloud_id,
        synced_at,
        sync_attempts,
        last_sync_error
      FROM events
      WHERE device_id = ?
      ORDER BY received_at DESC
      LIMIT ?
    `).all(deviceId, limit) as Array<{
      id: string;
      device_id: string;
      cloud_session_id: string | null;
      offline_mode: number;
      offline_batch_id: string | null;
      plu_code: string;
      product_name: string;
      weight_grams: number;
      barcode: string;
      scale_timestamp: string;
      received_at: string;
      source_ip: string | null;
      raw_data: string;
      sync_status: EventSyncStatus;
      cloud_id: string | null;
      synced_at: string | null;
      sync_attempts: number;
      last_sync_error: string | null;
    }>;

    return rows.map(row => ({
      id: row.id,
      deviceId: row.device_id,
      cloudSessionId: row.cloud_session_id ?? null,
      offlineMode: row.offline_mode === 1,
      offlineBatchId: row.offline_batch_id ?? null,
      pluCode: row.plu_code,
      productName: row.product_name,
      weightGrams: row.weight_grams,
      barcode: row.barcode,
      scaleTimestamp: fromSqliteDate(row.scale_timestamp)!,
      receivedAt: fromSqliteDate(row.received_at)!,
      sourceIp: row.source_ip ?? null,
      rawData: row.raw_data,
      syncStatus: row.sync_status,
      cloudId: row.cloud_id ?? null,
      syncedAt: fromSqliteDate(row.synced_at),
      syncAttempts: row.sync_attempts,
      lastSyncError: row.last_sync_error ?? null,
    }));
  }

  /**
   * Get pending events (not yet synced)
   */
  getPendingEvents(limit: number = 100): WeighingEvent[] {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT 
        id,
        device_id,
        cloud_session_id,
        offline_mode,
        offline_batch_id,
        plu_code,
        product_name,
        weight_grams,
        barcode,
        scale_timestamp,
        received_at,
        source_ip,
        raw_data,
        sync_status,
        cloud_id,
        synced_at,
        sync_attempts,
        last_sync_error
      FROM events
      WHERE sync_status IN ('pending', 'failed')
      ORDER BY received_at ASC
      LIMIT ?
    `).all(limit) as Array<{
      id: string;
      device_id: string;
      cloud_session_id: string | null;
      offline_mode: number;
      offline_batch_id: string | null;
      plu_code: string;
      product_name: string;
      weight_grams: number;
      barcode: string;
      scale_timestamp: string;
      received_at: string;
      source_ip: string | null;
      raw_data: string;
      sync_status: EventSyncStatus;
      cloud_id: string | null;
      synced_at: string | null;
      sync_attempts: number;
      last_sync_error: string | null;
    }>;

    return rows.map(row => ({
      id: row.id,
      deviceId: row.device_id,
      cloudSessionId: row.cloud_session_id ?? null,
      offlineMode: row.offline_mode === 1,
      offlineBatchId: row.offline_batch_id ?? null,
      pluCode: row.plu_code,
      productName: row.product_name,
      weightGrams: row.weight_grams,
      barcode: row.barcode,
      scaleTimestamp: fromSqliteDate(row.scale_timestamp)!,
      receivedAt: fromSqliteDate(row.received_at)!,
      sourceIp: row.source_ip ?? null,
      rawData: row.raw_data,
      syncStatus: row.sync_status,
      cloudId: row.cloud_id ?? null,
      syncedAt: fromSqliteDate(row.synced_at),
      syncAttempts: row.sync_attempts,
      lastSyncError: row.last_sync_error ?? null,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SYNC STATUS UPDATES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Mark event as synced
   */
  markEventSynced(eventId: string, cloudEventId: string): void {
    const db = getDatabase();
    const now = new Date();

    db.prepare(`
      UPDATE events
      SET 
        sync_status = 'synced',
        cloud_id = ?,
        synced_at = ?
      WHERE id = ?
    `).run(cloudEventId, toSqliteDate(now), eventId);

    // Fetch updated event and emit
    const event = this.getEvent(eventId);
    if (event) {
      this.emit("event:synced", event);
    }
  }

  /**
   * Mark event as failed to sync
   */
  markEventFailed(eventId: string, error: string): void {
    const db = getDatabase();

    db.prepare(`
      UPDATE events
      SET 
        sync_status = 'failed',
        sync_attempts = sync_attempts + 1,
        last_sync_error = ?
      WHERE id = ?
    `).run(error, eventId);

    // Fetch updated event and emit
    const event = this.getEvent(eventId);
    if (event) {
      this.emit("event:failed", event);
    }
  }

  /**
   * Update sync status (for streaming state)
   */
  updateSyncStatus(eventId: string, status: EventSyncStatus): void {
    const db = getDatabase();

    db.prepare(`
      UPDATE events
      SET sync_status = ?
      WHERE id = ?
    `).run(status, eventId);
  }

  /**
   * Update event sync status with optional cloud ID or error
   * Unified method for test compatibility
   */
  updateEventSyncStatus(
    eventId: string, 
    status: EventSyncStatus, 
    cloudEventId: string | null = null,
    error: string | null = null
  ): void {
    if (status === "synced" && cloudEventId) {
      this.markEventSynced(eventId, cloudEventId);
    } else if (status === "failed" && error) {
      this.markEventFailed(eventId, error);
    } else {
      this.updateSyncStatus(eventId, status);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENT SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Subscribe to event processor events
   */
  on(event: EventProcessorEvent, callback: EventCallback): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(callback);
  }

  /**
   * Unsubscribe from event processor events
   */
  off(event: EventProcessorEvent, callback: EventCallback): void {
    this.eventListeners.get(event)?.delete(callback);
  }

  /**
   * Emit event to all listeners
   */
  private emit(event: EventProcessorEvent, weighingEvent: WeighingEvent): void {
    this.eventListeners.get(event)?.forEach(callback => {
      try {
        callback(weighingEvent);
      } catch (error) {
        console.error(`[EventProcessor] Error in event listener for ${event}:`, error);
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════════════════

let eventProcessor: EventProcessor | null = null;

/**
 * Initialize event processor
 */
export function initEventProcessor(): EventProcessor {
  if (!eventProcessor) {
    eventProcessor = new EventProcessor();
    console.log("[EventProcessor] Initialized");
  }
  return eventProcessor;
}

/**
 * Get event processor instance
 */
export function getEventProcessor(): EventProcessor {
  if (!eventProcessor) {
    return initEventProcessor();
  }
  return eventProcessor;
}

/**
 * Destroy event processor (for shutdown)
 */
export function destroyEventProcessor(): void {
  eventProcessor = null;
  console.log("[EventProcessor] Destroyed");
}
