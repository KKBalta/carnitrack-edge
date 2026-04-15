/**
 * TSC TE210 / TSPL raw TCP client (port 9100).
 * One short-lived connection per public operation unless using dispatchPrintJob.
 */

import net from "node:net";
import { once } from "node:events";
import iconv from "iconv-lite";

/** Status byte from ESC !? (TSPL manual) */
export const PrinterStatus = {
  READY: 0x00,
  HEAD_OPENED: 0x01,
  PAPER_JAM: 0x02,
  PAPER_JAM_HEAD: 0x03,
  OUT_OF_PAPER: 0x04,
  OUT_OF_PAPER_HEAD: 0x05,
  OUT_OF_RIBBON: 0x08,
  OUT_OF_RIBBON_HEAD: 0x09,
  OUT_OF_RIBBON_PAPER_JAM: 0x0a,
  OUT_OF_RIBBON_PAPER_JAM_HEAD: 0x0b,
  OUT_OF_RIBBON_PAPER: 0x0c,
  OUT_OF_RIBBON_PAPER_HEAD: 0x0d,
  PAUSE: 0x10,
  PRINTING: 0x20,
  OTHER_ERROR: 0x80,
} as const;

const CMD_STATUS_BYTE = Buffer.from([0x1b, 0x21, 0x3f]);
const CMD_STATUS_EXT = Buffer.from([0x1b, 0x21, 0x53]);
const CMD_RESET = Buffer.from([0x1b, 0x21, 0x52]);
const CMD_FEED = Buffer.from([0x1b, 0x21, 0x46]);
const CMD_CANCEL_ALL = Buffer.from([0x1b, 0x21, 0x2e]);

/** Decode TSPL `<ESC>!S` status byte #1 (message) — TSPL_TSPL2_programming_manual § `<ESC>!S` */
const ESC_S_MESSAGE_BYTE1: Record<number, string> = {
  0x40: "Normal",
  0x60: "Pause",
  0x42: "Backing label",
  0x43: "Cutting",
  0x45: "Printer error",
  0x46: "Form feed",
  0x4b: "Waiting to press print key",
  0x4c: "Waiting to take label",
  0x50: "Printing batch",
  0x57: "Imaging",
};

const ESC_S_WARN_BYTE2: Record<number, string> = {
  0x40: "Warning: normal",
  0x41: "Warning: paper low",
  0x42: "Warning: ribbon low",
};

const ESC_S_ERR3_BYTE3: Record<number, string> = {
  0x40: "Error byte3: normal",
  0x41: "Error byte3: print head overheat",
  0x42: "Error byte3: stepping motor overheat",
  0x44: "Error byte3: print head error",
  0x48: "Error byte3: cutter jam",
  0x50: "Error byte3: insufficient memory",
};

const ESC_S_ERR4_BYTE4: Record<number, string> = {
  0x40: "Error byte4: normal",
  0x41: "Error byte4: paper empty",
  0x42: "Error byte4: paper jam",
  0x44: "Error byte4: ribbon empty",
  0x48: "Error byte4: ribbon jam",
  0x60: "Error byte4: print head open",
};

export interface PrinterDiagnosticsExtended {
  rawHex: string;
  frameOk: boolean;
  fourChars: string;
  messages: string[];
}

export interface PrinterDiagnosticsReport {
  model: string;
  codepage: string;
  statusByte: number;
  statusByteHex: string;
  statusLabel: string;
  extendedStatus: PrinterDiagnosticsExtended | null;
  /** Commands Carnitrack Edge sends during a normal print (for comparison with TSPL manual) */
  edgePrintPathCommands: string[];
  /** Human hints (TE210 user manual + TSPL manual) */
  notesForOperator: string[];
}

