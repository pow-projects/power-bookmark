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

describe('Bookmark Multi-Filter Badges and Cumulative Filtering', () => {
  let target: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
    mockData.bookmarks = [];
    mockData.archivedPages = [];
    mockData.settings = {};
    bulkScanController.reset();
  });

  describe('BookmarkFilterBar Badge Interactivity', () => {
    it('should render filter chips inside search-chips-container for active status and tag, but not folder', async () => {
      new BookmarkFilterBar({
        target,
        props: {
          searchQuery: '',
          selectedFilters: ['no-desc', 'broken'],
          selectedTags: ['svelte', 'dev'],
          selectedFolder: 'Bookmarks Bar/개발',
          availableTags: ['svelte', 'dev', 'react'],
          viewMode: 'grid'
        }
      });

      await tick();

      const chips = document.querySelectorAll('.filter-chip');
      expect(chips.length).toBe(4);

      const labels = Array.from(chips).map((c) => c.querySelector('.filter-chip-label')?.textContent?.trim());
      expect(labels).toContain('#svelte');
      expect(labels).toContain('#dev');
      expect(labels).not.toContain('Bookmarks Bar/개발');
    });

    it('should remove a badge and update list when chip remove button is clicked', async () => {
      let selectedFilters: any[] = ['no-desc', 'dead'];
      let selectedTags: string[] = ['tech'];

      const comp = new BookmarkFilterBar({
        target,
        props: {
          searchQuery: '',
          selectedFilters,
          selectedTags,
          availableTags: ['tech'],
          viewMode: 'grid'
        }
      });

      let changed = false;
      comp.$on('change', () => {
        changed = true;
      });

      await tick();

      let chips = document.querySelectorAll('.filter-chip');
      expect(chips.length).toBe(3);

      const removeBtns = document.querySelectorAll('.chip-remove-btn');
      expect(removeBtns.length).toBe(3);

      (removeBtns[0] as HTMLButtonElement).click();
      await tick();

      expect(changed).toBe(true);
      chips = document.querySelectorAll('.filter-chip');
      expect(chips.length).toBe(2);
    });

    it('should remove the last badge when Backspace is pressed in empty search input', async () => {
      new BookmarkFilterBar({
        target,
        props: {
          searchQuery: '',
          selectedFilters: ['uncategorized'],
          selectedTags: ['design'],
          availableTags: ['design'],
          viewMode: 'grid'
        }
      });

      await tick();

      let chips = document.querySelectorAll('.filter-chip');
      expect(chips.length).toBe(2);

      const searchInput = document.querySelector('.search-input') as HTMLInputElement;
      expect(searchInput).toBeTruthy();

      searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
      await tick();

      chips = document.querySelectorAll('.filter-chip');
      expect(chips.length).toBe(1);

      searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
      await tick();

      chips = document.querySelectorAll('.filter-chip');
      expect(chips.length).toBe(0);
    });

    it('should NOT remove badge when Backspace is pressed during IME composition', async () => {
      new BookmarkFilterBar({
        target,
        props: {
          searchQuery: '',
          selectedFilters: ['uncategorized'],
          availableTags: [],
          viewMode: 'grid'
        }
      });

      await tick();

      const searchInput = document.querySelector('.search-input') as HTMLInputElement;
      searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', isComposing: true, bubbles: true }));
      await tick();

      const chips = document.querySelectorAll('.filter-chip');
      expect(chips.length).toBe(1);
    });

    it('should cumulatively add multiple status and tag filters on dropdown change', async () => {
      new BookmarkFilterBar({
        target,
        props: {
          searchQuery: '',
          selectedFilters: [],
          selectedTags: [],
          availableTags: ['frontend', 'backend', 'ai'],
          viewMode: 'grid'
        }
      });

      await tick();

      const selects = document.querySelectorAll('select');
      const statusSelect = selects[0];
      const tagSelect = selects[1];

      statusSelect.value = 'no-desc';
      statusSelect.dispatchEvent(new Event('change'));
      await tick();

      statusSelect.value = 'broken';
      statusSelect.dispatchEvent(new Event('change'));
      await tick();

      tagSelect.value = 'frontend';
      tagSelect.dispatchEvent(new Event('change'));
      await tick();

      tagSelect.value = 'ai';
      tagSelect.dispatchEvent(new Event('change'));
      await tick();

      const chips = document.querySelectorAll('.filter-chip');
      expect(chips.length).toBe(4);
      const labels = Array.from(chips).map((c) => c.querySelector('.filter-chip-label')?.textContent?.trim());
      expect(labels).toContain('#frontend');
      expect(labels).toContain('#ai');
    });
  });

  describe('BookmarkList Multi-Filter Pipeline (AND matching)', () => {
    const testBookmarks = [
      {
        id: 1,
        syncId: 'sync-1',
        title: 'Svelte + TypeScript 가이드',
        url: 'https://example.com/svelte-ts',
        description: '스벨트와 타입스크립트 개발 가이드',
        folderPath: 'Bookmarks Bar/개발',
        tags: ['svelte', 'typescript', 'frontend'],
        createdAt: 1000,
        modifiedAt: 1000,
        httpStatus: 200
      },
      {
        id: 2,
        syncId: 'sync-2',
        title: 'Svelte 전용 팁',
        url: 'https://example.com/svelte-only',
        description: '',
        folderPath: 'Bookmarks Bar/개발',
        tags: ['svelte', 'frontend'],
        createdAt: 2000,
        modifiedAt: 2000,
        httpStatus: 200
      },
      {
        id: 3,
        syncId: 'sync-3',
        title: 'TypeScript 백엔드 튜토리얼',
        url: 'https://example.com/ts-backend',
        description: '백엔드 Node.js 가이드',
        folderPath: 'Bookmarks Bar/백엔드',
        tags: ['typescript', 'backend'],
        createdAt: 3000,
        modifiedAt: 3000,
        httpStatus: 500
      },
      {
        id: 4,
        syncId: 'sync-4',
        title: '죽은 링크 북마크',
        url: 'https://example.com/dead-link',
        description: '',
        folderPath: 'Bookmarks Bar',
        tags: ['svelte'],
        createdAt: 4000,
        modifiedAt: 4000,
        httpStatus: 404
      }
    ];

    it('should filter bookmarks by multiple tags simultaneously (AND condition)', async () => {
      mockData.bookmarks = [...testBookmarks];
      const comp: any = new BookmarkList({
        target,
        props: { folders: [] }
      });

      await comp.loadBookmarks();
      await tick();

      expect(document.querySelectorAll('.bookmark-card').length).toBe(4);

      const tagSelect = document.querySelectorAll('select')[1];
      tagSelect.value = 'svelte';
      tagSelect.dispatchEvent(new Event('change'));
      await tick();

      expect(document.querySelectorAll('.bookmark-card').length).toBe(3);

      tagSelect.value = 'typescript';
      tagSelect.dispatchEvent(new Event('change'));
      await tick();

      const cards = document.querySelectorAll('.bookmark-card');
      expect(cards.length).toBe(1);
      expect(cards[0].querySelector('.bookmark-title')?.textContent?.trim()).toBe('Svelte + TypeScript 가이드');
    });

    it('should filter bookmarks by multiple status filters (AND condition)', async () => {
      mockData.bookmarks = [...testBookmarks];
      const comp: any = new BookmarkList({
        target,
        props: { folders: [] }
      });

      await comp.loadBookmarks();
      await tick();

      const statusSelect = document.querySelectorAll('select')[0];

      statusSelect.value = 'no-desc';
      statusSelect.dispatchEvent(new Event('change'));
      await tick();
      expect(document.querySelectorAll('.bookmark-card').length).toBe(2);

      statusSelect.value = 'broken';
      statusSelect.dispatchEvent(new Event('change'));
      await tick();

      const cards = document.querySelectorAll('.bookmark-card');
      expect(cards.length).toBe(1);
      expect(cards[0].querySelector('.bookmark-title')?.textContent?.trim()).toBe('죽은 링크 북마크');
    });

    it('should support compound filtering: status + tag + search query', async () => {
      mockData.bookmarks = [...testBookmarks];
      const comp: any = new BookmarkList({
        target,
        props: { folders: [] }
      });

      await comp.loadBookmarks();
      await tick();

      const tagSelect = document.querySelectorAll('select')[1];
      tagSelect.value = 'svelte';
      tagSelect.dispatchEvent(new Event('change'));
      await tick();

      const searchInput = document.querySelector('.search-input') as HTMLInputElement;
      searchInput.value = '전용';
      searchInput.dispatchEvent(new Event('input'));
      await tick();

      const cards = document.querySelectorAll('.bookmark-card');
      expect(cards.length).toBe(1);
      expect(cards[0].querySelector('.bookmark-title')?.textContent?.trim()).toBe('Svelte 전용 팁');
    });

    it('should accumulate clicked tag on bookmark card into selectedTags', async () => {
      mockData.bookmarks = [...testBookmarks];
      const comp: any = new BookmarkList({
        target,
        props: { folders: [] }
      });

      await comp.loadBookmarks();
      await tick();

      const tagChips = document.querySelectorAll('.bookmark-card .tag-chip');
      const tsChip = Array.from(tagChips).find((el) => el.textContent?.includes('typescript')) as HTMLElement;
      expect(tsChip).toBeTruthy();

      tsChip.click();
      await tick();

      const chips = document.querySelectorAll('.filter-chip');
      expect(chips.length).toBe(1);
      expect(chips[0].textContent).toContain('typescript');

      expect(document.querySelectorAll('.bookmark-card').length).toBe(2);
    });

    it('should clear all badges and restore all bookmarks when clear button is clicked', async () => {
      mockData.bookmarks = [...testBookmarks];
      const comp: any = new BookmarkList({
        target,
        props: { folders: [] }
      });

      await comp.loadBookmarks();
      await tick();

      const statusSelect = document.querySelectorAll('select')[0];
      statusSelect.value = 'no-desc';
      statusSelect.dispatchEvent(new Event('change'));
      await tick();

      const tagSelect = document.querySelectorAll('select')[1];
      tagSelect.value = 'svelte';
      tagSelect.dispatchEvent(new Event('change'));
      await tick();

      expect(document.querySelectorAll('.bookmark-card').length).toBe(2);
      expect(document.querySelectorAll('.filter-chip').length).toBe(2);

      const clearBtn = document.querySelector('.btn-clear') as HTMLButtonElement;
      expect(clearBtn).toBeTruthy();
      clearBtn.click();
      await tick();

      expect(document.querySelectorAll('.bookmark-card').length).toBe(4);
      expect(document.querySelectorAll('.filter-chip').length).toBe(0);
    });
  });
});