import { describe, it, expect } from "bun:test";
import { parseEscSResponse } from "../src/printers/tcp-printer-client.ts";

describe("parseEscSResponse", () => {
  it("parses normal @@@@ frame (TSPL manual)", () => {
    const buf = Buffer.from([0x02, 0x40, 0x40, 0x40, 0x40, 0x03, 0x0d, 0x0a]);
    const r = parseEscSResponse(buf);
    expect(r.frameOk).toBe(true);
    expect(r.fourChars).toBe("@@@@");
    expect(r.messages.some((m) => m.includes("Normal"))).toBe(true);
  });

  it("flags short buffer", () => {
    const r = parseEscSResponse(Buffer.from([0x02, 0x40]));
    expect(r.frameOk).toBe(false);
    expect(r.messages.length).toBeGreaterThan(0);
  });
});
