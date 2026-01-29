/**
 * CarniTrack Edge - Cloud Sync Service
 * 
 * Streams events to Cloud via WebSocket in real-time and handles retry/backlog scenarios.
 * 
 * @see GitHub Issue #8
 */

import { getEventProcessor } from "../devices/event-processor.ts";
import { getWebSocketClient } from "./websocket-client.ts";
import { getOfflineBatchManager } from "./offline-batch-manager.ts";
import { config } from "../config.ts";
import type { WeighingEvent, EventPayload, EventAckPayload } from "../types/index.ts";
import type { CloudMessage } from "../types/index.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Sync service status */
export interface SyncStatus {
  isRunning: boolean;
  lastSyncAt: Date | null;
  pendingEvents: number;
  pendingBatches: number;
}

/** Sync result */
export interface SyncResult {
  success: boolean;
  synced: number;
  failed: number;
  errors: string[];
}

/** Sync service configuration */
interface SyncConfig {
  batchSize: number;
  retryInterval: number;
  maxRetries: number;
  backlogSyncDelay: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLOUD SYNC SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class CloudSyncService {
  private isRunning: boolean = false;
  private lastSyncAt: Date | null = null;
  private syncConfig: SyncConfig;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private backlogSyncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.syncConfig = {
      batchSize: config.cloud.batchSize,
      retryInterval: 5000, // 5 seconds
      maxRetries: 10,
      backlogSyncDelay: 2000, // 2 seconds after reconnect
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONTROL
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start sync service
   */
  start(): void {
    if (this.isRunning) {
      console.warn("[SyncService] Already running");
      return;
    }

    this.isRunning = true;
    const eventProcessor = getEventProcessor();
    const wsClient = getWebSocketClient();

    // Subscribe to event processor events
    eventProcessor.on("event:captured", (event) => {
      this.handleEventCaptured(event);
    });

    // Subscribe to WebSocket connection events
    wsClient.on("connected", () => {
      this.handleCloudConnected();
    });

    wsClient.on("disconnected", () => {
      this.handleCloudDisconnected();
    });

    // Subscribe to Cloud messages
    wsClient.on("message", (message: CloudMessage) => {
      if (message.type === "event_ack") {
        this.handleEventAck(message.payload as EventAckPayload);
      } else if (message.type === "event_rejected") {
        const payload = message.payload as { localEventId: string; reason: string };
        this.handleEventRejected(payload.localEventId, payload.reason);
      }
    });

    // Start retry timer for failed events
    this.startRetryTimer();

    console.log("[SyncService] Started");
  }

  /**
   * Stop sync service
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.stopRetryTimer();
    this.cancelBacklogSync();

    console.log("[SyncService] Stopped");
  }

  /**
   * Pause sync (temporarily stop processing)
   */
  pause(): void {
    this.stopRetryTimer();
    console.log("[SyncService] Paused");
  }

  /**
   * Resume sync
   */
  resume(): void {
    this.startRetryTimer();
    console.log("[SyncService] Resumed");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENT HANDLING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle new event captured
   * Stream immediately if Cloud is connected
   */
  private handleEventCaptured(event: WeighingEvent): void {
    const wsClient = getWebSocketClient();

    // If offline mode, event is already tagged with batch ID
    // Just store it, will sync when connection restored
    if (event.offlineMode) {
      return;
    }

    // If Cloud is connected, stream immediately
    if (wsClient.getStatus() === "connected") {
      this.streamEvent(event);
    }
    // Otherwise, event stays as "pending" and will be synced later
  }

  /**
   * Handle Cloud connection established
   */
  private handleCloudConnected(): void {
    console.log("[SyncService] Cloud connected, scheduling backlog sync...");

    // End any active offline batches
    const offlineBatchManager = getOfflineBatchManager();
    const activeBatches = offlineBatchManager.getActiveBatches();
    for (const batch of activeBatches) {
      offlineBatchManager.endBatch(batch.id);
    }

    // Schedule backlog sync after a short delay
    this.scheduleBacklogSync();
  }

  /**
   * Handle Cloud disconnection
   */
  private handleCloudDisconnected(): void {
    console.log("[SyncService] Cloud disconnected");
    this.cancelBacklogSync();
  }

  /**
   * Handle event acknowledgment from Cloud
   */
  private handleEventAck(payload: EventAckPayload): void {
    const eventProcessor = getEventProcessor();

    if (payload.status === "accepted") {
      eventProcessor.markEventSynced(payload.localEventId, payload.cloudEventId);
    } else if (payload.status === "duplicate") {
      // Cloud says it's a duplicate, mark as synced anyway
      eventProcessor.markEventSynced(payload.localEventId, payload.cloudEventId);
    }
  }

  /**
   * Handle event rejection from Cloud
   */
  private handleEventRejected(localEventId: string, reason: string): void {
    const eventProcessor = getEventProcessor();
    eventProcessor.markEventFailed(localEventId, `Rejected by Cloud: ${reason}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STREAMING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Stream single event to Cloud
   */
  async streamEvent(event: WeighingEvent): Promise<boolean> {
    const wsClient = getWebSocketClient();
    const eventProcessor = getEventProcessor();

    // Update status to "streaming"
    eventProcessor.updateSyncStatus(event.id, "streaming");

    // Get device info for global device ID
    const deviceManager = await import("../devices/device-manager.ts").then(m => m.getDeviceManager());
    const device = deviceManager.getDevice(event.deviceId);
    const globalDeviceId = device?.globalDeviceId ?? event.deviceId;

    // Build event payload
    const payload: EventPayload = {
      localEventId: event.id,
      deviceId: event.deviceId,
      globalDeviceId,
      cloudSessionId: event.cloudSessionId,
      offlineMode: event.offlineMode,
      offlineBatchId: event.offlineBatchId,
      pluCode: event.pluCode,
      productName: event.productName,
      weightGrams: event.weightGrams,
      barcode: event.barcode,
      scaleTimestamp: event.scaleTimestamp.toISOString(),
      receivedAt: event.receivedAt.toISOString(),
    };

    // Send via WebSocket
    const sent = wsClient.send({
      type: "event",
      payload,
    });

    if (!sent) {
      // Failed to send, mark as failed
      eventProcessor.markEventFailed(event.id, "WebSocket send failed");
      return false;
    }

    return true;
  }

  /**
   * Sync pending events (after reconnection)
   */
  async syncPendingEvents(): Promise<SyncResult> {
    const eventProcessor = getEventProcessor();
    const wsClient = getWebSocketClient();

    if (wsClient.getStatus() !== "connected") {
      return {
        success: false,
        synced: 0,
        failed: 0,
        errors: ["Cloud not connected"],
      };
    }

    const pendingEvents = eventProcessor.getPendingEvents(this.syncConfig.batchSize);
    const result: SyncResult = {
      success: true,
      synced: 0,
      failed: 0,
      errors: [],
    };

    // Send events in batches
    for (let i = 0; i < pendingEvents.length; i += this.syncConfig.batchSize) {
      const batch = pendingEvents.slice(i, i + this.syncConfig.batchSize);
      
      if (batch.length === 1) {
        // Single event - use regular stream
        const success = await this.streamEvent(batch[0]);
        if (success) {
          result.synced++;
        } else {
          result.failed++;
        }
      } else {
        // Multiple events - send as batch
        const success = await this.streamEventBatch(batch);
        if (success) {
          result.synced += batch.length;
        } else {
          result.failed += batch.length;
          result.errors.push(`Failed to send batch of ${batch.length} events`);
        }
      }
    }

    this.lastSyncAt = new Date();
    return result;
  }

  /**
   * Stream batch of events to Cloud
   */
  private async streamEventBatch(events: WeighingEvent[]): Promise<boolean> {
    const wsClient = getWebSocketClient();
    const eventProcessor = getEventProcessor();

    // Get device info
    const deviceManager = await import("../devices/device-manager.ts").then(m => m.getDeviceManager());

    // Build batch payload
    const payloads: EventPayload[] = events.map(event => {
      const device = deviceManager.getDevice(event.deviceId);
      const globalDeviceId = device?.globalDeviceId ?? event.deviceId;

      return {
        localEventId: event.id,
        deviceId: event.deviceId,
        globalDeviceId,
        cloudSessionId: event.cloudSessionId,
        offlineMode: event.offlineMode,
        offlineBatchId: event.offlineBatchId,
        pluCode: event.pluCode,
        productName: event.productName,
        weightGrams: event.weightGrams,
        barcode: event.barcode,
        scaleTimestamp: event.scaleTimestamp.toISOString(),
        receivedAt: event.receivedAt.toISOString(),
      };
    });

    // Update all events to "streaming"
    events.forEach(event => {
      eventProcessor.updateSyncStatus(event.id, "streaming");
    });

    // Send batch
    const sent = wsClient.send({
      type: "event_batch",
      payload: {
        events: payloads,
      },
    });

    if (!sent) {
      // Failed to send batch
      events.forEach(event => {
        eventProcessor.markEventFailed(event.id, "Batch send failed");
      });
      return false;
    }

    return true;
  }

  /**
   * Sync offline batch to Cloud
   */
  async syncOfflineBatch(batchId: string): Promise<SyncResult> {
    const offlineBatchManager = getOfflineBatchManager();
    const eventProcessor = getEventProcessor();
    const wsClient = getWebSocketClient();

    if (wsClient.getStatus() !== "connected") {
      return {
        success: false,
        synced: 0,
        failed: 0,
        errors: ["Cloud not connected"],
      };
    }

    const batch = offlineBatchManager.getBatch(batchId);
    if (!batch) {
      return {
        success: false,
        synced: 0,
        failed: 0,
        errors: [`Batch ${batchId} not found`],
      };
    }

    // Mark batch as syncing
    offlineBatchManager.markBatchSyncing(batchId);

    // Get events for this batch
    const events = eventProcessor.getEventsByBatch(batchId);

    // Send batch notification to Cloud
    wsClient.send({
      type: "offline_batch_end",
      payload: {
        batchId: batch.id,
        deviceId: batch.deviceId,
        startedAt: batch.startedAt.toISOString(),
        endedAt: batch.endedAt?.toISOString() ?? null,
        eventCount: batch.eventCount,
        totalWeightGrams: batch.totalWeightGrams,
      },
    });

    // Sync events
    const result = await this.syncPendingEvents();
    
    // If all events synced, mark batch as synced
    if (result.failed === 0) {
      offlineBatchManager.markBatchSynced(batchId);
    }

    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATUS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get sync status
   */
  getSyncStatus(): SyncStatus {
    const eventProcessor = getEventProcessor();
    const offlineBatchManager = getOfflineBatchManager();

    const pendingEvents = eventProcessor.getPendingEvents(1000).length;
    const pendingBatches = offlineBatchManager.getPendingSyncBatches().length;

    return {
      isRunning: this.isRunning,
      lastSyncAt: this.lastSyncAt,
      pendingEvents,
      pendingBatches,
    };
  }

  /**
   * Alias for getSyncStatus (for test compatibility)
   */
  getStatus(): SyncStatus {
    return this.getSyncStatus();
  }

  /**
   * Get count of pending events
   */
  getPendingCount(): number {
    const eventProcessor = getEventProcessor();
    return eventProcessor.getPendingEvents(1000).length;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RETRY LOGIC
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start retry timer for failed events
   */
  private startRetryTimer(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
    }

    this.retryTimer = setInterval(() => {
      if (this.isRunning) {
        this.syncPendingEvents().catch(error => {
          console.error("[SyncService] Error in retry sync:", error);
        });
      }
    }, this.syncConfig.retryInterval);
  }

  /**
   * Stop retry timer
   */
  private stopRetryTimer(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * Schedule backlog sync after reconnection
   */
  private scheduleBacklogSync(): void {
    this.cancelBacklogSync();

    this.backlogSyncTimer = setTimeout(() => {
      this.syncPendingEvents().catch(error => {
        console.error("[SyncService] Error in backlog sync:", error);
      });
    }, this.syncConfig.backlogSyncDelay);
  }

  /**
   * Cancel backlog sync
   */
  private cancelBacklogSync(): void {
    if (this.backlogSyncTimer) {
      clearTimeout(this.backlogSyncTimer);
      this.backlogSyncTimer = null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════════════════

let cloudSyncService: CloudSyncService | null = null;

/**
 * Initialize cloud sync service
 */
export function initCloudSyncService(): CloudSyncService {
  if (!cloudSyncService) {
    cloudSyncService = new CloudSyncService();
    console.log("[SyncService] Initialized");
  }
  return cloudSyncService;
}

/**
 * Get cloud sync service instance
 */
export function getCloudSyncService(): CloudSyncService {
  if (!cloudSyncService) {
    return initCloudSyncService();
  }
  return cloudSyncService;
}

/**
 * Destroy cloud sync service (for shutdown)
 */
export function destroyCloudSyncService(): void {
  if (cloudSyncService) {
    cloudSyncService.stop();
    cloudSyncService = null;
    console.log("[SyncService] Destroyed");
  }
}
