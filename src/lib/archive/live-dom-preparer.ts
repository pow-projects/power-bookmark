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

export interface AutoScrollOptions {
  maxDurationMs?: number;
  stepDelayMs?: number;
  stepFraction?: number;
  maxSteps?: number;
  easing?: boolean;
}

/**
 * Smooth Sine Ease-In-Out function:
 * Slow acceleration at start (0 -> 0.2), rapid cruise in middle (0.2 -> 0.8), slow deceleration at end (0.8 -> 1.0).
 */
export function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

function isElementInView(el: Element, viewportHeight: number): boolean {
  try {
    if (typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      if (rect.top === 0 && rect.bottom === 0 && rect.left === 0 && rect.right === 0) {
        return true;
      }
      return rect.top < viewportHeight + 300 && rect.bottom > -300;
    }
  } catch {}
  return true;
}

/**
 * Progressive Viewport Harvester:
 * Inspects rendered media in the viewport at each scroll step, capturing rendered currentSrc
 * and promoting high-res lazy attributes over placeholders.
 */
export function harvestInViewElements(doc: Document, viewportHeight = 800): void {
  // 1. Process <img> elements
  const images = Array.from(doc.querySelectorAll('img'));
  for (const img of images) {
    if (!isElementInView(img, viewportHeight)) continue;

    const htmlImg = img as HTMLImageElement;
    if (htmlImg.complete && htmlImg.naturalWidth > 1 && htmlImg.currentSrc) {
      if (!isPlaceholderUrl(htmlImg.currentSrc)) {
        img.setAttribute('src', htmlImg.currentSrc);
        img.setAttribute('data-pb-captured', 'true');
      }
    }

    // If it has lazy attributes and src is blur/placeholder, promote it
    const src = img.getAttribute('src');
    if (!src || isPlaceholderUrl(src)) {
      for (const attr of GENERIC_LAZY_SRC_ATTRS) {
        const val = img.getAttribute(attr);
        if (val && !isPlaceholderUrl(val)) {
          img.setAttribute('src', val);
          break;
        }
      }
    }
  }

  // 2. Process <video> elements
  const videos = Array.from(doc.querySelectorAll('video'));
  for (const video of videos) {
    if (!isElementInView(video, viewportHeight)) continue;
    const htmlVideo = video as HTMLVideoElement;
    if (htmlVideo.currentSrc) {
      video.setAttribute('src', htmlVideo.currentSrc);
    }
  }
}

/**
 * Automatically scrolls through a page to trigger lazy-loaded assets,
 * IntersectionObserver handlers, and dynamic scroll-based script triggers,
 * and restores the initial scroll position upon completion.
 */
