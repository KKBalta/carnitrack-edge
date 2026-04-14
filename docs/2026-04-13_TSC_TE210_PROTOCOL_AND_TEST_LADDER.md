# TSC TE210 — Protocol Analysis & Test Ladder

**Date:** 2026-04-13
**Printer:** TSC TE210, static IP `192.168.1.220`, Ethernet
**Goal:** document the real network protocol exposed by the TE210 and the PowerShell test ladder we use to validate every protocol claim before writing Bun code.

Companion to `2026-04-12_PRINTER_INTEGRATION_PLAN.md` (the edge-side plan).
Source PDFs stored locally:
- `docs/TSC_TE210_user_manual.pdf` (55 pages — hardware, loading, calibration)
- `docs/TSPL_TSPL2_programming_manual.pdf` (289 pages — command reference)

---

## 1. What the printer actually exposes on the network

TSC does **not** document a custom application-layer protocol for Ethernet. The LAN interface is simply:

**Raw TCP socket on port 9100 (HP JetDirect "raw print" convention).** Bytes written into the socket feed directly into the same TSPL parser that USB and RS-232 use. No framing, no handshake, no length prefix, no auth, no session.

Confirmed in the TSPL manual, *"Status Polling and Immediate Commands"* section (p. 82):
> "These commands support RS-232, USB and Ethernet."

The port number is defined by `NET PORT` (p. 253):
> `NET PORT number` — "Base raw port number. **Default is 9100.**"

**Protocol summary:**
1. Open TCP to `<printer-ip>:9100`
2. Write TSPL bytes (label commands OR status/control queries)
3. Optionally read reply bytes if the query returns data
4. Close socket

Nothing more exists. Every feature — dispatch, status, control, configuration — goes over the same raw socket.

---

## 2. Transport properties (input for `src/printers/tcp-printer-client.ts`)

