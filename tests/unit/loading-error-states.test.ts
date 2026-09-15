import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tick } from 'svelte';

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
      get: vi.fn(async () => undefined),
      delete: vi.fn(async () => {}),
      where: vi.fn(() => ({ equals: vi.fn(() => ({ first: async () => undefined, delete: async () => {} })) }))
    },
    settings: {
      get: vi.fn(async (key: string) => data.settings[key] !== undefined ? { key, value: data.settings[key] } : undefined),
      put: vi.fn(async (item: { key: string; value: any }) => { data.settings[item.key] = item.value; }),
      delete: vi.fn(async (key: string) => { delete data.settings[key]; })
    }
  };
  return { mockData: data, dbMock: mock };
});

vi.mock('../../src/lib/db', () => ({
  db: dbMock,
  default: dbMock
}));

vi.mock('../../src/lib/bookmarks/bookmark-manager', () => ({
  BookmarkManager: {
    getFolders: vi.fn(async () => []),
    openBookmark: vi.fn(),
    deleteBookmark: vi.fn(),
    moveBookmarkToFolder: vi.fn(),
    createFolder: vi.fn(),
    deleteFolder: vi.fn(),
    renameFolder: vi.fn()
  }
}));

vi.mock('../../src/lib/archive/archive-cloud', () => ({
  getCloudArchiveIndexCache: vi.fn(async () => []),
  setArchiveSyncEnabled: vi.fn()
}));

vi.mock('../../src/lib/sync/sync-conflict-store', () => ({
  getPendingConflicts: vi.fn(async () => [])
}));

vi.mock('../../src/lib/ui/toast-store', () => ({
  showToast: vi.fn()
}));

describe('Disk 100% / Stalled Storage Loading & Error States', () => {
  beforeEach(() => {
    mockData.bookmarks = [];
    mockData.archivedPages = [];
    mockData.settings = {};
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.stubGlobal('browser', {
      runtime: {
        sendMessage: vi.fn(async () => ({})),
        getManifest: () => ({ version: '1.0.0' })
      },
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => ({}))
        },
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn()
        }
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('BookmarkList renders loading spinner while bookmarks are loading', async () => {
    let resolveBookmarks: (val: any) => void;
    dbMock.bookmarks.toArray.mockReturnValueOnce(new Promise((resolve) => {
      resolveBookmarks = resolve;
    }));

    const { default: BookmarkList } = await import('../../src/components/management/bookmarks/BookmarkList.svelte');
    const target = document.body;
    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await tick();

    // While loading promise is pending, loading-state should be visible
    const loadingEl = document.querySelector('.loading-state');
    expect(loadingEl).not.toBeNull();
    expect(loadingEl?.textContent).toContain('북마크를 불러오는 중입니다');

    // EmptyState should NOT be rendered while loading
    const emptyState = document.querySelector('.empty-state');
    expect(emptyState).toBeNull();

    // Resolve bookmarks
    resolveBookmarks!([]);
    await comp.loadBookmarks();
    await tick();

    // After resolving, loading-state disappears and EmptyState is shown
    expect(document.querySelector('.loading-state')).toBeNull();
    expect(document.querySelector('.empty-state')).not.toBeNull();
  });

  it('BookmarkList renders error state with retry button when storage read fails (disk 100%)', async () => {
    dbMock.bookmarks.toArray.mockRejectedValue(new Error('QuotaExceededError: Disk is full'));

    const { default: BookmarkList } = await import('../../src/components/management/bookmarks/BookmarkList.svelte');
    const target = document.body;
    const comp: any = new BookmarkList({ target, props: { folders: [] } });

    await comp.loadBookmarks();
    await tick();

    const errorEl = document.querySelector('.error-state');
    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent).toContain('북마크를 불러오지 못했습니다');
    expect(errorEl?.textContent).toContain('QuotaExceededError: Disk is full');

    const retryBtn = errorEl?.querySelector('.btn-retry') as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();

    // Clicking retry button attempts to reload bookmarks
    dbMock.bookmarks.toArray.mockResolvedValue([{ id: 1, title: 'Recovered Bookmark', url: 'https://example.com' }]);
    retryBtn.click();
    await comp.loadBookmarks();
    await tick();

    expect(document.querySelector('.error-state')).toBeNull();
    expect(document.querySelector('.loading-state')).toBeNull();
  });

  it('ArchiveSettings displays loading indicator and disables toggles while loading', async () => {
    let resolveSettings: (val: any) => void;
    dbMock.settings.get.mockReturnValueOnce(new Promise((resolve) => {
      resolveSettings = resolve;
    }));

    const { default: ArchiveSettings } = await import('../../src/components/management/settings/ArchiveSettings.svelte');
    const target = document.body;
    new ArchiveSettings({ target });
    await tick();

    // Loading indicator is present
    const loadingIndicator = document.querySelector('.section-loading-indicator');
    expect(loadingIndicator).not.toBeNull();

    // Toggles are disabled while loading to prevent premature write
    const autoArchiveToggle = document.getElementById('auto-archive') as HTMLButtonElement;
    const compressToggle = document.getElementById('compress-archive') as HTMLButtonElement;
    expect(autoArchiveToggle?.disabled).toBe(true);
    expect(compressToggle?.disabled).toBe(true);

    // Resolve settings
    resolveSettings!({ value: true });
    await tick();
  });

  it('ArchiveSettings displays error banner with retry button on storage error', async () => {
    dbMock.settings.get.mockRejectedValueOnce(new Error('Storage failure'));

    const { default: ArchiveSettings } = await import('../../src/components/management/settings/ArchiveSettings.svelte');
    const target = document.body;
    new ArchiveSettings({ target });
    await tick();
    await new Promise((r) => setTimeout(r, 10));
    await tick();

    const errorBanner = document.querySelector('.section-error-banner');
    expect(errorBanner).not.toBeNull();
    expect(errorBanner?.textContent).toContain('설정을 불러오지 못했습니다');
  });

  it('SyncSettings displays loading indicator and disables provider select while loading', async () => {
    let resolveSync: (val: any) => void;
    dbMock.settings.get.mockReturnValueOnce(new Promise((resolve) => {
      resolveSync = resolve;
    }));

    const { default: SyncSettings } = await import('../../src/components/management/settings/SyncSettings.svelte');
    const target = document.body;
    new SyncSettings({ target });
    await tick();

    const providerSelect = document.getElementById('sync-provider') as HTMLSelectElement;
    expect(providerSelect?.disabled).toBe(true);

    resolveSync!({ value: 'none' });
    await tick();
  });

  it('AiSettings displays loading indicator and disables provider select while loading', async () => {
    let resolveAi: (val: any) => void;
    dbMock.settings.get.mockReturnValueOnce(new Promise((resolve) => {
      resolveAi = resolve;
    }));

    const { default: AiSettings } = await import('../../src/components/management/settings/AiSettings.svelte');
    const target = document.body;
    new AiSettings({ target });
    await tick();

    const providerSelect = document.getElementById('ai-provider') as HTMLSelectElement;
    expect(providerSelect?.disabled).toBe(true);

    resolveAi!({ value: 'none' });
    await tick();
  });
});
