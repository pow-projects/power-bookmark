import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tick } from 'svelte';

// Component-level regression test verifying the path where bookmark must be created immediately
// upon button click (open extension popup) (onMount -> autoAddBookmark -> doAddBookmark).
// t_7539944f: Fix immediate bookmark creation logic on click

const mocks = vi.hoisted(() => {
  return {
    settingsGet: vi.fn(async () => null),
    settingsPut: vi.fn(async () => undefined),
    archivedCount: vi.fn(async () => 0),
    bookmarkGet: vi.fn(async () => undefined),
    getFolders: vi.fn(async () => [{ id: '1', title: 'Bookmarks bar', path: 'Bookmarks bar' }]),
    findDuplicate: vi.fn(async () => undefined),
    createBookmark: vi.fn(async (url: string, title: string, folderId?: string) => ({
      id: 1,
      syncId: 'sync-1',
      bookmarkId: 'bm-1',
      url,
      title,
      folderPath: 'Bookmarks bar'
    })),
    updateBookmark: vi.fn(async () => undefined),
    isAiConfigured: vi.fn(async () => false),
    archiveBookmark: vi.fn(async () => undefined),
    setTaskIndicator: vi.fn(async () => undefined),
    getCloudArchiveIndexCache: vi.fn(async () => [])
  };
});

vi.mock('../../src/lib/db', () => ({
  default: {
    settings: {
      get: mocks.settingsGet,
      put: mocks.settingsPut
    },
    archivedPages: {
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          count: mocks.archivedCount
        }))
      }))
    },
    bookmarks: {
      get: mocks.bookmarkGet
    }
  }
}));

vi.mock('../../src/lib/bookmarks/bookmark-manager', () => ({
  BookmarkManager: {
    getFolders: mocks.getFolders,
    findDuplicate: mocks.findDuplicate,
    createBookmark: mocks.createBookmark,
    updateBookmark: mocks.updateBookmark
  }
}));

vi.mock('../../src/lib/ai/ai-summarizer', async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, isAiConfigured: mocks.isAiConfigured };
});

vi.mock('../../src/lib/archive/page-capture', async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, archiveBookmark: mocks.archiveBookmark };
});

vi.mock('../../src/lib/bookmarks/badge-manager', async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, setTaskIndicator: mocks.setTaskIndicator };
});

vi.mock('../../src/lib/archive/archive-viewer', () => ({
  buildArchiveBannerHtml: vi.fn((html: string) => html)
}));

vi.mock('../../src/lib/archive/archive-cloud', () => ({
  getCloudArchiveIndexCache: mocks.getCloudArchiveIndexCache
}));

// App.svelte import must come after all mock declarations
import App from '../../src/entrypoints/popup/App.svelte';

function stubBrowser() {
  vi.stubGlobal('browser', {
    tabs: {
      query: vi.fn(async () => [
        { id: 10, url: 'https://example.com', title: 'Example Domain', active: true }
      ]),
      sendMessage: vi.fn(async () => null)
    },
    runtime: {
      sendMessage: vi.fn(async () => undefined)
    },
    bookmarks: {
      get: vi.fn(async () => [])
    },
    i18n: {
      getMessage: vi.fn((key: string) => (key === 'addBookmark' ? '북마크' : ''))
    }
  });
}

function stubMatchMedia() {
  window.matchMedia = window.matchMedia || vi.fn(() => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  }));
}

describe('Popup 확장 버튼 클릭 시 즉시 북마크 생성 (autoAddBookmark 경로)', () => {
  let target: HTMLElement;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.createElement('div');
    document.body.appendChild(target);
    vi.clearAllMocks();
    stubBrowser();
    stubMatchMedia();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  async function flushOnMount() {
    // Complete Promise.all + chained await inside onMount in real-time
    await new Promise((r) => setTimeout(r, 100));
    await tick();
  }

  it('onMount 후 autoAddBookmark가 실행되어 createBookmark가 호출된다 (즉시 생성)', async () => {
    new App({ target });
    await flushOnMount();

    expect(mocks.createBookmark).toHaveBeenCalledTimes(1);
    // createBookmark(url, title, parentId, description) — in v2 new registration,
    // description is empty (''), so doAddBookmark passes 'description || undefined'.
    // (Matches BookmarkManager.createBookmark default description='')
    expect(mocks.createBookmark).toHaveBeenCalledWith(
      'https://example.com',
      'Example Domain',
      '1',
      undefined
    );
    // onMount must not abort with TDZ ReferenceError
    expect(consoleErrorSpy.mock.calls.some((c) => String(c[0]).includes('Popup onMount error'))).toBe(false);
  });

  it('즉시 생성 성공 시 수정 모드로 전환되어 삭제 버튼이 표시된다', async () => {
    new App({ target });
    await flushOnMount();

    // [Add Bookmark] button (btn-primary) in new add mode disappears,
    // and edit-mode dedicated delete button (btn-danger) appears
    const dangerBtn = target.querySelector('.btn-danger');
    expect(dangerBtn).not.toBeNull();
    expect(target.textContent).toContain('삭제');
  });

  it('즉시 생성 실패 시 오류 배너로 사용자에게 피드백이 표시된다', async () => {
    mocks.createBookmark.mockRejectedValueOnce(new Error('create failed'));
    new App({ target });
    await flushOnMount();

    // Failure feedback: failure message must be displayed in error banner (.error-banner)
    const errorBanner = target.querySelector('.error-banner');
    expect(errorBanner).not.toBeNull();
    expect(errorBanner!.textContent).toContain('북마크 생성 실패');
    // If failed, should not transition to edit mode and delete button must not exist
    expect(target.querySelector('.btn-danger')).toBeNull();
  });
});
