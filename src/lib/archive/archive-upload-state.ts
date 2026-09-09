/**
 * Module for maintaining cloud archive upload progress state (single-flight markers and state map) in storage.local.
 *
 * Mirrors the storage.local pattern of archive-capture-state.ts / ai-bulk-analyzer.ts.
 * browser.* APIs are used only for state storage/notification, and are safely skipped as no-ops
 * when the browser global does not exist, such as in Node test environments.
 *
 * Single-flight design: Since the upload marker (`archive_upload_state`) is a single storage key,
 * there is a risk of overwriting markers if uploads for different syncIds proceed concurrently.
 * To prevent TOCTOU races, claim rejects if "the current marker is fresh (within STALE_MS) and belongs to a different syncId".
 */

export type ArchiveUploadStatus = 'pending' | 'uploading' | 'uploaded' | 'error';

export interface ArchiveUploadState {
  syncId: string;
  status: ArchiveUploadStatus;
  attempt: number;
  lastError?: string;
  at: number;
}

const STATE_KEY = 'archive_upload_state';
const MAP_KEY = 'archive_upload_map';
const UPDATE_KEY = 'archive_upload_last_update';
const ERROR_KEY = 'archive_upload_error';

/** Maximum lifetime (ms) for which an upload progress marker is valid. If exceeded, considered stale and overwriting is allowed. */
export const STALE_MS = 10 * 60 * 1000;

function hasStorage(): boolean {
  return typeof browser !== 'undefined' && !!browser.storage?.local;
}

/**
 * Single-flight upload claim. Called at start.
 * If the current marker is *in-progress* (status==='uploading'), fresh (within STALE_MS), and belongs to a different syncId,
 * returns false without overwriting. Completed ('uploaded'), failed ('error'), and pending ('pending') markers
 * are not considered in-progress, allowing different syncIds to claim immediately (preventing blocking subsequent items in sequential loops).
 * In other cases (no marker / expired / same syncId), sets state and returns true.
 * Environments without browser (no-op) or exceptions are considered successful claims and return true.
 */
export async function claimArchiveUpload(syncId: string): Promise<boolean> {
  try {
    if (hasStorage()) {
      try {
        const res = await browser.storage.local.get(STATE_KEY);
        const cur = res?.[STATE_KEY] as ArchiveUploadState | undefined;
        if (cur && cur.status === 'uploading' && cur.syncId !== syncId && Date.now() - cur.at < STALE_MS) {
          return false; // Another upload is actively in progress
        }
      } catch (readErr) {
        console.warn('Failed to read archive upload state before claim:', readErr);
      }
      await browser.storage.local.set({
        [STATE_KEY]: { syncId, status: 'uploading', attempt: 0, at: Date.now() }
      });
    }
    return true;
  } catch (e) {
    console.warn('Failed to persist archive upload state:', e);
    return true;
  }
}

/** Mark upload as completed + update state map. */
export async function markUploaded(syncId: string): Promise<void> {
  await setState({ syncId, status: 'uploaded', attempt: 0, at: Date.now() });
  await clearError();
  await notifyArchiveUploadUpdate();
}

/** Mark upload as error + update state map. */
export async function markError(syncId: string, message: string): Promise<void> {
  await setState({ syncId, status: 'error', attempt: 0, lastError: message, at: Date.now() });
}

/** Update state map + record marker. */
async function setState(s: ArchiveUploadState): Promise<void> {
  try {
    if (!hasStorage()) return;
    const map = await getUploadStateMapRaw();
    map[s.syncId] = s;
    await browser.storage.local.set({ [STATE_KEY]: s, [MAP_KEY]: map });
  } catch (e) {
    console.warn('Failed to set archive upload state:', e);
  }
}

/** Reads the state map. Returns empty object if none exists. */
export async function getUploadStateMap(): Promise<Record<string, ArchiveUploadState>> {
  try {
    return await getUploadStateMapRaw();
  } catch {
    return {};
  }
}

async function getUploadStateMapRaw(): Promise<Record<string, ArchiveUploadState>> {
  if (!hasStorage()) return {};
  const res = await browser.storage.local.get(MAP_KEY);
  return (res?.[MAP_KEY] as Record<string, ArchiveUploadState> | undefined) || {};
}

async function clearError(): Promise<void> {
  try {
    if (hasStorage()) await browser.storage.local.remove(ERROR_KEY);
  } catch (e) {
    console.warn('Failed to clear archive upload error:', e);
  }
}

/** Completion notification — triggers state re-query / toast on other management pages. */
export async function notifyArchiveUploadUpdate(): Promise<void> {
  try {
    if (hasStorage()) await browser.storage.local.set({ [UPDATE_KEY]: Date.now() });
  } catch (e) {
    console.warn('Failed to notify archive upload update:', e);
  }
}

/** Failure notification — cross-page error toast. */
export async function notifyArchiveUploadError(syncId: string, error: string): Promise<void> {
  try {
    if (hasStorage()) {
      await browser.storage.local.set({ [ERROR_KEY]: { syncId, error, at: Date.now() } });
    }
  } catch (e) {
    console.warn('Failed to notify archive upload error:', e);
  }
}
