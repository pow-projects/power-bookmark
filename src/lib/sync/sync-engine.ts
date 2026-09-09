import db, { type Bookmark } from '../db';
import {
  resolveBookmarkWinner,
  sameTags,
  dedupeByUrl,
  isConcurrentWrite,
  findUrlIdConflicts,
  isEmptyBookmark,
  isFillGapPair,
  generateDeterministicSyncId,
  contentDiffers
} from './merge';
import { normalizeUrl } from '../bookmarks/url-normalizer';
import { isSameFolderLocation } from '../bookmarks/folder-utils';
import { GoogleDriveAdapter } from './adapters/google-drive';
import { OneDriveAdapter } from './adapters/onedrive';
import { DropboxAdapter } from './adapters/dropbox';
import { WebDavAdapter } from './adapters/webdav';
import { CloudStorageAdapter } from './adapters/base';
import { BookmarkManager } from '../bookmarks/bookmark-manager';
import { setSyncingIndicator } from '../bookmarks/badge-manager';
import {
  applyTombstonesToMerge,
  clearTombstones,
  getTombstones,
  mergeTombstones,
  persistTombstones,
  revokeTombstonesForLiveReRegistrations,
  type Tombstone
} from './tombstones';
import { syncPendingArchives, refreshCloudArchiveIndex } from '../archive/archive-cloud';

const SYNC_FILE_NAME = 'powerbookmark_sync.json';

// Legacy cloud backwards compatibility normalization:
// - Migrate past sync file aiTags → tags
// - Map aiSummary → description if description is empty and aiSummary exists
// - Generate URL-based deterministic UUID if syncId missing (guarantees identical syncId across all devices)
// - Defensively normalize createdAt/modifiedAt
export const normalizeCloudBookmark = (o: any) => {
  const createdAt = o.createdAt || o.dateAdded || o.modifiedAt || Date.now();
  const modifiedAt = o.modifiedAt || o.createdAt || o.dateAdded || Date.now();
  return {
    ...o,
    description: o.description || o.aiSummary || '',
    tags: o.tags ?? o.aiTags,
    syncId: o.syncId || (o.url ? generateDeterministicSyncId(o.url) : crypto.randomUUID()),
    createdAt,
    modifiedAt: Math.max(modifiedAt, createdAt)
  };
};

export const DEFAULT_SYNC_INTERVAL_MINUTES = 5;
export const SYNC_INTERVAL_KEY = 'sync_interval_minutes';

export class SyncEngine {
  static readonly DEFAULT_SYNC_INTERVAL_MINUTES = DEFAULT_SYNC_INTERVAL_MINUTES;
  static readonly SYNC_INTERVAL_KEY = SYNC_INTERVAL_KEY;
  private static adapter: CloudStorageAdapter | null = null;
  private static debounceTimer: any = null;
  // M-2: Concurrent execution guard — when sync() is called simultaneously from multiple paths
  // (30s debounce / 5min background alarm / modal applyAndSync / onInstalled),
  // a lost-update race condition occurs where both read the same cloud file and overwrite each other.
  private static syncInProgress = false;

  /**
   * Initializes and returns the appropriate adapter according to configured provider.
   */
  static async getAdapter(): Promise<CloudStorageAdapter | null> {
    const provider = (await db.settings.get('sync_provider'))?.value || 'none';
    if (provider === 'none') { this.adapter = null; return null; }

    if (this.adapter) return this.adapter;
    
    if (provider === 'google-drive') {
      this.adapter = new GoogleDriveAdapter();
    } else if (provider === 'onedrive') {
      this.adapter = new OneDriveAdapter();
    } else if (provider === 'dropbox') {
      this.adapter = new DropboxAdapter();
    } else if (provider === 'webdav') {
      this.adapter = new WebDavAdapter();
    } else {
      this.adapter = null;
    }

    return this.adapter;
  }

  /**
   * Force resets the sync adapter (upon settings change, etc.).
   */
  static resetAdapter(): void {
    this.adapter = null;
  }

