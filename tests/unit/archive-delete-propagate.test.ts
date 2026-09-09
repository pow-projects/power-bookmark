import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';

// G-2 regression test: BookmarkList.deleteArchive must send ARCHIVE_DELETE { syncId }
// to background as fire-and-forget along with local deletion.

const { mockData, dbMock } = vi.hoisted(() => {
  const data = { bookmarks: [] as any[], archivedPages: [] as any[], cloudIndex: [] as any[] };
  const mock = {
    bookmarks: {
      toArray: vi.fn(async () => data.bookmarks),
      get: vi.fn(async (id: number) => data.bookmarks.find((b) => b.id === id)),
      delete: vi.fn(async (id: number) => {
        const i = data.bookmarks.findIndex((b) => b.id === id);
        if (i !== -1) data.bookmarks.splice(i, 1);
      }),
      where: vi.fn(() => ({ equals: vi.fn(() => ({ first: async () => undefined })) })),
    },
    archivedPages: {
      toArray: vi.fn(async () => data.archivedPages),
      get: vi.fn(async (id: number) => data.archivedPages.find((a) => a.id === id)),
      delete: vi.fn(async (id: number) => {
        const i = data.archivedPages.findIndex((a) => a.id === id);
        if (i !== -1) data.archivedPages.splice(i, 1);
      }),
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          first: async () => undefined,
          delete: async () => {}
        }))
      })),
    },
    settings: {
      get: vi.fn(async (key: string) => {
        if (key === 'cloud_archive_index') return { value: data.cloudIndex };
        return undefined;
      }),
      put: vi.fn(async (item: any) => {
        if (item.key === 'cloud_archive_index') {
          data.cloudIndex = item.value;
        }
      })
    },
  };
  return { mockData: data, dbMock: mock };
});

vi.mock('../../src/lib/db', () => ({ db: dbMock, default: dbMock }));

const sendMessage = vi.fn(async () => ({ ok: true }));
vi.stubGlobal('browser', {
  runtime: { sendMessage },
  storage: {
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
  },
  bookmarks: { getTree: vi.fn(async () => [{ id: '0', title: 'root', children: [] }]) },
});

// toast-store must be safe even in absence of browser. Use real module as-is,
// isolating unnecessary global access with no-ops.
vi.mock('../../src/lib/ui/toast-store', () => ({
  showToast: vi.fn(),
  __esModule: true,
}));

describe('BookmarkList.deleteArchive → ARCHIVE_DELETE 전파 (G-2)', () => {
  let target: HTMLElement;
  beforeEach(() => {
    vi.stubGlobal('browser', {
      runtime: { sendMessage },
      storage: {
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      },
      bookmarks: {
        getTree: vi.fn(async () => [{ id: '0', title: 'root', children: [] }]),
        remove: vi.fn(async () => {})
      },
    });
    document.body.innerHTML = '<div id="mount"></div>';
    target = document.getElementById('mount') as HTMLElement;
    mockData.bookmarks = [
      { id: 1, title: 'T', url: 'https://t.com', folderPath: '', createdAt: 1, visitCount: 0, bookmarkId: 'b1', syncId: 'sync-abc' },
    ];
    mockData.archivedPages = [{ id: 10, bookmarkId: 1, url: 'https://t.com', title: 'T', htmlBlob: new Blob() }];
    sendMessage.mockClear();
    vi.clearAllMocks();
  });

  it('syncId가 있는 북마크의 아카이브 삭제 → ARCHIVE_DELETE { syncId } 전송 (fire-and-forget)', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const { default: BookmarkList } = await import('../../src/components/management/BookmarkList.svelte');
    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await tick();

    await comp.deleteArchive(10);
    await tick();

    expect(dbMock.archivedPages.delete).toHaveBeenCalledWith(10);
    expect(dbMock.bookmarks.get).toHaveBeenCalledWith(1);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'ARCHIVE_DELETE', syncId: 'sync-abc' });
    vi.unstubAllGlobals();
  });

  it('동기화된 아카이브 삭제 시 cloud_archive_index 캐시에서도 제거되어야 함', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    mockData.cloudIndex = [
      { syncId: 'sync-abc', bookmarkId: 'b1', url: 'https://t.com', title: 'T', fileName: 'sync-abc.html', fileSize: 100, format: 'html', archivedAt: 100 }
    ];
    const { default: BookmarkList } = await import('../../src/components/management/BookmarkList.svelte');
    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await tick();

    await comp.deleteArchive(10);
    await tick();

    expect(mockData.cloudIndex).toEqual([]);
    expect(dbMock.archivedPages.delete).toHaveBeenCalledWith(10);
    vi.unstubAllGlobals();
  });

  it('북마크에 syncId가 없으면 ARCHIVE_DELETE 미전송 (가드)', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    mockData.bookmarks[0].syncId = undefined;
    const { default: BookmarkList } = await import('../../src/components/management/BookmarkList.svelte');
    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await tick();

    await comp.deleteArchive(10);
    await tick();

    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ARCHIVE_DELETE' }));
    vi.unstubAllGlobals();
  });

  it('사용자가 취소(confirm=false)하면 삭제·전파 모두 수행하지 않음', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    const { default: BookmarkList } = await import('../../src/components/management/BookmarkList.svelte');
    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await tick();

    await comp.deleteArchive(10);
    await tick();

    expect(dbMock.archivedPages.delete).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ARCHIVE_DELETE' }));
    vi.unstubAllGlobals();
  });

  it('BookmarkManager.removeBookmark 호출 시 북마크 삭제와 함께 ARCHIVE_DELETE { syncId } 전파', async () => {
    const { BookmarkManager } = await import('../../src/lib/bookmarks/bookmark-manager');
    await BookmarkManager.removeBookmark(1);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'ARCHIVE_DELETE', syncId: 'sync-abc' });
  });
});
