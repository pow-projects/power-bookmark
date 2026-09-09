import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';

const { mockData, dbMock } = vi.hoisted(() => {
  const data = { bookmarks: [] as any[], archivedPages: [] as any[] };
  const mock = {
    bookmarks: {
      toArray: vi.fn(async () => data.bookmarks),
      get: vi.fn(async (id: number) => data.bookmarks.find((b) => b.id === id)),
      update: vi.fn(async (id: number, payload: any) => {
        const idx = data.bookmarks.findIndex((b) => b.id === id);
        if (idx !== -1) data.bookmarks[idx] = { ...data.bookmarks[idx], ...payload };
      }),
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          first: async () => undefined,
          delete: async () => {},
          toArray: async () => []
        }))
      })),
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
const updateCalls: { id: string; title: string }[] = [];

vi.stubGlobal('browser', {
  i18n: { getMessage: vi.fn((key: string) => key) },
  runtime: { sendMessage: vi.fn(async () => ({ ok: true })) },
  storage: {
    onChanged: {
      addListener: vi.fn((cb: any) => {
        storageListeners.push(cb);
      }),
      removeListener: vi.fn((cb: any) => {
        const idx = storageListeners.indexOf(cb);
        if (idx !== -1) storageListeners.splice(idx, 1);
      })
    },
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
  },
  bookmarks: {
    getTree: vi.fn(async () => [
      {
        id: '0',
        title: 'root',
        children: [
          {
            id: '1',
            title: 'Bookmarks Bar',
            children: [
              {
                id: '2',
                parentId: '1',
                title: 'Development',
                children: []
              }
            ]
          }
        ]
      }
    ]),
    get: vi.fn(async (id: string) => [{ id, parentId: '1' }]),
    move: vi.fn(async () => {}),
    update: vi.fn(async (id: string, changes: any) => {
      updateCalls.push({ id, title: changes.title });
    }),
    remove: vi.fn(async () => {}),
    removeTree: vi.fn(async () => {}),
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onChanged: { addListener: vi.fn() },
    onMoved: { addListener: vi.fn() }
  },
  tabs: { query: vi.fn(async () => []) }
});

import BookmarkList from '../../src/components/management/BookmarkList.svelte';
import { BookmarkManager } from '../../src/lib/bookmarks/bookmark-manager';

describe('BookmarkList.svelte - Folder rename modal flow', () => {
  let target: HTMLElement;

  const mockFolders = [
    { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', depth: 0 },
    { id: '2', title: 'Development', path: 'Bookmarks Bar/Development', parentId: '1', depth: 1 }
  ];

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
    mockData.bookmarks = [];
    mockData.archivedPages = [];
    storageListeners.length = 0;
    updateCalls.length = 0;
    vi.restoreAllMocks();
  });

  async function mount() {
    vi.spyOn(BookmarkManager, 'getFolders').mockResolvedValue(mockFolders as any);
    const comp: any = new BookmarkList({ target, props: { folders: mockFolders } });
    await comp.loadBookmarks();
    await tick();
    return comp;
  }

  it('clicking row-edit opens rename modal with pre-filled title and never throws undefined folder', async () => {
    await mount();

    const devItem = Array.from(document.querySelectorAll('.folder-tree .tree-item')).find(
      (el) => el.querySelector('.tree-label')?.textContent === 'Development'
    ) as HTMLElement;
    expect(devItem).toBeDefined();

    const editBtn = devItem.querySelector('.row-action.row-edit') as HTMLElement;
    expect(editBtn).not.toBeNull();

    editBtn.click();
    await tick();

    // Modal title should appear
    const modalTitle = document.querySelector('#folder-rename-modal-title');
    expect(modalTitle).not.toBeNull();
    expect(modalTitle?.textContent).toBe(i18n.t('folders.renameModal.title'));

    // Input should be pre-filled with 'Development'
    const input = document.querySelector('#rename-folder-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe('Development');

    // Spy on renameFolder
    const renameSpy = vi.spyOn(BookmarkManager, 'renameFolder').mockResolvedValue({
      id: '2',
      oldTitle: 'Development',
      newTitle: 'Engineering',
      newPath: 'Bookmarks Bar/Engineering'
    });

    // Change value and submit
    input.value = 'Engineering';
    input.dispatchEvent(new Event('input'));
    await tick();

    const submitBtn = Array.from(document.querySelectorAll('.modal-actions button')).find(
      (btn) => btn.classList.contains('btn-primary')
    ) as HTMLElement;
    expect(submitBtn).not.toBeNull();

    submitBtn.click();
    await tick();

    // Verify renameFolder was called with '2' (NEVER 'undefined'!)
    expect(renameSpy).toHaveBeenCalledWith('2', 'Engineering');
    expect(document.querySelector('.error-banner')).toBeNull();
  });

  it('sets dynamic max-height on folder-tree-panel to fit viewport', async () => {
    await mount();

    const panel = document.querySelector('.folder-tree-panel') as HTMLElement;
    expect(panel).not.toBeNull();
    // In jsdom, getBoundingClientRect returns top: 0, innerHeight: 768 -> 768 - 0 - 24 = 744px
    expect(panel.style.maxHeight).toBeTruthy();

    window.dispatchEvent(new Event('scroll'));
    await tick();

    expect(panel.style.maxHeight).toBeTruthy();
  });
});
