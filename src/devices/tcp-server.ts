/**
 * CarniTrack Edge TCP Server
 * 
 * Accepts connections from DP-401 WiFi-enabled scales.
 * Scales connect as TCP clients to this server on port 8899.
 * 
 * Connection Flow:
 * 1. Scale connects → TCP connection established
 * 2. Scale sends registration packet: "SCALE-XX"
 * 3. Scale sends heartbeat every 30s: "HB"
 * 4. Scale sends weighing events when label is printed
 * 5. Server responds with "OK\n" to acknowledge events
 */

import { config } from "../config.ts";
import type { Socket } from "bun";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Socket metadata stored for each connection */
export interface SocketMeta {
  /** Unique socket ID (UUID) */
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

/** TCP server callbacks */
export interface TCPServerCallbacks {
  /** Called when a new connection is established */
  onConnection: (socketId: string, meta: SocketMeta) => void;
  /** Called when data is received from a socket */
  onData: (socketId: string, data: Buffer, meta: SocketMeta) => void;
  /** Called when a socket disconnects */
  onDisconnect: (socketId: string, meta: SocketMeta, reason: string) => void;
  /** Called when a socket error occurs */
  onError: (socketId: string, meta: SocketMeta | null, error: Error) => void;
}

/** TCP server configuration */
export interface TCPServerConfig {
  port: number;
  host: string;
}

/** TCP server stats */
export interface TCPServerStats {
  startedAt: Date | null;
  totalConnections: number;
  totalBytesReceived: number;
  totalBytesSent: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGER (Simple console logger with timestamps)
// ═══════════════════════════════════════════════════════════════════════════════

const LOG_PREFIX = "[TCP Server]";

function log(level: "debug" | "info" | "warn" | "error", ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const levelColors = {
    debug: "\x1b[90m", // gray
    info: "\x1b[36m",  // cyan
    warn: "\x1b[33m",  // yellow
    error: "\x1b[31m", // red
  };
  const reset = "\x1b[0m";
  
  if (config.logging.level === "debug" || 
      (config.logging.level === "info" && level !== "debug") ||
      (config.logging.level === "warn" && (level === "warn" || level === "error")) ||
      level === "error") {
    console.log(`${levelColors[level]}${timestamp} ${LOG_PREFIX} [${level.toUpperCase()}]${reset}`, ...args);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UUID GENERATOR
// ═══════════════════════════════════════════════════════════════════════════════

function generateSocketId(): string {
  return `sock_${crypto.randomUUID().split("-")[0]}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TCP SERVER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

// Type for TCP socket listener
type TCPSocketListener = {
  stop(closeActiveConnections?: boolean): void;
  reload(options: unknown): void;
  ref(): void;
  unref(): void;
  readonly hostname: string;
  readonly port: number;
};

export class TCPServer {
  private server: TCPSocketListener | null = null;
  private sockets: Map<string, Socket<SocketMeta>> = new Map();
  private socketMetaMap: Map<string, SocketMeta> = new Map();
  private callbacks: TCPServerCallbacks;
  private config: TCPServerConfig;
  private stats: TCPServerStats;
  private isRunning: boolean = false;
  private actualPort: number = 0;

  constructor(callbacks: TCPServerCallbacks, serverConfig?: Partial<TCPServerConfig>) {
    this.callbacks = callbacks;
    this.config = {
      port: serverConfig?.port ?? config.tcp.port,
      host: serverConfig?.host ?? config.tcp.host,
    };
    this.stats = {
      startedAt: null,
      totalConnections: 0,
      totalBytesReceived: 0,
      totalBytesSent: 0,
    };
  }

  /**
   * Start the TCP server
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      log("warn", "Server is already running");
      return;
    }

    const self = this;

    try {
      this.server = Bun.listen<SocketMeta>({
        hostname: this.config.host,
        port: this.config.port,
        
        socket: {
          // ─────────────────────────────────────────────────────────────────────
          // OPEN - New connection established
          // ─────────────────────────────────────────────────────────────────────
          open(socket) {
            const socketId = generateSocketId();
            const remoteAddress = socket.remoteAddress || "unknown";
            
            const meta: SocketMeta = {
              id: socketId,
              remoteAddress: remoteAddress,
              remotePort: 0, // Bun doesn't expose remote port easily
              connectedAt: new Date(),
              lastDataAt: null,
              deviceId: null,
              closing: false,
            };

            // Store socket and meta data
            socket.data = meta;
            self.sockets.set(socketId, socket);
            self.socketMetaMap.set(socketId, meta);
            self.stats.totalConnections++;

            log("info", `Connection established: ${socketId} from ${remoteAddress}`);
            
            // Notify callback
            self.callbacks.onConnection(socketId, meta);
          },

          // ─────────────────────────────────────────────────────────────────────
          // DATA - Data received from socket
          // ─────────────────────────────────────────────────────────────────────
          data(socket, data) {
            const meta = socket.data;
            if (!meta) return;

            const buffer = Buffer.from(data);
            meta.lastDataAt = new Date();
            self.stats.totalBytesReceived += buffer.length;

            log("debug", `Data received from ${meta.id}: ${buffer.length} bytes`);

            // Notify callback
            self.callbacks.onData(meta.id, buffer, meta);
          },

          // ─────────────────────────────────────────────────────────────────────
          // CLOSE - Connection closed
          // ─────────────────────────────────────────────────────────────────────
          close(socket) {
            const meta = socket.data;
            if (!meta) return;

            // Prevent duplicate close handling
            if (meta.closing) return;
            meta.closing = true;

            const reason = "Socket closed";
            log("info", `Connection closed: ${meta.id} (${meta.deviceId || "unregistered"}) - ${reason}`);

            // Clean up maps
            self.sockets.delete(meta.id);
            self.socketMetaMap.delete(meta.id);

            // Notify callback
            self.callbacks.onDisconnect(meta.id, meta, reason);
          },

          // ─────────────────────────────────────────────────────────────────────
          // ERROR - Socket error occurred
          // ─────────────────────────────────────────────────────────────────────
          error(socket, error) {
            const meta = socket.data;
            const socketId = meta?.id || "unknown";

            log("error", `Socket error on ${socketId}:`, error.message);

            // Notify callback
            self.callbacks.onError(socketId, meta || null, error);

            // Socket will be closed automatically after error
          },

          // ─────────────────────────────────────────────────────────────────────
          // DRAIN - Write buffer drained (socket ready for more data)
          // ─────────────────────────────────────────────────────────────────────
          drain(socket) {
            // Log when socket is ready to accept more data
            const meta = socket.data;
            if (meta) {
              log("debug", `Socket ${meta.id} drained and ready for writes`);
            }
          },
        },
      }) as unknown as TCPSocketListener;

      this.isRunning = true;
      this.stats.startedAt = new Date();
      
      // Get actual port (may differ from config.port if port was 0)
      this.actualPort = this.server.port;
      
      log("info", `═══════════════════════════════════════════════════════════════`);
      log("info", `  TCP Server started on ${this.config.host}:${this.actualPort}`);
      log("info", `  Waiting for DP-401 scale connections...`);
      log("info", `═══════════════════════════════════════════════════════════════`);

    } catch (error) {
      log("error", "Failed to start TCP server:", error);
      throw error;
    }
  }

  /**
   * Stop the TCP server and close all connections
   */
  async stop(): Promise<void> {
    if (!this.isRunning || !this.server) {
      log("warn", "Server is not running");
      return;
    }

    log("info", "Stopping TCP server...");

    // Close all active connections
    const closePromises: Promise<void>[] = [];
    for (const [socketId] of this.sockets) {
      closePromises.push(this.closeSocket(socketId, "Server shutdown"));
    }
    await Promise.all(closePromises);

    // Stop listening for new connections
    this.server.stop();
    this.server = null;
    this.isRunning = false;

    log("info", "TCP server stopped");
  }

  /**
   * Close a specific socket connection
   */
  async closeSocket(socketId: string, reason: string = "Closed by server"): Promise<void> {
    const socket = this.sockets.get(socketId);
    const meta = this.socketMetaMap.get(socketId);

    if (!socket || !meta) {
      log("warn", `Cannot close socket ${socketId}: not found`);
      return;
    }

    if (meta.closing) {
      return; // Already closing
    }

    meta.closing = true;
    log("info", `Closing socket ${socketId}: ${reason}`);

    try {
      socket.end();
    } catch (error) {
      log("warn", `Error closing socket ${socketId}:`, error);
    }

    // Clean up maps
    this.sockets.delete(socketId);
    this.socketMetaMap.delete(socketId);

    // Notify callback
    this.callbacks.onDisconnect(socketId, meta, reason);
  }

  /**
   * Send data to a specific socket
   */
  send(socketId: string, data: Buffer | string): boolean {
    const socket = this.sockets.get(socketId);
    if (!socket) {
      log("warn", `Cannot send to socket ${socketId}: not found`);
      return false;
    }

    try {
      const bytes = typeof data === "string" ? Buffer.from(data) : data;
      const written = socket.write(bytes);
      this.stats.totalBytesSent += bytes.length;
      log("debug", `Sent ${bytes.length} bytes to ${socketId}`);
      return written > 0;
    } catch (error) {
      log("error", `Error sending to socket ${socketId}:`, error);
      return false;
    }
  }

  /**
   * Send data to all connected sockets
   */
  broadcast(data: Buffer | string): number {
    let successCount = 0;
    for (const socketId of this.sockets.keys()) {
      if (this.send(socketId, data)) {
        successCount++;
      }
    }
    log("debug", `Broadcast to ${successCount}/${this.sockets.size} sockets`);
    return successCount;
  }

  /**
   * Get socket metadata by socket ID
   */
  getSocketMeta(socketId: string): SocketMeta | undefined {
    return this.socketMetaMap.get(socketId);
  }

  /**
   * Update socket metadata (e.g., set device ID after registration)
   */
  updateSocketMeta(socketId: string, updates: Partial<SocketMeta>): boolean {
    const meta = this.socketMetaMap.get(socketId);
    if (!meta) return false;

    Object.assign(meta, updates);
    
    // Also update the socket.data reference
    const socket = this.sockets.get(socketId);
    if (socket) {
      Object.assign(socket.data, updates);
    }

    return true;
  }

  /**
   * Find socket ID by device ID
   */
  findSocketByDeviceId(deviceId: string): string | undefined {
    for (const [socketId, meta] of this.socketMetaMap) {
      if (meta.deviceId === deviceId) {
        return socketId;
      }
    }
    return undefined;
  }

  /**
   * Get all active connections
   */
  getActiveConnections(): Map<string, SocketMeta> {
    return new Map(this.socketMetaMap);
  }

  /**
   * Get number of active connections
   */
  get connectionCount(): number {
    return this.sockets.size;
  }

  /**
   * Get server statistics
   */
  getStats(): TCPServerStats & { connectionCount: number; isRunning: boolean } {
    return {
      ...this.stats,
      connectionCount: this.sockets.size,
      isRunning: this.isRunning,
    };
  }

  /**
   * Check if server is running
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Get server address info
   */
  getAddress(): { host: string; port: number } | null {
    if (!this.isRunning) return null;
    return {
      host: this.config.host,
      port: this.actualPort || this.config.port,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FACTORY FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a new TCP server instance with default callbacks (logging only)
 * Useful for testing or when you want to attach callbacks later
 */
export function createTCPServer(
  callbacks?: Partial<TCPServerCallbacks>,
  serverConfig?: Partial<TCPServerConfig>
): TCPServer {
  const defaultCallbacks: TCPServerCallbacks = {
    onConnection: (socketId, meta) => {
      log("info", `[Callback] New connection: ${socketId} from ${meta.remoteAddress}`);
    },
    onData: (socketId, data, _meta) => {
      const preview = data.toString("utf-8").substring(0, 100).replace(/\r?\n/g, "\\n");
      log("debug", `[Callback] Data from ${socketId}: ${preview}`);
    },
    onDisconnect: (socketId, meta, reason) => {
      log("info", `[Callback] Disconnected: ${socketId} (${meta.deviceId || "unregistered"}) - ${reason}`);
    },
    onError: (socketId, _meta, error) => {
      log("error", `[Callback] Error on ${socketId}:`, error.message);
    },
  };

  return new TCPServer(
    { ...defaultCallbacks, ...callbacks },
    serverConfig
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE (for global access)
// ═══════════════════════════════════════════════════════════════════════════════

let globalTCPServer: TCPServer | null = null;

/**
 * Get or create the global TCP server instance
 */
export function getGlobalTCPServer(): TCPServer | null {
  return globalTCPServer;
}

/**
 * Set the global TCP server instance
 */
export function setGlobalTCPServer(server: TCPServer): void {
  globalTCPServer = server;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT DEFAULT
// ═══════════════════════════════════════════════════════════════════════════════

export default TCPServer;
