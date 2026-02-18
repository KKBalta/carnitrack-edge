# Edge API v1 contract – migration notes

## Summary

The Edge client was updated to match the backend API contract: single `/api/v1/edge/` prefix, no duplicated `/edge/`, strict UUID for `edgeId`, and defined error-handling behavior.

## Config / env

- **`CLOUD_API_URL`**  
  - Can be either the API root (e.g. `https://api.carnitrack.com/api/v1`) or the Edge base (e.g. `https://api.carnitrack.com/api/v1/edge`).  
  - The client normalizes internally and builds URLs with exactly one `/edge` segment.  
  - No change required for existing deployments; both forms are supported.

## Endpoint paths (client → backend)

| Old (duplicated)           | New (current)        |
|----------------------------|----------------------|
| `/api/v1/edge/edge/register`      | `/api/v1/edge/register`      |
| `/api/v1/edge/edge/sessions`      | `/api/v1/edge/sessions`      |
| `/api/v1/edge/edge/events`       | `/api/v1/edge/events`        |
| `/api/v1/edge/edge/events/batch` | `/api/v1/edge/events/batch`  |
| `/api/v1/edge/edge/config`       | `/api/v1/edge/config`       |
| `/api/v1/edge/edge/devices/status`| `/api/v1/edge/devices/status`|

## Edge identity (UUID only)

- **First registration:** send `edgeId: null` in the register body; backend returns a UUID.  
- **Re-registration:** send the persisted UUID in the body; backend validates and returns the same (or updated) identity.  
- **All non-register requests:** send `X-Edge-Id: <uuid>` header.  
- Custom IDs (e.g. `edge-<timestamp>-<n>`) are no longer generated or sent.  
- On boot, if the stored `edgeId` is missing or not a valid UUID, it is cleared and registration is run as first-time (e.g. `edgeId: null`).

## Error handling

- **400** on register (e.g. invalid `edgeId` format): clear local `edgeId`, retry once as first registration (with backoff).  
- **401** with “Missing/Invalid X-Edge-Id” on other endpoints: re-register, persist new UUID, retry the request once.  
- **404** “Edge not found” during register: treat as first registration (clear, send `edgeId: null`, retry).  
- Registration is limited to a maximum number of attempts with backoff to avoid infinite retries.

## Tests

- **`tests/edge-api-contract.test.ts`**  
  - URL builder: no duplicated `/edge/` for base and child paths.  
  - UUID validation: valid UUIDs accepted, custom IDs and malformed values rejected.  
  - Registration: first registration (edgeId null), re-registration with UUID, 400 → RestResponseError, 401 → ensureEdgeIdentity + retry.  
  - Event POST: request includes `X-Edge-Id` UUID header and URL has no `edge/edge`.

Run contract tests only:

```bash
bun test tests/edge-api-contract.test.ts
```

## Final checklist

- [x] All Edge API calls use `/api/v1/edge/<child>` (no duplicated `/edge/`).
- [x] Child paths: `register`, `sessions`, `events`, `events/batch`, `config`, `devices/status`.
- [x] First registration sends `edgeId: null`; backend returns UUID; client persists it.
- [x] Subsequent requests send `X-Edge-Id: <persisted-uuid>`.
- [x] No custom edge IDs generated; UUID validation before using stored `edgeId`.
- [x] 400 on register → clear and retry as first registration; 401 → re-register and retry once; 404 on register → fresh register.
- [x] Max registration attempts and backoff to prevent infinite retry loops.
- [x] On successful register: log `edgeId` and endpoint (base URL) only.
- [x] Mock REST server updated to new paths and strict UUID for register.
- [x] Contract tests added/updated and passing.
