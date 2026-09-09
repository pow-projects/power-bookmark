/**
 * Shared utility for injecting a fixed top banner when opening archived HTML in a new tab.
 * Shared between popup "View Archive" and management page "Open in New Tab"
 * to guarantee identical output.
 */

export interface ArchiveBannerOptions {
  /** Archive date — if valid date value, displayed in banner as "Archived at: ..." */
  archivedAt?: string | number | Date | null;
  /** Unused (backward compatibility) — not referenced since download removal */
  title?: string | null;
  /** Custom message to display in banner (default: i18n.t('archive.banner')) */
  bannerText?: string | null;
}

/**
 * Returns HTML with banner (message + archive date) and body padding injected.
 * Inserted immediately after <body> tag if present, otherwise prepended. Date is right-aligned with float:right.
 * Note: This function must only be called in a browser context (where URL.createObjectURL is available).
 */
export function buildArchiveBannerHtml(html: string, opts: ArchiveBannerOptions = {}): string {
  const archivedDate = opts.archivedAt
    ? new Date(opts.archivedAt).toLocaleString()
    : '';
  const bannerStyle = [
    'position:fixed',
    'top:0',
    'left:0',
    'width:100%',
    'z-index:2147483647',
    'background:#D6453D',
    'color:#ffffff',
    'padding:10px 16px',
    'font-size:14px',
    'line-height:1.4',
    'box-sizing:border-box!important',
    'box-shadow:0 2px 8px rgba(0,0,0,0.3)'
  ].join(';');

  const defaultBannerText = typeof i18n !== 'undefined'
    ? i18n.t('archive.banner')
    : '아카이브 보기 중 · 원본 페이지의 저장된 복사본';
  const bannerText = opts.bannerText || defaultBannerText;

  const dateHtml = archivedDate
    ? `<span data-pb-archive-date style="float:right!important;margin-left:16px!important;opacity:.85;">${archivedDate}</span>`
    : '';
  const banner =
    `<div data-pb-archive-banner style="${bannerStyle}">` +
    dateHtml +
    bannerText +
    `</div>`;
  const padStyle =
    `<style data-pb-archive-pad>body{padding-top:52px !important;box-sizing:border-box;margin-top:0 !important;}</style>`;

  const inject = banner + padStyle;
  let resultHtml = html;
  if (opts.title) {
    const escapedTitle = opts.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const titleTag = `<title>${escapedTitle}</title>`;
    if (/<title\b[^>]*>[\s\S]*?<\/title>/i.test(resultHtml)) {
      resultHtml = resultHtml.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, titleTag);
    } else if (/<head\b[^>]*>/i.test(resultHtml)) {
      resultHtml = resultHtml.replace(/<head\b[^>]*>/i, `$&${titleTag}`);
    } else {
      resultHtml = titleTag + resultHtml;
    }
  }

  const bodyMatch = resultHtml.match(/<body[^>]*>/i);
  if (bodyMatch && bodyMatch.index !== undefined) {
    const idx = bodyMatch.index + bodyMatch[0].length;
    return resultHtml.slice(0, idx) + inject + resultHtml.slice(idx);
  }
  return inject + resultHtml;
}

/** Creates a blob URL from the injected HTML containing the banner and opens it with window.open. */
export function openArchivedPageInWindow(html: string, opts: ArchiveBannerOptions = {}): string {
  const injected = buildArchiveBannerHtml(html, opts);
  const blob = new Blob([injected], { type: 'text/html;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);
  window.open(blobUrl, '_blank');
  return blobUrl;
}