  /**
   * Two-way synchronizes cloud storage and local DB data (Last-Write-Wins).
   */
  static async sync(): Promise<void> {
    // M-2: Concurrent execution guard — early return (skip) if already executing. Retried by next debounce/alarm cycle.
    // Note: Guard must run before recording 'syncing' status (if status write precedes guard,
    // a second run could overwrite status before hitting the guard, rendering it useless).
    if (this.syncInProgress) {
      console.log('Sync already in progress, skipping.');
      return;
    }
    this.syncInProgress = true;

    try {
      if ((await db.settings.get('sync_provider'))?.value === 'none') { console.log('Sync disabled (provider=none), skipping.'); return; }

      const adapter = await this.getAdapter();
      if (!adapter) {
        console.log('No sync provider configured.');
        return;
      }

      // Initial sync check must be performed before putting 'syncing'.
      // Determined as initial sync if no prior successfully completed ('idle') sync records exist for current provider.
      const currentProvider = (await db.settings.get('sync_provider'))?.value || 'none';
      const initialSyncDone = (await db.settings.get(`initial_sync_completed_${currentProvider}`))?.value === true;
      const syncStates = await db.syncState.toArray();
      const priorSuccessfulSyncs = syncStates.filter(
        (s: any) => s.provider === currentProvider && s.status === 'idle'
      ).length;
      const isFirstSync = !initialSyncDone && priorSuccessfulSyncs === 0;

      // Update sync state to 'syncing'
      await db.syncState.put({ id: 1, provider: currentProvider, lastSyncAt: Date.now(), status: 'syncing' });
      // Display syncing indicator on extension button
      await setSyncingIndicator(true);

      try {
      // 1. First merge browser bookmark tree and internal DB up to date
      await BookmarkManager.syncAll();

      // 2. Fetch existing data from cloud
      let cloudBookmarks: Bookmark[] = [];
      let cloudTombstones: Tombstone[] = [];
      let isCloudFileExist = true;

      try {
        const cloudDataStr = await adapter.readFile(SYNC_FILE_NAME);
        const parsed = JSON.parse(cloudDataStr);
        cloudBookmarks = (parsed.bookmarks || []).map(normalizeCloudBookmark);
        cloudTombstones = parsed.tombstones || [];
      } catch (e) {
        // Treat cloud file as non-existent if file is missing or parse error occurs
        isCloudFileExist = false;
        console.log('No cloud sync file found, creating new one.');
      }

      // Gap B: Optimistic revalidation to prevent cross-device concurrent write (lost-update).
      // Capture server modifiedTime as base point immediately after cloud read.
      // (Fallback to -1 on getLastModified failure — skip check and proceed with write (fail-open),
      //  symmetric with revalidation failure to prevent false base=0 blocking)
      let cloudBaseModified = -1; // -1 = capture failed (skip check, proceed with write — fail-open, symmetric with revalidation)
      try {
        cloudBaseModified = await adapter.getLastModified(SYNC_FILE_NAME);
      } catch (e) {
        console.warn('Failed to capture cloud base modified time, skipping check.', e);
      }

      // 3. Fetch local data
      const localBookmarks = await db.bookmarks.toArray();

      // Mute browser bookmark change event listener interference during sync
      BookmarkManager.setSyncMuted(true);

      // 3.5. Pre-merge Identity Reconciliation (In-Place syncId Adoption)
      // Greedily adopt cloud syncId 1:1 in-place when local and cloud bookmarks share identical normalized URL.
      // Preserves local DB id, browser bookmarkId, and connected archivedPages without destruction.
      const cloudByNormUrl = new Map<string, Bookmark[]>();
      const cloudSyncIds = new Set<string>();
      for (const cb of cloudBookmarks) {
        cloudSyncIds.add(cb.syncId);
        const norm = normalizeUrl(cb.url);
        const list = cloudByNormUrl.get(norm) || [];
        list.push(cb);
        cloudByNormUrl.set(norm, list);
      }

      const localSyncIdSet = new Set(localBookmarks.map(b => b.syncId));
      const adoptedSyncIds = new Set<string>();

      for (const lb of localBookmarks) {
        if (cloudSyncIds.has(lb.syncId)) continue; // Already matched by syncId

        const norm = normalizeUrl(lb.url);
        const candidates = cloudByNormUrl.get(norm) || [];
        const availableCandidates = candidates.filter(
          cb => !localSyncIdSet.has(cb.syncId) && !adoptedSyncIds.has(cb.syncId)
        );

        if (availableCandidates.length > 0) {
          const matchingCloud =
            availableCandidates.find(cb => isSameFolderLocation(lb.folderPath, cb.folderPath) && lb.title === cb.title) ||
            availableCandidates.find(cb => isSameFolderLocation(lb.folderPath, cb.folderPath)) ||
            availableCandidates.find(cb => lb.title === cb.title) ||
            availableCandidates[0];

          const earliestCreatedAt = Math.min(lb.createdAt || Date.now(), matchingCloud.createdAt || Date.now());
          const isContentSame = !contentDiffers(lb, matchingCloud);
          const updateFields: Partial<Bookmark> = {
            syncId: matchingCloud.syncId,
            createdAt: earliestCreatedAt
          };
          if (isContentSame) {
            updateFields.modifiedAt = matchingCloud.modifiedAt;
            lb.modifiedAt = matchingCloud.modifiedAt;
          }
          if (lb.id !== undefined) {
            await db.bookmarks.update(lb.id, updateFields);
          }
          localSyncIdSet.delete(lb.syncId);
          lb.syncId = matchingCloud.syncId;
          lb.createdAt = earliestCreatedAt;
          localSyncIdSet.add(matchingCloud.syncId);
          adoptedSyncIds.add(matchingCloud.syncId);
        }
      }

      // 4. Proceed with Last-Write-Wins (LWW) merge
      const mergedMap = new Map<string, Bookmark>();
      const conflictLogs: any[] = [];
      const loggedSyncIds = new Set<string>();

      // Assign cloud bookmarks to map first
      for (const cb of cloudBookmarks) {
        mergedMap.set(cb.syncId, cb);
      }

      // URL-based conflict detection (same URL, different syncId) — precalculated via pure function.
      // Surface as conflict when local item (lb) does not match cloud by syncId but a separate cloud item exists with same URL.
      // Register in urlConflictIds so this pair is not silently removed by 4.6 dedupeByUrl.
      // (Detected regardless of firstSync — duplicate risk exists for same URL / different ID regardless of sync status)
      const urlConflictById = new Map<string, Bookmark>();
      const urlConflictIds = new Set<string>();
      // Do not surface fill-gap URL conflict pairs (same URL and title, only one side has empty content/folder categorization) as conflicts.
      // Remove empty side and retain filled side only (local empty is not put into mergedMap, cloud empty is deleted from mergedMap).
      const fillGapLocalSkip = new Set<string>();
      for (const pair of findUrlIdConflicts(localBookmarks, cloudBookmarks)) {
        if (isFillGapPair(pair.local, pair.cloud)) {
          if (isEmptyBookmark(pair.local)) {
            fillGapLocalSkip.add(pair.local.syncId);
          } else {
            mergedMap.delete(pair.cloud.syncId);
          }
          continue;
        }
        urlConflictById.set(pair.local.syncId, pair.cloud);
        urlConflictIds.add(pair.local.syncId);
        urlConflictIds.add(pair.cloud.syncId);
      }

      // LWW merge compared with local bookmarks
      for (const lb of localBookmarks) {
        const cb = mergedMap.get(lb.syncId);
        if (!cb) {
          // Remove empty local in fill-gap case without raising conflict (keep filled cloud only).
          if (fillGapLocalSkip.has(lb.syncId)) {
            const gapLocal = await db.bookmarks.where('syncId').equals(lb.syncId).first();
            if (gapLocal) {
              await db.bookmarks.delete(gapLocal.id!);
              // INVARIANT: fillGapLocalSkip deletion only applies to empty local bookmarks predicated on
              //   'filled cloud record with same syncId survives and preserves archive identity'. Do not delete gaps indiscriminately.
              //   (regression: merge.test.ts fill-gap case)
              await db.archivedPages.where('bookmarkId').equals(gapLocal.id!).delete();
            }
            if (typeof browser !== 'undefined') {
              try { await browser.bookmarks.remove(lb.bookmarkId); } catch { /* already removed */ }
            }
            continue;
          }
          // Exists locally only (by syncId). Record as URL-based conflict if a cloud item exists with same URL
          // (separate case from legacy firstSync URL-content conflict).
          const urlMatch = urlConflictById.get(lb.syncId);
          if (urlMatch && !loggedSyncIds.has(lb.syncId)) {
            loggedSyncIds.add(lb.syncId);
            conflictLogs.push({
              id: crypto.randomUUID(),
              status: 'pending',
              autoResolvedTo: lb.modifiedAt > urlMatch.modifiedAt ? 'local' : 'cloud',
              bookmarkId: lb.syncId,
              localVersion: { title: lb.title, url: lb.url, description: lb.description, folderPath: lb.folderPath, tags: lb.tags, modifiedAt: lb.modifiedAt, syncId: lb.syncId, bookmarkId: lb.bookmarkId },
              cloudVersion: { title: urlMatch.title, url: urlMatch.url, description: urlMatch.description, folderPath: urlMatch.folderPath, tags: urlMatch.tags, modifiedAt: urlMatch.modifiedAt, syncId: urlMatch.syncId, bookmarkId: urlMatch.bookmarkId },
              timestamp: Date.now()
            });
          }
          mergedMap.set(lb.syncId, lb);
          continue;
        }

        const earliestCreatedAt = Math.min(lb.createdAt || Date.now(), cb.createdAt || Date.now());
        const isContentSame = !contentDiffers(lb, cb);
        let finalWinner: Bookmark;
        let isConflict = false;

        if (isContentSame) {
          // If content is completely identical, ignore local browser dateAdded distortion and preserve cloud modifiedAt and earliest createdAt
          finalWinner = {
            ...cb,
            createdAt: earliestCreatedAt
          };
        } else {
          const result = resolveBookmarkWinner(lb, cb, { firstSync: isFirstSync });
          finalWinner = {
            ...result.winner,
            createdAt: earliestCreatedAt
          };
          isConflict = result.isConflict;
        }

        mergedMap.set(lb.syncId, finalWinner);
        if (isConflict && !loggedSyncIds.has(lb.syncId)) {
          loggedSyncIds.add(lb.syncId);
          conflictLogs.push({
            id: crypto.randomUUID(),
            status: 'pending',
            autoResolvedTo: finalWinner.modifiedAt === lb.modifiedAt ? 'local' : 'cloud',
            bookmarkId: lb.syncId,
            localVersion: { title: lb.title, url: lb.url, description: lb.description, folderPath: lb.folderPath, tags: lb.tags, modifiedAt: lb.modifiedAt, syncId: lb.syncId, bookmarkId: lb.bookmarkId },
            cloudVersion: { title: cb.title, url: cb.url, description: cb.description, folderPath: cb.folderPath, tags: cb.tags, modifiedAt: cb.modifiedAt, syncId: cb.syncId, bookmarkId: cb.bookmarkId },
            timestamp: Date.now()
          });
        }
      }

      // 4.5. Apply tombstones (deletion records) — remove in LWW merge if deletion is newer than modification
      let localTombstones = await getTombstones();
      if (isFirstSync && localTombstones.length > 0) {
        // INVARIANT (regression: reconnect-resurrection): the retroactive tombstone purge must apply
        //   ONLY to a genuinely fresh install. setSyncProvider('none') writes a `{provider:'none',
        //   status:'idle'}` disconnect marker (sync-status-store.ts) but wipes syncState history, so a
        //   reconnect after unlink is misjudged as first sync — and deletions recorded WHILE DISCONNECTED
        //   (recordTombstone fires unconditionally, provider-independent) were purged here, letting the
        //   stale cloud copy resurrect into DB + browser tree on reconnect.
        //   If a disconnect marker exists, tombstones recorded AFTER the unlink are confirmed local
        //   deletion intent (disconnect itself already cleared everything older), so they are KEPT and
        //   propagated; only pre-marker residuals are purged. No marker at all = true first install →
        //   full purge (preserves the archive-reset-wipe §8 guard / "첫 동기화 시 클라우드 복구" policy).
        const disconnectMarkers = syncStates.filter(
          (s: any) => s.provider === 'none' && s.status === 'idle'
        );
        if (disconnectMarkers.length === 0) {
          localTombstones = [];
          await clearTombstones();
        } else {
          // Newest unlink wins (markers accumulate across repeated disconnects).
          const cutoff = Math.max(...disconnectMarkers.map((s: any) => s.lastSyncAt || 0));
          const survivors = localTombstones.filter((t) => t.deletedAt > cutoff);
          if (survivors.length !== localTombstones.length) {
            localTombstones = survivors;
            await persistTombstones(survivors);
          }
        }
      }
      const allTombstones = mergeTombstones(localTombstones, cloudTombstones);
      // INVARIANT: revoke deletion intent BEFORE LWW application, measured against the LOCAL DB rows —
      //   this device's local modifiedAt is the authoritative re-registration evidence (identical-content
      //   merge below adopts the cloud's stale modifiedAt into the winner, which would otherwise let a
      //   re-imported bookmark lose its own tombstone tie). Survivors are then dropped from the payload
      //   at step 6 (same array), propagating the revocation to the cloud. See tombstones.ts
      //   revokeTombstonesForLiveReRegistrations (delete-all -> re-import -> auto-kill regression).
      revokeTombstonesForLiveReRegistrations(allTombstones, localBookmarks);
      const removedIds = applyTombstonesToMerge(mergedMap, allTombstones);
      for (const syncId of removedIds) {
        const local = await db.bookmarks.where('syncId').equals(syncId).first();
        if (local) {
          await db.bookmarks.delete(local.id!);
          await db.archivedPages.where('bookmarkId').equals(local.id!).delete();
        }

        // M-1: Propagate tombstone deletion to browser actual bookmarks as well.
        // Leaving browser bookmarks intact causes subsequent BookmarkManager.syncAll() to treat browser as source of truth,
        // re-adding bookmarks that do not exist in DB (= already deleted) and resurrecting zombie bookmarks.
        // Tombstones are permanent (no TTL, see persistTombstones) but re-registration survivors revoke them
        // (revokeTombstonesForLiveReRegistrations), so browser removal here cannot strand a legitimately re-added bookmark.
        // Use remove as targets are URL bookmarks (not folders).
        if (typeof browser !== 'undefined' && local) {
          try {
            await browser.bookmarks.remove(local.bookmarkId);
          } catch (e) {
            // If already deleted from browser or invalid id — silently ignore (no-op)
          }
        }
      }

      const finalBookmarks = Array.from(mergedMap.values());

      // 4.6. Merge duplicates by URL — if same URL exists under multiple syncIds (bookmarks) (duplicate creation case),
      //      keep only the one with latest modifiedAt and remove others from browser and DB.
      //      (Prevents createJobs from redundantly creating duplicates via browser.bookmarks.create())
      const { keep: dedupedBookmarks, duplicates: urlDuplicates } = dedupeByUrl(finalBookmarks);
      for (const dup of urlDuplicates) {
        // Do not silently dedupe (localVersion, cloudVersion) pairs logged as URL-based conflicts.
        // Removing them makes conflict indication meaningless; retain both until user resolves in ConflictResolverModal.
        if (urlConflictIds.has(dup.syncId)) continue;
        const dupLocal = await db.bookmarks.where('syncId').equals(dup.syncId).first();
        if (dupLocal) {
          // Re-parent db.archivedPages from duplicate to winner before deleting duplicate if winner has no archive
          const winner = dedupedBookmarks.find(b => normalizeUrl(b.url) === normalizeUrl(dup.url));
          const winnerLocal = winner ? await db.bookmarks.where('syncId').equals(winner.syncId).first() : null;
          if (winnerLocal && winnerLocal.id !== undefined && dupLocal.id !== undefined && winnerLocal.id !== dupLocal.id) {
            const winnerArchive = await db.archivedPages.where('bookmarkId').equals(winnerLocal.id).first();
            if (!winnerArchive) {
              const dupArchives = await db.archivedPages.where('bookmarkId').equals(dupLocal.id).toArray();
              for (const arch of dupArchives) {
                if (arch.id !== undefined) {
                  await db.archivedPages.update(arch.id, { bookmarkId: winnerLocal.id });
                }
              }
            }
          }
          await db.bookmarks.delete(dupLocal.id!);
          await db.archivedPages.where('bookmarkId').equals(dupLocal.id!).delete();

          if (typeof browser !== 'undefined' && dupLocal.bookmarkId) {
            try { await browser.bookmarks.remove(dupLocal.bookmarkId); } catch { /* already removed */ }
          }
        }
      }

      // 5. Reflect merged data in local DB & browser bookmarks
      //    (Awaiting non-Dexie browser.bookmarks API inside Dexie transaction causes
      //     PrematureCommitError on post-transaction writes, so browser operations are performed outside transaction)
      const retainedDuplicates = urlDuplicates.filter(d => urlConflictIds.has(d.syncId));
      const bookmarksToApply = [...dedupedBookmarks, ...retainedDuplicates];

      const updateJobs: { dbId: number; browserId: string; title: string; url: string; folderPath?: string }[] = [];
      const createJobs: typeof finalBookmarks = [];

      await db.transaction('rw', db.bookmarks, async () => {
        for (const fb of bookmarksToApply) {
          const exists = await db.bookmarks.where('syncId').equals(fb.syncId).first();
          if (exists) {
            // Update DB and browser bookmark only when information changed
            const winner = fb; // Winner in mergedMap
            const isContentSame = !contentDiffers(exists, winner);
            const earliestCreatedAt = Math.min(exists.createdAt || Date.now(), winner.createdAt || Date.now());
            const needsTimestampCorrection = isContentSame && (exists.modifiedAt !== winner.modifiedAt || exists.createdAt !== earliestCreatedAt);

            // M-1: If reverse (concurrent local edit makes exists newer, exists.modifiedAt > winner.modifiedAt),
            // do not overwrite with stale winner. Only reflect when winner is newer than or tied with exists,
            // with ties retaining cloud win (declared-actual agreement). tags compare content and order (not reference comparison).
            const changed =
              needsTimestampCorrection ||
              (exists.modifiedAt <= winner.modifiedAt &&
                (exists.modifiedAt !== winner.modifiedAt ||
                  exists.title !== winner.title ||
                  exists.url !== winner.url ||
                  exists.description !== winner.description ||
                  exists.folderPath !== winner.folderPath ||
                  !sameTags(exists.tags, winner.tags)));
            if (changed) {
              await db.bookmarks.update(exists.id!, {
                title: fb.title,
                url: fb.url,
                description: fb.description,
                tags: fb.tags ?? exists.tags,           // M-2: Retain local if missing in cloud (prevent wipe-out)
                folderPath: fb.folderPath,
                createdAt: earliestCreatedAt,
                modifiedAt: fb.modifiedAt,
                lastCheckedAt: fb.lastCheckedAt,
                httpStatus: fb.httpStatus,
                visitCount: Math.max(exists.visitCount, fb.visitCount)
              });
              if (!isContentSame) {
                updateJobs.push({
                  dbId: exists.id!,
                  browserId: exists.bookmarkId,
                  title: fb.title,
                  url: fb.url,
                  folderPath: fb.folderPath
                });
              }
            }
          } else {
            // Present in cloud only and missing locally -> acquire actual ID in browser then create locally (outside transaction)
            createJobs.push(fb);
          }
        }
      });

      // Outside transaction — reflect browser actual bookmarks (non-Dexie API, prevents PrematureCommitError)
      for (const job of updateJobs) {
        // Synchronize browser actual bookmark content
        try {
          await browser.bookmarks.update(job.browserId, {
            title: job.title,
            url: job.url
          });

          if (job.folderPath) {
            try {
              const targetFolder = await BookmarkManager.ensureFolderPath(job.folderPath);
              if (targetFolder) {
                const nodes = await browser.bookmarks.get(job.browserId);
                const curr = nodes?.[0];
                if (curr && curr.parentId !== targetFolder.id) {
                  await browser.bookmarks.move(job.browserId, { parentId: targetFolder.id });
                }
              }
            } catch (moveErr) {
              console.error('Failed to move bookmark to target folder:', moveErr);
            }
          }
        } catch (e) {
          // Recreate bookmark if already deleted or missing in browser
          try {
            let parentId: string | undefined = undefined;
            if (job.folderPath) {
              try {
                const targetFolder = await BookmarkManager.ensureFolderPath(job.folderPath);
                parentId = targetFolder?.id;
              } catch (folderErr) {
                console.error('Failed to ensure folder path on restore:', folderErr);
              }
            }
            const newB = await browser.bookmarks.create({
              parentId,
              title: job.title,
              url: job.url
            });
            // Update recovered ID
            if (newB.id !== job.browserId) {
              await db.bookmarks.update(job.dbId, { bookmarkId: newB.id });
            }
          } catch (createErr) {
            console.error('Failed to restore deleted browser bookmark:', createErr);
          }
        }
      }

      for (const fb of createJobs) {
        try {
          let targetFolder: { id: string; path: string } | null = null;
          if (fb.folderPath) {
            try {
              targetFolder = await BookmarkManager.ensureFolderPath(fb.folderPath);
            } catch (e) {
              console.error('Failed to ensure folder path for new bookmark:', e);
            }
          }

          // Duplicate defense: If a bookmark with the same URL already exists in browser, do not recreate;
          // match with existing bookmarkId in DB (prevents duplicate proliferation on resync after local DB reset).
          let existingBrowser: chrome.bookmarks.BookmarkTreeNode | undefined;
          try {
            const found = await browser.bookmarks.search({ url: fb.url });
            existingBrowser = found?.[0];
          } catch { /* ignore on search failure */ }

          let bookmarkNodeId: string;
          if (existingBrowser) {
            bookmarkNodeId = existingBrowser.id;
            if (targetFolder && existingBrowser.parentId !== targetFolder.id) {
              try {
                await browser.bookmarks.move(existingBrowser.id, { parentId: targetFolder.id });
              } catch (moveErr) {
                console.error('Failed to move existing browser bookmark to target folder:', moveErr);
              }
            }
          } else {
            const newB = await browser.bookmarks.create({
              parentId: targetFolder?.id,
              title: fb.title,
              url: fb.url
            });
            bookmarkNodeId = newB.id;
          }

          // Safely reflect cloud bookmark into local DB:
          // Check if record already exists by bookmarkId or syncId
          const existingByBookmarkId = await db.bookmarks.where('bookmarkId').equals(bookmarkNodeId).first();
          const existingBySyncId = await db.bookmarks.where('syncId').equals(fb.syncId).first();

          // Handle edge case matching two different records
          if (existingByBookmarkId && existingBySyncId && existingByBookmarkId.id !== existingBySyncId.id) {
            await db.bookmarks.delete(existingBySyncId.id!);
          }

          const existingRecord = existingByBookmarkId || existingBySyncId;

          if (existingRecord) {
            const earliestCreatedAt = Math.min(existingRecord.createdAt || Date.now(), fb.createdAt || Date.now());
            await db.bookmarks.update(existingRecord.id!, {
              syncId: fb.syncId,
              bookmarkId: bookmarkNodeId,
              url: fb.url,
              title: fb.title,
              folderPath: fb.folderPath,
              description: fb.description,
              tags: fb.tags,
              createdAt: earliestCreatedAt,
              modifiedAt: fb.modifiedAt,
              lastCheckedAt: fb.lastCheckedAt,
              httpStatus: fb.httpStatus,
              visitCount: Math.max(existingRecord.visitCount || 0, fb.visitCount || 0)
            });
          } else {
            await db.bookmarks.add({
              syncId: fb.syncId,
              bookmarkId: bookmarkNodeId,
              url: fb.url,
              title: fb.title,
              folderPath: fb.folderPath,
              description: fb.description,
              tags: fb.tags,
              createdAt: fb.createdAt,
              modifiedAt: fb.modifiedAt,
              lastCheckedAt: fb.lastCheckedAt,
              httpStatus: fb.httpStatus,
              visitCount: fb.visitCount || 0
            });
          }
        } catch (createErr) {
          console.error('Failed to create browser bookmark from cloud:', createErr);
        }
      }

      // 6. Upload merged latest version to cloud storage
      const snapshotTime = Date.now();
      const updatedLocalBookmarks = await db.bookmarks.toArray();

      // Fail-safe: Block cloud overwrite if merge candidate bookmarks existed but local is empty due to local DB/browser creation failure, etc.
      if (bookmarksToApply.length > 0 && updatedLocalBookmarks.length === 0) {
        console.error('Critical safety guard: bookmarksToApply is non-empty but updated local bookmarks is empty. Aborting cloud overwrite to prevent data loss.');
        throw new Error('Sync aborted: attempt to overwrite non-empty cloud bookmarks with empty local dataset.');
      }

      // Merge tombstones locally + include in payload (permanent, no TTL).
      // Re-registration revocation already applied at step 4.5 (in-place on allTombstones before LWW).
      const persistedTombstones = await persistTombstones(allTombstones);

      // When conflicts exist, for conflicting items, preserve the cloud version in cloud payload
      // to prevent premature overwrite of remote cloud data before user conflict resolution
      const conflictSyncIdSet = new Set(conflictLogs.map((c: any) => c.bookmarkId));
      const cloudBySyncId = new Map<string, Bookmark>();
      for (const cb of cloudBookmarks) {
        cloudBySyncId.set(cb.syncId, cb);
      }

      const payload = {
        bookmarks: updatedLocalBookmarks.map((b: any) => {
          let target = b;
          if (conflictSyncIdSet.has(b.syncId) && cloudBySyncId.has(b.syncId)) {
            target = cloudBySyncId.get(b.syncId)!;
          }
          // Exclude aiStatus (transient), aiCategory, aiSummary (removed fields), syncedAt (local-only), crossRootReview from cloud serialization
          // Also exclude id (device local IndexedDB auto-increment key)
          const { id, aiStatus, aiCategory, aiSummary, syncedAt, crossRootReview, ...rest } = target;
          return rest;
        }),
        tombstones: persistedTombstones,
        synchronizedAt: snapshotTime
      };
      // Gap B: Revalidate cloud modifiedTime just before write — if different from read time (base),
      // another device wrote concurrently, so abort write to prevent lost-update.
      // (Skip revalidation and proceed with write on getLastModified failure to avoid indefinitely blocking writes)
      let currentModified = 0;
      try {
        currentModified = await adapter.getLastModified(SYNC_FILE_NAME);
      } catch (e) {
        console.warn('Failed to revalidate cloud modified time, proceeding with write.', e);
        currentModified = -1; // Proceed with write on revalidation failure (prevents indefinite blocking)
      }

      // 7. Store sync conflict logs (prevents duplicate accumulation of same bookmarkId)
      if (conflictLogs.length > 0) {
        const existingLogs = (await db.settings.get('sync_conflict_logs'))?.value || [];
        const newConflictBookmarkIds = new Set(conflictLogs.map((l: any) => l.bookmarkId));
        // Replace bookmarkIds newly detected as conflicts among existing pending logs with latest conflictLog to block duplicate accumulation
        const remainingPending = existingLogs.filter((l: any) => l.status === 'pending' && !newConflictBookmarkIds.has(l.bookmarkId));
        const resolvedLogs = existingLogs.filter((l: any) => l.status !== 'pending');
        // Preserve all pending conflicts unconditionally; cap only historical resolved logs to 50
        const allPending = [...conflictLogs, ...remainingPending];
        const newLogs = [...allPending, ...resolvedLogs.slice(0, 50)];
        await db.settings.put({ key: 'sync_conflict_logs', value: newLogs });

        if (typeof document !== 'undefined') {
          document.dispatchEvent(new CustomEvent('sync-conflicts-detected', {
            detail: { count: conflictLogs.length }
          }));
        }
      }

      if (cloudBaseModified >= 0 && currentModified >= 0) {
        const concurrent = isConcurrentWrite(cloudBaseModified, currentModified);
        if (concurrent) {
          console.warn('Concurrent cloud write detected; skipping write to avoid lost-update.');
          await db.syncState.put({
            id: 1,
            provider: currentProvider,
            lastSyncAt: Date.now(),
            status: 'error'
          });
          return;
        }
      }
      await adapter.writeFile(SYNC_FILE_NAME, JSON.stringify(payload, null, 2));
      // Record syncedAt watermark on local bookmarks up to sync time (preserves dirty state of records edited locally during sync)
      await db.bookmarks.toCollection().modify((b: any) => {
        if (b.modifiedAt <= snapshotTime) {
          b.syncedAt = snapshotTime;
        }
      });
      // Mark initial sync completed for this provider and record sync state as 'idle'
      await db.settings.put({ key: `initial_sync_completed_${currentProvider}`, value: true });
      await db.syncState.put({ id: 1, provider: currentProvider, lastSyncAt: Date.now(), status: 'idle' });
      console.log('Cloud database synchronization successful.');

      // Reset periodic background sync alarm so the next periodic sync occurs according to configured interval
      await SyncEngine.resetPeriodicAlarm();

      // Sync cloud archives / propagate deletions and refresh index cache (safely handled so bookmark sync does not fail on errors)
      try {
        await syncPendingArchives();
        await refreshCloudArchiveIndex();
      } catch (archiveIdxErr) {
        console.warn('Failed to sync archives / refresh cloud archive index during sync:', archiveIdxErr);
      }
    } catch (error: any) {
      console.error('Synchronization failed:', error);
      const currentProvider = (await db.settings.get('sync_provider'))?.value || 'none';
      await db.syncState.put({
        id: 1,
        provider: currentProvider,
        lastSyncAt: Date.now(),
        status: 'error'
      });
      throw error;
      }
    } finally {
      BookmarkManager.setSyncMuted(false);
      // M-2: Release lock on all paths (success/failure/exception) to prevent lock deadlock on exceptions
      this.syncInProgress = false;
      // Restore badge across all paths (success/failure/exception) (remove syncing indicator)
      await setSyncingIndicator(false);
    }
  }

