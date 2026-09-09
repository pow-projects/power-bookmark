import { db, type Bookmark } from '../db';
import { normalizeUrl, generateDeterministicSyncId } from './url-normalizer';
import { recordVisit } from '../stats/stats-tracker';
import { recordTombstone, removeTombstone } from '../sync/tombstones';
import { deleteArchiveFromCloud } from '../archive/archive-cloud';
import {
  SYSTEM_ROOT_NAMES,
  isSystemRootTitle,
  getRootFolderName,
  normalizeFolderPath,
  isSameFolderLocation,
  isUncategorizedBookmark,
  findFuzzyMatchingFolder,
  type ResolvedFolderInput
} from './folder-utils';
import { sanitizeTags } from './tag-utils';

export {
  SYSTEM_ROOT_NAMES,
  isSystemRootTitle,
  getRootFolderName,
  normalizeFolderPath,
  isSameFolderLocation,
  isUncategorizedBookmark,
  generateDeterministicSyncId,
  type ResolvedFolderInput
};

// Cache map to calculate folder path from browser bookmark node information
const folderCache = new Map<string, { title: string; parentId?: string }>();

/**
 * Traverses the browser bookmark tree and refreshes folder cache.
 */
async function refreshFolderCache(): Promise<void> {
  folderCache.clear();
  try {
    const tree = await browser.bookmarks.getTree();
    
    function traverse(node: any) {
      if (!node) return;
      folderCache.set(node.id, { title: node.title, parentId: node.parentId });
      if (node.children && Array.isArray(node.children)) {
        for (const child of node.children) {
          traverse(child);
        }
      }
    }
    
    if (tree && Array.isArray(tree)) {
      for (const rootNode of tree) {
        traverse(rootNode);
      }
    }
  } catch (error) {
    console.error('Failed to refresh folder cache:', error);
  }
}

/**
 * Calculates full folder path for a specific bookmark node.
 * Example: "Bookmarks Bar/Tech/Development"
 */
function getFolderPathForNode(parentId?: string): string {
  if (!parentId) return '';
  
  const pathParts: string[] = [];
  let currentId: string | undefined = parentId;
  
  while (currentId) {
    const cached = folderCache.get(currentId);
    if (!cached) break;
    
    // Root nodes (generally nameless or system nodes) are excluded from path or assigned specific names
    if (cached.title && cached.title !== 'root' && currentId !== '0') {
      pathParts.unshift(cached.title);
    }
    currentId = cached.parentId;
  }
  
  return pathParts.join('/');
}

export interface FolderItem {
  id: string;
  title: string;
  path: string;
  parentId?: string;
  depth: number;
  displayName: string;
}

export type FolderNode = FolderItem;

class AsyncLock {
  private queue: Promise<void> = Promise.resolve();

  acquire<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
}

const folderCreationLock = new AsyncLock();

/**
 * Manager class handling two-way real-time synchronization between browser bookmark API and internal IndexedDB.
 */
export class BookmarkManager {
  private static isListening = false;
  static isSyncMuted = false;

