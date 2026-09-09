import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockBookmarkCreate,
  mockBookmarkGet,
  mockBookmarkGetTree,
  mockBookmarkMove,
  mockBookmarkUpdate,
  mockBookmarkSearch,
  mockBookmarkRemove,
  mockEnsureFolderPath,
  stores
} = vi.hoisted(() => {
  const stores = {
    bookmarks: [] as any[],
    archivedPages: [] as any[],
    syncState: [] as any[],
    settings: new Map<string, any>(),
    nextBookmarkId: 1
  };
  return {
    mockBookmarkCreate: vi.fn(),
    mockBookmarkGet: vi.fn(),
    mockBookmarkGetTree: vi.fn(),
    mockBookmarkMove: vi.fn(),
    mockBookmarkUpdate: vi.fn(),
    mockBookmarkSearch: vi.fn(),
    mockBookmarkRemove: vi.fn(),
    mockEnsureFolderPath: vi.fn(),
    stores
  };
});

vi.stubGlobal('browser', {
  bookmarks: {
    create: mockBookmarkCreate,
    get: mockBookmarkGet,
    getTree: mockBookmarkGetTree,
    move: mockBookmarkMove,
    update: mockBookmarkUpdate,
    search: mockBookmarkSearch,
    remove: mockBookmarkRemove,
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onChanged: { addListener: vi.fn() },
    onMoved: { addListener: vi.fn() }
  },
  alarms: {
    create: vi.fn(),
    clear: vi.fn().mockResolvedValue(true),
    get: vi.fn().mockResolvedValue(null),
    onAlarm: { addListener: vi.fn() }
  }
});

vi.mock('../../src/lib/db', () => {
  function makeTable(tableKey: 'bookmarks' | 'archivedPages' | 'syncState') {
    const getArr = () => stores[tableKey];
    const table: any = {};

    table.where = (idx: string) => ({
      equals(val: any) {
        return {
          first: async () => getArr().find((r: any) => r[idx] === val),
          delete: async () => {
            const arr = getArr();
            for (let i = arr.length - 1; i >= 0; i--) {
              if (arr[i][idx] === val) arr.splice(i, 1);
            }
          },
          toArray: async () => getArr().filter((r: any) => r[idx] === val),
          count: async () => getArr().filter((r: any) => r[idx] === val).length
        };
      }
    });

    table.first = async () => getArr()[0];
    table.toArray = async () => [...getArr()];
    table.count = async () => getArr().length;
    table.add = async (row: any) => {
      const id = stores.nextBookmarkId++;
      const arr = getArr();
      arr.push({ ...row, id });
      return id;
    };
    table.put = async (row: any) => {
      const arr = getArr();
      const id = row.id ?? stores.nextBookmarkId++;
      const existingIdx = arr.findIndex((r: any) => r.id === id);
      if (existingIdx >= 0) {
        arr[existingIdx] = { ...row, id };
      } else {
        arr.push({ ...row, id });
      }
      return id;
    };
    table.get = async (id: number) => getArr().find((r: any) => r.id === id);
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
    table.toCollection = () => ({
      modify: async (fn: (r: any) => void) => {
        for (const row of [...getArr()]) await fn(row);
      }
    });

    return table;
  }

  const mockDb: any = {
    bookmarks: makeTable('bookmarks'),
    archivedPages: makeTable('archivedPages'),
    syncState: makeTable('syncState'),
    settings: {
      get: async (key: string) => ({ value: stores.settings.get(key) }),
      put: async (item: { key: string; value: any }) => { stores.settings.set(item.key, item.value); },
      delete: async (key: string) => { stores.settings.delete(key); }
    },
    transaction: async (_mode: string, _table: any, fn: () => Promise<void>) => {
      await fn();
    }
  };

  return { db: mockDb, default: mockDb };
});

vi.mock('../../src/lib/bookmarks/badge-manager', () => ({
  setSyncingIndicator: vi.fn()
}));

vi.mock('../../src/lib/sync/tombstones', async () => {
  const actual: any = await vi.importActual('../../src/lib/sync/tombstones');
  return {
    ...actual
  };
});

const mockAdapter = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  getLastModified: vi.fn().mockResolvedValue(1000)
};

vi.mock('../../src/lib/sync/adapters/google-drive', () => ({
  GoogleDriveAdapter: vi.fn().mockImplementation(() => mockAdapter)
}));

import {
  SyncEngine,
  normalizeCloudBookmark,
  DEFAULT_SYNC_INTERVAL_MINUTES,
  SYNC_INTERVAL_KEY
} from '../../src/lib/sync/sync-engine';
import { BookmarkManager } from '../../src/lib/bookmarks/bookmark-manager';

