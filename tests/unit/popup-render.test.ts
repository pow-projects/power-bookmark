import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tick } from 'svelte';
import App from '../../src/entrypoints/popup/App.svelte';

/**
 * popup App.svelte integrated render test — verifies "whether bookmark title and
 * folder list are displayed in popup UI when clicking extension button".
 *
 * Before fixing the root cause (TDZ) of t_493c01a2, onMount's Promise.all aborted with
 * ReferenceError, so title (#title) and folder dropdown did not render at all.
 * These tests catch that regression.
 */

// Globally mock browser API/storage accessed in onMount
const mockTabsQuery = vi.fn();
const mockBookmarksGet = vi.fn();
const mockBookmarksCreate = vi.fn();
const mockBookmarksMove = vi.fn();
const mockTabsCreate = vi.fn();
const mockRuntimeSendMessage = vi.fn().mockResolvedValue({});
const mockSetTaskIndicator = vi.fn().mockResolvedValue(undefined);

// db.settings store (key -> {value})
const settingsStore = new Map<string, any>();

// Mock db
vi.mock('../../src/lib/db', () => {
  function makeTable(name: string) {
    const rows: any[] = [];
    const table: any = {
      where: () => ({
        equals: () => ({
          count: async () => 0,
          first: async () => undefined,
          toArray: async () => []
        })
      }),
      get: async () => undefined,
      add: async (r: any) => { rows.push(r); return rows.length; },
      update: async () => {},
      count: async () => 0
    };
    return table;
  }
  const db: any = {
    bookmarks: makeTable('bookmarks'),
    archivedPages: makeTable('archivedPages'),
    settings: {
      get: async (key: string) => settingsStore.has(key) ? { key, value: settingsStore.get(key) } : undefined,
      put: async (item: { key: string; value: any }) => { settingsStore.set(item.key, item.value); }
    }
  };
  return { db, default: db };
});

// Mock BookmarkManager
vi.mock('../../src/lib/bookmarks/bookmark-manager', () => ({
  BookmarkManager: {
    getFolders: vi.fn().mockResolvedValue([]),
    findDuplicate: vi.fn().mockResolvedValue(undefined),
    createBookmark: vi.fn(),
    updateBookmark: vi.fn().mockResolvedValue(undefined),
    removeBookmark: vi.fn().mockResolvedValue(undefined),
    ensureFolderPath: vi.fn()
  }
}));

// Mock other popup dependencies
vi.mock('../../src/lib/ai/ai-summarizer', () => ({
  isAiConfigured: vi.fn().mockResolvedValue(false),
  type: {}
}));
vi.mock('../../src/lib/archive/page-capture', () => ({
  archiveBookmark: vi.fn().mockResolvedValue(undefined),
  decompressArchiveHtml: vi.fn()
}));
vi.mock('../../src/lib/bookmarks/badge-manager', () => ({
  setTaskIndicator: (...args: any[]) => mockSetTaskIndicator(...args)
}));
vi.mock('../../src/lib/archive/archive-viewer', () => ({
  buildArchiveBannerHtml: vi.fn(() => '')
}));
vi.mock('../../src/lib/archive/archive-cloud', () => ({
  getCloudArchiveIndexCache: vi.fn().mockResolvedValue([])
}));

import { BookmarkManager } from '../../src/lib/bookmarks/bookmark-manager';

const SAMPLE_FOLDERS = [
  { id: '1', title: '북마크바', path: '북마크바', parentId: '0', depth: 0, displayName: '북마크바' },
  { id: '2', title: '개발', path: '북마크바/개발', parentId: '1', depth: 1, displayName: '개발' }
];

function stubBrowser() {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn()
  }));
  vi.stubGlobal('browser', {
    tabs: {
      query: mockTabsQuery,
      create: mockTabsCreate,
      sendMessage: vi.fn().mockResolvedValue({ html: '<html>test</html>', iframeSources: {} })
    },
    bookmarks: { get: mockBookmarksGet, create: mockBookmarksCreate, move: mockBookmarksMove },
    runtime: {
      sendMessage: mockRuntimeSendMessage,
      getURL: (p: string) => p
    },
    i18n: {
      getMessage: vi.fn((k: string) => k)
    }
  });
}

async function mountApp(waitMs = 20) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = new App({ target, props: {} });
  // onMount + wait for async initialization
  await tick();
  await new Promise((r) => setTimeout(r, waitMs));
  await tick();
  return { component, target };
}