  static setSyncMuted(muted: boolean): void {
    this.isSyncMuted = muted;
    try {
      if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
        browser.runtime.sendMessage({ type: 'SET_SYNC_MUTED', muted }).catch(() => {});
      }
    } catch {}
  }

  /**
   * One-time initialization sync matching the full browser bookmark tree with the internal DB.
   */
  static async syncAll(): Promise<void> {
    await refreshFolderCache();
    
    try {
      const tree = await browser.bookmarks.getTree();
      const browserBookmarks: any[] = [];
      
      function collect(node: any) {
        if (node.url) {
          browserBookmarks.push({
            bookmarkId: node.id,
            url: node.url,
            title: node.title,
            folderPath: getFolderPathForNode(node.parentId),
            dateAdded: node.dateAdded || Date.now()
          });
        }
        if (node.children) {
          for (const child of node.children) {
            collect(child);
          }
        }
      }
      
      for (const rootNode of tree) {
        collect(rootNode);
      }

      // Update in batch via IndexedDB transaction
      await db.transaction('rw', [db.bookmarks, db.archivedPages, db.settings], async () => {
        // Retrieve all bookmark IDs in internal DB
        const localBookmarks = await db.bookmarks.toArray();

        // Fail-safe: Guard against wiping out local DB when the browser bookmark tree is completely empty
        // but local DB contains records (e.g. new profile or before browser API initialization).
        if (browserBookmarks.length === 0 && localBookmarks.length > 0) {
          console.warn('Browser bookmark tree is empty while local DB has records; skipping wipe-out fail-safe.');
          return;
        }

        const localIdMap = new Map(localBookmarks.map(b => [b.bookmarkId, b]));
        const localSyncIdSet = new Set(localBookmarks.map(b => b.syncId));
        const unmatchedLocalByUrl = new Map<string, Bookmark[]>();
        for (const b of localBookmarks) {
          const norm = normalizeUrl(b.url);
          const list = unmatchedLocalByUrl.get(norm) || [];
          list.push(b);
          unmatchedLocalByUrl.set(norm, list);
        }

        // FIX-2(archive-reset-wipe): Browser node index (including duplicate URLs) and claim tracking set
        // for same-URL readoption determination. Unused node = node not matched/created for any DB record.
        const browserNodesByUrl = new Map<string, string[]>();
        for (const bb of browserBookmarks) {
          const norm = normalizeUrl(bb.url);
          const arr = browserNodesByUrl.get(norm) || [];
          arr.push(bb.bookmarkId);
          browserNodesByUrl.set(norm, arr);
        }
        const claimedBrowserIds = new Set<string>();

        for (const bb of browserBookmarks) {
          claimedBrowserIds.add(bb.bookmarkId);
          const local = localIdMap.get(bb.bookmarkId);
          if (local) {
            // Update if already exists (reflect changes to title, URL, folder path)
            const isUrlChanged = local.url !== bb.url;
            const isTitleChanged = local.title !== bb.title;
            const isFolderLocationChanged = !isSameFolderLocation(local.folderPath, bb.folderPath);
            const isFolderFormatChanged = (local.folderPath || '') !== (bb.folderPath || '');

            if (isUrlChanged || isTitleChanged || isFolderLocationChanged) {
              await db.bookmarks.update(local.id!, {
                url: bb.url,
                title: bb.title,
                folderPath: bb.folderPath,
                modifiedAt: Date.now()
              });
            } else if (isFolderFormatChanged) {
              // If actual location is identical and only root prefix format differs, update without modifying modifiedAt
              await db.bookmarks.update(local.id!, {
                folderPath: bb.folderPath
              });
            }
            localIdMap.delete(bb.bookmarkId);
            const norm = normalizeUrl(local.url);
            const list = unmatchedLocalByUrl.get(norm);
            if (list) {
              const idx = list.indexOf(local);
              if (idx !== -1) list.splice(idx, 1);
            }
          } else {
            // No match by bookmarkId -> attempt URL fallback match
            const norm = normalizeUrl(bb.url);
            const candidates = unmatchedLocalByUrl.get(norm) || [];
            let matched: Bookmark | undefined;
            if (candidates.length === 1) {
              matched = candidates[0];
            } else if (candidates.length > 1) {
              matched = candidates.find(c => isSameFolderLocation(c.folderPath, bb.folderPath) && c.title === bb.title)
                || candidates.find(c => isSameFolderLocation(c.folderPath, bb.folderPath))
                || candidates.find(c => c.title === bb.title)
                || candidates[0];
            }

            if (matched) {
              const oldBookmarkId = matched.bookmarkId;
              const isUrlChanged = matched.url !== bb.url;
              const isTitleChanged = matched.title !== bb.title;
              const isFolderLocationChanged = !isSameFolderLocation(matched.folderPath, bb.folderPath);
              const isFolderFormatChanged = (matched.folderPath || '') !== (bb.folderPath || '');

              const updatePayload: Partial<Bookmark> = {
                bookmarkId: bb.bookmarkId,
                url: bb.url,
                title: bb.title,
                folderPath: bb.folderPath
              };
              if (isUrlChanged || isTitleChanged || isFolderLocationChanged) {
                updatePayload.modifiedAt = Date.now();
              }
              await db.bookmarks.update(matched.id!, updatePayload);

              localIdMap.delete(oldBookmarkId);
              const idx = candidates.indexOf(matched);
              if (idx !== -1) candidates.splice(idx, 1);
            } else {
              // Newly added bookmark
              let newSyncId = generateDeterministicSyncId(bb.url);
              if (localSyncIdSet.has(newSyncId)) {
                newSyncId = crypto.randomUUID();
              }
              localSyncIdSet.add(newSyncId);
              await removeTombstone(newSyncId);

              const now = Date.now();
              await db.bookmarks.add({
                syncId: newSyncId,
                bookmarkId: bb.bookmarkId,
                url: bb.url,
                title: bb.title,
                folderPath: bb.folderPath,
                description: '',
                createdAt: bb.dateAdded || now,
                modifiedAt: Math.max(bb.dateAdded || 0, now),
                visitCount: 0
              });
            }
          }
        }

        // Remove bookmarks that no longer exist in browser from local DB as well
        for (const [unusedId, localObj] of localIdMap.entries()) {
          // FIX-2(archive-reset-wipe): Just before deletion, if an unadopted node (not matched to any DB record)
          // with the same normalizeUrl exists in the browser tree, replace record deletion with bookmarkId reassignment.
          // In this case, suppress tombstone recording and cloud archive deletion propagation to prevent cloud archive loss
          // when re-numbering bookmark IDs after complete reset. Retain existing delete behavior if no matching node is found.
          const freeNodes = browserNodesByUrl.get(normalizeUrl(localObj.url)) || [];
          const freeNode = freeNodes.find(id => !claimedBrowserIds.has(id));
          if (freeNode !== undefined) {
            claimedBrowserIds.add(freeNode);
            await db.bookmarks.update(localObj.id!, { bookmarkId: freeNode });
            console.log(`[syncAll] bookmarkId '${unusedId}' → '${freeNode}' reassigned (adopting unadopted node with same URL, suppressing deletion and propagation)`);
            continue;
          }

          await db.bookmarks.delete(localObj.id!);
          // INVARIANT: Local archive + cloud archive deletion only proceeds after confirming
          //   'no unadopted node with same URL exists in browser' (adoption failure = confirmed deletion intent). Do not delete indiscriminately.
          //   (regression: archive-reset-wipe-regression S3)
          // Also delete associated archive file
          await db.archivedPages.where('bookmarkId').equals(localObj.id!).delete();
          // Record tombstone for delete propagation (prevents resurrection in cloud LWW merge)
          await recordTombstone(localObj.syncId, Date.now());
          // Propagate cloud archive deletion
          if (localObj.syncId) {
            try {
              deleteArchiveFromCloud(localObj.syncId).catch((e) => console.warn('[BookmarkManager] Failed to delete cloud archive in syncAll:', e));
            } catch {}
          }
        }
      });
      
      console.log('Bookmark synchronization completed.');
    } catch (error) {
      console.error('Error syncing bookmarks:', error);
    }
  }

  /**
   * Listens to browser bookmark events to reflect them in the internal DB in real time.
   */
  static listen(): void {
    if (this.isListening) return;
    this.isListening = true;

    // Bookmark creation
    browser.bookmarks.onCreated.addListener(async (id, node) => {
      if (this.isSyncMuted) return;
      if (!node.url) return;
      await refreshFolderCache();

      // Check if deleted immediately after creation in browser (race condition defense: if onRemoved was processed first)
      if (typeof browser !== 'undefined' && browser.bookmarks?.get) {
        try {
          const check = await browser.bookmarks.get(id);
          if (!check || check.length === 0) {
            return;
          }
        } catch {
          // Already deleted from browser
          return;
        }
      }

      await db.transaction('rw', [db.bookmarks, db.settings], async () => {
        const exists = await db.bookmarks.where('bookmarkId').equals(id).first();
        if (!exists) {
          let newSyncId = generateDeterministicSyncId(node.url || '');
          const existsSyncId = await db.bookmarks.where('syncId').equals(newSyncId).first();
          if (existsSyncId) {
            newSyncId = crypto.randomUUID();
          }

          await removeTombstone(newSyncId);

          const now = Date.now();
          await db.bookmarks.add({
            syncId: newSyncId,
            bookmarkId: id,
            url: node.url || '',
            title: node.title,
            folderPath: getFolderPathForNode(node.parentId),
            description: '',
            createdAt: node.dateAdded || now,
            modifiedAt: Math.max(node.dateAdded || 0, now),
            visitCount: 0
          });
        }
      });
    });

    // Bookmark deletion
    browser.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
      if (this.isSyncMuted) return;
      await refreshFolderCache();
      const local = await db.bookmarks.where('bookmarkId').equals(id).first();
      if (local) {
        // Cancel AI analysis
        try {
          if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
            browser.runtime.sendMessage({ type: 'AI_ABORT_BOOKMARK', bookmarkId: local.id! }).catch(() => {});
          }
          const { cancelBookmarkAi } = await import('../ai/ai-queue');
          cancelBookmarkAi(local.id!).catch(() => {});
        } catch {}

        await db.bookmarks.delete(local.id!);
        // Delete associated archive
        await db.archivedPages.where('bookmarkId').equals(local.id!).delete();
        // Record tombstone for delete propagation (prevents resurrection in cloud LWW merge)
        await recordTombstone(local.syncId, Date.now());
        // Propagate cloud archive deletion
        if (local.syncId) {
          try {
            deleteArchiveFromCloud(local.syncId).catch((e) => console.warn('[BookmarkManager] Failed to delete cloud archive on bookmark remove:', e));
          } catch {}
        }
      }
    });

    // Bookmark content modification (title, URL)
    browser.bookmarks.onChanged.addListener(async (id, changeInfo) => {
      if (this.isSyncMuted) return;
      const local = await db.bookmarks.where('bookmarkId').equals(id).first();
      if (local) {
        const isTitleChanged = changeInfo.title !== undefined && changeInfo.title !== local.title;
        const isUrlChanged = changeInfo.url !== undefined && changeInfo.url !== local.url;
        if (isTitleChanged || isUrlChanged) {
          const updateData: Partial<Bookmark> = {
            modifiedAt: Date.now()
          };
          if (changeInfo.title !== undefined) updateData.title = changeInfo.title;
          if (changeInfo.url !== undefined) updateData.url = changeInfo.url;
          await db.bookmarks.update(local.id!, updateData);
        }
      }
    });

    // Bookmark folder move
    browser.bookmarks.onMoved.addListener(async (id, moveInfo) => {
      if (this.isSyncMuted) return;
      await refreshFolderCache();
      const local = await db.bookmarks.where('bookmarkId').equals(id).first();
      if (local) {
        const newPath = getFolderPathForNode(moveInfo.parentId);
        if (!isSameFolderLocation(local.folderPath, newPath)) {
          await db.bookmarks.update(local.id!, {
            folderPath: newPath,
            modifiedAt: Date.now()
          });
        }
      }
    });
    
    console.log('Started listening to browser bookmark events.');
  }

  /**
   * Creates a bookmark in the local DB and browser.
   */
  static async createBookmark(
    url: string,
    title: string,
    parentId?: string,
    description = '',
    timestamps?: { createdAt?: number; modifiedAt?: number },
    tags?: string[]
  ): Promise<Bookmark> {
    // 1. Create browser bookmark
    const node = await browser.bookmarks.create({
      url,
      title,
      parentId
    });

    await refreshFolderCache();
    const folderPath = getFolderPathForNode(node.parentId);

    // 2. Deterministically update/insert directly into IndexedDB db.bookmarks without a polling loop
    let local: Bookmark | undefined;
    await db.transaction('rw', [db.bookmarks, db.settings], async () => {
      local = await db.bookmarks.where('bookmarkId').equals(node.id).first();
      if (!local) {
        const now = Date.now();
        const createdAt = timestamps?.createdAt ?? (node.dateAdded || now);
        // INVARIANT (re-registration resurrection): Registration-time events (import/popup/create) must
        //   always stamp modifiedAt >= now. Never inherit a stale timestamp from source data (HTML export
        //   ADD_DATE/LAST_MODIFIED). Permanent cloud tombstones (tombstones.ts persistTombstones) apply LWW
        //   `deletedAt > modifiedAt` — a stale re-imported modifiedAt re-matches the tombstone of the same
        //   deterministic syncId and the sync engine deletes the record AND the browser node (regression:
        //   delete-all -> re-import -> auto-kill). "Import means fresh registration" per product decision.
        const modifiedAt = Math.max(timestamps?.modifiedAt ?? 0, now);
        let newSyncId = generateDeterministicSyncId(url);
        const existsSyncId = await db.bookmarks.where('syncId').equals(newSyncId).first();
        if (existsSyncId) {
          newSyncId = crypto.randomUUID();
        }

        await removeTombstone(newSyncId);

        const sanitizedTags = tags && tags.length > 0 ? sanitizeTags(tags) : undefined;
        const newId = await db.bookmarks.add({
          syncId: newSyncId,
          bookmarkId: node.id,
          url,
          title,
          folderPath,
          description,
          tags: sanitizedTags && sanitizedTags.length > 0 ? sanitizedTags : undefined,
          createdAt,
          modifiedAt,
          visitCount: 0
        });
        local = (await db.bookmarks.get(newId))!;
      } else {
        // INVARIANT: same re-registration guard as the insert branch above — an explicit stale
        //   timestamps.modifiedAt (import/re-add updating a listener-inserted row) must never resurrect
        //   the tombstone LWW hazard. Registration-time updates always stamp >= now.
        const updateData: Partial<Bookmark> = {
          modifiedAt: Math.max(timestamps?.modifiedAt ?? 0, Date.now())
        };
        if (timestamps?.createdAt) {
          updateData.createdAt = timestamps.createdAt;
          local.createdAt = timestamps.createdAt;
        }
        const sanitizedTags = tags && tags.length > 0 ? sanitizeTags(tags) : undefined;
        if (sanitizedTags && sanitizedTags.length > 0) {
          updateData.tags = sanitizedTags;
          local.tags = sanitizedTags;
        }
        if (description && local.description !== description) {
          updateData.description = description;
          local.description = description;
        }
        if (folderPath && local.folderPath !== folderPath) {
          updateData.folderPath = folderPath;
          local.folderPath = folderPath;
        }
        await db.bookmarks.update(local.id!, updateData);
      }
    });

    return local!;
  }

  /**
   * Deletes bookmark from local DB and browser.
   */
  static async removeBookmark(id: number): Promise<void> {
    // 0. Cancel AI analysis (send abort message to background SW and clean up local DB queue)
    try {
      if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
        browser.runtime.sendMessage({ type: 'AI_ABORT_BOOKMARK', bookmarkId: id }).catch(() => {});
      }
      const { cancelBookmarkAi } = await import('../ai/ai-queue');
      cancelBookmarkAi(id).catch(() => {});
    } catch {}

    const local = await db.bookmarks.get(id);
    if (!local) return;

    try {
      // 1. Remove from browser
      await browser.bookmarks.remove(local.bookmarkId);
    } catch (e) {
      // Handle exception if already removed from browser
      console.warn('Bookmark already removed from browser bookmarks:', e);
    }

    // 2. Record tombstone for delete propagation — ensures deletion is not restored during cloud LWW merge.
    //    (Using only onRemoved listener (bookmark-manager.ts listen) performs DB lookup via refreshFolderCache()
    //    getTree IPC, which may race with db.bookmarks.delete(id) below and fail to find local record to write tombstone.
    //    Without a tombstone, subsequent cloud sync would fetch the remaining cloud bookmark and revive it.
    //    Recording it explicitly here guarantees deletion propagation regardless of races.)
    await recordTombstone(local.syncId, Date.now());

    // 3. Remove from local DB (listener also runs, but delete once more for safety)
    await db.bookmarks.delete(id);
    await db.archivedPages.where('bookmarkId').equals(id).delete();

    // 4. Propagate cloud archive deletion
    if (local.syncId) {
      try {
        if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
          browser.runtime.sendMessage({ type: 'ARCHIVE_DELETE', syncId: local.syncId }).catch(async () => {
            try {
              await deleteArchiveFromCloud(local.syncId);
            } catch {}
          });
        } else {
          await deleteArchiveFromCloud(local.syncId);
        }
      } catch {
        try {
          await deleteArchiveFromCloud(local.syncId);
        } catch {}
      }
    }
  }

  /**
   * Updates bookmark information.
   */
  static async updateBookmark(id: number, data: Partial<Bookmark>): Promise<void> {
    const local = await db.bookmarks.get(id);
    if (!local) return;

    // Update browser bookmark title and URL
    try {
      const browserUpdate: { title?: string; url?: string } = {};
      if (data.title !== undefined) browserUpdate.title = data.title;
      if (data.url !== undefined) browserUpdate.url = data.url;

      if (Object.keys(browserUpdate).length > 0) {
        await browser.bookmarks.update(local.bookmarkId, browserUpdate);
      }
    } catch (e) {
      console.error('Failed to update browser bookmark:', e);
    }

    // Move browser bookmark folder
    if (data.folderPath !== undefined && (data.folderPath || '') !== (local.folderPath || '')) {
      try {
        if (data.folderPath) {
          const rootName = getRootFolderName(data.folderPath);
          const cleanPath = normalizeFolderPath(data.folderPath);
          const targetFolder = await BookmarkManager.ensureFolderPath(cleanPath, rootName);
          if (targetFolder) {
            const nodes = await browser.bookmarks.get(local.bookmarkId);
            const curr = nodes?.[0];
            if (curr && curr.parentId !== targetFolder.id) {
              await browser.bookmarks.move(local.bookmarkId, { parentId: targetFolder.id });
            }
          }
        } else {
          // Move to root folder
          const folders = await BookmarkManager.getFolders();
          const rootFolder = folders.find(f => f.title && f.title.toLowerCase() === 'bookmarks bar')
            ?? folders.find(f => f.parentId === '0' || f.parentId === 'root');
          const rootId = rootFolder?.id || '1';
          const nodes = await browser.bookmarks.get(local.bookmarkId);
          const curr = nodes?.[0];
          if (curr && curr.parentId !== rootId) {
            await browser.bookmarks.move(local.bookmarkId, { parentId: rootId });
          }
        }
      } catch (e) {
        console.error('Failed to move browser bookmark in updateBookmark:', e);
      }
    }

    // Update local DB
    const sanitizedData: Partial<Bookmark> = { ...data };
    if (sanitizedData.tags !== undefined) {
      sanitizedData.tags = sanitizeTags(sanitizedData.tags);
    }
    const contentKeys = ['title', 'url', 'description', 'folderPath', 'tags'] as const;
    const hasContentChange = contentKeys.some(
      (k) => (sanitizedData as any)[k] !== undefined && (sanitizedData as any)[k] !== (local as any)[k]
    );
    const updatePayload: Partial<Bookmark> = {
      ...sanitizedData,
      ...(sanitizedData.modifiedAt !== undefined
        ? { modifiedAt: sanitizedData.modifiedAt }
        : hasContentChange
        ? { modifiedAt: Date.now() }
        : {})
    };
    await db.bookmarks.update(id, updatePayload);
  }

  /**
   * Batches moving bookmark list to specified folder.
   * - Updates parentId in browser bookmark tree.
   * - Batches updating folderPath and modifiedAt (LWW) in local DB.
   * - Preserves syncId without modification.
   * @param bookmarkIds Array of bookmark DB primary keys (id) to move
   * @param targetFolder Target folder { id: string; path: string; title?: string }
   * @returns { movedCount: number } Count of bookmarks actually moved
   */
  static async moveBookmarksToFolder(
    bookmarkIds: number[],
    targetFolder: { id: string; path: string; title?: string }
  ): Promise<{ movedCount: number }> {
    if (!bookmarkIds || bookmarkIds.length === 0 || !targetFolder || !targetFolder.id) {
      return { movedCount: 0 };
    }

    const records = await db.bookmarks.where('id').anyOf(bookmarkIds).toArray();
    if (records.length === 0) {
      return { movedCount: 0 };
    }

    const targetPath = targetFolder.path || targetFolder.title || '';
    const toMove = records.filter(b => !isSameFolderLocation(b.folderPath, targetPath));
    if (toMove.length === 0) {
      return { movedCount: 0 };
    }

    // 1. Move browser bookmarks
    for (const b of toMove) {
      if (b.bookmarkId && typeof browser !== 'undefined' && browser.bookmarks?.move) {
        try {
          const nodes = await browser.bookmarks.get(b.bookmarkId);
          const curr = nodes?.[0];
          if (curr && curr.parentId !== targetFolder.id) {
            await browser.bookmarks.move(b.bookmarkId, { parentId: targetFolder.id });
          }
        } catch (e) {
          console.warn(`Failed to move browser bookmark ${b.bookmarkId}:`, e);
        }
      }
    }

    // 2. Batch update local DB (guarantees cloud LWW sync via modifiedAt update, keeps syncId immutable)
    const now = Date.now();
    await db.transaction('rw', db.bookmarks, async () => {
      for (const b of toMove) {
        await db.bookmarks.update(b.id!, {
          folderPath: targetPath,
          modifiedAt: now
        });
      }
    });

    return { movedCount: toMove.length };
  }

  /**
   * Opens bookmark URL in a new tab and records visit statistics.
   */
  static async openBookmark(url: string): Promise<void> {
    try {
      await recordVisit(url);
    } catch (e) {
      console.error('Failed to record visit:', e);
    }
    await browser.tabs.create({ url });
  }

  /**
   * URL lookup for duplicate detection.
   * Prevents full table scan (toArray) using IndexedDB 'url' index and host prefix index search.
   */
  static async findDuplicate(url: string): Promise<Bookmark | undefined> {
    if (!url) return undefined;
    const targetNorm = normalizeUrl(url, { ignoreProtocol: true, keepHash: false });
    if (!targetNorm) return undefined;

    // 1. First search for exact match via IndexedDB 'url' index (O(1) B-Tree lookup)
    const exactMatch = await db.bookmarks.where('url').equals(url).first();
    if (exactMatch) {
      const exactNorm = normalizeUrl(exactMatch.url, { ignoreProtocol: true, keepHash: false });
      if (exactNorm === targetNorm) {
        return exactMatch;
      }
    }

    // 2. Search index prefix range based on same host in case protocol/www/trailing slash differs
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();

      const hostVariations = new Set<string>();
      hostVariations.add(hostname);
      if (hostname.startsWith('www.')) {
        hostVariations.add(hostname.slice(4));
      } else {
        hostVariations.add(`www.${hostname}`);
      }

      for (const host of hostVariations) {
        for (const proto of ['http://', 'https://']) {
          const prefix = `${proto}${host}`;
          const candidates = await db.bookmarks.where('url').startsWith(prefix).toArray();
          const duplicate = candidates.find(b => {
            const itemNorm = normalizeUrl(b.url, { ignoreProtocol: true, keepHash: false });
            return itemNorm === targetNorm;
          });
          if (duplicate) return duplicate;
        }
      }
      return undefined;
    } catch (e) {
      // Fallback on URL parse failure: scan entire IndexedDB data for normalized match
      const all = await db.bookmarks.toArray();
      return all.find(b => {
        const itemNorm = normalizeUrl(b.url, { ignoreProtocol: true, keepHash: false });
        return itemNorm === targetNorm;
      });
    }
  }

  /**
   * Retrieves browser bookmark folder list (for dropdown composition).
   * Traverses and sorts hierarchical tree using DFS (depth-first search),
   * returning each folder object with id, title, path, parentId, depth, displayName (including indentation ├─, └─).
   */
  static async getFolders(): Promise<FolderItem[]> {
    await refreshFolderCache();
    const folders: FolderItem[] = [];
    
    let tree: any[] = [];
    try {
      const rawTree = await browser.bookmarks.getTree();
      tree = Array.isArray(rawTree) ? rawTree : (rawTree ? [rawTree] : []);
    } catch (e) {
      console.error('Failed to get bookmark tree:', e);
      return folders;
    }

    function getChildFolders(node: any): any[] {
      if (!node || !node.children || !Array.isArray(node.children)) return [];
      return node.children.filter((child: any) => child && !child.url);
    }

    function traverse(
      node: any,
      parentPath: string,
      depth: number
    ) {
      if (!node) return;
      const isSystemRoot = node.id === '0' || node.id === 'root' || node.id === 'root________' || node.title === 'root' || !node.parentId;
      let currentPath = parentPath;
      let currentDepth = depth;

      if (!isSystemRoot) {
        const title = node.title || `Folder (${node.id})`;
        currentPath = parentPath ? `${parentPath}/${title}` : title;

        const indent = '\u00A0\u00A0'.repeat(depth);
        const displayName = `${indent}${title}`;

        folders.push({
          id: node.id,
          title,
          path: currentPath,
          parentId: node.parentId,
          depth: currentDepth,
          displayName
        });

        currentDepth = depth + 1;
      }

      const childFolders = getChildFolders(node);
      for (const child of childFolders) {
        traverse(child, currentPath, currentDepth);
      }
    }

    for (const rootNode of tree) {
      if (!rootNode) continue;
      const isSystemRoot = rootNode.id === '0' || rootNode.id === 'root' || rootNode.id === 'root________' || rootNode.title === 'root' || !rootNode.parentId;
      if (isSystemRoot) {
        const childFolders = getChildFolders(rootNode);
        for (const child of childFolders) {
          traverse(child, '', 0);
        }
      } else {
        traverse(rootNode, '', 0);
      }
    }

    return folders;
  }

  /**
   * Ensures folder exists at "Major/Minor" path. Returns existing folder if present, or creates from top down in order.
   * Matching is based on normalized path with system roots (Bookmarks Bar, etc.) removed.
   * Serialized with async mutex to avoid duplicate folder creation during concurrent AI analysis tasks.
   * @param path Folder path to create or ensure (e.g., 'Other bookmarks/Tech/Web', 'Other bookmarks', 'Tech/Web')
   * @param targetRootName Target root folder name to create in (e.g., 'Other bookmarks', 'Bookmarks bar')
   * @returns Created/matched leaf folder { id, path } — null on failure
   */
  static async ensureFolderPath(path: string, targetRootName?: string): Promise<{ id: string; path: string } | null> {
    return folderCreationLock.acquire(async () => {
      const trimmedPath = (path || '').trim();
      if (!trimmedPath && !targetRootName) return null;

      let folders = await BookmarkManager.getFolders();
      let currentPath = '';

    // Determine target root folder:
    // 1) Use targetRootName if explicitly specified
    // 2) If path itself contains root folder (e.g., 'Other bookmarks/Dev' or 'Other bookmarks'), use that root
    // 3) Otherwise fallback to 'Bookmarks bar' system folder
    const effectiveRootName = targetRootName || (trimmedPath ? getRootFolderName(trimmedPath, folders) : undefined);

    let targetRoot: FolderItem | undefined;
    if (effectiveRootName) {
      targetRoot = folders.find(f => f.title && f.title.toLowerCase() === effectiveRootName.toLowerCase())
        ?? folders.find(f => f.path && f.path.toLowerCase() === effectiveRootName.toLowerCase())
        ?? folders.find(f => getRootFolderName(f.path, folders).toLowerCase() === effectiveRootName.toLowerCase());
    }
    if (!targetRoot) {
      targetRoot = folders.find(f => f.title && f.title.toLowerCase() === 'bookmarks bar')
        ?? folders.find(f => f.title && SYSTEM_ROOT_NAMES.has(f.title.toLowerCase()));
    }

    const normPath = normalizeFolderPath(trimmedPath);
    const segments = normPath.split('/').map(s => s.trim()).filter(Boolean);

    // When segments is empty (i.e. path is system root itself or empty)
    if (segments.length === 0) {
      if (targetRoot) {
        return { id: targetRoot.id, path: targetRoot.path || targetRoot.title };
      }
      return null;
    }

    const rootPrefix = targetRoot ? targetRoot.title : '';
    let parentId: string | undefined = targetRoot?.id;
    let result: { id: string; path: string } | null = null;

    for (const seg of segments) {
      currentPath = currentPath ? `${currentPath}/${seg}` : seg;
      const fullExpectedPath = rootPrefix ? `${rootPrefix}/${currentPath}` : currentPath;

      let existing = parentId !== undefined
        ? folders.find(f => f.parentId === parentId && f.title.toLowerCase() === seg.toLowerCase())
        : undefined;
      if (!existing) {
        existing = folders.find(f => {
          if (normalizeFolderPath(f.path) !== currentPath) return false;
          if (targetRoot) {
            return getRootFolderName(f.path, folders).toLowerCase() === targetRoot.title.toLowerCase();
          }
          return true;
        });
      }
      if (existing) {
        parentId = existing.id;
        result = { id: existing.id, path: existing.path || fullExpectedPath };
        continue;
      }
      try {
        const node = await browser.bookmarks.create({ parentId, title: seg });
        parentId = node.id;
        result = { id: node.id, path: fullExpectedPath };
        folders.push({ id: node.id, title: seg, path: fullExpectedPath, parentId, depth: 0, displayName: seg });
      } catch (e) {
        console.error(`Failed to create folder segment "${seg}" (${currentPath}):`, e);
        return result; // Return up to the path created so far
      }
    }
    return result;
    });
  }

  /**
   * Creates a new bookmark folder and returns updated folder info.
   * @param title Folder name to create (e.g. 'New Folder' or 'Development/Frontend')
   * @param parentId Parent folder ID (default Bookmarks bar if omitted)
   */
  static async createFolder(title: string, parentId?: string): Promise<FolderItem> {
    const trimmedTitle = (title || '').trim();
    if (!trimmedTitle) {
      throw new Error(i18n.t('folders.nameRequired'));
    }

    if (trimmedTitle.includes('/')) {
      const ensured = await BookmarkManager.ensureFolderPath(trimmedTitle);
      if (ensured) {
        const folders = await BookmarkManager.getFolders();
        const found = folders.find(f => f.id === ensured.id || f.path === ensured.path);
        if (found) return found;
        const leafTitle = trimmedTitle.split('/').pop() || trimmedTitle;
        const depth = (ensured.path.split('/').length || 1) - 1;
        return {
          id: ensured.id,
          title: leafTitle,
          path: ensured.path,
          depth,
          displayName: leafTitle
        };
      }
    }

    let targetParentId = parentId;
    if (!targetParentId) {
      const folders = await BookmarkManager.getFolders();
      const rootFolder = folders.find(f => f.title && f.title.toLowerCase() === 'bookmarks bar')
        ?? folders.find(f => f.parentId === '0' || f.parentId === 'root');
      targetParentId = rootFolder?.id || '1';
    }

    const node = await browser.bookmarks.create({
      parentId: targetParentId,
      title: trimmedTitle
    });

    const folders = await BookmarkManager.getFolders();
    const created = folders.find(f => f.id === node.id);
    if (created) return created;

    const parentFolder = folders.find(f => f.id === targetParentId);
    const calculatedPath = parentFolder?.path ? `${parentFolder.path}/${trimmedTitle}` : trimmedTitle;
    const depth = parentFolder?.depth !== undefined ? parentFolder.depth + 1 : 0;

    return {
      id: node.id,
      title: trimmedTitle,
      path: calculatedPath,
      parentId: targetParentId,
      depth,
      displayName: trimmedTitle
    };
  }

  /**
   * Deletes a bookmark folder.
   */
  static async deleteFolder(folderId: string): Promise<void> {
    if (typeof browser !== 'undefined' && browser.bookmarks?.removeTree) {
      await browser.bookmarks.removeTree(folderId);
    } else if (typeof browser !== 'undefined' && browser.bookmarks?.remove) {
      await browser.bookmarks.remove(folderId);
    }
  }

  /**
   * Renames a bookmark folder.
   */
  static async renameFolder(
    folderId: string,
    newTitle: string
  ): Promise<{ id: string; oldTitle: string; newTitle: string; newPath: string }> {
    const trimmed = (newTitle || '').trim();
    if (!trimmed) {
      throw new Error(i18n.t('folders.nameRequired'));
    }
    if (trimmed.includes('/')) {
      throw new Error(i18n.t('folders.noSlashAllowed'));
    }

    if (folderId === '0' || folderId === 'root') {
      throw new Error(i18n.t('folders.cannotRenameSystemRoot'));
    }

    const folders = await BookmarkManager.getFolders();
    let folder = folders.find(f => f.id === folderId);
    if (!folder && folderId && folderId !== 'undefined') {
      folder = folders.find(f => f.path === folderId || normalizeFolderPath(f.path) === normalizeFolderPath(folderId));
      if (folder) {
        folderId = folder.id;
      }
    }
    if (!folder) {
      throw new Error(`Folder "${folderId}" not found`);
    }

    if (isSystemRootTitle(folder.title) || folder.id === '0' || folder.id === 'root' || !folder.parentId) {
      throw new Error(i18n.t('folders.cannotRenameSystemRoot'));
    }

    const isDuplicate = folders.some(
      f => f.parentId === folder.parentId && f.id !== folderId && f.title.toLowerCase() === trimmed.toLowerCase()
    );
    if (isDuplicate) {
      throw new Error(i18n.t('folders.duplicateName'));
    }

    if (trimmed === folder.title) {
      return { id: folderId, oldTitle: folder.title, newTitle: trimmed, newPath: folder.path };
    }

    if (typeof browser !== 'undefined' && browser.bookmarks?.update) {
      await browser.bookmarks.update(folderId, { title: trimmed });
    }

    await BookmarkManager.syncAll();

    const updatedFolders = await BookmarkManager.getFolders();
    const updated = updatedFolders.find(f => f.id === folderId);

    return {
      id: folderId,
      oldTitle: folder.title,
      newTitle: trimmed,
      newPath: updated?.path || trimmed
    };
  }

  /**
   * Finds all empty folders within the specified target folder (or across the entire bookmark tree if not specified)
   * without deleting them.
   * @param targetFolderId Optional target folder ID to inspect inside. If omitted or null, inspects across all folders.
   * @param targetPath Optional target folder path to match if targetFolderId is not provided.
   * @returns FindEmptyFoldersResult with count of empty folders, empty folder details, topLevel IDs, and paths.
   */
  static async findEmptyFolders(targetFolderId?: string | null, targetPath?: string): Promise<FindEmptyFoldersResult> {
    if (typeof browser === 'undefined' || !browser.bookmarks?.getTree) {
      return { count: 0, emptyFolders: [], topLevelEmptyFolderIds: [], deletedPaths: [] };
    }

    const existingFolders = await BookmarkManager.getFolders();
    const folderMap = new Map<string, FolderItem>();
    for (const f of existingFolders) {
      folderMap.set(f.id, f);
    }

    let effectiveTargetId = targetFolderId;
    if (!effectiveTargetId && targetPath) {
      const found = existingFolders.find(f => f.path === targetPath || normalizeFolderPath(f.path) === normalizeFolderPath(targetPath));
      if (found) effectiveTargetId = found.id;
    }

    let tree: any[] = [];
    try {
      const rawTree = await browser.bookmarks.getTree();
      tree = Array.isArray(rawTree) ? rawTree : (rawTree ? [rawTree] : []);
    } catch (e) {
      console.error('Failed to get bookmark tree for empty folder lookup:', e);
      return { count: 0, emptyFolders: [], topLevelEmptyFolderIds: [], deletedPaths: [] };
    }

    interface SubtreeAnalysis {
      hasBookmarks: boolean;
      allEmptyFolderIds: string[];
      topLevelEmptyFolderIds: string[];
    }

    function analyzeSubtree(node: any, isSystemScope: boolean): SubtreeAnalysis {
      if (!node) {
        return { hasBookmarks: false, allEmptyFolderIds: [], topLevelEmptyFolderIds: [] };
      }

      if (node.url) {
        return {
          hasBookmarks: true,
          allEmptyFolderIds: [],
          topLevelEmptyFolderIds: []
        };
      }

      const isSystemRoot = isSystemScope ||
        node.id === '0' ||
        node.id === 'root' ||
        node.id === 'root________' ||
        isSystemRootTitle(node.title);

      const children = Array.isArray(node.children) ? node.children : [];
      let hasBookmarksInSubtree = false;
      const allEmptyFolderIds: string[] = [];
      const topLevelEmptyFolderIds: string[] = [];

      for (const child of children) {
        const childAnalysis = analyzeSubtree(child, false);
        if (childAnalysis.hasBookmarks) {
          hasBookmarksInSubtree = true;
        }
        allEmptyFolderIds.push(...childAnalysis.allEmptyFolderIds);
        topLevelEmptyFolderIds.push(...childAnalysis.topLevelEmptyFolderIds);
      }

      if (!hasBookmarksInSubtree && !isSystemRoot) {
        allEmptyFolderIds.push(node.id);
        return {
          hasBookmarks: false,
          allEmptyFolderIds,
          topLevelEmptyFolderIds: [node.id]
        };
      }

      return {
        hasBookmarks: hasBookmarksInSubtree,
        allEmptyFolderIds,
        topLevelEmptyFolderIds
      };
    }

    let targetNodes: any[] = [];
    if (effectiveTargetId) {
      function findNodeById(node: any, id: string): any {
        if (!node) return null;
        if (node.id === id) return node;
        if (node.children && Array.isArray(node.children)) {
          for (const child of node.children) {
            const found = findNodeById(child, id);
            if (found) return found;
          }
        }
        return null;
      }

      for (const root of tree) {
        const found = findNodeById(root, effectiveTargetId);
        if (found) {
          targetNodes.push(found);
          break;
        }
      }
    }

    if (targetNodes.length === 0) {
      targetNodes = tree;
    }

    const allDeletedIds: string[] = [];
    const allTopLevelIds: string[] = [];

    for (const startNode of targetNodes) {
      const isSystem = startNode.id === '0' ||
        startNode.id === 'root' ||
        startNode.id === 'root________' ||
        isSystemRootTitle(startNode.title);

      const analysis = analyzeSubtree(startNode, isSystem);
      allDeletedIds.push(...analysis.allEmptyFolderIds);
      allTopLevelIds.push(...analysis.topLevelEmptyFolderIds);
    }

    const emptyFolders: EmptyFolderInfo[] = allDeletedIds.map(id => {
      const item = folderMap.get(id);
      return {
        id,
        title: item?.title || `Folder (${id})`,
        path: item?.path || item?.title || id
      };
    });

    const deletedPaths = emptyFolders.map(f => f.path).filter(Boolean);

    return {
      count: emptyFolders.length,
      emptyFolders,
      topLevelEmptyFolderIds: allTopLevelIds,
      deletedPaths
    };
  }

  /**
   * Cleans up empty folders within the specified target folder (or across the entire bookmark tree if not specified).
   * A folder is considered empty if it contains 0 bookmarks and all its descendants are also empty folders.
   * System root folders (Bookmarks bar, Other bookmarks, etc.) are never deleted.
   * @param targetFolderId Optional target folder ID to clean inside. If omitted or null, cleans across all folders.
   * @param targetPath Optional target folder path to match if targetFolderId is not provided.
   * @returns CleanEmptyFoldersResult with count of deleted folders, their IDs, and paths.
   */
  static async cleanEmptyFolders(targetFolderId?: string | null, targetPath?: string): Promise<CleanEmptyFoldersResult> {
    const preview = await BookmarkManager.findEmptyFolders(targetFolderId, targetPath);
    if (preview.count === 0) {
      return { count: 0, deletedIds: [], deletedPaths: [] };
    }

    for (const topId of preview.topLevelEmptyFolderIds) {
      try {
        if (browser.bookmarks?.removeTree) {
          await browser.bookmarks.removeTree(topId);
        } else if (browser.bookmarks?.remove) {
          await browser.bookmarks.remove(topId);
        }
      } catch (err) {
        console.error(`Failed to delete empty folder ${topId}:`, err);
      }
    }

    await refreshFolderCache();
    try {
      await BookmarkManager.syncAll();
    } catch (err) {
      console.error('Failed to syncAll after cleanEmptyFolders:', err);
    }

    return {
      count: preview.count,
      deletedIds: preview.emptyFolders.map(f => f.id),
      deletedPaths: preview.deletedPaths
    };
  }
}

