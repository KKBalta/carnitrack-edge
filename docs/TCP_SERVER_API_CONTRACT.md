# TCP Server API Contract

## Overview

The CarniTrack Edge TCP Server accepts connections from DP-401 WiFi-enabled scales on port **8899** (configurable via `TCP_PORT` environment variable, default: 8899).

**Connection Type:** TCP (raw socket)
**Host:** Configurable via `TCP_HOST` environment variable (default: `0.0.0.0` - all interfaces)
**Port:** Configurable via `TCP_PORT` environment variable (default: `8899`)

---

## Connection Flow

1. **Scale connects** → TCP connection established
2. **Scale sends registration packet:** `"SCALE-XX"` (where XX is 01-99)
3. **Scale sends heartbeat every 30s:** `"HB"`
4. **Scale sends weighing events** when label is printed (CSV format)
5. **Server responds with:** `"OK\n"` to acknowledge events

---

## Message Protocol

### Important Notes

- **No newlines:** Most packets from scales are sent WITHOUT newlines (raw packets)
- **Fragmentation:** Data may arrive in chunks (fragmented packets)
- **Multiple packets:** Multiple packets may arrive in a single TCP chunk
- **Stream parsing:** Server buffers and reassembles packets using pattern matching

---

## Incoming Messages (Scale → Server)

### 1. Registration Packet

**Purpose:** Device identification on initial connection

**Format:**
HB

**Characteristics:**
- 2 bytes (no newline)
- Sent every 30 seconds by the scale
- Literal string: `"HB"`

**Response:** None (server updates device heartbeat timestamp)

---

### 3. Acknowledgment Request

**Purpose:** Scale requests acknowledgment from server

**Format:**
KONTROLLU AKTAR OK?

**Characteristics:**
- 19 bytes (no newline)
- Turkish text meaning "Transfer control OK?"
- May appear before or after weighing events

**Response:** Server sends `"OK\n"`

---

### 4. Weighing Event (CSV Format)

**Purpose:** Transmit weight measurement and label print data

**Format:**
PLU,TIME,DATE,PRODUCT,BARCODE,CODE,OPERATOR,VAL1,VAL2,VAL3,FLAGS

**CSV Fields:**

| Index | Field Name | Format | Description | Example |
|-------|------------|--------|-------------|---------|
| 0 | PLU | `\d{5}` | Original PLU code (5 digits) - kept for reference | `00001` |
| 1 | TIME | `HH:MM:SS` | Time from scale | `01:44:22` |
| 2 | DATE | `DD.MM.YYYY` | Date from scale | `30.01.2026` |
| 3 | PRODUCT | string (16 chars) | Product name (padded) | `KIYMA` |
| 4 | BARCODE | `\d{12}` | **12-digit barcode - Used as PLU code** (actual PLU identifier) | `000000000004` |
| 5 | CODE | string | Code field (purpose unclear) | `0000` |
| 6 | OPERATOR | string (48 chars) | Operator name (padded) | `KAAN` |
| 7 | VAL1 | `\d{10}` | Gross/total weight (for reference) | `0000072091` |
| 8 | VAL2 | `\d{10}` | **Tare weight (dara) in grams** | `0000062415` |
| 9 | VAL3 | `\d{10}` | **Net weight in grams (actual weight to use)** | `0000009676` |
| 10+ | FLAGS | varies | Flag fields (typically `2,0,2,1,N`) | `2,0,2,1,N` |
| last | COMPANY | string | Company name | `KORKUT KAAN BALTA` |

**Weight Parsing:**
- **Net weight is in field [9] (VAL3)** - 10-digit number (actual weight to use)
- **Tare weight (dara) is in field [8] (VAL2)** - 10-digit number
- Field [7] (VAL1) contains gross/total weight (for reference)

**Weight Format:**
The scale sends weight values in different formats:
- **Small values (< 1000)**: Sent in 0.1 kg units - multiply by 100 to get grams
  - Example: `0000000014` = 14 → 14 × 100 = 1,400 grams (1.4 kg)
  - Example: `0000000013` = 13 → 13 × 100 = 1,300 grams (1.3 kg)
- **Large values (≥ 1000)**: Sent directly in grams
  - Example: `0000009676` = 9,676 grams (already in grams)

**Examples:**

Example 1 (small values in 0.1 kg units):
```
00001,06:25:17,30.01.2026,BONF�LE,000000000004,0000,KAAN,0000000027,0000000013,0000000014,1,0,1,1,N,KORKUT KAAN BALTA
```
- Net weight (VAL3): `0000000014` = 14 → 1,400 grams (1.4 kg)
- Tare (VAL2): `0000000013` = 13 → 1,300 grams (1.3 kg)
- Total (VAL1): `0000000027` = 27 → 2,700 grams (2.7 kg)

Example 2 (large values in grams):
```
00001,06:00:27,30.01.2026,BONF�LE,000000000004,0000,KAAN,0000072091,0000062415,0000009676,2,0,2,1,N,KORKUT KAAN BALTA
```
- Net weight (VAL3): `0000009676` = 9,676 grams
- Tare (VAL2): `0000062415` = 62,415 grams

**Characteristics:**
- Contains newlines (`\r\n` or `\n`)
- Minimum 10 fields required
- May have `P"` or `P` prefix on PLU code after acknowledgment (stripped by parser)

**Response:** Server sends `"OK\n"` after processing

**Note:** Scale sends the same event twice:
- Once for weight measurement
- Once for print event (timestamp may differ by 1-2 seconds)
- Server deduplicates based on device+PLU+weight (ignoring timestamp)

---

## Outgoing Messages (Server → Scale)

### Acknowledgment Response

**Format:**
OK\n

**When sent:**
- After receiving a weighing event
- After receiving an acknowledgment request (`KONTROLLU AKTAR OK?`)
- Even if event is skipped due to deduplication

**Characteristics:**
- 3 bytes: `"O"`, `"K"`, `"\n"` (newline required)
- UTF-8 encoded

---

## Data Types & Structures

### Socket Metadata

interface SocketMeta {
  /** Unique socket ID (UUID-based) */
  id: string;
  
  /** Remote IP address */
  remoteAddress: string;
  
  /** Remote port */
  remotePort: number;
  
  /** When connection was established */
  connectedAt: Date;
  
  /** Last data received timestamp */
  lastDataAt: Date | null;
  
  /** Registered device ID (from SCALE-XX packet) */
  deviceId: string | null;
  
  /** Whether socket is closing/closed */
  closing: boolean;
}
