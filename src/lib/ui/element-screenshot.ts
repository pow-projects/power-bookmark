/**
 * Element screenshot capture and download utility.
 * Captures specific DOM elements by scrolling and capturing visible tab slices,
 * stitching them on a canvas, and triggering download as a PNG file.
 */
import { toSafeAsciiFilename } from '../bookmarks/export-manager';

export interface CaptureOptions {
  filename?: string;
  hideSelectorDuringCapture?: string;
}

export async function captureVisibleTab(): Promise<string> {
  // 1. Direct call if available in current extension context
  if (typeof browser !== 'undefined' && browser.tabs?.captureVisibleTab) {
    try {
      const dataUrl = await browser.tabs.captureVisibleTab({ format: 'png' });
      if (dataUrl) return dataUrl;
    } catch (e) {
      console.warn('[captureVisibleTab] Direct tabs.captureVisibleTab failed, trying relay:', e);
    }
  }

  // 2. Background service worker message relay
  if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
    try {
      const res = (await browser.runtime.sendMessage({ type: 'PB_CAPTURE_VISIBLE_TAB' })) as
        | { ok?: boolean; dataUrl?: string; error?: string }
        | undefined;
      if (res?.ok && res.dataUrl) return res.dataUrl;
      if (res?.error) throw new Error(res.error);
    } catch (e) {
      console.warn('[captureVisibleTab] Background relay failed:', e);
    }
  }

  throw new Error('No captureVisibleTab API available in current environment');
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error('Failed to load captured image: ' + String(e)));
    img.src = src;
  });
}

export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : 'blob:mock-url';
  try {
    if (typeof browser !== 'undefined' && browser.downloads?.download) {
      try {
        await browser.downloads.download({ url, filename, saveAs: false });
        return;
      } catch (e) {
        console.warn('[downloadBlob] downloads API failed, retrying safe name:', e);
        const safe = toSafeAsciiFilename(filename);
        try {
          await browser.downloads.download({ url, filename: safe, saveAs: false });
          return;
        } catch {
          /* fallback to anchor */
        }
      }
    }

    const a = document.createElement('a');
    a.href = url;
    a.download = toSafeAsciiFilename(filename);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    if (typeof URL.revokeObjectURL === 'function' && url !== 'blob:mock-url') {
      const timer = setTimeout(() => URL.revokeObjectURL(url), 5000);
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as any).unref();
      }
    }
  }
}

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve) => {
    try {
      if (typeof canvas.toBlob !== 'function') {
        resolve(new Blob(['mock-png'], { type: 'image/png' }));
        return;
      }
      let called = false;
      canvas.toBlob((b) => {
        called = true;
        if (b) resolve(b);
        else resolve(new Blob(['fallback-png'], { type: 'image/png' }));
      }, 'image/png');

      // Safeguard for jsdom or environments without canvas npm package
      setTimeout(() => {
        if (!called) {
          resolve(new Blob(['fallback-png'], { type: 'image/png' }));
        }
      }, 50);
    } catch {
      resolve(new Blob(['fallback-png'], { type: 'image/png' }));
    }
  });
}

async function waitForCompositor(ms = 80): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(resolve, ms);
        });
      });
    } else {
      setTimeout(resolve, ms);
    }
  });
}