describe('SyncEngine folderPath synchronization', () => {
  beforeEach(() => {
    stores.bookmarks = [];
    stores.archivedPages = [];
    stores.syncState = [];
    stores.settings.clear();
    stores.settings.set('sync_provider', 'google-drive');
    stores.nextBookmarkId = 1;
    vi.clearAllMocks();
    SyncEngine.resetAdapter();

    vi.spyOn(BookmarkManager, 'syncAll').mockImplementation(async () => {});
    vi.spyOn(BookmarkManager, 'ensureFolderPath').mockImplementation(mockEnsureFolderPath);
  });

  it('클라우드에서 새 북마크(folderPath 포함)를 가져올 때 ensureFolderPath 호출 및 parentId 적용', async () => {
    const cloudPayload = {
      bookmarks: [
        {
          syncId: 'sync-new-1',
          bookmarkId: 'bk-cloud-1',
          url: 'https://svelte.dev',
          title: 'Svelte',
          folderPath: '개발/프론트엔드',
          createdAt: 1000,
          modifiedAt: 1000,
          visitCount: 0
        }
      ],
      tombstones: [],
      synchronizedAt: 1000
    };

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    mockBookmarkSearch.mockResolvedValue([]);
    mockEnsureFolderPath.mockResolvedValue({ id: 'folder-fe', path: '개발/프론트엔드' });
    mockBookmarkCreate.mockResolvedValue({ id: 'bk-local-new', parentId: 'folder-fe', title: 'Svelte', url: 'https://svelte.dev' });

    await SyncEngine.sync();

    // 1. Verify ensureFolderPath was called with 'Development/Frontend'
    expect(mockEnsureFolderPath).toHaveBeenCalledWith('개발/프론트엔드');

    // 2. Verify parentId: 'folder-fe' was passed to browser.bookmarks.create
    expect(mockBookmarkCreate).toHaveBeenCalledWith({
      parentId: 'folder-fe',
      title: 'Svelte',
      url: 'https://svelte.dev'
    });

    // 3. Verify folderPath was properly saved to local DB
    expect(stores.bookmarks).toHaveLength(1);
    expect(stores.bookmarks[0].folderPath).toBe('개발/프론트엔드');
    expect(stores.bookmarks[0].bookmarkId).toBe('bk-local-new');
  });

  it('로컬 북마크의 folderPath를 클라우드 승자 데이터로 갱신 시 browser.bookmarks.move 호출', async () => {
    // Local: no folderPath (root), modifiedAt 100
    stores.bookmarks.push({
      id: 1,
      syncId: 'sync-existing-1',
      bookmarkId: 'bk-existing-1',
      url: 'https://svelte.dev',
      title: 'Svelte',
      folderPath: '',
      createdAt: 100,
      modifiedAt: 100,
      visitCount: 0
    });

    // Cloud: has folderPath, modifiedAt 500 (winner)
    const cloudPayload = {
      bookmarks: [
        {
          syncId: 'sync-existing-1',
          bookmarkId: 'bk-existing-1',
          url: 'https://svelte.dev',
          title: 'Svelte',
          folderPath: '개발/프론트엔드',
          createdAt: 100,
          modifiedAt: 500,
          visitCount: 0
        }
      ],
      tombstones: [],
      synchronizedAt: 500
    };

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    mockEnsureFolderPath.mockResolvedValue({ id: 'folder-fe', path: '개발/프론트엔드' });
    mockBookmarkGet.mockResolvedValue([{ id: 'bk-existing-1', parentId: '1' }]); // Currently at root (1)

    await SyncEngine.sync();

    // 1. Verify ensureFolderPath call
    expect(mockEnsureFolderPath).toHaveBeenCalledWith('개발/프론트엔드');

    // 2. Verify browser.bookmarks.move was called to move to target folder
    expect(mockBookmarkMove).toHaveBeenCalledWith('bk-existing-1', { parentId: 'folder-fe' });

    // 3. Verify folderPath and modifiedAt in local DB were updated
    expect(stores.bookmarks[0].folderPath).toBe('개발/프론트엔드');
    expect(stores.bookmarks[0].modifiedAt).toBe(500);
  });

  it('firstSync 시 URL 동일·folderPath 상이로 충돌 발생 시 conflictLogs에 folderPath 포함', async () => {
    // First sync state: syncState is empty
    stores.bookmarks.push({
      id: 1,
      syncId: 'sync-local',
      bookmarkId: 'bk-local',
      url: 'https://conflict.example',
      title: 'Same Title',
      folderPath: '로컬폴더',
      createdAt: 100,
      modifiedAt: 200,
      visitCount: 0
    });

    const cloudPayload = {
      bookmarks: [
        {
          syncId: 'sync-local',
          bookmarkId: 'bk-cloud',
          url: 'https://conflict.example',
          title: 'Same Title',
          folderPath: '클라우드폴더',
          createdAt: 100,
          modifiedAt: 100,
          visitCount: 0
        }
      ],
      tombstones: [],
      synchronizedAt: 100
    };

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));

    await SyncEngine.sync();

    const conflictLogs = stores.settings.get('sync_conflict_logs');
    expect(conflictLogs).toBeDefined();
    expect(conflictLogs).toHaveLength(1);
    expect(conflictLogs[0].localVersion.folderPath).toBe('로컬폴더');
    expect(conflictLogs[0].cloudVersion.folderPath).toBe('클라우드폴더');
  });

  it('클라우드에서 Other bookmarks 하위 북마크 동기화 시 ensureFolderPath에 Other bookmarks 전체 경로 전달 및 생성', async () => {
    const cloudPayload = {
      bookmarks: [
        {
          syncId: 'sync-other-1',
          bookmarkId: 'bk-cloud-other',
          url: 'https://other-example.com',
          title: 'Other Site',
          folderPath: 'Other bookmarks/하위폴더',
          createdAt: 1000,
          modifiedAt: 1000,
          visitCount: 0
        }
      ],
      tombstones: [],
      synchronizedAt: 1000
    };

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    mockBookmarkSearch.mockResolvedValue([]);
    mockEnsureFolderPath.mockResolvedValue({ id: 'folder-other-sub', path: 'Other bookmarks/하위폴더' });
    mockBookmarkCreate.mockResolvedValue({ id: 'bk-local-other', parentId: 'folder-other-sub', title: 'Other Site', url: 'https://other-example.com' });

    await SyncEngine.sync();

    // Verify ensureFolderPath was called with 'Other bookmarks/subfolder'
    expect(mockEnsureFolderPath).toHaveBeenCalledWith('Other bookmarks/하위폴더');

    // Verify parentId: 'folder-other-sub' was passed to browser.bookmarks.create
    expect(mockBookmarkCreate).toHaveBeenCalledWith({
      parentId: 'folder-other-sub',
      title: 'Other Site',
      url: 'https://other-example.com'
    });

    expect(stores.bookmarks).toHaveLength(1);
    expect(stores.bookmarks[0].folderPath).toBe('Other bookmarks/하위폴더');
  });

  it('클라우드에서 Other bookmarks 루트 직속 북마크 동기화 시 root folder id가 parentId로 적용', async () => {
    const cloudPayload = {
      bookmarks: [
        {
          syncId: 'sync-other-root',
          bookmarkId: 'bk-cloud-other-root',
          url: 'https://other-root.com',
          title: 'Other Root Site',
          folderPath: 'Other bookmarks',
          createdAt: 1000,
          modifiedAt: 1000,
          visitCount: 0
        }
      ],
      tombstones: [],
      synchronizedAt: 1000
    };

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    mockBookmarkSearch.mockResolvedValue([]);
    mockEnsureFolderPath.mockResolvedValue({ id: '2', path: 'Other bookmarks' });
    mockBookmarkCreate.mockResolvedValue({ id: 'bk-local-other-root', parentId: '2', title: 'Other Root Site', url: 'https://other-root.com' });

    await SyncEngine.sync();

    expect(mockEnsureFolderPath).toHaveBeenCalledWith('Other bookmarks');
    expect(mockBookmarkCreate).toHaveBeenCalledWith({
      parentId: '2',
      title: 'Other Root Site',
      url: 'https://other-root.com'
    });
    expect(stores.bookmarks[0].folderPath).toBe('Other bookmarks');
  });

  it('클라우드 북마크를 가져올 때 syncId, tags, description을 보존하여 로컬 DB에 생성하고 동기화 후 mute가 해제된다', async () => {
    const cloudPayload = {
      bookmarks: [
        {
          syncId: 'sync-exact-123',
          bookmarkId: 'bk-cloud-123',
          url: 'https://preserve.com',
          title: 'Preserve Metadata',
          folderPath: '',
          description: 'Original Cloud Description',
          tags: ['typescript', 'wxt'],
          createdAt: 1000,
          modifiedAt: 2000,
          visitCount: 5
        }
      ],
      tombstones: [],
      synchronizedAt: 2000
    };

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    mockBookmarkSearch.mockResolvedValue([]);
    mockBookmarkCreate.mockResolvedValue({ id: 'bk-local-123', title: 'Preserve Metadata', url: 'https://preserve.com' });

    let mutedDuringSync = false;
    mockBookmarkCreate.mockImplementation(async () => {
      mutedDuringSync = BookmarkManager.isSyncMuted;
      return { id: 'bk-local-123', title: 'Preserve Metadata', url: 'https://preserve.com' };
    });

    await SyncEngine.sync();

    // 1. Verify BookmarkManager.isSyncMuted was true during browser bookmark creation
    expect(mutedDuringSync).toBe(true);

    // 2. Verify BookmarkManager.isSyncMuted was restored to false after sync completion
    expect(BookmarkManager.isSyncMuted).toBe(false);

    // 3. Verify syncId, tags, and description were fully preserved in local DB
    expect(stores.bookmarks).toHaveLength(1);
    expect(stores.bookmarks[0].syncId).toBe('sync-exact-123');
    expect(stores.bookmarks[0].tags).toEqual(['typescript', 'wxt']);
    expect(stores.bookmarks[0].description).toBe('Original Cloud Description');
    expect(stores.bookmarks[0].bookmarkId).toBe('bk-local-123');
  });

  it('기존 bookmarkId 또는 syncId를 가진 레코드가 존재할 때 ConstraintError 없이 클라우드 메타데이터로 안전하게 갱신된다', async () => {
    // When the same bookmarkId already exists locally with a temporary syncId (e.g. pre-inserted by browser event)
    stores.bookmarks.push({
      id: 1,
      syncId: 'temp-local-sync-id',
      bookmarkId: 'bk-existing-node',
      url: 'https://existing-node.com',
      title: 'Cloud Title',
      folderPath: '',
      description: '',
      tags: [],
      createdAt: 100,
      modifiedAt: 100,
      visitCount: 0
    });

    const cloudPayload = {
      bookmarks: [
        {
          syncId: 'cloud-authoritative-sync-id',
          bookmarkId: 'bk-different-cloud-id',
          url: 'https://existing-node.com',
          title: 'Cloud Title',
          folderPath: '',
          description: 'Cloud Description',
          tags: ['authoritative'],
          createdAt: 100,
          modifiedAt: 500,
          visitCount: 3
        }
      ],
      tombstones: [],
      synchronizedAt: 500
    };

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    // Return bk-existing-node as existing bookmark search result from browser
    mockBookmarkSearch.mockResolvedValue([{ id: 'bk-existing-node', url: 'https://existing-node.com', title: 'Local Title' }]);

    await SyncEngine.sync();

    // Existing row (id: 1) is safely updated with cloud metadata (syncId, tags, description) without duplicate insert
    expect(stores.bookmarks).toHaveLength(1);
    expect(stores.bookmarks[0].id).toBe(1);
    expect(stores.bookmarks[0].syncId).toBe('cloud-authoritative-sync-id');
    expect(stores.bookmarks[0].tags).toEqual(['authoritative']);
    expect(stores.bookmarks[0].description).toBe('Cloud Description');
    expect(stores.bookmarks[0].bookmarkId).toBe('bk-existing-node');
  });

  it('클라우드에 데이터가 존재하나 로컬 북마크가 비어있는 경우 Fail-safe 가드가 클라우드 덮어쓰기를 차단하고 에러를 던진다', async () => {
    const cloudPayload = {
      bookmarks: [
        {
          syncId: 'cloud-precious-1',
          bookmarkId: 'bk-precious-1',
          url: 'https://important.com',
          title: 'Important',
          folderPath: '',
          createdAt: 1000,
          modifiedAt: 1000,
          visitCount: 0
        }
      ],
      tombstones: [],
      synchronizedAt: 1000
    };

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    // Simulate browser creation failure -> local DB remains empty
    mockBookmarkSearch.mockResolvedValue([]);
    mockBookmarkCreate.mockRejectedValue(new Error('Browser API bookmark creation failure'));

    await expect(SyncEngine.sync()).rejects.toThrow('Sync aborted: attempt to overwrite non-empty cloud bookmarks with empty local dataset.');

    // Verify cloud file overwrite (writeFile) was not called
    expect(mockAdapter.writeFile).not.toHaveBeenCalled();

    // Verify sync status was saved as 'error'
    expect(stores.syncState.at(-1)?.status).toBe('error');

    // Verify mute was properly released
    expect(BookmarkManager.isSyncMuted).toBe(false);
  });

  it('동일 URL, 상이한 syncId(내용 충돌 없음)일 때 in-place로 클라우드 syncId를 입양하고 로컬 id, bookmarkId, 아카이브를 보존한다', async () => {
    // Local: id 1, bookmarkId 'bk-local-node-99', syncId 'temp-local-uuid', url 'https://example.com'
    stores.bookmarks.push({
      id: 1,
      syncId: 'temp-local-uuid',
      bookmarkId: 'bk-local-node-99',
      url: 'https://example.com',
      title: 'Example Page',
      folderPath: '',
      description: 'Same desc',
      tags: ['web'],
      createdAt: 100,
      modifiedAt: 100,
      visitCount: 0
    });

    // Local archived page (bookmarkId: 1)
    stores.archivedPages.push({
      id: 10,
      bookmarkId: 1,
      url: 'https://example.com',
      fileSize: 1234,
      archivedAt: 100
    });

    const cloudPayload = {
      bookmarks: [
        {
          syncId: 'cloud-canonical-uuid',
          bookmarkId: 'foreign-chrome-node-555',
          url: 'https://example.com',
          title: 'Example Page',
          folderPath: '',
          description: 'Same desc',
          tags: ['web'],
          createdAt: 100,
          modifiedAt: 200,
          visitCount: 1
        }
      ],
      tombstones: [],
      synchronizedAt: 200
    };

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));

    await SyncEngine.sync();

    // 1. id and bookmarkId of local DB record are retained while only syncId is adopted from cloud in-place
    expect(stores.bookmarks).toHaveLength(1);
    expect(stores.bookmarks[0].id).toBe(1);
    expect(stores.bookmarks[0].bookmarkId).toBe('bk-local-node-99');
    expect(stores.bookmarks[0].syncId).toBe('cloud-canonical-uuid');

    // 2. Archive record is preserved without being deleted
    expect(stores.archivedPages).toHaveLength(1);
    expect(stores.archivedPages[0].bookmarkId).toBe(1);

    // 3. Browser bookmark creation API (mockBookmarkCreate) is not unnecessarily called
    expect(mockBookmarkCreate).not.toHaveBeenCalled();
  });

  it('동일 URL 후보가 여러 개일 때 folder match > title match > first 순으로 최적의 cloud syncId를 입양한다', async () => {
    // Local: 'React Guide' in 'Development/Frontend' folder
    stores.bookmarks.push({
      id: 1,
      syncId: 'local-react-uuid',
      bookmarkId: 'bk-react-node',
      url: 'https://react.dev',
      title: 'React Guide',
      folderPath: 'Bookmarks Bar/개발/프론트',
      description: 'Local desc',
      tags: [],
      createdAt: 100,
      modifiedAt: 100,
      visitCount: 0
    });

    // Cloud: 2 items with same URL (one in 'Other', one matching 'Development/Frontend' folder)
    const cloudPayload = {
      bookmarks: [
        {
          syncId: 'cloud-react-other-uuid',
          bookmarkId: 'bk-cloud-other',
          url: 'https://react.dev',
          title: 'React Dev',
          folderPath: 'Other bookmarks/기타',
          createdAt: 100,
          modifiedAt: 100,
          visitCount: 0
        },
        {
          syncId: 'cloud-react-matched-uuid',
          bookmarkId: 'bk-cloud-matched',
          url: 'https://react.dev',
          title: 'React Guide',
          folderPath: '개발/프론트',
          createdAt: 100,
          modifiedAt: 100,
          visitCount: 0
        }
      ],
      tombstones: [],
      synchronizedAt: 100
    };

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));

    await SyncEngine.sync();

    // Adopt cloud-react-matched-uuid whose folder path ('Development/Frontend' <-> 'Bookmarks Bar/Development/Frontend') and title match
    const local = stores.bookmarks.find(b => b.id === 1);
    expect(local).toBeDefined();
    expect(local?.syncId).toBe('cloud-react-matched-uuid');
  });

  it('updateJobs는 foreign 클라우드 bookmarkId가 아닌 로컬 exists.bookmarkId를 사용하여 브라우저를 업데이트한다', async () => {
    stores.bookmarks.push({
      id: 1,
      syncId: 'sync-common-1',
      bookmarkId: 'local-browser-node-77',
      url: 'https://test.com',
      title: 'Old Title',
      folderPath: '',
      description: 'desc',
      tags: [],
      createdAt: 100,
      modifiedAt: 100,
      visitCount: 0
    });

    const cloudPayload = {
      bookmarks: [
        {
          syncId: 'sync-common-1',
          bookmarkId: 'foreign-browser-node-888', // bookmarkId from another device
          url: 'https://test.com',
          title: 'New Cloud Title',
          folderPath: '',
          description: 'desc',
          tags: [],
          createdAt: 100,
          modifiedAt: 500,
          visitCount: 2
        }
      ],
      tombstones: [],
      synchronizedAt: 500
    };

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));

    await SyncEngine.sync();

    // Local ID ('local-browser-node-77') passed to mockBookmarkUpdate instead of foreign ID ('foreign-browser-node-888')
    expect(mockBookmarkUpdate).toHaveBeenCalledWith('local-browser-node-77', {
      title: 'New Cloud Title',
      url: 'https://test.com'
    });
    expect(mockBookmarkUpdate).not.toHaveBeenCalledWith('foreign-browser-node-888', expect.anything());
  });

  it('dedupeByUrl 처리 시 중복 로컬 북마크를 삭제하기 전 아카이브를 승자 북마크로 이전(re-parent)한다', async () => {
    // Winner local bookmark (id: 1, modifiedAt: 500)
    stores.bookmarks.push({
      id: 1,
      syncId: 'sync-winner',
      bookmarkId: 'node-winner',
      url: 'https://dedupe-target.com',
      title: 'Target Title',
      folderPath: '',
      description: 'Same desc',
      tags: [],
      createdAt: 100,
      modifiedAt: 500,
      visitCount: 0
    });

    // Duplicate local bookmark (id: 2, modifiedAt: 100) — archive is attached here
    stores.bookmarks.push({
      id: 2,
      syncId: 'sync-dup',
      bookmarkId: 'node-dup',
      url: 'https://dedupe-target.com',
      title: 'Target Title',
      folderPath: '',
      description: 'Same desc',
      tags: [],
      createdAt: 100,
      modifiedAt: 100,
      visitCount: 0
    });

    // Archive attached to id 2
    stores.archivedPages.push({
      id: 100,
      bookmarkId: 2,
      url: 'https://dedupe-target.com',
      fileSize: 5000,
      archivedAt: 100
    });

    const cloudPayload = {
      bookmarks: [
        {
          syncId: 'sync-winner',
          bookmarkId: 'node-winner-cloud',
          url: 'https://dedupe-target.com',
          title: 'Target Title',
          folderPath: '',
          description: 'Same desc',
          tags: [],
          createdAt: 100,
          modifiedAt: 500,
          visitCount: 0
        },
        {
          syncId: 'sync-dup',
          bookmarkId: 'node-dup-cloud',
          url: 'https://dedupe-target.com',
          title: 'Target Title',
          folderPath: '',
          description: 'Same desc',
          tags: [],
          createdAt: 100,
          modifiedAt: 100,
          visitCount: 0
        }
      ],
      tombstones: [],
      synchronizedAt: 500
    };

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));

    await SyncEngine.sync();

    // 1. Duplicate bookmark id: 2 is deleted and only winner id: 1 remains
    expect(stores.bookmarks).toHaveLength(1);
    expect(stores.bookmarks[0].id).toBe(1);

    // 2. Archive is preserved by reparenting from id: 2 to winner id: 1
    expect(stores.archivedPages).toHaveLength(1);
    expect(stores.archivedPages[0].id).toBe(100);
    expect(stores.archivedPages[0].bookmarkId).toBe(1);
  });

  it('Pre-merge identity reconciliation으로 동일 URL 레코드는 클라우드 syncId를 입양하여 단일 레코드로 통합되고 firstSync 충돌 로그가 기록된다', async () => {
    // Local item (different content -> adoption target for same URL)
    stores.bookmarks.push({
      id: 1,
      syncId: 'sync-conflict-local',
      bookmarkId: 'node-conflict-local',
      url: 'https://conflict-test.com',
      title: 'Local Unique Title',
      folderPath: '',
      description: 'Local unique description',
      tags: ['local'],
      createdAt: 100,
      modifiedAt: 200,
      visitCount: 0
    });

    // Cloud item (same URL, different syncId, different content)
    const cloudPayload = {
      bookmarks: [
        {
          syncId: 'sync-conflict-cloud',
          bookmarkId: 'node-conflict-cloud',
          url: 'https://conflict-test.com',
          title: 'Cloud Unique Title',
          folderPath: '',
          description: 'Cloud unique description',
          tags: ['cloud'],
          createdAt: 100,
          modifiedAt: 100,
          visitCount: 0
        }
      ],
      tombstones: [],
      synchronizedAt: 100
    };

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    mockBookmarkSearch.mockResolvedValue([{ id: 'node-conflict-local', url: 'https://conflict-test.com', title: 'Local Unique Title' }]);

    await SyncEngine.sync();

    // syncId is adopted from cloud and latest local content (modifiedAt: 200) is maintained as a single record by LWW
    expect(stores.bookmarks).toHaveLength(1);
    const unifiedRecord = stores.bookmarks[0];
    expect(unifiedRecord.id).toBe(1);
    expect(unifiedRecord.syncId).toBe('sync-conflict-cloud');
    expect(unifiedRecord.bookmarkId).toBe('node-conflict-local');
    expect(unifiedRecord.title).toBe('Local Unique Title');

    // Verify conflict log is registered for content discrepancy because isFirstSync is true
    const conflictLogs = stores.settings.get('sync_conflict_logs');
    expect(conflictLogs).toBeDefined();
    expect(conflictLogs.length).toBeGreaterThanOrEqual(1);
    expect(conflictLogs[0].bookmarkId).toBe('sync-conflict-cloud');
  });

  it('반복 동기화 시 동일 bookmarkId의 pending 충돌 로그가 누적되지 않고 1건으로 유지된다', async () => {
    stores.bookmarks.push({
      id: 1,
      syncId: 'sync-dup-test',
      bookmarkId: 'node-dup-test',
      url: 'https://dup-test.com',
      title: 'Local Title',
      folderPath: '',
      description: 'Local desc',
      tags: [],
      createdAt: 100,
      modifiedAt: 100,
      visitCount: 0
    });

    const cloudPayload = {
      bookmarks: [
        {
          syncId: 'sync-dup-test',
          bookmarkId: 'node-dup-test',
          url: 'https://dup-test.com',
          title: 'Cloud Title',
          folderPath: '',
          description: 'Cloud desc',
          tags: [],
          createdAt: 100,
          modifiedAt: 100,
          visitCount: 0
        }
      ],
      tombstones: [],
      synchronizedAt: 100
    };

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    mockBookmarkSearch.mockResolvedValue([{ id: 'node-dup-test', url: 'https://dup-test.com', title: 'Local Title' }]);

    // Sync run 1
    await SyncEngine.sync();
    let conflictLogs = stores.settings.get('sync_conflict_logs');
    const pendingCount1 = conflictLogs.filter((l: any) => l.bookmarkId === 'sync-dup-test' && l.status === 'pending').length;
    expect(pendingCount1).toBe(1);

    // Sync run 2 (re-sync before user resolves the conflict)
    await SyncEngine.sync();
    conflictLogs = stores.settings.get('sync_conflict_logs');
    const pendingCount2 = conflictLogs.filter((l: any) => l.bookmarkId === 'sync-dup-test' && l.status === 'pending').length;
    expect(pendingCount2).toBe(1);
  });

  it('50개를 초과하는 pending 충돌 로그가 발생해도 잘리지 않고 전체가 보존된다', async () => {
    // Generate 60 conflicting bookmarks
    const localItems = [];
    const cloudItems = [];
    for (let i = 0; i < 60; i++) {
      localItems.push({
        id: i + 1,
        syncId: `sync-bulk-${i}`,
        bookmarkId: `node-bulk-${i}`,
        url: `https://example.com/bulk-${i}`,
        title: `Local Bulk Title ${i}`,
        folderPath: '',
        description: 'Local desc',
        tags: [],
        createdAt: 100,
        modifiedAt: 100,
        visitCount: 0
      });
      cloudItems.push({
        syncId: `sync-bulk-${i}`,
        bookmarkId: `cloud-node-${i}`,
        url: `https://example.com/bulk-${i}`,
        title: `Cloud Bulk Title ${i}`,
        folderPath: '',
        description: 'Cloud desc',
        tags: [],
        createdAt: 100,
        modifiedAt: 100,
        visitCount: 0
      });
    }

    stores.bookmarks.push(...localItems);
    const cloudPayload = {
      bookmarks: cloudItems,
      tombstones: [],
      synchronizedAt: 100
    };

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    mockBookmarkSearch.mockResolvedValue([]);

    await SyncEngine.sync();
    const conflictLogs = stores.settings.get('sync_conflict_logs');
    expect(conflictLogs).toBeDefined();
    const pendingLogs = conflictLogs.filter((l: any) => l.status === 'pending');
    expect(pendingLogs.length).toBe(60);
  });

  it('충돌 발생 시 클라우드 파일에 미해결 로컬 변경사항을 덮어쓰지 않고 클라우드 버전을 보존한다', async () => {
    stores.bookmarks.push({
      id: 1,
      syncId: 'sync-conflict-preserve',
      bookmarkId: 'node-conflict-preserve',
      url: 'https://preserve-test.com',
      title: 'Local Title Before Apply',
      folderPath: '',
      description: 'Local desc',
      tags: ['local'],
      createdAt: 100,
      modifiedAt: 200,
      visitCount: 0
    });

    const cloudPayload = {
      bookmarks: [
        {
          syncId: 'sync-conflict-preserve',
          bookmarkId: 'cloud-node-1',
          url: 'https://preserve-test.com',
          title: 'Cloud Authoritative Title',
          folderPath: '',
          description: 'Cloud desc',
          tags: ['cloud'],
          createdAt: 100,
          modifiedAt: 150,
          visitCount: 0
        }
      ],
      tombstones: [],
      synchronizedAt: 150
    };

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    mockBookmarkSearch.mockResolvedValue([{ id: 'node-conflict-preserve', url: 'https://preserve-test.com', title: 'Local Title Before Apply' }]);

    await SyncEngine.sync();

    // Verify conflict was recorded
    const conflictLogs = stores.settings.get('sync_conflict_logs');
    expect(conflictLogs).toBeDefined();
    expect(conflictLogs.length).toBeGreaterThanOrEqual(1);

    // Verify written cloud payload preserved cloud version rather than overwriting with local
    expect(mockAdapter.writeFile).toHaveBeenCalled();
    const lastWrittenCall = mockAdapter.writeFile.mock.calls[mockAdapter.writeFile.mock.calls.length - 1];
    const writtenJson = JSON.parse(lastWrittenCall[1]);
    const writtenItem = writtenJson.bookmarks.find((b: any) => b.syncId === 'sync-conflict-preserve');
    expect(writtenItem).toBeDefined();
    expect(writtenItem.title).toBe('Cloud Authoritative Title');
  });

  it('충돌 해결(keep-cloud) 적용 후 재동기화 시 충돌이 재발하지 않고 정상 동기화된다', async () => {
    // 1. Initial state with conflict
    stores.bookmarks.push({
      id: 1,
      syncId: 'sync-keep-cloud-test',
      bookmarkId: 'node-keep-cloud',
      url: 'https://keep-cloud-test.com',
      title: 'Cloud Authoritative Title',
      folderPath: '',
      description: 'Cloud desc',
      tags: ['cloud'],
      createdAt: 100,
      modifiedAt: 300, // Updated by modal
      visitCount: 0
    });

    const cloudPayload = {
      bookmarks: [
        {
          syncId: 'sync-keep-cloud-test',
          bookmarkId: 'node-keep-cloud',
          url: 'https://keep-cloud-test.com',
          title: 'Cloud Authoritative Title',
          folderPath: '',
          description: 'Cloud desc',
          tags: ['cloud'],
          createdAt: 100,
          modifiedAt: 150,
          visitCount: 0
        }
      ],
      tombstones: [],
      synchronizedAt: 150
    };

    // Mark previous conflict as resolved
    stores.settings.set('sync_conflict_logs', [
      {
        id: 'conf-resolved-1',
        status: 'resolved',
        autoResolvedTo: 'cloud',
        userAction: 'keep-cloud',
        bookmarkId: 'sync-keep-cloud-test',
        timestamp: 250
      }
    ]);
    stores.settings.set('initial_sync_completed_google-drive', true);

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    mockBookmarkSearch.mockResolvedValue([{ id: 'node-keep-cloud', url: 'https://keep-cloud-test.com', title: 'Cloud Authoritative Title' }]);

    await SyncEngine.sync();

    // Verify no new pending conflicts exist
    const conflictLogs = stores.settings.get('sync_conflict_logs');
    const pending = conflictLogs.filter((l: any) => l.status === 'pending');
    expect(pending.length).toBe(0);

    // Verify cloud file has the resolved content
    const lastWrittenCall = mockAdapter.writeFile.mock.calls[mockAdapter.writeFile.mock.calls.length - 1];
    const writtenJson = JSON.parse(lastWrittenCall[1]);
    const writtenItem = writtenJson.bookmarks.find((b: any) => b.syncId === 'sync-keep-cloud-test');
    expect(writtenItem.title).toBe('Cloud Authoritative Title');
  });

  it('동기화 성공 시 주기적 동기화 알람이 5분 지연으로 재설정된다', async () => {
    stores.bookmarks.push({
      id: 1,
      syncId: 'sync-alarm-test',
      bookmarkId: 'node-alarm-test',
      url: 'https://alarm-test.com',
      title: 'Alarm Test',
      folderPath: '',
      description: '',
      tags: [],
      createdAt: 100,
      modifiedAt: 100,
      visitCount: 0
    });

    const cloudPayload = {
      bookmarks: [
        {
          syncId: 'sync-alarm-test',
          bookmarkId: 'node-alarm-test',
          url: 'https://alarm-test.com',
          title: 'Alarm Test',
          folderPath: '',
          description: '',
          tags: [],
          createdAt: 100,
          modifiedAt: 100,
          visitCount: 0
        }
      ],
      tombstones: [],
      synchronizedAt: 100
    };

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    mockBookmarkSearch.mockResolvedValue([{ id: 'node-alarm-test', url: 'https://alarm-test.com', title: 'Alarm Test' }]);

    await SyncEngine.sync();
    expect(browser.alarms.create).toHaveBeenCalledWith(
      SyncEngine.SYNC_ALARM_NAME,
      { delayInMinutes: 5, periodInMinutes: 5 }
    );
  });
});

