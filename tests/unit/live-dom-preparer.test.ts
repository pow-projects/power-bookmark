import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  autoScrollToLoadDeferredContent,
  prepareLiveDomForCapture,
  harvestInViewElements
} from '../../src/lib/archive/live-dom-preparer';

describe('live-dom-preparer', () => {
  describe('autoScrollToLoadDeferredContent', () => {
    let originalScrollTo: any;
    let originalDispatchEvent: any;
    let scrollToCalls: Array<{ x: number; y: number }> = [];
    let dispatchedEvents: string[] = [];

    beforeEach(() => {
      scrollToCalls = [];
      dispatchedEvents = [];
      originalScrollTo = window.scrollTo;
      originalDispatchEvent = window.dispatchEvent;

      window.scrollTo = vi.fn((x: any, y?: any) => {
        if (typeof x === 'object') {
          scrollToCalls.push({ x: x.left, y: x.top });
        } else {
          scrollToCalls.push({ x, y: y ?? 0 });
        }
      }) as any;

      window.dispatchEvent = vi.fn((event: Event) => {
        dispatchedEvents.push(event.type);
        return true;
      }) as any;
    });

    afterEach(() => {
      window.scrollTo = originalScrollTo;
      window.dispatchEvent = originalDispatchEvent;
      vi.restoreAllMocks();
    });

    it('exits safely if doc is empty or invalid', async () => {
      await expect(autoScrollToLoadDeferredContent(null as any)).resolves.toBeUndefined();
    });

    it('triggers scroll and resize events quickly without stepping for short pages', async () => {
      const doc = document.implementation.createHTMLDocument('Short Page');
      Object.defineProperty(doc.documentElement, 'scrollHeight', { value: 600, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

      await autoScrollToLoadDeferredContent(doc);

      expect(dispatchedEvents).toContain('scroll');
      expect(dispatchedEvents).toContain('resize');
      // For short page, only the final position restoration scrollTo is invoked
      expect(scrollToCalls.length).toBe(1);
      expect(scrollToCalls[0]).toEqual({ x: 0, y: 0 });
    });

    it('smoothly scrolls with ease-in-out (slow start, fast middle, slow end) and restores initial scroll position', async () => {
      const doc = document.implementation.createHTMLDocument('Long Page');
      Object.defineProperty(doc.documentElement, 'scrollHeight', { value: 3000, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
      Object.defineProperty(window, 'scrollY', { value: 120, configurable: true });
      Object.defineProperty(window, 'scrollX', { value: 0, configurable: true });

      doc.documentElement.style.scrollBehavior = 'smooth';

      await autoScrollToLoadDeferredContent(doc, {
        stepDelayMs: 5,
        maxDurationMs: 1000
      });

      // Downward steps before restoration
      const steps = scrollToCalls.slice(0, scrollToCalls.length - 1);
      expect(steps.length).toBeGreaterThanOrEqual(10);

      // 1. Slow start: first step delta is small (ease-in)
      const firstDelta = steps[0].y;
      expect(firstDelta).toBeLessThan(100);

      // 2. Middle cruise: middle deltas are significantly larger than initial delta
      const midIdx = Math.floor(steps.length / 2);
      const midDelta = steps[midIdx].y - steps[midIdx - 1].y;
      expect(midDelta).toBeGreaterThan(firstDelta * 2);

      // 3. Slow end: final step decelerates into bottom target (2200 = 3000 - 800)
      const lastDownStep = steps[steps.length - 1].y;
      expect(lastDownStep).toBe(2200);
      const lastDelta = steps[steps.length - 1].y - steps[steps.length - 2].y;
      expect(lastDelta).toBeLessThan(midDelta);

      // The final call must restore original scroll position (120)
      const lastCall = scrollToCalls[scrollToCalls.length - 1];
      expect(lastCall.y).toBe(120);

      // Original scrollBehavior 'smooth' should be restored
      expect(doc.documentElement.style.scrollBehavior).toBe('smooth');
    });

    it('supports linear stepping when easing: false is specified', async () => {
      const doc = document.implementation.createHTMLDocument('Linear Page');
      Object.defineProperty(doc.documentElement, 'scrollHeight', { value: 3000, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

      await autoScrollToLoadDeferredContent(doc, {
        stepDelayMs: 2,
        easing: false
      });

      // Linear step: step is max(800 * 0.75, 300) = 600
      expect(scrollToCalls[0].y).toBe(600);
      expect(scrollToCalls[1].y).toBe(1200);
    });

    it('adaptively scales maxSteps and maxDurationMs for very long pages (> 15000px)', async () => {
      const doc = document.implementation.createHTMLDocument('Huge Page');
      Object.defineProperty(doc.documentElement, 'scrollHeight', { value: 20000, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

      await autoScrollToLoadDeferredContent(doc, { stepDelayMs: 1 });

      // Step is 600, for 20000px with default maxSteps 70, it steps ~34 times
      expect(scrollToCalls.length).toBeGreaterThanOrEqual(30);
    });

    it('progressive viewport harvester captures rendered currentSrc and promotes lazy attributes during auto-scroll', async () => {
      const doc = document.implementation.createHTMLDocument('Harvester Page');
      Object.defineProperty(doc.documentElement, 'scrollHeight', { value: 2000, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

      doc.body.innerHTML = `
        <img id="loaded-img" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" />
        <img id="lazy-blur-img" src="https://example.com/blur.jpg" data-lazy-src="https://example.com/crisp.png" />
        <video id="vid1" src=""></video>
      `;

      const loadedImg = doc.getElementById('loaded-img') as HTMLImageElement;
      Object.defineProperty(loadedImg, 'complete', { value: true, configurable: true });
      Object.defineProperty(loadedImg, 'naturalWidth', { value: 1200, configurable: true });
      Object.defineProperty(loadedImg, 'currentSrc', { value: 'https://example.com/actual-rendered.jpg', configurable: true });

      const vid1 = doc.getElementById('vid1') as HTMLVideoElement;
      Object.defineProperty(vid1, 'currentSrc', { value: 'https://example.com/actual-video.mp4', configurable: true });

      await autoScrollToLoadDeferredContent(doc, { stepDelayMs: 1 });

      // In-view rendered img should have its src updated from currentSrc and marked with data-pb-captured
      expect(loadedImg.getAttribute('src')).toBe('https://example.com/actual-rendered.jpg');
      expect(loadedImg.getAttribute('data-pb-captured')).toBe('true');

      // Blur placeholder should be promoted to crisp.png
      const blurImg = doc.getElementById('lazy-blur-img') as HTMLImageElement;
      expect(blurImg.getAttribute('src')).toBe('https://example.com/crisp.png');

      // Video should have src updated from currentSrc
      expect(vid1.getAttribute('src')).toBe('https://example.com/actual-video.mp4');
    });
  });

  describe('prepareLiveDomForCapture', () => {
    it('promotes generic lazy image attributes to src when src is empty or a placeholder', () => {
      const doc = document.implementation.createHTMLDocument('Test');
      doc.body.innerHTML = `
        <img id="img1" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-lazy-src="https://cdn.example.com/real1.jpg" />
        <img id="img2" src="" data-original="https://cdn.example.com/real2.jpg" />
        <img id="img3" src="https://cdn.example.com/already-real.jpg" data-src="https://cdn.example.com/ignore.jpg" />
        <img id="img4" thumburl="https://postfiles.pstatic.net/naver_post.jpg?type=w2" src="" />
      `;

      prepareLiveDomForCapture(doc);

      expect(doc.getElementById('img1')?.getAttribute('src')).toBe('https://cdn.example.com/real1.jpg');
      expect(doc.getElementById('img2')?.getAttribute('src')).toBe('https://cdn.example.com/real2.jpg');
      expect(doc.getElementById('img3')?.getAttribute('src')).toBe('https://cdn.example.com/already-real.jpg');
      expect(doc.getElementById('img4')?.getAttribute('src')).toBe('https://postfiles.pstatic.net/naver_post.jpg?type=w2');
    });

    it('injects <img> into thumbnail / preview container elements lacking <img> children', () => {
      const doc = document.implementation.createHTMLDocument('Test');
      doc.body.innerHTML = `
        <span id="thumb-span" class="_img" thumburl="https://postfiles.pstatic.net/image.jpg?type=w2" data-width="640" data-height="480"></span>
        <div id="thumb-div" data-thumb="https://example.com/preview.png"></div>
        <div id="already-has-img" thumburl="https://example.com/ignore.png">
          <img src="https://example.com/existing.jpg" />
        </div>
      `;

      prepareLiveDomForCapture(doc);

      const spanImg = doc.querySelector('#thumb-span img');
      expect(spanImg).not.toBeNull();
      expect(spanImg?.getAttribute('src')).toBe('https://postfiles.pstatic.net/image.jpg?type=w2');
      expect(spanImg?.getAttribute('width')).toBe('640');
      expect(spanImg?.getAttribute('height')).toBe('480');

      const divImg = doc.querySelector('#thumb-div img');
      expect(divImg).not.toBeNull();
      expect(divImg?.getAttribute('src')).toBe('https://example.com/preview.png');

      const existingImgs = doc.querySelectorAll('#already-has-img img');
      expect(existingImgs.length).toBe(1);
      expect(existingImgs[0].getAttribute('src')).toBe('https://example.com/existing.jpg');
    });

    it('inlines lazy background images from data-bg and data-background', () => {
      const doc = document.implementation.createHTMLDocument('Test');
      doc.body.innerHTML = `
        <div id="bg1" data-bg="https://cdn.example.com/bg1.jpg"></div>
        <div id="bg2" data-background="https://cdn.example.com/bg2.png" style="color: red;"></div>
      `;

      prepareLiveDomForCapture(doc);

      expect(doc.getElementById('bg1')?.getAttribute('style')).toContain('background-image: url("https://cdn.example.com/bg1.jpg")');
      const bg2Style = doc.getElementById('bg2')?.getAttribute('style');
      expect(bg2Style).toContain('color: red;');
      expect(bg2Style).toContain('background-image: url("https://cdn.example.com/bg2.png")');
    });

    it('preserves form input values and selected option attributes', () => {
      const doc = document.implementation.createHTMLDocument('Test');
      doc.body.innerHTML = `
        <input type="text" id="t1" />
        <input type="checkbox" id="c1" />
        <select id="s1">
          <option value="opt1">Opt 1</option>
          <option value="opt2" id="opt2">Opt 2</option>
        </select>
      `;

      const input = doc.getElementById('t1') as HTMLInputElement;
      input.value = 'User Typed Text';

      const checkbox = doc.getElementById('c1') as HTMLInputElement;
      checkbox.checked = true;

      const select = doc.getElementById('s1') as HTMLSelectElement;
      select.value = 'opt2';

      prepareLiveDomForCapture(doc);

      expect(doc.getElementById('t1')?.getAttribute('value')).toBe('User Typed Text');
      expect(doc.getElementById('c1')?.hasAttribute('checked')).toBe(true);
      expect(doc.getElementById('opt2')?.hasAttribute('selected')).toBe(true);
    });

    it('promotes blur posters on animated micro-video elements (loop+muted, _gifmp4, data-gif-url) to high-res', () => {
      const doc = document.implementation.createHTMLDocument('Video Poster Test');
      doc.body.innerHTML = `
        <video id="v1" loop muted poster="https://example.com/poster_blur.jpg" data-poster="https://example.com/highres_poster1.png"></video>
        <video id="v2" class="_gifmp4" poster="https://example.com/m_blur.jpg" data-high-res-poster="https://example.com/highres_poster2.png"></video>
        <video id="v3" data-gif-url="https://example.com/anim.gif" poster="" data-poster-url="https://example.com/highres_poster3.png"></video>
        <video id="v-regular" controls poster="https://example.com/regular_blur.jpg" data-poster="https://example.com/ignored.png"></video>
      `;

      prepareLiveDomForCapture(doc);

      expect(doc.getElementById('v1')?.getAttribute('poster')).toBe('https://example.com/highres_poster1.png');
      expect(doc.getElementById('v2')?.getAttribute('poster')).toBe('https://example.com/highres_poster2.png');
      expect(doc.getElementById('v3')?.getAttribute('poster')).toBe('https://example.com/highres_poster3.png');
      // Regular non-micro video poster remains unchanged
      expect(doc.getElementById('v-regular')?.getAttribute('poster')).toBe('https://example.com/regular_blur.jpg');
    });
  });
});
