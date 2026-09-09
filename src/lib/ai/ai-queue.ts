import type { AiJob, AiJobKind } from './queue-types';
import { MAX_AI_RETRIES, retryBackoffMs } from './queue-config';
import { processAiJob, type ProcessOutcome } from './ai-processor';
import { setTaskIndicator } from '../bookmarks/badge-manager';
import { BookmarkManager } from '../bookmarks/bookmark-manager';
import { getAiSettings, isAiConfigured } from './ai-summarizer';
import { isPermanentAiError } from './llama-safety';
import db, { type CrossRootReviewData } from '../db';
import { AI_CONCURRENCY_CONFIG, type ExtractedPagePayload, type FolderInfo } from './types';

/**
 * Unified AI analysis queue — Both entry points (bookmark management AI analysis / auto-apply on bookmark creation)
 * push tasks to the same queue, and a single consumer (drain loop) processes them sequentially in FIFO order.
 *
 * - Persistence: IndexedDB `aiJobs` table (db v8). Restores queued/running jobs on SW restart.
 * - Dedup: Rejects if queued/running job already exists for (bookmarkId, kind).
 * - Retry: On failure, re-queues after exponential backoff (nextAttemptAt) while attempts < MAX_AI_RETRIES; transitions to error once exceeded.
 *   Permanent errors (token soup, etc., retryable=false) are immediately marked as error without exhausting attempts (R1/R2).
 * - Retry history: Appends {attempt, error, retryable, at} to retryHistory on each failure.
 * - Cancellation: Individual (cancelBookmarkAi) / All (cancelAllAi) — aborts running jobs, sets queued jobs to cancelled.
 * - Progress: Preserves single-key contract for storage.local `ai_bulk_progress` (REQ-7).
 */

export interface EnqueueInput {
  bookmarkId: number;
  kind: AiJobKind;
  payload?: ExtractedPagePayload;
  folders?: FolderInfo[];
  options?: AiJob['options'];
  batchId?: string;
}

export interface EnqueueResult {
  ok: boolean;
  jobId?: string;
  reason?: 'duplicate' | 'not-configured' | 'missing-bookmark';
}

type BulkAiKind = 'categorize' | 'summarize';

/**
 * Retrieves the effective concurrency limit (1-5, default 2) from active settings.
 */
export async function getEffectiveConcurrency(): Promise<number> {
  try {
    const settings = await getAiSettings();
    const c = Number(settings?.concurrency);
    if (!Number.isFinite(c)) return AI_CONCURRENCY_CONFIG.DEFAULT;
    return Math.max(AI_CONCURRENCY_CONFIG.MIN, Math.min(AI_CONCURRENCY_CONFIG.MAX, Math.round(c)));
  } catch {
    return AI_CONCURRENCY_CONFIG.DEFAULT;
  }
}

let isDispatching = false; // Guard to prevent re-entrant dispatcher loop execution
const activeAbortControllers = new Map<string, AbortController>(); // Map of AbortController per job ID
const runningJobIds = new Set<string>(); // Set of running job IDs to prevent duplicate concurrent dispatching
let resumeTimer: ReturnType<typeof setTimeout> | null = null; // Scheduled timer to resume drain after backoff wait

const batchProgress = new Map<string, { kind: BulkAiKind; total: number; done: number }>();
// Cross-root review storage items — must include bookmarkId (DB id) so BookmarkList.svelte can match DB records
type CrossRootReviewItem = CrossRootReviewData & { bookmarkId: number };
const batchCrossRoot = new Map<string, CrossRootReviewItem[]>();
// Set of completed job IDs per batch to track finish counts at job level (prevents duplicate counting on retry)
const batchFinishedIds = new Map<string, Set<string>>();

// Manage task indicator ('ai' badge) — claim on enqueue/recovery, release on terminal state transition
const activeJobIds = new Set<string>();

