/**
 * CarniTrack Edge - WebSocket Client
 * 
 * Maintains a persistent WebSocket connection to the Cloud service
 * for real-time bidirectional communication.
 * 
 * Features:
 * - Auto-reconnect with exponential backoff
 * - Ping/pong keep-alive
 * - Typed message protocol
 * - Event-based architecture
 * - Queue messages when disconnected (optional)
 * 
 * @see GitHub Issue #4
 */

import { config } from "../config.ts";
import type {
  CloudConnectionState,
  CloudMessage,
  CloudToEdgeMessageType,
  EdgeToCloudMessageType,
  EdgeIdentity,
} from "../types/index.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Internal connection state tracking */
interface ConnectionStateInfo {
  status: CloudConnectionState;
  lastConnected: Date | null;
  lastDisconnected: Date | null;
  lastError: string | null;
  reconnectAttempts: number;
  currentReconnectDelay: number;
}

/** Event types emitted by WebSocket client */
type WebSocketClientEvent = 
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "message"
  | "error"
  | "state_change";

/** Event callback signatures */
type EventCallback<T = unknown> = (data: T) => void;

/** Message handler for specific message types */
type MessageHandler<T = unknown> = (payload: T, message: CloudMessage<T>) => void;

/** Options for WebSocket client */
export interface WebSocketClientOptions {
  /** WebSocket URL (defaults to config.websocket.url) */
  url?: string;
  
  /** Edge identity for registration */
  edgeIdentity?: EdgeIdentity | null;
  
  /** Whether to auto-connect on creation */
  autoConnect?: boolean;
  
  /** Whether to queue messages when disconnected */
  queueWhenDisconnected?: boolean;
  
