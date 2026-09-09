import db from '../db';
import { isBlockedUrl, sanitizeDOM } from './archive-sanitizer';
import { removeArchiveTombstone } from './archive-tombstone';

/**
 * Maximum concurrent executions for resource fetch
 */
export const CONCURRENT_FETCH_LIMIT = 4;

/**
 * Lightweight concurrency controller (Semaphore/Queue)
 */
export class ConcurrencyLimiter {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly limit: number = CONCURRENT_FETCH_LIMIT) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) {
        next();
      }
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get queueLength(): number {
    return this.queue.length;
  }
}

/**
 * Capture session context: concurrency controller and URL cache management
 */
export interface CaptureContext {
  limiter: ConcurrencyLimiter;
  cache: Map<string, Promise<string>>;
}

/**
 * Resolves a relative URL to an absolute URL.
 */
export function resolveUrl(base: string, relative: string): string {
  try {
    return new URL(relative, base).href;
  } catch (e) {
    return relative;
  }
}

/**
 * Generic check for blank, transparent, 1x1, spacer, or LQIP / blur / low-res placeholder image URLs.
 */
export function isPlaceholderUrl(src: string | null | undefined): boolean {
  if (!src) return true;
  const s = src.trim();
  if (!s) return true;
  if (s.startsWith('data:image/')) {
    if (s.length < 256) return true;
    if (s.includes('R0lGODlhAQABA') || s.includes('PHN2Z') || s.includes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB')) {
      return true;
    }
  }
  if (/(?:^|\/)(?:blank|empty|spacer|pixel|transparent|1x1|dot|clear)\.(?:gif|png|jpe?g|webp|svg)(?:\?.*)?$/i.test(s)) {
    return true;
  }

  // Canonical Naver full-res image type parameter (?type=w2 or ?type=w966 without blur) is not a placeholder
  if (/[?&]type=w\d+(?:&|$)/i.test(s) && !s.toLowerCase().includes('blur')) {
    return false;
  }

  // Detect LQIP / blur / low-res indicators in filename or query parameters
  if (
    /(?:^|\/|[._-])blur(?:[._\-/]|\.|$|=|&)/i.test(s) ||
    s.toLowerCase().includes('_blur') ||
    /[?&](?:type=)?(?:w\d+_blur|m_blur|blur|thumb|thumbnail|preview|lowres|mini|s\d+|w\d+|q\d+)(?:=[^&]*)?(?:&|$)/i.test(s)
  ) {
    return true;
  }

  return false;
}

export const GENERIC_LAZY_SRC_ATTRS: readonly string[] = [
  'data-lazy-src',
  'data-original',
  'data-src',
  'data-actualsrc',
  'data-url',
  'data-hi-res-src',
  'data-high-res-src',
  'data-origin-src',
  'data-orig-file',
  'data-origin-file',
  'data-original-file',
  'data-source-url',
  'data-zoom-src',
  'data-lazy',
  'data-original-src',
  'data-echo',
  'data-image',
  'data-thumb',
  'data-thumbnail',
  'thumburl',
  'data-gif-url',
  'data-full-url',
  'data-large-file'
] as const;

export const GENERIC_LAZY_SRCSET_ATTRS: readonly string[] = [
  'data-lazy-srcset',
  'data-srcset',
  'data-original-srcset'
] as const;

/**
 * Detects animated micro-videos (e.g. GIFs converted to MP4/WebM, looping muted animations, or blog GIF-video resources)
 */
export function isAnimatedMicroVideo(el: Element): boolean {
  if (el.tagName !== 'VIDEO') return false;
  const hasLoop = el.hasAttribute('loop');
  const isMuted = el.hasAttribute('muted') || (el as HTMLVideoElement).muted === true;
  if (hasLoop && isMuted) return true;

  const className = el.getAttribute('class') || '';
  if (className.includes('_gifmp4') || className.includes('custom-se-image-video-resource')) {
    return true;
  }

  if (el.hasAttribute('data-gif-url')) {
    return true;
  }

  return false;
}

