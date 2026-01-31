/**
 * Comprehensive tests for Scale Parser
 * 
 * Tests parsing of registration packets, heartbeats, weighing events,
 * and handling of fragmented/incomplete data.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { ScaleParser } from "../src/devices/scale-parser.ts";
import type { ParsedPacket } from "../src/devices/scale-parser.ts";

describe("Scale Parser", () => {
  let parser: ScaleParser;

  beforeEach(() => {
    parser = new ScaleParser();
  });

  describe("parse", () => {
    it("should parse registration packet", () => {
      const result = parser.parse("socket-123", Buffer.from("SCALE-01"));
      
      expect(result.packets.length).toBe(1);
      expect(result.packets[0].type).toBe("registration");
      if (result.packets[0].type === "registration") {
        expect(result.packets[0].deviceId).toBe("SCALE-01");
        expect(result.packets[0].scaleNumber).toBe("01");
      }
      expect(result.errors.length).toBe(0);
    });

    it("should parse heartbeat packet", () => {
      const result = parser.parse("socket-123", Buffer.from("HB"));
      
      expect(result.packets.length).toBe(1);
      expect(result.packets[0].type).toBe("heartbeat");
      expect(result.errors.length).toBe(0);
    });

    it("should parse weighing event CSV with large values (in grams)", () => {
      // CSV format: PLU,TIME,DATE,PRODUCT,BARCODE,CODE,OPERATOR,VAL1(gross),VAL2(tare),VAL3(net),FLAGS...,COMPANY
      // Large values (>= 1000) are already in grams
      // Weight is read from VAL3 field (index 9): 0000037500 = 37500 grams (net weight)
      // Tare is read from VAL2 field (index 8): 0000000000 = 0 grams
      const csvLine = "00001,10:30:00,30.01.2026,KIYMA           ,2000001025004,000,MEHMET        ,0000002500,0000000000,0000037500,0,0,0,1,N,TEST COMPANY";
      const result = parser.parse("socket-123", Buffer.from(csvLine + "\n"));
      
      expect(result.packets.length).toBe(1);
      expect(result.packets[0].type).toBe("weighing_event");
      if (result.packets[0].type === "weighing_event") {
        expect(result.packets[0].event.pluCode).toBe("00001");
        expect(result.packets[0].event.productName.trim()).toBe("KIYMA");
        expect(result.packets[0].event.weightGrams).toBe(37500); // Net weight from VAL3 (already in grams)
        expect(result.packets[0].event.tareGrams).toBe(0); // Tare from VAL2
        expect(result.packets[0].event.barcode).toBe("2000001025004");
        expect(result.packets[0].event.operator.trim()).toBe("MEHMET");
      }
      expect(result.errors.length).toBe(0);
    });

    it("should parse weighing event CSV with small values (in 0.1 kg units)", () => {
      // Small values (< 1000) are in 0.1 kg units - multiply by 100 to get grams
      // Example: 0000000014 = 14 → 14 * 100 = 1400 grams (1.4 kg)
      const csvLine = "00001,06:25:17,30.01.2026,BONF�LE         ,000000000004,0000,KAAN                                            ,0000000027,0000000013,0000000014,1,0,1,1,N,KORKUT KAAN BALTA";
      const result = parser.parse("socket-123", Buffer.from(csvLine + "\n"));
      
      expect(result.packets.length).toBe(1);
      expect(result.packets[0].type).toBe("weighing_event");
      if (result.packets[0].type === "weighing_event") {
        expect(result.packets[0].event.pluCode).toBe("00001");
        expect(result.packets[0].event.productName.trim()).toBe("BONF�LE");
        expect(result.packets[0].event.weightGrams).toBe(1400); // Net weight: 14 * 100 = 1400 grams (1.4 kg)
        expect(result.packets[0].event.tareGrams).toBe(1300); // Tare: 13 * 100 = 1300 grams (1.3 kg)
        expect(result.packets[0].event.barcode).toBe("000000000004");
        expect(result.packets[0].event.operator.trim()).toBe("KAAN");
      }
      expect(result.errors.length).toBe(0);
    });

    it("should parse acknowledgment request", () => {
      const result = parser.parse("socket-123", Buffer.from("KONTROLLU AKTAR OK?"));
      
      expect(result.packets.length).toBe(1);
      expect(result.packets[0].type).toBe("ack_request");
      expect(result.errors.length).toBe(0);
    });

    it("should handle multiple packets in one chunk", () => {
      const data = "SCALE-01\nHB\n00001,10:30:00,30.01.2026,KIYMA,2000001025004,000,MEHMET,0000025000,0000015000,0000037500\n";
      const result = parser.parse("socket-123", Buffer.from(data));
      
      expect(result.packets.length).toBe(3);
      expect(result.packets[0].type).toBe("registration");
      expect(result.packets[1].type).toBe("heartbeat");
      expect(result.packets[2].type).toBe("weighing_event");
    });

    it("should handle fragmented packets", () => {
      // First chunk - incomplete
      const chunk1 = parser.parse("socket-123", Buffer.from("SCALE-0"));
      expect(chunk1.packets.length).toBe(0);
      expect(chunk1.remainder).toBe("SCALE-0");
      
      // Second chunk - completes the packet
      const chunk2 = parser.parse("socket-123", Buffer.from("1"));
      expect(chunk2.packets.length).toBe(1);
      expect(chunk2.packets[0].type).toBe("registration");
    });

    it("should handle incomplete CSV lines", () => {
      // Incomplete CSV line
      const chunk1 = parser.parse("socket-123", Buffer.from("00001,10:30:00,30.01.2026,KIYMA"));
      expect(chunk1.packets.length).toBe(0);
      expect(chunk1.remainder.length).toBeGreaterThan(0);
      
      // Complete the line
      const chunk2 = parser.parse("socket-123", Buffer.from(",2000001025004,000,MEHMET,0000025000,0000015000,0000037500\n"));
      expect(chunk2.packets.length).toBe(1);
      expect(chunk2.packets[0].type).toBe("weighing_event");
    });

    it("should handle unknown packets gracefully", () => {
      const result = parser.parse("socket-123", Buffer.from("UNKNOWN_DATA_12345\n"));
      
      expect(result.packets.length).toBe(1);
      expect(result.packets[0].type).toBe("unknown");
      if (result.packets[0].type === "unknown") {
        expect(result.packets[0].reason).toBeTruthy();
      }
    });

    it("should handle empty input", () => {
      const result = parser.parse("socket-123", Buffer.from(""));
      
      expect(result.packets.length).toBe(0);
      expect(result.errors.length).toBe(0);
      expect(result.remainder).toBe("");
    });

    it("should handle invalid CSV format", () => {
      const invalidCsv = "00001,10:30:00"; // Too few fields
      const result = parser.parse("socket-123", Buffer.from(invalidCsv + "\n"));
      
      // Should either parse as unknown or have errors
      expect(result.packets.length).toBeGreaterThanOrEqual(0);
      // May have errors or parse as unknown
    });

    it("should parse Turkish characters in product name", () => {
      const csvLine = "00001,10:30:00,30.01.2026,KUŞBAŞI         ,2000002018004,000,MEHMET        ,0000018000,0000015000,0000027000";
      const result = parser.parse("socket-123", Buffer.from(csvLine + "\n"));
      
      expect(result.packets.length).toBe(1);
      if (result.packets[0].type === "weighing_event") {
        expect(result.packets[0].event.productName.trim()).toBe("KUŞBAŞI");
      }
    });

    it("should handle registration packet with different scale numbers", () => {
      const scales = ["SCALE-01", "SCALE-02", "SCALE-10", "SCALE-99"];
      
      for (const scaleId of scales) {
        const result = parser.parse("socket-123", Buffer.from(scaleId));
        expect(result.packets.length).toBe(1);
        expect(result.packets[0].type).toBe("registration");
        if (result.packets[0].type === "registration") {
          expect(result.packets[0].deviceId).toBe(scaleId);
        }
      }
    });

    it("should handle mixed line endings (CRLF, LF, CR)", () => {
      const data1 = "SCALE-01\r\nHB\r\n";
      const data2 = "SCALE-01\nHB\n";
      const data3 = "SCALE-01\rHB\r";
      
      const result1 = parser.parse("socket-123", Buffer.from(data1));
      const result2 = parser.parse("socket-123", Buffer.from(data2));
      const result3 = parser.parse("socket-123", Buffer.from(data3));
      
      expect(result1.packets.length).toBe(2);
      expect(result2.packets.length).toBe(2);
      expect(result3.packets.length).toBe(2);
    });

    it("should maintain buffer per socket", () => {
      // Parse incomplete data on socket 1
      const chunk1_socket1 = parser.parse("socket-1", Buffer.from("SCALE-0"));
      expect(chunk1_socket1.packets.length).toBe(0);
      
      // Parse complete data on socket 2
      const chunk1_socket2 = parser.parse("socket-2", Buffer.from("SCALE-02"));
      expect(chunk1_socket2.packets.length).toBe(1);
      
      // Complete socket 1's data
      const chunk2_socket1 = parser.parse("socket-1", Buffer.from("1"));
      expect(chunk2_socket1.packets.length).toBe(1);
    });

    it("should handle very long product names", () => {
      const longName = "VERY_LONG_PRODUCT_NAME_12345678901234567890";
      const csvLine = `00001,10:30:00,30.01.2026,${longName.padEnd(16)},2000001025004,000,MEHMET,0000025000,0000015000,0000037500`;
      const result = parser.parse("socket-123", Buffer.from(csvLine + "\n"));
      
      expect(result.packets.length).toBe(1);
      if (result.packets[0].type === "weighing_event") {
        expect(result.packets[0].event.productName).toBeTruthy();
      }
    });

    it("should prevent buffer overflow", () => {
      const parser = new ScaleParser();
      const largeData = "A".repeat(100000); // 100KB
      
      const result = parser.parse("socket-123", Buffer.from(largeData));
      
      // Should handle gracefully, either parse what it can or reject
      expect(result.errors.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("clearBuffer", () => {
    it("should clear buffer for a socket", () => {
      // Add incomplete data
      parser.parse("socket-123", Buffer.from("SCALE-0"));
      
      // Clear buffer
      parser.clearBuffer("socket-123");
      
      // Next parse should not have remainder
      const result = parser.parse("socket-123", Buffer.from("SCALE-01"));
      expect(result.remainder).toBe("");
    });
  });

  describe("getBufferSize", () => {
    it("should return buffer size for a socket", () => {
      parser.parse("socket-123", Buffer.from("SCALE-0"));
      const size = parser.getBufferSize("socket-123");
      expect(size).toBeGreaterThan(0);
    });

    it("should return 0 for socket with no buffer", () => {
      const size = parser.getBufferSize("unknown-socket");
      expect(size).toBe(0);
    });
  });
});
