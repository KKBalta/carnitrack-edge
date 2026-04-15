import { initPrinterManager, destroyPrinterManager, getPrinterManager } from "./printer-manager.ts";
import { initPrintDispatcher, destroyPrintDispatcher } from "./print-dispatcher.ts";
import type { PrintJobRow } from "./print-job-queue.ts";

export async function initPrinters(): Promise<void> {
  await initPrinterManager();
  initPrintDispatcher();
}

export function destroyPrinters(): void {
  destroyPrintDispatcher();
  destroyPrinterManager();
}

export function resolvePrinter(job: PrintJobRow) {
  return getPrinterManager().resolvePrinter(job);
}

export {
  enqueue,
  getJobs,
  getJob,
  getJobPublic,
  getJobByGlobalId,
  recoverStuckDispatchingJobs,
} from "./print-job-queue.ts";
export {
  getPrinterManager,
  getPrinterById,
  initPrinterManager,
  destroyPrinterManager,
  updateGlobalPrinterId,
} from "./printer-manager.ts";
export type { PrinterRecord, PrinterRole } from "./printer-manager.ts";
export { normalizeRole } from "./printer-manager.ts";
export {
  TcpPrinterClient,
  PrinterStatus,
  describeStatus,
  parseEscSResponse,
} from "./tcp-printer-client.ts";
export type { PrinterDiagnosticsReport, PrinterDiagnosticsExtended } from "./tcp-printer-client.ts";
export { discoverPrinterCandidates, suggestSubnetFromIp, ipv4ToList } from "./discovery.ts";
export type { DiscoverOptions, PrinterCandidate } from "./discovery.ts";