async function claimActive(id: string): Promise<void> {
  if (activeJobIds.has(id)) return;
  activeJobIds.add(id);
  if (activeJobIds.size === 1) {
    try {
      await setTaskIndicator('ai', true);
    } catch { /* ignore indicator failure */ }
  }
}

async function releaseActive(id: string): Promise<void> {
  if (!activeJobIds.has(id)) return;
  activeJobIds.delete(id);
  if (activeJobIds.size === 0) {
    try {
      await setTaskIndicator('ai', false);
    } catch { /* ignore indicator failure */ }
  }
}

/** Records progress in storage.local (no-op in absence of browser) */
async function saveProgress(progress: { kind: BulkAiKind; total: number; done: number; status: 'running' | 'done' | 'error'; at: number }): Promise<void> {
  try {
    if (typeof browser !== 'undefined' && browser.storage?.local) {
      await browser.storage.local.set({ ai_bulk_progress: progress });
    }
  } catch (e) {
    console.warn('Failed to persist bulk AI progress:', e);
  }
}

async function clearBulkProgressStorage(): Promise<void> {
  try {
    if (typeof browser !== 'undefined' && browser.storage?.local) {
      await browser.storage.local.remove('ai_bulk_progress');
    }
  } catch (e) {
    console.warn('Failed to clear bulk AI progress:', e);
  }
}

async function flushBatchCrossRoot(batchId: string): Promise<void> {
  const list = batchCrossRoot.get(batchId);
  batchCrossRoot.delete(batchId);
  if (!list || list.length === 0) return;
  try {
    if (typeof browser !== 'undefined' && browser.storage?.local) {
      await browser.storage.local.set({ ai_bulk_cross_root_review: list });
    }
  } catch (e) {
    console.warn('Failed to persist cross root review list:', e);
  }
}

async function publishBatchProgress(job: AiJob, phase: 'start' | 'finish', _outcome?: ProcessOutcome): Promise<void> {
  if (!job.batchId) return; // auto (single item) does not publish progress — card spinner only
  const bp = batchProgress.get(job.batchId);
  if (!bp) return;
  if (phase === 'finish') {
    // finish is counted once per job — prevents double counting on retry (re-insertion into queued)
    let ids = batchFinishedIds.get(job.batchId);
    if (!ids) {
      ids = new Set();
      batchFinishedIds.set(job.batchId, ids);
    }
    if (!ids.has(job.id)) {
      ids.add(job.id);
      bp.done += 1;
    }
  }
  const status = bp.done >= bp.total ? 'done' : 'running';
  await saveProgress({ kind: bp.kind, total: bp.total, done: bp.done, status, at: Date.now() });
  if (status === 'done') {
    batchProgress.delete(job.batchId);
    batchFinishedIds.delete(job.batchId);
    await flushBatchCrossRoot(job.batchId);
  }
}

/**
 * Restores state on SW startup and triggers drain.
 * - Restores jobs left in 'running' due to abnormal termination -> 'queued' + resets corresponding bookmark aiStatus to 'none' (prevents stuck spinners).
 * - Sweeps orphan bookmarks left with aiStatus='running' without corresponding jobs.
 */
