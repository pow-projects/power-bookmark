import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';

const { mockData, dbMock, mockIsAiConfigured, mockAnalyzeContent } = vi.hoisted(() => {
  const data = { bookmarks: [] as any[], archivedPages: [] as any[], settings: {} as Record<string, any> };
  const mockIsAiConfigured = vi.fn(async () => true);
  const mockAnalyzeContent = vi.fn(async () => ({
    summary: 'Mock summary',
    category: '개발',
    suggestedFolderId: null,
    suggestedFolderName: '',
    isNewFolderRecommended: false,
    tags: [],
    confidence: 0.9
  }));
  const mock = {
    bookmarks: {
      toArray: vi.fn(async () => data.bookmarks),
      get: vi.fn(async (id: number) => data.bookmarks.find(b => b.id === id)),
      update: vi.fn(async (id: number, payload: any) => {
        const idx = data.bookmarks.findIndex(b => b.id === id);
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
      get: vi.fn(async (id: number) => data.archivedPages.find(a => a.id === id)),
      delete: vi.fn(async (id: number) => {
        const idx = data.archivedPages.findIndex(a => a.id === id);
        if (idx !== -1) data.archivedPages.splice(idx, 1);
      }),
      where: vi.fn(() => ({
        equals: vi.fn((val: any) => ({
          first: async () => data.archivedPages.find(a => a.bookmarkId === val),
          delete: async () => {
            const idx = data.archivedPages.findIndex(a => a.bookmarkId === val);
            if (idx !== -1) data.archivedPages.splice(idx, 1);
          }
        }))
      }))
    },
    settings: {
      get: vi.fn(async (key: string) => data.settings[key] !== undefined ? { key, value: data.settings[key] } : undefined),
      put: vi.fn(async (item: { key: string; value: any }) => { data.settings[item.key] = item.value; })
    }
  };
  return { mockData: data, dbMock: mock, mockIsAiConfigured, mockAnalyzeContent };
});

vi.mock('../../src/lib/db', () => ({
  db: dbMock,
  default: dbMock
}));

vi.mock('../../src/lib/ai/ai-summarizer', () => ({
  isAiConfigured: mockIsAiConfigured,
  analyzeContent: mockAnalyzeContent
}));

vi.mock('../../src/lib/archive/page-capture', () => ({
  archiveBookmark: vi.fn(async () => {}),
  decompressArchiveHtml: vi.fn(async (blob: Blob) => blob)
}));

if (!globalThis.URL.createObjectURL) {
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
}
if (!globalThis.URL.revokeObjectURL) {
  globalThis.URL.revokeObjectURL = vi.fn();
}

const storageListeners: any[] = [];

vi.stubGlobal('browser', {
  i18n: {
    getMessage: vi.fn((key: string) => key)
  },
  runtime: {
    sendMessage: vi.fn(async () => ({ ok: true }))
  },
  storage: {
    onChanged: {
      addListener: vi.fn((cb: any) => { storageListeners.push(cb); }),
      removeListener: vi.fn((cb: any) => {
        const idx = storageListeners.indexOf(cb);
        if (idx !== -1) storageListeners.splice(idx, 1);
      })
    },
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {})
    }
  },
  bookmarks: {
    getTree: vi.fn(async () => [{ id: '0', title: 'root', children: [] }]),
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onChanged: { addListener: vi.fn() },
    onMoved: { addListener: vi.fn() }
  },
  tabs: {
    query: vi.fn(async () => [])
  }
});

import BookmarkList from '../../src/components/management/BookmarkList.svelte';

