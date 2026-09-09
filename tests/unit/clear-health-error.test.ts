import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';
import { clearBookmarkHealth } from '../../src/lib/health/health-checker';
import { bulkScanController } from '../../src/lib/bulk-scan-controller';
import CardBadges from '../../src/components/management/bookmarks/CardBadges.svelte';
import BookmarkCard from '../../src/components/management/bookmarks/BookmarkCard.svelte';
import BookmarkRow from '../../src/components/management/bookmarks/BookmarkRow.svelte';
import BookmarkList from '../../src/components/management/bookmarks/BookmarkList.svelte';
import type { Bookmark } from '../../src/lib/db';

const { mockData, dbMock } = vi.hoisted(() => {
  const data = { bookmarks: [] as any[], archivedPages: [] as any[], settings: {} as Record<string, any> };
  const mock = {
    bookmarks: {
      toArray: vi.fn(async () => data.bookmarks),
      get: vi.fn(async (id: number) => data.bookmarks.find((b) => b.id === id)),
      update: vi.fn(async (id: number, changes: any) => {
        const item = data.bookmarks.find((b) => b.id === id);
        if (item) Object.assign(item, changes);
        return 1;
      }),
      where: vi.fn(() => ({ equals: vi.fn(() => ({ first: async () => undefined, delete: async () => {}, count: async () => 0 })) })),
      filter: vi.fn(() => ({ modify: vi.fn(async () => {}) })),
      delete: vi.fn(async () => {})
    },
    archivedPages: {
      toArray: vi.fn(async () => data.archivedPages),
      where: vi.fn(() => ({
        equals: vi.fn((val: any) => ({
          first: async () => data.archivedPages.find((a) => a.bookmarkId === val),
          delete: async () => {}
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

vi.stubGlobal('browser', {
  i18n: {
    getMessage: vi.fn((key: string) => key)
  },
  runtime: {
    sendMessage: vi.fn(async () => ({ ok: true }))
  },
  storage: {
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
  },
  bookmarks: {
    getTree: vi.fn(async () => []),
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onChanged: { addListener: vi.fn() },
    onMoved: { addListener: vi.fn() }
  },
  tabs: {
    query: vi.fn(async () => [])
  }
});

describe('Clear Bookmark Health Check Error', () => {
  let target: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
    mockData.bookmarks = [];
    mockData.archivedPages = [];
    mockData.settings = {};
    vi.clearAllMocks();
    bulkScanController.reset();
  });

  it('clearBookmarkHealth updates database with httpStatus: 200', async () => {
    mockData.bookmarks = [
      {
        id: 101,
        url: 'https://example.com/err',
        title: 'Error Link',
        httpStatus: 500,
        syncId: 'sync-101',
        bookmarkId: 'b-101',
        description: '',
        folderPath: '',
        createdAt: 1000,
        modifiedAt: 1000,
        visitCount: 0
      }
    ];

    await clearBookmarkHealth(101);

    expect(dbMock.bookmarks.update).toHaveBeenCalledWith(101, expect.objectContaining({
      httpStatus: 200
    }));
    expect(mockData.bookmarks[0].httpStatus).toBe(200);
  });

  it('bulkScanController.clearResult removes bookmark from healthResults and sessionOkIds', () => {
    bulkScanController.store.update((s) => {
      const nextResults = new Map(s.healthResults);
      nextResults.set(101, { bookmarkId: 101, url: 'https://example.com/err', status: 'error', httpStatus: 500 });
      const nextOk = new Set(s.sessionOkIds);
      nextOk.add(101);
      return {
        ...s,
        healthResults: nextResults,
        sessionOkIds: nextOk
      };
    });

    bulkScanController.clearResult(101);

    let state: any;
    const unsub = bulkScanController.store.subscribe((s) => { state = s; });
    unsub();

    expect(state.healthResults.has(101)).toBe(false);
    expect(state.sessionOkIds.has(101)).toBe(false);
  });

  it('CardBadges renders dismiss button for broken bookmark and dispatches clearHealthError on click', async () => {
    const bookmark: Bookmark = {
      id: 102,
      url: 'https://example.com/dead',
      title: 'Dead Link',
      httpStatus: 404,
      syncId: 'sync-102',
      bookmarkId: 'b-102',
      description: '',
      folderPath: '',
      createdAt: 1000,
      modifiedAt: 1000,
      visitCount: 0
    };

    const comp = new CardBadges({
      target,
      props: {
        section: 'body',
        bookmark
      }
    });

    let clearDispatched = false;
    comp.$on('clearHealthError', () => {
      clearDispatched = true;
    });

    await tick();

    const badge = target.querySelector('.connection-error-badge');
    expect(badge).toBeTruthy();

    const dismissBtn = target.querySelector('.error-dismiss-btn') as HTMLButtonElement;
    expect(dismissBtn).toBeTruthy();

    dismissBtn.click();
    await tick();

    expect(clearDispatched).toBe(true);
  });

  it('BookmarkCard forwards clearHealthError when dismiss button is clicked', async () => {
    const bookmark: Bookmark = {
      id: 103,
      url: 'https://example.com/500',
      title: '500 Server Error',
      httpStatus: 500,
      syncId: 'sync-103',
      bookmarkId: 'b-103',
      description: '',
      folderPath: '',
      createdAt: 1000,
      modifiedAt: 1000,
      visitCount: 0
    };

    const comp = new BookmarkCard({
      target,
      props: {
        bookmark
      }
    });

    let receivedBookmark: Bookmark | null = null;
    comp.$on('clearHealthError', (e: any) => {
      receivedBookmark = e.detail.bookmark;
    });

    await tick();

    const dismissBtn = target.querySelector('.error-dismiss-btn') as HTMLButtonElement;
    expect(dismissBtn).toBeTruthy();

    dismissBtn.click();
    await tick();

    expect(receivedBookmark).toEqual(bookmark);
  });

  it('BookmarkRow renders dismiss button and dispatches clearHealthError on click', async () => {
    const bookmark: Bookmark = {
      id: 104,
      url: 'https://example.com/403',
      title: '403 Forbidden',
      httpStatus: 403,
      syncId: 'sync-104',
      bookmarkId: 'b-104',
      description: '',
      folderPath: '',
      createdAt: 1000,
      modifiedAt: 1000,
      visitCount: 0
    };

    const comp = new BookmarkRow({
      target,
      props: {
        bookmark
      }
    });

    let receivedBookmark: Bookmark | null = null;
    comp.$on('clearHealthError', (e: any) => {
      receivedBookmark = e.detail.bookmark;
    });

    await tick();

    const dismissBtn = target.querySelector('.row-error-dismiss-btn') as HTMLButtonElement;
    expect(dismissBtn).toBeTruthy();

    dismissBtn.click();
    await tick();

    expect(receivedBookmark).toEqual(bookmark);
  });

  it('BookmarkList clears error status in database and removes badge upon dismiss click', async () => {
    const testBookmark: Bookmark = {
      id: 105,
      url: 'https://example.com/false-positive',
      title: 'False Positive Error',
      httpStatus: 503,
      syncId: 'sync-105',
      bookmarkId: 'b-105',
      description: 'Test bookmark',
      folderPath: 'Bookmarks Bar',
      createdAt: 1000,
      modifiedAt: 1000,
      visitCount: 0
    };
    mockData.bookmarks = [testBookmark];

    const comp: any = new BookmarkList({
      target,
      props: {
        folders: []
      }
    });

    await comp.loadBookmarks();
    await tick();

    // Verify error badge is visible
    expect(target.querySelector('.connection-error-badge')).toBeTruthy();

    // Click the X dismiss button on the error badge
    const dismissBtn = target.querySelector('.error-dismiss-btn') as HTMLButtonElement;
    expect(dismissBtn).toBeTruthy();
    dismissBtn.click();

    await tick();

    // Verify DB update
    expect(dbMock.bookmarks.update).toHaveBeenCalledWith(105, expect.objectContaining({
      httpStatus: 200
    }));

    // Verify error badge is no longer in DOM
    await tick();
    expect(target.querySelector('.connection-error-badge')).toBeFalsy();
  });
});