export async function autoScrollToLoadDeferredContent(
  doc: Document,
  options?: AutoScrollOptions
): Promise<void> {
  if (typeof window === 'undefined' || !doc || !doc.documentElement) {
    return;
  }

  const origX = window.scrollX ?? window.pageXOffset ?? 0;
  const origY = window.scrollY ?? window.pageYOffset ?? 0;

  const htmlEl = doc.documentElement;
  const originalScrollBehavior = htmlEl?.style?.scrollBehavior ?? '';
  if (htmlEl?.style) {
    htmlEl.style.scrollBehavior = 'auto';
  }

  try {
    const viewportHeight = window.innerHeight || 800;
    let scrollHeight = Math.max(
      doc.body?.scrollHeight || 0,
      doc.documentElement?.scrollHeight || 0
    );

    // If page content fits near a single viewport, trigger events and return
    if (scrollHeight <= viewportHeight * 1.15) {
      try {
        window.dispatchEvent(new Event('scroll'));
        window.dispatchEvent(new Event('resize'));
        harvestInViewElements(doc, viewportHeight);
      } catch {}
      return;
    }

    // Adaptively scale maxSteps and maxDurationMs for long pages (e.g. > 15,000px)
    let defaultMaxDurationMs = 2500;
    let defaultMaxSteps = 35;
    if (scrollHeight > 15000) {
      defaultMaxDurationMs = 4500;
      defaultMaxSteps = 70;
    }

    const maxDurationMs = options?.maxDurationMs ?? defaultMaxDurationMs;
    const stepDelayMs = options?.stepDelayMs ?? 40;
    const stepFraction = options?.stepFraction ?? 0.75;
    const maxSteps = options?.maxSteps ?? defaultMaxSteps;
    const useEasing = options?.easing !== false;

    const startTime = Date.now();
    const linearStep = Math.max(Math.floor(viewportHeight * stepFraction), 300);
    const targetDistance = Math.max(0, scrollHeight - viewportHeight);
    const estimatedSteps = useEasing
      ? Math.max(Math.ceil(targetDistance / (linearStep * 0.6)), 12)
      : Math.max(Math.ceil(targetDistance / linearStep), 1);
    const plannedSteps = Math.min(estimatedSteps, maxSteps);

    let currentY = 0;
    let stepCount = 0;

    // Harvest initial viewport
    harvestInViewElements(doc, viewportHeight);

    while (
      stepCount < plannedSteps &&
      Date.now() - startTime < maxDurationMs
    ) {
      stepCount++;

      scrollHeight = Math.max(
        doc.body?.scrollHeight || 0,
        doc.documentElement?.scrollHeight || 0
      );
      const currentMaxScroll = Math.max(0, scrollHeight - viewportHeight);

      if (useEasing) {
        const t = Math.min(stepCount / plannedSteps, 1);
        currentY = Math.round(currentMaxScroll * easeInOutSine(t));
      } else {
        currentY = Math.min(currentY + linearStep, currentMaxScroll);
      }

      window.scrollTo(0, currentY);

      try {
        window.dispatchEvent(new Event('scroll'));
      } catch {}

      // Progressive Viewport Harvester at each scroll step
      harvestInViewElements(doc, viewportHeight);

      await new Promise((resolve) => setTimeout(resolve, stepDelayMs));

      if (!useEasing && currentY >= currentMaxScroll) {
        break;
      }
    }

    // Brief settling pause at the bottom for IntersectionObserver callbacks and DOM mutations
    await new Promise((resolve) => setTimeout(resolve, 150));
    harvestInViewElements(doc, viewportHeight);
  } catch (err) {
    console.warn('[live-dom-preparer] Auto-scroll warning:', err);
  } finally {
    // Always restore original scroll position and CSS scroll-behavior
    try {
      window.scrollTo(origX, origY);
      window.dispatchEvent(new Event('scroll'));
    } catch {}
    if (htmlEl?.style) {
      htmlEl.style.scrollBehavior = originalScrollBehavior;
    }
  }
}

/**
 * Prepares the live document DOM for faithful archiving:
 * 1. Dispatches virtual scroll/resize events.
 * 2. Promotes deferred image attributes (data-lazy-src, data-original, thumburl, etc.) to src if placeholder.
 * 3. Injects <img> for thumbnail/preview containers lacking an <img> tag.
 * 4. Inlines data-bg/data-background into inline CSS background-image.
 * 5. Serializes canvas elements to images.
 * 6. Preserves interactive input values.
 */
