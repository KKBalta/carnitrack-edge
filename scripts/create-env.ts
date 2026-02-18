#!/usr/bin/env bun

/**
 * CarniTrack Edge - .env File Generator
 * 
 * Generates a .env file with all configurable environment variables
 * based on the config.ts file.
 * 
 * Usage:
 *   bun scripts/create-env.ts              # Interactive mode
 *   bun scripts/create-env.ts --template  # Generate template only
 *   bun scripts/create-env.ts --output .env.example  # Custom output file
 */

import { existsSync, writeFileSync } from "fs";
import { join } from "path";

const PROJECT_ROOT = import.meta.dir ? join(import.meta.dir, "..") : process.cwd();
const DEFAULT_ENV_PATH = join(PROJECT_ROOT, ".env");
const EXAMPLE_ENV_PATH = join(PROJECT_ROOT, ".env.example");

// ═══════════════════════════════════════════════════════════════════════════════
// ENVIRONMENT VARIABLE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

interface EnvVar {
  name: string;
  defaultValue: string;
  description: string;
  category: string;
  required?: boolean;
}

const envVars: EnvVar[] = [
  // Edge Identity
  {
    name: "EDGE_NAME",
    defaultValue: "",
    description: "Edge device name (human-readable identifier for this Edge instance, used as site name if provided)",
    category: "Edge Identity",
  },
  {
    name: "SITE_ID",
    defaultValue: "",
    description: "Site ID for registration (from Cloud setup)",
    category: "Edge Identity",
    required: true,
  },
  {
    name: "REGISTRATION_TOKEN",
    defaultValue: "",
    description: "Site registration token (for initial Cloud registration)",
    category: "Edge Identity",
    required: true,
  },
  
  // TCP Server
  {
    name: "TCP_PORT",
    defaultValue: "8899",
    description: "Port to listen for scale connections",
    category: "TCP Server",
  },
  {
    name: "TCP_HOST",
    defaultValue: "0.0.0.0",
    description: "Host to bind TCP server (0.0.0.0 for all interfaces)",
    category: "TCP Server",
  },
  
  // HTTP Server
  {
    name: "HTTP_PORT",
    defaultValue: "3000",
    description: "Port for admin dashboard and API",
    category: "HTTP Server",
  },
  {
    name: "HTTP_HOST",
    defaultValue: "0.0.0.0",
    description: "Host to bind HTTP server",
    category: "HTTP Server",
  },
  
  // Database
  {
    name: "DB_PATH",
    defaultValue: "data/carnitrack.db",
    description: "Path to SQLite database file (relative to project root)",
    category: "Database",
  },
  
  // REST API / Cloud Connection
  {
    name: "CLOUD_API_URL",
    defaultValue: "https://api.carnitrack.com/api/v1",
    description: "Cloud API root (no trailing slash, no /edge — Edge appends /edge/... itself)",
    category: "Cloud Connection",
  },
  {
    name: "SESSION_POLL_INTERVAL_MS",
    defaultValue: "5000",
    description: "Session polling interval (ms)",
    category: "Cloud Connection",
  },
  {
    name: "EVENT_SEND_TIMEOUT_MS",
    defaultValue: "10000",
    description: "Event POST timeout (ms)",
    category: "Cloud Connection",
  },
  {
    name: "REST_MAX_RETRIES",
    defaultValue: "3",
    description: "Max retry attempts for failed requests",
    category: "Cloud Connection",
  },
  {
    name: "REST_RETRY_DELAY_MS",
    defaultValue: "1000",
    description: "Initial retry delay (ms)",
    category: "Cloud Connection",
  },
  {
    name: "REST_BACKOFF_MULTIPLIER",
    defaultValue: "2",
    description: "Retry backoff multiplier",
    category: "Cloud Connection",
  },
  {
    name: "REST_MAX_RETRY_DELAY_MS",
    defaultValue: "30000",
    description: "Maximum retry delay (ms)",
    category: "Cloud Connection",
  },
  {
    name: "CLOUD_BATCH_SIZE",
    defaultValue: "50",
    description: "Batch size for event uploads",
    category: "Cloud Connection",
  },
  {
    name: "BATCH_INTERVAL_MS",
    defaultValue: "5000",
    description: "Batch interval for pending events (ms)",
    category: "Cloud Connection",
  },
  
  // Heartbeat & Health
  {
    name: "HEARTBEAT_TIMEOUT_MS",
    defaultValue: "60000",
    description: "Time without heartbeat before marking device disconnected (ms) - 2 missed HBs",
    category: "Health Monitoring",
  },
  
  // Activity Monitoring
  {
    name: "ACTIVITY_IDLE_MS",
    defaultValue: "300000",
    description: "Time without weight events before marking device 'idle' (ms) - 5 minutes",
    category: "Activity Monitoring",
  },
  {
    name: "ACTIVITY_STALE_MS",
    defaultValue: "1800000",
    description: "Time without weight events before marking device 'stale' (ms) - 30 minutes",
    category: "Activity Monitoring",
  },
  
  // Session Cache
  {
    name: "SESSION_CACHE_EXPIRY_MS",
    defaultValue: "14400000",
    description: "How long to keep cached session valid without Cloud update (ms) - 4 hours",
    category: "Session Cache",
  },
  
  // Offline Mode
  {
    name: "OFFLINE_TRIGGER_DELAY_MS",
    defaultValue: "5000",
    description: "Time without Cloud connection before entering offline mode (ms)",
    category: "Offline Mode",
  },
  {
    name: "OFFLINE_MAX_EVENTS_PER_BATCH",
    defaultValue: "1000",
    description: "Maximum events to store per offline batch before starting new batch",
    category: "Offline Mode",
  },
  {
    name: "OFFLINE_BATCH_RETENTION_DAYS",
    defaultValue: "30",
    description: "How long to keep offline batches before cleanup (days)",
    category: "Offline Mode",
  },
  
  // PLU Generation
  {
    name: "PLU_OUTPUT_DIR",
    defaultValue: "generated",
    description: "Output directory for generated PLU files (relative to project root)",
    category: "PLU Generation",
  },
  
  // Work Hours
  {
    name: "WORK_HOURS_START",
    defaultValue: "06:00",
    description: "Work start time (HH:MM)",
    category: "Work Hours",
  },
  {
    name: "WORK_HOURS_END",
    defaultValue: "18:00",
    description: "Work end time (HH:MM)",
    category: "Work Hours",
  },
  {
    name: "TIMEZONE",
    defaultValue: "Europe/Istanbul",
    description: "Timezone",
    category: "Work Hours",
  },
  
  // Logging
  {
    name: "LOG_LEVEL",
    defaultValue: "info",
    description: "Log level: debug, info, warn, error",
    category: "Logging",
  },
  {
    name: "LOG_DIR",
    defaultValue: "logs",
    description: "Log directory (relative to project root)",
    category: "Logging",
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function generateEnvContent(useDefaults: boolean = false, values?: Map<string, string>): string {
  const lines: string[] = [];
  
  lines.push("# ═══════════════════════════════════════════════════════════════════════════════");
  lines.push("# CarniTrack Edge - Environment Configuration");
  lines.push("# ═══════════════════════════════════════════════════════════════════════════════");
  lines.push("#");
  lines.push("# Generated by: scripts/create-env.ts");
  lines.push(`# Generated at: ${new Date().toISOString()}`);
  lines.push("#");
  lines.push("# This file contains all configurable environment variables.");
  lines.push("# Uncomment and set values as needed. Defaults are shown.");
  lines.push("#");
  lines.push("");
  
  let currentCategory = "";
  
  for (const envVar of envVars) {
    // Add category header
    if (envVar.category !== currentCategory) {
      if (currentCategory !== "") {
        lines.push("");
      }
      lines.push(`# ───────────────────────────────────────────────────────────────────────────────`);
      lines.push(`# ${envVar.category}`);
      lines.push(`# ───────────────────────────────────────────────────────────────────────────────`);
      currentCategory = envVar.category;
    }
    
    // Add variable
    const value = useDefaults 
      ? envVar.defaultValue 
      : (values?.get(envVar.name) ?? envVar.defaultValue);
    
    const required = envVar.required ? " (REQUIRED)" : "";
    const comment = `# ${envVar.description}${required}`;
    
    if (envVar.required && !value) {
      lines.push(comment);
      lines.push(`${envVar.name}=`);
    } else if (useDefaults || value === envVar.defaultValue) {
      lines.push(comment);
      lines.push(`# ${envVar.name}=${value}`);
    } else {
      lines.push(comment);
      lines.push(`${envVar.name}=${value}`);
    }
    
    lines.push("");
  }
  
  return lines.join("\n");
}

function readInput(prompt: string, defaultValue: string): string {
  process.stdout.write(`${prompt} [${defaultValue}]: `);
  const readline = require("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  return new Promise((resolve) => {
    rl.once("line", (line: string) => {
      rl.close();
      const trimmed = line.trim();
      resolve(trimmed || defaultValue);
    });
  });
}

async function interactiveMode(): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  
  console.log("\n╔══════════════════════════════════════════════════════════════════════════════╗");
  console.log("║           CarniTrack Edge - Interactive .env Configuration                    ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════╝");
  console.log("\nPress Enter to use default values, or type custom values.\n");
  
  for (const envVar of envVars) {
    const required = envVar.required ? " (REQUIRED)" : "";
    const prompt = `${envVar.name}${required}\n  ${envVar.description}`;
    const value = await readInput(prompt, envVar.defaultValue);
    values.set(envVar.name, value);
  }
  
  return values;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const isTemplate = args.includes("--template") || args.includes("-t");
  const outputIndex = args.indexOf("--output") || args.indexOf("-o");
  const outputPath = outputIndex !== -1 && args[outputIndex + 1]
    ? args[outputIndex + 1]
    : (isTemplate ? EXAMPLE_ENV_PATH : DEFAULT_ENV_PATH);
  
  let content: string;
  let values: Map<string, string> | undefined;
  
  if (isTemplate) {
    // Generate template with defaults commented out
    content = generateEnvContent(true);
    console.log(`✓ Generating .env template at: ${outputPath}`);
  } else {
    // Interactive mode
    values = await interactiveMode();
    content = generateEnvContent(false, values);
    console.log(`\n✓ Generating .env file at: ${outputPath}`);
  }
  
  // Check if file exists
  if (existsSync(outputPath) && !isTemplate) {
    console.log(`⚠️  Warning: ${outputPath} already exists!`);
    console.log("   The file will be overwritten.");
    console.log("   Press Ctrl+C to cancel, or Enter to continue...");
    await new Promise((resolve) => {
      process.stdin.once("data", () => resolve(undefined));
    });
  }
  
  // Write file
  writeFileSync(outputPath, content, "utf-8");
  console.log(`✓ File created successfully!\n`);
  
  // Show summary for required fields
  if (values) {
    const missingRequired = envVars.filter(
      (v) => v.required && (!values!.get(v.name) || values!.get(v.name) === "")
    );
    
    if (missingRequired.length > 0) {
      console.log("⚠️  Warning: The following required fields are empty:");
      missingRequired.forEach((v) => {
        console.log(`   - ${v.name}: ${v.description}`);
      });
      console.log("\n   Please set these values before running the application.\n");
    }
  }
}

// Run if executed directly
if (import.meta.main) {
  main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
}

export { generateEnvContent, envVars };
