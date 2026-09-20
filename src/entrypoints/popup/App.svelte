<script lang="ts">
  /**
   * PowerBookmark Popup — Modern Options & Direct Archive Card
   *
   * Displays:
   *   - Header: Wordmark & close button
   *   - Options Card: Cloud Sync status badge + AI automation toggles (Summarize, Tags, Folder) with hover tooltips
   *   - Unregistered: Single prominent [Save Archive] button (creates bookmark + AI + archive in background with toolbar spinner)
   *   - Registered: Pipeline status (when active) + [View/Save Archive] & [Delete] buttons
   *   - Footer: [Open Management]
   */
  import { onMount, onDestroy } from 'svelte';
  import type { Bookmark } from '../../lib/db';
  import { BookmarkManager } from '../../lib/bookmarks/bookmark-manager';
  import { isAiConfigured, getAiSettings } from '../../lib/ai/ai-summarizer';
  import type { ExtractedPagePayload, FolderInfo } from '../../lib/ai/types';
  import { buildArchiveBannerHtml } from '../../lib/archive/archive-viewer';
  import { getCloudArchiveIndexCache } from '../../lib/archive/archive-cloud';
  import { getArchiveCaptureState, STALE_MS } from '../../lib/archive/archive-capture-state';
  import db from '../../lib/db';
  import PopupOptionsCard from '../../components/popup/PopupOptionsCard.svelte';
  import ActionButtons from '../../components/popup/ActionButtons.svelte';
  import Icon from '../../components/shared/Icon.svelte';
  import { formatApproximateAiError } from '../../lib/ai/ai-error-formatter';
  import { initSyncStatusStore, syncStatus } from '../../lib/sync/sync-status-store';

  // Tab data
  let currentTab: chrome.tabs.Tab | null = null;
  let title = '';
  let url = '';
  let folders: FolderInfo[] = [];
  let hasArchive = false;
  let loaded = false;
  let isEditMode = false;
  let localBookmarkId: number | null = null;

  // AI automation options & status
  let aiProvider: string = 'none';
  let autoSummarize: boolean = false;
  let autoTags: boolean = true;
  let autoFolder: boolean = true;
  let aiConfigured: boolean = false;
  let unsubscribeSync: (() => void) | null = null;

  // State flags
  let isAdding = false;
  let isArchiving = false;
  let isDeleting = false;
  let successAction: 'archive' | 'delete' | null = null;
  let errorMessage: string | null = null;

  // Pipeline status
  let archiveStatus: 'none' | 'in_progress' | 'archived' = 'none';
  let aiStatus: NonNullable<Bookmark['aiStatus']> = 'none';
  let aiAttempts: number | undefined = undefined;
  let aiError: string | undefined = undefined;
  let archiveInSince: number | null = null;

  // Duplicate detection result
  let duplicate: Bookmark | null = null;

  // Polling & listeners
  let statusPollTimer: ReturnType<typeof setInterval> | null = null;
  let storageListener: ((changes: Record<string, any>, areaName: string) => void) | null = null;

  onMount(async () => {
    try {
      unsubscribeSync = initSyncStatusStore();

      // Load AI settings and configuration status
      try {
        const aiSettings = await getAiSettings();
        aiProvider = aiSettings.provider || 'none';
        autoSummarize = aiSettings.autoSummarize;
        autoTags = aiSettings.autoTags;
        autoFolder = aiSettings.autoFolder;
        aiConfigured = await isAiConfigured();
      } catch (e) {
        console.warn('[Popup] Failed to load AI settings:', e);
      }

      currentTab = await getActiveTab();
      if (!currentTab) return;

      url = currentTab.url || '';
      title = currentTab.title || url;

      if (url) {
        duplicate = await BookmarkManager.findDuplicate(url);
      }

      if (duplicate) {
        isEditMode = true;
        localBookmarkId = duplicate.id;
        title = duplicate.title || currentTab.title || '';
        url = duplicate.url || currentTab.url || '';
      }

      const folderResult = await loadFoldersWithRetry();
      folders = folderResult.folders;
      if (!folderResult.success) {
        errorMessage = i18n.t('popup.error.foldersLoadFailed');
      }
    } catch (error) {
      console.error('Popup onMount error:', error);
      errorMessage = i18n.t('popup.error.pageLoadFailed');
    } finally {
      loaded = true;
    }

    // Initialize pipeline state for registered item + polling
    if (localBookmarkId !== null) {
      if (!isEditMode) isEditMode = true;
      try {
        const archived = await checkHasArchive(localBookmarkId, duplicate?.syncId);
        hasArchive = archived;
        const captureState = await getArchiveCaptureState();
        const isCapturing = captureState?.bookmarkId === localBookmarkId && (Date.now() - captureState.startedAt < STALE_MS);
        if (archived) {
          archiveStatus = 'archived';
        } else if (isCapturing || archiveStatus === 'in_progress') {
          archiveStatus = 'in_progress';
          archiveInSince = captureState?.startedAt ?? Date.now();
        } else {
          archiveStatus = 'none';
        }
        const existing = await db.bookmarks.get(localBookmarkId).catch(() => undefined);
        aiStatus = (existing?.aiStatus ?? 'none') as NonNullable<Bookmark['aiStatus']>;
        aiAttempts = existing?.aiAttempts;
        aiError = existing?.aiError;
      } catch (error) {
        console.error('[Popup] Failed to initialize pipeline status:', error);
      }
      startStatusPolling();

      if (typeof browser !== 'undefined' && browser.storage?.onChanged) {
        storageListener = (changes, area) => {
          if (area === 'local') {
            if (changes['archive_capture_error']?.newValue?.bookmarkId === localBookmarkId) {
              errorMessage = i18n.t('popup.error.archiveSaveFailed', {
                error: changes['archive_capture_error'].newValue.error || i18n.t('common.unknownError')
              });
            }
            if (
              changes['ai_analysis_last_update'] ||
              changes['ai_analysis_error'] ||
              changes['archive_capture_state'] ||
              changes['archive_capture_last_update'] ||
              changes['archive_capture_error']
            ) {
              void pollStatus();
            }
          }
        };
        try {
          browser.storage.onChanged.addListener(storageListener);
        } catch { /* ignore */ }
      }

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
    if (unsubscribeSync) {
      unsubscribeSync();
      unsubscribeSync = null;
    }
    if (storageListener && typeof browser !== 'undefined' && browser.storage?.onChanged) {
      try {
        browser.storage.onChanged.removeListener(storageListener);
      } catch { /* ignore */ }
      storageListener = null;
    }
  });

  async function handleToggleSummarize(checked: boolean) {
    autoSummarize = checked;
    await db.settings.put({ key: 'ai_auto_summarize', value: checked });
  }

  async function handleToggleTags(checked: boolean) {
    autoTags = checked;
    await db.settings.put({ key: 'ai_auto_tags', value: checked });
  }

  async function handleToggleFolder(checked: boolean) {
    autoFolder = checked;
    await db.settings.put({ key: 'ai_auto_folder', value: checked });
  }

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

  async function dispatchBackgroundAiAnalysis(bookmarkId: number): Promise<boolean> {
    try {
      if (!autoSummarize && !autoTags && !autoFolder) return false;
      if (!aiConfigured) return false;
      let payload = await extractPagePayload();
      if (!payload) {
        payload = {
          title: title || currentTab?.title || '',
          url: url || currentTab?.url || '',
          metaDescription: '',
          content: '',
          textContent: '',
          extractionType: 'basic',
          text: ''
        };
      }
      await BookmarkManager.updateBookmark(bookmarkId, { aiStatus: 'pending' });
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
      console.error('Failed to dispatch background AI analysis:', e);
      try {
        await BookmarkManager.updateBookmark(bookmarkId, { aiStatus: 'none' });
      } catch {}
      return false;
    }
  }

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

  function markArchiveInProgress() {
    archiveStatus = 'in_progress';
    archiveInSince = Date.now();
  }

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

  async function pollStatus() {
    await refreshPipelineStatus();
  }

  async function refreshPipelineStatus() {
    if (localBookmarkId === null) return;
    const archived = await checkHasArchive(localBookmarkId);
    if (archived) {
      hasArchive = true;
      archiveStatus = 'archived';
      archiveInSince = null;
    } else {
      const captureState = await getArchiveCaptureState();
      const isCapturing = captureState?.bookmarkId === localBookmarkId && (Date.now() - captureState.startedAt < STALE_MS);
      if (isCapturing) {
        archiveStatus = 'in_progress';
        archiveInSince = captureState.startedAt;
      } else if (archiveStatus === 'in_progress') {
        if (archiveInSince !== null && Date.now() - archiveInSince > 60_000) {
          archiveStatus = 'none';
          archiveInSince = null;
        }
      } else {
        archiveStatus = 'none';
      }
    }

    try {
      const existing = await db.bookmarks.get(localBookmarkId);
      aiStatus = (existing?.aiStatus ?? 'none') as NonNullable<Bookmark['aiStatus']>;
      aiAttempts = existing?.aiAttempts;
      aiError = existing?.aiError;
    } catch {}
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
    const bookmarkIdToDelete = localBookmarkId;
    const syncIdToDelete: string | undefined = duplicate?.syncId;
    isDeleting = true;
    errorMessage = null;

    try {
      try {
        if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
          browser.runtime.sendMessage({ type: 'AI_ABORT_BOOKMARK', bookmarkId: bookmarkIdToDelete }).catch(() => {});
        }
      } catch {}

      await BookmarkManager.removeBookmark(bookmarkIdToDelete, syncIdToDelete);
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

  async function handleOpenAiSettings() {
    const aiSettingsUrl = browser.runtime.getURL('management.html?tab=settings&section=ai');
    await browser.tabs.create({ url: aiSettingsUrl });
    window.close();
  }

  async function handleOpenSyncSettings() {
    const syncSettingsUrl = browser.runtime.getURL('management.html?tab=settings&section=sync');
    await browser.tabs.create({ url: syncSettingsUrl });
    window.close();
  }

  async function triggerSuccess(action: 'archive' | 'delete') {
    successAction = action;
    setTimeout(() => {
      window.close();
    }, 800);
  }

  async function handleSaveAndArchive() {
    if (isAdding || isArchiving || archiveStatus === 'in_progress' || successAction !== null) return;
    errorMessage = null;
    isArchiving = true;
    try {
      const id = await doAddBookmark(true);
      if (id !== null && !errorMessage) {
        await triggerSuccess('archive');
      }
    } catch (error: any) {
      console.error('[Popup] Save and archive failed:', error);
      errorMessage = i18n.t('popup.error.archiveSaveFailed', { error: error.message || i18n.t('common.unknownError') });
    } finally {
      isArchiving = false;
    }
  }

  async function initEntryPipeline(bookmarkId: number, syncId?: string) {
    isEditMode = true;
    if (localBookmarkId !== bookmarkId) localBookmarkId = bookmarkId;
    try {
      const archived = await checkHasArchive(bookmarkId, syncId);
      hasArchive = archived;
      const captureState = await getArchiveCaptureState();
      const isCapturing = captureState?.bookmarkId === bookmarkId && (Date.now() - captureState.startedAt < STALE_MS);
      if (archived) {
        archiveStatus = 'archived';
      } else if (isCapturing || archiveStatus === 'in_progress') {
        archiveStatus = 'in_progress';
        archiveInSince = captureState?.startedAt ?? Date.now();
      } else {
        archiveStatus = 'none';
      }
      const existing = await db.bookmarks.get(bookmarkId).catch(() => undefined);
      aiStatus = (existing?.aiStatus ?? 'none') as NonNullable<Bookmark['aiStatus']>;
    } catch (error) {
      console.error('[Popup] Failed to initialize pipeline status:', error);
    }
    startStatusPolling();
  }

  async function doAddBookmark(forceArchive: boolean = true): Promise<number | null> {
    if (localBookmarkId !== null && isEditMode) return localBookmarkId;
    if (!currentTab?.id) return null;
    const effectiveUrl = url || currentTab.url;
    if (!effectiveUrl) {
      errorMessage = i18n.t('popup.error.noUrl');
      return null;
    }

    isAdding = true;
    errorMessage = null;
    try {
      const existing = await BookmarkManager.findDuplicate(effectiveUrl);
      if (existing) {
        localBookmarkId = existing.id;
        isEditMode = true;
        await initEntryPipeline(existing.id, existing.syncId);
        return existing.id;
      }

      const defaultFolderId = folders.length > 0 ? folders[0].id : undefined;
      const bookmarkData = await BookmarkManager.createBookmark(
        effectiveUrl,
        title || effectiveUrl,
        defaultFolderId
      );

      localBookmarkId = bookmarkData.id;
      isEditMode = true;

      await dispatchBackgroundAiAnalysis(bookmarkData.id);

      try {
        if (currentTab?.id) {
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
          markArchiveInProgress();
        }
      } catch (e: any) {
        if (forceArchive) {
          errorMessage = i18n.t('popup.error.archiveSaveFailed', { error: e.message || i18n.t('common.unknownError') });
          return bookmarkData.id;
        }
        console.warn('[Popup] Failed to start background archive processing:', e);
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

  async function handleArchiveHtml() {
    if (localBookmarkId === null || !currentTab?.id || isArchiving || archiveStatus === 'in_progress' || successAction) return;

    isArchiving = true;
    errorMessage = null;

    try {
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
      markArchiveInProgress();
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
    {:else if !currentTab}
      <!-- No page info -->
      <div class="failed-state">
        <p class="empty-hint">{i18n.t('popup.error.noPage')}</p>
      </div>
      <footer class="popup-footer">
        <button type="button" class="btn btn-secondary btn-manage" on:click={handleManage}>
          <Icon name="layout" size={14} />
          <span>{i18n.t('openManagement')}</span>
        </button>
      </footer>
    {:else}
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

      <PopupOptionsCard
        syncState={$syncStatus}
        {aiProvider}
        {autoSummarize}
        {autoTags}
        {autoFolder}
        {aiConfigured}
        onToggleSummarize={handleToggleSummarize}
        onToggleTags={handleToggleTags}
        onToggleFolder={handleToggleFolder}
        onOpenAiSettings={handleOpenAiSettings}
        onOpenSyncSettings={handleOpenSyncSettings}
      />

      {#if isEditMode && successAction !== 'archive'}
        <!-- REGISTERED: Pipeline progress/error line -->
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
                <span class="pipeline-value" title={aiAttempts && aiAttempts > 0 ? i18n.t('ai.retryingAttempt', { current: aiAttempts, max: 3 }) : undefined}>
                  <span class="spin"><Icon name="refresh-cw" size={11} /></span>
                  {i18n.t('badge.aiAnalyzing')}{aiAttempts && aiAttempts > 0 ? ` (${aiAttempts}/3)` : ''}
                </span>
              </div>
            {:else if aiStatus === 'error'}
              {@const approx = aiError ? formatApproximateAiError(aiError) : ''}
              <div class="pipeline-row">
                <span class="pipeline-label">{i18n.t('settings.tabs.ai')}</span>
                <span class="pipeline-value is-error" title={aiError ? `${i18n.t('ai.analysisFailed')}: ${aiError}` : undefined}>
                  <Icon name="alert-triangle" size={11} />
                  {approx || i18n.t('common.error')}
                </span>
              </div>
            {/if}
          </div>
        {/if}

        <ActionButtons
          {hasArchive}
          isArchiving={isArchiving || archiveStatus === 'in_progress'}
          {isDeleting}
          {successAction}
          on:archive={handleArchiveHtml}
          on:viewArchive={handleViewArchive}
          on:delete={handleDeleteBookmark}
        />
      {:else}
        <!-- UNREGISTERED: Single "Save Archive" Button -->
        <div class="actions-row new-bookmark-actions">
          <button
            type="button"
            class="btn btn-primary btn-save-and-archive btn-archive-bookmark"
            disabled={isAdding || isArchiving || archiveStatus === 'in_progress' || successAction !== null || !url}
            on:click={handleSaveAndArchive}
          >
            {#if successAction === 'archive'}
              <Icon name="check" size={16} />
              <span>{i18n.t('popup.saved')}</span>
            {:else if isArchiving || isAdding || archiveStatus === 'in_progress'}
              <span class="spin"><Icon name="refresh-cw" size={14} /></span>
              <span>{i18n.t('popup.saving')}</span>
            {:else}
              <Icon name="archive" size={16} />
              <span>{i18n.t('popup.actions.saveArchive')}</span>
            {/if}
          </button>
        </div>
      {/if}

      <footer class="popup-footer">
        <button type="button" class="btn btn-secondary btn-manage" on:click={handleManage}>
          <Icon name="layout" size={14} />
          <span>{i18n.t('openManagement')}</span>
        </button>
      </footer>
    {/if}
  </div>
</div>

<style>
  :global(body) {
    width: 430px;
  }

  .popup-wrapper {
    position: relative;
    min-height: 120px;
  }

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

  .failed-state {
    display: flex;
    justify-content: center;
    padding: 1.25rem 0.5rem 0.75rem;
  }

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

  .actions-row {
    display: flex;
    flex-direction: row;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }
  .new-bookmark-actions .btn-save-and-archive {
    width: 100%;
    min-height: 38px;
    font-size: 0.875rem;
    font-weight: 600;
    justify-content: center;
    gap: 0.375rem;
  }

  .popup-footer {
    display: flex;
    margin-top: 0.625rem;
    padding-top: 0.625rem;
    border-top: 1px dashed var(--border-color);
  }
  .btn-manage {
    width: 100%;
    min-height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.45rem 1rem;
    font-size: 0.8125rem;
    font-family: var(--font-primary);
    font-weight: 500;
    color: var(--text-secondary);
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .btn-manage:hover {
    background: var(--bg-tertiary);
    border-color: var(--color-primary);
    color: var(--color-primary);
    transform: translateY(-1px);
  }
</style>