export interface EmptyFolderInfo {
  id: string;
  title: string;
  path: string;
}

export interface FindEmptyFoldersResult {
  count: number;
  emptyFolders: EmptyFolderInfo[];
  topLevelEmptyFolderIds: string[];
  deletedPaths: string[];
}

export interface CleanEmptyFoldersResult {
  count: number;
  deletedIds: string[];
  deletedPaths: string[];
}

export interface ResolvedFolder {
  id: string;
  path: string;
}

export interface ResolveFolderResult {
  action: 'same-root' | 'cross-root' | 'create-new';
  targetFolder?: ResolvedFolder;
  currentRoot: string;
  targetRoot: string;
  cleanPath: string;
  crossRoot?: boolean;
}

/**
 * Resolves folder suggested by AI compared against current bookmark's root folder (Bookmarks bar / Other bookmarks, etc.).
 *
 * Rules:
 * 1. currentRoot = getRootFolderName(currentFolderPath, folders)
 * 2. If matching folder exists in same-root -> { action: 'same-root', targetFolder, currentRoot, targetRoot: currentRoot, cleanPath }
 * 3. If no match in same-root but matching folder exists in another root (cross-root) -> { action: 'cross-root', targetFolder, currentRoot, targetRoot: matchedFolderRoot, cleanPath, crossRoot: true }
 * 4. If nowhere -> { action: 'create-new', currentRoot, targetRoot: currentRoot, cleanPath }
 */
