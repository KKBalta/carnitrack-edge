# Testing Offline Batch ACK with Cloud

Use this to verify that Edge calls your Cloud’s `POST /offline-batches/ack` and marks batches as reconciled only after a successful ACK.

---

## 1. Turn on batch ACK on Edge

Edge only calls the batch ACK endpoint when this is enabled:

```bash
export OFFLINE_BATCH_ACK_REQUIRED=true
```

Or add to your `.env`:

```
OFFLINE_BATCH_ACK_REQUIRED=true
```

Point Edge at your Cloud (if not already):

```
CLOUD_API_URL=https://your-cloud.com/api/v1
```

(or `/api/v1/edge` depending on your base path; Edge appends `/edge` for Edge endpoints.)

---

## 2. Create an offline batch (no session + events)

Events go into an **offline batch** when:

- Cloud is unreachable, or  
- Cloud is reachable but there is **no active session** for the device.

**Option A – Use real “no session” flow**

1. Start Edge: `bun run start` (with `OFFLINE_BATCH_ACK_REQUIRED=true` and your `CLOUD_API_URL`).
2. Do **not** create a session for the scale on Cloud (so Edge has no session for that device).
3. Send events from the scale (or script):
   ```bash
   bun run scripts/send-scale-event.ts
   # or SCALE_ID=01 bun run scripts/send-scale-event.ts --count 2
   ```
4. Edge will store them with an offline batch (no `cloudSessionId`).

**Option B – Simulate offline by stopping Cloud**

1. Start Edge with Cloud URL pointing to your Cloud; ensure `OFFLINE_BATCH_ACK_REQUIRED=true`.
2. Stop your Cloud (or block it) so Edge sees “disconnected”.
3. Send events, e.g. `bun run scripts/send-scale-event.ts --count 2`.
4. Restart (or unblock) Cloud so Edge reconnects.

---

## 3. Let Edge sync and call the ACK

Once Cloud is back (or already up in Option A):

- Edge’s sync loop will:
  1. `POST /events/batch` with the pending events.
  2. If the batch response is OK and all events in that batch are synced, call  
     `POST /offline-batches/ack` with that batch’s metadata.
  3. Only after a **successful** ACK response (200) will Edge call `markBatchSynced` for that batch.

So:

- Keep Edge running (and Cloud up) for a bit so the periodic sync runs (default every few seconds).
- Or trigger a sync by waiting for the next batch timer (see `BATCH_INTERVAL_MS` in config).

---

## 4. What to check

**On Edge (logs)**

You should see something like:

- `[SyncService] Batch result: accepted=2, duplicate=0, failed=0 (... events)`
- No `Offline batch ACK failed` warning. If ACK fails, Edge logs the error and still marks the batch synced (fallback).

**On Cloud**

- **`POST /offline-batches/ack`** is called with body containing `batchId`, `deviceId`, `eventIds`, `eventCount`, `totalWeightGrams`, `startedAt`, `endedAt`.
- Response is **200** with JSON: `{ "batchId": "...", "status": "received", "receivedAt": "..." }` (or `"already_received"` on duplicate).

**In Edge DB**

- After ACK success, the batch’s `reconciliation_status` should become `reconciled` (and `reconciled_at` set).
- Check with:
  ```bash
  bun run check-offline-batches.ts
  ```
  You should see `Status: reconciled` for the batch that was ACKed.

---

## 5. Quick test against local mock (no real Cloud)

If you want to test the flow without your real Cloud:

1. Start the mock server (it already implements `POST /offline-batches/ack`):
   ```bash
   bun run src/cloud/mock-rest-server.ts
   ```
   (Default port 4000; set `MOCK_REST_PORT` if needed.)

2. Start Edge pointing at the mock:
   ```bash
   CLOUD_API_URL=http://localhost:4000/api/v1 OFFLINE_BATCH_ACK_REQUIRED=true bun run start
   ```

3. Send events **without** creating a session on the mock (so they go to an offline batch):
   ```bash
   bun run scripts/send-scale-event.ts --count 2
   ```

4. In the mock server logs you should see:
   - Incoming `POST /api/v1/edge/events/batch` with 2 events.
   - Then `POST /api/v1/edge/offline-batches/ack` with the same batch id and `status: received`.

5. Run `bun run check-offline-batches.ts` and confirm the batch is **reconciled**.

---

## 6. Idempotent ACK (optional)

To test that Cloud returns 200 for a **duplicate** ACK:

1. After a batch is synced and ACKed once, from Cloud logs or DB get the `batchId`.
2. Call your ACK endpoint again with the same body (same `batchId`).
3. Cloud should respond **200** with `"status": "already_received"` and the original `receivedAt` (or current time, per your spec). Edge may send the same ACK again on retries; Cloud must not return 4xx for duplicate ACK.

---

## Summary

| Step | Action |
|------|--------|
| 1 | Set `OFFLINE_BATCH_ACK_REQUIRED=true` and your `CLOUD_API_URL`. |
| 2 | Create an offline batch (no session for device, or Cloud down then up). |
| 3 | Send events; let Edge sync (periodic batch timer). |
| 4 | Confirm Edge logs (batch result + no ACK failure), Cloud receives `POST /offline-batches/ack`, and `check-offline-batches.ts` shows the batch as reconciled. |

If you share how you run Edge (env vars, Docker, etc.), the steps can be adapted to your setup (e.g. where to set `OFFLINE_BATCH_ACK_REQUIRED` and `CLOUD_API_URL`).
