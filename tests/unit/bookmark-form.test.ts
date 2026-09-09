import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';
import BookmarkForm from '../../src/components/popup/BookmarkForm.svelte';

vi.stubGlobal('browser', {
  i18n: {
    getMessage: vi.fn((key: string) => {
      const messages: Record<string, string> = {
        label_title: '제목',
        label_folder: '폴더',
        label_description: '설명',
        btn_new_folder: '새 폴더',
        btn_create: '생성',
        btn_cancel: '취소',
        placeholder_new_folder: '새 폴더 이름'
      };
      return messages[key] || '';
    })
  }
});

describe('BookmarkForm.svelte - Folder Creation Logic', () => {
  let target: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
  });

  it('should render folder dropdown and selected title without indentation spaces', () => {
    new BookmarkForm({
      target,
      props: {
        title: 'Test',
        folderId: '1',
        folders: [{ id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar' }]
      }
    });

    const selectedText = document.querySelector('.selected-text');
    expect(selectedText).not.toBeNull();
    expect(selectedText?.textContent).toBe('Bookmarks Bar');

    const newFolderBox = document.querySelector('.new-folder-box');
    expect(newFolderBox).toBeNull();
  });

  it('should display selected folder title without indentation and show indented options when opened', async () => {
    new BookmarkForm({
      target,
      props: {
        title: 'Test',
        folderId: '2',
        folders: [
          { id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar', depth: 0 },
          { id: '2', title: 'Tech', path: 'Bookmarks Bar/Tech', depth: 1 }
        ]
      }
    });

    const selectedText = document.querySelector('.selected-text');
    expect(selectedText?.textContent).toBe('Tech');

    const trigger = document.querySelector('.select-trigger') as HTMLButtonElement;
    await trigger.click();
    await tick();

    const options = document.querySelectorAll('.option-item');
    expect(options.length).toBe(2);
    expect(options[0].querySelector('.item-title')?.textContent).toBe('Bookmarks Bar');
    expect(options[1].querySelector('.item-title')?.textContent).toBe('Tech');
  });

  it('should toggle new folder creation input box when new folder button is clicked', async () => {
    new BookmarkForm({
      target,
      props: {
        title: 'Test',
        folderId: '1',
        folders: [{ id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar' }]
      }
    });

    const newFolderBtn = document.querySelector('.btn-icon') as HTMLButtonElement;
    expect(newFolderBtn).not.toBeNull();
    await newFolderBtn.click();
    await tick();

    const newFolderBox = document.querySelector('.new-folder-box');
    expect(newFolderBox).not.toBeNull();

    const input = document.querySelector('.new-folder-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.placeholder).toBe('새 폴더 이름');
  });

  it('should dispatch createFolder event with trimmed title and current folderId when create button is clicked', async () => {
    const component = new BookmarkForm({
      target,
      props: {
        title: 'Test',
        folderId: '1',
        folders: [{ id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar' }]
      }
    });

    const createFolderSpy = vi.fn();
    component.$on('createFolder', createFolderSpy);

    const newFolderBtn = document.querySelector('.btn-icon') as HTMLButtonElement;
    await newFolderBtn.click();
    await tick();

    const input = document.querySelector('.new-folder-input') as HTMLInputElement;
    input.value = '  New Test Folder  ';
    input.dispatchEvent(new Event('input'));
    await tick();

    const submitBtn = document.querySelector('.new-folder-actions .btn-primary') as HTMLButtonElement;
    await submitBtn.click();
    await tick();

    expect(createFolderSpy).toHaveBeenCalledTimes(1);
    expect(createFolderSpy.mock.calls[0][0].detail).toEqual({
      title: 'New Test Folder',
      parentId: '1'
    });

    // Input box should close after creation
    expect(document.querySelector('.new-folder-box')).toBeNull();
  });

  it('should dispatch createFolder on Enter keydown in the input field', async () => {
    const component = new BookmarkForm({
      target,
      props: {
        title: 'Test',
        folderId: '2',
        folders: [{ id: '2', title: 'Work', path: 'Work' }]
      }
    });

    const createFolderSpy = vi.fn();
    component.$on('createFolder', createFolderSpy);

    const newFolderBtn = document.querySelector('.btn-icon') as HTMLButtonElement;
    await newFolderBtn.click();
    await tick();

    const input = document.querySelector('.new-folder-input') as HTMLInputElement;
    input.value = 'Sub Folder';
    input.dispatchEvent(new Event('input'));
    await tick();

    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(enterEvent);
    await tick();

    expect(createFolderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { title: 'Sub Folder', parentId: '2' }
      })
    );
  });

  it('should cancel folder creation when Escape key is pressed', async () => {
    const component = new BookmarkForm({
      target,
      props: {
        title: 'Test',
        folderId: '1',
        folders: [{ id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar' }]
      }
    });

    const createFolderSpy = vi.fn();
    component.$on('createFolder', createFolderSpy);

    const newFolderBtn = document.querySelector('.btn-icon') as HTMLButtonElement;
    await newFolderBtn.click();
    await tick();

    const input = document.querySelector('.new-folder-input') as HTMLInputElement;
    input.value = 'Unsaved Folder';
    input.dispatchEvent(new Event('input'));
    await tick();

    const escEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(escEvent);
    await tick();

    expect(createFolderSpy).not.toHaveBeenCalled();
    expect(document.querySelector('.new-folder-box')).toBeNull();
  });

  it('should cancel folder creation when cancel button is clicked', async () => {
    const component = new BookmarkForm({
      target,
      props: {
        title: 'Test',
        folderId: '1',
        folders: [{ id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar' }]
      }
    });

    const createFolderSpy = vi.fn();
    component.$on('createFolder', createFolderSpy);

    const newFolderBtn = document.querySelector('.btn-icon') as HTMLButtonElement;
    await newFolderBtn.click();
    await tick();

    const cancelBtn = document.querySelector('.new-folder-actions .btn-secondary') as HTMLButtonElement;
    await cancelBtn.click();
    await tick();

    expect(createFolderSpy).not.toHaveBeenCalled();
    expect(document.querySelector('.new-folder-box')).toBeNull();
  });

  it('should not dispatch createFolder when title is empty or only whitespace', async () => {
    const component = new BookmarkForm({
      target,
      props: {
        title: 'Test',
        folderId: '1',
        folders: [{ id: '1', title: 'Bookmarks Bar', path: 'Bookmarks Bar' }]
      }
    });

    const createFolderSpy = vi.fn();
    component.$on('createFolder', createFolderSpy);

    const newFolderBtn = document.querySelector('.btn-icon') as HTMLButtonElement;
    await newFolderBtn.click();
    await tick();

    const input = document.querySelector('.new-folder-input') as HTMLInputElement;
    input.value = '   ';
    input.dispatchEvent(new Event('input'));
    await tick();

    const submitBtn = document.querySelector('.new-folder-actions .btn-primary') as HTMLButtonElement;
    await submitBtn.click();
    await tick();

    expect(createFolderSpy).not.toHaveBeenCalled();
    expect(document.querySelector('.new-folder-box')).not.toBeNull();
  });
});
