import { BookmarkManager } from '../lib/bookmarks/bookmark-manager';
import { SyncEngine } from '../lib/sync/sync-engine';
import { updateActionBadge, setTaskIndicator, resetTaskIndicator } from '../lib/bookmarks/badge-manager';
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
import { removeTombstone } from '../lib/sync/tombstones';
import { generateDeterministicSyncId } from '../lib/bookmarks/url-normalizer';
import { sanitizeTags } from '../lib/bookmarks/tag-utils';

/**
 * These header rewrites exist for embedded video players, which the archive viewer loads as
 * <iframe> (resourceType sub_frame) and media/xhr resources. Scoped strictly to the extension's
 * own origin via initiatorDomains to prevent rewriting third-party page requests.
 */
async function setupVideoEmbedHeaderRules(): Promise<void> {
  try {
    const dnr = (typeof browser !== 'undefined' && (browser as any).declarativeNetRequest)
      ? (browser as any).declarativeNetRequest
      : (typeof chrome !== 'undefined' ? chrome.declarativeNetRequest : null);
    if (dnr?.updateDynamicRules) {
      const initiatorDomain = (typeof chrome !== 'undefined' && chrome.runtime?.id)
        ? chrome.runtime.id
        : (typeof browser !== 'undefined' && (browser as any)?.runtime?.id ? (browser as any).runtime.id : '');
      await dnr.updateDynamicRules({
        removeRuleIds: [9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008],
        addRules: [
          {
            id: 9001,
            priority: 1,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [
                { header: 'Referer', operation: 'set', value: 'https://www.google.com/' }
              ]
            },
            condition: {
              urlFilter: '||youtube.com/',
              initiatorDomains: [initiatorDomain],
              resourceTypes: ['sub_frame', 'xmlhttprequest', 'media']
            }
          },
          {
            id: 9002,
            priority: 1,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [
                { header: 'Referer', operation: 'set', value: 'https://www.google.com/' }
              ]
            },
            condition: {
              urlFilter: '||youtube-nocookie.com/',
              initiatorDomains: [initiatorDomain],
              resourceTypes: ['sub_frame', 'xmlhttprequest', 'media']
            }
          },
          {
            id: 9003,
            priority: 1,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [
                { header: 'Referer', operation: 'set', value: 'https://vimeo.com/' }
              ]
            },
            condition: {
              urlFilter: '||vimeo.com/',
              initiatorDomains: [initiatorDomain],
              resourceTypes: ['sub_frame', 'xmlhttprequest', 'media']
            }
          },
          {
            id: 9004,
            priority: 1,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [
                { header: 'Referer', operation: 'set', value: 'https://www.dailymotion.com/' }
              ]
            },
            condition: {
              urlFilter: '||dailymotion.com/',
              initiatorDomains: [initiatorDomain],
              resourceTypes: ['sub_frame', 'xmlhttprequest', 'media']
            }
          },
          {
            id: 9005,
            priority: 1,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [
                { header: 'Referer', operation: 'set', value: 'https://www.tiktok.com/' }
              ]
            },
            condition: {
              urlFilter: '||tiktok.com/',
              initiatorDomains: [initiatorDomain],
              resourceTypes: ['sub_frame', 'xmlhttprequest', 'media']
            }
          },
          {
            id: 9006,
            priority: 1,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [
                { header: 'Referer', operation: 'set', value: 'https://tv.naver.com/' }
              ]
            },
            condition: {
              urlFilter: '||naver.com/',
              initiatorDomains: [initiatorDomain],
              resourceTypes: ['sub_frame', 'xmlhttprequest', 'media']
            }
          },
          {
            id: 9007,
            priority: 1,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [
                { header: 'Referer', operation: 'set', value: 'https://tv.kakao.com/' }
              ]
            },
            condition: {
              urlFilter: '||kakao.com/',
              initiatorDomains: [initiatorDomain],
              resourceTypes: ['sub_frame', 'xmlhttprequest', 'media']
            }
          },
          {
            id: 9008,
            priority: 1,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [
                { header: 'Referer', operation: 'set', value: 'https://tv.kakao.com/' }
              ]
            },
            condition: {
              urlFilter: '||daum.net/',
              initiatorDomains: [initiatorDomain],
              resourceTypes: ['sub_frame', 'xmlhttprequest', 'media']
            }
          }
        ] as any
      });
    }
  } catch (e) {
    console.warn('[DNR] Failed to register video embed header rules:', e);
  }
}

