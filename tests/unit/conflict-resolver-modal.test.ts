import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';
import ConflictResolverModal from '../../src/components/management/ConflictResolverModal.svelte';
import type { ConflictLog } from '../../src/lib/sync/sync-conflict-store';

const mockConflicts: ConflictLog[] = [
  {
    id: 'conf-1',
    status: 'pending',
    autoResolvedTo: 'local',
    bookmarkId: 'sync-1111-2222',
    localVersion: {
      syncId: 'sync-1111-2222',
      bookmarkId: 'local-node-1',
      title: 'Local Title 1',
      url: 'https://example.com/page1',
      description: 'Local desc',
      folderPath: '개발/React',
      tags: ['react', 'frontend'],
      modifiedAt: 1700000000000
    },
    cloudVersion: {
      syncId: 'sync-1111-2222',
      bookmarkId: 'cloud-node-1',
      title: 'Cloud Title 1',
      url: 'https://example.com/page1',
      description: 'Cloud desc',
      folderPath: '개발/Vue',
      tags: ['vue'],
      modifiedAt: 1699990000000
    },
    timestamp: 1700000005000
  },
  {
    id: 'conf-2',
    status: 'pending',
    autoResolvedTo: 'cloud',
    bookmarkId: 'sync-local-3333',
    localVersion: {
      syncId: 'sync-local-3333',
      bookmarkId: 'local-node-2',
      title: 'Common Title',
      url: 'https://example.com/page2',
      description: 'Same desc',
      folderPath: '기타',
      tags: ['web'],
      modifiedAt: 1699990000000
    },
    cloudVersion: {
      syncId: 'sync-cloud-4444',
      bookmarkId: 'cloud-node-2',
      title: 'Common Title',
      url: 'https://example.com/page2',
      description: 'Same desc',
      folderPath: '기타',
      tags: ['web'],
      modifiedAt: 1700000000000
    },
    timestamp: 1700000006000
  }
];

const mockGetPendingConflicts = vi.fn().mockResolvedValue(mockConflicts);
const mockResolveConflict = vi.fn().mockResolvedValue(undefined);
const mockResolveBatchConflicts = vi.fn().mockResolvedValue(undefined);
const mockSyncEngineSync = vi.fn().mockResolvedValue(undefined);
const mockUpdateBookmark = vi.fn().mockResolvedValue(undefined);
const mockDbBookmarkUpdate = vi.fn().mockResolvedValue(1);

vi.mock('../../src/lib/sync/sync-conflict-store', () => ({
  getPendingConflicts: () => mockGetPendingConflicts(),
  resolveConflict: (id: string, action: any) => mockResolveConflict(id, action),
  resolveBatchConflicts: (resolutions: any) => mockResolveBatchConflicts(resolutions)
}));

vi.mock('../../src/lib/sync/sync-engine', () => ({
  SyncEngine: {
    sync: () => mockSyncEngineSync()
  }
}));

vi.mock('../../src/lib/bookmarks/bookmark-manager', () => ({
  BookmarkManager: {
    updateBookmark: (...args: any[]) => mockUpdateBookmark(...args),
    setSyncMuted: vi.fn(),
    ensureFolderPath: vi.fn(),
    getFolders: vi.fn().mockResolvedValue([])
  }
}));

vi.mock('../../src/lib/db', () => ({
  db: {
    bookmarks: {
      toArray: vi.fn().mockResolvedValue([
        { id: 1, syncId: 'sync-1111-2222', title: 'Local Title 1', bookmarkId: 'local-node-1', url: 'https://example.com/page1' },
        { id: 2, syncId: 'sync-local-3333', title: 'Common Title', bookmarkId: 'local-node-2', url: 'https://example.com/page2' }
      ]),
      update: (...args: any[]) => mockDbBookmarkUpdate(...args),
      where: vi.fn().mockReturnValue({
        equals: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ id: 1, syncId: 'sync-1111-2222', title: 'Local Title 1' })
        })
      })
    },
    transaction: vi.fn().mockImplementation(async (_mode, _table, cb) => cb())
  }
}));

