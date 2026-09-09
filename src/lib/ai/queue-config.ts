/**
 * Centralized constants for the unified AI analysis queue.
 */
export const MAX_AI_RETRIES = 3; // Maximum limit for automatic retries on failure (REQ-10)
export const BULK_CATEGORIZE_CAP = 50; // Maximum cap for bulk categorization in the management page (moved from BookmarkList.svelte)
export const AI_ANALYSIS_TIMEOUT_MS = 120_000; // AI request timeout (constant extracted from ai-summarizer.ts:151)

// Exponential retry backoff — increases according to attempt count (1-based): 2s → 8s → 32s (capped at 30s)
export const RETRY_BACKOFF_BASE_MS = 2_000;
export const RETRY_BACKOFF_FACTOR = 4;
export const RETRY_BACKOFF_MAX_MS = 30_000;

/** Calculates the retry delay for the given attempt (1-based) using exponential backoff with a cap */
export function retryBackoffMs(attempt: number): number {
  return Math.min(RETRY_BACKOFF_BASE_MS * RETRY_BACKOFF_FACTOR ** (attempt - 1), RETRY_BACKOFF_MAX_MS);
}