/**
 * Validates whether an incoming IPC message originates from a trusted internal
 * extension context (popup, options/management page, background worker, or offscreen document).
 */
export function isInternalExtensionSender(sender: any): boolean {
  if (import.meta.env.MODE === 'test' && (!sender || (!sender.id && !sender.url && !sender.tab?.url))) {
    return true; // Compatibility with Vitest mock sendMessage(msg, {})
  }
  if (sender?.id && sender.id !== browser.runtime?.id) {
    return false;
  }
  const extUrl = browser.runtime?.getURL ? browser.runtime.getURL('') : '';
  if (sender?.url && extUrl && !sender.url.startsWith(extUrl)) {
    return false;
  }
  // Messages from popups, offscreen, background have no sender.tab
  if (!sender?.tab) {
    return true;
  }
  // Messages from extension tabs (Management SPA, Viewer SPA) have sender.tab with extension URL
  return Boolean(extUrl && (sender.url?.startsWith(extUrl) || sender.tab?.url?.startsWith(extUrl)));
}

/**
 * Validates whether the sender is authorized to create/register incognito bookmarks.
 * If sender.tab exists, it must either be an extension page or an incognito tab.
 */
export function isAuthorizedIncognitoSender(sender: any): boolean {
  if (!sender?.tab) {
    return true;
  }
  const extUrl = browser.runtime?.getURL ? browser.runtime.getURL('') : '';
  const isExtTab = Boolean(extUrl && (sender.url?.startsWith(extUrl) || sender.tab?.url?.startsWith(extUrl)));
  return isExtTab || Boolean(sender.tab.incognito);
}

const PRIVILEGED_MESSAGE_TYPES = new Set([
  'TASK_INDICATOR',
  'AI_ABORT_BOOKMARK',
  'AI_ABORT_BULK',
  'AI_ANALYZE_BOOKMARK',
  'AI_ANALYZE_BULK',
  'AI_BULK_PROCESS',
  'AI_BULK_CATEGORIZE',
  'AI_BULK_SUMMARIZE',
  'ARCHIVE_CAPTURE_BOOKMARK',
  'ARCHIVE_INDEX_REFRESH',
  'ARCHIVE_UPLOAD',
  'ARCHIVE_DELETE',
  'ARCHIVE_ORPHAN_SCAN',
  'ARCHIVE_ORPHAN_DELETE',
  'ARCHIVE_ORPHAN_FETCH_HTML',
  'ARCHIVE_RESTORE',
  'ARCHIVE_DOWNLOAD_ON_DEMAND',
  'CHECK_DUPLICATE_BOOKMARK',
  'GET_TAG_SUGGESTIONS',
  'CREATE_INCOGNITO_BOOKMARK',
  'REGISTER_INCOGNITO_BOOKMARK',
  'PB_CAPTURE_VISIBLE_TAB',
  'SET_SYNC_MUTED',
  'BOOKMARKS_UPDATED',
  'MARK_EXTENSION_BOOKMARK',
  'SYNC_RESOLVED'
]);

