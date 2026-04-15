/**
 * SQLite-backed print job queue (prn_bytes BLOB).
 */

import { getDatabase, generateId, nowISO } from "../storage/database.ts";
import { config } from "../config.ts";

export type PrintJobSource = "cloud" | "local-api";
export type PrintJobStatus = "pending" | "dispatching" | "printed" | "failed";

export interface PrintJobRow {
  job_id: string;
  global_job_id: string | null;
  target_printer: string | null;
  target_role: string | null;
  resolved_printer: string | null;
  prn_bytes: Buffer;
  status: PrintJobStatus;
  source: PrintJobSource;
  label_count: number;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  error_text: string | null;
  created_at: string;
  printed_at: string | null;
}

export interface EnqueueParams {
  targetRole?: string | null;
  targetPrinter?: string | null;
  prnBytes: Buffer;
  source: PrintJobSource;
  globalJobId?: string | null;
  labelCount?: number;
  /** Attempt count from cloud when source is cloud (Django GET /print-jobs/pending). */
  cloudAttempts?: number;
}

function backoffMs(attemptsForBackoff: number): number {
  const k = Math.max(1, attemptsForBackoff);
  return Math.min(
    config.printers.retryBaseDelayMs * 2 ** (k - 1),
    config.printers.retryMaxDelayMs
  );
}

function nextAttemptIso(attemptsForBackoff: number): string {
  const delay = backoffMs(attemptsForBackoff);
  return new Date(Date.now() + delay).toISOString();
}

export function enqueue(params: EnqueueParams): string {
  const db = getDatabase();
  const jobId = generateId();
  const created = nowISO();
  const labelCount = params.labelCount ?? 1;

  const initialAttempts = params.cloudAttempts ?? 0;
  db.prepare(
    `INSERT INTO print_jobs (
      job_id, global_job_id, target_printer, target_role, resolved_printer,
      prn_bytes, status, source, label_count, attempts, max_attempts,
      next_attempt_at, error_text, created_at, printed_at
    ) VALUES (?, ?, ?, ?, NULL, ?, 'pending', ?, ?, ?, 8, NULL, NULL, ?, NULL)`
  ).run(
    jobId,
    params.globalJobId ?? null,
    params.targetPrinter ?? null,
    params.targetRole ?? null,
    params.prnBytes,
    params.source,
    labelCount,
    initialAttempts,
    created
  );

  return jobId;
}

function rowToJob(r: Record<string, unknown>): PrintJobRow {
  return {
    job_id: r.job_id as string,
    global_job_id: (r.global_job_id as string) ?? null,
    target_printer: (r.target_printer as string) ?? null,
    target_role: (r.target_role as string) ?? null,
    resolved_printer: (r.resolved_printer as string) ?? null,
    prn_bytes: r.prn_bytes as Buffer,
    status: r.status as PrintJobStatus,
    source: r.source as PrintJobSource,
    label_count: r.label_count as number,
    attempts: r.attempts as number,
    max_attempts: r.max_attempts as number,
    next_attempt_at: (r.next_attempt_at as string) ?? null,
    error_text: (r.error_text as string) ?? null,
    created_at: r.created_at as string,
    printed_at: (r.printed_at as string) ?? null,
  };
}

export function getNextPending(): PrintJobRow | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT * FROM print_jobs
 WHERE status = 'pending'
         AND (
           next_attempt_at IS NULL
           OR datetime(replace(substr(next_attempt_at, 1, 19), 'T', ' ')) <= datetime('now')
         )
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .get() as Record<string, unknown> | undefined;
  return row ? rowToJob(row) : null;
}

export function markDispatching(jobId: string, printerId: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE print_jobs
     SET status = 'dispatching', resolved_printer = ?, attempts = attempts + 1
     WHERE job_id = ?`
  ).run(printerId, jobId);
}

export function markPrinted(jobId: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE print_jobs SET status = 'printed', printed_at = ?, error_text = NULL WHERE job_id = ?`
  ).run(nowISO(), jobId);
}

