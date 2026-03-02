/**
 * Runtime cloud config: values from GET /config or register response.
 * Used for sessionPollIntervalMs, heartbeatIntervalMs, workHours, timezone.
 * Falls back to static config when not yet received.
 */

import { config } from "../config.ts";

export interface CloudConfigSnapshot {
  sessionPollIntervalMs: number;
  heartbeatIntervalMs: number;
  workHoursStart: string;
  workHoursEnd: string;
  timezone: string;
}

const DEFAULTS: CloudConfigSnapshot = {
  sessionPollIntervalMs: config.rest.sessionPollIntervalMs,
  heartbeatIntervalMs: 30_000,
  workHoursStart: config.workHours.start,
  workHoursEnd: config.workHours.end,
  timezone: config.workHours.timezone,
};

let snapshot: CloudConfigSnapshot = { ...DEFAULTS };

/**
 * Update runtime config from Cloud (e.g. GET /config or register response.config).
 * Only overwrites keys that are present and valid numbers/strings.
 */
export function updateCloudConfig(cloud: Record<string, unknown>): void {
  if (typeof cloud.sessionPollIntervalMs === "number" && cloud.sessionPollIntervalMs > 0) {
    snapshot.sessionPollIntervalMs = cloud.sessionPollIntervalMs;
  }
  if (typeof cloud.heartbeatIntervalMs === "number" && cloud.heartbeatIntervalMs > 0) {
    snapshot.heartbeatIntervalMs = cloud.heartbeatIntervalMs;
  }
  if (typeof cloud.workHoursStart === "string") {
    snapshot.workHoursStart = cloud.workHoursStart;
  }
  if (typeof cloud.workHoursEnd === "string") {
    snapshot.workHoursEnd = cloud.workHoursEnd;
  }
  if (typeof cloud.timezone === "string") {
    snapshot.timezone = cloud.timezone;
  }
}

/**
 * Get current session poll interval (ms). Config-driven at runtime.
 */
export function getSessionPollIntervalMs(): number {
  return snapshot.sessionPollIntervalMs;
}

/**
 * Get current heartbeat interval (ms). Config-driven at runtime.
 */
export function getHeartbeatIntervalMs(): number {
  return snapshot.heartbeatIntervalMs;
}

/**
 * Get full snapshot (for logging or other consumers).
 */
export function getCloudConfigSnapshot(): CloudConfigSnapshot {
  return { ...snapshot };
}

/**
 * Reset to defaults (e.g. when cloud config is cleared).
 */
export function resetCloudConfig(): void {
  snapshot = { ...DEFAULTS };
}
