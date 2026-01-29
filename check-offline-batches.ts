#!/usr/bin/env bun
/**
 * Quick script to check offline batches in the database
 */

import { getDatabase } from "./src/storage/database.ts";

const db = getDatabase();

console.log("═══════════════════════════════════════════════════════════════");
console.log("OFFLINE BATCHES IN DATABASE");
console.log("═══════════════════════════════════════════════════════════════\n");

// Get all offline batches
const batches = db.prepare(`
  SELECT 
    id,
    device_id,
    started_at,
    ended_at,
    event_count,
    total_weight_grams,
    reconciliation_status,
    cloud_session_id,
    reconciled_at
  FROM offline_batches
  ORDER BY started_at DESC
`).all() as Array<{
  id: string;
  device_id: string;
  started_at: string;
  ended_at: string | null;
  event_count: number;
  total_weight_grams: number;
  reconciliation_status: string;
  cloud_session_id: string | null;
  reconciled_at: string | null;
}>;

console.log(`Total batches: ${batches.length}\n`);

if (batches.length === 0) {
  console.log("No offline batches found in database.");
  process.exit(0);
}

// Show summary
console.log("Summary:");
console.log(`  - Active batches (not ended): ${batches.filter(b => !b.ended_at).length}`);
console.log(`  - Ended batches: ${batches.filter(b => b.ended_at).length}`);
console.log(`  - Pending reconciliation: ${batches.filter(b => b.reconciliation_status === 'pending').length}`);
console.log(`  - Reconciled: ${batches.filter(b => b.reconciliation_status === 'reconciled').length}`);
console.log(`  - Total events: ${batches.reduce((sum, b) => sum + b.event_count, 0)}`);
console.log(`  - Total weight: ${batches.reduce((sum, b) => sum + b.total_weight_grams, 0)}g\n`);

// Show detailed list
console.log("═══════════════════════════════════════════════════════════════");
console.log("DETAILED BATCH LIST");
console.log("═══════════════════════════════════════════════════════════════\n");

for (const batch of batches) {
  console.log(`Batch ID: ${batch.id}`);
  console.log(`  Device: ${batch.device_id}`);
  console.log(`  Started: ${batch.started_at}`);
  console.log(`  Ended: ${batch.ended_at || "Still active"}`);
  console.log(`  Events: ${batch.event_count}`);
  console.log(`  Total Weight: ${batch.total_weight_grams}g`);
  console.log(`  Status: ${batch.reconciliation_status}`);
  if (batch.cloud_session_id) {
    console.log(`  Cloud Session: ${batch.cloud_session_id}`);
  }
  if (batch.reconciled_at) {
    console.log(`  Reconciled At: ${batch.reconciled_at}`);
  }
  
  // Get events for this batch
  const events = db.prepare(`
    SELECT id, weight_grams, received_at, plu_code, product_name
    FROM events
    WHERE offline_batch_id = ?
    ORDER BY received_at ASC
  `).all(batch.id) as Array<{
    id: string;
    weight_grams: number;
    received_at: string;
    plu_code: string | null;
    product_name: string | null;
  }>;
  
  if (events.length > 0) {
    console.log(`  Events (${events.length}):`);
    for (const event of events) {
      console.log(`    - ${event.id.substring(0, 8)}... | ${event.weight_grams}g | ${event.product_name || event.plu_code || 'N/A'} | ${event.received_at}`);
    }
  }
  
  console.log("");
}

// Check for events without batch (shouldn't happen in offline mode)
const orphanedEvents = db.prepare(`
  SELECT COUNT(*) as count
  FROM events
  WHERE offline_mode = 1 AND offline_batch_id IS NULL
`).get() as { count: number } | undefined;

if (orphanedEvents && orphanedEvents.count > 0) {
  console.log(`⚠️  WARNING: ${orphanedEvents.count} offline events without batch ID!`);
}

console.log("═══════════════════════════════════════════════════════════════");
console.log("Done!");
console.log("═══════════════════════════════════════════════════════════════");
