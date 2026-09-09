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

const TREE = [
  { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar' },
  { id: '2', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' },
  { id: '3', title: '테크', path: 'Bookmarks Bar/테크', parentId: '1' },
  { id: '4', title: '게임', path: 'Bookmarks Bar/게임', parentId: '1' }
];

describe('FolderTree.svelte - hover action buttons & left-button drag', () => {
  let target: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
  });

  function itemByLabel(label: string): HTMLElement {
    const el = Array.from(document.querySelectorAll('.folder-tree .tree-item')).find(
      item => item.querySelector('.tree-label')?.textContent === label
    );
    if (!el) throw new Error(`tree item not found: ${label}`);
    return el as HTMLElement;
  }

  /** Mock getBoundingClientRect for sibling rows + scroll container with 32px intervals (same as existing reorder tests) */
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

  it('renders move/delete hover action buttons on every folder row but not on the root item', async () => {
    new FolderTree({ target, props: { folders: TREE } });
    await tick();

    // Root row ('All Folders') must have clean button (.row-clean), not move/delete
    const rootItem = document.querySelector('.folder-tree .root-item') as HTMLElement;
    expect(rootItem.querySelector('.row-move')).toBeNull();
    expect(rootItem.querySelector('.row-delete')).toBeNull();
    expect(rootItem.querySelector('.row-clean')).not.toBeNull();

    // System root (Bookmarks Bar) must have clean button (.row-clean), not move/delete
    const barItem = itemByLabel('Bookmarks Bar');
    expect(barItem.querySelector('.row-move')).toBeNull();
    expect(barItem.querySelector('.row-delete')).toBeNull();
    expect(barItem.querySelector('.row-clean')).not.toBeNull();

    // Non-system root folder rows must have .row-move / .row-delete with aria-label in '{title} Move/Delete' format
    for (const label of ['커뮤니티', '테크', '게임']) {
      const item = itemByLabel(label);
      const move = item.querySelector('.row-action.row-move') as HTMLButtonElement;
      const del = item.querySelector('.row-action.row-delete') as HTMLButtonElement;
      expect(move).toBeTruthy();
      expect(del).toBeTruthy();
      expect(move.getAttribute('aria-label')).toBe(`${label} 이동`);
      expect(del.getAttribute('aria-label')).toBe(`${label} 삭제`);
      expect(move.getAttribute('title')).toBe('이동');
      expect(del.getAttribute('title')).toBe('삭제');
    }
  });

  it('shows move handle with grab cursor class and marks the tree dragging during a left-button drag', async () => {
    const comp: any = new FolderTree({ target, props: { folders: TREE } });
    await tick();

    // Move handle rendered with .row-move class indicating grab cursor
    const moveBtn = itemByLabel('커뮤니티').querySelector('.row-move') as HTMLElement;
    expect(moveBtn.classList.contains('row-move')).toBe(true);

    mockRowGeometry();
    const reorderEvents: any[] = [];
    comp.$on('reorder', (e: any) => reorderEvents.push(e.detail));

    // Before drag start: dragging class not on tree scroll container
    expect(document.querySelector('.tree-scroll')!.classList.contains('dragging')).toBe(false);

    // Left button (button 0) pointerdown -> start drag -> assign dragging class
    moveBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientY: 100 }));
    await tick();
    expect(document.querySelector('.tree-scroll')!.classList.contains('dragging')).toBe(true);
    expect(itemByLabel('커뮤니티').classList.contains('dragging-target')).toBe(true);

    moveBtn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: 190 }));
    await tick();
    moveBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await tick();

    // End drag -> remove dragging class, emit reorder event
    expect(document.querySelector('.tree-scroll')!.classList.contains('dragging')).toBe(false);
    expect(reorderEvents.length).toBe(1);
    expect(reorderEvents[0].folderId).toBe('2');
  });

  it('ignores non-left buttons: right-button press on the move handle does not start a drag', async () => {
    const comp: any = new FolderTree({ target, props: { folders: TREE } });
    await tick();
    mockRowGeometry();

    const reorderEvents: any[] = [];
    comp.$on('reorder', (e: any) => reorderEvents.push(e.detail));

    const moveBtn = itemByLabel('커뮤니티').querySelector('.row-move') as HTMLElement;
    // Right click (button 2) -> drag must not start
    moveBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2, clientY: 100 }));
    await tick();
    expect(document.querySelector('.tree-scroll')!.classList.contains('dragging')).toBe(false);

    moveBtn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: 190 }));
    await tick();
    moveBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await tick();

    expect(reorderEvents.length).toBe(0);
  });

  it('starts a drag for a folder with a single sibling (reorder is a no-op but cross-parent move stays enabled)', async () => {
    // Single sibling (self only) -> reorder impossible but drag must start.
    // onDragEnd treats fromIndex===target (0===0) as no-op, so reorder does not fire.
    const single = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar' },
      { id: '2', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' }
    ];
    const comp: any = new FolderTree({ target, props: { folders: single } });
    await tick();
    mockRowGeometry();

    const reorderEvents: any[] = [];
    comp.$on('reorder', (e: any) => reorderEvents.push(e.detail));

    const moveBtn = itemByLabel('커뮤니티').querySelector('.row-move') as HTMLElement;
    moveBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientY: 100 }));
    await tick();
    // Drag starts (for cross-parent move)
    expect(document.querySelector('.tree-scroll')!.classList.contains('dragging')).toBe(true);
    expect(itemByLabel('커뮤니티').classList.contains('dragging-target')).toBe(true);

    moveBtn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: 100 }));
    await tick();
    moveBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await tick();
    // End drag -> remove dragging class
    expect(document.querySelector('.tree-scroll')!.classList.contains('dragging')).toBe(false);
    // Only one sibling -> reorder no-op
    expect(reorderEvents.length).toBe(0);
  });

  it('system root folder (Bookmarks Bar) is excluded from drag reorder even when it is a root sibling', async () => {
    // Real Chrome structure: Bookmarks Bar (id '1') / Other bookmarks (id '2') both have parentId '0', forming siblings (2 items).
    // Roots must not be moved/reordered relative to each other, so drag must not start even with 2 siblings.
    const twoRoots = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', parentId: '0' },
      { id: '2', title: 'Other bookmarks', path: 'Other bookmarks', parentId: '0' },
      { id: '3', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' },
      { id: '4', title: '테크', path: 'Other bookmarks/테크', parentId: '2' }
    ];
    const comp: any = new FolderTree({ target, props: { folders: twoRoots } });
    await tick();
    mockRowGeometry();

    const reorderEvents: any[] = [];
    comp.$on('reorder', (e: any) => reorderEvents.push(e.detail));

    // Move handle not rendered for system root, so there is no way to initiate drag
    const barMove = itemByLabel('Bookmarks Bar').querySelector('.row-move');
    const otherMove = itemByLabel('Other bookmarks').querySelector('.row-move');
    expect(barMove).toBeNull();
    expect(otherMove).toBeNull();
    expect(document.querySelector('.tree-scroll')!.classList.contains('dragging')).toBe(false);

    // Regular folders retain move handles (maintaining mutual movement of internal folders)
    expect(itemByLabel('커뮤니티').querySelector('.row-move')).toBeTruthy();

    expect(reorderEvents.length).toBe(0);
  });
});
