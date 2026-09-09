import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';
import BookmarkTableHeader from '../../src/components/management/bookmarks/BookmarkTableHeader.svelte';
import BookmarkFilterBar from '../../src/components/management/bookmarks/BookmarkFilterBar.svelte';
import BookmarkRow from '../../src/components/management/bookmarks/BookmarkRow.svelte';
import { formatDate } from '../../src/lib/ui/date-formatter';

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
  }
});

describe('Bookmark List Views & High-Density Archival Catalog', () => {
  let target: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
  });

  describe('formatDate utility', () => {
    it('should format timestamp as YYYY.MM.DD', () => {
      const ts = new Date('2026-08-27T12:00:00Z').getTime();
      expect(formatDate(ts)).toMatch(/^\d{4}\.\d{2}\.\d{2}$/);
    });

    it('should return empty string for undefined or 0', () => {
      expect(formatDate(undefined)).toBe('');
      expect(formatDate(0)).toBe('');
      expect(formatDate(NaN)).toBe('');
    });
  });

  describe('BookmarkTableHeader.svelte', () => {
    it('should render header columns with sort buttons and checkbox', async () => {
      new BookmarkTableHeader({
        target,
        props: {
          allSelected: false,
          sortBy: 'date-desc'
        }
      });

      await tick();

      const checkbox = document.querySelector('.header-checkbox') as HTMLInputElement;
      expect(checkbox).toBeTruthy();
      expect(checkbox.checked).toBe(false);

      const titleHeader = document.querySelector('.col-title');
      expect(titleHeader?.textContent).toContain('제목 / URL');

      const folderHeader = document.querySelector('.col-folder');
      expect(folderHeader?.textContent).toContain('폴더');

      const tagsHeader = document.querySelector('.col-tags');
      expect(tagsHeader?.textContent).toContain('태그');

      const statusHeader = document.querySelector('.col-status');
      expect(statusHeader?.textContent).toContain('상태 / 아카이브');

      const dateHeader = document.querySelector('.col-date');
      expect(dateHeader?.textContent).toContain('추가일');
    });

    it('should dispatch toggleSelectAll on checkbox change', async () => {
      const headerComp = new BookmarkTableHeader({
        target,
        props: {
          allSelected: true,
          sortBy: 'date-desc'
        }
      });

      const spy = vi.fn();
      headerComp.$on('toggleSelectAll', spy);

      await tick();
      const checkbox = document.querySelector('.header-checkbox') as HTMLInputElement;
      checkbox.click();
      await tick();

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should dispatch sort event when title or date sort buttons are clicked', async () => {
      const headerComp = new BookmarkTableHeader({
        target,
        props: {
          allSelected: false,
          sortBy: 'title-asc'
        }
      });

      const sortSpy = vi.fn();
      headerComp.$on('sort', sortSpy);

      await tick();

      const titleSortBtn = document.querySelector('.col-title .header-sort-btn') as HTMLButtonElement;
      titleSortBtn.click();
      await tick();

      expect(sortSpy).toHaveBeenCalledWith(expect.objectContaining({
        detail: { sortBy: 'title-desc' }
      }));

      const dateSortBtn = document.querySelector('.col-date .header-sort-btn') as HTMLButtonElement;
      dateSortBtn.click();
      await tick();

      expect(sortSpy).toHaveBeenCalledWith(expect.objectContaining({
        detail: { sortBy: 'date-desc' }
      }));
    });

    it('should render folder and status sort buttons with accessible labels', async () => {
      new BookmarkTableHeader({
        target,
        props: {
          allSelected: false,
          sortBy: 'date-desc'
        }
      });

      await tick();

      const folderBtn = document.querySelector('.col-folder .header-sort-btn') as HTMLButtonElement;
      expect(folderBtn).toBeTruthy();
      expect(folderBtn.getAttribute('aria-label')).toMatch(/폴더|Folder/);

      const statusBtn = document.querySelector('.col-status .header-sort-btn') as HTMLButtonElement;
      expect(statusBtn).toBeTruthy();
      expect(statusBtn.getAttribute('aria-label')).toMatch(/상태|Status/);
    });

    it('should toggle folder sort button between folder-asc and folder-desc', async () => {
      const headerComp = new BookmarkTableHeader({
        target,
        props: {
          allSelected: false,
          sortBy: 'folder-asc'
        }
      });

      const sortSpy = vi.fn();
      headerComp.$on('sort', sortSpy);

      await tick();

      const folderBtn = document.querySelector('.col-folder .header-sort-btn') as HTMLButtonElement;
      folderBtn.click();
      await tick();

      expect(sortSpy).toHaveBeenCalledWith(expect.objectContaining({
        detail: { sortBy: 'folder-desc' }
      }));

      sortSpy.mockClear();
      headerComp.$set({ sortBy: 'folder-desc' });
      await tick();

      folderBtn.click();
      await tick();

      expect(sortSpy).toHaveBeenCalledWith(expect.objectContaining({
        detail: { sortBy: 'folder-asc' }
      }));
    });

    it('should toggle status sort button between status-desc and status-asc', async () => {
      const headerComp = new BookmarkTableHeader({
        target,
        props: {
          allSelected: false,
          sortBy: 'status-desc'
        }
      });

      const sortSpy = vi.fn();
      headerComp.$on('sort', sortSpy);

      await tick();

      const statusBtn = document.querySelector('.col-status .header-sort-btn') as HTMLButtonElement;
      statusBtn.click();
      await tick();

      expect(sortSpy).toHaveBeenCalledWith(expect.objectContaining({
        detail: { sortBy: 'status-asc' }
      }));

      sortSpy.mockClear();
      headerComp.$set({ sortBy: 'status-asc' });
      await tick();

      statusBtn.click();
      await tick();

      expect(sortSpy).toHaveBeenCalledWith(expect.objectContaining({
        detail: { sortBy: 'status-desc' }
      }));
    });

    it('should render chevron icons properly on active sort column', async () => {
      const headerComp = new BookmarkTableHeader({
        target,
        props: {
          allSelected: false,
          sortBy: 'date-desc'
        }
      });

      await tick();

      // In date-desc: folder and status buttons have no chevrons
      expect(document.querySelector('.col-folder .header-sort-btn svg')).toBeNull();
      expect(document.querySelector('.col-status .header-sort-btn svg')).toBeNull();

      // When sortBy is folder-asc, folder button has chevron-up
      headerComp.$set({ sortBy: 'folder-asc' });
      await tick();
      const folderUpSvg = document.querySelector('.col-folder .header-sort-btn svg path');
      expect(folderUpSvg).toBeTruthy();
      expect(folderUpSvg?.getAttribute('d')).toBe('M18 15l-6-6-6 6');
      expect(document.querySelector('.col-status .header-sort-btn svg')).toBeNull();

      // When sortBy is folder-desc, folder button has chevron-down
      headerComp.$set({ sortBy: 'folder-desc' });
      await tick();
      const folderDownSvg = document.querySelector('.col-folder .header-sort-btn svg path');
      expect(folderDownSvg).toBeTruthy();
      expect(folderDownSvg?.getAttribute('d')).toBe('M6 9l6 6 6-6');

      // When sortBy is status-desc, status button has chevron-down
      headerComp.$set({ sortBy: 'status-desc' });
      await tick();
      expect(document.querySelector('.col-folder .header-sort-btn svg')).toBeNull();
      const statusDownSvg = document.querySelector('.col-status .header-sort-btn svg path');
      expect(statusDownSvg).toBeTruthy();
      expect(statusDownSvg?.getAttribute('d')).toBe('M6 9l6 6 6-6');

      // When sortBy is status-asc, status button has chevron-up
      headerComp.$set({ sortBy: 'status-asc' });
      await tick();
      const statusUpSvg = document.querySelector('.col-status .header-sort-btn svg path');
      expect(statusUpSvg).toBeTruthy();
      expect(statusUpSvg?.getAttribute('d')).toBe('M18 15l-6-6-6 6');
    });
  });

  describe('BookmarkRow.svelte', () => {
    const mockBookmark: any = {
      id: 101,
      title: 'PowerBookmark GitHub',
      url: 'https://github.com/pow-projects/power-bookmark',
      description: 'Browser extension bookmark manager',
      folderPath: '북마크바/개발',
      createdAt: 1787832000000,
      tags: ['svelte', 'wxt', 'extension']
    };

    it('should render row with compact columns, title, domain, folder chip, and tags', async () => {
      new BookmarkRow({
        target,
        props: {
          bookmark: mockBookmark,
          selected: false,
          hasArchive: true,
          isArchivedLocally: true
        }
      });

      await tick();

      const row = document.querySelector('.bookmark-row');
      expect(row).toBeTruthy();

      const title = document.querySelector('.row-title');
      expect(title?.textContent?.trim()).toBe('PowerBookmark GitHub');

      const urlDomain = document.querySelector('.row-url');
      expect(urlDomain?.textContent?.trim()).toBe('github.com');

      const folderChip = document.querySelector('.folder-chip');
      expect(folderChip?.textContent).toContain('북마크바/개발');

      const tagChips = document.querySelectorAll('.tag-chip');
      expect(tagChips.length).toBe(2); // Display up to 2 items then +N
      const tagMore = document.querySelector('.tag-more');
      expect(tagMore?.textContent?.trim()).toBe('+1');
    });

    it('should dispatch toggleSelect when checkbox or row is clicked', async () => {
      const rowComp = new BookmarkRow({
        target,
        props: {
          bookmark: mockBookmark,
          selected: false
        }
      });

      const selectSpy = vi.fn();
      rowComp.$on('toggleSelect', selectSpy);

      await tick();

      const row = document.querySelector('.bookmark-row') as HTMLElement;
      row.click();
      await tick();

      expect(selectSpy).toHaveBeenCalledTimes(1);
      expect(selectSpy).toHaveBeenCalledWith(expect.objectContaining({
        detail: expect.objectContaining({ bookmarkId: 101 })
      }));
    });

    it('should dispatch selectFolder and selectTag events', async () => {
      const rowComp = new BookmarkRow({
        target,
        props: {
          bookmark: mockBookmark,
          selected: false
        }
      });

      const folderSpy = vi.fn();
      const tagSpy = vi.fn();
      rowComp.$on('selectFolder', folderSpy);
      rowComp.$on('selectTag', tagSpy);

      await tick();

      const folderBtn = document.querySelector('.folder-chip') as HTMLButtonElement;
      folderBtn.click();
      await tick();

      expect(folderSpy).toHaveBeenCalledWith(expect.objectContaining({
        detail: { folderPath: '북마크바/개발' }
      }));

      const firstTag = document.querySelector('.tag-chip') as HTMLButtonElement;
      firstTag.click();
      await tick();

      expect(tagSpy).toHaveBeenCalledWith(expect.objectContaining({
        detail: { tag: 'svelte' }
      }));
    });

    it('should dispatch edit, delete, and openArchive actions', async () => {
      const rowComp = new BookmarkRow({
        target,
        props: {
          bookmark: mockBookmark,
          selected: false,
          hasArchive: true,
          isArchivedLocally: true
        }
      });

      const editSpy = vi.fn();
      const deleteSpy = vi.fn();
      const archiveSpy = vi.fn();

      rowComp.$on('edit', editSpy);
      rowComp.$on('delete', deleteSpy);
      rowComp.$on('openArchive', archiveSpy);

      await tick();

      const buttons = document.querySelectorAll('.action-buttons .btn-icon-xs') as NodeListOf<HTMLButtonElement>;
      expect(buttons.length).toBe(3); // Archive, Edit, Delete

      buttons[0].click();
      await tick();
      expect(archiveSpy).toHaveBeenCalledWith(expect.objectContaining({
        detail: { bookmark: mockBookmark }
      }));

      buttons[1].click();
      await tick();
      expect(editSpy).toHaveBeenCalledWith(expect.objectContaining({
        detail: { bookmark: mockBookmark }
      }));

      buttons[2].click();
      await tick();
      expect(deleteSpy).toHaveBeenCalledWith(expect.objectContaining({
        detail: { bookmarkId: 101 }
      }));
    });

    it('should render dead link styling and connection error badge', async () => {
      new BookmarkRow({
        target,
        props: {
          bookmark: { ...mockBookmark, httpStatus: 404 },
          isDead: true,
          selected: false
        }
      });

      await tick();

      const deadLink = document.querySelector('.row-title.dead-link');
      expect(deadLink).toBeTruthy();

      const inlineError = document.querySelector('.inline-error');
      expect(inlineError?.textContent).toContain('404');
    });
  });

  describe('BookmarkFilterBar.svelte sort options', () => {
    it('should render folder and status sort options in filter bar', async () => {
      new BookmarkFilterBar({
        target,
        props: {
          sortBy: 'date-desc'
        }
      });

      await tick();

      const sortSelect = document.querySelector('.sort-select') as HTMLSelectElement;
      expect(sortSelect).toBeTruthy();

      const options = Array.from(sortSelect.options).map((opt) => opt.value);
      expect(options).toContain('folder-asc');
      expect(options).toContain('folder-desc');
      expect(options).toContain('status-desc');
      expect(options).toContain('status-asc');
    });
  });

  describe('Bookmark List Sorting Comparator Logic', () => {
    function getStatusRank(
      b: any,
      archiveMap: Map<number, any> = new Map(),
      cloudArchiveMap: Map<string, any> = new Map(),
      cloudArchiveUrlMap: Map<string, any> = new Map()
    ): number {
      if (b.aiStatus === 'error') return 3;
      if (b.aiStatus === 'running' || b.aiStatus === 'pending') return 2;
      const hasArch = b.id !== undefined && (
        archiveMap.has(b.id) ||
        (!!b.syncId && cloudArchiveMap.has(b.syncId)) ||
        (!!b.url && (cloudArchiveUrlMap.has(b.url)))
      );
      if (hasArch) return 1;
      return 0;
    }

    function sortBookmarks(
      list: any[],
      sortBy: string,
      archiveMap: Map<number, any> = new Map(),
      cloudArchiveMap: Map<string, any> = new Map(),
      cloudArchiveUrlMap: Map<string, any> = new Map()
    ) {
      return [...list].sort((a, b) => {
        if (sortBy === 'date-desc') return (b.createdAt || 0) - (a.createdAt || 0);
        if (sortBy === 'date-asc') return (a.createdAt || 0) - (b.createdAt || 0);
        if (sortBy === 'title-asc') return (a.title || '').localeCompare(b.title || '');
        if (sortBy === 'title-desc') return (b.title || '').localeCompare(a.title || '');
        if (sortBy === 'folder-asc') {
          const cmp = (a.folderPath || '').localeCompare(b.folderPath || '');
          return cmp !== 0 ? cmp : (a.title || '').localeCompare(b.title || '');
        }
        if (sortBy === 'folder-desc') {
          const cmp = (b.folderPath || '').localeCompare(a.folderPath || '');
          return cmp !== 0 ? cmp : (a.title || '').localeCompare(b.title || '');
        }
        if (sortBy === 'status-desc') {
          const rankA = getStatusRank(a, archiveMap, cloudArchiveMap, cloudArchiveUrlMap);
          const rankB = getStatusRank(b, archiveMap, cloudArchiveMap, cloudArchiveUrlMap);
          return rankB !== rankA ? rankB - rankA : (a.title || '').localeCompare(b.title || '');
        }
        if (sortBy === 'status-asc') {
          const rankA = getStatusRank(a, archiveMap, cloudArchiveMap, cloudArchiveUrlMap);
          const rankB = getStatusRank(b, archiveMap, cloudArchiveMap, cloudArchiveUrlMap);
          return rankA !== rankB ? rankA - rankB : (a.title || '').localeCompare(b.title || '');
        }
        return 0;
      });
    }

    it('folder-asc sorts empty folder first, then alphabetical folders, tie breaking by title', () => {
      const items = [
        { id: 1, title: 'Zebra', folderPath: 'Dev/Tools' },
        { id: 2, title: 'Beta', folderPath: '' },
        { id: 3, title: 'Alpha', folderPath: '' },
        { id: 4, title: 'Apple', folderPath: 'Dev/Tools' },
        { id: 5, title: 'Docs', folderPath: 'Analytics' }
      ];

      const sorted = sortBookmarks(items, 'folder-asc');

      expect(sorted.map((s) => s.id)).toEqual([
        3, // empty folder, title Alpha
        2, // empty folder, title Beta
        5, // Analytics, title Docs
        4, // Dev/Tools, title Apple
        1  // Dev/Tools, title Zebra
      ]);
    });

    it('folder-desc sorts descending folders', () => {
      const items = [
        { id: 1, title: 'B Item', folderPath: 'Beta' },
        { id: 2, title: 'A Item', folderPath: 'Alpha' },
        { id: 3, title: 'Z Item 2', folderPath: 'Zeta' },
        { id: 4, title: 'Z Item 1', folderPath: 'Zeta' },
        { id: 5, title: 'Root Item', folderPath: '' }
      ];

      const sorted = sortBookmarks(items, 'folder-desc');

      expect(sorted.map((s) => s.id)).toEqual([
        4, // Zeta, title Z Item 1
        3, // Zeta, title Z Item 2
        1, // Beta
        2, // Alpha
        5  // empty folder
      ]);
    });

    it('status-desc sorts AI error -> AI running -> archive -> normal', () => {
      const archiveMap = new Map<number, any>([[102, { id: 1 }]]);
      const items = [
        { id: 101, title: 'Normal Item', aiStatus: 'none' },
        { id: 102, title: 'Archived Item', aiStatus: 'none' },
        { id: 103, title: 'Running Item', aiStatus: 'running' },
        { id: 104, title: 'Error Item', aiStatus: 'error' },
        { id: 105, title: 'Pending Item', aiStatus: 'pending' }
      ];

      const sorted = sortBookmarks(items, 'status-desc', archiveMap);

      expect(sorted.map((s) => s.id)).toEqual([
        104, // AI error (rank 3)
        105, // AI pending (rank 2)
        103, // AI running (rank 2)
        102, // Archive (rank 1)
        101  // Normal (rank 0)
      ]);
    });

    it('status-asc sorts normal -> archive -> AI running -> AI error', () => {
      const archiveMap = new Map<number, any>([[102, { id: 1 }]]);
      const items = [
        { id: 101, title: 'Normal Item', aiStatus: 'none' },
        { id: 102, title: 'Archived Item', aiStatus: 'none' },
        { id: 103, title: 'Running Item', aiStatus: 'running' },
        { id: 104, title: 'Error Item', aiStatus: 'error' },
        { id: 105, title: 'Pending Item', aiStatus: 'pending' }
      ];

      const sorted = sortBookmarks(items, 'status-asc', archiveMap);

      expect(sorted.map((s) => s.id)).toEqual([
        101, // Normal (rank 0)
        102, // Archive (rank 1)
        105, // AI pending (rank 2)
        103, // AI running (rank 2)
        104  // AI error (rank 3)
      ]);
    });
  });
});