describe('normalizeCloudBookmark', () => {
  it('syncId가 없으면 URL 기반 결정적 UUID를 생성한다', () => {
    const item1 = normalizeCloudBookmark({ url: 'https://example.com/page', title: 'Example' });
    const item2 = normalizeCloudBookmark({ url: 'https://example.com/page', title: 'Example' });
    expect(item1.syncId).toBeDefined();
    expect(item1.syncId).toBe(item2.syncId);
  });

  it('description이 비어있고 aiSummary가 존재하면 description으로 매핑한다', () => {
    const item = normalizeCloudBookmark({
      url: 'https://example.com',
      title: 'Example',
      description: '',
      aiSummary: 'Legacy AI Summary Text'
    });
    expect(item.description).toBe('Legacy AI Summary Text');
  });

  it('tags가 없고 aiTags가 있으면 tags로 매핑한다', () => {
    const item = normalizeCloudBookmark({
      url: 'https://example.com',
      title: 'Example',
      aiTags: ['ai', 'legacy']
    });
    expect(item.tags).toEqual(['ai', 'legacy']);
  });

  it('기존 syncId와 description이 있으면 그대로 보존한다', () => {
    const item = normalizeCloudBookmark({
      syncId: 'my-custom-uuid',
      url: 'https://example.com',
      title: 'Example',
      description: 'Existing Desc',
      aiSummary: 'Ignored Summary',
      tags: ['valid']
    });
    expect(item.syncId).toBe('my-custom-uuid');
    expect(item.description).toBe('Existing Desc');
    expect(item.tags).toEqual(['valid']);
  });

  it('createdAt과 modifiedAt이 정규화되어 유효한 타임스탬프를 보장한다', () => {
    const item = normalizeCloudBookmark({
      url: 'https://example.com',
      title: 'Example',
      createdAt: 1600000000000,
      modifiedAt: 1650000000000
    });
    expect(item.createdAt).toBe(1600000000000);
    expect(item.modifiedAt).toBe(1650000000000);
  });

  it('modifiedAt이 createdAt보다 작으면 modifiedAt을 createdAt 이상으로 보정한다', () => {
    const item = normalizeCloudBookmark({
      url: 'https://example.com',
      title: 'Example',
      createdAt: 1700000000000,
      modifiedAt: 1600000000000
    });
    expect(item.createdAt).toBe(1700000000000);
    expect(item.modifiedAt).toBe(1700000000000);
  });
});

