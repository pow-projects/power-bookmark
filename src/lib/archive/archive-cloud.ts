/**
 * Coordinator for archive cloud storage, restoration, and deletion propagation.
 *
 * Handles uploads, restoration, deletion propagation, size validation, error classification/retries, and index.json atomic updates (lost-update prevention).
 * Orchestrates pure logic (archive-index.ts), state tracking (archive-upload-state.ts), and adapters (SyncEngine.getAdapter).
 * Local archives are never deleted under any circumstances (no data loss).
 */

import db, { type ArchivedPage } from '../db';
import { SyncEngine } from '../sync/sync-engine';
import { isConcurrentWrite } from '../sync/merge';
import { CloudStorageAdapter } from '../sync/adapters/base';
import { normalizeUrl } from '../bookmarks/url-normalizer';
import { getTombstones } from '../sync/tombstones';
import {
  getArchiveTombstones,
  recordArchiveTombstone,
  removeArchiveTombstone,
  isArchiveTombstoned,
  type ArchiveTombstone
} from './archive-tombstone';
import {
  ARCHIVES_FOLDER,
  ARCHIVE_INDEX_FILE,
  buildArchiveFileName,
  detectArchiveFormat,
  mergeArchiveIndex,
  emptyArchiveIndex,
  type ArchiveIndex,
  type ArchiveIndexEntry
} from './archive-index';

export type { ArchiveIndex, ArchiveIndexEntry, ArchiveTombstone };
export { getArchiveTombstones, recordArchiveTombstone, removeArchiveTombstone, isArchiveTombstoned };
import { decompressArchiveHtml } from './page-capture';
import {
  claimArchiveUpload,
  markUploaded,
  markError,
  notifyArchiveUploadError,
  getUploadStateMap
} from './archive-upload-state';

const INDEX_PATH = `${ARCHIVES_FOLDER}/${ARCHIVE_INDEX_FILE}`;

export type ArchiveSizeClass = 'ok' | 'soft-exceed' | 'hard-exceed';
export type ArchiveErrorClass = 'auth' | 'quota' | 'transient' | 'permanent';

/** Default size limits (bytes) — overridable via settings */
const DEFAULT_SOFT_LIMIT = 50 * 1024 * 1024; // 50 MiB
const DEFAULT_HARD_LIMIT = Infinity;

/** Setting gate (EC-1, AC-6). Default: true (enabled by default) */
export async function isArchiveCloudEnabled(): Promise<boolean> {
  return (await db.settings.get('sync_archive_to_cloud'))?.value ?? true;
}

/**
 * Shared helper for toggling archive cloud sync.
 * Used by both SyncSettings and SettingsContainer toggles, unifying behavior so that turning ON immediately
 * triggers catch-up (syncPendingArchives) (fixes defect where legacy toggle only saved settings).
 * @param enabled When ON (true), saves setting + immediately calls syncPendingArchives; when OFF (false), saves setting only.
 */
export async function setArchiveSyncEnabled(enabled: boolean): Promise<void> {
  await db.settings.put({ key: 'sync_archive_to_cloud', value: enabled });
  if (enabled) {
    await syncPendingArchives();
  }
}


/** Size validation (B-2/B-3). */
export async function classifyArchiveSize(fileSize: number): Promise<ArchiveSizeClass> {
  const soft = Number((await db.settings.get('archive_upload_soft_limit'))?.value ?? DEFAULT_SOFT_LIMIT);
  const hard = Number((await db.settings.get('archive_upload_hard_limit'))?.value ?? DEFAULT_HARD_LIMIT);
  if (fileSize >= hard) return 'hard-exceed';
  if (fileSize >= soft) return 'soft-exceed';
  return 'ok';
}

/**
 * Error classification (E-2/E-3).
 * - 401/403 -> auth
 * - 429/5xx/network/timeout -> transient
 * - Quota/space (507, 413, insufficient_space, quota) -> quota
 * - Other -> permanent
 */
