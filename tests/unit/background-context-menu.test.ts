import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BookmarkManager } from '../../src/lib/bookmarks/bookmark-manager';
import { SyncEngine } from '../../src/lib/sync/sync-engine';

const {
  mockRemoveAll,
  mockCreate,
  mockTabsCreate,
  runtimeListeners,
  contextMenuClickListeners
} = vi.hoisted(() => {
  const runtimeListeners: {
    onInstalled: Array<(details: any) => void>;
    onStartup: Array<() => void>;
    onMessage: Array<(msg: any, sender: any, sendResponse: any) => void>;
  } = {
    onInstalled: [],
    onStartup: [],
    onMessage: []
  };

  const contextMenuClickListeners: Array<(info: any) => void> = [];

  const mockRemoveAll = vi.fn((cb?: () => void) => {
    if (cb) cb();
    return Promise.resolve();
  });

  const mockCreate = vi.fn((_props: any, cb?: () => void) => {
    if (cb) cb();
  });

  const mockTabsCreate = vi.fn();

  return {
    mockRemoveAll,
    mockCreate,
    mockTabsCreate,
    runtimeListeners,
    contextMenuClickListeners
  };
});

// Setup globals before importing background
(globalThis as any).defineBackground = (fn: () => void) => {
  return { main: fn };
};

vi.stubGlobal('browser', {
  runtime: {
    getURL: vi.fn((path: string) => `chrome-extension://mock-id${path}`),
    onInstalled: {
      addListener: vi.fn((cb) => {
        runtimeListeners.onInstalled.push(cb);
      })
    },
    onStartup: {
      addListener: vi.fn((cb) => {
        runtimeListeners.onStartup.push(cb);
      })
    },
    onMessage: {
      addListener: vi.fn((cb) => {
        runtimeListeners.onMessage.push(cb);
      })
    }
  },
  tabs: {
    create: mockTabsCreate,
    query: vi.fn().mockResolvedValue([]),
    onActivated: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() }
  },
  bookmarks: {
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onChanged: { addListener: vi.fn() },
    onMoved: { addListener: vi.fn() }
  },
  alarms: {
    onAlarm: { addListener: vi.fn() },
    create: vi.fn(),
    clear: vi.fn()
  },
  contextMenus: {
    removeAll: mockRemoveAll,
    create: mockCreate,
    onClicked: {
      addListener: vi.fn((cb) => {
        contextMenuClickListeners.push(cb);
      })
    }
  }
});

vi.mock('../../src/lib/stats/stats-tracker', () => ({
  recordVisit: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../../src/lib/bookmarks/badge-manager', () => ({
  updateActionBadge: vi.fn().mockResolvedValue(undefined),
  setTaskIndicator: vi.fn()
}));

vi.mock('../../src/lib/db', () => ({
  default: {
    bookmarks: { where: vi.fn().mockReturnValue({ equals: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }) }) },
    settings: { get: vi.fn().mockResolvedValue({ value: true }), put: vi.fn().mockResolvedValue(undefined) }
  },
  db: {
    bookmarks: { where: vi.fn().mockReturnValue({ equals: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }) }) },
    settings: { get: vi.fn().mockResolvedValue({ value: true }), put: vi.fn().mockResolvedValue(undefined) }
  }
}));

vi.mock('../../src/lib/bookmarks/bookmark-manager', () => ({
  BookmarkManager: {
    listen: vi.fn(),
    syncAll: vi.fn().mockResolvedValue(undefined),
    isSyncMuted: false,
    setSyncMuted: vi.fn()
  }
}));

vi.mock('../../src/lib/sync/sync-engine', () => ({
  SyncEngine: {
    setupBackgroundAlarms: vi.fn(),
    triggerDebouncedSync: vi.fn(),
    sync: vi.fn().mockResolvedValue(undefined)
  }
}));

vi.mock('../../src/lib/ai/ai-queue', () => ({
  initAiQueue: vi.fn().mockResolvedValue(undefined),
  enqueueAiJob: vi.fn(),
  enqueueAiJobs: vi.fn(),
  cancelBookmarkAi: vi.fn(),
  cancelAllAi: vi.fn()
}));

vi.mock('../../src/lib/archive/archive-cloud', () => ({
  syncArchiveToCloudByBookmarkId: vi.fn(),
  syncPendingArchives: vi.fn().mockResolvedValue(undefined),
  restoreArchivesFromCloud: vi.fn(),
  deleteArchiveFromCloud: vi.fn(),
  refreshCloudArchiveIndex: vi.fn().mockResolvedValue(undefined),
  downloadArchiveOnDemand: vi.fn(),
  scanOrphanCloudArchives: vi.fn(),
  deleteOrphanCloudArchives: vi.fn(),
  fetchOrphanArchiveHtml: vi.fn()
}));

vi.mock('../../src/lib/archive/archive-queue', () => ({
  enqueueArchiveJob: vi.fn()
}));

describe('Background Context Menu Lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers context menu on worker initialization and handles clicks', async () => {
    const backgroundModule = await import('../../src/entrypoints/background');
    (backgroundModule.default as any).main();

    // 1. Must register on service worker initialization
    expect(mockRemoveAll).toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'open-management',
        contexts: ['action']
      }),
      expect.any(Function)
    );

    // 2. Must register on browser startup and trigger startup sync
    mockCreate.mockClear();
    mockRemoveAll.mockClear();
    for (const startupCb of runtimeListeners.onStartup) {
      await startupCb();
    }
    expect(mockRemoveAll).toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'open-management',
        contexts: ['action']
      }),
      expect.any(Function)
    );
    expect(BookmarkManager.syncAll).toHaveBeenCalled();
    expect(SyncEngine.sync).toHaveBeenCalled();

    // 3. Must register on extension install/update
    mockCreate.mockClear();
    mockRemoveAll.mockClear();
    for (const installedCb of runtimeListeners.onInstalled) {
      await installedCb({ reason: 'install' });
    }
    expect(mockRemoveAll).toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalled();

    // 4. Click event opens management page
    for (const clickCb of contextMenuClickListeners) {
      clickCb({ menuItemId: 'open-management' });
    }
    expect(mockTabsCreate).toHaveBeenCalledWith({
      url: 'chrome-extension://mock-id/management.html'
    });
  });
});
