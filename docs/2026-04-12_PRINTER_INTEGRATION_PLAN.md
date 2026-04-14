# Printer Integration Plan — carnitrack-edge side

**Started:** 2026-04-12
**Updated:** 2026-04-13 (cloud repo discovery complete)
**Status:** Ready to implement Phase 1A (edge local-only, testable against `nc -l 9100`)
**Companion doc (cloud side):** `slaughterhouse_system/docs/2026-04-13_EDGE_PRINTER_INTEGRATION_PLAN.md`

---

## Goal

Replace the current USB-plus-`.bat`-file printing workflow with a clean edge-driven, network-printer pipeline so that:

- Django (cloud) generates the label's TSPL `.prn` content as it already does — **no change to the label generation pipeline.**
- Django enqueues a `PrintJob` row and surfaces it via a new edge API endpoint.
- The `carnitrack-edge` container at the client site pulls the job, streams the `.prn` bytes straight to a TSC TE210 over raw TCP port 9100, and acks the result back.
- Any LAN device (phone, tablet, local Django app) can also enqueue directly on the edge's `POST /api/print-jobs` for offline resilience.
- The same mechanism scales to N printers per site (carcass-line, product-line, etc.) across M tenants without rewiring anything.

The critical design point: **the cloud must never have to know which IP a physical printer is at, and the edge must never have to know which tenant a job belongs to.** Each side has exactly the responsibility its architecture naturally gives it.

---

## Why this is the right time to build it

- Client #2 is being onboarded right now. Getting the data model right before the second site exists costs nothing; getting it right *after* costs migrations and downtime.
- The existing `.bat`-file workflow is fragile, user-visible, and doesn't work when the slaughterhouse floor doesn't have a reliable PC running the Django app locally.
- The edge container is already deployed at the first client, so adding a module to it is a drop-in change, not a new deployment surface.
- The cloud repo has **zero** existing printer-dispatch code (`grep` for `printnode|edge_print|prn_content` finds only label generation and `.bat` downloads). Clean slate, no legacy API contracts to match.

---

## Hardware context (TSC TE210, resolved)

**Transport:** raw TCP to port 9100 (JetDirect). The `.prn` files already produced by Django are plain TSPL, which is exactly what 9100 accepts. No driver, no spooler, no SDK.

**IP discovery:** verified with `nmap -p 9100 --open 192.168.1.0/24` on the client LAN. The TE210 responded with `9100/tcp open jetdirect` at `192.168.1.156` (MAC `00:1B:82:EC:2E:DB`, TSC). The web UI at `http://192.168.1.156` confirms it's a full network-capable printer with an HTTP admin interface.

**Static-IP setup gotcha (2026-04-13):** the TE210 web UI has both a **Wi-Fi** tab and a **Network** (Ethernet) tab. Setting a static IP under the **Wi-Fi** tab does nothing when the cable is plugged into the Ethernet port — the fields apply to a non-existent wireless interface and the printer keeps coming up with its DHCP-assigned IP. **Click the "Network" item in the left sidebar** (one above "Wi-Fi") to configure the actual Ethernet interface.

**Values to enter on the Network tab:**

| Field | Value | Why |
|---|---|---|
| IP Address | `192.168.1.220` | Unused, above typical DHCP pool, memorable. Confirm via `ipconfig /all` that it's not already in use. |
| Subnet Mask | `255.255.255.0` | Standard `/24` LAN. |
| Default Gateway | `192.168.1.1` | Your router. Confirm via `ipconfig`. Printer doesn't need internet, but some firmwares refuse static config with blank gateway. |

After saving and rebooting, verify with `Test-NetConnection 192.168.1.220 -Port 9100`. `TcpTestSucceeded : True` means done.

**Smoke test (PowerShell, run after static IP is set):**

