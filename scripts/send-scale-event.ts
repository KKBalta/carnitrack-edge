#!/usr/bin/env bun
/**
 * Send a fabricated DP401 weighing event to the Edge TCP server.
 *
 * Simulates real DP401 WiFi module behavior to eliminate race conditions:
 * - Registration (SCALE-XX) sent alone, then wait for Edge to poll sessions
 * - Heartbeat (HB) sent to signal "online" before events
 * - Weighing events sent one-by-one, waiting for Edge OK between each
 *
 * Usage:
 *   bun run scripts/send-scale-event.ts
 *   TCP_HOST=127.0.0.1 TCP_PORT=8899 bun run scripts/send-scale-event.ts
 *   bun run scripts/send-scale-event.ts --count 3
 *   bun run scripts/send-scale-event.ts --product KUŞBAŞI --weight 1500
 *
 * Requires: Edge service running (bun run start) with TCP server on port 8899.
 *
 * For events to get cloudSessionId: create session on Cloud first, then run this script.
 */

const host = process.env.TCP_HOST ?? "127.0.0.1";
const port = Number(process.env.TCP_PORT ?? "8899");
const scaleId = process.env.SCALE_ID ?? "01";

// Exact packet strings as real DP401 WiFi module sends (no newlines unless noted)
const REGISTRATION = `SCALE-${scaleId.padStart(2, "0")}`;
const HEARTBEAT = "HB";
const ACK_REQUEST = "KONTROLLU AKTAR OK?";

function parseArgs(): { count: number; product: string; weightGrams: number; operator: string } {
  const args = process.argv.slice(2);
  let count = 1;
  let product = "KIYMA";
  let weightGrams = 2500;
  let operator = "TEST_OP";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--count" && args[i + 1]) {
      count = Math.max(1, parseInt(args[i + 1], 10) || 1);
      i++;
    } else if (args[i] === "--product" && args[i + 1]) {
      product = String(args[i + 1]).slice(0, 16).padEnd(16);
      i++;
    } else if (args[i] === "--weight" && args[i + 1]) {
      weightGrams = Math.max(0, parseInt(args[i + 1], 10) || 0);
      i++;
    } else if (args[i] === "--operator" && args[i + 1]) {
      operator = String(args[i + 1]).slice(0, 48).padEnd(48);
      i++;
    }
  }

  return { count, product, weightGrams, operator };
}

/**
 * Build weighing event CSV line - same format as real DP401.
 * PLU,TIME,DATE,PRODUCT,BARCODE,CODE,OPERATOR,VAL1,VAL2,VAL3,FLAGS...,COMPANY
 * VAL1=gross, VAL2=tare, VAL3=net (grams). Values >= 1000 are grams.
 */
function buildCsvLine(opts: {
  product: string;
  weightGrams: number;
  operator: string;
  plu?: string;
  barcode?: string;
  date?: string;
  time?: string;
}): string {
  const now = new Date();
  const d = now.getDate();
  const m = now.getMonth() + 1;
  const date = opts.date ?? `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${now.getFullYear()}`;
  const time =
    opts.time ??
    [now.getHours(), now.getMinutes(), now.getSeconds()].map((x) => String(x).padStart(2, "0")).join(":");
  const plu = opts.plu ?? "00001";
  const barcode = opts.barcode ?? "000000000001";
  const net = opts.weightGrams;
  const tare = 0;
  const gross = net + tare;
  const val1 = String(gross).padStart(10, "0");
  const val2 = String(tare).padStart(10, "0");
  const val3 = String(net).padStart(10, "0");
  const productPadded = opts.product.slice(0, 16).padEnd(16);
  const operatorPadded = opts.operator.slice(0, 48).padEnd(48);
  return `${plu},${time},${date},${productPadded},${barcode},0000,${operatorPadded},${val1},${val2},${val3},2,0,2,1,N,INTEGRATION TEST`;
}

async function main(): Promise<void> {
  const { count, product, weightGrams, operator } = parseArgs();

  console.log(`Connecting to ${host}:${port} (scale ${REGISTRATION})...`);
  console.log(`Sending ${count} event(s): ${product.trim()} ${weightGrams}g net, operator ${operator.trim()}`);
  console.log(`Simulating real DP401: registration → wait → heartbeat → events`);

  const socket = await Bun.connect({
    hostname: host,
    port,
    socket: {
      data(_socket, data) {
        const text = data.toString();
        if (text.includes("OK")) {
          process.stdout.write(".");
        } else {
          console.log("Edge replied:", text);
        }
      },
      close() {},
      error(_, err) {
        console.error("Socket error:", err.message);
      },
    },
  });

  // 1. Registration only (same as real DP401: sent on connect, no newline)
  socket.write(REGISTRATION);
  console.log(`  Sent: ${REGISTRATION}`);
  await new Promise((r) => setTimeout(r, 2000)); // Let Edge poll and cache session

  // 2. Heartbeat (online signal - real DP401 sends every 30s)
  socket.write(HEARTBEAT);
  console.log(`  Sent: ${HEARTBEAT}`);
  await new Promise((r) => setTimeout(r, 500));

  // 3. Weighing event(s) - one per send, wait for OK between (eliminates race)
  for (let i = 0; i < count; i++) {
    const csvLine = buildCsvLine({
      product,
      weightGrams: weightGrams + i * 10,
      operator,
    });
    socket.write(csvLine + "\n");
    process.stdout.write(`  Event ${i + 1}/${count} sent, waiting for OK...`);
    await new Promise((r) => setTimeout(r, 600)); // Edge processes and sends OK
    process.stdout.write(".\n");
  }

  // 4. Ack request (optional - real DP401 may send this)
  socket.write(ACK_REQUEST);
  await new Promise((r) => setTimeout(r, 300));

  socket.end();

  console.log(`\nSent ${count} event(s). Check Edge logs and Cloud dashboard.`);
  console.log(`Tip: Create session on Cloud before running: POST /admin/session/start { "deviceId": "${REGISTRATION}" }`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  if (err.code === "ECONNREFUSED") {
    console.error("Make sure the Edge service is running: bun run start");
  }
  process.exit(1);
});
