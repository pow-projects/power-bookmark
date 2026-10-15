import { describe, it, expect, vi, beforeEach } from 'vitest';

const EXTENSION_ID = 'pb-test-extension-id';
const EXTENSION_BASE_URL = `chrome-extension://${EXTENSION_ID}`;

const {
  runtimeOnMessageListeners,
  mockTabsQuery,
  mockCaptureVisibleTab,
  mockBookmarksCreate,
  mockExtensionCreatedBookmarkIds,
  mockNotifyBookmarksChanged,
  mockFindDuplicate,
  mockRemoveTombstone,
  mockSetTaskIndicator,
  mockResetTaskIndicator,
  mockDbBookmarksAdd,
  mockDbBookmarksUpdate,
  mockDbBookmarksToArray,
  mockDbTransaction,
  mockDecodeResponseHtml,
  mockFetchResourceAsDataUri,
  mockFetch
} = vi.hoisted(() => {
  const runtimeOnMessageListeners: Array<(msg: any, sender: any, sendResponse: (res: any) => void) => boolean | void> = [];
  const mockExtensionCreatedBookmarkIds = new Set<string>();
  const mockBookmarksCreate = vi.fn().mockImplementation(async (data: any) => ({
    id: 'browser-node-123',
    title: data.title || data.url,
    url: data.url,
    parentId: data.parentId || '1'
  }));
  const mockDbBookmarksToArray = vi.fn().mockResolvedValue([
    { id: 1, tags: ['security', 'ipc'] },
    { id: 2, tags: ['vitest'] }
  ]);
  const mockDbBookmarksAdd = vi.fn().mockResolvedValue(101);
  const mockDbBookmarksUpdate = vi.fn().mockResolvedValue(1);
  const mockDbTransaction = vi.fn(async (_mode: any, _tables: any, fn: () => Promise<any>) => await fn());
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: vi.fn().mockResolvedValue('<html><body><iframe>embedded</iframe></body></html>')
  });

  return {
    runtimeOnMessageListeners,
    mockTabsQuery: vi.fn().mockResolvedValue([]),
    mockCaptureVisibleTab: vi.fn().mockResolvedValue('data:image/png;base64,mockCaptureData'),
    mockBookmarksCreate,
    mockExtensionCreatedBookmarkIds,
    mockNotifyBookmarksChanged: vi.fn(),
    mockFindDuplicate: vi.fn().mockResolvedValue(null),
    mockRemoveTombstone: vi.fn().mockResolvedValue(undefined),
    mockSetTaskIndicator: vi.fn().mockResolvedValue(undefined),
    mockResetTaskIndicator: vi.fn().mockResolvedValue(undefined),
    mockDbBookmarksAdd,
    mockDbBookmarksUpdate,
    mockDbBookmarksToArray,
    mockDbTransaction,
    mockDecodeResponseHtml: vi.fn().mockResolvedValue('<html><body><iframe>embedded</iframe></body></html>'),
    mockFetchResourceAsDataUri: vi.fn().mockResolvedValue('data:text/css;base64,mockCssData'),
    mockFetch
  };
});

// Setup globals before importing background
(globalThis as any).defineBackground = (fn: () => void) => {
  return { main: fn };
};

vi.stubGlobal('fetch', mockFetch);

vi.stubGlobal('browser', {
  runtime: {
    id: EXTENSION_ID,
    getURL: vi.fn((path: string = '') => `${EXTENSION_BASE_URL}${path.startsWith('/') || path === '' ? path : '/' + path}`),
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
    captureVisibleTab: mockCaptureVisibleTab,
    onActivated: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() }
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
    removeAll: vi.fn((cb?: () => void) => {
      if (cb) cb();
      return Promise.resolve();
    }),
    create: vi.fn(),
    onClicked: { addListener: vi.fn() }
  }
});

vi.mock('../../src/lib/stats/stats-tracker', () => ({
  recordVisit: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../../src/lib/bookmarks/badge-manager', () => ({
  updateActionBadge: vi.fn().mockResolvedValue(undefined),
  setTaskIndicator: mockSetTaskIndicator,
  resetTaskIndicator: mockResetTaskIndicator
}));

