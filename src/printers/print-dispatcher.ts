/**
 * Periodic dispatch: one in-flight job per printer_id, TSPL over TCP.
 */

import { config } from "../config.ts";
import {
  getNextPending,
  markDispatching,
  markPrinted,
  markFailed,
  scheduleRetry,
  scheduleRetryBumpAttempts,
  getJob,
  type PrintJobRow,
} from "./print-job-queue.ts";
import { getPrinterManager, getPrinterById } from "./printer-manager.ts";
import { TcpPrinterClient } from "./tcp-printer-client.ts";
import { getRestClient } from "../cloud/rest-client.ts";

let dispatchTimer: ReturnType<typeof setInterval> | null = null;
const inFlight = new Set<string>();

/** True when the dispatcher is currently holding the TCP socket for `printerId`. */
export function isInFlight(printerId: string): boolean {
  return inFlight.has(printerId);
}

function resolveGlobalPrinterId(localPrinterId: string | null): string | null {
  if (!localPrinterId) return null;
  return getPrinterById(localPrinterId)?.global_printer_id ?? null;
}

export async function ackJobDispatchedToCloud(
  globalJobId: string,
  jobId: string,
  printerId: string
): Promise<void> {
  const restClient = getRestClient();
  if (!restClient) return;
  const row = getJob(jobId);
  try {
    await restClient.ackPrintJob(globalJobId, {
      status: "dispatched",
      printedAt: null,
      resolvedPrinter: resolveGlobalPrinterId(printerId),
      attempts: row?.attempts ?? 1,
    });
    console.log(`[PrintDispatcher] → ACKed DISPATCHED job ${globalJobId} to cloud (localJob=${jobId}, printer=${printerId})`);
  } catch (e) {
    console.warn(
      `[PrintDispatcher] Cloud dispatched-ACK failed for job ${globalJobId}:`,
      e instanceof Error ? e.message : String(e)
    );
  }
}

export async function ackJobToCloud(
  globalJobId: string,
  jobId: string,
  printerId: string
): Promise<void> {
  const restClient = getRestClient();
  if (!restClient) return;
  const row = getJob(jobId);
  try {
    await restClient.ackPrintJob(globalJobId, {
      status: "completed",
      printedAt: row?.printed_at ?? new Date().toISOString(),
      resolvedPrinter: resolveGlobalPrinterId(printerId),
      attempts: row?.attempts ?? 1,
    });
    console.log(`[PrintDispatcher] ✓ ACKed job ${globalJobId} to cloud (printer=${printerId})`);
  } catch (e) {
    console.warn(
      `[PrintDispatcher] Cloud ACK failed for job ${globalJobId}:`,
      e instanceof Error ? e.message : String(e)
    );
  }
}

export async function ackJobFailedToCloud(
  globalJobId: string,
  jobId: string,
  printerId: string | null,
  errorText: string
): Promise<void> {
  const restClient = getRestClient();
  if (!restClient) return;
  const row = getJob(jobId);
  try {
    await restClient.ackPrintJob(globalJobId, {
      status: "failed",
      printedAt: null,
      resolvedPrinter: resolveGlobalPrinterId(printerId),
      attempts: row?.attempts ?? 1,
      errorText,
    });
    console.log(`[PrintDispatcher] ✗ ACKed FAILED job ${globalJobId} to cloud`);
  } catch (e) {
    console.warn(
      `[PrintDispatcher] Cloud failure-ACK failed for job ${globalJobId}:`,
      e instanceof Error ? e.message : String(e)
    );
  }
}

function currentAttempts(jobId: string): number {
  const row = getJob(jobId);
  return row?.attempts ?? 0;
}

async function dispatchOne(job: PrintJobRow): Promise<void> {
  const mgr = getPrinterManager();
  const resolved = mgr.resolvePrinter(job);
  if (!resolved) {
    scheduleRetryBumpAttempts(job.job_id, "no eligible printer for target");
    const updated = getJob(job.job_id);
    if (updated?.status === "failed" && job.global_job_id) {
      void ackJobFailedToCloud(
        job.global_job_id,
        job.job_id,
        null,
        "no eligible printer for target"
      );
    }
    return;
  }

  if (inFlight.has(resolved.printer_id)) return;

  inFlight.add(resolved.printer_id);
  markDispatching(job.job_id, resolved.printer_id);
  if (job.global_job_id) {
    void ackJobDispatchedToCloud(job.global_job_id, job.job_id, resolved.printer_id);
  }

  try {
    const client = new TcpPrinterClient(
      resolved.host,
      resolved.port,
      config.printers.connectTimeoutMs
    );
    await client.dispatchPrintJob(new Uint8Array(job.prn_bytes), {
      completionPollIntervalMs: config.printers.completionPollIntervalMs,
      completionStreakRequired: config.printers.completionStreakRequired,
      dispatchTimeoutMs: config.printers.dispatchTimeoutMs,
    });

    markPrinted(job.job_id);
    mgr.setPrinterOnline(resolved.printer_id);
    if (job.global_job_id) {
      await ackJobToCloud(job.global_job_id, job.job_id, resolved.printer_id);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const attempts = currentAttempts(job.job_id);
    const row = getJob(job.job_id);
    const max = row?.max_attempts ?? 8;
    mgr.setPrinterError(resolved.printer_id, msg);
    if (attempts >= max) {
      markFailed(job.job_id, msg);
      if (job.global_job_id) {
        await ackJobFailedToCloud(job.global_job_id, job.job_id, resolved.printer_id, msg);
      }
    } else {
      scheduleRetry(job.job_id, Math.max(1, attempts), msg);
    }
  } finally {
    inFlight.delete(resolved.printer_id);
  }
}

function tick(): void {
  const job = getNextPending();
  if (!job) return;
  void dispatchOne(job);
}

export function initPrintDispatcher(): void {
  if (dispatchTimer) clearInterval(dispatchTimer);
  dispatchTimer = setInterval(tick, config.printers.dispatchIntervalMs);
}

export function destroyPrintDispatcher(): void {
  if (dispatchTimer) {
    clearInterval(dispatchTimer);
    dispatchTimer = null;
  }
  inFlight.clear();
}
