import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tick } from 'svelte';
import App from '../../src/entrypoints/popup/App.svelte';

/**
 * popup App.svelte integrated regression test (QA, t_47ad206e)
 *
 * Verifies entire extension button click -> popup open -> onMount flow as a single scenario.
 * Three scenarios:
 *   1) Click button on unregistered page -> create bookmark immediately (autoAddBookmark -> createBookmark)
 *   2) On click, title and folder list displayed in UI (title input + folder dropdown)
 *   3) Already registered page -> display existing registered content (bind findDuplicate result, block duplicate creation)
 *
 * This integrated test verifies in a single render cycle that the entire onMount logic
 * (tab lookup -> duplicate check -> UI binding -> auto create), branching mutually exclusively
 * (unregistered vs registered), remains intact.
 */

// db.settings store (key -> value)
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
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn()
  }));
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
  // onMount + chained await (onMount -> autoAddBookmark -> doAddBookmark) completed
  await tick();
  await new Promise((r) => setTimeout(r, 30));
  await tick();
  return { component, target };
}

const TAB_UNREGISTERED = { id: 1, url: 'https://example.com/new-page', title: '새 페이지 제목', active: true };

function setUnregisteredPage() {
  mockTabsQuery.mockResolvedValue([TAB_UNREGISTERED]);
  (BookmarkManager.findDuplicate as any).mockResolvedValue(undefined);
}

const EXISTING_DUP = {
  id: 42,
  syncId: 'sync-42',
  bookmarkId: 'bm-42',
  url: 'https://example.com/existing',
  title: '기존 등록 제목',
  description: '기존 설명',
  folderPath: '북마크바/개발'
};

function setRegisteredPage() {
  mockTabsQuery.mockResolvedValue([
    { id: 2, url: 'https://example.com/existing', title: 'Example Page Title', active: true }
  ]);
  (BookmarkManager.findDuplicate as any).mockResolvedValue(EXISTING_DUP);
}

describe('popup App.svelte 통합 회귀 — 확장 버튼 클릭 3 시나리오 (t_47ad206e)', () => {
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

  describe('시나리오 1: 미등록 페이지에서 즉시 북마크 생성', () => {
    it('미등록 페이지 → createBookmark가 호출되어 즉시 생성된다', async () => {
      setUnregisteredPage();
      (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);
      (BookmarkManager.createBookmark as any).mockResolvedValue({
        id: 7,
        syncId: 'sync-7',
        bookmarkId: 'bm-7',
        url: TAB_UNREGISTERED.url,
        title: TAB_UNREGISTERED.title,
        folderPath: '북마크바'
      });

      await mountApp();

      expect(BookmarkManager.createBookmark).toHaveBeenCalledTimes(1);
      const [urlArg, titleArg, folderIdArg] = (BookmarkManager.createBookmark as any).mock.calls[0];
      expect(urlArg).toBe(TAB_UNREGISTERED.url);
      expect(titleArg).toBe(TAB_UNREGISTERED.title);
      expect(folderIdArg).toBe('1'); // Save to default folder (first in list)
    });

    it('즉시 생성 성공 후 수정 모드로 전환되어 삭제 버튼이 표시된다', async () => {
      setUnregisteredPage();
      (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);
      (BookmarkManager.createBookmark as any).mockResolvedValue({
        id: 7, syncId: 'sync-7', bookmarkId: 'bm-7',
        url: TAB_UNREGISTERED.url, title: TAB_UNREGISTERED.title, folderPath: '북마크바'
      });

      const { target } = await mountApp();

      // After auto-creation isEditMode=true -> show edit-mode dedicated delete button
      expect(target.querySelector('.btn-danger')).not.toBeNull();
      expect(target.textContent).toContain('삭제');
    });
  });

  describe('시나리오 2: 클릭 시 제목·폴더 목록이 UI에 표시', () => {
    it('제목 입력값이 현재 페이지 제목으로 채워지고 폴더 드롭다운에 목록이 표시된다', async () => {
      setUnregisteredPage();
      (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);
      (BookmarkManager.createBookmark as any).mockResolvedValue({
        id: 7, syncId: 'sync-7', bookmarkId: 'bm-7',
        url: TAB_UNREGISTERED.url, title: TAB_UNREGISTERED.title, folderPath: '북마크바'
      });

      const { target } = await mountApp();

      const titleInput = target.querySelector('#title') as HTMLInputElement | null;
      expect(titleInput).not.toBeNull();
      expect(titleInput!.value).toBe('새 페이지 제목');

      // Open folder dropdown to verify list
      const trigger = target.querySelector('.select-trigger') as HTMLButtonElement | null;
      expect(trigger).not.toBeNull();
      await trigger!.click();
      await tick();
      const options = target.querySelectorAll('.option-item');
      expect(options.length).toBe(SAMPLE_FOLDERS.length);
      expect(options[0].textContent).toContain('북마크바');
      expect(options[1].textContent).toContain('개발');
    });
  });

  describe('시나리오 3: 이미 등록된 페이지에서 기존 등록 내용 표시', () => {
    it('기존 북마크가 있으면 제목이 기존 등록 제목으로 바인딩되고 새 북마크를 만들지 않는다', async () => {
      setRegisteredPage();
      (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);

      const { target } = await mountApp();

      // Unlike scenario 1, createBookmark must not be called (block duplicate creation)
      expect(BookmarkManager.createBookmark).not.toHaveBeenCalled();

      // Existing registered title displayed in UI
      const titleInput = target.querySelector('#title') as HTMLInputElement | null;
      expect(titleInput).not.toBeNull();
      expect(titleInput!.value).toBe('기존 등록 제목');

      // Enter edit mode -> delete button displayed
      expect(target.querySelector('.btn-danger')).not.toBeNull();
    });

    it('기존 등록 폴더가 드롭다운 선택 텍스트로 표시된다', async () => {
      setRegisteredPage();
      (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);
      // browser.bookmarks.get -> returns parent folder id='2' (Development)
      mockBookmarksGet.mockResolvedValue([{ id: 'bm-42', parentId: '2', title: '기존 등록 제목' }]);

      const { target } = await mountApp();

      const selectedText = target.querySelector('.selected-text');
      expect(selectedText).not.toBeNull();
      expect(selectedText!.textContent).toContain('개발');
    });
  });

  describe('통합 경계 검증', () => {
    it('등록/미등록 분기 없이 onMount가 중단되지 않는다 (TDZ 회귀 방지)', async () => {
      // Unregistered page, folder loading, creation all normal -> onMount runs to completion
      setUnregisteredPage();
      (BookmarkManager.getFolders as any).mockResolvedValue(SAMPLE_FOLDERS);
      (BookmarkManager.createBookmark as any).mockResolvedValue({
        id: 7, syncId: 'sync-7', bookmarkId: 'bm-7',
        url: TAB_UNREGISTERED.url, title: TAB_UNREGISTERED.title, folderPath: '북마크바'
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const { target } = await mountApp();

      // Form rendered only if onMount does not abort with error
      expect(consoleErrorSpy.mock.calls.some((c) => String(c[0]).includes('Popup onMount error'))).toBe(false);
      expect(target.querySelector('#title')).not.toBeNull();
      consoleErrorSpy.mockRestore();
    });
  });
});
