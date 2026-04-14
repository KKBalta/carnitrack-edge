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
