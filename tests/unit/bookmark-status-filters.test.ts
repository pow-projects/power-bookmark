import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';
import BookmarkFilterBar from '../../src/components/management/bookmarks/BookmarkFilterBar.svelte';
import { bulkScanController } from '../../src/lib/bulk-scan-controller';

const { mockData, dbMock } = vi.hoisted(() => {
  const data = { bookmarks: [] as any[], archivedPages: [] as any[], settings: {} as Record<string, any> };
  const mock = {
    bookmarks: {
      toArray: vi.fn(async () => data.bookmarks),
      get: vi.fn(async (id: number) => data.bookmarks.find((b) => b.id === id)),
      update: vi.fn(async () => {}),
      where: vi.fn(() => ({ equals: vi.fn(() => ({ first: async () => undefined, delete: async () => {} })) })),
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

import BookmarkList from '../../src/components/management/bookmarks/BookmarkList.svelte';

describe('Bookmark Status & Category Filters', () => {
  let target: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
    mockData.bookmarks = [];
    mockData.archivedPages = [];
    mockData.settings = {};
    bulkScanController.reset();
  });

  describe('BookmarkFilterBar component', () => {
    it('should render all filter options in the status select', async () => {
      new BookmarkFilterBar({
        target,
        props: {
          searchQuery: '',
          selectedFilter: 'all',
          selectedTag: 'all',
          availableTags: ['dev'],
          viewMode: 'grid'
        }
      });

      await tick();

      const selects = document.querySelectorAll('select');
      const statusSelect = selects[0];
      expect(statusSelect).toBeTruthy();

      const options = Array.from(statusSelect.querySelectorAll('option'));
      const values = options.map((opt) => opt.value);
      expect(values).toEqual(['all', 'uncategorized', 'no-desc', 'no-tags', 'broken', 'dead']);
    });

    it('should show clear button when selectedFilter is not all and reset it on click', async () => {
      let selectedFilter: any = 'no-desc';
      const comp = new BookmarkFilterBar({
        target,
        props: {
          searchQuery: '',
          selectedFilter,
          selectedTag: 'all',
          availableTags: [],
          viewMode: 'grid'
        }
      });

      let clearDispatched = false;
      comp.$on('clearFilters', () => {
        clearDispatched = true;
      });

      await tick();

      const clearBtn = document.querySelector('.btn-clear') as HTMLButtonElement;
      expect(clearBtn).toBeTruthy();

      clearBtn.click();
      await tick();

      expect(clearDispatched).toBe(true);
    });

    it('should show clear button for broken and dead filters', async () => {
      new BookmarkFilterBar({
        target,
        props: {
          searchQuery: '',
          selectedFilter: 'broken',
          selectedTag: 'all',
          availableTags: [],
          viewMode: 'grid'
        }
      });

      await tick();
      expect(document.querySelector('.btn-clear')).toBeTruthy();

      document.body.innerHTML = '';
      new BookmarkFilterBar({
        target,
        props: {
          searchQuery: '',
          selectedFilter: 'dead',
          selectedTag: 'all',
          availableTags: [],
          viewMode: 'grid'
        }
      });

      await tick();
      expect(document.querySelector('.btn-clear')).toBeTruthy();
    });
  });

  describe('BookmarkList component with status filters', () => {
    const testBookmarks = [
      {
        id: 1,
        syncId: 'sync-1',
        bookmarkId: 'b1',
        title: '완전한 북마크',
        url: 'https://example.com/complete',
        description: '설명이 있습니다',
        folderPath: 'Bookmarks Bar/개발',
        tags: ['tech', 'svelte'],
        createdAt: 1000,
        modifiedAt: 1000,
        visitCount: 0,
        httpStatus: 200
      },
      {
        id: 2,
        syncId: 'sync-2',
        bookmarkId: 'b2',
        title: '설명 없는 북마크',
        url: 'https://example.com/no-desc',
        description: '',
        folderPath: 'Bookmarks Bar/개발',
        tags: ['tech'],
        createdAt: 2000,
        modifiedAt: 2000,
        visitCount: 0,
        httpStatus: 200
      },
      {
        id: 3,
        syncId: 'sync-3',
        bookmarkId: 'b3',
        title: '태그 없는 북마크',
        url: 'https://example.com/no-tags',
        description: '설명은 있음',
        folderPath: 'Bookmarks Bar/기획',
        tags: [],
        createdAt: 3000,
        modifiedAt: 3000,
        visitCount: 0,
        httpStatus: 500
      },
      {
        id: 4,
        syncId: 'sync-4',
        bookmarkId: 'b4',
        title: '미분류 기본폴더 북마크',
        url: 'https://example.com/uncategorized',
        description: '설명 있음',
        folderPath: 'Bookmarks Bar',
        tags: ['misc'],
        createdAt: 4000,
        modifiedAt: 4000,
        visitCount: 0,
        httpStatus: 404
      },
      {
        id: 5,
        syncId: 'sync-5',
        bookmarkId: 'b5',
        title: '완전 미정리 북마크',
        url: 'https://example.com/all-empty',
        description: '',
        folderPath: '',
        tags: [],
        createdAt: 5000,
        modifiedAt: 5000,
        visitCount: 0
      },
      {
        id: 6,
        syncId: 'sync-6',
        bookmarkId: 'b6',
        title: '서버 에러 북마크',
        url: 'https://example.com/503-error',
        description: '503 에러',
        folderPath: 'Bookmarks Bar/개발',
        tags: ['backend'],
        createdAt: 6000,
        modifiedAt: 6000,
        visitCount: 0,
        httpStatus: 503
      }
    ];

    it('should filter bookmarks with no description (no-desc)', async () => {
      mockData.bookmarks = [...testBookmarks];
      const comp: any = new BookmarkList({
        target,
        props: {
          folders: []
        }
      });

      await comp.loadBookmarks();
      await tick();

      // Verify all 6 rendered
      expect(document.querySelectorAll('.bookmark-card').length).toBe(6);

      // Select 'No description' filter
      const selects = document.querySelectorAll('select');
      const statusSelect = selects[0];
      statusSelect.value = 'no-desc';
      statusSelect.dispatchEvent(new Event('change'));
      await tick();

      const cards = document.querySelectorAll('.bookmark-card');
      expect(cards.length).toBe(2); // id: 2, 5
      const titles = Array.from(cards).map((c) => c.querySelector('.bookmark-title')?.textContent?.trim());
      expect(titles).toContain('설명 없는 북마크');
      expect(titles).toContain('완전 미정리 북마크');
    });

    it('should filter bookmarks with no tags (no-tags)', async () => {
      mockData.bookmarks = [...testBookmarks];
      const comp: any = new BookmarkList({
        target,
        props: {
          folders: []
        }
      });

      await comp.loadBookmarks();
      await tick();

      // Select 'No tags' filter
      const selects = document.querySelectorAll('select');
      const statusSelect = selects[0];
      statusSelect.value = 'no-tags';
      statusSelect.dispatchEvent(new Event('change'));
      await tick();

      const cards = document.querySelectorAll('.bookmark-card');
      expect(cards.length).toBe(2); // id: 3, 5
      const titles = Array.from(cards).map((c) => c.querySelector('.bookmark-title')?.textContent?.trim());
      expect(titles).toContain('태그 없는 북마크');
      expect(titles).toContain('완전 미정리 북마크');
    });

    it('should filter uncategorized bookmarks in default root folder (uncategorized)', async () => {
      mockData.bookmarks = [...testBookmarks];
      const comp: any = new BookmarkList({
        target,
        props: {
          folders: []
        }
      });

      await comp.loadBookmarks();
      await tick();

      // Select 'Uncategorized (default folder)' filter
      const selects = document.querySelectorAll('select');
      const statusSelect = selects[0];
      statusSelect.value = 'uncategorized';
      statusSelect.dispatchEvent(new Event('change'));
      await tick();

      const cards = document.querySelectorAll('.bookmark-card');
      expect(cards.length).toBe(2); // id: 4 (Bookmarks Bar), 5 ('')
      const titles = Array.from(cards).map((c) => c.querySelector('.bookmark-title')?.textContent?.trim());
      expect(titles).toContain('미분류 기본폴더 북마크');
      expect(titles).toContain('완전 미정리 북마크');
    });

    it('should filter broken bookmarks (broken)', async () => {
      mockData.bookmarks = [...testBookmarks];
      const comp: any = new BookmarkList({
        target,
        props: {
          folders: []
        }
      });

      await comp.loadBookmarks();
      await tick();

      // Select 'Unreachable (error)' filter
      const selects = document.querySelectorAll('select');
      const statusSelect = selects[0];
      statusSelect.value = 'broken';
      statusSelect.dispatchEvent(new Event('change'));
      await tick();

      const cards = document.querySelectorAll('.bookmark-card');
      expect(cards.length).toBe(3); // id: 3 (500), 4 (404), 6 (503)
      const titles = Array.from(cards).map((c) => c.querySelector('.bookmark-title')?.textContent?.trim());
      expect(titles).toContain('태그 없는 북마크');
      expect(titles).toContain('미분류 기본폴더 북마크');
      expect(titles).toContain('서버 에러 북마크');
    });

    it('should filter dead bookmarks (dead / 404)', async () => {
      mockData.bookmarks = [...testBookmarks];
      const comp: any = new BookmarkList({
        target,
        props: {
          folders: []
        }
      });

      await comp.loadBookmarks();
      await tick();

      // Select '404 dead link' filter
      const selects = document.querySelectorAll('select');
      const statusSelect = selects[0];
      statusSelect.value = 'dead';
      statusSelect.dispatchEvent(new Event('change'));
      await tick();

      const cards = document.querySelectorAll('.bookmark-card');
      expect(cards.length).toBe(1); // id: 4 (404)
      const titles = Array.from(cards).map((c) => c.querySelector('.bookmark-title')?.textContent?.trim());
      expect(titles).toEqual(['미분류 기본폴더 북마크']);
    });

    it('should respect live scan healthResults over cached httpStatus in filters', async () => {
      mockData.bookmarks = [...testBookmarks];
      const comp: any = new BookmarkList({
        target,
        props: {
          folders: []
        }
      });

      await comp.loadBookmarks();
      await tick();

      // Inject real-time check result:
      // id 4 (originally 404) -> recovered to ok (200)
      // id 1 (originally 200) -> changed to dead (404)
      bulkScanController.store.update((s) => {
        const nextResults = new Map(s.healthResults);
        nextResults.set(4, { bookmarkId: 4, url: 'https://example.com/uncategorized', status: 'ok', httpStatus: 200 });
        nextResults.set(1, { bookmarkId: 1, url: 'https://example.com/complete', status: 'dead', httpStatus: 404 });
        return {
          ...s,
          healthResults: nextResults
        };
      });
      await tick();

      // Select '404 dead link' filter
      const selects = document.querySelectorAll('select');
      const statusSelect = selects[0];
      statusSelect.value = 'dead';
      statusSelect.dispatchEvent(new Event('change'));
      await tick();

      const cards = document.querySelectorAll('.bookmark-card');
      expect(cards.length).toBe(1); // id: only 1 appears as dead (id 4 recovered to ok)
      const titles = Array.from(cards).map((c) => c.querySelector('.bookmark-title')?.textContent?.trim());
      expect(titles).toEqual(['완전한 북마크']);
    });

    it('should support compound filters with broken status and search / tag', async () => {
      mockData.bookmarks = [...testBookmarks];
      const comp: any = new BookmarkList({
        target,
        props: {
          folders: []
        }
      });

      await comp.loadBookmarks();
      await tick();

      const selects = document.querySelectorAll('select');
      const statusSelect = selects[0];
      statusSelect.value = 'broken';
      statusSelect.dispatchEvent(new Event('change'));
      await tick();

      expect(document.querySelectorAll('.bookmark-card').length).toBe(3);

      // Enter search keyword
      const searchInput = document.querySelector('.search-input') as HTMLInputElement;
      searchInput.value = '503';
      searchInput.dispatchEvent(new Event('input'));
      await tick();

      const cards = document.querySelectorAll('.bookmark-card');
      expect(cards.length).toBe(1);
      expect(cards[0].querySelector('.bookmark-title')?.textContent?.trim()).toBe('서버 에러 북마크');
    });

    it('should clear all filters and restore full list when clear button is clicked', async () => {
      mockData.bookmarks = [...testBookmarks];
      const comp: any = new BookmarkList({
        target,
        props: {
          folders: []
        }
      });

      await comp.loadBookmarks();
      await tick();

      const selects = document.querySelectorAll('select');
      const statusSelect = selects[0];
      statusSelect.value = 'broken';
      statusSelect.dispatchEvent(new Event('change'));
      await tick();

      expect(document.querySelectorAll('.bookmark-card').length).toBe(3);

      const clearBtn = document.querySelector('.btn-clear') as HTMLButtonElement;
      expect(clearBtn).toBeTruthy();
      clearBtn.click();
      await tick();

      expect(document.querySelectorAll('.bookmark-card').length).toBe(6);
    });
  });
});
