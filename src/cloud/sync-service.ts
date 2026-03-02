/**
 * CarniTrack Edge - Cloud Sync Service
 * 
 * Streams events to Cloud via WebSocket in real-time and handles retry/backlog scenarios.
 * 
 * @see GitHub Issue #8
 */

import { getEventProcessor } from "../devices/event-processor.ts";
import { getRestClient } from "./rest-client.ts";
import { getOfflineBatchManager } from "./offline-batch-manager.ts";
import { config } from "../config.ts";
import type { WeighingEvent, EventPayload } from "../types/index.ts";

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

/** Events in "streaming" longer than this are reset to "pending" for retry */
const STUCK_STREAMING_MS = 5 * 60 * 1000; // 5 minutes

/** Result of posting a batch (per-event counts, not just HTTP success) */
interface BatchPostResult {
  synced: number;
  failed: number;
  httpSuccess: boolean;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLOUD SYNC SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class CloudSyncService {
  private isRunning: boolean = false;
  private lastSyncAt: Date | null = null;
  private syncConfig: SyncConfig;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private batchTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.syncConfig = {
      batchSize: config.rest.batchSize,
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
    const restClient = getRestClient();

    if (!restClient) {
      console.error("[SyncService] REST client not initialized");
      return;
    }

    // Subscribe to event processor events
    eventProcessor.on("event:captured", (event) => {
      this.handleEventCaptured(event);
    });

    // Subscribe to REST client connection events
    restClient.on("connected", () => {
      this.handleCloudConnected();
    });

    restClient.on("disconnected", () => {
      this.handleCloudDisconnected();
    });

    // Start retry timer for failed events
    this.startRetryTimer();

    // Start batch timer for periodic batch uploads
    this.startBatchTimer();

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
    this.stopBatchTimer();

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
   * Post immediately if Cloud is online
   */
  private handleEventCaptured(event: WeighingEvent): void {
    const restClient = getRestClient();

    // If offline mode, event is already tagged with batch ID
    // Just store it, will sync when connection restored
    if (event.offlineMode) {
      return;
    }

    // If Cloud is online, post immediately
    if (restClient && restClient.isOnline()) {
      this.postEvent(event).catch(error => {
        console.error("[SyncService] Failed to post event:", error);
      });
    }
    // Otherwise, event stays as "pending" and will be synced later
  }

  /**
   * Handle Cloud connection established
   */
  private handleCloudConnected(): void {
    console.log("[SyncService] Cloud connected, syncing backlog...");

    // End any active offline batches
    const offlineBatchManager = getOfflineBatchManager();
    const activeBatches = offlineBatchManager.getActiveBatches();
    for (const batch of activeBatches) {
      offlineBatchManager.endBatch(batch.id);
    }

    // Sync pending events immediately
    this.syncPendingEvents().catch(error => {
      console.error("[SyncService] Error in backlog sync:", error);
    });
  }

  /**
   * Handle Cloud disconnection
   */
  private handleCloudDisconnected(): void {
    console.log("[SyncService] Cloud disconnected");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // POSTING EVENTS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post single event to Cloud
   */
  async postEvent(event: WeighingEvent): Promise<boolean> {
    const restClient = getRestClient();
    const eventProcessor = getEventProcessor();

    if (!restClient) {
      eventProcessor.markEventFailed(event.id, "REST client not available");
      return false;
    }

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

    try {
      // Post via REST API
      const response = await restClient.postEvent(payload);
      
      // Mark as synced and log
      eventProcessor.markEventSynced(event.id, response.cloudEventId);
      console.log(
        `[SyncService] Event ${response.status} (localEventId=${event.id}, cloudEventId=${response.cloudEventId}, deviceId=${event.deviceId}, cloudSessionId=${event.cloudSessionId ?? "—"})`
      );
      return true;
    } catch (error) {
      // Failed to post, mark as failed
      const errorMessage = error instanceof Error ? error.message : String(error);
      eventProcessor.markEventFailed(event.id, `REST POST failed: ${errorMessage}`);
      console.warn(
        `[SyncService] Event failed (localEventId=${event.id}, deviceId=${event.deviceId}): ${errorMessage}`
      );
      return false;
    }
  }

  /**
   * Sync pending events (after reconnection or periodically)
   */
  async syncPendingEvents(): Promise<SyncResult> {
    const eventProcessor = getEventProcessor();
    const restClient = getRestClient();

    if (!restClient || !restClient.isOnline()) {
      return {
        success: false,
        synced: 0,
        failed: 0,
        errors: ["Cloud not online"],
      };
    }

    const pendingEvents = eventProcessor.getPendingEvents(this.syncConfig.batchSize);
    const result: SyncResult = {
      success: true,
      synced: 0,
      failed: 0,
      errors: [],
    };

    if (pendingEvents.length === 0) {
      return result;
    }

    // Send events in batches
    for (let i = 0; i < pendingEvents.length; i += this.syncConfig.batchSize) {
      const batch = pendingEvents.slice(i, i + this.syncConfig.batchSize);
      
      if (batch.length === 1) {
        // Single event - use regular post
        const success = await this.postEvent(batch[0]);
        if (success) {
          result.synced++;
        } else {
          result.failed++;
        }
      } else {
        // Multiple events - send as batch
        const batchResult = await this.postEventBatch(batch);
        result.synced += batchResult.synced;
        result.failed += batchResult.failed;
        if (!batchResult.httpSuccess && batchResult.error) {
          result.errors.push(batchResult.error);
        }
      }
    }

    this.lastSyncAt = new Date();
    return result;
  }

  /**
   * Post batch of events to Cloud
   * Returns per-event synced/failed counts (not just HTTP success)
   */
  private async postEventBatch(events: WeighingEvent[]): Promise<BatchPostResult> {
    const restClient = getRestClient();
    const eventProcessor = getEventProcessor();

    if (!restClient) {
      events.forEach(event => {
        eventProcessor.markEventFailed(event.id, "REST client not available");
      });
      return { synced: 0, failed: events.length, httpSuccess: false, error: "REST client not available" };
    }

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

    try {
      // Post batch via REST API
      const response = await restClient.postEventBatch(payloads);

      // Validate batch response – require one result per event to avoid stuck "streaming"
      if (!response?.results || response.results.length !== events.length) {
        const msg = `Batch response incomplete (got ${response?.results?.length ?? 0}, expected ${events.length})`;
        console.warn(`[SyncService] ${msg}, will retry`);
        events.forEach(event => {
          eventProcessor.markEventFailed(event.id, msg);
        });
        return { synced: 0, failed: events.length, httpSuccess: true, error: msg };
      }

      const resultIds = new Set<string>();
      let accepted = 0;
      let duplicate = 0;
      let failed = 0;
      for (const result of response.results) {
        resultIds.add(result.localEventId);
        if (result.status === "accepted") {
          accepted++;
          eventProcessor.markEventSynced(result.localEventId, result.cloudEventId);
        } else if (result.status === "duplicate") {
          duplicate++;
          eventProcessor.markEventSynced(result.localEventId, result.cloudEventId);
        } else {
          failed++;
          eventProcessor.markEventFailed(result.localEventId, result.error || "Batch post failed");
        }
      }
      for (const event of events) {
        if (!resultIds.has(event.id)) {
          eventProcessor.markEventFailed(event.id, "Missing from batch response");
          failed++;
        }
      }
      console.log(
        `[SyncService] Batch result: accepted=${accepted}, duplicate=${duplicate}, failed=${failed} (${payloads.length} events)`
      );

      const syncedCount = accepted + duplicate;

      // Offline batch ACK: for batches whose events are all synced, notify Cloud and mark reconciled
      const offlineBatchManager = getOfflineBatchManager();
      const syncedBatchIds = new Set(
        events
          .filter(e => e.offlineBatchId && (response.results.find(r => r.localEventId === e.id)?.status === "accepted" || response.results.find(r => r.localEventId === e.id)?.status === "duplicate"))
          .map(e => e.offlineBatchId!)
      );
      for (const batchId of syncedBatchIds) {
        const batch = offlineBatchManager.getBatch(batchId);
        if (!batch) continue;
        const batchEvents = eventProcessor.getEventsByBatch(batchId);
        const allSynced = batchEvents.length > 0 && batchEvents.every(e => e.syncStatus === "synced");
        if (!allSynced) continue;

        if (config.offline.offlineBatchAckRequired) {
          try {
            await restClient.postOfflineBatchAck({
              batchId,
              deviceId: batch.deviceId,
              eventIds: batchEvents.map(e => e.id),
              eventCount: batch.eventCount,
              totalWeightGrams: batch.totalWeightGrams,
              startedAt: batch.startedAt.toISOString(),
              endedAt: (batch.endedAt ?? new Date()).toISOString(),
            });
            offlineBatchManager.markBatchSynced(batchId);
          } catch (ackError) {
            const msg = ackError instanceof Error ? ackError.message : String(ackError);
            console.warn(`[SyncService] Offline batch ACK failed for ${batchId}, falling back to mark synced: ${msg}`);
            offlineBatchManager.markBatchSynced(batchId);
          }
        } else {
          offlineBatchManager.markBatchSynced(batchId);
        }
      }

      return { synced: syncedCount, failed, httpSuccess: true };
    } catch (error) {
      // Failed to post batch (HTTP error)
      const errorMessage = error instanceof Error ? error.message : String(error);
      events.forEach(event => {
        eventProcessor.markEventFailed(event.id, `Batch POST failed: ${errorMessage}`);
      });
      return {
        synced: 0,
        failed: events.length,
        httpSuccess: false,
        error: `Failed to send batch of ${events.length} events: ${errorMessage}`,
      };
    }
  }

  /**
   * Sync offline batch to Cloud
   */
  async syncOfflineBatch(batchId: string): Promise<SyncResult> {
    const offlineBatchManager = getOfflineBatchManager();
    const eventProcessor = getEventProcessor();
    const restClient = getRestClient();

    if (!restClient || !restClient.isOnline()) {
      return {
        success: false,
        synced: 0,
        failed: 0,
        errors: ["Cloud not online"],
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

    // Note: Offline batch notification can be sent via REST if Cloud API supports it
    // For now, we'll just sync the events

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
   * Start batch timer for periodic batch uploads
   */
  private startBatchTimer(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
    }

    this.batchTimer = setInterval(() => {
      if (this.isRunning) {
        const eventProcessor = getEventProcessor();
        const reset = eventProcessor.resetStuckStreamingEvents(STUCK_STREAMING_MS);
        if (reset > 0) {
          console.log(`[SyncService] Reset ${reset} stuck streaming event(s) to pending for retry`);
        }
        this.syncPendingEvents().catch(error => {
          console.error("[SyncService] Error in batch sync:", error);
        });
      }
    }, config.rest.batchIntervalMs);
  }

  /**
   * Stop batch timer
   */
  private stopBatchTimer(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
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
