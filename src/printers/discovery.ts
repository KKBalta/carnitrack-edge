/**
 * LAN discovery: raw JetDirect :9100 + optional HTTP probe for TSC web UI.
 */

import net from "node:net";

export interface DiscoverOptions {
  /** e.g. "192.168.1.0/24", "192.168.1", or single host "192.168.1.50" */
  subnet?: string;
  /** When `subnet` is omitted, scan this host's /24 (e.g. from Edge primary IP). */
  localBaseIp?: string;
  tcpPort?: number;
  tcpTimeoutMs?: number;
  httpTimeoutMs?: number;
  /** Parallel TCP connect attempts */
  concurrency?: number;
  /** After 9100 is open, GET http://ip/ and look for TSC markers */
  probeWeb?: boolean;
}

export interface PrinterCandidate {
  ip: string;
  tcpPort: number;
  tcpOpen: boolean;
  webUi?: {
    reachable: boolean;
    url: string;
    title?: string;
    looksLikeTsc: boolean;
    httpStatus?: number;
    error?: string;
  };
}

/** @internal exported for tests */
export function ipv4ToList(subnet: string): string[] {
  const s = subnet.trim();
  const cidr = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}\/24$/i.exec(s);
  if (cidr) {
    // Any a.b.c.x/24 denotes the a.b.c.0/24 LAN — always sweep .1–.254
    const prefix = cidr[1];
    const out: string[] = [];
    for (let h = 1; h <= 254; h++) out.push(`${prefix}.${h}`);
    return out;
  }

  const parts = s.split(".").map((p) => p.trim());
  if (parts.length === 4) {
    const a = parts.map((p) => Number(p));
    if (a.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return [];
    if (a[3] === 0) {
      const prefix = `${a[0]}.${a[1]}.${a[2]}`;
      const out: string[] = [];
      for (let h = 1; h <= 254; h++) out.push(`${prefix}.${h}`);
      return out;
    }
    return [s];
  }

  if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
    const prefix = parts.join(".");
    const out: string[] = [];
    for (let h = 1; h <= 254; h++) out.push(`${prefix}.${h}`);
    return out;
  }

  return [];
}

function defaultListFromLocalIp(localIp: string): string[] {
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(localIp.trim());
  if (!m) return [];
  const prefix = m[1];
  const out: string[] = [];
  for (let h = 1; h <= 254; h++) out.push(`${prefix}.${h}`);
  return out;
}

export function suggestSubnetFromIp(localIp: string): string {
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(localIp.trim());
  if (!m) return "";
  return `${m[1]}.0/24`;
}

function tcpConnect(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: ip, port });
    const t = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(t);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

function looksLikeTscHtml(html: string, title: string): boolean {
  const blob = `${title}\n${html.slice(0, 48_000)}`;
  return /TSC|TE210|TE200|TE300|TSPL|Auto\s*ID|tscprinters|Barcode\s*Printer/i.test(blob);
}

async function probeWebUi(ip: string, timeoutMs: number): Promise<PrinterCandidate["webUi"]> {
  const url = `http://${ip}/`;
  try {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: "follow",
      headers: { Accept: "text/html,*/*" },
    });
    clearTimeout(tid);
    const text = await res.text();
    const titleM = /<title[^>]*>([^<]*)<\/title>/i.exec(text);
    const title = titleM ? titleM[1].trim() : undefined;
    const tsc = looksLikeTscHtml(text, title || "");
    return {
      reachable: true,
      url,
      title,
      looksLikeTsc: tsc,
      httpStatus: res.status,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      reachable: false,
      url,
      looksLikeTsc: false,
      error: msg,
    };
  }
}

async function runPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]!);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Scan addresses for open `tcpPort` (default 9100). Optionally confirm TSC via HTTP.
 */
export async function discoverPrinterCandidates(opts: DiscoverOptions = {}): Promise<PrinterCandidate[]> {
  const tcpPort = opts.tcpPort ?? 9100;
  const tcpTimeoutMs = opts.tcpTimeoutMs ?? 900;
  const httpTimeoutMs = opts.httpTimeoutMs ?? 2_500;
  const concurrency = Math.min(64, Math.max(4, opts.concurrency ?? 40));
  const probeWeb = opts.probeWeb !== false;

  let hosts: string[] = [];
  if (opts.subnet?.trim()) {
    hosts = ipv4ToList(opts.subnet.trim());
  } else if (opts.localBaseIp?.trim()) {
    hosts = defaultListFromLocalIp(opts.localBaseIp.trim());
  }

  if (hosts.length === 0) {
    return [];
  }

  const openFlags = await runPool(hosts, concurrency, async (ip) =>
    tcpConnect(ip, tcpPort, tcpTimeoutMs)
  );

  const candidates: PrinterCandidate[] = [];
  for (let i = 0; i < hosts.length; i++) {
    const ip = hosts[i]!;
    const tcpOpen = openFlags[i]!;
    if (!tcpOpen) continue;
    const row: PrinterCandidate = { ip, tcpPort, tcpOpen };
    if (probeWeb) {
      row.webUi = await probeWebUi(ip, httpTimeoutMs);
    }
    candidates.push(row);
  }

  return candidates;
}