export async function resolveSuggestedFolderWithRoot(
  suggestedFolderId: string | null,
  suggestedFolderName: string,
  folders: ResolvedFolderInput[],
  currentFolderPath?: string
): Promise<ResolveFolderResult> {
  const currentRoot = getRootFolderName(currentFolderPath, folders);
  const rawName = (suggestedFolderName || '').trim();
  const cleanPath = normalizeFolderPath(rawName).trim() || rawName;

  // Matching helper function
  function matchesFolder(f: ResolvedFolderInput): boolean {
    if (suggestedFolderId && f.id === suggestedFolderId) {
      return true;
    }
    if (!cleanPath) return false;
    const normFPath = normalizeFolderPath(f.path || '').trim();
    if (normFPath && normFPath.toLowerCase() === cleanPath.toLowerCase()) {
      return true;
    }
    // Only allow title / displayName matching between single-level folders
    const isSingleLevel = !cleanPath.includes('/') && !normFPath.includes('/');
    if (isSingleLevel) {
      if (f.title && f.title.trim().toLowerCase() === cleanPath.toLowerCase()) {
        return true;
      }
      if (f.displayName && f.displayName.trim().toLowerCase() === cleanPath.toLowerCase()) {
        return true;
      }
      if (rawName && f.title && f.title.trim().toLowerCase() === rawName.toLowerCase()) {
        return true;
      }
    }
    return false;
  }

  function findBestFolderMatch(folderList: ResolvedFolderInput[]): ResolvedFolderInput | undefined {
    const matches = folderList.filter(f => matchesFolder(f));
    if (matches.length === 0) return undefined;
    if (matches.length === 1) return matches[0];

    // Priority: Entire path match > Root-direct single-level folder > Deep folder (shallower depth first)
    return [...matches].sort((a, b) => {
      const normA = normalizeFolderPath(a.path || a.title || '').trim().toLowerCase();
      const normB = normalizeFolderPath(b.path || b.title || '').trim().toLowerCase();
      const cleanLower = cleanPath.toLowerCase();

      const aExact = normA === cleanLower ? 1 : 0;
      const bExact = normB === cleanLower ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;

      const aSingle = !normA.includes('/') ? 1 : 0;
      const bSingle = !normB.includes('/') ? 1 : 0;
      if (aSingle !== bSingle) return bSingle - aSingle;

      const aDepth = normA.split('/').filter(Boolean).length;
      const bDepth = normB.split('/').filter(Boolean).length;
      return aDepth - bDepth;
    })[0];
  }

  // 1. Highest priority check: match folder already existing in current root (SAME root)!
  //    (Even if AI returned folderId in another root, move immediately without asking if folder with same name/path exists in current root)
  const currentRootFolders = folders.filter(f => {
    const fRoot = getRootFolderName(f.path || f.title, folders);
    return fRoot.toLowerCase() === currentRoot.toLowerCase();
  });
  let sameRootMatch = findBestFolderMatch(currentRootFolders);
  if (!sameRootMatch && cleanPath) {
    sameRootMatch = findFuzzyMatchingFolder(cleanPath, currentRootFolders);
  }

  if (sameRootMatch) {
    return {
      action: 'same-root',
      targetFolder: {
        id: sameRootMatch.id,
        path: sameRootMatch.path || sameRootMatch.title
      },
      currentRoot,
      targetRoot: currentRoot,
      cleanPath
    };
  }

  // 2. If suggestedFolderName is empty and no suggestedFolderId, create-new
  if (!cleanPath && !suggestedFolderId) {
    return {
      action: 'create-new',
      currentRoot,
      targetRoot: currentRoot,
      cleanPath: ''
    };
  }

  // 3. When not in current root, but matching folder exists in ANOTHER root
  let crossRootMatch: ResolvedFolderInput | undefined;
  if (suggestedFolderId) {
    crossRootMatch = folders.find(f => f.id === suggestedFolderId);
  }
  const otherRootFolders = folders.filter(f => {
    const fRoot = getRootFolderName(f.path || f.title, folders);
    return fRoot.toLowerCase() !== currentRoot.toLowerCase();
  });
  if (!crossRootMatch) {
    crossRootMatch = findBestFolderMatch(otherRootFolders);
  }
  if (!crossRootMatch && cleanPath) {
    crossRootMatch = findFuzzyMatchingFolder(cleanPath, otherRootFolders);
  }

  if (crossRootMatch) {
    const targetRoot = getRootFolderName(crossRootMatch.path || crossRootMatch.title, folders);
    return {
      action: 'cross-root',
      targetFolder: {
        id: crossRootMatch.id,
        path: crossRootMatch.path || crossRootMatch.title
      },
      currentRoot,
      targetRoot,
      cleanPath,
      crossRoot: true
    };
  }

  // 4. If in neither root, create new folder in current root
  return {
    action: 'create-new',
    currentRoot,
    targetRoot: currentRoot,
    cleanPath
  };
}

