import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  updateActionBadge,
  normalizeUrl,
  setSyncingIndicator,
  setTaskIndicator,
  startTaskIndicator,
  endTaskIndicator,
  getActiveTaskCounts,
  isSpinnerRunning,
  _resetTaskIndicatorsForTest,
  BOOKMARK_BADGE_TEXT,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  COLOR_PRIMARY,
  COLOR_AI
} from '../../src/lib/bookmarks/badge-manager';

const { mockSetBadgeText, mockSetBadgeBackgroundColor, mockSetTitle, mockSetIcon, mockTabsGet, mockTabsQuery, stores } = vi.hoisted(() => {
  const stores = {
    bookmarks: [] as any[]
  };
  return {
    mockSetBadgeText: vi.fn().mockResolvedValue(undefined),
    mockSetBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
    mockSetTitle: vi.fn().mockResolvedValue(undefined),
    mockSetIcon: vi.fn().mockResolvedValue(undefined),
    mockTabsGet: vi.fn(),
    mockTabsQuery: vi.fn().mockResolvedValue([]),
    stores
  };
});

function setupBrowserMock() {
  vi.stubGlobal('browser', {
    action: {
      setBadgeText: mockSetBadgeText,
      setBadgeBackgroundColor: mockSetBadgeBackgroundColor,
      setTitle: mockSetTitle,
      setIcon: mockSetIcon
    },
    tabs: {
      get: mockTabsGet,
      query: mockTabsQuery
    }
  });
}

setupBrowserMock();

vi.mock('../../src/lib/db', () => {
  const mockDb = {
    bookmarks: {
      toArray: async () => stores.bookmarks,
      where: (idx: string) => ({
        equals: (val: any) => ({
          first: async () => stores.bookmarks.find((b: any) => b[idx] === val),
          toArray: async () => stores.bookmarks.filter((b: any) => b[idx] === val)
        }),
        startsWith: (prefix: string) => ({
          toArray: async () => stores.bookmarks.filter((b: any) => typeof b[idx] === 'string' && b[idx].startsWith(prefix))
        })
      })
    }
  };
  return { db: mockDb, default: mockDb };
});

