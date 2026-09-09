import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  recordVisit,
  getHostStats,
  getAddedByDate,
  getFolderDistribution,
  getCategoryVisitStats,
  getRevisitStats,
  getSummaryStats,
  getValidTimestamp,
  getTagTimeline
} from '../../src/lib/stats/stats-tracker';
import db from '../../src/lib/db';

vi.mock('../../src/lib/db', () => {
  const mockDb = {
    stats: {
      add: vi.fn(),
      toArray: vi.fn()
    },
    bookmarks: {
      where: vi.fn(),
      toArray: vi.fn(),
      count: vi.fn(),
      update: vi.fn()
    },
    archivedPages: {
      count: vi.fn(),
      toArray: vi.fn()
    },
    syncState: {
      toArray: vi.fn()
    },
    settings: {
      get: vi.fn()
    }
  };
  return {
    db: mockDb,
    default: mockDb
  };
});

describe('Stats Tracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call stats.add on recordVisit', async () => {
    vi.mocked(db.bookmarks.where).mockReturnValue({
      equals: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([])
      })
    } as any);

    await recordVisit('https://google.com/path');
    
    expect(db.stats.add).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://google.com/path',
      host: 'google.com'
    }));
  });

  it('should aggregate host stats correctly and strip www prefix', async () => {
    vi.mocked(db.stats.toArray).mockResolvedValueOnce([
      { host: 'www.google.com' },
      { host: 'github.com' },
      { host: 'google.com' }
    ] as any);
    vi.mocked(db.bookmarks.toArray).mockResolvedValueOnce([]);

    const result = await getHostStats();
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ host: 'google.com', count: 2 });
    expect(result[1]).toEqual({ host: 'github.com', count: 1 });
  });

  it('should aggregate added bookmarks by date', async () => {
    const today = new Date().toISOString().split('T')[0];
    vi.mocked(db.bookmarks.toArray).mockResolvedValueOnce([
      { createdAt: Date.now() },
      { createdAt: Date.now() }
    ] as any);

    const result = await getAddedByDate(3);
    expect(result).toHaveLength(3);
    const todayItem = result.find(r => r.date === today);
    expect(todayItem?.count).toBe(2);
  });

  it('should calculate folder distribution', async () => {
    vi.mocked(db.bookmarks.toArray).mockResolvedValueOnce([
      { folderPath: 'Dev/Frontend' },
      { folderPath: 'Dev/Frontend' },
      { folderPath: '' }
    ] as any);

    const result = await getFolderDistribution();
    expect(result).toHaveLength(2);
    const devItem = result.find(r => r.folder === 'Dev/Frontend');
    const etcItem = result.find(r => r.folder === '기타');
    expect(devItem?.count).toBe(2);
    expect(etcItem?.count).toBe(1);
  });

  it('should calculate category visit stats correctly', async () => {
    vi.mocked(db.bookmarks.toArray).mockResolvedValueOnce([
      { url: 'https://a.com', folderPath: '개발/웹' },
      { url: 'https://b.com', folderPath: '디자인' }
    ] as any);
    vi.mocked(db.stats.toArray).mockResolvedValueOnce([
      { url: 'https://a.com' },
      { url: 'https://a.com' },
      { url: 'https://b.com' }
    ] as any);

    const result = await getCategoryVisitStats();
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ folder: '개발/웹', count: 2 });
    expect(result[1]).toEqual({ folder: '디자인', count: 1 });
  });

  it('should calculate revisit stats correctly', async () => {
    vi.mocked(db.bookmarks.toArray).mockResolvedValueOnce([
      { visitCount: 0 },
      { visitCount: 1 },
      { visitCount: 3 },
      { visitCount: 10 }
    ] as any);

    const result = await getRevisitStats();
    expect(result.totalBookmarks).toBe(4);
    expect(result.revisitedCount).toBe(2);
    expect(result.revisitRate).toBe(50);
  });

  it('should summarize overall statistics including local and cloud archives', async () => {
    vi.mocked(db.bookmarks.count).mockResolvedValueOnce(10);
    vi.mocked(db.bookmarks.where).mockReturnValue({
      equals: vi.fn().mockReturnValue({
        count: vi.fn().mockResolvedValue(2)
      })
    } as any);
    vi.mocked(db.bookmarks.toArray).mockResolvedValueOnce([
      { id: 1, syncId: 'sync-1' },
      { id: 2, syncId: 'sync-2' },
      { id: 3, syncId: 'sync-3' }
    ] as any);
    vi.mocked(db.archivedPages.toArray).mockResolvedValueOnce([
      { bookmarkId: 1, fileSize: 100, archivedAt: 1000 },
      { bookmarkId: 2, fileSize: 250, archivedAt: 2000 }
    ] as any);
    vi.mocked(db.settings.get).mockResolvedValueOnce({
      key: 'cloud_archive_index',
      value: [
        { syncId: 'sync-2', fileSize: 250, archivedAt: 2000 }, // Duplicate (exists locally)
        { syncId: 'sync-3', fileSize: 400, archivedAt: 3000 }  // Cloud-only archive
      ]
    });
    vi.mocked(db.syncState.toArray).mockResolvedValueOnce([
      { lastSyncAt: 1000 }
    ] as any);

    const result = await getSummaryStats();
    expect(result.totalBookmarks).toBe(10);
    expect(result.deadLinks).toBe(2);
    expect(result.archivedCount).toBe(3); // sync-1 (local), sync-2 (local+cloud), sync-3 (cloud only)
    expect(result.totalArchiveSize).toBe(750); // 100 + 250 + 400
    expect(result.lastSyncAt).toBe(1000);
  });

  describe('getValidTimestamp', () => {
    it('returns createdAt when it is valid', () => {
      const now = Date.now();
      expect(getValidTimestamp(now, now - 1000)).toBe(now);
    });

    it('falls back to modifiedAt when createdAt is undefined or invalid', () => {
      const now = Date.now();
      expect(getValidTimestamp(undefined, now)).toBe(now);
      expect(getValidTimestamp(0, now)).toBe(now);
      expect(getValidTimestamp(NaN, now)).toBe(now);
    });

    it('rejects timestamps before 1990-01-01', () => {
      const pre1990 = new Date('1985-05-01T00:00:00Z').getTime();
      const validNow = Date.now();
      expect(getValidTimestamp(pre1990, validNow)).toBe(validNow);
      expect(getValidTimestamp(pre1990, pre1990)).toBeNull();
    });

    it('rejects timestamps beyond 1 day in future', () => {
      const farFuture = Date.now() + 48 * 60 * 60 * 1000;
      const validNow = Date.now();
      expect(getValidTimestamp(farFuture, validNow)).toBe(validNow);
      expect(getValidTimestamp(farFuture, farFuture)).toBeNull();
    });

    it('returns null when both createdAt and modifiedAt are missing/invalid', () => {
      expect(getValidTimestamp(undefined, undefined)).toBeNull();
      expect(getValidTimestamp(0, 0)).toBeNull();
    });
  });

  describe('getTagTimeline', () => {
    it('aggregates monthly buckets across all bookmarks, counts total bookmarks and tag frequencies', async () => {
      const d1 = new Date(2026, 8, 2).getTime(); // 2026.09.02
      const d2 = new Date(2026, 8, 3).getTime(); // 2026.09.03
      const d3 = new Date(2026, 7, 10).getTime(); // 2026.08.10
      const dNoTag = new Date(2026, 6, 5).getTime(); // 2026.07.05 (no tags)

      const mockBookmarks = [
        { createdAt: d1, tags: ['svelte', 'typescript'] },
        { createdAt: d2, tags: ['#svelte', 'frontend', 'svelte'] }, // duplicate 'svelte' & '#'
        { createdAt: d3, tags: ['vitest', 'testing'] },
        { createdAt: dNoTag, tags: [] } // No tags in 2026.07
      ];

      vi.mocked(db.bookmarks.toArray).mockResolvedValueOnce(mockBookmarks as any);

      const result = await getTagTimeline('month');

      expect(result.hasOlderData).toBe(false);
      // 2026.07 should be excluded because it has 0 tags
      expect(result.buckets).toHaveLength(2);

      // Latest month first (2026.09 > 2026.08)
      expect(result.buckets[0].yearMonth).toBe('2026.09');
      expect(result.buckets[0].totalBookmarks).toBe(2);
      expect(result.buckets[0].tags).toEqual([
        { tag: 'svelte', count: 2 },
        { tag: 'frontend', count: 1 },
        { tag: 'typescript', count: 1 }
      ]);

      expect(result.buckets[1].yearMonth).toBe('2026.08');
      expect(result.buckets[1].totalBookmarks).toBe(1);
      expect(result.buckets[1].tags).toEqual([
        { tag: 'testing', count: 1 },
        { tag: 'vitest', count: 1 }
      ]);
    });

    it('sorts tags with equal counts alphabetically', async () => {
      const d = new Date(2026, 4, 10).getTime();
      const mockBookmarks = [
        { createdAt: d, tags: ['zebra', 'apple', 'banana', 'apple'] }
      ];

      vi.mocked(db.bookmarks.toArray).mockResolvedValueOnce(mockBookmarks as any);

      const result = await getTagTimeline('month');
      expect(result.buckets).toHaveLength(1);
      expect(result.buckets[0].tags).toEqual([
        { tag: 'apple', count: 1 },
        { tag: 'banana', count: 1 },
        { tag: 'zebra', count: 1 }
      ]);
    });

    it('falls back to modifiedAt when createdAt is invalid and ignores invalid records', async () => {
      const validModifiedAt = new Date(2026, 2, 10).getTime();
      const mockBookmarks = [
        { createdAt: 0, modifiedAt: validModifiedAt, tags: ['fallback'] },
        { createdAt: undefined, modifiedAt: undefined, tags: ['corrupted'] } // skipped
      ];

      vi.mocked(db.bookmarks.toArray).mockResolvedValueOnce(mockBookmarks as any);

      const result = await getTagTimeline('month');
      expect(result.buckets).toHaveLength(1);
      expect(result.buckets[0].yearMonth).toBe('2026.03');
      expect(result.buckets[0].tags).toEqual([
        { tag: 'fallback', count: 1 }
      ]);
    });

    it('queries all bookmarks when limitMonths <= 0', async () => {
      const d = new Date(2025, 0, 15).getTime();
      vi.mocked(db.bookmarks.toArray).mockResolvedValueOnce([
        { createdAt: d, tags: ['all-time'] }
      ] as any);

      const result = await getTagTimeline(0);
      expect(db.bookmarks.toArray).toHaveBeenCalled();
      expect(result.hasOlderData).toBe(false);
      expect(result.buckets).toHaveLength(1);
      expect(result.buckets[0].yearMonth).toBe('2025.01');
      expect(result.buckets[0].tags).toEqual([
        { tag: 'all-time', count: 1 }
      ]);
    });

    it('aggregates tags by year when granularity is "year"', async () => {
      const d1 = new Date(2025, 1, 10).getTime();
      const d2 = new Date(2025, 7, 20).getTime();
      const d3 = new Date(2024, 5, 1).getTime();

      vi.mocked(db.bookmarks.toArray).mockResolvedValueOnce([
        { createdAt: d1, tags: ['dev', 'svelte'] },
        { createdAt: d2, tags: ['dev', 'ai'] },
        { createdAt: d3, tags: ['legacy'] }
      ] as any);

      const result = await getTagTimeline('year');
      expect(db.bookmarks.toArray).toHaveBeenCalled();
      expect(result.hasOlderData).toBe(false);
      expect(result.buckets).toHaveLength(2);

      // Descending by timestamp: 2025 first, then 2024
      expect(result.buckets[0].yearMonth).toBe('2025');
      expect(result.buckets[0].totalBookmarks).toBe(2);
      expect(result.buckets[0].tags).toEqual([
        { tag: 'dev', count: 2 },
        { tag: 'ai', count: 1 },
        { tag: 'svelte', count: 1 }
      ]);

      expect(result.buckets[1].yearMonth).toBe('2024');
      expect(result.buckets[1].totalBookmarks).toBe(1);
      expect(result.buckets[1].tags).toEqual([
        { tag: 'legacy', count: 1 }
      ]);
    });
  });
});
