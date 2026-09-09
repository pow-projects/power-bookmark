import { shouldSkipIframe } from '../lib/archive/archive-sanitizer';
import { autoScrollToLoadDeferredContent, prepareLiveDomForCapture } from '../lib/archive/live-dom-preparer';
import type { ExtractedPagePayload, ExtractionType } from '../lib/ai/types';

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    // @ts-ignore
    browser.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
      const message = msg as any;
      if (message?.type === 'EXTRACT_TEXT') {
        const payload = extractPageContent();
        sendResponse(payload);
        return;
      }
      if (message?.type === 'EXTRACT_HTML') {
        (async () => {
          try {
            if (message.autoScroll !== false) {
              await autoScrollToLoadDeferredContent(document);
            }
            prepareLiveDomForCapture(document);
          } catch (e) {
            console.warn('[content] DOM pre-processing warning:', e);
          }

          const result: { html: string; iframeSources: Record<string, string> } = {
            html: document.documentElement?.outerHTML || '',
            iframeSources: {}
          };
          const iframes = Array.from(document.querySelectorAll('iframe'));
          for (const iframe of iframes) {
            const src = iframe.getAttribute('src');
            if (!src) continue;
            if (/^(javascript:|data:|blob:|about:)/i.test(src)) continue;
            if (shouldSkipIframe(src)) continue;
            const absoluteSrc = (() => { try { return new URL(src, location.href).href; } catch { return null; } })();
            if (!absoluteSrc) continue;
            if (result.iframeSources[absoluteSrc]) continue;
            try {
              const doc = iframe.contentDocument;
              if (doc && doc.documentElement) {
                result.iframeSources[absoluteSrc] = doc.documentElement.outerHTML;
              } else {
                // cross-origin → background relay
                const res = await browser.runtime.sendMessage({ type: 'FETCH_IFRAME', url: absoluteSrc }) as any;
                if (res?.html) result.iframeSources[absoluteSrc] = res.html;
              }
            } catch {
              // access denied — skip
            }
          }
          sendResponse(result);
        })();
        return true; // Keep async response channel open
      }
      return;
    });

    function getMetaDescription(): string {
      const metaDesc =
        document.querySelector('meta[name="description"]')?.getAttribute('content') ||
        document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
        document.querySelector('meta[name="og:description"]')?.getAttribute('content') ||
        document.querySelector('meta[name="twitter:description"]')?.getAttribute('content');
      return metaDesc?.trim() || '';
    }

    function extractPageContent(): ExtractedPagePayload {
      const url = location.href;
      const metaDescription = getMetaDescription();

      // Extract body innerText after stripping noise (scripts/styles/nav/header/footer/forms/sidebars)
      // Simplified to metaDescription + innerText instead of Readability — full article unnecessary for 60-char summaries
      const clone = document.body.cloneNode(true) as HTMLElement;
      ['script', 'style', 'noscript', 'iframe', 'header', 'footer', 'nav', 'form', 'aside'].forEach((sel) =>
        clone.querySelectorAll(sel).forEach((el) => el.remove())
      );
      const text = clone.innerText?.trim() || clone.textContent?.trim() || '';

      return {
        title: document.title || '',
        url,
        metaDescription,
        content: text,
        extractionType: 'basic',
        text
      };
    }
  }
});

