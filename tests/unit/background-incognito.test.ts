import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateDeterministicSyncId } from '../../src/lib/bookmarks/url-normalizer';

const {
  mockRecordVisit,
  mockUpdateActionBadge,
  mockDbCount,
  mockDbFirst,
  mockDbWhere,
  mockDbBookmarksAdd,
  mockDbBookmarksUpdate,
  mockDbTransaction,
  tabsOnUpdatedListeners,
  runtimeOnMessageListeners,
  mockTabsQuery,
  mockBookmarksCreate,
  mockExtensionCreatedBookmarkIds,
  mockNotifyBookmarksChanged,
  mockFindDuplicate,
  mockRemoveTombstone
} = vi.hoisted(() => {
  const tabsOnUpdatedListeners: Array<(tabId: number, changeInfo: any, tab: any) => void> = [];
  const runtimeOnMessageListeners: Array<(msg: any, sender: any, sendResponse: (res: any) => void) => boolean | void> = [];
  const mockDbCount = vi.fn().mockResolvedValue(1);
  const mockDbFirst = vi.fn().mockResolvedValue(null);
  const mockDbWhere = vi.fn().mockReturnValue({
    equals: vi.fn().mockReturnValue({
      count: mockDbCount,
      first: mockDbFirst
    })
  });
  const mockDbBookmarksAdd = vi.fn().mockResolvedValue(101);
  const mockDbBookmarksUpdate = vi.fn().mockResolvedValue(1);
  const mockDbTransaction = vi.fn(async (_mode: any, _tables: any, fn: () => Promise<any>) => await fn());
  const mockBookmarksCreate = vi.fn().mockImplementation(async (data: any) => ({
    id: 'browser-node-123',
    title: data.title || data.url,
    url: data.url,
    parentId: data.parentId || '1'
  }));
  const mockExtensionCreatedBookmarkIds = new Set<string>();
  const mockNotifyBookmarksChanged = vi.fn();
  const mockFindDuplicate = vi.fn().mockResolvedValue(null);
  const mockRemoveTombstone = vi.fn().mockResolvedValue(undefined);

  return {
    mockRecordVisit: vi.fn().mockResolvedValue(undefined),
    mockUpdateActionBadge: vi.fn().mockResolvedValue(undefined),
    mockDbCount,
    mockDbFirst,
    mockDbWhere,
    mockDbBookmarksAdd,
    mockDbBookmarksUpdate,
    mockDbTransaction,
    tabsOnUpdatedListeners,
    runtimeOnMessageListeners,
    mockTabsQuery: vi.fn().mockResolvedValue([]),
    mockBookmarksCreate,
    mockExtensionCreatedBookmarkIds,
    mockNotifyBookmarksChanged,
    mockFindDuplicate,
    mockRemoveTombstone
  };
});

// Setup globals before importing background
(globalThis as any).defineBackground = (fn: () => void) => {
  return { main: fn };
};

vi.stubGlobal('browser', {
  runtime: {
    getURL: vi.fn((path: string) => `chrome-extension://mock-id${path}`),
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
    onMessage: {
      addListener: vi.fn((cb) => {
        runtimeOnMessageListeners.push(cb);
      })
    }
  },
  tabs: {
    create: vi.fn(),
    query: mockTabsQuery,
    onActivated: { addListener: vi.fn() },
    onUpdated: {
      addListener: vi.fn((cb) => {
        tabsOnUpdatedListeners.push(cb);
      })
    }
  },
  bookmarks: {
    create: mockBookmarksCreate,
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onChanged: { addListener: vi.fn() },
    onMoved: { addListener: vi.fn() }
  },
  alarms: {
    onAlarm: { addListener: vi.fn() }
  },
  contextMenus: {
    create: vi.fn(),
    onClicked: { addListener: vi.fn() }
  }
});

vi.mock('../../src/lib/stats/stats-tracker', () => ({
  recordVisit: mockRecordVisit
}));

vi.mock('../../src/lib/bookmarks/badge-manager', () => ({
  updateActionBadge: mockUpdateActionBadge,
  setTaskIndicator: vi.fn(),
  resetTaskIndicator: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../../src/lib/db', () => ({
  default: {
    bookmarks: {
      where: mockDbWhere,
      add: mockDbBookmarksAdd,
      update: mockDbBookmarksUpdate,
      toArray: vi.fn().mockResolvedValue([])
    },
    settings: {
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined)
    },
    transaction: mockDbTransaction
  },
  db: {
    bookmarks: {
      where: mockDbWhere,
      add: mockDbBookmarksAdd,
      update: mockDbBookmarksUpdate,
      toArray: vi.fn().mockResolvedValue([])
    },
    settings: {
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined)
    },
    transaction: mockDbTransaction
  }
}));