export function parseEscSResponse(buf: Buffer): PrinterDiagnosticsExtended {
  const messages: string[] = [];
  if (buf.length < 8) {
    return {
      rawHex: buf.toString("hex"),
      frameOk: false,
      fourChars: "",
      messages: [`response too short (${buf.length} bytes, expected 8: STX+4+ETX+CR+LF)`],
    };
  }
  const rawHex = buf.subarray(0, 8).toString("hex");
  const okStx = buf[0] === 0x02;
  const okEtx = buf[5] === 0x03;
  const b1 = buf[1]!;
  const b2 = buf[2]!;
  const b3 = buf[3]!;
  const b4 = buf[4]!;
  const fourChars = String.fromCharCode(b1, b2, b3, b4);
  if (!okStx) messages.push("Expected STX (0x02) at start of <ESC>!S response (TSPL manual).");
  if (!okEtx) messages.push("Expected ETX (0x03) before CR/LF; firmware may use a different framing.");
  const m1 = ESC_S_MESSAGE_BYTE1[b1];
  if (m1) messages.push(`Status message: ${m1}`);
  else messages.push(`Status message: unknown (byte1=0x${b1.toString(16)})`);
  const w2 = ESC_S_WARN_BYTE2[b2];
  if (w2 && b2 !== 0x40) messages.push(w2);
  const e3 = ESC_S_ERR3_BYTE3[b3];
  if (e3 && b3 !== 0x40) messages.push(e3);
  const e4 = ESC_S_ERR4_BYTE4[b4];
  if (e4 && b4 !== 0x40) messages.push(e4);
  return {
    rawHex,
    frameOk: okStx && okEtx,
    fourChars,
    messages,
  };
}

export function describeStatus(byte: number): string {
  const known: Record<number, string> = {
    [PrinterStatus.READY]: "ready",
    [PrinterStatus.HEAD_OPENED]: "head_opened",
    [PrinterStatus.PAPER_JAM]: "paper_jam",
    [PrinterStatus.PAPER_JAM_HEAD]: "paper_jam_head_open",
    [PrinterStatus.OUT_OF_PAPER]: "out_of_paper",
    [PrinterStatus.OUT_OF_PAPER_HEAD]: "out_of_paper_head_open",
    [PrinterStatus.OUT_OF_RIBBON]: "out_of_ribbon",
    [PrinterStatus.OUT_OF_RIBBON_HEAD]: "out_of_ribbon_head_open",
    [PrinterStatus.OUT_OF_RIBBON_PAPER_JAM]: "out_of_ribbon_paper_jam",
    [PrinterStatus.OUT_OF_RIBBON_PAPER_JAM_HEAD]: "out_of_ribbon_paper_jam_head",
    [PrinterStatus.OUT_OF_RIBBON_PAPER]: "out_of_ribbon_paper",
    [PrinterStatus.OUT_OF_RIBBON_PAPER_HEAD]: "out_of_ribbon_paper_head",
    [PrinterStatus.PAUSE]: "pause",
    [PrinterStatus.PRINTING]: "printing",
    [PrinterStatus.OTHER_ERROR]: "other_error",
  };
  return known[byte] ?? `unknown_0x${byte.toString(16)}`;
}

