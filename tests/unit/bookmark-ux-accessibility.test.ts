import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';
import Badge from '../../src/components/shared/Badge.svelte';
import Icon from '../../src/components/shared/Icon.svelte';
import BookmarkEditModal from '../../src/components/management/bookmarks/BookmarkEditModal.svelte';
import BookmarkCard from '../../src/components/management/bookmarks/BookmarkCard.svelte';
import BulkActionBar from '../../src/components/management/bookmarks/BulkActionBar.svelte';
import BookmarkFilterBar from '../../src/components/management/bookmarks/BookmarkFilterBar.svelte';

vi.stubGlobal('browser', {
  i18n: {
    getMessage: vi.fn((key: string) => key)
  },
  runtime: {
    sendMessage: vi.fn(async () => ({ ok: true }))
  },
  storage: {
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
  },
  bookmarks: {
    getTree: vi.fn(async () => []),
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onChanged: { addListener: vi.fn() },
    onMoved: { addListener: vi.fn() }
  }
});

describe('Bookmark Management UX & Accessibility Fixes', () => {
  let target: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
  });

  describe('Icon.svelte', () => {
    it('should render non-empty path for edit and edit-2 icons', () => {
      new Icon({
        target,
        props: {
          name: 'edit-2',
          size: 14
        }
      });
      const svgPath = document.querySelector('svg path');
      expect(svgPath).toBeTruthy();
      expect(svgPath?.getAttribute('d')?.length).toBeGreaterThan(5);
    });
  });

  describe('Badge.svelte', () => {
    it('should render text prop', () => {
      new Badge({
        target,
        props: {
          variant: 'success',
          text: '완료'
        }
      });
      const badge = document.querySelector('.badge');
      expect(badge).toBeTruthy();
      expect(badge?.textContent?.trim()).toBe('완료');
    });
  });

  describe('BookmarkEditModal.svelte', () => {
    it('should render footer buttons (취소, 저장) inside modal-footer', async () => {
      const mockBookmark: any = {
        id: 1,
        title: '테스트 북마크',
        url: 'https://example.com',
        description: '설명',
        folderPath: 'Bookmarks Bar'
      };

      new BookmarkEditModal({
        target,
        props: {
          open: true,
          bookmark: mockBookmark,
          folders: [{ id: 'f-1', title: 'Bookmarks Bar', path: 'Bookmarks Bar' }]
        }
      });

      await tick();

      const modalFooter = document.querySelector('.modal-footer');
      expect(modalFooter).toBeTruthy();
      expect(modalFooter?.textContent).toContain('취소');
      expect(modalFooter?.textContent).toContain('저장');
    });

    it('should initialize title, url, tags, description and match folderPath to folderId', async () => {
      const mockBookmark: any = {
        id: 1,
        title: '테스트 북마크',
        url: 'https://example.com/page',
        description: '상세 설명입니다.',
        tags: ['개발', '프론트엔드'],
        folderPath: '개발/프론트'
      };

      const folders = [
        { id: 'f-root', title: 'Bookmarks Bar', path: 'Bookmarks Bar' },
        { id: 'f-dev-front', title: '프론트', path: '개발/프론트' }
      ];

      const modal = new BookmarkEditModal({
        target,
        props: {
          open: true,
          bookmark: mockBookmark,
          folders
        }
      });

      await tick();

      const titleInput = document.querySelector('#edit-title') as HTMLInputElement;
      const urlInput = document.querySelector('#edit-url') as HTMLInputElement;
      const tagsInput = document.querySelector('#edit-tags') as HTMLInputElement;
      const descInput = document.querySelector('#edit-desc') as HTMLTextAreaElement;
      const tagBadges = document.querySelectorAll('.tag-badge');

      expect(titleInput.value).toBe('테스트 북마크');
      expect(urlInput.value).toBe('https://example.com/page');
      expect(tagsInput.value).toBe('개발, 프론트엔드');
      expect(descInput.value).toBe('상세 설명입니다.');
      expect(tagBadges.length).toBe(2);
      expect(tagBadges[0].textContent).toBe('#개발');
      expect(tagBadges[1].textContent).toBe('#프론트엔드');
    });

    it('should dispatch saved event with updated values on save click', async () => {
      const mockBookmark: any = {
        id: 10,
        syncId: 'sync-10',
        bookmarkId: 'b-10',
        title: '이전 제목',
        url: 'https://old.com',
        description: '이전 설명',
        tags: ['old'],
        folderPath: 'Bookmarks Bar'
      };

      const folders = [
        { id: 'f-1', title: 'Bookmarks Bar', path: 'Bookmarks Bar' },
        { id: 'f-2', title: 'New Folder', path: 'New Folder' }
      ];

      let savedData: any = null;
      const modal = new BookmarkEditModal({
        target,
        props: {
          open: true,
          bookmark: mockBookmark,
          folders
        }
      });

      modal.$on('saved', (e: any) => {
        savedData = e.detail;
      });

      await tick();

      const titleInput = document.querySelector('#edit-title') as HTMLInputElement;
      const urlInput = document.querySelector('#edit-url') as HTMLInputElement;
      const tagsInput = document.querySelector('#edit-tags') as HTMLInputElement;
      const descInput = document.querySelector('#edit-desc') as HTMLTextAreaElement;

      titleInput.value = '새로운 제목';
      titleInput.dispatchEvent(new Event('input'));
      urlInput.value = 'https://new.com';
      urlInput.dispatchEvent(new Event('input'));
      tagsInput.value = 'svelte, testing';
      tagsInput.dispatchEvent(new Event('input'));
      descInput.value = '새로운 요약';
      descInput.dispatchEvent(new Event('input'));

      await tick();

      const saveBtn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('저장')
      );
      saveBtn?.click();

      await tick();

      expect(savedData).toBeTruthy();
      expect(savedData.bookmark.title).toBe('새로운 제목');
      expect(savedData.bookmark.url).toBe('https://new.com');
      expect(savedData.bookmark.description).toBe('새로운 요약');
      expect(savedData.tags).toEqual(['svelte', 'testing']);
    });

    it('should prevent saving and not dispatch saved event when title is blank', async () => {
      const mockBookmark: any = {
        id: 10,
        title: '제목',
        url: 'https://test.com',
        description: '설명',
        folderPath: ''
      };

      let savedCalled = false;
      const modal = new BookmarkEditModal({
        target,
        props: {
          open: true,
          bookmark: mockBookmark,
          folders: []
        }
      });

      modal.$on('saved', () => {
        savedCalled = true;
      });

      await tick();

      const titleInput = document.querySelector('#edit-title') as HTMLInputElement;
      titleInput.value = '   ';
      titleInput.dispatchEvent(new Event('input'));

      await tick();

      const saveBtn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('저장')
      );
      saveBtn?.click();

      await tick();

      expect(savedCalled).toBe(false);
    });

    it('should set folderPath to empty string when root/no folder is selected', async () => {
      const mockBookmark: any = {
        id: 20,
        title: '폴더 이동 테스트',
        url: 'https://test.com',
        description: '',
        folderPath: '기존/하위폴더'
      };

      let savedData: any = null;
      const modal = new BookmarkEditModal({
        target,
        props: {
          open: true,
          bookmark: mockBookmark,
          folders: [{ id: 'f-sub', title: '하위폴더', path: '기존/하위폴더' }]
        }
      });

      modal.$on('saved', (e: any) => {
        savedData = e.detail;
      });

      await tick();

      // Open folder dropdown and click root option
      const selectTrigger = document.querySelector('.select-trigger') as HTMLButtonElement;
      selectTrigger?.click();
      await tick();

      const rootOption = Array.from(document.querySelectorAll('.option-item')).find(
        (btn) => btn.textContent?.includes('최상위')
      ) as HTMLButtonElement;
      rootOption?.click();
      await tick();

      const saveBtn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('저장')
      );
      saveBtn?.click();
      await tick();

      expect(savedData).toBeTruthy();
      expect(savedData.folderPath).toBe('');
      expect(savedData.folderId).toBe('');
    });
  });

  describe('BookmarkCard.svelte', () => {
    const mockBookmark: any = {
      id: 42,
      title: '테스트 북마크 제목',
      url: 'https://example.com/test',
      description: '설명 문구',
      tags: ['svelte', 'typescript'],
      folderPath: 'Bookmarks Bar'
    };

    it('should not have tabindex="0" on outer .bookmark-card', async () => {
      new BookmarkCard({
        target,
        props: {
          bookmark: mockBookmark,
          selected: false
        }
      });

      await tick();
      const card = document.querySelector('.bookmark-card');
      expect(card?.getAttribute('tabindex')).toBeNull();
    });

    it('should have dynamic aria-label on checkbox', async () => {
      new BookmarkCard({
        target,
        props: {
          bookmark: mockBookmark,
          selected: false
        }
      });

      await tick();
      const checkbox = document.querySelector('.card-checkbox');
      expect(checkbox?.getAttribute('aria-label')).toBe("'테스트 북마크 제목' 선택");
    });

    it('should not toggle selection on card click if text is being selected/copied', async () => {
      const cardComp = new BookmarkCard({
        target,
        props: {
          bookmark: mockBookmark,
          selected: false
        }
      });

      const toggleSpy = vi.fn();
      cardComp.$on('toggleSelect', toggleSpy);

      // Simulate active selection
      const getSelectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue({
        toString: () => 'selected text'
      } as any);

      const card = document.querySelector('.bookmark-card') as HTMLElement;
      card.click();
      await tick();

      expect(toggleSpy).not.toHaveBeenCalled();

      // Clear selection simulation
      getSelectionSpy.mockReturnValue({
        toString: () => ''
      } as any);

      card.click();
      await tick();

      expect(toggleSpy).toHaveBeenCalledTimes(1);
      getSelectionSpy.mockRestore();
    });

    it('should render interactive tag chips and dispatch selectTag event on click', async () => {
      const cardComp = new BookmarkCard({
        target,
        props: {
          bookmark: mockBookmark,
          selected: false
        }
      });

      const selectTagSpy = vi.fn();
      cardComp.$on('selectTag', selectTagSpy);

      await tick();
      const tagChips = document.querySelectorAll('.tag-chip') as NodeListOf<HTMLButtonElement>;
      expect(tagChips.length).toBe(2);
      expect(tagChips[0].textContent?.trim()).toBe('#svelte');

      tagChips[0].click();
      await tick();

      expect(selectTagSpy).toHaveBeenCalledTimes(1);
      expect(selectTagSpy).toHaveBeenCalledWith(expect.objectContaining({
        detail: { tag: 'svelte' }
      }));
    });

    it('should render added date on the far left of the card footer', async () => {
      new BookmarkCard({
        target,
        props: {
          bookmark: {
            ...mockBookmark,
            createdAt: new Date('2026-05-15T12:00:00Z').getTime()
          },
          selected: false
        }
      });

      await tick();
      const cardDate = document.querySelector('.card-footer .card-footer-left .card-date');
      expect(cardDate).toBeTruthy();
      expect(cardDate?.textContent?.trim()).toBe('2026.05.15');
      expect(cardDate?.getAttribute('title')).toBe('추가일');
    });
  });

  describe('BulkActionBar.svelte', () => {
    it('should render AI 일괄 요약 button and dispatch summarizeAi on click', async () => {
      const bar = new BulkActionBar({
        target,
        props: {
          selectedCount: 3,
          totalCount: 10,
          deadSelectedCount: 2,
          allSelected: false
        }
      });

      const summarizeSpy = vi.fn();
      bar.$on('summarizeAi', summarizeSpy);

      await tick();
      const buttons = Array.from(document.querySelectorAll('.bulk-right button')) as HTMLButtonElement[];
      const summarizeBtn = buttons.find(b => b.textContent?.includes('AI 일괄 요약'));
      expect(summarizeBtn).toBeTruthy();

      await summarizeBtn?.click();
      await tick();

      expect(summarizeSpy).toHaveBeenCalledTimes(1);
    });

    it('should display accurate counts for 404 delete and selected delete buttons', async () => {
      new BulkActionBar({
        target,
        props: {
          selectedCount: 5,
          totalCount: 10,
          deadSelectedCount: 2,
          allSelected: false
        }
      });

      await tick();
      const buttons = Array.from(document.querySelectorAll('.bulk-right button')) as HTMLButtonElement[];
      const delete404Btn = buttons.find(b => b.textContent?.includes('404 삭제'));
      const deleteSelectedBtn = buttons.find(b => b.textContent?.includes('선택 삭제'));

      expect(delete404Btn?.textContent).toContain('404 삭제 (2)');
      expect(deleteSelectedBtn?.textContent).toContain('선택 삭제 (5)');
    });

    it('should render persistently with 0 selected items and have delete button disabled', async () => {
      new BulkActionBar({
        target,
        props: {
          selectedCount: 0,
          totalCount: 8,
          deadSelectedCount: 0,
          allSelected: false
        }
      });

      await tick();
      const selectionText = document.querySelector('.selection-text');
      expect(selectionText?.textContent?.trim()).toBe('전체 선택');

      const clearBtn = document.querySelector('.btn-text-muted');
      expect(clearBtn).toBeNull();

      const deleteSelectedBtn = Array.from(document.querySelectorAll('.bulk-right button')).find(
        b => b.textContent?.includes('선택 삭제')
      ) as HTMLButtonElement;
      expect(deleteSelectedBtn?.disabled).toBe(true);
    });

    it('should display selected count when items are selected', async () => {
      new BulkActionBar({
        target,
        props: {
          selectedCount: 3,
          totalCount: 10,
          deadSelectedCount: 0,
          allSelected: false
        }
      });

      await tick();
      const selectionText = document.querySelector('.selection-text');
      expect(selectionText?.textContent?.trim()).toBe('3개 선택됨');
    });

    it('should show cancel button on hover when AI categorizing and dispatch cancelAi on click', async () => {
      const bar = new BulkActionBar({
        target,
        props: {
          selectedCount: 0,
          totalCount: 10,
          deadSelectedCount: 0,
          allSelected: false,
          isAiCategorizing: true
        }
      });

      const cancelSpy = vi.fn();
      bar.$on('cancelAi', cancelSpy);

      await tick();
      const buttons = Array.from(document.querySelectorAll('.bulk-right button')) as HTMLButtonElement[];
      const aiBtn = buttons[0];
      expect(aiBtn).toBeTruthy();
      expect(aiBtn.disabled).toBe(false);
      expect(aiBtn.classList.contains('btn-secondary')).toBe(true);
      expect(aiBtn.classList.contains('btn-danger')).toBe(false);

      // Hover
      aiBtn.dispatchEvent(new MouseEvent('mouseenter'));
      await tick();

      expect(aiBtn.classList.contains('btn-danger')).toBe(true);
      expect(aiBtn.textContent).toContain('취소');

      // Click while categorizing
      await aiBtn.click();
      await tick();

      expect(cancelSpy).toHaveBeenCalledTimes(1);

      // Leave hover
      aiBtn.dispatchEvent(new MouseEvent('mouseleave'));
      await tick();

      expect(aiBtn.classList.contains('btn-danger')).toBe(false);
      expect(aiBtn.classList.contains('btn-secondary')).toBe(true);
    });

    it('should show spinner and cancel on hover when isAiSummarizing is true, and disable classify button', async () => {
      const bar = new BulkActionBar({
        target,
        props: {
          selectedCount: 0,
          totalCount: 10,
          deadSelectedCount: 0,
          allSelected: false,
          isAiSummarizing: true
        }
      });

      const cancelSpy = vi.fn();
      bar.$on('cancelAi', cancelSpy);

      await tick();
      const buttons = Array.from(document.querySelectorAll('.bulk-right button')) as HTMLButtonElement[];
      const classifyBtn = buttons[0];
      const summarizeBtn = buttons[1];

      expect(classifyBtn.disabled).toBe(true);
      expect(summarizeBtn).toBeTruthy();
      expect(summarizeBtn.disabled).toBe(false);
      expect(summarizeBtn.classList.contains('btn-secondary')).toBe(true);
      expect(summarizeBtn.classList.contains('btn-danger')).toBe(false);
      expect(summarizeBtn.querySelector('.spinner-inline')).toBeTruthy();

      // Hover on summarize button -> danger styling and cancel text
      summarizeBtn.dispatchEvent(new MouseEvent('mouseenter'));
      await tick();

      expect(summarizeBtn.classList.contains('btn-danger')).toBe(true);
      expect(summarizeBtn.textContent).toContain('취소');

      // Click while summarizing -> dispatches cancelAi
      await summarizeBtn.click();
      await tick();

      expect(cancelSpy).toHaveBeenCalledTimes(1);

      // Mouseleave restores normal loading state
      summarizeBtn.dispatchEvent(new MouseEvent('mouseleave'));
      await tick();

      expect(summarizeBtn.classList.contains('btn-danger')).toBe(false);
      expect(summarizeBtn.classList.contains('btn-secondary')).toBe(true);
    });
  });

  describe('BookmarkFilterBar.svelte', () => {
    it('should have correct accessibility attributes on search input, selects, and view toggle buttons', async () => {
      new BookmarkFilterBar({
        target,
        props: {
          searchQuery: '',
          selectedTag: 'all',
          availableTags: ['dev', 'news'],
          viewMode: 'grid'
        }
      });

      await tick();

      const searchInput = document.querySelector('.search-input');
      expect(searchInput?.getAttribute('aria-label')).toBe('북마크 검색');

      const selects = document.querySelectorAll('select');
      const statusSelect = selects[0];
      const tagSelect = selects[1];
      const sortSelect = selects[2];

      expect(statusSelect?.getAttribute('aria-label')).toBe('상태 및 분류 필터');
      expect(tagSelect?.getAttribute('aria-label')).toBe('태그 필터');
      expect(sortSelect?.getAttribute('aria-label')).toBe('정렬 기준');

      const viewBtns = document.querySelectorAll('.view-btn');
      expect(viewBtns[0].getAttribute('aria-pressed')).toBe('true');
      expect(viewBtns[1].getAttribute('aria-pressed')).toBe('false');
    });
  });
});