vi.mock('../../src/lib/bookmarks/bookmark-manager', () => ({
  BookmarkManager: {
    listen: vi.fn(),
    syncAll: vi.fn().mockResolvedValue(undefined),
    isSyncMuted: false,
    extensionCreatedBookmarkIds: mockExtensionCreatedBookmarkIds,
    notifyBookmarksChanged: mockNotifyBookmarksChanged,
    findDuplicate: mockFindDuplicate
  }
}));

vi.mock('../../src/lib/sync/sync-engine', () => ({
  SyncEngine: {
    setupBackgroundAlarms: vi.fn(),
    triggerDebouncedSync: vi.fn(),
    sync: vi.fn().mockResolvedValue(undefined),
    SYNC_ALARM_NAME: 'sync_alarm'
  }
}));

vi.mock('../../src/lib/sync/tombstones', () => ({
  removeTombstone: mockRemoveTombstone
}));

vi.mock('../../src/lib/ai/ai-queue', () => ({
  initAiQueue: vi.fn().mockResolvedValue(undefined),
  enqueueAiJob: vi.fn(),
  enqueueAiJobs: vi.fn(),
  cancelBookmarkAi: vi.fn(),
  cancelAllAi: vi.fn()
}));

vi.mock('../../src/lib/dev-settings', () => ({
  seedDevSettings: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../../src/lib/archive/archive-cloud', () => ({
  syncArchiveToCloudByBookmarkId: vi.fn(),
  syncPendingArchives: vi.fn().mockResolvedValue(undefined),
  restoreArchivesFromCloud: vi.fn(),
  deleteArchiveFromCloud: vi.fn(),
  refreshCloudArchiveIndex: vi.fn().mockResolvedValue(undefined),
  downloadArchiveOnDemand: vi.fn()
}));

vi.mock('../../src/lib/archive/resource-fetcher', () => ({
  fetchResourceAsDataUri: vi.fn()
}));

vi.mock('../../src/lib/archive/archive-queue', () => ({
  enqueueArchiveJob: vi.fn()
}));

vi.mock('../../src/lib/archive/fetch-with-charset', () => ({
  decodeResponseHtml: vi.fn()
}));

import backgroundDefinition from '../../src/entrypoints/background';

async function sendMessage(message: any, sender: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const sendResponse = (response: any) => {
      if (!resolved) {
        resolved = true;
        resolve(response);
      }
    };

    for (const listener of runtimeOnMessageListeners) {
      try {
        const isAsync = listener(message, sender, sendResponse);
        if (isAsync === true) {
          return;
        }
        if (resolved) {
          return;
        }
      } catch (err) {
        reject(err);
        return;
      }
    }

    if (!resolved) {
      resolve(undefined);
    }
  });
}

describe('Background tabs.onUpdated policy compliance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tabsOnUpdatedListeners.length = 0;
    runtimeOnMessageListeners.length = 0;
    mockDbCount.mockResolvedValue(1);
    // Execute the background main function to register listeners
    (backgroundDefinition as any).main();
  });

  it('should NOT record visit if tab is incognito (Mozilla Add-on Policy 6.3)', async () => {
    expect(tabsOnUpdatedListeners.length).toBeGreaterThan(0);
    const onUpdated = tabsOnUpdatedListeners[0];

    const incognitoTab = {
      id: 101,
      url: 'https://example.com/private-page',
      incognito: true
    };

    onUpdated(101, { status: 'complete', url: 'https://example.com/private-page' }, incognitoTab);

    // Wait a tick for any async promises
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockRecordVisit).not.toHaveBeenCalled();
    expect(mockDbWhere).not.toHaveBeenCalled();
  });

  it('should record visit if tab is not incognito and URL is bookmarked', async () => {
    expect(tabsOnUpdatedListeners.length).toBeGreaterThan(0);
    const onUpdated = tabsOnUpdatedListeners[0];

    mockDbCount.mockResolvedValueOnce(1);

    const normalTab = {
      id: 102,
      url: 'https://example.com/normal-page',
      incognito: false
    };

    onUpdated(102, { status: 'complete', url: 'https://example.com/normal-page' }, normalTab);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockDbWhere).toHaveBeenCalledWith('url');
    expect(mockRecordVisit).toHaveBeenCalledWith('https://example.com/normal-page');
  });

  it('should NOT record visit if tab is not incognito but URL is not bookmarked', async () => {
    expect(tabsOnUpdatedListeners.length).toBeGreaterThan(0);
    const onUpdated = tabsOnUpdatedListeners[0];

    mockDbCount.mockResolvedValueOnce(0);

    const normalTab = {
      id: 103,
      url: 'https://example.com/unbookmarked-page',
      incognito: false
    };

    onUpdated(103, { status: 'complete', url: 'https://example.com/unbookmarked-page' }, normalTab);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockDbWhere).toHaveBeenCalledWith('url');
    expect(mockRecordVisit).not.toHaveBeenCalled();
  });
});

