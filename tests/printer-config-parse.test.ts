/**
 * PRINTERS env string parsing.
 */

import { describe, it, expect } from "bun:test";
import { parsePrintersConfigString } from "../src/printers/printer-manager.ts";

describe("parsePrintersConfigString", () => {
  it("parses id:host:port with default role generic", () => {
    const rows = parsePrintersConfigString("label1:192.168.1.10:9100");
    expect(rows).toHaveLength(1);
    expect(rows[0].printer_id).toBe("label1");
    expect(rows[0].host).toBe("192.168.1.10");
    expect(rows[0].port).toBe(9100);
    expect(rows[0].role).toBe("generic");
    expect(rows[0].priority).toBe(100);
  });

  it("parses role=carcass and comma-separated entries with ascending priority", () => {
    const rows = parsePrintersConfigString(
      "a:192.168.1.1:9100:role=carcass, b:192.168.1.2:9101:role=meat_cut"
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].printer_id).toBe("a");
    expect(rows[0].role).toBe("carcass");
    expect(rows[0].priority).toBe(100);
    expect(rows[1].printer_id).toBe("b");
    expect(rows[1].port).toBe(9101);
    expect(rows[1].role).toBe("meat_cut");
    expect(rows[1].priority).toBe(110);
  });

  it("maps unknown role token to generic", () => {
    const rows = parsePrintersConfigString("x:10.0.0.1:9100:role=unknown_role");
    expect(rows[0].role).toBe("generic");
  });

  it("ignores invalid segments", () => {
    const rows = parsePrintersConfigString("bad, good:1.1.1.1:9100");
    expect(rows).toHaveLength(1);
    expect(rows[0].printer_id).toBe("good");
  });

  it("returns empty array for empty string", () => {
    expect(parsePrintersConfigString("")).toEqual([]);
    expect(parsePrintersConfigString(" ,  ")).toEqual([]);
  });
});