export function markFailed(jobId: string, errorText: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE print_jobs SET status = 'failed', error_text = ? WHERE job_id = ?`
  ).run(errorText, jobId);
}

export function scheduleRetry(jobId: string, attemptsForBackoff: number, errorText: string): void {
  const db = getDatabase();
  const nextAt = nextAttemptIso(attemptsForBackoff);
  db.prepare(
    `UPDATE print_jobs
     SET status = 'pending', next_attempt_at = ?, error_text = ?, resolved_printer = NULL
     WHERE job_id = ?`
  ).run(nextAt, errorText, jobId);
}

/** When the job never reached dispatching (e.g. no printer); increments attempts for backoff. */
export function scheduleRetryBumpAttempts(jobId: string, errorText: string): void {
  const row = getJob(jobId);
  if (!row) return;
  const nextAttempts = row.attempts + 1;
  if (nextAttempts >= row.max_attempts) {
    markFailed(jobId, errorText);
    return;
  }
  const db = getDatabase();
  const nextAt = nextAttemptIso(Math.max(1, nextAttempts));
  db.prepare(
    `UPDATE print_jobs
     SET status = 'pending', attempts = ?, next_attempt_at = ?, error_text = ?, resolved_printer = NULL
     WHERE job_id = ?`
  ).run(nextAttempts, nextAt, errorText, jobId);
}

export function getJobs(filters: { status?: PrintJobStatus; limit?: number }): Omit<
  PrintJobRow,
  "prn_bytes"
>[] {
  const db = getDatabase();
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  let sql = `SELECT job_id, global_job_id, target_printer, target_role, resolved_printer,
    status, source, label_count, attempts, max_attempts, next_attempt_at, error_text, created_at, printed_at
    FROM print_jobs`;
  const args: unknown[] = [];
  if (filters.status) {
    sql += ` WHERE status = ?`;
    args.push(filters.status);
  }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  args.push(limit);
  const rows = db.prepare(sql).all(...(args as (string | number)[])) as Record<string, unknown>[];
  return rows.map((r) => ({
    job_id: r.job_id as string,
    global_job_id: (r.global_job_id as string) ?? null,
    target_printer: (r.target_printer as string) ?? null,
    target_role: (r.target_role as string) ?? null,
    resolved_printer: (r.resolved_printer as string) ?? null,
    status: r.status as PrintJobStatus,
    source: r.source as PrintJobSource,
    label_count: r.label_count as number,
    attempts: r.attempts as number,
    max_attempts: r.max_attempts as number,
    next_attempt_at: (r.next_attempt_at as string) ?? null,
    error_text: (r.error_text as string) ?? null,
    created_at: r.created_at as string,
    printed_at: (r.printed_at as string) ?? null,
  }));
}

export function getJob(jobId: string): PrintJobRow | null {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM print_jobs WHERE job_id = ?").get(jobId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToJob(row) : null;
}

export function getJobPublic(jobId: string): Omit<PrintJobRow, "prn_bytes"> | null {
  const j = getJob(jobId);
  if (!j) return null;
  const { prn_bytes: _b, ...rest } = j;
  return rest;
}

export function getJobByGlobalId(globalJobId: string): PrintJobRow | null {
  const db = getDatabase();
  const row = db
    .prepare("SELECT * FROM print_jobs WHERE global_job_id = ?")
    .get(globalJobId) as Record<string, unknown> | undefined;
  return row ? rowToJob(row) : null;
}

/** Reset jobs stuck in dispatching (e.g. process crash mid-send). */
export function recoverStuckDispatchingJobs(maxAgeMs: number): number {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const result = db
    .prepare(
      `UPDATE print_jobs
       SET status = 'pending', resolved_printer = NULL, error_text = 'recovered from stuck dispatching'
       WHERE status = 'dispatching'
         AND created_at < ?`
    )
    .run(cutoff);
  return result.changes;
}