export async function initAiQueue(): Promise<void> {
  activeAbortControllers.clear();
  runningJobIds.clear();

  // 1. running -> queued restoration. However, jobs that exhausted retry budget (attempts >= MAX)
  //    are finalized as error without re-execution — prevents infinite retries
  const stale = await db.aiJobs.where('status').equals('running').toArray();
  for (const job of stale) {
    const b = await db.bookmarks.get(job.bookmarkId);
    if ((job.attempts ?? 0) >= MAX_AI_RETRIES) {
      job.status = 'error';
      job.finishedAt = Date.now();
      await db.aiJobs.put(job);
      if (b?.aiStatus === 'running') {
        await BookmarkManager.updateBookmark(job.bookmarkId, { aiStatus: 'error' });
      }
      continue;
    }
    job.status = 'queued';
    await db.aiJobs.put(job);
    if (b?.aiStatus === 'running') {
      await BookmarkManager.updateBookmark(job.bookmarkId, { aiStatus: 'none' });
    }
  }

  // 2. Sweep orphan bookmarks with aiStatus running & pending (aiStatus is unindexed — use .filter() to prevent Dexie SchemaError)
  const orphans = await db.bookmarks.filter((b) => b.aiStatus === 'running' || b.aiStatus === 'pending').toArray();
  for (const b of orphans) {
    if (b.id !== undefined) {
      const jobs = await db.aiJobs.where('bookmarkId').equals(b.id).toArray();
      const hasJob = jobs.some((j) => j.status === 'queued' || j.status === 'running');
      if (!hasJob) {
        await BookmarkManager.updateBookmark(b.id, { aiStatus: 'none' });
      }
    }
  }

  // 3. Resume draining remaining queue
  const queued = await db.aiJobs.where('status').equals('queued').toArray();
  for (const j of queued) await claimActive(j.id);
  void drainQueue();
}

/**
 * Enqueues a single job (with dedup). Returns ok:false on not-configured/missing-bookmark/duplicate.
 */
export async function enqueueAiJob(input: EnqueueInput): Promise<EnqueueResult> {
  if (!(await isAiConfigured())) {
    const bookmark = await db.bookmarks.get(input.bookmarkId);
    if (bookmark && bookmark.aiStatus === 'pending') {
      await db.bookmarks.update(input.bookmarkId, { aiStatus: 'none' });
    }
    return { ok: false, reason: 'not-configured' };
  }

  const bookmark = await db.bookmarks.get(input.bookmarkId);
  if (!bookmark) {
    return { ok: false, reason: 'missing-bookmark' };
  }

  // dedup: reject if queued/running already exists for (bookmarkId, kind) (AC-1/AC-5)
  const dup = await db.aiJobs
    .where('[bookmarkId+kind]')
    .equals([input.bookmarkId, input.kind])
    .filter((j) => j.status === 'queued' || j.status === 'running')
    .first();
  if (dup) {
    return { ok: false, reason: 'duplicate' };
  }

  const job: AiJob = {
    id: crypto.randomUUID(),
    bookmarkId: input.bookmarkId,
    kind: input.kind,
    payload: input.payload,
    folders: input.folders,
    options: input.options,
    batchId: input.batchId,
    status: 'queued',
    attempts: 0,
    createdAt: Date.now()
  };
  await db.aiJobs.add(job);
  await claimActive(job.id);
  void drainQueue();
  return { ok: true, jobId: job.id };
}

/**
 * Bulk enqueue — assigns a common batchId to track progress (ai_bulk_progress) and
 * cross-root review list (ai_bulk_cross_root_review) at batch level.
 */
export async function enqueueAiJobs(inputs: EnqueueInput[]): Promise<EnqueueResult[]> {
  if (inputs.length === 0) return [];
  const batchId = crypto.randomUUID();
  const kind: BulkAiKind = inputs[0].kind === 'summarize' ? 'summarize' : 'categorize';
  batchProgress.set(batchId, { kind, total: inputs.length, done: 0 });
  batchCrossRoot.set(batchId, []);
  await saveProgress({ kind, total: inputs.length, done: 0, status: 'running', at: Date.now() });

  const results: EnqueueResult[] = [];
  for (const input of inputs) {
    results.push(await enqueueAiJob({ ...input, batchId }));
  }

  // If some were not enqueued due to dedup, adjust progress total to actual enqueued count and re-save
  const okCount = results.filter((r) => r.ok).length;
  const bp = batchProgress.get(batchId);
  if (bp) bp.total = okCount;
  if (okCount === 0) {
    // No items were enqueued in this batch — leave storage untouched so we don't overwrite single storage key with 0 and break existing progress
    batchProgress.delete(batchId);
    batchCrossRoot.delete(batchId);
    batchFinishedIds.delete(batchId);
  } else {
    await saveProgress({ kind, total: okCount, done: 0, status: 'running', at: Date.now() });
  }
  return results;
}

