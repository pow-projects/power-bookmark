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

// Reflects real Chrome structure: Bookmarks Bar ('1') / Other bookmarks ('2') are siblings with parentId '0'.
// 'Community' (3) and 'Tech' (4) are siblings under Bookmarks Bar, 'Games' (5) is a child of Other bookmarks,
// 'Sub' (6) is a descendant of Community (3).
const TREE = [
  { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', parentId: '0' },
  { id: '2', title: 'Other bookmarks', path: 'Other bookmarks', parentId: '0' },
  { id: '3', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' },
  { id: '4', title: '테크', path: 'Bookmarks Bar/테크', parentId: '1' },
  { id: '5', title: '게임', path: 'Other bookmarks/게임', parentId: '2' },
  { id: '6', title: '서브', path: 'Bookmarks Bar/커뮤니티/서브', parentId: '3' }
];

describe('FolderTree.svelte - cross-folder move (reparent via move event)', () => {
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

  function rowCenterY(label: string): number {
    const el = itemByLabel(label);
    const r = el.getBoundingClientRect();
    return r.top + r.height / 2;
  }

  /** Mock getBoundingClientRect for sibling/cross rows + scroll container with 32px intervals (same as existing reorder tests).
   *  DOM order = flatNodes (DFS expansion order) = [1,3,6,4,2,5] -> row top is 100+i*32. */
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

  interface EventLog {
    move: any[];
    reorder: any[];
  }

  function mountWithListeners(): { comp: any; log: EventLog } {
    const comp: any = new FolderTree({ target, props: { folders: TREE } });
    const log: EventLog = { move: [], reorder: [] };
    comp.$on('move', (e: any) => log.move.push(e.detail));
    comp.$on('reorder', (e: any) => log.reorder.push(e.detail));
    return { comp, log };
  }

  /** Start drag using left move handle (pointerdown->pointermove->pointerup) and drop at specified coordinates */
  async function drag(sourceLabel: string, clientY: number, clientX = 100) {
    const moveBtn = itemByLabel(sourceLabel).querySelector('.row-move') as HTMLElement;
    moveBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientY }));
    await tick();
    moveBtn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX, clientY }));
    await tick();
    moveBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await tick();
  }

  it('1. 비-sibling(교차 부모) 행에 드롭 → reorder 대신 move emit (targetParentId = 대상 폴더 id)', async () => {
    const { comp, log } = mountWithListeners();
    await tick();
    mockRowGeometry(); // Geometry mock after rows are rendered

    // Drop 'Community' (3) onto 'Games' (5, non-sibling under Other bookmarks) row
    await drag('커뮤니티', rowCenterY('게임'));

    expect(log.move.length).toBe(1);
    expect(log.move[0].folderId).toBe('3');
    expect(log.move[0].targetParentId).toBe('5'); // 'Games' folder id
    expect(log.move[0].targetPath).toBe('Other bookmarks/게임');
    expect(log.reorder.length).toBe(0); // reorder must not be emitted
  });

  it('2. 시스템 루트 행(Other bookmarks)에 드롭 → move emit (소스는 시스템 루트가 아님)', async () => {
    const { comp, log } = mountWithListeners();
    await tick();
    mockRowGeometry();

    // Drop 'Community' (3) onto system root 'Other bookmarks' (2) row -> move to top level
    await drag('커뮤니티', rowCenterY('Other bookmarks'));

    expect(log.move.length).toBe(1);
    expect(log.move[0].folderId).toBe('3');
    expect(log.move[0].targetParentId).toBe('2'); // 'Other bookmarks' id
    expect(log.reorder.length).toBe(0);
  });

  it('3. sibling 행 위 드롭 → reorder emit (move 미발생, 기존 재정렬 동작 유지)', async () => {
    const { comp, log } = mountWithListeners();
    await tick();
    mockRowGeometry();

    // Drop 'Community' (3) below sibling 'Tech' (4) under same parent -> reorder
    await drag('커뮤니티', rowCenterY('테크') + 10);

    expect(log.move.length).toBe(0);
    expect(log.reorder.length).toBe(1);
    expect(log.reorder[0].folderId).toBe('3');
  });

  it('4. 자신에게 드롭 → move도 reorder도 emit하지 않음', async () => {
    const { comp, log } = mountWithListeners();
    await tick();
    mockRowGeometry();

    await drag('커뮤니티', rowCenterY('커뮤니티'));

    expect(log.move.length).toBe(0);
    expect(log.reorder.length).toBe(0);
  });

  it('5. descendant(자식) 행에 드롭 → move 미발생 (사이클 방지)', async () => {
    const { comp, log } = mountWithListeners();
    await tick();
    mockRowGeometry();

    // Drop 'Community' (3) onto its child 'Sub' (6) row -> cycle -> block
    await drag('커뮤니티', rowCenterY('서브'));

    expect(log.move.length).toBe(0);
    expect(log.reorder.length).toBe(0);
  });

  it('6. .drop-target 클래스는 유효한 이동 대상 행에만 토글된다', async () => {
    const { comp, log } = mountWithListeners();
    await tick();
    mockRowGeometry();

    const moveBtn = itemByLabel('커뮤니티').querySelector('.row-move') as HTMLElement;
    moveBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientY: 100 }));
    await tick();

    // Move over non-sibling 'Games' row -> apply drop-target highlight
    moveBtn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 100, clientY: rowCenterY('게임') }));
    await tick();
    expect(itemByLabel('게임').classList.contains('drop-target')).toBe(true);
    // drop-target not applied to sibling 'Tech' row (reorder target)
    expect(itemByLabel('테크').classList.contains('drop-target')).toBe(false);
    // Not applied to self either
    expect(itemByLabel('커뮤니티').classList.contains('drop-target')).toBe(false);

    // Remove highlight after drop completes
    moveBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await tick();
    expect(itemByLabel('게임').classList.contains('drop-target')).toBe(false);
    // Drop over valid move target -> emit move
    expect(log.move.length).toBe(1);
  });

  it('7. 시스템 루트(Bookmarks Bar/Other bookmarks)는 이동 핸들 미보유 — 드래그 소스 불가', async () => {
    const { comp, log } = mountWithListeners();
    await tick();
    mockRowGeometry();

    expect(itemByLabel('Bookmarks Bar').querySelector('.row-move')).toBeNull();
    expect(itemByLabel('Other bookmarks').querySelector('.row-move')).toBeNull();

    // No move handle, so reorder/move events cannot occur
    expect(log.move.length).toBe(0);
    expect(log.reorder.length).toBe(0);
  });
});

