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
  
  /** Net weight in grams (parsed from field [9] VAL3) */
  weightGrams: number;
  
  /** Tare weight (dara) in grams (parsed from field [8] VAL2) */
  tareGrams: number;
  
  /** Value 1 (gross/total weight from field [7] VAL1 - stored for reference) */
  value1: string;
  
  /** Value 2 (not used, kept for compatibility) */
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
   * PLU,TIME,DATE,PRODUCT,BARCODE,CODE,OPERATOR,VAL1,VAL2,VAL3,FLAGS...,COMPANY
   * 
   * Field mapping based on actual scale data:
   * - Field [0]: Original PLU code (5 digits) - kept for reference
   * - Field [1]: Time (HH:MM:SS)
   * - Field [2]: Date (DD.MM.YYYY)
   * - Field [3]: Product name (16 chars, padded)
   * - Field [4]: Barcode (12 digits) - **Used as PLU code** (actual PLU identifier)
   * - Field [5]: Code field
   * - Field [6]: Operator name (48 chars, padded)
   * - Field [7] (VAL1): Gross/total weight
   * - Field [8] (VAL2): Tare weight (dara)
   * - Field [9] (VAL3): Net weight (actual weight to use)
   * - Field [10+]: Flags and company name
   * 
   * Weight Format:
   * - Small values (< 1000): In 0.1 kg units (multiply by 100 for grams)
   * - Large values (≥ 1000): Already in grams
   * 
   * Examples:
   * 00001,06:25:17,30.01.2026,BONF�LE,000000000004,0000,KAAN,0000000027,0000000013,0000000014,1,0,1,1,N,KORKUT KAAN BALTA
   * - Net weight (VAL3): 0000000014 = 14 → 1400 grams (1.4 kg)
   * - Tare (VAL2): 0000000013 = 13 → 1300 grams (1.3 kg)
   * - Total (VAL1): 0000000027 = 27 → 2700 grams (2.7 kg)
   */
  private parseWeighingEvent(line: string): WeighingEventData | null {
    const fields = line.split(",");
    
    // Minimum fields check
    if (fields.length < MIN_EVENT_FIELDS) {
      log("debug", `Event has too few fields: ${fields.length} < ${MIN_EVENT_FIELDS}`);
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
    
    // Use barcode as PLU code (barcode field contains the actual PLU code)
    // Strip any leading/trailing quotes and whitespace
    let pluCode = barcode.replace(/^["']|["']$/g, "").trim();
    
    // Validate PLU code format (accepts 12-digit barcode format or 5-digit format)
    if (!pluCode || !/^\d{5,12}$/.test(pluCode)) {
      log("debug", `Invalid PLU code (from barcode field): ${pluCode}`);
      return null;
    }
    const code = fields[5]?.trim() || "";
    const operator = fields[6]?.trim() || "";
    
    // Weight parsing - corrected based on actual scale data:
    // Field [7] (VAL1): Gross/total weight (for reference)
    // Field [8] (VAL2): Tare weight (dara) in grams
    // Field [9] (VAL3): Net weight in grams (actual weight to use)
    const value1 = fields[7]?.trim() || ""; // VAL1 - gross/total
    const tareRaw = fields[8]?.trim() || ""; // VAL2 - tare/dara
    const weightRaw = fields[9]?.trim() || ""; // VAL3 - net weight (actual weight)
    
    const weightGrams = this.parseWeight(weightRaw);
    const tareGrams = this.parseWeight(tareRaw);
    
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
      tareGrams, // Tare weight (dara) from field [8] (VAL2)
      value1, // VAL1 (gross/total) from field [7] for reference
      value2: "", // Not used, kept for compatibility
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
   * The DP-401 scale sends weight values in different formats depending on configuration:
   * - Small values (< 1000): Sent in 0.1 kg units (e.g., "0000000014" = 14 = 1.4 kg = 1400 grams)
   * - Large values (>= 1000): Sent directly in grams (e.g., "0000009676" = 9676 grams)
   * 
   * Weight values come from:
   * - VAL3 (field [9]): Net weight (actual weight to use)
   * - VAL2 (field [8]): Tare weight (dara)
   * - VAL1 (field [7]): Gross/total weight (for reference)
   * 
   * Examples:
   * - "0000000014" = 14 → 14 * 100 = 1400 grams (1.4 kg)
   * - "0000000013" = 13 → 13 * 100 = 1300 grams (1.3 kg)
   * - "0000009676" = 9676 → 9676 grams (already in grams)
   */
  private parseWeight(raw: string): number {
    const weight = parseInt(raw, 10);
    if (isNaN(weight)) {
      log("warn", `Failed to parse weight: ${raw}`);
      return 0;
    }
    
    // If value is less than 1000, it's likely in 0.1 kg units (multiply by 100 to get grams)
    // If value is 1000 or more, it's already in grams
    if (weight < 1000) {
      return weight * 100; // Convert from 0.1 kg units to grams
    }
    
    // Already in grams
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
          tareGrams: packet.event.tareGrams,
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
    tareGrams: event.tareGrams,
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
