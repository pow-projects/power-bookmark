import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchResourceAsDataUri,
  blobToDataUrl,
  MAX_RESOURCE_SIZE,
  FETCH_RESOURCE_TIMEOUT_MS
} from '../../src/lib/archive/resource-fetcher';

describe('resource-fetcher', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  describe('constants', () => {
    it('defines unconstrained max resource size (Infinity)', () => {
      expect(MAX_RESOURCE_SIZE).toBe(Infinity);
    });

    it('defines 30000ms timeout', () => {
      expect(FETCH_RESOURCE_TIMEOUT_MS).toBe(30000);
    });
  });

  describe('blobToDataUrl', () => {
    it('converts a blob to data URI using FileReader when available', async () => {
      const blob = new Blob(['hello world'], { type: 'text/plain' });
      const dataUrl = await blobToDataUrl(blob);
      expect(dataUrl).toMatch(/^data:text\/plain;base64,/);
      const base64Data = dataUrl.split(',')[1];
      expect(atob(base64Data)).toBe('hello world');
    });

    it('converts binary blob correctly', async () => {
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const dataUrl = await blobToDataUrl(blob);
      expect(dataUrl).toMatch(/^data:application\/octet-stream;base64,/);
    });
  });

  describe('fetchResourceAsDataUri', () => {
    const TEST_URL = 'https://example.com/image.png';
    const PAGE_URL = 'https://example.com/article';

    it('fetches and converts valid resource under 2MB to Data URI', async () => {
      const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG header
      global.fetch = vi.fn().mockResolvedValue(
        new Response(imageBytes, {
          status: 200,
          headers: {
            'Content-Type': 'image/png',
            'Content-Length': String(imageBytes.byteLength)
          }
        })
      );

      const result = await fetchResourceAsDataUri(TEST_URL, PAGE_URL);
      expect(result).toMatch(/^data:image\/png;base64,/);
      expect(global.fetch).toHaveBeenCalledWith(
        TEST_URL,
        expect.objectContaining({
          credentials: 'include',
          headers: { Referer: PAGE_URL },
          signal: expect.any(AbortSignal)
        })
      );
    });

    it('returns original url if HTTP status is not ok (e.g. 404)', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response('Not Found', {
          status: 404,
          statusText: 'Not Found'
        })
      );

      const result = await fetchResourceAsDataUri(TEST_URL);
      expect(result).toBe(TEST_URL);
    });

    it('returns original url if fetch throws network error', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const result = await fetchResourceAsDataUri(TEST_URL);
      expect(result).toBe(TEST_URL);
    });

    it('allows large resources over 2MB (e.g. 5MB) without aborting', async () => {
      const largeSize = 5 * 1024 * 1024;
      const content = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      global.fetch = vi.fn().mockResolvedValue(
        new Response(content, {
          status: 200,
          headers: {
            'Content-Type': 'image/png',
            'Content-Length': String(largeSize)
          }
        })
      );

      const result = await fetchResourceAsDataUri(TEST_URL);
      expect(result).toMatch(/^data:image\/png;base64,/);
    });

    it('streams large chunked resources over 2MB without aborting', async () => {
      // Simulate a chunked stream of 3MB (3 chunks of 1MB)
      const chunkSize = 1024 * 1024;
      let chunkCount = 0;
      const cancelFn = vi.fn();

      const stream = new ReadableStream({
        async pull(controller) {
          chunkCount++;
          if (chunkCount <= 3) {
            controller.enqueue(new Uint8Array(chunkSize));
          } else {
            controller.close();
          }
        },
        cancel: cancelFn
      });

      const response = new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'image/gif' }
      });

      global.fetch = vi.fn().mockResolvedValue(response);

      const result = await fetchResourceAsDataUri(TEST_URL);
      expect(result).toMatch(/^data:image\/gif;base64,/);
      expect(cancelFn).not.toHaveBeenCalled();
    });

    it('handles timeout (30000ms) by aborting and returning original URL', async () => {
      vi.useFakeTimers();

      global.fetch = vi.fn().mockImplementation((_url, options) => {
        return new Promise((_, reject) => {
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              const abortErr = new Error('The operation was aborted');
              abortErr.name = 'AbortError';
              reject(abortErr);
            });
          }
        });
      });

      const promise = fetchResourceAsDataUri(TEST_URL);
      vi.advanceTimersByTime(30000);

      const result = await promise;
      expect(result).toBe(TEST_URL);
    });

    it('fetches large blob over 2MB when stream reader is unavailable without aborting', async () => {
      const mockBlob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'video/mp4' });
      Object.defineProperty(mockBlob, 'size', { value: 10 * 1024 * 1024 });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'video/mp4' }),
        body: null,
        blob: vi.fn().mockResolvedValue(mockBlob)
      } as any);

      const result = await fetchResourceAsDataUri('https://example.com/video.mp4');
      expect(result).toMatch(/^data:video\/mp4;base64,/);
    });
  });
});