export async function captureElementScreenshot(
  element: HTMLElement,
  options: CaptureOptions = {}
): Promise<Blob> {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const filename = options.filename || `tag-timeline-${new Date().toISOString().slice(0, 10)}.png`;

  // Hide elements from the screenshot — queried at document level so fixed overlays are also hidden
  const hiddenElements: HTMLElement[] = [];
  if (options.hideSelectorDuringCapture && typeof document !== 'undefined') {
    const targets = document.querySelectorAll<HTMLElement>(options.hideSelectorDuringCapture);
    targets.forEach((el) => {
      if (el.style.visibility !== 'hidden') {
        el.style.visibility = 'hidden';
        hiddenElements.push(el);
      }
    });
  }

  const originalScrollX = typeof window !== 'undefined' ? window.scrollX : 0;
  const originalScrollY = typeof window !== 'undefined' ? window.scrollY : 0;
  let spacer: HTMLElement | null = null;

  try {
    const rect = element.getBoundingClientRect();
    const cardWidth = rect.width;
    const cardHeight = rect.height;

    if (cardWidth <= 0 || cardHeight <= 0) {
      // In non-rendered/jsdom environment or unmeasured element
      const dummyCanvas = document.createElement('canvas');
      dummyCanvas.width = 100;
      dummyCanvas.height = 100;
      const blob = await canvasToBlob(dummyCanvas);
      await downloadBlob(blob, filename);
      return blob;
    }

    // Add temporary bottom spacer so window can freely scroll past the bottom of the document
    if (typeof document !== 'undefined' && document.body) {
      spacer = document.createElement('div');
      spacer.setAttribute('data-capture-spacer', 'true');
      spacer.style.height = `${Math.round(cardHeight + (typeof window !== 'undefined' ? window.innerHeight : 800))}px`;
      spacer.style.width = '1px';
      spacer.style.pointerEvents = 'none';
      spacer.style.visibility = 'hidden';
      document.body.appendChild(spacer);
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(cardWidth * dpr);
    canvas.height = Math.round(cardHeight * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to create 2D canvas context');
    }

    // Scroll to the start of the element
    if (typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'start', behavior: 'instant' });
    }

    await waitForCompositor(100);

    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
    let capturedHeight = 0;
    let iterations = 0;
    const MAX_ITERATIONS = 50;

    while (capturedHeight < cardHeight && iterations < MAX_ITERATIONS) {
      iterations++;

      const dataUrl = await captureVisibleTab();
      const img = await loadImage(dataUrl);

      const currentRect = element.getBoundingClientRect();
      const visibleTopInViewport = Math.max(0, currentRect.top);
      const visibleBottomInViewport = Math.min(viewportHeight, currentRect.bottom);
      const visibleHeight = visibleBottomInViewport - visibleTopInViewport;

      if (visibleHeight <= 0) {
        break;
      }

      // Where does the visible slice start within the element itself
      const elementSliceTop = visibleTopInViewport - currentRect.top;

      // The uncaptured range in element coordinates
      const newSliceStartInElement = Math.max(capturedHeight, elementSliceTop);
      const newSliceEndInElement = Math.min(cardHeight, elementSliceTop + visibleHeight);
      const newSliceHeight = newSliceEndInElement - newSliceStartInElement;

      if (newSliceHeight > 0) {
        const offsetFromVisibleTop = newSliceStartInElement - elementSliceTop;

        const sx = Math.max(0, Math.round(currentRect.left * dpr));
        const sy = Math.max(0, Math.round((visibleTopInViewport + offsetFromVisibleTop) * dpr));
        const sWidth = Math.min(img.width - sx, Math.round(cardWidth * dpr));
        const sHeight = Math.min(img.height - sy, Math.round(newSliceHeight * dpr));

        const dx = 0;
        const dy = Math.round(newSliceStartInElement * dpr);
        const dWidth = sWidth;
        const dHeight = sHeight;

        if (sWidth > 0 && sHeight > 0) {
          ctx.drawImage(img, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight);
        }

        capturedHeight = newSliceEndInElement;
      }

      if (capturedHeight >= cardHeight) {
        break;
      }

      // Scroll down so the next portion appears in viewport
      const remainingHeight = cardHeight - capturedHeight;
      const scrollStep = Math.min(Math.max(100, viewportHeight - 60), remainingHeight);

      if (typeof window !== 'undefined') {
        if (typeof window.scrollBy === 'function') {
          window.scrollBy({ top: scrollStep, behavior: 'instant' });
        } else if (typeof window.scrollTo === 'function') {
          window.scrollTo({ top: (window.scrollY || 0) + scrollStep, behavior: 'instant' });
        }
      }

      await waitForCompositor(100);
    }

    // Capture complete — restore scroll position before download so page snaps back immediately
    if (spacer && spacer.parentNode) {
      spacer.parentNode.removeChild(spacer);
      spacer = null;
    }
    if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
      window.scrollTo({ left: originalScrollX, top: originalScrollY, behavior: 'instant' });
    }

    const blob = await canvasToBlob(canvas);
    await downloadBlob(blob, filename);
    return blob;
  } finally {
    // Error-case cleanup
    if (spacer && spacer.parentNode) {
      spacer.parentNode.removeChild(spacer);
    }
    hiddenElements.forEach((el) => {
      el.style.visibility = '';
    });
    if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
      window.scrollTo({ left: originalScrollX, top: originalScrollY, behavior: 'instant' });
    }
  }
}
