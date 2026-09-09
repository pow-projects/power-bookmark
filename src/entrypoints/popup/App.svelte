<script lang="ts">
  /**
   * PowerBookmark Popup — "Registered Item Card" (v2)
   *
   * Clicking extension button = page is already automatically registered, so popup is not a "creation form"
   * but a management card in REGISTERED state. UI state model:
   *   LOADING   : loaded=false → ribbon loading bar + mono LOADING ENTRY…
   *   REGISTERED: localBookmarkId!==null → autosave form (+ pipeline status line only during progress/error)
   *   Completed states (REGISTERED/ARCHIVED/AI done) are not reiterated with stamps — buttons/forms already express them.
   *   FAILED    : auto-save failed / no page info → slim error banner + [Save Again] (R2 fallback)
   */
  import { onMount, onDestroy } from 'svelte';
  import type { Bookmark } from '../../lib/db';
  import { BookmarkManager } from '../../lib/bookmarks/bookmark-manager';
  import { isSameFolderLocation } from '../../lib/bookmarks/folder-utils';
  import { isAiConfigured } from '../../lib/ai/ai-summarizer';
  import type { ExtractedPagePayload, FolderInfo } from '../../lib/ai/types';
  import { buildArchiveBannerHtml } from '../../lib/archive/archive-viewer';
  import { getCloudArchiveIndexCache } from '../../lib/archive/archive-cloud';
  import db from '../../lib/db';
  import BookmarkForm from '../../components/popup/BookmarkForm.svelte';
  import ActionButtons from '../../components/popup/ActionButtons.svelte';
  import Icon from '../../components/shared/Icon.svelte';
  import { setTaskIndicator } from '../../lib/bookmarks/badge-manager';

  // Tab data
  let currentTab: chrome.tabs.Tab | null = null;

  // Form state
  let title = '';
  let url = '';
  let description = '';
  let folderId = '';
  let folders: FolderInfo[] = [];
  let hasArchive = false;
  let loaded = false;
  let isEditMode = false;
  let localBookmarkId: number | null = null; // Bookmark record ID (for deletion)

  // State flags
  let isAdding = false;
  let isArchiving = false;
  let isSaving = false;
  let isDeleting = false;
  let successAction: 'archive' | 'delete' | null = null;
  let errorMessage: string | null = null;

  // v2 — Registered item card state
  let archiveStatus: 'none' | 'in_progress' | 'archived' = 'none';
  let aiStatus: NonNullable<Bookmark['aiStatus']> = 'none';
  let saveIndicator: 'idle' | 'saving' = 'idle'; // Autosave indicator (no completed state display — in-progress only)
  let archiveInSince: number | null = null; // in_progress optimistic timing (for fallback timeout)

  // URL duplicate detection result (set in onMount — used for deletion propagation syncId)
  let duplicate: Bookmark | null = null;

  // Autosave debounce
  let autosaveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let statusPollTimer: ReturnType<typeof setInterval> | null = null;
  let lastSavedTitle = '';
  let lastSavedDescription = '';
  let lastSavedFolderId = '';

  onMount(async () => {
    try {
      currentTab = await getActiveTab();
      if (!currentTab) return; // finally → end LOADING, FAILED state (no page info)

      // Load existing bookmark data (find duplicate by URL)
      url = currentTab.url || '';
      title = currentTab.title || '';

      if (url) {
        duplicate = await BookmarkManager.findDuplicate(url);
      }

      if (duplicate) {
        // Existing bookmark - enter edit mode
        isEditMode = true;
        localBookmarkId = duplicate.id;
        title = duplicate.title || currentTab.title || '';
        url = duplicate.url || currentTab.url || '';
        description = duplicate.description || '';

        // [t_7539944f] loadFoldersWithRetry: 1 retry (200ms) to prevent initialization timing race
        const folderResult = await loadFoldersWithRetry();
        folders = folderResult.folders;
        if (!folderResult.success) {
          errorMessage = i18n.t('popup.error.foldersLoadFailed');
        }

        // Set folderId based on duplicate.folderPath using isSameFolderLocation
        const dupFolderPath = duplicate.folderPath;
        if (dupFolderPath) {
          const normalizedTarget = dupFolderPath.replace(/^\//, '').toLowerCase();
          const matchedFolder = folders.find(f => {
            return isSameFolderLocation(f.path, dupFolderPath);
          });
          if (matchedFolder) {
            folderId = matchedFolder.id;
          } else {
            // No folder found matching the stored path - leave as default (uncategorized)
            console.warn(`[Popup] No folder matches saved path: ${dupFolderPath}`);
          }
        } else {
          console.log('[Popup] Duplicate bookmark has no folderPath, using default');
        }
      } else {
        // New bookmark - load available folders for selection
        const folderResult = await loadFoldersWithRetry();
        folders = folderResult.folders;
        if (!folderResult.success) {
          errorMessage = i18n.t('popup.error.foldersLoadFailed');
        }
      }

      // Set default values
      if (url && !title) title = url;
      if (folderId === '' && folders.length > 0) folderId = folders[0].id;

      // Auto-registration path: existing item is already REGISTERED, new item created immediately here
      if (!isEditMode) {
        await autoAddBookmark();
      }
    } catch (error) {
      console.error('Popup onMount error:', error);
      errorMessage = i18n.t('popup.error.pageLoadFailed');
    } finally {
      loaded = true;
    }

    // [t_645c7d9b] Initialize pipeline state for registered item + 2-second polling while popup is open
    if (localBookmarkId !== null) {
      if (!isEditMode) isEditMode = true;
      try {
        const archived = await checkHasArchive(localBookmarkId, duplicate?.syncId);
        hasArchive = archived;
        archiveStatus = archived ? 'archived' : (archiveStatus === 'in_progress' ? 'in_progress' : 'none');
        const existing = await db.bookmarks.get(localBookmarkId).catch(() => undefined);
        aiStatus = (existing?.aiStatus ?? 'none') as NonNullable<Bookmark['aiStatus']>;
      } catch (error) {
        console.error('[Popup] Failed to initialize pipeline status:', error);
      }
      startStatusPolling();

      // Re-check hasArchive after cloud index refresh (maintain existing logic)
      browser.runtime.sendMessage({ type: 'ARCHIVE_INDEX_REFRESH' }).then(async () => {
        if (localBookmarkId === null) return;
        const archived = await checkHasArchive(localBookmarkId, duplicate?.syncId);
        hasArchive = archived;
        if (archived) archiveStatus = 'archived';
      }).catch(() => {});
    }
  });

  onDestroy(() => {
    stopStatusPolling();
    if (autosaveDebounceTimer) clearTimeout(autosaveDebounceTimer);
  });

  /**
   * [t_7539944f] Load folders: on failure, retry once after 200ms.
   */
  async function loadFoldersWithRetry(): Promise<{ folders: FolderInfo[]; success: boolean }> {
    try {
      const list = await BookmarkManager.getFolders();
      return { folders: list, success: true };
    } catch (error) {
      console.warn('[Popup] Folder loading failed, retrying once:', error);
      await new Promise(r => setTimeout(r, 200));
      try {
        const list = await BookmarkManager.getFolders();
        return { folders: list, success: true };
      } catch (retryError) {
        console.error('[Popup] Folder loading failed after retry:', retryError);
        return { folders: [], success: false };
      }
    }
  }

  async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
    const isExtensionUrl = (url?: string) => {
      if (!url) return false;
      return url.startsWith('chrome-extension://') ||
             url.startsWith('moz-extension://') ||
             url.startsWith('extension://');
    };

    const queries: chrome.tabs.QueryInfo[] = [
      { active: true, currentWindow: true },
      { active: true, lastFocusedWindow: true },
      { active: true }
    ];

    for (const query of queries) {
      try {
        const tabs = await browser.tabs.query(query);
        if (tabs && tabs.length > 0) {
          const webTab = tabs.find(t => t.url && !isExtensionUrl(t.url));
          if (webTab) return webTab;
          if (tabs[0] && !isExtensionUrl(tabs[0].url)) {
            return tabs[0];
          }
        }
      } catch (e) {
        console.warn(`tabs.query failed for query:`, query, e);
      }
    }

    try {
      const allTabs = await browser.tabs.query({});
      const webTab = allTabs.find(t => t.url && !isExtensionUrl(t.url));
      if (webTab) {
        return webTab;
      }
    } catch (e) {
      console.error('Failed to query all tabs:', e);
    }

    return null;
  }

  /**
   * Extract full HTML source from tab (for archiving) — revived v1 local function (corrects v2 importing
   * non-existent extractTabHtml from page-capture). 1500ms timeout.
   */
  async function extractTabHtml(tabId: number): Promise<{ html: string; iframeSources: Record<string, string> }> {
    try {
      const sendPromise = browser.tabs.sendMessage(tabId, { type: 'EXTRACT_HTML' });
      const timeoutPromise = new Promise<{ html: string; iframeSources: Record<string, string> }>((resolve) =>
        setTimeout(() => resolve({ html: '', iframeSources: {} }), 6000)
      );
      const response = await Promise.race([sendPromise, timeoutPromise]);
      return { html: response?.html || '', iframeSources: response?.iframeSources || {} };
    } catch (e) {
      console.error('Failed to extract HTML from page:', e);
      return { html: '', iframeSources: {} };
    }
  }

  /**
   * Extract ExtractedPagePayload from tab (for background AI analysis) - 1000ms timeout
   */
  async function extractPagePayload(): Promise<ExtractedPagePayload | null> {
    if (!currentTab || !currentTab.id) return null;
    try {
      const sendPromise = browser.tabs.sendMessage(currentTab.id, { type: 'EXTRACT_TEXT' });
      const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000));
      const response = await Promise.race([sendPromise, timeoutPromise]);
      if (!response) return null;
      return {
        title: response.title || title || currentTab.title || '',
        url: response.url || url || currentTab.url || '',
        metaDescription: response.metaDescription || '',
        content: response.content || response.text || '',
        extractionType: response.extractionType || 'basic',
        text: response.text || response.content || ''
      };
    } catch (e) {
      console.error('Failed to extract page payload from tab:', e);
      return null;
    }
  }

  /**
   * Delegates AI analysis of saved bookmark to background service worker.
   * Saving completes successfully even if auto-analysis is disabled or payload extraction fails.
   * - aiStatus='pending' is recorded **only immediately before actual delegation occurs** (prevents
   *   orphan pending spinners on management page if payload extraction fails or popup closes).
   * - Returns success status (caller determines whether pending was recorded).
   */
  async function dispatchBackgroundAiAnalysis(bookmarkId: number): Promise<boolean> {
    try {
      const autoSummarize = (await db.settings.get('ai_auto_summarize'))?.value === true;
      const autoTags = (await db.settings.get('ai_auto_tags'))?.value ?? (await db.settings.get('ai_auto_categorize'))?.value ?? true;
      const autoFolder = (await db.settings.get('ai_auto_folder'))?.value ?? (await db.settings.get('ai_auto_categorize'))?.value ?? true;
      // Skip delegation if no auto-analysis options are enabled
      if (!autoSummarize && !autoTags && !autoFolder) return false;
      // Skip delegation if AI provider/API key is not configured (no pending status -> no error badge/toast)
      if (!(await isAiConfigured())) return false;
      let payload = await extractPagePayload();
      if (!payload) {
        payload = {
          title: title || currentTab?.title || '',
          url: url || currentTab?.url || '',
          metaDescription: description || '',
          content: '',
          textContent: '',
          extractionType: 'basic',
          text: ''
        };
      }
      // Record pending only immediately before delegation — prevents orphan pending if subsequent exception occurs
      await BookmarkManager.updateBookmark(bookmarkId, { aiStatus: 'pending' });
      // Single combined AI request per bookmark (summary/tags/folder all at once) — single delegation to background
      await browser.runtime.sendMessage({
        type: 'AI_ANALYZE_BOOKMARK',
        bookmarkId,
        payload,
        folders,
        autoSummarize,
        autoTags,
        autoFolder
      });
      return true;
    } catch (e) {
      // Analysis delegation failure does not block saving (save is already complete)
      console.error('Failed to dispatch background AI analysis:', e);
      // If exception occurs after recording pending, restore to none to avoid orphan spinner
      try {
        await BookmarkManager.updateBookmark(bookmarkId, { aiStatus: 'none' });
      } catch {
        // Ignore restore failure
      }
      return false;
    }
  }

  // [t_645c7d9b] Check archive existence — parallel local + cloud check
  async function checkHasArchive(bookmarkId: number, syncId?: string): Promise<boolean> {
    try {
      const results = await Promise.all([
        (async () => {
          const count = await db.archivedPages.where('bookmarkId').equals(bookmarkId).count();
          return count > 0;
        })(),
        (async () => {
          try {
            let id = syncId;
            if (!id) {
              const b = await db.bookmarks.get(bookmarkId);
              id = b?.syncId;
            }
            if (!id) return false;
            const index = await getCloudArchiveIndexCache();
            // Cloud index entries do not have a 'status' field (ArchiveIndexEntry in archive-index.ts).
            // Archive exists = syncId matches + non-tombstone (deleted) entry (same semantics as management list).
            return index.some(e => e.syncId === id && !e.deleted);
          } catch { return false; }
        })()
      ]);
      return results[0] || results[1];
    } catch (error) {
      console.error('[Popup] hasArchive check failed:', error);
      return false;
    }
  }

  /**
   * Optimistic: mark as save in-progress immediately upon enqueue (= message delivery complete).
   * Progress continues outside popup (toolbar badge + status line polling).
   */
  function markArchiveInProgress() {
    archiveStatus = 'in_progress';
    archiveInSince = Date.now();
  }

  /**
   * 2-second polling of background pipeline state while popup is open (local Dexie — lightweight).
   * Archive: local archivedPages + cloud index cache.
   * AI: bookmarks.aiStatus.
   */
  function startStatusPolling() {
    stopStatusPolling();
    refreshPipelineStatus().catch(() => {});
    statusPollTimer = setInterval(() => {
      refreshPipelineStatus().catch(() => {});
    }, 2000);
  }

  function stopStatusPolling() {
    if (statusPollTimer !== null) {
      clearInterval(statusPollTimer);
      statusPollTimer = null;
    }
  }

  async function refreshPipelineStatus() {
    if (localBookmarkId === null) return;
    const archived = await checkHasArchive(localBookmarkId);
    if (archived) {
      hasArchive = true;
      archiveStatus = 'archived';
      archiveInSince = null;
    } else if (archiveStatus === 'in_progress') {
      // Maintain optimistic "saving…" until background pipeline actually registers (60s fallback)
      if (archiveInSince !== null && Date.now() - archiveInSince > 60_000) {
        archiveStatus = 'none';
        archiveInSince = null;
      }
    } else {
      archiveStatus = 'none';
    }

    try {
      const existing = await db.bookmarks.get(localBookmarkId);
      aiStatus = (existing?.aiStatus ?? 'none') as NonNullable<Bookmark['aiStatus']>;
    } catch {
      // DB not ready, etc. — retry on next poll
    }
  }

  function setSaveState(state: 'idle' | 'saving') {
    saveIndicator = state;
  }

  // Debounced autosave for edit mode (allowed continuously unless moving folder or saving — R5)
  $: if (isEditMode && localBookmarkId !== null) {
    if (title !== lastSavedTitle || description !== lastSavedDescription || folderId !== lastSavedFolderId) {
      const snapshot = { t: title, d: description, f: folderId };
      if (autosaveDebounceTimer) clearTimeout(autosaveDebounceTimer);
      autosaveDebounceTimer = setTimeout(() => {
        autoSaveEditBookmark(snapshot.t, snapshot.d, snapshot.f).then(ok => {
          if (!ok) {
            errorMessage = i18n.t('popup.error.autoSave');
          }
        });
      }, 500);
    } else if (autosaveDebounceTimer) {
      clearTimeout(autosaveDebounceTimer);
      autosaveDebounceTimer = null;
    }
  }

  /**
   * Edit mode autosave — only executes if the current values match the snapshot.
   * This prevents stale saves when the user has continued typing.
   */
  async function autoSaveEditBookmark(savedTitle: string, savedDescription: string, savedFolderId: string): Promise<boolean> {
    // Guard: skip if already in edit mode and values haven't changed since snapshot
    if (!isEditMode || localBookmarkId === null || isDeleting || successAction) return false;
    if (title !== savedTitle || description !== savedDescription || folderId !== savedFolderId) return false;
    if (isSaving) return false;

    isSaving = true;
    setSaveState('saving');
    try {
      const existing = await db.bookmarks.get(localBookmarkId);
      // Only update DB if description actually changed
      const dbChanged = existing && existing.description !== savedDescription;
      const titleChanged = existing && existing.title !== savedTitle;
      if (dbChanged || titleChanged) {
        await BookmarkManager.updateBookmark(localBookmarkId, {
          ...(titleChanged ? { title: savedTitle } : {}),
          ...(dbChanged ? { description: savedDescription } : {})
        });
        // Update in-memory copy too
        if (existing) {
          existing.title = savedTitle;
          existing.description = savedDescription;
        }
      }

      // Track last successful save to prevent re-triggering
      lastSavedTitle = savedTitle;
      lastSavedDescription = savedDescription;
      lastSavedFolderId = savedFolderId;

      // Move folder in browser API if folder changed
      if (folderId !== '' && existing?.bookmarkId) {
        try {
          const browserBookmark = await browser.bookmarks.get(existing.bookmarkId);
          if (browserBookmark && browserBookmark.parentId !== folderId) {
            await browser.bookmarks.move(existing.bookmarkId, { parentId: folderId });
          }
        } catch (e) {
          console.warn('[Popup] Browser bookmark move failed:', e);
        }
      }

      setSaveState('idle');
      return true;
    } catch (error) {
      console.error('[Popup] Autosave edit failed:', error);
      setSaveState('idle');
      return false;
    } finally {
      isSaving = false;
    }
  }

  async function handleViewArchive() {
    if (localBookmarkId === null || successAction) return;
    try {
      const viewerUrl = browser.runtime.getURL(`viewer.html?bookmarkId=${localBookmarkId}`);
      await browser.tabs.create({ url: viewerUrl, active: true });
      window.close();
    } catch (error) {
      console.error('[Popup] Archive viewing failed:', error);
      errorMessage = i18n.t('popup.error.viewArchiveFailed');
    }
  }

  async function handleDeleteBookmark() {
    if (localBookmarkId === null || isDeleting || successAction) return;
    if (autosaveDebounceTimer) {
      clearTimeout(autosaveDebounceTimer);
      autosaveDebounceTimer = null;
    }
    const bookmarkIdToDelete = localBookmarkId;
    const syncIdToDelete: string | undefined = duplicate?.syncId;
    isDeleting = true;
    errorMessage = null;

    try {
      // 0. Immediately abort ongoing AI analysis task
      try {
        if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
          browser.runtime.sendMessage({ type: 'AI_ABORT_BOOKMARK', bookmarkId: bookmarkIdToDelete }).catch(() => {});
        }
      } catch {}

      // 1. Delete DB + browser bookmark + archive via BookmarkManager.removeBookmark
      await BookmarkManager.removeBookmark(bookmarkIdToDelete, syncIdToDelete);

      // 2. Success — close popup
      triggerSuccess('delete');
    } catch (error: any) {
      console.error('[Popup] Delete failed:', error);
      errorMessage = i18n.t('popup.error.deleteFailed', { error: error.message || String(error) });
    } finally {
      isDeleting = false;
    }
  }

  async function handleManage() {
    const managementUrl = browser.runtime.getURL('management.html');
    await browser.tabs.create({ url: managementUrl });
    window.close();
  }

  /**
   * FAILED state [Save Again] — R2 fallback. Reuses existing auto-creation logic.
   */
  async function handleRetryAdd() {
    if (isAdding || successAction) return;
    errorMessage = null;
    await autoAddBookmark();
  }

  async function triggerSuccess(action?: 'archive' | 'delete') {
    if (action) {
      successAction = action;
    } else if (!successAction) {
      successAction = 'delete';
    }
    // Delay so popup does not close too quickly (800ms — v2: allow time to perceive stamp)
    setTimeout(() => {
      window.close();
    }, 800);
  }

  async function autoAddBookmark(): Promise<void> {
    if (successAction || isEditMode) return;
    try {
      const id = await doAddBookmark();
      if (id !== null && !errorMessage) {
        lastSavedTitle = title;
        lastSavedDescription = description;
        lastSavedFolderId = folderId;
        await initEntryPipeline(id);
      }
    } catch (error) {
      console.error('[Popup] Auto add bookmark failed:', error);
    }
  }

  /**
   * Initialize background pipeline state + start polling on entering REGISTERED.
   * (Shared between onMount duplicate path and autoAddBookmark path — idempotent)
   */
  async function initEntryPipeline(bookmarkId: number, syncId?: string) {
    isEditMode = true;
    if (localBookmarkId !== bookmarkId) localBookmarkId = bookmarkId;
    try {
      const archived = await checkHasArchive(bookmarkId, syncId);
      hasArchive = archived;
      archiveStatus = archived ? 'archived' : (archiveStatus === 'in_progress' ? 'in_progress' : 'none');
      const existing = await db.bookmarks.get(bookmarkId).catch(() => undefined);
      aiStatus = (existing?.aiStatus ?? 'none') as NonNullable<Bookmark['aiStatus']>;
    } catch (error) {
      console.error('[Popup] Failed to initialize pipeline status:', error);
    }
    startStatusPolling();
  }

  async function doAddBookmark(): Promise<number | null> {
    if (localBookmarkId !== null && isEditMode) return localBookmarkId; // Already in edit mode
    if (!currentTab?.id) return null;
    const effectiveUrl = url || currentTab.url;
    if (!effectiveUrl) {
      errorMessage = i18n.t('popup.error.noUrl');
      return null;
    }

    isAdding = true;
    errorMessage = null;
    try {
      // 1. Check for duplicates using shared BookmarkManager
      const existing = await BookmarkManager.findDuplicate(effectiveUrl);
      if (existing) {
        // Update last saved values to prevent autosave from triggering
        lastSavedTitle = title;
        lastSavedDescription = description;
        lastSavedFolderId = folderId;
        localBookmarkId = existing.id;
        isEditMode = true;
        await initEntryPipeline(existing.id, existing.syncId);
        return existing.id;
      }

      // 2. Create bookmark using shared BookmarkManager
      const savedFolderId = folderId || (folders.length > 0 ? folders[0].id : undefined);
      const bookmarkData = await BookmarkManager.createBookmark(
        effectiveUrl,
        title,
        savedFolderId,
        description || undefined
      );

      // 3. Store local ID for later deletion
      localBookmarkId = bookmarkData.id;
      isEditMode = true;

      // 3-1. If auto-analysis is enabled, delegate to background service worker (does not wait for saving).
      //      pending record/gate handled inside dispatchBackgroundAiAnalysis (recovers f23ec34 deletion incident)
      await dispatchBackgroundAiAnalysis(bookmarkData.id);

      // 4. If autoArchive is enabled, enqueue background pipeline immediately (optimistic)
      //    Capture/enqueue failure is not a reason to transition registration (bookmark creation) to FAILED (R5: non-blocking)
      try {
        const autoArchive = (await db.settings.get('auto_archive'))?.value === true;
        if (autoArchive && currentTab?.id) {
          const htmlResult = await extractTabHtml(currentTab.id).catch(() => ({ html: '', iframeSources: {} as Record<string, string> }));
          const htmlWithBanner = buildArchiveBannerHtml(htmlResult.html);
          const compress = (await db.settings.get('archive_compress'))?.value ?? true;
          const response = await browser.runtime.sendMessage({
            type: 'ARCHIVE_CAPTURE_BOOKMARK',
            bookmarkId: bookmarkData.id,
            bookmarkIdStr: String(bookmarkData.id),
            tabId: currentTab.id,
            pageTitle: title,
            pageUrl: effectiveUrl,
            title: title,
            url: effectiveUrl,
            aiEnabled: await isAiConfigured(),
            htmlSource: htmlWithBanner,
            html: htmlWithBanner,
            iframeSources: htmlResult.iframeSources,
            compress
          });
          if (response?.success === false || response?.ok === false) {
            throw new Error(response.error || i18n.t('popup.error.archiveStartFailed'));
          }
          markArchiveInProgress(); // Optimistic — reflect in status line immediately on enqueue success
        }
      } catch (e) {
        console.warn('[Popup] Failed to start background archive processing:', e);
        // Ignore - non-critical
      }

      return bookmarkData.id;
    } catch (error: any) {
      console.error('Failed to add bookmark:', error);
      errorMessage = i18n.t('popup.error.createFailed', { error: error.message || i18n.t('common.unknownError') });
      return null;
    } finally {
      isAdding = false;
    }
  }

  // Handle 'createFolder' event from BookmarkForm: refresh list and select after actual folder creation
  async function handleCreateFolder(e: CustomEvent<{ title: string; parentId?: string }>) {
    const { title: folderName, parentId } = e.detail;
    try {
      const created = await BookmarkManager.createFolder(folderName, parentId || undefined);
      const folderResult = await loadFoldersWithRetry();
      folders = folderResult.folders;
      folderId = created.id;
      errorMessage = null;
    } catch (error: any) {
      console.error('[Popup] Failed to create folder:', error);
      errorMessage = i18n.t('folders.createFailed', { error: error.message || i18n.t('common.unknownError') });
    }
  }

  async function handleArchiveHtml() {
    // v2: Registered item path only (new mode branch removed — R2)
    if (localBookmarkId === null || !currentTab?.id || isArchiving || successAction) return;

    isArchiving = true;
    errorMessage = null;

    try {
      // Capture HTML from tab and delegate to background service worker archive queue (R5: non-blocking)
      const htmlResult = await extractTabHtml(currentTab.id).catch(() => ({ html: '', iframeSources: {} as Record<string, string> }));
      const htmlWithBanner = buildArchiveBannerHtml(htmlResult.html);
      const compress = (await db.settings.get('archive_compress'))?.value ?? true;

      const message = {
        type: 'ARCHIVE_CAPTURE_BOOKMARK',
        bookmarkId: localBookmarkId,
        bookmarkIdStr: String(localBookmarkId),
        tabId: currentTab.id,
        pageTitle: title || currentTab.title || '',
        pageUrl: url || currentTab.url || '',
        title: title || currentTab.title || '',
        url: url || currentTab.url || '',
        aiEnabled: await isAiConfigured(),
        htmlSource: htmlWithBanner,
        html: htmlWithBanner,
        iframeSources: htmlResult.iframeSources,
        compress
      };

      const response = await browser.runtime.sendMessage(message);
      if (response?.success === false || response?.ok === false) {
        throw new Error(response.error || i18n.t('popup.error.archiveStartFailed'));
      }
      markArchiveInProgress(); // Optimistic — reflect in status line immediately on enqueue success (R5)
      triggerSuccess('archive');
    } catch (error: any) {
      console.error('[Popup] Archive failed:', error);
      errorMessage = i18n.t('popup.error.archiveSaveFailed', { error: error.message || i18n.t('common.unknownError') });
    } finally {
      isArchiving = false;
    }
  }
