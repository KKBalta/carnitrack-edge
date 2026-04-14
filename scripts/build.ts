#!/usr/bin/env bun

/**
 * CarniTrack Edge — Standalone Binary Builder
 *
 * Compiles the Edge service into a single executable using `bun build --compile`.
 * No runtime dependencies needed on the target machine.
 *
 * Usage:
 *   bun scripts/build.ts                # Build for current platform
 *   bun scripts/build.ts --windows      # Cross-compile for Windows x64
 *   bun scripts/build.ts --linux        # Cross-compile for Linux x64
 *   bun scripts/build.ts --all          # Build for all platforms
 */

import { mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";

const PROJECT_ROOT = join(import.meta.dir, "..");
const DIST_DIR = join(PROJECT_ROOT, "dist");
const ENTRY = join(PROJECT_ROOT, "src", "index.ts");

interface BuildTarget {
  name: string;
  bunTarget: string;
  outFile: string;
}

const TARGETS: Record<string, BuildTarget> = {
  windows: {
    name: "Windows x64",
    bunTarget: "bun-windows-x64",
    outFile: "carnitrack-edge.exe",
  },
  linux: {
    name: "Linux x64",
    bunTarget: "bun-linux-x64",
    outFile: "carnitrack-edge",
  },
  darwin: {
    name: "macOS x64",
    bunTarget: "bun-darwin-x64",
    outFile: "carnitrack-edge",
  },
};

function currentPlatformKey(): string {
  const p = process.platform;
  if (p === "win32") return "windows";
  if (p === "linux") return "linux";
  if (p === "darwin") return "darwin";
  return "linux";
}

async function build(target: BuildTarget, outputDir: string): Promise<void> {
  const outPath = join(outputDir, target.outFile);

  console.log(`  Building for ${target.name}...`);
  console.log(`    Target: ${target.bunTarget}`);
  console.log(`    Output: ${outPath}`);

  const proc = Bun.spawn(
    [
      "bun",
      "build",
      "--compile",
      `--target=${target.bunTarget}`,
      ENTRY,
      "--outfile",
      outPath,
    ],
    {
      cwd: PROJECT_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    console.error(`    FAILED (exit code ${exitCode})`);
    if (stderr.trim()) console.error(`    ${stderr.trim()}`);
    throw new Error(`Build failed for ${target.name}`);
  }

  const stat = Bun.file(outPath);
  const sizeMB = ((await stat.size) / 1024 / 1024).toFixed(1);
  console.log(`    OK (${sizeMB} MB)`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const buildAll = args.includes("--all");
  const buildWindows = args.includes("--windows") || args.includes("-w");
  const buildLinux = args.includes("--linux") || args.includes("-l");
  const buildDarwin = args.includes("--darwin") || args.includes("-m");

  console.log("");
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║         CarniTrack Edge — Standalone Build               ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  console.log("");

  if (existsSync(DIST_DIR)) {
    rmSync(DIST_DIR, { recursive: true });
  }

  const targetsToBuild: { key: string; target: BuildTarget; dir: string }[] = [];

  if (buildAll) {
    for (const [key, target] of Object.entries(TARGETS)) {
      const dir = join(DIST_DIR, key);
      mkdirSync(dir, { recursive: true });
      targetsToBuild.push({ key, target, dir });
    }
  } else {
    if (buildWindows) {
      const dir = join(DIST_DIR, "windows");
      mkdirSync(dir, { recursive: true });
      targetsToBuild.push({ key: "windows", target: TARGETS.windows, dir });
    }
    if (buildLinux) {
      const dir = join(DIST_DIR, "linux");
      mkdirSync(dir, { recursive: true });
      targetsToBuild.push({ key: "linux", target: TARGETS.linux, dir });
    }
    if (buildDarwin) {
      const dir = join(DIST_DIR, "darwin");
      mkdirSync(dir, { recursive: true });
      targetsToBuild.push({ key: "darwin", target: TARGETS.darwin, dir });
    }

    if (targetsToBuild.length === 0) {
      const key = currentPlatformKey();
      const dir = join(DIST_DIR, key);
      mkdirSync(dir, { recursive: true });
      targetsToBuild.push({ key, target: TARGETS[key], dir });
    }
  }

  console.log(`  Targets: ${targetsToBuild.map((t) => t.target.name).join(", ")}`);
  console.log(`  Entry:   ${ENTRY}`);
  console.log(`  Output:  ${DIST_DIR}/`);
  console.log("");

  let failed = 0;
  for (const { target, dir } of targetsToBuild) {
    try {
      await build(target, dir);
    } catch {
      failed++;
    }
    console.log("");
  }

  if (failed > 0) {
    console.error(`  ${failed} build(s) failed.`);
    process.exit(1);
  }

  console.log("  All builds completed successfully.");
  console.log("");
  console.log("  Next steps:");
  console.log("    1. Copy the dist/<platform>/ folder to the target machine");
  console.log("    2. Run the executable");
  console.log("    3. Open http://localhost:3000 to activate with a setup code");
  console.log("");
}

main().catch((err) => {
  console.error("Build error:", err);
  process.exit(1);
});