/**
 * Cancels AI task for an individual bookmark (AI_ABORT_BOOKMARK). Aborts running, marks queued as cancelled.
 */
export async function cancelBookmarkAi(bookmarkId: number): Promise<void> {
  const jobs = await db.aiJobs.where('bookmarkId').equals(bookmarkId).toArray();
  for (const job of jobs) {
    if (job.status !== 'queued' && job.status !== 'running') continue;
    if (job.status === 'running') {
      const controller = activeAbortControllers.get(job.id);
      controller?.abort();
    }
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    await db.aiJobs.put(job);
    await releaseActive(job.id);
  }
}

/**
 * Cancels all AI tasks (AI_ABORT_BULK). Marks all queued as cancelled, aborts running, clears progress.
 */
export async function cancelAllAi(): Promise<void> {
  for (const controller of activeAbortControllers.values()) {
    try {
      controller.abort();
    } catch { /* ignore */ }
  }
  activeAbortControllers.clear();

  const active = await db.aiJobs.where('status').anyOf('queued', 'running').toArray();
  for (const job of active) {
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    await db.aiJobs.put(job);
    await releaseActive(job.id);
  }
  runningJobIds.clear();
  batchProgress.clear();
  batchCrossRoot.clear();
  batchFinishedIds.clear();
  if (resumeTimer) {
    clearTimeout(resumeTimer);
    resumeTimer = null;
  }
  await clearBulkProgressStorage();
}

async function finalizeJob(job: AiJob, outcome: ProcessOutcome): Promise<void> {
  if (outcome.aborted) {
    job.status = 'cancelled';
    job.finishedAt = Date.now();
  } else if (outcome.ok) {
    job.status = 'done';
    job.finishedAt = Date.now();
    if (outcome.crossRootReview && job.batchId) {
      const list = batchCrossRoot.get(job.batchId) || [];
      // Saved item must include bookmarkId (DB id, number) so BookmarkList.svelte can match DB record and display
      list.push({ ...outcome.crossRootReview, bookmarkId: job.bookmarkId });
      batchCrossRoot.set(job.batchId, list);
    }
  } else {
    applyRetryOrFail(job, outcome.error || i18n.t('common.unknownError'), outcome.retryable !== false);
    if (job.status === 'queued') {
      // Retry transition does not increment finish count (defect #2 fix: prevent double count)
      await db.aiJobs.put(job);
      return;
    }
  }
  await db.aiJobs.put(job);
  await publishBatchProgress(job, 'finish', outcome);
}

/**
 * Common failure handling logic — logs retry history, then marks as error (dead-letter) if permanent error (non-retryable)
 * or max retries exceeded; otherwise re-inserts into queued with exponential backoff nextAttemptAt.
 * Returns resulting state ('queued' | 'error') so caller can determine whether to record finish.
 */
function applyRetryOrFail(job: AiJob, error: string, retryable: boolean): 'queued' | 'error' {
  job.error = error;
  const attempt = job.attempts + 1;
  job.retryHistory = [
    ...(job.retryHistory ?? []),
    { attempt, error, retryable, at: Date.now() }
  ];

  if (!retryable) {
    // Permanent error (token soup, etc.): immediately finalize as error without exhausting attempts (R1)
    job.status = 'error';
    job.finishedAt = Date.now();
    console.warn(`[ai-queue] job ${job.id} finalized immediately as error due to non-retryable failure (attempt ${attempt}): ${error}`);
    return 'error';
  }

  job.attempts = attempt;
  if (job.attempts < MAX_AI_RETRIES) {
    job.status = 'queued'; // Retry after exponential backoff (R2)
    job.nextAttemptAt = Date.now() + retryBackoffMs(attempt);
    console.warn(`[ai-queue] job ${job.id} attempt ${attempt}/${MAX_AI_RETRIES} failed — retrying in ${retryBackoffMs(attempt)}ms: ${error}`);
    return 'queued';
  }

  // Max retries exceeded -> dead-letter (marked as error)
  job.status = 'error';
  job.finishedAt = Date.now();
  job.nextAttemptAt = undefined;
  console.error(`[ai-queue] job ${job.id} exceeded max retries (${MAX_AI_RETRIES}) → marked as dead-letter error: ${error}`);
  return 'error';
}

