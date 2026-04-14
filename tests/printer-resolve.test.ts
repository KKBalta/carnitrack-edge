/**
 * Printer resolution by role / id (DB-backed, no TCP).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getPrinterManager, destroyPrinterManager } from "../src/printers/printer-manager.ts";
import type { PrintJobRow } from "../src/printers/print-job-queue.ts";
import { initDatabase, closeDatabase, getDatabase, nowISO } from "../src/storage/database.ts";

function job(partial: Partial<PrintJobRow> & Pick<PrintJobRow, "job_id">): PrintJobRow {
  return {
    job_id: partial.job_id,
    global_job_id: partial.global_job_id ?? null,
    target_printer: partial.target_printer ?? null,
    target_role: partial.target_role ?? null,
    resolved_printer: partial.resolved_printer ?? null,
    prn_bytes: partial.prn_bytes ?? Buffer.alloc(0),
    status: partial.status ?? "pending",
    source: partial.source ?? "local-api",
    label_count: partial.label_count ?? 1,
    attempts: partial.attempts ?? 0,
    max_attempts: partial.max_attempts ?? 8,
    next_attempt_at: partial.next_attempt_at ?? null,
    error_text: partial.error_text ?? null,
    created_at: partial.created_at ?? nowISO(),
    printed_at: partial.printed_at ?? null,
  };
}

function insertPrinter(
  row: {
    printer_id: string;
    role: string;
    host: string;
    port?: number;
    priority: number;
    status: string;
    enabled?: number;
  }
): void {
  const db = getDatabase();
  const created = nowISO();
  db.prepare(
    `INSERT INTO printers (
      printer_id, global_printer_id, display_name, role, transport, host, port,
      model, status, priority, enabled, last_seen_at, last_error, version, created_at
    ) VALUES (?, NULL, NULL, ?, 'tcp', ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, ?)`
  ).run(
    row.printer_id,
    row.role,
    row.host,
    row.port ?? 9100,
    row.status,
    row.priority,
    row.enabled ?? 1,
    created
  );
}

describe("printer resolvePrinter", () => {
  beforeEach(() => {
    initDatabase();
    destroyPrinterManager();
    const db = getDatabase();
    db.prepare("DELETE FROM print_jobs").run();
    db.prepare("DELETE FROM printers").run();
  });

  afterEach(() => {
    destroyPrinterManager();
    closeDatabase();
  });

  it("picks target_printer when enabled and not error", () => {
    insertPrinter({
      printer_id: "p-a",
      role: "carcass",
      host: "10.0.0.1",
      priority: 100,
      status: "online",
    });
    insertPrinter({
      printer_id: "p-b",
      role: "carcass",
      host: "10.0.0.2",
      priority: 90,
      status: "online",
    });

    const mgr = getPrinterManager();
    const chosen = mgr.resolvePrinter(
      job({ job_id: "j1", target_printer: "p-a", target_role: null })
    );
    expect(chosen?.printer_id).toBe("p-a");
  });

  it("excludes error printers for target_printer", () => {
    insertPrinter({
      printer_id: "p-bad",
      role: "carcass",
      host: "10.0.0.1",
      priority: 100,
      status: "error",
    });
    const mgr = getPrinterManager();
    expect(
      mgr.resolvePrinter(job({ job_id: "j1", target_printer: "p-bad", target_role: null }))
    ).toBeNull();
  });

  it("resolves by role: lowest priority number first, then online over unknown", () => {
    insertPrinter({
      printer_id: "late",
      role: "carcass",
      host: "10.0.0.1",
      priority: 200,
      status: "online",
    });
    insertPrinter({
      printer_id: "early",
      role: "carcass",
      host: "10.0.0.2",
      priority: 100,
      status: "unknown",
    });
    insertPrinter({
      printer_id: "mid",
      role: "carcass",
      host: "10.0.0.3",
      priority: 100,
      status: "online",
    });

    const mgr = getPrinterManager();
    const chosen = mgr.resolvePrinter(job({ job_id: "j1", target_role: "carcass" }));
    expect(chosen?.printer_id).toBe("mid");
  });

  it("tie-breaks same priority and status by printer_id", () => {
    insertPrinter({
      printer_id: "z",
      role: "offal",
      host: "10.0.0.1",
      priority: 50,
      status: "online",
    });
    insertPrinter({
      printer_id: "a",
      role: "offal",
      host: "10.0.0.2",
      priority: 50,
      status: "online",
    });

    const mgr = getPrinterManager();
    const chosen = mgr.resolvePrinter(job({ job_id: "j1", target_role: "offal" }));
    expect(chosen?.printer_id).toBe("a");
  });

  it("returns null when no matching role", () => {
    insertPrinter({
      printer_id: "p1",
      role: "carcass",
      host: "10.0.0.1",
      priority: 100,
      status: "online",
    });
    const mgr = getPrinterManager();
    expect(mgr.resolvePrinter(job({ job_id: "j1", target_role: "meat_cut" }))).toBeNull();
  });

  it("skips disabled printers", () => {
    insertPrinter({
      printer_id: "off",
      role: "carcass",
      host: "10.0.0.1",
      priority: 100,
      status: "online",
      enabled: 0,
    });
    const mgr = getPrinterManager();
    expect(mgr.resolvePrinter(job({ job_id: "j1", target_role: "carcass" }))).toBeNull();
  });
});
