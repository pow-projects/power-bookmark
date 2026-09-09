import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  capturePageHtml,
  archiveBookmark,
  decompressArchiveHtml,
  ensureFullViewportHtml,
  isPlaceholderUrl,
  ConcurrencyLimiter,
  CONCURRENT_FETCH_LIMIT
} from '../../src/lib/archive/page-capture';
import db from '../../src/lib/db';

// db mock (archiveBookmark uses db.transaction + db.archivedPages)
vi.mock('../../src/lib/db', () => {
  const mockArchivedPages = {
    where: vi.fn(() => ({ equals: vi.fn(() => ({ delete: vi.fn().mockResolvedValue(0) })) })),
    add: vi.fn().mockResolvedValue(1)
  };
  const mockBookmarks = {
    get: vi.fn().mockResolvedValue({ id: 1 })
  };
  const mockDb = {
    archivedPages: mockArchivedPages,
    bookmarks: mockBookmarks,
    transaction: vi.fn(async (_mode: string, _table: any, fn: () => Promise<any>) => fn()),
    on: vi.fn()
  };
  return { db: mockDb, default: mockDb };
});

const PAGE_URL = 'https://example.com/page';
const TITLE = 'Test Page';

describe('ConcurrencyLimiter', () => {
  it('has default limit of 4', () => {
    expect(CONCURRENT_FETCH_LIMIT).toBe(4);
    const limiter = new ConcurrencyLimiter();
    expect(limiter.activeCount).toBe(0);
  });

  it('limits concurrent executions to max limit and drains queue', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let maxObserved = 0;
    const completed: number[] = [];

    const makeTask = (id: number, delayMs: number) => {
      return limiter.run(async () => {
        active++;
        maxObserved = Math.max(maxObserved, active);
        await new Promise(r => setTimeout(r, delayMs));
        active--;
        completed.push(id);
        return id;
      });
    };

    const results = await Promise.all([
      makeTask(1, 30),
      makeTask(2, 30),
      makeTask(3, 10),
      makeTask(4, 10)
    ]);

    expect(results).toEqual([1, 2, 3, 4]);
    expect(maxObserved).toBe(2);
    expect(completed.length).toBe(4);
    expect(limiter.activeCount).toBe(0);
    expect(limiter.queueLength).toBe(0);
  });
});