describe('popup App.svelte — 제목·폴더 목록 표시 (t_493c01a2)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    settingsStore.clear();
    vi.clearAllMocks();
    mockTabsQuery.mockReset();
    mockBookmarksGet.mockReset();
    mockBookmarksCreate.mockReset();
    mockTabsCreate.mockReset();
    mockRuntimeSendMessage.mockResolvedValue({});
    mockSetTaskIndicator.mockResolvedValue(undefined);
    stubBrowser();
  });

  it('활성 탭이 있으면 onMount 후 제목 입력값이 페이지 제목으로 채워진다', async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/page', title: 'Example Page Title', active: true }
    ]);
    (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);
    (BookmarkManager.findDuplicate as any).mockResolvedValue(undefined);
    (BookmarkManager.createBookmark as any).mockResolvedValue({ id: 7, title: 'Example Page Title' });

    const { target } = await mountApp();

    const titleInput = target.querySelector('#title') as HTMLInputElement | null;
    expect(titleInput).not.toBeNull();
    expect(titleInput!.value).toBe('Example Page Title');
  });

  it('폴더 목록을 렌더링하고 기본 폴더를 선택한다 (폴더 목록 표시)', async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/page', title: 'Example Page Title', active: true }
    ]);
    (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);
    (BookmarkManager.findDuplicate as any).mockResolvedValue(undefined);
    (BookmarkManager.createBookmark as any).mockResolvedValue({ id: 8, title: 'Example Page Title' });

    const { target } = await mountApp();

    // Open dropdown
    const trigger = target.querySelector('.select-trigger') as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    await trigger!.click();
    await tick();

    const options = target.querySelectorAll('.option-item');
    // Folder count + (not empty)
    expect(options.length).toBe(SAMPLE_FOLDERS.length);
    expect(options[0].textContent).toContain('북마크바');
    expect(options[1].textContent).toContain('개발');
  });

  it('폴더 목록이 비어 있으면 빈 목록 안내가 표시된다', async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/page', title: 'Example Page Title', active: true }
    ]);
    (BookmarkManager.getFolders as any).mockResolvedValue([]);
    (BookmarkManager.findDuplicate as any).mockResolvedValue(undefined);
    (BookmarkManager.createBookmark as any).mockResolvedValue({ id: 9, title: 'Example Page Title' });

    const { target } = await mountApp();

    // Form should render without loading/errors
    const titleInput = target.querySelector('#title') as HTMLInputElement | null;
    expect(titleInput).not.toBeNull();

    // Empty list guide UI must exist (displayed in defined UI)
    const emptyHint = target.querySelector('.folder-empty-hint');
    expect(emptyHint).not.toBeNull();
  });

  it('폴더 로딩 실패 시 오류 안내가 표시된다', async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/page', title: 'Example Page Title', active: true }
    ]);
    (BookmarkManager.getFolders as any)
      // mockRejectedValueOnce: lazily create to reject immediately at call time (without shallow reject stack) —
      // Promise.reject(...) created eagerly before execution is caught as Vitest unhandled-rejection.
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'));
    (BookmarkManager.findDuplicate as any).mockResolvedValue(undefined);
    (BookmarkManager.createBookmark as any).mockResolvedValue({ id: 10, title: 'Example Page Title' });

    // Since loadFoldersWithRetry finalizes failure after 200ms retry,
    // wait 300ms so second getFolders (promise reject) is consumed.
    const { target } = await mountApp(300);

    const emptyHint = target.querySelector('.folder-empty-hint');
    // Failure -> should display as empty list guide (defined UI)
    expect(emptyHint).not.toBeNull();
  });

  it('아카이브 저장 버튼 클릭 시 ARCHIVE_CAPTURE_BOOKMARK 메시지를 백그라운드로 전송한다', async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/page', title: 'Example Page Title', active: true }
    ]);
    (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);
    (BookmarkManager.findDuplicate as any).mockResolvedValue(undefined);
    (BookmarkManager.createBookmark as any).mockResolvedValue({ id: 10, title: 'Example Page Title' });
    mockRuntimeSendMessage.mockResolvedValue({ ok: true });

    const { target } = await mountApp();

    const buttons = target.querySelectorAll('button');
    const archiveBtn = Array.from(buttons).find(b => b.textContent?.includes('아카이브 저장') || b.classList.contains('action-primary'));
    expect(archiveBtn).toBeDefined();

    await archiveBtn?.click();
    await tick();
    await new Promise((r) => setTimeout(r, 20));
    await tick();

    expect(mockRuntimeSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ARCHIVE_CAPTURE_BOOKMARK',
        bookmarkId: 10,
        pageUrl: 'https://example.com/page',
        pageTitle: 'Example Page Title'
      })
    );
  });
});
