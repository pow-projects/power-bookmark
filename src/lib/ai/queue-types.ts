import type { ExtractedPagePayload, FolderInfo } from './types';

/**
 * Unified AI analysis queue job schema.
 * Both entry points (bookmark management AI analysis / auto-apply on bookmark creation) push jobs to the same queue,
 * and a background worker (drain loop in ai-queue) processes them sequentially.
 *
 * kind has 3 values: 'auto' | 'categorize' | 'summarize' (retry removed — individual reanalysis accommodated by re-enqueuing categorize).
 */
export type AiJobKind = 'auto' | 'categorize' | 'summarize';

export type AiJobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

/** Single retry record — attempt (1-based), failure reason, retryable flag, failure timestamp */
export interface AiJobRetryRecord {
  attempt: number;
  error: string;
  retryable: boolean;
  at: number;
}

export interface AiJob {
  id: string; // crypto.randomUUID() — generated upon enqueue
  bookmarkId: number; // Internal DB bookmark.id
  kind: AiJobKind;
  payload?: ExtractedPagePayload; // auto: popup passed value. If absent, processAiJob falls back to buildPagePayload
  folders?: FolderInfo[]; // Optional. If absent, processAiJob freshly loads via getFolders()
  options?: { autoSummarize?: boolean; autoTags?: boolean; autoFolder?: boolean }; // auto only
  batchId?: string; // For bulk progress (ai_bulk_progress) tracking (optional)
  status: AiJobStatus;
  attempts: number; // Number of retry attempts
  nextAttemptAt?: number; // Next retryable timestamp after exponential backoff (set when re-queued)
  retryHistory?: AiJobRetryRecord[]; // Retry history logging (appended on failure)
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}
