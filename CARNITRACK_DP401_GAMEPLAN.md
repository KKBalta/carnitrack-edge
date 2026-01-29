# CarniTrack + DP-401 Integration Game Plan

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            CARNITRACK ECOSYSTEM                                  │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │   CLOUD      │    │    EDGE      │    │   DP-401    │    │    SCALE     │   │
│  │   (Django)   │◄──►│   (Bun)      │◄──►│   WiFi      │◄──►│   Hardware   │   │
│  │   GCP        │    │   Windows PC │    │   Module    │    │              │   │
│  └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘   │
│                                                                                  │
│  - Animal profiles   - Local buffer     - TCP Server      - Weight sensor       │
│  - PLU catalog       - Session mgmt     - Port 8899       - Label printer       │
│  - Reports           - Offline support  - Serial bridge   - PLU display         │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. The Core Problem: Animal Traceability

### Current Challenge
When a butcher weighs "KIYMA" (ground meat), the scale doesn't know WHICH animal it came from.

### Solution: Disassembly Sessions

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        DISASSEMBLY SESSION CONCEPT                               │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ANIMAL ARRIVAL          DISASSEMBLY SESSION           PRODUCTS                  │
│  ┌──────────────┐       ┌──────────────────┐         ┌──────────────┐           │
│  │ Animal #A123 │       │ Session Started  │         │ 2.5kg Kıyma  │──► A123   │
│  │ Dana (Beef)  │──────►│ Animal: A123     │────────►│ 1.2kg Bonfile│──► A123   │
│  │ 350kg        │       │ Operator: KAAN   │         │ 3.0kg Kuşbaşı│──► A123   │
│  └──────────────┘       │ Scale: DP401-001 │         └──────────────┘           │
│                         └──────────────────┘                                     │
│                                                                                  │
│  All weighings during this session are automatically linked to Animal #A123     │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Flow Architecture

### 3.1 Bidirectional Sync

```
                    CLOUD (Django/GCP)
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         │
    ┌─────────────────┐                 │
    │  PLU Catalog    │                 │
    │  (Products)     │                 │
    │  - Names        │                 │
    │  - Prices       │                 │
    │  - Barcodes     │                 │
    └────────┬────────┘                 │
             │                          │
             │ GET /api/plu/export/     │
             ▼                          │
    ┌─────────────────┐                 │
    │   EDGE SERVICE  │                 │
    │   (Bun + SQLite)│                 │
    └────────┬────────┘                 │
             │                          │
             │ TCP :8899                │
             ▼                          │
    ┌─────────────────┐                 │
    │    DP-401       │                 │
    │    Scale        │                 │
    └────────┬────────┘                 │
             │                          │
             │ Weight Events            │
             ▼                          │
    ┌─────────────────┐                 │
    │   EDGE SERVICE  │                 │
    │   (Buffer)      │                 │
    └────────┬────────┘                 │
             │                          │
             │ POST /api/events/batch/  │
             └──────────────────────────┘
```

### 3.2 Data Flow Summary

| Direction | Data | Protocol | Trigger |
|-----------|------|----------|---------|
| Cloud → Edge | PLU Catalog | HTTPS GET | On demand / Schedule |
| Edge → Scale | PLU File | TCP (port 8899) | After cloud sync |
| Scale → Edge | Weight Events | TCP (port 8899) | On label print |
| Edge → Cloud | Events + Session | HTTPS POST | Batch sync |

---

## 4. PLU Upload Protocol (Cloud → Scale)

### 4.1 PLU File Format (Confirmed)

```
PLU_CODE~PRODUCT_NAME____~DEPT~BARCODE______~LOT_______~PRICE~DATE1___~DATE2___~LBL~UNIT~TARE~TEXT_FIELDS...~FLAG~CUSTOM~CUSTOM~EXTENDED~
```

**Example:**
```
00001~KIYMA           ~000~000000000001~          ~00015~00000000~00000000~01~01~0000~...
```

| Field | Length | Description |
|-------|--------|-------------|
| PLU Code | 5 | Product ID (00001-99999) |
| Product Name | 16 | Name (padded, CP1254 encoding) |
| Department | 3 | Category code |
| Barcode | 12 | EAN-13 barcode |
| Lot Number | 10 | Batch ID |
| Price | 5 | Unit price (×100) |
| Date 1 | 8 | Production date (YYYYMMDD) |
| Date 2 | 8 | Expiry date (YYYYMMDD) |
| Label Type | 2 | Label format |
| Unit Type | 2 | 01=kg, 00=piece |
| Tare | 4 | Default tare weight |