```powershell
$tspl = "SIZE 40 mm,30 mm`r`nCLS`r`nTEXT 10,10,`"3`",0,1,1,`"HELLO CARNITRACK`"`r`nPRINT 1`r`n"
$client = New-Object System.Net.Sockets.TcpClient("192.168.1.220", 9100)
$stream = $client.GetStream()
$bytes = [Text.Encoding]::ASCII.GetBytes($tspl)
$stream.Write($bytes, 0, $bytes.Length)
$stream.Close(); $client.Close()
```

If this prints a test label, the **entire transport layer is pre-validated** before a single line of Bun code is written. The edge's `TcpTransport` just has to do the same thing wrapped in a class.

---

## Multi-tenant model (the big realization from 2026-04-13)

The cloud repo uses **`django-tenants` (schema-per-tenant PostgreSQL)**, not row-level `tenant_id` filtering. Implications:

- Every tenant (`tenants.Client`) has its own Postgres schema. Data isolation is enforced by the database; cross-tenant leakage is structurally impossible without explicit schema switching.
- The Edge API is served at tenant subdomains (`<tenant>.basedomain.com/api/v1/edge/...`). `TenantMainMiddleware` routes each request to the correct schema based on the subdomain.
- `Site`, `EdgeDevice`, `ScaleDevice`, and the new `Printer` model all live **inside** the tenant schema.
- **The edge container has no concept of tenants at all** — it authenticates with `X-Edge-Id`, the middleware resolves that to one specific `EdgeDevice` in one specific tenant schema, and every query from that request is automatically scoped to that tenant's data. The edge never sees or stores a `tenant_id`.

This is cleaner than the original plan's "tenant-blind edge" idea because it's already enforced by infrastructure. No middleware to write, no tenant ID to plumb through Bun code, no accidental cross-tenant bugs possible.

**Mental model:**

```
Tenant A (schema: slaughterhouse_a)
  └── Site "Ankara Main Plant"
        └── EdgeDevice <uuid>  ← one carnitrack-edge container
              ├── ScaleDevice(s)  (existing)
              └── Printer(s)      (new — carcass, product, ...)
                    └── PrintJob(s)  (new field: target_printer / target_role)

Tenant B (schema: slaughterhouse_b)
  └── Site "Istanbul Plant"
        └── EdgeDevice <uuid>  ← a different carnitrack-edge container
              └── Printer(s)
