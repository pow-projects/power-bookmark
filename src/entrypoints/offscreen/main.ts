import { archiveBookmark } from '../../lib/archive/page-capture';
import { fetchHtmlWithCharset } from '../../lib/archive/fetch-with-charset';

// @ts-ignore
browser.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  const message = msg as any;
  if (message?.type === 'OFFSCREEN_ARCHIVE_BOOKMARK' && typeof message.bookmarkId === 'number') {
    (async () => {
      try {
        let htmlSource = message.htmlSource;
        if (!htmlSource && message.pageUrl) {
          htmlSource = await fetchHtmlWithCharset(message.pageUrl);
        }
        if (!htmlSource) {
          throw new Error(i18n.t('archive.offscreenError'));
        }
        const savedId = await archiveBookmark(
          message.bookmarkId,
          htmlSource,
          message.pageUrl,
          message.pageTitle || '',
          message.summary || '',
          message.iframeSources || {},
          message.compress ?? true
        );
        sendResponse({ ok: true, savedId });
      } catch (err: any) {
        console.error('[offscreen] Archive execution failed:', err);
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true; // async response
  }
});
