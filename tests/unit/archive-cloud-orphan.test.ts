import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  scanOrphanCloudArchives,
  fetchOrphanArchiveHtml,
  deleteOrphanCloudArchives,
  type ArchiveIndexEntry
} from '../../src/lib/archive/archive-cloud';
import { ARCHIVES_FOLDER, ARCHIVE_INDEX_FILE } from '../../src/lib/archive/archive-index';

const { stores, mockAdapter } = vi.hoisted(() => {
  const stores = {
    bookmarks: [] as any[],
    archivedPages: [] as any[],
    syncStates: [] as any[],
    settings: new Map<string, any>(),
    nextId: 1
  };
  const mockAdapter = {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    getLastModified: vi.fn(),
    ensureFolder: vi.fn(),
    writeBinaryFile: vi.fn(),
    readBinaryFile: vi.fn(),
    deleteFile: vi.fn(),
    authenticate: vi.fn(),
    revoke: vi.fn(),
    listFiles: vi.fn()
  };
  return { stores, mockAdapter };
});

function makeTable(key: 'bookmarks' | 'archivedPages') {
  const getArr = () => stores[key];
  const table: any = {};
  table.where = (idx: string) => ({
    equals(val: any) {
      return {
        first: async () => getArr().find((r: any) => r[idx] === val),
        toArray: async () => getArr().filter((r: any) => r[idx] === val),
        delete: async () => {
          const arr = getArr();
          for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i][idx] === val) arr.splice(i, 1);
          }
        }
      };
    }
  });
  table.first = async () => getArr()[0];
  table.toArray = async () => [...getArr()];
  table.get = async (id: number) => getArr().find((r: any) => r.id === id);
  table.put = async (row: any) => {
    const arr = getArr();
    const id = row.id ?? stores.nextId++;
    const idx = arr.findIndex((r: any) => r.id === id);
    if (idx >= 0) arr[idx] = { ...row, id };
    else arr.push({ ...row, id });
    return id;
  };
  return table;
}

vi.mock('../../src/lib/db', () => {
  const mockDb: any = {
    bookmarks: makeTable('bookmarks'),
    archivedPages: makeTable('archivedPages'),
    syncState: {
      put: vi.fn(async (s) => { stores.syncStates.push(s); }),
      toArray: async () => [...stores.syncStates],
      orderBy: (_col: string) => ({
        last: async () => stores.syncStates[stores.syncStates.length - 1]
      })
    },
    settings: {
      get: async (key: string) => ({ value: stores.settings.get(key) }),
      put: async (item: { key: string; value: any }) => { stores.settings.set(item.key, item.value); },
      delete: async (key: string) => { stores.settings.delete(key); }
    }
  };
  return { db: mockDb, default: mockDb };
});

vi.mock('../../src/lib/sync/sync-engine', () => ({
  SyncEngine: {
    getAdapter: vi.fn().mockResolvedValue(mockAdapter)
  }
}));