describe('capturePageHtml', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes <script> tags', async () => {
    const html = `<html><head></head><body><script>alert(1)</script><p>hi</p></body></html>`;
    const blob = await capturePageHtml(html, PAGE_URL, TITLE);
    const text = await blob.text();
    expect(text).not.toContain('<script');
    expect(text).toContain('<p>hi</p>');
  });

  it('removes inline on* event handlers', async () => {
    const html = `<html><head></head><body><button onclick="x()">c</button></body></html>`;
    const blob = await capturePageHtml(html, PAGE_URL, TITLE);
    const text = await blob.text();
    expect(text).not.toContain('onclick');
  });

  it('injects <base> and meta comment into <head>', async () => {
    const html = `<html><head><title>t</title></head><body>x</body></html>`;
    const blob = await capturePageHtml(html, PAGE_URL, TITLE);
    const text = await blob.text();
    expect(text).toContain('<base');
    expect(text).toContain('PowerBookmark Archive');
  });

  it('inlines iframe via srcdoc from iframeSources', async () => {
    const iframeDoc = '<html><head></head><body><p>frame</p></body></html>';
    const html = `<html><head></head><body><iframe src="https://example.com/frame"></iframe></body></html>`;
    const blob = await capturePageHtml(html, PAGE_URL, TITLE, '', { 'https://example.com/frame': iframeDoc });
    const text = await blob.text();
    expect(text).toContain('srcdoc');
    expect(text).toContain('<p>frame</p>');
    expect(text).not.toContain('src="https://example.com/frame"');
  });

  it('returns full HTML when compress=false (default)', async () => {
    const html = `<html><head></head><body><p>content</p></body></html>`;
    const blob = await capturePageHtml(html, PAGE_URL, TITLE);
    const text = await blob.text();
    expect(text).toContain('<p>content</p>');
    expect(text).not.toContain('DecompressionStream');
  });

  it('archiveBookmark stores blob in db', async () => {
    const html = `<html><head></head><body><p>z</p></body></html>`;
    const id = await archiveBookmark(5, html, PAGE_URL, TITLE);
    expect(id).toBe(1);
    expect(db.archivedPages.add).toHaveBeenCalledOnce();
  });

  it('archiveBookmark retries on AbortError and succeeds', async () => {
    const html = `<html><head></head><body><p>retry</p></body></html>`;
    let callCount = 0;
    const origTransaction = db.transaction as any;
    origTransaction.mockImplementation(async (_mode: string, _table: any, fn: () => Promise<any>) => {
      callCount++;
      if (callCount === 1) {
        const err: any = new Error('The transaction was aborted');
        err.name = 'AbortError';
        throw err;
      }
      return fn();
    });

    const id = await archiveBookmark(5, html, PAGE_URL, TITLE);
    expect(id).toBe(1);
    expect(callCount).toBe(2);
  });

  it('광고 iframe을 출력에서 제거한다', async () => {
    const html = `<html><head></head><body><iframe src="https://criteo.com/ad"></iframe><p>content</p></body></html>`;
    const blob = await capturePageHtml(html, PAGE_URL, TITLE);
    const text = await blob.text();
    expect(text).not.toContain('criteo.com');
    expect(text).toContain('<p>content</p>');
  });

  it('트래킹 픽셀을 출력에서 제거한다', async () => {
    const html = `<html><head></head><body><img src="https://tracker.com/pixel.gif" width="1" height="1"><p>content</p></body></html>`;
    const blob = await capturePageHtml(html, PAGE_URL, TITLE);
    const text = await blob.text();
    expect(text).not.toContain('pixel.gif');
    expect(text).toContain('<p>content</p>');
  });

  it('<article> 내부 콘텐츠는 광고와 유사한 클래스명이 있어도 보존한다', async () => {
    const html = `<html><head></head><body><article><div class="advertisement">real content</div><img src="https://tracker.com/pixel.gif" width="1" height="1"></article></body></html>`;
    const blob = await capturePageHtml(html, PAGE_URL, TITLE);
    const text = await blob.text();
    expect(text).toContain('real content');
    expect(text).toContain('advertisement');
  });

  it('차단된 URL은 fetch하지 않는다', async () => {
    const globalFetch = global.fetch;
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    );
    global.fetch = mockFetch as any;
    
    try {
      const html = `<html><head></head><body><img src="https://google-analytics.com/collect"></body></html>`;
      await capturePageHtml(html, PAGE_URL, TITLE);
      
      expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining('google-analytics.com'), expect.anything());
    } finally {
      global.fetch = globalFetch;
    }
  });

  it('동일 세션 내 중복 URL에 대해 fetch를 1회만 수행하고 공유한다 (URL Deduplication)', async () => {
    const globalFetch = global.fetch;
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'content-type': 'image/png' }
      })
    );
    global.fetch = mockFetch as any;

    try {
      const html = `
        <html>
          <head>
            <style>
              .icon { background-image: url("https://example.com/shared-logo.png"); }
            </style>
          </head>
          <body>
            <img src="https://example.com/shared-logo.png" />
            <img src="https://example.com/shared-logo.png" />
            <picture>
              <source srcset="https://example.com/shared-logo.png 1x" />
            </picture>
          </body>
        </html>
      `;
      const blob = await capturePageHtml(html, PAGE_URL, TITLE);
      const text = await blob.text();

      // shared-logo.png should only be fetched ONCE across style, img, picture/source
      const sharedLogoFetches = mockFetch.mock.calls.filter(call =>
        call[0]?.toString().includes('shared-logo.png')
      );
      expect(sharedLogoFetches.length).toBe(1);
      expect(text).toContain('data:image/png;base64,');
    } finally {
      global.fetch = globalFetch;
    }
  });

  it('동시 리소스 요청 수가 최대 CONCURRENT_FETCH_LIMIT(4)를 넘지 않는다', async () => {
    const globalFetch = global.fetch;
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const mockFetch = vi.fn().mockImplementation(async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise(r => setTimeout(r, 20));
      concurrentCount--;
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'content-type': 'image/png' }
      });
    });
    global.fetch = mockFetch as any;

    try {
      const images = Array.from({ length: 12 }, (_, i) => `<img src="https://example.com/img_${i}.png" />`).join('\n');
      const html = `<html><head></head><body>${images}</body></html>`;
      await capturePageHtml(html, PAGE_URL, TITLE);

      expect(maxConcurrent).toBeLessThanOrEqual(CONCURRENT_FETCH_LIMIT);
      expect(mockFetch).toHaveBeenCalledTimes(12);
    } finally {
      global.fetch = globalFetch;
    }
  });

  it('video/audio/embed/object 스트림은 Data URI로 변환하지 않고 원본 URL 유지, video poster와 img는 인라인화한다', async () => {
    const globalFetch = global.fetch;
    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'content-type': 'image/png' }
      });
    });
    global.fetch = mockFetch as any;

    try {
      const html = `
        <html>
          <head></head>
          <body>
            <video src="https://example.com/stream.mp4" poster="https://example.com/poster.jpg">
              <source src="https://example.com/fallback.webm" type="video/webm">
            </video>
            <audio src="https://example.com/podcast.mp3">
              <source src="https://example.com/audio.ogg" type="audio/ogg">
            </audio>
            <embed src="https://example.com/plugin.swf">
            <object data="https://example.com/document.pdf"></object>
            <img src="https://example.com/photo.jpg">
          </body>
        </html>
      `;
      const blob = await capturePageHtml(html, PAGE_URL, TITLE);
      const text = await blob.text();

      // video / audio / embed / object media streams MUST NOT be fetched as Data URI
      expect(text).toContain('src="https://example.com/stream.mp4"');
      expect(text).toContain('src="https://example.com/fallback.webm"');
      expect(text).toContain('src="https://example.com/podcast.mp3"');
      expect(text).toContain('src="https://example.com/audio.ogg"');
      expect(text).toContain('src="https://example.com/plugin.swf"');
      expect(text).toContain('data="https://example.com/document.pdf"');

      // Video poster and img SHOULD be fetched and inlined as Data URI
      expect(text).toContain('poster="data:image/png;base64,');
      expect(text).toContain('src="data:image/png;base64,');

      // Verify fetch was only called for poster and photo, not video/audio/embed/object streams
      const fetchedUrls = mockFetch.mock.calls.map(c => c[0].toString());
      expect(fetchedUrls).toContain('https://example.com/poster.jpg');
      expect(fetchedUrls).toContain('https://example.com/photo.jpg');
      expect(fetchedUrls).not.toContain('https://example.com/stream.mp4');
      expect(fetchedUrls).not.toContain('https://example.com/fallback.webm');
      expect(fetchedUrls).not.toContain('https://example.com/podcast.mp3');
      expect(fetchedUrls).not.toContain('https://example.com/audio.ogg');
      expect(fetchedUrls).not.toContain('https://example.com/plugin.swf');
      expect(fetchedUrls).not.toContain('https://example.com/document.pdf');
    } finally {
      global.fetch = globalFetch;
    }
  });

  it('fetch 실패 또는 타임아웃 시 원본 URL로 안전하게 fallback된다', async () => {
    const globalFetch = global.fetch;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('fail.png')) {
        return new Response(null, { status: 404, statusText: 'Not Found' });
      }
      if (url.includes('timeout.png')) {
        throw new Error('Network timeout');
      }
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'content-type': 'image/png' }
      });
    });
    global.fetch = mockFetch as any;

    try {
      const html = `
        <html>
          <head></head>
          <body>
            <img src="https://example.com/fail.png" />
            <img src="https://example.com/timeout.png" />
            <img src="https://example.com/good.png" />
          </body>
        </html>
      `;
      const blob = await capturePageHtml(html, PAGE_URL, TITLE);
      const text = await blob.text();

      expect(text).toContain('src="https://example.com/fail.png"');
      expect(text).toContain('src="https://example.com/timeout.png"');
      expect(text).toContain('src="data:image/png;base64,');
    } finally {
      global.fetch = globalFetch;
    }
  });
});

