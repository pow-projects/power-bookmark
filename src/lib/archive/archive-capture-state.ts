/**
 * Module for maintaining archive capture progress state (checkpoint) in storage.local.
 *
 * Background: If a page refresh/unload occurs while saving an archive (archiveBookmark) from
 * the management page, in-flight work is quietly lost. To prevent this, three layers of defense are used:
 *  1) beforeunload guard (UX assistance) — 2) progress marker in this module (`archive_capture_state`) — 3) automatic resumption on re-entry.
 * If a marker remains in storage.local, archive work is resumed upon the next visit to the management page.
 *
 * Directly mirrors the saveProgress/getProgress/clearProgress + `ai_analysis_last_update`/
 * `ai_analysis_error` notification patterns in `ai-bulk-analyzer.ts`. browser.* APIs are used
 * only for update triggers and state persistence, safely skipping as no-ops in environments without
 * browser globals like Node test environments.
 *
 * Ownership design: Since the progress marker is a single storage key, multiple management pages
 * archiving different bookmarks concurrently would overwrite each other's markers. To prevent
 * TOCTOU (write-and-erase) races and cross-context interference, all marker modifications are performed
 * "only when current marker matches my bookmarkId" (setArchiveCaptureState claim, clearArchiveCaptureState ownership check).
 */

/** Progress marker. Its presence signifies "running". Removed upon normal completion/failure. */
export interface ArchiveCaptureState {
  /** Internal DB bookmark id (Bookmark.id) */
  bookmarkId: number;
  /** Capture start epoch ms — used to determine staleness upon resume */
  startedAt: number;
}

const STATE_KEY = 'archive_capture_state';
const UPDATE_KEY = 'archive_capture_last_update';
const ERROR_KEY = 'archive_capture_error';

/** Maximum lifetime (ms) for which a progress marker is valid. If exceeded, considered not running and overwriting is allowed. */
export const STALE_MS = 10 * 60 * 1000;

function hasStorage(): boolean {
  return typeof browser !== 'undefined' && !!browser.storage?.local;
}

/**
 * Records (claims) the progress marker. Called at start.
 *
 * single-flight claim: If the current marker is fresh (within STALE_MS) and belongs to a different bookmarkId,
 * does not overwrite and returns false (another archive already in progress across contexts).
 * In other cases (no marker / expired / same bookmarkId), sets state and returns true.
 * Environments without browser (no-op) are considered successful claims and return true.
 * Read/write exceptions log console.warn and return true to keep progressing.
 */
export async function setArchiveCaptureState(s: ArchiveCaptureState): Promise<boolean> {
  try {
    if (hasStorage()) {
      try {
        const res = await browser.storage.local.get(STATE_KEY);
        const cur = res?.[STATE_KEY] as ArchiveCaptureState | undefined;
        if (cur && cur.bookmarkId !== s.bookmarkId && Date.now() - cur.startedAt < STALE_MS) {
          // Another page currently holds an active marker -> do not overwrite (TOCTOU defense)
          return false;
        }
      } catch (readErr) {
        // Marker read failure allows claim to keep progressing
        console.warn('Failed to read archive capture state before claim:', readErr);
      }
      await browser.storage.local.set({ [STATE_KEY]: s });
    }
    return true;
  } catch (e) {
    console.warn('Failed to persist archive capture state:', e);
    return true;
  }
}

/** Reads the progress marker. Returns undefined if none exists. */
export async function getArchiveCaptureState(): Promise<ArchiveCaptureState | undefined> {
  try {
    if (hasStorage()) {
      const res = await browser.storage.local.get(STATE_KEY);
      return res?.[STATE_KEY] as ArchiveCaptureState | undefined;
    }
  } catch (e) {
    console.warn('Failed to read archive capture state:', e);
  }
  return undefined;
}

/**
 * Clears the progress marker. Called upon normal completion/failure.
 *
 * When bookmarkId is provided, performs ownership check — only removes if current marker matches the bookmarkId,
 * and preserves marker if mismatched (another page has claimed marker and is still running).
 * If bookmarkId is omitted, unconditionally removes for backward compatibility.
 */
export async function clearArchiveCaptureState(bookmarkId?: number): Promise<void> {
  try {
    if (hasStorage()) {
      if (bookmarkId !== undefined) {
        try {
          const res = await browser.storage.local.get(STATE_KEY);
          const cur = res?.[STATE_KEY] as ArchiveCaptureState | undefined;
          // Do not clear if marker is missing or does not match my bookmarkId (another active task)
          if (!cur || cur.bookmarkId !== bookmarkId) return;
        } catch (readErr) {
          console.warn('Failed to read archive capture state before clear:', readErr);
        }
      }
      await browser.storage.local.remove(STATE_KEY);
    }
  } catch (e) {
    console.warn('Failed to clear archive capture state:', e);
  }
}

/**
 * Completion notification — triggers archiveMap re-query / toast on other management pages (mirrors ai_analysis_last_update).
 * On success, also removes previous failure object (archive_capture_error) to prevent stale error toasts.
 */
export async function notifyArchiveCaptureUpdate(): Promise<void> {
  try {
    if (hasStorage()) {
      await browser.storage.local.set({ [UPDATE_KEY]: Date.now() });
      await browser.storage.local.remove(ERROR_KEY);
    }
  } catch (e) {
    console.warn('Failed to notify archive capture update:', e);
  }
}

/** Failure notification — cross-page error toast (mirrors ai_analysis_error). */
export async function notifyArchiveCaptureError(bookmarkId: number, error: string): Promise<void> {
  try {
    if (hasStorage()) {
      await browser.storage.local.set({
        [ERROR_KEY]: { bookmarkId, error, at: Date.now() }
      });
    }
  } catch (e) {
    console.warn('Failed to notify archive capture error:', e);
  }
}
