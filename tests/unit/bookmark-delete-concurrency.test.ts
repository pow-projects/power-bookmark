import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';

const { mockData, dbMock } = vi.hoisted(() => {
  const data = {
    bookmarks: [] as any[],
    archivedPages: [] as any[],
    settings: {} as Record<string, any>
  };
  const mock = {
    bookmarks: {
      toArray: vi.fn(async () => data.bookmarks),
      get: vi.fn(async (id: number) => data.bookmarks.find(b => b.id === id)),
      update: vi.fn(async (id: number, payload: any) => {
        const idx = data.bookmarks.findIndex(b => b.id === id);
        if (idx !== -1) {
          data.bookmarks[idx] = { ...data.bookmarks[idx], ...payload };
        }
      }),
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          first: async () => undefined,
          delete: async () => {}
        }))
      })),
      filter: vi.fn(() => ({ modify: vi.fn(async () => {}) })),
      delete: vi.fn(async () => {})
    },
    archivedPages: {
      toArray: vi.fn(async () => data.archivedPages),
      get: vi.fn(async (id: number) => data.archivedPages.find(a => a.id === id)),
      delete: vi.fn(async (id: number) => {
        const idx = data.archivedPages.findIndex(a => a.id === id);
        if (idx !== -1) data.archivedPages.splice(idx, 1);
      }),
      where: vi.fn(() => ({
        equals: vi.fn((val: any) => ({
          first: async () => data.archivedPages.find(a => a.bookmarkId === val),
          delete: async () => {
            const idx = data.archivedPages.findIndex(a => a.bookmarkId === val);
            if (idx !== -1) data.archivedPages.splice(idx, 1);
          }
        }))
      }))
    },
    settings: {
      get: vi.fn(async (key: string) => (data.settings[key] !== undefined ? { key, value: data.settings[key] } : undefined)),
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

vi.mock('../../src/lib/sync/sync-engine', () => ({
  SyncEngine: {
    triggerDebouncedSync: vi.fn(),
    sync: vi.fn(async () => {}),
    getAdapter: vi.fn(async () => null)
  }
}));

describe('Bookmark Deletion - Concurrency & Loading Feedback', () => {
  let target: HTMLElement;

  beforeEach(() => {
    target = document.createElement('div');
    document.body.replaceChildren(target);
    mockData.bookmarks = [];
    mockData.archivedPages = [];
    mockData.settings = {};
    vi.clearAllMocks();

    vi.stubGlobal('browser', {
      runtime: {
        sendMessage: vi.fn(async () => ({ ok: true })),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() }
      },
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {}),
          remove: vi.fn(async () => {})
        },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
      },
      bookmarks: {
        getTree: vi.fn(async () => []),
        remove: vi.fn(async () => {}),
        onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
        onMoved: { addListener: vi.fn(), removeListener: vi.fn() }
      }
    });
  });

  it('BookmarkModals: single delete shows loading spinner and disables confirm button while deletion is pending', async () => {
    const { default: BookmarkModals } = await import('../../src/components/management/bookmarks/BookmarkModals.svelte');
    const { BookmarkManager } = await import('../../src/lib/bookmarks/bookmark-manager');

    // Make removeBookmark take time
    let resolveDelete: () => void;
    const deletePromise = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    const removeBookmarkSpy = vi.spyOn(BookmarkManager, 'removeBookmark').mockImplementation(async () => {
      await deletePromise;
    });

    const comp = new BookmarkModals({
      target,
      props: {
        bookmarks: [{ id: 101, title: 'Test Bookmark', url: 'https://test.com', folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b101' }],
        folders: [],
        selectedIds: new Set(),
        archiveMap: new Map(),
        healthResults: new Map()
      }
    });

    comp.openDeleteSingle(101);
    await tick();

    // Verify modal is open
    const confirmBtn = document.querySelector('.modal-actions .btn-danger') as HTMLButtonElement;
    expect(confirmBtn).toBeTruthy();
    expect(confirmBtn.disabled).toBe(false);

    // Click confirm to start delete
    confirmBtn.click();
    await tick();

    // While deletion is running, confirm button must be disabled and contain a spinner
    expect(confirmBtn.disabled).toBe(true);
    expect(confirmBtn.querySelector('.spinner-inline')).toBeTruthy();

    // Second click must not trigger another removeBookmark (idempotent / concurrency guard)
    confirmBtn.click();
    await tick();
    expect(removeBookmarkSpy).toHaveBeenCalledTimes(1);

    // Cancel button must also be disabled during loading
    const cancelBtn = document.querySelector('.modal-actions .btn-secondary') as HTMLButtonElement;
    expect(cancelBtn.disabled).toBe(true);

    // Resolve deletion
    resolveDelete!();
    await deletePromise;
    await tick();

    // Modal should close and removeBookmark was called once
    expect(removeBookmarkSpy).toHaveBeenCalledTimes(1);
    expect(removeBookmarkSpy).toHaveBeenCalledWith(101);

    removeBookmarkSpy.mockRestore();
  });

  it('BookmarkModals: bulk delete disables buttons and shows spinner during execution', async () => {
    const { default: BookmarkModals } = await import('../../src/components/management/bookmarks/BookmarkModals.svelte');
    const { BookmarkManager } = await import('../../src/lib/bookmarks/bookmark-manager');

    let resolveDelete: () => void;
    const deletePromise = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    const removeBookmarkSpy = vi.spyOn(BookmarkManager, 'removeBookmark').mockImplementation(async () => {
      await deletePromise;
    });

    const comp = new BookmarkModals({
      target,
      props: {
        bookmarks: [
          { id: 201, title: 'Item 1', url: 'https://test1.com', folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b201' },
          { id: 202, title: 'Item 2', url: 'https://test2.com', folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b202' }
        ],
        folders: [],
        selectedIds: new Set([201, 202]),
        archiveMap: new Map(),
        healthResults: new Map()
      }
    });

    comp.openDeleteSelected();
    await tick();

    const deleteAllBtn = document.querySelector('.modal-actions .btn-danger') as HTMLButtonElement;
    expect(deleteAllBtn).toBeTruthy();
    expect(deleteAllBtn.disabled).toBe(false);

    // Click deleteAll
    deleteAllBtn.click();
    await tick();

    // Button should show spinner and be disabled
    expect(deleteAllBtn.disabled).toBe(true);
    expect(deleteAllBtn.querySelector('.spinner-inline')).toBeTruthy();

    // Concurrent click should be blocked
    deleteAllBtn.click();
    await tick();
    expect(removeBookmarkSpy).toHaveBeenCalledTimes(1); // Only the first bookmark in progress

    // Resolve
    resolveDelete!();
    await deletePromise;
    await tick();

    removeBookmarkSpy.mockRestore();
  });

  it('BookmarkList: reflects deleting status on BookmarkRow, BookmarkCard, and BulkActionBar', async () => {
    const { default: BookmarkList } = await import('../../src/components/management/bookmarks/BookmarkList.svelte');
    const { BookmarkManager } = await import('../../src/lib/bookmarks/bookmark-manager');

    let resolveDelete: () => void;
    const deletePromise = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    const removeBookmarkSpy = vi.spyOn(BookmarkManager, 'removeBookmark').mockImplementation(async () => {
      await deletePromise;
    });

    mockData.bookmarks = [
      { id: 301, title: 'Row Item', url: 'https://test.com', folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b301' }
    ];

    const comp = new BookmarkList({
      target,
      props: { folders: [] }
    });
    await comp.loadBookmarks();
    await tick();

    // Find the row's delete button and click it to open single delete modal
    const cardDeleteBtn = document.querySelector('.bookmark-card .btn-icon-danger') as HTMLButtonElement;
    expect(cardDeleteBtn).toBeTruthy();
    cardDeleteBtn.click();
    await tick();

    // Confirm button in modal
    const confirmBtn = document.querySelector('.modal-actions .btn-danger') as HTMLButtonElement;
    expect(confirmBtn).toBeTruthy();
    confirmBtn.click();
    await tick();

    // During deletion, the bookmark card must have .deleting class and disabled delete button with spinner
    const deletingCard = document.querySelector('.bookmark-card.deleting');
    expect(deletingCard).toBeTruthy();
    const activeDeleteBtn = deletingCard?.querySelector('.btn-icon-danger') as HTMLButtonElement;
    expect(activeDeleteBtn?.disabled).toBe(true);
    expect(activeDeleteBtn?.querySelector('.spinner-inline')).toBeTruthy();

    // Finish delete
    resolveDelete!();
    await deletePromise;
    await tick();

    removeBookmarkSpy.mockRestore();
  });
});
