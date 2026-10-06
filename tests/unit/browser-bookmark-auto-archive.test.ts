import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  mockTabsSendMessage,
  mockEnqueueArchiveJob,
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
    mockTabsSendMessage: vi.fn(),
    mockEnqueueArchiveJob: vi.fn(),
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
      query: mockTabsQuery,
      sendMessage: mockTabsSendMessage
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

vi.mock('../../src/lib/archive/archive-queue', () => ({
  enqueueArchiveJob: (...args: any[]) => {
    // Assert Split Transaction Boundary Rule
    if (txState.inTransaction) {
      throw new Error('VIOLATION: enqueueArchiveJob called inside db.transaction!');
    }
    return mockEnqueueArchiveJob(...args);
  }
}));

vi.mock('../../src/lib/ai/ai-queue', () => ({
  enqueueAiJob: (...args: any[]) => mockEnqueueAiJob(...args),
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

describe('Browser Native Bookmark Auto-Archive Integration', () => {
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

    mockIsAiConfigured.mockResolvedValue(false);
    mockEnqueueArchiveJob.mockResolvedValue({ ok: true });
    mockTabsSendMessage.mockResolvedValue(null);

    BookmarkManager.listen();

    onCreatedCallback = mockOnCreatedAddListener.mock.calls[0]?.[0];
    onImportBeganCallback = mockOnImportBeganAddListener.mock.calls[0]?.[0];
    onImportEndedCallback = mockOnImportEndedAddListener.mock.calls[0]?.[0];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('triggers auto-archive when auto_archive is boolean true', async () => {
    stores.settings.set('auto_archive', true);
    mockTabsQuery.mockResolvedValue([{ id: 10, url: 'https://example.com/page' }]);
    mockTabsSendMessage.mockResolvedValue({
      html: '<html><body>Hello World</body></html>',
      iframeSources: { 'https://sub.frame': '<html>Frame</html>' }
    });

    await onCreatedCallback('node-1', {
      id: 'node-1',
      title: 'Page Title',
      url: 'https://example.com/page',
      parentId: '1',
      dateAdded: Date.now()
    });

    expect(mockEnqueueArchiveJob).toHaveBeenCalledTimes(1);
    const callArg = mockEnqueueArchiveJob.mock.calls[0][0];
    expect(callArg.bookmarkId).toBe(1);
    expect(callArg.pageUrl).toBe('https://example.com/page');
    expect(callArg.pageTitle).toBe('Page Title');
    expect(callArg.htmlSource).toBe('<html><body>Hello World</body></html>');
    expect(callArg.iframeSources).toEqual({ 'https://sub.frame': '<html>Frame</html>' });
    expect(callArg.compress).toBe(true);
  });

  it('triggers auto-archive when auto_archive is string "true"', async () => {
    stores.settings.set('auto_archive', 'true');
    mockTabsQuery.mockResolvedValue([{ id: 10, url: 'https://example.com/string-true' }]);
    mockTabsSendMessage.mockResolvedValue({ html: '<div>Content</div>' });

    await onCreatedCallback('node-str-true', {
      id: 'node-str-true',
      title: 'String True Title',
      url: 'https://example.com/string-true',
      parentId: '1',
      dateAdded: Date.now()
    });

    expect(mockEnqueueArchiveJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueArchiveJob.mock.calls[0][0].bookmarkId).toBe(1);
    expect(mockEnqueueArchiveJob.mock.calls[0][0].htmlSource).toBe('<div>Content</div>');
  });

  it('does NOT trigger auto-archive when auto_archive is boolean false', async () => {
    stores.settings.set('auto_archive', false);
    mockTabsQuery.mockResolvedValue([{ id: 10, url: 'https://example.com/false' }]);

    await onCreatedCallback('node-false', {
      id: 'node-false',
      title: 'False Title',
      url: 'https://example.com/false',
      parentId: '1',
      dateAdded: Date.now()
    });

    expect(mockEnqueueArchiveJob).not.toHaveBeenCalled();
    expect(mockTabsSendMessage).not.toHaveBeenCalled();
  });

  it('does NOT trigger auto-archive when auto_archive is string "false"', async () => {
    stores.settings.set('auto_archive', 'false');
    mockTabsQuery.mockResolvedValue([{ id: 10, url: 'https://example.com/str-false' }]);

    await onCreatedCallback('node-str-false', {
      id: 'node-str-false',
      title: 'String False Title',
      url: 'https://example.com/str-false',
      parentId: '1',
      dateAdded: Date.now()
    });

    expect(mockEnqueueArchiveJob).not.toHaveBeenCalled();
    expect(mockTabsSendMessage).not.toHaveBeenCalled();
  });

  it('does NOT trigger auto-archive when auto_archive setting is absent', async () => {
    // auto_archive not set in stores.settings
    mockTabsQuery.mockResolvedValue([{ id: 10, url: 'https://example.com/absent' }]);

    await onCreatedCallback('node-absent', {
      id: 'node-absent',
      title: 'Absent Title',
      url: 'https://example.com/absent',
      parentId: '1',
      dateAdded: Date.now()
    });

    expect(mockEnqueueArchiveJob).not.toHaveBeenCalled();
    expect(mockTabsSendMessage).not.toHaveBeenCalled();
  });

  it('extracts live DOM when active tab matches bookmark URL', async () => {
    stores.settings.set('auto_archive', true);
    mockTabsQuery.mockResolvedValue([{ id: 42, url: 'https://matched.com/article/' }]);
    mockTabsSendMessage.mockResolvedValue({
      html: '<article>Captured</article>',
      iframeSources: {}
    });

    await onCreatedCallback('node-matched', {
      id: 'node-matched',
      title: 'Matched Article',
      url: 'https://matched.com/article',
      parentId: '1',
      dateAdded: Date.now()
    });

    expect(mockTabsSendMessage).toHaveBeenCalledWith(42, {
      type: 'EXTRACT_HTML',
      autoScroll: false
    });
    expect(mockEnqueueArchiveJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueArchiveJob.mock.calls[0][0].htmlSource).toBe('<article>Captured</article>');
  });

  it('falls back to htmlSource: undefined when live DOM extraction errors', async () => {
    stores.settings.set('auto_archive', true);
    mockTabsQuery.mockResolvedValue([{ id: 42, url: 'https://err.com' }]);
    mockTabsSendMessage.mockRejectedValue(new Error('Connection closed'));

    await onCreatedCallback('node-err', {
      id: 'node-err',
      title: 'Error Article',
      url: 'https://err.com',
      parentId: '1',
      dateAdded: Date.now()
    });

    expect(mockTabsSendMessage).toHaveBeenCalledWith(42, {
      type: 'EXTRACT_HTML',
      autoScroll: false
    });
    expect(mockEnqueueArchiveJob).toHaveBeenCalledTimes(1);
    const callArg = mockEnqueueArchiveJob.mock.calls[0][0];
    expect(callArg.htmlSource).toBeUndefined();
    expect(callArg.iframeSources).toBeUndefined();
    expect(callArg.pageUrl).toBe('https://err.com');
  });

  it('falls back to htmlSource: undefined when live DOM extraction times out (>1500ms)', async () => {
    vi.useFakeTimers();
    stores.settings.set('auto_archive', true);
    mockTabsQuery.mockResolvedValue([{ id: 42, url: 'https://timeout.com' }]);
    // Promise that never resolves, simulating a slow/stalled content script
    mockTabsSendMessage.mockImplementation(() => new Promise(() => {}));

    const promise = onCreatedCallback('node-timeout', {
      id: 'node-timeout',
      title: 'Timeout Article',
      url: 'https://timeout.com',
      parentId: '1',
      dateAdded: Date.now()
    });

    // Advance beyond the 1500ms race timeout
    await vi.advanceTimersByTimeAsync(1600);
    await promise;

    expect(mockTabsSendMessage).toHaveBeenCalledWith(42, {
      type: 'EXTRACT_HTML',
      autoScroll: false
    });
    expect(mockEnqueueArchiveJob).toHaveBeenCalledTimes(1);
    const callArg = mockEnqueueArchiveJob.mock.calls[0][0];
    expect(callArg.htmlSource).toBeUndefined();
    expect(callArg.iframeSources).toBeUndefined();
  });

  it('keeps htmlSource undefined when bookmark URL is not from the active tab', async () => {
    stores.settings.set('auto_archive', true);
    mockTabsQuery.mockResolvedValue([{ id: 42, url: 'https://different-tab.com' }]);

    await onCreatedCallback('node-diff', {
      id: 'node-diff',
      title: 'Diff Tab Article',
      url: 'https://target-site.com',
      parentId: '1',
      dateAdded: Date.now()
    });

    expect(mockTabsSendMessage).not.toHaveBeenCalled();
    expect(mockEnqueueArchiveJob).toHaveBeenCalledTimes(1);
    const callArg = mockEnqueueArchiveJob.mock.calls[0][0];
    expect(callArg.htmlSource).toBeUndefined();
    expect(callArg.iframeSources).toBeUndefined();
    expect(callArg.pageUrl).toBe('https://target-site.com');
  });

  it('skips auto-archive when isImporting is true', async () => {
    stores.settings.set('auto_archive', true);
    onImportBeganCallback();
    expect(BookmarkManager.isImporting).toBe(true);

    mockTabsQuery.mockResolvedValue([{ id: 1, url: 'https://imported.com' }]);

    await onCreatedCallback('node-import-1', {
      id: 'node-import-1',
      title: 'Imported',
      url: 'https://imported.com',
      parentId: '1'
    });

    expect(mockEnqueueArchiveJob).not.toHaveBeenCalled();

    // After import ends, auto-archive should work again
    onImportEndedCallback();
    expect(BookmarkManager.isImporting).toBe(false);

    await onCreatedCallback('node-normal-1', {
      id: 'node-normal-1',
      title: 'Normal',
      url: 'https://imported.com',
      parentId: '1'
    });

    expect(mockEnqueueArchiveJob).toHaveBeenCalledTimes(1);
  });

  it('skips auto-archive when bookmark was created by extension (isExtensionCreated)', async () => {
    stores.settings.set('auto_archive', true);
    mockBookmarkCreate.mockResolvedValue({
      id: 'popup-node-1',
      url: 'https://popup.com',
      title: 'Popup Bookmark',
      parentId: '1'
    });

    mockTabsQuery.mockResolvedValue([{ id: 5, url: 'https://popup.com' }]);

    const created = await BookmarkManager.createBookmark('https://popup.com', 'Popup Bookmark');
    expect(created.bookmarkId).toBe('popup-node-1');
    expect(BookmarkManager.extensionCreatedBookmarkIds.has('popup-node-1')).toBe(true);

    // Browser fires onCreated for the extension-created node
    await onCreatedCallback('popup-node-1', {
      id: 'popup-node-1',
      title: 'Popup Bookmark',
      url: 'https://popup.com',
      parentId: '1'
    });

    expect(mockEnqueueArchiveJob).not.toHaveBeenCalled();
    expect(BookmarkManager.extensionCreatedBookmarkIds.has('popup-node-1')).toBe(false);
  });

  it('skips auto-archive when burst rate limiter triggers (isBurst)', async () => {
    stores.settings.set('auto_archive', true);
    const baseTime = 10000;
    mockTabsQuery.mockResolvedValue([{ id: 1, url: 'https://burst.com' }]);

    // Creation 1 (t = 10000): Allowed
    vi.spyOn(Date, 'now').mockReturnValue(baseTime);
    await onCreatedCallback('burst-1', {
      id: 'burst-1',
      title: 'Burst 1',
      url: 'https://burst.com/1',
      parentId: '1'
    });
    expect(mockEnqueueArchiveJob).toHaveBeenCalledTimes(1);

    // Creation 2 (t = 10100): Allowed
    vi.spyOn(Date, 'now').mockReturnValue(baseTime + 100);
    await onCreatedCallback('burst-2', {
      id: 'burst-2',
      title: 'Burst 2',
      url: 'https://burst.com/2',
      parentId: '1'
    });
    expect(mockEnqueueArchiveJob).toHaveBeenCalledTimes(2);

    // Creation 3 (t = 10200): Burst tripped!
    vi.spyOn(Date, 'now').mockReturnValue(baseTime + 200);
    await onCreatedCallback('burst-3', {
      id: 'burst-3',
      title: 'Burst 3',
      url: 'https://burst.com/3',
      parentId: '1'
    });
    expect(mockEnqueueArchiveJob).toHaveBeenCalledTimes(2); // Still 2, 3rd was skipped
  });

  it('passes archive_compress setting correctly (defaults true, respects false and "false")', async () => {
    mockTabsQuery.mockResolvedValue([{ id: 1, url: 'https://example.com' }]);
    stores.settings.set('auto_archive', true);
    let time = 20000;

    // 1. Default (no archive_compress setting) -> true
    vi.spyOn(Date, 'now').mockReturnValue(time);
    await onCreatedCallback('node-c1', {
      id: 'node-c1',
      title: 'C1',
      url: 'https://example.com/c1',
      parentId: '1'
    });
    expect(mockEnqueueArchiveJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ compress: true })
    );

    // 2. archive_compress = false -> false
    time += 3000;
    vi.spyOn(Date, 'now').mockReturnValue(time);
    stores.settings.set('archive_compress', false);
    await onCreatedCallback('node-c2', {
      id: 'node-c2',
      title: 'C2',
      url: 'https://example.com/c2',
      parentId: '1'
    });
    expect(mockEnqueueArchiveJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ compress: false })
    );

    // 3. archive_compress = 'false' -> false
    time += 3000;
    vi.spyOn(Date, 'now').mockReturnValue(time);
    stores.settings.set('archive_compress', 'false');
    await onCreatedCallback('node-c3', {
      id: 'node-c3',
      title: 'C3',
      url: 'https://example.com/c3',
      parentId: '1'
    });
    expect(mockEnqueueArchiveJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ compress: false })
    );

    // 4. archive_compress = 'true' -> true
    time += 3000;
    vi.spyOn(Date, 'now').mockReturnValue(time);
    stores.settings.set('archive_compress', 'true');
    await onCreatedCallback('node-c4', {
      id: 'node-c4',
      title: 'C4',
      url: 'https://example.com/c4',
      parentId: '1'
    });
    expect(mockEnqueueArchiveJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ compress: true })
    );
  });

  it('aborts auto-archive if bookmark was deleted before extraction completes (TOCTOU defense)', async () => {
    stores.settings.set('auto_archive', true);
    mockTabsQuery.mockResolvedValue([{ id: 42, url: 'https://toctou.com' }]);

    // Simulate bookmark being deleted during extraction
    mockTabsSendMessage.mockImplementation(async () => {
      // Clear bookmarks store to simulate deletion
      stores.bookmarks = [];
      return { html: '<p>HTML</p>' };
    });

    await onCreatedCallback('node-toctou', {
      id: 'node-toctou',
      title: 'Toctou Article',
      url: 'https://toctou.com',
      parentId: '1'
    });

    expect(mockTabsSendMessage).toHaveBeenCalled();
    expect(mockEnqueueArchiveJob).not.toHaveBeenCalled();
  });
});
