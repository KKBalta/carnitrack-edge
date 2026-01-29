/**
 * CarniTrack Edge - Offline Batch Manager
 * 
 * Groups events captured when Cloud is unreachable for later reconciliation.
 * 
 * @see GitHub Issue #7
 */

import { getDatabase } from "../storage/database.ts";
import { toSqliteDate, fromSqliteDate, generateId } from "../storage/database.ts";
import type { OfflineBatch, ReconciliationStatus } from "../types/index.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Event types emitted by Offline Batch Manager */
type OfflineBatchEvent = 
  | "batch:started"
  | "batch:ended"
  | "batch:synced";

/** Event callback signature */
type EventCallback = (batch: OfflineBatch) => void;

// ═══════════════════════════════════════════════════════════════════════════════
// OFFLINE BATCH MANAGER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class OfflineBatchManager {
  private currentBatchId: string | null = null;
  private eventListeners: Map<OfflineBatchEvent, Set<EventCallback>> = new Map();

  constructor() {
    // Check for any active batch on startup (in case of crash recovery)
    this.loadActiveBatch();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BATCH LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start a new offline batch
   * Called when Cloud disconnects
   */
  startBatch(deviceId: string): OfflineBatch {
    const db = getDatabase();
    const batchId = generateId();
    const now = new Date();

    // Create batch in database
    db.prepare(`
      INSERT INTO offline_batches (
        id,
        device_id,
        started_at,
        event_count,
        total_weight_grams,
        reconciliation_status
      ) VALUES (?, ?, ?, 0, 0, 'pending')
    `).run(
      batchId,
      deviceId,
      toSqliteDate(now)
    );

    this.currentBatchId = batchId;

    const batch: OfflineBatch = {
      id: batchId,
      deviceId,
      startedAt: now,
      endedAt: null,
      eventCount: 0,
      totalWeightGrams: 0,
      reconciliationStatus: "pending",
      cloudSessionId: null,
      reconciledAt: null,
      reconciledBy: null,
      notes: null,
    };

    // Emit event
    this.emit("batch:started", batch);

    console.log(`[OfflineBatch] Started batch ${batchId} for device ${deviceId}`);

    return batch;
  }

  /**
   * End an offline batch
   * Called when Cloud reconnects
   */
  endBatch(batchId: string): OfflineBatch | null {
    const db = getDatabase();
    const now = new Date();

    // Update batch
    const result = db.prepare(`
      UPDATE offline_batches
      SET ended_at = ?
      WHERE id = ?
    `).run(toSqliteDate(now), batchId);

    if (result.changes === 0) {
      console.warn(`[OfflineBatch] Batch ${batchId} not found`);
      return null;
    }

    // Clear current batch if it's the one we're ending
    if (this.currentBatchId === batchId) {
      this.currentBatchId = null;
    }

    // Fetch updated batch
    const batch = this.getBatch(batchId);
    if (batch) {
      this.emit("batch:ended", batch);
      console.log(`[OfflineBatch] Ended batch ${batchId} with ${batch.eventCount} events`);
    }

    return batch;
  }

  /**
   * Get current active batch ID
   */
  getCurrentBatchId(): string | null {
    return this.currentBatchId;
  }

  /**
   * Get current active batch
   */
  getCurrentBatch(): OfflineBatch | null {
    if (!this.currentBatchId) {
      return null;
    }
    return this.getBatch(this.currentBatchId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // QUERIES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get batch by ID
   */
  getBatch(batchId: string): OfflineBatch | null {
    const db = getDatabase();
    const row = db.prepare(`
      SELECT 
        id,
        device_id,
        started_at,
        ended_at,
        event_count,
        total_weight_grams,
        reconciliation_status,
        cloud_session_id,
        reconciled_at,
        reconciled_by,
        notes
      FROM offline_batches
      WHERE id = ?
    `).get(batchId) as {
      id: string;
      device_id: string;
      started_at: string;
      ended_at: string | null;
      event_count: number;
      total_weight_grams: number;
      reconciliation_status: ReconciliationStatus;
      cloud_session_id: string | null;
      reconciled_at: string | null;
      reconciled_by: string | null;
      notes: string | null;
    } | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      deviceId: row.device_id,
      startedAt: fromSqliteDate(row.started_at)!,
      endedAt: fromSqliteDate(row.ended_at),
      eventCount: row.event_count,
      totalWeightGrams: row.total_weight_grams,
      reconciliationStatus: row.reconciliation_status,
      cloudSessionId: row.cloud_session_id ?? null,
      reconciledAt: fromSqliteDate(row.reconciled_at),
      reconciledBy: row.reconciled_by ?? null,
      notes: row.notes ?? null,
    };
  }

  /**
   * Get all active batches (not yet ended)
   */
  getActiveBatches(): OfflineBatch[] {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT 
        id,
        device_id,
        started_at,
        ended_at,
        event_count,
        total_weight_grams,
        reconciliation_status,
        cloud_session_id,
        reconciled_at,
        reconciled_by,
        notes
      FROM offline_batches
      WHERE ended_at IS NULL
      ORDER BY started_at DESC
    `).all() as Array<{
      id: string;
      device_id: string;
      started_at: string;
      ended_at: string | null;
      event_count: number;
      total_weight_grams: number;
      reconciliation_status: ReconciliationStatus;
      cloud_session_id: string | null;
      reconciled_at: string | null;
      reconciled_by: string | null;
      notes: string | null;
    }>;

    return rows.map(row => ({
      id: row.id,
      deviceId: row.device_id,
      startedAt: fromSqliteDate(row.started_at)!,
      endedAt: fromSqliteDate(row.ended_at),
      eventCount: row.event_count,
      totalWeightGrams: row.total_weight_grams,
      reconciliationStatus: row.reconciliation_status,
      cloudSessionId: row.cloud_session_id ?? null,
      reconciledAt: fromSqliteDate(row.reconciled_at),
      reconciledBy: row.reconciled_by ?? null,
      notes: row.notes ?? null,
    }));
  }

  /**
   * Get batches pending sync (ended but not yet synced)
   */
  getPendingSyncBatches(): OfflineBatch[] {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT 
        id,
        device_id,
        started_at,
        ended_at,
        event_count,
        total_weight_grams,
        reconciliation_status,
        cloud_session_id,
        reconciled_at,
        reconciled_by,
        notes
      FROM offline_batches
      WHERE ended_at IS NOT NULL
        AND reconciliation_status = 'pending'
      ORDER BY ended_at DESC
    `).all() as Array<{
      id: string;
      device_id: string;
      started_at: string;
      ended_at: string | null;
      event_count: number;
      total_weight_grams: number;
      reconciliation_status: ReconciliationStatus;
      cloud_session_id: string | null;
      reconciled_at: string | null;
      reconciled_by: string | null;
      notes: string | null;
    }>;

    return rows.map(row => ({
      id: row.id,
      deviceId: row.device_id,
      startedAt: fromSqliteDate(row.started_at)!,
      endedAt: fromSqliteDate(row.ended_at),
      eventCount: row.event_count,
      totalWeightGrams: row.total_weight_grams,
      reconciliationStatus: row.reconciliation_status,
      cloudSessionId: row.cloud_session_id ?? null,
      reconciledAt: fromSqliteDate(row.reconciled_at),
      reconciledBy: row.reconciled_by ?? null,
      notes: row.notes ?? null,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENT COUNTING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Increment event count for a batch
   * Called by Event Processor when events are tagged with batch ID
   */
  incrementEventCount(batchId: string, weightGrams: number = 0): void {
    const db = getDatabase();
    
    db.prepare(`
      UPDATE offline_batches
      SET 
        event_count = event_count + 1,
        total_weight_grams = total_weight_grams + ?
      WHERE id = ?
    `).run(weightGrams, batchId);
  }

  /**
   * Get event count for a batch
   */
  getEventCount(batchId: string): number {
    const db = getDatabase();
    const row = db.prepare(`
      SELECT event_count
      FROM offline_batches
      WHERE id = ?
    `).get(batchId) as { event_count: number } | undefined;

    return row?.event_count ?? 0;
  }

  /**
   * Alias for getBatch (for test compatibility)
   */
  getBatchById(batchId: string): OfflineBatch | null {
    return this.getBatch(batchId);
  }

  /**
   * Alias for getPendingSyncBatches (for test compatibility)
   */
  getPendingBatches(): OfflineBatch[] {
    return this.getPendingSyncBatches();
  }

  /**
   * Get batches for a specific device
   */
  getBatchesByDevice(deviceId: string): OfflineBatch[] {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT 
        id,
        device_id,
        started_at,
        ended_at,
        event_count,
        total_weight_grams,
        reconciliation_status,
        cloud_session_id,
        reconciled_at,
        reconciled_by,
        notes
      FROM offline_batches
      WHERE device_id = ?
      ORDER BY started_at DESC
    `).all(deviceId) as Array<{
      id: string;
      device_id: string;
      started_at: string;
      ended_at: string | null;
      event_count: number;
      total_weight_grams: number;
      reconciliation_status: ReconciliationStatus;
      cloud_session_id: string | null;
      reconciled_at: string | null;
      reconciled_by: string | null;
      notes: string | null;
    }>;

    return rows.map(row => ({
      id: row.id,
      deviceId: row.device_id,
      startedAt: fromSqliteDate(row.started_at)!,
      endedAt: fromSqliteDate(row.ended_at),
      eventCount: row.event_count,
      totalWeightGrams: row.total_weight_grams,
      reconciliationStatus: row.reconciliation_status,
      cloudSessionId: row.cloud_session_id ?? null,
      reconciledAt: fromSqliteDate(row.reconciled_at),
      reconciledBy: row.reconciled_by ?? null,
      notes: row.notes ?? null,
    }));
  }

  /**
   * Update reconciliation status with optional metadata
   */
  updateReconciliationStatus(
    batchId: string,
    status: ReconciliationStatus,
    metadata?: {
      cloudSessionId?: string;
      reconciledBy?: string;
      notes?: string;
    }
  ): void {
    const db = getDatabase();
    const now = new Date();

    if (status === "reconciled") {
      // Full reconciliation with metadata
      db.prepare(`
        UPDATE offline_batches
        SET 
          reconciliation_status = ?,
          cloud_session_id = ?,
          reconciled_at = ?,
          reconciled_by = ?,
          notes = ?
        WHERE id = ?
      `).run(
        status,
        metadata?.cloudSessionId ?? null,
        toSqliteDate(now),
        metadata?.reconciledBy ?? null,
        metadata?.notes ?? null,
        batchId
      );

      // Emit synced event
      const batch = this.getBatch(batchId);
      if (batch) {
        this.emit("batch:synced", batch);
      }
    } else {
      // Just update status
      db.prepare(`
        UPDATE offline_batches
        SET reconciliation_status = ?
        WHERE id = ?
      `).run(status, batchId);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SYNC STATUS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Mark batch as syncing (Cloud is processing it)
   */
  markBatchSyncing(batchId: string): void {
    const db = getDatabase();
    
    db.prepare(`
      UPDATE offline_batches
      SET reconciliation_status = 'in_progress'
      WHERE id = ?
    `).run(batchId);
  }

  /**
   * Mark batch as synced (Cloud has reconciled it)
   */
  markBatchSynced(batchId: string, cloudSessionId: string | null = null): void {
    const db = getDatabase();
    const now = new Date();
    
    db.prepare(`
      UPDATE offline_batches
      SET 
        reconciliation_status = 'reconciled',
        cloud_session_id = ?,
        reconciled_at = ?
      WHERE id = ?
    `).run(
      cloudSessionId ?? null,
      toSqliteDate(now),
      batchId
    );

    // Fetch updated batch and emit event
    const batch = this.getBatch(batchId);
    if (batch) {
      this.emit("batch:synced", batch);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RECOVERY
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Load active batch on startup (crash recovery)
   */
  private loadActiveBatch(): void {
    const activeBatches = this.getActiveBatches();
    if (activeBatches.length > 0) {
      // Use the most recent active batch
      this.currentBatchId = activeBatches[0].id;
      console.log(`[OfflineBatch] Recovered active batch: ${this.currentBatchId}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENT SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Subscribe to offline batch events
   */
  on(event: OfflineBatchEvent, callback: EventCallback): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(callback);
  }

  /**
   * Unsubscribe from offline batch events
   */
  off(event: OfflineBatchEvent, callback: EventCallback): void {
    this.eventListeners.get(event)?.delete(callback);
  }

  /**
   * Emit event to all listeners
   */
  private emit(event: OfflineBatchEvent, batch: OfflineBatch): void {
    this.eventListeners.get(event)?.forEach(callback => {
      try {
        callback(batch);
      } catch (error) {
        console.error(`[OfflineBatch] Error in event listener for ${event}:`, error);
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════════════════

let offlineBatchManager: OfflineBatchManager | null = null;

/**
 * Initialize offline batch manager
 */
export function initOfflineBatchManager(): OfflineBatchManager {
  if (!offlineBatchManager) {
    offlineBatchManager = new OfflineBatchManager();
    console.log("[OfflineBatch] Initialized");
  }
  return offlineBatchManager;
}

/**
 * Get offline batch manager instance
 */
export function getOfflineBatchManager(): OfflineBatchManager {
  if (!offlineBatchManager) {
    return initOfflineBatchManager();
  }
  return offlineBatchManager;
}

/**
 * Destroy offline batch manager (for shutdown)
 */
export function destroyOfflineBatchManager(): void {
  offlineBatchManager = null;
  console.log("[OfflineBatch] Destroyed");
}