/**
 * Resumes drain after backoff wait — updates existing timer if present (based on earliest timestamp).
 * Timer is cleared in cancelAllAi if queue becomes empty due to cancellation.
 */
function scheduleResume(delayMs: number): void {
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    void drainQueue();
  }, Math.max(delayMs, 0));
}

/**
 * Worker pool dispatch loop — dispatches ready jobs in parallel up to configured maxConcurrency limit.
 */
async function drainQueue(): Promise<void> {
  if (isDispatching) return;
  isDispatching = true;
  try {
    while (true) {
      const maxConcurrency = await getEffectiveConcurrency();
      if (runningJobIds.size >= maxConcurrency) break;

      const now = Date.now();
      const queued = await db.aiJobs.where('status').equals('queued').toArray();
      // Apply backoff: select jobs where nextAttemptAt has passed (ready for retry) in FIFO order, excluding already running jobs
      const ready = queued
        .filter((j) => !runningJobIds.has(j.id) && (j.nextAttemptAt ?? 0) <= now)
        .sort((a, b) => a.createdAt - b.createdAt);

      if (ready.length === 0) {
        // No ready jobs — schedule resume at earliest nextAttemptAt among unassigned queued jobs, then wait
        const unassignedQueued = queued.filter((j) => !runningJobIds.has(j.id));
        const earliest = Math.min(...unassignedQueued.map((j) => j.nextAttemptAt ?? Infinity));
        if (earliest !== Infinity && earliest > now) {
          scheduleResume(earliest - now);
        }
        break;
      }

      const job = ready[0];

      // Transition to running (synchronous memory claim prevents duplicate dispatch before DB persistence)
      runningJobIds.add(job.id);
      const abortController = new AbortController();
      activeAbortControllers.set(job.id, abortController);

      job.status = 'running';
      job.startedAt = Date.now();
      await db.aiJobs.put(job);

      // Asynchronous worker execution (prevents blocking dispatcher loop)
      void runWorker(job, abortController);
    }
  } finally {
    isDispatching = false;
    // Prevent Drain Gap (Double-Check): Check if ready jobs were added asynchronously right before exiting loop and schedule
    try {
      const maxConcurrency = await getEffectiveConcurrency();
      if (runningJobIds.size < maxConcurrency) {
        const now = Date.now();
        const hasReady = await db.aiJobs.where('status').equals('queued')
          .filter((j) => !runningJobIds.has(j.id) && (j.nextAttemptAt ?? 0) <= now)
          .first();
        if (hasReady) {
          scheduleResume(0);
        }
      }
    } catch {
      // ignore
    }
  }
}

async function runWorker(job: AiJob, abortController: AbortController): Promise<void> {
  try {
    await publishBatchProgress(job, 'start');
    const outcome = await processAiJob(job, abortController.signal);
    await finalizeJob(job, outcome);
  } catch (e: any) {
    const outcome = applyRetryOrFail(job, e?.message || String(e), !isPermanentAiError(e));
    await db.aiJobs.put(job);
    if (outcome === 'error') {
      await publishBatchProgress(job, 'finish', { ok: false, error: job.error });
    }
  } finally {
    activeAbortControllers.delete(job.id);
    runningJobIds.delete(job.id);
    const finalStatus: string = job.status;
    if (finalStatus === 'done' || finalStatus === 'error' || finalStatus === 'cancelled') {
      await releaseActive(job.id);
    }
    // Slot freed -> immediately run next waiting job
    void drainQueue();
  }
}
