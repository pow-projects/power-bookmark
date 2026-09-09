import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';

const { mockData, dbMock } = vi.hoisted(() => {
  const data = { bookmarks: [] as any[], archivedPages: [] as any[], tombstones: [] as any[] };
  const mock = {
    bookmarks: {
      toArray: vi.fn(async () => data.bookmarks),
      get: vi.fn(async (id: number) => data.bookmarks.find(b => b.id === id)),
      add: vi.fn(async (b: any) => { data.bookmarks.push(b); return b.id; }),
      update: vi.fn(async (id: number, payload: any) => {
        const idx = data.bookmarks.findIndex(b => b.id === id);
        if (idx !== -1) data.bookmarks[idx] = { ...data.bookmarks[idx], ...payload };
      }),
      where: vi.fn(() => ({ equals: vi.fn(() => ({ first: async () => undefined, delete: async () => {} })) })),
      filter: vi.fn(() => ({ modify: vi.fn(async () => {}) })),
      delete: vi.fn(async () => {}),
      bulkAdd: vi.fn(async () => {}),
      bulkPut: vi.fn(async () => {})
    },
    archivedPages: {
      toArray: vi.fn(async () => data.archivedPages),
      where: vi.fn(() => ({ equals: vi.fn(() => ({ delete: async () => {} })) }))
    },
    tombstones: {
      toArray: vi.fn(async () => data.tombstones),
      where: vi.fn(() => ({ equals: vi.fn(() => ({ delete: async () => {} })) }))
    },
    syncState: {
      get: vi.fn(async () => undefined),
      put: vi.fn(async () => {})
    },
    settings: {
      get: vi.fn(async () => undefined)
    },
    transaction: vi.fn(async (_mode: any, ...args: any[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') return await cb();
    })
  };
  return { mockData: data, dbMock: mock };
});

vi.mock('../../src/lib/db', () => ({ db: dbMock, default: dbMock }));

const storageListeners: any[] = [];
let removeTreeCalls: string[] = [];
let treeMock: any[] = [];

function setupBrowserMock() {
  vi.stubGlobal('browser', {
    i18n: { getMessage: vi.fn((key: string) => key) },
    runtime: { sendMessage: vi.fn(async () => ({ ok: true })) },
    storage: {
      onChanged: {
        addListener: vi.fn((cb: any) => { storageListeners.push(cb); }),
        removeListener: vi.fn((cb: any) => {
          const idx = storageListeners.indexOf(cb);
          if (idx !== -1) storageListeners.splice(idx, 1);
        })
      },
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
    },
    bookmarks: {
      getTree: vi.fn(async () => treeMock),
      get: vi.fn(async (id: string) => [{ id, parentId: '1' }]),
      move: vi.fn(async () => {}),
      removeTree: vi.fn(async (id: string) => {
        removeTreeCalls.push(id);
      }),
      remove: vi.fn(async (id: string) => {
        removeTreeCalls.push(id);
      }),
      onCreated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
      onChanged: { addListener: vi.fn() },
      onMoved: { addListener: vi.fn() }
    },
    tabs: { query: vi.fn(async () => []) }
  });
}

import { BookmarkManager } from '../../src/lib/bookmarks/bookmark-manager';
import BookmarkList from '../../src/components/management/BookmarkList.svelte';

const sleep = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Clean Empty Folders Feature', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mockData.bookmarks = [];
    mockData.archivedPages = [];
    removeTreeCalls = [];
    treeMock = [];
    setupBrowserMock();
  });

  describe('BookmarkManager.findEmptyFolders & cleanEmptyFolders', () => {
    it('finds all empty folder details without modifying the tree', async () => {
      treeMock = [
        {
          id: '0',
          title: 'root',
          children: [
            {
              id: '1',
              title: 'Bookmarks Bar',
              children: [
                { id: '10', title: 'Empty1', children: [] },
                { id: '20', title: 'NonEmpty', children: [{ id: '21', title: 'BM1', url: 'https://example.com' }] },
                { id: '30', title: 'NestedParent', children: [{ id: '31', title: 'NestedChild', children: [] }] }
              ]
            },
            {
              id: '2',
              title: 'Other Bookmarks',
              children: [
                { id: '40', title: 'OtherEmpty', children: [] }
              ]
            }
          ]
        }
      ];

      const preview = await BookmarkManager.findEmptyFolders();

      expect(preview.count).toBe(4);
      expect(preview.emptyFolders.length).toBe(4);
      expect(preview.emptyFolders.map(f => f.id)).toContain('10');
      expect(preview.emptyFolders.map(f => f.id)).toContain('30');
      expect(preview.emptyFolders.map(f => f.id)).toContain('31');
      expect(preview.emptyFolders.map(f => f.id)).toContain('40');
      expect(preview.emptyFolders.map(f => f.id)).not.toContain('20');
      expect(preview.emptyFolders.map(f => f.id)).not.toContain('1');
      expect(preview.emptyFolders.map(f => f.id)).not.toContain('2');

      // findEmptyFolders does not delete anything
      expect(removeTreeCalls.length).toBe(0);
    });

    it('removes single and nested empty folders across all folders while preserving non-empty folders and system roots', async () => {
      treeMock = [
        {
          id: '0',
          title: 'root',
          children: [
            {
              id: '1',
              title: 'Bookmarks Bar',
              children: [
                { id: '10', title: 'Empty1', children: [] },
                { id: '20', title: 'NonEmpty', children: [{ id: '21', title: 'BM1', url: 'https://example.com' }] },
                { id: '30', title: 'NestedParent', children: [{ id: '31', title: 'NestedChild', children: [] }] }
              ]
            },
            {
              id: '2',
              title: 'Other Bookmarks',
              children: [
                { id: '40', title: 'OtherEmpty', children: [] }
              ]
            }
          ]
        }
      ];

      const result = await BookmarkManager.cleanEmptyFolders();

      expect(result.count).toBe(4);
      expect(result.deletedIds).toContain('10');
      expect(result.deletedIds).toContain('30');
      expect(result.deletedIds).toContain('31');
      expect(result.deletedIds).toContain('40');
      expect(result.deletedIds).not.toContain('20');
      expect(result.deletedIds).not.toContain('1');
      expect(result.deletedIds).not.toContain('2');

      expect(removeTreeCalls).toContain('10');
      expect(removeTreeCalls).toContain('30');
      expect(removeTreeCalls).toContain('40');
      expect(removeTreeCalls).not.toContain('20');
      expect(removeTreeCalls).not.toContain('1');
      expect(removeTreeCalls).not.toContain('2');
    });

    it('cleans only empty folders inside a targeted system root folder', async () => {
      treeMock = [
        {
          id: '0',
          title: 'root',
          children: [
            {
              id: '1',
              title: 'Bookmarks Bar',
              children: [
                { id: '10', title: 'EmptyBar', children: [] }
              ]
            },
            {
              id: '2',
              title: 'Other Bookmarks',
              children: [
                { id: '20', title: 'EmptyOther', children: [] }
              ]
            }
          ]
        }
      ];

      const result = await BookmarkManager.cleanEmptyFolders('1', 'Bookmarks Bar');

      expect(result.count).toBe(1);
      expect(result.deletedIds).toEqual(['10']);
      expect(removeTreeCalls).toEqual(['10']);
    });

    it('returns count 0 when all folders contain bookmarks', async () => {
      treeMock = [
        {
          id: '0',
          title: 'root',
          children: [
            {
              id: '1',
              title: 'Bookmarks Bar',
              children: [
                { id: '10', title: 'Folder1', children: [{ id: '11', title: 'BM1', url: 'https://example.com' }] }
              ]
            }
          ]
        }
      ];

      const result = await BookmarkManager.cleanEmptyFolders();

      expect(result.count).toBe(0);
      expect(result.deletedIds).toEqual([]);
      expect(removeTreeCalls).toEqual([]);
    });
  });

  describe('BookmarkList clean empty folders confirmation modal', () => {
    it('opens confirmation modal listing folders to be deleted and deletes on confirm', async () => {
      const mockFolders = [
        { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', depth: 0 },
        { id: '2', title: 'EmptyFolder', path: 'Bookmarks Bar/EmptyFolder', depth: 1, parentId: '1' },
        { id: '3', title: 'AnotherEmpty', path: 'Bookmarks Bar/AnotherEmpty', depth: 1, parentId: '1' }
      ];

      treeMock = [
        {
          id: '0',
          title: 'root',
          children: [
            {
              id: '1',
              title: 'Bookmarks Bar',
              children: [
                { id: '2', title: 'EmptyFolder', children: [] },
                { id: '3', title: 'AnotherEmpty', children: [] }
              ]
            }
          ]
        }
      ];

      const getFoldersSpy = vi.spyOn(BookmarkManager, 'getFolders').mockResolvedValue(mockFolders as any);

      const comp: any = new BookmarkList({
        target: document.body,
        props: { folders: mockFolders }
      });
      await comp.loadBookmarks();
      await tick();

      // Click clean button on root item
      const rootCleanBtn = document.querySelector('.folder-tree .root-item .row-clean') as HTMLButtonElement;
      expect(rootCleanBtn).not.toBeNull();

      rootCleanBtn.click();
      await sleep(50);
      await tick();

      // Confirmation modal should be visible with the list of folders
      const modalTitle = document.getElementById('clean-empty-folders-modal-title');
      expect(modalTitle).not.toBeNull();

      const folderItems = document.querySelectorAll('.clean-empty-folders-body .empty-folder-item');
      expect(folderItems.length).toBe(2);

      // Verify paths in modal list
      const modalText = document.querySelector('.clean-empty-folders-body')?.textContent || '';
      expect(modalText).toContain('EmptyFolder');
      expect(modalText).toContain('AnotherEmpty');

      // Click confirm button in modal
      const confirmBtn = Array.from(document.querySelectorAll('.modal-actions button.btn-danger'))
        .find(btn => btn.textContent?.includes('빈 폴더 삭제')) as HTMLButtonElement;
      expect(confirmBtn).not.toBeNull();

      confirmBtn.click();
      await sleep(50);
      await tick();

      expect(removeTreeCalls).toContain('2');
      expect(removeTreeCalls).toContain('3');
      expect(document.getElementById('clean-empty-folders-modal-title')).toBeNull();
      getFoldersSpy.mockRestore();
    });

    it('closes confirmation modal without deleting when cancel is clicked', async () => {
      const mockFolders = [
        { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', depth: 0 },
        { id: '2', title: 'EmptyFolder', path: 'Bookmarks Bar/EmptyFolder', depth: 1, parentId: '1' }
      ];

      treeMock = [
        {
          id: '0',
          title: 'root',
          children: [
            {
              id: '1',
              title: 'Bookmarks Bar',
              children: [
                { id: '2', title: 'EmptyFolder', children: [] }
              ]
            }
          ]
        }
      ];

      const getFoldersSpy = vi.spyOn(BookmarkManager, 'getFolders').mockResolvedValue(mockFolders as any);

      const comp: any = new BookmarkList({
        target: document.body,
        props: { folders: mockFolders }
      });
      await comp.loadBookmarks();
      await tick();

      const rootCleanBtn = document.querySelector('.folder-tree .root-item .row-clean') as HTMLButtonElement;
      expect(rootCleanBtn).not.toBeNull();
      rootCleanBtn.click();
      await sleep(50);
      await tick();

      expect(document.getElementById('clean-empty-folders-modal-title')).not.toBeNull();

      // Click Cancel
      const cancelBtn = Array.from(document.querySelectorAll('.modal-actions button.btn-secondary'))
        .find(btn => btn.textContent?.includes('취소')) as HTMLButtonElement;
      expect(cancelBtn).not.toBeNull();

      cancelBtn.click();
      await sleep(50);
      await tick();

      expect(removeTreeCalls.length).toBe(0);
      expect(document.getElementById('clean-empty-folders-modal-title')).toBeNull();
      getFoldersSpy.mockRestore();
    });
  });
});
