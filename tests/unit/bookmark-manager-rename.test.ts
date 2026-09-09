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
    table.put = async (row: any) => {
      const arr = getArr();
      const idx = arr.findIndex((r: any) => (row.id !== undefined && r.id === row.id) || (row.syncId && r.syncId === row.syncId));
      if (idx >= 0) {
        arr[idx] = { ...arr[idx], ...row };
        return arr[idx].id;
      }
      const id = row.id ?? stores.nextBookmarkId++;
      arr.push({ ...row, id });
      return id;
    };
    table.delete = async (id: number) => {
      const arr = getArr();
      const idx = arr.findIndex((r: any) => r.id === id);
      if (idx >= 0) arr.splice(idx, 1);
    };
    table.bulkPut = async (rows: any[]) => {
      for (const r of rows) await table.put(r);
    };
    table.filter = (predicate: (r: any) => boolean) => ({
      toArray: async () => getArr().filter(predicate),
      count: async () => getArr().filter(predicate).length,
      first: async () => getArr().find(predicate)
    });

    return table;
  }

  const mockDb: any = {
    bookmarks: makeTable('bookmarks'),
    archivedPages: makeTable('archivedPages'),
    settings: {
      get: vi.fn(async (key: string) => stores.settings.get(key)),
      set: vi.fn(async (key: string, val: any) => stores.settings.set(key, val)),
      put: vi.fn(async (val: any) => stores.settings.set(val.key, val.value))
    },
    syncState: {
      get: vi.fn(async () => undefined),
      put: vi.fn(async () => {})
    },
    transaction: async (_mode: string, ...args: any[]) => {
      const fn = args[args.length - 1];
      return fn();
    }
  };

  return { db: mockDb, default: mockDb };
});

import { BookmarkManager } from '../../src/lib/bookmarks/bookmark-manager';

describe('BookmarkManager.renameFolder', () => {
  let mockTree: any[] = [];

  beforeEach(() => {
    stores.bookmarks = [];
    stores.archivedPages = [];
    stores.settings.clear();
    stores.nextBookmarkId = 1;
    vi.clearAllMocks();
    (BookmarkManager as any).isListening = false;

    mockTree = [
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
                title: 'Development',
                children: [
                  {
                    id: '100',
                    parentId: '10',
                    title: 'Frontend',
                    children: []
                  },
                  {
                    id: 'bk-1',
                    parentId: '10',
                    title: 'GitHub',
                    url: 'https://github.com',
                    dateAdded: 1000
                  }
                ]
              },
              {
                id: '20',
                parentId: '1',
                title: 'Design',
                children: []
              }
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
    ];

    mockBookmarkGetTree.mockImplementation(async () => JSON.parse(JSON.stringify(mockTree)));

    mockBookmarkUpdate.mockImplementation(async (id: string, changes: any) => {
      function findAndUpdate(nodes: any[]) {
        for (const node of nodes) {
          if (node.id === id) {
            Object.assign(node, changes);
            return true;
          }
          if (node.children && findAndUpdate(node.children)) return true;
        }
        return false;
      }
      findAndUpdate(mockTree);
    });
  });

  describe('Validation', () => {
    it('throws folders.nameRequired if new title is empty or only whitespace', async () => {
      await expect(BookmarkManager.renameFolder('10', '')).rejects.toThrow(i18n.t('folders.nameRequired'));
      await expect(BookmarkManager.renameFolder('10', '   ')).rejects.toThrow(i18n.t('folders.nameRequired'));
    });

    it('throws folders.noSlashAllowed if new title contains /', async () => {
      await expect(BookmarkManager.renameFolder('10', 'Dev/Tools')).rejects.toThrow(i18n.t('folders.noSlashAllowed'));
      await expect(BookmarkManager.renameFolder('10', '/Dev')).rejects.toThrow(i18n.t('folders.noSlashAllowed'));
    });

    it('throws if folder does not exist', async () => {
      await expect(BookmarkManager.renameFolder('non-existent', 'NewTitle')).rejects.toThrow('Folder "non-existent" not found');
    });

    it('throws folders.cannotRenameSystemRoot when attempting to rename root or system root folders', async () => {
      await expect(BookmarkManager.renameFolder('0', 'Root')).rejects.toThrow(i18n.t('folders.cannotRenameSystemRoot'));
      await expect(BookmarkManager.renameFolder('root', 'Root')).rejects.toThrow(i18n.t('folders.cannotRenameSystemRoot'));
      await expect(BookmarkManager.renameFolder('1', 'My Bookmarks')).rejects.toThrow(i18n.t('folders.cannotRenameSystemRoot'));
      await expect(BookmarkManager.renameFolder('2', 'Archive')).rejects.toThrow(i18n.t('folders.cannotRenameSystemRoot'));
    });

    it('throws folders.duplicateName when a sibling folder already has the target name (case-insensitive)', async () => {
      // Sibling '20' is 'Design'
      await expect(BookmarkManager.renameFolder('10', 'Design')).rejects.toThrow(i18n.t('folders.duplicateName'));
      await expect(BookmarkManager.renameFolder('10', 'design')).rejects.toThrow(i18n.t('folders.duplicateName'));
      await expect(BookmarkManager.renameFolder('10', '  DESIGN  ')).rejects.toThrow(i18n.t('folders.duplicateName'));
    });
  });

  describe('Execution & Cascade', () => {
    it('returns without updating if new title is identical to current title', async () => {
      const res = await BookmarkManager.renameFolder('10', 'Development');
      expect(res).toEqual({
        id: '10',
        oldTitle: 'Development',
        newTitle: 'Development',
        newPath: 'Bookmarks Bar/Development'
      });
      expect(mockBookmarkUpdate).not.toHaveBeenCalled();
    });

    it('successfully renames folder, calls browser.bookmarks.update, and syncs', async () => {
      // Set initial DB bookmark under Development
      stores.bookmarks.push({
        id: 1,
        bookmarkId: 'bk-1',
        url: 'https://github.com',
        title: 'GitHub',
        folderPath: 'Bookmarks Bar/Development',
        createdAt: 1000,
        modifiedAt: 1000,
        visitCount: 0
      });

      const res = await BookmarkManager.renameFolder('10', 'Code');

      expect(mockBookmarkUpdate).toHaveBeenCalledWith('10', { title: 'Code' });
      expect(res).toEqual({
        id: '10',
        oldTitle: 'Development',
        newTitle: 'Code',
        newPath: 'Bookmarks Bar/Code'
      });

      // Verify cascade: syncAll() updated DB bookmarks' folderPath
      const updatedBm = stores.bookmarks.find((b) => b.bookmarkId === 'bk-1');
      expect(updatedBm).toBeDefined();
      expect(updatedBm.folderPath).toBe('Bookmarks Bar/Code');
    });
  });
});