</script>

<div class="popup-wrapper">
  <div class="ribbon-bar" class:is-loading={!loaded} aria-hidden="true"></div>

  {#if loaded && errorMessage}
    <div class="error-banner" role="alert">
      <Icon name="alert-triangle" size={14} />
      <span>{errorMessage}</span>
    </div>
  {/if}

  <div class="content-body">
    {#if !loaded}
      <div class="loading-container">
        <span class="loading-text">{i18n.t('common.loading')}</span>
      </div>
    {:else if localBookmarkId === null}
      <!-- FAILED: Auto-save failed / no page info -> [Save Again] (R2 fallback) -->
      <div class="failed-state">
        <button
          type="button"
          class="btn btn-primary retry-btn"
          on:click={handleRetryAdd}
          disabled={isAdding || successAction !== null}
        >
          <Icon name="refresh-cw" size={14} />
          {i18n.t('common.retry')}
        </button>
      </div>
    {:else}
      <!-- REGISTERED: Registered item card -->
      <header class="header">
        <div class="logo">
          <Icon name="bookmark" size={16} />
          <span class="wordmark">{i18n.t('popup.wordmark')}</span>
        </div>
        <div class="header-right">
          <button class="close-btn" aria-label={i18n.t('common.close')} on:click={() => window.close()}>
            <Icon name="x" size={14} />
          </button>
        </div>
      </header>

      <BookmarkForm
        bind:title
        {url}
        bind:description
        bind:folderId
        {folders}
        saveState={saveIndicator}
        on:createFolder={handleCreateFolder}
      />

      <!-- Pipeline progress/error line — completed/idle states are not displayed (buttons/form already express them) -->
      {#if archiveStatus === 'in_progress' || aiStatus === 'pending' || aiStatus === 'running' || aiStatus === 'error'}
        <div class="pipeline-lines" aria-live="polite">
          {#if archiveStatus === 'in_progress'}
            <div class="pipeline-row">
              <span class="pipeline-label">{i18n.t('settings.tabs.archive')}</span>
              <span class="pipeline-value">
                <span class="spin"><Icon name="refresh-cw" size={11} /></span>
                {i18n.t('archive.saving')}
              </span>
            </div>
          {/if}
          {#if aiStatus === 'pending' || aiStatus === 'running'}
            <div class="pipeline-row">
              <span class="pipeline-label">{i18n.t('settings.tabs.ai')}</span>
              <span class="pipeline-value">
                <span class="spin"><Icon name="refresh-cw" size={11} /></span>
                {i18n.t('badge.aiAnalyzing')}
              </span>
            </div>
          {:else if aiStatus === 'error'}
            <div class="pipeline-row">
              <span class="pipeline-label">{i18n.t('settings.tabs.ai')}</span>
              <span class="pipeline-value is-error">
                <Icon name="alert-triangle" size={11} />
                {i18n.t('common.error')}
              </span>
            </div>
          {/if}
        </div>
      {/if}

      <ActionButtons
        {hasArchive}
        {isArchiving}
        {isDeleting}
        {successAction}
        on:archive={handleArchiveHtml}
        on:viewArchive={handleViewArchive}
        on:delete={handleDeleteBookmark}
      />

      <footer class="popup-footer">
        <button type="button" class="manage-link" on:click={handleManage}>{i18n.t('popup.manage')}</button>
      </footer>
    {/if}
  </div>
</div>

<style>
  /* Popup width: Chrome default 400px -> 430px (ensures body/form readability) */
  :global(body) {
    width: 430px;
  }

  .popup-wrapper {
    position: relative;
    min-height: 120px;
  }

  /* Signature: card top 3px hairline — left-to-right sweep during LOADING (1.2s loop) */
  .ribbon-bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 3px;
    background: var(--border-color);
    overflow: hidden;
    border-radius: 6px 6px 0 0;
  }
  .ribbon-bar::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 45%;
    background: linear-gradient(90deg, transparent, var(--color-primary), transparent);
    transform: translateX(-110%);
  }
  .ribbon-bar.is-loading::after {
    animation: ribbon-sweep 1.2s linear infinite;
  }
  @keyframes ribbon-sweep {
    to { transform: translateX(340%); }
  }

  /* LOADING: spinner removed — mono text only */
  .loading-container {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2.75rem 1rem;
  }
  .loading-text {
    font-family: var(--font-mono);
    font-size: var(--badge-font-size);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-secondary);
  }

  /* FAILED: slim error banner (top 2px danger line + reduced padding) */
  .error-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.75rem 1rem 0;
    padding: 0.5rem 0.75rem;
    background: color-mix(in srgb, var(--color-danger) 6%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-danger) 35%, transparent);
    border-top: 2px solid var(--color-danger);
    border-radius: var(--radius-sm);
    color: var(--color-danger);
    font-size: 0.8rem;
  }
  .error-banner :global(svg) { flex-shrink: 0; }

  .content-body {
    padding: 1rem;
  }

  /* REGISTERED header — slim (wordmark eyebrow + stamp + close) */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }
  .logo {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--text-secondary);
  }
  .wordmark {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-secondary);
  }
  .header-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .close-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.25rem;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    transition: color var(--transition-fast), background-color var(--transition-fast);
  }
  .close-btn:hover {
    color: var(--text-primary);
    background: var(--bg-tertiary);
  }

  /* FAILED: [Save Again] */
  .failed-state {
    display: flex;
    justify-content: center;
    padding: 1.25rem 0.5rem 0.75rem;
  }
  .retry-btn {
    width: 100%;
    max-width: 240px;
  }

  /* Background pipeline status line — mono, non-blocking */
  .pipeline-lines {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.25rem 0.75rem;
    align-items: center;
    margin: 0.25rem 0 0.625rem;
    padding: 0.375rem 0.5rem;
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
  }
  .pipeline-row {
    display: contents;
  }
  .pipeline-label {
    font-family: var(--font-mono);
    font-size: var(--badge-font-size);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .pipeline-value {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-family: var(--font-mono);
    font-size: var(--badge-font-size);
    color: var(--text-secondary);
  }
  .pipeline-value.is-error { color: var(--color-danger); }
  .pipeline-value .spin {
    display: inline-flex;
    animation: pipeline-spin 1s linear infinite;
  }
  @keyframes pipeline-spin { to { transform: rotate(360deg); } }

  /* Footer: [Management Page] button -> demoted to text link (R4) */
  .popup-footer {
    display: flex;
    justify-content: flex-end;
    margin-top: 0.5rem;
    padding-top: 0.375rem;
    border-top: 1px dashed var(--border-color);
  }
  .manage-link {
    font-family: var(--font-mono);
    font-size: var(--badge-font-size);
    letter-spacing: 0.06em;
    color: var(--text-secondary);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.25rem 0;
    transition: color var(--transition-fast);
  }
  .manage-link:hover {
    color: var(--color-primary);
  }
</style>
