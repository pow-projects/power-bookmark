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
  table.update = async (id: number, payload: any) => {
    const arr = getArr();
    const idx = arr.findIndex((r: any) => r.id === id);
    if (idx >= 0) {
      arr[idx] = { ...arr[idx], ...payload };
      return 1;
    }
    return 0;
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
    getAdapter: vi.fn().mockImplementation(async () => mockAdapter)
  }
}));

import db from '../../src/lib/db';
import { SyncEngine } from '../../src/lib/sync/sync-engine';
import {
  refreshCloudArchiveIndex,
  getCloudArchiveIndexCache,
  downloadArchiveOnDemand
} from '../../src/lib/archive/archive-cloud';
import type { ArchiveIndexEntry } from '../../src/lib/archive/archive-index';

describe('archive-ondemand (온디맨드 아카이브 인덱싱 및 단건 다운로드)', () => {
  beforeEach(() => {
    stores.bookmarks = [];
    stores.archivedPages = [];
    stores.settings.clear();
    stores.nextBookmarkId = 1;
    vi.clearAllMocks();
    stores.settings.set('sync_archive_to_cloud', true);
    vi.mocked(SyncEngine.getAdapter).mockResolvedValue(mockAdapter as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('refreshCloudArchiveIndex & getCloudArchiveIndexCache', () => {
    it('클라우드 index.json을 읽어 deleted=false인 유효 항목만 db.settings에 캐시하고 반환한다', async () => {
      const mockEntries: ArchiveIndexEntry[] = [
        {
          syncId: 'sync-1',
          bookmarkId: 'bm-1',
          url: 'https://example.com/1',
          title: 'Example 1',
          fileName: 'sync-1.html',
          fileSize: 1024,
          format: 'single-file',
          archivedAt: 1000
        },
        {
          syncId: 'sync-2',
          bookmarkId: 'bm-2',
          url: 'https://example.com/2',
          title: 'Example 2 (Deleted)',
          fileName: 'sync-2.html',
          fileSize: 2048,
          format: 'single-file',
          archivedAt: 2000,
          deleted: true,
          deletedAt: 3000
        },
        {
          syncId: 'sync-3',
          bookmarkId: 'bm-3',
          url: 'https://example.com/3',
          title: 'Example 3',
          fileName: 'sync-3.html',
          fileSize: 4096,
          format: 'single-file',
          archivedAt: 4000
        }
      ];

      mockAdapter.readBinaryFile.mockResolvedValueOnce(
        new Blob([JSON.stringify({ version: 1, entries: mockEntries, updatedAt: 5000 })], {
          type: 'application/json'
        })
      );

      const result = await refreshCloudArchiveIndex();

      expect(result).toHaveLength(2);
      expect(result.map((e) => e.syncId)).toEqual(['sync-1', 'sync-3']);

      // Verify settings cache
      const cached = await getCloudArchiveIndexCache();
      expect(cached).toEqual(result);
    });

    it('sync_archive_to_cloud가 false이면 클라우드를 읽지 않고 빈 배열을 반환한다', async () => {
      stores.settings.set('sync_archive_to_cloud', false);

      const result = await refreshCloudArchiveIndex();
      expect(result).toEqual([]);
      expect(mockAdapter.readBinaryFile).not.toHaveBeenCalled();
    });

    it('어댑터가 없으면 빈 배열을 반환한다', async () => {
      vi.mocked(SyncEngine.getAdapter).mockResolvedValueOnce(null);

      const result = await refreshCloudArchiveIndex();
      expect(result).toEqual([]);
      expect(mockAdapter.readBinaryFile).not.toHaveBeenCalled();
    });

    it('클라우드에 index.json이 없으면 (404) 빈 배열을 캐시하고 반환한다', async () => {
      mockAdapter.readBinaryFile.mockRejectedValueOnce({ status: 404, message: 'File not found' });

      const result = await refreshCloudArchiveIndex();
      expect(result).toEqual([]);

      const cached = await getCloudArchiveIndexCache();
      expect(cached).toEqual([]);
    });

    it('캐시가 비어있을 때 getCloudArchiveIndexCache는 빈 배열을 반환한다', async () => {
      const cached = await getCloudArchiveIndexCache();
      expect(cached).toEqual([]);
    });
  });

  describe('downloadArchiveOnDemand', () => {
    it('syncId에 해당하는 로컬 북마크가 없으면 null을 반환한다', async () => {
      const result = await downloadArchiveOnDemand('non-existent-sync-id');
      expect(result).toBeNull();
      expect(mockAdapter.readBinaryFile).not.toHaveBeenCalled();
    });

    it('로컬에 이미 온전한 아카이브(htmlBlob)가 있으면 재다운로드 없이 로컬 아카이브를 반환한다', async () => {
      const bookmarkId = await db.bookmarks.add({
        syncId: 'sync-local-exists',
        bookmarkId: 'b-1',
        url: 'https://example.com/page',
        title: 'Local Bookmark',
        folderPath: 'Bookmarks',
        createdAt: 1000,
        modifiedAt: 1000,
        visitCount: 0
      });

      const existingBlob = new Blob(['<html>Local Content</html>'], { type: 'text/html' });
      await db.archivedPages.put({
        id: 42,
        bookmarkId,
        url: 'https://example.com/page',
        htmlBlob: existingBlob,
        fileSize: existingBlob.size,
        archivedAt: 1500
      });

      const result = await downloadArchiveOnDemand('sync-local-exists');
      expect(result).not.toBeNull();
      expect(result?.id).toBe(42);
      expect(result?.bookmarkId).toBe(bookmarkId);
      expect(result?.archivedAt).toBe(1500);

      // Verify no cloud read call was made
      expect(mockAdapter.readBinaryFile).not.toHaveBeenCalled();
    });

    it('로컬에 아카이브가 없으면 클라우드에서 다운로드하여 db.archivedPages에 저장하고 반환한다', async () => {
      const bookmarkId = await db.bookmarks.add({
        syncId: 'sync-cloud-download',
        bookmarkId: 'b-2',
        url: 'https://example.com/download-target',
        title: 'Download Target',
        folderPath: 'Bookmarks',
        createdAt: 1000,
        modifiedAt: 1000,
        visitCount: 0
      });

      const cloudHtml = '<html>Cloud Saved Page</html>';
      const cloudBlob = new Blob([cloudHtml], { type: 'text/html' });

      // readBinaryFile: first call is htmlBlob (archives/sync-cloud-download.html), second call is index.json (archives/index.json)
      mockAdapter.readBinaryFile.mockImplementation(async (path: string) => {
        if (path.endsWith('.html')) {
          return cloudBlob;
        }
        if (path.endsWith('index.json')) {
          return new Blob(
            [
              JSON.stringify({
                version: 1,
                entries: [
                  {
                    syncId: 'sync-cloud-download',
                    bookmarkId: 'b-2',
                    url: 'https://example.com/download-target',
                    title: 'Download Target',
                    fileName: 'sync-cloud-download.html',
                    fileSize: cloudBlob.size,
                    format: 'single-file',
                    archivedAt: 9999
                  }
                ],
                updatedAt: 9999
              })
            ],
            { type: 'application/json' }
          );
        }
        throw new Error('Not found');
      });

      const result = await downloadArchiveOnDemand('sync-cloud-download');

      expect(result).not.toBeNull();
      expect(result?.bookmarkId).toBe(bookmarkId);
      expect(result?.url).toBe('https://example.com/download-target');
      expect(result?.archivedAt).toBe(9999);
      expect(result?.fileSize).toBe(cloudBlob.size);

      // Verify it was actually saved to DB
      const saved = await db.archivedPages.where('bookmarkId').equals(bookmarkId).first();
      expect(saved).toBeDefined();
      expect(saved?.bookmarkId).toBe(bookmarkId);
      expect(saved?.archivedAt).toBe(9999);
    });

    it('어댑터가 없으면 Error를 throw한다', async () => {
      await db.bookmarks.add({
        syncId: 'sync-no-adapter',
        bookmarkId: 'b-3',
        url: 'https://example.com',
        title: 'No Adapter',
        folderPath: 'Bookmarks',
        createdAt: 1000,
        modifiedAt: 1000,
        visitCount: 0
      });

      vi.mocked(SyncEngine.getAdapter).mockResolvedValueOnce(null);

      await expect(downloadArchiveOnDemand('sync-no-adapter')).rejects.toThrow('No cloud storage adapter');
    });

    it('로컬에 빈/손상된 아카이브 레코드가 있었던 경우(htmlBlob 없음) 기존 id를 유지하며 upsert한다', async () => {
      const bookmarkId = await db.bookmarks.add({
        syncId: 'sync-empty-local',
        bookmarkId: 'b-4',
        url: 'https://example.com/empty',
        title: 'Empty Local',
        folderPath: 'Bookmarks',
        createdAt: 1000,
        modifiedAt: 1000,
        visitCount: 0
      });

      // Corrupted/empty record (no htmlBlob)
      await db.archivedPages.put({
        id: 77,
        bookmarkId,
        url: 'https://example.com/empty',
        htmlBlob: null as any,
        fileSize: 0,
        archivedAt: 500
      });

      const cloudBlob = new Blob(['<html>Valid Content</html>'], { type: 'text/html' });
      mockAdapter.readBinaryFile.mockImplementation(async (path: string) => {
        if (path.endsWith('.html')) return cloudBlob;
        if (path.endsWith('index.json')) {
          return new Blob([JSON.stringify({ version: 1, entries: [], updatedAt: 1000 })], {
            type: 'application/json'
          });
        }
        throw new Error('Not found');
      });

      const result = await downloadArchiveOnDemand('sync-empty-local');

      expect(result).not.toBeNull();
      expect(result?.id).toBe(77); // Verify id preservation
      expect(result?.fileSize).toBe(cloudBlob.size);

      const inDb = await db.archivedPages.get(77);
      expect(inDb).toBeDefined();
      expect(inDb?.fileSize).toBe(cloudBlob.size);
    });

    it('URL로 온디맨드 다운로드 시 URL 폴백으로 북마크와 인덱스를 매칭하고 fileName으로 파일을 다운로드한다', async () => {
      const bookmarkId = await db.bookmarks.add({
        url: 'https://example.com/url-only-test',
        title: 'URL Only Bookmark',
        folderPath: 'Bookmarks',
        createdAt: 1000,
        modifiedAt: 1000,
        visitCount: 0
      });

      const cloudBlob = new Blob(['<html>URL Downloaded Content</html>'], { type: 'text/html' });
      mockAdapter.readBinaryFile.mockImplementation(async (path: string) => {
        if (path === 'archives/custom-archive-file.html') return cloudBlob;
        if (path.endsWith('index.json')) {
          return new Blob([
            JSON.stringify({
              version: 1,
              entries: [
                {
                  syncId: 'sync-recovered-99',
                  bookmarkId: 'b-99',
                  url: 'https://example.com/url-only-test',
                  title: 'URL Only Bookmark',
                  fileName: 'custom-archive-file.html',
                  fileSize: cloudBlob.size,
                  format: 'single-file',
                  archivedAt: 7777
                }
              ],
              updatedAt: 7777
            })
          ], { type: 'application/json' });
        }
        throw new Error('Not found');
      });

      const result = await downloadArchiveOnDemand('https://example.com/url-only-test');

      expect(result).not.toBeNull();
      expect(result?.bookmarkId).toBe(bookmarkId);
      expect(result?.archivedAt).toBe(7777);
      expect(result?.url).toBe('https://example.com/url-only-test');

      // Verify bookmark syncId was updated with index syncId
      const updatedBookmark = await db.bookmarks.get(bookmarkId);
      expect(updatedBookmark?.syncId).toBe('sync-recovered-99');
    });

    it('index.json이 404이거나 비어있을 때 listFiles로 archives 폴더 내 .html 파일들로부터 인덱스를 자가 복구한다', async () => {
      await db.bookmarks.add({
        syncId: 'sync-self-heal-1',
        bookmarkId: 'b-sh-1',
        url: 'https://example.com/self-heal-1',
        title: 'Self Heal 1',
        folderPath: 'Bookmarks',
        createdAt: 1000,
        modifiedAt: 1000,
        visitCount: 0
      });

      mockAdapter.readBinaryFile.mockRejectedValueOnce({ status: 404, message: 'File not found' });
      mockAdapter.listFiles.mockResolvedValueOnce([
        { name: 'sync-self-heal-1.html', modifiedAt: 8888, size: 2048 }
      ]);

      const result = await refreshCloudArchiveIndex();

      expect(result).toHaveLength(1);
      expect(result[0].syncId).toBe('sync-self-heal-1');
      expect(result[0].url).toBe('https://example.com/self-heal-1');
      expect(result[0].fileName).toBe('sync-self-heal-1.html');
      expect(result[0].archivedAt).toBe(8888);
    });
  });

  describe('openArchiveBookmark (온디맨드 다운로드 후 뷰어 오픈 핸들러)', () => {
    it('다운로드 완료 시 IPC 응답 대신 로컬 DB의 온전한 Blob을 가진 ArchivedPage를 openViewer에 전달한다', async () => {
      const { openArchiveBookmark } = await import('../../src/components/management/bookmarks/archive-action-handler');

      const bookmarkId = await db.bookmarks.add({
        syncId: 'sync-dl-open',
        bookmarkId: 'b-open-1',
        url: 'https://example.com/open-target',
        title: 'Open Target',
        folderPath: 'Bookmarks',
        createdAt: 1000,
        modifiedAt: 1000,
        visitCount: 0
      });
      const bookmark = await db.bookmarks.get(bookmarkId);

      const realBlob = new Blob(['<html>Real Cloud HTML Content</html>'], { type: 'text/html' });

      // Simulate download saving to DB
      const browserMock = {
        runtime: {
          sendMessage: vi.fn(async (msg: any) => {
            if (msg.type === 'ARCHIVE_DOWNLOAD_ON_DEMAND') {
              await db.archivedPages.put({
                id: 123,
                bookmarkId,
                url: bookmark?.url,
                htmlBlob: realBlob,
                fileSize: realBlob.size,
                archivedAt: 9999
              });
              // Return metadata only without Blob (simulating Chrome IPC serialization)
              return {
                ok: true,
                page: {
                  id: 123,
                  bookmarkId,
                  url: bookmark?.url,
                  fileSize: realBlob.size,
                  archivedAt: 9999
                }
              };
            }
            return { ok: false };
          })
        }
      };
      vi.stubGlobal('browser', browserMock);

      const archiveMap = new Map();
      const cloudArchiveMap = new Map([
        ['sync-dl-open', { syncId: 'sync-dl-open', bookmarkId: 'b-open-1', url: 'https://example.com/open-target', fileName: 'sync-dl-open.html', fileSize: realBlob.size, format: 'single-file' as const, archivedAt: 9999 }]
      ]);

      const openViewerSpy = vi.fn();
      const reloadSpy = vi.fn(async () => {});
      const startSpy = vi.fn();
      const finishSpy = vi.fn();

      await openArchiveBookmark(
        bookmark!,
        archiveMap,
        cloudArchiveMap,
        openViewerSpy,
        reloadSpy,
        startSpy,
        finishSpy
      );

      expect(startSpy).toHaveBeenCalled();
      expect(reloadSpy).toHaveBeenCalled();
      expect(openViewerSpy).toHaveBeenCalled();

      const passedArchive = openViewerSpy.mock.calls[0][0];
      expect(passedArchive).not.toBeNull();
      expect(passedArchive.id).toBe(123);
      expect(passedArchive.htmlBlob).toBeInstanceOf(Blob);
      expect(finishSpy).toHaveBeenCalled();
    });
  });
});