// ── Single subfolder (only one subfolder) move regression test (t_314f6b89)
describe('FolderTree.svelte - single-child folder cross-parent move regression', () => {
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

  function rowCenterY(label: string): number {
    const el = itemByLabel(label);
    const r = el.getBoundingClientRect();
    return r.top + r.height / 2;
  }

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

  function mount(folders: any[]): { comp: any; log: { move: any[]; reorder: any[] } } {
    const comp: any = new FolderTree({ target, props: { folders } });
    const log = { move: [] as any[], reorder: [] as any[] };
    comp.$on('move', (e: any) => log.move.push(e.detail));
    comp.$on('reorder', (e: any) => log.reorder.push(e.detail));
    return { comp, log };
  }

  async function drag(sourceLabel: string, clientY: number, clientX = 100) {
    const moveBtn = itemByLabel(sourceLabel).querySelector('.row-move') as HTMLElement;
    moveBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientY }));
    await tick();
    moveBtn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX, clientY }));
    await tick();
    moveBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await tick();
  }

  // A — 1 subfolder (bug case): drop sole child under parent onto non-sibling row -> 1 move / 0 reorder
  it('A. 단일 하위 폴더를 비-sibling 행에 드롭 → move emit 1건, reorder 0건', async () => {
    const single = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', parentId: '0' },
      { id: '2', title: 'Other bookmarks', path: 'Other bookmarks', parentId: '0' },
      { id: '3', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' },
      { id: '5', title: '게임', path: 'Other bookmarks/게임', parentId: '2' }
    ];
    const { comp, log } = mount(single);
    await tick();
    mockRowGeometry();

    await drag('커뮤니티', rowCenterY('게임'));

    expect(log.move.length).toBe(1);
    expect(log.move[0].folderId).toBe('3');
    expect(log.move[0].targetParentId).toBe('5');
    expect(log.move[0].targetPath).toBe('Other bookmarks/게임');
    expect(log.reorder.length).toBe(0);
  });

  // B — 0 subfolders (leaf folder): move childless single leaf folder to cross parent -> emit move (normal even with empty descendants set)
  it('B. 리프(하위 0개) 단일 폴더를 교차 부모 행에 드롭 → move emit', async () => {
    const single = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', parentId: '0' },
      { id: '2', title: 'Other bookmarks', path: 'Other bookmarks', parentId: '0' },
      { id: '3', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' },
      { id: '5', title: '게임', path: 'Other bookmarks/게임', parentId: '2' }
    ];
    const { comp, log } = mount(single);
    await tick();
    mockRowGeometry();

    await drag('커뮤니티', rowCenterY('게임'));

    expect(log.move.length).toBe(1);
    expect(log.move[0].folderId).toBe('3');
    expect(log.move[0].targetParentId).toBe('5');
    expect(log.reorder.length).toBe(0);
  });

  // D1 — Single child -> drop on system root (Other bookmarks) -> 1 move (targetParentId=root id)
  it('D1. 단일 하위 폴더를 시스템 루트 행에 드롭 → move emit (targetParentId = 루트 id)', async () => {
    const single = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', parentId: '0' },
      { id: '2', title: 'Other bookmarks', path: 'Other bookmarks', parentId: '0' },
      { id: '3', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' }
    ];
    const { comp, log } = mount(single);
    await tick();
    mockRowGeometry();

    await drag('커뮤니티', rowCenterY('Other bookmarks'));

    expect(log.move.length).toBe(1);
    expect(log.move[0].folderId).toBe('3');
    expect(log.move[0].targetParentId).toBe('2');
    expect(log.reorder.length).toBe(0);
  });

  // D2 — Single child -> drop on self -> 0 move / 0 reorder
  it('D2. 단일 하위 폴더를 자기 자신에 드롭 → move·reorder 0건', async () => {
    const single = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', parentId: '0' },
      { id: '2', title: 'Other bookmarks', path: 'Other bookmarks', parentId: '0' },
      { id: '3', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' },
      { id: '5', title: '게임', path: 'Other bookmarks/게임', parentId: '2' }
    ];
    const { comp, log } = mount(single);
    await tick();
    mockRowGeometry();

    await drag('커뮤니티', rowCenterY('커뮤니티'));

    expect(log.move.length).toBe(0);
    expect(log.reorder.length).toBe(0);
  });

  // D3 — Drop in place (no sibling) -> fromIndex===target -> reorder no-op
  it('D3. 제자리 드롭(no sibling) → reorder 0건', async () => {
    const single = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', parentId: '0' },
      { id: '3', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' }
    ];
    const { comp, log } = mount(single);
    await tick();
    mockRowGeometry();

    await drag('커뮤니티', rowCenterY('커뮤니티'));

    expect(log.move.length).toBe(0);
    expect(log.reorder.length).toBe(0);
  });

  // D4 — Single child with descendants -> drop on descendant row -> block cycle (0 move)
  it('D4. descendant 보유 단일 폴더를 그 descendant 행에 드롭 → move 0건 (사이클 차단)', async () => {
    const single = [
      { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', parentId: '0' },
      { id: '2', title: 'Other bookmarks', path: 'Other bookmarks', parentId: '0' },
      { id: '3', title: '커뮤니티', path: 'Bookmarks Bar/커뮤니티', parentId: '1' },
      { id: '6', title: '서브', path: 'Bookmarks Bar/커뮤니티/서브', parentId: '3' }
    ];
    const { comp, log } = mount(single);
    await tick();
    mockRowGeometry();

    await drag('커뮤니티', rowCenterY('서브'));

    expect(log.move.length).toBe(0);
    expect(log.reorder.length).toBe(0);
  });
});

