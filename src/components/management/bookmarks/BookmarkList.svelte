<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import db, { type Bookmark, type ArchivedPage } from '../../../lib/db';
  import { BookmarkManager, type FolderNode } from '../../../lib/bookmarks/bookmark-manager';
  import { getCloudArchiveIndexCache, type ArchiveIndexEntry } from '../../../lib/archive/archive-cloud';
  import { normalizeUrl } from '../../../lib/bookmarks/url-normalizer';
  import { getPendingConflicts } from '../../../lib/sync/sync-conflict-store';
  import { showToast } from '../../../lib/ui/toast-store';
  import { bulkScanController } from '../../../lib/bulk-scan-controller';
  import { initAiProgressStore } from '../../../lib/ai/ai-progress-store';
  import { requestBulkAiCategorize, requestBulkAiSummarize, retrySingleAi, cancelSingleAi, cancelBulkAi } from '../../../lib/ai/ai-batch-controller';
  import { openArchiveBookmark, saveArchiveBookmark, deleteArchiveRecord } from './archive-action-handler';
  import { getArchiveCaptureState, STALE_MS } from '../../../lib/archive/archive-capture-state';
  import { isUncategorizedBookmark } from '../../../lib/bookmarks/folder-utils';
  import { isBookmarkDead, isBookmarkBroken, clearBookmarkHealth } from '../../../lib/health/health-checker';
  import { parseDrilldownParams } from '../../../lib/stats/dashboard-drilldown';

  import BookmarkListHeader from './BookmarkListHeader.svelte';
  import BookmarkFilterBar from './BookmarkFilterBar.svelte';
  import BulkActionBar from './BulkActionBar.svelte';
  import BookmarkCard from './BookmarkCard.svelte';
  import BookmarkRow from './BookmarkRow.svelte';
  import BookmarkTableHeader from './BookmarkTableHeader.svelte';
  import EmptyState from '../../shared/EmptyState.svelte';
  import FolderTree from '../FolderTree.svelte';
  import CrossRootSection from './CrossRootSection.svelte';
  import BookmarkModals from './BookmarkModals.svelte';

  export let folders: FolderNode[] = [];

  let bookmarks: Bookmark[] = [];
  let archiveMap = new Map<number, ArchivedPage>();
  let cloudArchiveMap = new Map<string, ArchiveIndexEntry>();
  let cloudArchiveUrlMap = new Map<string, ArchiveIndexEntry>();

  // Search & Filter
  let searchQuery = '';
  let selectedFolder = '';
  let selectedFilters: Array<'uncategorized' | 'no-desc' | 'no-tags' | 'broken' | 'dead'> = [];
  let selectedTags: string[] = [];
  let selectedFilter: 'all' | 'uncategorized' | 'no-desc' | 'no-tags' | 'broken' | 'dead' = 'all';
  let selectedTag = 'all';
  let sortBy:
    | 'date-desc'
    | 'date-asc'
    | 'title-asc'
    | 'title-desc'
    | 'folder-asc'
    | 'folder-desc'
    | 'status-asc'
    | 'status-desc' = 'date-desc';
  let viewMode: 'grid' | 'list' = 'grid';

  // Clear selection on folder switch
  let _lastFolderForSelectionReset = '';
  $: {
    const next = selectedFolder;
    if (next !== _lastFolderForSelectionReset) {
      _lastFolderForSelectionReset = next;
      selectedIds.clear();
      selectedIds = selectedIds;
    }
  }

  // Selection state
  let selectedIds = new Set<number>();

  // Archive operation state
  let savingArchiveIds = new Set<number>();
  let openingArchiveId: number | null = null;
  let downloadingArchiveIds = new Set<number>();
  let deletingBookmarkIds = new Set<number>();

  // Conflict state
  let pendingConflictCount = 0;

  // AI and scan state
  let isAiCategorizing = false;
  let isAiSummarizing = false;
  let aiBulkProgress = 0;
  let aiBulkTotal = 0;
  let cleanupAiStore: (() => void) | null = null;
  let lastAiErrorToast = 0;
  let aiUpdateDebounceTimer: any = null;
  let lastArchiveErrorToast = 0;
  let archiveUpdateDebounceTimer: any = null;

  const scanState = bulkScanController.store;

  let crossRootSectionEl: CrossRootSection;
  let modalsEl: BookmarkModals;

  // Compute FolderTree counts
  $: folderCounts = (() => {
    const counts: Record<string, number> = {};
    for (const b of bookmarks) {
      const raw = (b.folderPath || '').trim();
      if (!raw) continue;
      const segs = raw.split('/').filter(Boolean);
      let acc = '';
      for (let i = 0; i < segs.length; i += 1) {
        acc = acc ? `${acc}/${segs[i]}` : segs[i];
        counts[acc] = (counts[acc] ?? 0) + 1;
      }
    }
    return counts;
  })();

  $: rootCount = bookmarks.length;
  $: availableTags = Array.from(new Set(bookmarks.flatMap((b) => b.tags || []))).sort();

  function getStatusRank(b: Bookmark): number {
    if (b.aiStatus === 'error') return 3;
    if (b.aiStatus === 'running' || b.aiStatus === 'pending') return 2;
    const hasArch = b.id !== undefined && (
      archiveMap.has(b.id) ||
      (!!b.syncId && cloudArchiveMap.has(b.syncId)) ||
      (!!b.url && (cloudArchiveUrlMap.has(normalizeUrl(b.url)) || cloudArchiveUrlMap.has(b.url)))
    );
    if (hasArch) return 1;
    return 0;
  }

  // Filtered & sorted bookmarks
  $: filteredBookmarks = bookmarks.filter((b) => {
    if (selectedFolder) {
      const bPath = b.folderPath || '';
      if (bPath !== selectedFolder && !bPath.startsWith(selectedFolder + '/')) return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchTitle = (b.title || '').toLowerCase().includes(q);
      const matchUrl = (b.url || '').toLowerCase().includes(q);
      const matchDesc = (b.description || '').toLowerCase().includes(q);
      const matchTags = (b.tags || []).some((t) => t.toLowerCase().includes(q));
      if (!matchTitle && !matchUrl && !matchDesc && !matchTags) return false;
    }

    if (selectedTags.length > 0) {
      const bTags = b.tags || [];
      if (!selectedTags.every((t) => bTags.includes(t))) return false;
    } else if (selectedTag !== 'all' && !(b.tags || []).includes(selectedTag)) {
      return false;
    }

    const activeStatusFilters = selectedFilters.length > 0
      ? selectedFilters
      : (selectedFilter !== 'all' ? [selectedFilter] : []);

    for (const status of activeStatusFilters) {
      if (status === 'uncategorized') {
        if (!isUncategorizedBookmark(b)) return false;
      } else if (status === 'no-desc') {
        if (b.description && b.description.trim() !== '') return false;
      } else if (status === 'no-tags') {
        if (b.tags && b.tags.some((t) => t.trim() !== '')) return false;
      } else if (status === 'broken') {
        const res = b.id !== undefined ? $scanState.healthResults?.get(b.id) : undefined;
        if (!isBookmarkBroken(b, res)) return false;
      } else if (status === 'dead') {
        const res = b.id !== undefined ? $scanState.healthResults?.get(b.id) : undefined;
        if (!isBookmarkDead(b, res)) return false;
      }
    }

    return true;
  }).sort((a, b) => {
    void archiveMap; void cloudArchiveMap; void cloudArchiveUrlMap;
    if (sortBy === 'date-desc') return (b.createdAt || 0) - (a.createdAt || 0);
    if (sortBy === 'date-asc') return (a.createdAt || 0) - (b.createdAt || 0);
    if (sortBy === 'title-asc') return (a.title || '').localeCompare(b.title || '');
    if (sortBy === 'title-desc') return (b.title || '').localeCompare(a.title || '');
    if (sortBy === 'folder-asc') {
      const cmp = (a.folderPath || '').localeCompare(b.folderPath || '');
      return cmp !== 0 ? cmp : (a.title || '').localeCompare(b.title || '');
    }
    if (sortBy === 'folder-desc') {
      const cmp = (b.folderPath || '').localeCompare(a.folderPath || '');
      return cmp !== 0 ? cmp : (a.title || '').localeCompare(b.title || '');
    }
    if (sortBy === 'status-desc') {
      const rankA = getStatusRank(a);
      const rankB = getStatusRank(b);
      return rankB !== rankA ? rankB - rankA : (a.title || '').localeCompare(b.title || '');
    }
    if (sortBy === 'status-asc') {
      const rankA = getStatusRank(a);
      const rankB = getStatusRank(b);
      return rankA !== rankB ? rankA - rankB : (a.title || '').localeCompare(b.title || '');
    }
    return 0;
  });

  $: deadSelectedCount = Array.from(selectedIds).filter((id) => {
    const res = $scanState.healthResults?.get(id);
    const bm = bookmarks.find((b) => b.id === id);
    return bm && isBookmarkDead(bm, res);
  }).length;

  $: allSelected = filteredBookmarks.length > 0 && filteredBookmarks.every((b) => b.id !== undefined && selectedIds.has(b.id));

  let _initialArchiveOpened = false;
  // Guard to consume dashboard quick-select deep link (?host= / ?folder= / ?filter=uncategorized) once
  let _initialDrilldownApplied = false;

  export async function loadBookmarks() {
    try {
      // Consume dashboard quick-select deep link once on initial load:
      // ?host= -> searchQuery / ?folder= -> selectedFolder / ?filter=uncategorized -> status filter.
      // Since this component initializes right after App's syncTabFromUrl transitions and mounts the bookmark tab,
      // read window.location.search here and reflect it in filter state. Single consumption -> no effect on remount.
      if (!_initialDrilldownApplied && typeof window !== 'undefined') {
        _initialDrilldownApplied = true;
        const dp = parseDrilldownParams(window.location.search);
        if (dp.host) searchQuery = dp.host;
        if (dp.folder) selectedFolder = dp.folder;
        if (dp.filterUncategorized) selectedFilters = ['uncategorized'];
        if (dp.tag) {
          selectedTags = [dp.tag];
          selectedTag = dp.tag;
        }
        if (dp.host || dp.folder || dp.filterUncategorized || dp.tag) {
          window.history.replaceState({ tab: 'bookmarks' }, '', window.location.pathname + '?tab=bookmarks');
        }
      }

      if (typeof db !== 'undefined' && db.bookmarks) {
        bookmarks = await db.bookmarks.toArray();
      }
      try {
        folders = await BookmarkManager.getFolders();
      } catch (e) {
        console.error('Failed to get folders:', e);
      }
      await loadArchiveMap();
      await updatePendingConflicts();
      if (crossRootSectionEl) {
        await crossRootSectionEl.sync(false);
      }

      // Auto-open archive viewer modal once on initial load if archiveId parameter is in URL
      if (!_initialArchiveOpened && typeof window !== 'undefined') {
        const urlParams = new URLSearchParams(window.location.search);
        const archiveIdParam = urlParams.get('archiveId');
        if (archiveIdParam) {
          _initialArchiveOpened = true;
          const targetId = Number(archiveIdParam);
          const targetBm = bookmarks.find((b) => b.id === targetId);
          if (targetBm) {
            handleOpenArchive(targetBm);
          } else {
            const arch = archiveMap.get(targetId);
            if (arch) {
              const bm = bookmarks.find((b) => b.id === arch.bookmarkId) || null;
              modalsEl?.openArchiveViewer(arch, null, bm);
            }
          }
        }
      }
    } catch (e) {
      console.error('Failed to load bookmarks:', e);
    }
  }

  function buildCloudMaps(cloudIndex: ArchiveIndexEntry[]) {
    const cm = new Map<string, ArchiveIndexEntry>();
    const um = new Map<string, ArchiveIndexEntry>();
    for (const entry of cloudIndex) {
      if (entry.deleted) continue;
      if (entry.syncId) cm.set(entry.syncId, entry);
      if (entry.url) {
        const norm = normalizeUrl(entry.url);
        if (norm) um.set(norm, entry);
        um.set(entry.url, entry);
      }
    }
    cloudArchiveMap = cm;
    cloudArchiveUrlMap = um;
  }

  async function loadArchiveMap() {
    try {
      if (typeof db !== 'undefined' && db.archivedPages) {
        const list = await db.archivedPages.toArray();
        const m = new Map<number, ArchivedPage>();
        for (const p of list) m.set(p.bookmarkId, p);
        archiveMap = m;
      }
      const cloudIndex = await getCloudArchiveIndexCache();
      buildCloudMaps(cloudIndex);

      if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
        browser.runtime.sendMessage({ type: 'ARCHIVE_INDEX_REFRESH' }).then((res: any) => {
          if ((res?.ok || res?.success) && Array.isArray(res?.entries)) {
            buildCloudMaps(res.entries);
          }
        }).catch(() => {});
      }
    } catch (e) {
      console.error('Failed to load archive map:', e);
    }
  }

  async function updatePendingConflicts() {
    try {
      const list = await getPendingConflicts();
      pendingConflictCount = list.length;
    } catch (e) {
      console.error('Failed to get pending conflicts:', e);
    }
  }

  function handleStorageChanged(changes: any, area: string) {
    if (area === 'local') {
      if (changes['ai_bulk_progress']) {
        const val = changes['ai_bulk_progress'].newValue;
        const isRunning = val?.status === 'running';
        isAiCategorizing = isRunning && val?.kind === 'categorize';
        isAiSummarizing = isRunning && val?.kind === 'summarize';
        if (val?.done !== undefined) aiBulkProgress = val.done;
        if (val?.total !== undefined) aiBulkTotal = val.total;
        if (val?.status === 'done' || val?.status === 'completed') {
          isAiCategorizing = false;
          isAiSummarizing = false;
          loadBookmarks();
        }
      }
      if (changes['ai_analysis_last_update']) {
        if (aiUpdateDebounceTimer) clearTimeout(aiUpdateDebounceTimer);
        aiUpdateDebounceTimer = setTimeout(() => {
          aiUpdateDebounceTimer = null;
          loadBookmarks();
        }, 150);
      }
      if (changes['ai_analysis_error'] && changes['ai_analysis_error'].newValue) {
        const now = Date.now();
        if (now - lastAiErrorToast > 2000) {
          const detail = changes['ai_analysis_error'].newValue?.error;
          showToast(detail ? i18n.t('ai.analysisFailedWithDetail', { detail }) : i18n.t('ai.analysisFailed'), 'error');
          lastAiErrorToast = now;
        }
      }

      // Real-time reflection of archive progress state (checkpoint)
      if (changes['archive_capture_state']) {
        const curState = changes['archive_capture_state'].newValue;
        if (curState?.bookmarkId) {
          savingArchiveIds.add(curState.bookmarkId);
          savingArchiveIds = savingArchiveIds;
        } else {
          const oldState = changes['archive_capture_state'].oldValue;
          if (oldState?.bookmarkId) {
            savingArchiveIds.delete(oldState.bookmarkId);
            savingArchiveIds = savingArchiveIds;
          } else {
            savingArchiveIds.clear();
            savingArchiveIds = savingArchiveIds;
          }
        }
      }

      // Real-time reflection of archive completion notification
      if (changes['archive_capture_last_update']) {
        if (archiveUpdateDebounceTimer) clearTimeout(archiveUpdateDebounceTimer);
        archiveUpdateDebounceTimer = setTimeout(() => {
          archiveUpdateDebounceTimer = null;
          loadArchiveMap();
        }, 100);
      }

      // Real-time reflection of archive error notification
      if (changes['archive_capture_error'] && changes['archive_capture_error'].newValue) {
        const now = Date.now();
        if (now - lastArchiveErrorToast > 2000) {
          const detail = changes['archive_capture_error'].newValue?.error;
          showToast(detail ? i18n.t('archive.saveFailedWithDetail', { detail }) : i18n.t('archive.saveFailed'), 'error');
          lastArchiveErrorToast = now;
        }
        loadArchiveMap();
      }
    }
  }

  onMount(() => {
    loadBookmarks();
    document.addEventListener('bookmarks-updated', loadBookmarks);
    if (typeof browser !== 'undefined' && browser.storage?.onChanged) {
      browser.storage.onChanged.addListener(handleStorageChanged);
    }
    cleanupAiStore = initAiProgressStore(() => { loadBookmarks(); });

    // Restore in-progress AI bulk job state on initial mount
    if (typeof browser !== 'undefined' && browser.storage?.local) {
      browser.storage.local.get('ai_bulk_progress').then((res: any) => {
        const val = res?.ai_bulk_progress;
        if (val?.status === 'running') {
          isAiCategorizing = val.kind === 'categorize';
          isAiSummarizing = val.kind === 'summarize';
          if (val.done !== undefined) aiBulkProgress = val.done;
          if (val.total !== undefined) aiBulkTotal = val.total;
        }
      }).catch(() => {});
    }

    // Restore in-progress archive state on initial mount
    getArchiveCaptureState().then((state) => {
      if (state?.bookmarkId && Date.now() - state.startedAt < STALE_MS) {
        savingArchiveIds.add(state.bookmarkId);
        savingArchiveIds = savingArchiveIds;
      }
    }).catch(() => {});

    updateTreeMaxHeight();
  });

  onDestroy(() => {
    if (aiUpdateDebounceTimer) clearTimeout(aiUpdateDebounceTimer);
    if (archiveUpdateDebounceTimer) clearTimeout(archiveUpdateDebounceTimer);
    document.removeEventListener('bookmarks-updated', loadBookmarks);
    if (typeof browser !== 'undefined' && browser.storage?.onChanged) {
      browser.storage.onChanged.removeListener(handleStorageChanged);
    }
    if (cleanupAiStore) cleanupAiStore();
    if (treeHeightRaf !== null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(treeHeightRaf);
      treeHeightRaf = null;
    }
  });

  // Dynamic viewport-height matching for FolderTree panel (Option A: Viewport bottom aligned)
  let folderTreePanelEl: HTMLElement | null = null;
  let treeMaxHeight = 'calc(100dvh - 11.5rem)';
  let treeHeightRaf: number | null = null;

  function updateTreeMaxHeight() {
    if (!folderTreePanelEl || typeof window === 'undefined') return;
    const rect = folderTreePanelEl.getBoundingClientRect();
    // 24px bottom buffer ensures the panel and its scrollbar never overflow or touch the viewport bottom
    const available = window.innerHeight - rect.top - 24;
    if (available > 160) {
      treeMaxHeight = `${Math.floor(available)}px`;
    }
  }

  function handleWindowChange() {
    if (typeof window === 'undefined') return;
    if (treeHeightRaf !== null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(treeHeightRaf);
    }
    if (typeof requestAnimationFrame !== 'undefined') {
      treeHeightRaf = requestAnimationFrame(() => {
        treeHeightRaf = null;
        updateTreeMaxHeight();
      });
    } else {
      updateTreeMaxHeight();
    }
  }

  $: if (folders && folders.length > 0) {
    handleWindowChange();
  }

  // Selection toggle
  function handleToggleSelect(bookmarkId: number) {
    if (selectedIds.has(bookmarkId)) selectedIds.delete(bookmarkId);
    else selectedIds.add(bookmarkId);
    selectedIds = selectedIds;
  }

  function handleToggleSelectAll() {
    if (allSelected) {
      for (const b of filteredBookmarks) {
        if (b.id !== undefined) selectedIds.delete(b.id);
      }
    } else {
      for (const b of filteredBookmarks) {
        if (b.id !== undefined) selectedIds.add(b.id);
      }
    }
    selectedIds = selectedIds;
  }

  function handleClearSelection() {
    selectedIds.clear();
    selectedIds = selectedIds;
  }

  function handleModalsDeleting(e: CustomEvent<{ ids: number[] }>) {
    if (e.detail?.ids) {
      for (const id of e.detail.ids) deletingBookmarkIds.add(id);
      deletingBookmarkIds = deletingBookmarkIds;
    }
  }

  function handleModalsDeleteFailed(e: CustomEvent<{ ids: number[] }>) {
    if (e.detail?.ids) {
      for (const id of e.detail.ids) deletingBookmarkIds.delete(id);
      deletingBookmarkIds = deletingBookmarkIds;
    }
  }

  function handleModalsDeleted(e: CustomEvent<{ ids: number[] }>) {
    if (e.detail?.ids) {
      for (const id of e.detail.ids) {
        selectedIds.delete(id);
        deletingBookmarkIds.delete(id);
      }
    }
    selectedIds = selectedIds;
    deletingBookmarkIds = deletingBookmarkIds;
    loadBookmarks();
  }

  async function handleCrossRootUpdated() {
    try { folders = await BookmarkManager.getFolders(); } catch {}
    await loadBookmarks();
  }

  // Open / Save / Delete archive
  async function handleOpenArchive(bookmark: Bookmark) {
    if (!bookmark.id) return;
    openingArchiveId = bookmark.id;
    try {
      const normUrl = bookmark.url ? normalizeUrl(bookmark.url) : '';
      const resolvedEntry =
        (bookmark.syncId ? cloudArchiveMap.get(bookmark.syncId) : null) ||
        (normUrl ? cloudArchiveUrlMap.get(normUrl) : null) ||
        (bookmark.url ? cloudArchiveUrlMap.get(bookmark.url) : null);
      const targetBookmark = (resolvedEntry?.syncId && !bookmark.syncId)
        ? { ...bookmark, syncId: resolvedEntry.syncId }
        : bookmark;

      await openArchiveBookmark(
        targetBookmark,
        archiveMap,
        cloudArchiveMap,
        (arch, html, bm) => modalsEl?.openArchiveViewer(arch, html, bm || targetBookmark),
        loadArchiveMap,
        () => { downloadingArchiveIds.add(bookmark.id!); downloadingArchiveIds = downloadingArchiveIds; },
        () => { downloadingArchiveIds.delete(bookmark.id!); downloadingArchiveIds = downloadingArchiveIds; },
        cloudArchiveUrlMap
      );
    } finally {
      openingArchiveId = null;
    }
  }

  async function handleSaveArchive(bookmark: Bookmark) {
    if (bookmark.id === undefined || savingArchiveIds.has(bookmark.id) || openingArchiveId !== null) return;
    await saveArchiveBookmark(
      bookmark,
      () => { savingArchiveIds.add(bookmark.id!); savingArchiveIds = savingArchiveIds; },
      () => { savingArchiveIds.delete(bookmark.id!); savingArchiveIds = savingArchiveIds; },
      loadArchiveMap
    );
  }

  export async function deleteArchive(id: number) {
    const targetBm = bookmarks.find((b) => b.id === id);
    const activeArch = modalsEl?.getActiveArchive();
    await deleteArchiveRecord(
      id,
      activeArch?.id,
      loadArchiveMap,
      () => modalsEl?.closeArchiveViewer(),
      {
        syncId: targetBm?.syncId,
        url: targetBm?.url || activeArch?.url,
        bookmarkId: targetBm?.id ?? activeArch?.bookmarkId
      }
    );
  }

  // Link check
  function handleReviewSelected() {
    const ids = selectedIds.size > 0
      ? Array.from(selectedIds)
      : filteredBookmarks.map((b) => b.id).filter((id): id is number => id !== undefined);
    if (ids.length === 0) return;
    bulkScanController.start(
      ids,
      (results) => {
        loadBookmarks();
        const errorCount = results.filter((r) => r.status !== 'ok').length;
        if (errorCount > 0) {
          if (!selectedFilters.includes('broken')) {
            selectedFilters = [...selectedFilters, 'broken'];
          }
          selectedFilter = 'broken';
        }
        showToast(i18n.t('healthCheck.scanCompleted', { deadCount: errorCount, count: errorCount, errorCount }), 'success');
      },
      (err) => { showToast(i18n.t('healthCheck.scanError', { error: err.message }), 'error'); }
    );
  }

  function handleStopScan() {
    bulkScanController.stop();
    showToast(i18n.t('healthCheck.scanStopped'), 'info');
  }

  async function handleClearHealthError(b: Bookmark) {
    if (b.id === undefined) return;
    try {
      await clearBookmarkHealth(b.id);
      bulkScanController.clearResult(b.id);
      b.httpStatus = 200;
      bookmarks = [...bookmarks];
      showToast(i18n.t('bookmarks.healthErrorCleared'), 'success');
    } catch (err: any) {
      console.error('Failed to clear health error:', err);
      showToast(i18n.t('bookmarks.healthErrorClearFailed'), 'error');
    }
  }

  // AI bulk categorization/summarization
  export async function handleBulkAiCategorize() {
    const res = await requestBulkAiCategorize(selectedIds, bookmarks, folders);
    if (res.started) {
      isAiCategorizing = true;
      isAiSummarizing = false;
      aiBulkTotal = res.total || 0;
      aiBulkProgress = 0;
    }
  }

  async function handleCancelBulkAi() {
    isAiCategorizing = false;
    isAiSummarizing = false;
    aiBulkProgress = 0;
    aiBulkTotal = 0;
    await cancelBulkAi();
    await loadBookmarks();
  }

  export async function handleBulkAiSummarize() {
    const res = await requestBulkAiSummarize(selectedIds, bookmarks);
    if (res.started) {
      isAiSummarizing = true;
      isAiCategorizing = false;
      aiBulkTotal = res.total || 0;
      aiBulkProgress = 0;
    }
  }

  // Folder delete / reorder / move
  function isSystemRootTitle(title: string): boolean {
    return ['Bookmarks bar', 'Bookmarks Bar', 'Other bookmarks', 'Other Bookmarks', 'Mobile bookmarks', 'Mobile Bookmarks', '북마크바', '북마크 바', '기타 북마크', '모바일 북마크'].includes(title);
  }

  async function handleFolderDelete(e: any) {
    const path = e?.detail?.value || e?.detail?.path;
    if (!path) return;
    const folder = folders.find(f => f.path === path || f.id === e?.detail?.folder?.id);
    if (!folder || isSystemRootTitle(folder.title)) return;

    const inside = bookmarks.filter(b => (b.folderPath || '') === path || (b.folderPath || '').startsWith(path + '/'));
    if (inside.length === 0) {
      if (typeof browser !== 'undefined' && browser.bookmarks?.removeTree) await browser.bookmarks.removeTree(folder.id);
      else await BookmarkManager.deleteFolder(folder.id);
      if (selectedFolder === folder.path || selectedFolder.startsWith(folder.path + '/')) selectedFolder = '';
      folders = await BookmarkManager.getFolders();
      await loadBookmarks();
      showToast(i18n.t('folders.deleted'), 'success');
      return;
    }
    modalsEl?.openFolderDeleteModal({ path, title: folder.title, count: inside.length });
  }

  async function handleFolderClean(e: any) {
    const path = e?.detail?.value ?? '';
    const folderId = e?.detail?.folderId;
    const title = e?.detail?.title || (path ? path.split('/').pop() : '') || i18n.t('folders.allFolders');
    try {
      const preview = await BookmarkManager.findEmptyFolders(folderId, path);
      if (preview.count === 0) {
        showToast(i18n.t('folders.noEmptyFoldersFound'), 'info');
        return;
      }
      modalsEl?.openCleanEmptyFoldersModal({
        title,
        folderId,
        path,
        emptyFolders: preview.emptyFolders
      });
    } catch (err: any) {
      console.error('Failed to find empty folders:', err);
      showToast(i18n.t('folders.cleanEmptyFoldersFailed', { error: err?.message || '' }), 'error');
    }
  }

  async function handleFolderModalCleaned(e: CustomEvent<{ deletedPaths: string[] }>) {
    const deletedPaths = e.detail?.deletedPaths || [];
    if (selectedFolder && deletedPaths.includes(selectedFolder)) {
      selectedFolder = '';
    }
    folders = await BookmarkManager.getFolders();
    await loadBookmarks();
  }

  async function handleFolderReorder(e: any) {
    const { folderId, parentId, order } = e?.detail ?? {};
    if (!folderId || !parentId || !Array.isArray(order) || order.length === 0) return;
    const f = folders.find(x => x.id === folderId);
    if (!f || isSystemRootTitle(f.title) || typeof browser === 'undefined' || !browser.bookmarks?.move) return;
    try {
      for (let i = 0; i < order.length; i++) await browser.bookmarks.move(order[i], { parentId, index: i });
      folders = await BookmarkManager.getFolders();
      showToast(i18n.t('folders.reordered'), 'success');
    } catch (err) {
      showToast(i18n.t('folders.reorderFailed'), 'error');
    }
  }

  async function handleFolderMove(e: CustomEvent<{
    folderId: string;
    targetParentId: string;
    targetPath?: string;
    position?: 'before' | 'after' | 'inside';
    referenceFolderId?: string;
    targetIndex?: number;
  }>) {
    const { folderId, targetParentId, position, referenceFolderId, targetIndex } = e?.detail ?? {};
    if (!folderId || !targetParentId) return;

    const source = folders.find((x) => x.id === folderId);
    if (!source || isSystemRootTitle(source.title)) return;
    if (typeof browser === 'undefined' || !browser.bookmarks?.move) return;

    // 루트 '0'으로의 이동 방어 (브라우저 정책 위반 차단)
    if (targetParentId === '0' || targetParentId === 'root' || targetParentId === 'root________') return;

    // 동일 부모 내에서 위치 지정(index / referenceFolderId) 없는 이동은 No-op 방어
    if (targetParentId === source.parentId && !referenceFolderId && targetIndex === undefined) return;

    try {
      const moveDestination: { parentId: string; index?: number } = { parentId: targetParentId };

      let destIndex: number | undefined = undefined;
      if (referenceFolderId && (position === 'before' || position === 'after')) {
        try {
          const [refNode] = await browser.bookmarks.get(referenceFolderId);
          if (refNode && typeof refNode.index === 'number') {
            destIndex = position === 'before' ? refNode.index : refNode.index + 1;
          }
        } catch (err) {
          console.warn('Failed to resolve referenceFolderId index, falling back to targetIndex:', err);
        }
      }

      if (destIndex === undefined && typeof targetIndex === 'number' && targetIndex >= 0) {
        destIndex = targetIndex;
      }

      if (typeof destIndex === 'number') {
        moveDestination.index = destIndex;
      }

      const oldPath = source.path;
      await browser.bookmarks.move(folderId, moveDestination);
      await BookmarkManager.syncAll();
      folders = await BookmarkManager.getFolders();

      const updated = folders.find((x) => x.id === folderId);
      if (updated && updated.path !== oldPath) {
        if (selectedFolder === oldPath) {
          selectedFolder = updated.path;
        } else if (selectedFolder.startsWith(oldPath + '/')) {
          selectedFolder = updated.path + selectedFolder.slice(oldPath.length);
        }
      }

      await loadBookmarks();
      showToast(i18n.t('folders.moved'), 'success');
    } catch (err: any) {
      console.error('Failed to move folder:', err);
      showToast(i18n.t('folders.moveFailed'), 'error');
    }
  }

  async function handleDropBookmarks(e: CustomEvent<{ bookmarkIds: number[]; targetFolder: { id: string; path: string; title: string } }>) {
    const { bookmarkIds, targetFolder } = e?.detail ?? {};
    if (!bookmarkIds || bookmarkIds.length === 0 || !targetFolder || !targetFolder.id) return;

    try {
      const { movedCount } = await BookmarkManager.moveBookmarksToFolder(bookmarkIds, targetFolder);
      if (movedCount > 0) {
        selectedIds.clear();
        selectedIds = selectedIds;
        folders = await BookmarkManager.getFolders();
        await loadBookmarks();
        const folderName = targetFolder.title || targetFolder.path || '';
        showToast(
          movedCount === 1
            ? i18n.t('folders.bookmarkMoved', { folder: folderName })
            : i18n.t('folders.bookmarksMoved', { count: movedCount, folder: folderName }),
          'success'
        );
      }
    } catch (err: any) {
      console.error('Failed to move bookmarks via drag & drop:', err);
      showToast(i18n.t('folders.moveFailed'), 'error');
    }
  }

  function handleSelectTag(tag: string) {
    if (!tag) return;
    if (selectedTags.includes(tag)) {
      selectedTags = selectedTags.filter((t) => t !== tag);
      if (selectedTag === tag) selectedTag = 'all';
    } else {
      selectedTags = [...selectedTags, tag];
      selectedTag = tag;
    }
  }

  async function handleFolderModalDeleted(e: CustomEvent<{ path: string }>) {
    if (selectedFolder === e.detail?.path || selectedFolder.startsWith(e.detail?.path + '/')) selectedFolder = '';
    folders = await BookmarkManager.getFolders();
    await loadBookmarks();
  }

  function handleFolderEdit(e: any) {
    const detail = e?.detail;
    if (!detail) return;
    const folderId = detail.id || detail.folderId;
    const path = detail.path || detail.value;
    const folder = folders.find(f => (folderId && f.id === folderId) || (path && f.path === path));
    if (!folder || isSystemRootTitle(folder.title)) return;
    modalsEl?.openFolderRenameModal({
      id: folder.id,
      folderId: folder.id,
      title: folder.title,
      path: folder.path,
      parentId: folder.parentId
    });
  }

  async function handleFolderModalRenamed(e: CustomEvent<{ folderId: string; oldPath: string; oldTitle: string; newTitle: string }>) {
    const { oldPath, folderId } = e.detail;
    folders = await BookmarkManager.getFolders();
    const updated = folders.find(f => f.id === folderId);
    const newPath = updated?.path || '';

    if (selectedFolder === oldPath) {
      selectedFolder = newPath;
    } else if (selectedFolder.startsWith(oldPath + '/')) {
      selectedFolder = newPath + selectedFolder.slice(oldPath.length);
    }
    await loadBookmarks();
  }
