# CarniTrack Edge - Cloud Integration Guide

This document describes how to integrate the CarniTrack Edge service with your Cloud application.

## Table of Contents

1. [Overview](#overview)
2. [WebSocket Connection](#websocket-connection)
3. [Message Protocol](#message-protocol)
4. [Edge Registration](#edge-registration)
5. [Session Management](#session-management)
6. [Event Handling](#event-handling)
7. [Offline Batch Reconciliation](#offline-batch-reconciliation)
8. [Device Management](#device-management)
9. [Error Handling](#error-handling)
10. [Example Implementation](#example-implementation)

---

## Overview

The Edge service connects to Cloud via WebSocket for real-time bidirectional communication. The Edge:

- **Sends**: Device connections, heartbeats, weighing events, offline batches
- **Receives**: Session management, PLU updates, configuration changes, event acknowledgments

### Architecture

```
┌─────────────┐         WebSocket          ┌─────────────┐
│   Edge      │ ◄─────────────────────────► │   Cloud     │
│  Service    │    (Bidirectional)         │ Application │
└─────────────┘                             └─────────────┘
     │                                              │
     │ TCP (Scales)                                 │
     ▼                                              │
┌─────────────┐                                    │
│ DP-401      │                                    │
│ Scales      │                                    │
└─────────────┘                                    │
```

---

## WebSocket Connection

### Connection URL

Edge connects to: `ws://your-cloud-domain/edge` (configurable via `config.websocket.url`)

### Connection Headers

Edge sends these headers on connection:

```
X-Client-Type: carnitrack-edge
X-Client-Version: 0.3.0
X-Edge-Id: <edge-id-if-registered>
X-Site-Id: <site-id-if-registered>
```

### Connection Lifecycle

1. **Edge connects** → Sends `register` message
2. **Cloud authenticates** → Assigns/validates Edge ID
3. **Cloud sends active sessions** → Edge caches them
4. **Connection maintained** → Ping/pong keep-alive
5. **Reconnection** → Edge auto-reconnects with exponential backoff

### Keep-Alive

- **Edge-initiated ping**: Edge sends `ping` every 30 seconds
- **Cloud-initiated ping**: Cloud can send `ping`, Edge responds with `pong`
- **Timeout**: If no pong received within 10 seconds, Edge closes connection

---

## Message Protocol

### Message Format

All messages follow this structure:

```typescript
interface CloudMessage<T = unknown> {
  type: CloudToEdgeMessageType | EdgeToCloudMessageType;
  payload: T;
  timestamp: string;      // ISO 8601
  messageId: string;     // Unique message ID
  edgeId?: string;       // Edge ID (for Edge → Cloud messages)
}
```

### Message Types

#### Edge → Cloud Messages

| Type | Description | When Sent |
|------|-------------|-----------|
| `register` | Edge registration/hello | On connection |
| `device_connected` | Scale connected | When scale registers |
| `device_disconnected` | Scale disconnected | When scale disconnects |
| `device_heartbeat` | Scale heartbeat | Every heartbeat received |
| `event` | Single weighing event | Real-time when Cloud connected |
| `event_batch` | Batch of events | For offline sync |
| `offline_batch_start` | Starting offline mode | When Cloud disconnects |
| `offline_batch_end` | Ending offline mode | When Cloud reconnects |
| `status` | Edge status update | Periodic or on request |
| `ping` | Keep-alive ping | Every 30 seconds |
| `pong` | Keep-alive pong | Response to Cloud ping |

#### Cloud → Edge Messages

| Type | Description | When Sent |
|------|-------------|-----------|
| `session_started` | New session started | When operator starts session |
| `session_ended` | Session ended | When session completes |
| `session_paused` | Session paused | When session paused |
| `session_resumed` | Session resumed | When session resumed |
| `plu_updated` | PLU catalog updated | When PLU changes |
| `event_ack` | Event acknowledgment | After processing event |
| `event_rejected` | Event rejected | If event invalid/duplicate |
| `config_update` | Edge config changed | When config updated |
| `ping` | Keep-alive ping | Optional, Cloud-initiated |
| `pong` | Keep-alive pong | Response to Edge ping |

---

## Edge Registration

### Registration Flow

1. **Edge connects** → Sends `register` message
2. **Cloud checks** → Validates Edge ID or creates new one
3. **Cloud responds** → (via separate endpoint or message)
4. **Edge stores** → Edge ID persisted in database

### Register Message

```typescript
{
  type: "register",
  payload: {
    edgeId: string | null,        // null if first connection
    siteId: string | null,
    siteName: string | null,
    version: "0.3.0",
    capabilities: ["events", "sessions", "offline_batches"]
  },
  timestamp: "2026-01-30T10:00:00Z",
  messageId: "edge-1234567890-1"
}
```

### Cloud Response

Cloud should respond via HTTP endpoint or WebSocket message:

**Option 1: HTTP Endpoint** (Recommended)
```
POST /api/edge/register
Response: { edgeId: "uuid", siteId: "site-01", ... }
```

**Option 2: WebSocket Message**
```typescript
{
  type: "edge_registered",
  payload: {
    edgeId: "uuid",
    siteId: "site-01",
    siteName: "Main Facility"
  }
}
```

---

## Session Management

### Session Lifecycle

Sessions are **Cloud-managed**. Edge only caches active sessions for event tagging.

### 1. Start Session

**Cloud → Edge:**
```typescript
{
  type: "session_started",
  payload: {
    cloudSessionId: "session-uuid",
    deviceId: "SCALE-01",
    animalId: "animal-uuid",
    animalTag: "A-123",
    animalSpecies: "Dana",
    operatorId: "operator-uuid"
  },
  timestamp: "2026-01-30T10:00:00Z",
  messageId: "cloud-1234567890-1"
}
```

**Edge Action:**
- Caches session in `active_sessions_cache` table
- Tags future events with `cloudSessionId`
- Session expires after 24 hours (configurable)

### 2. Update Session

**Cloud → Edge:**
```typescript
{
  type: "session_paused",
  payload: {
    cloudSessionId: "session-uuid",
    deviceId: "SCALE-01"
  }
}
```

**Edge Action:**
- Updates session status in cache
- Continues tagging events with session ID

### 3. End Session

**Cloud → Edge:**
```typescript
{
  type: "session_ended",
  payload: {
    cloudSessionId: "session-uuid",
    deviceId: "SCALE-01",
    reason: "completed" | "cancelled" | "timeout"
  }
}
```

**Edge Action:**
- Removes session from cache
- Future events won't be tagged with this session

### Session Cache Behavior

- **Expiry**: Sessions expire after 24 hours (configurable)
- **Lookup**: Edge looks up active session by `deviceId` when processing events
- **Offline**: If Cloud disconnects, Edge uses cached sessions for event tagging

---

## Event Handling

### Real-Time Event Streaming

When Cloud is connected, Edge streams events immediately:

**Edge → Cloud:**
```typescript
{
  type: "event",
  payload: {
    localEventId: "edge-event-uuid",
    deviceId: "SCALE-01",
    globalDeviceId: "SITE01-SCALE-01",
    cloudSessionId: "session-uuid" | null,
    offlineMode: false,
    offlineBatchId: null,
    pluCode: "00001",
    productName: "KIYMA",
    weightGrams: 1500,
    barcode: "1234567890123",
    scaleTimestamp: "2026-01-30T10:00:00Z",
    receivedAt: "2026-01-30T10:00:01Z"
  },
  timestamp: "2026-01-30T10:00:01Z",
  messageId: "edge-1234567890-2",
  edgeId: "edge-uuid"
}
```

### Event Acknowledgment

**Cloud → Edge:**
```typescript
{
  type: "event_ack",
  payload: {
    localEventId: "edge-event-uuid",
    cloudEventId: "cloud-event-uuid",
    status: "accepted" | "duplicate"
  },
  timestamp: "2026-01-30T10:00:02Z",
  messageId: "cloud-1234567890-2"
}
```

**Edge Action:**
- Marks event as `synced` in database
- Stores `cloudEventId` for reference
- Updates `syncedAt` timestamp

### Event Rejection

**Cloud → Edge:**
```typescript
{
  type: "event_rejected",
  payload: {
    localEventId: "edge-event-uuid",
    reason: "Duplicate event" | "Invalid data" | "Session not found"
  }
}
```

**Edge Action:**
- Marks event as `failed` in database
- Stores error message
- Increments `syncAttempts` counter
- Retries later (if retry logic enabled)

### Batch Event Streaming

For offline sync, Edge sends batches:

**Edge → Cloud:**
```typescript
{
  type: "event_batch",
  payload: {
    events: [
      { /* EventPayload */ },
      { /* EventPayload */ },
      // ... up to batchSize (default: 50)
    ]
  },
  timestamp: "2026-01-30T10:00:00Z",
  messageId: "edge-1234567890-3",
  edgeId: "edge-uuid"
}
```

**Cloud Action:**
- Process each event in batch
- Send individual `event_ack` for each event
- Or send batch acknowledgment (if supported)

---

## Offline Batch Reconciliation

### Offline Batch Lifecycle

When Cloud disconnects, Edge groups events into batches for later reconciliation.

### 1. Batch Start

**Edge → Cloud:**
```typescript
{
  type: "offline_batch_start",
  payload: {
    batchId: "batch-uuid",
    deviceId: "SCALE-01",
    startedAt: "2026-01-30T10:00:00Z"
  }
}
```

**Cloud Action:**
- Log batch start
- Prepare for reconciliation later

### 2. Batch End

When Cloud reconnects, Edge ends the batch:

**Edge → Cloud:**
```typescript
{
  type: "offline_batch_end",
  payload: {
    batchId: "batch-uuid",
    deviceId: "SCALE-01",
    startedAt: "2026-01-30T10:00:00Z",
    endedAt: "2026-01-30T10:15:00Z",
    eventCount: 25,
    totalWeightGrams: 37500
  }
}
```

**Cloud Action:**
- Receive batch summary
- Events are sent separately via `event_batch` or individual `event` messages
- Cloud reconciles batch with appropriate session

### Reconciliation Process

1. **Cloud receives batch end** → Creates reconciliation task
2. **Cloud receives events** → Events tagged with `offlineBatchId`
3. **Operator assigns session** → Cloud matches batch to session
4. **Cloud updates batch** → (Optional: send reconciliation status to Edge)

---

## Device Management

### Device Connected

**Edge → Cloud:**
```typescript
{
  type: "device_connected",
  payload: {
    deviceId: "SCALE-01",
    globalDeviceId: "SITE01-SCALE-01",
    sourceIp: "192.168.1.100",
    deviceType: "disassembly" | "retail" | "receiving"
  }
}
```

**Cloud Action:**
- Register/update device in database
- Check for active sessions for this device
- Send `session_started` if session exists

### Device Disconnected

**Edge → Cloud:**
```typescript
{
  type: "device_disconnected",
  payload: {
    deviceId: "SCALE-01",
    reason: "TCP closed" | "Heartbeat timeout" | "Manual disconnect",
    timestamp: "2026-01-30T10:00:00Z"
  }
}
```

**Cloud Action:**
- Update device status
- Optionally end active session for this device

### Device Heartbeat

**Edge → Cloud:**
```typescript
{
  type: "device_heartbeat",
  payload: {
    deviceId: "SCALE-01",
    globalDeviceId: "SITE01-SCALE-01",
    status: "online" | "idle" | "stale",
    heartbeatCount: 150,
    timestamp: "2026-01-30T10:00:00Z"
  }
}
```

**Cloud Action:**
- Update device last seen timestamp
- Monitor device health
- (Optional: Alert if device stale)

---

## Error Handling

### Connection Errors

**Edge Behavior:**
- Auto-reconnects with exponential backoff
- Queues messages when disconnected (if enabled)
- Flushes queue on reconnect

**Cloud Action:**
- Handle reconnection gracefully
- Accept queued messages
- Don't duplicate process events

### Message Errors

**Invalid Message:**
- Cloud should log error
- Send error response (if applicable)
- Don't crash connection

**Duplicate Events:**
- Cloud should detect duplicates (by `localEventId` or content hash)
- Send `event_ack` with `status: "duplicate"`
- Don't process duplicate

### Timeout Handling

**Event Timeout:**
- If Cloud doesn't acknowledge within timeout, Edge retries
- Edge marks as `failed` after max retries
- Cloud should handle late acknowledgments gracefully

---

## Example Implementation

### Node.js/TypeScript Example

```typescript
import WebSocket from 'ws';

interface EdgeMessage {
  type: string;
  payload: any;
  timestamp: string;
  messageId: string;
  edgeId?: string;
}

class CloudEdgeHandler {
  private ws: WebSocket.Server;
  private edges: Map<string, WebSocket> = new Map();

  constructor(port: number) {
    this.ws = new WebSocket.Server({ port });
    this.setupHandlers();
  }

  private setupHandlers() {
    this.ws.on('connection', (socket, req) => {
      const edgeId = req.headers['x-edge-id'] as string;
      console.log(`Edge connected: ${edgeId}`);

      this.edges.set(edgeId, socket);

      socket.on('message', (data: string) => {
        const message: EdgeMessage = JSON.parse(data);
        this.handleMessage(edgeId, message);
      });

      socket.on('close', () => {
        console.log(`Edge disconnected: ${edgeId}`);
        this.edges.delete(edgeId);
      });

      // Send active sessions for this edge
      this.sendActiveSessions(edgeId);
    });
  }

  private async handleMessage(edgeId: string, message: EdgeMessage) {
    switch (message.type) {
      case 'register':
        await this.handleRegister(edgeId, message.payload);
        break;
      case 'device_connected':
        await this.handleDeviceConnected(edgeId, message.payload);
        break;
      case 'event':
        await this.handleEvent(edgeId, message.payload);
        break;
      case 'event_batch':
        await this.handleEventBatch(edgeId, message.payload);
        break;
      case 'offline_batch_end':
        await this.handleOfflineBatchEnd(edgeId, message.payload);
        break;
      default:
        console.log(`Unknown message type: ${message.type}`);
    }
  }

  private async handleRegister(edgeId: string, payload: any) {
    // Validate or create Edge ID
    const edge = await this.getOrCreateEdge(edgeId, payload);
    
    // Send registration confirmation
    this.send(edgeId, {
      type: 'edge_registered',
      payload: {
        edgeId: edge.id,
        siteId: edge.siteId,
        siteName: edge.siteName
      }
    });
  }

  private async handleEvent(edgeId: string, payload: any) {
    // Process event
    const cloudEvent = await this.processEvent(payload);
    
    // Acknowledge event
    this.send(edgeId, {
      type: 'event_ack',
      payload: {
        localEventId: payload.localEventId,
        cloudEventId: cloudEvent.id,
        status: 'accepted'
      }
    });
  }

  private async handleEventBatch(edgeId: string, payload: any) {
    // Process each event in batch
    for (const event of payload.events) {
      const cloudEvent = await this.processEvent(event);
      
      // Acknowledge each event
      this.send(edgeId, {
        type: 'event_ack',
        payload: {
          localEventId: event.localEventId,
          cloudEventId: cloudEvent.id,
          status: 'accepted'
        }
      });
    }
  }

  // Start a session on a device
  public startSession(deviceId: string, sessionData: any) {
    const edgeId = this.getEdgeIdForDevice(deviceId);
    
    this.send(edgeId, {
      type: 'session_started',
      payload: {
        cloudSessionId: sessionData.id,
        deviceId: deviceId,
        animalId: sessionData.animalId,
        animalTag: sessionData.animalTag,
        animalSpecies: sessionData.animalSpecies,
        operatorId: sessionData.operatorId
      }
    });
  }

  // End a session
  public endSession(deviceId: string, sessionId: string, reason: string) {
    const edgeId = this.getEdgeIdForDevice(deviceId);
    
    this.send(edgeId, {
      type: 'session_ended',
      payload: {
        cloudSessionId: sessionId,
        deviceId: deviceId,
        reason: reason
      }
    });
  }

  private send(edgeId: string, message: Partial<EdgeMessage>) {
    const socket = this.edges.get(edgeId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.warn(`Edge ${edgeId} not connected`);
      return;
    }

    const fullMessage: EdgeMessage = {
      type: message.type!,
      payload: message.payload!,
      timestamp: new Date().toISOString(),
      messageId: `cloud-${Date.now()}-${Math.random()}`
    };

    socket.send(JSON.stringify(fullMessage));
  }

  private async sendActiveSessions(edgeId: string) {
    // Get all active sessions for devices on this edge
    const sessions = await this.getActiveSessionsForEdge(edgeId);
    
    for (const session of sessions) {
      this.send(edgeId, {
        type: 'session_started',
        payload: {
          cloudSessionId: session.id,
          deviceId: session.deviceId,
          animalId: session.animalId,
          animalTag: session.animalTag,
          animalSpecies: session.animalSpecies,
          operatorId: session.operatorId
        }
      });
    }
  }
}
```

### Python Example

```python
import asyncio
import websockets
import json
from typing import Dict

class CloudEdgeHandler:
    def __init__(self):
        self.edges: Dict[str, websockets.WebSocketServerProtocol] = {}
    
    async def handle_edge_connection(self, websocket, path):
        edge_id = websocket.request_headers.get('X-Edge-Id')
        print(f"Edge connected: {edge_id}")
        
        self.edges[edge_id] = websocket
        
        try:
            # Send active sessions
            await self.send_active_sessions(edge_id)
            
            async for message in websocket:
                data = json.loads(message)
                await self.handle_message(edge_id, data)
        except websockets.exceptions.ConnectionClosed:
            print(f"Edge disconnected: {edge_id}")
            self.edges.pop(edge_id, None)
    
    async def handle_message(self, edge_id: str, message: dict):
        msg_type = message.get('type')
        payload = message.get('payload', {})
        
        if msg_type == 'register':
            await self.handle_register(edge_id, payload)
        elif msg_type == 'event':
            await self.handle_event(edge_id, payload)
        elif msg_type == 'event_batch':
            await self.handle_event_batch(edge_id, payload)
    
    async def handle_event(self, edge_id: str, payload: dict):
        # Process event
        cloud_event = await self.process_event(payload)
        
        # Acknowledge
        await self.send(edge_id, {
            'type': 'event_ack',
            'payload': {
                'localEventId': payload['localEventId'],
                'cloudEventId': cloud_event['id'],
                'status': 'accepted'
            }
        })
    
    async def start_session(self, device_id: str, session_data: dict):
        edge_id = self.get_edge_id_for_device(device_id)
        
        await self.send(edge_id, {
            'type': 'session_started',
            'payload': {
                'cloudSessionId': session_data['id'],
                'deviceId': device_id,
                'animalId': session_data['animalId'],
                'animalTag': session_data['animalTag'],
                'animalSpecies': session_data['animalSpecies'],
                'operatorId': session_data['operatorId']
            }
        })
    
    async def send(self, edge_id: str, message: dict):
        if edge_id not in self.edges:
            print(f"Edge {edge_id} not connected")
            return
        
        websocket = self.edges[edge_id]
        full_message = {
            'type': message['type'],
            'payload': message['payload'],
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'messageId': f"cloud-{int(time.time() * 1000)}-{random.randint(1000, 9999)}"
        }
        
        await websocket.send(json.dumps(full_message))

# Start server
handler = CloudEdgeHandler()
start_server = websockets.serve(handler.handle_edge_connection, "0.0.0.0", 8080)

asyncio.get_event_loop().run_until_complete(start_server)
asyncio.get_event_loop().run_forever()
```

---

## Testing Integration

### Test Checklist

- [ ] Edge connects and sends `register` message
- [ ] Cloud responds with Edge ID
- [ ] Cloud sends active sessions on connection
- [ ] Edge caches sessions correctly
- [ ] Events are streamed in real-time
- [ ] Event acknowledgments work
- [ ] Offline batches are created on disconnect
- [ ] Offline batches are synced on reconnect
- [ ] Session start/end messages are handled
- [ ] Reconnection works correctly
- [ ] Message queue flushes on reconnect

### Test Tools

Use WebSocket testing tools:
- **wscat**: `npm install -g wscat`
- **Postman**: WebSocket support
- **Custom test client**: Use examples above

---

## Configuration

### Edge Configuration

Edge WebSocket URL is configured in `src/config.ts`:

```typescript
websocket: {
  url: "ws://your-cloud-domain/edge",
  reconnectDelayMs: 5000,
  maxReconnectDelayMs: 60000,
  pingIntervalMs: 30000,
  pingTimeoutMs: 10000,
}
```

### Cloud Requirements

- WebSocket server on `/edge` endpoint
- Support for custom headers (`X-Edge-Id`, etc.)
- Message queuing for disconnected edges (optional)
- Session management API
- Event processing pipeline
- Database for events, sessions, devices

---

## Security Considerations

1. **Authentication**: Validate Edge ID on connection
2. **Authorization**: Check Edge belongs to correct site
3. **Rate Limiting**: Limit message frequency
4. **Message Validation**: Validate all message payloads
5. **TLS**: Use `wss://` in production
6. **Message Size**: Limit payload size (default: reasonable)

---

## Support

For issues or questions:
- GitHub Issues: [Repository URL]
- Documentation: See `README.md`
- Architecture: See `CARNITRACK_ARCHITECTURE_V2.md`

---

**Last Updated**: January 30, 2026  
**Edge Version**: 0.3.0