describe('ensureFullViewportHtml', () => {
  it('injects viewport meta tag if missing without forcing margin/padding overrides', () => {
    const html = `<html><head><title>Test</title></head><body><div style="margin: 5em auto;">Hello</div></body></html>`;
    const result = ensureFullViewportHtml(html);
    expect(result).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
    expect(result).not.toContain('margin: 0 !important');
    expect(result).not.toContain('pb-viewport-style');
    expect(result).toContain('margin: 5em auto;');
  });

  it('updates existing viewport meta tag to width=device-width, initial-scale=1.0', () => {
    const html = `<html><head><meta name="viewport" content="width=360, initial-scale=0.5"></head><body><p>Test</p></body></html>`;
    const result = ensureFullViewportHtml(html);
    expect(result).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
  });

  it('captures HTML with viewport meta tag in capturePageHtml preserving original element margins', async () => {
    const html = `<html><head></head><body><div style="margin: 5em auto;">Captured content</div></body></html>`;
    const blob = await capturePageHtml(html, PAGE_URL, TITLE);
    const text = await blob.text();
    expect(text).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
    expect(text).not.toContain('margin: 0 !important');
    expect(text).toContain('margin: 5em auto;');
  });
});

describe('decompressArchiveHtml', () => {
  it('decompresses gzip self-extracting HTML Blob to plain HTML with viewport correction', async () => {
    const html = `<html><head></head><body><p>compressed content</p></body></html>`;
    const compressedBlob = await capturePageHtml(html, PAGE_URL, TITLE, '', {}, true);
    const decompressedBlob = await decompressArchiveHtml(compressedBlob);
    const text = await decompressedBlob.text();
    expect(text).toContain('<p>compressed content</p>');
    expect(text).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
    expect(text).not.toContain('DecompressionStream');
  });

  it('returns original blob intact when given uncompressed HTML Blob', async () => {
    const html = `<html><head></head><body><p>normal html</p></body></html>`;
    const uncompressedBlob = await capturePageHtml(html, PAGE_URL, TITLE, '', {}, false);
    const resultBlob = await decompressArchiveHtml(uncompressedBlob);
    expect(resultBlob).toBe(uncompressedBlob);
    const text = await resultBlob.text();
    expect(text).toContain('<p>normal html</p>');
  });

  it('returns original blob on invalid or corrupt payload Blob without throwing', async () => {
    const corruptLoaderHtml = `<!DOCTYPE html><html><body><script>const p="invalid_base64_or_corrupt_gzip!!!"; new DecompressionStream('gzip');</script></body></html>`;
    const corruptBlob = new Blob([corruptLoaderHtml], { type: 'text/html' });
    const resultBlob = await decompressArchiveHtml(corruptBlob);
    expect(resultBlob).toBe(corruptBlob);
  });

  describe('generic lazy-load & asset capture', () => {
    let globalFetch: typeof global.fetch;
    let mockFetch: any;

    beforeEach(() => {
      globalFetch = global.fetch;
      mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(new Uint8Array([137, 80, 78, 71]), {
            status: 200,
            headers: { 'content-type': 'image/png' }
          })
        )
      );
      global.fetch = mockFetch;
    });

    afterEach(() => {
      global.fetch = globalFetch;
    });

    it('isPlaceholderUrl correctly identifies empty, 1x1, and placeholder URLs', () => {
      expect(isPlaceholderUrl('')).toBe(true);
      expect(isPlaceholderUrl(null)).toBe(true);
      expect(isPlaceholderUrl(undefined)).toBe(true);
      expect(isPlaceholderUrl('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')).toBe(true);
      expect(isPlaceholderUrl('https://ssl.pstatic.net/static/blog/blank.gif')).toBe(true);
      expect(isPlaceholderUrl('https://example.com/assets/pixel.gif')).toBe(true);
      expect(isPlaceholderUrl('https://example.com/images/spacer.png')).toBe(true);
      expect(isPlaceholderUrl('https://example.com/1x1.png')).toBe(true);

      expect(isPlaceholderUrl('https://example.com/photo.jpg')).toBe(false);
      expect(isPlaceholderUrl('https://mblogthumb-phinf.pstatic.net/test.jpg?type=w2')).toBe(false);
    });

    it('promotes data-lazy-src when src is a 1x1 transparent GIF placeholder', async () => {
      const html = `<html><body><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-lazy-src="https://example.com/actual-image.png"></body></html>`;
      const blob = await capturePageHtml(html, PAGE_URL, TITLE);
      const text = await blob.text();
      // Should have inlined the real image as data URI
      expect(text).toContain('data:image/png;base64,');
      expect(text).not.toContain('data-lazy-src');
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/actual-image.png', expect.objectContaining({
        referrer: PAGE_URL,
        referrerPolicy: 'no-referrer-when-downgrade'
      }));
    });

    it('promotes data-original when src is a static blank.gif placeholder', async () => {
      const html = `<html><body><img src="https://example.com/blank.gif" data-original="https://example.com/photo.png"></body></html>`;
      const blob = await capturePageHtml(html, PAGE_URL, TITLE);
      const text = await blob.text();
      expect(text).toContain('data:image/png;base64,');
      expect(text).not.toContain('data-original');
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/photo.png', expect.objectContaining({
        referrer: PAGE_URL
      }));
    });

    it('inlines CSS background images inside style attribute on arbitrary elements', async () => {
      const html = `<html><body><div style="background-image: url('https://example.com/hero.png'); width: 100px;">Hello</div></body></html>`;
      const blob = await capturePageHtml(html, PAGE_URL, TITLE);
      const text = await blob.text();
      expect(text).toContain('style="background-image: url(&quot;data:image/png;base64,');
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/hero.png', expect.objectContaining({
        referrer: PAGE_URL
      }));
    });

    it('promotes data-lazy-srcset when srcset is empty', async () => {
      const html = `<html><body><img data-lazy-srcset="https://example.com/actual-image.png 1x"></body></html>`;
      const blob = await capturePageHtml(html, PAGE_URL, TITLE);
      const text = await blob.text();
      expect(text).toContain('srcset="data:image/png;base64,');
      expect(text).not.toContain('data-lazy-srcset');
    });

    it('promotes thumburl attribute on img tags', async () => {
      const html = `<html><body><img thumburl="https://example.com/thumb-img.png" src=""></body></html>`;
      const blob = await capturePageHtml(html, PAGE_URL, TITLE);
      const text = await blob.text();
      expect(text).toContain('src="data:image/png;base64,');
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/thumb-img.png', expect.objectContaining({
        referrer: PAGE_URL
      }));
    });

    it('synthesizes and inlines <img> for thumbnail container elements lacking <img> children', async () => {
      const html = `<html><body><span class="_img" thumburl="https://example.com/span-thumb.png" data-width="800" data-height="600"></span></body></html>`;
      const blob = await capturePageHtml(html, PAGE_URL, TITLE);
      const text = await blob.text();
      expect(text).toContain('<img src="data:image/png;base64,');
      expect(text).toContain('width="800"');
      expect(text).toContain('height="600"');
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/span-thumb.png', expect.objectContaining({
        referrer: PAGE_URL
      }));
    });

    it('isPlaceholderUrl correctly identifies blur and LQIP URLs', () => {
      expect(isPlaceholderUrl('https://postfiles.pstatic.net/test.jpg?type=w800_blur')).toBe(true);
      expect(isPlaceholderUrl('https://postfiles.pstatic.net/test.jpg?type=m_blur')).toBe(true);
      expect(isPlaceholderUrl('https://example.com/images/photo_blur.jpg')).toBe(true);
      expect(isPlaceholderUrl('https://example.com/images/banner.jpg?blur=10')).toBe(true);
      expect(isPlaceholderUrl('https://example.com/thumb.jpg?lowres=true')).toBe(true);
      expect(isPlaceholderUrl('https://example.com/pic.jpg?preview=1')).toBe(true);
      expect(isPlaceholderUrl('https://example.com/pic.jpg?thumb=1')).toBe(true);

      // Full-res URLs are NOT placeholders
      expect(isPlaceholderUrl('https://example.com/photo.jpg')).toBe(false);
      expect(isPlaceholderUrl('https://mblogthumb-phinf.pstatic.net/test.jpg?type=w2')).toBe(false);
      expect(isPlaceholderUrl('https://postfiles.pstatic.net/test.jpg?type=w966')).toBe(false);
    });

    it('promotes high-res lazy attributes over blur/LQIP src', async () => {
      const html = `<html><body>
        <img id="i1" src="https://example.com/image.jpg?type=w800_blur" data-lazy-src="https://example.com/highres1.png" />
        <img id="i2" src="https://example.com/photo_blur.jpg" data-high-res-src="https://example.com/highres2.png" />
        <img id="i3" src="https://example.com/blur.jpg" data-gif-url="https://example.com/anim.gif" />
        <img id="i4" src="https://example.com/blur.jpg" data-origin-file="https://example.com/orig.png" />
      </body></html>`;

      const blob = await capturePageHtml(html, PAGE_URL, TITLE);
      const text = await blob.text();

      expect(mockFetch).toHaveBeenCalledWith('https://example.com/highres1.png', expect.anything());
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/highres2.png', expect.anything());
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/anim.gif', expect.anything());
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/orig.png', expect.anything());
      expect(text).not.toContain('data-lazy-src');
      expect(text).not.toContain('data-high-res-src');
      expect(text).not.toContain('data-gif-url');
      expect(text).not.toContain('data-origin-file');
    });

    it('promotes candidate from srcset when src is blur/placeholder and no lazy attributes exist', async () => {
      const html = `<html><body><img src="https://example.com/image_blur.jpg" srcset="https://example.com/srcset-image.png 1x"></body></html>`;
      const blob = await capturePageHtml(html, PAGE_URL, TITLE);
      const text = await blob.text();
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/srcset-image.png', expect.anything());
    });

    it('inlines animated micro-videos (loop + muted) and preserves inlined data-gif-url and high-res poster', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url.endsWith('.mp4')) {
          return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
            status: 200,
            headers: { 'content-type': 'video/mp4' }
          });
        }
        if (url.endsWith('.gif')) {
          return new Response(new Uint8Array([71, 73, 70, 56, 57, 97]), {
            status: 200,
            headers: { 'content-type': 'image/gif' }
          });
        }
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' }
        });
      });

      const html = `<html><body>
        <video loop muted poster="https://example.com/poster_blur.jpg" data-poster="https://example.com/poster_real.png" src="https://example.com/animation.mp4" data-gif-url="https://example.com/original.gif"></video>
        <video class="_gifmp4"><source src="https://example.com/micro.mp4" type="video/mp4"></video>
        <video controls src="https://example.com/regular-movie.mp4"></video>
      </body></html>`;

      const blob = await capturePageHtml(html, PAGE_URL, TITLE);
      const text = await blob.text();

      // Micro-video src should be inlined as data:video/mp4
      expect(text).toContain('src="data:video/mp4;base64,');
      // Poster should be inlined from promoted high-res data-poster
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/poster_real.png', expect.anything());
      // data-gif-url should be inlined as data:image/gif
      expect(text).toContain('data-gif-url="data:image/gif;base64,');
      // Regular video without loop/muted should remain external URL
      expect(text).toContain('src="https://example.com/regular-movie.mp4"');
    });
  });
});
