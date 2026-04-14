# Full-Stack Printer Implementation Map

**Date:** 2026-04-13 (continued from Claude Code session)
**Status:** Analysis complete — ready for Phase 1A implementation
**Repos:** `Carnitrack_EDGE` (Bun/TypeScript) + `Core/slaughterhouse_system` (Django)

---

## 1. Architecture overview — what exists today vs what we're building

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                               DJANGO CLOUD                                       │
│  (tenant.carnitrack.com/api/v1/edge/*)                                          │
│                                                                                  │
│  EXISTING:                          NEW (Phase 1B):                              │
│  ┌──────────────┐                   ┌───────────────────────────┐               │
│  │ scales/      │                   │ scales/models.py          │               │
│  │  models.py   │                   │  + Printer model (NEW)    │               │
│  │  - Site      │                   │                           │               │
│  │  - EdgeDevice│                   │ labeling/models.py        │               │
│  │  - ScaleDevice                   │  + PrintJob extensions    │               │
│  │              │                   │  (site, target_role,      │               │
│  │ scales/      │                   │   prn_content, attempts,  │               │
│  │  api_views.py│                   │   printed_at, etc.)       │               │
│  │  - register  │                   │                           │               │
│  │  - sessions  │                   │ scales/api_views.py       │               │
│  │  - events    │                   │  + edge_pending_print_jobs│               │
│  │  - heartbeat │                   │  + edge_ack_print_job     │               │
│  │  - config    │                   │  + edge_printer_inventory │               │
│  │  - batch     │                   │  + heartbeat printers[]   │               │
│  │  - ack       │                   │                           │               │
│  └──────────────┘                   │ labeling/services.py      │               │
│                                     │  + enqueue_print_job()    │               │
│  labeling/                          └───────────────────────────┘               │
│  ├── models.py (LabelTemplate, PrintJob, AnimalLabel, CustomLabel)              │
│  └── utils.py  (generate_tspl_prn_label, generate_bat_file_content, ...)        │
│         ↓ generates TSPL/PRN content, stores in AnimalLabel.prn_content         │
└─────────────────────────────────────────────────────────────────────────────────┘
                            │ REST (X-Edge-Id auth)
                            ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          CARNITRACK EDGE (Bun)                                   │
│  (carnitrack-edge container on site LAN)                                        │
│                                                                                  │
│  EXISTING:                          NEW (Phase 1A):                              │
│  ┌──────────────┐                   ┌───────────────────────────┐               │
│  │ src/devices/ │                   │ src/printers/             │               │
│  │  tcp-server  │                   │  tcp-printer-client.ts    │               │
│  │  device-mgr  │                   │  printer-manager.ts       │               │
│  │  scale-parser│                   │  print-job-queue.ts       │               │
│  │  event-proc  │                   │  print-dispatcher.ts      │               │
│  │              │                   │  index.ts                 │               │
│  │ src/cloud/   │                   │                           │               │
│  │  rest-client │                   │ src/storage/database.ts   │               │
│  │  sync-service│                   │  + printers table         │               │
│  │  offline-mgr │                   │  + print_jobs table       │               │
│  │              │                   │                           │               │
│  │ src/storage/ │                   │ src/index.ts              │               │
│  │  database.ts │                   │  + POST /api/print-jobs   │               │
│  │              │                   │  + GET  /api/print-jobs   │               │
│  │ src/index.ts │                   │  + GET  /api/printers     │               │
│  │  Bun.serve   │                   │  + POST /api/printers/:id │               │
│  │  admin HTML  │                   │    /test                  │               │
│  └──────────────┘                   └───────────────────────────┘               │
└─────────────────────────────────────────────────────────────────────────────────┘
                            │ TCP raw 9100
                            ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      TSC TE210 PRINTER                                            │
│  192.168.1.220:9100  (HP JetDirect / TSPL raw)                                  │
│                                                                                  │
│  Accepts: raw TSPL byte stream over TCP                                         │
│  Returns: 1-byte or 8-byte status on immediate commands                         │
│  No auth, no TLS, no framing, no job IDs, no completion callbacks               │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. PRN generation pipeline — end to end

### Current flow (legacy .bat download)

```
1. User clicks "Print" in Django UI
2. labeling/utils.py → generate_tspl_prn_label(animal)
   - Reads animal data, order data, company info from tenant
   - Formats Turkish text via format_turkish_text_for_printer()
     (mode from Client.printer_turkish_mode: unicode/ascii/codepage1254)
   - Builds TSPL template string:
     SIZE 97.5 mm, 260 mm
     GAP 3 mm, 0 mm
     DIRECTION 0,0 / CODEPAGE 1254
     TEXT ... (4 label copies per sheet, rotated 90°)
     QRCODE ... (tracking URL per animal)
     PRINT 1,1
   - Converts \n → \r\n for TSPL compatibility
3. labeling/utils.py → generate_bat_file_content(prn)
   - Base64-encodes PRN bytes
   - Embeds in PowerShell here-string inside .bat file
   - PS1 does: Win32 OpenPrinter → WritePrinter → ClosePrinter
   - Fallbacks: copy /b to UNC share, copy /b to LPT1
4. AnimalLabel.prn_content = raw TSPL text
   AnimalLabel.bat_content = .bat wrapper
5. User downloads .bat, double-clicks → label prints
```

### New flow (edge dispatch — what we're building)

```
1. User clicks "Print to Edge" in Django UI  (or auto on label creation)
2. labeling/utils.py → generate_tspl_prn_label(animal)
   - SAME PIPELINE — zero changes to PRN generation
3. labeling/services.py → enqueue_print_job(
     site=edge.site,
     target_role="carcass",
     prn_content=animal_label.prn_content
   )
   - Creates PrintJob(status="pending", dispatch_mode="edge")
4. Edge polls GET /api/v1/edge/print-jobs/pending (every ~5s)
   - Returns [{jobId, targetRole, prnContent, ...}]
5. Edge print-dispatcher.ts:
   a. Resolves printer by role ("carcass" → printers where role=carcass, priority ASC)
   b. Pre-flight: sends ESC!? (0x1B 0x21 0x3F) → reads 1 byte → 0x00 = ready
   c. Sends prn_content bytes over TCP:9100
   d. Polls ESC!? every 500ms until 0x00 × 3 consecutive (or timeout)
   e. On success: POST /api/v1/edge/print-jobs/{id}/ack {status: "completed"}
   f. On failure: requeue with exponential backoff, ack {status: "failed"}
6. Django marks PrintJob.status="completed", PrintJob.printed_at=now
```

---

## 3. Django model landscape (labeling app)

### Existing models — no changes needed

| Model | Key fields | Role |
|-------|-----------|------|
| `LabelTemplate` | `name`, `template_data` (JSON), `target_item_type` (carcass\|meat_cut\|offal\|by_product\|animal), `label_format` (prn\|pdf\|both) | Layout definition |
| `PrintJob` | `label_template` (FK), `item_type`, `item_id` (UUID), `quantity`, `printed_by`, `status` (pending\|completed\|failed) | **Skeletal — needs extension** |
| `AnimalLabel` | `animal` (FK), `cut` (FK, nullable), `label_type`, `label_code`, `prn_content`, `bat_content`, `pdf_file` | Stores generated PRN per animal |
| `CustomLabel` | `kupe_no`, `uretici`, `cinsi`, `weight`, `prn_content`, `bat_content`, `pdf_file` | Manual standalone labels |
| `Label` | `label_code`, `item_type`, `item_id` | Generic printed-label audit record |

### Extensions to `PrintJob` (Phase 1B migration)

New fields — all nullable/defaulted for backward compat:

| Field | Type | Purpose |
|-------|------|---------|
| `site` | FK → `scales.Site` | Which site's edge dispatches this job |
| `target_printer` | FK → `scales.Printer` | Optional explicit printer override |
| `target_role` | CharField | Routing: "carcass"\|"meat_cut"\|"offal"\|... |
| `prn_content` | TextField | TSPL bytes, copied from AnimalLabel at enqueue |
| `dispatch_mode` | CharField | "edge" or "legacy_bat" |
| `attempts` | PositiveSmallIntegerField | Retry counter |
| `max_attempts` | PositiveSmallIntegerField | Default 8 |
| `error_text` | CharField(500) | Last error from edge |
| `edge_received_at` | DateTimeField | When edge first polled this job |
| `printed_at` | DateTimeField | When edge confirmed success |

### New model: `scales.Printer` (Phase 1B)

Lives in `scales/models.py` next to `EdgeDevice` and `ScaleDevice`:

| Field | Type | Purpose |
|-------|------|---------|
| `edge` | FK → EdgeDevice | Which edge owns this printer |
| `site` | FK → Site | Denormalized for efficient queries |
| `local_printer_id` | CharField(64) | Operator-friendly ID ("carcass-01") |
| `role` | CharField(32) | Same vocabulary as LabelTemplate.TARGET_ITEM_TYPE_CHOICES |
| `transport` | CharField(16) | "tcp" (only value for now) |
| `host` | CharField(64) | LAN IP |
| `port` | PositiveIntegerField | Default 9100 |
| `model` | CharField(64) | "TE210" |
| `status` | CharField(16) | unknown\|online\|offline\|error (edge-owned) |
| `priority` | PositiveSmallIntegerField | Lower = preferred (primary/backup) |
| `version` | CharField(64) | Firmware version from `~!T` query |

Unique constraint: `(edge, local_printer_id)`.

---

## 4. Django PRN generation functions (labeling/utils.py)

These are the functions the edge path reuses without modification:

| Function | Input | Output | Label type |
|----------|-------|--------|------------|
| `generate_tspl_prn_label(animal, label_type)` | Animal instance | TSPL string (97.5mm × 260mm, 4 labels/sheet) | Hot/cold carcass |
| `generate_cut_prn_label(cut)` | DisassemblyCut instance | TSPL string (same size, 1 label) | Cut labels |
| `generate_tspl_prn_label_from_data(label_data)` | dict of field values | TSPL string (4 labels/sheet) | Custom/manual |
| `create_animal_label(animal, label_type, user)` | Animal + user | AnimalLabel instance with prn_content | Wrapper |
| `create_cut_label(cut, label_type, user)` | Cut + user | AnimalLabel instance with prn_content | Wrapper |
| `create_custom_label(label_data, user)` | dict + user | CustomLabel instance with prn_content | Wrapper |

### Label format details (from TSPL template analysis)

```
SIZE 97.5 mm, 260 mm          ← 97.5mm wide, 260mm tall
GAP 3 mm, 0 mm                ← 3mm gap between labels, 0mm offset
DIRECTION 0,0                 ← portrait, no mirror
REFERENCE 0,0                 ← origin at top-left
OFFSET 0 mm                   ← no vertical offset
SET PEEL OFF / CUTTER OFF / TEAR ON  ← tear mode
CLS                           ← clear image buffer
CODEPAGE 1254                 ← Windows-1254 (Turkish)
```

Each label sheet prints **4 identical copies** of the same label data, arranged vertically at Y offsets ~200 dots apart. This is a single TSPL `PRINT 1,1` command (1 set, 1 copy) — the 4 copies are spatially laid out in the template, not via PRINT repetition.

### Turkish text handling

`Client.printer_turkish_mode` controls encoding:
- `"unicode"` — keep Turkish chars (ğ, ş, ç, ö, ü, ı, İ) as-is, rely on `CODEPAGE 1254`
- `"ascii"` — replace with ASCII equivalents (ğ→g, ş→s, etc.)
- `"codepage1254"` — explicit Windows-1254 encode/decode round-trip

The TSPL `CODEPAGE 1254` command in the template handles the printer-side decoding.

---

## 5. Edge API contract — existing + new endpoints

### Existing (scales/api_urls.py, mounted at /api/v1/edge/)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/register` | IP-based | Register/re-register edge |
| GET | `/sessions` | X-Edge-Id | Poll disassembly sessions |
| POST | `/events` | X-Edge-Id | Single weighing event |
| POST | `/events/batch` | X-Edge-Id | Batch weighing events |
| POST | `/offline-batches/ack` | X-Edge-Id | Idempotent batch ACK |
| GET | `/config` | X-Edge-Id | Runtime config |
| POST | `/devices/status` | X-Edge-Id | Device status update |
| POST | `/heartbeat` | X-Edge-Id | Connectivity snapshot |

### New (Phase 1B additions)

| Method | Path | Auth | Request | Response | Rate limit |
|--------|------|------|---------|----------|------------|
| GET | `/print-jobs/pending` | X-Edge-Id | headers only | `{jobs: [{jobId, targetRole, prnContent, ...}]}` | 60/min |
| POST | `/print-jobs/<uuid>/ack` | X-Edge-Id | `{status, printedAt, resolvedPrinter, attempts}` | `{ok: true}` | 120/min |
| POST | `/printers/inventory` | X-Edge-Id | `{printers: [{localPrinterId, role, host, port, ...}]}` | `{ok, printers: [{localPrinterId, globalPrinterId}]}` | 10/min |

### Heartbeat extension (additive)

Edge includes `printers[]` array in heartbeat body:
```json
{
  "version": "0.4.0",
  "devices": [...],
  "printers": [
    {"localPrinterId": "carcass-01", "status": "online", "lastSeenAt": "..."}
  ]
}
```

Django updates `Printer.status`/`last_seen_at`/`last_error` — never creates new rows (inventory push is the only creation path).

---

## 6. Edge SQLite schema additions

```sql
CREATE TABLE IF NOT EXISTS printers (
  printer_id        TEXT PRIMARY KEY,
  global_printer_id TEXT UNIQUE,
  display_name      TEXT,
  role              TEXT NOT NULL,
  transport         TEXT NOT NULL DEFAULT 'tcp',
  host              TEXT NOT NULL,
  port              INTEGER NOT NULL DEFAULT 9100,
  model             TEXT,
  status            TEXT NOT NULL DEFAULT 'unknown',
  priority          INTEGER NOT NULL DEFAULT 100,
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_seen_at      TEXT,
  last_error        TEXT,
  version           TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS print_jobs (
  job_id           TEXT PRIMARY KEY,
  global_job_id    TEXT UNIQUE,
  target_printer   TEXT,
  target_role      TEXT,
  resolved_printer TEXT,
  prn_bytes        BLOB NOT NULL,
  status           TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 8,
  next_attempt_at  TEXT,
  error_text       TEXT,
  source           TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  printed_at       TEXT,
  FOREIGN KEY (resolved_printer) REFERENCES printers(printer_id)
);
```

---

## 7. TSC TE210 protocol summary (from manual analysis)

### Transport
- **TCP raw socket on port 9100** (JetDirect)
- No framing, no handshake, no auth, no TLS
- `\r\n` (CRLF) between TSPL commands
- Binary-safe; codepage 1254 for Turkish text

### Status commands (for dispatcher)

| Command | Bytes | Reply | Use |
|---------|-------|-------|-----|
| `<ESC>!?` | `1B 21 3F` | 1 byte | Pre-flight + completion polling |
| `<ESC>!S` | `1B 21 53` | 8 bytes `<STX>+4+<ETX><CR><LF>` | Rich status (V6.29+) |
| `~!T` | `7E 21 54` | ASCII model+firmware | Device fingerprinting |
| `~!I` | `7E 21 49` | codepage,country | Codepage verification |

### Status byte decoding (`<ESC>!?`)

| Hex | Meaning |
|-----|---------|
| `0x00` | Ready |
| `0x01` | Head opened |
| `0x02` | Paper jam |
| `0x04` | Out of paper |
| `0x08` | Out of ribbon |
| `0x10` | Pause |
| `0x20` | Printing |
| `0x80` | Other error |

Values are bitmask-combined (e.g. `0x03` = paper jam + head open).

### Control commands

| Command | Bytes | Purpose |
|---------|-------|---------|
| `<ESC>!R` | `1B 21 52` | Reset printer |
| `<ESC>!F` | `1B 21 46` | Feed one label (V7.00+) |
| `<ESC>!.` | `1B 21 2E` | Cancel all queued jobs (V7.00+) |
| `<ESC>!P`/`O` | `1B 21 50`/`4F` | Pause / Resume |
| `~!E` | `7E 21 45` | Enable immediate commands |

### Dispatcher algorithm

```
1. Pick printer by target_role + priority (lowest priority number wins)
2. Pre-flight: send ESC!? → abort if ≠ 0x00, requeue
3. Write prn_bytes over TCP
4. Poll ESC!? every 500ms until 0x00 × 3 consecutive, or timeout
   (timeout = labelCount × 2s + 5s)
5. Success → printed_at = now, ACK to cloud
6. Failure/timeout → requeue with exponential backoff (2s, 4s, 8s... cap 60s)
```

---

## 8. Edge module structure (to build)

```
src/printers/
├── tcp-printer-client.ts     # Bun TCP socket to port 9100
│   ├── connect(ip, port=9100)
│   ├── disconnect()
│   ├── send(bytes: Uint8Array)
│   ├── getStatusByte() → 0x00..0x80
│   ├── getStatusExtended() → {message, warning, error1, error2}
│   ├── getModel() → string
│   ├── getCodepage() → string
│   ├── reset() / feed() / cancel() / pause() / resume()
│   └── enableImmediate()
│
├── printer-manager.ts        # Registry loaded from PRINTERS env + SQLite
│   ├── initialize()
│   ├── resolvePrinter(job) → Printer | null
│   ├── updatePrinterStatus(id, status)
│   ├── getPrinters() → Printer[]
│   └── healthCheck()            # periodic ping cycle
│
├── print-job-queue.ts        # SQLite-backed CRUD over print_jobs
│   ├── enqueue(job) → jobId
│   ├── getPendingJobs() → Job[]
│   ├── markDispatching(jobId, printerId)
│   ├── markPrinted(jobId)
│   ├── markFailed(jobId, error)
│   └── scheduleRetry(jobId, backoffMs)
│
├── print-dispatcher.ts       # Worker loop
│   ├── start() / stop()
│   └── dispatchJob(job)       # preflight → send → poll → ack
│
└── index.ts                  # initPrinters() / destroyPrinters()
```

---

## 9. Implementation phases — checklist

### Phase 1A — Edge local-only (no Django changes)

- [ ] SQLite migration: `printers` + `print_jobs` tables
- [ ] `tcp-printer-client.ts` — connect, send, status queries
- [ ] `printer-manager.ts` — load from `PRINTERS=` env var
- [ ] `print-job-queue.ts` — SQLite CRUD
- [ ] `print-dispatcher.ts` — worker loop with preflight/polling
- [ ] `src/printers/index.ts` — init/destroy lifecycle
- [ ] HTTP routes: POST/GET `/api/print-jobs`, GET `/api/printers`, POST `/api/printers/:id/test`
- [ ] Wire into `src/index.ts` main() and shutdown()
- [ ] Test: `nc -l 9100` receives bytes from curl → POST /api/print-jobs
- [ ] Test: real TE210 at 192.168.1.220 prints from curl

### Phase 1B — Django cloud models

- [ ] `scales.Printer` model + migration
- [ ] `labeling.PrintJob` extensions + migration
- [ ] `enqueue_print_job()` in `labeling/services.py`
- [ ] Three new API views in `scales/api_views.py`
- [ ] URL registration in `scales/api_urls.py`
- [ ] `edge_heartbeat` extension for `printers[]`
- [ ] Admin surfaces
- [ ] Unit tests

### Phase 2 — Integration

- [ ] Edge sync-service polls `/print-jobs/pending`
- [ ] Edge RestClient: `pollPendingPrintJobs()`, `ackPrintJob()`
- [ ] Edge heartbeat includes `printers[]`
- [ ] Edge pushes inventory on startup
- [ ] End-to-end: Django "Print" → edge → TE210 → ack → Django "completed"

### Phase 3 — Hardening

- [ ] TSPL status queries on separate health cycle (not just TCP success)
- [ ] Rate-limit guardrails per printer
- [ ] Metrics in admin dashboard
- [ ] Persistent retry across container restarts (SQLite already covers this)

---

## 10. Key technical decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| PRN generation | Cloud (Django) | Already works, tenant-scoped, tested |
| PRN delivery | Inline in API response | TSPL is ASCII, <5KB/label |
| Printer discovery | Static IP + env var | Reliable for industrial LAN |
| Job completion detection | Poll `<ESC>!?` for 0x00 × 3 | No async callback exists |
| Queue persistence | SQLite (edge) + PostgreSQL (cloud) | Survives container restarts |
| Multi-tenant isolation | django-tenants schema-per-tenant | Structural, not application-level |
| Turkish text encoding | `CODEPAGE 1254` in TSPL | Configurable per tenant |
| Printer auth | None (LAN firewall) | JetDirect has no auth mechanism |
| Edge auth to cloud | `X-Edge-Id` header | Existing pattern, schema-scoped |

---

## 11. File-by-file change map

### Edge repo (`Carnitrack_EDGE`)

| File | Action | Description |
|------|--------|-------------|
| `src/storage/database.ts` | MODIFY | Add `printers` + `print_jobs` tables to SCHEMA |
| `src/printers/tcp-printer-client.ts` | CREATE | Bun TCP client for TSPL over port 9100 |
| `src/printers/printer-manager.ts` | CREATE | Registry, env var loading, health checks |
| `src/printers/print-job-queue.ts` | CREATE | SQLite CRUD for print_jobs |
| `src/printers/print-dispatcher.ts` | CREATE | Worker loop: preflight → send → poll → ack |
| `src/printers/index.ts` | CREATE | Public API: init/destroy/exports |
| `src/index.ts` | MODIFY | Wire initPrinters/destroyPrinters, add HTTP routes |
| `src/cloud/rest-client.ts` | MODIFY (Phase 2) | Add print-job poll + ack methods |
| `src/cloud/sync-service.ts` | MODIFY (Phase 2) | Add print-job poll loop |
| `src/config.ts` | MODIFY | Add PRINTERS env var parsing |

### Django repo (`Core/slaughterhouse_system`)

| File | Action | Description |
|------|--------|-------------|
| `scales/models.py` | MODIFY | Add `Printer` model |
| `labeling/models.py` | MODIFY | Add fields to `PrintJob` |
| `scales/api_views.py` | MODIFY | Add 3 new edge views |
| `scales/api_urls.py` | MODIFY | Register 3 new URL patterns |
| `labeling/services.py` | MODIFY | Add `enqueue_print_job()` |
| `scales/admin.py` | MODIFY | Add PrinterAdmin, PrinterInline |
| `labeling/admin.py` | MODIFY | Extend PrintJobAdmin |
| `scales/migrations/00XX_printer.py` | CREATE | Migration for Printer |
| `labeling/migrations/00XX_printjob_edge.py` | CREATE | Migration for PrintJob extensions |

---

## 12. Source document cross-references

| Document | Location | Content |
|----------|----------|---------|
| Protocol & test ladder | `docs/2026-04-13_TSC_TE210_PROTOCOL_AND_TEST_LADDER.md` | TSPL commands, status bytes, PowerShell tests |
| Edge printer plan | `docs/2026-04-12_PRINTER_INTEGRATION_PLAN.md` | Edge architecture, SQLite schema, HTTP routes |
| Cloud printer plan | `Core/.../docs/2026-04-13_EDGE_PRINTER_INTEGRATION_PLAN.md` | Django models, API views, migration plan |
| TSPL manual (PDF) | `docs/TSPL_TSPL2_programming_manual.pdf` | 289-page command reference |
| TE210 user manual (PDF) | `docs/TSC_TE210_user_manual.pdf` | Hardware, calibration, troubleshooting |
| Cloud integration spec | `Core/.../docs/DJANGO_CLOUD_INTEGRATION_SPEC.md` | Full edge REST contract |
| Offline batch testing | `docs/TEST_OFFLINE_BATCH_ACK.md` | Batch ACK verification procedure |
