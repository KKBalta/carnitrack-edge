/**
 * Printer registry: env PRINTERS string, SQLite, health loop, resolve by role/id.
 */

import { getDatabase, nowISO } from "../storage/database.ts";
import { config } from "../config.ts";
import { TcpPrinterClient, PrinterStatus, describeStatus } from "./tcp-printer-client.ts";
import type { PrintJobRow } from "./print-job-queue.ts";

export type PrinterRole =
  | "carcass"
  | "meat_cut"
  | "offal"
  | "by_product"
  | "animal"
  | "generic";

export interface PrinterRecord {
  printer_id: string;
  global_printer_id: string | null;
  display_name: string | null;
  role: string;
  transport: string;
  host: string;
  port: number;
  model: string | null;
  status: string;
  priority: number;
  enabled: number;
  last_seen_at: string | null;
  last_error: string | null;
  version: string | null;
  created_at: string;
}

const ROLES = new Set<string>([
  "carcass",
  "meat_cut",
  "offal",
  "by_product",
  "animal",
  "generic",
]);

/** Map cloud/operator role strings to a known printer role (default generic). */
export function normalizeRole(role: string | null | undefined): PrinterRole {
  if (role == null || !String(role).trim()) return "generic";
  const r = String(role).trim().toLowerCase();
  return (ROLES.has(r) ? r : "generic") as PrinterRole;
}

let printerManagerInstance: PrinterManager | null = null;
let healthInterval: ReturnType<typeof setInterval> | null = null;

export class PrinterManager {
  private printers: PrinterRecord[] = [];

  async initialize(): Promise<void> {
    this.printers = parsePrintersConfigString(config.printers.configString);
    if (this.printers.length === 0) {
      console.log("[PrinterManager] No PRINTERS env configured (edge printing disabled until set)");
    }
    const db = getDatabase();
    const created = nowISO();

    for (const p of this.printers) {
      db.prepare(
        `INSERT INTO printers (
          printer_id, global_printer_id, display_name, role, transport, host, port,
          model, status, priority, enabled, last_seen_at, last_error, version, created_at
        ) VALUES (?, NULL, NULL, ?, 'tcp', ?, ?, NULL, 'unknown', ?, 1, NULL, NULL, NULL, ?)
        ON CONFLICT(printer_id) DO UPDATE SET
          host = excluded.host,
          port = excluded.port,
          role = excluded.role,
          priority = excluded.priority,
          enabled = excluded.enabled`
      ).run(p.printer_id, p.role, p.host, p.port, p.priority, created);
    }

    for (const p of this.printers) {
      await this.probePrinterStartup(p.printer_id);
    }
  }

  private async probePrinterStartup(printerId: string): Promise<void> {
    const row = this.getDbPrinter(printerId);
    if (!row) return;
    const client = new TcpPrinterClient(
      row.host,
      row.port,
      config.printers.connectTimeoutMs
    );
    try {
      await client.enableImmediate();
      let version: string | null = null;
      try {
        version = await client.getModel();
      } catch {
        version = null;
      }
      const st = await client.getStatusByte();
      const online = st === PrinterStatus.READY;
      this.updatePrinterRow(printerId, {
        version,
        status: online ? "online" : "error",
        last_error: online ? null : `status ${describeStatus(st)}`,
        last_seen_at: nowISO(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.updatePrinterRow(printerId, {
        status: "error",
        last_error: msg,
        last_seen_at: nowISO(),
      });
    }
  }

  private getDbPrinter(printerId: string): PrinterRecord | null {
    const db = getDatabase();
    const row = db.prepare("SELECT * FROM printers WHERE printer_id = ?").get(printerId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return row as unknown as PrinterRecord;
  }

  private updatePrinterRow(
    printerId: string,
    patch: Partial<{
      version: string | null;
      status: string;
      last_error: string | null;
      last_seen_at: string | null;
    }>
  ): void {
    const db = getDatabase();
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.version !== undefined) {
      sets.push("version = ?");
      args.push(patch.version);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      args.push(patch.status);
    }
    if (patch.last_error !== undefined) {
      sets.push("last_error = ?");
      args.push(patch.last_error);
    }
    if (patch.last_seen_at !== undefined) {
      sets.push("last_seen_at = ?");
      args.push(patch.last_seen_at);
    }
    if (sets.length === 0) return;
    args.push(printerId);
    db.prepare(`UPDATE printers SET ${sets.join(", ")} WHERE printer_id = ?`).run(
      ...(args as (string | null)[])
    );
  }

  setPrinterOnline(printerId: string): void {
    this.updatePrinterRow(printerId, {
      status: "online",
      last_error: null,
      last_seen_at: nowISO(),
    });
  }

  setPrinterError(printerId: string, message: string): void {
    this.updatePrinterRow(printerId, {
      status: "error",
      last_error: message,
      last_seen_at: nowISO(),
    });
  }

  getPrinters(): PrinterRecord[] {
    const db = getDatabase();
    return db.prepare("SELECT * FROM printers ORDER BY priority ASC, printer_id ASC").all() as PrinterRecord[];
  }

  getPrinterById(printerId: string): PrinterRecord | null {
    const db = getDatabase();
    const row = db.prepare("SELECT * FROM printers WHERE printer_id = ?").get(printerId) as
      | PrinterRecord
      | undefined;
    return row ?? null;
  }

  /**
   * Insert or update a printer (same persistence as PRINTERS env) and probe reachability.
   */
  async upsertConfiguredPrinter(opts: {
    printerId: string;
    host: string;
    port: number;
    role: string;
  }): Promise<PrinterRecord> {
    const printerId = opts.printerId.trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(printerId)) {
      throw new Error(
        "printerId must be 1–64 chars: letters, digits, underscore, hyphen (e.g. carcass, label-1)"
      );
    }
    const host = opts.host.trim();
    if (!host.length) throw new Error("host required");
    const port = opts.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be 1–65535");
    const role = normalizeRole(opts.role);

    const db = getDatabase();
    const existing = this.getPrinterById(printerId);
    let priority: number;
    if (existing) {
      priority = existing.priority;
    } else {
      const maxRow = db.prepare("SELECT MAX(priority) AS m FROM printers").get() as { m: number | null };
      priority = (maxRow.m ?? 90) + 10;
    }

    const created = nowISO();
    db.prepare(
      `INSERT INTO printers (
          printer_id, global_printer_id, display_name, role, transport, host, port,
          model, status, priority, enabled, last_seen_at, last_error, version, created_at
        ) VALUES (?, NULL, NULL, ?, 'tcp', ?, ?, NULL, 'unknown', ?, 1, NULL, NULL, NULL, ?)
        ON CONFLICT(printer_id) DO UPDATE SET
          host = excluded.host,
          port = excluded.port,
          role = excluded.role,
          priority = excluded.priority,
          enabled = excluded.enabled`
    ).run(printerId, role, host, port, priority, created);

    await this.probePrinterStartup(printerId);
    const row = this.getPrinterById(printerId);
    if (!row) throw new Error("printer upsert failed");
    return row;
  }

  resolvePrinter(job: PrintJobRow): PrinterRecord | null {
    const all = this.getPrinters().filter((p) => p.enabled === 1 && p.status !== "error");

    if (job.target_printer) {
      const p = this.getPrinterById(job.target_printer);
      if (p && p.enabled === 1 && p.status !== "error") return p;
      return null;
    }

    if (!job.target_role) return null;
    const candidates = all.filter((p) => p.role === job.target_role);
    if (candidates.length === 0) return null;

    const statusRank = (s: string) => (s === "online" ? 0 : s === "unknown" ? 1 : 2);
    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      const sr = statusRank(a.status) - statusRank(b.status);
      if (sr !== 0) return sr;
      return a.printer_id.localeCompare(b.printer_id);
    });
    return candidates[0] ?? null;
  }

