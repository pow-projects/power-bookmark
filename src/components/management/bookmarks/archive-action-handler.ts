import db, { type Bookmark, type ArchivedPage } from '../../../lib/db';
import { archiveBookmark } from '../../../lib/archive/page-capture';
import { fetchHtmlWithCharset } from '../../../lib/archive/fetch-with-charset';
import {
  STALE_MS,
  getArchiveCaptureState,
  setArchiveCaptureState,
  clearArchiveCaptureState,
  notifyArchiveCaptureUpdate,
  notifyArchiveCaptureError
} from '../../../lib/archive/archive-capture-state';
import {
  getCloudArchiveIndexCache,
  recordArchiveTombstone,
  type ArchiveIndexEntry
} from '../../../lib/archive/archive-cloud';
import { normalizeUrl } from '../../../lib/bookmarks/url-normalizer';
import { showToast } from '../../../lib/ui/toast-store';

export async function openArchiveBookmark(
  bookmark: Bookmark,
  archiveMap: Map<number, ArchivedPage>,
  cloudArchiveMap: Map<string, ArchiveIndexEntry>,
  openViewer: (archive: ArchivedPage | null, html: string | null, bookmark?: Bookmark | null) => void,
  onReload: () => Promise<void>,
  onDownloadStart: () => void,
  onDownloadFinish: () => void,
  cloudArchiveUrlMap?: Map<string, ArchiveIndexEntry>
): Promise<void> {
  if (!bookmark.id) return;
  try {
    const archive = archiveMap.get(bookmark.id);
    if (archive && archive.htmlBlob instanceof Blob && archive.htmlBlob.size > 0) {
      openViewer(archive, null, bookmark);
      return;
    }

    const normUrl = bookmark.url ? normalizeUrl(bookmark.url) : '';
    const cloudEntry =
      (bookmark.syncId ? cloudArchiveMap.get(bookmark.syncId) : null) ||
      (normUrl && cloudArchiveUrlMap ? cloudArchiveUrlMap.get(normUrl) : null) ||
      (normUrl ? Array.from(cloudArchiveMap.values()).find((e) => !e.deleted && e.url && normalizeUrl(e.url) === normUrl) : null);

    const hasCloud = Boolean(
      (bookmark.syncId && cloudArchiveMap.has(bookmark.syncId)) ||
      (normUrl && cloudArchiveUrlMap?.has(normUrl)) ||
      cloudEntry
    );

    if (hasCloud || bookmark.syncId || bookmark.url) {
      onDownloadStart();
      showToast(i18n.t('archive.downloadingCloud'), 'info');
      if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
        const syncId = bookmark.syncId || cloudEntry?.syncId;
        const msgPayload: { type: string; syncId?: string; url?: string } = {
          type: 'ARCHIVE_DOWNLOAD_ON_DEMAND'
        };
        if (syncId) {
          msgPayload.syncId = syncId;
        } else if (bookmark.url) {
          msgPayload.url = bookmark.url;
        }

        const res = (await browser.runtime.sendMessage(msgPayload)) as any;
        if (res?.ok || res?.success) {
          await onReload();
          let freshArchive: ArchivedPage | null = null;
          if (bookmark.id) {
            freshArchive = (await db.archivedPages.where('bookmarkId').equals(bookmark.id).first()) || null;
          }
          if (!freshArchive && res.page?.bookmarkId) {
            freshArchive = (await db.archivedPages.where('bookmarkId').equals(res.page.bookmarkId).first()) || null;
          }
          openViewer(freshArchive || (res.page?.htmlBlob instanceof Blob ? res.page : null) || res.archive || null, res.directHtml || null, bookmark);
          return;
        } else {
          await onReload();
          showToast(i18n.t('archive.downloadFailed', { error: res?.error || 'Unknown error' }), 'error');
        }
      }
    }
  } catch (e: any) {
    showToast(i18n.t('archive.openFailed', { error: e.message }), 'error');
  } finally {
    onDownloadFinish();
  }
}

/**
 * Captures live rendered DOM from a temporary background tab (active: false).
 * Allows JavaScript (SPA, React, blog viewer scripts) to execute and hydrate without interrupting the user.
 */