export function classifyArchiveError(err: unknown): ArchiveErrorClass {
  const e: any = err;
  const status = typeof e?.status === 'number' ? e.status : 0;
  const message = String(e?.message || e?.name || '').toLowerCase();

  if (status === 401 || status === 403) return 'auth';
  // Enhance classification by parsing statusText ('Unauthorized'/'Forbidden' etc.) for errors without status code
  if (status === 0 && /unauthorized|forbidden|access.?denied|invalid.?credentials|authentication.?failed/.test(message)) return 'auth';
  if (status === 507 || status === 413 || status === 5070) return 'quota';
  if (/insufficient_space|quota|storage.?limit|space.?exceeded|507/.test(message)) return 'quota';
  if (status === 429 || (status >= 500 && status <= 599)) return 'transient';
  if (e?.name === 'TypeError' || /fetch|network|timeout|abort|temporarily|too many/.test(message)) return 'transient';
  return 'permanent';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry wrapper (E-3).
 * - auth: retry once after adapter.authenticate(true), throw on failure
 * - transient: retry up to 3 times with exponential backoff (500/1000/2000ms)
 * - quota/permanent: throw immediately
 * Throws the last error upon final failure (caller handles markError).
 */
export async function retry(
  fn: () => Promise<void>,
  classify: (err: unknown) => ArchiveErrorClass = classifyArchiveError,
  adapter?: CloudStorageAdapter | null
): Promise<void> {
  let authRetried = false;
  let attempt = 0;
  let lastErr: unknown;

  while (attempt < 3) {
    try {
      await fn();
      return;
    } catch (err) {
      lastErr = err;
      const kind = classify(err);
      if (kind === 'quota' || kind === 'permanent') throw err;
      if (kind === 'auth') {
        if (!authRetried && adapter) {
          authRetried = true;
          attempt++;
          try {
            await adapter.authenticate(true);
            continue;
          } catch (authErr) {
            throw err; // Re-authentication failed -> throw original error (auth)
          }
        }
        throw err;
      }
      // transient
      attempt++;
      if (attempt >= 3) break;
      await sleep(500 * Math.pow(2, attempt - 1)); // 500/1000/2000
    }
  }
  throw lastErr;
}

/** Determines whether error is a 'file not found' (404/not-found) signal. */
export function isIndexNotFound(err: unknown): boolean {
  const e: any = err;
  if (typeof e?.status === 'number' && e.status === 404) return true;
  const message = String(e?.message || '').toLowerCase();
  return /not found|404|enotfound/.test(message);
}

/**
 * Self-healing helper that inspects existing .html files in cloud archives/ directory to recover index entries.
 */
async function recoverEntriesFromFiles(adapter: CloudStorageAdapter): Promise<ArchiveIndexEntry[]> {
  try {
    if (typeof adapter.listFiles !== 'function') return [];
    const files = await adapter.listFiles(ARCHIVES_FOLDER);
    if (!Array.isArray(files) || files.length === 0) return [];

    const entries: ArchiveIndexEntry[] = [];
    const bookmarks = await db.bookmarks.toArray();
    const bookmarkSyncMap = new Map<string, typeof bookmarks[0]>();

    for (const b of bookmarks) {
      if (b.syncId) bookmarkSyncMap.set(b.syncId, b);
    }

    for (const file of files) {
      const rawName = file.name || '';
      const baseName = rawName.split('/').pop() || rawName;
      if (!baseName.endsWith('.html') || baseName.startsWith('.')) continue;

      const syncIdOrStem = baseName.replace(/\.html$/i, '');
      const matchedBookmark = bookmarkSyncMap.get(syncIdOrStem);

      entries.push({
        syncId: syncIdOrStem,
        bookmarkId: matchedBookmark?.bookmarkId || '',
        url: matchedBookmark?.url || '',
        title: matchedBookmark?.title || '',
        fileName: baseName,
        fileSize: file.size || 0,
        format: 'raw',
        archivedAt: file.modifiedAt || Date.now()
      });
    }

    return entries;
  } catch (e) {
    console.warn('[archive-cloud] self-healing file list recovery failed:', e);
    return [];
  }
}

/**
 * Reads cloud index or returns empty index if not found.
 * Only 'File not found' / HTTP 404 (and adapter not-found signals) are treated as empty index.
 * Other transient errors (network/timeout/5xx), auth (401/403), and quota errors are propagated up,
 * skipping writeIndex for this cycle and retrying in the next cycle.
 * -> Prevents data loss (orphaning) caused by mistaking transient read failures of existing cloud indices
 *    for empty indices and overwriting existing entries.
 * Attempts self-healing from archives/ directory file list on corrupted index (parse failure) or 404.
 */
async function readIndexOrEmpty(adapter: CloudStorageAdapter): Promise<ArchiveIndex> {
  try {
    // folder-aware binary I/O (C-3): gdrive readFile is flat (root) storage,
    // causing path divergence from getLastModified (folder-aware) and disabling lost-update validation.
    const blob = await adapter.readBinaryFile(INDEX_PATH);
    const parsed = JSON.parse(await blob.text());
    if (parsed && Array.isArray(parsed.entries)) {
      if (parsed.entries.length === 0) {
        const recovered = await recoverEntriesFromFiles(adapter);
        if (recovered.length > 0) {
          return { version: 1, entries: recovered, updatedAt: parsed.updatedAt || Date.now() };
        }
      }
      return { version: 1, entries: parsed.entries, updatedAt: parsed.updatedAt || 0 };
    }
  } catch (e) {
    if (isIndexNotFound(e)) {
      try {
        const recovered = await recoverEntriesFromFiles(adapter);
        if (recovered.length > 0) {
          return { version: 1, entries: recovered, updatedAt: Date.now() };
        }
      } catch {}
      return emptyArchiveIndex();
    }
    const kind = classifyArchiveError(e);
    if (kind === 'transient' || kind === 'auth' || kind === 'quota') throw e;
    // Permanent errors like corrupted index -> attempt recovery from archives directory file list
    try {
      const recovered = await recoverEntriesFromFiles(adapter);
      if (recovered.length > 0) {
        return { version: 1, entries: recovered, updatedAt: Date.now() };
      }
    } catch {}
  }
  return emptyArchiveIndex();
}

/** index.json atomic update (folder-aware binary write, C-3). */
async function writeIndex(adapter: CloudStorageAdapter, entries: ArchiveIndexEntry[]): Promise<void> {
  await adapter.writeBinaryFile(
    INDEX_PATH,
    new Blob([JSON.stringify({ version: 1, entries, updatedAt: Date.now() })], { type: 'application/json' }),
    'application/json'
  );
}

/** Tie + differing size conflict log item (D-3/AC-3 — archive_conflict_logs, separate key from sync_conflict_logs). */
interface ArchiveConflictLogItem {
  id: string;
  syncId: string;
  url: string;
  title: string;
  localFileSize: number;
  cloudFileSize: number;
  archivedAt: number;
  timestamp: number;
  status: 'pending';
}

/** Logs conflict to settings['archive_conflict_logs']. Does not record duplicate if pending conflict for same syncId already exists. */
async function logArchiveConflict(item: ArchiveConflictLogItem): Promise<void> {
  const logs = (await db.settings.get('archive_conflict_logs'))?.value || [];
  const exists = logs.some((l: any) => l.syncId === item.syncId && l.status === 'pending');
  if (!exists) {
    logs.push(item);
    await db.settings.put({ key: 'archive_conflict_logs', value: logs });
  }
  console.warn(`[archive-cloud] Archive conflict (tie + size mismatch) recorded: ${item.syncId} (local=${item.localFileSize}B cloud=${item.cloudFileSize}B)`);
}

/**
 * Single archive upload + atomic index update (D-1/D-2, C-3, AC-4/5/6).
 * On failure, records error state and does not throw (retried next cycle).
 */
export async function syncArchiveToCloudByBookmarkId(bookmarkId: number): Promise<void> {
  if (!(await isArchiveCloudEnabled())) return; // AC-6
  const adapter = await SyncEngine.getAdapter();
  if (!adapter) return; // provider=none -> silently skip (EC-1)

  const bookmark = await db.bookmarks.get(bookmarkId);
  if (!bookmark) return;
  const archive = await db.archivedPages.where('bookmarkId').equals(bookmarkId).first();
  if (!bookmark.syncId || !archive) return;

  // Size validation (AC-4)
  const sizeClass = await classifyArchiveSize(archive.fileSize);
  if (sizeClass === 'hard-exceed') {
    await markError(bookmark.syncId, i18n.t('archive.sizeHardExceeded', { size: archive.fileSize }));
    await notifyArchiveUploadError(bookmark.syncId, i18n.t('archive.sizeHardExceededNotify'));
    return;
  }
  if (sizeClass === 'soft-exceed') {
    console.warn(`[archive-cloud] Archive (${archive.fileSize} bytes) exceeds soft limit; proceeding with warning.`);
  }

  // single-flight claim (E-5)
  const claimed = await claimArchiveUpload(bookmark.syncId);
  if (!claimed) return; // Another upload already in progress

  const fileName = buildArchiveFileName(bookmark.syncId);
  const format = await detectArchiveFormat(archive.htmlBlob);
  const localEntry: ArchiveIndexEntry = {
    syncId: bookmark.syncId,
    bookmarkId: bookmark.bookmarkId,
    url: archive.url,
    title: bookmark.title,
    fileName,
    fileSize: archive.fileSize,
    format,
    archivedAt: archive.archivedAt
  };

  try {
    // 1) Read cloud index + capture base modified (lost-update prevention, C-3)
    const cloudIndex = await readIndexOrEmpty(adapter);
    let base = -1;
    try { base = await adapter.getLastModified(INDEX_PATH); } catch { base = -1; }

    // 2) Conflict resolution: LWW if cloud entry exists with same syncId
    const cloudEntry = cloudIndex.entries.find((e) => e.syncId === bookmark.syncId);
    if (cloudEntry && cloudEntry.archivedAt > localEntry.archivedAt) {
      // Cloud is newer -> download and apply locally (D-2), skip upload
      const blob = await adapter.readBinaryFile(`${ARCHIVES_FOLDER}/${cloudEntry.fileName}`);
      await db.archivedPages.put({
        ...archive,
        htmlBlob: blob,
        fileSize: blob.size,
        archivedAt: cloudEntry.archivedAt
      });
      await markUploaded(bookmark.syncId);
      return;
    }
    if (cloudEntry && cloudEntry.archivedAt === localEntry.archivedAt && cloudEntry.fileSize !== localEntry.fileSize) {
      // Tie + different size -> cannot determine winner (D-3/AC-3). Do not overwrite either side; record in conflict log and defer upload.
      await logArchiveConflict({
        id: `${bookmark.syncId}-${Date.now()}`,
        syncId: bookmark.syncId,
        url: archive.url,
        title: bookmark.title,
        localFileSize: localEntry.fileSize,
        cloudFileSize: cloudEntry.fileSize,
        archivedAt: cloudEntry.archivedAt,
        timestamp: Date.now(),
        status: 'pending'
      });
      await markError(bookmark.syncId, i18n.t('archive.clockSkewHold'));
      return;
    }

    // 3) Upload file first (file before index — minimizes partial upload/atomicity risk)
    await retry(
      async () => {
        await adapter.ensureFolder(ARCHIVES_FOLDER);
        await adapter.writeBinaryFile(`${ARCHIVES_FOLDER}/${fileName}`, archive.htmlBlob, 'text/html');
      },
      classifyArchiveError,
      adapter
    );

    // 4) Merge index and revalidate immediately before write (C-3, U-3)
    const merged = mergeArchiveIndex([localEntry], cloudIndex.entries);
    let mergedFinal = merged;
    let retries = 0;
    while (retries <= 2) {
      let current = -1;
      try { current = await adapter.getLastModified(INDEX_PATH); } catch { current = -1; }
      if (base >= 0 && current >= 0 && isConcurrentWrite(base, current)) {
        // Concurrent write detected -> re-read latest index to merge + update revalidation baseline (base) (U-3)
        const latest = await readIndexOrEmpty(adapter);
        mergedFinal = mergeArchiveIndex([localEntry], latest.entries);
        base = current; // Without updating base, repeated re-merging compares stale base vs same current -> exhausts retries
        retries++;
        if (retries > 2) {
          // Exceeded 3 retries -> leave in error state and retry next cycle
          await markError(bookmark.syncId, i18n.t('archive.indexWriteDeferred'));
          await notifyArchiveUploadError(bookmark.syncId, i18n.t('archive.indexConflictNotify'));
          return;
        }
        continue;
      }
      break;
    }

    await writeIndex(adapter, mergedFinal);
    await markUploaded(bookmark.syncId);
  } catch (e: any) {
    // Final failure -> error state + notification (local archive is never deleted)
    await markError(bookmark.syncId, String(e?.message || e));
    await notifyArchiveUploadError(bookmark.syncId, i18n.t('archive.uploadFailedWithDetail', { error: e?.message || e }));
  }
}

/**
 * catch-up: Sequentially uploads unuploaded local archives (status !== uploaded) (F-4, EC-4 recovery).
 * Deletion propagation (G-2): For syncIds in index.json without a local bookmark, deletes file + marks
 *   deleted tombstone only when deletion tombstone (deletion intent) exists.
 *   No tombstone = no deletion intent (e.g. 0 bookmarks in local DB right after full reset) -> preserve files/entries.
 */
export async function syncPendingArchives(): Promise<void> {
  if (!(await isArchiveCloudEnabled())) return;
  const adapter = await SyncEngine.getAdapter();
  if (!adapter) return;

  const stateMap = await getUploadStateMap();

  // 1) Sequentially upload unuploaded local archives
  const archived = await db.archivedPages.toArray();
  for (const a of archived) {
    const bookmark = await db.bookmarks.get(a.bookmarkId);
    if (!bookmark?.syncId) continue;
    const st = stateMap[bookmark.syncId];
    if (st?.status === 'uploaded') continue;
    await syncArchiveToCloudByBookmarkId(a.bookmarkId);
  }

  // 2) Deletion propagation — even if syncId is in cloud index but absent from local bookmarks,
  //    only delete file + mark deleted tombstone if deletion tombstone (deletion intent) exists.
  //    FIX(archive-reset-wipe): Preserves cloud files and entries if local DB is simply empty (like after full reset) without tombstones.
  try {
    const cloudIndex = await readIndexOrEmpty(adapter);
    const localSyncIds = new Set((await db.bookmarks.toArray()).map((b) => b.syncId));
    const deletedSyncIds = new Set((await getTombstones()).map((t) => t.syncId));
    const archiveTombstones = await getArchiveTombstones();
    let changed = false;
    // INVARIANT: Cloud archive file deletion only passes syncIds with confirmed 'deletion intent (tombstone/local deletion)'.
    //   Indiscriminate orphan deletion is forbidden — regression case where catch-up wiped all archives right after reset.
    //   (regression: archive-reset-wipe-regression S1/S2, archive-cloud.test.ts:341)
    for (const entry of cloudIndex.entries) {
      const isBookmarkDeleted = !localSyncIds.has(entry.syncId) && deletedSyncIds.has(entry.syncId);
      const isArchiveDeleted = isArchiveTombstoned(entry, archiveTombstones, normalizeUrl);
      if (!entry.deleted && (isBookmarkDeleted || isArchiveDeleted)) {
        try {
          await retry(() => adapter.deleteFile(`${ARCHIVES_FOLDER}/${entry.fileName}`), classifyArchiveError, adapter);
        } catch (delErr) {
          if (!isIndexNotFound(delErr)) {
            console.warn(`[archive-cloud] Failed to delete cloud archive file (${entry.fileName}):`, delErr);
          }
        }
        entry.deleted = true;
        entry.deletedAt = Date.now();
        changed = true;
      }
    }
    if (changed) {
      await writeIndex(adapter, cloudIndex.entries);
    }
  } catch (e) {
    console.warn('[archive-cloud] Failed to propagate deletion:', e);
  }
}

export interface RestoreResult {
  restored: number;
  orphans: ArchiveIndexEntry[];
}

/**
 * Cloud archive restoration (G-1).
 * - Excludes deleted (soft-delete).
 * - Collects orphans if local bookmark does not exist (EC-3 orphan preservation).
 * - Downloads and applies if local archive does not exist or is older.
 */
export async function restoreArchivesFromCloud(): Promise<RestoreResult> {
  const adapter = await SyncEngine.getAdapter();
  if (!adapter) return { restored: 0, orphans: [] };

  const cloudIndex = await readIndexOrEmpty(adapter);
  const result: RestoreResult = { restored: 0, orphans: [] };

  for (const entry of cloudIndex.entries) {
    if (entry.deleted) continue;
    let localBookmark = await db.bookmarks.where('syncId').equals(entry.syncId).first();
    if (!localBookmark && entry.url) {
      localBookmark = await db.bookmarks.where('url').equals(entry.url).first();
      if (!localBookmark) {
        const norm = normalizeUrl(entry.url);
        const allBookmarks = await db.bookmarks.toArray();
        localBookmark = allBookmarks.find((b) => b.url && normalizeUrl(b.url) === norm);
      }
    }
    if (!localBookmark || localBookmark.id === undefined) {
      result.orphans.push(entry); // EC-3 orphan preservation
      continue;
    }
    const localArchive = await db.archivedPages.where('bookmarkId').equals(localBookmark.id).first();
    if (!localArchive || localArchive.archivedAt < entry.archivedAt) {
      const blob = await adapter.readBinaryFile(`${ARCHIVES_FOLDER}/${entry.fileName}`);
      await db.archivedPages.put({
        // BUG-1: Preserve local row id -> prevent duplicate row insertion (upsert). Auto-generated if absent.
        ...(localArchive ? { id: localArchive.id } : {}),
        bookmarkId: localBookmark.id,
        url: entry.url,
        htmlBlob: blob,
        fileSize: blob.size,
        archivedAt: entry.archivedAt
      });
      result.restored++;
    }
  }
  return result;
}

/**
 * Archive deletion propagation (G-2): Deletes file + marks deleted tombstone in index (30-day retention).
 * Local archive is not deleted.
 *
 * INVARIANT: Assumes caller has verified deletion intent (tombstone/explicit deletion).
 *   When adding new call paths, verify deletion intent guarantee and link regression tests.
 *   (regression: archive-reset-wipe-regression S2 — presence of tombstone is the sole gate for deletion propagation)
 */
export async function deleteArchiveFromCloud(syncId: string, url?: string): Promise<void> {
  const deletedAt = Date.now();
  if (syncId || url) {
    await recordArchiveTombstone(syncId, url, deletedAt);
  }

  // Proactively clean local cache regardless of cloud settings/adapter presence
  try {
    const cached = await db.settings.get('cloud_archive_index');
    const cachedEntries = Array.isArray(cached?.value) ? (cached!.value as ArchiveIndexEntry[]) : [];
    if (cachedEntries.length > 0) {
      const normUrl = url ? normalizeUrl(url) : '';
      const updated = cachedEntries.filter((e) => {
        if (syncId && e.syncId === syncId) return false;
        if (normUrl && e.url && normalizeUrl(e.url) === normUrl) return false;
        if (url && e.url && e.url === url) return false;
        return true;
      });
      if (updated.length !== cachedEntries.length) {
        await db.settings.put({ key: 'cloud_archive_index', value: updated });
      }
    }
  } catch {}

  if (!(await isArchiveCloudEnabled())) return;
  const adapter = await SyncEngine.getAdapter();
  if (!adapter) return;

  try {
    const cloudIndex = await readIndexOrEmpty(adapter);
    const normUrl = url ? normalizeUrl(url) : '';
    const matchingEntries = cloudIndex.entries.filter((e) => {
      if (syncId && e.syncId === syncId) return true;
      if (normUrl && e.url && normalizeUrl(e.url) === normUrl) return true;
      if (url && e.url && e.url === url) return true;
      return false;
    });

    if (matchingEntries.length > 0) {
      for (const entry of matchingEntries) {
        const fileName = entry.fileName || buildArchiveFileName(entry.syncId);
        try {
          await retry(() => adapter.deleteFile(`${ARCHIVES_FOLDER}/${fileName}`), classifyArchiveError, adapter);
        } catch (fileErr) {
          if (!isIndexNotFound(fileErr)) {
            console.warn(`[archive-cloud] Failed to delete archive file ${fileName}:`, fileErr);
          }
        }
        entry.deleted = true;
        entry.deletedAt = deletedAt;
      }
      await writeIndex(adapter, cloudIndex.entries);
    } else if (syncId) {
      const fileName = buildArchiveFileName(syncId);
      try {
        await retry(() => adapter.deleteFile(`${ARCHIVES_FOLDER}/${fileName}`), classifyArchiveError, adapter);
      } catch (fileErr) {
        if (!isIndexNotFound(fileErr)) {
          console.warn(`[archive-cloud] Failed to delete archive file ${fileName}:`, fileErr);
        }
      }
    }

    // 3. Update local cache (keep valid entries only)
    const tombstones = await getArchiveTombstones();
    const validEntries = cloudIndex.entries.filter((e) => !e.deleted && !isArchiveTombstoned(e, tombstones, normalizeUrl));
    await db.settings.put({ key: 'cloud_archive_index', value: validEntries });
  } catch (e) {
    console.warn('[archive-cloud] Failed to propagate deletion:', e);
    throw e;
  }
}

/**
 * Fetches cloud archive metadata index and updates the local settings cache.
 * Excludes deleted entries, storing valid entries only.
 */
export async function refreshCloudArchiveIndex(): Promise<ArchiveIndexEntry[]> {
  if (!(await isArchiveCloudEnabled())) return [];
  const adapter = await SyncEngine.getAdapter();
  if (!adapter) return [];

  const index = await readIndexOrEmpty(adapter);
  const tombstones = await getArchiveTombstones();
  let validEntries = index.entries.filter((e) => !e.deleted && !isArchiveTombstoned(e, tombstones, normalizeUrl));
  if (validEntries.length === 0) {
    const recovered = await recoverEntriesFromFiles(adapter);
    if (recovered.length > 0) {
      validEntries = recovered.filter((e) => !isArchiveTombstoned(e, tombstones, normalizeUrl));
    }
  }
  await db.settings.put({ key: 'cloud_archive_index', value: validEntries });
  return validEntries;
}

/**
 * Retrieves the cloud archive index stored in local settings cache.
 */
export async function getCloudArchiveIndexCache(): Promise<ArchiveIndexEntry[]> {
  const all = (await db.settings.get('cloud_archive_index'))?.value || [];
  if (!Array.isArray(all) || all.length === 0) return [];
  const tombstones = await getArchiveTombstones();
  return all.filter((e) => !e.deleted && !isArchiveTombstoned(e, tombstones, normalizeUrl));
}

/**
 * Downloads a single archive on-demand for a specific bookmark, saves locally, and returns it.
 * If an intact archive already exists locally, returns local data without re-downloading.
 */
export async function downloadArchiveOnDemand(syncIdOrUrl: string): Promise<ArchivedPage | null> {
  let bookmark = await db.bookmarks.where('syncId').equals(syncIdOrUrl).first();
  if (!bookmark) {
    bookmark = await db.bookmarks.where('url').equals(syncIdOrUrl).first();
    if (!bookmark) {
      const norm = normalizeUrl(syncIdOrUrl);
      const allBookmarks = await db.bookmarks.toArray();
      bookmark = allBookmarks.find((b) => b.url && normalizeUrl(b.url) === norm);
    }
  }
  if (!bookmark || bookmark.id === undefined) {
    return null;
  }

  const localArchive = await db.archivedPages.where('bookmarkId').equals(bookmark.id).first();
  if (localArchive && localArchive.htmlBlob && localArchive.htmlBlob.size > 0) {
    return localArchive;
  }

  const adapter = await SyncEngine.getAdapter();
  if (!adapter) {
    throw new Error('No cloud storage adapter');
  }

  const index = await readIndexOrEmpty(adapter);
  const targetSyncId = bookmark.syncId || syncIdOrUrl;
  const normTargetUrl = bookmark.url ? normalizeUrl(bookmark.url) : normalizeUrl(syncIdOrUrl);

  let entry = index.entries.find((e) => !e.deleted && (e.syncId === targetSyncId || (bookmark.syncId && e.syncId === bookmark.syncId)));
  if (!entry) {
    entry = index.entries.find((e) => !e.deleted && e.url && (e.url === (bookmark.url || syncIdOrUrl) || (normTargetUrl && normalizeUrl(e.url) === normTargetUrl)));
  }

  if (!bookmark.syncId && entry?.syncId) {
    try {
      await db.bookmarks.update(bookmark.id, { syncId: entry.syncId });
      bookmark.syncId = entry.syncId;
    } catch {}
  }

  const resolvedSyncId = bookmark.syncId || entry?.syncId || syncIdOrUrl;
  const fileName = entry?.fileName || buildArchiveFileName(resolvedSyncId);
  let blob: Blob;
  try {
    blob = await adapter.readBinaryFile(`${ARCHIVES_FOLDER}/${fileName}`);
  } catch (err) {
    try {
      const currentCache = await getCloudArchiveIndexCache();
      const updatedCache = currentCache.filter((e) => e.syncId !== resolvedSyncId && (!entry?.url || e.url !== entry.url));
      if (updatedCache.length !== currentCache.length) {
        await db.settings.put({ key: 'cloud_archive_index', value: updatedCache });
      }
    } catch {}
    throw err;
  }

  const page: ArchivedPage = {
    ...(localArchive ? { id: localArchive.id } : {}),
    bookmarkId: bookmark.id,
    url: entry?.url || bookmark.url,
    htmlBlob: blob,
    fileSize: blob.size,
    archivedAt: entry?.archivedAt || Date.now()
  };

  await db.archivedPages.put(page);
  return page;
}

export interface ScanOrphanArchivesOptions {
  /** If true, allows scanning even if in sync error state */
  force?: boolean;
}

export interface DeleteOrphanArchivesResult {
  successCount: number;
  failedCount: number;
  errors: Array<{ syncId: string; error: string }>;
}

/**
 * Scans cloud storage index.json for orphan archive entries whose bookmarks
 * no longer exist in the local database (matched by syncId and normalized URL).
 *
 * Strictly read-only: does NOT delete or modify any cloud files or local records.
 */
export async function scanOrphanCloudArchives(
  options?: ScanOrphanArchivesOptions
): Promise<ArchiveIndexEntry[]> {
  if (!(await isArchiveCloudEnabled())) return [];
  const adapter = await SyncEngine.getAdapter();
  if (!adapter) return [];

  // Pre-flight safety check to prevent false-positive orphan detection
  if (typeof db !== 'undefined' && db.syncState) {
    const syncRecord = await db.syncState.orderBy('id').last();
    if (syncRecord?.status === 'syncing') {
      throw new Error('SYNC_IN_PROGRESS');
    }
    if (syncRecord?.status === 'error' && !options?.force) {
      throw new Error('SYNC_ERROR_STATE');
    }
    if (!options?.force && (!syncRecord?.lastSyncAt || syncRecord.lastSyncAt <= 0)) {
      throw new Error('SYNC_NOT_SYNCED');
    }
  }

  const cloudIndex = await readIndexOrEmpty(adapter);
  const activeEntries = cloudIndex.entries.filter((e) => !e.deleted);
  if (activeEntries.length === 0) return [];

  // Read local bookmarks and index them for fast lookup
  const localBookmarks = await db.bookmarks.toArray();
  const localSyncIds = new Set<string>();
  const localNormUrls = new Set<string>();

  for (const b of localBookmarks) {
    if (b.syncId) localSyncIds.add(b.syncId);
    if (b.url) {
      try {
        localNormUrls.add(normalizeUrl(b.url));
      } catch {
        localNormUrls.add(b.url);
      }
    }
  }

  // Filter out any entries that match existing bookmarks
  return activeEntries.filter((entry) => {
    if (localSyncIds.has(entry.syncId)) return false;
    if (entry.url) {
      try {
        if (localNormUrls.has(normalizeUrl(entry.url))) return false;
      } catch {
        if (localNormUrls.has(entry.url)) return false;
      }
    }
    return true;
  });
}

/**
 * Downloads and decompresses an orphan archive's HTML from cloud storage for inspection.
 * Does not insert rows into db.archivedPages (orphans have no local bookmarkId).
 */
export async function fetchOrphanArchiveHtml(syncId: string): Promise<string> {
  const adapter = await SyncEngine.getAdapter();
  if (!adapter) {
    throw new Error('No cloud storage adapter');
  }

  const cloudIndex = await readIndexOrEmpty(adapter);
  const entry = cloudIndex.entries.find((e) => e.syncId === syncId);
  const fileName = entry?.fileName || buildArchiveFileName(syncId);

  const blob = await adapter.readBinaryFile(`${ARCHIVES_FOLDER}/${fileName}`);
  const decompressed = await decompressArchiveHtml(blob);
  return await decompressed.text();
}

/**
 * Deletes selected orphan archive files from cloud storage and marks soft-delete in index.json.
 *
 * Execution flow:
 * 1. Capture base modified timestamp of index.json for optimistic concurrency control.
 * 2. Delete physical archive files via adapter.deleteFile() (idempotent on 404).
 * 3. Atomically update index.json with deleted = true and deletedAt = Date.now().
 *    Re-reads and re-applies if concurrent write is detected.
 * 4. Update local cloud_archive_index settings cache.
 */
export async function deleteOrphanCloudArchives(
  syncIds: string[],
  onProgress?: (completed: number, total: number) => void
): Promise<DeleteOrphanArchivesResult> {
  if (syncIds.length === 0) {
    return { successCount: 0, failedCount: 0, errors: [] };
  }

  const adapter = await SyncEngine.getAdapter();
  if (!adapter) {
    throw new Error('No cloud storage adapter');
  }

  if (typeof db !== 'undefined' && db.syncState) {
    const syncRecord = await db.syncState.orderBy('id').last();
    if (syncRecord?.status === 'syncing') {
      throw new Error('SYNC_IN_PROGRESS');
    }
  }

  // 1) Read cloud index and capture base modified timestamp for concurrency guard
  let base = -1;
  try {
    base = await adapter.getLastModified(INDEX_PATH);
  } catch {
    base = -1;
  }
  const cloudIndex = await readIndexOrEmpty(adapter);

  const result: DeleteOrphanArchivesResult = {
    successCount: 0,
    failedCount: 0,
    errors: []
  };

  const deletedSyncIds = new Set<string>();
  let completed = 0;
  const total = syncIds.length;

  // 2) Delete files from cloud storage (idempotent on 404)
  for (const syncId of syncIds) {
    const entry = cloudIndex.entries.find((e) => e.syncId === syncId);
    const fileName = entry?.fileName || buildArchiveFileName(syncId);

    try {
      await retry(
        () => adapter.deleteFile(`${ARCHIVES_FOLDER}/${fileName}`),
        classifyArchiveError,
        adapter
      );
      deletedSyncIds.add(syncId);
      result.successCount++;
    } catch (err: any) {
      if (isIndexNotFound(err)) {
        // Already missing on cloud -> treat as deleted
        deletedSyncIds.add(syncId);
        result.successCount++;
      } else {
        result.failedCount++;
        result.errors.push({ syncId, error: String(err?.message || err) });
      }
    }
    completed++;
    onProgress?.(completed, total);
  }

  // 3) Atomic index.json update for successfully deleted entries
  if (deletedSyncIds.size > 0) {
    const now = Date.now();
    const applyTombstones = (entries: ArchiveIndexEntry[]) => {
      for (const entry of entries) {
        if (deletedSyncIds.has(entry.syncId)) {
          entry.deleted = true;
          entry.deletedAt = now;
        }
      }
    };

    applyTombstones(cloudIndex.entries);

    // Concurrency check and retry
    let retries = 0;
    while (retries <= 2) {
      let current = -1;
      try {
        current = await adapter.getLastModified(INDEX_PATH);
      } catch {
        current = -1;
      }
      if (base >= 0 && current >= 0 && isConcurrentWrite(base, current)) {
        const latest = await readIndexOrEmpty(adapter);
        applyTombstones(latest.entries);
        cloudIndex.entries = latest.entries;
        base = current;
        retries++;
        continue;
      }
      break;
    }

    await writeIndex(adapter, cloudIndex.entries);

    // 4) Synchronize local settings cache
    try {
      const validEntries = cloudIndex.entries.filter((e) => !e.deleted);
      await db.settings.put({ key: 'cloud_archive_index', value: validEntries });
    } catch (cacheErr) {
      console.warn('[archive-cloud] Failed to update local cloud_archive_index cache:', cacheErr);
    }
  }

  return result;
}


