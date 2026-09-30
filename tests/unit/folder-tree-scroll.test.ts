import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tick } from 'svelte';
import fs from 'fs';
import path from 'path';

const { mockData, dbMock } = vi.hoisted(() => {
  const data = {
    bookmarks: [] as any[],
    archivedPages: [] as any[],
    settings: {} as Record<string, any>
  };

  const mock = {
    bookmarks: {
      toArray: vi.fn(async () => data.bookmarks),
      get: vi.fn(async (id: number) => data.bookmarks.find((b) => b.id === id)),
      update: vi.fn(async (id: number, payload: any) => {
        const idx = data.bookmarks.findIndex((b) => b.id === id);
        if (idx !== -1) {
          data.bookmarks[idx] = { ...data.bookmarks[idx], ...payload };
        }
      }),
      where: vi.fn(() => ({ equals: vi.fn(() => ({ first: async () => undefined, delete: async () => {} })) })),
      filter: vi.fn(() => ({ modify: vi.fn(async () => {}) })),
      delete: vi.fn(async () => {})
    },
    archivedPages: {
      toArray: vi.fn(async () => data.archivedPages),
      get: vi.fn(async (id: number) => data.archivedPages.find((a) => a.id === id)),
      delete: vi.fn(async () => {}),
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          first: async () => undefined,
          delete: async () => {}
        }))
      }))
    },
    settings: {
      get: vi.fn(async (key: string) =>
        data.settings[key] !== undefined ? { key, value: data.settings[key] } : undefined
      ),
      put: vi.fn(async (item: { key: string; value: any }) => {
        data.settings[item.key] = item.value;
      })
    }
  };

  return { mockData: data, dbMock: mock };
});

vi.mock('../../src/lib/db', () => ({
  db: dbMock,
  default: dbMock
}));

vi.mock('../../src/lib/bookmarks/bookmark-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    BookmarkManager: {
      ...actual.BookmarkManager,
      getFolders: vi.fn(async () => [
        {
          id: '1',
          title: 'Bookmarks Bar',
          path: 'Bookmarks Bar'
        },
        {
          id: '2',
          title: 'Folder A',
          path: 'Bookmarks Bar/Folder A',
          parentId: '1'
        },
        {
          id: '3',
          title: 'Folder B',
          path: 'Bookmarks Bar/Folder B',
          parentId: '1'
        }
      ]),
      openBookmark: vi.fn(),
      updateBookmark: vi.fn(),
      ensureFolderPath: vi.fn()
    }
  };
});

vi.mock('../../src/lib/archive/archive-cloud', () => ({
  getCloudArchiveIndexCache: vi.fn(async () => [])
}));

vi.stubGlobal('browser', {
  i18n: {
    getMessage: vi.fn((key: string) => key)
  },
  runtime: {
    sendMessage: vi.fn(async () => ({ ok: true }))
  },
  storage: {
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {})
    }
  },
  bookmarks: {
    get: vi.fn(async () => [{ id: '1', title: 'Bookmarks Bar' }]),
    getTree: vi.fn(async () => [{ id: '0', title: 'root', children: [] }]),
    onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
    onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    onMoved: { addListener: vi.fn(), removeListener: vi.fn() }
  }
});

import FolderTree from '../../src/components/management/FolderTree.svelte';
import BookmarkList from '../../src/components/management/bookmarks/BookmarkList.svelte';

