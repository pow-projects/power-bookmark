import { setTaskIndicator } from '../bookmarks/badge-manager';
import {
  setArchiveCaptureState,
  clearArchiveCaptureState,
  notifyArchiveCaptureUpdate,
  notifyArchiveCaptureError
} from './archive-capture-state';
import { syncArchiveToCloudByBookmarkId } from './archive-cloud';
import { archiveBookmark } from './page-capture';
import { fetchHtmlWithCharset } from './fetch-with-charset';
import db from '../db';

export interface ArchiveJobInput {
  bookmarkId: number;
  htmlSource?: string;
  pageUrl: string;
  pageTitle: string;
  summary?: string;
  iframeSources?: Record<string, string>;
  compress?: boolean;
}

export interface EnqueueArchiveResult {
  ok: boolean;
  reason?: 'duplicate' | 'missing-params';
  error?: string;
}

const jobQueue: ArchiveJobInput[] = [];
const activeJobIds = new Set<number>();
let draining = false;
let offscreenCreatingPromise: Promise<void> | null = null;
let offscreenCloseTimer: ReturnType<typeof setTimeout> | null = null;

const IDLE_OFFSCREEN_CLOSE_MS = 30000;
const JOB_TIMEOUT_MS = 60000;

export async function ensureOffscreenDocument(): Promise<void> {
  if (import.meta.env.FIREFOX || typeof chrome === 'undefined' || !chrome.offscreen) {
    return;
  }

  if (offscreenCloseTimer) {
    clearTimeout(offscreenCloseTimer);
    offscreenCloseTimer = null;
  }

  try {
    if ('hasDocument' in chrome.offscreen && typeof chrome.offscreen.hasDocument === 'function') {
      const hasDoc = await chrome.offscreen.hasDocument();
      if (hasDoc) return;
    } else if ('getContexts' in chrome.runtime && typeof chrome.runtime.getContexts === 'function') {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT' as any]
      });
      if (contexts && contexts.length > 0) return;
    }
  } catch (e) {
    console.warn('[archive-queue] Failed to check offscreen document status:', e);
  }

  if (offscreenCreatingPromise) {
    await offscreenCreatingPromise;
    return;
  }

  offscreenCreatingPromise = (async () => {
    try {
      const offscreenUrl = chrome.runtime.getURL('offscreen.html');
      await chrome.offscreen.createDocument({
        url: offscreenUrl,
        reasons: ['DOM_SCRAPING' as any],
        justification: 'Capture and archive web page DOM and assets'
      });
    } catch (err: any) {
      if (!err?.message?.includes('already exists') && !err?.message?.includes('Only a single offscreen')) {
        console.warn('[archive-queue] Offscreen create failed:', err);
      }
    } finally {
      offscreenCreatingPromise = null;
    }
  })();

  await offscreenCreatingPromise;
}

export async function closeOffscreenDocument(): Promise<void> {
  if (import.meta.env.FIREFOX || typeof chrome === 'undefined' || !chrome.offscreen || !chrome.offscreen.closeDocument) {
    return;
  }
  try {
    if ('hasDocument' in chrome.offscreen && typeof chrome.offscreen.hasDocument === 'function') {
      const hasDoc = await chrome.offscreen.hasDocument();
      if (!hasDoc) return;
    }
    await chrome.offscreen.closeDocument();
  } catch {
    // ignore
  }
}

async function claimActive(bookmarkId: number): Promise<void> {
  if (activeJobIds.has(bookmarkId)) return;
  activeJobIds.add(bookmarkId);
  if (activeJobIds.size === 1) {
    try {
      await setTaskIndicator('archive', true);
    } catch {
      // ignore
    }
  }
}

async function releaseActive(bookmarkId: number): Promise<void> {
  if (!activeJobIds.has(bookmarkId)) return;
  activeJobIds.delete(bookmarkId);
  if (activeJobIds.size === 0) {
    try {
      await setTaskIndicator('archive', false);
    } catch {
      // ignore
    }
    if (offscreenCloseTimer) clearTimeout(offscreenCloseTimer);
    if (!import.meta.env.FIREFOX) {
      offscreenCloseTimer = setTimeout(() => {
        closeOffscreenDocument().catch(() => {});
      }, IDLE_OFFSCREEN_CLOSE_MS);
    }
  }
}

