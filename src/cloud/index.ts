/**
 * CarniTrack Edge - Cloud Communication Module
 * 
 * Handles all communication between Edge and Cloud services:
 * - WebSocket client for real-time bidirectional communication
 * - Auto-reconnection with exponential backoff
 * - Message queuing when offline
 * - Offline batch management
 * 
 * @see GitHub Issue #4, #7
 */

export {
  WebSocketClient,
  initWebSocketClient,
  getWebSocketClient,
  destroyWebSocketClient,
  type WebSocketClientOptions,
} from "./websocket-client.ts";

export {
  OfflineBatchManager,
  initOfflineBatchManager,
  getOfflineBatchManager,
  destroyOfflineBatchManager,
} from "./offline-batch-manager.ts";

export {
  CloudSyncService,
  initCloudSyncService,
  getCloudSyncService,
  destroyCloudSyncService,
  type SyncStatus,
  type SyncResult,
} from "./sync-service.ts";
