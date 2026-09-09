import Dexie, { type Table } from 'dexie';
import type { AiJob } from './ai/queue-types';
import { sanitizeTags } from './bookmarks/tag-utils';

export interface CrossRootReviewData {
  currentRoot?: string;
  currentFolderPath?: string;
  suggestedRoot: string;
  suggestedFolderId?: string;
  suggestedFolderName?: string;
  suggestedFolderPath?: string;
  cleanPath: string;
}

export interface Bookmark {
  id?: number;
  syncId: string; // Globally unique sync key (UUID, immutable)
  bookmarkId: string; // Browser built-in bookmark ID (device local, bridge)
  url: string;
  title: string;
  description: string;
  folderPath: string; // e.g. "Bookmarks bar/Development/Frontend"
  createdAt: number;
  modifiedAt: number;
  syncedAt?: number; // Local-only sync completion timestamp (excluded from cloud serialization)
  lastCheckedAt?: number; // 404 last checked timestamp
  httpStatus?: number; // 200, 404, etc.
  visitCount: number;
  tags?: string[];
  aiStatus?: 'none' | 'pending' | 'running' | 'done' | 'error'; // AI analysis status (for indicating background analysis progress)
  crossRootReview?: CrossRootReviewData; // Pending review data for AI cross-root folder move
}

export interface ArchivedPage {
  id?: number;
  bookmarkId: number; // Internal DB bookmark id
  url: string;
  htmlBlob: Blob; // Archived HTML Blob data
  fileSize: number;
  archivedAt: number;
}

export interface SyncState {
  id?: number;
  provider: 'google-drive' | 'onedrive' | 'dropbox' | 'webdav' | 'none';
  lastSyncAt: number;
  syncToken?: string;
  status: 'idle' | 'syncing' | 'error';
}

export interface Stats {
  id?: number;
  url: string;
  host: string;
  visitedAt: number;
  duration: number; // Visit duration (ms)
}

export interface Setting {
  key: string;
  value: any;
}

export class PowerBookmarkDatabase extends Dexie {
  bookmarks!: Table<Bookmark>;
  archivedPages!: Table<ArchivedPage>;
  syncState!: Table<SyncState>;
  stats!: Table<Stats>;
  settings!: Table<Setting>;
  aiJobs!: Table<AiJob>;

