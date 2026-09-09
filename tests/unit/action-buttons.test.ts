import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';
import ActionButtons from '../../src/components/popup/ActionButtons.svelte';

vi.stubGlobal('browser', {
  i18n: {
    getMessage: vi.fn((key: string) => {
      const messages: Record<string, string> = {
        action_save_html: '아카이브 저장',
        action_view_archive: '아카이브 보기',
        action_delete: '삭제',
        deleted: '삭제됨'
      };
      return messages[key] || '';
    })
  }
});

// v2: Registered item card — REGISTERED dedicated action stack (new mode/spinner/management buttons removed)
describe('ActionButtons.svelte (v2 registered entry)', () => {
  let target: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
  });

  it('renders [아카이브 저장] primary + ghost delete and dispatches "archive"', async () => {
    const component = new ActionButtons({
      target,
      props: { hasArchive: false }
    });

    const archiveSpy = vi.fn();
    component.$on('archive', archiveSpy);

    const buttons = document.querySelectorAll('button');
    expect(buttons.length).toBe(2);

    const primary = buttons[0];
    expect(primary.textContent).toContain('아카이브 저장');
    expect(primary.textContent).not.toContain('아카이브 보기');

    await primary.click();
    await tick();

    expect(archiveSpy).toHaveBeenCalledTimes(1);
  });

  it('renders [아카이브 보기] with eye icon and dispatches "viewArchive" when hasArchive is true', async () => {
    const component = new ActionButtons({
      target,
      props: { hasArchive: true }
    });

    const viewArchiveSpy = vi.fn();
    component.$on('viewArchive', viewArchiveSpy);

    const primary = document.querySelectorAll('button')[0];
    expect(primary.textContent).toContain('아카이브 보기');

    // Verify existence of eye icon
    expect(primary.querySelector('svg path')).not.toBeNull();

    await primary.click();
    await tick();

    expect(viewArchiveSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps .btn-danger class on delete button (test contract) and dispatches "delete"', async () => {
    const component = new ActionButtons({
      target,
      props: { hasArchive: false }
    });

    const deleteSpy = vi.fn();
    component.$on('delete', deleteSpy);

    const deleteBtn = document.querySelector('.btn-danger') as HTMLButtonElement;
    expect(deleteBtn).not.toBeNull();
    expect(deleteBtn.classList.contains('btn-danger-ghost')).toBe(true);
    expect(deleteBtn.textContent).toContain('삭제');

    await deleteBtn.click();
    await tick();

    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });

  it('disables primary while isArchiving (enqueue busy) — no spinner text (R5)', async () => {
    new ActionButtons({
      target,
      props: { hasArchive: false, isArchiving: true }
    });

    const primary = document.querySelectorAll('button')[0];
    expect(primary.disabled).toBe(true);
    // v2: Button spinner removed — progress is displayed in status line/toolbar badge
    expect(primary.textContent).not.toContain('저장 중...');
    expect(primary.querySelector('.spinner, [class*="spin"]')).toBeNull();
  });

  it('shows archive success stamp (check + 저장 완료) and disables both buttons', async () => {
    new ActionButtons({
      target,
      props: { hasArchive: false, successAction: 'archive' }
    });

    const buttons = document.querySelectorAll('button');
    const primary = buttons[0] as HTMLButtonElement;
    expect(primary.textContent).toContain('저장 완료');
    expect(primary.disabled).toBe(true);

    const deleteBtn = buttons[1] as HTMLButtonElement;
    expect(deleteBtn.disabled).toBe(true);
  });

  it('shows delete success stamp (check + 삭제됨)', async () => {
    new ActionButtons({
      target,
      props: { hasArchive: false, successAction: 'delete' }
    });

    const deleteBtn = document.querySelector('.btn-danger') as HTMLButtonElement;
    expect(deleteBtn.textContent).toContain('삭제됨');
    expect(deleteBtn.disabled).toBe(true);
  });

  it('disables delete while isDeleting', async () => {
    new ActionButtons({
      target,
      props: { hasArchive: false, isDeleting: true }
    });

    const deleteBtn = document.querySelector('.btn-danger') as HTMLButtonElement;
    expect(deleteBtn.disabled).toBe(true);
  });
});
