import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockRecordVisit,
  mockUpdateActionBadge,
  mockDbCount,
  mockDbWhere,
  tabsOnUpdatedListeners,
  mockTabsQuery
} = vi.hoisted(() => {
  const tabsOnUpdatedListeners: Array<(tabId: number, changeInfo: any, tab: any) => void> = [];
  const mockDbCount = vi.fn().mockResolvedValue(1);
  const mockDbWhere = vi.fn().mockReturnValue({
    equals: vi.fn().mockReturnValue({
      count: mockDbCount
    })
  });

  return {
    mockRecordVisit: vi.fn().mockResolvedValue(undefined),
    mockUpdateActionBadge: vi.fn().mockResolvedValue(undefined),
    mockDbCount,
    mockDbWhere,
    tabsOnUpdatedListeners,
    mockTabsQuery: vi.fn().mockResolvedValue([])
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
    onMessage: { addListener: vi.fn() }
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
  setTaskIndicator: vi.fn()
}));

vi.mock('../../src/lib/db', () => ({
  default: {
    bookmarks: {
      where: mockDbWhere
    }
  },
  db: {
    bookmarks: {
      where: mockDbWhere
    }
  }
}));

vi.mock('../../src/lib/bookmarks/bookmark-manager', () => ({
  BookmarkManager: {
    listen: vi.fn(),
    isSyncMuted: false
  }
}));

vi.mock('../../src/lib/sync/sync-engine', () => ({
  SyncEngine: {
    setupBackgroundAlarms: vi.fn(),
    triggerDebouncedSync: vi.fn(),
    SYNC_ALARM_NAME: 'sync_alarm'
  }
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

describe('Background tabs.onUpdated policy compliance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tabsOnUpdatedListeners.length = 0;
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
