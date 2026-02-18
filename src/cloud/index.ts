/**
 * CarniTrack Edge - Cloud Communication Module
 * 
 * Handles all communication between Edge and Cloud services:
 * - REST client for HTTP-based communication
 * - Retry logic with exponential backoff
 * - Request queuing when offline
 * - Session polling for active sessions
 * - Offline batch management
 * 
 * @see Plan: websocket_to_rest_pivot_4f27b93c.plan.md
 */

export {
  RestClient,
  RestResponseError,
  initRestClient,
  getRestClient,
  destroyRestClient,
  type RestClientOptions,
  type EventPostResponse,
  type BatchPostResponse,
  type SessionsResponse,
} from "./rest-client.ts";

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
