/**
 * CarniTrack Edge Scale Parser
 * 
 * Parses TCP data from DP-401 scales into structured packets.
 * 
 * Packet Types:
 * 1. Registration: "SCALE-XX" - Device identification on connect
 * 2. Heartbeat: "HB" - Keep-alive every 30 seconds
 * 3. Weighing Event: CSV format with PLU, weight, timestamp, etc.
 * 4. Ack Request: "KONTROLLU AKTAR OK?" - Requests acknowledgment
 * 
 * TCP Stream Handling:
 * - DP-401 scales send data WITHOUT newlines (just raw packets)
 * - Data may arrive in chunks (fragmented packets)
 * - Multiple packets may arrive in a single chunk
 * - Parser detects known packet patterns in the buffer
 */

import type { ParsedScaleEvent, ScaleMessage } from "../types/index.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/** Registration packet pattern: SCALE-XX where XX is 01-99 (anywhere in string) */
const REGISTRATION_PATTERN = /SCALE-(\d{2})/;

/** Heartbeat literal */
const HEARTBEAT_LITERAL = "HB";

/** Acknowledgment request from scale */
const ACK_REQUEST_LITERAL = "KONTROLLU AKTAR OK?";

/** Line delimiters (for weighing events which DO have newlines) */
const LINE_DELIMITERS = /\r?\n|\r/;

/** Max buffer size per socket (prevent memory issues) */
const MAX_BUFFER_SIZE = 64 * 1024; // 64KB

/** Expected minimum fields in weighing event CSV */
const MIN_EVENT_FIELDS = 10;

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Extended parsed packet types */
export type ParsedPacketType = 
  | "registration"
  | "heartbeat"
  | "weighing_event"
  | "ack_request"
  | "unknown";

/** Parsed packet discriminated union */
export type ParsedPacket = 
  | { type: "registration"; scaleNumber: string; deviceId: string; raw: string }
  | { type: "heartbeat"; raw: string }
  | { type: "weighing_event"; event: WeighingEventData; raw: string }
  | { type: "ack_request"; raw: string }
  | { type: "unknown"; raw: string; reason: string };

/** Weighing event data extracted from scale CSV */
export interface WeighingEventData {
  /** PLU code (e.g., "00001") */
  pluCode: string;
  
  /** Time from scale (HH:MM:SS) */
  time: string;
  
  /** Date from scale (DD.MM.YYYY) */
  date: string;
  
  /** Combined timestamp */
  timestamp: Date;
  
  /** Product name (16 chars, padded) */
  productName: string;
  
  /** Barcode (12 digits) */
  barcode: string;
  
  /** Code field (purpose unclear, kept for reference) */
  code: string;
  
  /** Operator name (48 chars, padded) */
  operator: string;
  
  /** Weight in grams (parsed from 10-digit field) */
  weightGrams: number;
  
  /** Value 1 (cumulative/total - stored for reference) */
  value1: string;
  
  /** Value 2 (calculated value - stored for reference) */
  value2: string;
  
  /** Flags from scale */
  flags: string[];
  
  /** Company name */
  company: string;
  
  /** Original raw line */
  rawData: string;
}

/** Parser result for a data chunk */
export interface ParseResult {
  /** Successfully parsed packets */
  packets: ParsedPacket[];
  
  /** Remaining data to buffer for next chunk */
  remainder: string;
  
  /** Any parse errors encountered */
  errors: ParseError[];
}