/**
 * Fetch wrapper function with timeout functionality.
 */
export async function fetchWithTimeout(url: string, options: RequestInit = {}, timeout = 30000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(id);
    return response;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

/**
 * Performs actual single resource fetch and Base64 Data URI conversion
 */
async function executeFetch(url: string, pageUrl?: string): Promise<string> {
  let ext: typeof browser | null = null;
  try {
    if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.id) {
      ext = browser;
    }
  } catch {
    ext = null;
  }

  if (ext) {
    try {
      const res = await browser.runtime.sendMessage({ type: 'FETCH_RESOURCE', url, pageUrl }) as any;
      if (res?.dataUri && res.dataUri !== url) {
        return res.dataUri;
      }
    } catch {
      // fall through to local fetch
    }
  }

  try {
    const fetchOpts: RequestInit = {};
    if (pageUrl) {
      fetchOpts.referrer = pageUrl;
      fetchOpts.referrerPolicy = 'no-referrer-when-downgrade';
    }
    const response = await fetchWithTimeout(url, fetchOpts, 30000);
    if (!response.ok) return url;
    const contentType = response.headers?.get?.('content-type') || '';
    let mime = contentType.split(';')[0].trim() || '';
    if (!mime || mime === 'application/octet-stream') {
      const lowerUrl = url.toLowerCase();
      if (lowerUrl.includes('.mp4')) mime = 'video/mp4';
      else if (lowerUrl.includes('.webm')) mime = 'video/webm';
      else if (lowerUrl.includes('.ogg')) mime = 'video/ogg';
      else if (lowerUrl.includes('.gif')) mime = 'image/gif';
      else if (lowerUrl.includes('.jpg') || lowerUrl.includes('.jpeg')) mime = 'image/jpeg';
      else if (lowerUrl.includes('.png')) mime = 'image/png';
      else if (lowerUrl.includes('.webp')) mime = 'image/webp';
      else if (lowerUrl.includes('.svg')) mime = 'image/svg+xml';
      else mime = mime || 'image/png';
    }
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    const base64 = btoa(binary);
    return `data:${mime};base64,${base64}`;
  } catch (e) {
    console.warn(`Failed to fetch and convert resource: ${url}`, e);
    return url;
  }
}

/**
 * Fetches resource and converts to Base64 Data URI.
 * If session context is provided, URL deduplication cache and concurrency control are applied.
 */
export async function fetchAsDataUri(url: string, pageUrl?: string, ctx?: CaptureContext): Promise<string> {
  if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#')) {
    return url;
  }
  if (isBlockedUrl(url)) {
    return url;
  }

  if (ctx) {
    const cached = ctx.cache.get(url);
    if (cached) {
      return cached;
    }
    const promise = ctx.limiter.run(() => executeFetch(url, pageUrl));
    ctx.cache.set(url, promise);
    return promise;
  }

  return executeFetch(url, pageUrl);
}

/**
 * Replaces url(...), @import, @font-face src inside CSS with inline Data URIs.
 * Applies session context concurrency control and URL deduplication cache.
 */