export async function captureFromBackgroundTab(
  url: string,
  timeoutMs = 8000
): Promise<{ html: string; iframeSources: Record<string, string> } | null> {
  if (
    typeof browser === 'undefined' ||
    !browser.tabs?.create ||
    !browser.tabs?.remove ||
    !browser.tabs?.onUpdated ||
    !browser.tabs?.sendMessage
  ) {
    return null;
  }

  let tempTabId: number | undefined;
  let listener: ((tabId: number, changeInfo: any) => void) | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    const tab = await browser.tabs.create({ url, active: false });
    if (!tab || typeof tab.id !== 'number') {
      return null;
    }
    tempTabId = tab.id;

    // Wait until tab completes loading or times out
    await new Promise<void>((resolve) => {
      timeoutTimer = setTimeout(() => {
        resolve();
      }, timeoutMs);

      listener = (updatedTabId: number, changeInfo: any) => {
        if (updatedTabId === tempTabId && changeInfo.status === 'complete') {
          resolve();
        }
      };
      browser.tabs.onUpdated.addListener(listener);
    });

    // Brief settling time for dynamic client-side JS rendering (React, Vue, SmartEditor, etc.)
    await new Promise((r) => setTimeout(r, 700));

    // Request extracted live HTML from the content script (which auto-scrolls to load deferred content)
    const sendPromise = browser.tabs.sendMessage(tempTabId, { type: 'EXTRACT_HTML' });
    const timeoutMsg = new Promise<null>((resolve) => setTimeout(() => resolve(null), 7000));
    const response = (await Promise.race([sendPromise, timeoutMsg])) as any;
    if (response?.html) {
      return {
        html: response.html,
        iframeSources: response.iframeSources || {}
      };
    }
    return null;
  } catch (e) {
    console.warn('[archive] Background tab capture error:', e);
    return null;
  } finally {
    if (listener && browser.tabs?.onUpdated?.removeListener) {
      try {
        browser.tabs.onUpdated.removeListener(listener);
      } catch {}
    }
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    if (tempTabId !== undefined) {
      try {
        await browser.tabs.remove(tempTabId);
      } catch {}
    }
  }
}

export async function performArchiveCapture(bookmark: Bookmark): Promise<boolean> {
  if (bookmark.id === undefined) return false;
  try {
    let html = '';
    let iframeSources: Record<string, string> = {};

    try {
      if (typeof browser !== 'undefined' && browser.tabs?.query && browser.tabs?.sendMessage) {
        let targetTabId: number | undefined;

        // 1. Direct URL query
        const matchingTabs = await browser.tabs.query({ url: bookmark.url });
        if (matchingTabs && matchingTabs.length > 0 && matchingTabs[0].id) {
          targetTabId = matchingTabs[0].id;
        }

        // 2. Generic normalized URL & origin/pathname match across open tabs (handles redirects, tracking params)
        if (!targetTabId && bookmark.url) {
          const normBookmarkUrl = normalizeUrl(bookmark.url);
          const allTabs = await browser.tabs.query({});
          const matched = allTabs.find((tab) => {
            if (!tab.url || !tab.id) return false;
            if (normalizeUrl(tab.url) === normBookmarkUrl) return true;
            try {
              const uTab = new URL(tab.url);
              const uBook = new URL(bookmark.url);
              if (uTab.origin !== uBook.origin) return false;
              // Match normalized path ignoring trailing slash
              const pTab = uTab.pathname.replace(/\/+$/, '');
              const pBook = uBook.pathname.replace(/\/+$/, '');
              if (pTab === pBook) return true;
              // Check if path contains the article/post ID parameter
              const postParamMatch = bookmark.url.match(/(?:logNo|id|post|article|p)=([0-9a-zA-Z_-]+)/i);
              if (postParamMatch && postParamMatch[1] && tab.url.includes(postParamMatch[1])) {
                return true;
              }
              return false;
            } catch {
              return false;
            }
          });
          if (matched?.id) {
            targetTabId = matched.id;
          }
        }

        if (targetTabId) {
          const sendPromise = browser.tabs.sendMessage(targetTabId, { type: 'EXTRACT_HTML' });
          const timeoutMsg = new Promise<null>((resolve) => setTimeout(() => resolve(null), 7000));
          const response = (await Promise.race([sendPromise, timeoutMsg])) as any;
          html = response?.html || '';
          iframeSources = response?.iframeSources || {};
        }
      }
    } catch (e) {}

    // 3. If no open tab was matched, render and capture in a temporary background tab (active: false)
    if (!html && bookmark.url) {
      try {
        const bgResult = await captureFromBackgroundTab(bookmark.url);
        if (bgResult?.html) {
          html = bgResult.html;
          iframeSources = bgResult.iframeSources || {};
        }
      } catch (e) {
        console.warn('Background tab capture failed:', e);
      }
    }

    if (!html) {
      try {
        html = await fetchHtmlWithCharset(bookmark.url);
      } catch (e) {
        console.warn('Direct fetch failed for archive:', e);
      }
    }

    if (!html) throw new Error(i18n.t('archive.htmlFetchFailed'));

    const compress = (await db.settings.get('archive_compress'))?.value ?? true;
    await archiveBookmark(bookmark.id, html, bookmark.url, bookmark.title, '', iframeSources, compress);
    if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
      browser.runtime.sendMessage({ type: 'ARCHIVE_UPLOAD', bookmarkId: bookmark.id }).catch(() => {});
    }
    showToast(i18n.t('archive.saved'), 'success');
    return true;
  } catch (e: any) {
    showToast(i18n.t('archive.saveFailedWithDetail', { detail: e.message }), 'error');
    await notifyArchiveCaptureError(bookmark.id, e.message);
    return false;
  }
}

