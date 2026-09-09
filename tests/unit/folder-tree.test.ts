import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tick } from 'svelte';

// FolderTree imports ../../lib/bookmark-manager (normalizeFolderPath) -> pulls ./db (dexie), requiring a mock
const { dbMock } = vi.hoisted(() => {
  const mock = {
    bookmarks: {
      toArray: vi.fn(async () => []),
      get: vi.fn(async () => undefined),
      update: vi.fn(async () => {}),
      where: vi.fn(() => ({ equals: vi.fn(() => ({ first: async () => undefined, delete: async () => {} })) })),
      delete: vi.fn(async () => {})
    },
    archivedPages: {
      toArray: vi.fn(async () => []),
      where: vi.fn(() => ({ equals: vi.fn(() => ({ delete: async () => {} })) }))
    },
    settings: {
      get: vi.fn(async () => undefined)
    }
  };
  return { dbMock: mock };
});

vi.mock('../../src/lib/db', () => ({
  db: dbMock,
  default: dbMock
}));

import FolderTree from '../../src/components/management/FolderTree.svelte';

// 4-level structure below Bookmarks Bar (system root): Community > Politics > Korea > Seoul
//  - Depth: Bookmarks Bar=0 (Level 1), Community=1 (Level 2), Politics=2 (Level 3), Korea=3 (Level 4), Seoul=4 (Level 5)
const SYSTEM_ROOT_TREE = [
  { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar' },
  { id: '2', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' },
  { id: '3', title: '정치', path: 'Bookmarks Bar/커뮤니티/정치', parentId: '2' },
  { id: '4', title: '한국', path: 'Bookmarks Bar/커뮤니티/정치/한국', parentId: '3' },
  { id: '5', title: '서울', path: 'Bookmarks Bar/커뮤니티/정치/한국/서울', parentId: '4' }
];

describe('FolderTree.svelte', () => {
  let target: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
  });

  /** List of tree labels currently rendered in DOM (including root-item, DFS order) */
  function labels(): string[] {
    return Array.from(document.querySelectorAll('.folder-tree .tree-label')).map(el => el.textContent || '');
  }

  /** Query tree item (.tree-item) by label — fails if not found */
  function itemByLabel(label: string): HTMLElement {
    const el = Array.from(document.querySelectorAll('.folder-tree .tree-item')).find(
      item => item.querySelector('.tree-label')?.textContent === label
    );
    if (!el) throw new Error(`tree item not found: ${label}`);
    return el as HTMLElement;
  }

  it('renders system root folders (like Bookmarks Bar) and their children', async () => {
    const folders = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar' },
      { id: '2', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' }
    ];

    new FolderTree({ target, props: { folders } });
    await tick();

    // 'All Folders' + 'Bookmarks Bar' + 'Community' = 3 nodes
    const items = document.querySelectorAll('.folder-tree .tree-item');
    expect(items.length).toBe(3);
    expect(labels()).toEqual(['모든 폴더', 'Bookmarks Bar', '커뮤니티']);
    expect(document.body.textContent).toContain('Bookmarks Bar');

    // 'Bookmarks Bar' is top-level (depth 0) — 8px (0.5rem margin same as 'All Folders')
    const rootFolder = itemByLabel('Bookmarks Bar');
    expect(rootFolder.getAttribute('aria-level')).toBe('1');
    expect(rootFolder.style.paddingLeft).toBe('8px');

    // 'Community' is child (depth 1) — 8px + 16px = 24px
    const community = itemByLabel('커뮤니티');
    expect(community.getAttribute('aria-level')).toBe('2');
    expect(community.style.paddingLeft).toBe('24px');
  });

  it('expands folders through level 3 by default and keeps deeper levels collapsed', async () => {
    new FolderTree({ target, props: { folders: SYSTEM_ROOT_TREE } });
    await tick();

    // Depth 0-2 (Levels 1-3) auto-expanded -> displays up to 'Politics' (Level 3), 'Korea' (Level 4) is collapsed -> 'Seoul' (Level 5) not shown
    expect(labels()).toEqual(['모든 폴더', 'Bookmarks Bar', '커뮤니티', '정치', '한국']);
    expect(document.body.textContent).not.toContain('서울');

    expect(itemByLabel('Bookmarks Bar').getAttribute('aria-expanded')).toBe('true');
    expect(itemByLabel('커뮤니티').getAttribute('aria-expanded')).toBe('true');
    expect(itemByLabel('정치').getAttribute('aria-expanded')).toBe('true'); // Level 3 auto-expanded
    expect(itemByLabel('한국').getAttribute('aria-expanded')).toBe('false'); // Level 4 is not forced to expand
    expect(itemByLabel('한국').style.paddingLeft).toBe('56px'); // depth 3
  });

  it('toggles children via chevron without selecting the folder', async () => {
    const comp: any = new FolderTree({ target, props: { folders: SYSTEM_ROOT_TREE } });
    await tick();

    const changeEvents: any[] = [];
    comp.$on('change', (e: any) => changeEvents.push(e.detail));

    const chevron = itemByLabel('Bookmarks Bar').querySelector('.chevron') as HTMLButtonElement;
    expect(chevron).not.toBeNull();
    expect(chevron.classList.contains('open')).toBe(true);
    expect(chevron.getAttribute('aria-expanded')).toBe('true');
    expect(chevron.getAttribute('aria-label')).toBe('접기');

    // Collapse -> 'Community' hidden
    chevron.click();
    await tick();
    expect(labels()).toEqual(['모든 폴더', 'Bookmarks Bar']);
    expect(chevron.getAttribute('aria-expanded')).toBe('false');
    expect(chevron.getAttribute('aria-label')).toBe('펼치기');

    // Expand again -> re-displays 'Community' and auto-expanded descendants (Politics, Korea)
    chevron.click();
    await tick();
    expect(labels()).toEqual(['모든 폴더', 'Bookmarks Bar', '커뮤니티', '정치', '한국']);
    expect(chevron.getAttribute('aria-expanded')).toBe('true');

    // Chevron click uses stopPropagation -> selection (change) must not occur
    expect(changeEvents.length).toBe(0);
    // When mounted without value (=''), root-item ('All Folders') is active by design — remains so after chevron click
    expect(document.querySelectorAll('.folder-tree .tree-item.active').length).toBe(1);
    expect(document.querySelector('.folder-tree .root-item')?.classList.contains('active')).toBe(true);
  });

  it('selects a folder row, dispatches change with the folder path and marks it active', async () => {
    const folders = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar' },
      { id: '2', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' }
    ];

    const comp: any = new FolderTree({ target, props: { folders } });
    await tick();

    const changeHandler = vi.fn();
    comp.$on('change', changeHandler);

    itemByLabel('커뮤니티').click();
    await tick();

    expect(changeHandler).toHaveBeenCalledTimes(1);
    expect(changeHandler.mock.calls[0][0].detail).toEqual({ value: 'Bookmarks Bar/커뮤니티' });

    const activeItems = document.querySelectorAll('.folder-tree .tree-item.active');
    expect(activeItems.length).toBe(1);
    expect(activeItems[0].querySelector('.tree-label')?.textContent).toBe('커뮤니티');
    expect(activeItems[0].getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('.folder-tree .root-item')?.getAttribute('aria-selected')).toBe('false');
  });

  it('deselects to all folders when the root item is clicked', async () => {
    const folders = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar' },
      { id: '2', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' }
    ];

    const comp: any = new FolderTree({ target, props: { folders, value: 'Bookmarks Bar/커뮤니티' } });
    await tick();

    const changeHandler = vi.fn();
    comp.$on('change', changeHandler);

    // Initial: folder selected state -> root-item inactive
    expect(document.querySelector('.folder-tree .root-item')?.classList.contains('active')).toBe(false);

    (document.querySelector('.folder-tree .root-item') as HTMLElement).click();
    await tick();

    expect(changeHandler).toHaveBeenCalledTimes(1);
    expect(changeHandler.mock.calls[0][0].detail).toEqual({ value: '' });
    expect(document.querySelector('.folder-tree .root-item')?.classList.contains('active')).toBe(true);
    expect(document.querySelector('.folder-tree .root-item')?.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelectorAll('.folder-tree .tree-item.active').length).toBe(1); // root-item only
  });

  it('auto-expands ancestors of the selected folder so it stays visible', async () => {
    const comp: any = new FolderTree({
      target,
      props: { folders: SYSTEM_ROOT_TREE, value: 'Bookmarks Bar/커뮤니티/정치' }
    });
    await tick();

    // Ancestors of value ('Bookmarks Bar', 'Community') expand, displaying 'Politics' node
    expect(labels()).toEqual(['모든 폴더', 'Bookmarks Bar', '커뮤니티', '정치', '한국']);
    expect(itemByLabel('정치').classList.contains('active')).toBe(true);
    expect(document.body.textContent).not.toContain('서울');

    // Change props (value to deeper path) -> auto-expand 3 ancestor levels (Bookmarks Bar, Community, Politics) -> displays 'Korea'.
    // 'Korea' (Level 4) itself is not forced to expand, so its child 'Seoul' remains hidden
    comp.$set({ value: 'Bookmarks Bar/커뮤니티/정치/한국' });
    await tick();

    expect(labels()).toEqual(['모든 폴더', 'Bookmarks Bar', '커뮤니티', '정치', '한국']);
    expect(document.body.textContent).not.toContain('서울');
    const korea = itemByLabel('한국');
    expect(korea.classList.contains('active')).toBe(true);
    expect(korea.getAttribute('aria-level')).toBe('4'); // depth 3 + 1
    expect(korea.style.paddingLeft).toBe('56px');
    expect(itemByLabel('정치').getAttribute('aria-expanded')).toBe('true');
    expect(korea.getAttribute('aria-expanded')).toBe('false'); // Level 4 is not forced to expand even when selected
  });
  it('renders per-folder and root counts when counts/rootCount props are provided', async () => {
    // counts keys are based on normalized path (system root removed) — looked up regardless of raw node path
    const counts = { '커뮤니티': 3, '커뮤니티/정치': 1 };

    new FolderTree({ target, props: { folders: SYSTEM_ROOT_TREE, counts, rootCount: 10 } });
    await tick();

    // root row ('All Folders'): rootCount badge
    const rootItem = itemByLabel('모든 폴더');
    expect(rootItem.querySelector('.tree-count')?.textContent).toBe('10');

    // Folder row: counts value badge (count including descendants)
    const commItem = itemByLabel('커뮤니티');
    expect(commItem.querySelector('.tree-count')?.textContent).toBe('3');

    // Auto-expanded up to Level 3 -> verify 'Politics' badge immediately
    const politicsItem = itemByLabel('정치');
    expect(politicsItem.querySelector('.tree-count')?.textContent).toBe('1');

    // Folders not in counts ('Korea') have no visible class — empty placeholder maintained
    const koreaCount = itemByLabel('한국').querySelector('.tree-count') as HTMLElement;
    expect(koreaCount.classList.contains('visible')).toBe(false);
  });

  it('keeps levels 1-3 expanded after folder reorder or deletion updates', async () => {
    const comp: any = new FolderTree({ target, props: { folders: SYSTEM_ROOT_TREE } });
    await tick();
    expect(labels()).toEqual(['모든 폴더', 'Bookmarks Bar', '커뮤니티', '정치', '한국']);

    // Folder reordering (change order) + partial deletion -> Levels 1-3 still remain auto-expanded
    const reordered = [
      { id: '3', title: '정치', path: 'Bookmarks Bar/커뮤니티/정치', parentId: '2' },
      { id: '2', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' },
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar' }
      // 'Korea' (id 4), 'Seoul' (id 5) deleted
    ];
    comp.$set({ folders: reordered });
    await tick();

    // Deleted descendants disappear, remaining Levels 1-3 (Bookmarks Bar, Community, Politics) remain expanded
    expect(labels()).toEqual(['모든 폴더', 'Bookmarks Bar', '커뮤니티', '정치']);
    expect(itemByLabel('Bookmarks Bar').getAttribute('aria-expanded')).toBe('true');
    expect(itemByLabel('커뮤니티').getAttribute('aria-expanded')).toBe('true');
    // 'Politics' became a leaf due to child deletion, so no aria-expanded — node is still rendered (verified via labels)
    expect(document.body.textContent).not.toContain('한국');
    expect(document.body.textContent).not.toContain('서울');
  });

  it('handles duplicate folder paths with different IDs without crashing or throwing duplicate key error', async () => {
    const foldersWithDuplicates = [
      { id: '1', title: 'Other bookmarks', path: 'Other bookmarks' },
      { id: '2', title: 'Other bookmarks', path: 'Other bookmarks/Other bookmarks', parentId: '1' },
      { id: '3', title: 'Other bookmarks', path: 'Other bookmarks/Other bookmarks', parentId: '1' }
    ];

    expect(() => {
      new FolderTree({ target, props: { folders: foldersWithDuplicates } });
    }).not.toThrow();

    await tick();
    const items = document.querySelectorAll('.folder-tree .tree-item');
    expect(items.length).toBeGreaterThan(1);
  });

  it('reorders a folder among its siblings when dragged vertically (same parent scope)', async () => {
    const folders = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar' },
      { id: '2', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' },
      { id: '3', title: '테크', path: 'Bookmarks Bar/테크', parentId: '1' },
      { id: '4', title: '게임', path: 'Bookmarks Bar/게임', parentId: '1' }
    ];
    const comp: any = new FolderTree({ target, props: { folders } });
    await tick();

    // Mock Y-coordinates of sibling rows in DOM order (all depth 1 at 32px intervals) -> drag insert calculation possible
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.tree-item[data-folder-id]'));
    rows.forEach((el, i) => {
      const top = 100 + i * 32;
      el.getBoundingClientRect = () =>
        ({ top, bottom: top + 32, height: 32, left: 0, right: 200, width: 200, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    });
    document.querySelector<HTMLElement>('.tree-scroll')!.getBoundingClientRect = () =>
      ({ top: 100, bottom: 400, height: 300, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;

    const reorderEvents: any[] = [];
    comp.$on('reorder', (e: any) => reorderEvents.push(e.detail));

    // Grab move button of 'Community' (id 2, index 0) row
    const moveBtn = itemByLabel('커뮤니티').querySelector('.row-move') as HTMLElement;
    moveBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientY: 100 }));
    await tick();

    // Drag down below 'Tech' (index 2, center≈180) -> insertPos=1
    moveBtn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: 190 }));
    await tick();
    expect(reorderEvents.length).toBe(0); // Before drop

    moveBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await tick();

    expect(reorderEvents.length).toBe(1);
    expect(reorderEvents[0].folderId).toBe('2');
    expect(reorderEvents[0].parentId).toBe('1');
    expect(reorderEvents[0].value).toBe('Bookmarks Bar/커뮤니티');
    expect(reorderEvents[0].order).toEqual(['3', '2', '4']); // Move before Tech
  });

  it('ignores drop when dragged back to the original sibling position', async () => {
    const folders = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar' },
      { id: '2', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' },
      { id: '3', title: '테크', path: 'Bookmarks Bar/테크', parentId: '1' }
    ];
    const comp: any = new FolderTree({ target, props: { folders } });
    await tick();

    const rows = Array.from(document.querySelectorAll<HTMLElement>('.tree-item[data-folder-id]'));
    rows.forEach((el, i) => {
      const top = 100 + i * 32;
      el.getBoundingClientRect = () =>
        ({ top, bottom: top + 32, height: 32, left: 0, right: 200, width: 200, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    });
    document.querySelector<HTMLElement>('.tree-scroll')!.getBoundingClientRect = () =>
      ({ top: 100, bottom: 400, height: 300, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;

    const reorderEvents: any[] = [];
    comp.$on('reorder', (e: any) => reorderEvents.push(e.detail));

    // Grabbing 'Community' (id 2) and dropping in place (original position) does not trigger reorder
    const moveBtn = itemByLabel('커뮤니티').querySelector('.row-move') as HTMLElement;
    moveBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientY: 100 }));
    await tick();
    moveBtn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: 100 }));
    await tick();
    moveBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await tick();

    expect(reorderEvents.length).toBe(0);
  });

  it('renders clean button on root item (All Folders) and dispatches clean event with empty path on click', async () => {
    const folders = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar' },
      { id: '2', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' }
    ];
    const comp: any = new FolderTree({ target, props: { folders } });
    await tick();

    const cleanEvents: any[] = [];
    comp.$on('clean', (e: any) => cleanEvents.push(e.detail));

    const rootItem = document.querySelector('.folder-tree .root-item') as HTMLElement;
    expect(rootItem).not.toBeNull();

    const cleanBtn = rootItem.querySelector('.row-clean') as HTMLButtonElement;
    expect(cleanBtn).not.toBeNull();
    expect(cleanBtn.getAttribute('title')).toBe('빈 폴더 정리');

    cleanBtn.click();
    await tick();

    expect(cleanEvents.length).toBe(1);
    expect(cleanEvents[0]).toEqual({
      value: '',
      folderId: undefined,
      title: '모든 폴더'
    });
  });

  it('renders clean button on system root folders and delete button on regular folders', async () => {
    const folders = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar' },
      { id: '2', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' }
    ];
    const comp: any = new FolderTree({ target, props: { folders } });
    await tick();

    const cleanEvents: any[] = [];
    const deleteEvents: any[] = [];
    comp.$on('clean', (e: any) => cleanEvents.push(e.detail));
    comp.$on('delete', (e: any) => deleteEvents.push(e.detail));

    // System root folder: Bookmarks Bar has clean button (.row-clean), no delete (.row-delete) or move (.row-move)
    const rootFolderItem = itemByLabel('Bookmarks Bar');
    const systemCleanBtn = rootFolderItem.querySelector('.row-clean') as HTMLButtonElement;
    expect(systemCleanBtn).not.toBeNull();
    expect(rootFolderItem.querySelector('.row-delete')).toBeNull();
    expect(rootFolderItem.querySelector('.row-move')).toBeNull();

    // Regular folder: Community has move (.row-move) and delete (.row-delete), no clean (.row-clean)
    const commItem = itemByLabel('커뮤니티');
    expect(commItem.querySelector('.row-clean')).toBeNull();
    expect(commItem.querySelector('.row-delete')).not.toBeNull();
    expect(commItem.querySelector('.row-move')).not.toBeNull();

    // Clicking clean on system root folder dispatches clean event
    systemCleanBtn.click();
    await tick();

    expect(cleanEvents.length).toBe(1);
    expect(cleanEvents[0]).toEqual({
      value: 'Bookmarks Bar',
      folderId: '1',
      title: 'Bookmarks Bar'
    });

    // Clicking delete on regular folder dispatches delete event
    const commDeleteBtn = commItem.querySelector('.row-delete') as HTMLButtonElement;
    commDeleteBtn.click();
    await tick();

    expect(deleteEvents.length).toBe(1);
    expect(deleteEvents[0]).toEqual({ value: 'Bookmarks Bar/커뮤니티' });
  });
});