export async function inlineCssUrls(cssText: string, baseUrl: string, ctx?: CaptureContext): Promise<string> {
  const urlRegex = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
  const importRegex = /@import\s+(?:url\(\s*['"]?([^'")]+)['"]?\s*\)|['"]([^'"]+)['"])/g;
  const promises: { matchStr: string; absoluteUrl: string }[] = [];
  let match: RegExpExecArray | null;

  const push = (matchStr: string, relUrl: string) => {
    if (!relUrl || relUrl.startsWith('data:') || relUrl.startsWith('blob:') || relUrl.startsWith('#')) return;
    promises.push({ matchStr, absoluteUrl: resolveUrl(baseUrl, relUrl) });
  };

  while ((match = urlRegex.exec(cssText)) !== null) push(match[0], match[1]);
  while ((match = importRegex.exec(cssText)) !== null) push(match[0], match[1] || match[2]);

  const seen = new Set<string>();
  const uniqueItems = promises.filter(p => {
    if (seen.has(p.matchStr)) return false;
    seen.add(p.matchStr);
    return true;
  });

  const dataUris = await Promise.all(
    uniqueItems.map(async (p) => ({
      matchStr: p.matchStr,
      dataUri: await fetchAsDataUri(p.absoluteUrl, baseUrl, ctx),
      absoluteUrl: p.absoluteUrl
    }))
  );

  let result = cssText;
  for (const item of dataUris) {
    if (item.dataUri && item.dataUri !== item.absoluteUrl) {
      result = result.split(item.matchStr).join(`url("${item.dataUri}")`);
    }
  }
  return result;
}

/**
 * Compresses string with gzip and converts to base64 data URI (payload only).
 */