/** Parse error details */
export interface ParseError {
  line: string;
  reason: string;
  index: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGER
// ═══════════════════════════════════════════════════════════════════════════════

const LOG_PREFIX = "[Scale Parser]";

function log(level: "debug" | "info" | "warn" | "error", ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const levelColors = {
    debug: "\x1b[90m",
    info: "\x1b[36m",
    warn: "\x1b[33m",
    error: "\x1b[31m",
  };
  const reset = "\x1b[0m";
  console.log(`${levelColors[level]}${timestamp} ${LOG_PREFIX} [${level.toUpperCase()}]${reset}`, ...args);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARSER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Scale data parser with per-socket buffering
 * 
 * Usage:
 * ```typescript
 * const parser = new ScaleParser();
 * 
 * // On TCP data received:
 * const result = parser.parse(socketId, dataBuffer);
 * for (const packet of result.packets) {
 *   switch (packet.type) {
 *     case "registration": // Handle registration
 *     case "heartbeat": // Handle heartbeat
 *     case "weighing_event": // Handle event
 *   }
 * }
 * 
 * // On socket disconnect:
 * parser.clearBuffer(socketId);
 * ```
 */
export class ScaleParser {
  /** Per-socket data buffers for TCP stream reassembly */
  private buffers: Map<string, string> = new Map();

  /**
   * Parse incoming TCP data chunk
   * 
   * DP-401 scales send data WITHOUT newlines for most packets:
   * - Registration: "SCALE-XX" (8 bytes, no newline)
   * - Heartbeat: "HB" (2 bytes, no newline)
   * - Weighing events: CSV with newlines
   * 
   * @param socketId - Socket identifier for buffer tracking
   * @param data - Raw data buffer from TCP
   * @returns ParseResult with packets, remainder, and any errors
   */
  parse(socketId: string, data: Buffer): ParseResult {
    const packets: ParsedPacket[] = [];
    const errors: ParseError[] = [];

    // Get existing buffer and append new data
    let buffer = this.buffers.get(socketId) || "";
    buffer += data.toString("utf-8");

    // Safety check: prevent buffer from growing too large
    if (buffer.length > MAX_BUFFER_SIZE) {
      log("warn", `Buffer overflow for ${socketId}, clearing (${buffer.length} bytes)`);
      buffer = buffer.slice(-MAX_BUFFER_SIZE / 2); // Keep last half
    }

    // Process buffer, extracting known patterns
    let position = 0;
    while (position < buffer.length) {
      const remaining = buffer.slice(position);
      
      // Try to match known patterns at current position
      const { packet, consumed } = this.extractPacket(remaining);
      
      if (packet) {
        packets.push(packet);
        position += consumed;
        
        if (packet.type === "unknown") {
          log("debug", `Unknown packet: ${packet.raw.substring(0, 50)}...`);
        }
      } else {
        // No pattern matched at current position
        // Check if we have a complete line (for CSV events)
        const lineEnd = remaining.search(LINE_DELIMITERS);
        if (lineEnd !== -1) {
          // Found a line ending - extract and parse the line
          const line = remaining.slice(0, lineEnd).trim();
          if (line) {
            try {
              const linePacket = this.parseLine(line);
              packets.push(linePacket);
            } catch (error) {
              errors.push({
                line: line.substring(0, 100),
                reason: error instanceof Error ? error.message : "Unknown error",
                index: position,
              });
              log("warn", `Parse error: ${error}`);
            }
          }
          // Move past the line and delimiter
          const delimiterMatch = remaining.slice(lineEnd).match(/^\r?\n|\r/);
          position += lineEnd + (delimiterMatch ? delimiterMatch[0].length : 0);
        } else {
          // No complete pattern or line - buffer the rest
          break;
        }
      }
    }

    // Store remaining unprocessed data in buffer
    const remainder = buffer.slice(position);
    this.buffers.set(socketId, remainder);

    return { packets, remainder, errors };
  }

  /**
   * Try to extract a known packet pattern from the start of a string
   * Returns the packet and how many characters were consumed
   */
  private extractPacket(data: string): { packet: ParsedPacket | null; consumed: number } {
    // 1. Check for registration: "SCALE-XX" (8 chars)
    const regMatch = data.match(/^SCALE-(\d{2})/);
    if (regMatch) {
      return {
        packet: {
          type: "registration",
          scaleNumber: regMatch[1],
          deviceId: regMatch[0],
          raw: regMatch[0],
        },
        consumed: regMatch[0].length,
      };
    }

    // 2. Check for heartbeat: "HB" (2 chars)
    if (data.startsWith(HEARTBEAT_LITERAL)) {
      return {
        packet: {
          type: "heartbeat",
          raw: HEARTBEAT_LITERAL,
        },
        consumed: 2,
      };
    }

    // 3. Check for ack request: "KONTROLLU AKTAR OK?" (19 chars)
    if (data.startsWith(ACK_REQUEST_LITERAL)) {
      return {
        packet: {
          type: "ack_request",
          raw: ACK_REQUEST_LITERAL,
        },
        consumed: ACK_REQUEST_LITERAL.length,
      };
    }

    // No known pattern found
    return { packet: null, consumed: 0 };
  }

  /**
   * Parse a single complete line
   */
  private parseLine(line: string): ParsedPacket {
    // 1. Check for registration packet: SCALE-XX
    const registrationMatch = line.match(REGISTRATION_PATTERN);
    if (registrationMatch) {
      const scaleNumber = registrationMatch[1];
      return {
        type: "registration",
        scaleNumber,
        deviceId: `SCALE-${scaleNumber}`,
        raw: line,
      };
    }

    // 2. Check for heartbeat: HB
    if (line === HEARTBEAT_LITERAL) {
      return {
        type: "heartbeat",
        raw: line,
      };
    }

    // 3. Check for acknowledgment request
    if (line === ACK_REQUEST_LITERAL || line.includes(ACK_REQUEST_LITERAL)) {
      return {
        type: "ack_request",
        raw: line,
      };
    }

    // 4. Try to parse as weighing event (CSV format)
    if (line.includes(",")) {
      const eventData = this.parseWeighingEvent(line);
      if (eventData) {
        return {
          type: "weighing_event",
          event: eventData,
          raw: line,
        };
      }
    }

    // 5. Unknown packet type
    return {
      type: "unknown",
      raw: line,
      reason: "No matching pattern",
    };
  }

  /**
   * Parse weighing event from CSV line
   * 
   * Format from DP-401:
   * PLU,TIME,DATE,PRODUCT,BARCODE,CODE,OPERATOR,VAL1,WEIGHT,VAL2,FLAGS...,COMPANY
   * 
   * Example:
   * 00001,13:59:59,15.01.2026,KIYMA           ,000000000001,0000,KAAN...,0038319236,0000000035,0038319201,0,0,0,1,N,KORKUT KAAN BALTA
   */
  private parseWeighingEvent(line: string): WeighingEventData | null {
    const fields = line.split(",");
    
    // Minimum fields check
    if (fields.length < MIN_EVENT_FIELDS) {
      log("debug", `Event has too few fields: ${fields.length} < ${MIN_EVENT_FIELDS}`);
      return null;
    }

    // Extract PLU code - may have prefixes like P" from scale acknowledgment response
    let pluCode = fields[0]?.trim() || "";
    
    // Strip P" prefix if present (scale sends this after acknowledgment)
    if (pluCode.startsWith('P"')) {
      pluCode = pluCode.slice(2);
      log("debug", `Stripped P" prefix, PLU now: ${pluCode}`);
    }
    // Also handle just P prefix
    if (pluCode.startsWith('P')) {
      pluCode = pluCode.slice(1);
      log("debug", `Stripped P prefix, PLU now: ${pluCode}`);
    }
    // Strip any leading/trailing quotes
    pluCode = pluCode.replace(/^["']|["']$/g, "");
    
    // Validate PLU code format (5 digits)
    if (!pluCode || !/^\d{5}$/.test(pluCode)) {
      log("debug", `Invalid PLU code: ${pluCode}`);
      return null;
    }

    // Validate time format (HH:MM:SS)
    const time = fields[1]?.trim();
    if (!time || !/^\d{2}:\d{2}:\d{2}$/.test(time)) {
      log("debug", `Invalid time format: ${time}`);
      return null;
    }

    // Validate date format (DD.MM.YYYY)
    const date = fields[2]?.trim();
    if (!date || !/^\d{2}\.\d{2}\.\d{4}$/.test(date)) {
      log("debug", `Invalid date format: ${date}`);
      return null;
    }

    // Parse timestamp
    const timestamp = this.parseTimestamp(date, time);

    // Extract fields
    const productName = fields[3]?.trim() || "";
    const barcode = fields[4]?.trim() || "";
    const code = fields[5]?.trim() || "";
    const operator = fields[6]?.trim() || "";
    const value1 = fields[7]?.trim() || "";
    
    // Weight is at index 8, typically 10 digits representing grams
    const weightRaw = fields[8]?.trim() || "0";
    const weightGrams = this.parseWeight(weightRaw);
    
    const value2 = fields[9]?.trim() || "";
    
    // Flags are the remaining fields until company (typically last)
    // Structure: 0,0,0,1,N,COMPANY
    // Company is usually the last field
    const flagsAndCompany = fields.slice(10);
    const company = flagsAndCompany.pop()?.trim() || "";
    const flags = flagsAndCompany.map(f => f.trim());

    return {
      pluCode,
      time,
      date,
      timestamp,
      productName,
      barcode,
      code,
      operator,
      weightGrams,
      value1,
      value2,
      flags,
      company,
      rawData: line,
    };
  }

  /**
   * Parse timestamp from DD.MM.YYYY and HH:MM:SS
   */
  private parseTimestamp(date: string, time: string): Date {
    try {
      const [day, month, year] = date.split(".");
      const [hours, minutes, seconds] = time.split(":");
      
      return new Date(
        parseInt(year, 10),
        parseInt(month, 10) - 1, // JS months are 0-indexed
        parseInt(day, 10),
        parseInt(hours, 10),
        parseInt(minutes, 10),
        parseInt(seconds, 10)
      );
    } catch {
      log("warn", `Failed to parse timestamp: ${date} ${time}`);
      return new Date();
    }
  }

  /**
   * Parse weight from raw value
   * 
   * The DP-401 sends weight as a 10-digit number.
   * Based on the example "0000000035" = 35 (likely grams or 0.035 kg)
   * 
   * TODO: Verify with known weights whether this is grams directly
   */
  private parseWeight(raw: string): number {
    const weight = parseInt(raw, 10);
    if (isNaN(weight)) {
      log("warn", `Failed to parse weight: ${raw}`);
      return 0;
    }
    
    // According to DP-401 protocol, this appears to be grams directly
    // but may need calibration testing
    return weight;
  }

  /**
   * Clear buffer for a socket (call on disconnect)
   */
  clearBuffer(socketId: string): void {
    this.buffers.delete(socketId);
    log("debug", `Cleared buffer for ${socketId}`);
  }

  /**
   * Get current buffer size for a socket
   */
  getBufferSize(socketId: string): number {
    return this.buffers.get(socketId)?.length || 0;
  }

  /**
   * Get all buffer sizes (for debugging)
   */
  getAllBufferSizes(): Map<string, number> {
    const sizes = new Map<string, number>();
    for (const [socketId, buffer] of this.buffers) {
      sizes.set(socketId, buffer.length);
    }
    return sizes;
  }

  /**
   * Clear all buffers
   */
  clearAllBuffers(): void {
    this.buffers.clear();
    log("debug", "Cleared all buffers");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STANDALONE PARSING FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse a single packet (without buffering)
 * Use when you have a complete line already
 */
export function parsePacket(data: string): ParsedPacket {
  const parser = new ScaleParser();
  const result = parser.parse("temp", Buffer.from(data + "\n"));
  return result.packets[0] || { type: "unknown", raw: data, reason: "Empty result" };
}

/**
 * Check if data looks like a registration packet
 */
export function isRegistrationPacket(data: string): boolean {
  return REGISTRATION_PATTERN.test(data.trim());
}

/**
 * Check if data is a heartbeat packet
 */
export function isHeartbeatPacket(data: string): boolean {
  return data.trim() === HEARTBEAT_LITERAL;
}

/**
 * Check if data is an acknowledgment request
 */
export function isAckRequest(data: string): boolean {
  return data.includes(ACK_REQUEST_LITERAL);
}

/**
 * Extract scale number from registration packet
 */
export function extractScaleNumber(data: string): string | null {
  const match = data.trim().match(REGISTRATION_PATTERN);
  return match ? match[1] : null;
}

/**
 * Generate acknowledgment response
 */
export function getAckResponse(): string {
  return "OK\n";
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVERSION TO TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert ParsedPacket to ScaleMessage (for compatibility with existing types)
 */
export function toScaleMessage(packet: ParsedPacket): ScaleMessage {
  switch (packet.type) {
    case "registration":
      return {
        type: "registration",
        raw: packet.raw,
        deviceId: packet.deviceId,
      };
    
    case "heartbeat":
      return {
        type: "heartbeat",
        raw: packet.raw,
      };
    
    case "weighing_event":
      return {
        type: "event",
        raw: packet.raw,
        event: {
          pluCode: packet.event.pluCode,
          productName: packet.event.productName,
          weightGrams: packet.event.weightGrams,
          barcode: packet.event.barcode,
          timestamp: packet.event.timestamp.toISOString(),
          operator: packet.event.operator,
          rawData: packet.event.rawData,
        },
      };
    
    case "ack_request":
      // Treat ack requests as unknown in the basic type system
      return {
        type: "unknown",
        raw: packet.raw,
      };
    
    case "unknown":
    default:
      return {
        type: "unknown",
        raw: packet.raw,
      };
  }
}

/**
 * Convert WeighingEventData to ParsedScaleEvent
 */
export function toParsedScaleEvent(event: WeighingEventData): ParsedScaleEvent {
  return {
    pluCode: event.pluCode,
    productName: event.productName,
    weightGrams: event.weightGrams,
    barcode: event.barcode,
    timestamp: event.timestamp.toISOString(),
    operator: event.operator,
    rawData: event.rawData,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════════════════

let globalParser: ScaleParser | null = null;

/**
 * Get the global parser instance (singleton)
 */
export function getGlobalParser(): ScaleParser {
  if (!globalParser) {
    globalParser = new ScaleParser();
  }
  return globalParser;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default ScaleParser;