async function executeArchiveWithOffscreen(job: ArchiveJobInput): Promise<void> {
  await ensureOffscreenDocument();

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(i18n.t('archive.jobTimeout', { seconds: JOB_TIMEOUT_MS / 1000 })));
    }, JOB_TIMEOUT_MS);

    try {
      if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
        browser.runtime.sendMessage({
          type: 'OFFSCREEN_ARCHIVE_BOOKMARK',
          bookmarkId: job.bookmarkId,
          htmlSource: job.htmlSource,
          pageUrl: job.pageUrl,
          pageTitle: job.pageTitle,
          summary: job.summary,
          iframeSources: job.iframeSources,
          compress: job.compress
        }).then((res: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (res?.ok) {
            resolve();
          } else {
            reject(new Error(res?.error || i18n.t('archive.offscreenRunFailed')));
          }
        }).catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
      } else {
        clearTimeout(timer);
        reject(new Error('browser.runtime.sendMessage is not available'));
      }
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    }
  });
}

async function executeArchiveDirect(job: ArchiveJobInput): Promise<void> {
  let htmlSource = job.htmlSource;
  if (!htmlSource && job.pageUrl) {
    htmlSource = await fetchHtmlWithCharset(job.pageUrl);
  }
  if (!htmlSource) {
    throw new Error(i18n.t('archive.htmlCaptureFailed'));
  }

  await archiveBookmark(
    job.bookmarkId,
    htmlSource,
    job.pageUrl,
    job.pageTitle,
    job.summary || '',
    job.iframeSources || {},
    job.compress ?? true
  );
}

async function processSingleJob(job: ArchiveJobInput): Promise<void> {
  const bookmark = await db.bookmarks.get(job.bookmarkId);
  if (!bookmark) {
    console.log(`[archive-queue] Bookmark ${job.bookmarkId} no longer exists; skipping archive job.`);
    return;
  }

  await setArchiveCaptureState({ bookmarkId: job.bookmarkId, startedAt: Date.now() });

  try {
    const isChromeOffscreenSupported = !import.meta.env.FIREFOX && typeof chrome !== 'undefined' && !!chrome.offscreen;
    if (isChromeOffscreenSupported) {
      await executeArchiveWithOffscreen(job);
    } else {
      await executeArchiveDirect(job);
    }

    const existsAfter = await db.bookmarks.get(job.bookmarkId);
    if (existsAfter) {
      try {
        await syncArchiveToCloudByBookmarkId(job.bookmarkId);
      } catch (e) {
        console.warn('[archive-queue] Cloud sync relay failed for bookmark:', job.bookmarkId, e);
      }
    }

    await notifyArchiveCaptureUpdate();
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    console.error('[archive-queue] Job processing error for bookmark:', job.bookmarkId, errMsg);
    await notifyArchiveCaptureError(job.bookmarkId, errMsg);
    throw err;
  } finally {
    await clearArchiveCaptureState(job.bookmarkId);
  }
}

async function drainArchiveQueue(): Promise<void> {
  if (draining) return;
  draining = true;

  try {
    while (jobQueue.length > 0) {
      const job = jobQueue.shift();
      if (!job) break;

      try {
        await processSingleJob(job);
      } catch {
        // Individual job error is logged and notified in processSingleJob
      } finally {
        await releaseActive(job.bookmarkId);
      }
    }
  } finally {
    draining = false;
    if (jobQueue.length > 0) {
      void drainArchiveQueue();
    }
  }
}

export async function enqueueArchiveJob(input: ArchiveJobInput): Promise<EnqueueArchiveResult> {
  if (typeof input.bookmarkId !== 'number' || !input.pageUrl) {
    return { ok: false, reason: 'missing-params' };
  }

  if (activeJobIds.has(input.bookmarkId)) {
    return { ok: false, reason: 'duplicate' };
  }

  await claimActive(input.bookmarkId);
  jobQueue.push(input);
  void drainArchiveQueue();

  return { ok: true };
}

export function getArchiveQueueLength(): number {
  return jobQueue.length;
}

export function getActiveArchiveCount(): number {
  return activeJobIds.size;
}

export function _resetArchiveQueueForTest(): void {
  jobQueue.length = 0;
  activeJobIds.clear();
  draining = false;
  if (offscreenCloseTimer) {
    clearTimeout(offscreenCloseTimer);
    offscreenCloseTimer = null;
  }
  offscreenCreatingPromise = null;
}
