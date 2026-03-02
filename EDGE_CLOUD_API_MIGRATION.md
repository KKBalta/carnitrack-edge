# Edge ↔ Cloud API alignment – migration note for ops

## Summary

Edge was updated to align with the Django Cloud API contract: aggregated heartbeat as the primary connectivity endpoint, config-driven intervals, and robust registration/session/event flow. Backward compatibility is preserved (e.g. legacy `POST /devices/status` remains).

## Environment / config

- **`CLOUD_API_URL`**  
  Base URL for the Cloud API (e.g. `https://api.example.com/api/v1` or `https://api.example.com/api/v1/edge`).  
  Edge normalizes this so there is exactly one `/edge` segment; no change required for existing deployments.

- **Optional overrides** (defaults in code; can be overridden by Cloud via `GET /config`):
  - `SESSION_POLL_INTERVAL_MS` – fallback session poll interval (ms) if Cloud does not send `sessionPollIntervalMs`.
  - No new mandatory env vars. Cloud can return `sessionPollIntervalMs`, `heartbeatIntervalMs`, `workHoursStart`, `workHoursEnd`, `timezone` in `GET /config` (or in register response `config`); Edge uses these at runtime.

## Endpoints (no duplicate `/edge/`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/register` | POST | Edge registration; returns UUID `edgeId`. |
| `/sessions` | GET | Active sessions for devices (`?device_ids=...`). |
| `/events` | POST | Single event. |
| `/events/batch` | POST | Batch of events. |
| `/config` | GET | Runtime config (intervals, work hours, timezone). |
| `/devices/status` | POST | Legacy device status (kept for compatibility). |
| `/heartbeat` | POST | **New primary** – aggregated edge + device status. |

All authenticated calls use header: **`X-Edge-Id: <UUID>`** (from `/register`).

## Behaviour changes

1. **Registration**  
   First boot: `POST /register` with `edgeId: null`. Edge persists the returned UUID and reuses it on later boots. If the backend returns 400/404 for a stale `edgeId`, Edge clears the stored id and registers again with `edgeId: null`.

2. **Session polling**  
   Edge polls `GET /sessions?device_ids=...` at an interval from Cloud config (or fallback). Device → `cloudSessionId` mapping is kept in memory and used for event binding.

3. **Aggregated heartbeat**  
   Edge sends `POST /heartbeat` periodically (interval from Cloud config). Payload includes edge `version`, `uptimeSec`, `health`, and a `devices[]` array (deviceId, status, lastHeartbeatAt, lastEventAt, etc.). On non-2xx, Edge retries with exponential backoff and jitter.

4. **Events**  
   Events use `cloudSessionId` when an active session exists for the device; otherwise they are marked offline with `offlineBatchId`. Local event IDs are UUIDs; batch responses are handled without double-counting duplicates.

5. **Auth recovery**  
   If any authenticated request returns 401 (invalid/unknown edge), Edge triggers re-registration, updates the stored `X-Edge-Id`, and retries. Process does not crash on network/API errors.

## Checklist for deploy

- [ ] Backend exposes `POST /heartbeat` and accepts the payload described above (and returns 2xx on success).
- [ ] Backend `GET /config` can return `sessionPollIntervalMs`, `heartbeatIntervalMs` (and optionally work hours / timezone).
- [ ] No duplicate `/edge/` in URLs (e.g. base is `/api/v1/edge`, paths are `/register`, `/sessions`, etc.).
- [ ] No CSRF or cookie auth required for Edge (machine-to-machine, `X-Edge-Id` only).

## Rollback

If you need to run an older Edge build: ensure the backend still supports the endpoints that build used. Legacy `POST /devices/status` is still sent by this Edge version for compatibility.
