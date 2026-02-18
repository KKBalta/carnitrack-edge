/**
 * CarniTrack Edge - REST Client
 * 
 * HTTP-based client for communicating with Cloud REST API.
 * Replaces WebSocket client for simpler, more reliable communication.
 * 
 * Features:
 * - HTTP client using fetch (Bun built-in)
 * - Retry logic with exponential backoff
 * - Request queue for offline buffering
 * - Authentication header injection
 * - Connection state tracking
 * 
 * @see Plan: websocket_to_rest_pivot_4f27b93c.plan.md
 */

import { config } from "../config.ts";
import { isValidUuid } from "../utils/uuid.ts";
import type {
  CloudConnectionState,
  EdgeIdentity,
  EventPayload,
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
  consecutiveFailures: number;
}

/** Event types emitted by REST client */
type RestClientEvent = 
  | "connected"
  | "disconnected"
  | "error"
  | "state_change";

/** Event callback signatures */
type EventCallback<T = unknown> = (data: T) => void;

/** Options for REST client */
export interface RestClientOptions {
  /** API base URL (defaults to config.rest.apiUrl) */
  apiUrl?: string;
  
  /** Edge identity for authentication */
  edgeIdentity?: EdgeIdentity | null;
  
  /** Whether to auto-start (begin polling) */
  autoStart?: boolean;
  
  /** Whether to queue requests when offline */
  queueWhenOffline?: boolean;
  
  /** Max queued requests (oldest dropped when exceeded) */
  maxQueueSize?: number;

  /**
   * Callback used to (re)obtain a valid edge identity.
   * - missing_or_invalid: local identity missing or malformed before request
   * - auth_recovery: backend rejected edge identity (invalid/unknown)
   */
  ensureEdgeIdentity?: (
    reason: "missing_or_invalid" | "auth_recovery"
  ) => Promise<EdgeIdentity>;
}

/** REST API response for event POST */
export interface EventPostResponse {
  cloudEventId: string;
  status: "accepted" | "duplicate";
}

/** REST API response for batch POST */
export interface BatchPostResponse {
  results: Array<{
    localEventId: string;
    cloudEventId: string;
    status: "accepted" | "duplicate" | "failed";
    error?: string;
  }>;
}

/** REST API response for sessions GET */
export interface SessionsResponse {
  sessions: Array<{
    cloudSessionId: string;
    deviceId: string;
    animalId?: string | null;
    animalTag?: string | null;
    animalSpecies?: string | null;
    operatorId?: string | null;
    status: "active" | "paused";
  }>;
}

/** Queued request */
interface QueuedRequest {
  method: string;
  path: string;
  body?: unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  retries: number;
  timestamp: Date;
}

/** Error thrown when REST request fails with HTTP status (e.g. 400/401/404) for contract handling */
export class RestResponseError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly bodyText: string = ""
  ) {
    super(message);
    this.name = "RestResponseError";
  }
}

/** Edge API path suffixes (no duplicated /edge/; backend prefix is /api/v1/edge/) */
const EDGE_PATHS = [
  "/register",
  "/sessions",
  "/events",
  "/events/batch",
  "/config",
  "/devices/status",
] as const;

function isEdgePath(path: string): boolean {
  const basePath = path.split("?")[0];
  return EDGE_PATHS.some((p) => basePath === p || basePath.startsWith(p + "/"));
}