const SAMPLE_FOLDERS = [
  { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar' },
  { id: '2', title: 'Folder 1', path: 'Bookmarks Bar/Folder 1', parentId: '1' },
  { id: '3', title: 'Folder 2', path: 'Bookmarks Bar/Folder 2', parentId: '1' },
  { id: '4', title: 'Folder 3', path: 'Bookmarks Bar/Folder 3', parentId: '1' }
];

describe('FolderTree and BookmarkList scroll & drag auto-scroll', () => {
  let target: HTMLElement;
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let rafIdCounter = 0;

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
    rafCallbacks = new Map();
    rafIdCounter = 0;

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      const id = ++rafIdCounter;
      rafCallbacks.set(id, cb);
      return id;
    });

    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
      rafCallbacks.delete(id);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stepRaf() {
    const entries = Array.from(rafCallbacks.entries());
    rafCallbacks.clear();
    for (const [, cb] of entries) {
      cb(performance.now());
    }
  }

  describe('FolderTree CSS & Styles', () => {
    it('FolderTree.svelte defines overscroll-behavior: contain on .folder-tree and padding-bottom on .tree-scroll', () => {
      const svelteFile = fs.readFileSync(
        path.resolve(__dirname, '../../src/components/management/FolderTree.svelte'),
        'utf-8'
      );
      expect(svelteFile).toContain('overscroll-behavior: contain;');
      expect(svelteFile).toContain('overscroll-behavior-y: contain;');
      expect(svelteFile).toContain('padding-bottom: 0.75rem;');
    });
  });

  describe('FolderTree Drag Auto-scroll', () => {
    it('initiates upward auto-scroll when pointer is in the top scroll zone and scrollTop > 0', async () => {
      const comp = new FolderTree({
        target,
        props: { folders: SAMPLE_FOLDERS }
      });
      await tick();

      const container = target.querySelector('.folder-tree') as HTMLElement;
      expect(container).toBeTruthy();

      // Mock bounding rect: top 100, bottom 500 (height 400), left 0, right 300
      container.getBoundingClientRect = () =>
        ({ top: 100, bottom: 500, left: 0, right: 300, width: 300, height: 400, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;
      Object.defineProperty(container, 'scrollTop', { value: 100, writable: true });
      Object.defineProperty(container, 'scrollHeight', { value: 1000, writable: true });
      Object.defineProperty(container, 'clientHeight', { value: 400, writable: true });

      const moveHandle = target.querySelector('.tree-item[data-folder-id="2"] .row-move') as HTMLElement;
      expect(moveHandle).toBeTruthy();

      // Start drag at y = 200
      moveHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 150, clientY: 200 }));
      await tick();

      // Move into top zone (clientY = 110, topDist = 10 < 36px)
      moveHandle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 150, clientY: 110 }));
      await tick();

      // Auto-scroll RAF should be scheduled
      expect(rafCallbacks.size).toBeGreaterThan(0);

      // Execute RAF step and verify scrollTop decreased
      const prevScroll = container.scrollTop;
      stepRaf();
      expect(container.scrollTop).toBeLessThan(prevScroll);

      // Moving to middle (clientY = 250) stops auto-scroll
      moveHandle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 150, clientY: 250 }));
      await tick();
      expect(rafCallbacks.size).toBe(0);

      // End drag
      moveHandle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      await tick();
    });

    it('initiates downward auto-scroll when pointer is in the bottom scroll zone', async () => {
      const comp = new FolderTree({
        target,
        props: { folders: SAMPLE_FOLDERS }
      });
      await tick();

      const container = target.querySelector('.folder-tree') as HTMLElement;
      container.getBoundingClientRect = () =>
        ({ top: 100, bottom: 500, left: 0, right: 300, width: 300, height: 400, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;
      Object.defineProperty(container, 'scrollTop', { value: 100, writable: true });
      Object.defineProperty(container, 'scrollHeight', { value: 1000, writable: true });
      Object.defineProperty(container, 'clientHeight', { value: 400, writable: true });

      const moveHandle = target.querySelector('.tree-item[data-folder-id="2"] .row-move') as HTMLElement;

      // Start drag
      moveHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 150, clientY: 200 }));
      await tick();

      // Move into bottom zone (clientY = 480, bottomDist = 20 < 36px)
      moveHandle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 150, clientY: 480 }));
      await tick();

      expect(rafCallbacks.size).toBeGreaterThan(0);

      const prevScroll = container.scrollTop;
      stepRaf();
      expect(container.scrollTop).toBeGreaterThan(prevScroll);

      // pointerup stops auto-scroll
      moveHandle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      await tick();
      expect(rafCallbacks.size).toBe(0);
    });

    it('handles bookmark dragover and dragleave on container', async () => {
      const comp = new FolderTree({
        target,
        props: { folders: SAMPLE_FOLDERS }
      });
      await tick();

      const container = target.querySelector('.folder-tree') as HTMLElement;
      container.getBoundingClientRect = () =>
        ({ top: 100, bottom: 500, left: 0, right: 300, width: 300, height: 400, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;
      Object.defineProperty(container, 'scrollTop', { value: 50, writable: true });
      Object.defineProperty(container, 'scrollHeight', { value: 1000, writable: true });
      Object.defineProperty(container, 'clientHeight', { value: 400, writable: true });

      // Dragover with bookmark data in top zone
      const dragOverEvent = new Event('dragover', { bubbles: true, cancelable: true }) as any;
      dragOverEvent.clientX = 150;
      dragOverEvent.clientY = 110;
      dragOverEvent.dataTransfer = {
        types: ['application/x-powerbookmark-ids']
      };

      container.dispatchEvent(dragOverEvent);
      await tick();
      expect(rafCallbacks.size).toBeGreaterThan(0);

      // Dragleave container stops auto-scroll
      const dragLeaveEvent = new Event('dragleave', { bubbles: true, cancelable: true }) as any;
      dragLeaveEvent.relatedTarget = document.body;
      container.dispatchEvent(dragLeaveEvent);
      await tick();

      expect(rafCallbacks.size).toBe(0);
    });

    it('stops auto-scroll on window dragend or drop', async () => {
      const comp = new FolderTree({
        target,
        props: { folders: SAMPLE_FOLDERS }
      });
      await tick();

      const container = target.querySelector('.folder-tree') as HTMLElement;
      container.getBoundingClientRect = () =>
        ({ top: 100, bottom: 500, left: 0, right: 300, width: 300, height: 400, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;
      Object.defineProperty(container, 'scrollTop', { value: 50, writable: true });
      Object.defineProperty(container, 'scrollHeight', { value: 1000, writable: true });
      Object.defineProperty(container, 'clientHeight', { value: 400, writable: true });

      const moveHandle = target.querySelector('.tree-item[data-folder-id="2"] .row-move') as HTMLElement;
      moveHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 150, clientY: 200 }));
      await tick();

      moveHandle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 150, clientY: 110 }));
      await tick();
      expect(rafCallbacks.size).toBeGreaterThan(0);

      window.dispatchEvent(new Event('dragend'));
      await tick();
      expect(rafCallbacks.size).toBe(0);
    });
  });

  describe('BookmarkList Height Clamping & Mobile Responsiveness', () => {
    it('clamps treeMaxHeight to at least 160px on desktop when available height is small', async () => {
      Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true });
      Object.defineProperty(window, 'innerHeight', { value: 250, writable: true });

      mockData.bookmarks = [{ id: 1, title: 'Test 1', url: 'https://example.com' }];

      const comp = new BookmarkList({ target });
      await tick();
      await (comp as any).loadBookmarks();
      await tick();

      const panel = target.querySelector('.folder-tree-panel') as HTMLElement;
      expect(panel).toBeTruthy();

      // Mock bounding rect: top 150px -> available = 250 - 150 - 24 = 76px (< 160px)
      panel.getBoundingClientRect = () =>
        ({ top: 150, bottom: 400, left: 0, right: 250, width: 250, height: 250, x: 0, y: 150, toJSON: () => ({}) }) as DOMRect;

      window.dispatchEvent(new Event('resize'));
      await tick();
      stepRaf();
      await tick();

      // Clamped to 160px
      expect(panel.style.maxHeight).toBe('160px');
    });

    it('sets treeMaxHeight according to available height on desktop when available > 160px', async () => {
      Object.defineProperty(window, 'innerWidth', { value: 1200, writable: true });
      Object.defineProperty(window, 'innerHeight', { value: 900, writable: true });

      mockData.bookmarks = [{ id: 1, title: 'Test 1', url: 'https://example.com' }];

      const comp = new BookmarkList({ target });
      await tick();
      await (comp as any).loadBookmarks();
      await tick();

      const panel = target.querySelector('.folder-tree-panel') as HTMLElement;
      expect(panel).toBeTruthy();

      // Top 200px -> available = 900 - 200 - 24 = 676px
      panel.getBoundingClientRect = () =>
        ({ top: 200, bottom: 876, left: 0, right: 250, width: 250, height: 676, x: 0, y: 200, toJSON: () => ({}) }) as DOMRect;

      window.dispatchEvent(new Event('resize'));
      await tick();
      stepRaf();
      await tick();

      expect(panel.style.maxHeight).toBe('676px');
    });

    it('clears inline max-height on mobile (<= 768px)', async () => {
      Object.defineProperty(window, 'innerWidth', { value: 600, writable: true });
      Object.defineProperty(window, 'innerHeight', { value: 800, writable: true });

      mockData.bookmarks = [{ id: 1, title: 'Test 1', url: 'https://example.com' }];

      const comp = new BookmarkList({ target });
      await tick();
      await (comp as any).loadBookmarks();
      await tick();

      const panel = target.querySelector('.folder-tree-panel') as HTMLElement;
      expect(panel).toBeTruthy();

      window.dispatchEvent(new Event('resize'));
      await tick();
      stepRaf();
      await tick();

      // On mobile (<= 768px), treeMaxHeight is empty string -> inline style max-height is cleared
      expect(panel.style.maxHeight).toBe('');
    });
  });
});