  async healthCheckAll(): Promise<void> {
    const rows = this.getPrinters();
    for (const p of rows) {
      if (!p.enabled) continue;
      const client = new TcpPrinterClient(
        p.host,
        p.port,
        config.printers.connectTimeoutMs
      );
      try {
        await client.enableImmediate();
        const st = await client.getStatusByte();
        const ok = st === PrinterStatus.READY || st === PrinterStatus.PRINTING;
        this.updatePrinterRow(p.printer_id, {
          status: ok ? "online" : "error",
          last_error: ok ? null : describeStatus(st),
          last_seen_at: nowISO(),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.updatePrinterRow(p.printer_id, {
          status: "error",
          last_error: msg,
          last_seen_at: nowISO(),
        });
      }
    }
  }

  destroy(): void {
    /* singleton clears interval outside */
  }
}

/** Exported for tests; parses `PRINTERS` env format. */
export function parsePrintersConfigString(configString: string): PrinterRecord[] {
  const segments = configString
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out: PrinterRecord[] = [];
  let basePriority = 100;
  for (const seg of segments) {
    const parts = seg.split(":").map((p) => p.trim());
    if (parts.length < 3) {
      console.warn(`[PrinterManager] Skip invalid PRINTERS segment (need id:host:port): ${seg}`);
      continue;
    }
    const [id, host, portStr, ...rest] = parts;
    const port = Number(portStr);
    if (!id || !host || !Number.isFinite(port)) {
      console.warn(`[PrinterManager] Skip invalid PRINTERS segment: ${seg}`);
      continue;
    }
    let role: string = "generic";
    for (const kv of rest) {
      const m = kv.match(/^role=(.+)$/i);
      if (m) {
        role = normalizeRole(m[1]);
      }
    }
    out.push({
      printer_id: id,
      global_printer_id: null,
      display_name: null,
      role,
      transport: "tcp",
      host,
      port,
      model: null,
      status: "unknown",
      priority: basePriority,
      enabled: 1,
      last_seen_at: null,
      last_error: null,
      version: null,
      created_at: nowISO(),
    });
    basePriority += 10;
  }
  return out;
}

export function getPrinterManager(): PrinterManager {
  if (!printerManagerInstance) {
    printerManagerInstance = new PrinterManager();
  }
  return printerManagerInstance;
}

export async function initPrinterManager(): Promise<void> {
  const m = getPrinterManager();
  await m.initialize();
  if (healthInterval) clearInterval(healthInterval);
  healthInterval = setInterval(() => {
    m.healthCheckAll().catch((e) => console.warn("[PrinterManager] health check error:", e));
  }, config.printers.healthCheckIntervalMs);
}

export function destroyPrinterManager(): void {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
  printerManagerInstance = null;
}

export function getPrinterById(printerId: string): PrinterRecord | null {
  return getPrinterManager().getPrinterById(printerId);
}

export function updateGlobalPrinterId(printerId: string, globalPrinterId: string): void {
  const db = getDatabase();
  db.prepare("UPDATE printers SET global_printer_id = ? WHERE printer_id = ?").run(
    globalPrinterId,
    printerId
  );
}