```

Both edges run the same container image, same env var format, same code — only their `X-Edge-Id` differs. Neither knows about the other, and neither can see the other's data even if they tried.

---

## Existing edge architecture (what we're building into)

- **`src/devices/tcp-server.ts`** — DP-401 scales dial *in* to the edge on a TCP port.
- **`src/devices/device-manager.ts`** — tracks device state, persists to SQLite.
- **`src/cloud/rest-client.ts`** — calls `/api/v1/edge/{register,sessions,events,heartbeat,...}` with offline-batch fallback and retry machinery.
- **`src/cloud/sync-service.ts`** — streams events up, polls sessions down, handles reconnect backlog.
- **`src/cloud/offline-batch-manager.ts`** — groups events into batches when cloud is unreachable.
- **`src/index.ts`** — `Bun.serve` HTTP server, admin dashboard at `/`, API at `/api/*`, aggregated heartbeat loop, graceful shutdown.
- **`src/storage/database.ts`** — SQLite schema: `edge_config`, `devices`, `active_sessions_cache`, `offline_batches`, `events`, `plu_cache`, `cloud_connection_log`, `sync_queue`.

No printer-related code exists yet (`grep -r "printer\|9100\|tspl" src/` finds nothing except docs).

---

## Proposed new module: `src/printers/`

Mirrors `src/devices/` structurally but flipped — outbound (edge → printer), not inbound.

```
src/printers/
├── printer-manager.ts     # registry, loaded from `printers` table, hot-reloadable
├── tcp-printer-client.ts  # Bun.connect(host, 9100), stream TSPL bytes, close
├── print-job-queue.ts     # SQLite-backed queue, reuses offline-batch patterns
├── print-dispatcher.ts    # worker loop: pending → dispatch → printed/retry/failed
└── index.ts               # public API: init/destroy/getPrinterManager/enqueueJob
```

### Transport interface (future-proof for USB/other)

```ts
export interface PrinterTransport {
  /** Send raw bytes to the printer. Throws on any failure (network, timeout, reset). */
  send(prn: Buffer): Promise<void>;
  /** Cheap reachability check, used by health/heartbeat. */
  ping(): Promise<boolean>;
}
```

v1 ships only `TcpTransport` (~40 lines). Keeping the interface means a `UsbTransport` or `WindowsSpoolerTransport` can drop in later without touching the dispatcher or the queue.

### Per-printer configuration

Per-printer config loaded from an env var at startup, persisted to the `printers` table:

```
PRINTERS=carcass-01:192.168.1.220:9100:role=carcass,product-01:192.168.1.221:9100:role=product
```

Format: `local_id:host:port[:role=X][:model=Y]`, comma-separated. Same format whether the IP came from router DHCP reservation, TE210 static config, or a USB-RNDIS virtual NIC.

The env var is just the bootstrap; once the printer is known to the cloud (via the inventory push), the cloud's `global_printer_id` is stored in the local `printers.global_printer_id` column and becomes the stable identifier used in print jobs.

---

## New SQLite tables

Added to `src/storage/database.ts`:

```sql
CREATE TABLE IF NOT EXISTS printers (
  printer_id        TEXT PRIMARY KEY,           -- local stable ID, e.g. 'carcass-01'
  global_printer_id TEXT UNIQUE,                -- UUID assigned by cloud after first inventory push
  display_name      TEXT,
  role              TEXT NOT NULL,              -- 'carcass'|'product'|'offal'|'by_product'|'animal'|'generic'
  transport         TEXT NOT NULL DEFAULT 'tcp',
  host              TEXT NOT NULL,
  port              INTEGER NOT NULL DEFAULT 9100,
  model             TEXT,                       -- e.g. 'TE210'
  status            TEXT NOT NULL DEFAULT 'unknown',  -- online|offline|error|unknown
  priority          INTEGER NOT NULL DEFAULT 100,     -- lower = preferred when multiple match a role
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_seen_at      TEXT,
  last_error        TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS print_jobs (
  job_id           TEXT PRIMARY KEY,            -- local UUID
  global_job_id    TEXT UNIQUE,                 -- UUID from cloud (null for local-only jobs)
  target_printer   TEXT,                        -- explicit local printer_id; wins over role
  target_role      TEXT,                        -- 'carcass'|'product'|... when no explicit printer
  resolved_printer TEXT,                        -- set at dispatch time: which printer actually got it
  prn_bytes        BLOB NOT NULL,
  status           TEXT NOT NULL,               -- pending|dispatching|printed|failed|cancelled
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 8,
  next_attempt_at  TEXT,                        -- for exponential backoff scheduling
  error_text       TEXT,
  source           TEXT NOT NULL,               -- 'cloud'|'local-api'
  created_at       TEXT NOT NULL,
  printed_at       TEXT,
  FOREIGN KEY (resolved_printer) REFERENCES printers(printer_id)
);

CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status);
CREATE INDEX IF NOT EXISTS idx_print_jobs_next_attempt ON print_jobs(next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_print_jobs_global_id ON print_jobs(global_job_id);
```

**Why the split between `target_printer` and `target_role`:** cloud sends jobs by *role* ("any carcass printer at this site"), which decouples the cloud from physical hardware changes. Explicit `target_printer` is an override for cases like "reprint on the exact machine that just jammed".

---

## Routing rule (lives in `printer-manager.ts`)

```ts
function resolvePrinter(job: PrintJob): Printer | null {
  // 1. Explicit printer wins (reprints, diagnostics, operator override)
  if (job.target_printer) {
    const p = printers.get(job.target_printer);
    return (p && p.enabled && p.status !== 'error') ? p : null;
  }

  // 2. Role-based routing
  if (!job.target_role) return null;
  const candidates = [...printers.values()]
    .filter(p => p.role === job.target_role
              && p.enabled
              && (p.status === 'online' || p.status === 'unknown'));

  if (candidates.length === 0) return null;

  // 3. Lowest priority wins; status=online beats unknown; ties broken by printer_id
  candidates.sort((a, b) =>
    (a.priority - b.priority)
    || (a.status === 'online' ? -1 : 1)
    || a.printer_id.localeCompare(b.printer_id)
  );
  return candidates[0];
}
```

Adding a backup printer = insert a row with `priority=200`. Hardware swap = `UPDATE printers SET host=...`. Both zero code changes.

---

## Dispatch flow

```
1. Job lands in `print_jobs` (status=pending) — from cloud pull OR local POST /api/print-jobs
2. Dispatcher worker wakes (every ~1s) and picks jobs where status=pending
                                         AND (next_attempt_at IS NULL OR next_attempt_at <= now)
3. For each job:
   a. Resolve printer via routing rule above
   b. If no printer available → leave as pending, retry in 5s (maybe the printer comes back online)
   c. If resolved → UPDATE status='dispatching', resolved_printer=<id>, attempts=attempts+1
   d. Call TcpTransport.send(prn_bytes)
      ├─ Success → UPDATE status='printed', printed_at=now, ack to cloud if global_job_id set
      └─ Failure → capture error_text, schedule exponential backoff
                    (2s, 4s, 8s, 16s, 32s, 60s cap) up to max_attempts
                    If attempts >= max_attempts → UPDATE status='failed', surface in dashboard + heartbeat
```

Exponential backoff reuses the same pattern as the existing event retry loop in `sync-service.ts`.

---

## Job intake — three routes, one queue

1. **Cloud pull.** Extend `src/cloud/sync-service.ts` to poll `GET /api/v1/edge/print-jobs/pending` on the same tick as `edge_sessions`. Ack via `POST /api/v1/edge/print-jobs/<id>/ack`. Reuses offline-batch retry machinery for free.

2. **Local LAN push.** New `POST /api/print-jobs` route on the existing `Bun.serve` in `src/index.ts`. Accepts either raw PRN bytes or `{ target_role, prn_base64 }` JSON. Lets a phone or the Django app on the same LAN enqueue when cloud is unreachable.

3. **Heartbeat reporting.** Extend `buildHeartbeatPayload()` to include a `printers[]` array so cloud sees printer health on every heartbeat tick. The cloud's `edge_heartbeat` endpoint already accepts unknown fields gracefully — we just add the new schema on the Django side.

All three routes insert into the same `print_jobs` table. The dispatcher is agnostic about job origin.

---

## New edge HTTP routes

Added to the `fetch` handler in `src/index.ts` (same `Bun.serve` that already handles `/api/status`, `/api/devices`, etc.):

### `POST /api/print-jobs`

Enqueue a print job from the LAN.

**Request (multipart):** `target_role=carcass` + binary `prn` file, **or** JSON body:
```json
{
  "target_role": "carcass",
  "target_printer": "carcass-01",
  "prn_base64": "U0laRSA0MCBtbSwzMCBtbQ0KQ0xTDQo..."
}
```

**Response:**
```json
{
  "jobId": "01HXYZ...",
  "status": "pending",
  "resolvedPrinter": null
}
```

### `GET /api/print-jobs`

List recent print jobs with filters `?status=pending|printed|failed&limit=50`. Used by the admin dashboard panel.

### `GET /api/printers`

List registered printers with their current runtime status. Used by the admin dashboard panel.

### `POST /api/printers/:id/test`

Fire a small "HELLO" TSPL payload at the printer to verify reachability. Used by operators during site setup.

---

## Phased delivery

### Phase 1A — Edge local-only (session-of-2026-04-13 target)

**Scope:** everything that can be built and tested without touching Django.

- [ ] SQLite migration: add `printers` and `print_jobs` tables in `src/storage/database.ts`
- [ ] `src/printers/tcp-printer-client.ts` — `TcpTransport` class implementing `PrinterTransport`
- [ ] `src/printers/printer-manager.ts` — load from env var `PRINTERS=...`, persist to `printers` table, expose `resolvePrinter(job)`, hot-reload via admin API
- [ ] `src/printers/print-job-queue.ts` — CRUD over `print_jobs` table, exponential-backoff scheduling
- [ ] `src/printers/print-dispatcher.ts` — worker loop, resolves printer, dispatches, handles retry/failure
- [ ] `src/printers/index.ts` — `initPrinters()` / `destroyPrinters()` wired into `main()` and `shutdown()` in `src/index.ts`
- [ ] `POST /api/print-jobs` route on the existing `Bun.serve`
- [ ] `GET /api/print-jobs`, `GET /api/printers`, `POST /api/printers/:id/test` routes
- [ ] Admin dashboard panel: printer list with status, recent jobs with status/errors
- [ ] Env var `PRINTERS=main:127.0.0.1:9100` for local testing
- [ ] Smoke test: `nc -l 9100` in one terminal, `curl -X POST http://localhost:3000/api/print-jobs -F 'target_role=carcass' -F 'prn=@test.prn'` in another, verify bytes arrive at nc
- [ ] Real test: change env to `PRINTERS=main:192.168.1.220:9100`, fire a curl, verify a real label comes out of the TE210
- [ ] Unit tests for routing rule, backoff scheduler, and queue CRUD

**Exit criteria:** a `curl` at `POST /api/print-jobs` with the HELLO TSPL body prints a real label on the TE210, with the job visible in the admin dashboard as `printed`.

### Phase 1B — Cloud models (separate session, Django repo)

**Scope:** all Django-side changes. See companion doc `slaughterhouse_system/docs/2026-04-13_EDGE_PRINTER_INTEGRATION_PLAN.md` for full details.

Summary:
- New `Printer` model in `scales/models.py` (tenant-scoped by schema).
- Extended `PrintJob` in `labeling/models.py`: add `site` FK, `target_printer` FK, `target_role`, `prn_content`, `attempts`, `error_text`, `printed_at`, `edge_received_at`, `global_print_job_id`.
- Three new edge endpoints in `scales/api_views.py` + `scales/api_urls.py`:
  - `GET /api/v1/edge/print-jobs/pending`
  - `POST /api/v1/edge/print-jobs/<id>/ack`
  - `POST /api/v1/edge/printers/inventory`
- Extend `edge_heartbeat` to accept and persist `printers[]` array.
- Django-side dispatcher: when user clicks "Print" in the Django UI, create `PrintJob` with `site=<edge.site>, target_role=<label type>, prn_content=<existing PRN generation output>`. The existing label-generation views are reused as-is.

**Exit criteria:** a Django admin action "Print carcass label" creates a `PrintJob` row that gets picked up by the edge on its next poll.

### Phase 2 — Integration

**Scope:** wire the two sides together.

- [ ] Extend `src/cloud/sync-service.ts` with a print-job poll loop (reuse session-poll cadence)
- [ ] Add `pollPendingPrintJobs()` method to `RestClient`
- [ ] Add `ackPrintJob(jobId, result)` method to `RestClient`
- [ ] Extend `buildHeartbeatPayload()` in `src/index.ts` with `printers[]` array
- [ ] Add `POST /api/v1/edge/printers/inventory` call on edge startup after `register`
- [ ] End-to-end test: user clicks Print in Django → PrintJob row → edge poll picks it up → TE210 prints → edge acks → Django shows "completed"

**Exit criteria:** the full round-trip works with the offline-batch system picking up the slack if the cloud is unreachable during dispatch.

### Phase 3 — Hardening

- Persistent retry across container restarts (already covered by SQLite, just verify with a kill/restart test).
- TSPL status query (`<ESC>!?`) on a separate cycle for real paper-out / head-open detection instead of just TCP-level success.
- Rate-limit guardrails per printer so a runaway job loop can't hammer the hardware.
- Metrics: jobs printed per hour, failure rate, mean dispatch latency — surfaced in admin dashboard.

### Phase 4 — Optional/later

- mDNS/Zeroconf discovery for sites where static IPs weren't configured.
- Claude API diagnostic escalation when a printer has been in `error` state for >N minutes (send log bundle, get plain-English summary in weekly report).
- Multi-edge-per-site (today one edge per site is enforced by the env config; the schema supports N).

---

## Open items before Phase 1A starts

None blocking. Everything else is either resolved or deferred to the appropriate later phase:

- ~~Transport choice (USB vs TCP)~~ — resolved: TCP only, via USB-RNDIS for USB-connected printers.
- ~~Printer discovery~~ — resolved: static IP on the printer itself via the Network tab in the TE210 web UI.
- ~~Multi-tenant model~~ — resolved: django-tenants handles it; edge stays tenant-blind.
- ~~Role catalog~~ — resolved: global enum, mirrors `LabelTemplate.TARGET_ITEM_TYPE_CHOICES` (`carcass`, `meat_cut`, `offal`, `by_product`, `animal`). Edge uses these strings directly.
- ~~Existing Django endpoints to match~~ — resolved: none exist, we're designing them clean.
- ~~Host OS target~~ — not a blocker for Phase 1A since local-only testing is host-agnostic; will be decided empirically before Phase 2 deploy.

---

## Resume checklist

- [x] Verify TE210 reachable at port 9100 (nmap confirmed)
- [x] Record printer IP (`192.168.1.156` currently, will pin to `192.168.1.220` static)
- [x] Explore edge repo structure
- [x] Explore cloud repo structure (django-tenants, existing endpoints, existing PrintJob model)
- [x] Write edge-side plan (this doc)
- [ ] Write cloud-side plan (companion doc)
- [ ] **Fix the TE210 Network-vs-Wi-Fi tab issue and pin the static IP**
- [ ] Run the PowerShell smoke test to confirm raw TSPL prints a test label
- [ ] Start Phase 1A implementation