  /** Max queued messages (oldest dropped when exceeded) */
  maxQueueSize?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET CLIENT CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class WebSocketClient {
  private socket: WebSocket | null = null;
  private url: string;
  private edgeIdentity: EdgeIdentity | null;
  
  // Connection state
  private state: ConnectionStateInfo = {
    status: "disconnected",
    lastConnected: null,
    lastDisconnected: null,
    lastError: null,
    reconnectAttempts: 0,
    currentReconnectDelay: config.websocket.reconnectDelayMs,
  };
  
  // Timers
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPongReceived: Date | null = null;
  
  // Event listeners
  private eventListeners: Map<WebSocketClientEvent, Set<EventCallback>> = new Map();
  private messageHandlers: Map<CloudToEdgeMessageType, Set<MessageHandler>> = new Map();
  
  // Message queue (for when disconnected)
  private messageQueue: CloudMessage[] = [];
  private queueWhenDisconnected: boolean;
  private maxQueueSize: number;
  
  // Message ID counter for correlation
  private messageIdCounter = 0;
  
  // Pending acknowledgments (messageId -> resolver)
  private pendingAcks: Map<string, { 
    resolve: (success: boolean) => void; 
    timeout: ReturnType<typeof setTimeout>;
  }> = new Map();

  constructor(options: WebSocketClientOptions = {}) {
    this.url = options.url || config.websocket.url;
    this.edgeIdentity = options.edgeIdentity || null;
    this.queueWhenDisconnected = options.queueWhenDisconnected ?? true;
    this.maxQueueSize = options.maxQueueSize ?? 100;
    
    if (options.autoConnect) {
      this.connect();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CONNECTION MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Connect to the Cloud WebSocket server
   */
  async connect(): Promise<void> {
    if (this.socket && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)) {
      console.log("[WS] Already connected or connecting");
      return;
    }
    
    this.clearReconnectTimer();
    this.updateState("connecting");
    
    console.log(`[WS] Connecting to ${this.url}...`);
    
    try {
      // Create WebSocket with custom headers (Bun-specific)
      const headers: Record<string, string> = {
        "X-Client-Type": "carnitrack-edge",
        "X-Client-Version": "0.3.0",
      };
      
      if (this.edgeIdentity?.edgeId) {
        headers["X-Edge-Id"] = this.edgeIdentity.edgeId;
      }
      if (this.edgeIdentity?.siteId) {
        headers["X-Site-Id"] = this.edgeIdentity.siteId;
      }
      
      this.socket = new WebSocket(this.url, { headers } as WebSocketInit);
      this.setupSocketListeners();
    } catch (error) {
      console.error("[WS] Connection error:", error);
      this.handleConnectionError(error as Error);
    }
  }

  /**
   * Disconnect from the Cloud server
   */
  disconnect(): void {
    console.log("[WS] Disconnecting...");
    
    this.clearAllTimers();
    
    if (this.socket) {
      // Remove listeners to prevent reconnection attempt
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.close(1000, "Client disconnected");
      this.socket = null;
    }
    
    this.updateState("disconnected");
    this.state.reconnectAttempts = 0;
    this.state.currentReconnectDelay = config.websocket.reconnectDelayMs;
    
    this.emit("disconnected", { reason: "manual", wasClean: true });
  }

  /**
   * Check if currently connected
   */
  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionStateInfo {
    return { ...this.state };
  }

  /**
   * Get connection status
   */
  getStatus(): CloudConnectionState {
    return this.state.status;
  }

  /**
   * Update edge identity (for registration after Cloud assigns ID)
   */
  setEdgeIdentity(identity: EdgeIdentity): void {
    this.edgeIdentity = identity;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SOCKET EVENT HANDLERS
  // ─────────────────────────────────────────────────────────────────────────────

  private setupSocketListeners(): void {
    if (!this.socket) return;
    
    this.socket.onopen = () => {
      console.log("[WS] ✓ Connected to Cloud");
      
      this.updateState("connected");
      this.state.lastConnected = new Date();
      this.state.reconnectAttempts = 0;
      this.state.currentReconnectDelay = config.websocket.reconnectDelayMs;
      this.state.lastError = null;
      
      // Start ping/pong keep-alive
      this.startPingPong();
      
      // Send registration message
      this.sendRegistration();
      
      // Flush queued messages
      this.flushMessageQueue();
      
      this.emit("connected", { 
        timestamp: new Date(),
        reconnectAttempts: this.state.reconnectAttempts,
      });
    };
    
    this.socket.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };
    
    this.socket.onclose = (event: CloseEvent) => {
      console.log(`[WS] Connection closed: code=${event.code}, reason=${event.reason || "unknown"}, clean=${event.wasClean}`);
      
      this.state.lastDisconnected = new Date();
      this.stopPingPong();
      
      this.emit("disconnected", { 
        code: event.code, 
        reason: event.reason,
        wasClean: event.wasClean,
      });
      
      // Attempt reconnection unless it was a clean close (manual disconnect)
      if (event.code !== 1000) {
        this.scheduleReconnect();
      } else {
        this.updateState("disconnected");
      }
    };
    
    this.socket.onerror = (event: Event) => {
      console.error("[WS] Socket error:", event);
      this.handleConnectionError(new Error("WebSocket error"));
    };
  }

  private handleConnectionError(error: Error): void {
    this.state.lastError = error.message;
    this.updateState("error");
    
    this.emit("error", { error: error.message, timestamp: new Date() });
    
    // Schedule reconnection
    this.scheduleReconnect();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RECONNECTION LOGIC
  // ─────────────────────────────────────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return; // Already scheduled
    
    this.state.reconnectAttempts++;
    this.updateState("reconnecting");
    
    const delay = this.state.currentReconnectDelay;
    
    console.log(`[WS] Reconnecting in ${delay / 1000}s (attempt #${this.state.reconnectAttempts})...`);
    
    this.emit("reconnecting", {
      attempt: this.state.reconnectAttempts,
      delay,
      nextAttemptAt: new Date(Date.now() + delay),
    });
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      
      // Increase delay with exponential backoff
      this.state.currentReconnectDelay = Math.min(
        this.state.currentReconnectDelay * config.websocket.reconnectBackoffMultiplier,
        config.websocket.maxReconnectDelayMs
      );
      
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PING/PONG KEEP-ALIVE
  // ─────────────────────────────────────────────────────────────────────────────

  private startPingPong(): void {
    this.stopPingPong(); // Clear any existing
    
    this.pingTimer = setInterval(() => {
      if (!this.isConnected()) return;
      
      // Send ping
      this.sendPing();
      
      // Set timeout for pong response
      this.pingTimeoutTimer = setTimeout(() => {
        const lastPong = this.lastPongReceived?.getTime() || 0;
        const timeSincePong = Date.now() - lastPong;
        
        if (timeSincePong > config.websocket.pingIntervalMs + config.websocket.pingTimeoutMs) {
          console.warn("[WS] Ping timeout - connection may be dead");
          // Force close to trigger reconnection
          this.socket?.close(4000, "Ping timeout");
        }
      }, config.websocket.pingTimeoutMs);
      
    }, config.websocket.pingIntervalMs);
  }

  private stopPingPong(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pingTimeoutTimer) {
      clearTimeout(this.pingTimeoutTimer);
      this.pingTimeoutTimer = null;
    }
  }

  private sendPing(): void {
    const pingMessage: CloudMessage = {
      type: "ping", // Edge-initiated keep-alive ping
      payload: { timestamp: new Date().toISOString() },
      timestamp: new Date().toISOString(),
      messageId: this.generateMessageId(),
      edgeId: this.edgeIdentity?.edgeId,
    };
    
    this.sendRaw(JSON.stringify(pingMessage));
  }

  private handlePong(): void {
    this.lastPongReceived = new Date();
    
    if (this.pingTimeoutTimer) {
      clearTimeout(this.pingTimeoutTimer);
      this.pingTimeoutTimer = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // MESSAGE HANDLING
  // ─────────────────────────────────────────────────────────────────────────────

  private handleMessage(data: string | Buffer): void {
    try {
      const text = typeof data === "string" ? data : data.toString();
      const message = JSON.parse(text) as CloudMessage;
      
      // Handle ping from server (server-initiated keep-alive)
      if (message.type === "ping") {
        // Send pong response
        this.send({ type: "pong", payload: {} });
        return;
      }
      
      // Handle pong from server (response to Edge-initiated ping)
      if (message.type === "pong") {
        this.handlePong();
        return;
      }
      
      // Handle acknowledgment
      if (message.type === "event_ack" || message.type === "ack") {
        this.handleAck(message);
        return;
      }
      
      console.log(`[WS] ← Received: ${message.type}`);
      
      // Emit generic message event
      this.emit("message", message);
      
      // Dispatch to specific type handlers
      const handlers = this.messageHandlers.get(message.type as CloudToEdgeMessageType);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(message.payload, message);
          } catch (err) {
            console.error(`[WS] Handler error for ${message.type}:`, err);
          }
        }
      }
    } catch (err) {
      console.error("[WS] Failed to parse message:", err);
    }
  }

  private handleAck(message: CloudMessage): void {
    const ackPayload = message.payload as { messageId?: string; localEventId?: string };
    const messageId = ackPayload.messageId || ackPayload.localEventId;
    
    if (messageId && this.pendingAcks.has(messageId)) {
      const pending = this.pendingAcks.get(messageId)!;
      clearTimeout(pending.timeout);
      pending.resolve(true);
      this.pendingAcks.delete(messageId);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SENDING MESSAGES
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Send a message to Cloud
   * Returns true if sent, false if queued or failed
   */
  send<T = unknown>(message: { type: EdgeToCloudMessageType; payload: T }): boolean {
    const fullMessage: CloudMessage<T> = {
      type: message.type,
      payload: message.payload,
      timestamp: new Date().toISOString(),
      messageId: this.generateMessageId(),
      edgeId: this.edgeIdentity?.edgeId,
    };
    
    if (this.isConnected()) {
      return this.sendRaw(JSON.stringify(fullMessage));
    }
    
    // Queue for later if enabled
    if (this.queueWhenDisconnected) {
      this.queueMessage(fullMessage);
      return false;
    }
    
    console.warn("[WS] Cannot send - not connected and queue disabled");
    return false;
  }

  /**
   * Send a message and wait for acknowledgment
   */
  async sendWithAck<T = unknown>(
    message: { type: EdgeToCloudMessageType; payload: T },
    timeout: number = 10000
  ): Promise<boolean> {
    const messageId = this.generateMessageId();
    
    const fullMessage: CloudMessage<T> = {
      type: message.type,
      payload: message.payload,
      timestamp: new Date().toISOString(),
      messageId,
      edgeId: this.edgeIdentity?.edgeId,
    };
    
    if (!this.isConnected()) {
      if (this.queueWhenDisconnected) {
        this.queueMessage(fullMessage);
      }
      return false;
    }
    
    return new Promise((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingAcks.delete(messageId);
        resolve(false);
      }, timeout);
      
      this.pendingAcks.set(messageId, { resolve, timeout: timeoutHandle });
      
      if (!this.sendRaw(JSON.stringify(fullMessage))) {
        clearTimeout(timeoutHandle);
        this.pendingAcks.delete(messageId);
        resolve(false);
      }
    });
  }

  private sendRaw(data: string): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    
    try {
      this.socket.send(data);
      return true;
    } catch (err) {
      console.error("[WS] Send error:", err);
      return false;
    }
  }