### 4.2 Upload Protocol (To Be Tested)

Based on the "KONTROLLU AKTAR OK?" prompt, the protocol might be:

```
1. Connect to TCP 192.168.1.135:8899
2. Receive: "KONTROLLU AKTAR OK?"
3. Send: "OK" or specific command
4. Send: PLU file content (Windows-1254 encoded)
5. Receive: Confirmation
```

**Testing needed:**
- [ ] What command initiates PLU upload mode?
- [ ] Does scale need to be in a specific mode?
- [ ] What's the acknowledgment after upload?

### 4.3 Alternative: Use Densi Windows App Protocol

The `Densi_DP401.exe` Windows app successfully uploads PLU files. We could:
1. Monitor network traffic when app sends PLU
2. Reverse-engineer the exact protocol
3. Replicate in Bun

---

## 5. Event Capture Protocol (Scale → Cloud)

### 5.1 Event Format (Confirmed!)

When a label is printed, the scale sends:

```
PLU,TIME,DATE,PRODUCT,BARCODE,CODE,OPERATOR,VALUE1,WEIGHT,VALUE2,FLAGS,COMPANY
```

**Actual Example:**
```
00001,13:59:59,15.01.2026,KIYMA           ,000000000001,0000,KAAN...,0038319236,0000000035,0038319201,0,0,0,1,N,KORKUT KAAN BALTA
```

### 5.2 Parsed Fields

| Index | Field | Example | Notes |
|-------|-------|---------|-------|
| 0 | PLU Code | `00001` | Product identifier |
| 1 | Time | `13:59:59` | Weighing time |
| 2 | Date | `15.01.2026` | Weighing date (DD.MM.YYYY) |
| 3 | Product Name | `KIYMA` | 16 chars, padded |
| 4 | Barcode | `000000000001` | 12 digits |
| 5 | Code | `0000` | Price code? |
| 6 | Operator | `KAAN` | 48 chars, padded |
| 7 | Value 1 | `0038319236` | Total/Cumulative? |
| 8 | Weight | `0000000035` | Net weight (grams?) |
| 9 | Value 2 | `0038319201` | Calculated value |
| 10-14 | Flags | `0,0,0,1,N` | Status flags |
| 15 | Company | `KORKUT KAAN BALTA` | Business name |

### 5.3 Acknowledgment Protocol

```
Scale: [event data]\r\nKONTROLLU AKTAR OK?\n
Edge:  OK\n
Scale: [confirmed event data]\r\n
```

---

## 6. Session Management Design

### 6.1 Session Workflow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         DISASSEMBLY SESSION WORKFLOW                             │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐        │
│  │ SELECT  │───►│ START   │───►│ WEIGH   │───►│ WEIGH   │───►│  END    │        │
│  │ ANIMAL  │    │ SESSION │    │ CUT #1  │    │ CUT #N  │    │ SESSION │        │
│  └─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘        │
│       │              │              │              │              │              │
│       │              │              │              │              │              │
│       ▼              ▼              ▼              ▼              ▼              │
│  [Cloud API]   [Edge stores    [Event tagged  [Event tagged  [Session          │
│  fetch animal   session_id]     with session]  with session]  closed, sync]    │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Data Model

**Cloud (Django)**
```python
class Animal:
    id: UUID
    tag_number: str          # Ear tag
    species: str             # Dana, Kuzu, Koyun
    breed: str
    arrival_date: datetime
    carcass_weight: decimal
    status: str              # alive, slaughtered, processed

class DisassemblySession:
    id: UUID
    animal: FK(Animal)
    scale_device_id: str     # DP401 identifier
    operator: str
    started_at: datetime
    ended_at: datetime
    status: str              # active, completed, cancelled

class WeighingEvent:
    id: UUID
    session: FK(DisassemblySession)
    plu_code: str
    product_name: str
    weight_grams: int
    timestamp: datetime
    barcode: str
    raw_data: str            # Original scale output
    synced_at: datetime
```

**Edge (SQLite)**
```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    animal_id TEXT,
    animal_tag TEXT,
    scale_ip TEXT,
    operator TEXT,
    started_at TEXT,
    ended_at TEXT,
    status TEXT DEFAULT 'active',
    synced INTEGER DEFAULT 0
);

CREATE TABLE events (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    plu_code TEXT,
    product_name TEXT,
    weight_grams INTEGER,
    timestamp TEXT,
    barcode TEXT,
    operator TEXT,
    raw_data TEXT,
    synced INTEGER DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE plu_cache (
    plu_code TEXT PRIMARY KEY,
    product_name TEXT,
    barcode TEXT,
    price INTEGER,
    unit_type TEXT,
    last_synced TEXT
);
```

