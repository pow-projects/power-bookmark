import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkBookmarkHealth,
  checkBookmarksHealth,
  isBookmarkDead,
  isBookmarkBroken,
  type HealthCheckResult
} from '../../src/lib/health/health-checker';
import type { Bookmark } from '../../src/lib/db';

const mockBookmarkStore = new Map<number, Bookmark>();

// Mock db
vi.mock('../../src/lib/db', () => {
  const mockUpdate = vi.fn().mockResolvedValue(1);
  const mockGet = vi.fn(async (id: number) => mockBookmarkStore.get(id));
  const mockToArray = vi.fn(async () => Array.from(mockBookmarkStore.values()));
  return {
    db: {
      bookmarks: {
        update: mockUpdate,
        get: mockGet,
        toArray: mockToArray
      }
    },
    default: {
      bookmarks: {
        update: mockUpdate,
        get: mockGet,
        toArray: mockToArray
      }
    }
  };
});

describe('Health Checker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockBookmarkStore.clear();
  });

  it('should return ok for 200 status', async () => {
    // Inject fetch mock
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true
    });
    vi.stubGlobal('fetch', mockFetch);

    const bookmark: Bookmark = { id: 1, url: 'https://example.com', title: 'Test', bookmarkId: 'b1', description: '', folderPath: '', createdAt: 0, modifiedAt: 0, visitCount: 0 };
    const result = await checkBookmarkHealth(bookmark);

    expect(result.status).toBe('ok');
    expect(result.httpStatus).toBe(200);
  });

  it('should return dead for 404 status', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 404,
      ok: false
    });
    vi.stubGlobal('fetch', mockFetch);

    const bookmark: Bookmark = { id: 2, url: 'https://example.com/404', title: 'Test 404', bookmarkId: 'b2', description: '', folderPath: '', createdAt: 0, modifiedAt: 0, visitCount: 0 };
    const result = await checkBookmarkHealth(bookmark);

    expect(result.status).toBe('dead');
    expect(result.httpStatus).toBe(404);
  });

  it('should retry with GET if HEAD fails with status 405 (method not allowed)', async () => {
    // Configure first fetch (HEAD) to error and second fetch (GET) to return 200
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error('HEAD Method Not Allowed'))
      .mockResolvedValueOnce({
        status: 200,
        ok: true
      });
    vi.stubGlobal('fetch', mockFetch);

    const bookmark: Bookmark = { id: 3, url: 'https://example.com/get-only', title: 'Get Only', bookmarkId: 'b3', description: '', folderPath: '', createdAt: 0, modifiedAt: 0, visitCount: 0 };
    const result = await checkBookmarkHealth(bookmark);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('ok');
    expect(result.httpStatus).toBe(200);
  });

  it('should retry with GET and succeed if HEAD returns 404 but GET returns 200 (e.g. CloudFront / abacus.ai)', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        status: 404,
        ok: false
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true
      });
    vi.stubGlobal('fetch', mockFetch);

    const bookmark: Bookmark = { id: 5, url: 'https://supercomputer.abacus.ai/', title: 'Abacus AI', bookmarkId: 'b5', description: '', folderPath: '', createdAt: 0, modifiedAt: 0, visitCount: 0 };
    const result = await checkBookmarkHealth(bookmark);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('ok');
    expect(result.httpStatus).toBe(200);
  });

  it('should return timeout if AbortError occurs', async () => {
    const abortError = new Error('The user aborted a request.');
    abortError.name = 'AbortError';
    
    const mockFetch = vi.fn().mockRejectedValue(abortError);
    vi.stubGlobal('fetch', mockFetch);

    const bookmark: Bookmark = { id: 4, url: 'https://example.com/timeout', title: 'Timeout', bookmarkId: 'b4', description: '', folderPath: '', createdAt: 0, modifiedAt: 0, visitCount: 0 };
    const result = await checkBookmarkHealth(bookmark);

    expect(result.status).toBe('timeout');
  });

  describe('isBookmarkDead helper', () => {
    const baseBookmark: Bookmark = {
      id: 10,
      url: 'https://example.com',
      title: 'Base',
      bookmarkId: 'b10',
      description: '',
      folderPath: '',
      createdAt: 0,
      modifiedAt: 0,
      visitCount: 0
    };

    it('returns true when healthResult status is dead', () => {
      const res: HealthCheckResult = { bookmarkId: 10, url: 'https://example.com', status: 'dead', httpStatus: 404 };
      expect(isBookmarkDead(baseBookmark, res)).toBe(true);
    });

    it('returns true when healthResult httpStatus is 404', () => {
      const res: HealthCheckResult = { bookmarkId: 10, url: 'https://example.com', status: 'error', httpStatus: 404 };
      expect(isBookmarkDead(baseBookmark, res)).toBe(true);
    });

    it('overrides cached 404 status when live healthResult is ok', () => {
      const bmWith404: Bookmark = { ...baseBookmark, httpStatus: 404 };
      const res: HealthCheckResult = { bookmarkId: 10, url: 'https://example.com', status: 'ok', httpStatus: 200 };
      expect(isBookmarkDead(bmWith404, res)).toBe(false);
    });

    it('falls back to bookmark.httpStatus === 404 when healthResult is undefined', () => {
      expect(isBookmarkDead({ ...baseBookmark, httpStatus: 404 })).toBe(true);
      expect(isBookmarkDead({ ...baseBookmark, httpStatus: 200 })).toBe(false);
      expect(isBookmarkDead({ ...baseBookmark, httpStatus: 500 })).toBe(false);
      expect(isBookmarkDead({ ...baseBookmark, httpStatus: 0 })).toBe(false);
      expect(isBookmarkDead({ ...baseBookmark, httpStatus: undefined })).toBe(false);
    });
  });

  describe('isBookmarkBroken helper', () => {
    const baseBookmark: Bookmark = {
      id: 20,
      url: 'https://example.com',
      title: 'Base Broken',
      bookmarkId: 'b20',
      description: '',
      folderPath: '',
      createdAt: 0,
      modifiedAt: 0,
      visitCount: 0
    };

    it('returns true for non-ok healthResult statuses (dead, server_error, timeout, error)', () => {
      expect(isBookmarkBroken(baseBookmark, { bookmarkId: 20, url: baseBookmark.url, status: 'dead', httpStatus: 404 })).toBe(true);
      expect(isBookmarkBroken(baseBookmark, { bookmarkId: 20, url: baseBookmark.url, status: 'server_error', httpStatus: 500 })).toBe(true);
      expect(isBookmarkBroken(baseBookmark, { bookmarkId: 20, url: baseBookmark.url, status: 'timeout' })).toBe(true);
      expect(isBookmarkBroken(baseBookmark, { bookmarkId: 20, url: baseBookmark.url, status: 'error' })).toBe(true);
    });

    it('overrides cached error when live healthResult is ok', () => {
      const bmWithError: Bookmark = { ...baseBookmark, httpStatus: 500 };
      const res: HealthCheckResult = { bookmarkId: 20, url: baseBookmark.url, status: 'ok', httpStatus: 200 };
      expect(isBookmarkBroken(bmWithError, res)).toBe(false);
    });

    it('falls back to bookmark.httpStatus when healthResult is undefined', () => {
      expect(isBookmarkBroken({ ...baseBookmark, httpStatus: 500 })).toBe(true);
      expect(isBookmarkBroken({ ...baseBookmark, httpStatus: 404 })).toBe(true);
      expect(isBookmarkBroken({ ...baseBookmark, httpStatus: 403 })).toBe(true);
      expect(isBookmarkBroken({ ...baseBookmark, httpStatus: 503 })).toBe(true);
      expect(isBookmarkBroken({ ...baseBookmark, httpStatus: 100 })).toBe(true);
      expect(isBookmarkBroken({ ...baseBookmark, httpStatus: 200 })).toBe(false);
      expect(isBookmarkBroken({ ...baseBookmark, httpStatus: 301 })).toBe(false);
      expect(isBookmarkBroken({ ...baseBookmark, httpStatus: 0 })).toBe(false);
      expect(isBookmarkBroken({ ...baseBookmark, httpStatus: undefined })).toBe(false);
    });
  });

  describe('checkBookmarksHealth with onBatchResults', () => {
    it('calls onBatchResults after processing each batch', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true
      });
      vi.stubGlobal('fetch', mockFetch);

      for (let i = 1; i <= 15; i++) {
        mockBookmarkStore.set(i, {
          id: i,
          url: `https://example.com/${i}`,
          title: `BM ${i}`,
          bookmarkId: `b${i}`,
          description: '',
          folderPath: '',
          createdAt: 0,
          modifiedAt: 0,
          visitCount: 0
        });
      }

      const batchCalls: HealthCheckResult[][] = [];
      const onBatchResults = vi.fn((batch: HealthCheckResult[]) => {
        batchCalls.push([...batch]);
      });

      const ids = Array.from({ length: 15 }, (_, i) => i + 1);
      const results = await checkBookmarksHealth(
        ids,
        undefined,
        undefined,
        undefined,
        onBatchResults
      );

      expect(results.length).toBe(15);
      expect(onBatchResults).toHaveBeenCalledTimes(2); // 10 in first batch, 5 in second batch
      expect(batchCalls[0].length).toBe(10);
      expect(batchCalls[1].length).toBe(5);
    });
  });
});
