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
// browser.bookmarks.move call history — reparent (cross-move) if parentId is a different parent, reorder within same parent if index is present
const moveCalls: { folderId: string; parentId: string; index?: number }[] = [];

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
    get: vi.fn(async (id: string) => [{ id, parentId: '2', index: 2 }]),
    move: vi.fn(async (id: string, opts: any) => {
      moveCalls.push({ folderId: id, parentId: opts.parentId, index: opts.index });
    }),
    removeTree: vi.fn(async () => {}),
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onChanged: { addListener: vi.fn() },
    onMoved: { addListener: vi.fn() }
  },
  tabs: { query: vi.fn(async () => []) }
});

import BookmarkList from '../../src/components/management/BookmarkList.svelte';
import { toasts } from '../../src/lib/ui/toast-store';
import { get } from 'svelte/store';

describe('BookmarkList.svelte - FolderTree move (reparent) flow', () => {
  let target: HTMLElement;

  // 'Community' (2) and 'Tech' (3) are siblings under Bookmarks Bar ('1'), 'Games' (4) is directly under Other bookmarks ('0') (non-sibling)
  const moveFolders = [
    { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', parentId: '0' },
    { id: '2', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' },
    { id: '3', title: '테크', path: 'Bookmarks Bar/테크', parentId: '1' },
    { id: '4', title: '게임', path: 'Other bookmarks/게임', parentId: '0' }
  ];

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
    mockData.bookmarks = [];
    mockData.archivedPages = [];
    storageListeners.length = 0;
    moveCalls.length = 0;
    toasts.set([]);
    vi.restoreAllMocks();
  });

  async function mount(folders = moveFolders) {
    const { BookmarkManager } = await import('../../src/lib/bookmarks/bookmark-manager');
    const getFoldersSpy = vi.spyOn(BookmarkManager, 'getFolders').mockResolvedValue(folders as any);
    const syncAllSpy = vi.spyOn(BookmarkManager, 'syncAll').mockResolvedValue(undefined as any);
    const comp: any = new BookmarkList({ target, props: { folders } });
    await comp.loadBookmarks();
    await tick();
    return { comp, getFoldersSpy, syncAllSpy };
  }

  function itemByLabel(label: string): HTMLElement {
    const el = Array.from(document.querySelectorAll('.folder-tree .tree-item')).find(
      item => item.querySelector('.tree-label')?.textContent === label
    );
    if (!el) throw new Error(`tree item not found: ${label}`);
    return el as HTMLElement;
  }

  /** Mock getBoundingClientRect with 32px spacing on rendered folder tree rows (same approach as FolderTree reorder/cross-move tests) */
  function mockRowGeometry() {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.tree-item[data-folder-id]'));
    rows.forEach((el, i) => {
      const top = 100 + i * 32;
      el.getBoundingClientRect = () =>
        ({ top, bottom: top + 32, height: 32, left: 0, right: 200, width: 200, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    });
    document.querySelector<HTMLElement>('.tree-scroll')!.getBoundingClientRect = () =>
      ({ top: 100, bottom: 400, height: 300, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;
  }

  function rowCenterY(label: string): number {
    const r = itemByLabel(label).getBoundingClientRect();
    return r.top + r.height / 2;
  }

  /** Simulate drag by grabbing the left move handle of FolderTree and dropping at specified coordinates */
  async function dragFolder(sourceLabel: string, clientY: number) {
    const moveBtn = itemByLabel(sourceLabel).querySelector('.row-move') as HTMLElement;
    moveBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientY }));
    await tick();
    moveBtn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 100, clientY }));
    await tick();
    moveBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    // Process internal async chain of handleFolderMove/handleFolderReorder (browser.move -> syncAll -> getFolders -> loadBookmarks)
    await new Promise(r => setTimeout(r, 0));
    await tick();
  }

  it('1. 비-sibling 폴더로 드래그 → browser.bookmarks.move로 reparent(parentId 교체)', async () => {
    const { getFoldersSpy, syncAllSpy } = await mount();
    mockRowGeometry();

    // Drag 'Community' (2) to 'Games' (4, non-sibling under Other bookmarks) row -> move across parents
    await dragFolder('커뮤니티', rowCenterY('게임'));

    // reparent: parentId moves to '4' (different parent)
    expect(moveCalls).toContainEqual(expect.objectContaining({ folderId: '2', parentId: '4' }));
    getFoldersSpy.mockRestore();
    syncAllSpy.mockRestore();
  });

  it('2. 시스템 루트(Bookmarks Bar)는 이동 핸들 미렌더 → 드래그 소스 불가', async () => {
    const { getFoldersSpy, syncAllSpy } = await mount();
    mockRowGeometry();

    // System root has no move handle -> cannot be a drag source
    expect(itemByLabel('Bookmarks Bar').querySelector('.row-move')).toBeNull();
    // Regular folders still retain the move handle
    expect(itemByLabel('커뮤니티').querySelector('.row-move')).toBeTruthy();

    expect(moveCalls.length).toBe(0);
    getFoldersSpy.mockRestore();
    syncAllSpy.mockRestore();
  });

  it('3. sibling 행으로 드래그 → 같은 부모 내 재정렬(reorder), 다른 부모로의 reparent 미발생', async () => {
    const { getFoldersSpy, syncAllSpy } = await mount();
    mockRowGeometry();

    // Drag 'Community' (2) below sibling 'Tech' (3) under the same parent -> reorder
    await dragFolder('커뮤니티', rowCenterY('테크') + 10);

    // reorder moves by index within the same parentId ('1') — no reparent to a different parent ('4') occurs
    expect(moveCalls.length).toBeGreaterThan(0);
    expect(moveCalls.every(c => c.parentId === '1')).toBe(true);
    expect(moveCalls.some(c => c.parentId === '4')).toBe(false);
    getFoldersSpy.mockRestore();
    syncAllSpy.mockRestore();
  });

  it('4. move 후 syncAll + getFolders로 폴더 경로 정합성 갱신 및 성공 토스트', async () => {
    const { getFoldersSpy, syncAllSpy } = await mount();
    mockRowGeometry();

    await dragFolder('커뮤니티', rowCenterY('게임'));

    expect(moveCalls).toContainEqual(expect.objectContaining({ folderId: '2', parentId: '4' }));
    // After browser.bookmarks.move, syncAll (recalculating internal bookmark folderPath) and getFolders (reloading tree) are executed
    expect(syncAllSpy).toHaveBeenCalled();
    expect(getFoldersSpy).toHaveBeenCalled();
    // Success toast is recorded in the global toast store
    const messages = get(toasts).map(t => t.message);
    expect(messages).toContain('폴더가 이동되었습니다.');
    getFoldersSpy.mockRestore();
    syncAllSpy.mockRestore();
  });

  it('5. 비-sibling 상단(r < 0.25) 드롭 시 before 처리 -> refNode.index로 browser.bookmarks.move 호출', async () => {
    const crossFolders = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', parentId: '0' },
      { id: '2', title: 'Other bookmarks', path: 'Other bookmarks', parentId: '0' },
      { id: '3', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' },
      { id: '4', title: '게임', path: 'Other bookmarks/게임', parentId: '2' }
    ];
    const { getFoldersSpy, syncAllSpy } = await mount(crossFolders);
    mockRowGeometry();

    const gameTop = itemByLabel('게임').getBoundingClientRect().top;
    await dragFolder('커뮤니티', gameTop + 4);

    expect(moveCalls).toContainEqual({ folderId: '3', parentId: '2', index: 2 });
    getFoldersSpy.mockRestore();
    syncAllSpy.mockRestore();
  });

  it('6. 비-sibling 하단(r > 0.75) 드롭 시 after 처리 -> refNode.index + 1로 browser.bookmarks.move 호출', async () => {
    const crossFolders = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', parentId: '0' },
      { id: '2', title: 'Other bookmarks', path: 'Other bookmarks', parentId: '0' },
      { id: '3', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' },
      { id: '4', title: '게임', path: 'Other bookmarks/게임', parentId: '2' }
    ];
    const { getFoldersSpy, syncAllSpy } = await mount(crossFolders);
    mockRowGeometry();

    const gameBottom = itemByLabel('게임').getBoundingClientRect().bottom;
    await dragFolder('커뮤니티', gameBottom - 4);

    expect(moveCalls).toContainEqual({ folderId: '3', parentId: '2', index: 3 });
    getFoldersSpy.mockRestore();
    syncAllSpy.mockRestore();
  });

  it('7. 이동된 폴더가 selectedFolder인 경우 이동 후 변경된 경로로 동기화', async () => {
    const crossFolders = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', parentId: '0' },
      { id: '2', title: 'Other bookmarks', path: 'Other bookmarks', parentId: '0' },
      { id: '3', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' },
      { id: '4', title: '게임', path: 'Other bookmarks/게임', parentId: '2' }
    ];
    const updatedFolders = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', parentId: '0' },
      { id: '2', title: 'Other bookmarks', path: 'Other bookmarks', parentId: '0' },
      { id: '3', title: '커뮤니티', path: 'Other bookmarks/게임/커뮤니티', parentId: '4' },
      { id: '4', title: '게임', path: 'Other bookmarks/게임', parentId: '2' }
    ];
    const { getFoldersSpy, syncAllSpy } = await mount(crossFolders);
    mockRowGeometry();

    // Select '커뮤니티'
    itemByLabel('커뮤니티').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    expect(itemByLabel('커뮤니티').classList.contains('active')).toBe(true);

    // When BookmarkManager.getFolders is called after move, return updatedFolders
    getFoldersSpy.mockResolvedValue(updatedFolders as any);

    // Drop '커뮤니티' inside '게임' (rowCenterY)
    await dragFolder('커뮤니티', rowCenterY('게임'));

    expect(moveCalls).toContainEqual(expect.objectContaining({ folderId: '3', parentId: '4' }));

    mockRowGeometry();
    await tick();

    // The updated '커뮤니티' with path 'Other bookmarks/게임/커뮤니티' must be active
    expect(itemByLabel('커뮤니티').classList.contains('active')).toBe(true);

    getFoldersSpy.mockRestore();
    syncAllSpy.mockRestore();
  });
});
