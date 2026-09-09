import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';
import CrossRootFolderModal, { type CrossRootItem } from '../../src/components/management/CrossRootFolderModal.svelte';

describe('CrossRootFolderModal.svelte', () => {
  let target: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
  });

  const sampleItems: CrossRootItem[] = [
    {
      bookmarkId: 101,
      browserBookmarkId: 'bb101',
      title: 'Damoang Politics',
      url: 'https://damoang.net/politics/1',
      currentFolderPath: '기타 북마크/임시',
      currentRoot: 'Other bookmarks',
      suggestedFolderId: 'f201',
      suggestedFolderPath: '커뮤니티/정치',
      suggestedRoot: 'Bookmarks bar',
      cleanPath: '커뮤니티/정치'
    },
    {
      bookmarkId: 102,
      browserBookmarkId: 'bb102',
      title: 'Ppomppu Shopping',
      url: 'https://ppomppu.co.kr/shopping',
      currentFolderPath: '기타 북마크',
      currentRoot: 'Other bookmarks',
      suggestedFolderId: undefined,
      suggestedFolderPath: '쇼핑/특가',
      suggestedRoot: 'Bookmarks bar',
      cleanPath: '쇼핑/특가'
    }
  ];

  it('renders modal content when isOpen is true', async () => {
    const comp = new CrossRootFolderModal({
      target,
      props: {
        isOpen: true,
        items: sampleItems
      }
    });
    await tick();

    const titleEl = document.querySelector('#cross-root-modal-title');
    expect(titleEl?.textContent).toBe('다른 위치 폴더 이동 검토');

    const countTag = document.querySelector('.header-count-tag');
    expect(countTag?.textContent).toContain('2건 대기 중');

    const reviewCards = document.querySelectorAll('.review-card');
    expect(reviewCards.length).toBe(2);

    expect(reviewCards[0].querySelector('.item-title')?.textContent).toBe('Damoang Politics');
    expect(reviewCards[1].querySelector('.item-title')?.textContent).toBe('Ppomppu Shopping');
  });

  it('does not render dialog when isOpen is false', async () => {
    const comp = new CrossRootFolderModal({
      target,
      props: {
        isOpen: false,
        items: sampleItems
      }
    });
    await tick();

    expect(document.querySelector('.modal-container')).toBeNull();
  });

  it('defaults to move-recommended for all items and applies global quick-select batch buttons', async () => {
    const comp = new CrossRootFolderModal({
      target,
      props: {
        isOpen: true,
        items: sampleItems
      }
    });
    await tick();

    // Default: 'move-recommended'
    const radioInputs = document.querySelectorAll('input[type="radio"]') as NodeListOf<HTMLInputElement>;
    const moveRadios = Array.from(radioInputs).filter(r => r.value === 'move-recommended');
    expect(moveRadios.every(r => r.checked)).toBe(true);

    // Global Batch button 1: [Create all new folders at current location]
    const batchButtons = document.querySelectorAll('.bulk-actions button') as NodeListOf<HTMLButtonElement>;
    const createAllBtn = Array.from(batchButtons).find(b => b.textContent?.includes('모두 현재 위치에 새 폴더 생성'));
    expect(createAllBtn).toBeDefined();
    await createAllBtn?.click();
    await tick();

    const createRadios = Array.from(document.querySelectorAll('input[type="radio"]') as NodeListOf<HTMLInputElement>).filter(r => r.value === 'create-here');
    expect(createRadios.every(r => r.checked)).toBe(true);

    // Global Batch button 3: [Skip all]
    const skipAllBtn = Array.from(batchButtons).find(b => b.textContent?.includes('모두 건너뛰기'));
    expect(skipAllBtn).toBeDefined();
    await skipAllBtn?.click();
    await tick();

    const skipRadios = Array.from(document.querySelectorAll('input[type="radio"]') as NodeListOf<HTMLInputElement>).filter(r => r.value === 'skip');
    expect(skipRadios.every(r => r.checked)).toBe(true);

    // Global Batch button 2: [Move all to recommended location]
    const moveAllBtn = Array.from(batchButtons).find(b => b.textContent?.includes('모두 추천 위치로 이동'));
    expect(moveAllBtn).toBeDefined();
    await moveAllBtn?.click();
    await tick();

    const moveRadiosAfter = Array.from(document.querySelectorAll('input[type="radio"]') as NodeListOf<HTMLInputElement>).filter(r => r.value === 'move-recommended');
    expect(moveRadiosAfter.every(r => r.checked)).toBe(true);
  });

  it('dispatches apply event with user selected choices', async () => {
    const comp = new CrossRootFolderModal({
      target,
      props: {
        isOpen: true,
        items: sampleItems
      }
    });
    await tick();

    const onApply = vi.fn();
    comp.$on('apply', onApply);

    // Set item 101 to 'create-here' by clicking the choice-option
    const firstCard = document.querySelectorAll('.review-card')[0];
    const createOption = Array.from(firstCard.querySelectorAll('.choice-option')).find(el => el.textContent?.includes('현재 위치에 새 폴더 생성')) as HTMLElement;
    expect(createOption).toBeDefined();
    await createOption.click();
    await tick();

    // Item 102 remains default 'move-recommended'

    // Click [Apply] button in modal footer
    const applyBtn = Array.from(document.querySelectorAll('.modal-footer button')).find(b => b.textContent?.includes('적용하기')) as HTMLButtonElement;
    expect(applyBtn).toBeDefined();
    await applyBtn.click();
    await tick();

    expect(onApply).toHaveBeenCalledTimes(1);
    const eventDetail = onApply.mock.calls[0][0].detail;
    expect(eventDetail.results).toEqual([
      {
        bookmarkId: 101,
        action: 'create-here',
        cleanPath: '커뮤니티/정치',
        targetFolderId: 'f201',
        targetRoot: 'Bookmarks bar',
        currentRoot: 'Other bookmarks'
      },
      {
        bookmarkId: 102,
        action: 'move-recommended',
        cleanPath: '쇼핑/특가',
        targetFolderId: undefined,
        targetRoot: 'Bookmarks bar',
        currentRoot: 'Other bookmarks'
      }
    ]);
  });

  it('dispatches close event on cancel button click or close icon', async () => {
    const comp = new CrossRootFolderModal({
      target,
      props: {
        isOpen: true,
        items: sampleItems
      }
    });
    await tick();

    const onClose = vi.fn();
    comp.$on('close', onClose);

    const cancelBtn = Array.from(document.querySelectorAll('.modal-footer button')).find(b => b.textContent?.includes('취소')) as HTMLButtonElement;
    await cancelBtn.click();
    await tick();

    expect(onClose).toHaveBeenCalledTimes(1);

    const closeIconBtn = document.querySelector('.btn-close') as HTMLButtonElement;
    await closeIconBtn.click();
    await tick();

    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