export function prepareLiveDomForCapture(doc: Document): void {
  try {
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
  } catch {}

  // 1. Promote deferred image attributes to src if current src is empty or placeholder
  const images = Array.from(doc.querySelectorAll('img'));
  for (const img of images) {
    const src = img.getAttribute('src');
    if (!src || isPlaceholderUrl(src)) {
      for (const attr of GENERIC_LAZY_SRC_ATTRS) {
        const val = img.getAttribute(attr);
        if (val && !isPlaceholderUrl(val)) {
          img.setAttribute('src', val);
          break;
        }
      }
    }
    const srcset = img.getAttribute('srcset');
    if (!srcset || isPlaceholderUrl(srcset)) {
      for (const attr of GENERIC_LAZY_SRCSET_ATTRS) {
        const val = img.getAttribute(attr);
        if (val) {
          img.setAttribute('srcset', val);
          break;
        }
      }
    }
  }

  // 2. Promote deferred picture/media sources
  const sources = Array.from(doc.querySelectorAll('picture source, source'));
  for (const source of sources) {
    const srcset = source.getAttribute('srcset');
    if (!srcset || isPlaceholderUrl(srcset)) {
      for (const attr of GENERIC_LAZY_SRCSET_ATTRS) {
        const val = source.getAttribute(attr);
        if (val) {
          source.setAttribute('srcset', val);
          break;
        }
      }
    }
  }

  // 3. Promote elements with thumburl, data-thumb, data-thumbnail without an <img> child
  const thumbContainers = Array.from(doc.querySelectorAll('[thumburl], [data-thumb], [data-thumbnail]'));
  for (const el of thumbContainers) {
    if (el.tagName !== 'IMG' && !el.querySelector('img')) {
      const thumb = el.getAttribute('thumburl') || el.getAttribute('data-thumb') || el.getAttribute('data-thumbnail');
      if (thumb && !isPlaceholderUrl(thumb)) {
        const img = doc.createElement('img');
        img.setAttribute('src', thumb);
        const w = el.getAttribute('data-width') || el.getAttribute('width');
        const h = el.getAttribute('data-height') || el.getAttribute('height');
        if (w) img.setAttribute('width', w);
        if (h) img.setAttribute('height', h);
        const alt = el.getAttribute('alt') || el.getAttribute('data-alt');
        if (alt) img.setAttribute('alt', alt);
        el.appendChild(img);
      }
    }
  }

  // 4. Promote lazy background images (data-bg, data-background, data-background-image)
  const bgEls = Array.from(doc.querySelectorAll('[data-bg], [data-background], [data-background-image]'));
  for (const el of bgEls) {
    const bg = el.getAttribute('data-bg') || el.getAttribute('data-background') || el.getAttribute('data-background-image');
    if (bg && !isPlaceholderUrl(bg)) {
      const style = el.getAttribute('style') || '';
      if (!style.includes('background-image')) {
        el.setAttribute('style', `${style ? style.replace(/;?$/, '; ') : ''}background-image: url("${bg}");`);
      }
    }
  }

  // 5. Convert canvas drawings to static images
  const canvases = Array.from(doc.querySelectorAll('canvas'));
  for (const canvas of canvases) {
    try {
      const dataUrl = canvas.toDataURL('image/png');
      if (dataUrl && dataUrl.length > 30) {
        const img = doc.createElement('img');
        img.src = dataUrl;
        img.className = canvas.className;
        const style = canvas.getAttribute('style');
        if (style) img.setAttribute('style', style);
        canvas.parentNode?.replaceChild(img, canvas);
      }
    } catch {}
  }

  // 6. Preserve live input states
  doc.querySelectorAll('input, textarea, select').forEach((el: any) => {
    if (el.type === 'checkbox' || el.type === 'radio') {
      if (el.checked) el.setAttribute('checked', '');
      else el.removeAttribute('checked');
    } else if (el.tagName === 'SELECT') {
      Array.from(el.options).forEach((opt: any) => {
        if (opt.selected) opt.setAttribute('selected', '');
        else opt.removeAttribute('selected');
      });
    } else if (el.value) {
      el.setAttribute('value', el.value);
    }
  });

  // 7. Handle <video> elements with loop/muted or data-gif-url: promote blur posters to high-res
  const videos = Array.from(doc.querySelectorAll('video'));
  for (const video of videos) {
    if (isAnimatedMicroVideo(video)) {
      const poster = video.getAttribute('poster');
      if (!poster || isPlaceholderUrl(poster)) {
        const posterCandidates = [
          'data-poster',
          'data-poster-url',
          'data-high-res-poster',
          'data-orig-poster',
          ...GENERIC_LAZY_SRC_ATTRS
        ];
        for (const attr of posterCandidates) {
          const candidate = video.getAttribute(attr);
          if (candidate && !isPlaceholderUrl(candidate)) {
            video.setAttribute('poster', candidate);
            break;
          }
        }
      }
    }
  }
}