// ── 3-Zone Hit-Testing & Enhanced Cross-Move / Sibling Inside Specification Tests
describe('FolderTree.svelte - 3-Zone Hit-Testing specification', () => {
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

  function rowTop(label: string): number {
    return itemByLabel(label).getBoundingClientRect().top;
  }

  function rowBottom(label: string): number {
    return itemByLabel(label).getBoundingClientRect().bottom;
  }

  function rowCenterY(label: string): number {
    const el = itemByLabel(label);
    const r = el.getBoundingClientRect();
    return r.top + r.height / 2;
  }

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

  function mountWithListeners(): { comp: any; log: { move: any[]; reorder: any[] } } {
    const comp: any = new FolderTree({ target, props: { folders: TREE } });
    const log = { move: [] as any[], reorder: [] as any[] };
    comp.$on('move', (e: any) => log.move.push(e.detail));
    comp.$on('reorder', (e: any) => log.reorder.push(e.detail));
    return { comp, log };
  }

  async function drag(sourceLabel: string, clientY: number, clientX = 100) {
    const moveBtn = itemByLabel(sourceLabel).querySelector('.row-move') as HTMLElement;
    moveBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientY }));
    await tick();
    moveBtn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX, clientY }));
    await tick();
    moveBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await tick();
  }

  it('1. 동일 부모(형제) 폴더 중앙(rowCenterY) 드롭 시 inside 판정 -> move 이벤트 발생 (targetParentId = 형제 id)', async () => {
    const { comp, log } = mountWithListeners();
    await tick();
    mockRowGeometry();

    // Drag sibling 'Community' (3) and drop at center (ratio=0.5) of sibling 'Tech' (4)
    await drag('커뮤니티', rowCenterY('테크'));

    expect(log.move.length).toBe(1);
    expect(log.move[0].folderId).toBe('3');
    expect(log.move[0].targetParentId).toBe('4');
    expect(log.move[0].position).toBe('inside');
    expect(log.move[0].referenceFolderId).toBe('4');
    expect(log.reorder.length).toBe(0);
  });

  it('2. 비형제 폴더 상단(r < 0.25) 드롭 시 before 판정 -> move 이벤트 발생 (targetParentId = 대상의 parentId, position: before)', async () => {
    const { comp, log } = mountWithListeners();
    await tick();
    mockRowGeometry();

    // Drag 'Community' (3) and drop on upper 12.5% (top + 4px) of non-sibling 'Games' (5, parentId: '2')
    await drag('커뮤니티', rowTop('게임') + 4);

    expect(log.move.length).toBe(1);
    expect(log.move[0].folderId).toBe('3');
    expect(log.move[0].targetParentId).toBe('2');
    expect(log.move[0].position).toBe('before');
    expect(log.move[0].referenceFolderId).toBe('5');
    expect(log.move[0].targetIndex).toBe(0);
    expect(log.reorder.length).toBe(0);
  });

  it('3. 비형제 폴더 하단(r > 0.75) 드롭 시 after 판정 -> move 이벤트 발생 (targetParentId = 대상의 parentId, position: after)', async () => {
    const { comp, log } = mountWithListeners();
    await tick();
    mockRowGeometry();

    // Drag 'Community' (3) and drop on lower 12.5% (bottom - 4px) of non-sibling 'Games' (5, parentId: '2')
    await drag('커뮤니티', rowBottom('게임') - 4);

    expect(log.move.length).toBe(1);
    expect(log.move[0].folderId).toBe('3');
    expect(log.move[0].targetParentId).toBe('2');
    expect(log.move[0].position).toBe('after');
    expect(log.move[0].referenceFolderId).toBe('5');
    expect(log.move[0].targetIndex).toBe(1);
    expect(log.reorder.length).toBe(0);
  });

  it('4. 시스템 루트 폴더 상단/하단 드롭 시에도 inside로 강제 고정', async () => {
    const { comp, log } = mountWithListeners();
    await tick();
    mockRowGeometry();

    // Upper zone (r < 0.25) of system root 'Other bookmarks'
    await drag('커뮤니티', rowTop('Other bookmarks') + 4);
    expect(log.move.length).toBe(1);
    expect(log.move[0].targetParentId).toBe('2');
    expect(log.move[0].position).toBe('inside');
    expect(log.reorder.length).toBe(0);

    // Lower zone (r > 0.75) of system root 'Other bookmarks'
    await drag('커뮤니티', rowBottom('Other bookmarks') - 4);
    expect(log.move.length).toBe(2);
    expect(log.move[1].targetParentId).toBe('2');
    expect(log.move[1].position).toBe('inside');
    expect(log.reorder.length).toBe(0);
  });

  it('5. 자기 자신 또는 자손 노드로 드롭 시 move/reorder 모두 차단 (무효 영역)', async () => {
    const { comp, log } = mountWithListeners();
    await tick();
    mockRowGeometry();

    // Self: upper, center, lower
    await drag('커뮤니티', rowTop('커뮤니티') + 4);
    await drag('커뮤니티', rowCenterY('커뮤니티'));
    await drag('커뮤니티', rowBottom('커뮤니티') - 4);

    // Descendant: 'Sub' (6) upper, center, lower
    await drag('커뮤니티', rowTop('서브') + 4);
    await drag('커뮤니티', rowCenterY('서브'));
    await drag('커뮤니티', rowBottom('서브') - 4);

    expect(log.move.length).toBe(0);
    expect(log.reorder.length).toBe(0);
  });
});