  private sendRegistration(): void {
    console.log("[WS] → Sending registration...");
    
    this.send({
      type: "register",
      payload: {
        edgeId: this.edgeIdentity?.edgeId || null,
        siteId: this.edgeIdentity?.siteId || null,
        siteName: this.edgeIdentity?.siteName || null,
        version: "0.3.0",
        capabilities: ["events", "sessions", "offline_batches"],
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // MESSAGE QUEUE
  // ─────────────────────────────────────────────────────────────────────────────

  private queueMessage(message: CloudMessage): void {
    // Drop oldest if queue is full
    while (this.messageQueue.length >= this.maxQueueSize) {
      this.messageQueue.shift();
    }
    
    this.messageQueue.push(message);
    console.log(`[WS] Message queued (${this.messageQueue.length} pending)`);
  }

  private flushMessageQueue(): void {
    if (this.messageQueue.length === 0) return;
    
    console.log(`[WS] Flushing ${this.messageQueue.length} queued messages...`);
    
    const queue = [...this.messageQueue];
    this.messageQueue = [];
    
    for (const message of queue) {
      if (!this.sendRaw(JSON.stringify(message))) {
        // Re-queue if send fails
        this.messageQueue.push(message);
      }
    }
  }

  /**
   * Get count of queued messages
   */
  getQueueSize(): number {
    return this.messageQueue.length;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // EVENT SYSTEM
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to client events
   */
  on<T = unknown>(event: WebSocketClientEvent, callback: EventCallback<T>): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    
    this.eventListeners.get(event)!.add(callback as EventCallback);
    
    // Return unsubscribe function
    return () => {
      this.eventListeners.get(event)?.delete(callback as EventCallback);
    };
  }

  /**
   * Subscribe to specific message types from Cloud
   */
  onMessage<T = unknown>(type: CloudToEdgeMessageType, handler: MessageHandler<T>): () => void {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, new Set());
    }
    
    this.messageHandlers.get(type)!.add(handler as MessageHandler);
    
    // Return unsubscribe function
    return () => {
      this.messageHandlers.get(type)?.delete(handler as MessageHandler);
    };
  }

  private emit<T = unknown>(event: WebSocketClientEvent, data: T): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      for (const callback of listeners) {
        try {
          callback(data);
        } catch (err) {
          console.error(`[WS] Event listener error for ${event}:`, err);
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // UTILITY
  // ─────────────────────────────────────────────────────────────────────────────

  private updateState(status: CloudConnectionState): void {
    const previousStatus = this.state.status;
    this.state.status = status;
    
    if (previousStatus !== status) {
      this.emit("state_change", { 
        previousStatus, 
        currentStatus: status,
        timestamp: new Date(),
      });
    }
  }

  private generateMessageId(): string {
    return `edge-${Date.now()}-${++this.messageIdCounter}`;
  }

  private clearAllTimers(): void {
    this.clearReconnectTimer();
    this.stopPingPong();
    
    // Clear all pending ack timeouts
    for (const [, pending] of this.pendingAcks) {
      clearTimeout(pending.timeout);
      pending.resolve(false);
    }
    this.pendingAcks.clear();
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.disconnect();
    this.eventListeners.clear();
    this.messageHandlers.clear();
    this.messageQueue = [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════════════════

let globalClient: WebSocketClient | null = null;

/**
 * Initialize the global WebSocket client
 */
export function initWebSocketClient(options?: WebSocketClientOptions): WebSocketClient {
  if (globalClient) {
    console.warn("[WS] Client already initialized, returning existing instance");
    return globalClient;
  }
  
  globalClient = new WebSocketClient(options);
  return globalClient;
}

/**
 * Get the global WebSocket client instance
 */
export function getWebSocketClient(): WebSocketClient | null {
  return globalClient;
}

/**
 * Destroy the global WebSocket client
 */
export function destroyWebSocketClient(): void {
  if (globalClient) {
    globalClient.destroy();
    globalClient = null;
  }
}

// Type for WebSocketInit (Bun-specific)
interface WebSocketInit {
  headers?: Record<string, string>;
}
