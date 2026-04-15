/**
 * Tests for printer flow gap fixes: B, C, D, H.
 *
 * Gap B — Cloud failed ACK when no eligible printer (terminal fail path)
 * Gap C — recoverStuckDispatchingJobs resets old dispatching rows to pending
 * Gap D — dispatched ACK reads real attempts from DB (not hardcoded)
 * Gap H — normalizeRole trims, lowercases, maps unknown to "generic"
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  enqueue,
  getJob,
  markDispatching,
  scheduleRetryBumpAttempts,
  recoverStuckDispatchingJobs,
} from "../src/printers/print-job-queue.ts";
import { normalizeRole } from "../src/printers/printer-manager.ts";
import { initDatabase, closeDatabase, getDatabase, nowISO } from "../src/storage/database.ts";

function clearPrintTables(): void {
  const db = getDatabase();
  db.prepare("DELETE FROM print_jobs").run();
  db.prepare("DELETE FROM printers").run();
}

function ensurePrinter(printerId: string): void {
  const db = getDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO printers (
      printer_id, global_printer_id, display_name, role, transport, host, port,
      model, status, priority, enabled, last_seen_at, last_error, version, created_at
    ) VALUES (?, NULL, NULL, 'generic', 'tcp', '127.0.0.1', 9100, NULL, 'online', 100, 1, NULL, NULL, NULL, ?)`
  ).run(printerId, nowISO());
}

describe("Gap B — failed ACK path on no eligible printer", () => {
  beforeEach(() => {
    initDatabase();
    clearPrintTables();
  });
  afterEach(() => closeDatabase());

  it("scheduleRetryBumpAttempts marks failed at max attempts, preserving global_job_id for ACK", () => {
    const id = enqueue({
      prnBytes: Buffer.from("test"),
      targetRole: "carcass",
      source: "cloud",
      globalJobId: "cloud-uuid-123",
    });
    const db = getDatabase();
    db.prepare("UPDATE print_jobs SET attempts = 7 WHERE job_id = ?").run(id);

    scheduleRetryBumpAttempts(id, "no eligible printer for target");

    const row = getJob(id)!;
    expect(row.status).toBe("failed");
    expect(row.error_text).toBe("no eligible printer for target");
    expect(row.global_job_id).toBe("cloud-uuid-123");
  });

  it("scheduleRetryBumpAttempts retries when below max, preserving global_job_id", () => {
    const id = enqueue({
      prnBytes: Buffer.from("test"),
      targetRole: "carcass",
      source: "cloud",
      globalJobId: "cloud-uuid-456",
    });
    scheduleRetryBumpAttempts(id, "no eligible printer for target");

    const row = getJob(id)!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.global_job_id).toBe("cloud-uuid-456");
  });
});

describe("Gap C — recoverStuckDispatchingJobs", () => {
  beforeEach(() => {
    initDatabase();
    clearPrintTables();
  });
  afterEach(() => closeDatabase());

  it("resets dispatching jobs with old created_at back to pending", () => {
    const id = enqueue({
      prnBytes: Buffer.from("stuck"),
      targetRole: "generic",
      source: "local-api",
    });
    ensurePrinter("p1");
    markDispatching(id, "p1");

    const db = getDatabase();
    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db.prepare("UPDATE print_jobs SET created_at = ? WHERE job_id = ?").run(oldTime, id);

    const recovered = recoverStuckDispatchingJobs(5 * 60 * 1000);
    expect(recovered).toBe(1);

    const row = getJob(id)!;
    expect(row.status).toBe("pending");
    expect(row.resolved_printer).toBeNull();
    expect(row.error_text).toBe("recovered from stuck dispatching");
  });

  it("does not reset dispatching jobs with recent created_at", () => {
    const id = enqueue({
      prnBytes: Buffer.from("recent"),
      targetRole: "generic",
      source: "local-api",
    });
    ensurePrinter("p1");
    markDispatching(id, "p1");

    const recovered = recoverStuckDispatchingJobs(5 * 60 * 1000);
    expect(recovered).toBe(0);
    expect(getJob(id)!.status).toBe("dispatching");
  });

  it("does not touch non-dispatching statuses", () => {
    const id = enqueue({
      prnBytes: Buffer.from("pending-job"),
      targetRole: "generic",
      source: "local-api",
    });
    const db = getDatabase();
    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db.prepare("UPDATE print_jobs SET created_at = ? WHERE job_id = ?").run(oldTime, id);

    const recovered = recoverStuckDispatchingJobs(5 * 60 * 1000);
    expect(recovered).toBe(0);
    expect(getJob(id)!.status).toBe("pending");
  });

  it("returns 0 when no jobs are stuck", () => {
    expect(recoverStuckDispatchingJobs(5 * 60 * 1000)).toBe(0);
  });
});

describe("Gap D — cloudAttempts preserved through enqueue and dispatching", () => {
  beforeEach(() => {
    initDatabase();
    clearPrintTables();
  });
  afterEach(() => closeDatabase());

  it("enqueue with cloudAttempts stores the cloud value", () => {
    const id = enqueue({
      prnBytes: Buffer.from("cloud-job"),
      targetRole: "carcass",
      source: "cloud",
      globalJobId: "cloud-uuid-789",
      cloudAttempts: 3,
    });
    const row = getJob(id)!;
    expect(row.attempts).toBe(3);
  });

  it("markDispatching increments from the cloud attempts base", () => {
    ensurePrinter("p1");
    const id = enqueue({
      prnBytes: Buffer.from("cloud-job"),
      targetRole: "carcass",
      source: "cloud",
      cloudAttempts: 3,
    });
    markDispatching(id, "p1");
    const row = getJob(id)!;
    expect(row.attempts).toBe(4);
  });

  it("enqueue without cloudAttempts defaults to 0", () => {
    const id = enqueue({
      prnBytes: Buffer.from("local"),
      targetRole: "generic",
      source: "local-api",
    });
    expect(getJob(id)!.attempts).toBe(0);
  });
});

describe("Gap H — normalizeRole", () => {
  it("returns generic for null", () => {
    expect(normalizeRole(null)).toBe("generic");
  });

  it("returns generic for undefined", () => {
    expect(normalizeRole(undefined)).toBe("generic");
  });

  it("returns generic for empty string", () => {
    expect(normalizeRole("")).toBe("generic");
    expect(normalizeRole("   ")).toBe("generic");
  });

  it("lowercases known roles", () => {
    expect(normalizeRole("CARCASS")).toBe("carcass");
    expect(normalizeRole("Meat_Cut")).toBe("meat_cut");
    expect(normalizeRole("OFFAL")).toBe("offal");
    expect(normalizeRole("By_Product")).toBe("by_product");
    expect(normalizeRole("Animal")).toBe("animal");
    expect(normalizeRole("GENERIC")).toBe("generic");
  });

  it("trims whitespace", () => {
    expect(normalizeRole("  carcass  ")).toBe("carcass");
    expect(normalizeRole("\tmeat_cut\n")).toBe("meat_cut");
  });

  it("maps unknown roles to generic", () => {
    expect(normalizeRole("unknown_role")).toBe("generic");
    expect(normalizeRole("printer_a")).toBe("generic");
    expect(normalizeRole("label")).toBe("generic");
  });

  it("normalizeRole applied to cloud job enqueue stores normalized role", () => {
    initDatabase();
    clearPrintTables();
    const id = enqueue({
      prnBytes: Buffer.from("cloud-job"),
      targetRole: normalizeRole("CARCASS"),
      source: "cloud",
    });
    expect(getJob(id)!.target_role).toBe("carcass");
    closeDatabase();
  });
});