describe('ConflictResolverModal.svelte', () => {
  let target: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
    vi.clearAllMocks();
    mockGetPendingConflicts.mockResolvedValue([...mockConflicts]);
  });

  it('renders conflict items and displays syncId for each version', async () => {
    const comp = new ConflictResolverModal({ target });
    await tick();
    await tick();

    const titleEl = document.querySelector('#modal-title');
    expect(titleEl?.textContent).toContain('동기화 충돌 감지 (2건)');

    const conflictCards = document.querySelectorAll('.conflict-card');
    expect(conflictCards.length).toBe(2);

    // Card 1: IDs are rendered in version-meta ('sync-1111-2222')
    const card1 = conflictCards[0];
    const card1SyncValues = card1.querySelectorAll('.version-id');
    expect(card1SyncValues.length).toBe(2);
    expect(card1SyncValues[0].textContent?.trim()).toBe('sync-1111-2222');
    expect(card1SyncValues[1].textContent?.trim()).toBe('sync-1111-2222');

    // Field labels do not contain 'syncId'
    const card1Labels = Array.from(card1.querySelectorAll('.field-label')).map(el => el.textContent?.trim());
    expect(card1Labels).not.toContain('syncId');

    // Recommendation badges are removed
    expect(document.querySelector('.badge-recommend')).toBeNull();

    // Card 1: Local is newer (1700000000000 > 1699990000000)
    const card1TimeEls = card1.querySelectorAll('.version-time');
    expect(card1TimeEls[0].classList.contains('newer')).toBe(true);
    expect(card1TimeEls[1].classList.contains('older')).toBe(true);

    // Card 2: IDs are rendered in version-meta ('sync-local-3333' vs 'sync-cloud-4444')
    // Cloud is newer (1700000000000 > 1699990000000)
    const card2 = conflictCards[1];
    const card2SyncValues = card2.querySelectorAll('.version-id');
    expect(card2SyncValues.length).toBe(2);
    expect(card2SyncValues[0].textContent?.trim()).toBe('sync-local-3333');
    expect(card2SyncValues[1].textContent?.trim()).toBe('sync-cloud-4444');

    const card2TimeEls = card2.querySelectorAll('.version-time');
    expect(card2TimeEls[0].classList.contains('older')).toBe(true);
    expect(card2TimeEls[1].classList.contains('newer')).toBe(true);
  });

  it('toggles selection and supports bulk actions (모두 로컬 유지 / 모두 클라우드 적용)', async () => {
    const comp = new ConflictResolverModal({ target });
    await tick();
    await tick();

    const bulkBtns = document.querySelectorAll('.bulk-actions button') as NodeListOf<HTMLButtonElement>;
    const keepLocalAllBtn = Array.from(bulkBtns).find(b => b.textContent?.includes('모두 로컬 유지'));
    const keepCloudAllBtn = Array.from(bulkBtns).find(b => b.textContent?.includes('모두 클라우드 적용'));

    expect(keepLocalAllBtn).toBeDefined();
    expect(keepCloudAllBtn).toBeDefined();

    // Click keepCloudAllBtn
    await keepCloudAllBtn?.click();
    await tick();

    const cloudRadios = Array.from(document.querySelectorAll('.selection-radio input[value="keep-cloud"]')) as HTMLInputElement[];
    expect(cloudRadios.every(r => r.checked)).toBe(true);

    // Click keepLocalAllBtn
    await keepLocalAllBtn?.click();
    await tick();

    const localRadios = Array.from(document.querySelectorAll('.selection-radio input[value="keep-local"]')) as HTMLInputElement[];
    expect(localRadios.every(r => r.checked)).toBe(true);
  });

  it('dispatches close event when cancel button is clicked', async () => {
    const comp = new ConflictResolverModal({ target });
    await tick();
    await tick();

    const onClose = vi.fn();
    comp.$on('close', onClose);

    const cancelBtn = Array.from(document.querySelectorAll('.modal-footer-actions button')).find(b => b.textContent?.includes('취소')) as HTMLButtonElement;
    expect(cancelBtn).toBeDefined();
    await cancelBtn.click();
    await tick();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('적용 및 동기화 시 새 북마크를 생성하지 않고 기존 레코드를 단일 syncId로 갱신한다', async () => {
    const comp = new ConflictResolverModal({ target });
    await tick();
    await tick();

    const applyBtn = Array.from(document.querySelectorAll('.modal-footer-actions button')).find(b => b.textContent?.includes('적용 및 동기화')) as HTMLButtonElement;
    expect(applyBtn).toBeDefined();

    await applyBtn.click();
    await new Promise(r => setTimeout(r, 50));
    await tick();

    // db.bookmarks.update called in batch to update existing bookmark
    expect(mockDbBookmarkUpdate).toHaveBeenCalled();
    // Execute batch resolve and sync after resolving conflict
    expect(mockResolveBatchConflicts).toHaveBeenCalledTimes(1);
    expect(mockSyncEngineSync).toHaveBeenCalledTimes(1);
  });
});