  constructor() {
    super('PowerBookmark');
    
    this.version(1).stores({
      bookmarks: '++id, browserBookmarkId, url, title, description, folderPath, createdAt, modifiedAt, lastCheckedAt, httpStatus, visitCount, [url+browserBookmarkId]',
      archivedPages: '++id, bookmarkId, url, fileSize, archivedAt',
      syncState: '++id, provider, lastSyncAt, status',
      stats: '++id, url, host, visitedAt',
      settings: 'key'
    });

    this.version(2).stores({
      bookmarks: '++id, &browserBookmarkId, url, title, description, folderPath, createdAt, modifiedAt, lastCheckedAt, httpStatus, visitCount, [url+browserBookmarkId]',
      archivedPages: '++id, bookmarkId, url, fileSize, archivedAt',
      syncState: '++id, provider, lastSyncAt, status',
      stats: '++id, url, host, visitedAt',
      settings: 'key'
    }).upgrade(async (tx) => {
      // Remove duplicate browserBookmarkId rows (keep only the first row)
      const seen = new Map<string, number>(); // browserBookmarkId → keep-row id
      await tx.table('bookmarks').each((row: any) => {
        seen.set(row.browserBookmarkId, row.id);
      });
      // Collect duplicate rows (remaining id at the end is not the first one)
      const allRows = await tx.table('bookmarks').toArray();
      const dupes = allRows.filter((row: any) => seen.get(row.browserBookmarkId) !== row.id);
      for (const dupe of dupes) {
        await tx.table('archivedPages').where('bookmarkId').equals(dupe.id).delete();
        await tx.table('bookmarks').delete(dupe.id);
      }
    });

    this.version(3).stores({
      bookmarks: '++id, &browserBookmarkId, url, title, description, folderPath, createdAt, modifiedAt, lastCheckedAt, httpStatus, visitCount, [url+browserBookmarkId]',
      archivedPages: '++id, bookmarkId, url, fileSize, archivedAt',
      syncState: '++id, provider, lastSyncAt, status',
      stats: '++id, url, host, visitedAt',
      settings: 'key'
    }).upgrade(async (tx) => {
      // Consolidate aiSummary → description: fill description with aiSummary value if empty, then remove aiSummary field
      await tx.table('bookmarks').toCollection().modify((row: any) => {
        row.description = row.aiSummary || row.description;
        delete row.aiSummary;
      });
    });

    this.version(4).stores({
      bookmarks: '++id, &browserBookmarkId, url, title, description, folderPath, createdAt, modifiedAt, lastCheckedAt, httpStatus, visitCount, [url+browserBookmarkId]',
      archivedPages: '++id, bookmarkId, url, fileSize, archivedAt',
      syncState: '++id, provider, lastSyncAt, status',
      stats: '++id, url, host, visitedAt',
      settings: 'key'
    }).upgrade(async (tx) => {
      // Remove aiCategory field (2026-08-13) + physical cleanup of legacy residual aiSummary — keep only folderPath (directory) for permanent categorization
      await tx.table('bookmarks').toCollection().modify((row: any) => {
        delete row.aiCategory;
        delete row.aiSummary;
      });
    });

    this.version(5).stores({
      bookmarks: '++id, &browserBookmarkId, url, title, description, folderPath, createdAt, modifiedAt, lastCheckedAt, httpStatus, visitCount, [url+browserBookmarkId]',
      archivedPages: '++id, bookmarkId, url, fileSize, archivedAt',
      syncState: '++id, provider, lastSyncAt, status',
      stats: '++id, url, host, visitedAt',
      settings: 'key'
    }).upgrade(async (tx) => {
      // Rename aiTags → tags field (2026-08-13): migrate existing IndexedDB aiTags values to tags and remove aiTags key
      await tx.table('bookmarks').toCollection().modify((row: any) => {
        row.tags = row.aiTags;
        delete row.aiTags;
      });
    });

    this.version(6).stores({
      bookmarks: '++id, &browserBookmarkId, &syncId, url, title, description, folderPath, createdAt, modifiedAt, lastCheckedAt, httpStatus, visitCount, [url+browserBookmarkId]',
      archivedPages: '++id, bookmarkId, url, fileSize, archivedAt',
      syncState: '++id, provider, lastSyncAt, status',
      stats: '++id, url, host, visitedAt',
      settings: 'key'
    }).upgrade(async (tx) => {
      // Introduce syncId (2026-08-13): backfill with randomUUID() without preserving links since existing sample data is discarded.
      // (&syncId unique index — no duplicates occur with randomUUID())
      await tx.table('bookmarks').toCollection().modify((row: any) => {
        row.syncId = crypto.randomUUID();
      });
    });

    this.version(7).stores({
      bookmarks: '++id, &bookmarkId, &syncId, url, title, description, folderPath, createdAt, modifiedAt, lastCheckedAt, httpStatus, visitCount, [url+bookmarkId]',
      archivedPages: '++id, bookmarkId, url, fileSize, archivedAt',
      syncState: '++id, provider, lastSyncAt, status',
      stats: '++id, url, host, visitedAt',
      settings: 'key'
    }).upgrade(async (tx) => {
      // Rename browserBookmarkId → bookmarkId field (2026-08-13)
      await tx.table('bookmarks').toCollection().modify((row: any) => {
        row.bookmarkId = row.browserBookmarkId;
        delete row.browserBookmarkId;
      });
    });

    this.version(8).stores({
      bookmarks: '++id, &bookmarkId, &syncId, url, title, description, folderPath, createdAt, modifiedAt, lastCheckedAt, httpStatus, visitCount, [url+bookmarkId]',
      archivedPages: '++id, bookmarkId, url, fileSize, archivedAt',
      syncState: '++id, provider, lastSyncAt, status',
      stats: '++id, url, host, visitedAt',
      settings: 'key',
      aiJobs: 'id, bookmarkId, kind, status, createdAt, [bookmarkId+kind]'
    });
    // aiJobs is a new volatile job store — no migration needed for existing bookmark data (only adds new table).
    // id (UUID string) is the primary key, [bookmarkId+kind] compound index is for dedup lookup.

    this.version(9).stores({
      bookmarks: '++id, &bookmarkId, &syncId, url, title, description, folderPath, createdAt, modifiedAt, syncedAt, lastCheckedAt, httpStatus, visitCount, [url+bookmarkId]',
      archivedPages: '++id, bookmarkId, url, fileSize, archivedAt',
      syncState: '++id, provider, lastSyncAt, status',
      stats: '++id, url, host, visitedAt',
      settings: 'key',
      aiJobs: 'id, bookmarkId, kind, status, createdAt, [bookmarkId+kind]'
    }).upgrade(async (tx) => {
      // Introduce syncedAt field: backfill syncedAt for records with modifiedAt <= lastSyncAt if a successful prior sync record exists
      const syncStates = (await tx.table('syncState').toArray()) || [];
      const successful = syncStates.filter((s: any) => s.status === 'idle' && typeof s.lastSyncAt === 'number' && s.lastSyncAt > 0);
      const latestSyncAt = successful.length > 0 ? Math.max(...successful.map((s: any) => s.lastSyncAt)) : 0;

      await tx.table('bookmarks').toCollection().modify((row: any) => {
        row.createdAt = row.createdAt || row.modifiedAt || Date.now();
        row.modifiedAt = row.modifiedAt || row.createdAt || Date.now();
        if (latestSyncAt > 0 && row.modifiedAt <= latestSyncAt) {
          row.syncedAt = latestSyncAt;
        }
      });
    });

    this.version(10).stores({
      bookmarks: '++id, &bookmarkId, &syncId, url, title, description, folderPath, createdAt, modifiedAt, syncedAt, lastCheckedAt, httpStatus, visitCount, [url+bookmarkId]',
      archivedPages: '++id, bookmarkId, url, fileSize, archivedAt',
      syncState: '++id, provider, lastSyncAt, status',
      stats: '++id, url, host, visitedAt',
      settings: 'key',
      aiJobs: 'id, bookmarkId, kind, status, createdAt, [bookmarkId+kind]'
    }).upgrade(async (tx) => {
      // Clean up whitespace in existing bookmark tags (2026-09-08)
      await tx.table('bookmarks').toCollection().modify((row: any) => {
        if (row.tags && Array.isArray(row.tags)) {
          row.tags = sanitizeTags(row.tags);
        }
      });
    });
  }
}

export const db = new PowerBookmarkDatabase();

// If opened with a higher version in another context (popup/management page),
// immediately close the connection in the current context to prevent versionchange AbortError
db.on('versionchange', () => {
  db.close();
});

export default db;
