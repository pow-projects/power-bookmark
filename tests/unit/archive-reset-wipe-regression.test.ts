/**
 * Regression test for bug where cloud archives were deleted during drive re-sync after full reset.
 * (Plan: archive-reset-wipe-fix-plan.md — FIX-1/FIX-2 contract)
 *
 * Scenarios:
 *  S1 (FIX-1) syncPendingArchives: missing in local DB + no tombstone (0 bookmarks right after reset)
 *             -> preserve drive files and index entries (deletion propagation prohibited)
 *  S2 (FIX-1) syncPendingArchives: missing in local DB + delete tombstone exists
 *             -> delete file + retain index tombstone (intentional deletion propagation still works)
 *  S3 (FIX-2) BookmarkManager.syncAll: record from another device (bookmarkId='old-9')
 *             fails to match in new tree + unused browser node ('new-3') with same URL exists
 *             -> preserve record, reassign bookmarkId, no archive/deletion propagation
 *
 * Harness: Combines mockAdapter/vi.mock(db) pattern from tests/unit/archive-cloud.test.ts and
 * tests/unit/bookmark-manager.test.ts browser.bookmarks.getTree stub pattern.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { stores, mockAdapter, mockBookmarkGetTree } = vi.hoisted(() => {
  const stores = {
    bookmarks: [] as any[],
    archivedPages: [] as any[],
    settings: new Map<string, any>(),
    nextBookmarkId: 1
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
  return { stores, mockAdapter, mockBookmarkGetTree: vi.fn() };
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
    const id = row.id ?? stores.nextBookmarkId++;
    const idx = arr.findIndex((r: any) => r.id === id);
    if (idx >= 0) arr[idx] = { ...row, id };
    else arr.push({ ...row, id });
    return id;
  };
  table.add = async (row: any) => {
    const id = stores.nextBookmarkId++;
    getArr().push({ ...row, id });
    return id;
  };
  table.update = async (id: number, changes: any) => {
    const arr = getArr();
    const idx = arr.findIndex((r: any) => r.id === id);
    if (idx >= 0) Object.assign(arr[idx], changes);
  };
  table.delete = async (id: number) => {
    const arr = getArr();
    const idx = arr.findIndex((r: any) => r.id === id);
    if (idx >= 0) arr.splice(idx, 1);
  };
  return table;
}

vi.mock('../../src/lib/db', () => {
  const mockDb: any = {
    bookmarks: makeTable('bookmarks'),
    archivedPages: makeTable('archivedPages'),
    syncState: { put: vi.fn(), toArray: async () => [] },
    settings: {
      get: async (key: string) => ({ value: stores.settings.get(key) }),
      put: async (item: { key: string; value: any }) => { stores.settings.set(item.key, item.value); },
      delete: async (key: string) => { stores.settings.delete(key); }
    },
    transaction: async (_m: string, _t: any, fn: () => Promise<void>) => { await fn(); }
  };
  return { db: mockDb, default: mockDb };
});

vi.mock('../../src/lib/sync/sync-engine', () => ({
  SyncEngine: {
    getAdapter: vi.fn().mockResolvedValue(mockAdapter)
  }
}));

// S3: browser.bookmarks API stub required by BookmarkManager
vi.stubGlobal('browser', {
  bookmarks: {
    create: vi.fn(),
    get: vi.fn(),
    getTree: mockBookmarkGetTree,
    move: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    removeTree: vi.fn(),
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onChanged: { addListener: vi.fn() },
    onMoved: { addListener: vi.fn() }
  },
  tabs: { create: vi.fn() }
});

import { syncPendingArchives } from '../../src/lib/archive/archive-cloud';
import { BookmarkManager } from '../../src/lib/bookmarks/bookmark-manager';

function cloudIndexBlob(entries: any[]): Blob {
  return new Blob([JSON.stringify({ version: 1, entries, updatedAt: 1000 })], { type: 'application/json' });
}

function findIndexWrite(entriesWritten: boolean): { call: any[] } | undefined {
  const call = mockAdapter.writeBinaryFile.mock.calls.find((c: any[]) => c[0] === 'archives/index.json');
  return call ? { call } : undefined;
}

describe('완전 초기화 후 클라우드 아카이브 소실 회귀 (archive-reset-wipe)', () => {
  beforeEach(() => {
    stores.bookmarks = [];
    stores.archivedPages = [];
    stores.settings.clear();
    stores.nextBookmarkId = 1;
    vi.clearAllMocks();
    stores.settings.set('sync_archive_to_cloud', true);
  });

  describe('S1 — FIX-1: tombstone 없는 고아 엔트리는 삭제 전파 금지', () => {
    it('로컬 DB 0북마크·tombstone 없음 → 드라이브 파일 유지 + index 엔트리 deleted 미설정', async () => {
      // No local bookmarks (right after full reset), no tombstones (never deleted)
      mockAdapter.readBinaryFile.mockImplementation(async (path: string) => {
        if (path === 'archives/index.json') {
          return cloudIndexBlob([{
            syncId: 'sync-cloud-keep', bookmarkId: 'bk-from-other-device', url: 'https://keep.com', title: 'Keep',
            fileName: 'sync-cloud-keep.html', fileSize: 100, format: 'raw', archivedAt: 1000
          }]);
        }
        return new Blob(['<html>archive</html>']);
      });
      mockAdapter.deleteFile.mockResolvedValue(undefined);
      mockAdapter.getLastModified.mockResolvedValue(5000);

      await syncPendingArchives();

      // Contract 1: Cloud archive files must not be deleted
      expect(mockAdapter.deleteFile).not.toHaveBeenCalledWith('archives/sync-cloud-keep.html');
      // Contract 2: Tombstone (deleted:true) must not be recorded in index entries
      const idx = findIndexWrite(true);
      if (idx) {
        await expect(idx.call[1].text()).resolves.not.toContain('"deleted":true');
      }
    });
  });

  describe('S2 — FIX-1: 삭제 의도(tombstone)가 있으면 전파 유지', () => {
    it('로컬 DB 부재 + 삭제 tombstone 존재 → 파일 삭제 + index tombstone 기록', async () => {
      stores.settings.set('sync_tombstones', [{ syncId: 'sync-deliberate', deletedAt: 500 }]);
      mockAdapter.readBinaryFile.mockImplementation(async (path: string) => {
        if (path === 'archives/index.json') {
          return cloudIndexBlob([{
            syncId: 'sync-deliberate', bookmarkId: 'bk-del', url: 'https://gone.com', title: 'Gone',
            fileName: 'sync-deliberate.html', fileSize: 50, format: 'raw', archivedAt: 1000
          }]);
        }
        return new Blob(['x']);
      });
      mockAdapter.deleteFile.mockResolvedValue(undefined);
      mockAdapter.getLastModified.mockResolvedValue(5000);

      await syncPendingArchives();

      expect(mockAdapter.deleteFile).toHaveBeenCalledWith('archives/sync-deliberate.html');
      const idx = findIndexWrite(true);
      expect(idx).toBeDefined();
      await expect(idx!.call[1].text()).resolves.toContain('"deleted":true');
    });
  });

  describe('S3 — FIX-2: syncAll 미사용 레코드 삭제 전 동일 URL 노드 재입양', () => {
    it('bookmarkId stale(old-9) + 동일 URL 미사용 브라우저 노드(new-3) → 레코드 보존·bookmarkId 갱신·아카이브 삭제 없음', async () => {
      // Record restored from another device: bookmarkId is from old device, mismatching new tree (re-indexed IDs)
      stores.bookmarks.push({
        id: 1,
        syncId: 'sync-carry-over',
        bookmarkId: 'old-9',
        url: 'https://carry-over.com',
        title: 'Carry Over',
        folderPath: 'Bookmarks Bar',
        createdAt: 100,
        modifiedAt: 100,
        visitCount: 0
      });
      // Other bookmark for fail-safe bypass (matches new tree normally)
      stores.bookmarks.push({
        id: 2,
        syncId: 'sync-other',
        bookmarkId: 'bk-other',
        url: 'https://other.com',
        title: 'Other',
        folderPath: 'Bookmarks Bar',
        createdAt: 100,
        modifiedAt: 100,
        visitCount: 0
      });
      // Local archive row attached to record 1
      stores.archivedPages.push({
        id: 70, bookmarkId: 1, url: 'https://carry-over.com',
        htmlBlob: new Blob(['<html>a</html>'], { type: 'text/html' }), fileSize: 11, archivedAt: 1000
      });

      mockBookmarkGetTree.mockResolvedValue([{
        id: '0',
        title: 'root',
        children: [
          {
            id: '1',
            title: 'Bookmarks Bar',
            children: [
              { id: 'new-3', parentId: '1', title: 'Carry Over', url: 'https://carry-over.com', dateAdded: 500 },
              { id: 'bk-other', parentId: '1', title: 'Other', url: 'https://other.com', dateAdded: 500 }
            ]
          }
        ]
      }]);

      await BookmarkManager.syncAll();

      // Contract 1: Record preserved
      const kept = stores.bookmarks.find((b) => b.syncId === 'sync-carry-over');
      expect(kept).toBeDefined();
      // Contract 2: bookmarkId reassigned
      expect(kept.bookmarkId).toBe('new-3');
      // Contract 3: Archive row preserved
      expect(stores.archivedPages.find((r) => r.id === 70)).toBeDefined();
      // Contract 4: Deletion propagation (tombstone) unrecorded
      const tombstones = stores.settings.get('sync_tombstones');
      expect(Array.isArray(tombstones) ? tombstones.filter((t: any) => t.syncId === 'sync-carry-over') : []).toHaveLength(0);
    });
  });
});
