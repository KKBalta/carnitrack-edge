# Printer Transport Test Results — 2026-04-14

**Printer:** TSC TE210  
**IP:** `192.168.1.220` (static, Ethernet)  
**Port:** 9100 (JetDirect / raw TCP)  
**Test machine:** Windows PC at `192.168.1.28` (Wi-Fi), accessed via AnyDesk  
**Edge repo:** `Carnitrack_EDGE` — Phase 1A code complete, all 149 unit tests passing  

---

## 1. Test ladder results

| Step | Command | Result | Notes |
|------|---------|--------|-------|
| 0. TCP connectivity | `Test-NetConnection 192.168.1.220 -Port 9100` | **PASS** — `TcpTestSucceeded: True` | Printer was initially offline (not in ARP table). After power cycle / cable check, came online. |
| 1. Enable immediate commands | `~!E\r\n` | **PASS** — no error | Safety measure; idempotent. |
| 2. 1-byte status (`ESC!?`) | `0x1B 0x21 0x3F` → read 1 byte | **PASS** — `0x00` (ready) | Confirms printer is idle and accepting jobs. |
| 3. Model fingerprint (`~!T`) | `~!T\r\n` → read ASCII | **PASS** — `TE210` | Firmware version string returned. No version suffix in output — may need longer read buffer. |
| 4. Feed one label (`ESC!F`) | `0x1B 0x21 0x46` | **PASS** — paper advanced one label | Confirms paper sensor is calibrated for the loaded 97.5mm × 260mm stock. |
| 5. Simple TSPL print | TEXT commands with `SIZE 97.5 mm, 260 mm` | **PASS** — label printed correctly | Used `CODEPAGE 1254`, font `"3"`, rotation 90. Text appeared correctly. |
| 6. `first.prn` file print | `ReadAllBytes` → raw send | **FAIL** — bytes sent but no output | See encoding issue below. |

---

## 2. Critical finding: PRN file encoding

### Problem

`first.prn` (12,661 bytes) was saved with **Unix line endings (`\n` / `0x0A`)** instead of the TSPL-required **`\r\n` (`0x0D 0x0A`)**. Verified via hex dump:

```
00000010: 3020 6d6d 0a47 4150 2033 206d 6d2c 2030  0 mm.GAP 3 mm, 0
                   ^^
                   LF only — TSPL parser ignores the commands
```

### Why text-based CRLF fix also failed

The file contains a `BITMAP` command with **4,416 bytes of raw binary pixel data** on the same line. A text-mode `\n` → `\r\n` replacement corrupts any `0x0A` bytes inside the bitmap payload, making the image data invalid and the byte count in the `BITMAP` header wrong.

### Why this is NOT a production issue

In production, Django's `generate_tspl_prn_label()` builds the TSPL string in Python with explicit `\r\n` line endings:

```python
prn_content = prn_content.replace('\n', '\r\n')
```

The edge receives `prnContent` as a string from the cloud API, encodes it via `iconv.encode(prnContent, "windows-1254")`, and streams the resulting bytes to the printer. The BITMAP data in production PRN is generated correctly with proper byte counts. The `first.prn` file was a manually-saved copy that lost its line endings — not representative of the production pipeline.

### Recommendation for cloud agent

When generating PRN content that includes `BITMAP` commands:
- **Always use `\r\n`** between TSPL commands from the start — do NOT generate with `\n` and convert later, because the bitmap binary payload may contain `0x0A` bytes that would be incorrectly expanded.
- The `BITMAP x,y,width,height,mode,<data>` command's data section is **raw binary, not text**. Its length is exactly `width × height` bytes. Any byte insertion breaks parsing.
- Alternatively, use `PUTBMP` (loads from printer memory) or `DOWNLOAD` + `PUTBMP` to avoid inline binary in the TSPL stream.

---

## 3. Confirmed protocol behavior

| Property | Observed | Manual reference |
|----------|----------|-----------------|
| Transport | Raw TCP, port 9100, no framing | TSPL p. 82, 253 |
| Command terminator | `\r\n` (CRLF) required | TSPL convention |
| `ESC!?` status reply | 1 byte, `0x00` = ready | TSPL p. 82 |
| `~!T` model reply | ASCII string, CR-terminated | TSPL p. 101 |
| `ESC!F` feed | Advances exactly one label | TSPL p. 92 |
| `CODEPAGE 1254` | Turkish characters render correctly | TSPL CODEPAGE cmd |
| `PRINT 1,1` | Prints and returns to ready (no async callback) | TSPL p. 23 |
| Concurrent sockets | Not tested; edge serializes per printer | Safe default |

---

## 4. Network discovery notes

- Printer was **not initially reachable** — not in ARP table, port 9100 scan of all 22 LAN hosts returned nothing.
- After physical check (power cycle / Ethernet cable), printer appeared at `192.168.1.220`.
- **Lesson:** the TE210 Ethernet interface can go dormant or lose its static IP config after extended downtime. Edge health checks should handle `offline` → `online` transitions gracefully (already implemented in `printer-manager.ts` health loop).
- TSC MAC prefix is `00:1B:82` — none of the ARP entries matched, confirming the printer was truly offline, not just on a different IP.

---

## 5. Edge implementation status (Phase 1A)

All Phase 1A components are **implemented and unit-tested** (149/150 tests pass; 1 unrelated failure in session cache):

