import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockBookmarkCreate,
  mockBookmarkGet,
  mockBookmarkGetTree,
  mockOnCreatedAddListener,
  mockOnRemovedAddListener,
  mockOnChangedAddListener,
  mockOnMovedAddListener,
  mockOnImportBeganAddListener,
  mockOnImportEndedAddListener,
  mockTabsQuery,
  mockEnqueueAiJob,
  mockIsAiConfigured,
  mockGetAiSettings,
  stores,
  txState
} = vi.hoisted(() => {
  const stores = {
    bookmarks: [] as any[],
    archivedPages: [] as any[],
    settings: new Map<string, any>(),
    nextBookmarkId: 1
  };
  const txState = {
    inTransaction: false
  };
  return {
    mockBookmarkCreate: vi.fn(),
    mockBookmarkGet: vi.fn(),
    mockBookmarkGetTree: vi.fn(),
    mockOnCreatedAddListener: vi.fn(),
    mockOnRemovedAddListener: vi.fn(),
    mockOnChangedAddListener: vi.fn(),
    mockOnMovedAddListener: vi.fn(),
    mockOnImportBeganAddListener: vi.fn(),
    mockOnImportEndedAddListener: vi.fn(),
    mockTabsQuery: vi.fn(),
    mockEnqueueAiJob: vi.fn(),
    mockIsAiConfigured: vi.fn(),
    mockGetAiSettings: vi.fn(),
    stores,
    txState
  };
});

let browserMock: any;

function setupBrowserGlobal(includeImportEvents = true) {
  browserMock = {
    bookmarks: {
      create: mockBookmarkCreate,
      get: mockBookmarkGet,
      getTree: mockBookmarkGetTree,
      onCreated: { addListener: mockOnCreatedAddListener },
      onRemoved: { addListener: mockOnRemovedAddListener },
      onChanged: { addListener: mockOnChangedAddListener },
      onMoved: { addListener: mockOnMovedAddListener },
      ...(includeImportEvents
        ? {
            onImportBegan: { addListener: mockOnImportBeganAddListener },
            onImportEnded: { addListener: mockOnImportEndedAddListener }
          }
        : {})
    },
    tabs: {
      query: mockTabsQuery
    },
    runtime: {
      sendMessage: vi.fn().mockResolvedValue({ ok: true })
    }
  };
  vi.stubGlobal('browser', browserMock);
}

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
      put: async (item: { key: string; value: any }) => {
        stores.settings.set(item.key, item.value);
      },
      clear: async () => stores.settings.clear()
    },
    transaction: async (_mode: string, _tables: any, fn: () => Promise<any>) => {
      txState.inTransaction = true;
      try {
        return await fn();
      } finally {
        txState.inTransaction = false;
      }
    }
  };

  return { db: mockDb, default: mockDb };
});

vi.mock('../../src/lib/ai/ai-queue', () => ({
  enqueueAiJob: (...args: any[]) => {
    // Assert Split Transaction Boundary Rule
    if (txState.inTransaction) {
      throw new Error('VIOLATION: enqueueAiJob called inside db.transaction!');
    }
    return mockEnqueueAiJob(...args);
  },
  cancelBookmarkAi: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../../src/lib/ai/ai-summarizer', () => ({
  isAiConfigured: (...args: any[]) => mockIsAiConfigured(...args),
  getAiSettings: (...args: any[]) => mockGetAiSettings(...args)
}));

vi.mock('../../src/lib/sync/tombstones', () => ({
  recordTombstone: vi.fn().mockResolvedValue(undefined),
  removeTombstone: vi.fn().mockResolvedValue(undefined)
}));

import { BookmarkManager } from '../../src/lib/bookmarks/bookmark-manager';

