import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';
import BookmarkList from '../../src/components/management/bookmarks/BookmarkList.svelte';

const { mockData, dbMock } = vi.hoisted(() => {
  const data = {
    bookmarks: [] as any[],
    archivedPages: [] as any[],
    settings: {} as Record<string, any>
  };

  const mock = {
    bookmarks: {
      toArray: vi.fn(async () => data.bookmarks),
      get: vi.fn(async (id: number) => data.bookmarks.find((b) => b.id === id)),
      update: vi.fn(async (id: number, payload: any) => {
        const idx = data.bookmarks.findIndex((b) => b.id === id);
        if (idx !== -1) {
          data.bookmarks[idx] = { ...data.bookmarks[idx], ...payload };
        }
      }),
      where: vi.fn(() => ({ equals: vi.fn(() => ({ first: async () => undefined, delete: async () => {} })) })),
      filter: vi.fn(() => ({ modify: vi.fn(async () => {}) })),
      delete: vi.fn(async () => {})
    },
    archivedPages: {
      toArray: vi.fn(async () => data.archivedPages),
      get: vi.fn(async (id: number) => data.archivedPages.find((a) => a.id === id)),
      delete: vi.fn(async () => {}),
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          first: async () => undefined,
          delete: async () => {}
        }))
      }))
    },
    settings: {
      get: vi.fn(async (key: string) =>
        data.settings[key] !== undefined ? { key, value: data.settings[key] } : undefined
      ),
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

vi.mock('../../src/lib/bookmarks/bookmark-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    BookmarkManager: {
      ...actual.BookmarkManager,
      getFolders: vi.fn(async () => [
        {
          id: 'f-dev',
          title: 'Development',
          path: 'Bookmarks bar/Development',
          depth: 1,
          displayName: 'Development'
        }
      ]),
      openBookmark: vi.fn(),
      updateBookmark: vi.fn(),
      ensureFolderPath: vi.fn()
    }
  };
});

vi.mock('../../src/lib/archive/archive-cloud', () => ({
  getCloudArchiveIndexCache: vi.fn(async () => [])
}));

vi.stubGlobal('browser', {
  i18n: {
    getMessage: vi.fn((key: string) => key)
  },
  runtime: {
    sendMessage: vi.fn(async () => ({ ok: true }))
  },
  storage: {
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {})
    }
  },
  bookmarks: {
    get: vi.fn(async () => [{ id: 'bm-1', title: 'Test' }]),
    move: vi.fn(async () => {}),
    remove: vi.fn(async () => {})
  }
});

describe('BookmarkList.svelte - Overcrowded Folder Banner Removal Regression', () => {
  let target: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
    mockData.bookmarks = [];
    mockData.archivedPages = [];
    mockData.settings = {};
    vi.clearAllMocks();
  });

  it('does not render overcrowded folder banner even when a folder contains >= 50 bookmarks', async () => {
    // 52 bookmarks in "Bookmarks bar/Development"
    mockData.bookmarks = Array.from({ length: 52 }, (_, i) => ({
      id: i + 1,
      syncId: `sync-${i}`,
      bookmarkId: `bm-${i}`,
      url: `https://dev.example.com/${i}`,
      title: `Dev Bookmark ${i}`,
      description: '',
      folderPath: 'Bookmarks bar/Development',
      createdAt: Date.now() - i * 1000,
      modifiedAt: Date.now(),
      visitCount: 0
    }));

    const component = new BookmarkList({
      target,
      props: {
        folders: [
          {
            id: 'f-dev',
            title: 'Development',
            path: 'Bookmarks bar/Development',
            depth: 1,
            displayName: 'Development'
          }
        ]
      }
    });

    await component.loadBookmarks();
    await tick();

    const banner = document.querySelector('.overcrowded-folder-banner');
    expect(banner).toBeNull();
  });

  it('does not render banner when folder contains < 50 bookmarks', async () => {
    mockData.bookmarks = Array.from({ length: 49 }, (_, i) => ({
      id: i + 1,
      syncId: `sync-${i}`,
      bookmarkId: `bm-${i}`,
      url: `https://dev.example.com/${i}`,
      title: `Dev Bookmark ${i}`,
      description: '',
      folderPath: 'Bookmarks bar/Development',
      createdAt: Date.now() - i * 1000,
      modifiedAt: Date.now(),
      visitCount: 0
    }));

    const component = new BookmarkList({
      target,
      props: {
        folders: []
      }
    });

    await component.loadBookmarks();
    await tick();

    const banner = document.querySelector('.overcrowded-folder-banner');
    expect(banner).toBeNull();
  });
});

