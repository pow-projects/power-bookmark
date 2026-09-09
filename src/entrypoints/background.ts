import { BookmarkManager } from '../lib/bookmarks/bookmark-manager';
import { SyncEngine } from '../lib/sync/sync-engine';
import { updateActionBadge, setTaskIndicator } from '../lib/bookmarks/badge-manager';
import { recordVisit } from '../lib/stats/stats-tracker';
import db from '../lib/db';
import { decodeResponseHtml } from '../lib/archive/fetch-with-charset';
import { initAiQueue, enqueueAiJob, enqueueAiJobs, cancelBookmarkAi, cancelAllAi } from '../lib/ai/ai-queue';
import { seedDevSettings } from '../lib/dev-settings';
import {
  syncArchiveToCloudByBookmarkId,
  syncPendingArchives,
  restoreArchivesFromCloud,
  deleteArchiveFromCloud,
  refreshCloudArchiveIndex,
  downloadArchiveOnDemand,
  scanOrphanCloudArchives,
  deleteOrphanCloudArchives,
  fetchOrphanArchiveHtml
} from '../lib/archive/archive-cloud';
import { fetchResourceAsDataUri } from '../lib/archive/resource-fetcher';
import { enqueueArchiveJob } from '../lib/archive/archive-queue';

export default defineBackground(() => {
  console.log('PowerBookmark background service worker initializing...');

  // Shared entry point to open management page in new tab (no bookmark created)
  function openManagementPage() {
    browser.tabs.create({ url: browser.runtime.getURL('/management.html') });
  }

  // Dev-only default settings seed (populates empty items with local dev server values)
  // WXT: COMMAND === 'serve' only during `npm run dev` (wxt serve).
  if (import.meta.env.COMMAND === 'serve') {
    seedDevSettings().catch((e) => console.error('Failed to seed dev settings:', e));
  }

  // 1. Start listening to browser bookmark events (maintain local IndexedDB synchronization)
  BookmarkManager.listen();

  // 1-1. Initialize integrated AI analysis queue (restore running job + resume remaining queue on SW restart)
  initAiQueue().catch((e) => console.error('Failed to init AI queue:', e));

  // 2. Setup background 5-minute periodic cloud sync alarms
  SyncEngine.setupBackgroundAlarms();

  // Archive catch-up hook — sequentially upload unuploaded archives (F-4, EC-4) and refresh index cache
  const runArchiveCatchUp = async () => {
    try {
      await syncPendingArchives();
      await refreshCloudArchiveIndex();
    } catch (e: any) {
      console.warn('[archive-cloud] Archive catch-up scan skipped or failed:', e?.message || e);
    }
  };

  // 3. Trigger 5-second debounced cloud sync on bookmark modification
  // Guard: while a local batch operation mutes bookmark listeners (import loop, sync write-back),
  // do not fire syncs from these events — importing hundreds of items must not trigger a mid-import
  // cloud sync (its permanent tombstones would race the freshly re-registered rows).
  const triggerSync = () => {
    if (BookmarkManager.isSyncMuted) return;
    SyncEngine.triggerDebouncedSync();
  };

  browser.bookmarks.onCreated.addListener(triggerSync);
  browser.bookmarks.onRemoved.addListener(triggerSync);
  browser.bookmarks.onChanged.addListener(triggerSync);
  browser.bookmarks.onMoved.addListener(triggerSync);

  // 5. Real-time bookmark badge and icon title update integration
  browser.tabs.onActivated.addListener((activeInfo) => {
    updateActionBadge(activeInfo.tabId);
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const currentUrl = changeInfo.url || tab.url;
    if (changeInfo.status === 'complete' || changeInfo.url) {
      updateActionBadge(tabId, currentUrl);
    }
    if (tab.incognito) return;
    if (changeInfo.status === 'complete' && currentUrl && /^https?:\/\//i.test(currentUrl)) {
      db.bookmarks.where('url').equals(currentUrl).count().then((count) => {
        if (count > 0) {
          recordVisit(currentUrl).catch(() => {});
        }
      }).catch(() => {});
    }
  });

  const refreshActiveTabBadge = async () => {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      for (const tab of tabs) {
        if (tab.id) {
          await updateActionBadge(tab.id, tab.url);
        }
      }
    } catch (e) {
      console.error('Failed to refresh active tab badge:', e);
    }
  };

  browser.bookmarks.onCreated.addListener(() => {
    setTimeout(refreshActiveTabBadge, 50);
  });
  browser.bookmarks.onRemoved.addListener(() => {
    setTimeout(refreshActiveTabBadge, 50);
  });
  browser.bookmarks.onChanged.addListener(() => {
    setTimeout(refreshActiveTabBadge, 50);
  });

  // Refresh active tab badge on initial startup
  refreshActiveTabBadge();

  // 6. Run one-time full sync on install or update
  browser.runtime.onInstalled.addListener(async (details) => {
    try {
      // Firefox uses 'browser_action', Chrome MV3 uses 'action' context enum (different values)
      const actionContext = import.meta.env.FIREFOX ? 'browser_action' : 'action';
      browser.contextMenus.create({
        id: 'open-management',
        title: i18n.t('openManagement'),
        contexts: [actionContext]
      });
    } catch (e) {
      console.error('Failed to create context menu:', e);
    }
    console.log('Extension installed/updated. Running initial sync...', details.reason);
    try {
      const archiveCompressSetting = await db.settings.get('archive_compress');
      if (!archiveCompressSetting) {
        await db.settings.put({ key: 'archive_compress', value: true });
      }
      await BookmarkManager.syncAll();
      await SyncEngine.sync();
      await runArchiveCatchUp();
      await refreshActiveTabBadge();
    } catch (e) {
      console.error('Initial installation sync failed:', e);
    }
  });

  // Context menu (toolbar icon right-click) -> Open management page
  browser.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === 'open-management') {
      openManagementPage();
    }
  });

  // 7. cross-origin iframe HTML fetch relay (for single-file style archiving)
  // @ts-ignore
  browser.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    const message = msg as any;
    if (message?.type === 'FETCH_IFRAME' && message.url) {
      fetch(message.url, { credentials: 'include' })
        .then(async (r) => {
          if (!r.ok) return { html: '' };
          const html = await decodeResponseHtml(r);
          return { html };
        })
        .then((result) => sendResponse(result?.html ? result : { html: '' }))
        .catch(() => sendResponse({ html: '' }));
      return true; // async
    }
  });

  // 8. generic resource fetch relay (CSP bypass for archiving)
  // @ts-ignore
  browser.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    const message = msg as any;
    if (message?.type === 'FETCH_RESOURCE' && message.url) {
      fetchResourceAsDataUri(message.url, message.pageUrl)
        .then((dataUri) => sendResponse({ dataUri }))
        .catch(() => sendResponse({ dataUri: message.url }));
      return true; // async
    }
  });

  // 9. Integrated AI analysis queue — both entry points (management AI analysis / auto-apply on bookmark creation)
  //    push jobs to the same queue (enqueueAiJob/enqueueAiJobs), and the background worker (drain loop)
  //    processes them sequentially via FIFO. Cancellation is handled by cancelBookmarkAi (single) / cancelAllAi (bulk).
  // @ts-ignore
  browser.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    const message = msg as any;

    if (message?.type === 'TASK_INDICATOR' && message.taskType) {
      setTaskIndicator(message.taskType, !!message.active)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true; // async
    }

    if (message?.type === 'AI_ABORT_BOOKMARK' && message.bookmarkId) {
      // Abort ongoing analysis for bookmark (running is aborted, queued is cancelled)
      cancelBookmarkAi(message.bookmarkId).catch((e) =>
        console.error('AI bookmark cancel failed:', e));
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === 'AI_ANALYZE_BOOKMARK' && message.bookmarkId) {
      // Respond immediately to popup — avoid holding service worker. Analysis processed asynchronously in queue.
      sendResponse({ ok: true });
      enqueueAiJob({
        bookmarkId: message.bookmarkId,
        kind: 'auto',
        payload: message.payload || {},
        folders: message.folders || [],
        options: {
          autoSummarize: message.autoSummarize,
          autoTags: message.autoTags,
          autoFolder: message.autoFolder
        }
      }).catch((e) => console.error('AI analysis enqueue failed:', e));
      return false;
    }

    if (message?.type === 'AI_ABORT_BULK') {
      // Cancel all bulk AI (categorize/summarize) — revert in-progress bookmarks to aiStatus=none
      cancelAllAi().catch((e) => console.error('AI bulk cancel failed:', e));
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === 'AI_BULK_CATEGORIZE' && Array.isArray(message.bookmarkIds)) {
      sendResponse({ ok: true });
      enqueueAiJobs(
        (message.bookmarkIds as number[]).map((id) => ({
          bookmarkId: id,
          kind: 'categorize',
          folders: message.folders
        }))
      ).catch((e) => console.error('AI bulk categorize enqueue failed:', e));
      return false;
    }

    if (message?.type === 'AI_BULK_SUMMARIZE' && Array.isArray(message.bookmarkIds)) {
      sendResponse({ ok: true });
      enqueueAiJobs(
        (message.bookmarkIds as number[]).map((id) => ({ bookmarkId: id, kind: 'summarize' }))
      ).catch((e) => console.error('AI bulk summarize enqueue failed:', e));
      return false;
    }

    if (message?.type === 'ARCHIVE_CAPTURE_BOOKMARK' && message.bookmarkId) {
      sendResponse({ ok: true });
      enqueueArchiveJob({
        bookmarkId: message.bookmarkId,
        htmlSource: message.htmlSource || message.html,
        pageUrl: message.pageUrl || message.url,
        pageTitle: message.pageTitle || message.title,
        summary: message.summary,
        iframeSources: message.iframeSources,
        compress: message.compress
      }).catch((e) => console.error('Archive capture enqueue failed:', e));
      return false;
    }

    if (message?.type === 'ARCHIVE_UPLOAD' && typeof message.bookmarkId === 'number') {
      // Fire-and-forget right after management page archiveBookmark — delegate cloud upload
      sendResponse({ ok: true });
      syncArchiveToCloudByBookmarkId(message.bookmarkId)
        .catch((e) => console.error('Archive cloud upload job failed:', e));
      return false;
    }

    if (message?.type === 'ARCHIVE_DELETE' && message.syncId) {
      deleteArchiveFromCloud(message.syncId, message.url)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => {
          console.error('Archive cloud delete propagation failed:', e);
          sendResponse({ ok: false, error: String(e?.message || e) });
        });
      return true;
    }

    if (message?.type === 'SET_SYNC_MUTED') {
      BookmarkManager.setSyncMuted(!!message.muted);
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === 'ARCHIVE_RESTORE') {
      // Wait and return result for restore request (SyncSettings restore button)
      restoreArchivesFromCloud()
        .then((result) => sendResponse({ ok: true, restored: result.restored, orphans: result.orphans.length }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true; // async
    }

    if (message?.type === 'ARCHIVE_DOWNLOAD_ON_DEMAND') {
      const target = message.syncId || message.url;
      if (!target) {
        sendResponse({ ok: false, error: 'Missing syncId or url' });
        return false;
      }
      downloadArchiveOnDemand(target)
        .then((page) => {
          if (!page) {
            sendResponse({ ok: false, error: 'Archive not found' });
            return;
          }
          sendResponse({
            ok: true,
            page: {
              id: page.id,
              bookmarkId: page.bookmarkId,
              url: page.url,
              fileSize: page.fileSize,
              archivedAt: page.archivedAt
            }
          });
        })
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true; // async
    }

    if (message?.type === 'ARCHIVE_INDEX_REFRESH') {
      refreshCloudArchiveIndex()
        .then((entries) => sendResponse({ ok: true, entries }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true; // async
    }

    if (message?.type === 'ARCHIVE_ORPHAN_SCAN') {
      scanOrphanCloudArchives({ force: !!message.force })
        .then((orphans) => sendResponse({ ok: true, orphans }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true; // async
    }

    if (message?.type === 'ARCHIVE_ORPHAN_DELETE' && Array.isArray(message.syncIds)) {
      deleteOrphanCloudArchives(message.syncIds)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true; // async
    }

    if (message?.type === 'ARCHIVE_ORPHAN_FETCH_HTML' && message.syncId) {
      fetchOrphanArchiveHtml(message.syncId)
        .then((html) => sendResponse({ ok: true, html }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true; // async
    }

    if (message?.type === 'PB_CAPTURE_VISIBLE_TAB') {
      browser.tabs.captureVisibleTab({ format: 'png' })
        .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true; // async
    }
  });

  console.log('PowerBookmark background initialization complete.');
});