/**
 * Resolves AI suggested folder (suggestedFolderId/suggestedFolderName) to actual browser folder.
 * Shared matching rules between batch categorization (BookmarkList) and background analysis on bookmark addition.
 *
 * Matching order:
 *  1. If suggestedFolderId exists in folders list, use that folder id
 *  2. If suggestedFolderName matches (a) normalized path → (b) single name (title/displayName)
 *  3. Otherwise automatically create hierarchical folders via ensureFolderPath
 *
 * @returns Resolved folder { id, path } or null on match/creation failure
 */
export async function resolveSuggestedFolder(
  suggestedFolderId: string | null,
  suggestedFolderName: string,
  folders: ResolvedFolderInput[]
): Promise<ResolvedFolder | null> {
  if (suggestedFolderId && folders.some(f => f.id === suggestedFolderId)) {
    const matched = folders.find(f => f.id === suggestedFolderId)!;
    return { id: matched.id, path: matched.path || matched.title };
  }
  if (suggestedFolderName && suggestedFolderName.trim()) {
    const name = suggestedFolderName.trim();
    // (a) Normalized path matching ("Major/Minor")
    // Also normalize name → matches normalized path even if AI suggests path including system root ("Bookmarks Bar/Community")
    const byPath = folders.find(f => normalizeFolderPath(f.path || '') === normalizeFolderPath(name));
    if (byPath) return { id: byPath.id, path: byPath.path || byPath.title };
    // (b) Single name matching (title/displayName)
    const byName = folders.find(f => f.title === name || f.displayName === name);
    if (byName) return { id: byName.id, path: byName.path || byName.title };
    // (c) Automatically create hierarchical folders
    try {
      const ensured = await BookmarkManager.ensureFolderPath(name);
      if (ensured) return { id: ensured.id, path: ensured.path };
    } catch (e) {
      console.error('Failed to create folder path:', e);
    }
  }
  return null;
}
