import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tick } from 'svelte';

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

describe('FolderTree rename (row-edit)', () => {
  let target: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
  });

  const TEST_FOLDERS = [
    { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar' },
    { id: '2', title: 'Development', path: 'Bookmarks Bar/Development', parentId: '1' },
    { id: '3', title: 'Frontend', path: 'Bookmarks Bar/Development/Frontend', parentId: '2' },
    { id: 'other', title: 'Other Bookmarks', path: 'Other Bookmarks' }
  ];

  it('renders row-edit button on regular folders', async () => {
    new FolderTree({ target, props: { folders: TEST_FOLDERS } });
    await tick();

    const devItem = Array.from(document.querySelectorAll('.tree-item')).find(
      (el) => el.querySelector('.tree-label')?.textContent === 'Development'
    );
    expect(devItem).toBeDefined();
    const editBtn = devItem?.querySelector('.row-action.row-edit') as HTMLButtonElement;
    expect(editBtn).not.toBeNull();
    expect(editBtn.getAttribute('title')).toBe(i18n.t('common.edit'));
  });

  it('does NOT render row-edit button on system root folders', async () => {
    new FolderTree({ target, props: { folders: TEST_FOLDERS } });
    await tick();

    const rootItem = Array.from(document.querySelectorAll('.tree-item')).find(
      (el) => el.querySelector('.tree-label')?.textContent === 'Bookmarks Bar'
    );
    expect(rootItem).toBeDefined();
    expect(rootItem?.querySelector('.row-action.row-edit')).toBeNull();

    const otherItem = Array.from(document.querySelectorAll('.tree-item')).find(
      (el) => el.querySelector('.tree-label')?.textContent === 'Other Bookmarks'
    );
    expect(otherItem).toBeDefined();
    expect(otherItem?.querySelector('.row-action.row-edit')).toBeNull();
  });

  it('dispatches edit event with folder details when row-edit is clicked', async () => {
    const comp = new FolderTree({ target, props: { folders: TEST_FOLDERS } });
    await tick();

    const editEvents: any[] = [];
    comp.$on('edit', (e: any) => editEvents.push(e.detail));

    const devItem = Array.from(document.querySelectorAll('.tree-item')).find(
      (el) => el.querySelector('.tree-label')?.textContent === 'Development'
    );
    const editBtn = devItem?.querySelector('.row-action.row-edit') as HTMLButtonElement;
    expect(editBtn).not.toBeNull();

    editBtn.click();
    await tick();

    expect(editEvents.length).toBe(1);
    expect(editEvents[0]).toEqual({
      value: 'Bookmarks Bar/Development',
      id: '2',
      folderId: '2',
      title: 'Development',
      path: 'Bookmarks Bar/Development',
      parentId: '1'
    });
  });

  it('stops event propagation when clicking row-edit so change event is not triggered', async () => {
    const comp = new FolderTree({ target, props: { folders: TEST_FOLDERS } });
    await tick();

    const changeEvents: any[] = [];
    const editEvents: any[] = [];
    comp.$on('change', (e: any) => changeEvents.push(e.detail));
    comp.$on('edit', (e: any) => editEvents.push(e.detail));

    const devItem = Array.from(document.querySelectorAll('.tree-item')).find(
      (el) => el.querySelector('.tree-label')?.textContent === 'Development'
    );
    const editBtn = devItem?.querySelector('.row-action.row-edit') as HTMLButtonElement;

    editBtn.click();
    await tick();

    expect(editEvents.length).toBe(1);
    expect(changeEvents.length).toBe(0);
  });
});
