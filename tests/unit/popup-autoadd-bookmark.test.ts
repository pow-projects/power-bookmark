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

describe('Popup 확장 버튼 클릭 시 즉시 생성하지 않고 [북마크 저장] 버튼으로 북마크 생성', () => {
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
    await new Promise((r) => setTimeout(r, 100));
    await tick();
  }

  it('onMount 시점에 createBookmark가 즉시 호출되지 않고, [북마크 저장] 없이 단일 [아카이브 저장] 및 [관리 페이지] 버튼이 표시된다', async () => {
    new App({ target });
    await flushOnMount();

    // Must NOT call createBookmark automatically on mount
    expect(mocks.createBookmark).not.toHaveBeenCalled();

    // Standalone Save Bookmark button must NOT exist
    const saveBtn = target.querySelector('.btn-save-bookmark');
    expect(saveBtn).toBeNull();

    // Single Archive button must be visible
    const archiveBtn = target.querySelector('.btn-archive-bookmark') as HTMLButtonElement | null;
    expect(archiveBtn).not.toBeNull();
    expect(archiveBtn!.textContent).toContain('아카이브 저장');

    // Management page button must be visible
    const manageBtn = target.querySelector('.btn-manage') as HTMLButtonElement | null;
    expect(manageBtn).not.toBeNull();
    expect(manageBtn!.textContent).toContain('관리 페이지');

    // onMount must not abort with errors
    expect(consoleErrorSpy.mock.calls.some((c) => String(c[0]).includes('Popup onMount error'))).toBe(false);
  });

  it('[아카이브 저장] 버튼 클릭 시 북마크가 자동 생성되고 ARCHIVE_CAPTURE_BOOKMARK 메시지가 전송된다', async () => {
    new App({ target });
    await flushOnMount();

    const archiveBtn = target.querySelector('.btn-archive-bookmark') as HTMLButtonElement | null;
    expect(archiveBtn).not.toBeNull();

    await archiveBtn!.click();
    await flushOnMount();

    expect(mocks.createBookmark).toHaveBeenCalledTimes(1);
    expect(mocks.createBookmark).toHaveBeenCalledWith(
      'https://example.com',
      'Example Domain',
      '1'
    );

    // Verify ARCHIVE_CAPTURE_BOOKMARK message was dispatched to background
    const sendMessageCalls = (browser.runtime.sendMessage as any).mock.calls;
    const archiveCall = sendMessageCalls.find((call: any[]) => call[0]?.type === 'ARCHIVE_CAPTURE_BOOKMARK');
    expect(archiveCall).toBeDefined();
    expect(archiveCall[0].bookmarkId).toBe(1);

    // Shows saved stamp
    expect(target.textContent).toContain('저장 완료');
  });

  it('[아카이브 저장] 시 북마크 생성 실패 시 오류 배너로 사용자에게 피드백이 표시된다', async () => {
    mocks.createBookmark.mockRejectedValueOnce(new Error('create failed'));
    new App({ target });
    await flushOnMount();

    const archiveBtn = target.querySelector('.btn-archive-bookmark') as HTMLButtonElement | null;
    expect(archiveBtn).not.toBeNull();

    await archiveBtn!.click();
    await flushOnMount();

    const errorBanner = target.querySelector('.error-banner');
    expect(errorBanner).not.toBeNull();
    expect(errorBanner!.textContent).toContain('북마크 생성 실패');
  });

  it('[아카이브 저장] 캡처 실패 시 오류 배너로 아카이브 저장 실패 피드백이 표시된다', async () => {
    (browser.runtime.sendMessage as any).mockImplementation(async (msg: any) => {
      if (msg.type === 'ARCHIVE_CAPTURE_BOOKMARK') {
        return { success: false, error: 'archive failed' };
      }
      return undefined;
    });

    new App({ target });
    await flushOnMount();

    const archiveBtn = target.querySelector('.btn-archive-bookmark') as HTMLButtonElement | null;
    expect(archiveBtn).not.toBeNull();

    await archiveBtn!.click();
    await flushOnMount();

    const errorBanner = target.querySelector('.error-banner');
    expect(errorBanner).not.toBeNull();
    expect(errorBanner!.textContent).toContain('아카이브 저장에 실패했습니다');
  });
});