export async function gzipToBase64(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const inputStream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
  const compressedStream = inputStream.pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(compressedStream).arrayBuffer();
  let binary = '';
  const compressedBytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < compressedBytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(compressedBytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

/**
 * Generates self-extracting loader HTML that decompresses compressed HTML.
 */
export function buildCompressedLoader(payloadBase64: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>
const p="${payloadBase64}";
const bin=atob(p);const arr=new Uint8Array(bin.length);
for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
new Response(new Blob([arr]).stream().pipeThrough(new DecompressionStream('gzip')))
  .text().then(t=>{document.open();document.write(t);document.close();});
</script></body></html>`;
}

/**
 * Takes serialized DOM HTML string, inlines image, CSS, font resources,
 * removes scripts, and creates a single HTML file (Blob).
 */
export async function capturePageHtml(
  htmlSource: string,
  pageUrl: string,
  pageTitle: string,
  summary = '',
  iframeSources: Record<string, string> = {},
  compress: boolean = false,
  parentCtx?: CaptureContext
): Promise<Blob> {
  const ctx: CaptureContext = parentCtx || {
    limiter: new ConcurrencyLimiter(CONCURRENT_FETCH_LIMIT),
    cache: new Map<string, Promise<string>>()
  };

  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlSource, 'text/html');

  // shadow DOM → <template shadowrootmode>, recursive (including nested shadow)
  let pending = Array.from(doc.querySelectorAll('*'));
  while (pending.length) {
    const next: Element[] = [];
    for (const host of pending) {
      const root = (host as any).shadowRoot;
      if (root && !(host as any)._shadowSerialized) {
        (host as any)._shadowSerialized = true;
        const template = doc.createElement('template');
        template.setAttribute('shadowrootmode', (root as any).mode || 'open');
        for (const child of Array.from((root as Node).childNodes)) {
          template.content.appendChild(child.cloneNode(true));
        }
        host.appendChild(template);
        next.push(host);
      }
    }
    pending = next;
  }

  // 1. DOM cleanup — remove <script>, <noscript> tags
  doc.querySelectorAll('script, noscript').forEach((el) => el.remove());
  
  // Remove inline script attributes like onclick
  const allElements = doc.querySelectorAll('*');
  allElements.forEach((el) => {
    const attrs = el.attributes;
    for (let i = attrs.length - 1; i >= 0; i--) {
      const attrName = attrs[i].name;
      if (attrName.toLowerCase().startsWith('on')) {
        el.removeAttribute(attrName);
      }
    }
  });

  // Remove javascript: URLs
  doc.querySelectorAll('a[href^="javascript:" i], area[href^="javascript:" i]').forEach((el) => {
    el.removeAttribute('href');
  });

  // Sanitize ads, trackers, and unnecessary elements
  sanitizeDOM(doc);

  // 2. Read external stylesheets (<link rel="stylesheet">) and replace with inline <style> tags (concurrency limited)
  const styleLinks = Array.from(doc.querySelectorAll('link[rel="stylesheet"], link[rel="preload"][as="style"]'));
  await Promise.all(
    styleLinks.map(async (link: any) => {
      const href = link.getAttribute('href');
      if (href) {
        const absoluteHref = resolveUrl(pageUrl, href);
        if (isBlockedUrl(absoluteHref)) return;
        try {
          const res = await ctx.limiter.run(() => fetchWithTimeout(absoluteHref, {}, 2000));
          if (res.ok) {
            let cssText = await res.text();
            cssText = await inlineCssUrls(cssText, absoluteHref, ctx);
            const styleEl = doc.createElement('style');
            styleEl.textContent = cssText;
            link.parentNode?.replaceChild(styleEl, link);
          }
        } catch (e) {
          console.warn(`Failed to inline stylesheet: ${absoluteHref}`, e);
        }
      }
    })
  );

  // Inline favicon/icon links
  const iconLinks = Array.from(doc.querySelectorAll('link[rel*="icon"]'));
  await Promise.all(
    iconLinks.map(async (link: any) => {
      const href = link.getAttribute('href');
      if (href && !href.startsWith('data:') && !href.startsWith('blob:')) {
        const dataUri = await fetchAsDataUri(resolveUrl(pageUrl, href), pageUrl, ctx);
        link.setAttribute('href', dataUri);
      }
    })
  );

  // Inline CSS inside existing <style> tags (apply concurrency limit and cache)
  const styleTags = Array.from(doc.querySelectorAll('style'));
  await Promise.all(
    styleTags.map(async (styleEl) => {
      if (styleEl.textContent) {
        styleEl.textContent = await inlineCssUrls(styleEl.textContent, pageUrl, ctx);
      }
    })
  );

  // Inline CSS background images in inline style attributes: style="... url(...) ..."
  const elementsWithInlineStyle = Array.from(doc.querySelectorAll('[style*="url("]'));
  await Promise.all(
    elementsWithInlineStyle.map(async (el) => {
      const rawStyle = el.getAttribute('style');
      if (rawStyle) {
        const inlined = await inlineCssUrls(rawStyle, pageUrl, ctx);
        el.setAttribute('style', inlined);
      }
    })
  );

  // Helper to inline image src with placeholder detection & generic lazy attribute resolution
  const inlineSrc = async (el: Element, attr: string) => {
    let src = el.getAttribute(attr);
    const isPlaceholder = isPlaceholderUrl(src);

    if (!src || isPlaceholder) {
      let candidateFound = false;
      const candidates =
        attr === 'src'
          ? GENERIC_LAZY_SRC_ATTRS
          : [`data-${attr}`, `data-high-res-${attr}`, `data-orig-${attr}`, ...GENERIC_LAZY_SRC_ATTRS];
      for (const lazyAttr of candidates) {
        const candidate = el.getAttribute(lazyAttr);
        if (candidate && !isPlaceholderUrl(candidate)) {
          src = candidate;
          el.setAttribute(attr, candidate);
          candidateFound = true;
          break;
        }
      }

      // If candidate was not found from lazy attributes, check srcset
      if (!candidateFound) {
        const srcset = el.getAttribute('srcset') || el.getAttribute('data-srcset');
        if (srcset) {
          const firstEntry = srcset.split(',')[0]?.trim()?.split(/\s+/)[0];
          if (firstEntry && !isPlaceholderUrl(firstEntry)) {
            src = firstEntry;
            el.setAttribute(attr, firstEntry);
          }
        }
      }
    }

    if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
      const dataUri = await fetchAsDataUri(resolveUrl(pageUrl, src), pageUrl, ctx);
      el.setAttribute(attr, dataUri);
    }
  };

  // Helper to rewrite srcset with placeholder detection & generic lazy attribute resolution
  async function rewriteSrcset(el: Element, pageUrl: string) {
    let srcset = el.getAttribute('srcset');
    if (!srcset || isPlaceholderUrl(srcset)) {
      for (const lazyAttr of GENERIC_LAZY_SRCSET_ATTRS) {
        const lazySrcset = el.getAttribute(lazyAttr);
        if (lazySrcset) {
          srcset = lazySrcset;
          el.setAttribute('srcset', lazySrcset);
          break;
        }
      }
    }
    if (!srcset) return;
    const entries = await Promise.all(
      srcset.split(',').map(async (entry) => {
        const trimmed = entry.trim();
        if (!trimmed) return '';
        const [u, ...rest] = trimmed.split(/\s+/);
        if (!u || u.startsWith('data:') || u.startsWith('blob:')) return trimmed;
        const dataUri = await fetchAsDataUri(resolveUrl(pageUrl, u), pageUrl, ctx);
        const descriptor = rest.join(' ');
        return descriptor ? `${dataUri} ${descriptor}` : dataUri;
      })
    );
    el.setAttribute('srcset', entries.filter(Boolean).join(', '));
  }

  const cleanLazyAttrs = (el: Element) => {
    for (const attr of GENERIC_LAZY_SRC_ATTRS) el.removeAttribute(attr);
    for (const attr of GENERIC_LAZY_SRCSET_ATTRS) el.removeAttribute(attr);
    el.removeAttribute('data-poster');
    el.removeAttribute('data-poster-url');
    el.removeAttribute('data-high-res-poster');
  };

  // 3. Process media elements
  // (1) <img> tags: inline src and srcset (apply concurrency control and cache)
  const imgEls = Array.from(doc.querySelectorAll('img'));
  await Promise.all(
    imgEls.map(async (el) => {
      await inlineSrc(el, 'src');
      await rewriteSrcset(el, pageUrl);
      cleanLazyAttrs(el);
    })
  );

  // (2) <source> tags inside <picture>: inline srcset and src
  const pictureSources = Array.from(doc.querySelectorAll('picture source'));
  await Promise.all(
    pictureSources.map(async (el) => {
      await rewriteSrcset(el, pageUrl);
      if (!el.hasAttribute('srcset') && !el.hasAttribute('src')) {
        for (const lazyAttr of GENERIC_LAZY_SRC_ATTRS) {
          const lazy = el.getAttribute(lazyAttr);
          if (lazy && !isPlaceholderUrl(lazy)) {
            el.setAttribute('src', lazy);
            break;
          }
        }
      }
      if (el.hasAttribute('src')) {
        await inlineSrc(el, 'src');
      }
      cleanLazyAttrs(el);
    })
  );

  // (3) <video> tags: inline poster, and inline animated micro-videos as Base64 Data URIs
  const videoEls = Array.from(doc.querySelectorAll('video'));
  await Promise.all(
    videoEls.map(async (el) => {
      if (
        el.hasAttribute('poster') ||
        el.hasAttribute('data-poster') ||
        el.hasAttribute('data-poster-url') ||
        el.hasAttribute('data-high-res-poster')
      ) {
        await inlineSrc(el, 'poster');
        el.removeAttribute('data-poster');
        el.removeAttribute('data-poster-url');
        el.removeAttribute('data-high-res-poster');
      }

      const isMicro = isAnimatedMicroVideo(el);

      // Preserve & inline data-gif-url if present
      if (el.hasAttribute('data-gif-url')) {
        const gifUrl = el.getAttribute('data-gif-url');
        if (gifUrl && !gifUrl.startsWith('data:') && !gifUrl.startsWith('blob:')) {
          const inlinedGif = await fetchAsDataUri(resolveUrl(pageUrl, gifUrl), pageUrl, ctx);
          el.setAttribute('data-gif-url', inlinedGif);
        }
      }

      const src = el.getAttribute('src') || el.getAttribute('data-src');
      if (src) {
        const fullSrc = resolveUrl(pageUrl, src);
        if (isMicro) {
          const videoDataUri = await fetchAsDataUri(fullSrc, pageUrl, ctx);
          el.setAttribute('src', videoDataUri);
        } else {
          el.setAttribute('src', fullSrc);
        }
        el.removeAttribute('data-src');
      }

      for (const child of Array.from(el.querySelectorAll('source'))) {
        const childSrc = child.getAttribute('src') || child.getAttribute('data-src');
        if (childSrc) {
          const fullChildSrc = resolveUrl(pageUrl, childSrc);
          if (isMicro) {
            const childDataUri = await fetchAsDataUri(fullChildSrc, pageUrl, ctx);
            child.setAttribute('src', childDataUri);
          } else {
            child.setAttribute('src', fullChildSrc);
          }
          child.removeAttribute('data-src');
        }
        child.removeAttribute('data-srcset');
      }
    })
  );

  // (4) <audio> tags: keep original URL for audio media streams without Base64 conversion
  const audioEls = Array.from(doc.querySelectorAll('audio'));
  await Promise.all(
    audioEls.map(async (el) => {
      const src = el.getAttribute('src') || el.getAttribute('data-src');
      if (src) {
        el.setAttribute('src', resolveUrl(pageUrl, src));
        el.removeAttribute('data-src');
      }
      for (const child of Array.from(el.querySelectorAll('source'))) {
        const childSrc = child.getAttribute('src') || child.getAttribute('data-src');
        if (childSrc) {
          child.setAttribute('src', resolveUrl(pageUrl, childSrc));
          child.removeAttribute('data-src');
        }
        child.removeAttribute('data-srcset');
      }
    })
  );

  // (5) <embed>, <object> tags: keep original URL for large embedded streams without Base64 conversion
  const embedEls = Array.from(doc.querySelectorAll('embed'));
  embedEls.forEach((el) => {
    const src = el.getAttribute('src') || el.getAttribute('data-src');
    if (src) {
      el.setAttribute('src', resolveUrl(pageUrl, src));
      el.removeAttribute('data-src');
    }
  });

  const objectEls = Array.from(doc.querySelectorAll('object'));
  objectEls.forEach((el) => {
    const data = el.getAttribute('data') || el.getAttribute('data-src');
    if (data) {
      el.setAttribute('data', resolveUrl(pageUrl, data));
      el.removeAttribute('data-src');
    }
  });

  // (6) Other standalone <source> tags besides <picture>, <video>, <audio>
  const otherSources = Array.from(doc.querySelectorAll('source')).filter(
    s => !s.closest('video') && !s.closest('audio') && !s.closest('picture')
  );
  await Promise.all(
    otherSources.map(async (el) => {
      await rewriteSrcset(el, pageUrl);
      if (!el.hasAttribute('srcset') && !el.hasAttribute('src')) {
        for (const lazyAttr of GENERIC_LAZY_SRC_ATTRS) {
          const lazy = el.getAttribute(lazyAttr);
          if (lazy && !isPlaceholderUrl(lazy)) {
            el.setAttribute('src', lazy);
            break;
          }
        }
      }
      if (el.hasAttribute('src')) {
        await inlineSrc(el, 'src');
      }
      cleanLazyAttrs(el);
    })
  );

  // (7) Inline SVG <image> tags
  const svgImages = Array.from(doc.querySelectorAll('svg image'));
  await Promise.all(
    svgImages.map(async (el) => {
      const href = el.getAttribute('href') || el.getAttribute('xlink:href');
      if (href && !href.startsWith('data:') && !href.startsWith('blob:') && !href.startsWith('#')) {
        const dataUri = await fetchAsDataUri(resolveUrl(pageUrl, href), pageUrl, ctx);
        if (el.hasAttribute('href')) el.setAttribute('href', dataUri);
        if (el.hasAttribute('xlink:href')) el.setAttribute('xlink:href', dataUri);
      }
    })
  );

  // (8) Generic elements with thumbnail / deferred preview URLs lacking an <img> child
  const thumbContainers = Array.from(doc.querySelectorAll('[thumburl], [data-thumb], [data-thumbnail]'));
  await Promise.all(
    thumbContainers.map(async (el) => {
      if (el.tagName === 'IMG' || el.querySelector('img')) return;
      const thumbUrl = el.getAttribute('thumburl') || el.getAttribute('data-thumb') || el.getAttribute('data-thumbnail');
      if (thumbUrl && !isPlaceholderUrl(thumbUrl)) {
        try {
          const fullThumbUrl = resolveUrl(pageUrl, thumbUrl);
          const dataUri = await fetchAsDataUri(fullThumbUrl, pageUrl, ctx);
          const img = doc.createElement('img');
          img.setAttribute('src', dataUri);
          const w = el.getAttribute('data-width') || el.getAttribute('width');
          const h = el.getAttribute('data-height') || el.getAttribute('height');
          if (w) img.setAttribute('width', w);
          if (h) img.setAttribute('height', h);
          el.appendChild(img);
        } catch {}
      }
    })
  );

  // 4. iframe -> srcdoc inline (same-origin collected only; cross-origin skipped)
  const iframes = Array.from(doc.querySelectorAll('iframe'));
  await Promise.all(
    iframes.map(async (iframe: any) => {
      const src = iframe.getAttribute('src');
      if (src && iframeSources[src]) {
        // Inline iframe document with same context (limiter, cache)
        const iframeBlob = await capturePageHtml(iframeSources[src], resolveUrl(pageUrl, src), pageTitle, '', {}, compress, ctx);
        const text = await iframeBlob.text();
        iframe.removeAttribute('src');
        iframe.setAttribute('srcdoc', text);
      }
    })
  );

  // Preserve input value state
  doc.querySelectorAll('input, textarea, select').forEach((el: any) => {
    if (el.type === 'checkbox' || el.type === 'radio') {
      if (el.checked) el.setAttribute('checked', '');
    } else if (el.tagName === 'SELECT') {
      Array.from(el.options).forEach((opt: any) => {
        if (opt.selected) opt.setAttribute('selected', '');
      });
    } else if (el.value) {
      el.setAttribute('value', el.value);
    }
  });

  // 5. Inject metadata and Viewport adjustments
  let head = doc.querySelector('head');
  if (!head) {
    head = doc.createElement('head');
    doc.documentElement.insertBefore(head, doc.documentElement.firstChild);
  }
  const comment = doc.createComment(` PowerBookmark Archive | URL: ${pageUrl} | Archived: ${new Date().toISOString()} | Title: ${pageTitle} | Summary: ${summary.replace(/-->/g, ' ')} `);
  head.insertBefore(comment, head.firstChild);
  const baseEl = doc.createElement('base');
  baseEl.setAttribute('href', pageUrl);
  head.insertBefore(baseEl, head.firstChild);

  // Viewport meta adjustment
  let viewportMeta = doc.querySelector('meta[name="viewport"]');
  if (viewportMeta) {
    viewportMeta.setAttribute('content', 'width=device-width, initial-scale=1.0');
  } else {
    viewportMeta = doc.createElement('meta');
    viewportMeta.setAttribute('name', 'viewport');
    viewportMeta.setAttribute('content', 'width=device-width, initial-scale=1.0');
    head.appendChild(viewportMeta);
  }

  const finalHtml = doc.documentElement.outerHTML;
  if (compress) {
    const b64 = await gzipToBase64(finalHtml);
    const loader = buildCompressedLoader(b64);
    return new Blob([loader], { type: 'text/html;charset=utf-8' });
  }
  return new Blob([finalHtml], { type: 'text/html;charset=utf-8' });
}

/**
 * Automatically injects/adjusts viewport meta tag inside <head> of HTML string.
 */
export function ensureFullViewportHtml(htmlSource: string): string {
  if (!htmlSource) return htmlSource;
  // Return original as-is if viewport meta tag is already injected
  if (
    htmlSource.includes('name="viewport"') &&
    htmlSource.includes('content="width=device-width, initial-scale=1.0"')
  ) {
    return htmlSource;
  }

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlSource, 'text/html');

    let head = doc.querySelector('head');
    if (!head) {
      head = doc.createElement('head');
      doc.documentElement.insertBefore(head, doc.documentElement.firstChild);
    }

    // Inspect and adjust viewport meta tag
    let viewportMeta = doc.querySelector('meta[name="viewport"]');
    if (viewportMeta) {
      viewportMeta.setAttribute('content', 'width=device-width, initial-scale=1.0');
    } else {
      viewportMeta = doc.createElement('meta');
      viewportMeta.setAttribute('name', 'viewport');
      viewportMeta.setAttribute('content', 'width=device-width, initial-scale=1.0');
      head.appendChild(viewportMeta);
    }

    const doctypeStr = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>` : '<!DOCTYPE html>';
    return doctypeStr + '\n' + doc.documentElement.outerHTML;
  } catch (e) {
    console.warn('Failed to ensure viewport HTML:', e);
    return htmlSource;
  }
}

/**
 * Creates an archived page for a specific bookmark and saves it to IndexedDB.
 */
export async function archiveBookmark(
  bookmarkId: number,
  htmlSource: string,
  pageUrl: string,
  pageTitle: string,
  summary = '',
  iframeSources: Record<string, string> = {},
  compress: boolean = false
): Promise<number> {
  const blob = await capturePageHtml(htmlSource, pageUrl, pageTitle, summary, iframeSources, compress);

  const doWrite = () => db.transaction('rw', [db.bookmarks, db.archivedPages], async () => {
    if (db.bookmarks) {
      const bookmarkExists = await db.bookmarks.get(bookmarkId);
      if (!bookmarkExists) {
        console.warn(`[archiveBookmark] Bookmark '${bookmarkId}' no longer exists in db.bookmarks; skipping archive save.`);
        return -1;
      }
    }
    await db.archivedPages.where('bookmarkId').equals(bookmarkId).delete();
    return db.archivedPages.add({
      bookmarkId,
      url: pageUrl,
      htmlBlob: blob,
      fileSize: blob.size,
      archivedAt: Date.now()
    });
  });

  // Retry: ensure success even during transient connection renegotiations (AbortError/VersionError)
  let lastErr: unknown;
  let savedId = -1;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      savedId = await doWrite();
      break;
    } catch (e: any) {
      if (e && (e.name === 'AbortError' || e.name === 'VersionError')) {
        lastErr = e;
        await new Promise(r => setTimeout(r, 150 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  if (savedId === -1 && lastErr) throw lastErr;
  if (savedId > 0) {
    try {
      const bm = await db.bookmarks?.get(bookmarkId);
      await removeArchiveTombstone(bm?.syncId, pageUrl);
    } catch {}
  }
  return savedId;
}

/**
 * Decompresses Gzip-compressed self-extracting archive HTML Blob and returns Plain HTML Blob.
 * Returns original Blob without throwing exception if uncompressed regular HTML or on decompression failure.
 */
export async function decompressArchiveHtml(blob: Blob): Promise<Blob> {
  try {
    const text = await blob.text();
    if (!text.includes('DecompressionStream') || !text.includes('const p=')) {
      return blob;
    }
    const match = text.match(/const p="([^"]+)";/);
    if (!match || !match[1]) {
      return blob;
    }
    const payloadBase64 = match[1].trim();
    const binary = atob(payloadBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const inputStream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    });
    const decompressedStream = inputStream.pipeThrough(new DecompressionStream('gzip'));
    const decompressedText = await new Response(decompressedStream).text();
    return new Blob([decompressedText], { type: 'text/html;charset=utf-8' });
  } catch (e) {
    console.warn('Failed to decompress archive HTML, returning original blob:', e);
    return blob;
  }
}
