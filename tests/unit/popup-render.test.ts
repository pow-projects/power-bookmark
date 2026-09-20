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

const mockGetAiSettings = vi.fn().mockResolvedValue({
  provider: 'none',
  autoSummarize: false,
  autoTags: true,
  autoFolder: true
});

// Mock other popup dependencies
vi.mock('../../src/lib/ai/ai-summarizer', () => ({
  isAiConfigured: vi.fn().mockResolvedValue(false),
  getAiSettings: () => mockGetAiSettings(),
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

const storageLocalData = new Map<string, any>();
const mockStorageLocal = {
  get: vi.fn(async (key: string | string[] | Record<string, any>) => {
    if (typeof key === 'string') {
      return { [key]: storageLocalData.get(key) };
    }
    if (Array.isArray(key)) {
      const res: Record<string, any> = {};
      for (const k of key) res[k] = storageLocalData.get(k);
      return res;
    }
    return Object.fromEntries(storageLocalData.entries());
  }),
  set: vi.fn(async (obj: Record<string, any>) => {
    for (const [k, v] of Object.entries(obj)) {
      storageLocalData.set(k, v);
    }
  }),
  remove: vi.fn(async (key: string) => {
    storageLocalData.delete(key);
  })
};

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
    storage: {
      local: mockStorageLocal,
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      }
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
    storageLocalData.clear();
    vi.clearAllMocks();
    mockTabsQuery.mockReset();
    mockBookmarksGet.mockReset();
    mockBookmarksCreate.mockReset();
    mockTabsCreate.mockReset();
    mockRuntimeSendMessage.mockResolvedValue({});
    mockSetTaskIndicator.mockResolvedValue(undefined);
    stubBrowser();
  });

  it('활성 탭이 있으면 onMount 후 클라우드 동기화 상태 배지가 렌더링된다', async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/page', title: 'Example Page Title', active: true }
    ]);
    (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);
    (BookmarkManager.findDuplicate as any).mockResolvedValue(undefined);

    const { target } = await mountApp();

    const syncBadge = target.querySelector('.sync-badge');
    expect(syncBadge).not.toBeNull();
    expect(syncBadge?.getAttribute('title')).toBeTruthy();
  });

  it('AI 자동화 옵션(요약, 태그, 폴더) 토글 스위치가 렌더링된다', async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/page', title: 'Example Page Title', active: true }
    ]);
    (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);
    (BookmarkManager.findDuplicate as any).mockResolvedValue(undefined);

    const { target } = await mountApp();

    expect(target.querySelector('#toggle-auto-summarize')).not.toBeNull();
    expect(target.querySelector('#toggle-auto-tags')).not.toBeNull();
    expect(target.querySelector('#toggle-auto-folder')).not.toBeNull();
  });

  it('AI 옵션 행에 설명 툴팁(title 속성)이 제공된다', async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/page', title: 'Example Page Title', active: true }
    ]);
    (BookmarkManager.getFolders as any).mockResolvedValue([]);
    (BookmarkManager.findDuplicate as any).mockResolvedValue(undefined);

    const { target } = await mountApp();

    const toggleRows = target.querySelectorAll('.toggle-row');
    expect(toggleRows.length).toBe(3);
    for (const row of Array.from(toggleRows)) {
      expect(row.getAttribute('title')).toBeTruthy();
    }
  });

  it('미등록 상태에서는 [북마크 저장] 버튼 없이 단일 [아카이브 저장] 버튼만 표시된다', async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/page', title: 'Example Page Title', active: true }
    ]);
    (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);
    (BookmarkManager.findDuplicate as any).mockResolvedValue(undefined);

    const { target } = await mountApp();

    expect(target.querySelector('.btn-save-bookmark')).toBeNull();
    const archiveBtn = target.querySelector('.btn-archive-bookmark');
    expect(archiveBtn).not.toBeNull();
    expect(archiveBtn?.textContent).toContain('아카이브 저장');
  });

  it('아카이브 저장 버튼 클릭 시 ARCHIVE_CAPTURE_BOOKMARK 메시지를 백그라운드로 전송한다', async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/page', title: 'Example Page Title', active: true }
    ]);
    (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);
    (BookmarkManager.findDuplicate as any).mockResolvedValue({
      id: 10,
      syncId: 'sync-10',
      bookmarkId: 'bm-10',
      url: 'https://example.com/page',
      title: 'Example Page Title',
      folderPath: '북마크바'
    });
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

  it('아카이브 진행 중일 때 팝업을 열면 버튼에 스피너 로딩 표시가 나타나고 비활성화된다', async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/page', title: 'Example Page Title', active: true }
    ]);
    (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);
    (BookmarkManager.findDuplicate as any).mockResolvedValue({
      id: 10,
      syncId: 'sync-10',
      bookmarkId: 'bm-10',
      url: 'https://example.com/page',
      title: 'Example Page Title',
      folderPath: '북마크바'
    });
    storageLocalData.set('archive_capture_state', {
      bookmarkId: 10,
      startedAt: Date.now()
    });

    const { target } = await mountApp();

    const buttons = target.querySelectorAll('button');
    const primaryBtn = Array.from(buttons).find(b => b.classList.contains('action-primary'));
    expect(primaryBtn).toBeDefined();
    expect(primaryBtn?.disabled).toBe(true);
    expect(primaryBtn?.querySelector('.spin')).not.toBeNull();
    expect(primaryBtn?.textContent).toContain('저장 중');
  });

  it('AI Provider가 none일 때 토글 스위치들이 비활성화되고 AI 설정 바로가기 버튼이 가운데 표시된다', async () => {
    mockGetAiSettings.mockResolvedValue({
      provider: 'none',
      autoSummarize: false,
      autoTags: true,
      autoFolder: true
    });
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/page', title: 'Example Page Title', active: true }
    ]);
    (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);
    (BookmarkManager.findDuplicate as any).mockResolvedValue(undefined);

    const { target } = await mountApp();

    // Verify toggle switches are disabled
    const summarizeToggle = target.querySelector('#toggle-auto-summarize') as HTMLInputElement;
    const tagsToggle = target.querySelector('#toggle-auto-tags') as HTMLInputElement;
    const folderToggle = target.querySelector('#toggle-auto-folder') as HTMLInputElement;

    expect(summarizeToggle?.disabled).toBe(true);
    expect(tagsToggle?.disabled).toBe(true);
    expect(folderToggle?.disabled).toBe(true);

    // Verify AI settings navigation button and overlay
    const overlay = target.querySelector('.no-provider-overlay');
    expect(overlay).not.toBeNull();

    const settingsBtn = target.querySelector('.btn-open-ai-settings') as HTMLButtonElement;
    expect(settingsBtn).not.toBeNull();
    expect(settingsBtn?.textContent).toContain('AI 설정');

    // Verify clicking navigates to management.html?tab=settings&section=ai
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
    await settingsBtn.click();
    await tick();

    expect(mockTabsCreate).toHaveBeenCalledWith({
      url: 'management.html?tab=settings&section=ai'
    });
    expect(closeSpy).toHaveBeenCalled();
  });

  it('AI Provider가 선택되어 있을 때는 토글 스위치가 활성화되고 오버레이 버튼이 표시되지 않는다', async () => {
    mockGetAiSettings.mockResolvedValue({
      provider: 'openai',
      autoSummarize: false,
      autoTags: true,
      autoFolder: true
    });
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/page', title: 'Example Page Title', active: true }
    ]);
    (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);
    (BookmarkManager.findDuplicate as any).mockResolvedValue(undefined);

    const { target } = await mountApp();

    const summarizeToggle = target.querySelector('#toggle-auto-summarize') as HTMLInputElement;
    const tagsToggle = target.querySelector('#toggle-auto-tags') as HTMLInputElement;
    const folderToggle = target.querySelector('#toggle-auto-folder') as HTMLInputElement;

    expect(summarizeToggle?.disabled).toBe(false);
    expect(tagsToggle?.disabled).toBe(false);
    expect(folderToggle?.disabled).toBe(false);

    const overlay = target.querySelector('.no-provider-overlay');
    expect(overlay).toBeNull();
  });

  it('클라우드 동기화 섹션 타이틀 클릭 시 management.html?tab=settings&section=sync 로 이동한다', async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/page', title: 'Example Page Title', active: true }
    ]);
    (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);
    (BookmarkManager.findDuplicate as any).mockResolvedValue(undefined);

    const { target } = await mountApp();

    const syncTitleBtn = target.querySelector('.sync-section button.header-title-btn') as HTMLButtonElement;
    expect(syncTitleBtn).not.toBeNull();

    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
    await syncTitleBtn.click();
    await tick();

    expect(mockTabsCreate).toHaveBeenCalledWith({
      url: 'management.html?tab=settings&section=sync'
    });
    expect(closeSpy).toHaveBeenCalled();
  });

  it('AI 자동 처리 섹션 타이틀 클릭 시 management.html?tab=settings&section=ai 로 이동한다', async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/page', title: 'Example Page Title', active: true }
    ]);
    (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);
    (BookmarkManager.findDuplicate as any).mockResolvedValue(undefined);

    const { target } = await mountApp();

    const aiTitleBtn = target.querySelector('.ai-options-section button.header-title-btn') as HTMLButtonElement;
    expect(aiTitleBtn).not.toBeNull();

    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
    await aiTitleBtn.click();
    await tick();

    expect(mockTabsCreate).toHaveBeenCalledWith({
      url: 'management.html?tab=settings&section=ai'
    });
    expect(closeSpy).toHaveBeenCalled();
  });
});
