/**
 * Print job queue: SQLite persistence, pending selection, retries.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  enqueue,
  getJob,
  getJobPublic,
  getJobs,
  getNextPending,
  markDispatching,
  markFailed,
  markPrinted,
  scheduleRetry,
  scheduleRetryBumpAttempts,
} from "../src/printers/print-job-queue.ts";
import { initDatabase, closeDatabase, getDatabase, nowISO } from "../src/storage/database.ts";

function clearPrintTables(): void {
  const db = getDatabase();
  db.prepare("DELETE FROM print_jobs").run();
  db.prepare("DELETE FROM printers").run();
}

function ensurePrinter(printerId: string): void {
  const db = getDatabase();
  const created = nowISO();
  db.prepare(
    `INSERT OR IGNORE INTO printers (
      printer_id, global_printer_id, display_name, role, transport, host, port,
      model, status, priority, enabled, last_seen_at, last_error, version, created_at
    ) VALUES (?, NULL, NULL, 'generic', 'tcp', '127.0.0.1', 9100, NULL, 'online', 100, 1, NULL, NULL, NULL, ?)`
  ).run(printerId, created);
}

describe("print-job-queue", () => {
  beforeEach(() => {
    initDatabase();
    clearPrintTables();
  });

  afterEach(() => {
    closeDatabase();
  });

  describe("enqueue / getJob / getJobPublic", () => {
    it("stores prn_bytes and returns job id", () => {
      const blob = Buffer.from([0x41, 0x42, 0xc7]);
      const id = enqueue({
        prnBytes: blob,
        targetRole: "carcass",
        source: "local-api",
      });
      expect(id.length).toBeGreaterThan(10);

      const row = getJob(id);
      expect(row).not.toBeNull();
      expect(Buffer.compare(row!.prn_bytes, blob)).toBe(0);
      expect(row!.status).toBe("pending");
      expect(row!.target_role).toBe("carcass");
      expect(row!.attempts).toBe(0);

      const pub = getJobPublic(id);
      expect(pub).not.toBeNull();
      expect("prn_bytes" in (pub as object)).toBe(false);
    });

    it("accepts targetPrinter and globalJobId", () => {
      const id = enqueue({
        prnBytes: Buffer.from("x"),
        targetPrinter: "p1",
        source: "cloud",
        globalJobId: "550e8400-e29b-41d4-a716-446655440000",
      });
      const row = getJob(id)!;
      expect(row.target_printer).toBe("p1");
      expect(row.target_role).toBeNull();
      expect(row.global_job_id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(row.source).toBe("cloud");
    });
  });

  describe("getNextPending", () => {
    it("returns oldest pending job when next_attempt_at is null", () => {
      const a = enqueue({ prnBytes: Buffer.from("a"), targetRole: "generic", source: "local-api" });
      Bun.sleepSync(2);
      const b = enqueue({ prnBytes: Buffer.from("b"), targetRole: "generic", source: "local-api" });

      const next = getNextPending();
      expect(next?.job_id).toBe(a);

      markPrinted(a);
      const next2 = getNextPending();
      expect(next2?.job_id).toBe(b);
    });

    it("skips jobs with future next_attempt_at", () => {
      const id = enqueue({ prnBytes: Buffer.from("x"), targetRole: "generic", source: "local-api" });
      scheduleRetry(id, 1, "wait");

      expect(getNextPending()).toBeNull();

      const db = getDatabase();
      db.prepare(
        `UPDATE print_jobs SET next_attempt_at = ? WHERE job_id = ?`
      ).run(new Date(Date.now() - 60_000).toISOString(), id);

      const next = getNextPending();
      expect(next?.job_id).toBe(id);
    });
  });

  describe("markDispatching / markPrinted / markFailed", () => {
    it("markDispatching increments attempts and sets resolved_printer", () => {
      ensurePrinter("printer-1");
      const id = enqueue({ prnBytes: Buffer.from("x"), targetRole: "generic", source: "local-api" });
      markDispatching(id, "printer-1");
      const row = getJob(id)!;
      expect(row.status).toBe("dispatching");
      expect(row.attempts).toBe(1);
      expect(row.resolved_printer).toBe("printer-1");
    });

    it("markPrinted sets status and printed_at", () => {
      ensurePrinter("p");
      const id = enqueue({ prnBytes: Buffer.from("x"), targetRole: "generic", source: "local-api" });
      markDispatching(id, "p");
      markPrinted(id);
      const row = getJob(id)!;
      expect(row.status).toBe("printed");
      expect(row.printed_at).not.toBeNull();
    });

    it("markFailed sets terminal status", () => {
      const id = enqueue({ prnBytes: Buffer.from("x"), targetRole: "generic", source: "local-api" });
      markFailed(id, "paper jam");
      expect(getJob(id)!.status).toBe("failed");
      expect(getJob(id)!.error_text).toBe("paper jam");
    });
  });

  describe("scheduleRetry / scheduleRetryBumpAttempts", () => {
    it("scheduleRetry keeps attempts and sets pending + next_attempt_at", () => {
      ensurePrinter("p");
      const id = enqueue({ prnBytes: Buffer.from("x"), targetRole: "generic", source: "local-api" });
      markDispatching(id, "p");
      scheduleRetry(id, 2, "tcp reset");
      const row = getJob(id)!;
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(1);
      expect(row.next_attempt_at).not.toBeNull();
      expect(row.error_text).toBe("tcp reset");
    });

    it("scheduleRetryBumpAttempts increments attempts each reschedule", () => {
      const id = enqueue({ prnBytes: Buffer.from("x"), targetRole: "generic", source: "local-api" });
      scheduleRetryBumpAttempts(id, "no printer");
      expect(getJob(id)!.attempts).toBe(1);
      expect(getJob(id)!.status).toBe("pending");
    });

    it("scheduleRetryBumpAttempts marks failed when next attempts would reach max_attempts", () => {
      const id = enqueue({ prnBytes: Buffer.from("x"), targetRole: "generic", source: "local-api" });
      const db = getDatabase();
      db.prepare(`UPDATE print_jobs SET attempts = 7 WHERE job_id = ?`).run(id);
      scheduleRetryBumpAttempts(id, "no printer");
      expect(getJob(id)!.status).toBe("failed");
      expect(getJob(id)!.error_text).toBe("no printer");
    });
  });

  describe("getJobs", () => {
    it("lists jobs without prn_bytes and respects status filter", () => {
      enqueue({ prnBytes: Buffer.from("1"), targetRole: "generic", source: "local-api" });
      const id2 = enqueue({ prnBytes: Buffer.from("2"), targetRole: "generic", source: "local-api" });
      markPrinted(id2);

      const printed = getJobs({ status: "printed", limit: 10 });
      expect(printed.length).toBe(1);
      expect(printed[0].job_id).toBe(id2);
      expect((printed[0] as { prn_bytes?: Buffer }).prn_bytes).toBeUndefined();
    });
  });
});
