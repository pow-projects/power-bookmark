import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';

const { mockData, dbMock } = vi.hoisted(() => {
  const data = { bookmarks: [] as any[], archivedPages: [] as any[] };
  const mock = {
    bookmarks: {
      toArray: vi.fn(async () => data.bookmarks),
      get: vi.fn(async (id: number) => data.bookmarks.find(b => b.id === id)),
      update: vi.fn(async (id: number, payload: any) => {
        const idx = data.bookmarks.findIndex(b => b.id === id);
        if (idx !== -1) data.bookmarks[idx] = { ...data.bookmarks[idx], ...payload };
      }),
      where: vi.fn(() => ({ equals: vi.fn(() => ({ first: async () => undefined, delete: async () => {} })) })),
      filter: vi.fn(() => ({ modify: vi.fn(async () => {}) })),
      delete: vi.fn(async () => {})
    },
    archivedPages: {
      toArray: vi.fn(async () => data.archivedPages),
      where: vi.fn(() => ({ equals: vi.fn(() => ({ delete: async () => {} })) }))
    },
    settings: {
      get: vi.fn(async () => undefined)
    }
  };
  return { mockData: data, dbMock: mock };
});

vi.mock('../../src/lib/db', () => ({ db: dbMock, default: dbMock }));

const storageListeners: any[] = [];

// For recording browser.bookmarks.removeTree / move calls
const removeTreeCalls: string[] = [];
const moveCalls: { bookmarkId: string; parentId: string }[] = [];

vi.stubGlobal('browser', {
  i18n: { getMessage: vi.fn((key: string) => key) },
  runtime: { sendMessage: vi.fn(async () => ({ ok: true })) },
  storage: {
    onChanged: {
      addListener: vi.fn((cb: any) => { storageListeners.push(cb); }),
      removeListener: vi.fn((cb: any) => {
        const idx = storageListeners.indexOf(cb);
        if (idx !== -1) storageListeners.splice(idx, 1);
      })
    },
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
  },
  bookmarks: {
    getTree: vi.fn(async () => [{ id: '0', title: 'root', children: [] }]),
    get: vi.fn(async (id: string) => [{ id, parentId: '2' }]),
    move: vi.fn(async (id: string, opts: any) => {
      moveCalls.push({ bookmarkId: id, parentId: opts.parentId });
    }),
    removeTree: vi.fn(async (id: string) => {
      removeTreeCalls.push(id);
    }),
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onChanged: { addListener: vi.fn() },
    onMoved: { addListener: vi.fn() }
  },
  tabs: { query: vi.fn(async () => []) }
});

import BookmarkList from '../../src/components/management/BookmarkList.svelte';

