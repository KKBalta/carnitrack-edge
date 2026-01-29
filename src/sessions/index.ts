/**
 * CarniTrack Edge - Session Cache Module
 * 
 * Exports for session cache management.
 */

export {
  SessionCacheManager,
  initSessionCacheManager,
  getSessionCacheManager,
  destroySessionCacheManager,
} from "./session-cache.ts";

export type { SessionCache } from "../types/index.ts";
