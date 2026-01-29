-- Query to check offline batches and their events
-- Run with: sqlite3 data/carnitrack.db < query-offline-batches.sql

-- Show all offline batches
SELECT 
    id,
    device_id,
    started_at,
    ended_at,
    event_count,
    total_weight_grams,
    reconciliation_status
FROM offline_batches
ORDER BY started_at DESC;

-- Show events linked to batches
SELECT 
    e.id as event_id,
    e.device_id,
    e.offline_batch_id,
    e.weight_grams,
    e.product_name,
    e.received_at,
    b.started_at as batch_started_at
FROM events e
JOIN offline_batches b ON e.offline_batch_id = b.id
ORDER BY e.received_at DESC;
