#!/usr/bin/env bun
/**
 * Multi-session test: send events from multiple scales (01, 02, 03) concurrently.
 *
 * Simulates real DP401 WiFi modules connecting in parallel to verify:
 * - Edge handles multiple TCP connections
 * - Each scale gets its own session/device
 * - Events are attributed to correct scale
 *
 * Usage:
 *   bun run scripts/send-scale-event-multi.ts
 *   TCP_HOST=127.0.0.1 TCP_PORT=8899 bun run scripts/send-scale-event-multi.ts
 *   bun run scripts/send-scale-event-multi.ts --scales 01,02,03
 *   bun run scripts/send-scale-event-multi.ts --scales 01,03 --events 2
 *
 * Requires: Edge service running (bun run start) with TCP server on port 8899.
 *
 * For cloudSessionId: create sessions on Cloud first for each device:
 *   POST /admin/session/start { "deviceId": "SCALE-01" }
 *   POST /admin/session/start { "deviceId": "SCALE-02" }
 *   POST /admin/session/start { "deviceId": "SCALE-03" }
 */

const host = process.env.TCP_HOST ?? "127.0.0.1";
const port = Number(process.env.TCP_PORT ?? "8899");

const HEARTBEAT = "HB";
const ACK_REQUEST = "KONTROLLU AKTAR OK?";

function parseArgs(): {
  scales: string[];
  eventsPerScale: number;
  staggerMs: number;
} {
  const args = process.argv.slice(2);
  let scales = ["01", "02", "03"];
  let eventsPerScale = 1;
  let staggerMs = 500;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--scales" && args[i + 1]) {
      scales = String(args[i + 1])
        .split(",")
        .map((s) => s.trim().padStart(2, "0"))
        .filter(Boolean);
      i++;
    } else if (args[i] === "--events" && args[i + 1]) {
      eventsPerScale = Math.max(1, parseInt(args[i + 1], 10) || 1);
      i++;
    } else if (args[i] === "--stagger" && args[i + 1]) {
      staggerMs = Math.max(0, parseInt(args[i + 1], 10) || 0);
      i++;
    }
  }

  return { scales, eventsPerScale, staggerMs };
}

/**
 * Build weighing event CSV line - same format as real DP401.
 */
function buildCsvLine(opts: {
  scaleId: string;
  product: string;
  weightGrams: number;
  operator: string;
  eventIndex: number;
}): string {
  const now = new Date();
  const d = now.getDate();
  const m = now.getMonth() + 1;
  const date = `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${now.getFullYear()}`;
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((x) => String(x).padStart(2, "0"))
    .join(":");
  const plu = String(opts.eventIndex + 1).padStart(5, "0");
  const barcode = `0000000000${opts.scaleId}`;
  const net = opts.weightGrams;
  const tare = 0;
  const gross = net + tare;
  const val1 = String(gross).padStart(10, "0");
  const val2 = String(tare).padStart(10, "0");
  const val3 = String(net).padStart(10, "0");
  const productPadded = opts.product.slice(0, 16).padEnd(16);
  const operatorPadded = opts.operator.slice(0, 48).padEnd(48);
  return `${plu},${time},${date},${productPadded},${barcode},0000,${operatorPadded},${val1},${val2},${val3},2,0,2,1,N,MULTI-SESSION TEST`;
}

async function runScale(
  scaleId: string,
  eventsPerScale: number,
  staggerMs: number,
  index: number
): Promise<void> {
  const registration = `SCALE-${scaleId}`;
  const product = `SCALE${scaleId}`;
  const operator = `OP_${scaleId}`;

  // Stagger connections so they don't all hit at once
  if (staggerMs > 0 && index > 0) {
    await new Promise((r) => setTimeout(r, staggerMs * index));
  }

  const socket = await Bun.connect({
    hostname: host,
    port,
    socket: {
      data(_socket, data) {
        const text = data.toString();
        if (text.includes("OK")) {
          process.stdout.write(`[${scaleId}]`);
        } else {
          console.log(`[${scaleId}] Edge replied:`, text);
        }
      },
      close() {},
      error(_, err) {
        console.error(`[${scaleId}] Socket error:`, err.message);
      },
    },
  });

  // 1. Registration
  socket.write(registration);
  console.log(`[${scaleId}] Sent: ${registration}`);
  await new Promise((r) => setTimeout(r, 1500));

  // 2. Heartbeat
  socket.write(HEARTBEAT);
  console.log(`[${scaleId}] Sent: ${HEARTBEAT}`);
  await new Promise((r) => setTimeout(r, 300));

  // 3. Events
  for (let i = 0; i < eventsPerScale; i++) {
    const csvLine = buildCsvLine({
      scaleId,
      product,
      weightGrams: 2500 + index * 100 + i * 10,
      operator,
      eventIndex: i,
    });
    socket.write(csvLine + "\n");
    process.stdout.write(`[${scaleId}] Event ${i + 1}/${eventsPerScale} sent...`);
    await new Promise((r) => setTimeout(r, 500));
    process.stdout.write(" ok\n");
  }

  // 4. Ack request
  socket.write(ACK_REQUEST);
  await new Promise((r) => setTimeout(r, 200));

  socket.end();
}

async function main(): Promise<void> {
  const { scales, eventsPerScale, staggerMs } = parseArgs();

  console.log(`Multi-session test: ${host}:${port}`);
  console.log(`Scales: ${scales.map((s) => `SCALE-${s}`).join(", ")}`);
  console.log(`Events per scale: ${eventsPerScale}`);
  console.log(`Stagger: ${staggerMs}ms between connections`);
  console.log("");

  const start = Date.now();

  await Promise.all(
    scales.map((scaleId, index) =>
      runScale(scaleId, eventsPerScale, staggerMs, index)
    )
  );

  const elapsed = Date.now() - start;
  console.log("");
  console.log(`Done in ${elapsed}ms. ${scales.length} scales × ${eventsPerScale} events = ${scales.length * eventsPerScale} total.`);
  console.log("Check Edge logs and Cloud dashboard for multi-session attribution.");
  console.log("");
  console.log("Tip: Create sessions on Cloud before running:");
  for (const s of scales) {
    console.log(`  POST /admin/session/start { "deviceId": "SCALE-${s}" }`);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  if (err.code === "ECONNREFUSED") {
    console.error("Make sure the Edge service is running: bun run start");
  }
  process.exit(1);
});
