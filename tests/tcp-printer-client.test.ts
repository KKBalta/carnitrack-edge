/**
 * TcpPrinterClient against a minimal TSC-like mock (status byte replies).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import net from "node:net";
import { TcpPrinterClient, PrinterStatus, describeStatus } from "../src/printers/tcp-printer-client.ts";

/** Respond with 0x00 to every ESC !? query; absorb other bytes (TSPL / ~!E). */
function startMockTscPrinter(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const cmd = Buffer.from([0x1b, 0x21, 0x3f]);
        let idx: number;
        while ((idx = buf.indexOf(cmd)) !== -1) {
          socket.write(Buffer.from([PrinterStatus.READY]));
          buf = buf.subarray(idx + cmd.length);
        }
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("no address"));
        return;
      }
      resolve({
        port: addr.port,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

describe("TcpPrinterClient (mock printer)", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const s = await startMockTscPrinter();
    port = s.port;
    close = s.close;
  });

  afterAll(async () => {
    await close();
  });

  it("getStatusByte returns ready (0x00)", async () => {
    const client = new TcpPrinterClient("127.0.0.1", port, 2_000);
    const b = await client.getStatusByte();
    expect(b).toBe(PrinterStatus.READY);
  });

  it("describeStatus maps known codes", () => {
    expect(describeStatus(0x00)).toBe("ready");
    expect(describeStatus(0x04)).toBe("out_of_paper");
  });

  it("dispatchPrintJob sends payload and completes on ready streak", async () => {
    const client = new TcpPrinterClient("127.0.0.1", port, 2_000);
    const label = Buffer.from("SIZE 10 mm,10 mm\r\nCLS\r\nPRINT 1,1\r\n");
    await client.dispatchPrintJob(label, {
      completionPollIntervalMs: 20,
      completionStreakRequired: 3,
      dispatchTimeoutMs: 5_000,
    });
  });

  it("ping connects and closes", async () => {
    const client = new TcpPrinterClient("127.0.0.1", port, 2_000);
    await client.ping();
  });
});

describe("TcpPrinterClient (connection error)", () => {
  it("throws on connect timeout to unused port", async () => {
    const client = new TcpPrinterClient("127.0.0.1", 1, 300);
    await expect(client.getStatusByte()).rejects.toThrow(/timeout|ECONNREFUSED/i);
  });
});