describe('Browser Native Bookmark AI Integration', () => {
  let onCreatedCallback: (id: string, node: any) => Promise<void>;
  let onImportBeganCallback: () => void;
  let onImportEndedCallback: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    setupBrowserGlobal(true);
    BookmarkManager._resetForTest();

    stores.bookmarks = [];
    stores.archivedPages = [];
    stores.settings.clear();
    stores.nextBookmarkId = 1;

    mockBookmarkGetTree.mockResolvedValue([
      {
        id: '0',
        title: 'root',
        children: [{ id: '1', title: 'Bookmarks Bar', children: [] }]
      }
    ]);

    mockBookmarkGet.mockImplementation(async (id: string) => [{ id, title: 'Bookmark', url: 'https://example.com' }]);

    mockIsAiConfigured.mockResolvedValue(true);
    mockGetAiSettings.mockResolvedValue({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'test-key',
      autoSummarize: true,
      autoTags: true,
      autoFolder: true,
      autoOnBrowserBookmark: true
    });

    mockEnqueueAiJob.mockResolvedValue({ ok: true, jobId: 'job-1' });

    BookmarkManager.listen();

    onCreatedCallback = mockOnCreatedAddListener.mock.calls[0]?.[0];
    onImportBeganCallback = mockOnImportBeganAddListener.mock.calls[0]?.[0];
    onImportEndedCallback = mockOnImportEndedAddListener.mock.calls[0]?.[0];
  });

  it('passes Dexie primary key (number, NOT browser string id) to enqueueAiJob', async () => {
    mockTabsQuery.mockResolvedValue([
      {
        id: 101,
        url: 'https://example.com/article',
        title: 'Example Article'
      }
    ]);

    await onCreatedCallback('browser-node-999', {
      id: 'browser-node-999',
      title: 'Example Article',
      url: 'https://example.com/article',
      parentId: '1',
      dateAdded: Date.now()
    });

    expect(mockEnqueueAiJob).toHaveBeenCalledTimes(1);
    const callArg = mockEnqueueAiJob.mock.calls[0][0];
    expect(callArg.bookmarkId).toBe(1); // First record ID is number 1
    expect(typeof callArg.bookmarkId).toBe('number');
    expect(callArg.bookmarkId).not.toBe('browser-node-999');
    expect(callArg.kind).toBe('auto');
    expect(callArg.options).toEqual({
      autoSummarize: true,
      autoTags: true,
      autoFolder: true
    });
  });

  it('safely handles environments where onImportBegan / onImportEnded are undefined (Firefox safety)', async () => {
    BookmarkManager._resetForTest();
    setupBrowserGlobal(false); // No onImportBegan or onImportEnded

    expect(() => BookmarkManager.listen()).not.toThrow();

    const firefoxCreatedCallback = mockOnCreatedAddListener.mock.calls[mockOnCreatedAddListener.mock.calls.length - 1][0];
    mockTabsQuery.mockResolvedValue([{ id: 10, url: 'https://firefox-test.org' }]);

    await firefoxCreatedCallback('ff-1', {
      id: 'ff-1',
      title: 'FF Test',
      url: 'https://firefox-test.org',
      parentId: '1'
    });

    expect(mockEnqueueAiJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueAiJob.mock.calls[0][0].bookmarkId).toBe(1);
  });

  it('skips AI when isImporting is true (onImportBegan fired)', async () => {
    onImportBeganCallback();
    expect(BookmarkManager.isImporting).toBe(true);

    mockTabsQuery.mockResolvedValue([{ id: 1, url: 'https://imported.com' }]);

    await onCreatedCallback('node-import-1', {
      id: 'node-import-1',
      title: 'Imported',
      url: 'https://imported.com',
      parentId: '1'
    });

    expect(stores.bookmarks).toHaveLength(1);
    expect(mockEnqueueAiJob).not.toHaveBeenCalled();
  });

  it('resumes AI processing after onImportEnded fires', async () => {
    onImportBeganCallback();
    expect(BookmarkManager.isImporting).toBe(true);

    await onCreatedCallback('node-import-1', {
      id: 'node-import-1',
      title: 'Imported',
      url: 'https://imported.com',
      parentId: '1'
    });
    expect(mockEnqueueAiJob).not.toHaveBeenCalled();

    onImportEndedCallback();
    expect(BookmarkManager.isImporting).toBe(false);

    mockTabsQuery.mockResolvedValue([{ id: 2, url: 'https://normal.com' }]);

    await onCreatedCallback('node-normal-2', {
      id: 'node-normal-2',
      title: 'Normal',
      url: 'https://normal.com',
      parentId: '1'
    });

    expect(mockEnqueueAiJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueAiJob.mock.calls[0][0].bookmarkId).toBe(2);
  });

  it('tracks extensionCreatedBookmarkIds and skips AI on listener to avoid duplicate/payload-drop with popup creation', async () => {
    mockBookmarkCreate.mockResolvedValue({
      id: 'popup-created-10',
      url: 'https://popup.com',
      title: 'Popup Bookmark',
      parentId: '1'
    });

    mockTabsQuery.mockResolvedValue([{ id: 5, url: 'https://popup.com' }]);

    const created = await BookmarkManager.createBookmark('https://popup.com', 'Popup Bookmark');
    expect(created.bookmarkId).toBe('popup-created-10');
    expect(BookmarkManager.extensionCreatedBookmarkIds.has('popup-created-10')).toBe(true);

    // Simulate browser dispatching onCreated for the node created by the extension
    await onCreatedCallback('popup-created-10', {
      id: 'popup-created-10',
      title: 'Popup Bookmark',
      url: 'https://popup.com',
      parentId: '1'
    });

    // Native listener MUST NOT have triggered AI because extension handles its own AI dispatch
    expect(mockEnqueueAiJob).not.toHaveBeenCalled();
    // And ID was pruned from set
    expect(BookmarkManager.extensionCreatedBookmarkIds.has('popup-created-10')).toBe(false);
  });

  it('skips AI when sliding-window burst rate limiter detects > 2 creations within 2000ms', async () => {
    const baseTime = 10000;
    mockTabsQuery.mockImplementation(async () => [
      { id: 1, url: 'https://burst.com' }
    ]);

    // Creation 1 (t = 10000): Allowed
    vi.spyOn(Date, 'now').mockReturnValue(baseTime);
    await onCreatedCallback('burst-1', {
      id: 'burst-1',
      title: 'Burst 1',
      url: 'https://burst.com',
      parentId: '1'
    });
    expect(mockEnqueueAiJob).toHaveBeenCalledTimes(1);

    // Creation 2 (t = 10500): Allowed (count = 2 <= 2)
    vi.spyOn(Date, 'now').mockReturnValue(baseTime + 500);
    await onCreatedCallback('burst-2', {
      id: 'burst-2',
      title: 'Burst 2',
      url: 'https://burst.com',
      parentId: '1'
    });
    expect(mockEnqueueAiJob).toHaveBeenCalledTimes(2);

    // Creation 3 (t = 1200): Skips AI (> 2 within 2000ms)
    vi.spyOn(Date, 'now').mockReturnValue(baseTime + 1200);
    await onCreatedCallback('burst-3', {
      id: 'burst-3',
      title: 'Burst 3',
      url: 'https://burst.com',
      parentId: '1'
    });
    expect(mockEnqueueAiJob).toHaveBeenCalledTimes(2); // Still 2

    // Creation 4 (t = 1500): Skips AI
    vi.spyOn(Date, 'now').mockReturnValue(baseTime + 1500);
    await onCreatedCallback('burst-4', {
      id: 'burst-4',
      title: 'Burst 4',
      url: 'https://burst.com',
      parentId: '1'
    });
    expect(mockEnqueueAiJob).toHaveBeenCalledTimes(2); // Still 2

    // Creation 5 (t = 14000, 2500ms after t=11500): Window expired, Allowed
    vi.spyOn(Date, 'now').mockReturnValue(baseTime + 4000);
    await onCreatedCallback('burst-5', {
      id: 'burst-5',
      title: 'Burst 5',
      url: 'https://burst.com',
      parentId: '1'
    });
    expect(mockEnqueueAiJob).toHaveBeenCalledTimes(3);
  });

  it('skips AI when bookmark URL does not have http/https protocol', async () => {
    mockTabsQuery.mockResolvedValue([{ id: 1, url: 'javascript:alert(1)' }]);

    await onCreatedCallback('js-url-1', {
      id: 'js-url-1',
      title: 'Bookmarklet',
      url: 'javascript:alert(1)',
      parentId: '1'
    });

    expect(stores.bookmarks).toHaveLength(1);
    expect(mockEnqueueAiJob).not.toHaveBeenCalled();

    await onCreatedCallback('chrome-url-1', {
      id: 'chrome-url-1',
      title: 'Settings',
      url: 'chrome://settings',
      parentId: '1'
    });
    expect(mockEnqueueAiJob).not.toHaveBeenCalled();
  });

  it('skips AI when active tab URL does not have http/https protocol', async () => {
    mockTabsQuery.mockResolvedValue([{ id: 1, url: 'chrome://newtab' }]);

    await onCreatedCallback('tab-proto-1', {
      id: 'tab-proto-1',
      title: 'Some Page',
      url: 'https://example.com/page',
      parentId: '1'
    });

    expect(mockEnqueueAiJob).not.toHaveBeenCalled();
  });

  it('skips AI when active tab URL does not match bookmark URL', async () => {
    mockTabsQuery.mockResolvedValue([{ id: 1, url: 'https://active-tab.com' }]);

    await onCreatedCallback('diff-url-1', {
      id: 'diff-url-1',
      title: 'Different',
      url: 'https://other-tab.com',
      parentId: '1'
    });

    expect(mockEnqueueAiJob).not.toHaveBeenCalled();
  });

  it('matches URLs correctly via normalizeUrl (e.g. trailing slash variations)', async () => {
    // Active tab has trailing slash, bookmark does not
    mockTabsQuery.mockResolvedValue([{ id: 1, url: 'https://example.com/test/' }]);

    await onCreatedCallback('norm-url-1', {
      id: 'norm-url-1',
      title: 'Normalize Match',
      url: 'https://example.com/test',
      parentId: '1'
    });

    expect(mockEnqueueAiJob).toHaveBeenCalledTimes(1);
  });

  it('skips AI when autoOnBrowserBookmark setting is false', async () => {
    mockGetAiSettings.mockResolvedValue({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'test-key',
      autoSummarize: true,
      autoTags: true,
      autoFolder: true,
      autoOnBrowserBookmark: false
    });

    mockTabsQuery.mockResolvedValue([{ id: 1, url: 'https://disabled-setting.com' }]);

    await onCreatedCallback('disabled-1', {
      id: 'disabled-1',
      title: 'Disabled',
      url: 'https://disabled-setting.com',
      parentId: '1'
    });

    expect(mockEnqueueAiJob).not.toHaveBeenCalled();
  });

  it('skips AI when isAiConfigured returns false', async () => {
    mockIsAiConfigured.mockResolvedValue(false);

    mockTabsQuery.mockResolvedValue([{ id: 1, url: 'https://not-configured.com' }]);

    await onCreatedCallback('no-cfg-1', {
      id: 'no-cfg-1',
      title: 'Not Configured',
      url: 'https://not-configured.com',
      parentId: '1'
    });

    expect(mockEnqueueAiJob).not.toHaveBeenCalled();
  });

  it('skips AI when all auto options are disabled', async () => {
    mockGetAiSettings.mockResolvedValue({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'test-key',
      autoSummarize: false,
      autoTags: false,
      autoFolder: false,
      autoOnBrowserBookmark: true
    });

    mockTabsQuery.mockResolvedValue([{ id: 1, url: 'https://no-actions.com' }]);

    await onCreatedCallback('no-actions-1', {
      id: 'no-actions-1',
      title: 'No Actions',
      url: 'https://no-actions.com',
      parentId: '1'
    });

    expect(mockEnqueueAiJob).not.toHaveBeenCalled();
  });

  it('strictly obeys Split Transaction Boundary Rule (no async tab queries or enqueue inside db.transaction)', async () => {
    mockTabsQuery.mockResolvedValue([{ id: 1, url: 'https://tx-test.com' }]);

    await onCreatedCallback('tx-1', {
      id: 'tx-1',
      title: 'Tx Test',
      url: 'https://tx-test.com',
      parentId: '1'
    });

    expect(mockEnqueueAiJob).toHaveBeenCalledTimes(1);
    // If enqueueAiJob was called inside db.transaction, the mock would have thrown an error.
    expect(txState.inTransaction).toBe(false);
  });
});