### 6.3 Session Selection Options

**Option A: Edge Service UI (Recommended)**
- Simple web UI on edge service (Bun serves HTML)
- Operator selects animal from list before starting
- Session auto-ends after timeout or manual close

**Option B: Cloud Dashboard**
- Start session from Angular dashboard
- Edge service polls for active session
- Works but requires internet at start

**Option C: Scale Operator Field**
- Use the OPERATOR field on scale to encode animal ID
- Parse from weight events
- Hacky but works without UI changes

---

## 7. Implementation Phases

### Phase 1: Event Capture (DONE ✓)
- [x] TCP connection to DP-401
- [x] Receive weight/print events
- [x] Parse event data format
- [x] Acknowledge with OK

### Phase 2: Local Storage
- [ ] SQLite database setup
- [ ] Store events locally
- [ ] Handle offline scenarios

### Phase 3: Cloud Sync (Events UP)
- [ ] Django API endpoint for events
- [ ] Batch upload from edge
- [ ] Retry on failure
- [ ] Mark events as synced

### Phase 4: PLU Sync (Catalog DOWN)
- [ ] Django API endpoint for PLU export
- [ ] Edge fetches PLU catalog
- [ ] **Figure out PLU upload protocol**
- [ ] Push PLU to scale

### Phase 5: Session Management
- [ ] Session data model
- [ ] Session selection UI/mechanism
- [ ] Link events to sessions
- [ ] Session sync to cloud

### Phase 6: Production Hardening
- [ ] Windows Service wrapper
- [ ] Auto-reconnect on disconnect
- [ ] Error logging
- [ ] Health monitoring

---

## 8. Open Questions

### Critical
1. **PLU Upload Protocol**: How exactly do we send PLU data to the scale?
   - Need to test sending data after "KONTROLLU AKTAR OK?"
   - May need to capture Densi app traffic

2. **Weight Field Interpretation**: Is `0000000035` = 35 grams or 0.035 kg?
   - Need to test with known weights

### Important
3. **Session Selection**: How will operator indicate which animal they're processing?
   - Edge UI vs Cloud selection vs Operator field hack

4. **Multiple Scales**: How to handle multiple DP-401 devices?
   - Each scale = separate TCP connection
   - Session per scale

5. **Real-time vs Batch**: Sync events immediately or batch?
   - Batch is more reliable for offline
   - Real-time better for monitoring

---

## 9. Next Steps

### Immediate (Today)
1. **Test PLU Upload**: Try sending PLU data over TCP
2. **Capture Densi App Traffic**: Use Wireshark to see what the Windows app sends

### Short Term
3. Build SQLite event storage
4. Build Django API endpoints
5. Implement cloud sync

### Medium Term
6. Session management
7. PLU sync from cloud
8. Edge service UI

---

## 10. API Endpoints (Django)

### Events API
```
POST /api/iot/events/batch/
{
  "device_id": "DP401-001",
  "events": [
    {
      "local_id": "uuid",
      "session_id": "uuid",
      "plu_code": "00001",
      "product_name": "KIYMA",
      "weight_grams": 35,
      "timestamp": "2026-01-15T13:59:59",
      "barcode": "000000000001",
      "operator": "KAAN",
      "raw_data": "..."
    }
  ]
}
```

### PLU Export API
```
GET /api/iot/plu/export/?format=dp401

Response:
{
  "version": "2026-01-15T10:00:00Z",
  "items": [
    {
      "plu_code": "00001",
      "name": "KIYMA",
      "barcode": "000000000001",
      "price": 15,
      "unit_type": "kg"
    }
  ]
}
```

### Session API
```
POST /api/iot/sessions/
{
  "animal_id": "uuid",
  "scale_device_id": "DP401-001",
  "operator": "KAAN"
}

GET /api/iot/sessions/active/?device_id=DP401-001
```

---

## 11. Quick Reference

### TCP Connection
```
Host: 192.168.1.135
Port: 8899
Protocol: TCP Server (scale listens)
Encoding: ASCII (events), Windows-1254 (PLU files)
```

### Event Format
```
PLU,TIME,DATE,PRODUCT,BARCODE,CODE,OPERATOR,VAL1,WEIGHT,VAL2,FLAGS,COMPANY
```

### PLU Format
```
PLU~NAME____________~DEPT~BARCODE_____~LOT_______~PRICE~DATE1___~DATE2___~LBL~UNIT~TARE~...
```

---

*Document Version: 1.0*
*Created: January 2026*
*Status: In Progress*