export async function saveArchiveBookmark(
  bookmark: Bookmark,
  onStart: () => void,
  onFinish: () => void,
  onReload: () => Promise<void>
): Promise<void> {
  if (bookmark.id === undefined) return;

  try {
    const existing = await getArchiveCaptureState();
    if (existing && Date.now() - existing.startedAt < STALE_MS) {
      showToast(i18n.t('archive.inProgressOther'), 'info');
      return;
    }
  } catch (e) {}

  const claimed = await setArchiveCaptureState({ bookmarkId: bookmark.id, startedAt: Date.now() });
  if (!claimed) {
    showToast(i18n.t('archive.inProgressOther'), 'info');
    return;
  }

  onStart();
  let succeeded = false;
  try {
    showToast(i18n.t('archive.savingToast'), 'info');
    succeeded = await performArchiveCapture(bookmark);
    if (succeeded) {
      await onReload();
    }
  } finally {
    await clearArchiveCaptureState(bookmark.id);
    if (succeeded) {
      await notifyArchiveCaptureUpdate();
    }
    onFinish();
  }
}

export async function deleteArchiveRecord(
  id: number,
  activeArchiveId: number | undefined,
  onReload: () => Promise<void>,
  closeViewer: () => void,
  context?: { syncId?: string; url?: string; bookmarkId?: number }
): Promise<void> {
  if (!confirm(i18n.t('archiveViewerModal.deleteConfirm'))) return;
  try {
    let archiveRow = await db.archivedPages.get(id);
    let targetArchiveId = id;
    if (!archiveRow) {
      archiveRow = await db.archivedPages.where('bookmarkId').equals(id).first();
      if (archiveRow && archiveRow.id !== undefined) {
        targetArchiveId = archiveRow.id;
      }
    }
    if (!archiveRow && activeArchiveId) {
      archiveRow = await db.archivedPages.get(activeArchiveId);
      if (!archiveRow) {
        archiveRow = await db.archivedPages.where('bookmarkId').equals(activeArchiveId).first();
      }
      if (archiveRow && archiveRow.id !== undefined) {
        targetArchiveId = archiveRow.id;
      }
    }

    if (targetArchiveId) {
      await db.archivedPages.delete(targetArchiveId);
    }

    let syncId: string | undefined = context?.syncId;
    let url: string | undefined = context?.url;

    if (archiveRow) {
      if (!url) url = archiveRow.url;
      const bookmark = await db.bookmarks.get(archiveRow.bookmarkId);
      if (!syncId) syncId = bookmark?.syncId;
      if (!url) url = bookmark?.url;
    } else {
      const bookmark = await db.bookmarks.get(context?.bookmarkId ?? id);
      if (!syncId) syncId = bookmark?.syncId;
      if (!url) url = bookmark?.url;
    }

    const normUrl = url ? normalizeUrl(url) : '';
    try {
      const cachedIndex = await getCloudArchiveIndexCache();
      if (cachedIndex && cachedIndex.length > 0) {
        if (!syncId) {
          const matched = cachedIndex.find(
            (e) => (normUrl && e.url && normalizeUrl(e.url) === normUrl) || (url && e.url === url)
          );
          if (matched?.syncId) syncId = matched.syncId;
        }
        const updated = cachedIndex.filter((e) => {
          if (syncId && e.syncId === syncId) return false;
          if (normUrl && e.url && normalizeUrl(e.url) === normUrl) return false;
          if (url && e.url && e.url === url) return false;
          return true;
        });
        if (updated.length !== cachedIndex.length) {
          await db.settings.put({ key: 'cloud_archive_index', value: updated });
        }
      }
    } catch {}

    if (syncId || url) {
      try {
        await recordArchiveTombstone(syncId || '', url);
      } catch {}
    }

    if (syncId && typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
      try {
        const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 3000));
        await Promise.race([
          browser.runtime.sendMessage({ type: 'ARCHIVE_DELETE', syncId }),
          timeoutPromise
        ]);
      } catch (err) {
        console.warn('ARCHIVE_DELETE error:', err);
      }
    }

    await onReload();
    closeViewer();
    showToast(i18n.t('archive.deleted'), 'success');
  } catch (e: any) {
    showToast(i18n.t('archive.deleteFailed', { error: e.message }), 'error');
  }
}