export default defineBackground(() => {
  console.log('PowerBookmark background service worker initializing...');

  // Shared entry point to open management page in new tab (no bookmark created)
  function openManagementPage() {
    browser.tabs.create({ url: browser.runtime.getURL('/management.html') });
  }

  // Dev-only default settings seed (populates empty items with local dev server values)
  // WXT: COMMAND === 'serve' only during `npm run dev` (wxt serve).
  let devSeedPromise: Promise<void> | null = null;
  if (import.meta.env.COMMAND === 'serve') {
    devSeedPromise = seedDevSettings().catch((e) => console.error('Failed to seed dev settings:', e));
  }

  // 1. Start listening to browser bookmark events (maintain local IndexedDB synchronization)
  BookmarkManager.listen();

  // 1-0. Setup declarativeNetRequest rules to provide valid Referer headers for embedded video players
  setupVideoEmbedHeaderRules().catch((e) => console.warn('[background] DNR rule setup warning:', e));

  // 1-1. Restore toolbar task indicator before starting AI queue to ensure stale spinner states are cleared first
  (async () => {
    try {
      await resetTaskIndicator();
    } catch (e) {
      console.warn('[background] Task indicator reset warning:', e);
    }
    try {
      await initAiQueue();
    } catch (e) {
      console.error('Failed to init AI queue:', e);
    }
  })();

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

  // Browser session startup sync: runs once when browser opens/starts (guarded by session storage across SW lifecycles)
  let inMemorySessionSynced = false;
  const runStartupSync = async (source: string = 'session-init') => {
    try {
      if (devSeedPromise) {
        await devSeedPromise;
      }
      if (typeof browser !== 'undefined' && (browser.storage as any)?.session) {
        const sessionData = await (browser.storage as any).session.get('startup_sync_completed').catch(() => null);
        if (sessionData?.startup_sync_completed) {
          return;
        }
        await (browser.storage as any).session.set({ startup_sync_completed: true }).catch(() => {});
      } else {
        if (inMemorySessionSynced && source !== 'onStartup') return;
        inMemorySessionSynced = true;
      }
      console.log(`Running startup sync (${source})...`);
      await BookmarkManager.syncAll();
      await SyncEngine.sync();
      await runArchiveCatchUp();
      await refreshActiveTabBadge();
    } catch (e) {
      console.error(`Startup sync failed (${source}):`, e);
    }
  };

  // Trigger startup sync on worker launch for a new browser session
  runStartupSync('session-init');

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
  browser.tabs.onActivated.addListener(async (activeInfo) => {
    try {
      const tab = await browser.tabs.get(activeInfo.tabId);
      if (tab?.incognito) return;
    } catch {}
    updateActionBadge(activeInfo.tabId);
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.incognito) return;
    const currentUrl = changeInfo.url || tab.url;
    if (changeInfo.status === 'complete' || changeInfo.url) {
      updateActionBadge(tabId, currentUrl);
    }
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

  // Setup context menu (toolbar icon right-click)
  const setupContextMenu = () => {
    if (!browser.contextMenus?.create) return;
    try {
      // Firefox MV2 uses 'browser_action', whereas MV3 (Chrome and Firefox MV3) uses 'action'
      const actionContext = import.meta.env.MANIFEST_VERSION === 2 ? 'browser_action' : 'action';
      const createItem = () => {
        try {
          browser.contextMenus.create(
            {
              id: 'open-management',
              title: i18n.t('openManagement'),
              contexts: [actionContext as any]
            },
            () => {
              if (browser.runtime.lastError) {
                // Silently ignore duplicate id or race
              }
            }
          );
        } catch {
          // Silently ignore duplicate id error if thrown synchronously
        }
      };

      if (typeof browser.contextMenus.removeAll === 'function') {
        let called = false;
        const onRemoved = () => {
          if (called) return;
          called = true;
          createItem();
        };

        const res: unknown = (browser.contextMenus.removeAll as any)(onRemoved);
        if (res != null && typeof (res as Record<string, any>).then === 'function') {
          (res as Promise<void>).then(onRemoved).catch(onRemoved);
        }
      } else {
        createItem();
      }
    } catch (e) {
      console.error('Failed to setup context menu:', e);
    }
  };

  // Ensure context menu is created and run startup sync on browser startup
  setupContextMenu();
  browser.runtime.onStartup?.addListener(async () => {
    setupContextMenu();
    await runStartupSync('onStartup');
  });

  // 6. Run one-time full sync on install or update
  browser.runtime.onInstalled.addListener(async (details) => {
    setupContextMenu();
    console.log('Extension installed/updated. Running initial sync...', details.reason);
    try {
      if (devSeedPromise) {
        await devSeedPromise;
      }
      const archiveCompressSetting = await db.settings.get('archive_compress');
      if (!archiveCompressSetting) {
        await db.settings.put({ key: 'archive_compress', value: true });
      }
      if (typeof browser !== 'undefined' && (browser.storage as any)?.session) {
        await (browser.storage as any).session.set({ startup_sync_completed: true }).catch(() => {});
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
  if (browser.contextMenus?.onClicked?.addListener) {
    browser.contextMenus.onClicked.addListener((info) => {
      if (info.menuItemId === 'open-management') {
        openManagementPage();
      }
    });
  }

  // 7. cross-origin iframe HTML fetch relay (for single-file style archiving)
  // @ts-ignore
  browser.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
    const message = msg as any;
    if (message?.type === 'FETCH_IFRAME' && message.url) {
      if (sender?.id && sender.id !== browser.runtime?.id) {
        sendResponse({ html: '' });
        return false;
      }
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
  browser.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
    const message = msg as any;
    if (message?.type === 'FETCH_RESOURCE' && message.url) {
      if (sender?.id && sender.id !== browser.runtime?.id) {
        sendResponse({ dataUri: message.url });
        return false;
      }
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
  browser.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
    const message = msg as any;

    if (message?.type && PRIVILEGED_MESSAGE_TYPES.has(message.type)) {
      if (!isInternalExtensionSender(sender)) {
        sendResponse({ ok: false, error: 'Unauthorized IPC sender' });
        return false;
      }
    }

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

    if (message?.type === 'AI_ANALYZE_BOOKMARK' && (message.bookmarkId || message.syncId || message.browserBookmarkId)) {
      sendResponse({ ok: true });
      (async () => {
        let bId = typeof message.bookmarkId === 'number' && message.bookmarkId > 0 ? message.bookmarkId : undefined;
        if (!bId && message.syncId) {
          const rec = await db.bookmarks.where('syncId').equals(message.syncId).first();
          if (rec?.id) bId = rec.id;
        }
        if (!bId && message.browserBookmarkId) {
          const rec = await db.bookmarks.where('bookmarkId').equals(String(message.browserBookmarkId)).first();
          if (rec?.id) bId = rec.id;
        }
        if (bId) {
          await enqueueAiJob({
            bookmarkId: bId,
            kind: 'auto',
            payload: message.payload || {},
            folders: message.folders || [],
            options: {
              autoSummarize: message.autoSummarize,
              autoTags: message.autoTags,
              autoFolder: message.autoFolder
            }
          });
        }
      })().catch((e) => console.error('AI analysis enqueue failed:', e));
      return false;
    }

    if (message?.type === 'AI_ABORT_BULK') {
      // Cancel all bulk AI (categorize/summarize) — revert in-progress bookmarks to aiStatus=none
      cancelAllAi().catch((e) => console.error('AI bulk cancel failed:', e));
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === 'AI_BULK_PROCESS' && Array.isArray(message.bookmarkIds)) {
      sendResponse({ ok: true });
      enqueueAiJobs(
        (message.bookmarkIds as number[]).map((id) => ({
          bookmarkId: id,
          kind: 'auto',
          options: message.options,
          folders: message.folders
        }))
      ).catch((e) => console.error('AI bulk process enqueue failed:', e));
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

    if (message?.type === 'ARCHIVE_CAPTURE_BOOKMARK' && (message.bookmarkId || message.syncId || message.browserBookmarkId)) {
      sendResponse({ ok: true });
      (async () => {
        let bId = typeof message.bookmarkId === 'number' ? message.bookmarkId : undefined;
        if (!bId && message.syncId) {
          const rec = await db.bookmarks.where('syncId').equals(message.syncId).first();
          if (rec?.id) bId = rec.id;
        }
        if (!bId && message.browserBookmarkId) {
          const rec = await db.bookmarks.where('bookmarkId').equals(String(message.browserBookmarkId)).first();
          if (rec?.id) bId = rec.id;
        }
        if (bId) {
          await enqueueArchiveJob({
            bookmarkId: bId,
            htmlSource: message.htmlSource || message.html,
            pageUrl: message.pageUrl || message.url,
            pageTitle: message.pageTitle || message.title,
            summary: message.summary,
            iframeSources: message.iframeSources,
            compress: message.compress
          });
        }
      })().catch((e) => console.error('Archive capture enqueue failed:', e));
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

    if (message?.type === 'MARK_EXTENSION_BOOKMARK' && message.bookmarkId) {
      BookmarkManager.extensionCreatedBookmarkIds.add(String(message.bookmarkId));
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === 'CHECK_DUPLICATE_BOOKMARK' && message.url) {
      BookmarkManager.findDuplicate(message.url)
        .then((existing) => {
          sendResponse({
            duplicate: !!existing,
            bookmark: existing ? {
              id: existing.id,
              syncId: existing.syncId,
              bookmarkId: existing.bookmarkId,
              title: existing.title,
              folderPath: existing.folderPath,
              tags: existing.tags,
              description: existing.description,
              createdAt: existing.createdAt,
              modifiedAt: existing.modifiedAt
            } : null
          });
        })
        .catch(() => sendResponse({ duplicate: false, bookmark: null }));
      return true; // async
    }

    if (message?.type === 'GET_TAG_SUGGESTIONS') {
      db.bookmarks.toArray()
        .then((bookmarks) => {
          const tagSet = new Set<string>();
          for (const b of bookmarks) {
            if (Array.isArray(b.tags)) {
              for (const t of b.tags) {
                if (t && typeof t === 'string') tagSet.add(t.trim());
              }
            }
          }
          sendResponse({ tags: Array.from(tagSet) });
        })
        .catch(() => sendResponse({ tags: [] }));
      return true; // async
    }

    if (message?.type === 'CREATE_INCOGNITO_BOOKMARK') {
      if (!isAuthorizedIncognitoSender(sender)) {
        sendResponse({ ok: false, error: 'Unauthorized IPC sender' });
        return false;
      }
      const { url, title, parentId, folderPath, description, tags } = message;
      (async () => {
        try {
          if (!url) {
            sendResponse({ ok: false, error: 'URL is required' });
            return;
          }
          const node = await browser.bookmarks.create({
            parentId,
            title: title || url,
            url
          });
          BookmarkManager.extensionCreatedBookmarkIds.add(node.id);

          let newId: number = 0;
          let targetSyncId = generateDeterministicSyncId(url);
          const now = Date.now();
          const sanitizedTags = tags && tags.length > 0 ? sanitizeTags(tags) : undefined;

          await db.transaction('rw', [db.bookmarks, db.settings], async () => {
            const existsSync = await db.bookmarks.where('syncId').equals(targetSyncId).first();
            if (existsSync) {
              targetSyncId = crypto.randomUUID();
            }
            await removeTombstone(targetSyncId);
            newId = await db.bookmarks.add({
              syncId: targetSyncId,
              bookmarkId: String(node.id),
              url,
              title: title || url,
              folderPath: folderPath || '',
              description: description || '',
              tags: sanitizedTags,
              createdAt: now,
              modifiedAt: now,
              visitCount: 0
            });
          });
          BookmarkManager.notifyBookmarksChanged();
          sendResponse({
            ok: true,
            bookmarkId: newId,
            browserBookmarkId: node.id,
            syncId: targetSyncId
          });
        } catch (e: any) {
          console.error('[background] CREATE_INCOGNITO_BOOKMARK failed:', e);
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true; // async
    }

    if (message?.type === 'REGISTER_INCOGNITO_BOOKMARK') {
      if (!isAuthorizedIncognitoSender(sender)) {
        sendResponse({ ok: false, error: 'Unauthorized IPC sender' });
        return false;
      }
      const { syncId, browserBookmarkId, url, title, folderPath, description, tags } = message;
      BookmarkManager.extensionCreatedBookmarkIds.add(String(browserBookmarkId));
      (async () => {
        try {
          const now = Date.now();
          const sanitizedTags = tags && tags.length > 0 ? sanitizeTags(tags) : undefined;
          let resDbId: number | undefined;
          let resSyncId: string = syncId;

          await db.transaction('rw', [db.bookmarks, db.settings], async () => {
            const existing = await db.bookmarks.where('bookmarkId').equals(String(browserBookmarkId)).first()
              || await db.bookmarks.where('syncId').equals(syncId).first();
            if (existing) {
              await db.bookmarks.update(existing.id!, {
                title: title || existing.title,
                folderPath: folderPath ?? existing.folderPath,
                description: description || existing.description || '',
                tags: sanitizedTags !== undefined ? sanitizedTags : existing.tags,
                modifiedAt: now
              });
              resDbId = existing.id;
              resSyncId = existing.syncId;
            } else {
              let targetSyncId = syncId;
              const existsSync = await db.bookmarks.where('syncId').equals(targetSyncId).first();
              if (existsSync) {
                targetSyncId = crypto.randomUUID();
              }
              await removeTombstone(targetSyncId);
              const newId = await db.bookmarks.add({
                syncId: targetSyncId,
                bookmarkId: String(browserBookmarkId),
                url,
                title: title || url,
                folderPath: folderPath || '',
                description: description || '',
                tags: sanitizedTags,
                createdAt: message.createdAt || now,
                modifiedAt: now,
                visitCount: 0
              });
              resDbId = newId;
              resSyncId = targetSyncId;
            }
          });
          BookmarkManager.notifyBookmarksChanged();
          sendResponse({ ok: true, dbId: resDbId, syncId: resSyncId });
        } catch (e: any) {
          console.error('[background] REGISTER_INCOGNITO_BOOKMARK failed:', e);
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true; // async
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
