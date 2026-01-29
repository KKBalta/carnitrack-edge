# CarniTrack Edge - Cloud Integration Quick Reference

Quick reference for common integration scenarios.

## Message Types Quick Reference

### Edge → Cloud

| Message | Payload Fields | Cloud Action |
|---------|---------------|--------------|
| `register` | `edgeId`, `siteId`, `siteName`, `version`, `capabilities` | Assign/validate Edge ID, send active sessions |
| `device_connected` | `deviceId`, `globalDeviceId`, `sourceIp`, `deviceType` | Register device, check for active session |
| `device_disconnected` | `deviceId`, `reason`, `timestamp` | Update device status |
| `device_heartbeat` | `deviceId`, `globalDeviceId`, `status`, `heartbeatCount`, `timestamp` | Update last seen |
| `event` | `localEventId`, `deviceId`, `cloudSessionId`, `pluCode`, `weightGrams`, `barcode`, `scaleTimestamp` | Process event, send `event_ack` |
| `event_batch` | `events[]` | Process each event, send individual `event_ack` |
| `offline_batch_end` | `batchId`, `deviceId`, `startedAt`, `endedAt`, `eventCount`, `totalWeightGrams` | Create reconciliation task |

### Cloud → Edge

| Message | Payload Fields | Edge Action |
|---------|---------------|-------------|
| `session_started` | `cloudSessionId`, `deviceId`, `animalId`, `animalTag`, `animalSpecies`, `operatorId` | Cache session, tag future events |
| `session_ended` | `cloudSessionId`, `deviceId`, `reason` | Remove from cache |
| `session_paused` | `cloudSessionId`, `deviceId` | Update status to "paused" |
| `session_resumed` | `cloudSessionId`, `deviceId` | Update status to "active" |
| `event_ack` | `localEventId`, `cloudEventId`, `status` | Mark event as synced |
| `event_rejected` | `localEventId`, `reason` | Mark event as failed |
| `plu_updated` | `pluCode`, `name`, `price`, etc. | Update local PLU cache |

## Common Integration Patterns

### 1. Edge Connects

```typescript
// Edge sends
{
  type: "register",
  payload: { edgeId: null, siteId: null, ... }
}

// Cloud responds (HTTP or WebSocket)
POST /api/edge/register
Response: { edgeId: "uuid", siteId: "site-01" }

// Cloud sends active sessions
{
  type: "session_started",
  payload: { cloudSessionId: "...", deviceId: "SCALE-01", ... }
}
```

### 2. Operator Starts Session

```typescript
// Cloud sends to Edge
{
  type: "session_started",
  payload: {
    cloudSessionId: "session-uuid",
    deviceId: "SCALE-01",
    animalId: "animal-uuid",
    animalTag: "A-123",
    animalSpecies: "Dana",
    operatorId: "operator-uuid"
  }
}

// Edge caches session
// Future events automatically tagged with cloudSessionId
```

### 3. Scale Sends Weight Event

```typescript
// Edge sends to Cloud (real-time)
{
  type: "event",
  payload: {
    localEventId: "edge-event-uuid",
    deviceId: "SCALE-01",
    cloudSessionId: "session-uuid",  // Auto-tagged
    pluCode: "00001",
    productName: "KIYMA",
    weightGrams: 1500,
    barcode: "1234567890123",
    scaleTimestamp: "2026-01-30T10:00:00Z"
  }
}

// Cloud processes and acknowledges
{
  type: "event_ack",
  payload: {
    localEventId: "edge-event-uuid",
    cloudEventId: "cloud-event-uuid",
    status: "accepted"
  }
}
```

### 4. Cloud Disconnects (Offline Mode)

```typescript
// Edge detects disconnect
// Automatically starts offline batch

// Edge sends batch start
{
  type: "offline_batch_start",
  payload: {
    batchId: "batch-uuid",
    deviceId: "SCALE-01",
    startedAt: "2026-01-30T10:00:00Z"
  }
}

// Events continue to be captured
// Tagged with offlineBatchId instead of cloudSessionId
```

### 5. Cloud Reconnects (Sync Backlog)

```typescript
// Edge detects reconnect
// Ends offline batch

// Edge sends batch end
{
  type: "offline_batch_end",
  payload: {
    batchId: "batch-uuid",
    deviceId: "SCALE-01",
    startedAt: "2026-01-30T10:00:00Z",
    endedAt: "2026-01-30T10:15:00Z",
    eventCount: 25,
    totalWeightGrams: 37500
  }
}

// Edge sends events in batch
{
  type: "event_batch",
  payload: {
    events: [
      { localEventId: "...", offlineBatchId: "batch-uuid", ... },
      { localEventId: "...", offlineBatchId: "batch-uuid", ... },
      // ... more events
    ]
  }
}

// Cloud reconciles batch with session
```

### 6. Operator Ends Session

```typescript
// Cloud sends to Edge
{
  type: "session_ended",
  payload: {
    cloudSessionId: "session-uuid",
    deviceId: "SCALE-01",
    reason: "completed"
  }
}

// Edge removes from cache
// Future events won't be tagged with this session
```

