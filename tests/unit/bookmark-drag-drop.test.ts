import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';
import { get } from 'svelte/store';

const { mockData, dbMock } = vi.hoisted(() => {
  const data = { bookmarks: [] as any[], archivedPages: [] as any[] };
  const mock = {
    bookmarks: {
      toArray: vi.fn(async () => data.bookmarks),
      get: vi.fn(async (id: number) => data.bookmarks.find(b => b.id === id)),
      add: vi.fn(async (b: any) => {
        const id = data.bookmarks.length + 1;
        data.bookmarks.push({ ...b, id });
        return id;
      }),
      update: vi.fn(async (id: number, payload: any) => {
        const idx = data.bookmarks.findIndex(b => b.id === id);
        if (idx !== -1) data.bookmarks[idx] = { ...data.bookmarks[idx], ...payload };
      }),
      where: vi.fn((key: string) => ({
        equals: vi.fn((val: any) => ({
          first: async () => data.bookmarks.find(b => b[key] === val),
          delete: async () => { data.bookmarks = data.bookmarks.filter(b => b[key] !== val); }
        })),
        anyOf: vi.fn((vals: any[]) => ({
          toArray: async () => data.bookmarks.filter(b => vals.includes(b[key]))
        }))
      })),
      filter: vi.fn(() => ({ modify: vi.fn(async () => {}) })),
      delete: vi.fn(async () => {})
    },
    archivedPages: {
      toArray: vi.fn(async () => data.archivedPages),
      where: vi.fn(() => ({ equals: vi.fn(() => ({ delete: async () => {} })) }))
    },
    settings: {
      get: vi.fn(async () => undefined)
    },
    transaction: vi.fn(async (_mode: string, _tables: any, fn: () => Promise<any>) => fn())
  };
  return { mockData: data, dbMock: mock };
});

vi.mock('../../src/lib/db', () => ({ db: dbMock, default: dbMock }));

const storageListeners: any[] = [];
const moveCalls: { bookmarkId: string; parentId: string }[] = [];

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
    getTree: vi.fn(async () => [{ id: '0', title: 'root', children: [] }]),
    get: vi.fn(async (id: string) => [{ id, parentId: '1' }]),
    move: vi.fn(async (id: string, opts: any) => {
      moveCalls.push({ bookmarkId: id, parentId: opts.parentId });
    }),
    removeTree: vi.fn(async () => {}),
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onChanged: { addListener: vi.fn() },
    onMoved: { addListener: vi.fn() }
  },
  tabs: { query: vi.fn(async () => []) }
});

import { BookmarkManager } from '../../src/lib/bookmarks/bookmark-manager';
import { setBookmarkDragImage } from '../../src/lib/bookmarks/drag-helper';
import BookmarkCard from '../../src/components/management/bookmarks/BookmarkCard.svelte';
import BookmarkRow from '../../src/components/management/bookmarks/BookmarkRow.svelte';
import FolderTree from '../../src/components/management/FolderTree.svelte';
import BookmarkList from '../../src/components/management/bookmarks/BookmarkList.svelte';
import { toasts } from '../../src/lib/ui/toast-store';

