# Prompt for Cloud Team: Offline Batch ACK & Event Idempotency

**Purpose:** Eliminate duplicate events when CarniTrack Edge retries after timeouts or connection drops. Edge will only consider a batch “synced” after Cloud explicitly acknowledges it. Please implement the following on the Cloud side.

---

## 1. New endpoint: Offline batch ACK

**Add:** `POST /api/v1/edge/offline-batches/ack`

Edge sends this **after** successfully uploading events for an offline batch. Cloud must acknowledge receipt so Edge can mark the batch as reconciled and stop retrying those events.

### Request (JSON body)

| Field              | Type     | Description                                      |
|--------------------|----------|--------------------------------------------------|
| `batchId`          | string   | UUID of the offline batch                        |
| `deviceId`         | string   | Device identifier (e.g. `SCALE-01`)              |
| `eventIds`         | string[] | Array of `localEventId` values in this batch     |
| `eventCount`       | number   | Number of events in the batch                    |
| `totalWeightGrams` | number   | Sum of weight for all events in the batch       |
| `startedAt`        | string   | ISO 8601 – batch start time                      |
| `endedAt`          | string   | ISO 8601 – batch end time                        |

Example:

```json
{
  "batchId": "550e8400-e29b-41d4-a716-446655440000",
  "deviceId": "SCALE-01",
  "eventIds": ["evt-uuid-1", "evt-uuid-2"],
  "eventCount": 2,
  "totalWeightGrams": 5000,
  "startedAt": "2026-02-20T10:00:00Z",
  "endedAt": "2026-02-20T10:15:00Z"
}
```

### Response (always HTTP 200 for success and duplicate ACK – idempotent)

**First time this `batchId` is acknowledged:**

```json
{
  "batchId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "received",
  "receivedAt": "2026-02-20T10:16:00Z"
}
```

**When the same `batchId` is sent again (retry / duplicate ACK):**

```json
{
  "batchId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "already_received",
  "receivedAt": "2026-02-20T10:15:30Z"
}
```

- Use **`receivedAt`** as the time Cloud first received the ACK (for `already_received`, return that original time).
- **Idempotency:** For a given `batchId`, return **200** with either `received` or `already_received`; do not return 4xx for duplicate ACKs.
- Optionally: persist or log batch ACKs for reconciliation and auditing.
- Optionally: validate that `eventIds` match events already stored for this batch; if you do strict validation and something is wrong, you may return 4xx with a clear message (document the contract so Edge can handle it).

---

## 2. Event batch idempotency by `localEventId`

**Existing endpoint:** `POST /api/v1/edge/events/batch` (or your equivalent batch event ingestion endpoint)

**Requirement:** Treat **`localEventId`** as the idempotency key for each event.

- If an event with the same `localEventId` has **already been stored**, do **not** create a new event.
- Return a result for that event with **`status: "duplicate"`** and the **existing `cloudEventId`**, for example:

  ```json
  {
    "localEventId": "edge-event-uuid-123",
    "cloudEventId": "existing-cloud-event-uuid",
    "status": "duplicate"
  }
  ```

- For newly accepted events, keep returning e.g. `status: "accepted"` (or your current success status) and the new `cloudEventId`.

This way, when Edge retries the same batch after a timeout or connection drop, Cloud will respond with “duplicate” for already-stored events and Edge will not double-count or re-insert them.

---

## 3. Summary checklist for Cloud

- [ ] **Implement `POST /api/v1/edge/offline-batches/ack`**
  - Accept the JSON body above.
  - Store or log the batch ACK (e.g. by `batchId`).
  - Return 200 with `{ batchId, status: "received" | "already_received", receivedAt }`.
  - Make the endpoint idempotent by `batchId` (duplicate ACK → `already_received` + original `receivedAt`).
- [ ] **Ensure event batch endpoint is idempotent by `localEventId`**
  - On duplicate `localEventId`, return `status: "duplicate"` and existing `cloudEventId`; do not create a new event.
- [ ] **Document** any extra validation (e.g. `eventIds` vs stored events) and error responses (4xx) so Edge can handle them in a future release if needed.

---

## 4. Edge behavior (for context)

- Edge uploads events via the existing batch endpoint, then calls **`POST /offline-batches/ack`** for each batch whose events were all successfully accepted or marked duplicate.
- Edge marks a batch as “synced” only after a **successful** batch ACK response (200).
- If the ACK request fails or times out, Edge will retry the batch (and may re-send the same events); idempotency by `localEventId` and by `batchId` ensures no duplicates and consistent state.

If you have questions or need a different path prefix (e.g. without `/api/v1/edge/`), we can align on that.