describe('archive-cloud orphan management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stores.bookmarks = [];
    stores.archivedPages = [];
    stores.syncStates = [{ id: 1, provider: 'google-drive', lastSyncAt: Date.now() - 1000, status: 'idle' }];
    stores.settings.clear();
    stores.settings.set('sync_archive_to_cloud', true);

    // Default mock adapter responses
    mockAdapter.getLastModified.mockResolvedValue(1000);
    mockAdapter.ensureFolder.mockResolvedValue(undefined);
    mockAdapter.writeBinaryFile.mockResolvedValue(undefined);
    mockAdapter.deleteFile.mockResolvedValue(undefined);
  });

  describe('scanOrphanCloudArchives', () => {
    it('throws SYNC_IN_PROGRESS when sync status is syncing', async () => {
      stores.syncStates = [{ id: 1, provider: 'google-drive', lastSyncAt: Date.now(), status: 'syncing' }];
      await expect(scanOrphanCloudArchives()).rejects.toThrow('SYNC_IN_PROGRESS');
    });

    it('throws SYNC_ERROR_STATE when sync status is error unless force is true', async () => {
      stores.syncStates = [{ id: 1, provider: 'google-drive', lastSyncAt: Date.now(), status: 'error' }];
      await expect(scanOrphanCloudArchives()).rejects.toThrow('SYNC_ERROR_STATE');
      // With force: true, does not throw SYNC_ERROR_STATE
      mockAdapter.readBinaryFile.mockResolvedValue(
        new Blob([JSON.stringify({ version: 1, entries: [], updatedAt: Date.now() })])
      );
      const res = await scanOrphanCloudArchives({ force: true });
      expect(res).toEqual([]);
    });

    it('throws SYNC_NOT_SYNCED when lastSyncAt is missing or zero', async () => {
      stores.syncStates = [{ id: 1, provider: 'google-drive', lastSyncAt: 0, status: 'idle' }];
      await expect(scanOrphanCloudArchives()).rejects.toThrow('SYNC_NOT_SYNCED');
    });

    it('detects orphan entries that do not match local bookmarks by syncId or url', async () => {
      // Local bookmark exists for sync-1 and url https://example.com/matched
      stores.bookmarks = [
        { id: 1, syncId: 'sync-1', url: 'https://example.com/one', title: 'One' },
        { id: 2, syncId: 'sync-2', url: 'https://example.com/matched/', title: 'Two' }
      ];

      const entries: ArchiveIndexEntry[] = [
        {
          syncId: 'sync-1',
          bookmarkId: '1',
          url: 'https://example.com/one',
          title: 'One',
          fileName: 'sync-1.html',
          fileSize: 100,
          format: 'raw',
          archivedAt: Date.now()
        },
        {
          syncId: 'sync-diff-url',
          bookmarkId: '99',
          url: 'https://example.com/matched', // matches bookmark 2 by normalized url
          title: 'Two',
          fileName: 'sync-diff-url.html',
          fileSize: 200,
          format: 'raw',
          archivedAt: Date.now()
        },
        {
          syncId: 'orphan-1',
          bookmarkId: '3',
          url: 'https://orphan.example.com',
          title: 'Orphan 1',
          fileName: 'orphan-1.html',
          fileSize: 500,
          format: 'raw',
          archivedAt: Date.now()
        },
        {
          syncId: 'deleted-1',
          bookmarkId: '4',
          url: 'https://deleted.example.com',
          title: 'Deleted',
          fileName: 'deleted-1.html',
          fileSize: 500,
          format: 'raw',
          archivedAt: Date.now(),
          deleted: true
        }
      ];

      mockAdapter.readBinaryFile.mockResolvedValue(
        new Blob([JSON.stringify({ version: 1, entries, updatedAt: Date.now() })])
      );

      const orphans = await scanOrphanCloudArchives();
      expect(orphans).toHaveLength(1);
      expect(orphans[0].syncId).toBe('orphan-1');
      expect(orphans[0].title).toBe('Orphan 1');

      // Invariant check: scan must be strictly read-only
      expect(mockAdapter.deleteFile).not.toHaveBeenCalled();
      expect(mockAdapter.writeBinaryFile).not.toHaveBeenCalled();
    });
  });

  describe('fetchOrphanArchiveHtml', () => {
    it('downloads and returns decompressed HTML text from cloud storage', async () => {
      const entries: ArchiveIndexEntry[] = [
        {
          syncId: 'orphan-1',
          bookmarkId: '3',
          url: 'https://orphan.example.com',
          title: 'Orphan 1',
          fileName: 'orphan-1.html',
          fileSize: 500,
          format: 'raw',
          archivedAt: Date.now()
        }
      ];

      mockAdapter.readBinaryFile.mockImplementation(async (path: string) => {
        if (path === `${ARCHIVES_FOLDER}/${ARCHIVE_INDEX_FILE}`) {
          return new Blob([JSON.stringify({ version: 1, entries, updatedAt: Date.now() })]);
        }
        if (path === `${ARCHIVES_FOLDER}/orphan-1.html`) {
          return new Blob(['<!DOCTYPE html><html><body><h1>Saved Archive</h1></body></html>']);
        }
        throw new Error('Not found');
      });

      const html = await fetchOrphanArchiveHtml('orphan-1');
      expect(html).toContain('<h1>Saved Archive</h1>');
      // Must not insert into local db.archivedPages (no local bookmark foreign key)
      expect(stores.archivedPages).toHaveLength(0);
    });
  });

  describe('deleteOrphanCloudArchives', () => {
    it('deletes selected cloud files, updates index.json, and refreshes cache', async () => {
      const entries: ArchiveIndexEntry[] = [
        {
          syncId: 'orphan-1',
          bookmarkId: '1',
          url: 'https://orphan1.com',
          title: 'Orphan 1',
          fileName: 'orphan-1.html',
          fileSize: 500,
          format: 'raw',
          archivedAt: Date.now()
        },
        {
          syncId: 'orphan-2',
          bookmarkId: '2',
          url: 'https://orphan2.com',
          title: 'Orphan 2',
          fileName: 'orphan-2.html',
          fileSize: 600,
          format: 'raw',
          archivedAt: Date.now()
        }
      ];

      mockAdapter.readBinaryFile.mockResolvedValue(
        new Blob([JSON.stringify({ version: 1, entries, updatedAt: 1000 })])
      );

      const progressSpy = vi.fn();
      const result = await deleteOrphanCloudArchives(['orphan-1'], progressSpy);

      expect(result.successCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(progressSpy).toHaveBeenCalledWith(1, 1);
      expect(mockAdapter.deleteFile).toHaveBeenCalledWith(`${ARCHIVES_FOLDER}/orphan-1.html`);

      // Verify index.json was written with tombstone
      expect(mockAdapter.writeBinaryFile).toHaveBeenCalledTimes(1);
      const writtenBlob = mockAdapter.writeBinaryFile.mock.calls[0][1] as Blob;
      const writtenText = await writtenBlob.text();
      const parsed = JSON.parse(writtenText);
      const deletedEntry = parsed.entries.find((e: any) => e.syncId === 'orphan-1');
      expect(deletedEntry.deleted).toBe(true);
      expect(deletedEntry.deletedAt).toBeGreaterThan(0);

      // Verify cloud_archive_index setting was updated without the deleted entry
      const cached = stores.settings.get('cloud_archive_index');
      expect(cached).toHaveLength(1);
      expect(cached[0].syncId).toBe('orphan-2');
    });

    it('treats 404 on deleteFile as idempotent success and marks index deleted', async () => {
      const entries: ArchiveIndexEntry[] = [
        {
          syncId: 'orphan-missing',
          bookmarkId: '1',
          url: 'https://missing.com',
          title: 'Missing',
          fileName: 'orphan-missing.html',
          fileSize: 500,
          format: 'raw',
          archivedAt: Date.now()
        }
      ];

      mockAdapter.readBinaryFile.mockResolvedValue(
        new Blob([JSON.stringify({ version: 1, entries, updatedAt: 1000 })])
      );
      // Simulate 404 on deleteFile
      mockAdapter.deleteFile.mockRejectedValue({ status: 404, message: 'File not found' });

      const result = await deleteOrphanCloudArchives(['orphan-missing']);
      expect(result.successCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(mockAdapter.writeBinaryFile).toHaveBeenCalledTimes(1);
    });
  });
});
