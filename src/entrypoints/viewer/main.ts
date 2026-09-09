import db, { type ArchivedPage, type Bookmark } from '../../lib/db';
import { decompressArchiveHtml } from '../../lib/archive/page-capture';
import { buildArchiveBannerHtml } from '../../lib/archive/archive-viewer';

async function loadAndRenderArchive() {
  try {
    const params = new URLSearchParams(window.location.search);
    const bookmarkIdStr = params.get('bookmarkId') || params.get('id');
    const syncId = params.get('syncId');

    if (!bookmarkIdStr && !syncId) {
      showError(i18n.t('archive.noIdentifier'));
      return;
    }

    const bookmarkId = bookmarkIdStr ? Number(bookmarkIdStr) : undefined;
    let archivedPage: ArchivedPage | undefined;
    let bookmark: Bookmark | undefined;

    if (bookmarkId) {
      archivedPage = await db.archivedPages.where('bookmarkId').equals(bookmarkId).first();
      bookmark = await db.bookmarks.get(bookmarkId);
    } else if (syncId) {
      bookmark = await db.bookmarks.where('syncId').equals(syncId).first();
      if (bookmark?.id) {
        archivedPage = await db.archivedPages.where('bookmarkId').equals(bookmark.id).first();
      }
    }

    let html = '';
    if (archivedPage?.htmlBlob instanceof Blob) {
      const decompressed = await decompressArchiveHtml(archivedPage.htmlBlob);
      html = await decompressed.text();
    } else {
      // Attempt cloud on-demand download
      try {
        const dlResponse = (await browser.runtime.sendMessage({
          type: 'ARCHIVE_DOWNLOAD_ON_DEMAND',
          syncId: syncId || bookmark?.syncId,
          url: bookmark?.url
        })) as any;
        if (dlResponse?.ok) {
          const targetBookmarkId = bookmarkId || bookmark?.id || dlResponse.page?.bookmarkId;
          if (targetBookmarkId) {
            const fresh = await db.archivedPages.where('bookmarkId').equals(targetBookmarkId).first();
            if (fresh?.htmlBlob instanceof Blob) {
              archivedPage = fresh;
              const decompressed = await decompressArchiveHtml(fresh.htmlBlob);
              html = await decompressed.text();
            }
          }
        }
      } catch (e) {
        console.warn('[Viewer] On-demand download failed:', e);
      }
    }

    if (!html) {
      showError(i18n.t('archive.loadFailed'));
      return;
    }

    const pageTitle = bookmark?.title || archivedPage?.url || i18n.t('bookmarks.card.saveArchive');
    document.title = pageTitle;
    const bannerHtml = buildArchiveBannerHtml(html, {
      archivedAt: archivedPage?.archivedAt,
      title: pageTitle
    });

    const blob = new Blob([bannerHtml], { type: 'text/html;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);

    document.body.textContent = '';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.overflow = 'hidden';

    const iframe = document.createElement('iframe');
    iframe.src = blobUrl;
    iframe.title = pageTitle;
    iframe.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;border:none;margin:0;padding:0;display:block;';
    iframe.setAttribute('sandbox', 'allow-same-origin allow-popups allow-scripts');
    document.body.appendChild(iframe);
  } catch (e: any) {
    console.error('[Viewer] Failed to render archive:', e);
    showError(i18n.t('archive.loadError', { error: e.message || String(e) }));
  }
}

function showError(message: string) {
  document.body.textContent = '';
  const container = document.createElement('div');
  container.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#333;text-align:center;padding:20px;box-sizing:border-box;';

  const heading = document.createElement('h2');
  heading.style.cssText = 'color:#d6453d;margin-bottom:8px;';
  heading.textContent = i18n.t('archive.unavailable');

  const p = document.createElement('p');
  p.style.color = '#666';
  p.textContent = message;

  container.appendChild(heading);
  container.appendChild(p);
  document.body.appendChild(container);
}

loadAndRenderArchive();
