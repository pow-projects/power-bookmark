import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockBookmarkCreate,
  mockBookmarkGet,
  mockBookmarkGetTree,
  mockBookmarkMove,
  mockBookmarkUpdate,
  mockBookmarkRemove,
  mockBookmarkRemoveTree,
  mockOnCreatedAddListener,
  mockOnRemovedAddListener,
  mockOnChangedAddListener,
  mockOnMovedAddListener,
  stores
} = vi.hoisted(() => {
  const stores = {
    bookmarks: [] as any[],
    archivedPages: [] as any[],
    settings: new Map<string, any>(),
    nextBookmarkId: 1
  };
  return {
    mockBookmarkCreate: vi.fn(),
    mockBookmarkGet: vi.fn(),
    mockBookmarkGetTree: vi.fn(),
    mockBookmarkMove: vi.fn(),
    mockBookmarkUpdate: vi.fn(),
    mockBookmarkRemove: vi.fn(),
    mockBookmarkRemoveTree: vi.fn(),
    mockOnCreatedAddListener: vi.fn(),
    mockOnRemovedAddListener: vi.fn(),
    mockOnChangedAddListener: vi.fn(),
    mockOnMovedAddListener: vi.fn(),
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
    remove: mockBookmarkRemove,
    removeTree: mockBookmarkRemoveTree,
    onCreated: { addListener: mockOnCreatedAddListener },
    onRemoved: { addListener: mockOnRemovedAddListener },
    onChanged: { addListener: mockOnChangedAddListener },
    onMoved: { addListener: mockOnMovedAddListener }
  },
  tabs: { create: vi.fn() }
});

vi.mock('../../src/lib/db', () => {
  function makeTable(tableKey: 'bookmarks' | 'archivedPages') {
    // Read from stores at call time, not capture time
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
      },
      startsWith(prefix: string) {
        return {
          toArray: async () => getArr().filter((r: any) => typeof r[idx] === 'string' && r[idx].startsWith(prefix))
        };
      }
    });

    table.first = async () => undefined;
    table.toArray = async () => [...getArr()];
    table.count = async () => getArr().length;
    table.each = async (fn: (r: any) => void) => {
      for (const row of [...getArr()]) await fn(row);
    };
    table.add = async (row: any) => {
      const id = stores.nextBookmarkId++;
      const arr = getArr();
      arr.push({ ...row, id });
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

    return table;
  }

  const mockDb: any = {
    bookmarks: makeTable('bookmarks'),
    archivedPages: makeTable('archivedPages'),
    settings: {
      get: async (key: string) => ({ value: stores.settings.get(key) }),
      put: async (item: { key: string; value: any }) => { stores.settings.set(item.key, item.value); }
    },
    transaction: async (_mode: string, _table: any, fn: () => Promise<void>) => {
      await fn();
    }
  };

  return { db: mockDb, default: mockDb };
});

import { BookmarkManager, isSystemRootTitle, generateDeterministicSyncId } from '../../src/lib/bookmarks/bookmark-manager';

describe('isSystemRootTitle', () => {
  it('브라우저 시스템 루트 폴더명을 인식한다 (대소문자·공백 무시)', () => {
    expect(isSystemRootTitle('Bookmarks Bar')).toBe(true);
    expect(isSystemRootTitle('Other bookmarks')).toBe(true);
    expect(isSystemRootTitle('Mobile bookmarks')).toBe(true);
    expect(isSystemRootTitle('북마크바')).toBe(true);
    expect(isSystemRootTitle('북마크 바')).toBe(true);
    expect(isSystemRootTitle('기타 북마크')).toBe(true);
    expect(isSystemRootTitle('  Bookmarks Bar  ')).toBe(true);
  });

  it('일반 폴더명/빈 값은 시스템 루트로 판별하지 않는다', () => {
    expect(isSystemRootTitle('커뮤니티')).toBe(false);
    expect(isSystemRootTitle('Bookmarks Bar/커뮤니티')).toBe(false);
    expect(isSystemRootTitle('')).toBe(false);
    expect(isSystemRootTitle(undefined)).toBe(false);
    expect(isSystemRootTitle()).toBe(false);
  });
});

