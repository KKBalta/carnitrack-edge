# CarniTrack Cloud Django Integration Specification

> **Document Purpose:** This is a complete specification for an agent building the Django Cloud backend. It describes every REST endpoint the Edge expects, the data contracts, Django models, session lifecycle, offline reconciliation, and testing strategy.
>
> **Generated from:** Analysis of the CarniTrack Edge codebase (v0.3.0, REST API pivot, February 2026)

---

## 1. Context & Architecture Overview

CarniTrack is a **meat traceability system** for butcher shops and slaughterhouses. The architecture is **Cloud-Centric**:

```
Phone App ←── REST + SSE ──→ Cloud (Django) ←── REST API ──→ Edge (Bun) ←── TCP ── Scales (DP-401)
```

**Key Principle:** Cloud is the source of truth. Edge is a smart relay.

| Component | Technology | Role |
|-----------|-----------|------|
| **Cloud** | Django + PostgreSQL (GCP Cloud Run) | Multi-tenant. Manages sessions, animals, users, PLU catalog. Source of truth for all business logic. |
| **Edge** | Bun + SQLite (Windows PC / Linux per site) | One per physical site. Captures scale events via TCP, buffers offline, streams to Cloud via REST. |
| **Scales** | DP-401 with WiFi modules | Embedded devices. Send weight events via TCP to Edge on port 8899. |
| **Phone App** | React Native / Flutter | Operators start/end sessions, view real-time events. Talks to Cloud only. |

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    CLOUD-CENTRIC ARCHITECTURE (v3.0)                            │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  OPERATOR'S PHONE                 EDGE (Bun)                    CLOUD (Django) │
│  ┌─────────────────┐             ┌─────────────────┐           ┌─────────────┐ │
│  │                 │             │                 │           │             │ │
│  │ Start Session ──┼─────────────┼─────────────────┼──────────►│ Create      │ │
│  │ (Phone App)     │   REST      │                 │   REST    │ Session     │ │
│  │                 │             │   Poll Sessions │◄──────────│ (Edge       │ │
│  │ View Events ◄───┼─────────────┼─────────────────┼───────────│ polls)      │ │
│  │ (Real-time)     │             │                 │           │             │ │
│  │ End Session ────┼─────────────┼─────────────────┼──────────►│ Close       │ │
│  │                 │             │  Stream to Cloud│──────────►│ Session     │ │
│  └─────────────────┘             │                 │  (2-3s)   │             │ │
│                                  │  Offline Buffer │           │             │ │
│  ┌─────────────────┐             │  ┌───────────┐  │           │             │ │
│  │ DP-401 Scales   │             │  │ SQLite    │  │           │             │ │
│  │                 │────TCP─────►│  │ - Events  │  │           │             │ │
│  │ SCALE-01        │   :8899     │  │ - Queue   │  │           │             │ │
│  │ SCALE-02        │             │  └───────────┘  │           │             │ │
│  └─────────────────┘             └─────────────────┘           └─────────────┘ │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Why Cloud-Centric?

| Aspect | Cloud-Centric Design |
|--------|---------------------|
| Session Creation | Phone App via Cloud API |
| Session State Machine | Cloud handles all state |
| Event Visibility | Real-time in Cloud (2-3s latency) |
| Operator Experience | Use phone anywhere at site |
| Multi-Site | Central management, one Cloud many Edges |
| Offline | Capture events, reconcile later |

---

## 2. Edge REST API Contract (What Django Must Implement)

The Edge communicates with Cloud via **6 REST endpoints** under a configurable base URL.

### Base URL

The Edge default configuration is:

```
CLOUD_API_URL = https://api.carnitrack.com/api/v1
```

`CLOUD_API_URL` must be the **API root only**: no trailing slash, no `/edge` suffix. The Edge appends paths like `/edge/register`, `/edge/config`, etc. itself.

The Edge constructs URLs as `{CLOUD_API_URL}{path}` (trailing slashes on the base are stripped). Examples:
- `{CLOUD_API_URL}/edge/register` → `https://api.carnitrack.com/api/v1/edge/register`
- `{CLOUD_API_URL}/edge/sessions` → `https://api.carnitrack.com/api/v1/edge/sessions`
- `{CLOUD_API_URL}/edge/config` → `https://api.carnitrack.com/api/v1/edge/config`

Django should route these under a single `edge` prefix, e.g. `/api/v1/edge/register`, `/api/v1/edge/config`.

### Common Request Headers

All requests from Edge include:

```http
Content-Type: application/json
X-Client-Type: carnitrack-edge
X-Client-Version: 0.3.0
X-Edge-Id: <edge-uuid>        (present after registration)
X-Site-Id: <site-uuid>        (present after registration)
```

### Retry Behavior

- Timeout: 10 seconds per request (configurable)
- Max retries: 3 with exponential backoff (1s → 2s → 4s, max 30s)
- 4xx errors (except 429): NOT retried
- 5xx errors and 429: Retried
- Network errors: Retried

---

### 2.1 `POST /edge/register` — Edge Registration

Called when Edge starts and connects to Cloud for the first time, or on reconnection.

**Request Body:**

```json
{
  "edgeId": null,
  "siteId": "site-001",
  "siteName": "Kasap Merkezi A",
  "version": "0.3.0",
  "capabilities": ["rest", "tcp"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `edgeId` | `string \| null` | `null` on first registration; Edge UUID on re-registration |
| `siteId` | `string \| null` | From env `SITE_ID` (optional, for initial pairing) |
| `siteName` | `string \| null` | From env `EDGE_NAME` (human-readable) |
| `version` | `string` | Edge software version |
| `capabilities` | `string[]` | Always `["rest", "tcp"]` |

**Success Response (200):**

```json
{
  "edgeId": "550e8400-e29b-41d4-a716-446655440000",
  "siteId": "site-uuid-123",
  "siteName": "Kasap Merkezi A",
  "config": {
    "sessionPollIntervalMs": 5000,
    "heartbeatIntervalMs": 30000,
    "workHoursStart": "06:00",
    "workHoursEnd": "18:00"
  }
}
```

**Django Action:**

1. If `edgeId` is `null`:
   - Create a new `EdgeDevice` record, assign a UUID
   - Associate with `Site` using `siteId` or create one
2. If `edgeId` is provided:
   - Look up `EdgeDevice`, update `last_seen_at`, `is_online=True`, `version`
3. Return the edge identity and any configuration overrides

---

### 2.2 `GET /edge/sessions?device_ids=SCALE-01,SCALE-02` — Poll Active Sessions

Called **every 5 seconds** by Edge to discover active sessions for its connected devices. This is how the Edge learns about sessions created by the Phone App.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `device_ids` | `string` | Comma-separated local device IDs (e.g., `SCALE-01,SCALE-02`) |

**Success Response (200):**

```json
{
  "sessions": [
    {
      "cloudSessionId": "session-uuid-123",
      "deviceId": "SCALE-01",
      "animalId": "animal-uuid-456",
      "animalTag": "A-124",
      "animalSpecies": "Kuzu",
      "operatorId": "operator-uuid-789",
      "status": "active"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `cloudSessionId` | `string` | UUID of the DisassemblySession |
| `deviceId` | `string` | **Local** device ID (e.g., `SCALE-01`), NOT UUID |
| `animalId` | `string \| null` | Animal UUID |
| `animalTag` | `string \| null` | Ear tag (e.g., `A-124`) |
| `animalSpecies` | `string \| null` | Species name (e.g., `Dana`, `Kuzu`, `Koyun`) |
| `operatorId` | `string \| null` | Operator UUID |
| `status` | `"active" \| "paused"` | Session status |

**Django Action:**

1. Identify the requesting Edge from `X-Edge-Id` header
2. Find `DisassemblySession` records where:
   - `device__edge_id` matches the Edge
   - `device__device_id` is in the provided `device_ids` list
   - `status` is `active` or `paused` (not `completed`, `cancelled`, etc.)
3. Return matching sessions with animal metadata

**CRITICAL:** `deviceId` in the response must be the **local** device ID (e.g., `SCALE-01`), not the database UUID. The Edge matches sessions to devices using this local identifier.

**Empty Response (no active sessions):**

```json
{
  "sessions": []
}
```

---

### 2.3 `POST /edge/events` — Single Event Upload

Called in **real-time** when a weighing event occurs on a scale. Target latency: 2-3 seconds end-to-end.

**Request Body:**

```json
{
  "localEventId": "edge-generated-uuid",
  "deviceId": "SCALE-01",
  "globalDeviceId": "SITE01-SCALE-01",
  "cloudSessionId": "session-uuid-or-null",
  "offlineMode": false,
  "offlineBatchId": null,
  "pluCode": "000000000004",
  "productName": "BONFILE         ",
  "weightGrams": 1400,
  "barcode": "000000000004",
  "scaleTimestamp": "2026-01-29T10:31:05.000Z",
  "receivedAt": "2026-01-29T10:31:05.500Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `localEventId` | `string` | Edge-generated UUID (for deduplication) |
| `deviceId` | `string` | Local device ID (e.g., `SCALE-01`) |
| `globalDeviceId` | `string` | Globally unique device ID (e.g., `SITE01-SCALE-01`) |
| `cloudSessionId` | `string \| null` | Session UUID if online and session active; `null` if offline or no session |
| `offlineMode` | `boolean` | `true` if captured while Cloud was unreachable |
| `offlineBatchId` | `string \| null` | Batch UUID if offline mode |
| `pluCode` | `string` | Product code (5-12 digit string from barcode field) |
| `productName` | `string` | Product name from scale (16 chars, space-padded — **trim on Cloud side**) |
| `weightGrams` | `number` | Net weight in grams (integer) |
| `barcode` | `string` | Generated barcode string |
| `scaleTimestamp` | `string` | ISO 8601 timestamp from scale |
| `receivedAt` | `string` | ISO 8601 timestamp when Edge received the event |

**Success Response (200):**

```json
{
  "cloudEventId": "cloud-generated-uuid",
  "status": "accepted"
}
```

**Duplicate Response (200):**

```json
{
  "cloudEventId": "existing-cloud-uuid",
  "status": "duplicate"
}
```

**Django Action:**

1. **Deduplicate** by `localEventId` → `edge_event_id` (unique constraint). If exists, return `"duplicate"`.
2. Find the `ScaleDevice` by matching `X-Edge-Id` + `deviceId`
3. Create `WeighingEvent` record
4. If `cloudSessionId` is not null:
   - Link event to `DisassemblySession`
   - Update session stats: `total_weight_grams += weightGrams`, `event_count += 1`, `last_event_at = now`
   - If session was `pending`, transition to `active`
5. If `offlineMode` is `true` and `offlineBatchId` is set:
   - Find or create `OrphanedBatch` record
   - Increment `event_count` and `total_weight_grams`
6. **Trim** `productName` (remove trailing spaces)
7. Return the cloud-assigned UUID

---

### 2.4 `POST /edge/events/batch` — Batch Event Upload

Called for **backlog sync** after reconnection or periodic batch uploads. Batch size default: 50 events.

**Request Body:**

```json
{
  "events": [
    {
      "localEventId": "uuid-1",
      "deviceId": "SCALE-01",
      "globalDeviceId": "SITE01-SCALE-01",
      "cloudSessionId": null,
      "offlineMode": true,
      "offlineBatchId": "batch-uuid-abc",
      "pluCode": "00001",
      "productName": "KIYMA           ",
      "weightGrams": 2500,
      "barcode": "2000001025004",
      "scaleTimestamp": "2026-01-29T14:22:05.000Z",
      "receivedAt": "2026-01-29T14:22:05.500Z"
    }
  ]
}
```

**Success Response (200):**

```json
{
  "results": [
    {
      "localEventId": "uuid-1",
      "cloudEventId": "cloud-uuid-1",
      "status": "accepted"
    },
    {
      "localEventId": "uuid-2",
      "cloudEventId": "cloud-uuid-2",
      "status": "duplicate"
    },
    {
      "localEventId": "uuid-3",
      "cloudEventId": "",
      "status": "failed",
      "error": "Invalid PLU code"
    }
  ]
}
```

**Django Action:**

1. Process each event individually within a database transaction
2. Return **per-event results** (accepted / duplicate / failed)
3. For offline events with `offlineBatchId`, create/update `OrphanedBatch` records
4. A batch should NOT fail entirely if one event fails — process all and report individually

---

### 2.5 `GET /edge/config` — Edge Configuration / Health Check

Called on startup to check connectivity and retrieve configuration. Also serves as a **health check** — any `2xx` response means Cloud is reachable.

**Success Response (200):**

```json
{
  "edgeId": "edge-uuid",
  "sessionPollIntervalMs": 5000,
  "heartbeatIntervalMs": 30000,
  "workHoursStart": "06:00",
  "workHoursEnd": "18:00",
  "timezone": "Europe/Istanbul"
}
```

**Django Action:**

- Look up Edge from `X-Edge-Id` header
- Return configuration for this Edge
- This endpoint must respond quickly (under 5 seconds) as it's used for connection detection

---

### 2.6 `POST /edge/devices/status` — Device Status Update

Called when a scale connects, disconnects, or sends heartbeats (~every 30 seconds per device).

**Request Body (connect/heartbeat):**

```json
{
  "deviceId": "SCALE-01",
  "status": "online",
  "heartbeatCount": 100,
  "eventCount": 50,
  "globalDeviceId": "SITE01-SCALE-01",
  "sourceIp": "192.168.1.50",
  "deviceType": "disassembly",
  "timestamp": "2026-01-29T10:31:00.000Z"
}
```

**Request Body (disconnect):**

```json
{
  "deviceId": "SCALE-01",
  "status": "disconnected",
  "heartbeatCount": 0,
  "eventCount": 0,
  "reason": "Heartbeat timeout",
  "timestamp": "2026-01-29T10:32:00.000Z"
}
```

**Success Response (200):**

```json
{
  "ok": true
}
```

**Django Action:**

1. Find or create `ScaleDevice` for this Edge + `deviceId`
2. Update `status`, `last_heartbeat_at` (if online), `last_event_at`
3. If `deviceType` is provided, update it
4. Log status changes for the monitoring dashboard

---

## 3. Django Models

These are the recommended models. Adapt to your existing schema as needed.

```python
import uuid
from django.db import models


class Site(models.Model):
    """Multi-tenant: Different butcher shops/plants"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    name = models.CharField(max_length=200)
    address = models.TextField(blank=True)
    api_key = models.CharField(max_length=100, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name


class EdgeDevice(models.Model):
    """Edge computers registered with Cloud"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name='edges')
    name = models.CharField(max_length=200, blank=True)
    is_online = models.BooleanField(default=False)
    last_seen_at = models.DateTimeField(null=True)
    version = models.CharField(max_length=20, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.name or self.id} ({self.site.name})"


class ScaleDevice(models.Model):
    """DP-401 scales connected to Edges"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    edge = models.ForeignKey(EdgeDevice, on_delete=models.CASCADE, related_name='scales')
    device_id = models.CharField(max_length=50)  # "SCALE-01" (local to site)
    global_device_id = models.CharField(max_length=100, unique=True)  # "SITE01-SCALE-01"
    name = models.CharField(max_length=200, blank=True)
    location = models.CharField(max_length=200, blank=True)
    device_type = models.CharField(max_length=50, default='disassembly')  # disassembly | retail | receiving
    is_active = models.BooleanField(default=True)
    status = models.CharField(max_length=50, default='unknown')  # online | idle | stale | disconnected | unknown
    last_heartbeat_at = models.DateTimeField(null=True)
    last_event_at = models.DateTimeField(null=True)

    class Meta:
        unique_together = ['edge', 'device_id']

    def __str__(self):
        return f"{self.device_id} @ {self.edge.name or self.edge.id}"


class Animal(models.Model):
    """Animal/carcass registry"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name='animals')
    tag_number = models.CharField(max_length=50)
    species = models.CharField(max_length=50)  # Dana, Kuzu, Koyun, Sigir
    breed = models.CharField(max_length=100, blank=True)
    carcass_weight_kg = models.DecimalField(max_digits=10, decimal_places=2, null=True)
    arrival_date = models.DateField(null=True)
    slaughter_date = models.DateField(null=True)
    status = models.CharField(max_length=50, default='registered')  # registered | processing | completed
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ['site', 'tag_number']

    def __str__(self):
        return f"{self.tag_number} ({self.species})"


class DisassemblySession(models.Model):
    """Session linking scale events to an animal — SOURCE OF TRUTH"""
    STATUS_CHOICES = [
        ('pending', 'Pending'),
        ('active', 'Active'),
        ('completed', 'Completed'),
        ('cancelled', 'Cancelled'),
        ('auto_closed', 'Auto-closed'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name='sessions')
    animal = models.ForeignKey(Animal, on_delete=models.SET_NULL, null=True, blank=True, related_name='sessions')
    device = models.ForeignKey(ScaleDevice, on_delete=models.SET_NULL, null=True, blank=True, related_name='sessions')
    operator = models.CharField(max_length=100)
    status = models.CharField(max_length=50, choices=STATUS_CHOICES, default='pending')
    started_at = models.DateTimeField()
    ended_at = models.DateTimeField(null=True, blank=True)
    last_event_at = models.DateTimeField(null=True, blank=True)
    total_weight_grams = models.IntegerField(default=0)
    event_count = models.IntegerField(default=0)
    close_reason = models.CharField(max_length=100, blank=True)
    notes = models.TextField(blank=True)

    def __str__(self):
        animal_str = self.animal.tag_number if self.animal else "No animal"
        return f"Session {self.id} - {animal_str} ({self.status})"


class WeighingEvent(models.Model):
    """Individual weighing/print events from scales"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name='events')
    session = models.ForeignKey(
        DisassemblySession, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='events'
    )
    device = models.ForeignKey(
        ScaleDevice, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='events'
    )
    animal = models.ForeignKey(
        Animal, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='events'
    )

    # Event data
    plu_code = models.CharField(max_length=20)
    product_name = models.CharField(max_length=100)
    weight_grams = models.IntegerField()
    barcode = models.CharField(max_length=50)

    # Timestamps
    scale_timestamp = models.DateTimeField()
    edge_received_at = models.DateTimeField()
    cloud_received_at = models.DateTimeField(auto_now_add=True)

    # Edge tracking
    edge_event_id = models.CharField(max_length=100, unique=True)  # localEventId from Edge (dedup key)
    offline_batch_id = models.CharField(max_length=100, blank=True, null=True)

    class Meta:
        indexes = [
            models.Index(fields=['site', 'scale_timestamp']),
            models.Index(fields=['session']),
            models.Index(fields=['animal']),
            models.Index(fields=['offline_batch_id']),
            models.Index(fields=['edge_event_id']),
        ]

    def __str__(self):
        return f"{self.device} | {self.plu_code} | {self.weight_grams}g"


class OrphanedBatch(models.Model):
    """Batches of events captured while Edge was offline, pending reconciliation"""
    STATUS_CHOICES = [
        ('pending', 'Pending'),
        ('reconciled', 'Reconciled'),
        ('ignored', 'Ignored'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name='orphaned_batches')
    edge = models.ForeignKey(EdgeDevice, on_delete=models.CASCADE, related_name='orphaned_batches')
    device = models.ForeignKey(ScaleDevice, on_delete=models.SET_NULL, null=True, blank=True)
    batch_id = models.CharField(max_length=100, unique=True)  # offlineBatchId from Edge
    started_at = models.DateTimeField()
    ended_at = models.DateTimeField(null=True, blank=True)
    event_count = models.IntegerField(default=0)
    total_weight_grams = models.IntegerField(default=0)
    status = models.CharField(max_length=50, choices=STATUS_CHOICES, default='pending')
    reconciled_to_session = models.ForeignKey(
        DisassemblySession, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='reconciled_batches'
    )
    reconciled_at = models.DateTimeField(null=True, blank=True)
    reconciled_by = models.CharField(max_length=100, blank=True)

    def __str__(self):
        return f"Batch {self.batch_id} ({self.status}, {self.event_count} events)"


class PLUItem(models.Model):
    """Master product catalog"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name='plu_items')
    plu_code = models.CharField(max_length=20)
    name = models.CharField(max_length=100)
    name_turkish = models.CharField(max_length=16)  # 16-char limit for scale label
    barcode = models.CharField(max_length=50)
    price_cents = models.IntegerField()  # kuruş (e.g., 15000 = 150.00 TL)
    unit_type = models.CharField(max_length=10, default='kg')  # kg | piece
    tare_grams = models.IntegerField(default=0)
    category = models.CharField(max_length=100)  # Dana, Kuzu, Sakatat
    is_active = models.BooleanField(default=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ['site', 'plu_code']

    def __str__(self):
        return f"{self.plu_code} - {self.name}"
```

---

## 4. Django URL Configuration

```python
from django.urls import path
from . import views

urlpatterns = [
    # ═══════════════════════════════════════════════════════════════════
    # EDGE API — Called by Edge service (server-to-server, no CORS needed)
    # ═══════════════════════════════════════════════════════════════════
    path('api/v1/edge/edge/register', views.edge_register, name='edge-register'),
    path('api/v1/edge/edge/sessions', views.edge_sessions, name='edge-sessions'),
    path('api/v1/edge/edge/events', views.edge_post_event, name='edge-post-event'),
    path('api/v1/edge/edge/events/batch', views.edge_post_event_batch, name='edge-post-event-batch'),
    path('api/v1/edge/edge/config', views.edge_config, name='edge-config'),
    path('api/v1/edge/edge/devices/status', views.edge_device_status, name='edge-device-status'),

    # ═══════════════════════════════════════════════════════════════════
    # PHONE APP API — Called by mobile app (CORS required)
    # ═══════════════════════════════════════════════════════════════════
    path('api/v1/auth/login/', views.auth_login, name='auth-login'),
    path('api/v1/sessions/', views.SessionListCreateView.as_view(), name='session-list-create'),
    path('api/v1/sessions/<uuid:pk>/', views.SessionDetailView.as_view(), name='session-detail'),
    path('api/v1/events/', views.EventListView.as_view(), name='event-list'),
    path('api/v1/animals/', views.AnimalListView.as_view(), name='animal-list'),
    path('api/v1/devices/', views.DeviceListView.as_view(), name='device-list'),
    path('api/v1/orphaned-batches/', views.OrphanedBatchListView.as_view(), name='orphaned-batch-list'),
    path('api/v1/orphaned-batches/<uuid:pk>/reconcile/', views.reconcile_batch, name='reconcile-batch'),
]
```

---

## 5. Authentication Strategy

### Edge Authentication (Server-to-Server)

The Edge uses header-based identification (not JWT):

```http
X-Edge-Id: <edge-uuid>
X-Site-Id: <site-uuid>
```

**Recommended implementation:**

1. Create a custom DRF authentication class or middleware
2. On **first registration** (`edgeId` is null): Accept based on a `REGISTRATION_TOKEN` or the `siteId` env var
3. After registration: Validate `X-Edge-Id` against `EdgeDevice` table
4. All Edge API endpoints should be scoped to the authenticated Edge's site
5. Optionally add API key or shared secret for extra security

### Phone App Authentication

Standard JWT or token-based auth for the mobile app API endpoints.

---

## 6. Session Lifecycle (Cloud Manages, Edge Caches)

This is the most critical flow to understand:

```
Phone App                    Cloud (Django)                  Edge
    │                            │                            │
    │── POST /api/v1/sessions/ ─►│                            │
    │   {device_id, animal_id}   │── creates session ────────►│
    │                            │   status: "pending"        │
    │                            │                            │
    │                            │  ┌─────────────────────────┤
    │                            │  │ Edge polls every 5s:    │
    │                            │  │ GET /edge/sessions      │
    │                            │  └─────────────────────────┤
    │                            │                            │
    │                            │◄── GET /edge/sessions ─────│
    │                            │── returns [{session}] ────►│
    │                            │                            │── caches session locally
    │                            │                            │── tags future events with cloudSessionId
    │                            │                            │
    │                            │                            │  (scale weighs product, prints label)
    │                            │                            │
    │                            │◄── POST /edge/events ──────│  (real-time, 2-3s latency)
    │                            │── {cloudEventId} ─────────►│
    │                            │                            │
    │                            │── update session stats ───►│  (total_weight, event_count)
    │                            │                            │
    │── PATCH /sessions/{id}/ ──►│                            │
    │   {status: "completed"}    │── session ended ──────────►│
    │                            │                            │
    │                            │  ┌─────────────────────────┤
    │                            │  │ Edge polls:             │
    │                            │  │ Session gone from       │
    │                            │  │ response → remove cache │
    │                            │  └─────────────────────────┤
```

### Session State Machine (Cloud-Managed)

```
              ┌─────────────┐
              │   PENDING   │  ← Created by phone app
              │  (created)  │
              └──────┬──────┘
                     │ First event received from Edge
                     ▼
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│  CANCELLED  │◄──│   ACTIVE    │──►│  COMPLETED  │
│             │   │             │   │             │
└─────────────┘   └──────┬──────┘   └─────────────┘
  Operator cancel        │
                         │ Timeout (configurable)
                         ▼
                  ┌─────────────┐
                  │ AUTO-CLOSED │
                  │  (timeout)  │
                  └─────────────┘
```

**Important:** The Edge only sees `active` and `paused` sessions. All other state transitions are invisible to the Edge — it simply stops receiving the session in poll responses.

---

## 7. Offline Mode & Reconciliation

### When Cloud is Unreachable

1. Edge detects disconnect (REST requests start failing)
2. Edge enters offline mode
3. Edge creates an offline batch per device (UUID-based `offlineBatchId`)
4. Events continue to be captured with:
   - `cloudSessionId: null`
   - `offlineMode: true`
   - `offlineBatchId: <batch-uuid>`
5. Events stored locally in SQLite

### On Reconnection

1. Edge reconnects to Cloud (REST requests succeed)
2. Edge ends offline batches
3. Edge uploads all pending events via `POST /edge/events/batch`
4. Cloud processes events, creates `OrphanedBatch` records

### Reconciliation (Admin/Operator Task)

```
┌─────────────────────────────────────────────────────────────────┐
│  ORPHANED EVENTS NEED ASSIGNMENT                                │
│                                                                  │
│  Batch: offline-batch-uuid (15 events from SCALE-01)            │
│  Time: 14:22 - 15:45                                           │
│                                                                  │
│  Events:                                                        │
│  - 14:22:05  KIYMA      2.5 kg                                 │
│  - 14:23:12  KUSBASI    1.8 kg                                 │
│  - 14:24:45  BUT        3.2 kg                                 │
│  - ... 12 more                                                  │
│                                                                  │
│  Assign to Animal: [A-124 Kuzu ▼]                               │
│                                                                  │
│  [Link All to Animal]  [Create New Session]  [Keep Unlinked]    │
└─────────────────────────────────────────────────────────────────┘
```

**Django must provide:**

1. `GET /api/v1/orphaned-batches/` — List pending batches (for phone app or admin UI)
2. `POST /api/v1/orphaned-batches/{id}/reconcile/` — Assign batch to animal/session
   - Request: `{ "animal_id": "uuid" }` or `{ "session_id": "uuid" }`
   - On reconciliation:
     - Create or find a `DisassemblySession`
     - Update all events in the batch with the `session_id`
     - Update batch status to `reconciled`

---

## 8. Event Data Details

### Weight Data from Scale

| Aspect | Detail |
|--------|--------|
| PLU code | From barcode field. Can be 5-12 digit string (e.g., `000000000004`) |
| Product name | 16 chars, **space-padded** (e.g., `"BONFILE         "`) — trim on Cloud side |
| Weight | In **grams** (integer). Net weight after tare subtraction |
| Barcode | 12-digit string from scale |
| Timestamp | ISO 8601 string, as converted by Edge |

### Deduplication Strategy

| Layer | Method |
|-------|--------|
| **Edge** (local) | In-memory: Same `deviceId + pluCode + weightGrams` within 5 seconds = duplicate |
| **Edge** (database) | SQLite unique index on `(device_id, scale_timestamp, plu_code, weight_grams)` |
| **Cloud** (database) | Unique constraint on `edge_event_id` (`localEventId` from Edge) |

Cloud should always deduplicate by `edge_event_id`. If the event already exists, return `"status": "duplicate"` with the existing `cloudEventId`.

---

## 9. Phone App REST API (For Operators)

These are **separate** from the Edge API and serve the mobile app:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/v1/auth/login/` | User login, return JWT |
| `GET` | `/api/v1/sessions/` | List sessions (filter: `?status=active&site_id=...`) |
| `POST` | `/api/v1/sessions/` | Start session `{ device_id, animal_id, operator }` |
| `PATCH` | `/api/v1/sessions/{id}/` | End session `{ status: "completed" }` |
| `DELETE` | `/api/v1/sessions/{id}/` | Cancel session |
| `GET` | `/api/v1/events/` | List events `?session_id=...&limit=50` |
| `GET` | `/api/v1/events/stream/` | SSE real-time event stream `?session_id=...` |
| `GET` | `/api/v1/devices/` | List devices `?site_id=...&status=online` |
| `GET` | `/api/v1/animals/` | List animals `?site_id=...&status=processing` |
| `GET` | `/api/v1/orphaned-batches/` | List pending batches `?site_id=...&status=pending` |
| `POST` | `/api/v1/orphaned-batches/{id}/reconcile/` | Assign batch to animal |

### Phone App Session Creation Flow

```json
// POST /api/v1/sessions/
{
  "device_id": "scale-device-uuid",   // ScaleDevice UUID (not "SCALE-01")
  "animal_id": "animal-uuid",
  "operator": "MEHMET"
}

// Response
{
  "id": "session-uuid",
  "status": "pending",
  "device": { "id": "...", "device_id": "SCALE-01", "name": "..." },
  "animal": { "id": "...", "tag_number": "A-124", "species": "Kuzu" },
  "started_at": "2026-01-29T10:30:00Z"
}
```

The session will appear in the Edge's next poll of `GET /edge/sessions` (within 5 seconds).

---

## 10. Multi-Edge / Multi-Site Architecture

```
SITE A (Kasap Merkezi)          SITE B (Et Fabrikasi)
┌─────────────────────┐         ┌─────────────────────┐
│ EDGE-A              │         │ EDGE-B              │
│ edge_id: "edge-001" │         │ edge_id: "edge-002" │
│ site_id: "site-A"   │         │ site_id: "site-B"   │
│                     │         │                     │
│ ┌───────┐ ┌───────┐ │         │ ┌───────┐ ┌───────┐ │
│ │SCALE01│ │SCALE02│ │         │ │SCALE01│ │SCALE02│ │
│ └───────┘ └───────┘ │         │ └───────┘ └───────┘ │
└──────────┬──────────┘         └──────────┬──────────┘
           │                               │
           └───────────────┬───────────────┘
                           │
                   ┌───────┴───────┐
                   │     CLOUD     │
                   │   (Django)    │
                   └───────────────┘
```

**Key Points:**

- `device_id` (e.g., `SCALE-01`) is **local** to a site — same name can exist at different sites
- `global_device_id` (e.g., `SITE01-SCALE-01`) is **globally unique** across all sites
- All Edge API requests include `X-Edge-Id` — always scope queries to the requesting Edge
- Use `unique_together = ['edge', 'device_id']` on `ScaleDevice`

---

## 11. CORS & Network Notes

| Aspect | Detail |
|--------|--------|
| Edge → Cloud | Server-to-server (Bun `fetch`). **No CORS needed.** |
| Phone App → Cloud | Browser/WebView. **CORS required.** |
| Edge network | May be behind satellite internet (500-2000ms latency) |
| Edge request timeout | 10 seconds (configurable via `EVENT_SEND_TIMEOUT_MS`) |
| Edge retry | 3 attempts, exponential backoff: 1s → 2s → 4s (max 30s) |
| Edge batch size | 50 events default (configurable via `CLOUD_BATCH_SIZE`) |
| Session poll interval | 5 seconds (configurable via `SESSION_POLL_INTERVAL_MS`) |

---

## 12. Testing Strategy

### Option A: Test Against the Mock Server

The Edge repo includes a mock REST server that simulates Cloud behavior:

```bash
cd Carnitrack_EDGE
bun run src/cloud/mock-rest-server.ts
# Mock server on http://localhost:4000
# Dashboard: http://localhost:4000/
# API tester: http://localhost:4000/api-test
```

Study the mock server code at `src/cloud/mock-rest-server.ts` for exact request/response patterns.

### Option B: Test Django Against Edge

Point the Edge at your Django instance:

```bash
CLOUD_API_URL=http://your-django-host:8000/api/v1 bun run src/index.ts
```

### Integration Test Checklist

- [ ] **Registration:** Edge registers via `POST /edge/register` → receives `edgeId`
- [ ] **Config:** Edge health checks via `GET /edge/config` → 200 response
- [ ] **Sessions:** Edge polls `GET /edge/sessions` → returns active sessions
- [ ] **Single event:** Edge posts event via `POST /edge/events` → receives `cloudEventId`
- [ ] **Batch events:** Edge posts batch via `POST /edge/events/batch` → per-event results
- [ ] **Device status:** Edge posts status via `POST /edge/devices/status` → `{ ok: true }`
- [ ] **Duplicate handling:** Same `localEventId` sent twice → second returns `"duplicate"`
- [ ] **Session discovery:** Session created from phone app → appears in Edge poll within 5s
- [ ] **Session removal:** Session ended from phone app → disappears from Edge poll
- [ ] **Session tagging:** Event posted with `cloudSessionId` → linked to session, stats updated
- [ ] **Offline events:** Events with `offlineMode: true` → `OrphanedBatch` created
- [ ] **Reconciliation:** Orphaned batch reconciled → events linked to session

---

## 13. Quick Reference: Edge Source Files

For deep understanding of the Edge implementation:

| File | Purpose |
|------|---------|
| `src/cloud/rest-client.ts` | HTTP client that calls Cloud REST API |
| `src/cloud/sync-service.ts` | Streams events to Cloud, handles retry/backlog |
| `src/cloud/offline-batch-manager.ts` | Groups offline events into batches |
| `src/cloud/mock-rest-server.ts` | **Mock Cloud server** — study this for exact API contracts |
| `src/sessions/session-cache.ts` | Polls Cloud for sessions, caches locally |
| `src/devices/event-processor.ts` | Processes scale events, tags with session/batch, stores in SQLite |
| `src/devices/scale-parser.ts` | Parses TCP data from scales (registration, heartbeat, CSV events) |
| `src/devices/device-manager.ts` | Tracks connected devices and their health |
| `src/types/index.ts` | All TypeScript type definitions (data contracts) |
| `src/config.ts` | Configuration with env var overrides |
| `src/index.ts` | Main entry point — initialization, TCP handlers, HTTP API |

---

*Document Version: 1.0*
*Generated: February 2026*
*Source: CarniTrack Edge v0.3.0 (REST API, Cloud-Centric)*