vi.mock('../../src/lib/db', () => ({
  default: {
    bookmarks: {
      where: vi.fn().mockReturnValue({
        equals: vi.fn().mockReturnValue({
          count: vi.fn().mockResolvedValue(0),
          first: vi.fn().mockResolvedValue(null)
        })
      }),
      add: mockDbBookmarksAdd,
      update: mockDbBookmarksUpdate,
      toArray: mockDbBookmarksToArray
    },
    settings: {
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined)
    },
    transaction: mockDbTransaction
  },
  db: {
    bookmarks: {
      where: vi.fn().mockReturnValue({
        equals: vi.fn().mockReturnValue({
          count: vi.fn().mockResolvedValue(0),
          first: vi.fn().mockResolvedValue(null)
        })
      }),
      add: mockDbBookmarksAdd,
      update: mockDbBookmarksUpdate,
      toArray: mockDbBookmarksToArray
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
    setSyncMuted: vi.fn(),
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
  enqueueAiJob: vi.fn().mockResolvedValue(undefined),
  enqueueAiJobs: vi.fn().mockResolvedValue(undefined),
  cancelBookmarkAi: vi.fn().mockResolvedValue(undefined),
  cancelAllAi: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../../src/lib/dev-settings', () => ({
  seedDevSettings: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../../src/lib/archive/archive-cloud', () => ({
  syncArchiveToCloudByBookmarkId: vi.fn().mockResolvedValue(undefined),
  syncPendingArchives: vi.fn().mockResolvedValue(undefined),
  restoreArchivesFromCloud: vi.fn().mockResolvedValue({ restored: 0, orphans: [] }),
  deleteArchiveFromCloud: vi.fn().mockResolvedValue(undefined),
  refreshCloudArchiveIndex: vi.fn().mockResolvedValue([]),
  downloadArchiveOnDemand: vi.fn().mockResolvedValue(null),
  scanOrphanCloudArchives: vi.fn().mockResolvedValue([]),
  deleteOrphanCloudArchives: vi.fn().mockResolvedValue({ deleted: 0 }),
  fetchOrphanArchiveHtml: vi.fn().mockResolvedValue('<html>orphan</html>')
}));

vi.mock('../../src/lib/archive/resource-fetcher', () => ({
  fetchResourceAsDataUri: mockFetchResourceAsDataUri
}));

vi.mock('../../src/lib/archive/archive-queue', () => ({
  enqueueArchiveJob: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../../src/lib/archive/fetch-with-charset', () => ({
  decodeResponseHtml: mockDecodeResponseHtml
}));

import backgroundDefinition, {
  isInternalExtensionSender,
  isAuthorizedIncognitoSender
} from '../../src/entrypoints/background';

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

describe('IPC Security Verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeOnMessageListeners.length = 0;
    mockExtensionCreatedBookmarkIds.clear();
    mockDecodeResponseHtml.mockResolvedValue('<html><body><iframe>embedded</iframe></body></html>');
    mockFetchResourceAsDataUri.mockResolvedValue('data:text/css;base64,mockCssData');
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('<html><body><iframe>embedded</iframe></body></html>')
    });
    mockCaptureVisibleTab.mockResolvedValue('data:image/png;base64,mockCaptureData');
    mockSetTaskIndicator.mockResolvedValue(undefined);
    mockFindDuplicate.mockResolvedValue(null);
    mockDbBookmarksToArray.mockResolvedValue([
      { id: 1, tags: ['security', 'ipc'] },
      { id: 2, tags: ['vitest'] }
    ]);
    (backgroundDefinition as any).main();
  });

  describe('isInternalExtensionSender', () => {
    it('allows popups and offscreen documents with matching runtime ID and no tab', () => {
      // Ephemeral popup sender: runtime.id present, tab is null/undefined
      expect(isInternalExtensionSender({ id: EXTENSION_ID })).toBe(true);
      expect(isInternalExtensionSender({
        id: EXTENSION_ID,
        url: `${EXTENSION_BASE_URL}/popup.html`
      })).toBe(true);
      expect(isInternalExtensionSender({
        id: EXTENSION_ID,
        url: `${EXTENSION_BASE_URL}/offscreen.html`
      })).toBe(true);
    });

    it('allows extension tabs whose tab.url starts with the extension base URL', () => {
      // Management SPA tab
      expect(isInternalExtensionSender({
        id: EXTENSION_ID,
        url: `${EXTENSION_BASE_URL}/management.html`,
        tab: { id: 10, url: `${EXTENSION_BASE_URL}/management.html` }
      })).toBe(true);

      // Viewer SPA tab
      expect(isInternalExtensionSender({
        id: EXTENSION_ID,
        tab: { id: 11, url: `${EXTENSION_BASE_URL}/viewer.html` }
      })).toBe(true);
    });

    it('rejects external web page content scripts even if sender.id matches', () => {
      // Content script running on external domain
      expect(isInternalExtensionSender({
        id: EXTENSION_ID,
        url: 'https://malicious.com',
        tab: { id: 20, url: 'https://malicious.com' }
      })).toBe(false);

      expect(isInternalExtensionSender({
        id: EXTENSION_ID,
        tab: { id: 21, url: 'https://malicious.com' }
      })).toBe(false);

      expect(isInternalExtensionSender({
        tab: { id: 22, url: 'https://malicious.com' }
      })).toBe(false);
    });

    it('rejects senders with mismatched extension ID', () => {
      expect(isInternalExtensionSender({
        id: 'other-extension-id',
        url: `${EXTENSION_BASE_URL}/popup.html`
      })).toBe(false);

      expect(isInternalExtensionSender({
        id: 'other-extension-id'
      })).toBe(false);

      expect(isInternalExtensionSender({
        id: 'other-extension-id',
        tab: { id: 30, url: `${EXTENSION_BASE_URL}/management.html` }
      })).toBe(false);
    });

    it('maintains compatibility for empty test mock senders in test mode', () => {
      expect(isInternalExtensionSender({})).toBe(true);
      expect(isInternalExtensionSender(null)).toBe(true);
      expect(isInternalExtensionSender(undefined)).toBe(true);
    });
  });

  describe('isAuthorizedIncognitoSender', () => {
    it('allows extension tabs and popups', () => {
      // Popup sender (no tab)
      expect(isAuthorizedIncognitoSender({ id: EXTENSION_ID })).toBe(true);
      expect(isAuthorizedIncognitoSender({
        id: EXTENSION_ID,
        url: `${EXTENSION_BASE_URL}/popup.html`
      })).toBe(true);

      // Extension SPA tab
      expect(isAuthorizedIncognitoSender({
        id: EXTENSION_ID,
        url: `${EXTENSION_BASE_URL}/management.html`,
        tab: { id: 10, url: `${EXTENSION_BASE_URL}/management.html`, incognito: false }
      })).toBe(true);
    });

    it('allows incognito tabs (sender.tab.incognito == true)', () => {
      expect(isAuthorizedIncognitoSender({
        id: EXTENSION_ID,
        url: 'https://secret.example.com',
        tab: { id: 50, url: 'https://secret.example.com', incognito: true }
      })).toBe(true);
    });

    it('rejects non-incognito external web page tabs', () => {
      expect(isAuthorizedIncognitoSender({
        id: EXTENSION_ID,
        url: 'https://regular.com',
        tab: { id: 60, url: 'https://regular.com', incognito: false }
      })).toBe(false);
    });
  });

  describe('Runtime IPC message dispatching security', () => {
    const untrustedWebSender = {
      id: EXTENSION_ID,
      url: 'https://malicious.com',
      tab: { id: 99, url: 'https://malicious.com' }
    };

    const mismatchedExtensionSender = {
      id: 'foreign-extension-id',
      url: 'chrome-extension://foreign-extension-id/popup.html'
    };

    const trustedPopupSender = {
      id: EXTENSION_ID,
      url: `${EXTENSION_BASE_URL}/popup.html`
    };

    const trustedExtTabSender = {
      id: EXTENSION_ID,
      url: `${EXTENSION_BASE_URL}/management.html`,
      tab: { id: 1, url: `${EXTENSION_BASE_URL}/management.html` }
    };

    describe('Privileged messages from untrusted senders are rejected', () => {
      it('rejects CREATE_INCOGNITO_BOOKMARK from untrusted sender', async () => {
        const res = await sendMessage(
          {
            type: 'CREATE_INCOGNITO_BOOKMARK',
            url: 'https://exploit.example.com',
            title: 'Exploit'
          },
          untrustedWebSender
        );

        expect(res).toEqual({ ok: false, error: 'Unauthorized IPC sender' });
        expect(mockBookmarksCreate).not.toHaveBeenCalled();
        expect(mockDbBookmarksAdd).not.toHaveBeenCalled();
      });

      it('rejects GET_TAG_SUGGESTIONS from untrusted sender', async () => {
        const res = await sendMessage(
          { type: 'GET_TAG_SUGGESTIONS' },
          untrustedWebSender
        );

        expect(res).toEqual({ ok: false, error: 'Unauthorized IPC sender' });
      });

      it('rejects CHECK_DUPLICATE_BOOKMARK from untrusted sender', async () => {
        const res = await sendMessage(
          {
            type: 'CHECK_DUPLICATE_BOOKMARK',
            url: 'https://private-data.example.com'
          },
          untrustedWebSender
        );

        expect(res).toEqual({ ok: false, error: 'Unauthorized IPC sender' });
        expect(mockFindDuplicate).not.toHaveBeenCalled();
      });

      it('rejects PB_CAPTURE_VISIBLE_TAB from untrusted sender', async () => {
        const res = await sendMessage(
          { type: 'PB_CAPTURE_VISIBLE_TAB' },
          untrustedWebSender
        );

        expect(res).toEqual({ ok: false, error: 'Unauthorized IPC sender' });
        expect(mockCaptureVisibleTab).not.toHaveBeenCalled();
      });

      it('rejects TASK_INDICATOR from untrusted sender', async () => {
        const res = await sendMessage(
          { type: 'TASK_INDICATOR', taskType: 'ai', active: true },
          untrustedWebSender
        );

        expect(res).toEqual({ ok: false, error: 'Unauthorized IPC sender' });
        expect(mockSetTaskIndicator).not.toHaveBeenCalled();
      });

      it('rejects privileged messages from mismatched extension ID', async () => {
        const res = await sendMessage(
          { type: 'GET_TAG_SUGGESTIONS' },
          mismatchedExtensionSender
        );

        expect(res).toEqual({ ok: false, error: 'Unauthorized IPC sender' });
      });

      it('rejects other privileged operations (AI, Archive, Sync) from untrusted sender', async () => {
        const aiRes = await sendMessage(
          { type: 'AI_ANALYZE_BOOKMARK', bookmarkId: 1 },
          untrustedWebSender
        );
        expect(aiRes).toEqual({ ok: false, error: 'Unauthorized IPC sender' });

        const archiveRes = await sendMessage(
          { type: 'ARCHIVE_CAPTURE_BOOKMARK', bookmarkId: 1 },
          untrustedWebSender
        );
        expect(archiveRes).toEqual({ ok: false, error: 'Unauthorized IPC sender' });

        const syncRes = await sendMessage(
          { type: 'SET_SYNC_MUTED', muted: true },
          untrustedWebSender
        );
        expect(syncRes).toEqual({ ok: false, error: 'Unauthorized IPC sender' });
      });
    });

    describe('Privileged messages from trusted internal senders are allowed', () => {
      it('allows TASK_INDICATOR from trusted popup sender', async () => {
        const res = await sendMessage(
          { type: 'TASK_INDICATOR', taskType: 'ai', active: true },
          trustedPopupSender
        );

        expect(res).toEqual({ ok: true });
        expect(mockSetTaskIndicator).toHaveBeenCalledWith('ai', true);
      });

      it('allows GET_TAG_SUGGESTIONS from trusted extension tab sender', async () => {
        const res = await sendMessage(
          { type: 'GET_TAG_SUGGESTIONS' },
          trustedExtTabSender
        );

        expect(res).toEqual({ tags: ['security', 'ipc', 'vitest'] });
      });

      it('allows CHECK_DUPLICATE_BOOKMARK from trusted extension tab sender', async () => {
        const res = await sendMessage(
          { type: 'CHECK_DUPLICATE_BOOKMARK', url: 'https://clean.example.com' },
          trustedExtTabSender
        );

        expect(mockFindDuplicate).toHaveBeenCalledWith('https://clean.example.com');
        expect(res).toEqual({ duplicate: false, bookmark: null });
      });

      it('allows PB_CAPTURE_VISIBLE_TAB from trusted popup sender', async () => {
        const res = await sendMessage(
          { type: 'PB_CAPTURE_VISIBLE_TAB' },
          trustedPopupSender
        );

        expect(res).toEqual({ ok: true, dataUrl: 'data:image/png;base64,mockCaptureData' });
        expect(mockCaptureVisibleTab).toHaveBeenCalledWith({ format: 'png' });
      });

      it('allows CREATE_INCOGNITO_BOOKMARK from trusted popup sender', async () => {
        const res = await sendMessage(
          {
            type: 'CREATE_INCOGNITO_BOOKMARK',
            url: 'https://trusted-site.com',
            title: 'Trusted Bookmark'
          },
          trustedPopupSender
        );

        expect(res.ok).toBe(true);
        expect(res.bookmarkId).toBe(101);
        expect(res.browserBookmarkId).toBe('browser-node-123');
        expect(mockBookmarksCreate).toHaveBeenCalled();
      });
    });

    describe('Content script cross-origin relay handlers', () => {
      const validContentScriptSender = {
        id: EXTENSION_ID,
        tab: { id: 42, url: 'https://article.example.com/page' }
      };

      const hostileForeignSender = {
        id: 'foreign-extension-attacker',
        tab: { id: 42, url: 'https://article.example.com/page' }
      };

      it('allows FETCH_IFRAME from valid extension content script', async () => {
        const res = await sendMessage(
          { type: 'FETCH_IFRAME', url: 'https://article.example.com/subframe' },
          validContentScriptSender
        );

        expect(mockFetch).toHaveBeenCalledWith(
          'https://article.example.com/subframe',
          { credentials: 'include' }
        );
        expect(mockDecodeResponseHtml).toHaveBeenCalled();
        expect(res).toEqual({ html: '<html><body><iframe>embedded</iframe></body></html>' });
      });

      it('rejects FETCH_IFRAME from sender with mismatched extension ID', async () => {
        const res = await sendMessage(
          { type: 'FETCH_IFRAME', url: 'https://article.example.com/subframe' },
          hostileForeignSender
        );

        expect(res).toEqual({ html: '' });
      });

      it('allows FETCH_RESOURCE from valid extension content script', async () => {
        const res = await sendMessage(
          {
            type: 'FETCH_RESOURCE',
            url: 'https://article.example.com/style.css',
            pageUrl: 'https://article.example.com/page'
          },
          validContentScriptSender
        );

        expect(mockFetchResourceAsDataUri).toHaveBeenCalledWith(
          'https://article.example.com/style.css',
          'https://article.example.com/page'
        );
        expect(res).toEqual({ dataUri: 'data:text/css;base64,mockCssData' });
      });

      it('rejects FETCH_RESOURCE from sender with mismatched extension ID without fetching', async () => {
        mockFetchResourceAsDataUri.mockClear();

        const res = await sendMessage(
          {
            type: 'FETCH_RESOURCE',
            url: 'https://article.example.com/style.css',
            pageUrl: 'https://article.example.com/page'
          },
          hostileForeignSender
        );

        expect(mockFetchResourceAsDataUri).not.toHaveBeenCalled();
        expect(res).toEqual({ dataUri: 'https://article.example.com/style.css' });
      });
    });
  });
});