## Payload Schemas

### Event Payload (Edge → Cloud)

```typescript
{
  localEventId: string;           // Edge-generated UUID
  deviceId: string;                // "SCALE-01"
  globalDeviceId: string;          // "SITE01-SCALE-01"
  cloudSessionId: string | null;  // Session ID if available
  offlineMode: boolean;           // true if captured offline
  offlineBatchId: string | null;  // Batch ID if offline
  pluCode: string;                // "00001"
  productName: string;            // "KIYMA"
  weightGrams: number;             // 1500
  barcode: string;                // "1234567890123"
  scaleTimestamp: string;          // ISO 8601
  receivedAt: string;              // ISO 8601
}
```

### Session Started Payload (Cloud → Edge)

```typescript
{
  cloudSessionId: string;    // UUID
  deviceId: string;          // "SCALE-01"
  animalId: string;          // UUID
  animalTag: string;         // "A-123"
  animalSpecies: string;     // "Dana"
  operatorId: string;        // UUID
}
```

### Event Acknowledgment Payload (Cloud → Edge)

```typescript
{
  localEventId: string;      // From Edge event
  cloudEventId: string;      // Cloud-generated UUID
  status: "accepted" | "duplicate";
}
```

## Error Scenarios

### Duplicate Event

```typescript
// Cloud detects duplicate
{
  type: "event_ack",
  payload: {
    localEventId: "edge-event-uuid",
    cloudEventId: "existing-cloud-uuid",
    status: "duplicate"
  }
}
```

### Invalid Event

```typescript
// Cloud rejects event
{
  type: "event_rejected",
  payload: {
    localEventId: "edge-event-uuid",
    reason: "Invalid PLU code"
  }
}
```

### Session Not Found

```typescript
// Cloud rejects event (if session required)
{
  type: "event_rejected",
  payload: {
    localEventId: "edge-event-uuid",
    reason: "Session not found"
  }
}
```

## WebSocket Connection Flow

```
1. Edge connects → ws://cloud/edge
   Headers: X-Edge-Id, X-Site-Id

2. Edge sends → register
   Payload: { edgeId: null, ... }

3. Cloud responds → HTTP POST /api/edge/register
   Response: { edgeId: "uuid", siteId: "site-01" }

4. Cloud sends → session_started (for each active session)
   Edge caches sessions

5. Connection maintained → ping/pong every 30s

6. Events stream → event → event_ack

7. If disconnect → Edge queues messages, auto-reconnects

8. On reconnect → Edge flushes queue, sends offline batches
```

## Database Tables (Cloud Side)

### Events Table

```sql
CREATE TABLE events (
  id UUID PRIMARY KEY,
  edge_id VARCHAR(255),
  local_event_id VARCHAR(255) UNIQUE,  -- From Edge
  device_id VARCHAR(255),
  cloud_session_id UUID,
  offline_batch_id UUID,
  plu_code VARCHAR(50),
  product_name VARCHAR(255),
  weight_grams INTEGER,
  barcode VARCHAR(50),
  scale_timestamp TIMESTAMP,
  received_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Sessions Table

```sql
CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  device_id VARCHAR(255),
  animal_id UUID,
  animal_tag VARCHAR(50),
  animal_species VARCHAR(50),
  operator_id UUID,
  status VARCHAR(20),
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Offline Batches Table

```sql
CREATE TABLE offline_batches (
  id UUID PRIMARY KEY,
  edge_id VARCHAR(255),
  batch_id VARCHAR(255) UNIQUE,  -- From Edge
  device_id VARCHAR(255),
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  event_count INTEGER,
  total_weight_grams INTEGER,
  reconciliation_status VARCHAR(20),
  cloud_session_id UUID,  -- Assigned during reconciliation
  reconciled_at TIMESTAMP,
  reconciled_by UUID,
  created_at TIMESTAMP DEFAULT NOW()
);
```

## Testing Checklist

- [ ] Edge connects successfully
- [ ] Registration works
- [ ] Active sessions are sent on connection
- [ ] Events are received in real-time
- [ ] Event acknowledgments work
- [ ] Offline batches are handled
- [ ] Session start/end works
- [ ] Reconnection works
- [ ] Message queue flushes correctly
- [ ] Duplicate detection works
- [ ] Error handling works

## Common Issues

### Edge Not Connecting

- Check WebSocket URL in Edge config
- Verify Cloud WebSocket server is running
- Check firewall/network rules
- Verify TLS certificate (if using wss://)

### Events Not Being Acknowledged

- Check Cloud is processing events
- Verify `event_ack` message format
- Check `localEventId` matches
- Verify WebSocket connection is open

### Sessions Not Caching

- Verify `session_started` message format
- Check `deviceId` matches registered device
- Verify Edge is receiving messages
- Check Edge logs for errors

### Offline Batches Not Syncing

- Verify `offline_batch_end` is sent
- Check events have `offlineBatchId`
- Verify Cloud processes batch events
- Check reconciliation logic

---

**See**: `CLOUD_INTEGRATION.md` for detailed documentation