describe('BookmarkList.svelte - FolderTree delete flow', () => {
  let target: HTMLElement;

  const mockFolders = [
    { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', depth: 0 },
    { id: '2', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', depth: 1 },
    { id: '3', title: '정치', path: 'Bookmarks Bar/커뮤니티/정치', depth: 2 }
  ];

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
    mockData.bookmarks = [];
    mockData.archivedPages = [];
    storageListeners.length = 0;
    removeTreeCalls.length = 0;
    moveCalls.length = 0;
    vi.restoreAllMocks();
  });

  async function mount(bookmarks: any[] = []) {
    mockData.bookmarks = bookmarks;
    const { BookmarkManager } = await import('../../src/lib/bookmarks/bookmark-manager');
    const getFoldersSpy = vi.spyOn(BookmarkManager, 'getFolders').mockResolvedValue(mockFolders as any);
    const comp: any = new BookmarkList({ target, props: { folders: mockFolders } });
    await comp.loadBookmarks();
    await tick();
    return { comp, getFoldersSpy };
  }

  /** Helper to click delete button (right X) */
  async function clickDeleteOn(label: string) {
    const item = Array.from(document.querySelectorAll('.folder-tree .tree-item')).find(
      el => el.querySelector('.tree-label')?.textContent === label
    ) as HTMLElement;
    const del = item.querySelector('.row-delete') as HTMLElement;
    del.click();
    await tick();
  }

  it('빈 폴더는 확인 모달 없이 즉시 삭제하고 removeTree 호출', async () => {
    const { getFoldersSpy } = await mount([]);

    await clickDeleteOn('정치');
    await tick();

    // Modal does not appear
    expect(document.querySelector('#folder-delete-modal-title')).toBeNull();
    expect(removeTreeCalls).toContain('3'); // 'Politics' folder id
    getFoldersSpy.mockRestore();
  });

  it('북마크가 있는 폴더는 확인 모달을 표시한다', async () => {
    const { getFoldersSpy } = await mount([
      { id: 10, title: '뉴스', url: 'https://e.com/a', folderPath: 'Bookmarks Bar/커뮤니티/정치', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b10' }
    ]);

    await clickDeleteOn('정치');
    await tick();

    expect(document.querySelector('#folder-delete-modal-title')).toBeTruthy();
    expect(document.body.textContent).toContain('폴더와 북마크 모두 삭제');
    // Actual deletion has not occurred yet
    expect(removeTreeCalls.length).toBe(0);
    getFoldersSpy.mockRestore();
  });

  it('하위 폴더 포함 북마크 개수를 카운트한다', async () => {
    const { getFoldersSpy } = await mount([
      { id: 10, title: 'A', url: 'https://e.com/a', folderPath: 'Bookmarks Bar/커뮤니티', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b10' },
      { id: 11, title: 'B', url: 'https://e.com/b', folderPath: 'Bookmarks Bar/커뮤니티/정치', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b11' }
    ]);

    await clickDeleteOn('커뮤니티');
    await tick();

    expect(document.body.textContent).toContain('2개');
    getFoldersSpy.mockRestore();
  });

  it('"폴더와 북마크 모두 삭제" 클릭 시 removeBookmark 후 removeTree 호출', async () => {
    const { getFoldersSpy } = await mount([
      { id: 10, title: 'A', url: 'https://e.com/a', folderPath: 'Bookmarks Bar/커뮤니티/정치', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b10' }
    ]);
    const { BookmarkManager } = await import('../../src/lib/bookmarks/bookmark-manager');

    await clickDeleteOn('정치');
    await tick();

    const removeBookmarkSpy = vi.spyOn(BookmarkManager, 'removeBookmark').mockResolvedValue(undefined as any);
    const allBtn = Array.from(document.querySelectorAll('.modal-actions .btn-danger')).find(
      b => (b.textContent || '').includes('모두 삭제')
    ) as HTMLButtonElement;
    allBtn.click();
    await tick();

    expect(removeBookmarkSpy).toHaveBeenCalledWith(10);
    expect(removeTreeCalls).toContain('3');
    getFoldersSpy.mockRestore();
  });

  it('"북마크 보존 후 삭제" 클릭 시 북마크를 상위 폴더로 move 후 removeTree 호출', async () => {
    const { getFoldersSpy } = await mount([
      { id: 10, title: 'A', url: 'https://e.com/a', folderPath: 'Bookmarks Bar/커뮤니티/정치', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b10' }
    ]);

    await clickDeleteOn('정치');
    await tick();

    const keepBtn = Array.from(document.querySelectorAll('.modal-actions .btn-secondary')).find(
      b => (b.textContent || '').includes('보존')
    ) as HTMLButtonElement;
    keepBtn.click();
    await tick();
    // Additional flush to completely process the deep async chain through microtasks
    // from moveBookmarksToParent to updateBookmark (internal ensureFolderPath/get/move/update)
    await new Promise(r => setTimeout(r, 0));
    await tick();

    // move to parent ('Community' id '2')
    expect(moveCalls).toContainEqual({ bookmarkId: 'b10', parentId: '2' });
    expect(removeTreeCalls).toContain('3');
    getFoldersSpy.mockRestore();
  });

  it('시스템 루트 폴더(Bookmarks Bar) 삭제 시 removeTree가 호출되지 않는다 (가드)', async () => {
    const { getFoldersSpy } = await mount([
      { id: 10, title: 'A', url: 'https://e.com/a', folderPath: 'Bookmarks Bar', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b10' }
    ]);

    // Since FolderTree does not render a delete button for system root, delete event cannot occur via UI.
    // Force dispatch FolderTree delete event to directly test defensive layer (handleFolderDelete).
    const treeRoot = document.querySelector('.folder-tree') as HTMLElement;
    expect(treeRoot).toBeTruthy();
    treeRoot.dispatchEvent(new CustomEvent('delete', { bubbles: true, detail: { value: 'Bookmarks Bar' } }));
    await tick();

    // Deleting system root is blocked -> no removeTree call, confirmation modal does not appear
    expect(removeTreeCalls).not.toContain('1'); // 'Bookmarks Bar' id
    expect(removeTreeCalls.length).toBe(0);
    expect(document.querySelector('#folder-delete-modal-title')).toBeNull();
    getFoldersSpy.mockRestore();
  });
});