describe('Bookmark Drag & Drop onto Folder Tree', () => {
  let target: HTMLElement;

  const testFolders = [
    { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', parentId: '0' },
    { id: '2', title: '개발', path: 'Bookmarks Bar/개발', parentId: '1' },
    { id: '3', title: '프론트엔드', path: 'Bookmarks Bar/개발/프론트엔드', parentId: '2' },
    { id: '4', title: '디자인', path: 'Bookmarks Bar/디자인', parentId: '1' },
    { id: '5', title: 'Other bookmarks', path: 'Other bookmarks', parentId: '0' }
  ];

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
    mockData.bookmarks = [];
    mockData.archivedPages = [];
    storageListeners.length = 0;
    moveCalls.length = 0;
    toasts.set([]);
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. BookmarkManager.moveBookmarksToFolder
  // =========================================================================
  describe('BookmarkManager.moveBookmarksToFolder', () => {
    it('moves single bookmark to target folder and updates browser & DB', async () => {
      mockData.bookmarks = [
        { id: 101, bookmarkId: 'bm-1', title: 'Svelte', url: 'https://svelte.dev', folderPath: 'Bookmarks Bar', syncId: 'sync-1', modifiedAt: 1000 }
      ];

      const res = await BookmarkManager.moveBookmarksToFolder([101], { id: '2', path: 'Bookmarks Bar/개발', title: '개발' });

      expect(res.movedCount).toBe(1);
      expect(moveCalls).toContainEqual({ bookmarkId: 'bm-1', parentId: '2' });
      const updated = mockData.bookmarks.find(b => b.id === 101);
      expect(updated.folderPath).toBe('Bookmarks Bar/개발');
      expect(updated.syncId).toBe('sync-1'); // syncId must be preserved
      expect(updated.modifiedAt).toBeGreaterThan(1000);
    });

    it('moves multiple bookmarks in batch to target folder', async () => {
      mockData.bookmarks = [
        { id: 101, bookmarkId: 'bm-1', title: 'Svelte', url: 'https://svelte.dev', folderPath: 'Bookmarks Bar', syncId: 'sync-1' },
        { id: 102, bookmarkId: 'bm-2', title: 'React', url: 'https://react.dev', folderPath: 'Bookmarks Bar', syncId: 'sync-2' },
        { id: 103, bookmarkId: 'bm-3', title: 'Vue', url: 'https://vuejs.org', folderPath: 'Bookmarks Bar/개발', syncId: 'sync-3' }
      ];

      // Move 101 and 102 to 'Dev' (103 is already in 'Dev' so only 2 should move)
      const res = await BookmarkManager.moveBookmarksToFolder([101, 102, 103], { id: '2', path: 'Bookmarks Bar/개발', title: '개발' });

      expect(res.movedCount).toBe(2);
      expect(moveCalls.length).toBe(2);
      expect(moveCalls).toContainEqual({ bookmarkId: 'bm-1', parentId: '2' });
      expect(moveCalls).toContainEqual({ bookmarkId: 'bm-2', parentId: '2' });
      expect(mockData.bookmarks[0].folderPath).toBe('Bookmarks Bar/개발');
      expect(mockData.bookmarks[1].folderPath).toBe('Bookmarks Bar/개발');
    });

    it('returns movedCount 0 when all bookmarks are already in target folder', async () => {
      mockData.bookmarks = [
        { id: 101, bookmarkId: 'bm-1', title: 'Svelte', url: 'https://svelte.dev', folderPath: 'Bookmarks Bar/개발', syncId: 'sync-1' }
      ];

      const res = await BookmarkManager.moveBookmarksToFolder([101], { id: '2', path: 'Bookmarks Bar/개발', title: '개발' });

      expect(res.movedCount).toBe(0);
      expect(moveCalls.length).toBe(0);
    });
  });

  // =========================================================================
  // 2. BookmarkCard & BookmarkRow Drag Events & Semi-Transparent Ghost
  // =========================================================================
  describe('BookmarkCard and BookmarkRow dragstart & ghost preview', () => {
    function createMockDataTransfer() {
      const store: Record<string, string> = {};
      return {
        setData: vi.fn((key: string, val: string) => { store[key] = val; }),
        getData: vi.fn((key: string) => store[key] || ''),
        types: [] as string[],
        effectAllowed: 'none',
        dropEffect: 'none',
        setDragImage: vi.fn()
      };
    }

    it('setBookmarkDragImage: creates a compact semi-transparent ghost preview element', () => {
      const dt = createMockDataTransfer();
      const dragEvent = { dataTransfer: dt } as unknown as DragEvent;
      setBookmarkDragImage(dragEvent, 'Very Long Bookmark Title That Should Be Truncated', 3);
      expect(dt.setDragImage).toHaveBeenCalled();
      const ghost = dt.setDragImage.mock.calls[0][0] as HTMLElement;
      expect(ghost.className).toBe('bookmark-drag-ghost');
      expect(ghost.textContent).toContain('+2');
      expect(ghost.style.background).toContain('rgba(28, 28, 34, 0.88)');
    });

    it('BookmarkCard: dragstart on single unselected card sets 1 bookmark ID payload and ghost image', async () => {
      const bookmark = { id: 101, bookmarkId: 'bm-1', title: 'Svelte', url: 'https://svelte.dev', folderPath: 'Bookmarks Bar', syncId: 'sync-1' };
      new BookmarkCard({
        target,
        props: {
          bookmark: bookmark as any,
          selected: false,
          selectedIds: new Set<number>([102, 103])
        }
      });
      await tick();

      const card = target.querySelector('.bookmark-card') as HTMLElement;
      expect(card.getAttribute('draggable')).toBe('true');

      const dt = createMockDataTransfer();
      card.dispatchEvent(Object.assign(new Event('dragstart', { bubbles: true }), { dataTransfer: dt }));

      expect(dt.setData).toHaveBeenCalledWith('application/x-powerbookmark-ids', JSON.stringify([101]));
      expect(dt.effectAllowed).toBe('move');
      expect(dt.setDragImage).toHaveBeenCalled();
    });

    it('BookmarkCard: dragstart on selected card when multiple are selected sets all selected IDs and ghost image', async () => {
      const bookmark = { id: 101, bookmarkId: 'bm-1', title: 'Svelte', url: 'https://svelte.dev', folderPath: 'Bookmarks Bar', syncId: 'sync-1' };
      new BookmarkCard({
        target,
        props: {
          bookmark: bookmark as any,
          selected: true,
          selectedIds: new Set<number>([101, 102, 103])
        }
      });
      await tick();

      const card = target.querySelector('.bookmark-card') as HTMLElement;
      const dt = createMockDataTransfer();
      card.dispatchEvent(Object.assign(new Event('dragstart', { bubbles: true }), { dataTransfer: dt }));

      expect(dt.setData).toHaveBeenCalledWith('application/x-powerbookmark-ids', JSON.stringify([101, 102, 103]));
      expect(dt.effectAllowed).toBe('move');
      expect(dt.setDragImage).toHaveBeenCalled();
    });

    it('BookmarkRow: dragstart on selected row when multiple are selected sets all selected IDs and ghost image', async () => {
      const bookmark = { id: 102, bookmarkId: 'bm-2', title: 'React', url: 'https://react.dev', folderPath: 'Bookmarks Bar', syncId: 'sync-2' };
      new BookmarkRow({
        target,
        props: {
          bookmark: bookmark as any,
          selected: true,
          selectedIds: new Set<number>([101, 102])
        }
      });
      await tick();

      const row = target.querySelector('.bookmark-row') as HTMLElement;
      expect(row.getAttribute('draggable')).toBe('true');

      const dt = createMockDataTransfer();
      row.dispatchEvent(Object.assign(new Event('dragstart', { bubbles: true }), { dataTransfer: dt }));

      expect(dt.setData).toHaveBeenCalledWith('application/x-powerbookmark-ids', JSON.stringify([101, 102]));
      expect(dt.effectAllowed).toBe('move');
      expect(dt.setDragImage).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. FolderTree Dragover, Dragleave, Drop
  // =========================================================================
  describe('FolderTree bookmark drop interaction', () => {
    function createMockDataTransfer(types = ['application/x-powerbookmark-ids'], payload = '[101, 102]') {
      return {
        types,
        getData: vi.fn((key: string) => key === 'application/x-powerbookmark-ids' ? payload : ''),
        setData: vi.fn(),
        effectAllowed: 'move',
        dropEffect: 'none'
      };
    }

    it('FolderTree: dragover on folder highlights node and drop dispatches dropBookmarks', async () => {
      const comp: any = new FolderTree({
        target,
        props: { folders: testFolders }
      });
      await tick();

      const dropHandler = vi.fn();
      comp.$on('dropBookmarks', dropHandler);

      const devFolder = Array.from(document.querySelectorAll('.tree-item')).find(
        el => el.querySelector('.tree-label')?.textContent === '개발'
      ) as HTMLElement;
      expect(devFolder).toBeTruthy();

      // 1. Dragover
      const dt = createMockDataTransfer();
      const dragoverEvent = Object.assign(new Event('dragover', { bubbles: true, cancelable: true }), { dataTransfer: dt });
      devFolder.dispatchEvent(dragoverEvent);
      await tick();

      expect(dt.dropEffect).toBe('move');
      expect(devFolder.classList.contains('bookmark-drop-target')).toBe(true);

      // 2. Drop
      const dropEvent = Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: dt });
      devFolder.dispatchEvent(dropEvent);
      await tick();

      expect(dropHandler).toHaveBeenCalledTimes(1);
      expect(dropHandler.mock.calls[0][0].detail).toEqual({
        bookmarkIds: [101, 102],
        targetFolder: {
          id: '2',
          path: 'Bookmarks Bar/개발',
          title: '개발'
        }
      });
      expect(devFolder.classList.contains('bookmark-drop-target')).toBe(false);
    });

    it('FolderTree: root-item (All Folders) does not accept bookmark dragover', async () => {
      new FolderTree({
        target,
        props: { folders: testFolders }
      });
      await tick();

      const rootItem = document.querySelector('.root-item') as HTMLElement;
      const dt = createMockDataTransfer();
      const dragoverEvent = Object.assign(new Event('dragover', { bubbles: true, cancelable: true }), { dataTransfer: dt });
      rootItem.dispatchEvent(dragoverEvent);
      await tick();

      expect(rootItem.classList.contains('bookmark-drop-target')).toBe(false);
    });
  });

  // =========================================================================
  // 4. BookmarkList End-to-End Drop Integration
  // =========================================================================
  describe('BookmarkList drag & drop integration', () => {
    it('BookmarkList: handles dropBookmarks event, moves bookmarks, refreshes list, and clears selection', async () => {
      mockData.bookmarks = [
        { id: 101, bookmarkId: 'bm-1', title: 'Svelte', url: 'https://svelte.dev', folderPath: 'Bookmarks Bar', syncId: 'sync-1' },
        { id: 102, bookmarkId: 'bm-2', title: 'React', url: 'https://react.dev', folderPath: 'Bookmarks Bar', syncId: 'sync-2' }
      ];

      vi.spyOn(BookmarkManager, 'getFolders').mockResolvedValue(testFolders as any);

      const comp: any = new BookmarkList({
        target,
        props: { folders: testFolders as any }
      });
      await comp.loadBookmarks();
      await tick();

      // Drop on 'Dev' folder
      const devFolder = Array.from(document.querySelectorAll('.folder-tree .tree-item')).find(
        el => el.querySelector('.tree-label')?.textContent === '개발'
      ) as HTMLElement;

      const dt = {
        types: ['application/x-powerbookmark-ids'],
        getData: vi.fn(() => JSON.stringify([101, 102])),
        effectAllowed: 'move',
        dropEffect: 'none'
      };

      const dropEvent = Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: dt });
      devFolder.dispatchEvent(dropEvent);
      await tick();
      await new Promise(r => setTimeout(r, 10));
      await tick();

      // Verify browser moves occurred
      expect(moveCalls.length).toBe(2);
      expect(moveCalls).toContainEqual({ bookmarkId: 'bm-1', parentId: '2' });
      expect(moveCalls).toContainEqual({ bookmarkId: 'bm-2', parentId: '2' });

      // Verify toast
      const toastList = get(toasts);
      expect(toastList.length).toBeGreaterThan(0);
      expect(toastList[0].type).toBe('success');
      expect(toastList[0].message).toContain('개발');
    });
  });
});
