# Test checklist – Heartbeat & Cloud API contract

Use this checklist to verify acceptance criteria after deployment or local runs.

## 1. Edge identity (UUID from `/register`)

- [ ] **First boot (no saved edgeId):** Edge calls `POST /register` with `edgeId: null` and receives a UUID. Log shows: `[REGISTRATION] ✓ Edge registered successfully (edgeId=...)`.
- [ ] **Next boot (saved edgeId):** Edge calls `POST /register` with the persisted UUID. Same edgeId is kept. Log shows registration success with that edgeId.
- [ ] **Stale edgeId (400/404):** If backend returns 400 or 404 for the stored edgeId, Edge clears it and registers again with `edgeId: null`. Log shows clearing and retry.
- [ ] No custom non-UUID edge IDs are generated or sent.

**Sample log (success):**
```
[REGISTRATION] ✓ Edge registered successfully (edgeId=550e8400-e29b-41d4-a716-446655440000)
[REGISTRATION]   Endpoint: http://localhost:8000/api/v1/edge
[REGISTRATION]   Site: site-001 / Test Site
```

---

## 2. Session poll and device → session binding

- [ ] Edge polls `GET /sessions?device_ids=SCALE-01,...` at the configured interval (from `/config` or fallback).
- [ ] Log shows: `[SessionCache] Poll result: N session(s) for devices [SCALE-01, ...]`.
- [ ] When Cloud has an active session for a device, log shows mapping (e.g. device→session mapping changes when sessions start/end).
- [ ] Events from that device are sent with the correct `cloudSessionId` when a session exists.

**Sample log:**
```
[SessionCache] Poll result: 1 session(s) for devices [SCALE-01]
[SessionCache] Device→session mapping changes: SCALE-01: — → abc-session-uuid
```

---

## 3. Weight events in active cloud session

- [ ] With an active session for SCALE-01 (started from UI), send a weight event from the scale (or simulate).
- [ ] Event is stored with `cloudSessionId` set. Log shows: `Event stored (localEventId=..., deviceId=SCALE-01, cloudSessionId=..., offlineBatchId=—)`.
- [ ] Event is delivered to Cloud and appears in the active session (not orphaned). Sync log shows: `Event accepted (localEventId=..., cloudEventId=..., deviceId=..., cloudSessionId=...)`.

---

## 4. Aggregated heartbeat (POST `/heartbeat`)

- [ ] Edge sends `POST /heartbeat` periodically. Interval is config-driven (from `GET /config` or register response).
- [ ] Log shows: `[HEARTBEAT] ✓ POST /heartbeat ok (edgeId=..., devices=N, health=ok|degraded|error)`.
- [ ] Payload includes `version`, `uptimeSec`, `health`, and `devices[]` with at least `deviceId`, `status`, `lastHeartbeatAt` (and optional `lastEventAt`, `globalDeviceId`, `deviceType`).
- [ ] Request includes header `X-Edge-Id: <UUID>`.

**Sample log:**
```
[HEARTBEAT] ✓ POST /heartbeat ok (edgeId=550e8400-..., devices=2, health=ok)
```

---

## 5. Edge/printers show offline after Edge stop

- [ ] With Edge running and devices connected, Cloud shows edge/printers online (or last heartbeat recent).
- [ ] Stop the Edge process (SIGTERM/SIGINT). Wait for Cloud’s timeout window (e.g. 2–3 missed heartbeats).
- [ ] Cloud shows edge/printers as offline (or last seen timestamp in the past).

---

## 6. Edge restart → online again

- [ ] Restart Edge. Registration succeeds (re-use of persisted edgeId).
- [ ] Heartbeat resumes. Log shows: `[HEARTBEAT] ✓ POST /heartbeat ok ...`.
- [ ] Cloud shows edge (and devices) online again shortly after heartbeat interval.

---

## 7. No duplicate `/edge/` in paths

- [ ] All Edge API requests use a base URL with exactly one `/edge` (e.g. `.../api/v1/edge/register`, `.../api/v1/edge/heartbeat`). No `.../edge/edge/...` in logs or proxy/capture.

---

## 8. No CSRF / cookie auth

- [ ] Edge does not send CSRF tokens or session cookies. Auth is `X-Edge-Id` only (machine-to-machine).

---

## 9. Event delivery and batch

- [ ] Single event POST: log shows `Event accepted` or `Event duplicate` with `localEventId` and `cloudEventId`.
- [ ] Batch POST: log shows `Batch result: accepted=N, duplicate=M, failed=0 (... events)`.
- [ ] Duplicate responses do not cause double-counting or duplicate processing.

---

## 10. Device connect/disconnect logging

- [ ] On scale connect: log shows `Device connected (deviceId=..., edgeId=..., globalId=...)`.
- [ ] On scale disconnect: log shows `Device disconnected (deviceId=..., reason=..., edgeId=...)`.

---

## Running contract tests

```bash
bun test tests/edge-api-contract.test.ts
```

Covers: URL builder (no `edge/edge`), UUID validation, registration lifecycle, 401 → re-register, event POST with `X-Edge-Id`, and POST `/heartbeat` URL and `X-Edge-Id` header.
