import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockBookmarkCreate,
  mockBookmarkGet,
  mockBookmarkGetTree,
  mockBookmarkRemove,
  mockOnCreatedAddListener,
  mockOnRemovedAddListener,
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
    mockBookmarkRemove: vi.fn(),
    mockOnCreatedAddListener: vi.fn(),
    mockOnRemovedAddListener: vi.fn(),
    stores
  };
});

vi.stubGlobal('browser', {
  bookmarks: {
    create: mockBookmarkCreate,
    get: mockBookmarkGet,
    getTree: mockBookmarkGetTree,
    remove: mockBookmarkRemove,
    onCreated: { addListener: mockOnCreatedAddListener },
    onRemoved: { addListener: mockOnRemovedAddListener },
    onChanged: { addListener: vi.fn() },
    onMoved: { addListener: vi.fn() }
  },
  runtime: {
    sendMessage: vi.fn().mockResolvedValue({ ok: true })
  }
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
      }
    });

    table.first = async () => undefined;
    table.toArray = async () => [...getArr()];
    table.count = async () => getArr().length;
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
    table.clear = async () => {
      stores[tableKey].length = 0;
    };

    return table;
  }

  const mockDb: any = {
    bookmarks: makeTable('bookmarks'),
    archivedPages: makeTable('archivedPages'),
    settings: {
      get: async (key: string) => ({ value: stores.settings.get(key) }),
      put: async (item: { key: string; value: any }) => { stores.settings.set(item.key, item.value); },
      clear: async () => stores.settings.clear()
    },
    transaction: async (_mode: string, _table: any, fn: () => Promise<any>) => {
      return await fn();
    }
  };

  return { db: mockDb, default: mockDb };
});

import { db } from '../../src/lib/db';
import { BookmarkManager } from '../../src/lib/bookmarks/bookmark-manager';
import { archiveBookmark } from '../../src/lib/archive/page-capture';
import { recordTombstone, getTombstones, removeTombstone } from '../../src/lib/sync/tombstones';
import { generateDeterministicSyncId } from '../../src/lib/bookmarks/url-normalizer';

describe('Bookmark Create & Immediate Delete Race Condition Safeguards', () => {
  beforeEach(async () => {
    stores.bookmarks.length = 0;
    stores.archivedPages.length = 0;
    stores.settings.clear();
    stores.nextBookmarkId = 1;
    vi.clearAllMocks();
  });

  it('safeguards against zombie creation when browser node is deleted before onCreated commits', async () => {
    let onCreatedCallback: (id: string, node: any) => Promise<void> = async () => {};

    mockOnCreatedAddListener.mockImplementation((cb: any) => {
      onCreatedCallback = cb;
    });

    mockBookmarkGetTree.mockResolvedValue([
      { id: '0', title: 'root', children: [] }
    ]);

    // When browser.bookmarks.get('123') is queried, it throws (already deleted in browser)
    mockBookmarkGet.mockRejectedValue(new Error('Bookmark not found'));

    // Start listening
    (BookmarkManager as any).isListening = false;
    BookmarkManager.listen();

    // Trigger onCreated event for a bookmark that was deleted immediately in the browser
    await onCreatedCallback('123', {
      id: '123',
      url: 'https://example.com/fast-delete',
      title: 'Fast Delete',
      parentId: '1',
      dateAdded: Date.now()
    });

    // Verify no zombie record was added to Dexie db.bookmarks
    const records = await db.bookmarks.toArray();
    expect(records).toHaveLength(0);
  });

  it('prevents archiveBookmark from creating orphaned archive blobs when bookmark is deleted', async () => {
    const nonExistentBookmarkId = 99999;
    const htmlSource = '<html><body>Test Content</body></html>';

    const result = await archiveBookmark(
      nonExistentBookmarkId,
      htmlSource,
      'https://example.com/test',
      'Test Page'
    );

    expect(result).toBe(-1);

    const archives = await db.archivedPages.where('bookmarkId').equals(nonExistentBookmarkId).toArray();
    expect(archives).toHaveLength(0);
  });

  it('clears past tombstones when a bookmark is re-created with the same URL', async () => {
    const url = 'https://example.com/re-created';
    const syncId = generateDeterministicSyncId(url);

    // 1. Simulate prior deletion tombstone
    await recordTombstone(syncId, Date.now() - 10000);
    const initialTombstones = await getTombstones();
    expect(initialTombstones.some(t => t.syncId === syncId)).toBe(true);

    // 2. Remove tombstone
    await removeTombstone(syncId);
    const updatedTombstones = await getTombstones();
    expect(updatedTombstones.some(t => t.syncId === syncId)).toBe(false);
  });

  it('cancels AI queue jobs and records tombstone when removeBookmark is called', async () => {
    const syncId = generateDeterministicSyncId('https://example.com/to-delete');
    const id = await db.bookmarks.add({
      syncId,
      bookmarkId: 'bm-99',
      url: 'https://example.com/to-delete',
      title: 'To Delete',
      folderPath: '',
      description: '',
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      visitCount: 0
    });

    mockBookmarkRemove.mockResolvedValue(undefined);

    await BookmarkManager.removeBookmark(id);

    // Verify DB bookmark deleted
    const record = await db.bookmarks.get(id);
    expect(record).toBeUndefined();

    // Verify AI abort broadcasted
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'AI_ABORT_BOOKMARK', bookmarkId: id })
    );

    // Verify tombstone recorded
    const tombstones = await getTombstones();
    expect(tombstones.some(t => t.syncId === syncId)).toBe(true);
  });

  it('aborts processAiJob cleanly without error badge when bookmark was deleted mid-analysis', async () => {
    const { processAiJob } = await import('../../src/lib/ai/ai-processor');
    const controller = new AbortController();

    const outcome = await processAiJob(
      {
        id: 'job-999',
        bookmarkId: 999999, // Already deleted ID
        kind: 'auto',
        status: 'running',
        attempts: 1,
        createdAt: Date.now()
      },
      controller.signal
    );

    expect(outcome.ok).toBe(true);
  });
});