describe('Incognito IPC Message Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tabsOnUpdatedListeners.length = 0;
    runtimeOnMessageListeners.length = 0;
    mockExtensionCreatedBookmarkIds.clear();
    mockDbFirst.mockResolvedValue(null);
    mockDbCount.mockResolvedValue(1);
    mockDbBookmarksAdd.mockResolvedValue(101);
    mockDbBookmarksUpdate.mockResolvedValue(1);
    mockFindDuplicate.mockResolvedValue(null);
    mockBookmarksCreate.mockImplementation(async (data: any) => ({
      id: 'browser-node-123',
      title: data.title || data.url,
      url: data.url,
      parentId: data.parentId || '1'
    }));
    mockDbTransaction.mockImplementation(async (_mode: any, _tables: any, fn: () => Promise<any>) => await fn());
    (backgroundDefinition as any).main();
  });

  describe('CREATE_INCOGNITO_BOOKMARK', () => {
    it('successfully creates bookmark node, adds to extensionCreatedBookmarkIds, commits to DB, and returns bookmark info', async () => {
      const targetUrl = 'https://example.com/incognito-page';
      const expectedSyncId = generateDeterministicSyncId(targetUrl);

      const res = await sendMessage({
        type: 'CREATE_INCOGNITO_BOOKMARK',
        url: targetUrl,
        title: 'Incognito Bookmark',
        parentId: 'toolbar_____',
        folderPath: 'Bookmarks/Private',
        description: 'Test description',
        tags: ['private', 'dev']
      });

      expect(mockBookmarksCreate).toHaveBeenCalledWith({
        parentId: 'toolbar_____',
        title: 'Incognito Bookmark',
        url: targetUrl
      });
      expect(mockExtensionCreatedBookmarkIds.has('browser-node-123')).toBe(true);
      expect(mockDbTransaction).toHaveBeenCalledWith('rw', expect.any(Array), expect.any(Function));
      expect(mockRemoveTombstone).toHaveBeenCalledWith(expectedSyncId);
      expect(mockDbBookmarksAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          syncId: expectedSyncId,
          bookmarkId: 'browser-node-123',
          url: targetUrl,
          title: 'Incognito Bookmark',
          folderPath: 'Bookmarks/Private',
          description: 'Test description',
          tags: ['private', 'dev'],
          visitCount: 0
        })
      );
      expect(mockNotifyBookmarksChanged).toHaveBeenCalled();
      expect(res).toEqual({
        ok: true,
        bookmarkId: 101,
        browserBookmarkId: 'browser-node-123',
        syncId: expectedSyncId
      });
    });

    it('falls back to randomUUID if deterministic syncId already exists in DB', async () => {
      const targetUrl = 'https://example.com/collision-page';
      const expectedSyncId = generateDeterministicSyncId(targetUrl);

      // Simulate existing bookmark with the same deterministic syncId
      mockDbFirst.mockResolvedValueOnce({ id: 999, syncId: expectedSyncId });

      const res = await sendMessage({
        type: 'CREATE_INCOGNITO_BOOKMARK',
        url: targetUrl,
        title: 'Collision Bookmark'
      });

      expect(res.ok).toBe(true);
      expect(res.browserBookmarkId).toBe('browser-node-123');
      expect(res.syncId).not.toBe(expectedSyncId);
      expect(res.syncId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(mockRemoveTombstone).toHaveBeenCalledWith(res.syncId);
      expect(mockDbBookmarksAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          syncId: res.syncId,
          url: targetUrl
        })
      );
    });

    it('returns error when URL is missing', async () => {
      const res = await sendMessage({
        type: 'CREATE_INCOGNITO_BOOKMARK',
        url: '',
        title: 'Missing URL'
      });

      expect(res).toEqual({ ok: false, error: 'URL is required' });
      expect(mockBookmarksCreate).not.toHaveBeenCalled();
      expect(mockDbBookmarksAdd).not.toHaveBeenCalled();
    });

    it('returns error response when browser.bookmarks.create throws', async () => {
      mockBookmarksCreate.mockRejectedValueOnce(new Error('Permission denied'));

      const res = await sendMessage({
        type: 'CREATE_INCOGNITO_BOOKMARK',
        url: 'https://example.com/fail',
        title: 'Fail'
      });

      expect(res).toEqual({ ok: false, error: 'Permission denied' });
      expect(mockDbBookmarksAdd).not.toHaveBeenCalled();
    });
  });

  describe('REGISTER_INCOGNITO_BOOKMARK', () => {
    it('successfully updates existing bookmark record in transaction', async () => {
      const existingBookmark = {
        id: 42,
        syncId: 'existing-sync-id',
        bookmarkId: '456',
        url: 'https://example.com/existing',
        title: 'Old Title',
        folderPath: 'Old/Folder',
        description: 'Old Description',
        tags: ['old']
      };
      mockDbFirst.mockResolvedValueOnce(existingBookmark);

      const res = await sendMessage({
        type: 'REGISTER_INCOGNITO_BOOKMARK',
        syncId: 'existing-sync-id',
        browserBookmarkId: '456',
        url: 'https://example.com/existing',
        title: 'Updated Title',
        folderPath: 'Updated/Folder',
        description: 'Updated Description',
        tags: ['updated']
      });

      expect(mockExtensionCreatedBookmarkIds.has('456')).toBe(true);
      expect(mockDbBookmarksUpdate).toHaveBeenCalledWith(
        42,
        expect.objectContaining({
          title: 'Updated Title',
          folderPath: 'Updated/Folder',
          description: 'Updated Description',
          tags: ['updated'],
          modifiedAt: expect.any(Number)
        })
      );
      expect(mockNotifyBookmarksChanged).toHaveBeenCalled();
      expect(res).toEqual({ ok: true, dbId: 42, syncId: 'existing-sync-id' });
    });

    it('creates new record in transaction when bookmark does not exist', async () => {
      mockDbFirst.mockResolvedValue(null);
      mockDbBookmarksAdd.mockResolvedValueOnce(77);

      const res = await sendMessage({
        type: 'REGISTER_INCOGNITO_BOOKMARK',
        syncId: 'new-sync-id',
        browserBookmarkId: '789',
        url: 'https://example.com/new',
        title: 'New Bookmark',
        folderPath: 'New/Folder',
        description: 'New Description',
        tags: ['tag1']
      });

      expect(mockExtensionCreatedBookmarkIds.has('789')).toBe(true);
      expect(mockRemoveTombstone).toHaveBeenCalledWith('new-sync-id');
      expect(mockDbBookmarksAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          syncId: 'new-sync-id',
          bookmarkId: '789',
          url: 'https://example.com/new',
          title: 'New Bookmark',
          folderPath: 'New/Folder',
          description: 'New Description',
          tags: ['tag1'],
          visitCount: 0
        })
      );
      expect(mockNotifyBookmarksChanged).toHaveBeenCalled();
      expect(res).toEqual({ ok: true, dbId: 77, syncId: 'new-sync-id' });
    });

    it('returns error response when transaction fails', async () => {
      mockDbTransaction.mockRejectedValueOnce(new Error('Transaction aborted'));

      const res = await sendMessage({
        type: 'REGISTER_INCOGNITO_BOOKMARK',
        syncId: 'sync-err',
        browserBookmarkId: 'node-err',
        url: 'https://example.com/err'
      });

      expect(res).toEqual({ ok: false, error: 'Transaction aborted' });
    });
  });

  describe('CHECK_DUPLICATE_BOOKMARK', () => {
    it('returns duplicate: true with bookmark metadata when duplicate bookmark is found', async () => {
      const duplicateRecord = {
        id: 10,
        syncId: 'sync-10',
        bookmarkId: 'bm-10',
        title: 'Dup Title',
        folderPath: 'Bookmarks/Bar',
        tags: ['test'],
        description: 'Existing description',
        createdAt: 1000,
        modifiedAt: 2000
      };
      mockFindDuplicate.mockResolvedValueOnce(duplicateRecord);

      const res = await sendMessage({
        type: 'CHECK_DUPLICATE_BOOKMARK',
        url: 'https://example.com/duplicate'
      });

      expect(mockFindDuplicate).toHaveBeenCalledWith('https://example.com/duplicate');
      expect(res).toEqual({
        duplicate: true,
        bookmark: {
          id: 10,
          syncId: 'sync-10',
          bookmarkId: 'bm-10',
          title: 'Dup Title',
          folderPath: 'Bookmarks/Bar',
          tags: ['test'],
          description: 'Existing description',
          createdAt: 1000,
          modifiedAt: 2000
        }
      });
    });

    it('returns duplicate: false and bookmark: null when no duplicate is found', async () => {
      mockFindDuplicate.mockResolvedValueOnce(null);

      const res = await sendMessage({
        type: 'CHECK_DUPLICATE_BOOKMARK',
        url: 'https://example.com/unique'
      });

      expect(mockFindDuplicate).toHaveBeenCalledWith('https://example.com/unique');
      expect(res).toEqual({
        duplicate: false,
        bookmark: null
      });
    });

    it('handles error in findDuplicate and returns duplicate: false with null bookmark', async () => {
      mockFindDuplicate.mockRejectedValueOnce(new Error('Lookup failure'));

      const res = await sendMessage({
        type: 'CHECK_DUPLICATE_BOOKMARK',
        url: 'https://example.com/error-url'
      });

      expect(res).toEqual({
        duplicate: false,
        bookmark: null
      });
    });
  });
});