describe('BookmarkList.svelte - Folder Filter Options & Selection', () => {
  let target: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
    mockData.bookmarks = [];
    mockData.archivedPages = [];
    mockData.settings = {};
    storageListeners.length = 0;
    (globalThis as any).browser.runtime.sendMessage = vi.fn(async () => ({ ok: true }));
  });

  it('should render folder tree (system roots excluded) and filter bookmarks on folder selection', async () => {
    const mockFolders = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', depth: 0 },
      { id: '2', title: 'Development', path: 'Bookmarks Bar/Development', depth: 1 }
    ];

    mockData.bookmarks = [
      { id: 201, title: 'Dev Item', url: 'https://example.com/dev', folderPath: 'Bookmarks Bar/Development', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b201' },
      { id: 202, title: 'Root Item', url: 'https://example.com/root', folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b202' }
    ];

    // m3 hardening: mock onMount getFolders() with same data so it does not overwrite prop folders
    const { BookmarkManager } = await import('../../src/lib/bookmarks/bookmark-manager');
    const getFoldersSpy = vi.spyOn(BookmarkManager, 'getFolders').mockResolvedValue(mockFolders as any);
    const comp: any = new BookmarkList({
      target,
      props: {
        folders: mockFolders
      }
    });

    await comp.loadBookmarks();
    await tick();

    // System root (Bookmarks Bar) is also displayed in tree -> 'All Folders' + 'Bookmarks Bar' + 'Development' = 3 nodes
    const treeItems = document.querySelectorAll('.folder-tree .tree-item');
    expect(treeItems.length).toBe(3);

    const rootItem = document.querySelector('.folder-tree .root-item');
    expect(rootItem?.querySelector('.tree-label')?.textContent).toBe('모든 폴더');
    expect(rootItem?.classList.contains('active')).toBe(true); // Initial selection: all

    const labels = Array.from(treeItems).map(el => el.querySelector('.tree-label')?.textContent);
    expect(labels).toEqual(['모든 폴더', 'Bookmarks Bar', 'Development']);

    // Click 'Development' folder row -> change event + reflect selectedFolder -> filter bookmarks in that folder only
    const devItem = Array.from(treeItems).find(el => el.querySelector('.tree-label')?.textContent === 'Development') as HTMLElement;
    devItem.click();
    await tick();

    const activeItems = document.querySelectorAll('.folder-tree .tree-item.active');
    expect(activeItems.length).toBe(1);
    expect(activeItems[0].querySelector('.tree-label')?.textContent).toBe('Development');
    expect(rootItem?.classList.contains('active')).toBe(false);

    const cards = document.querySelectorAll('.bookmark-card');
    expect(cards.length).toBe(1);
    expect(cards[0].querySelector('.bookmark-title')?.textContent).toBe('Dev Item');

    // Click 'All Folders' -> clear filter -> display all bookmarks
    (document.querySelector('.folder-tree .root-item') as HTMLElement).click();
    await tick();
    expect(document.querySelectorAll('.bookmark-card').length).toBe(2);

    getFoldersSpy.mockRestore();
  });

  it('system root 클릭 시 해당 루트 하위(직속+하위 폴더)만 표시하고 다른 루트는 제외', async () => {
    const mockFolders = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', depth: 0 },
      { id: '2', title: 'Development', path: 'Bookmarks Bar/Development', depth: 1 },
      { id: '3', title: 'Other Bookmarks', path: 'Other Bookmarks', depth: 0 },
      { id: '4', title: 'Community', path: 'Other Bookmarks/Community', depth: 1 },
      { id: '5', title: 'Sports', path: 'Other Bookmarks/Community/Sports', depth: 2 }
    ];

    mockData.bookmarks = [
      // Direct + subfolders of Bookmarks Bar
      { id: 301, title: 'Bar Direct', url: 'https://example.com/bar-direct', folderPath: 'Bookmarks Bar', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b301' },
      { id: 302, title: 'Bar Dev', url: 'https://example.com/bar-dev', folderPath: 'Bookmarks Bar/Development', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b302' },
      // Direct + subfolders of Other bookmarks
      { id: 303, title: 'Other Direct', url: 'https://example.com/other-direct', folderPath: 'Other Bookmarks', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b303' },
      { id: 304, title: 'Other Sports', url: 'https://example.com/other-sports', folderPath: 'Other Bookmarks/Community/Sports', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b304' }
    ];

    const { BookmarkManager } = await import('../../src/lib/bookmarks/bookmark-manager');
    const getFoldersSpy = vi.spyOn(BookmarkManager, 'getFolders').mockResolvedValue(mockFolders as any);
    const comp: any = new BookmarkList({ target, props: { folders: mockFolders } });
    await comp.loadBookmarks();
    await tick();

    // Click 'Bookmarks Bar' root -> direct + subfolders of that root only, excluding Other bookmarks
    const treeItems = () => Array.from(document.querySelectorAll('.folder-tree .tree-item'));
    const barItem = treeItems().find(el => el.querySelector('.tree-label')?.textContent === 'Bookmarks Bar') as HTMLElement;
    barItem.click();
    await tick();
    const barCards = Array.from(document.querySelectorAll('.bookmark-card .bookmark-title')).map(el => el.textContent);
    expect(barCards.sort()).toEqual(['Bar Dev', 'Bar Direct'].sort());

    // Click 'Other Bookmarks' root -> includes bookmarks in subfolders (Community/Sports)
    const otherItem = treeItems().find(el => el.querySelector('.tree-label')?.textContent === 'Other Bookmarks') as HTMLElement;
    otherItem.click();
    await tick();
    const otherCards = Array.from(document.querySelectorAll('.bookmark-card .bookmark-title')).map(el => el.textContent);
    expect(otherCards.sort()).toEqual(['Other Direct', 'Other Sports'].sort());

    getFoldersSpy.mockRestore();
  });

  it('should toggle individual bookmark selection correctly when checkbox is clicked', async () => {
    mockData.bookmarks = [
      { id: 101, title: 'Item 1', url: 'https://example.com/1', folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b1' },
      { id: 102, title: 'Item 2', url: 'https://example.com/2', folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b2' }
    ];

    const comp: any = new BookmarkList({
      target,
      props: { folders: [] }
    });

    await comp.loadBookmarks();
    await tick();

    const cardCheckboxes = document.querySelectorAll('.bookmark-card input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
    expect(cardCheckboxes.length).toBe(2);

    // Initial state: not checked, bulk action bar is permanently visible
    expect(document.querySelector('.bulk-actions')).toBeTruthy();
    const initialDeleteBtn = document.querySelector('.bulk-actions .btn-danger') as HTMLButtonElement;
    expect(initialDeleteBtn.disabled).toBe(true);
    expect(cardCheckboxes[0].checked).toBe(false);
    expect(cardCheckboxes[1].checked).toBe(false);

    // Click individual checkbox 0
    cardCheckboxes[0].checked = true;
    cardCheckboxes[0].dispatchEvent(new Event('change'));
    await tick();

    const selectedCards = document.querySelectorAll('.bookmark-card.selected');
    expect(selectedCards.length).toBe(1);

    // Check bulk actions buttons state
    const deleteBtn = document.querySelector('.bulk-actions .btn-danger') as HTMLButtonElement;
    expect(deleteBtn.disabled).toBe(false);
    expect(deleteBtn.textContent).toContain('(1)');
  });

  it('should wrap bulk action bar in bulk-action-sticky-wrapper inside results-wrapper for sticky scroll follow', async () => {
    mockData.bookmarks = [
      { id: 101, title: 'Item 1', url: 'https://example.com/1', folderPath: 'Bookmarks Bar', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b1' }
    ];

    const comp: any = new BookmarkList({
      target,
      props: { folders: [] }
    });

    await comp.loadBookmarks();
    await tick();

    const resultsWrapper = document.querySelector('.results-wrapper');
    expect(resultsWrapper).toBeTruthy();

    const stickyWrapper = resultsWrapper?.querySelector('.bulk-action-sticky-wrapper');
    expect(stickyWrapper).toBeTruthy();

    const bulkBar = stickyWrapper?.querySelector('.bulk-actions');
    expect(bulkBar).toBeTruthy();
  });

  it('should clear bookmark selection when switching to a different folder in the tree', async () => {
    const mockFolders = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', depth: 0 },
      { id: '2', title: 'Development', path: 'Bookmarks Bar/Development', depth: 1 }
    ];
    mockData.bookmarks = [
      { id: 101, title: 'Item 1', url: 'https://example.com/1', folderPath: 'Bookmarks Bar', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b1' },
      { id: 102, title: 'Item 2', url: 'https://example.com/2', folderPath: 'Bookmarks Bar/Development', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b2' }
    ];
    const { BookmarkManager } = await import('../../src/lib/bookmarks/bookmark-manager');
    const getFoldersSpy = vi.spyOn(BookmarkManager, 'getFolders').mockResolvedValue(mockFolders as any);

    const comp: any = new BookmarkList({ target, props: { folders: mockFolders } });
    await comp.loadBookmarks();
    await tick();
    try {
      const treeItems = () => Array.from(document.querySelectorAll('.folder-tree .tree-item'));
      const barItem = treeItems().find(el => el.querySelector('.tree-label')?.textContent === 'Bookmarks Bar') as HTMLElement;
      barItem.click(); // Switch filter to 'Bookmarks Bar' (including subfolders)
      await tick();

      // 2 bookmarks displayed directly + subfolder (Development) under 'Bookmarks Bar' -> select both
      const cardCheckboxes = () => document.querySelectorAll('.bookmark-card input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
      expect(cardCheckboxes().length).toBe(2);
      for (const cb of Array.from(cardCheckboxes())) {
        (cb as HTMLInputElement).checked = true;
        (cb as HTMLInputElement).dispatchEvent(new Event('change'));
      }
      await tick();
      expect(document.querySelectorAll('.bookmark-card.selected').length).toBe(2);

      // Click 'Bookmarks Bar' folder again (same folder) -> selection should be retained
      barItem.click();
      await tick();
      expect(document.querySelectorAll('.bookmark-card.selected').length).toBe(2);

      // Switch to different folder 'Development' -> selection should be cleared
      const devItem = treeItems().find(el => el.querySelector('.tree-label')?.textContent === 'Development') as HTMLElement;
      devItem.click();
      await tick();
      expect(document.querySelectorAll('.bookmark-card.selected').length).toBe(0);

      // Selection should not be retained when switching back (reset state)
      barItem.click();
      await tick();
      expect(document.querySelectorAll('.bookmark-card.selected').length).toBe(0);
    } finally {
      getFoldersSpy.mockRestore();
    }
  });

  it('should exclude bookmarks with archives when excludeArchived is true in delete modal', async () => {
    const { BookmarkManager } = await import('../../src/lib/bookmarks/bookmark-manager');
    const removeBookmarkSpy = vi.spyOn(BookmarkManager, 'removeBookmark').mockResolvedValue(undefined as any);

    mockData.bookmarks = [
      { id: 1, title: 'Archived 1', url: 'https://example.com/1', folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b1' },
      { id: 2, title: 'Non-Archived 2', url: 'https://example.com/2', folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b2' }
    ];
    mockData.archivedPages = [{ id: 10, bookmarkId: 1, url: 'https://example.com/1', title: 'Archived 1', htmlBlob: new Blob() }];

    const comp: any = new BookmarkList({
      target,
      props: { folders: [] }
    });

    await comp.loadBookmarks();
    await tick();

    // Select both bookmarks by checking boxes
    const checkboxes = document.querySelectorAll('.bookmark-card input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
    checkboxes[0].checked = true;
    checkboxes[0].dispatchEvent(new Event('change'));
    checkboxes[1].checked = true;
    checkboxes[1].dispatchEvent(new Event('change'));
    await tick();

    // Click bulk delete button to open modal
    const deleteBtn = document.querySelector('.bulk-actions .btn-danger') as HTMLButtonElement;
    await deleteBtn.click();
    await tick();

    // Verify modal is open and has option texts
    const modal = document.querySelector('.edit-modal');
    expect(modal).not.toBeNull();
    expect(modal?.textContent).toContain('아카이브가 저장된 1개 항목은 보존하고');

    // Click "Delete excluding archive"
    const buttons = modal?.querySelectorAll('.modal-actions button') as NodeListOf<HTMLButtonElement>;
    const excludeBtn = Array.from(buttons).find(b => b.textContent?.includes('아카이브 제외 삭제'));
    expect(excludeBtn).toBeDefined();
    await excludeBtn?.click();
    await tick();

    // Only ID 2 should be deleted (ID 1 archived is excluded)
    expect(removeBookmarkSpy).toHaveBeenCalledTimes(1);
    expect(removeBookmarkSpy).toHaveBeenCalledWith(2);

    removeBookmarkSpy.mockRestore();
  });

  it('should delete all selected bookmarks when 모두 삭제 is clicked in delete modal', async () => {
    const { BookmarkManager } = await import('../../src/lib/bookmarks/bookmark-manager');
    const removeBookmarkSpy = vi.spyOn(BookmarkManager, 'removeBookmark').mockResolvedValue(undefined as any);

    mockData.bookmarks = [
      { id: 1, title: 'Archived 1', url: 'https://example.com/1', folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b1' },
      { id: 2, title: 'Non-Archived 2', url: 'https://example.com/2', folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b2' }
    ];
    mockData.archivedPages = [{ id: 10, bookmarkId: 1, url: 'https://example.com/1', title: 'Archived 1', htmlBlob: new Blob() }];

    const comp: any = new BookmarkList({
      target,
      props: { folders: [] }
    });

    await comp.loadBookmarks();
    await tick();

    const checkboxes = document.querySelectorAll('.bookmark-card input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
    checkboxes[0].checked = true;
    checkboxes[0].dispatchEvent(new Event('change'));
    checkboxes[1].checked = true;
    checkboxes[1].dispatchEvent(new Event('change'));
    await tick();

    // Click bulk delete button to open modal
    const deleteBtn = document.querySelector('.bulk-actions .btn-danger') as HTMLButtonElement;
    await deleteBtn.click();
    await tick();

    const modal = document.querySelector('.edit-modal');
    const buttons = modal?.querySelectorAll('.modal-actions button') as NodeListOf<HTMLButtonElement>;
    const deleteAllBtn = Array.from(buttons).find(b => b.textContent?.includes('모두 삭제'));
    expect(deleteAllBtn).toBeDefined();
    await deleteAllBtn?.click();
    await tick();

    expect(removeBookmarkSpy).toHaveBeenCalledTimes(2);
    expect(removeBookmarkSpy).toHaveBeenCalledWith(1);
    expect(removeBookmarkSpy).toHaveBeenCalledWith(2);

    removeBookmarkSpy.mockRestore();
  });

  it('should send AI_BULK_CATEGORIZE message to background for selected bookmarks', async () => {
    const aiSummarizerModule = await import('../../src/lib/ai/ai-summarizer');
    const toastStoreModule = await import('../../src/lib/ui/toast-store');
    vi.spyOn(aiSummarizerModule, 'isAiConfigured').mockResolvedValue(true);
    const toastSpy = vi.spyOn(toastStoreModule, 'showToast').mockImplementation(() => {});
    const sendMessageSpy = (globalThis as any).browser.runtime.sendMessage as ReturnType<typeof vi.fn>;

    mockData.bookmarks = [
      { id: 1, title: 'Item 1', url: 'https://example.com/1', folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b1' },
      { id: 2, title: 'Item 2', url: 'https://example.com/2', folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b2' }
    ];

    const comp: any = new BookmarkList({
      target,
      props: { folders: [] }
    });

    await comp.loadBookmarks();
    await tick();

    await comp.handleBulkAiCategorize();
    await tick();

    // Batch delegate all uncategorized items (unspecified folder) to background
    expect(sendMessageSpy).toHaveBeenCalledWith({
      type: 'AI_BULK_CATEGORIZE',
      bookmarkIds: [1, 2],
      folders: []
    });
    // Progress/spinner state captured at job start (renders progress bar)
    expect(document.querySelector('.progress-bar-container')).toBeTruthy();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('50개 초과(예: 51개) 미분류 북마크도 개수 제한 없이 background에 정상 위임', async () => {
    const aiSummarizerModule = await import('../../src/lib/ai/ai-summarizer');
    const toastStoreModule = await import('../../src/lib/ui/toast-store');
    vi.spyOn(aiSummarizerModule, 'isAiConfigured').mockResolvedValue(true);
    const toastSpy = vi.spyOn(toastStoreModule, 'showToast').mockImplementation(() => {});
    const sendMessageSpy = (globalThis as any).browser.runtime.sendMessage as ReturnType<typeof vi.fn>;
    sendMessageSpy.mockClear();

    // folderPath '' = directly under system root -> 51 uncategorized bookmarks based on isUncategorizedBookmark
    mockData.bookmarks = Array.from({ length: 51 }, (_, i) => ({
      id: i + 1,
      title: `Item ${i + 1}`,
      url: `https://example.com/${i + 1}`,
      folderPath: '',
      createdAt: Date.now(),
      visitCount: 0,
      bookmarkId: `b${i + 1}`
    }));

    const comp: any = new BookmarkList({
      target,
      props: { folders: [] }
    });
    await comp.loadBookmarks();
    await tick();

    await comp.handleBulkAiCategorize();
    await tick();

    // All 51 delegated to background normally without count limit blocking
    expect(sendMessageSpy).toHaveBeenCalledWith({
      type: 'AI_BULK_CATEGORIZE',
      bookmarkIds: Array.from({ length: 51 }, (_, i) => i + 1),
      folders: []
    });
    expect(toastSpy.mock.calls.some(c => c[0].includes('너무 많습니다'))).toBe(false);
  });

  it('cancels bulk AI categorization when cancel button in BulkActionBar is clicked', async () => {
    const aiSummarizerModule = await import('../../src/lib/ai/ai-summarizer');
    vi.spyOn(aiSummarizerModule, 'isAiConfigured').mockResolvedValue(true);
    const sendMessageSpy = (globalThis as any).browser.runtime.sendMessage as ReturnType<typeof vi.fn>;
    sendMessageSpy.mockClear();

    mockData.bookmarks = [
      { id: 1, title: 'Item 1', url: 'https://example.com/1', folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b1' },
      { id: 2, title: 'Item 2', url: 'https://example.com/2', folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b2' }
    ];

    const comp: any = new BookmarkList({
      target,
      props: { folders: [] }
    });
    await comp.loadBookmarks();
    await tick();

    await comp.handleBulkAiCategorize();
    await tick();

    // In-progress: progress bar is visible
    expect(document.querySelector('.progress-bar-container')).toBeTruthy();

    // AI cancel button in BulkActionBar: hover & click
    const buttons = Array.from(document.querySelectorAll('.bulk-right button')) as HTMLButtonElement[];
    const aiBtn = buttons[0];
    aiBtn.dispatchEvent(new MouseEvent('mouseenter'));
    await tick();

    expect(aiBtn.classList.contains('btn-danger')).toBe(true);
    await aiBtn.click();
    await tick();

    // After cancellation: AI_ABORT_BULK sent and progress-bar removed
    expect(sendMessageSpy).toHaveBeenCalledWith({ type: 'AI_ABORT_BULK' });
    expect(document.querySelector('.progress-bar-container')).toBeNull();
  });

  it('shows loading on bulk summarize button and progress bar, and cancels when cancel button is clicked', async () => {
    const aiSummarizerModule = await import('../../src/lib/ai/ai-summarizer');
    vi.spyOn(aiSummarizerModule, 'isAiConfigured').mockResolvedValue(true);
    const sendMessageSpy = (globalThis as any).browser.runtime.sendMessage as ReturnType<typeof vi.fn>;
    sendMessageSpy.mockClear();

    mockData.bookmarks = [
      { id: 1, title: 'Item 1', url: 'https://example.com/1', folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b1' },
      { id: 2, title: 'Item 2', url: 'https://example.com/2', folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b2' }
    ];

    const comp: any = new BookmarkList({
      target,
      props: { folders: [] }
    });
    await comp.loadBookmarks();
    await tick();

    await comp.handleBulkAiSummarize();
    await tick();

    // AI_BULK_SUMMARIZE message sent
    expect(sendMessageSpy).toHaveBeenCalledWith({
      type: 'AI_BULK_SUMMARIZE',
      bookmarkIds: [1, 2]
    });

    // In-progress: progress bar is visible
    expect(document.querySelector('.progress-bar-container')).toBeTruthy();

    // In BulkActionBar, summarize button (buttons[1]) is loading with spinner
    const buttons = Array.from(document.querySelectorAll('.bulk-right button')) as HTMLButtonElement[];
    const categorizeBtn = buttons[0];
    const summarizeBtn = buttons[1];

    expect(categorizeBtn.disabled).toBe(true);
    expect(summarizeBtn.querySelector('.spinner-inline')).toBeTruthy();

    // Hover summarize button -> switches to cancel button (btn-danger)
    summarizeBtn.dispatchEvent(new MouseEvent('mouseenter'));
    await tick();

    expect(summarizeBtn.classList.contains('btn-danger')).toBe(true);
    expect(summarizeBtn.textContent).toContain('취소');

    // Click cancel while summarizing
    await summarizeBtn.click();
    await tick();

    // After cancellation: AI_ABORT_BULK sent and progress-bar removed
    expect(sendMessageSpy).toHaveBeenCalledWith({ type: 'AI_ABORT_BULK' });
    expect(document.querySelector('.progress-bar-container')).toBeNull();
  });

  it('AI 분석 실패 배지(aiStatus: error)를 클릭하면 해당 북마크 재분석 메시지를 전송한다', async () => {
    mockIsAiConfigured.mockResolvedValue(true);
    const sendMessageSpy = (globalThis as any).browser.runtime.sendMessage as ReturnType<typeof vi.fn>;
    sendMessageSpy.mockClear();

    mockData.bookmarks = [
      { id: 77, title: 'Error Item', url: 'https://example.com/err', folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b77', aiStatus: 'error' }
    ];

    const comp: any = new BookmarkList({
      target,
      props: { folders: [] }
    });
    await comp.loadBookmarks();
    await tick();

    const errorBadge = document.querySelector('.ai-error-badge.retryable') as HTMLButtonElement;
    expect(errorBadge).not.toBeNull();
    expect(errorBadge.textContent).toContain('AI 분석 실패');

    errorBadge.click();
    await new Promise(r => setTimeout(r, 50));
    await tick();

    expect(sendMessageSpy).toHaveBeenCalledWith({
      type: 'AI_BULK_CATEGORIZE',
      bookmarkIds: [77],
      folders: []
    });
  });

  it('편집 모달에서 AI 요약 생성 버튼 클릭 시 요약이 입력 필드에 자동 반영된다', async () => {
    mockIsAiConfigured.mockResolvedValue(true);
    mockAnalyzeContent.mockResolvedValue({
      summary: '편집 모달에서 자동 생성된 간결 요약',
      category: '개발',
      suggestedFolderId: null,
      suggestedFolderName: '개발',
      isNewFolderRecommended: false,
      tags: [],
      confidence: 0.9
    });

    mockData.bookmarks = [
      { id: 88, title: 'Edit Test Item', url: 'https://example.com/edit', folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b88', description: '' }
    ];

    (globalThis as any).browser.bookmarks.get = vi.fn().mockResolvedValue([{ id: 'b88', parentId: '1' }]);

    const comp: any = new BookmarkList({
      target,
      props: { folders: [] }
    });
    await comp.loadBookmarks();
    await tick();

    // Click "Edit" button to open edit modal
    const actionButtons = Array.from(document.querySelectorAll('.card-actions button')) as HTMLButtonElement[];
    const editBtn = actionButtons.find(b => b.textContent?.includes('수정'));
    expect(editBtn).toBeDefined();
    await editBtn?.click();
    await tick();

    const editModal = document.querySelector('.edit-modal');
    expect(editModal).not.toBeNull();

    const aiSummaryBtn = editModal?.querySelector('.btn-outline-ai') as HTMLButtonElement;
    expect(aiSummaryBtn).not.toBeNull();
    expect(aiSummaryBtn.textContent).toContain('AI 요약 생성');

    aiSummaryBtn.click();
    // Deterministic wait: the async summary pipeline (payload build -> analyze -> bind)
    // can exceed a fixed 50ms tick on slower runtimes (CI Node 22 vs local Node 26).
    const descTextarea = editModal?.querySelector('#edit-desc') as HTMLTextAreaElement;
    for (let i = 0; i < 40 && descTextarea.value === ''; i++) {
      await new Promise(r => setTimeout(r, 25));
      await tick();
    }
    expect(descTextarea.value).toBe('편집 모달에서 자동 생성된 간결 요약');
  });

  it('crossRootReview가 있는 북마크가 있으면 상단 배너와 카드 배지가 표시되고 모달에서 적용할 수 있다', async () => {
    const { BookmarkManager } = await import('../../src/lib/bookmarks/bookmark-manager');
    const ensureFolderSpy = vi.spyOn(BookmarkManager, 'ensureFolderPath').mockResolvedValue({ id: 'f-created', path: '기타 북마크/개발/프론트' });
    const updateBookmarkSpy = vi.spyOn(BookmarkManager, 'updateBookmark').mockImplementation(async (id: number, data: any) => {
      const idx = mockData.bookmarks.findIndex(b => b.id === id);
      if (idx !== -1) {
        mockData.bookmarks[idx] = { ...mockData.bookmarks[idx], ...data };
      }
    });

    (globalThis as any).browser.bookmarks.move = vi.fn().mockResolvedValue({ id: 'b501' });

    mockData.bookmarks = [
      {
        id: 501,
        title: 'Cross Root Item',
        url: 'https://example.com/cross',
        folderPath: 'Other bookmarks',
        createdAt: Date.now(),
        visitCount: 0,
        bookmarkId: 'b501',
        crossRootReview: {
          currentRoot: 'Other bookmarks',
          currentFolderPath: 'Other bookmarks',
          suggestedRoot: 'Bookmarks bar',
          suggestedFolderId: 'f-bar',
          suggestedFolderPath: 'Bookmarks bar/개발/프론트',
          cleanPath: '개발/프론트'
        }
      }
    ];

    const comp: any = new BookmarkList({
      target,
      props: { folders: [] }
    });
    await comp.loadBookmarks();
    await tick();

    // 1. Verify top banner displayed
    const banner = document.querySelector('.cross-root-banner');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('다른 위치의 폴더로 이동이 제안된 북마크 1개가 있습니다.');

    // 2. Verify card badge "Pending location check" displayed
    const cardBadge = document.querySelector('.badge-cross-root');
    expect(cardBadge).not.toBeNull();
    expect(cardBadge?.textContent).toContain('위치 확인 대기');

    // 3. Click "Review & Apply" button on banner -> open modal
    const bannerBtn = banner?.querySelector('.banner-action-btn') as HTMLButtonElement;
    expect(bannerBtn).toBeDefined();
    await bannerBtn.click();
    await tick();

    const modal = document.querySelector('.modal-container');
    expect(modal).not.toBeNull();
    expect(modal?.textContent).toContain('다른 위치 폴더 이동 검토');
    expect(modal?.textContent).toContain('Cross Root Item');

    // 4. Select create-here and click apply in modal
    const createOption = Array.from(modal?.querySelectorAll('.choice-option') || []).find(el => el.textContent?.includes('현재 위치에 새 폴더 생성')) as HTMLElement;
    expect(createOption).toBeDefined();
    await createOption.click();
    await tick();

    const applyBtn = Array.from(modal?.querySelectorAll('.modal-footer button') || []).find(b => b.textContent?.includes('적용하기')) as HTMLButtonElement;
    expect(applyBtn).toBeDefined();
    await applyBtn.click();
    await new Promise(r => setTimeout(r, 50));
    await tick();

    // Verify ensureFolderPath call and bookmark update
    expect(ensureFolderSpy).toHaveBeenCalledWith('개발/프론트', 'Other bookmarks');
    expect(updateBookmarkSpy).toHaveBeenCalledWith(501, {
      folderPath: '기타 북마크/개발/프론트',
      crossRootReview: undefined
    });

    ensureFolderSpy.mockRestore();
    updateBookmarkSpy.mockRestore();
  });

  it('storage.local에 ai_bulk_cross_root_review가 있으면 모달이 동기화되고 열린다', async () => {
    (globalThis as any).browser.storage.local.get = vi.fn(async (key?: any) => {
      if (key === 'ai_bulk_cross_root_review' || key === undefined) {
        return {
          ai_bulk_cross_root_review: [
            {
              bookmarkId: 601,
              title: 'Bulk Cross Item',
              url: 'https://example.com/bulk-cross',
              currentFolderPath: 'Other bookmarks',
              currentRoot: 'Other bookmarks',
              suggestedFolderId: 'f-rec',
              suggestedFolderPath: 'Bookmarks bar/추천폴더',
              suggestedRoot: 'Bookmarks bar',
              cleanPath: '추천폴더'
            }
          ]
        };
      }
      return {};
    });

    mockData.bookmarks = [
      {
        id: 601,
        title: 'Bulk Cross Item',
        url: 'https://example.com/bulk-cross',
        folderPath: 'Other bookmarks',
        createdAt: Date.now(),
        visitCount: 0,
        bookmarkId: 'b601'
      }
    ];

    const comp: any = new BookmarkList({
      target,
      props: { folders: [] }
    });
    await comp.loadBookmarks();
    await tick();

    // Verify 1 pending displayed in top banner
    const banner = document.querySelector('.cross-root-banner');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('다른 위치의 폴더로 이동이 제안된 북마크 1개가 있습니다.');

    // Click banner action button to open modal
    const bannerBtn = banner?.querySelector('.banner-action-btn') as HTMLButtonElement;
    expect(bannerBtn).toBeDefined();
    await bannerBtn.click();
    await tick();

    const modal = document.querySelector('.modal-container');
    expect(modal).not.toBeNull();
    expect(modal?.textContent).toContain('다른 위치 폴더 이동 검토');
    expect(modal?.textContent).toContain('Bulk Cross Item');
  });

  it('Bookmarks Bar와 Other Bookmarks에 각각 생성된 폴더가 다를 때 카운트와 필터링이 독립적으로 동작한다', async () => {
    const mockFolders = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', depth: 0 },
      { id: '2', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1', depth: 1 },
      { id: '3', title: 'Other Bookmarks', path: 'Other Bookmarks', depth: 0 },
      { id: '4', title: '커뮤니티', path: 'Other Bookmarks/커뮤니티', parentId: '3', depth: 1 },
      { id: '5', title: '뉴스', path: 'Other Bookmarks/뉴스', parentId: '3', depth: 1 }
    ];

    mockData.bookmarks = [
      // 3 items in Bookmarks Bar/Community
      { id: 701, title: 'Bar Comm 1', url: 'https://example.com/bar-1', folderPath: 'Bookmarks Bar/커뮤니티', createdAt: 3000, visitCount: 0, bookmarkId: 'b701' },
      { id: 702, title: 'Bar Comm 2', url: 'https://example.com/bar-2', folderPath: 'Bookmarks Bar/커뮤니티', createdAt: 2000, visitCount: 0, bookmarkId: 'b702' },
      { id: 703, title: 'Bar Comm 3', url: 'https://example.com/bar-3', folderPath: 'Bookmarks Bar/커뮤니티', createdAt: 1000, visitCount: 0, bookmarkId: 'b703' },
      // 1 item in Other Bookmarks/Community
      { id: 704, title: 'Other Comm 1', url: 'https://example.com/other-1', folderPath: 'Other Bookmarks/커뮤니티', createdAt: 3000, visitCount: 0, bookmarkId: 'b704' },
      // 2 items in Other Bookmarks/News
      { id: 705, title: 'Other News 1', url: 'https://example.com/news-1', folderPath: 'Other Bookmarks/뉴스', createdAt: 3000, visitCount: 0, bookmarkId: 'b705' },
      { id: 706, title: 'Other News 2', url: 'https://example.com/news-2', folderPath: 'Other Bookmarks/뉴스', createdAt: 2000, visitCount: 0, bookmarkId: 'b706' }
    ];

    const { BookmarkManager } = await import('../../src/lib/bookmarks/bookmark-manager');
    const getFoldersSpy = vi.spyOn(BookmarkManager, 'getFolders').mockResolvedValue(mockFolders as any);
    const comp: any = new BookmarkList({ target, props: { folders: mockFolders } });
    await comp.loadBookmarks();
    await tick();

    // Query tree items
    const treeItems = Array.from(document.querySelectorAll('.folder-tree .tree-item'));
    
    // Count for Community under Bookmarks Bar must be exactly 3
    const barCommunityItem = treeItems.find(el => el.querySelector('.tree-label')?.textContent === '커뮤니티' && el.getAttribute('aria-level') === '2');
    expect(barCommunityItem).toBeDefined();

    // When Bookmarks Bar/Community clicked -> only 3 filtered (excluding Community under Other Bookmarks)
    barCommunityItem?.click();
    await tick();

    const displayedBarCards = Array.from(document.querySelectorAll('.bookmark-card .bookmark-title')).map(el => el.textContent);
    expect(displayedBarCards.length).toBe(3);
    expect(displayedBarCards).toEqual(['Bar Comm 1', 'Bar Comm 2', 'Bar Comm 3']);

    // When Other Bookmarks/News clicked -> only 2 filtered
    // Expand Community in Other Bookmarks
    const otherCommunityItem = treeItems.filter(el => el.querySelector('.tree-label')?.textContent === '커뮤니티')[1];
    otherCommunityItem?.click();
    await tick();

    const displayedOtherCards = Array.from(document.querySelectorAll('.bookmark-card .bookmark-title')).map(el => el.textContent);
    expect(displayedOtherCards.length).toBe(1);
    expect(displayedOtherCards).toEqual(['Other Comm 1']);

    getFoldersSpy.mockRestore();
  });
});

describe('BookmarkList.svelte - On-demand cloud archive UI', () => {
  let target: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
    mockData.bookmarks = [];
    mockData.archivedPages = [];
    mockData.settings = {};
    storageListeners.length = 0;
    (globalThis as any).browser.runtime.sendMessage = vi.fn(async () => ({ ok: true }));
  });

  it('should show [아카이브 보기] button without cloud icon for bookmark with local archive', async () => {
    mockData.bookmarks = [
      { id: 101, title: 'Local Archived Page', url: 'https://example.com/local', folderPath: 'Bookmarks Bar', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b101', syncId: 'sync-101' }
    ];
    mockData.archivedPages = [
      { id: 1, bookmarkId: 101, url: 'https://example.com/local', htmlBlob: new Blob(['<html></html>']), fileSize: 100, archivedAt: Date.now() }
    ];

    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await tick();

    const actionButtons = Array.from(document.querySelectorAll('.card-actions button'));
    const archiveBtn = actionButtons.find(b => b.textContent?.includes('아카이브 보기'));
    expect(archiveBtn).toBeDefined();
    expect(archiveBtn?.querySelector('svg path[d*="M18 10h-1.26"]')).toBeNull(); // No cloud icon
  });

  it('should show [아카이브 보기] button with cloud icon for bookmark in cloud index cache only', async () => {
    mockData.bookmarks = [
      { id: 102, title: 'Cloud Only Page', url: 'https://example.com/cloud', folderPath: 'Bookmarks Bar', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b102', syncId: 'sync-102' }
    ];
    mockData.archivedPages = []; // No local archive
    mockData.settings = {
      cloud_archive_index: [
        { syncId: 'sync-102', bookmarkId: 'b102', url: 'https://example.com/cloud', title: 'Cloud Only Page', fileName: 'sync-102.html', fileSize: 500, format: 'html', archivedAt: Date.now() }
      ]
    };

    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await tick();

    const actionButtons = Array.from(document.querySelectorAll('.card-actions button'));
    const archiveBtn = actionButtons.find(b => b.textContent?.includes('아카이브 보기'));
    expect(archiveBtn).toBeDefined();
    expect(archiveBtn?.getAttribute('title')).toBe('클라우드에 저장된 아카이브를 내려받아 엽니다');
    // Cloud icon path: 'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z'
    const cloudSvg = archiveBtn?.querySelector('svg path[d*="M18 10h-1.26"]');
    expect(cloudSvg).not.toBeNull();
  });

  it('should show [아카이브] button for bookmark with neither local nor cloud archive', async () => {
    mockData.bookmarks = [
      { id: 103, title: 'No Archive Page', url: 'https://example.com/none', folderPath: 'Bookmarks Bar', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b103', syncId: 'sync-103' }
    ];
    mockData.archivedPages = [];
    mockData.settings = { cloud_archive_index: [] };

    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await tick();

    const actionButtons = Array.from(document.querySelectorAll('.card-actions button'));
    const archiveBtn = actionButtons.find(b => b.textContent?.trim() === '아카이브');
    expect(archiveBtn).toBeDefined();
    expect(actionButtons.some(b => b.textContent?.includes('아카이브 보기'))).toBe(false);
  });

  it('should request on-demand download via background message and open viewer on success', async () => {
    const bookmark = { id: 104, title: 'Download Me', url: 'https://example.com/dl', folderPath: 'Bookmarks Bar', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b104', syncId: 'sync-104' };
    mockData.bookmarks = [bookmark];
    mockData.archivedPages = [];
    mockData.settings = {
      cloud_archive_index: [
        { syncId: 'sync-104', bookmarkId: 'b104', url: 'https://example.com/dl', title: 'Download Me', fileName: 'sync-104.html', fileSize: 500, format: 'html', archivedAt: Date.now() }
      ]
    };

    const sendMessageMock = vi.fn(async (msg: any) => {
      if (msg.type === 'ARCHIVE_DOWNLOAD_ON_DEMAND') {
        mockData.archivedPages.push({
          id: 10,
          bookmarkId: 104,
          url: 'https://example.com/dl',
          htmlBlob: new Blob(['<html>downloaded</html>']),
          fileSize: 500,
          archivedAt: Date.now()
        });
        return { ok: true };
      }
      return { ok: false };
    });
    (globalThis as any).browser.runtime.sendMessage = sendMessageMock;

    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await tick();

    const archiveBtn = Array.from(document.querySelectorAll('.card-actions button')).find(b => b.textContent?.includes('아카이브 보기')) as HTMLButtonElement;
    expect(archiveBtn).toBeDefined();

    await archiveBtn.click();
    await tick();

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'ARCHIVE_DOWNLOAD_ON_DEMAND',
      syncId: 'sync-104'
    });

    // After success, local archive is loaded
    expect(mockData.archivedPages.length).toBe(1);
  });

  it('should handle on-demand download failure and reset loading state', async () => {
    const bookmark = { id: 105, title: 'Fail DL', url: 'https://example.com/fail', folderPath: 'Bookmarks Bar', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b105', syncId: 'sync-105' };
    mockData.bookmarks = [bookmark];
    mockData.archivedPages = [];
    mockData.settings = {
      cloud_archive_index: [
        { syncId: 'sync-105', bookmarkId: 'b105', url: 'https://example.com/fail', title: 'Fail DL', fileName: 'sync-105.html', fileSize: 500, format: 'html', archivedAt: Date.now() }
      ]
    };

    const sendMessageMock = vi.fn(async () => ({
      ok: false,
      error: '인증 실패'
    }));
    (globalThis as any).browser.runtime.sendMessage = sendMessageMock;

    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await tick();

    const archiveBtn = Array.from(document.querySelectorAll('.card-actions button')).find(b => b.textContent?.includes('아카이브 보기')) as HTMLButtonElement;
    await archiveBtn.click();
    await tick();

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'ARCHIVE_DOWNLOAD_ON_DEMAND',
      syncId: 'sync-105'
    });

    // Button should still be present and not stuck in downloading state
    const afterButtons = Array.from(document.querySelectorAll('.card-actions button'));
    const retryBtn = afterButtons.find(b => b.textContent?.includes('아카이브 보기'));
    expect(retryBtn).toBeDefined();
    expect(retryBtn?.textContent).not.toContain('다운로드 중...');
  });

  it('should show [아카이브 보기] button and download by URL fallback when bookmark lacks syncId', async () => {
    const bookmark = { id: 106, title: 'No SyncId Page', url: 'https://example.com/url-match', folderPath: 'Bookmarks Bar', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b106' };
    mockData.bookmarks = [bookmark];
    mockData.archivedPages = [];
    mockData.settings = {
      cloud_archive_index: [
        { syncId: 'sync-cloud-matched', bookmarkId: 'b999', url: 'https://example.com/url-match', title: 'Cloud Page', fileName: 'sync-cloud-matched.html', fileSize: 600, format: 'html', archivedAt: Date.now() }
      ]
    };

    const sendMessageMock = vi.fn(async (msg: any) => {
      if (msg.type === 'ARCHIVE_DOWNLOAD_ON_DEMAND') {
        mockData.archivedPages.push({
          id: 11,
          bookmarkId: 106,
          url: 'https://example.com/url-match',
          htmlBlob: new Blob(['<html>url matched download</html>']),
          fileSize: 600,
          archivedAt: Date.now()
        });
        return { ok: true, page: mockData.archivedPages[0] };
      }
      if (msg.type === 'ARCHIVE_INDEX_REFRESH') {
        return { ok: true, entries: mockData.settings.cloud_archive_index };
      }
      return { ok: true };
    });
    (globalThis as any).browser.runtime.sendMessage = sendMessageMock;

    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await tick();

    const actionButtons = Array.from(document.querySelectorAll('.card-actions button'));
    const archiveBtn = actionButtons.find(b => b.textContent?.includes('아카이브 보기')) as HTMLButtonElement;
    expect(archiveBtn).toBeDefined();

    await archiveBtn.click();
    await tick();

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'ARCHIVE_DOWNLOAD_ON_DEMAND',
      syncId: 'sync-cloud-matched'
    });
  });

  it('should update cloud archive maps and display archive button when ARCHIVE_INDEX_REFRESH responds', async () => {
    const bookmark = { id: 107, title: 'Refresh Page', url: 'https://example.com/refresh-target', folderPath: 'Bookmarks Bar', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b107', syncId: 'sync-107' };
    mockData.bookmarks = [bookmark];
    mockData.archivedPages = [];
    mockData.settings = { cloud_archive_index: [] }; // initially empty cache

    const sendMessageMock = vi.fn(async (msg: any) => {
      if (msg.type === 'ARCHIVE_INDEX_REFRESH') {
        return {
          ok: true,
          entries: [
            { syncId: 'sync-107', bookmarkId: 'b107', url: 'https://example.com/refresh-target', title: 'Refresh Page', fileName: 'sync-107.html', fileSize: 500, format: 'html', archivedAt: Date.now() }
          ]
        };
      }
      return { ok: true };
    });
    (globalThis as any).browser.runtime.sendMessage = sendMessageMock;

    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await tick();
    await new Promise((r) => setTimeout(r, 10));
    await tick();

    const actionButtons = Array.from(document.querySelectorAll('.card-actions button'));
    const archiveBtn = actionButtons.find(b => b.textContent?.includes('아카이브 보기'));
    expect(archiveBtn).toBeDefined();
  });

  it('should switch to Save Archive button immediately when a synced archive is deleted', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const bookmark = { id: 109, title: 'Synced Archive Delete Test', url: 'https://example.com/sync-del', folderPath: 'Bookmarks Bar', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b109', syncId: 'sync-109' };
    mockData.bookmarks = [bookmark];
    mockData.archivedPages = [
      { id: 99, bookmarkId: 109, url: 'https://example.com/sync-del', htmlBlob: new Blob(['test']), fileSize: 100, archivedAt: Date.now() }
    ];
    mockData.settings = {
      cloud_archive_index: [
        { syncId: 'sync-109', bookmarkId: 'b109', url: 'https://example.com/sync-del', title: 'Synced Archive Delete Test', fileName: 'sync-109.html', fileSize: 100, format: 'html', archivedAt: Date.now() }
      ]
    };

    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await tick();

    // Verify initial state has "View Archive"
    let actionButtons = Array.from(document.querySelectorAll('.card-actions button'));
    let archiveBtn = actionButtons.find(b => b.textContent?.includes('아카이브 보기'));
    expect(archiveBtn).toBeDefined();

    // Delete archive
    await comp.deleteArchive(99);
    await tick();

    // Verify cloud cache is cleared and button is now save archive (not view archive)
    expect(mockData.settings.cloud_archive_index).toEqual([]);
    actionButtons = Array.from(document.querySelectorAll('.card-actions button'));
    archiveBtn = actionButtons.find(b => b.textContent?.includes('아카이브 보기'));
    expect(archiveBtn).toBeUndefined();
    const saveBtn = actionButtons.find(b => b.textContent?.includes('아카이브'));
    expect(saveBtn).toBeDefined();
  });

  it('should update saving state on archive_capture_state and reload archive map on archive_capture_last_update', async () => {
    const bookmark = { id: 108, title: 'Live Archive Page', url: 'https://example.com/live', folderPath: 'Bookmarks Bar', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b108', syncId: 'sync-108' };
    mockData.bookmarks = [bookmark];
    mockData.archivedPages = [];

    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await tick();

    // 1. Initially no archive exists
    let actionButtons = Array.from(document.querySelectorAll('.card-actions button'));
    let saveBtn = actionButtons.find(b => b.textContent?.includes('아카이브')) as HTMLButtonElement;
    expect(saveBtn).toBeDefined();
    expect(saveBtn.textContent).not.toContain('저장 중');

    // 2. Storage event: archive_capture_state indicates bookmark 108 is currently archiving
    for (const listener of storageListeners) {
      listener({ archive_capture_state: { newValue: { bookmarkId: 108, startedAt: Date.now() } } }, 'local');
    }
    await tick();

    // Now button should show 'Saving...'
    actionButtons = Array.from(document.querySelectorAll('.card-actions button'));
    saveBtn = actionButtons.find(b => b.textContent?.includes('저장 중')) as HTMLButtonElement;
    expect(saveBtn).toBeDefined();

    // 3. Mock archive completion in DB
    mockData.archivedPages = [{ id: 1, bookmarkId: 108, url: 'https://example.com/live', htmlBlob: new Blob(['test']), fileSize: 10, archivedAt: Date.now() }];

    // Storage event: archive_capture_state cleared + archive_capture_last_update fired
    for (const listener of storageListeners) {
      listener({
        archive_capture_state: { oldValue: { bookmarkId: 108, startedAt: Date.now() }, newValue: undefined },
        archive_capture_last_update: { newValue: Date.now() }
      }, 'local');
    }
    await new Promise((r) => setTimeout(r, 150));
    await tick();

    // Now button should switch to 'View Archive'
    actionButtons = Array.from(document.querySelectorAll('.card-actions button'));
    const archiveBtn = actionButtons.find(b => b.textContent?.includes('아카이브 보기'));
    expect(archiveBtn).toBeDefined();
  });

  it('should include non-404 errors (5xx, timeout, error) in the link check completion count', async () => {
    const toastStoreModule = await import('../../src/lib/ui/toast-store');
    const toastSpy = vi.spyOn(toastStoreModule, 'showToast').mockImplementation(() => {});

    const testBookmarks = [
      { id: 201, title: 'OK Link', url: 'https://example.com/ok', folderPath: 'Bookmarks Bar', createdAt: Date.now(), bookmarkId: 'b201' },
      { id: 202, title: '500 Server Error Link', url: 'https://example.com/500', folderPath: 'Bookmarks Bar', createdAt: Date.now(), bookmarkId: 'b202' },
      { id: 203, title: 'Timeout Link', url: 'https://example.com/timeout', folderPath: 'Bookmarks Bar', createdAt: Date.now(), bookmarkId: 'b203' },
      { id: 204, title: '404 Dead Link', url: 'https://example.com/404', folderPath: 'Bookmarks Bar', createdAt: Date.now(), bookmarkId: 'b204' }
    ];
    mockData.bookmarks = [...testBookmarks];

    const { bulkScanController } = await import('../../src/lib/bulk-scan-controller');
    const startSpy = vi.spyOn(bulkScanController, 'start').mockImplementation((ids, onComplete) => {
      const results: any[] = [
        { bookmarkId: 201, url: 'https://example.com/ok', status: 'ok', httpStatus: 200 },
        { bookmarkId: 202, url: 'https://example.com/500', status: 'server_error', httpStatus: 500 },
        { bookmarkId: 203, url: 'https://example.com/timeout', status: 'timeout' },
        { bookmarkId: 204, url: 'https://example.com/404', status: 'dead', httpStatus: 404 }
      ];
      bulkScanController.store.update((s) => ({
        ...s,
        healthResults: new Map(results.map((r) => [r.bookmarkId, r]))
      }));
      onComplete?.(results);
      return Promise.resolve();
    });

    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await tick();

    const buttons = Array.from(document.querySelectorAll('.bulk-right button')) as HTMLButtonElement[];
    const checkLinksBtn = buttons.find(b => b.textContent?.includes('링크 점검'));
    expect(checkLinksBtn).toBeDefined();

    await checkLinksBtn?.click();
    await tick();

    expect(startSpy).toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('3'), 'success');

    // Verify broken filter is auto-applied and only 3 error cards are displayed
    await tick();
    const cards = document.querySelectorAll('.bookmark-card');
    expect(cards.length).toBe(3);

    startSpy.mockRestore();
    toastSpy.mockRestore();
  });

  it('대시보드 태그 드릴다운(?tag=...) 단일 소비 및 replaceState URL 정리', async () => {
    mockData.bookmarks = [
      { id: 301, title: 'TS Docs', url: 'https://ts.dev', tags: ['typescript', 'docs'] },
      { id: 302, title: 'Svelte Docs', url: 'https://svelte.dev', tags: ['svelte'] }
    ];

    const replaceSpy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    const origSearch = window.location.search;
    delete (window as any).location;
    (window as any).location = new URL('http://localhost/management.html?tab=bookmarks&tag=typescript');

    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await tick();

    // Verify tag filter was applied
    const cards = document.querySelectorAll('.bookmark-card');
    expect(cards.length).toBe(1);
    expect(cards[0].textContent).toContain('TS Docs');

    // Verify replaceState cleaned up the query
    expect(replaceSpy).toHaveBeenCalledWith(
      { tab: 'bookmarks' },
      '',
      '/management.html?tab=bookmarks'
    );

    replaceSpy.mockRestore();
    delete (window as any).location;
    (window as any).location = new URL('http://localhost/management.html' + origSearch);
  });
});

