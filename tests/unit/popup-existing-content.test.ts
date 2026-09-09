import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tick } from 'svelte';
import App from '../../src/entrypoints/popup/App.svelte';

/**
 * popup App.svelte integrated render test — "Display existing content for already registered bookmark" (t_d4cda30f)
 *
 * Scenario: When the current page is already registered as a bookmark and user clicks the extension button:
 *  1) findDuplicate result is reflected, entering edit mode (isEditMode)
 *  2) existing title and folderId are bound to UI as-is
 *  3) no duplicate bookmark is created (createBookmark not called).
 *
 * This regression test ensures that if the TDZ bug (App.svelte onMount Promise.all referencing lastFolderSetting
 * before initialization) reoccurs, onMount won't fail after line 162, breaking findDuplicate reflection and auto-create branches.
 */

const settingsStore = new Map<string, any>();

vi.mock('../../src/lib/db', () => {
  function makeTable() {
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
    bookmarks: makeTable(),
    archivedPages: makeTable(),
    settings: {
      get: async (key: string) => settingsStore.has(key) ? { key, value: settingsStore.get(key) } : undefined,
      put: async (item: { key: string; value: any }) => { settingsStore.set(item.key, item.value); }
    }
  };
  return { db, default: db };
});

const mockTabsQuery = vi.fn();
const mockBookmarksGet = vi.fn();
const mockBookmarksMove = vi.fn();
const mockTabsCreate = vi.fn();
const mockRuntimeSendMessage = vi.fn().mockResolvedValue({});
const mockSetTaskIndicator = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/lib/bookmarks/bookmark-manager', () => ({
  BookmarkManager: {
    getFolders: vi.fn().mockResolvedValue([]),
    findDuplicate: vi.fn().mockResolvedValue(undefined),
    createBookmark: vi.fn().mockResolvedValue(undefined),
    updateBookmark: vi.fn().mockResolvedValue(undefined),
    removeBookmark: vi.fn().mockResolvedValue(undefined),
    ensureFolderPath: vi.fn()
  }
}));
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
  vi.stubGlobal('browser', {
    tabs: { query: mockTabsQuery, create: mockTabsCreate },
    bookmarks: { get: mockBookmarksGet, move: mockBookmarksMove },
    runtime: {
      sendMessage: mockRuntimeSendMessage,
      getURL: (p: string) => p
    },
    i18n: {
      getMessage: vi.fn((k: string) => k)
    }
  });
}

async function mountApp() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = new App({ target, props: {} });
  await tick();
  await new Promise((r) => setTimeout(r, 20));
  await tick();
  return { component, target };
}

describe('popup App.svelte — 이미 등록된 북마크 기존 내용 표시 (t_d4cda30f)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    settingsStore.clear();
    vi.clearAllMocks();
    mockTabsQuery.mockReset();
    mockBookmarksGet.mockReset();
    mockBookmarksMove.mockReset();
    mockTabsCreate.mockReset();
    mockRuntimeSendMessage.mockResolvedValue({});
    mockSetTaskIndicator.mockResolvedValue(undefined);
    stubBrowser();
  });

  it('기존 북마크가 있으면 findDuplicate 결과의 제목이 title 입력값으로 바인딩된다', async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/page', title: 'Example Page Title', active: true }
    ]);
    (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);
    (BookmarkManager.findDuplicate as any).mockResolvedValue({
      id: 42,
      syncId: 'sync-42',
      bookmarkId: 'bm-42',
      url: 'https://example.com/page',
      title: '기존 등록 제목',
      description: '기존 설명',
      folderPath: '북마크바/개발'
    });

    const { target } = await mountApp();

    const titleInput = target.querySelector('#title') as HTMLInputElement | null;
    expect(titleInput).not.toBeNull();
    // Existing registered bookmark title should be displayed instead of page title
    expect(titleInput!.value).toBe('기존 등록 제목');
  });

  it('기존 북마크가 있으면 수정 모드로 진입하고 새 북마크를 생성하지 않는다', async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/page', title: 'Example Page Title', active: true }
    ]);
    (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);
    (BookmarkManager.findDuplicate as any).mockResolvedValue({
      id: 42,
      syncId: 'sync-42',
      bookmarkId: 'bm-42',
      url: 'https://example.com/page',
      title: '기존 등록 제목',
      description: '',
      folderPath: '북마크바/개발'
    });

    const { target } = await mountApp();

    // No duplicate registration allowed -> createBookmark must not be called
    expect(BookmarkManager.createBookmark).not.toHaveBeenCalled();

    // Enter edit mode -> delete button (btn-danger) is displayed
    const dangerBtn = target.querySelector('.btn-danger');
    expect(dangerBtn).not.toBeNull();
    expect(target.textContent).toContain('삭제');
  });

  it('기존 북마크의 폴더가 browser.bookmarks.get(parentId)로 역매칭되어 드롭다운에 선택된다', async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/page', title: 'Example Page Title', active: true }
    ]);
    (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);
    (BookmarkManager.findDuplicate as any).mockResolvedValue({
      id: 42,
      syncId: 'sync-42',
      bookmarkId: 'bm-42',
      url: 'https://example.com/page',
      title: '기존 등록 제목',
      description: '',
      folderPath: '북마크바/개발'
    });
    // browser.bookmarks.get -> returns parent folder id='2' (Development)
    mockBookmarksGet.mockResolvedValue([{ id: 'bm-42', parentId: '2', title: '기존 등록 제목' }]);

    const { target } = await mountApp();

    const selectedText = target.querySelector('.selected-text');
    expect(selectedText).not.toBeNull();
    // Folder containing existing bookmark (Development) is displayed in dropdown
    expect(selectedText!.textContent).toContain('개발');
  });

  it('클라우드 아카이브 인덱스에 URL이 일치하는 항목이 있으면 checkHasArchive가 true로 판별된다', async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/url-archive-match', title: 'URL Match Page', active: true }
    ]);
    (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);
    (BookmarkManager.findDuplicate as any).mockResolvedValue({
      id: 55,
      // v2 invariant: DB records always have a deterministic syncId (AGENTS.md). checkHasArchive's
      // cloud check matches index by syncId, so without syncId in mock, true cannot be determined.
      syncId: 'sync-cloud-55',
      url: 'https://example.com/url-archive-match',
      title: 'URL Match Page',
      description: '',
      folderPath: '북마크바'
    });

    const archiveCloudModule = await import('../../src/lib/archive/archive-cloud');
    vi.spyOn(archiveCloudModule, 'getCloudArchiveIndexCache').mockResolvedValue([
      {
        syncId: 'sync-cloud-55',
        bookmarkId: 'bm-55',
        url: 'https://example.com/url-archive-match',
        title: 'URL Match Page',
        fileName: 'sync-cloud-55.html',
        fileSize: 1024,
        format: 'raw',
        archivedAt: Date.now()
      }
    ]);

    const { target } = await mountApp();

    // hasArchive=true is passed to ActionButtons, rendering the view archive button
    expect(target.textContent).toContain('아카이브 보기');
  });
});