describe('BookmarkManager.createBookmark', () => {
  beforeEach(() => {
    stores.bookmarks = [];
    stores.archivedPages = [];
    stores.settings.clear();
    stores.nextBookmarkId = 1;
    vi.clearAllMocks();
    (BookmarkManager as any).isListening = false;

    mockBookmarkGetTree.mockResolvedValue([{
      id: '0',
      title: 'Root',
      children: [{ id: '1', title: 'Bookmarks Bar', children: [] }]
    }]);

    BookmarkManager.listen();
  });

  it('should create exactly one DB row for a new bookmark (race-free)', async () => {
    const node = { id: 'bk-123', url: 'https://example.com', title: 'Example', parentId: '1' };
    mockBookmarkCreate.mockResolvedValue(node);

    const result = await BookmarkManager.createBookmark(
      'https://example.com', 'Example', undefined, 'A test description'
    );

    expect(stores.bookmarks).toHaveLength(1);
    expect(stores.bookmarks[0].bookmarkId).toBe('bk-123');
    expect(stores.bookmarks[0].url).toBe('https://example.com');
    expect(stores.bookmarks[0].description).toBe('A test description');
    expect(result.bookmarkId).toBe('bk-123');
    expect(result.id).toBe(1);
  });

  it('should not create duplicate when listener already inserted the row', async () => {
    const node = { id: 'bk-456', url: 'https://dup.com', title: 'Dup', parentId: '1' };
    mockBookmarkCreate.mockResolvedValue(node);

    // Simulate listener firing before polling loop
    stores.bookmarks.push({
      id: stores.nextBookmarkId++,
      bookmarkId: 'bk-456',
      url: 'https://dup.com',
      title: 'Dup',
      folderPath: '',
      description: '',
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      visitCount: 0
    });

    const result = await BookmarkManager.createBookmark(
      'https://dup.com', 'Dup', undefined, 'New description'
    );

    const rows = stores.bookmarks.filter(b => b.bookmarkId === 'bk-456');
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('New description');
    expect(result.id).toBe(rows[0].id);
  });

  it('should fallback insert when listener has not written yet', async () => {
    const node = { id: 'bk-789', url: 'https://race.com', title: 'Race', parentId: '1' };
    mockBookmarkCreate.mockResolvedValue(node);

    const result = await BookmarkManager.createBookmark(
      'https://race.com', 'Race', undefined, ''
    );

    const rows = stores.bookmarks.filter(b => b.bookmarkId === 'bk-789');
    expect(rows).toHaveLength(1);
    expect(result.bookmarkId).toBe('bk-789');
  });

  it('onCreated listener should not duplicate when row already exists', async () => {
    stores.bookmarks.push({
      id: stores.nextBookmarkId++,
      bookmarkId: 'bk-pre',
      url: 'https://pre.com',
      title: 'Pre',
      folderPath: '',
      description: '',
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      visitCount: 0
    });

    const onCreatedCallback = mockOnCreatedAddListener.mock.calls[0]?.[0];
    expect(onCreatedCallback).toBeDefined();

    await onCreatedCallback('bk-pre', {
      url: 'https://pre.com',
      title: 'Pre',
      parentId: '1',
      dateAdded: Date.now()
    });

    const rows = stores.bookmarks.filter(b => b.bookmarkId === 'bk-pre');
    expect(rows).toHaveLength(1);
  });

  it('createBookmark preserves createdAt but bumps stale modifiedAt to >= now (re-registration invariant)', async () => {
    const node = { id: 'bk-time', url: 'https://time.com', title: 'Time', parentId: '1' };
    mockBookmarkCreate.mockResolvedValue(node);

    const before = Date.now();
    const result = await BookmarkManager.createBookmark(
      'https://time.com',
      'Time',
      undefined,
      '',
      { createdAt: 1600000000000, modifiedAt: 1650000000000 }
    );

    // createdAt stays from source data (provenance preserved)...
    expect(result.createdAt).toBe(1600000000000);
    // ...but registration-time events must NEVER inherit a stale modifiedAt (old export file + permanent
    // cloud tombstone = LWW re-kill regression). Import means fresh registration: modifiedAt >= now.
    expect(result.modifiedAt).toBeGreaterThanOrEqual(before);
    expect(result.modifiedAt).toBeLessThanOrEqual(Date.now());
  });

  it('updateBookmark should preserve createdAt and bump modifiedAt only on content change', async () => {
    const originalCreated = 1600000000000;
    const originalModified = 1600000000000;
    const bmId = stores.nextBookmarkId++;
    stores.bookmarks.push({
      id: bmId,
      bookmarkId: 'bk-immut',
      syncId: 'sync-immut',
      url: 'https://immut.com',
      title: 'Original Title',
      folderPath: '',
      description: 'Original Desc',
      createdAt: originalCreated,
      modifiedAt: originalModified,
      visitCount: 0
    });

    // Content update
    await BookmarkManager.updateBookmark(bmId, { title: 'New Title' });
    const updated = stores.bookmarks.find(b => b.id === bmId);
    expect(updated.createdAt).toBe(originalCreated); // Immutable!
    expect(updated.modifiedAt).toBeGreaterThan(originalModified);

    // Non-content update (e.g. aiStatus) should not bump modifiedAt
    const modBefore = updated.modifiedAt;
    await BookmarkManager.updateBookmark(bmId, { aiStatus: 'done' });
    const afterNonContent = stores.bookmarks.find(b => b.id === bmId);
    expect(afterNonContent.createdAt).toBe(originalCreated);
    expect(afterNonContent.modifiedAt).toBe(modBefore);
  });

  describe('BookmarkManager.removeBookmark', () => {
    it('should always delete both bookmark and associated archive', async () => {
      const bookmarkId = stores.nextBookmarkId++;
      stores.bookmarks.push({
        id: bookmarkId,
        bookmarkId: 'bk-del-1',
        url: 'https://delete-me.com',
        title: 'Delete Me',
        folderPath: '',
        description: '',
          createdAt: Date.now(),
        modifiedAt: Date.now(),
        visitCount: 0
      });
      stores.archivedPages.push({
        id: 1,
        bookmarkId: bookmarkId,
        url: 'https://delete-me.com',
        title: 'Delete Me',
        htmlBlob: new Blob()
      });

      await BookmarkManager.removeBookmark(bookmarkId);

      expect(stores.bookmarks.find(b => b.id === bookmarkId)).toBeUndefined();
      expect(stores.archivedPages.find(a => a.bookmarkId === bookmarkId)).toBeUndefined();
    });

    it('records a tombstone so the deleted bookmark is not resurrected by cloud sync (regression: onRemoved-only recording raced with the DB delete)', async () => {
      const bookmarkId = stores.nextBookmarkId++;
      stores.bookmarks.push({
        id: bookmarkId,
        bookmarkId: 'bk-del-tomb',
        syncId: 'sync-del-tomb',
        url: 'https://tomb-me.com',
        title: 'Tomb Me',
        folderPath: '',
        description: '',
        createdAt: Date.now(),
        modifiedAt: Date.now(),
        visitCount: 0
      });

      await BookmarkManager.removeBookmark(bookmarkId);

      const tombstones = stores.settings.get('sync_tombstones');
      expect(Array.isArray(tombstones)).toBe(true);
      expect(tombstones.find((t: any) => t.syncId === 'sync-del-tomb')).toBeDefined();
    });
  });

  describe('BookmarkManager.getFolders', () => {
    it('should exclude root node (id 0/root) and return top-level folders with DFS properties', async () => {
      mockBookmarkGetTree.mockResolvedValue([{
        id: '0',
        title: '',
        children: [
          { id: '1', parentId: '0', title: 'Bookmarks Bar', children: [] },
          { id: '2', parentId: '0', title: 'Other Bookmarks', children: [] }
        ]
      }]);

      const folders = await BookmarkManager.getFolders();
      expect(folders).toHaveLength(2);
      expect(folders.find(f => f.id === '0')).toBeUndefined();
      expect(folders).toEqual([
        {
          id: '1',
          title: 'Bookmarks Bar',
          path: 'Bookmarks Bar',
          parentId: '0',
          depth: 0,
          displayName: 'Bookmarks Bar'
        },
        {
          id: '2',
          title: 'Other Bookmarks',
          path: 'Other Bookmarks',
          parentId: '0',
          depth: 0,
          displayName: 'Other Bookmarks'
        }
      ]);
    });

    it('should traverse nested folders in DFS order and set depth, parentId, path, displayName with pure NBSP indentation correctly', async () => {
      mockBookmarkGetTree.mockResolvedValue([
        {
          id: '0',
          title: 'root',
          children: [
            {
              id: '1',
              parentId: '0',
              title: 'Bookmarks Bar',
              children: [
                {
                  id: '10',
                  parentId: '1',
                  title: 'Tech',
                  children: [
                    { id: '100', parentId: '10', title: 'Development', children: [] },
                    { id: '101', parentId: '10', title: 'Bookmark Link', url: 'https://example.com' },
                    { id: '102', parentId: '10', title: 'Design', children: [] }
                  ]
                },
                { id: '11', parentId: '1', title: 'News', children: [] }
              ]
            },
            {
              id: '2',
              parentId: '0',
              title: 'Other Bookmarks',
              children: []
            }
          ]
        }
      ]);

      const folders = await BookmarkManager.getFolders();

      // Bookmark link id '101' must be ignored, leaving 6 folders.
      expect(folders).toHaveLength(6);
      expect(folders.map(f => f.id)).toEqual(['1', '10', '100', '102', '11', '2']);

      expect(folders).toEqual([
        {
          id: '1',
          title: 'Bookmarks Bar',
          path: 'Bookmarks Bar',
          parentId: '0',
          depth: 0,
          displayName: 'Bookmarks Bar'
        },
        {
          id: '10',
          title: 'Tech',
          path: 'Bookmarks Bar/Tech',
          parentId: '1',
          depth: 1,
          displayName: '\u00A0\u00A0Tech'
        },
        {
          id: '100',
          title: 'Development',
          path: 'Bookmarks Bar/Tech/Development',
          parentId: '10',
          depth: 2,
          displayName: '\u00A0\u00A0\u00A0\u00A0Development'
        },
        {
          id: '102',
          title: 'Design',
          path: 'Bookmarks Bar/Tech/Design',
          parentId: '10',
          depth: 2,
          displayName: '\u00A0\u00A0\u00A0\u00A0Design'
        },
        {
          id: '11',
          title: 'News',
          path: 'Bookmarks Bar/News',
          parentId: '1',
          depth: 1,
          displayName: '\u00A0\u00A0News'
        },
        {
          id: '2',
          title: 'Other Bookmarks',
          path: 'Other Bookmarks',
          parentId: '0',
          depth: 0,
          displayName: 'Other Bookmarks'
        }
      ]);
    });
  });
  describe('BookmarkManager.ensureFolderPath', () => {
    it('creates nested folders along the path and returns the leaf folder', async () => {
      mockBookmarkGetTree.mockResolvedValue([{
        id: '0', title: '', children: [
          { id: '1', parentId: '0', title: 'Bookmarks Bar', children: [] }
        ]
      }]);

      const createCalls: any[] = [];
      mockBookmarkCreate.mockImplementation(async (arg: any) => {
        createCalls.push(arg);
        return { id: String(20 + createCalls.length), title: arg.title, parentId: arg.parentId };
      });

      const result = await BookmarkManager.ensureFolderPath('커뮤니티/정치');
      // First creation (Community id 21) attached under Bookmarks Bar (id 1), second creation (Politics id 22) attached under Community (id 21)
      expect(result).toEqual({ id: '22', path: 'Bookmarks Bar/커뮤니티/정치' });
      expect(createCalls).toEqual([
        { parentId: '1', title: '커뮤니티' },
        { parentId: '21', title: '정치' }
      ]);
    });

    it('reuses existing folder path segments (system root prefix 제거 매칭)', async () => {
      mockBookmarkGetTree.mockResolvedValue([{
        id: '0', title: '', children: [
          {
            id: '1', parentId: '0', title: 'Bookmarks Bar', children: [
              { id: '10', parentId: '1', title: '커뮤니티', children: [] }
            ]
          }
        ]
      }]);

      const createCalls: any[] = [];
      mockBookmarkCreate.mockImplementation(async (arg: any) => {
        createCalls.push(arg);
        return { id: '99', title: arg.title, parentId: arg.parentId };
      });

      const result = await BookmarkManager.ensureFolderPath('커뮤니티/정치');
      expect(result).toEqual({ id: '99', path: 'Bookmarks Bar/커뮤니티/정치' });
      expect(createCalls).toEqual([{ parentId: '10', title: '정치' }]);
    });

    it('normalizeFolderPath strips system root names', async () => {
      const { normalizeFolderPath } = await import('../../src/lib/bookmarks/bookmark-manager');
      expect(normalizeFolderPath('Bookmarks Bar/커뮤니티')).toBe('커뮤니티');
      expect(normalizeFolderPath('Other Bookmarks/개발')).toBe('개발');
      expect(normalizeFolderPath('커뮤니티/정치')).toBe('커뮤니티/정치');
      expect(normalizeFolderPath('Other bookmarks')).toBe('');
      expect(normalizeFolderPath('Bookmarks bar')).toBe('');
    });

    it('returns root folder and does not create subfolder when path is a system root name itself', async () => {
      mockBookmarkGetTree.mockResolvedValue([{
        id: '0', title: '', children: [
          { id: '1', parentId: '0', title: 'Bookmarks Bar', children: [] },
          { id: '2', parentId: '0', title: 'Other bookmarks', children: [] }
        ]
      }]);

      const createCalls: any[] = [];
      mockBookmarkCreate.mockImplementation(async (arg: any) => {
        createCalls.push(arg);
        return { id: '99', title: arg.title, parentId: arg.parentId };
      });

      const resultOther = await BookmarkManager.ensureFolderPath('Other bookmarks');
      expect(resultOther).toEqual({ id: '2', path: 'Other bookmarks' });

      const resultBar = await BookmarkManager.ensureFolderPath('Bookmarks Bar');
      expect(resultBar).toEqual({ id: '1', path: 'Bookmarks Bar' });

      const resultEmpty = await BookmarkManager.ensureFolderPath('');
      expect(resultEmpty).toBeNull();

      expect(createCalls.length).toBe(0);
    });

    it('creates nested folders inside Other bookmarks when path starts with Other bookmarks', async () => {
      mockBookmarkGetTree.mockResolvedValue([{
        id: '0', title: '', children: [
          { id: '1', parentId: '0', title: 'Bookmarks Bar', children: [] },
          { id: '2', parentId: '0', title: 'Other bookmarks', children: [] }
        ]
      }]);

      const createCalls: any[] = [];
      mockBookmarkCreate.mockImplementation(async (arg: any) => {
        createCalls.push(arg);
        return { id: String(30 + createCalls.length), title: arg.title, parentId: arg.parentId };
      });

      const result = await BookmarkManager.ensureFolderPath('Other bookmarks/개발/백엔드');
      expect(result).toEqual({ id: '32', path: 'Other bookmarks/개발/백엔드' });
      expect(createCalls).toEqual([
        { parentId: '2', title: '개발' },
        { parentId: '31', title: '백엔드' }
      ]);
    });

    it('isUncategorizedBookmark — 시스템 루트 직속/빈 경로면 미분류', async () => {
      const { isUncategorizedBookmark } = await import('../../src/lib/bookmarks/bookmark-manager');
      expect(isUncategorizedBookmark({ folderPath: '' })).toBe(true);
      expect(isUncategorizedBookmark({ folderPath: 'Bookmarks bar' })).toBe(true);
      expect(isUncategorizedBookmark({ folderPath: 'Other bookmarks' })).toBe(true);
      expect(isUncategorizedBookmark({ folderPath: undefined })).toBe(true);
    });

    it('isUncategorizedBookmark — 하위 폴더에 배치되면 분류됨', async () => {
      const { isUncategorizedBookmark } = await import('../../src/lib/bookmarks/bookmark-manager');
      expect(isUncategorizedBookmark({ folderPath: '커뮤니티' })).toBe(false);
      expect(isUncategorizedBookmark({ folderPath: 'Bookmarks bar/커뮤니티/사회' })).toBe(false);
      expect(isUncategorizedBookmark({ folderPath: 'Other bookmarks/개발' })).toBe(false);
    });
  });

  describe('resolveSuggestedFolder', () => {
    it('suggestedFolderId가 기존 폴더에 있으면 해당 폴더 id/path를 반환한다', async () => {
      const { resolveSuggestedFolder } = await import('../../src/lib/bookmarks/bookmark-manager');
      const folders = [
        { id: 'f1', title: '개발', path: '개발' },
        { id: 'f2', title: '디자인', path: '디자인' }
      ];
      const result = await resolveSuggestedFolder('f2', '아무이름', folders);
      expect(result).toEqual({ id: 'f2', path: '디자인' });
    });

    it('suggestedFolderName이 정규화 경로와 일치하면 해당 폴더를 반환한다 (시스템 루트 접두 제거 매칭)', async () => {
      const { resolveSuggestedFolder } = await import('../../src/lib/bookmarks/bookmark-manager');
      const folders = [
        { id: 'f1', title: '개발', path: 'Bookmarks Bar/개발' }
      ];
      const result = await resolveSuggestedFolder(null, '개발', folders);
      expect(result).toEqual({ id: 'f1', path: 'Bookmarks Bar/개발' });
    });

    it('suggestedFolderName이 title/displayName 단일 이름과 일치하면 해당 폴더를 반환한다', async () => {
      const { resolveSuggestedFolder } = await import('../../src/lib/bookmarks/bookmark-manager');
      const folders = [
        { id: 'f1', title: '개발자료' },
        { id: 'f2', title: '기타', displayName: '디자인팀' }
      ];
      // title matching
      expect(await resolveSuggestedFolder(null, '개발자료', folders)).toEqual({ id: 'f1', path: '개발자료' });
      // displayName matching
      expect(await resolveSuggestedFolder(null, '디자인팀', folders)).toEqual({ id: 'f2', path: '기타' });
    });

    it('매칭 실패 시 ensureFolderPath로 계층 폴더를 자동 생성한다', async () => {
      const { resolveSuggestedFolder } = await import('../../src/lib/bookmarks/bookmark-manager');
      mockBookmarkGetTree.mockResolvedValue([{
        id: '0', title: '', children: [
          { id: '1', parentId: '0', title: 'Bookmarks Bar', children: [] }
        ]
      }]);
      const createCalls: any[] = [];
      mockBookmarkCreate.mockImplementation(async (arg: any) => {
        createCalls.push(arg);
        return { id: String(20 + createCalls.length), title: arg.title, parentId: arg.parentId };
      });

      const result = await resolveSuggestedFolder(null, '커뮤니티/정치', []);
      expect(result).toEqual({ id: '22', path: 'Bookmarks Bar/커뮤니티/정치' });
      expect(createCalls).toEqual([
        { parentId: '1', title: '커뮤니티' },
        { parentId: '21', title: '정치' }
      ]);
    });

    it('suggestedFolderId 미일치 + 이름 없음(빈 문자열/공백)이면 null을 반환한다', async () => {
      const { resolveSuggestedFolder } = await import('../../src/lib/bookmarks/bookmark-manager');
      const folders = [{ id: 'f1', title: '개발', path: '개발' }];
      expect(await resolveSuggestedFolder('unknown-id', '', folders)).toBeNull();
      expect(await resolveSuggestedFolder(null, '   ', folders)).toBeNull();
    });

    it('suggestedFolderName이 시스템 루트 포함 경로여도 정규화 경로로 기존 폴더에 매칭된다 (P2-2 회귀 방지)', async () => {
      const { resolveSuggestedFolder } = await import('../../src/lib/bookmarks/bookmark-manager');
      // Even if AI suggests a path including system root like "Bookmarks Bar/Community",
      // if normalized path "Community" folder exists in folders, it matches and returns existing folder id
      const folders = [{ id: 'f1', title: '커뮤니티', path: '커뮤니티' }];
      const ensureSpy = vi.spyOn(BookmarkManager, 'ensureFolderPath');

      const result = await resolveSuggestedFolder(null, 'Bookmarks Bar/커뮤니티', folders);

      expect(result).toEqual({ id: 'f1', path: '커뮤니티' });
      // Existing folder match succeeded -> ensureFolderPath auto-creation is not called
      expect(ensureSpy).not.toHaveBeenCalled();
      ensureSpy.mockRestore();
    });

    it('ensureFolderPath가 reject하면 null을 반환한다 (P2-3 회귀 방지)', async () => {
      const { resolveSuggestedFolder } = await import('../../src/lib/bookmarks/bookmark-manager');
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const ensureSpy = vi
        .spyOn(BookmarkManager, 'ensureFolderPath')
        .mockRejectedValue(new Error('create failed'));

      const result = await resolveSuggestedFolder(null, '신규폴더/생성실패', []);

      expect(result).toBeNull();
      ensureSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('getRootFolderName', () => {
    it('recognizes depth-1 root names from folderPath', async () => {
      const { getRootFolderName } = await import('../../src/lib/bookmarks/bookmark-manager');
      expect(getRootFolderName('Bookmarks bar/개발')).toBe('Bookmarks bar');
      expect(getRootFolderName('Bookmarks Bar/News')).toBe('Bookmarks Bar');
      expect(getRootFolderName('Other bookmarks/자료')).toBe('Other bookmarks');
      expect(getRootFolderName('Other Bookmarks/Tech')).toBe('Other Bookmarks');
      expect(getRootFolderName('Mobile bookmarks/뉴스')).toBe('Mobile bookmarks');
      expect(getRootFolderName('Bookmarks Menu/Tools')).toBe('Bookmarks Menu');
      expect(getRootFolderName('Bookmarks Toolbar/Feeds')).toBe('Bookmarks Toolbar');
    });

    it('recognizes custom root folder from folders list', async () => {
      const { getRootFolderName } = await import('../../src/lib/bookmarks/bookmark-manager');
      const folders = [
        { id: 'c1', title: 'Custom Root', path: 'Custom Root' },
        { id: 'c2', title: 'Sub', path: 'Custom Root/Sub' }
      ];
      expect(getRootFolderName('Custom Root/Sub', folders)).toBe('Custom Root');
    });

    it('defaults to Bookmarks bar if empty, undefined, or not matched', async () => {
      const { getRootFolderName } = await import('../../src/lib/bookmarks/bookmark-manager');
      expect(getRootFolderName('')).toBe('Bookmarks bar');
      expect(getRootFolderName(undefined)).toBe('Bookmarks bar');
      expect(getRootFolderName('개발/프론트엔드')).toBe('Bookmarks bar');
    });
  });

  describe('BookmarkManager.ensureFolderPath with targetRootName', () => {
    it('creates folder under targetRootName when specified', async () => {
      mockBookmarkGetTree.mockResolvedValue([{
        id: '0', title: '', children: [
          { id: '1', parentId: '0', title: 'Bookmarks Bar', children: [] },
          { id: '2', parentId: '0', title: 'Other Bookmarks', children: [] }
        ]
      }]);

      const createCalls: any[] = [];
      mockBookmarkCreate.mockImplementation(async (arg: any) => {
        createCalls.push(arg);
        return { id: String(30 + createCalls.length), title: arg.title, parentId: arg.parentId };
      });

      const result = await BookmarkManager.ensureFolderPath('자료/연구', 'Other Bookmarks');
      expect(result).toEqual({ id: '32', path: 'Other Bookmarks/자료/연구' });
      expect(createCalls).toEqual([
        { parentId: '2', title: '자료' },
        { parentId: '31', title: '연구' }
      ]);
    });
  });

  describe('resolveSuggestedFolderWithRoot', () => {
    it('returns same-root when matched folder is in the same root', async () => {
      const { resolveSuggestedFolderWithRoot } = await import('../../src/lib/bookmarks/bookmark-manager');
      const folders = [
        { id: 'f1', title: 'Bookmarks bar', path: 'Bookmarks bar' },
        { id: 'f2', title: '개발', path: 'Bookmarks bar/개발' },
        { id: 'f3', title: 'Other bookmarks', path: 'Other bookmarks' },
        { id: 'f4', title: '개발', path: 'Other bookmarks/개발' }
      ];

      // Current bookmark is in Bookmarks bar
      const result = await resolveSuggestedFolderWithRoot(null, '개발', folders, 'Bookmarks bar/기타');
      expect(result).toEqual({
        action: 'same-root',
        targetFolder: { id: 'f2', path: 'Bookmarks bar/개발' },
        currentRoot: 'Bookmarks bar',
        targetRoot: 'Bookmarks bar',
        cleanPath: '개발'
      });
    });

    it('returns cross-root when matched folder only exists in another root', async () => {
      const { resolveSuggestedFolderWithRoot } = await import('../../src/lib/bookmarks/bookmark-manager');
      const folders = [
        { id: 'f1', title: 'Bookmarks bar', path: 'Bookmarks bar' },
        { id: 'f3', title: 'Other bookmarks', path: 'Other bookmarks' },
        { id: 'f4', title: '자료실', path: 'Other bookmarks/자료실' }
      ];

      // Current bookmark is in Bookmarks bar, but folder exists in Other bookmarks
      const result = await resolveSuggestedFolderWithRoot(null, '자료실', folders, 'Bookmarks bar/기타');
      expect(result).toEqual({
        action: 'cross-root',
        targetFolder: { id: 'f4', path: 'Other bookmarks/자료실' },
        currentRoot: 'Bookmarks bar',
        targetRoot: 'Other bookmarks',
        cleanPath: '자료실',
        crossRoot: true
      });
    });

    it('returns cross-root when suggestedFolderId points to folder in another root', async () => {
      const { resolveSuggestedFolderWithRoot } = await import('../../src/lib/bookmarks/bookmark-manager');
      const folders = [
        { id: 'f1', title: 'Bookmarks bar', path: 'Bookmarks bar' },
        { id: 'f3', title: 'Other bookmarks', path: 'Other bookmarks' },
        { id: 'f4', title: '자료실', path: 'Other bookmarks/자료실' }
      ];

      const result = await resolveSuggestedFolderWithRoot('f4', '아무이름', folders, 'Bookmarks bar/기타');
      expect(result).toEqual({
        action: 'cross-root',
        targetFolder: { id: 'f4', path: 'Other bookmarks/자료실' },
        currentRoot: 'Bookmarks bar',
        targetRoot: 'Other bookmarks',
        cleanPath: '아무이름',
        crossRoot: true
      });
    });

    it('returns same-root even if suggestedFolderId points to another root when current root already has matching folder', async () => {
      const { resolveSuggestedFolderWithRoot } = await import('../../src/lib/bookmarks/bookmark-manager');
      const folders = [
        { id: 'f1', title: 'Bookmarks bar', path: 'Bookmarks bar' },
        { id: 'f2', title: '커뮤니티', path: 'Bookmarks bar/커뮤니티' },
        { id: 'f3', title: 'Other bookmarks', path: 'Other bookmarks' },
        { id: 'f4', title: '커뮤니티', path: 'Other bookmarks/커뮤니티' }
      ];

      // Current bookmark is in Other bookmarks, AI recommended f2 (Bookmarks bar/Community)
      const result = await resolveSuggestedFolderWithRoot('f2', '커뮤니티', folders, 'Other bookmarks');
      expect(result).toEqual({
        action: 'same-root',
        targetFolder: { id: 'f4', path: 'Other bookmarks/커뮤니티' },
        currentRoot: 'Other bookmarks',
        targetRoot: 'Other bookmarks',
        cleanPath: '커뮤니티'
      });
    });

    it('returns create-new when no match in any root', async () => {
      const { resolveSuggestedFolderWithRoot } = await import('../../src/lib/bookmarks/bookmark-manager');
      const folders = [
        { id: 'f1', title: 'Bookmarks bar', path: 'Bookmarks bar' },
        { id: 'f2', title: '개발', path: 'Bookmarks bar/개발' }
      ];

      const result = await resolveSuggestedFolderWithRoot(null, '신규카테고리', folders, 'Bookmarks bar');
      expect(result).toEqual({
        action: 'create-new',
        currentRoot: 'Bookmarks bar',
        targetRoot: 'Bookmarks bar',
        cleanPath: '신규카테고리'
      });
    });

    it('Scrapling 시나리오: AI/StableDiffusion/Tools와 Bookmarks bar/Tools가 공존할 때 "Tools" 제안 시 루트 Bookmarks bar/Tools로 정상 매칭', async () => {
      const { resolveSuggestedFolderWithRoot } = await import('../../src/lib/bookmarks/bookmark-manager');
      const folders = [
        { id: 'f1', title: 'Bookmarks bar', path: 'Bookmarks bar' },
        { id: 'f_deep', title: 'Tools', path: 'Bookmarks bar/AI/StableDiffusion/Tools' },
        { id: 'f_root', title: 'Tools', path: 'Bookmarks bar/Tools' }
      ];

      const result = await resolveSuggestedFolderWithRoot(null, 'Tools', folders, 'Bookmarks bar');
      expect(result).toEqual({
        action: 'same-root',
        targetFolder: { id: 'f_root', path: 'Bookmarks bar/Tools' },
        currentRoot: 'Bookmarks bar',
        targetRoot: 'Bookmarks bar',
        cleanPath: 'Tools'
      });
    });

    it('Scrapling 시나리오: AI/StableDiffusion/Tools만 있을 때 "AI/Tools" 제안 시 납치되지 않고 create-new 반환', async () => {
      const { resolveSuggestedFolderWithRoot } = await import('../../src/lib/bookmarks/bookmark-manager');
      const folders = [
        { id: 'f1', title: 'Bookmarks bar', path: 'Bookmarks bar' },
        { id: 'f_deep', title: 'Tools', path: 'Bookmarks bar/AI/StableDiffusion/Tools' }
      ];

      const result = await resolveSuggestedFolderWithRoot(null, 'AI/Tools', folders, 'Bookmarks bar');
      expect(result).toEqual({
        action: 'create-new',
        currentRoot: 'Bookmarks bar',
        targetRoot: 'Bookmarks bar',
        cleanPath: 'AI/Tools'
      });
    });
  });

  describe('BookmarkManager.findDuplicate', () => {
    it('should find exact URL match', async () => {
      stores.bookmarks.push({
        id: 1,
        bookmarkId: 'bk-1',
        url: 'https://example.com/page',
        title: 'Example',
        folderPath: '',
        description: '',
          createdAt: Date.now(),
        modifiedAt: Date.now(),
        visitCount: 0
      });

      const found = await BookmarkManager.findDuplicate('https://example.com/page');
      expect(found).toBeDefined();
      expect(found?.id).toBe(1);
    });

    it('should find normalized URL match with protocol or trailing slash difference', async () => {
      stores.bookmarks.push({
        id: 2,
        bookmarkId: 'bk-2',
        url: 'https://example.com/page/',
        title: 'Example Trailing',
        folderPath: '',
        description: '',
          createdAt: Date.now(),
        modifiedAt: Date.now(),
        visitCount: 0
      });

      const found = await BookmarkManager.findDuplicate('http://example.com/page');
      expect(found).toBeDefined();
      expect(found?.id).toBe(2);
    });

    it('should return undefined when no duplicate exists', async () => {
      stores.bookmarks.push({
        id: 3,
        bookmarkId: 'bk-3',
        url: 'https://example.com/page',
        title: 'Example',
        folderPath: '',
        description: '',
          createdAt: Date.now(),
        modifiedAt: Date.now(),
        visitCount: 0
      });

      const found = await BookmarkManager.findDuplicate('https://different.com/page');
      expect(found).toBeUndefined();
    });
  });

  describe('BookmarkManager.updateBookmark modifiedAt 조건부 갱신', () => {
    beforeEach(() => {
      stores.bookmarks = [];
      stores.archivedPages = [];
      stores.nextBookmarkId = 1;
      vi.clearAllMocks();
      (BookmarkManager as any).isListening = false;

      mockBookmarkGetTree.mockResolvedValue([{
        id: '0',
        title: 'Root',
        children: [{ id: '1', title: 'Bookmarks Bar', children: [] }]
      }]);

      BookmarkManager.listen();

      stores.bookmarks.push({
        id: 1,
        bookmarkId: 'bk-1',
        url: 'https://example.com',
        title: 'Example',
        folderPath: '',
        description: '',
          tags: undefined,
        createdAt: 1000,
        modifiedAt: 1000,
        visitCount: 0
      });
    });

    it('aiStatus만 update → modifiedAt 미갱신', async () => {
      await BookmarkManager.updateBookmark(1, { aiStatus: 'done' });
      expect(stores.bookmarks[0].aiStatus).toBe('done');
      expect(stores.bookmarks[0].modifiedAt).toBe(1000);
    });

    it('tags 포함 update → modifiedAt = Date.now()', async () => {
      await BookmarkManager.updateBookmark(1, { tags: ['dev'] });
      expect(stores.bookmarks[0].tags).toEqual(['dev']);
      expect(stores.bookmarks[0].modifiedAt).toBeGreaterThan(1000);
    });

    it('tags 포함 update 시 공백이 완전히 제거된다', async () => {
      await BookmarkManager.updateBookmark(1, { tags: ['web development', '인공 지능', ' #TypeScript '] });
      expect(stores.bookmarks[0].tags).toEqual(['webdevelopment', '인공지능', 'TypeScript']);
    });

    it('folderPath 변경 update → ensureFolderPath 및 browser.bookmarks.move 호출', async () => {
      mockBookmarkGet.mockResolvedValue([{ id: 'bk-1', parentId: '1' }]);
      mockBookmarkCreate.mockResolvedValue({ id: 'f-100', title: 'Svelte', parentId: '1' });

      await BookmarkManager.updateBookmark(1, { folderPath: '개발/Svelte' });

      expect(stores.bookmarks[0].folderPath).toBe('개발/Svelte');
      expect(mockBookmarkMove).toHaveBeenCalledWith('bk-1', { parentId: expect.any(String) });
    });
  });

  describe('BookmarkManager.syncAll folderPath 정규화 비교', () => {
    beforeEach(() => {
      stores.bookmarks = [];
      stores.archivedPages = [];
      stores.nextBookmarkId = 1;
      vi.clearAllMocks();
      (BookmarkManager as any).isListening = false;
    });

    it('시스템 루트 접두가 포함된 경로와 로컬 DB 정규화 경로가 동일하면 modifiedAt을 오염시키지 않는다', async () => {
      // Local DB: normalized folderPath "Dev" (modifiedAt: 500)
      stores.bookmarks.push({
        id: 1,
        bookmarkId: 'bk-1',
        url: 'https://example.com',
        title: 'Example',
        folderPath: '개발',
        createdAt: 500,
        modifiedAt: 500,
        visitCount: 0
      });

      // Browser tree: located under "Bookmarks Bar/Dev"
      mockBookmarkGetTree.mockResolvedValue([{
        id: '0',
        title: 'root',
        children: [
          {
            id: '1',
            title: 'Bookmarks Bar',
            children: [
              {
                id: '10',
                parentId: '1',
                title: '개발',
                children: [
                  {
                    id: 'bk-1',
                    parentId: '10',
                    title: 'Example',
                    url: 'https://example.com',
                    dateAdded: 500
                  }
                ]
              }
            ]
          }
        ]
      }]);

      await BookmarkManager.syncAll();

      // modifiedAt should remain 500 (not polluted by Date.now())
      expect(stores.bookmarks[0].modifiedAt).toBe(500);
      // folderPath format updated to browser full path
      expect(stores.bookmarks[0].folderPath).toBe('Bookmarks Bar/개발');
    });

    it('Bookmarks Bar에서 Other bookmarks로 이동된 경우 변경을 감지하여 modifiedAt을 갱신한다', async () => {
      // Local DB: Bookmarks Bar/Dev (modifiedAt: 500)
      stores.bookmarks.push({
        id: 1,
        bookmarkId: 'bk-1',
        url: 'https://example.com',
        title: 'Example',
        folderPath: 'Bookmarks Bar/개발',
        createdAt: 500,
        modifiedAt: 500,
        visitCount: 0
      });

      // Browser tree: moved under "Other bookmarks/Dev"
      mockBookmarkGetTree.mockResolvedValue([{
        id: '0',
        title: 'root',
        children: [
          {
            id: '2',
            title: 'Other bookmarks',
            children: [
              {
                id: '20',
                parentId: '2',
                title: '개발',
                children: [
                  {
                    id: 'bk-1',
                    parentId: '20',
                    title: 'Example',
                    url: 'https://example.com',
                    dateAdded: 500
                  }
                ]
              }
            ]
          }
        ]
      }]);

      await BookmarkManager.syncAll();

      // Moved to another root (Other bookmarks), so modifiedAt must be updated
      expect(stores.bookmarks[0].modifiedAt).toBeGreaterThan(500);
      expect(stores.bookmarks[0].folderPath).toBe('Other bookmarks/개발');
    });

    it('루트 직속 간 이동(Bookmarks Bar -> Other bookmarks)을 감지하여 갱신한다', async () => {
      stores.bookmarks.push({
        id: 1,
        bookmarkId: 'bk-root',
        url: 'https://example.com/root',
        title: 'Root Item',
        folderPath: 'Bookmarks Bar',
        createdAt: 500,
        modifiedAt: 500,
        visitCount: 0
      });

      mockBookmarkGetTree.mockResolvedValue([{
        id: '0',
        title: 'root',
        children: [
          {
            id: '2',
            title: 'Other bookmarks',
            children: [
              {
                id: 'bk-root',
                parentId: '2',
                title: 'Root Item',
                url: 'https://example.com/root',
                dateAdded: 500
              }
            ]
          }
        ]
      }]);

      await BookmarkManager.syncAll();

      expect(stores.bookmarks[0].modifiedAt).toBeGreaterThan(500);
      expect(stores.bookmarks[0].folderPath).toBe('Other bookmarks');
    });

    it('브라우저 북마크 트리가 비어있을 때 로컬 DB의 북마크를 삭제하지 않는다 (Fail-safe)', async () => {
      stores.bookmarks.push({
        id: 1,
        bookmarkId: 'bk-keep-1',
        url: 'https://keep-me.com',
        title: 'Keep Me',
        folderPath: 'Bookmarks Bar',
        createdAt: 500,
        modifiedAt: 500,
        visitCount: 0
      });

      mockBookmarkGetTree.mockResolvedValue([{
        id: '0',
        title: 'root',
        children: []
      }]);

      await BookmarkManager.syncAll();

      // Local DB bookmark must be retained without deletion
      expect(stores.bookmarks).toHaveLength(1);
      expect(stores.bookmarks[0].bookmarkId).toBe('bk-keep-1');
    });

    it('bookmarkId가 변경되었으나 URL이 일치하는 경우 URL Fallback으로 syncId/태그/설명을 보존하고 bookmarkId를 갱신한다', async () => {
      stores.bookmarks.push({
        id: 1,
        syncId: 'sync-preserve-uuid',
        bookmarkId: 'bk-old-id',
        url: 'https://matched-by-url.com',
        title: 'Old Title',
        folderPath: 'Bookmarks Bar/개발',
        description: 'Important Note',
        tags: ['pinned'],
        createdAt: 100,
        modifiedAt: 100,
        visitCount: 5
      });

      // Exists in browser with new bookmarkId 'bk-new-id'
      mockBookmarkGetTree.mockResolvedValue([{
        id: '0',
        title: 'root',
        children: [
          {
            id: '1',
            title: 'Bookmarks Bar',
            children: [
              {
                id: '10',
                parentId: '1',
                title: '개발',
                children: [
                  {
                    id: 'bk-new-id',
                    parentId: '10',
                    title: 'New Title',
                    url: 'https://matched-by-url.com',
                    dateAdded: 300
                  }
                ]
              }
            ]
          }
        ]
      }]);

      await BookmarkManager.syncAll();

      // Existing record (id: 1) is updated without creating a new record
      expect(stores.bookmarks).toHaveLength(1);
      expect(stores.bookmarks[0].id).toBe(1);
      expect(stores.bookmarks[0].syncId).toBe('sync-preserve-uuid');
      expect(stores.bookmarks[0].bookmarkId).toBe('bk-new-id');
      expect(stores.bookmarks[0].title).toBe('New Title');
      expect(stores.bookmarks[0].description).toBe('Important Note');
      expect(stores.bookmarks[0].tags).toEqual(['pinned']);
      expect(stores.bookmarks[0].createdAt).toBe(100);
    });

    it('브라우저에서 삭제된 북마크 정리 시 tombstone을 기록한다', async () => {
      stores.bookmarks.push({
        id: 1,
        syncId: 'sync-orphan-uuid',
        bookmarkId: 'bk-orphan-id',
        url: 'https://orphan.com',
        title: 'Orphan',
        folderPath: 'Bookmarks Bar',
        createdAt: 100,
        modifiedAt: 100,
        visitCount: 0
      });

      // Only other bookmarks exist in browser tree (orphan deleted)
      mockBookmarkGetTree.mockResolvedValue([{
        id: '0',
        title: 'root',
        children: [
          {
            id: '1',
            title: 'Bookmarks Bar',
            children: [
              {
                id: 'bk-active',
                parentId: '1',
                title: 'Active Bookmark',
                url: 'https://active.com',
                dateAdded: 500
              }
            ]
          }
        ]
      }]);

      await BookmarkManager.syncAll();

      // Orphan bookmark deleted and only active bookmark exists
      expect(stores.bookmarks.find(b => b.syncId === 'sync-orphan-uuid')).toBeUndefined();
      expect(stores.bookmarks.find(b => b.bookmarkId === 'bk-active')).toBeDefined();

      // Verify tombstone was recorded
      const tombstones = stores.settings.get('sync_tombstones');
      expect(Array.isArray(tombstones)).toBe(true);
      expect(tombstones.find((t: any) => t.syncId === 'sync-orphan-uuid')).toBeDefined();
    });

    it('신규 북마크 추가 시 URL 기반 결정적 syncId(generateDeterministicSyncId)를 발급한다', async () => {
      mockBookmarkGetTree.mockResolvedValue([{
        id: '0',
        title: 'root',
        children: [
          {
            id: '1',
            title: 'Bookmarks Bar',
            children: [
              {
                id: 'bk-det-1',
                parentId: '1',
                title: 'Deterministic Test',
                url: 'https://deterministic-test.com',
                dateAdded: 500
              }
            ]
          }
        ]
      }]);

      await BookmarkManager.syncAll();

      expect(stores.bookmarks).toHaveLength(1);
      const expectedSyncId = generateDeterministicSyncId('https://deterministic-test.com');
      expect(stores.bookmarks[0].syncId).toBe(expectedSyncId);
    });

    it('createBookmark 호출 시 URL 기반 결정적 syncId를 발급한다', async () => {
      mockBookmarkCreate.mockResolvedValue({
        id: 'bk-created-node',
        parentId: '1',
        title: 'Created Test',
        url: 'https://created-test.com',
        dateAdded: 600
      });

      const b = await BookmarkManager.createBookmark('https://created-test.com', 'Created Test', '1');
      const expectedSyncId = generateDeterministicSyncId('https://created-test.com');
      expect(b.syncId).toBe(expectedSyncId);
      expect(stores.bookmarks.find(x => x.syncId === expectedSyncId)).toBeDefined();
    });
  });

  describe('BookmarkManager isSyncMuted', () => {
    beforeEach(() => {
      stores.bookmarks = [];
      stores.archivedPages = [];
      stores.nextBookmarkId = 1;
      vi.clearAllMocks();
      (BookmarkManager as any).isListening = false;
      BookmarkManager.listen();
    });

    it('isSyncMuted가 true일 때 onCreated, onRemoved, onChanged, onMoved 리스너가 DB를 변경하지 않는다', async () => {
      BookmarkManager.setSyncMuted(true);
      expect(BookmarkManager.isSyncMuted).toBe(true);

      const onCreatedCb = mockOnCreatedAddListener.mock.calls[0]?.[0];
      const onRemovedCb = mockOnRemovedAddListener.mock.calls[0]?.[0];
      const onChangedCb = mockOnChangedAddListener.mock.calls[0]?.[0];
      const onMovedCb = mockOnMovedAddListener.mock.calls[0]?.[0];

      // 1. Ignore onCreated
      await onCreatedCb('bk-new', { url: 'https://new.com', title: 'New', parentId: '1' });
      expect(stores.bookmarks).toHaveLength(0);

      // Add existing record
      stores.bookmarks.push({
        id: 1,
        bookmarkId: 'bk-existing',
        syncId: 'sync-existing',
        url: 'https://existing.com',
        title: 'Existing',
        folderPath: '',
        createdAt: 100,
        modifiedAt: 100,
        visitCount: 0
      });

      // 2. Ignore onChanged
      await onChangedCb('bk-existing', { title: 'Updated Title' });
      expect(stores.bookmarks[0].title).toBe('Existing');

      // 3. Ignore onMoved
      await onMovedCb('bk-existing', { parentId: '2' });
      expect(stores.bookmarks[0].folderPath).toBe('');

      // 4. Ignore onRemoved
      await onRemovedCb('bk-existing', {});
      expect(stores.bookmarks).toHaveLength(1);

      // Release Muted
      BookmarkManager.setSyncMuted(false);
      expect(BookmarkManager.isSyncMuted).toBe(false);
    });
  });

  describe('isSameFolderLocation', () => {
    it('시스템 루트가 다르면 다른 위치로 판별한다', async () => {
      const { isSameFolderLocation } = await import('../../src/lib/bookmarks/bookmark-manager');
      expect(isSameFolderLocation('Bookmarks bar', 'Other bookmarks')).toBe(false);
      expect(isSameFolderLocation('Bookmarks bar/개발', 'Other bookmarks/개발')).toBe(false);
      expect(isSameFolderLocation('기타 북마크/개발', 'Bookmarks bar/개발')).toBe(false);
    });

    it('동일 시스템 루트 및 하위 경로면 동일 위치로 판별한다', async () => {
      const { isSameFolderLocation } = await import('../../src/lib/bookmarks/bookmark-manager');
      expect(isSameFolderLocation('Other bookmarks/개발', 'Other bookmarks/개발')).toBe(true);
      expect(isSameFolderLocation('Bookmarks bar/개발', '개발')).toBe(true); // Compatible since default root is Bookmarks bar
    });

    it('하위 경로가 다르면 다른 위치로 판별한다', async () => {
      const { isSameFolderLocation } = await import('../../src/lib/bookmarks/bookmark-manager');
      expect(isSameFolderLocation('Other bookmarks/개발', 'Other bookmarks/디자인')).toBe(false);
      expect(isSameFolderLocation('Bookmarks bar/개발', 'Bookmarks bar/기획')).toBe(false);
    });
  });

  describe('BookmarkManager.createFolder & deleteFolder', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockBookmarkGetTree.mockResolvedValue([{
        id: '0',
        title: 'Root',
        children: [{ id: '1', title: 'Bookmarks Bar', children: [] }]
      }]);
    });

    it('단일 폴더 생성 시 browser.bookmarks.create를 호출하고 생성된 폴더를 반환한다', async () => {
      mockBookmarkCreate.mockResolvedValue({ id: 'f-new', title: '새폴더', parentId: '1' });

      const created = await BookmarkManager.createFolder('새폴더', '1');

      expect(mockBookmarkCreate).toHaveBeenCalledWith({ parentId: '1', title: '새폴더' });
      expect(created.id).toBe('f-new');
      expect(created.title).toBe('새폴더');
    });

    it('계층 폴더 생성 시 ensureFolderPath를 통해 생성한다', async () => {
      mockBookmarkCreate.mockResolvedValue({ id: 'f-sub', title: '서브', parentId: '1' });

      const created = await BookmarkManager.createFolder('개발/서브');

      expect(mockBookmarkCreate).toHaveBeenCalled();
      expect(created.id).toBe('f-sub');
    });

    it('빈 제목 전달 시 예외를 던진다', async () => {
      await expect(BookmarkManager.createFolder('   ')).rejects.toThrow('폴더 이름을 입력해주세요.');
    });

    it('deleteFolder 호출 시 browser.bookmarks.removeTree를 호출한다', async () => {
      await BookmarkManager.deleteFolder('f-100');
      expect(mockBookmarkRemoveTree).toHaveBeenCalledWith('f-100');
    });

    it('동시에 여러 요청이 동일 경로 ensureFolderPath를 호출할 때 async mutex로 중복 생성을 방지한다', async () => {
      let createCallCount = 0;
      const rootChildren: any[] = [{ id: '1', parentId: '0', title: 'Bookmarks Bar', children: [] }];
      const tree = [{
        id: '0',
        title: 'Root',
        children: rootChildren
      }];

      function findNode(node: any, id: string): any {
        if (node.id === id) return node;
        if (node.children) {
          for (const c of node.children) {
            const found = findNode(c, id);
            if (found) return found;
          }
        }
        return null;
      }

      mockBookmarkGetTree.mockImplementation(async () => JSON.parse(JSON.stringify(tree)));
      mockBookmarkCreate.mockImplementation(async ({ parentId, title }) => {
        createCallCount++;
        const newNode = { id: `folder-${createCallCount}`, title, parentId, children: [] };
        const parent = findNode(tree[0], parentId);
        if (parent) {
          parent.children.push(newNode);
        }
        await new Promise((r) => setTimeout(r, 10));
        return newNode;
      });

      // 5 concurrent ensureFolderPath calls for same folder path
      const results = await Promise.all([
        BookmarkManager.ensureFolderPath('Dev/AI', 'Bookmarks Bar'),
        BookmarkManager.ensureFolderPath('Dev/AI', 'Bookmarks Bar'),
        BookmarkManager.ensureFolderPath('Dev/AI', 'Bookmarks Bar'),
        BookmarkManager.ensureFolderPath('Dev/AI', 'Bookmarks Bar'),
        BookmarkManager.ensureFolderPath('Dev/AI', 'Bookmarks Bar')
      ]);

      // 'Dev' 1 time + 'AI' 1 time = total 2 browser.bookmarks.create calls expected
      expect(createCallCount).toBe(2);
      expect(results.every((r) => r?.id === 'folder-2')).toBe(true);
    });
  });
});