function connectWithTimeout(
  host: string,
  port: number,
  timeoutMs: number
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TCP connect timeout ${timeoutMs}ms (${host}:${port})`));
    }, timeoutMs);

    const onErr = (e: Error) => {
      clearTimeout(timer);
      reject(e);
    };

    socket.once("error", onErr);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", onErr);
      resolve(socket);
    });
  });
}

async function readBytes(
  socket: net.Socket,
  count: number,
  timeoutMs: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let got = 0;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`read timeout waiting for ${count} bytes (got ${got})`));
    }, timeoutMs);

    const onData = (data: Buffer) => {
      chunks.push(data);
      got += data.length;
      if (got >= count) {
        cleanup();
        resolve(Buffer.concat(chunks).subarray(0, count));
      }
    };

    const onErr = (e: Error) => {
      cleanup();
      reject(e);
    };

    const onEnd = () => {
      cleanup();
      reject(new Error("socket closed before read complete"));
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onErr);
      socket.off("end", onEnd);
    };

    socket.on("data", onData);
    socket.once("error", onErr);
    socket.once("end", onEnd);
  });
}

async function readUntilCr(
  socket: net.Socket,
  maxLen: number,
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const parts: Buffer[] = [];
  let total = 0;

  while (Date.now() < deadline) {
    const chunk = await readBytes(socket, 1, Math.max(1, deadline - Date.now()));
    const b = chunk[0];
    if (b === 0x0d) break;
    parts.push(chunk);
    total++;
    if (total > maxLen) {
      throw new Error("model response too long");
    }
  }
  return Buffer.concat(parts).toString("ascii");
}

async function writeAll(socket: net.Socket, data: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.write(Buffer.from(data), (err) => (err ? reject(err) : resolve()));
  });
}

async function withSocket<T>(
  host: string,
  port: number,
  connectTimeoutMs: number,
  fn: (socket: net.Socket) => Promise<T>
): Promise<T> {
  const socket = await connectWithTimeout(host, port, connectTimeoutMs);
  try {
    return await fn(socket);
  } finally {
    socket.end();
    await Promise.race([
      once(socket, "close"),
      new Promise((r) => setTimeout(r, 500)),
    ]);
  }
}

export class TcpPrinterClient {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly connectTimeoutMs: number
  ) {}

  async send(bytes: Uint8Array): Promise<void> {
    await withSocket(this.host, this.port, this.connectTimeoutMs, async (s) => {
      await writeAll(s, bytes);
    });
  }

  async sendText(line: string): Promise<void> {
    const buf = iconv.encode(line + "\r\n", "windows-1254");
    await this.send(buf);
  }

  async enableImmediate(): Promise<void> {
    await this.sendText("~!E");
  }

  async getStatusByte(): Promise<number> {
    return withSocket(this.host, this.port, this.connectTimeoutMs, async (s) => {
      await writeAll(s, CMD_STATUS_BYTE);
      const buf = await readBytes(s, 1, 1_500);
      return buf[0];
    });
  }

  async getStatusExtended(): Promise<Buffer | null> {
    try {
      return await withSocket(this.host, this.port, this.connectTimeoutMs, async (s) => {
        await writeAll(s, CMD_STATUS_EXT);
        const buf = await readBytes(s, 8, 2_000);
        return buf;
      });
    } catch {
      return null;
    }
  }

  async getModel(): Promise<string> {
    return withSocket(this.host, this.port, this.connectTimeoutMs, async (s) => {
      await writeAll(s, iconv.encode("~!T\r\n", "windows-1254"));
      return readUntilCr(s, 256, 2_000);
    });
  }

  async getCodepage(): Promise<string> {
    return withSocket(this.host, this.port, this.connectTimeoutMs, async (s) => {
      await writeAll(s, iconv.encode("~!I\r\n", "windows-1254"));
      return readUntilCr(s, 128, 2_000);
    });
  }

  async reset(): Promise<void> {
    await withSocket(this.host, this.port, this.connectTimeoutMs, async (s) => {
      await writeAll(s, CMD_RESET);
    });
  }

  async feed(): Promise<void> {
    await withSocket(this.host, this.port, this.connectTimeoutMs, async (s) => {
      await writeAll(s, CMD_FEED);
    });
  }

  async cancelAll(): Promise<void> {
    await withSocket(this.host, this.port, this.connectTimeoutMs, async (s) => {
      await writeAll(s, CMD_CANCEL_ALL);
    });
  }

  async ping(): Promise<void> {
    const s = await connectWithTimeout(this.host, this.port, this.connectTimeoutMs);
    s.end();
    await Promise.race([once(s, "close"), new Promise((r) => setTimeout(r, 500))]);
  }

  /**
   * Single connection: enable immediate, preflight status, send job bytes, poll until ready.
   */
  /**
   * One TCP session: `~!E` then `<ESC>!?`, `<ESC>!S`, `~!T`, `~!I` (read-only; TE210 / TSPL).
   * See `docs/TSC_TE210_user_manual.txt` (Diagnostic Tool) and `docs/TSPL_TSPL2_programming_manual.txt`.
   */
  async runDiagnostics(): Promise<PrinterDiagnosticsReport> {
    const edgePrintPathCommands = [
      "~!E  (enable immediate-mode ESC commands; TSPL manual)",
      "<ESC>!?  (0x1B 0x21 0x3F — single-byte status; polled after job)",
      "[TSPL job bytes from cloud / API — SIZE, CLS, TEXT, PRINT, etc.]",
      "TCP socket close after job (does not power off hardware)",
    ];
    const notesForOperator = [
      "Carnitrack does not send <ESC>!R (printer reset), <ESC>!P (pause), <ESC>!Q (restart), or SET SLEEPTIME in the print dispatcher.",
      "If the printer seems to “turn off” after one label: check AC adapter rating, head overheat / paper / ribbon / head-open in extended status above, cutter errors (TE210 manual § LED), and avoid excessive darkness/speed (TSPL manual warns high print ratio can stress the supply).",
      "SET SLEEPTIME / SET STANDBYTIME in TSPL apply to Alpha-2R / TDM series in the manual; TE210 may still have power-saving via web UI or Energy Star — use TSC Diagnostic Tool for full setup.",
    ];

    const socket = await connectWithTimeout(
      this.host,
      this.port,
      this.connectTimeoutMs
    );
    try {
      await writeAll(socket, iconv.encode("~!E\r\n", "windows-1254"));
      await writeAll(socket, CMD_STATUS_BYTE);
      const sb = await readBytes(socket, 1, 1_500);
      await writeAll(socket, CMD_STATUS_EXT);
      const extBuf = await readBytes(socket, 8, 2_500);
      await writeAll(socket, iconv.encode("~!T\r\n", "windows-1254"));
      const model = await readUntilCr(socket, 256, 2_500);
      await writeAll(socket, iconv.encode("~!I\r\n", "windows-1254"));
      const codepage = await readUntilCr(socket, 128, 2_500);

      let extendedStatus: PrinterDiagnosticsExtended | null = null;
      try {
        extendedStatus = parseEscSResponse(extBuf);
      } catch {
        extendedStatus = {
          rawHex: extBuf.toString("hex"),
          frameOk: false,
          fourChars: "",
          messages: ["failed to parse <ESC>!S response"],
        };
      }

      return {
        model: model.trim(),
        codepage: codepage.trim(),
        statusByte: sb[0]!,
        statusByteHex: `0x${(sb[0]!).toString(16)}`,
        statusLabel: describeStatus(sb[0]!),
        extendedStatus,
        edgePrintPathCommands,
        notesForOperator,
      };
    } finally {
      socket.end();
      await Promise.race([
        once(socket, "close"),
        new Promise((r) => setTimeout(r, 500)),
      ]);
    }
  }

  async dispatchPrintJob(
    prnBytes: Uint8Array,
    opts: {
      completionPollIntervalMs: number;
      completionStreakRequired: number;
      dispatchTimeoutMs: number;
    }
  ): Promise<void> {
    const socket = await connectWithTimeout(
      this.host,
      this.port,
      this.connectTimeoutMs
    );
    const end = Date.now() + opts.dispatchTimeoutMs;

    try {
      await writeAll(socket, iconv.encode("~!E\r\n", "windows-1254"));
      await writeAll(socket, CMD_STATUS_BYTE);
      const pre = await readBytes(socket, 1, 1_500);
      if (pre[0] !== PrinterStatus.READY) {
        throw new Error(`printer not ready: ${describeStatus(pre[0])} (0x${pre[0].toString(16)})`);
      }

      await writeAll(socket, Buffer.from(prnBytes));

      let streak = 0;
      while (Date.now() < end) {
        await writeAll(socket, CMD_STATUS_BYTE);
        const st = await readBytes(socket, 1, 1_500);
        if (st[0] === PrinterStatus.READY) {
          streak++;
          if (streak >= opts.completionStreakRequired) return;
        } else {
          streak = 0;
        }
        await new Promise((r) => setTimeout(r, opts.completionPollIntervalMs));
      }
      throw new Error("dispatch timeout waiting for printer ready");
    } finally {
      socket.end();
      await Promise.race([
        once(socket, "close"),
        new Promise((r) => setTimeout(r, 500)),
      ]);
    }
  }
}