</script>

<svelte:window on:scroll={handleWindowChange} on:resize={handleWindowChange} />

<div class="bookmarks-container">
  <BookmarkListHeader
    {bookmarks}
    totalCount={bookmarks.length}
    filteredCount={filteredBookmarks.length}
    isFiltered={filteredBookmarks.length !== bookmarks.length}
    hasConflict={pendingConflictCount > 0}
    conflictCount={pendingConflictCount}
    on:imported={loadBookmarks}
    on:openConflictModal={() => { document.dispatchEvent(new CustomEvent('sync-conflicts-detected')); }}
  />

  <div class="filter-bar-sticky-wrapper">
    <BookmarkFilterBar
      bind:searchQuery
      bind:selectedFilters
      bind:selectedTags
      bind:selectedFolder
      bind:selectedFilter
      bind:selectedTag
      bind:sortBy
      bind:viewMode
      {availableTags}
      on:clearFilters={() => {
        searchQuery = '';
        selectedFolder = '';
        selectedFilters = [];
        selectedTags = [];
        selectedTag = 'all';
        selectedFilter = 'all';
      }}
    />
  </div>

  <CrossRootSection
    bind:this={crossRootSectionEl}
    {bookmarks}
    {folders}
    on:updated={handleCrossRootUpdated}
  />

  <div class="bookmarks-layout">
    {#if folders && folders.length > 0}
      <div class="folder-tree-panel" bind:this={folderTreePanelEl} style="max-height: {treeMaxHeight};">
        <FolderTree
          {folders}
          counts={folderCounts}
          {rootCount}
          bind:value={selectedFolder}
          on:edit={handleFolderEdit}
          on:delete={handleFolderDelete}
          on:clean={handleFolderClean}
          on:reorder={handleFolderReorder}
          on:move={handleFolderMove}
          on:dropBookmarks={handleDropBookmarks}
        />
      </div>
    {/if}

    <div class="results-wrapper">
      <div class="bulk-action-sticky-wrapper">
        {#if $scanState.isScanning || isAiCategorizing || isAiSummarizing}
          <div class="progress-bar-container">
            <div
              class="progress-bar {(isAiCategorizing || isAiSummarizing) && aiBulkProgress === 0 ? 'progress-bar-indeterminate' : ''}"
              style="width: {(isAiCategorizing || isAiSummarizing) ? (aiBulkProgress / (aiBulkTotal || 1)) * 100 : ($scanState.progress / ($scanState.total || 1)) * 100}%"
            ></div>
          </div>
        {/if}

        <BulkActionBar
          selectedCount={selectedIds.size}
          totalCount={filteredBookmarks.length}
          {allSelected}
          isScanning={$scanState.isScanning}
          scanProgress={$scanState.progress}
          scanTotal={$scanState.total}
          {isAiCategorizing}
          {isAiSummarizing}
          {deadSelectedCount}
          isDeleting={deletingBookmarkIds.size > 0}
          on:toggleSelectAll={handleToggleSelectAll}
          on:clearSelection={handleClearSelection}
          on:categorizeAi={handleBulkAiCategorize}
          on:cancelAi={handleCancelBulkAi}
          on:summarizeAi={handleBulkAiSummarize}
          on:reviewLinks={handleReviewSelected}
          on:stopScan={handleStopScan}
          on:delete404={() => modalsEl?.openDelete404()}
          on:deleteSelected={() => modalsEl?.openDeleteSelected()}
        />
      </div>

      {#if filteredBookmarks.length === 0}
        <EmptyState
          icon="search"
          title={i18n.t('bookmarks.noBookmarks')}
          description={searchQuery || selectedFolder || selectedTags.length > 0 || selectedFilters.length > 0 || selectedTag !== 'all' || selectedFilter !== 'all' ? i18n.t('bookmarks.emptyFilter') : i18n.t('bookmarks.noBookmarks')}
        />
      {:else if viewMode === 'list'}
        <div class="bookmarks-list-view">
          <BookmarkTableHeader
            {allSelected}
            {sortBy}
            on:toggleSelectAll={handleToggleSelectAll}
            on:sort={(e) => { sortBy = e.detail.sortBy; }}
          />
          <div class="bookmarks-list-rows" role="table" aria-label={i18n.t('bookmarks.title')}>
            {#each filteredBookmarks as b (b.id)}
              <BookmarkRow
                bookmark={b}
                selected={b.id !== undefined && selectedIds.has(b.id)}
                {selectedIds}
                isDeleting={b.id !== undefined && deletingBookmarkIds.has(b.id)}
                hasArchive={b.id !== undefined && (archiveMap.has(b.id) || (!!b.syncId && cloudArchiveMap.has(b.syncId)) || (!!b.url && (cloudArchiveUrlMap.has(normalizeUrl(b.url)) || cloudArchiveUrlMap.has(b.url))))}
                isArchivedLocally={b.id !== undefined && archiveMap.has(b.id)}
                isArchivedInCloud={(!!b.syncId && cloudArchiveMap.has(b.syncId)) || (!!b.url && (cloudArchiveUrlMap.has(normalizeUrl(b.url)) || cloudArchiveUrlMap.has(b.url)))}
                healthResult={b.id !== undefined ? $scanState.healthResults?.get(b.id) : undefined}
                isDead={isBookmarkDead(b, b.id !== undefined ? $scanState.healthResults?.get(b.id) : undefined)}
                isScanning={b.id !== undefined && ($scanState.scanningIds?.has(b.id) ?? false)}
                isSessionOk={b.id !== undefined && ($scanState.sessionOkIds?.has(b.id) ?? false)}
                openingArchive={b.id !== undefined && openingArchiveId === b.id}
                isDownloadingArchive={b.id !== undefined && downloadingArchiveIds.has(b.id)}
                savingArchive={b.id !== undefined && savingArchiveIds.has(b.id)}
                on:toggleSelect={(e) => handleToggleSelect(e.detail.bookmarkId)}
                on:openUrl={(e) => BookmarkManager.openBookmark(e.detail.url)}
                on:openArchive={(e) => handleOpenArchive(e.detail.bookmark)}
                on:saveArchive={(e) => handleSaveArchive(e.detail.bookmark)}
                on:edit={(e) => modalsEl?.openEdit(e.detail.bookmark)}
                on:delete={(e) => modalsEl?.openDeleteSingle(e.detail.bookmarkId)}
                on:retryAi={(e) => retrySingleAi(e.detail.bookmark, folders, isAiCategorizing || isAiSummarizing)}
                on:cancelAi={(e) => cancelSingleAi(e.detail.bookmarkId)}
                on:clearHealthError={(e) => handleClearHealthError(e.detail.bookmark)}
                on:openCrossRoot={(e) => crossRootSectionEl?.openSingle(e.detail.bookmark)}
                on:stopScan={handleStopScan}
                on:selectTag={(e) => handleSelectTag(e.detail.tag)}
                on:selectFolder={(e) => { selectedFolder = e.detail.folderPath; }}
              />
            {/each}
          </div>
        </div>
      {:else}
        <div class="bookmarks-grid">
          {#each filteredBookmarks as b (b.id)}
            <BookmarkCard
              bookmark={b}
              selected={b.id !== undefined && selectedIds.has(b.id)}
              {selectedIds}
              isDeleting={b.id !== undefined && deletingBookmarkIds.has(b.id)}
              hasArchive={b.id !== undefined && (archiveMap.has(b.id) || (!!b.syncId && cloudArchiveMap.has(b.syncId)) || (!!b.url && (cloudArchiveUrlMap.has(normalizeUrl(b.url)) || cloudArchiveUrlMap.has(b.url))))}
              isArchivedLocally={b.id !== undefined && archiveMap.has(b.id)}
              isArchivedInCloud={(!!b.syncId && cloudArchiveMap.has(b.syncId)) || (!!b.url && (cloudArchiveUrlMap.has(normalizeUrl(b.url)) || cloudArchiveUrlMap.has(b.url)))}
              healthResult={b.id !== undefined ? $scanState.healthResults?.get(b.id) : undefined}
              isDead={isBookmarkDead(b, b.id !== undefined ? $scanState.healthResults?.get(b.id) : undefined)}
              isScanning={b.id !== undefined && ($scanState.scanningIds?.has(b.id) ?? false)}
              isSessionOk={b.id !== undefined && ($scanState.sessionOkIds?.has(b.id) ?? false)}
              openingArchive={b.id !== undefined && openingArchiveId === b.id}
              isDownloadingArchive={b.id !== undefined && downloadingArchiveIds.has(b.id)}
              savingArchive={b.id !== undefined && savingArchiveIds.has(b.id)}
              on:toggleSelect={(e) => handleToggleSelect(e.detail.bookmarkId)}
              on:openUrl={(e) => BookmarkManager.openBookmark(e.detail.url)}
              on:openArchive={(e) => handleOpenArchive(e.detail.bookmark)}
              on:saveArchive={(e) => handleSaveArchive(e.detail.bookmark)}
              on:edit={(e) => modalsEl?.openEdit(e.detail.bookmark)}
              on:delete={(e) => modalsEl?.openDeleteSingle(e.detail.bookmarkId)}
              on:retryAi={(e) => retrySingleAi(e.detail.bookmark, folders, isAiCategorizing || isAiSummarizing)}
              on:cancelAi={(e) => cancelSingleAi(e.detail.bookmarkId)}
              on:clearHealthError={(e) => handleClearHealthError(e.detail.bookmark)}
              on:openCrossRoot={(e) => crossRootSectionEl?.openSingle(e.detail.bookmark)}
              on:stopScan={handleStopScan}
              on:selectTag={(e) => handleSelectTag(e.detail.tag)}
            />
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>

<BookmarkModals
  bind:this={modalsEl}
  {folders}
  {bookmarks}
  {selectedIds}
  {archiveMap}
  healthResults={$scanState.healthResults}
  on:saved={loadBookmarks}
  on:deleting={handleModalsDeleting}
  on:deleteFailed={handleModalsDeleteFailed}
  on:deleted={handleModalsDeleted}
  on:folderDeleted={handleFolderModalDeleted}
  on:folderCleaned={handleFolderModalCleaned}
  on:folderRenamed={handleFolderModalRenamed}
  on:archiveDeleted={loadArchiveMap}
/>

<style>
  .bookmarks-container { display: flex; flex-direction: column; gap: 1rem; width: 100%; }
  .filter-bar-sticky-wrapper {
    position: sticky;
    top: 0;
    z-index: 9;
    background: var(--bg-primary);
    padding: 0.5rem 0;
    margin-top: -0.5rem;
    box-shadow: 0 0.5rem 0 0 var(--bg-primary);
  }
  .bookmarks-layout { display: grid; grid-template-columns: 240px 1fr; gap: 1.25rem; align-items: start; }
  .folder-tree-panel {
    position: sticky;
    top: 3.5rem;
    z-index: 8;
    max-height: calc(100dvh - 10.5rem);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .results-wrapper { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
  .bulk-action-sticky-wrapper {
    position: sticky;
    top: 3.5rem;
    z-index: 8;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .progress-bar-container {
    width: 100%;
    height: 4px;
    background-color: var(--bg-tertiary);
    border-radius: 2px;
    overflow: hidden;
  }
  .progress-bar { height: 100%; background-color: var(--color-primary); transition: width var(--transition-fast); }
  .progress-bar-indeterminate { animation: indeterminate 1.5s infinite linear; transform-origin: 0% 50%; }
  @keyframes indeterminate {
    0% { transform: translateX(0) scaleX(0); }
    40% { transform: translateX(0) scaleX(0.4); }
    100% { transform: translateX(100%) scaleX(0.5); }
  }
  .bookmarks-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1rem; }
  .bookmarks-list-view { display: flex; flex-direction: column; gap: 0.5rem; width: 100%; min-width: 0; }
  .bookmarks-list-rows { display: flex; flex-direction: column; gap: 0.35rem; width: 100%; min-width: 0; }
  @media (max-width: 768px) {
    .bookmarks-layout { grid-template-columns: 1fr; }
    .folder-tree-panel { position: static; max-height: 300px !important; }
    .filter-bar-sticky-wrapper { position: static; padding: 0; margin-top: 0; box-shadow: none; }
    .bulk-action-sticky-wrapper { position: static; padding: 0; margin: 0; }
  }
</style>
