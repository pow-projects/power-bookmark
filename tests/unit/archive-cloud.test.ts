import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { stores, mockAdapter } = vi.hoisted(() => {
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
    listFiles: vi.fn(),
    readFileStr: undefined
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
        toArray: async () => getArr().filter((r: any) => r[idx] === val)
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
  return table;
}

vi.mock('../../src/lib/db', () => {
  const mockDb: any = {
    bookmarks: makeTable('bookmarks'),
    archivedPages: makeTable('archivedPages'),
    syncState: { put: vi.fn(), toArray: async () => [] },
    settings: {
      get: async (key: string) => ({ value: stores.settings.get(key) }),
      put: async (item: { key: string; value: any }) => { stores.settings.set(item.key, item.value); }
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

import {
  isArchiveCloudEnabled,
  classifyArchiveSize,
  classifyArchiveError,
  retry,
  syncArchiveToCloudByBookmarkId,
  syncPendingArchives,
  deleteArchiveFromCloud,
  restoreArchivesFromCloud,
  getCloudArchiveIndexCache,
  refreshCloudArchiveIndex,
  getArchiveTombstones
} from '../../src/lib/archive/archive-cloud';

describe('archive-cloud (아카이브 클라우드 조정자)', () => {
  beforeEach(() => {
    stores.bookmarks = [];
    stores.archivedPages = [];
    stores.settings.clear();
    stores.nextBookmarkId = 1;
    vi.clearAllMocks();
    // Default: Archive cloud sync enabled
    stores.settings.set('sync_archive_to_cloud', true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('isArchiveCloudEnabled', () => {
    it('sync_archive_to_cloud === true → true', async () => {
      stores.settings.set('sync_archive_to_cloud', true);
      expect(await isArchiveCloudEnabled()).toBe(true);
    });
    it('false → false, 부재 시 기본값 → true', async () => {
      stores.settings.set('sync_archive_to_cloud', false);
      expect(await isArchiveCloudEnabled()).toBe(false);
      stores.settings.delete('sync_archive_to_cloud');
      expect(await isArchiveCloudEnabled()).toBe(true);
    });
  });

  describe('classifyArchiveSize', () => {
    it('소프트(50MiB) 미만 → ok', async () => {
      expect(await classifyArchiveSize(10 * 1024 * 1024)).toBe('ok');
    });
    it('소프트 한도 이상·하드 미만 → soft-exceed', async () => {
      expect(await classifyArchiveSize(50 * 1024 * 1024)).toBe('soft-exceed');
    });
    it('하드 한도 기본값은 Infinity(무제한) → 200MiB 이상도 soft-exceed로 통과', async () => {
      expect(await classifyArchiveSize(200 * 1024 * 1024)).toBe('soft-exceed');
      expect(await classifyArchiveSize(300 * 1024 * 1024)).toBe('soft-exceed');
    });
    it('설정으로 한도 재정의 가능', async () => {
      stores.settings.set('archive_upload_soft_limit', 1024);
      stores.settings.set('archive_upload_hard_limit', 2048);
      expect(await classifyArchiveSize(512)).toBe('ok');
      expect(await classifyArchiveSize(1500)).toBe('soft-exceed');
      expect(await classifyArchiveSize(3000)).toBe('hard-exceed');
    });
  });

  describe('classifyArchiveError', () => {
    it('401/403 → auth', () => {
      expect(classifyArchiveError({ status: 401, message: 'unauthorized' })).toBe('auth');
      expect(classifyArchiveError({ status: 403 })).toBe('auth');
    });
    it('429/5xx/네트워크 → transient', () => {
      expect(classifyArchiveError({ status: 429 })).toBe('transient');
      expect(classifyArchiveError({ status: 502 })).toBe('transient');
      expect(classifyArchiveError({ name: 'TypeError', message: 'Failed to fetch' })).toBe('transient');
    });
    it('507/413/quota → quota', () => {
      expect(classifyArchiveError({ status: 507 })).toBe('quota');
      expect(classifyArchiveError({ status: 413 })).toBe('quota');
      expect(classifyArchiveError({ message: 'insufficient_space in quota' })).toBe('quota');
    });
    it('그 외 → permanent', () => {
      expect(classifyArchiveError({ status: 400 })).toBe('permanent');
      expect(classifyArchiveError({ message: 'invalid request' })).toBe('permanent');
    });
  });

  describe('retry', () => {
    it('transient는 지수 백오프 후 재시도, 성공 시 통과', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce({ status: 500 })
        .mockResolvedValueOnce(undefined);
      await expect(retry(fn, classifyArchiveError)).resolves.toBeUndefined();
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('transient 3회 실패 → throw', async () => {
      const fn = vi.fn().mockRejectedValue({ status: 503 });
      await expect(retry(fn, classifyArchiveError)).rejects.toBeTruthy();
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('permanent는 즉시 throw (재시도 없음)', async () => {
      const fn = vi.fn().mockRejectedValue({ status: 400 });
      await expect(retry(fn, classifyArchiveError)).rejects.toBeTruthy();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('auth는 authenticate(true) 1회 후 재시도, 성공 시 통과', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce({ status: 401 })
        .mockResolvedValueOnce(undefined);
      mockAdapter.authenticate.mockResolvedValue(undefined);
      await expect(retry(fn, classifyArchiveError, mockAdapter)).resolves.toBeUndefined();
      expect(mockAdapter.authenticate).toHaveBeenCalledWith(true);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('auth 재인증 실패 시 원래 오류 throw', async () => {
      const fn = vi.fn().mockRejectedValue({ status: 401 });
      mockAdapter.authenticate.mockRejectedValue(new Error('re-auth failed'));
      await expect(retry(fn, classifyArchiveError, mockAdapter)).rejects.toEqual({ status: 401 });
    });
  });

  describe('syncArchiveToCloudByBookmarkId', () => {
    beforeEach(() => {
      stores.bookmarks.push({ id: 1, syncId: 'sync-1', bookmarkId: 'bk-1', title: 'Example', url: 'https://example.com' });
      stores.archivedPages.push({
        id: 1, bookmarkId: 1, url: 'https://example.com',
        htmlBlob: new Blob(['<html>hi</html>'], { type: 'text/html' }),
        fileSize: 15, archivedAt: 1000
      });
      // No cloud index -> empty index (use folder-aware readBinaryFile)
      mockAdapter.readBinaryFile.mockRejectedValue(new Error('File not found'));
      mockAdapter.getLastModified.mockResolvedValue(5000); // base == current (no conflict)
      mockAdapter.ensureFolder.mockResolvedValue(undefined);
      mockAdapter.writeBinaryFile.mockResolvedValue(undefined);
    });

    it('업로드 성공: ensureFolder → writeBinaryFile(html) → index 원자 갱신 (folder-aware)', async () => {
      await syncArchiveToCloudByBookmarkId(1);

      expect(mockAdapter.ensureFolder).toHaveBeenCalledWith('archives');
      expect(mockAdapter.writeBinaryFile).toHaveBeenCalledWith(
        'archives/sync-1.html',
        expect.any(Blob),
        'text/html'
      );
      // Save index.json with folder-aware binary write (C-3) — writeBinaryFile instead of flat writeFile
      expect(mockAdapter.writeFile).not.toHaveBeenCalledWith('archives/index.json', expect.any(String));
      const idxWrite = mockAdapter.writeBinaryFile.mock.calls.find((c) => c[0] === 'archives/index.json');
      expect(idxWrite).toBeDefined();
      expect(idxWrite[2]).toBe('application/json');
      await expect(idxWrite[1].text()).resolves.toContain('"syncId":"sync-1"');
    });

    it('설정 OFF → 아무 작업 없음 (AC-6)', async () => {
      stores.settings.set('sync_archive_to_cloud', false);
      await syncArchiveToCloudByBookmarkId(1);
      expect(mockAdapter.writeBinaryFile).not.toHaveBeenCalled();
      expect(mockAdapter.writeFile).not.toHaveBeenCalled();
    });

    it('provider=none → 아무 작업 없음 (EC-1)', async () => {
      vi.mocked(await import('../../src/lib/sync/sync-engine')).SyncEngine.getAdapter.mockResolvedValueOnce(null);
      await syncArchiveToCloudByBookmarkId(1);
      expect(mockAdapter.writeBinaryFile).not.toHaveBeenCalled();
    });

    it('하드 한도 설정 시 초과 → 업로드 전 거부 + 오류 상태 (AC-4)', async () => {
      stores.settings.set('archive_upload_hard_limit', 200 * 1024 * 1024);
      stores.archivedPages[0].fileSize = 500 * 1024 * 1024; // > 200MiB
      await syncArchiveToCloudByBookmarkId(1);
      expect(mockAdapter.ensureFolder).not.toHaveBeenCalled();
      expect(mockAdapter.writeBinaryFile).not.toHaveBeenCalled();
      expect(mockAdapter.writeFile).not.toHaveBeenCalled();
    });

    it('클라우드가 최신이면 다운로드해 로컬 반영, 업로드 스킵 (D-2)', async () => {
      mockAdapter.readBinaryFile.mockImplementation(async (path: string) => {
        if (path === 'archives/index.json') {
          return new Blob([JSON.stringify({
            version: 1,
            entries: [{
              syncId: 'sync-1', bookmarkId: 'bk-1', url: 'https://example.com', title: 'Example',
              fileName: 'sync-1.html', fileSize: 999, format: 'raw', archivedAt: 9999
            }],
            updatedAt: 9999
          })], { type: 'application/json' });
        }
        return new Blob(['<html>cloud</html>']);
      });
      await syncArchiveToCloudByBookmarkId(1);
      expect(mockAdapter.writeBinaryFile).not.toHaveBeenCalled();
      expect(mockAdapter.readBinaryFile).toHaveBeenCalledWith('archives/sync-1.html');
      expect(stores.archivedPages[0].archivedAt).toBe(9999);
    });

    it('북마크/아카이브 부재 → no-op', async () => {
      stores.bookmarks = [];
      await expect(syncArchiveToCloudByBookmarkId(99)).resolves.toBeUndefined();
      expect(mockAdapter.writeBinaryFile).not.toHaveBeenCalled();
    });

    it('동점+크기상이 충돌 → 업로드 스킵 + archive_conflict_logs 기록 (D-3/AC-3)', async () => {
      // Entry exists in cloud with same archivedAt (1000) but different fileSize (999 vs local 15)
      mockAdapter.readBinaryFile.mockImplementation(async (path: string) => {
        if (path === 'archives/index.json') {
          return new Blob([JSON.stringify({
            version: 1,
            entries: [{
              syncId: 'sync-1', bookmarkId: 'bk-1', url: 'https://example.com', title: 'Example',
              fileName: 'sync-1.html', fileSize: 999, format: 'raw', archivedAt: 1000
            }],
            updatedAt: 1000
          })], { type: 'application/json' });
        }
        return new Blob(['x']);
      });
      mockAdapter.getLastModified.mockResolvedValue(5000);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await syncArchiveToCloudByBookmarkId(1);
      // Skip upload — neither cloud nor local is overwritten (index/file unrecorded)
      expect(mockAdapter.writeBinaryFile).not.toHaveBeenCalled();
      expect(mockAdapter.writeFile).not.toHaveBeenCalled();
      // Record conflict log (pending)
      const logs = stores.settings.get('archive_conflict_logs');
      expect(logs).toHaveLength(1);
      expect(logs[0].syncId).toBe('sync-1');
      expect(logs[0].localFileSize).toBe(15);
      expect(logs[0].cloudFileSize).toBe(999);
      expect(logs[0].status).toBe('pending');
      // Prevent duplicate log on re-invoking with same syncId
      await syncArchiveToCloudByBookmarkId(1);
      expect(stores.settings.get('archive_conflict_logs')).toHaveLength(1);
      warn.mockRestore();
    });
  });

  describe('deleteArchiveFromCloud', () => {
    it('삭제: deleteFile + index에 tombstone 표시 (G-2)', async () => {
      mockAdapter.readBinaryFile.mockResolvedValue(new Blob([JSON.stringify({
        version: 1,
        entries: [{
          syncId: 'sync-1', bookmarkId: 'bk-1', url: 'https://example.com', title: 'Example',
          fileName: 'sync-1.html', fileSize: 100, format: 'raw', archivedAt: 1000
        }],
        updatedAt: 1000
      })], { type: 'application/json' }));
      mockAdapter.deleteFile.mockResolvedValue(undefined);
      mockAdapter.getLastModified.mockResolvedValue(5000);
      await deleteArchiveFromCloud('sync-1');
      expect(mockAdapter.deleteFile).toHaveBeenCalledWith('archives/sync-1.html');
      // Record index tombstone with folder-aware binary write
      const idxWrite = mockAdapter.writeBinaryFile.mock.calls.find((c) => c[0] === 'archives/index.json');
      expect(idxWrite).toBeDefined();
      await expect(idxWrite[1].text()).resolves.toContain('"deleted":true');
    });

    it('index에 없는 syncId라도 fallback 파일명으로 드라이브 파일 삭제 시도', async () => {
      mockAdapter.readBinaryFile.mockResolvedValue(new Blob([JSON.stringify({
        version: 1,
        entries: [],
        updatedAt: 1000
      })], { type: 'application/json' }));
      mockAdapter.deleteFile.mockResolvedValue(undefined);
      await deleteArchiveFromCloud('sync-orphan-99');
      expect(mockAdapter.deleteFile).toHaveBeenCalledWith('archives/sync-orphan-99.html');
    });

    it('URL 기반으로 클라우드 인덱스 엔트리를 찾아 삭제 및 tombstone 적용', async () => {
      mockAdapter.readBinaryFile.mockResolvedValue(new Blob([JSON.stringify({
        version: 1,
        entries: [{
          syncId: 'sync-device-a', bookmarkId: 'bk-1', url: 'https://example.com/page', title: 'Page',
          fileName: 'sync-device-a.html', fileSize: 100, format: 'raw', archivedAt: 1000
        }],
        updatedAt: 1000
      })], { type: 'application/json' }));
      mockAdapter.deleteFile.mockResolvedValue(undefined);

      await deleteArchiveFromCloud('sync-device-b', 'https://example.com/page');

      expect(mockAdapter.deleteFile).toHaveBeenCalledWith('archives/sync-device-a.html');
      const idxWrite = mockAdapter.writeBinaryFile.mock.calls.find((c) => c[0] === 'archives/index.json');
      expect(idxWrite).toBeDefined();
      await expect(idxWrite[1].text()).resolves.toContain('"deleted":true');

      // Archive tombstone recorded
      const tombstones = await getArchiveTombstones();
      expect(tombstones.some((t) => t.syncId === 'sync-device-b' || t.url === 'https://example.com/page')).toBe(true);

      // Subsequent refreshCloudArchiveIndex excludes this entry even if adapter returns it
      const refreshed = await refreshCloudArchiveIndex();
      expect(refreshed).toHaveLength(0);
    });

    it('삭제 후 리프레시 시 원격 index에 아직 반영되지 않았더라도 tombstone으로 부활 방지', async () => {
      // Remote adapter returns un-deleted entry (e.g. race condition)
      mockAdapter.readBinaryFile.mockResolvedValue(new Blob([JSON.stringify({
        version: 1,
        entries: [{
          syncId: 'sync-race', bookmarkId: 'bk-1', url: 'https://example.com/race', title: 'Race',
          fileName: 'sync-race.html', fileSize: 100, format: 'raw', archivedAt: 1000
        }],
        updatedAt: 1000
      })], { type: 'application/json' }));
      mockAdapter.deleteFile.mockResolvedValue(undefined);

      await deleteArchiveFromCloud('sync-race', 'https://example.com/race');

      const cached = await getCloudArchiveIndexCache();
      expect(cached).toHaveLength(0);
    });
  });

  describe('syncPendingArchives', () => {
    it('로컬 북마크가 삭제된(tombstone 보유) 아카이브 엔트리는 드라이브 파일 삭제 + index tombstone 처리', async () => {
      // FIX-1(archive-reset-wipe) new contract: local bookmark missing + delete tombstone exists -> propagate deletion.
      // (No deletion propagation without tombstone — regression case is archive-reset-wipe-regression.test.ts S1)
      stores.bookmarks = []; // No local bookmark (deleted)
      stores.settings.set('sync_tombstones', [{ syncId: 'sync-deleted-bm', deletedAt: 999 }]);
      mockAdapter.readBinaryFile.mockResolvedValue(new Blob([JSON.stringify({
        version: 1,
        entries: [{
          syncId: 'sync-deleted-bm', bookmarkId: 'bk-del', url: 'https://deleted.com', title: 'Deleted',
          fileName: 'sync-deleted-bm.html', fileSize: 50, format: 'raw', archivedAt: 1000
        }],
        updatedAt: 1000
      })], { type: 'application/json' }));
      mockAdapter.deleteFile.mockResolvedValue(undefined);

      await syncPendingArchives();

      expect(mockAdapter.deleteFile).toHaveBeenCalledWith('archives/sync-deleted-bm.html');
      const idxWrite = mockAdapter.writeBinaryFile.mock.calls.find((c) => c[0] === 'archives/index.json');
      expect(idxWrite).toBeDefined();
      await expect(idxWrite[1].text()).resolves.toContain('"deleted":true');
    });
  });

  describe('restoreArchivesFromCloud', () => {
    it('복원: 로컬에 없으면 다운로드해 저장, 고아는 보존 (G-1, EC-3)', async () => {
      stores.bookmarks.push({ id: 2, syncId: 'sync-local', bookmarkId: 'bk-local', title: 'Local', url: 'https://local.com' });
      mockAdapter.readBinaryFile.mockImplementation(async (path: string) => {
        if (path === 'archives/index.json') {
          return new Blob([JSON.stringify({
            version: 1,
            entries: [
              { syncId: 'sync-local', bookmarkId: 'bk-local', url: 'https://local.com', title: 'Local', fileName: 'sync-local.html', fileSize: 100, format: 'raw', archivedAt: 5000 },
              { syncId: 'sync-orphan', bookmarkId: 'bk-orphan', url: 'https://orphan.com', title: 'Orphan', fileName: 'sync-orphan.html', fileSize: 100, format: 'raw', archivedAt: 5000 }
            ],
            updatedAt: 5000
          })], { type: 'application/json' });
        }
        return new Blob(['<html>restored</html>']);
      });
      const result = await restoreArchivesFromCloud();
      expect(result.restored).toBe(1);
      expect(result.orphans).toHaveLength(1);
      expect(mockAdapter.readBinaryFile).toHaveBeenCalledWith('archives/sync-local.html');
    });

    it('BUG-1: 로컬 stale 아카이브가 있으면 id 보존 upsert — 중복 행 없이 최신 blob으로 갱신', async () => {
      stores.bookmarks.push({ id: 2, syncId: 'sync-local', bookmarkId: 'bk-local', title: 'Local', url: 'https://local.com' });
      stores.archivedPages.push({
        id: 50, bookmarkId: 2, url: 'https://local.com',
        htmlBlob: new Blob(['<html>stale</html>'], { type: 'text/html' }),
        fileSize: 15, archivedAt: 1000
      });
      mockAdapter.readBinaryFile.mockImplementation(async (path: string) => {
        if (path === 'archives/index.json') {
          return new Blob([JSON.stringify({
            version: 1,
            entries: [
              { syncId: 'sync-local', bookmarkId: 'bk-local', url: 'https://local.com', title: 'Local', fileName: 'sync-local.html', fileSize: 100, format: 'raw', archivedAt: 5000 }
            ],
            updatedAt: 5000
          })], { type: 'application/json' });
        }
        return new Blob(['<html>restored</html>']);
      });
      const result = await restoreArchivesFromCloud();
      expect(result.restored).toBe(1);
      const rows = stores.archivedPages.filter((r) => r.bookmarkId === 2);
      expect(rows).toHaveLength(1); // No duplicate rows
      expect(rows[0].id).toBe(50);  // Preserve local row id (upsert)
      expect(await rows[0].htmlBlob.text()).toBe('<html>restored</html>');
      expect(rows[0].archivedAt).toBe(5000);
    });
  });
});
