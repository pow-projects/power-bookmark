import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BookmarkManager } from '../../src/lib/bookmarks/bookmark-manager';
import db from '../../src/lib/db';

describe('Popup Active Tab and Folder Matching Logic', () => {
  function isExtensionUrl(tabUrl?: string): boolean {
    if (!tabUrl) return false;
    return (
      tabUrl.startsWith('chrome-extension://') ||
      tabUrl.startsWith('moz-extension://') ||
      tabUrl.startsWith('extension://')
    );
  }

  async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
    const queries: chrome.tabs.QueryInfo[] = [
      { active: true, currentWindow: true },
      { active: true, lastFocusedWindow: true },
      { active: true }
    ];

    for (const query of queries) {
      try {
        const tabs = await browser.tabs.query(query);
        if (tabs && tabs.length > 0) {
          const webTab = tabs.find(t => t.url && !isExtensionUrl(t.url));
          if (webTab) {
            return webTab;
          }
          if (tabs[0] && !isExtensionUrl(tabs[0].url)) {
            return tabs[0];
          }
        }
      } catch (e) {
        console.warn('tabs.query failed for query:', query, e);
      }
    }

    try {
      const allTabs = await browser.tabs.query({});
      const fallbackTab = allTabs.find(t => t.active && t.url && !isExtensionUrl(t.url))
        || allTabs.find(t => t.url && !isExtensionUrl(t.url))
        || (allTabs[0] && !isExtensionUrl(allTabs[0].url) ? allTabs[0] : null);
      if (fallbackTab) return fallbackTab;
    } catch (e) {
      console.warn('Fallback tabs.query failed:', e);
    }

    return null;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should find web tab from currentWindow when available', async () => {
    const mockQuery = vi.fn().mockImplementation((q: any) => {
      if (q.currentWindow) {
        return Promise.resolve([
          { id: 10, url: 'https://example.com/test', title: 'Example Title', active: true }
        ]);
      }
      return Promise.resolve([]);
    });

    vi.stubGlobal('browser', {
      tabs: {
        query: mockQuery
      }
    });

    const tab = await getActiveTab();
    expect(tab).not.toBeNull();
    expect(tab?.url).toBe('https://example.com/test');
    expect(tab?.title).toBe('Example Title');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('should fallback to lastFocusedWindow when currentWindow has extension popup URL', async () => {
    const mockQuery = vi.fn().mockImplementation((q: any) => {
      if (q.currentWindow) {
        return Promise.resolve([
          { id: 1, url: 'chrome-extension://abcdefg/popup.html', title: 'PowerBookmark Popup', active: true }
        ]);
      }
      if (q.lastFocusedWindow) {
        return Promise.resolve([
          { id: 2, url: 'https://developer.mozilla.org/ko/', title: 'MDN Web Docs', active: true }
        ]);
      }
      return Promise.resolve([]);
    });

    vi.stubGlobal('browser', {
      tabs: {
        query: mockQuery
      }
    });

    const tab = await getActiveTab();
    expect(tab).not.toBeNull();
    expect(tab?.url).toBe('https://developer.mozilla.org/ko/');
    expect(tab?.title).toBe('MDN Web Docs');
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('should fallback to active: true when currentWindow and lastFocusedWindow fail', async () => {
    const mockQuery = vi.fn().mockImplementation((q: any) => {
      if (q.currentWindow) return Promise.resolve([]);
      if (q.lastFocusedWindow) return Promise.resolve([]);
      if (q.active && !q.currentWindow && !q.lastFocusedWindow) {
        return Promise.resolve([
          { id: 3, url: 'https://github.com/trending', title: 'Trending Repositories', active: true }
        ]);
      }
      return Promise.resolve([]);
    });

    vi.stubGlobal('browser', {
      tabs: {
        query: mockQuery
      }
    });

    const tab = await getActiveTab();
    expect(tab).not.toBeNull();
    expect(tab?.url).toBe('https://github.com/trending');
    expect(tab?.title).toBe('Trending Repositories');
  });

  it('should match folderId from duplicate.folderPath if browser.bookmarks.get fails', () => {
    const folders = [
      { id: '1', title: 'Bookmarks bar', path: 'Bookmarks bar' },
      { id: '2', title: 'Tech', path: 'Bookmarks bar/Tech' },
      { id: '3', title: 'Frontend', path: 'Bookmarks bar/Tech/Frontend' }
    ];

    const duplicate = {
      id: 101,
      bookmarkId: '999',
      title: 'Svelte Docs',
      url: 'https://svelte.dev',
      folderPath: 'Bookmarks bar/Tech/Frontend'
    };

    let folderId = '';
    if ((!folderId || !folders.some(f => f.id === folderId)) && duplicate.folderPath && folders.length > 0) {
      const targetPath = duplicate.folderPath.trim();
      const lastSegment = targetPath.split('/').filter(Boolean).pop() || '';
      const matched = folders.find(f => f.path === targetPath)
        || folders.find(f => f.path.toLowerCase() === targetPath.toLowerCase())
        || (lastSegment ? folders.find(f => f.title === lastSegment || f.title.toLowerCase() === lastSegment.toLowerCase()) : undefined);
      if (matched) {
        folderId = matched.id;
      }
    }

    expect(folderId).toBe('3');
  });

  it('should match folderId by last segment when full path does not match exactly', () => {
    const folders = [
      { id: '1', title: 'Bookmarks bar', path: 'Bookmarks bar' },
      { id: '10', title: 'News', path: 'Bookmarks bar/News' }
    ];

    const duplicate = {
      id: 102,
      bookmarkId: '888',
      title: 'BBC',
      url: 'https://bbc.com',
      folderPath: 'Other bookmarks/News'
    };

    let folderId = '';
    if ((!folderId || !folders.some(f => f.id === folderId)) && duplicate.folderPath && folders.length > 0) {
      const targetPath = duplicate.folderPath.trim();
      const lastSegment = targetPath.split('/').filter(Boolean).pop() || '';
      const matched = folders.find(f => f.path === targetPath)
        || folders.find(f => f.path.toLowerCase() === targetPath.toLowerCase())
        || (lastSegment ? folders.find(f => f.title === lastSegment || f.title.toLowerCase() === lastSegment.toLowerCase()) : undefined);
      if (matched) {
        folderId = matched.id;
      }
    }

    expect(folderId).toBe('10');
  });

  it('should select lastFolderId or folders[0].id for new bookmarks', () => {
    const folders = [
      { id: '1', title: 'Bookmarks bar', path: 'Bookmarks bar' },
      { id: '2', title: 'Tech', path: 'Bookmarks bar/Tech' }
    ];

    // Case 1: lastFolderId matches
    const lastFolderSetting = { value: '2' };
    let folderId = '';
    const lastFolderId = lastFolderSetting?.value;
    if (lastFolderId && folders.some(f => f.id === lastFolderId)) {
      folderId = lastFolderId;
    } else if (folders.length > 0) {
      folderId = folders[0].id;
    }
    expect(folderId).toBe('2');

    // Case 2: lastFolderId does not match -> falls back to folders[0].id
    const invalidLastFolder = { value: '999' };
    folderId = '';
    if (invalidLastFolder?.value && folders.some(f => f.id === invalidLastFolder.value)) {
      folderId = invalidLastFolder.value;
    } else if (folders.length > 0) {
      folderId = folders[0].id;
    }
    expect(folderId).toBe('1');
  });
});
