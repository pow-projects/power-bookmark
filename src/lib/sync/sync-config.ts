/**
 * Default fallback cooldown duration (1000ms = 1s) for manual sync retries.
 */
export const DEFAULT_SYNC_COOLDOWN_MS = 1000;

/**
 * Built-in fixed guard for manual sync cooldown.
 * Injected at build time via `define: { __SYNC_COOLDOWN_MS__ }` in wxt.config.ts / vitest.config.ts.
 */
export const SYNC_COOLDOWN_MS: number =
  typeof __SYNC_COOLDOWN_MS__ !== 'undefined' ? __SYNC_COOLDOWN_MS__ : DEFAULT_SYNC_COOLDOWN_MS;
