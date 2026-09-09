import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tick } from 'svelte';
import type { ArchiveIndexEntry } from '../../src/lib/archive/archive-cloud';

const { mockScanOrphans, mockDeleteOrphans, mockFetchHtml, mockShowToast } = vi.hoisted(() => ({
  mockScanOrphans: vi.fn(),
  mockDeleteOrphans: vi.fn(),
  mockFetchHtml: vi.fn(),
  mockShowToast: vi.fn()
}));

vi.mock('../../src/lib/archive/archive-cloud', () => ({
  scanOrphanCloudArchives: mockScanOrphans,
  deleteOrphanCloudArchives: mockDeleteOrphans,
  fetchOrphanArchiveHtml: mockFetchHtml
}));

vi.mock('../../src/lib/ui/toast-store', () => ({
  showToast: mockShowToast
}));

vi.mock('../../src/lib/db', () => ({
  default: {
    bookmarks: { toArray: async () => [] },
    archivedPages: { toArray: async () => [] }
  }
}));

// Stub browser global without sendMessage to exercise direct lib functions
vi.stubGlobal('browser', undefined);

describe('CloudOrphanArchivesCard component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders in collapsed state and expands when header is clicked', async () => {
    const { default: CloudOrphanArchivesCard } = await import(
      '../../src/components/management/settings/CloudOrphanArchivesCard.svelte'
    );

    const component = new CloudOrphanArchivesCard({
      target: document.body,
      props: {
        provider: 'google-drive',
        isSyncing: false,
        syncError: null
      }
    });
    await tick();

    const titleEl = document.querySelector('.header-title');
    expect(titleEl?.textContent).toBeTruthy();

    // Table should not be visible when collapsed
    expect(document.querySelector('.orphan-table')).toBeNull();

    // Click toggle button
    const toggleBtn = document.querySelector('.header-toggle-btn') as HTMLButtonElement;
    toggleBtn.click();
    await tick();

    // Empty state should be visible inside expanded card
    expect(document.querySelector('.empty-state')).not.toBeNull();

    component.$destroy();
  });

  it('disables scan button and shows banner when isSyncing is true', async () => {
    const { default: CloudOrphanArchivesCard } = await import(
      '../../src/components/management/settings/CloudOrphanArchivesCard.svelte'
    );

    const component = new CloudOrphanArchivesCard({
      target: document.body,
      props: {
        provider: 'google-drive',
        isSyncing: true,
        syncError: null
      }
    });
    await tick();

    const scanBtn = document.querySelector('.scan-btn') as HTMLButtonElement;
    expect(scanBtn.disabled).toBe(true);

    component.$destroy();
  });

  it('executes scan, lists detected orphans, supports selection, and deletes selected items', async () => {
    const mockOrphans: ArchiveIndexEntry[] = [
      {
        syncId: 'orphan-1',
        bookmarkId: '1',
        url: 'https://orphan1.com',
        title: 'Orphan Title 1',
        fileName: 'orphan-1.html',
        fileSize: 1024,
        format: 'raw',
        archivedAt: 1700000000000
      },
      {
        syncId: 'orphan-2',
        bookmarkId: '2',
        url: 'https://orphan2.com',
        title: 'Orphan Title 2',
        fileName: 'orphan-2.html',
        fileSize: 2048,
        format: 'raw',
        archivedAt: 1700000000000
      }
    ];

    mockScanOrphans.mockResolvedValue(mockOrphans);
    mockDeleteOrphans.mockResolvedValue({ successCount: 1, failedCount: 0, errors: [] });

    const { default: CloudOrphanArchivesCard } = await import(
      '../../src/components/management/settings/CloudOrphanArchivesCard.svelte'
    );

    const component = new CloudOrphanArchivesCard({
      target: document.body,
      props: {
        provider: 'google-drive',
        isSyncing: false,
        syncError: null
      }
    });
    await tick();

    // Click scan
    const scanBtn = document.querySelector('.scan-btn') as HTMLButtonElement;
    scanBtn.click();
    await tick();
    await tick();

    // Verify scan was invoked
    expect(mockScanOrphans).toHaveBeenCalledTimes(1);

    // Verify rows rendered
    const rows = document.querySelectorAll('.orphan-table tbody tr');
    expect(rows.length).toBe(2);

    // Test select item 1
    const checkboxes = document.querySelectorAll('.orphan-table tbody input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
    expect(checkboxes.length).toBe(2);
    checkboxes[0].click();
    await tick();

    // Selected count text should appear
    const summarySelected = document.querySelector('.summary-selected');
    expect(summarySelected?.textContent).toContain('1');

    // Click delete selected
    const deleteBtn = document.querySelector('.table-toolbar .btn-danger') as HTMLButtonElement;
    expect(deleteBtn.disabled).toBe(false);
    deleteBtn.click();
    await tick();
    await tick();

    expect(mockDeleteOrphans).toHaveBeenCalledWith(['orphan-1'], expect.any(Function));
    expect(mockShowToast).toHaveBeenCalledWith(expect.any(String), 'success');

    // Item 1 deleted -> 1 item remaining
    await tick();
    const remainingRows = document.querySelectorAll('.orphan-table tbody tr');
    expect(remainingRows.length).toBe(1);

    component.$destroy();
  });
});