| Property | Value | Source |
|---|---|---|
| Transport | TCP, unencrypted | TSPL p. 82, 253 |
| Port | 9100 (default, configurable via `NET PORT`) | TSPL p. 253 |
| Framing | None — raw byte stream | TSPL p. 82 |
| Encoding | Binary-safe; codepage 1254 for Turkish `TEXT`, raw bytes for `BITMAP` | TSPL CODEPAGE command |
| Command terminator | `\r\n` (CRLF) between TSPL commands | TSPL format convention |
| Concurrency | One active socket per printer (serialize at the edge — TSC doesn't state limits, serializing is the safe assumption) | implicit |
| Authentication | None | n/a — use network ACL instead |

---

## 3. Usable commands — the subset we care about

### 3.1 Status queries

All four are sent as raw bytes over TCP:9100. Send, then read until the documented terminator.

| Command | Bytes | Reply | Edge use |
|---|---|---|---|
| `<ESC>!?` | `1B 21 3F` | **1 byte** status | Primary status check. Fast pre-flight before every job; completion polling after each job. |
| `<ESC>!S` | `1B 21 53` | **8 bytes**: `<STX>` + 4 status chars + `<ETX><CR><LF>` | Rich status including paper-low / ribbon-low warnings. V6.29+ firmware only. |
| `~!T` | `7E 21 54` | Model name (ASCII, CR-terminated) | Device fingerprinting — record per printer in edge DB. |
| `~!I` | `7E 21 49` | `codepage, country\r` | Verify Turkish codepage (optional — each `.prn` carries its own `CODEPAGE` anyway). |

**`<ESC>!?` reply decoding (TSPL p. 82):**

| Hex | Meaning |
|---|---|
| `0x00` | Normal / ready |
| `0x01` | Head opened |
| `0x02` | Paper jam |
| `0x03` | Paper jam and head opened |
| `0x04` | Out of paper |
| `0x05` | Out of paper and head opened |
| `0x08` | Out of ribbon |
| `0x09` | Out of ribbon and head opened |
| `0x0A` | Out of ribbon and paper jam |
| `0x0B` | Out of ribbon, paper jam, head opened |
| `0x0C` | Out of ribbon and out of paper |
| `0x0D` | Out of ribbon, out of paper, head opened |
| `0x10` | Pause |
| `0x20` | Printing |
| `0x80` | Other error |

**`<ESC>!S` reply decoding (TSPL p. 90):** 4 ASCII chars bit-packed:
- Byte 1 (message): `@` normal, `` ` `` pause, `B` backing, `C` cutting, `E` error, `F` form feed, `K` waiting-for-key, `L` waiting-for-label, `P` printing-batch, `W` imaging
- Byte 2 (warning): `@` normal, `A` paper-low, `B` ribbon-low
- Byte 3 (error): `@` normal, `A` head-overheat, `B` motor-overheat, `D` head-error, `H` cutter-jam, `P` out-of-memory
- Byte 4 (error): `@` normal, `A` paper-empty, `B` paper-jam, `D` ribbon-empty, `H` ribbon-jam, `` ` `` head-open

Normal state returns `<STX>@@@@<ETX><CR><LF>` = `02 40 40 40 40 03 0D 0A`.

**Safety note:** `<ESC>!` immediate commands can be disabled by `<ESC>!D` and re-enabled by `~!E`. On a fresh printer they're enabled by default, but if a prior job disabled them, status polling silently fails. The edge should send `~!E` once at startup per printer as a safety measure.

### 3.2 Control commands (write-only, no reply)

| Command | Bytes | Purpose | Edge use |
|---|---|---|---|
| `<ESC>!R` | `1B 21 52` | Reset printer (clears downloaded memory) | Admin "Reset" button |
| `<ESC>!C` | `1B 21 43` | Restart, skip AUTO.BAS | Recovery from stuck state |
| `<ESC>!P` | `1B 21 50` | Pause | Maintenance mode |
| `<ESC>!O` | `1B 21 4F` | Resume from pause | Maintenance mode |
| `<ESC>!F` | `1B 21 46` | Feed one label (V7.00+) | Admin "Feed" button / alignment test |
| `<ESC>!.` | `1B 21 2E` | Cancel all queued jobs (V7.00+) | Admin "Cancel" button / purge stale jobs |
| `~!E` | `7E 21 45` | Enable immediate commands | Startup safety |
| `~!F` | `7E 21 46` | List files in printer memory (reply) | Verify downloaded fonts/bitmaps |

### 3.3 Label commands (already proven by `first.prn`)

`SIZE`, `GAP`, `DIRECTION`, `REFERENCE`, `OFFSET`, `SET PEEL/CUTTER/TEAR`, `CLS`, `CODEPAGE`, `BITMAP`, `TEXT`, `BARCODE`, `QRCODE`, `PRINT m,n`.

`first.prn` exercises all of these. The edge does NOT generate TSPL — the cloud renders to `.prn` and the edge streams the bytes verbatim. Cloud stays responsible for label layout.

**`PRINT m,n` (TSPL p. 23):** `m` = sets, `n` = copies per set. Does NOT return anything — the printer just starts printing. There is no "job complete" async event on port 9100. This is the biggest protocol gap and drives the queue design below.

### 3.4 Network configuration commands (one-time provisioning)

All sendable over port 9100 (including setting the IP itself, as long as we currently know the old one):

| Command | Syntax | Notes |
|---|---|---|
| `NET DHCP` | `NET DHCP` | Switch to DHCP, printer restarts |
| `NET IP` | `NET IP "ip","mask","gateway"` | Static IP, printer restarts |
| `NET PORT` | `NET PORT 9100` | Change port, printer restarts |
| `NET NAME` | `NET NAME "carcass-01"` | Set printer server name |

Useful for a "Printer settings" panel in the edge admin UI. Phase 3.

---

## 4. Protocol gaps and edge-side workarounds

TSC does NOT provide:

| Missing feature | Workaround (edge-side) |
|---|---|
| Job completion callback | Poll `<ESC>!?` every 500ms after `PRINT`; mark complete when status = `0x00` for N consecutive reads OR timeout = `labelCount × ~2s + 5s` |
| Job ID | Edge assigns its own `print_job.id` in SQLite; the printer never sees it |
| Queue introspection | One active TCP per printer; queue everything else in `print-job-queue.ts` |
| Authentication | Network ACL — firewall port 9100 to edge subnet only |
| TLS | None. Unencrypted plaintext. Acceptable for LAN-only deployment. |
| Concurrent sockets guarantee | Serialize per printer (safe default) |
| Pre-flight "is printer ready" | Send `<ESC>!?` before writing job bytes; abort if non-zero, requeue with backoff |

**Resulting dispatcher algorithm:**

1. Pick printer by `target_role` + `priority`
2. Pre-flight: `<ESC>!?` → abort if non-zero
3. Write job bytes
4. Poll `<ESC>!?` every 500ms until `0x00` × 3 consecutive, or timeout
5. On success: set `printed_at`, ACK to cloud
6. On failure/timeout: requeue with exponential backoff, record `last_error`

---

## 5. Firmware version awareness

The TSPL manual is dated **2014**. Some commands are gated by firmware version:

| Command | Minimum firmware |
|---|---|
| `<ESC>!?` | All |
| `<ESC>!S` | V6.29+ |
| `<ESC>!C` | V5.23+ |
| `<ESC>!D` / `~!E` | V6.61+ |
| `<ESC>!F` / `<ESC>!.` | V7.00+ |
| `<ESC>!O` / `<ESC>!P` | V6.93+ |
| `<ESC>!Q` | V6.72+ |

**Edge startup routine per printer:**
1. Send `~!E` (enable immediate commands, safe even on fresh printers)
2. Send `~!T` (get model + firmware string)
3. Log firmware version in SQLite `printers.version` column
4. Decide which status query to use based on firmware: `<ESC>!S` if ≥ V6.29, else fall back to `<ESC>!?`

`<ESC>!?` is the oldest and most universally supported — make it the primary, with `<ESC>!S` as an optional richer query where firmware allows.

---

## 6. Test ladder — PowerShell verification

Run on the edge PC via AnyDesk. Each step validates one claim from the manual. No Bun, no Docker, no install needed.

### 6.1 Reusable helper (paste once per PowerShell session)

```powershell
function Send-Printer {
    param(
        [string]$Ip = "192.168.1.220",
        [int]$Port = 9100,
        [byte[]]$WriteBytes,
        [int]$ReadBytes = 0,
        [int]$ReadTimeoutMs = 1500
    )
    $client = New-Object System.Net.Sockets.TcpClient
    $client.ReceiveTimeout = $ReadTimeoutMs
    $client.SendTimeout = 1500
    $client.Connect($Ip, $Port)
    $stream = $client.GetStream()

    if ($WriteBytes) {
        $stream.Write($WriteBytes, 0, $WriteBytes.Length)
        $stream.Flush()
    }

    $reply = $null
    if ($ReadBytes -gt 0) {
        $buf = New-Object byte[] $ReadBytes
        $deadline = [DateTime]::UtcNow.AddMilliseconds($ReadTimeoutMs)
        $read = 0
        try {
            while ($read -lt $ReadBytes -and [DateTime]::UtcNow -lt $deadline) {
                if ($stream.DataAvailable) {
                    $n = $stream.Read($buf, $read, $ReadBytes - $read)
                    if ($n -le 0) { break }
                    $read += $n
                } else {
                    Start-Sleep -Milliseconds 50
                }
            }
        } catch {}
        $reply = $buf[0..([Math]::Max(0, $read - 1))]
    }

    $stream.Close()
    $client.Close()
    return $reply
}
```

### 6.2 Step A — TCP pipe alive

```powershell
Test-NetConnection 192.168.1.220 -Port 9100
```
**Pass:** `TcpTestSucceeded : True`.

### 6.3 Step B.5 — Enable immediate commands (safety)

```powershell
Send-Printer -WriteBytes ([System.Text.Encoding]::ASCII.GetBytes("~!E`r`n"))
```
No reply expected.

### 6.4 Step B — 1-byte status (`<ESC>!?`)

```powershell
$reply = Send-Printer -WriteBytes ([byte[]](0x1B, 0x21, 0x3F)) -ReadBytes 1
"Status byte: 0x{0:X2}" -f $reply[0]
```
**Pass:** `0x00` when ready. Open top cover → expect non-zero. Close cover → back to `0x00`.

### 6.5 Step C — 8-byte extended status (`<ESC>!S`)

```powershell
$reply = Send-Printer -WriteBytes ([byte[]](0x1B, 0x21, 0x53)) -ReadBytes 8
if ($reply) {
    ($reply | ForEach-Object { "{0:X2}" -f $_ }) -join " "
    "ASCII: " + ([System.Text.Encoding]::ASCII.GetString($reply))
}
```
**Pass (normal state):** `02 40 40 40 40 03 0D 0A` / `<STX>@@@@<ETX><CR><LF>`.
**Empty reply:** firmware < V6.29 — fall back to Step B.

### 6.6 Step D — Model name (`~!T`)

```powershell
$reply = Send-Printer -WriteBytes ([System.Text.Encoding]::ASCII.GetBytes("~!T`r`n")) -ReadBytes 64
if ($reply) { [System.Text.Encoding]::ASCII.GetString($reply) }
```
**Pass:** string containing `TE210` and firmware version. Record the exact firmware string.

### 6.7 Step E — Codepage (`~!I`)

```powershell
$reply = Send-Printer -WriteBytes ([System.Text.Encoding]::ASCII.GetBytes("~!I`r`n")) -ReadBytes 32
if ($reply) { [System.Text.Encoding]::ASCII.GetString($reply) }
```
**Pass:** something like `1254, 001` or `437, 001`.

### 6.8 Step F — Feed one label (`<ESC>!F`)

```powershell
Send-Printer -WriteBytes ([byte[]](0x1B, 0x21, 0x46))
```
**Pass:** camera shows exactly one label advance, printer stops cleanly at next gap.
If it feeds continuously or stops mid-label → re-run auto-calibration (hold physical FEED button ~3 seconds).

### 6.9 Step G — Full happy path: print `first.prn` with completion polling

This is what the Bun dispatcher will do in production.

```powershell
# 1. Pre-flight check
$pre = Send-Printer -WriteBytes ([byte[]](0x1B, 0x21, 0x3F)) -ReadBytes 1
"Pre-flight: 0x{0:X2}" -f $pre[0]
if ($pre[0] -ne 0x00) { Write-Error "Printer not ready"; return }

# 2. Send the job (binary-safe file read, NOT string encoding)
$bytes = [System.IO.File]::ReadAllBytes("C:\Users\enver\first.prn")
Send-Printer -WriteBytes $bytes
"Wrote $($bytes.Length) bytes"

# 3. Poll until ready
$readyStreak = 0
$start = Get-Date
do {
    Start-Sleep -Milliseconds 500
    $s = Send-Printer -WriteBytes ([byte[]](0x1B, 0x21, 0x3F)) -ReadBytes 1
    $hex = "0x{0:X2}" -f $s[0]
    $elapsed = ((Get-Date) - $start).TotalSeconds
    "[{0,5:N1}s] status={1}" -f $elapsed, $hex
    if ($s[0] -eq 0x00) { $readyStreak++ } else { $readyStreak = 0 }
    if ($elapsed -gt 60) { Write-Error "Timeout"; break }
} while ($readyStreak -lt 3)
"Job complete after {0:N1}s" -f ((Get-Date) - $start).TotalSeconds
```

**Pass:**
1. Pre-flight returns `0x00`
2. "Wrote N bytes"
3. Status polls show `0x20` (printing) for a few seconds
4. Label ejects
5. Status returns to `0x00` × 3 consecutive polls
6. "Job complete after ~X seconds"

Record the wall-clock time — that's the basis for the dispatcher timeout formula.

### 6.10 Step H — Failure-mode tests (optional)

**H1. Jam/head-open detection:** open top cover, run Step B, expect non-zero.
**H2. Cancel while printing:** kick off a long job, then `Send-Printer -WriteBytes ([byte[]](0x1B, 0x21, 0x2E))`.
**H3. Reset:** `Send-Printer -WriteBytes ([byte[]](0x1B, 0x21, 0x52))`.

### 6.11 Ladder execution order

Run in strict sequence — later steps depend on earlier rungs:
1. **A** (pipe alive)
2. **B.5** (enable immediate)
3. **B** (1-byte status)
4. **F** (feed test — validates calibration after the earlier paper jam)
5. **C** (8-byte status — optional rich path)
6. **D** (fingerprint firmware)
7. **E** (codepage check)
8. **G** (end-to-end print)
9. **H** (failure modes — after happy path works)

If any step fails, debug that rung before climbing higher. The whole point of the ladder is that a failure at B makes G meaningless.

---

## 7. Mapping findings → edge module

```
src/printers/
├── tcp-printer-client.ts
│   ├── connect(ip, port=9100) → TCP socket
│   ├── send(bytes: Uint8Array) → void (writes raw)
│   ├── sendText(tspl: string) → encodes via codepage 1254, appends CRLF
│   ├── getStatusByte() → sends 1B 21 3F, reads 1 byte, decodes to enum
│   ├── getStatusExtended() → sends 1B 21 53, reads 8 bytes, decodes 4 status bytes
│   ├── getModel() → sends 7E 21 54 0D 0A, reads until CR
│   ├── getCodepage() → sends 7E 21 49 0D 0A, reads until CR
│   ├── reset() → sends 1B 21 52
│   ├── feed() → sends 1B 21 46
│   ├── cancel() → sends 1B 21 2E
│   ├── pause() / resume() → sends 1B 21 50 / 1B 21 4F
│   └── enableImmediate() → sends 7E 21 45 (startup only)
│
├── print-dispatcher.ts
│   └── dispatchJob(job):
│       1. pick printer by role+priority
│       2. preflight getStatusByte() → abort if non-zero
│       3. send(job.prn_bytes)
│       4. poll getStatusByte() every 500ms until 0x00 × 3 OR timeout
│       5. on success → job.printed_at = now, cloud ACK
│       6. on error/timeout → requeue with backoff, store last_error
│
└── print-job-queue.ts
    └── one in-flight job per printer, serialized
```

---

## 8. Security posture

- **No auth, no TLS** on port 9100 — inherent to JetDirect protocol.
- **Mitigation:** network ACL. Firewall the printer subnet so only the edge container can reach port 9100. No direct cloud → printer path.
- **Defense in depth:** the edge admin dashboard should expose only authenticated endpoints that *construct* print jobs; raw byte passthrough must never be exposed beyond the edge's own network.
- **TE210 web UI:** also unauthenticated by default. Set an admin password via the web UI during provisioning, and note this in the site onboarding checklist.

---

## 9. Open questions / next checks

1. **Firmware version of the on-site TE210** — unknown until Step D runs. Drives whether we use `<ESC>!S` or only `<ESC>!?`.
2. **Concurrent connection behavior** — untested. Assumption is "one at a time"; the edge enforces this via the queue regardless.
3. **Per-label wall time** — unknown until Step G runs. Feeds the dispatcher timeout formula.
4. **Buffer size** — manual doesn't state how many queued label commands the printer buffers. Relevant if we ever batch multiple jobs in one TCP write. For now: one job per connection, so N/A.
5. **Behavior after reboot mid-job** — untested. Test H3 partially covers this.

---

## 10. Source citations (page numbers in `TSPL_TSPL2_programming_manual.pdf`)

- Port 9100 default: p. 253 (`NET PORT`)
- Status polling intro + Ethernet support: p. 82
- `<ESC>!?` 1-byte status table: p. 82
- `<ESC>!S` 8-byte status table: p. 90
- `<ESC>!C`, `<ESC>!D`, `<ESC>!O`, `<ESC>!P`, `<ESC>!Q`, `<ESC>!R`: pp. 84–89
- `<ESC>!F`, `<ESC>!.`: pp. 92–93
- `~!@`, `~!A`, `~!C`, `~!D`, `~!E`, `~!F`, `~!I`, `~!T`: pp. 94–101
- `PRINT m,n`: p. 23
- `NET DHCP`, `NET IP`, `NET PORT`, `NET NAME`: pp. 251–254
- `WLAN DHCP/IP/PORT`: pp. 248–250 (not applicable — TE210 has no Wi-Fi)