// ═══════════════════════════════════════════════════════════════════════════════
// REST CLIENT CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class RestClient {
  private apiUrl: string;
  private edgeIdentity: EdgeIdentity | null;
  private ensureEdgeIdentityHandler?: RestClientOptions["ensureEdgeIdentity"];
  
  // Connection state
  private state: ConnectionStateInfo = {
    status: "disconnected",
    lastConnected: null,
    lastDisconnected: null,
    lastError: null,
    consecutiveFailures: 0,
  };
  
  // Request queue
  private requestQueue: QueuedRequest[] = [];
  private queueWhenOffline: boolean;
  private maxQueueSize: number;
  
  // Event listeners
  private eventListeners: Map<RestClientEvent, Set<EventCallback>> = new Map();
  
  // Online status (based on recent request success)
  private isOnlineFlag: boolean = false;
  private lastSuccessfulRequest: Date | null = null;
  
  constructor(options: RestClientOptions = {}) {
    this.apiUrl = options.apiUrl || config.rest.apiUrl;
    this.edgeIdentity = this.normalizeEdgeIdentity(options.edgeIdentity || null);
    this.ensureEdgeIdentityHandler = options.ensureEdgeIdentity;
    this.queueWhenOffline = options.queueWhenOffline ?? true;
    this.maxQueueSize = options.maxQueueSize ?? 100;
    
    if (options.autoStart) {
      this.start();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CONNECTION MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Start the REST client (mark as active)
   */
  start(): void {
    this.updateState("connecting");
    // Try a health check to determine initial state
    this.checkConnection().catch(() => {
      // Ignore initial check failures
    });
  }

  /**
   * Stop the REST client
   */
  stop(): void {
    this.updateState("disconnected");
    this.requestQueue = [];
  }

  /**
   * Check if currently online (based on recent request success)
   */
  isOnline(): boolean {
    // Consider online if we had a successful request in the last 30 seconds
    if (this.lastSuccessfulRequest) {
      const timeSinceSuccess = Date.now() - this.lastSuccessfulRequest.getTime();
      return timeSinceSuccess < 30_000;
    }
    return this.isOnlineFlag;
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
   * Update edge identity (for authentication headers)
   */
  setEdgeIdentity(identity: EdgeIdentity): void {
    this.edgeIdentity = this.normalizeEdgeIdentity(identity);
  }

  /**
   * Clear edge identity in memory (used before re-registration)
   */
  clearEdgeIdentity(): void {
    this.edgeIdentity = null;
  }

  /**
   * Base URL for Edge API (exactly one /edge segment: /api/v1/edge).
   * Normalizes CLOUD_API_URL whether it ends with /api/v1 or /api/v1/edge.
   */
  private getEdgeBaseUrl(): string {
    const base = this.apiUrl.replace(/\/+$/, "").replace(/\/edge\/?$/i, "");
    return `${base}/edge`;
  }

  /**
   * Build full request URL (no duplicated /edge/).
   */
  private buildRequestUrl(path: string): string {
    const base = isEdgePath(path) ? this.getEdgeBaseUrl() : this.apiUrl.replace(/\/+$/, "");
    return `${base}${path}`;
  }

  /** Public edge API base URL for logging (e.g. after registration). */
  getEdgeApiBase(): string {
    return this.getEdgeBaseUrl();
  }

  /**
   * Check connection by making a lightweight request
   */
  private async checkConnection(): Promise<boolean> {
    try {
      const response = await this.request("GET", "/config", undefined, { timeout: 5000 });
      if (response.ok) {
        this.markOnline();
        return true;
      }
      this.markOffline();
      return false;
    } catch {
      this.markOffline();
      return false;
    }
  }

  private markOnline(): void {
    if (!this.isOnlineFlag) {
      this.isOnlineFlag = true;
      this.state.lastConnected = new Date();
      this.state.consecutiveFailures = 0;
      this.state.lastError = null;
      this.updateState("connected");
      this.emit("connected", { timestamp: new Date() });
      
      // Flush queued requests
      this.flushQueue();
    }
    this.lastSuccessfulRequest = new Date();
  }

  private markOffline(): void {
    if (this.isOnlineFlag) {
      this.isOnlineFlag = false;
      this.state.lastDisconnected = new Date();
      this.updateState("disconnected");
      this.emit("disconnected", { timestamp: new Date() });
    }
    this.state.consecutiveFailures++;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HTTP REQUEST METHODS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Make an HTTP request with retry logic
   */
  private async request(
    method: string,
    path: string,
    body?: unknown,
    options: { timeout?: number; skipRetry?: boolean; skipEdgeRecovery?: boolean } = {}
  ): Promise<Response> {
    if (this.isAuthenticatedEdgePath(path)) {
      await this.ensureEdgeIdentity("missing_or_invalid");
    }

    const url = this.buildRequestUrl(path);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Client-Type": "carnitrack-edge",
      "X-Client-Version": "0.3.0",
    };
    
    // Add authentication headers
    if (this.isAuthenticatedEdgePath(path)) {
      if (!this.edgeIdentity?.edgeId || !isValidUuid(this.edgeIdentity.edgeId)) {
        throw new Error("Missing valid Edge identity for authenticated request");
      }
      headers["X-Edge-Id"] = this.edgeIdentity.edgeId;
      if (this.edgeIdentity.siteId) {
        headers["X-Site-Id"] = this.edgeIdentity.siteId;
      }
    } else if (this.edgeIdentity?.siteId) {
      // Keep optional site header for non-auth endpoints to preserve behavior.
      headers["X-Site-Id"] = this.edgeIdentity.siteId;
    }
    
    const requestOptions: RequestInit = {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    };
    
    // Add timeout using AbortController
    const controller = new AbortController();
    const timeout = options.timeout || config.rest.eventSendTimeoutMs;
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    requestOptions.signal = controller.signal;
    
    let lastError: Error | null = null;
    let retries = 0;
    const maxRetries = options.skipRetry ? 0 : config.rest.maxRetries;
    
    while (retries <= maxRetries) {
      try {
        const response = await fetch(url, requestOptions);
        clearTimeout(timeoutId);
        
        if (response.ok) {
          this.markOnline();
          return response;
        }

        // Let register() handle non-2xx so it can throw RestResponseError with status/bodyText
        if (path === "/register") {
          this.markOffline();
          return response;
        }

        if (
          !options.skipEdgeRecovery &&
          this.isAuthenticatedEdgePath(path) &&
          await this.isInvalidEdgeResponse(response)
        ) {
          console.warn(
            `[REST] Invalid edge identity rejected by backend (${response.status}). Triggering re-register + single retry for ${method} ${path}`
          );
          await this.ensureEdgeIdentity("auth_recovery");
          return this.request(method, path, body, {
            ...options,
            skipEdgeRecovery: true,
          });
        }
        
        // 4xx errors shouldn't be retried (except 429)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          this.markOffline();
          lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
          break;
        }
        
        // 5xx and 429 should be retried
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        
      } catch (error) {
        clearTimeout(timeoutId);
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // Network errors should be retried
        if (error instanceof TypeError && error.message.includes("fetch")) {
          // Network error
        } else if (error instanceof Error && error.name === "AbortError") {
          // Timeout
          lastError = new Error("Request timeout");
        }
      }
      
      // Retry with exponential backoff
      if (retries < maxRetries) {
        const delay = Math.min(
          config.rest.retryDelayMs * Math.pow(config.rest.retryBackoffMultiplier, retries),
          config.rest.maxRetryDelayMs
        );
        await new Promise(resolve => setTimeout(resolve, delay));
        retries++;
      } else {
        break;
      }
    }
    
    this.markOffline();
    throw lastError || new Error("Request failed after retries");
  }

  private normalizeEdgeIdentity(identity: EdgeIdentity | null): EdgeIdentity | null {
    if (!identity) {
      return null;
    }
    if (!isValidUuid(identity.edgeId)) {
      console.warn(
        `[REST] Ignoring malformed edgeId in memory: ${identity.edgeId}`
      );
      return null;
    }
    return identity;
  }

  private isAuthenticatedEdgePath(path: string): boolean {
    return isEdgePath(path) && path !== "/register";
  }

  private async ensureEdgeIdentity(
    reason: "missing_or_invalid" | "auth_recovery"
  ): Promise<void> {
    if (reason === "missing_or_invalid" && this.edgeIdentity?.edgeId && isValidUuid(this.edgeIdentity.edgeId)) {
      return;
    }

    if (!this.ensureEdgeIdentityHandler) {
      if (reason === "missing_or_invalid") {
        throw new Error("No edge identity available and no ensureEdgeIdentity handler configured");
      }
      return;
    }

    const identity = await this.ensureEdgeIdentityHandler(reason);
    this.edgeIdentity = this.normalizeEdgeIdentity(identity);
    if (!this.edgeIdentity) {
      throw new Error("ensureEdgeIdentity handler returned invalid edge identity");
    }
  }

  private async isInvalidEdgeResponse(response: Response): Promise<boolean> {
    if (response.status !== 401 && response.status !== 404) {
      return false;
    }

    let bodyText = "";
    try {
      bodyText = (await response.clone().text()).toLowerCase();
    } catch {
      return false;
    }

    return (
      bodyText.includes("missing") ||
      bodyText.includes("invalid edge") ||
      bodyText.includes("unknown edge") ||
      bodyText.includes("invalid_edge") ||
      bodyText.includes("unknown_edge") ||
      bodyText.includes("x-edge-id")
    );
  }

  /**
   * Queue a request for later execution
   */
  private queueRequest(
    method: string,
    path: string,
    body?: unknown
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      // Drop oldest if queue is full
      while (this.requestQueue.length >= this.maxQueueSize) {
        const oldest = this.requestQueue.shift();
        oldest?.reject(new Error("Request queue full, dropped"));
      }
      
      this.requestQueue.push({
        method,
        path,
        body,
        resolve,
        reject,
        retries: 0,
        timestamp: new Date(),
      });
      
      console.log(`[REST] Request queued (${this.requestQueue.length} pending): ${method} ${path}`);
    });
  }

  /**
   * Flush queued requests
   */
  private async flushQueue(): Promise<void> {
    if (this.requestQueue.length === 0) return;
    
    console.log(`[REST] Flushing ${this.requestQueue.length} queued requests...`);
    
    const queue = [...this.requestQueue];
    this.requestQueue = [];
    
    for (const queued of queue) {
      try {
        const response = await this.request(queued.method, queued.path, queued.body);
        const data = await response.json();
        queued.resolve(data);
      } catch (error) {
        // Re-queue if still failing
        if (this.queueWhenOffline) {
          this.requestQueue.push(queued);
        } else {
          queued.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
  }

  /**
   * Get count of queued requests
   */
  getQueueSize(): number {
    return this.requestQueue.length;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // API METHODS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Register Edge with Cloud
   * @throws RestResponseError on 4xx/5xx (caller can use status/bodyText for 400/404 recovery)
   */
  async register(registrationData: {
    edgeId?: string | null;
    siteId?: string | null;
    siteName?: string | null;
    version: string;
    capabilities: string[];
  }): Promise<{
    edgeId: string;
    siteId: string;
    siteName: string;
    config: Record<string, unknown>;
  }> {
    const response = await this.request("POST", "/register", registrationData);
    if (!response.ok) {
      const bodyText = await response.text();
      throw new RestResponseError(
        `Registration failed: ${response.status} ${response.statusText}`,
        response.status,
        bodyText
      );
    }
    return await response.json() as {
      edgeId: string;
      siteId: string;
      siteName: string;
      config: Record<string, unknown>;
    };
  }

  /**
   * Get active sessions for devices
   */
  async getSessions(deviceIds: string[]): Promise<SessionsResponse> {
    const deviceIdsParam = deviceIds.join(",");
    const response = await this.request("GET", `/sessions?device_ids=${deviceIdsParam}`);
    if (!response.ok) {
      throw new Error(`Get sessions failed: ${response.statusText}`);
    }
    return await response.json() as SessionsResponse;
  }

  /**
   * Post a single event
   */
  async postEvent(eventPayload: EventPayload): Promise<EventPostResponse> {
    if (!this.isOnline() && this.queueWhenOffline) {
      return this.queueRequest("POST", "/events", eventPayload) as Promise<EventPostResponse>;
    }
    
    const response = await this.request("POST", "/events", eventPayload);
    if (!response.ok) {
      if (this.queueWhenOffline) {
        return this.queueRequest("POST", "/events", eventPayload) as Promise<EventPostResponse>;
      }
      throw new Error(`Post event failed: ${response.statusText}`);
    }
    return await response.json() as EventPostResponse;
  }

  /**
   * Post a batch of events
   */
  async postEventBatch(events: EventPayload[]): Promise<BatchPostResponse> {
    if (!this.isOnline() && this.queueWhenOffline) {
      return this.queueRequest("POST", "/events/batch", { events }) as Promise<BatchPostResponse>;
    }
    
    const response = await this.request("POST", "/events/batch", { events });
    if (!response.ok) {
      if (this.queueWhenOffline) {
        return this.queueRequest("POST", "/events/batch", { events }) as Promise<BatchPostResponse>;
      }
      throw new Error(`Post batch failed: ${response.statusText}`);
    }
    return await response.json() as BatchPostResponse;
  }

  /**
   * Post device status update
   */
  async postDeviceStatus(statusData: {
    deviceId: string;
    status: string;
    heartbeatCount: number;
    eventCount: number;
    [key: string]: unknown;
  }): Promise<{ ok: boolean }> {
    if (!this.isOnline() && this.queueWhenOffline) {
      return this.queueRequest("POST", "/devices/status", statusData) as Promise<{ ok: boolean }>;
    }
    
    const response = await this.request("POST", "/devices/status", statusData);
    if (!response.ok) {
      if (this.queueWhenOffline) {
        return this.queueRequest("POST", "/devices/status", statusData) as Promise<{ ok: boolean }>;
      }
      throw new Error(`Post device status failed: ${response.statusText}`);
    }
    return await response.json() as { ok: boolean };
  }

  /**
   * Get Edge configuration from Cloud
   */
  async getConfig(): Promise<Record<string, unknown>> {
    const response = await this.request("GET", "/config");
    if (!response.ok) {
      throw new Error(`Get config failed: ${response.statusText}`);
    }
    return await response.json() as Record<string, unknown>;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // EVENT SYSTEM
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to client events
   */
  on<T = unknown>(event: RestClientEvent, callback: EventCallback<T>): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    
    this.eventListeners.get(event)!.add(callback as EventCallback);
    
    // Return unsubscribe function
    return () => {
      this.eventListeners.get(event)?.delete(callback as EventCallback);
    };
  }

  private emit<T = unknown>(event: RestClientEvent, data: T): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      for (const callback of listeners) {
        try {
          callback(data);
        } catch (err) {
          console.error(`[REST] Event listener error for ${event}:`, err);
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

  /**
   * Clean up resources
   */
  destroy(): void {
    this.stop();
    this.eventListeners.clear();
    this.requestQueue = [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════════════════

let globalClient: RestClient | null = null;

/**
 * Initialize the global REST client
 */
export function initRestClient(options?: RestClientOptions): RestClient {
  if (globalClient) {
    console.warn("[REST] Client already initialized, returning existing instance");
    return globalClient;
  }
  
  globalClient = new RestClient(options);
  return globalClient;
}

/**
 * Get the global REST client instance
 */
export function getRestClient(): RestClient | null {
  return globalClient;
}

/**
 * Destroy the global REST client
 */
export function destroyRestClient(): void {
  if (globalClient) {
    globalClient.destroy();
    globalClient = null;
  }
}