  /**
   * Executes cloud sync via debounce (5s) when bookmark data is modified.
   */
  static triggerDebouncedSync(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      try {
        console.log('Triggering debounced cloud sync...');
        await this.sync();
      } catch (e) {
        console.error('Debounced sync failed:', e);
      }
    }, 5000); // 5 seconds
  }

  /** Name of 5-minute periodic background sync alarm. */
  static readonly SYNC_ALARM_NAME = 'powerbookmark_sync_alarm';

  /**
   * Sets up background sync schedule according to alarm interval.
   * Operates idempotently — retains existing alarm if alive, recreates if missing or interval changed,
   * and logs console.warn and retries in 1 minute on registration failure.
   */
  static setupBackgroundAlarms(): void {
    // Register alarm listener
    browser.alarms.onAlarm.addListener(async (alarm) => {
      if (alarm.name === SyncEngine.SYNC_ALARM_NAME) {
        console.log('Scheduled sync alarm fired...');
        try {
          await this.sync();
        } catch (e) {
          console.error('Scheduled sync failed:', e);
        }
      }
    });

    // Register alarm (idempotent + retry on failure)
    this.ensureSyncAlarm().catch((e) => console.warn('ensureSyncAlarm failed:', e));
  }

  /**
   * Reads configured sync interval in minutes. Defaults to 5 minutes if unset or invalid.
   */
  static async getSyncInterval(): Promise<number> {
    try {
      if (typeof db !== 'undefined' && db.settings) {
        const row = await db.settings.get(SyncEngine.SYNC_INTERVAL_KEY);
        const val = row?.value;
        if (val !== null && val !== undefined) {
          const num = Number(val);
          if (Number.isFinite(num) && num >= 0) {
            return num;
          }
        }
      }
    } catch (e) {
      console.warn('Failed to read sync interval setting:', e);
    }
    return SyncEngine.DEFAULT_SYNC_INTERVAL_MINUTES;
  }

  /**
   * Updates or clears periodic background sync alarm according to provider and interval.
   */
  static async updateSyncSchedule(intervalMinutes?: number): Promise<void> {
    if (typeof browser === 'undefined' || !browser.alarms) {
      return;
    }
    const provider = (await db.settings.get('sync_provider'))?.value || 'none';
    const interval = intervalMinutes !== undefined ? intervalMinutes : await this.getSyncInterval();

    if (provider === 'none' || interval === 0) {
      if (browser.alarms?.clear) {
        await browser.alarms.clear(SyncEngine.SYNC_ALARM_NAME);
      }
      return;
    }

    if (browser.alarms?.create) {
      browser.alarms.create(SyncEngine.SYNC_ALARM_NAME, {
        delayInMinutes: interval,
        periodInMinutes: interval
      });
    }
  }

  /**
   * Resets the periodic background sync alarm using the configured or provided interval.
   * Prevents redundant syncs when manual sync, debounced sync, or initial sync completes.
   */
  static async resetPeriodicAlarm(intervalMinutes?: number): Promise<void> {
    await this.updateSyncSchedule(intervalMinutes);
  }

  /**
   * Checks whether sync alarm is actually registered and recreates if missing or interval changed.
   * (Auto-recovers when alarm disappears due to MV3 service worker lifecycle or registration failure)
   * Logs console.warn and retries after retryDelayMs on query/registration failure.
   */
  static async ensureSyncAlarm(retryDelayMs = 60_000): Promise<void> {
    if (typeof browser === 'undefined' || !browser.alarms?.get) {
      return;
    }
    const ALARM_NAME = SyncEngine.SYNC_ALARM_NAME;
    try {
      const provider = (await db.settings.get('sync_provider'))?.value || 'none';
      const targetInterval = await SyncEngine.getSyncInterval();

      if (provider === 'none' || targetInterval === 0) {
        if (browser.alarms?.clear) {
          await browser.alarms.clear(ALARM_NAME);
        }
        return;
      }

      const alarm = await browser.alarms.get(ALARM_NAME);
      if (alarm && alarm.periodInMinutes === targetInterval) {
        console.log('Background sync alarm already exists; keeping it.');
        return;
      }

      console.log(`Configuring background sync alarm (${targetInterval} minutes interval).`);
      browser.alarms.create(ALARM_NAME, {
        delayInMinutes: targetInterval,
        periodInMinutes: targetInterval
      });
      console.log(`Background sync alarm configured (${targetInterval} minutes interval).`);
    } catch (e) {
      // Guard in case browser.alarms.get/create throws synchronous exceptions (extension context invalidation, etc.)
      console.warn('Failed to set up sync alarm; will retry.', e);
      setTimeout(() => {
        this.ensureSyncAlarm(retryDelayMs).catch(() => {});
      }, retryDelayMs);
    }
  }
}