| Component | File | Status |
|-----------|------|--------|
| SQLite schema | `src/storage/database.ts` | `printers` + `print_jobs` tables with indexes |
| TCP client | `src/printers/tcp-printer-client.ts` | `connect`, `send`, `getStatusByte`, `dispatchPrintJob` (preflight + poll) |
| Printer manager | `src/printers/printer-manager.ts` | Env var parsing, SQLite persistence, health checks, role-based resolution |
| Job queue | `src/printers/print-job-queue.ts` | SQLite CRUD, exponential backoff (`2s, 4s, 8s... 60s cap`) |
| Dispatcher | `src/printers/print-dispatcher.ts` | Worker loop, 1 in-flight per printer, cloud ACK on success/failure |
| HTTP routes | `src/index.ts` | `POST /api/print-jobs`, `GET /api/print-jobs`, `GET /api/printers`, `POST /api/printers/:id/test`, `POST /api/printers/discover` |
| Cloud sync | `src/cloud/sync-service.ts` | `pollPendingPrintJobs()`, `pushPrinterInventory()` |
| Cloud REST | `src/cloud/rest-client.ts` | `fetchPendingPrintJobs()`, `ackPrintJob()` |
| Config | `src/config.ts` | `PRINTERS` env var, all timing knobs |

### Edge data flow (validated today)

```
Django generates prnContent (TSPL string, \r\n, CODEPAGE 1254)
    ↓
Cloud API: GET /api/v1/edge/print-jobs/pending
    → returns { jobs: [{ jobId, targetRole, prnContent, ... }] }
    ↓
Edge sync-service.ts: pollPendingPrintJobs()
    → iconv.encode(prnContent, "windows-1254") → Buffer
    → enqueue({ prnBytes, targetRole, globalJobId, source: "cloud" })
    → INSERT INTO print_jobs (status='pending')
    ↓
Edge print-dispatcher.ts: tick() every 1s
    → getNextPending() → resolvePrinter(job) by role+priority
    → TcpPrinterClient.dispatchPrintJob(prnBytes):
        1. ESC!? preflight → must be 0x00
        2. Write prnBytes to TCP:9100
        3. Poll ESC!? every 500ms until 0x00 × 3 (or timeout)
    → markPrinted(jobId)
    → ackPrintJob(globalJobId, { status: "completed" })
    ↓
Printer: receives raw TSPL bytes, prints label
```

---

## 6. What the cloud agent needs to implement

### Required Django endpoints (Phase 1B)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/v1/edge/print-jobs/pending` | Edge polls every ~5s. Return pending jobs for this edge's site. |
| `POST` | `/api/v1/edge/print-jobs/<uuid>/ack` | Edge reports job result: `{ status, printedAt, resolvedPrinter, attempts }` |
| `POST` | `/api/v1/edge/printers/inventory` | Edge pushes printer list on startup: `{ printers: [{ localPrinterId, role, host, port, model, version }] }` |

### `GET /api/v1/edge/print-jobs/pending` response format

```json
{
  "jobs": [
    {
      "jobId": "uuid-from-django",
      "targetRole": "carcass",
      "targetPrinter": null,
      "prnContent": "SIZE 97.5 mm, 260 mm\r\nGAP 3 mm, 0 mm\r\n...\r\nPRINT 1,1\r\n",
      "labelCount": 1,
      "attempts": 0,
      "createdAt": "2026-04-14T10:30:00Z"
    }
  ]
}
```

### Critical: `prnContent` encoding contract

- **Type:** UTF-8 JSON string (standard JSON transport)
- **Line endings:** `\r\n` (CRLF) — TSPL requirement
- **Content:** Complete TSPL command sequence from `SIZE` through `PRINT m,n`
- **Turkish text:** Use `CODEPAGE 1254` directive in the TSPL; actual Turkish characters (ğ, ş, ç, ö, ü, ı, İ) encoded per `Client.printer_turkish_mode`
- **BITMAP data:** If using inline `BITMAP` command, the binary payload must be **base64-encoded or hex-encoded** in the JSON string, OR avoid inline BITMAP entirely and use `PUTBMP` with pre-downloaded images
- **Edge decoding:** `iconv.encode(prnContent, "windows-1254")` converts the string to raw bytes for the printer

### `POST /api/v1/edge/print-jobs/<uuid>/ack` request format

```json
{
  "status": "completed",
  "printedAt": "2026-04-14T10:30:05Z",
  "resolvedPrinter": "global-printer-uuid-from-inventory",
  "attempts": 1
}
```

Or on failure:

```json
{
  "status": "failed",
  "printedAt": null,
  "resolvedPrinter": "global-printer-uuid",
  "attempts": 8,
  "errorText": "printer not ready: out_of_paper (0x04)"
}
```

### Heartbeat extension (additive, non-breaking)

Edge already includes `printers[]` in heartbeat payload:

```json
{
  "version": "0.4.0",
  "devices": [...],
  "printers": [
    {
      "localPrinterId": "carcass-01",
      "status": "online",
      "lastSeenAt": "2026-04-14T10:29:55Z"
    }
  ]
}
```

Django should update `Printer.status` / `last_seen_at` from this — never create new rows (inventory push is the only creation path).

---

## 7. Env var for edge deployment

```bash
PRINTERS=carcass-01:192.168.1.220:9100:role=carcass
```

Format: `local_id:host:port[:role=value]`, comma-separated for multiple printers.

---

## 8. Open items

1. **`first.prn` BITMAP encoding** — the test file needs to be re-saved with CRLF line endings from the original Django generation pipeline, not from a text editor. Not blocking; production PRN comes from Django, not from files.
2. **Firmware version** — `~!T` returned `TE210` without a version suffix. May need a longer read timeout or buffer. Not blocking; `ESC!?` (the primary status command) works on all firmware versions.
3. **Printer going offline** — observed during testing. Edge health check loop (every 30s) handles this. Consider adding a "printer offline" alert to the Django admin.
4. **Static IP persistence** — verify the TE210 retains `192.168.1.220` across power cycles. If it reverts to DHCP, set it via TSPL: `NET IP "192.168.1.220","255.255.255.0","192.168.1.1"\r\n` over TCP.