describe('SyncEngine 3-Tier Timestamp & syncedAt isolation', () => {
  beforeEach(() => {
    stores.bookmarks = [];
    stores.archivedPages = [];
    stores.syncState = [];
    stores.settings.clear();
    stores.settings.set('sync_provider', 'google-drive');
    vi.clearAllMocks();
  });

  it('동기화 성공 시 로컬 레코드에 syncedAt이 기록되고, 클라우드 페이로드에는 syncedAt이 제외된다', async () => {
    const localCreatedAt = 1600000000000;
    const localModifiedAt = 1620000000000;
    stores.bookmarks.push({
      id: 1,
      syncId: 'sync-ts-1',
      bookmarkId: 'bm-ts-1',
      url: 'https://ts-test.com',
      title: 'TS Test',
      folderPath: '',
      description: 'Desc',
      createdAt: localCreatedAt,
      modifiedAt: localModifiedAt,
      visitCount: 0
    });

    mockAdapter.readFile.mockResolvedValue(JSON.stringify({ bookmarks: [], tombstones: [] }));
    mockBookmarkGetTree.mockResolvedValue([
      { id: '0', title: 'root', children: [{ id: '1', title: 'Bookmarks Bar', children: [{ id: 'bm-ts-1', url: 'https://ts-test.com', title: 'TS Test' }] }] }
    ]);

    await SyncEngine.sync();

    // 1. Verify syncedAt recorded in local record
    const local = stores.bookmarks.find(b => b.syncId === 'sync-ts-1');
    expect(local.syncedAt).toBeDefined();
    expect(local.syncedAt).toBeGreaterThanOrEqual(localModifiedAt);
    expect(local.createdAt).toBe(localCreatedAt); // Verify createdAt is immutable

    // 2. Verify syncedAt excluded from cloud payload
    expect(mockAdapter.writeFile).toHaveBeenCalled();
    const writtenPayloadStr = mockAdapter.writeFile.mock.calls[0][1];
    const writtenPayload = JSON.parse(writtenPayloadStr);
    expect(writtenPayload.bookmarks[0].syncedAt).toBeUndefined();
    expect(writtenPayload.bookmarks[0].createdAt).toBe(localCreatedAt);
    expect(writtenPayload.bookmarks[0].modifiedAt).toBe(localModifiedAt);
  });

  it('LWW 병합 시 과거 생성시간(earliest createdAt)이 보존된다', async () => {
    const originalCreated = 1500000000000;
    const cloudModified = 1680000000000;
    const localModified = 1650000000000;

    // Local has a later createdAt due to restore time or other reasons
    stores.bookmarks.push({
      id: 1,
      syncId: 'sync-ts-2',
      bookmarkId: 'bm-ts-2',
      url: 'https://earliest.com',
      title: 'Local Title',
      folderPath: '',
      description: 'Local Desc',
      createdAt: 1650000000000,
      modifiedAt: localModified,
      visitCount: 0
    });

    // Cloud has the original older createdAt and latest modifiedAt
    const cloudPayload = {
      bookmarks: [{
        syncId: 'sync-ts-2',
        url: 'https://earliest.com',
        title: 'Cloud Title',
        folderPath: '',
        description: 'Cloud Desc',
        createdAt: originalCreated,
        modifiedAt: cloudModified
      }],
      tombstones: []
    };

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    mockBookmarkGetTree.mockResolvedValue([
      { id: '0', title: 'root', children: [{ id: '1', title: 'Bookmarks Bar', children: [{ id: 'bm-ts-2', url: 'https://earliest.com', title: 'Local Title' }] }] }
    ]);

    await SyncEngine.sync();

    const local = stores.bookmarks.find(b => b.syncId === 'sync-ts-2');
    expect(local.title).toBe('Cloud Title');
    expect(local.modifiedAt).toBe(cloudModified);
    expect(local.createdAt).toBe(originalCreated); // Preserved with older original creation time!
  });

  it('로컬과 클라우드 북마크 내용이 동일할 때, 로컬의 최근 dateAdded로 인해 클라우드의 modifiedAt과 createdAt이 오염되지 않는다', async () => {
    const cloudCreatedAt = 1500000000000;
    const cloudModifiedAt = 1550000000000;
    const localImportedTime = 1700000000000; // Browser import/index timing on new device

    // Local has recent dateAdded generated by browser on new device (never modified, identical content)
    stores.bookmarks.push({
      id: 1,
      syncId: 'sync-identical-1',
      bookmarkId: 'bm-identical-1',
      url: 'https://identical.com',
      title: 'Identical Title',
      folderPath: '북마크바',
      description: 'Identical Desc',
      createdAt: localImportedTime,
      modifiedAt: localImportedTime,
      visitCount: 0
    });

    const cloudPayload = {
      bookmarks: [{
        syncId: 'sync-identical-1',
        url: 'https://identical.com',
        title: 'Identical Title',
        folderPath: '북마크바',
        description: 'Identical Desc',
        createdAt: cloudCreatedAt,
        modifiedAt: cloudModifiedAt
      }],
      tombstones: []
    };

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    mockBookmarkGetTree.mockResolvedValue([
      { id: '0', title: 'root', children: [{ id: '1', title: 'Bookmarks Bar', children: [{ id: 'bm-identical-1', url: 'https://identical.com', title: 'Identical Title' }] }] }
    ]);

    await SyncEngine.sync();

    // 1. Verify cloud original createdAt and modifiedAt are preserved in local DB
    const local = stores.bookmarks.find(b => b.syncId === 'sync-identical-1');
    expect(local.createdAt).toBe(cloudCreatedAt);
    expect(local.modifiedAt).toBe(cloudModifiedAt);

    // 2. Verify cloud original timestamps are preserved in payload written back to drive
    expect(mockAdapter.writeFile).toHaveBeenCalled();
    const writtenPayloadStr = mockAdapter.writeFile.mock.calls[0][1];
    const writtenPayload = JSON.parse(writtenPayloadStr);
    expect(writtenPayload.bookmarks[0].createdAt).toBe(cloudCreatedAt);
    expect(writtenPayload.bookmarks[0].modifiedAt).toBe(cloudModifiedAt);
  });

  it('사용자가 모든 북마크를 의도적으로 삭제하여 툼스톤이 생성된 경우, 에러 없이 클라우드에 빈 북마크 목록과 툼스톤이 업로드된다', async () => {
    // Previous sync record exists (isFirstSync = false)
    stores.syncState = [
      { id: 1, provider: 'google-drive', lastSyncAt: 1000, status: 'idle' }
    ];

    const cloudPayload = {
      bookmarks: [
        {
          syncId: 'cloud-del-1',
          url: 'https://deleted.com',
          title: 'Deleted Title',
          folderPath: '',
          createdAt: 1000,
          modifiedAt: 1000
        }
      ],
      tombstones: [],
      synchronizedAt: 1000
    };

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    mockBookmarkGetTree.mockResolvedValue([
      { id: '0', title: 'root', children: [{ id: '1', title: 'Bookmarks Bar', children: [] }] }
    ]);

    // Tombstone deleted locally exists
    stores.settings.set('sync_tombstones', [
      { syncId: 'cloud-del-1', deletedAt: 2000 }
    ]);

    await SyncEngine.sync();

    // Verify writeFile was called with empty bookmarks and tombstone included
    expect(mockAdapter.writeFile).toHaveBeenCalled();
    const writtenPayload = JSON.parse(mockAdapter.writeFile.mock.calls[0][1]);
    expect(writtenPayload.bookmarks).toEqual([]);
    expect(writtenPayload.tombstones).toEqual([
      { syncId: 'cloud-del-1', deletedAt: 2000 }
    ]);
    expect(stores.syncState.at(-1)?.status).toBe('idle');
  });

  it('로컬 북마크가 비어있고 이전 툼스톤이 남아있더라도 첫 동기화(또는 재연결) 시 클라우드 북마크가 정상 복구된다', async () => {
    // First sync state: no successful record in syncState (isFirstSync = true)
    stores.syncState = [];

    // Residual tombstone from previous session exists locally
    stores.settings.set('sync_tombstones', [
      { syncId: 'cloud-restore-1', deletedAt: 2000 }
    ]);

    const cloudPayload = {
      bookmarks: [
        {
          syncId: 'cloud-restore-1',
          url: 'https://restore.com',
          title: 'Restore Title',
          folderPath: '',
          createdAt: 1000,
          modifiedAt: 1000
        }
      ],
      tombstones: [],
      synchronizedAt: 1000
    };

    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    mockBookmarkGetTree.mockResolvedValue([
      { id: '0', title: 'root', children: [{ id: '1', title: 'Bookmarks Bar', children: [] }] }
    ]);
    mockBookmarkSearch.mockResolvedValue([]);
    mockBookmarkCreate.mockResolvedValue({ id: 'bm-restored-1', url: 'https://restore.com', title: 'Restore Title' });

    await SyncEngine.sync();

    // Verify bookmark is restored in local DB
    expect(stores.bookmarks.length).toBe(1);
    expect(stores.bookmarks[0].syncId).toBe('cloud-restore-1');
    expect(stores.bookmarks[0].url).toBe('https://restore.com');

    // Verify browser bookmark is created
    expect(mockBookmarkCreate).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://restore.com', title: 'Restore Title' })
    );

    // Verify sync status is idle
    expect(stores.syncState.at(-1)?.status).toBe('idle');
  });

  // ==========================================================================
  // Regression: delete-all -> re-import (same deterministic syncId) -> next
  // cloud sync auto-killed the resurrected bookmarks AND their browser nodes,
  // because removeTombstone only cleared the LOCAL copy while the permanent
  // cloud tombstone was re-absorbed via mergeTombstones and won LWW against
  // the stale export-file modifiedAt.
  // ==========================================================================

  it('재수입된 북마크: 클라우드 툼스톤이存活을 막지 못하고, payload에서 툼스톤이 철회 전파된다', async () => {
    stores.syncState = [{ id: 1, provider: 'google-drive', lastSyncAt: 1000, status: 'idle' }];

    // Re-imported bookmark with fresh (>= now) modifiedAt — simulates createBookmark's
    // re-registration bump. Local tombstone already purged by removeTombstone at import.
    stores.bookmarks.push({
      id: 1,
      syncId: 'sync-reimport-1',
      bookmarkId: 'bm-reimport-1',
      url: 'https://reimport.com',
      title: 'Reimported',
      folderPath: '',
      description: '',
      createdAt: 4000,
      modifiedAt: 5000,
      visitCount: 0
    });

    // Cloud only holds the deletion record from the earlier delete-all sync.
    const cloudPayload = { bookmarks: [], tombstones: [{ syncId: 'sync-reimport-1', deletedAt: 2000 }], synchronizedAt: 2000 };
    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    mockBookmarkSearch.mockResolvedValue([]);
    mockBookmarkGetTree.mockResolvedValue([
      { id: '0', title: 'root', children: [{ id: '1', title: 'Bookmarks Bar', children: [{ id: 'bm-reimport-1', url: 'https://reimport.com', title: 'Reimported' }] }] }
    ]);

    await SyncEngine.sync();

    // 1. Bookmark survives locally (LWW: deletedAt 2000 < modifiedAt 5000) and is NOT removed from the browser tree
    expect(stores.bookmarks.find(b => b.syncId === 'sync-reimport-1')).toBeTruthy();
    expect(mockBookmarkRemove).not.toHaveBeenCalledWith('bm-reimport-1');

    // 2. Uploaded payload resurrects the bookmark and REVOKES the tombstone (propagates un-deletion to all devices)
    const writtenPayload = JSON.parse(mockAdapter.writeFile.mock.calls[0][1]);
    expect(writtenPayload.bookmarks.map((b: any) => b.syncId)).toContain('sync-reimport-1');
    expect(writtenPayload.tombstones).toEqual([]);
    expect(stores.settings.get('sync_tombstones')).toEqual([]);
  });

  it('로컬 툼스톤 잔존(read-modify-write 경합) + 동일내용 클라우드 rollback에서도 재수입 북마크가 살아남는다', async () => {
    stores.syncState = [{ id: 1, provider: 'google-drive', lastSyncAt: 1000, status: 'idle' }];

    // Re-imported fresh row BUT stale local tombstone still present (simulates the cross-context
    // removeTombstone lost-update / non-purging path).
    stores.bookmarks.push({
      id: 1,
      syncId: 'sync-reimport-2',
      bookmarkId: 'bm-reimport-2',
      url: 'https://reimport2.com',
      title: 'Same',
      folderPath: '',
      description: '',
      createdAt: 1000,
      modifiedAt: 5000,
      visitCount: 0
    });
    stores.settings.set('sync_tombstones', [{ syncId: 'sync-reimport-2', deletedAt: 2000 }]);

    // Cloud still has the pre-delete copy with identical content and STALE modifiedAt —
    // identical-content merge rolls the winner back to T1000 < deletedAt (the S6 landmine).
    const cloudPayload = {
      bookmarks: [{
        syncId: 'sync-reimport-2',
        url: 'https://reimport2.com',
        title: 'Same',
        folderPath: '',
        description: '',
        createdAt: 1000,
        modifiedAt: 1000
      }],
      tombstones: [],
      synchronizedAt: 1000
    };
    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    mockBookmarkSearch.mockResolvedValue([]);
    mockBookmarkGetTree.mockResolvedValue([
      { id: '0', title: 'root', children: [{ id: '1', title: 'Bookmarks Bar', children: [{ id: 'bm-reimport-2', url: 'https://reimport2.com', title: 'Same' }] }] }
    ]);

    await SyncEngine.sync();

    // Revocation is evaluated against LOCAL DB rows BEFORE LWW, so the parked tombstone dies
    // instead of re-killing the bookmark on the timestamp rollback.
    expect(stores.bookmarks.find(b => b.syncId === 'sync-reimport-2')).toBeTruthy();
    expect(mockBookmarkRemove).not.toHaveBeenCalledWith('bm-reimport-2');
    const writtenPayload = JSON.parse(mockAdapter.writeFile.mock.calls[0][1]);
    expect(writtenPayload.tombstones).toEqual([]);
  });

  it('재수입 후 정당한 재삭제는 여전히 전파된다 (negative gate: 삭제 의도 보존)', async () => {
    stores.syncState = [{ id: 1, provider: 'google-drive', lastSyncAt: 1000, status: 'idle' }];

    // Local row gone (re-deleted); tombstone recorded AFTER the re-registration (deletedAt > any live row).
    stores.settings.set('sync_tombstones', [{ syncId: 'sync-reimport-3', deletedAt: 9000 }]);

    const cloudPayload = {
      bookmarks: [{
        syncId: 'sync-reimport-3',
        url: 'https://reimport3.com',
        title: 'WillDie',
        folderPath: '',
        description: '',
        createdAt: 1000,
        modifiedAt: 1000
      }],
      tombstones: [],
      synchronizedAt: 1000
    };
    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    mockBookmarkSearch.mockResolvedValue([]);
    mockBookmarkGetTree.mockResolvedValue([
      { id: '0', title: 'root', children: [{ id: '1', title: 'Bookmarks Bar', children: [] }] }
    ]);

    await SyncEngine.sync();

    // No live local record -> tombstone NOT revoked -> deletion wins and stays in payload.
    expect(stores.bookmarks.find(b => b.syncId === 'sync-reimport-3')).toBeFalsy();
    const writtenPayload = JSON.parse(mockAdapter.writeFile.mock.calls[0][1]);
    expect(writtenPayload.bookmarks).toEqual([]);
    expect(writtenPayload.tombstones).toEqual([{ syncId: 'sync-reimport-3', deletedAt: 9000 }]);
  });

  // ==========================================================================
  // Regression: reconnect-resurrection — 동기화 해제 → 언링크 중 삭제 → 재연결
  // sync()는 disconnect 마커({provider:'none',idle}) 때문에 isFirstSync=true로
  // 오판정되어 언링크 중 기록된 tombstone을 폐기했고, 클라우드의 낡은 북마크가
  // DB+브라우저 트리로 부활했다. 마커 이후 tombstone은 삭제 의도로 보존·전파,
  // 마커 이전 잔존분과 진성 첫 설치(마커 없음)는 기존 소급삭제 금지 정책 유지.
  // ==========================================================================

  it('언링크 중 삭제 후 재연결: tombstone이 폐기되지 않고 삭제가 클라우드에 전파된다 (부활 금지)', async () => {
    // disconnect가 남긴 마커 (sync-status-store.ts put), provider 이력은 clear됨 → isFirstSync=true
    stores.syncState = [{ id: 9, provider: 'none', lastSyncAt: 3000, status: 'idle' }];
    // 언링크 후 삭제된 북마크의 tombstone (deletedAt > cutoff)
    stores.settings.set('sync_tombstones', [{ syncId: 'sync-unlink-del', deletedAt: 5000 }]);

    const cloudPayload = {
      bookmarks: [{
        syncId: 'sync-unlink-del',
        url: 'https://unlinked-delete.com',
        title: 'ShouldNotResurrect',
        folderPath: '',
        description: '',
        createdAt: 1000,
        modifiedAt: 1000
      }],
      tombstones: [],
      synchronizedAt: 1000
    };
    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    mockBookmarkGetTree.mockResolvedValue([
      { id: '0', title: 'root', children: [{ id: '1', title: 'Bookmarks Bar', children: [] }] }
    ]);
    mockBookmarkSearch.mockResolvedValue([]);
    mockBookmarkCreate.mockResolvedValue({ id: 'bm-zombie', url: 'https://unlinked-delete.com', title: 'ShouldNotResurrect' });

    await SyncEngine.sync();

    // 부활 금지: 브라우저 노드 생성 및 DB 행 복구 없어야 함
    expect(mockBookmarkCreate).not.toHaveBeenCalled();
    expect(stores.bookmarks.find(b => b.syncId === 'sync-unlink-del')).toBeFalsy();

    // 삭제 의도 전파: payload에서 북마크 제거 + tombstone 유지, settings에도 잔존
    const writtenPayload = JSON.parse(mockAdapter.writeFile.mock.calls[0][1]);
    expect(writtenPayload.bookmarks).toEqual([]);
    expect(writtenPayload.tombstones).toEqual([{ syncId: 'sync-unlink-del', deletedAt: 5000 }]);
    expect(stores.settings.get('sync_tombstones')).toEqual([{ syncId: 'sync-unlink-del', deletedAt: 5000 }]);
  });

  it('언링크 마커 이후 tombstone과 재수입(라이브 행)이 공존하면 철회 규칙이 우선한다 (3c5d0ae 비회귀)', async () => {
    stores.syncState = [{ id: 9, provider: 'none', lastSyncAt: 3000, status: 'idle' }];
    stores.settings.set('sync_tombstones', [{ syncId: 'sync-relink-1', deletedAt: 5000 }]);
    // 삭제 후 동일 URL 재등록: modifiedAt >= now(>> deletedAt)의 라이브 로컬 행
    const now = Date.now();
    stores.bookmarks.push({
      id: 1,
      syncId: 'sync-relink-1',
      bookmarkId: 'bm-relink-1',
      url: 'https://relink.com',
      title: 'ReRegistered',
      folderPath: '',
      description: '',
      createdAt: now,
      modifiedAt: now,
      visitCount: 0
    });

    mockAdapter.readFile.mockResolvedValue(JSON.stringify({ bookmarks: [], tombstones: [], synchronizedAt: 1000 }));
    mockBookmarkGetTree.mockResolvedValue([
      { id: '0', title: 'root', children: [{ id: '1', title: 'Bookmarks Bar', children: [{ id: 'bm-relink-1', url: 'https://relink.com', title: 'ReRegistered' }] }] }
    ]);

    await SyncEngine.sync();

    // 재등록 생존 + tombstone 철회 전파 (보존 경로에서도 revokeTombstones 발동)
    expect(stores.bookmarks.find(b => b.syncId === 'sync-relink-1')).toBeTruthy();
    expect(mockBookmarkRemove).not.toHaveBeenCalledWith('bm-relink-1');
    const writtenPayload = JSON.parse(mockAdapter.writeFile.mock.calls[0][1]);
    expect(writtenPayload.tombstones).toEqual([]);
  });

  it('마커 이전 잔존 tombstone은 폐기되고, 마커 이후 tombstone만 생존한다 (분리 검증)', async () => {
    stores.syncState = [{ id: 9, provider: 'none', lastSyncAt: 3000, status: 'idle' }];
    stores.settings.set('sync_tombstones', [
      { syncId: 'pre-marker', deletedAt: 2000 },   // 언링크 이전 구세대 잔존분 → 폐기
      { syncId: 'post-marker', deletedAt: 5000 }   // 언링크 중 삭제 → 보존
    ]);

    const cloudPayload = {
      bookmarks: [
        { syncId: 'pre-marker', url: 'https://pre.com', title: 'RestoreMe', folderPath: '', description: '', createdAt: 1000, modifiedAt: 1000 },
        { syncId: 'post-marker', url: 'https://post.com', title: 'StayDead', folderPath: '', description: '', createdAt: 1000, modifiedAt: 1000 }
      ],
      tombstones: [],
      synchronizedAt: 1000
    };
    mockAdapter.readFile.mockResolvedValue(JSON.stringify(cloudPayload));
    mockBookmarkGetTree.mockResolvedValue([
      { id: '0', title: 'root', children: [{ id: '1', title: 'Bookmarks Bar', children: [] }] }
    ]);
    mockBookmarkSearch.mockResolvedValue([]);
    mockBookmarkCreate.mockResolvedValue({ id: 'bm-pre', url: 'https://pre.com', title: 'RestoreMe' });

    await SyncEngine.sync();

    // pre-marker는 소급삭제 금지 정책대로 클라우드에서 복구(부활 허용), post-marker는 삭제 유지
    expect(stores.bookmarks.find(b => b.syncId === 'pre-marker')).toBeTruthy();
    expect(stores.bookmarks.find(b => b.syncId === 'post-marker')).toBeFalsy();
    const writtenPayload = JSON.parse(mockAdapter.writeFile.mock.calls[0][1]);
    expect(writtenPayload.tombstones).toEqual([{ syncId: 'post-marker', deletedAt: 5000 }]);
    expect(stores.settings.get('sync_tombstones')).toEqual([{ syncId: 'post-marker', deletedAt: 5000 }]);
  });

  it('triggerDebouncedSync는 5초 디바운스 후 SyncEngine.sync()를 실행한다', async () => {
    vi.useFakeTimers();
    const syncSpy = vi.spyOn(SyncEngine, 'sync').mockResolvedValue(undefined);

    SyncEngine.triggerDebouncedSync();
    SyncEngine.triggerDebouncedSync(); // Debounce reset on 2 consecutive calls

    // Not executed yet at 4.9s
    vi.advanceTimersByTime(4900);
    expect(syncSpy).not.toHaveBeenCalled();

    // Executed once at 5s
    vi.advanceTimersByTime(100);
    expect(syncSpy).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});

describe('SyncEngine sync interval and alarm schedule configuration', () => {
  beforeEach(() => {
    stores.bookmarks = [];
    stores.archivedPages = [];
    stores.syncState = [];
    stores.settings.clear();
    stores.settings.set('sync_provider', 'google-drive');
    vi.clearAllMocks();
  });

  describe('getSyncInterval', () => {
    it('returns DEFAULT_SYNC_INTERVAL_MINUTES (5) when setting is not present', async () => {
      const interval = await SyncEngine.getSyncInterval();
      expect(interval).toBe(DEFAULT_SYNC_INTERVAL_MINUTES);
      expect(interval).toBe(5);
    });

    it('returns stored positive interval from db.settings', async () => {
      stores.settings.set(SYNC_INTERVAL_KEY, 30);
      const interval = await SyncEngine.getSyncInterval();
      expect(interval).toBe(30);
    });

    it('returns 0 when interval is configured for manual sync (0)', async () => {
      stores.settings.set(SYNC_INTERVAL_KEY, 0);
      const interval = await SyncEngine.getSyncInterval();
      expect(interval).toBe(0);
    });

    it('falls back to default (5) when value is negative or invalid string', async () => {
      stores.settings.set(SYNC_INTERVAL_KEY, -10);
      expect(await SyncEngine.getSyncInterval()).toBe(5);

      stores.settings.set(SYNC_INTERVAL_KEY, 'invalid');
      expect(await SyncEngine.getSyncInterval()).toBe(5);
    });
  });

  describe('updateSyncSchedule', () => {
    it('clears alarm when provider is "none"', async () => {
      stores.settings.set('sync_provider', 'none');
      stores.settings.set(SYNC_INTERVAL_KEY, 15);

      await SyncEngine.updateSyncSchedule();

      expect(browser.alarms.clear).toHaveBeenCalledWith(SyncEngine.SYNC_ALARM_NAME);
      expect(browser.alarms.create).not.toHaveBeenCalled();
    });

    it('clears alarm when interval is 0 (manual sync)', async () => {
      stores.settings.set('sync_provider', 'google-drive');
      stores.settings.set(SYNC_INTERVAL_KEY, 0);

      await SyncEngine.updateSyncSchedule();

      expect(browser.alarms.clear).toHaveBeenCalledWith(SyncEngine.SYNC_ALARM_NAME);
      expect(browser.alarms.create).not.toHaveBeenCalled();
    });

    it('clears alarm when interval parameter 0 is passed explicitly', async () => {
      stores.settings.set('sync_provider', 'google-drive');
      stores.settings.set(SYNC_INTERVAL_KEY, 15);

      await SyncEngine.updateSyncSchedule(0);

      expect(browser.alarms.clear).toHaveBeenCalledWith(SyncEngine.SYNC_ALARM_NAME);
      expect(browser.alarms.create).not.toHaveBeenCalled();
    });

    it('creates alarm with configured interval when provider is set', async () => {
      stores.settings.set('sync_provider', 'google-drive');
      stores.settings.set(SYNC_INTERVAL_KEY, 60);

      await SyncEngine.updateSyncSchedule();

      expect(browser.alarms.create).toHaveBeenCalledWith(
        SyncEngine.SYNC_ALARM_NAME,
        { delayInMinutes: 60, periodInMinutes: 60 }
      );
    });

    it('creates alarm with explicit parameter interval if provided', async () => {
      stores.settings.set('sync_provider', 'onedrive');
      stores.settings.set(SYNC_INTERVAL_KEY, 5);

      await SyncEngine.updateSyncSchedule(1440);

      expect(browser.alarms.create).toHaveBeenCalledWith(
        SyncEngine.SYNC_ALARM_NAME,
        { delayInMinutes: 1440, periodInMinutes: 1440 }
      );
    });
  });

  describe('resetPeriodicAlarm', () => {
    it('calls updateSyncSchedule with configured interval when called without parameters', async () => {
      stores.settings.set('sync_provider', 'dropbox');
      stores.settings.set(SYNC_INTERVAL_KEY, 360);

      await SyncEngine.resetPeriodicAlarm();

      expect(browser.alarms.create).toHaveBeenCalledWith(
        SyncEngine.SYNC_ALARM_NAME,
        { delayInMinutes: 360, periodInMinutes: 360 }
      );
    });
  });

  describe('ensureSyncAlarm', () => {
    it('clears alarm if sync_provider is none', async () => {
      stores.settings.set('sync_provider', 'none');

      await SyncEngine.ensureSyncAlarm();

      expect(browser.alarms.clear).toHaveBeenCalledWith(SyncEngine.SYNC_ALARM_NAME);
      expect(browser.alarms.create).not.toHaveBeenCalled();
    });

    it('clears alarm if configured interval is 0', async () => {
      stores.settings.set('sync_provider', 'webdav');
      stores.settings.set(SYNC_INTERVAL_KEY, 0);

      await SyncEngine.ensureSyncAlarm();

      expect(browser.alarms.clear).toHaveBeenCalledWith(SyncEngine.SYNC_ALARM_NAME);
      expect(browser.alarms.create).not.toHaveBeenCalled();
    });

    it('keeps existing alarm if periodInMinutes matches target interval', async () => {
      stores.settings.set('sync_provider', 'google-drive');
      stores.settings.set(SYNC_INTERVAL_KEY, 15);
      (browser.alarms.get as any).mockResolvedValueOnce({
        name: SyncEngine.SYNC_ALARM_NAME,
        periodInMinutes: 15
      });

      await SyncEngine.ensureSyncAlarm();

      expect(browser.alarms.create).not.toHaveBeenCalled();
      expect(browser.alarms.clear).not.toHaveBeenCalled();
    });

    it('recreates alarm if existing alarm period differs from target interval', async () => {
      stores.settings.set('sync_provider', 'google-drive');
      stores.settings.set(SYNC_INTERVAL_KEY, 30);
      (browser.alarms.get as any).mockResolvedValueOnce({
        name: SyncEngine.SYNC_ALARM_NAME,
        periodInMinutes: 5 // Old period
      });

      await SyncEngine.ensureSyncAlarm();

      expect(browser.alarms.create).toHaveBeenCalledWith(
        SyncEngine.SYNC_ALARM_NAME,
        { delayInMinutes: 30, periodInMinutes: 30 }
      );
    });

    it('creates alarm if no alarm exists', async () => {
      stores.settings.set('sync_provider', 'google-drive');
      stores.settings.set(SYNC_INTERVAL_KEY, 15);
      (browser.alarms.get as any).mockResolvedValueOnce(null);

      await SyncEngine.ensureSyncAlarm();

      expect(browser.alarms.create).toHaveBeenCalledWith(
        SyncEngine.SYNC_ALARM_NAME,
        { delayInMinutes: 15, periodInMinutes: 15 }
      );
    });
  });
});
