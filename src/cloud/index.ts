/**
 * CarniTrack Edge - Cloud Communication Module
 * 
 * Handles all communication between Edge and Cloud services:
 * - WebSocket client for real-time bidirectional communication
 * - Auto-reconnection with exponential backoff
 * - Message queuing when offline
 * 
 * @see GitHub Issue #4
 */

export {
  WebSocketClient,
  initWebSocketClient,
  getWebSocketClient,
  destroyWebSocketClient,
  type WebSocketClientOptions,
} from "./websocket-client.ts";