describe('badge-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupBrowserMock();
    _resetTaskIndicatorsForTest();
    stores.bookmarks = [];
    mockTabsQuery.mockResolvedValue([]);
  });

  afterEach(() => {
    _resetTaskIndicatorsForTest();
    vi.useRealTimers();
  });

  describe('normalizeUrl', () => {
    it('returns empty string for falsy/empty URL', () => {
      expect(normalizeUrl('')).toBe('');
    });

    it('handles trailing slashes correctly (removes subpath slash, retains root slash)', () => {
      expect(normalizeUrl('https://example.com/path/')).toBe('https://example.com/path');
      expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
    });

    it('sorts query parameters alphabetically and sorts multi-value parameters', () => {
      expect(normalizeUrl('https://example.com/path?b=2&a=1')).toBe('https://example.com/path?a=1&b=2');
      expect(normalizeUrl('https://example.com/path?a=2&a=1&b=3')).toBe('https://example.com/path?a=1&a=2&b=3');
    });

    it('converts host to lowercase while preserving pathname case', () => {
      expect(normalizeUrl('https://EXAMPLE.COM/PageName')).toBe('https://example.com/PageName');
    });

    it('removes default ports for HTTP (80) and HTTPS (443)', () => {
      expect(normalizeUrl('http://example.com:80/page')).toBe('http://example.com/page');
      expect(normalizeUrl('https://example.com:443/page')).toBe('https://example.com/page');
      expect(normalizeUrl('http://example.com:8080/page')).toBe('http://example.com:8080/page');
    });

    it('preserves hash in URL', () => {
      expect(normalizeUrl('https://example.com/page#section1')).toBe('https://example.com/page#section1');
    });

    it('handles invalid URL string with fallback logic', () => {
      expect(normalizeUrl('not-a-valid-url/')).toBe('not-a-valid-url');
      expect(normalizeUrl('INVALID_URL/PATH/')).toBe('invalid_url/path');
    });
  });

  describe('updateActionBadge', () => {
    it('returns early when tabId is invalid or zero', async () => {
      await updateActionBadge(0);
      expect(mockSetBadgeText).not.toHaveBeenCalled();
    });

    it('updates badge with bookmarked title and active icon without duplicate text badge when URL is bookmarked', async () => {
      stores.bookmarks = [{ url: 'https://example.com/page' }];

      await updateActionBadge(1, 'https://example.com/page');

      expect(mockSetBadgeText).toHaveBeenCalledWith({ tabId: 1, text: '' });
      expect(mockSetTitle).toHaveBeenCalledWith({ tabId: 1, title: 'PowerBookmark (이미 저장된 북마크)' });
      expect(mockSetIcon).toHaveBeenCalledWith({
        tabId: 1,
        path: {
          '16': 'icons/icon-active-16.png',
          '32': 'icons/icon-active-32.png',
          '48': 'icons/icon-active-48.png',
          '128': 'icons/icon-active-128.png',
        },
      });
    });

    it('clears badge text, sets default title, and sets default icon when URL is not bookmarked', async () => {
      stores.bookmarks = [{ url: 'https://example.com/page' }];

      await updateActionBadge(1, 'https://other.com/page');

      expect(mockSetBadgeText).toHaveBeenCalledWith({ tabId: 1, text: '' });
      expect(mockSetTitle).toHaveBeenCalledWith({ tabId: 1, title: 'PowerBookmark' });
      expect(mockSetIcon).toHaveBeenCalledWith({
        tabId: 1,
        path: {
          '16': 'icons/icon-16.png',
          '32': 'icons/icon-32.png',
          '48': 'icons/icon-48.png',
          '128': 'icons/icon-128.png',
        },
      });
    });

    it('falls back to browser.browserAction when browser.action is undefined (Firefox compatibility)', async () => {
      const mockBrowserActionSetBadgeText = vi.fn().mockResolvedValue(undefined);
      const mockBrowserActionSetTitle = vi.fn().mockResolvedValue(undefined);
      const mockBrowserActionSetIcon = vi.fn().mockResolvedValue(undefined);

      vi.stubGlobal('browser', {
        browserAction: {
          setBadgeText: mockBrowserActionSetBadgeText,
          setTitle: mockBrowserActionSetTitle,
          setIcon: mockBrowserActionSetIcon,
        },
        tabs: {
          get: mockTabsGet,
          query: mockTabsQuery,
        },
      });

      await updateActionBadge(1, 'https://example.com/page');

      expect(mockBrowserActionSetBadgeText).toHaveBeenCalledWith({ tabId: 1, text: '' });
      expect(mockBrowserActionSetTitle).toHaveBeenCalledWith({ tabId: 1, title: 'PowerBookmark' });
      expect(mockBrowserActionSetIcon).toHaveBeenCalledWith({
        tabId: 1,
        path: {
          '16': 'icons/icon-16.png',
          '32': 'icons/icon-32.png',
          '48': 'icons/icon-48.png',
          '128': 'icons/icon-128.png',
        },
      });
    });

    it('returns cleanly without throwing when neither action nor browserAction is available', async () => {
      vi.stubGlobal('browser', {
        tabs: {
          get: mockTabsGet,
          query: mockTabsQuery,
        },
      });

      await expect(updateActionBadge(1, 'https://example.com/page')).resolves.toBeUndefined();
    });

    it('handles trailing slash URL matching when bookmarked', async () => {
      stores.bookmarks = [{ url: 'https://example.com/page/' }];

      await updateActionBadge(1, 'https://example.com/page');

      expect(mockSetBadgeText).toHaveBeenCalledWith({ tabId: 1, text: '' });
      expect(mockSetTitle).toHaveBeenCalledWith({ tabId: 1, title: 'PowerBookmark (이미 저장된 북마크)' });
      expect(mockSetIcon).toHaveBeenCalledWith({
        tabId: 1,
        path: {
          '16': 'icons/icon-active-16.png',
          '32': 'icons/icon-active-32.png',
          '48': 'icons/icon-active-48.png',
          '128': 'icons/icon-active-128.png',
        },
      });

      stores.bookmarks = [{ url: 'https://example.com/page' }];

      await updateActionBadge(2, 'https://example.com/page/');

      expect(mockSetBadgeText).toHaveBeenCalledWith({ tabId: 2, text: '' });
      expect(mockSetIcon).toHaveBeenCalledWith({
        tabId: 2,
        path: {
          '16': 'icons/icon-active-16.png',
          '32': 'icons/icon-active-32.png',
          '48': 'icons/icon-active-48.png',
          '128': 'icons/icon-active-128.png',
        },
      });
    });

    it('fetches tab URL when url parameter is missing', async () => {
      stores.bookmarks = [{ url: 'https://example.com' }];
      mockTabsGet.mockResolvedValue({ id: 2, url: 'https://example.com' });

      await updateActionBadge(2);

      expect(mockTabsGet).toHaveBeenCalledWith(2);
      expect(mockSetBadgeText).toHaveBeenCalledWith({ tabId: 2, text: '' });
      expect(mockSetIcon).toHaveBeenCalledWith({
        tabId: 2,
        path: {
          '16': 'icons/icon-active-16.png',
          '32': 'icons/icon-active-32.png',
          '48': 'icons/icon-active-48.png',
          '128': 'icons/icon-active-128.png',
        },
      });
    });

    it('returns early when tab cannot be fetched', async () => {
      mockTabsGet.mockRejectedValue(new Error('Tab not found'));

      await updateActionBadge(2);

      expect(mockTabsGet).toHaveBeenCalledWith(2);
      expect(mockSetBadgeText).not.toHaveBeenCalled();
    });

    it('clears badge for chrome:// internal URLs', async () => {
      await updateActionBadge(3, 'chrome://extensions');

      expect(mockSetBadgeText).toHaveBeenCalledWith({ tabId: 3, text: '' });
      expect(mockSetTitle).toHaveBeenCalledWith({ tabId: 3, title: 'PowerBookmark' });
      expect(mockSetIcon).toHaveBeenCalledWith({
        tabId: 3,
        path: {
          '16': 'icons/icon-16.png',
          '32': 'icons/icon-32.png',
          '48': 'icons/icon-48.png',
          '128': 'icons/icon-128.png',
        },
      });
    });

    it('clears badge for chrome-extension:// and about: internal URLs', async () => {
      await updateActionBadge(4, 'chrome-extension://abcdef/popup.html');

      expect(mockSetBadgeText).toHaveBeenCalledWith({ tabId: 4, text: '' });

      await updateActionBadge(5, 'about:blank');

      expect(mockSetBadgeText).toHaveBeenCalledWith({ tabId: 5, text: '' });
    });

    it('handles setIcon exception gracefully without throwing', async () => {
      mockSetIcon.mockRejectedValue(new Error('setIcon error'));
      stores.bookmarks = [{ url: 'https://example.com' }];

      await expect(updateActionBadge(1, 'https://example.com')).resolves.not.toThrow();
      expect(mockSetBadgeText).toHaveBeenCalledWith({ tabId: 1, text: '' });
    });

    it('sets spinner frame icon and task title instead of bookmark badge when total active tasks > 0', async () => {
      stores.bookmarks = [{ url: 'https://example.com' }];
      await startTaskIndicator('archive');

      mockSetBadgeText.mockClear();
      mockSetTitle.mockClear();
      mockSetIcon.mockClear();

      await updateActionBadge(1, 'https://example.com');

      // Since an archive task is running, updateActionBadge should clear badge text and set spinner icon + task title
      expect(mockSetBadgeText).toHaveBeenCalledWith({ tabId: 1, text: '' });
      expect(mockSetTitle).toHaveBeenCalledWith({ tabId: 1, title: 'PowerBookmark (아카이브 저장 중...)' });
      expect(mockSetIcon).toHaveBeenCalledWith({ tabId: 1, path: SPINNER_FRAMES[0] });
    });
  });

  describe('Task Indicator (setTaskIndicator / startTaskIndicator / endTaskIndicator)', () => {
    it('starts spinner animation and sets appropriate title/icon for archive task', async () => {
      await setTaskIndicator('archive', true);

      expect(getActiveTaskCounts().archive).toBe(1);
      expect(isSpinnerRunning()).toBe(true);
      expect(mockSetBadgeText).toHaveBeenCalledWith({ text: '' });
      expect(mockSetTitle).toHaveBeenCalledWith({ title: 'PowerBookmark (아카이브 저장 중...)' });
      expect(mockSetIcon).toHaveBeenCalledWith({ path: SPINNER_FRAMES[0] });
    });

    it('sets AI title for ai task', async () => {
      await setTaskIndicator('ai', true);

      expect(getActiveTaskCounts().ai).toBe(1);
      expect(isSpinnerRunning()).toBe(true);
      expect(mockSetTitle).toHaveBeenCalledWith({ title: 'PowerBookmark (AI 분석 중...)' });
      expect(mockSetIcon).toHaveBeenCalledWith({ path: SPINNER_FRAMES[0] });
    });

    it('sets sync title for sync task', async () => {
      await setTaskIndicator('sync', true);

      expect(getActiveTaskCounts().sync).toBe(1);
      expect(isSpinnerRunning()).toBe(true);
      expect(mockSetTitle).toHaveBeenCalledWith({ title: 'PowerBookmark (동기화 중...)' });
      expect(mockSetIcon).toHaveBeenCalledWith({ path: SPINNER_FRAMES[0] });
    });

    it('sets capture title for capture task', async () => {
      await setTaskIndicator('capture', true);

      expect(getActiveTaskCounts().capture).toBe(1);
      expect(isSpinnerRunning()).toBe(true);
      expect(mockSetTitle).toHaveBeenCalledWith({ title: 'PowerBookmark (타임라인 캡처 중...)' });
      expect(mockSetIcon).toHaveBeenCalledWith({ path: SPINNER_FRAMES[0] });
    });

    it('sets generic title when multiple task types are running concurrently', async () => {
      await startTaskIndicator('archive');
      await startTaskIndicator('ai');

      expect(mockSetTitle).toHaveBeenLastCalledWith({ title: 'PowerBookmark (작업 처리 중...)' });
    });

    it('cycles through spinner frames over time', async () => {
      vi.useFakeTimers();

      await setTaskIndicator('archive', true);
      expect(mockSetIcon).toHaveBeenCalledWith({ path: SPINNER_FRAMES[0] });

      await vi.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS);
      expect(mockSetIcon).toHaveBeenCalledWith({ path: SPINNER_FRAMES[1] });

      await vi.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS);
      expect(mockSetIcon).toHaveBeenCalledWith({ path: SPINNER_FRAMES[2] });

      await vi.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS);
      expect(mockSetIcon).toHaveBeenCalledWith({ path: SPINNER_FRAMES[3] });

      await vi.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS);
      expect(mockSetIcon).toHaveBeenCalledWith({ path: SPINNER_FRAMES[4] });
    });

    it('manages task reference counts safely and stops spinner only when all counts reach zero', async () => {
      stores.bookmarks = [{ url: 'https://example.com' }];
      mockTabsQuery.mockResolvedValue([
        { id: 1, url: 'https://example.com' },
        { id: 2, url: 'https://other.com' }
      ]);

      await startTaskIndicator('archive');
      await startTaskIndicator('archive');
      expect(getActiveTaskCounts().archive).toBe(2);
      expect(isSpinnerRunning()).toBe(true);

      // On 1st termination, count is still 1 so keep spinner running
      await endTaskIndicator('archive');
      expect(getActiveTaskCounts().archive).toBe(1);
      expect(isSpinnerRunning()).toBe(true);

      // On 2nd termination, count becomes 0 so stop spinner and restore tab badge
      await endTaskIndicator('archive');
      expect(getActiveTaskCounts().archive).toBe(0);
      expect(isSpinnerRunning()).toBe(false);

      expect(mockSetBadgeText).toHaveBeenCalledWith({ text: '' });
      expect(mockSetTitle).toHaveBeenCalledWith({ title: 'PowerBookmark' });
      expect(mockTabsQuery).toHaveBeenCalledWith({});
      expect(mockSetIcon).toHaveBeenCalledWith({
        tabId: 1,
        path: {
          '16': 'icons/icon-active-16.png',
          '32': 'icons/icon-active-32.png',
          '48': 'icons/icon-active-48.png',
          '128': 'icons/icon-active-128.png',
        },
      });
      expect(mockSetIcon).toHaveBeenCalledWith({
        tabId: 2,
        path: {
          '16': 'icons/icon-16.png',
          '32': 'icons/icon-32.png',
          '48': 'icons/icon-48.png',
          '128': 'icons/icon-128.png',
        },
      });
    });

    it('does not decrement count below zero', async () => {
      await endTaskIndicator('ai');
      expect(getActiveTaskCounts().ai).toBe(0);
      expect(isSpinnerRunning()).toBe(false);
    });

    it('is a no-op when browser.action is missing', async () => {
      vi.stubGlobal('browser', { tabs: { query: mockTabsQuery } });

      await expect(setTaskIndicator('archive', true)).resolves.toBeUndefined();
      await expect(setTaskIndicator('archive', false)).resolves.toBeUndefined();
    });
  });

  describe('setSyncingIndicator compatibility', () => {
    it('acts as setTaskIndicator("sync", true) when syncing=true', async () => {
      await setSyncingIndicator(true);

      expect(getActiveTaskCounts().sync).toBe(1);
      expect(mockSetBadgeText).toHaveBeenCalledWith({ text: '' });
      expect(mockSetTitle).toHaveBeenCalledWith({ title: 'PowerBookmark (동기화 중...)' });
      expect(mockSetIcon).toHaveBeenCalledWith({ path: SPINNER_FRAMES[0] });
    });

    it('restores badge per active tab via updateActionBadge when syncing=false', async () => {
      stores.bookmarks = [{ url: 'https://example.com' }];
      mockTabsQuery.mockResolvedValue([
        { id: 1, url: 'https://example.com' },
        { id: 2, url: 'https://example.com' }
      ]);

      await setSyncingIndicator(true);
      await setSyncingIndicator(false);

      expect(getActiveTaskCounts().sync).toBe(0);
      expect(mockTabsQuery).toHaveBeenCalledWith({});
      expect(mockSetIcon).toHaveBeenCalledWith({
        tabId: 1,
        path: {
          '16': 'icons/icon-active-16.png',
          '32': 'icons/icon-active-32.png',
          '48': 'icons/icon-active-48.png',
          '128': 'icons/icon-active-128.png',
        },
      });
      expect(mockSetIcon).toHaveBeenCalledWith({
        tabId: 2,
        path: {
          '16': 'icons/icon-active-16.png',
          '32': 'icons/icon-active-32.png',
          '48': 'icons/icon-active-48.png',
          '128': 'icons/icon-active-128.png',
        },
      });
    });

    it('resolves without exception when tabs.query returns an empty array', async () => {
      mockTabsQuery.mockResolvedValue([]);

      await setSyncingIndicator(true);
      await expect(setSyncingIndicator(false)).resolves.toBeUndefined();
      expect(mockSetBadgeText).toHaveBeenCalledWith({ text: '' });
      expect(mockSetTitle).toHaveBeenCalledWith({ title: 'PowerBookmark' });
    });
  });
});
