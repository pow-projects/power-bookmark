import db from '../db';

export interface VisitStat {
  url: string;
  host: string;
  visitedAt: number;
}

export function normalizeHost(hostOrUrl: string): string {
  if (!hostOrUrl) return '';
  let host = hostOrUrl;
  if (hostOrUrl.includes('://')) {
    try {
      host = new URL(hostOrUrl).hostname;
    } catch {
      host = hostOrUrl;
    }
  }
  return host.replace(/^www\./i, '').toLowerCase();
}

/**
 * Records statistics and counts when visiting a bookmark.
 */
export async function recordVisit(url: string): Promise<void> {
  let host = '';
  try {
    host = normalizeHost(new URL(url).hostname);
  } catch (e) {
    host = normalizeHost(url);
  }

  const now = Date.now();

  // 1. Add visit record to stats table
  await db.stats.add({
    url,
    host,
    visitedAt: now,
    duration: 0
  });

  // 2. Increment visitCount for corresponding url in bookmarks table
  // Update all matching bookmarks since duplicates may exist
  const bookmarks = await db.bookmarks.where('url').equals(url).toArray();
  for (const bookmark of bookmarks) {
    if (bookmark.id !== undefined) {
      await db.bookmarks.update(bookmark.id, {
        visitCount: (bookmark.visitCount || 0) + 1
      });
    }
  }
}

/**
 * Aggregates visit and bookmark counts by host (descending order).
 */
export async function getHostStats(): Promise<{ host: string; count: number }[]> {
  const stats = await db.stats.toArray();
  const bookmarks = await db.bookmarks.toArray();
  const counts: { [host: string]: number } = {};

  for (const s of stats) {
    const h = normalizeHost(s.host);
    if (h) counts[h] = (counts[h] || 0) + 1;
  }

  for (const b of bookmarks) {
    if (b.url) {
      const h = normalizeHost(b.url);
      if (h) counts[h] = (counts[h] || 0) + 1;
    }
  }

  return Object.keys(counts)
    .map(host => ({ host, count: counts[host] }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Daily bookmark addition trend for the last N days.
 */
export async function getAddedByDate(days: number = 30): Promise<{ date: string; count: number }[]> {
  const bookmarks = await db.bookmarks.toArray();
  const counts: { [date: string]: number } = {};

  // Initialize date keys for the last N days (fill all dates with 0)
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = d.toISOString().split('T')[0]; // YYYY-MM-DD
    counts[dateStr] = 0;
  }

  for (const b of bookmarks) {
    if (b.createdAt) {
      const dateStr = new Date(b.createdAt).toISOString().split('T')[0];
      if (counts[dateStr] !== undefined) {
        counts[dateStr]++;
      }
    }
  }

  return Object.keys(counts)
    .sort()
    .map(date => ({ date, count: counts[date] }));
}

interface UnifiedArchiveItem {
  key: string;
  fileSize: number;
  archivedAt: number;
}

/**
 * Helper to aggregate local archives (db.archivedPages) and cloud archive index cache (cloud_archive_index)
 * without duplicates.
 */
async function getUnifiedArchiveItems(): Promise<UnifiedArchiveItem[]> {
  const localArchives = await db.archivedPages.toArray();
  const cloudEntries: any[] = (await db.settings.get('cloud_archive_index'))?.value || [];

  const bookmarks = await db.bookmarks.toArray();
  const bookmarkIdToSyncId = new Map<number, string>();
  const localSyncIds = new Set<string>();
  for (const b of bookmarks) {
    if (b.id !== undefined && b.syncId) {
      bookmarkIdToSyncId.set(b.id, b.syncId);
    }
    if (b.syncId) {
      localSyncIds.add(b.syncId);
    }
  }

  const map = new Map<string, UnifiedArchiveItem>();

  // 1. Register local archives
  for (const a of localArchives) {
    const syncId = bookmarkIdToSyncId.get(a.bookmarkId);
    const key = syncId || `local_${a.bookmarkId}`;
    map.set(key, {
      key,
      fileSize: a.fileSize || 0,
      archivedAt: a.archivedAt || 0
    });
  }

  // 2. Register cloud archive index (items not present locally)
  for (const ce of cloudEntries) {
    if (ce.deleted) continue;
    if (ce.syncId && !map.has(ce.syncId)) {
      if (localSyncIds.has(ce.syncId)) {
        map.set(ce.syncId, {
          key: ce.syncId,
          fileSize: ce.fileSize || 0,
          archivedAt: ce.archivedAt || 0
        });
      }
    }
  }

  return Array.from(map.values());
}

/**
 * Daily archived page trend for the last N days.
 */
export async function getArchivedByDate(days: number = 30): Promise<{ date: string; count: number }[]> {
  const archiveItems = await getUnifiedArchiveItems();
  const counts: { [date: string]: number } = {};

  // Initialize date keys for the last N days (fill all dates with 0)
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = d.toISOString().split('T')[0]; // YYYY-MM-DD
    counts[dateStr] = 0;
  }

  for (const b of archiveItems) {
    if (b.archivedAt) {
      const dateStr = new Date(b.archivedAt).toISOString().split('T')[0];
      if (counts[dateStr] !== undefined) {
        counts[dateStr]++;
      }
    }
  }

  return Object.keys(counts)
    .sort()
    .map(date => ({ date, count: counts[date] }));
}

/**
 * Aggregates bookmark distribution by folder.
 */
export async function getFolderDistribution(): Promise<{ folder: string; count: number }[]> {
  const bookmarks = await db.bookmarks.toArray();
  const counts: { [folder: string]: number } = {};

  for (const b of bookmarks) {
    // If folderPath is empty, fallback to '기타' or 'Root'
    const folder = b.folderPath || '기타';
    counts[folder] = (counts[folder] || 0) + 1;
  }

  return Object.keys(counts).map(folder => ({
    folder,
    count: counts[folder]
  }));
}

/**
 * Aggregates access (visit) counts by folder (category) (descending order).
 */
export async function getCategoryVisitStats(): Promise<{ folder: string; count: number }[]> {
  const bookmarks = await db.bookmarks.toArray();
  const stats = await db.stats.toArray();
  const counts: { [folder: string]: number } = {};

  const urlToFolderMap = new Map<string, string>();
  for (const b of bookmarks) {
    const folder = b.folderPath || '기타';
    if (b.url) {
      urlToFolderMap.set(b.url, folder);
    }
  }

  for (const s of stats) {
    const folder = urlToFolderMap.get(s.url) || '기타';
    counts[folder] = (counts[folder] || 0) + 1;
  }

  // Use visitCount from bookmarks if no db.stats visit records exist
  if (stats.length === 0) {
    for (const b of bookmarks) {
      const folder = b.folderPath || '기타';
      const visits = b.visitCount || 0;
      counts[folder] = (counts[folder] || 0) + visits;
    }
  }

  return Object.keys(counts)
    .map(folder => ({ folder, count: counts[folder] }))
    .sort((a, b) => b.count - a.count);
}

export interface RevisitStats {
  revisitRate: number;
  totalBookmarks: number;
  revisitedCount: number;
  singleVisitedCount: number;
  unvisitedCount: number;
  distribution: {
    label: string;
    count: number;
  }[];
}

/**
 * Aggregates bookmark revisit rate and visit frequency distribution.
 */
export async function getRevisitStats(): Promise<RevisitStats> {
  const bookmarks = await db.bookmarks.toArray();
  const total = bookmarks.length;

  if (total === 0) {
    return {
      revisitRate: 0,
      totalBookmarks: 0,
      revisitedCount: 0,
      singleVisitedCount: 0,
      unvisitedCount: 0,
      distribution: [
        { label: i18n.t('dashboard.unvisited'), count: 0 },
        { label: i18n.t('dashboard.visited1'), count: 0 },
        { label: i18n.t('dashboard.visited2to5'), count: 0 },
        { label: i18n.t('dashboard.visited6plus'), count: 0 }
      ]
    };
  }

  let unvisited = 0;
  let singleVisit = 0;
  let revisitLow = 0;
  let revisitHigh = 0;

  for (const b of bookmarks) {
    const visits = b.visitCount || 0;
    if (visits === 0) unvisited++;
    else if (visits === 1) singleVisit++;
    else if (visits <= 5) revisitLow++;
    else revisitHigh++;
  }

  const revisitedTotal = revisitLow + revisitHigh;
  const revisitRate = Math.round((revisitedTotal / total) * 1000) / 10;

  return {
    revisitRate,
    totalBookmarks: total,
    revisitedCount: revisitedTotal,
    singleVisitedCount: singleVisit,
    unvisitedCount: unvisited,
    distribution: [
      { label: i18n.t('dashboard.unvisited'), count: unvisited },
      { label: i18n.t('dashboard.visited1'), count: singleVisit },
      { label: i18n.t('dashboard.visited2to5'), count: revisitLow },
      { label: i18n.t('dashboard.visited6plus'), count: revisitHigh }
    ]
  };
}

/**
 * Aggregates overall summary statistics.
 */
export async function getSummaryStats(): Promise<{
  totalBookmarks: number;
  deadLinks: number;
  archivedCount: number;
  totalArchiveSize: number;
  lastSyncAt: number | null;
}> {
  const totalBookmarks = await db.bookmarks.count();
  
  // deadLinks: items where httpStatus is 404
  const deadLinks = await db.bookmarks.where('httpStatus').equals(404).count();

  // Unified aggregation of local archives + cloud archive index
  const archiveItems = await getUnifiedArchiveItems();
  const archivedCount = archiveItems.length;
  const totalArchiveSize = archiveItems.reduce((acc, curr) => acc + (curr.fileSize || 0), 0);

  // lastSyncAt: find the most recent lastSyncAt in syncState
  const syncStates = await db.syncState.toArray();
  let lastSyncAt: number | null = null;
  if (syncStates.length > 0) {
    lastSyncAt = Math.max(...syncStates.map(s => s.lastSyncAt || 0));
    if (lastSyncAt === 0) lastSyncAt = null;
  }

  return {
    totalBookmarks,
    deadLinks,
    archivedCount,
    totalArchiveSize,
    lastSyncAt
  };
}

export interface TagCount {
  tag: string;
  count: number;
}

export type TimelineGranularity = 'month' | 'year';

export interface MonthlyTagBucket {
  yearMonth: string; // "YYYY.MM" (month) or "YYYY" (year)
  timestamp: number;
  totalBookmarks: number;
  tags: TagCount[];
}

export interface TagTimelineResult {
  buckets: MonthlyTagBucket[];
  hasOlderData: boolean;
}

/**
 * Validates timestamp range (1990-01-01 to now + 1 day buffer).
 * Falls back to modifiedAt if createdAt is invalid or out of range.
 */
export function getValidTimestamp(createdAt?: number, modifiedAt?: number): number | null {
  const minTimestamp = new Date('1990-01-01T00:00:00Z').getTime();
  const maxTimestamp = Date.now() + 24 * 60 * 60 * 1000;

  const isValid = (ts?: number): ts is number =>
    typeof ts === 'number' && !isNaN(ts) && ts >= minTimestamp && ts <= maxTimestamp;

  if (isValid(createdAt)) return createdAt;
  if (isValid(modifiedAt)) return modifiedAt;
  return null;
}

/**
 * Aggregates monthly or yearly tag trends and bookmark counts for vertical timeline visualization across all bookmarks.
 * @param granularityOrLimit 'month' | 'year' or optional legacy limit number
 * @param granularityParam optional 'month' | 'year' when first arg is a number
 */
export async function getTagTimeline(
  granularityOrLimit?: TimelineGranularity | number,
  granularityParam?: TimelineGranularity
): Promise<TagTimelineResult> {
  const granularity: TimelineGranularity =
    typeof granularityOrLimit === 'string'
      ? granularityOrLimit
      : (granularityParam || 'month');

  const bookmarks = await db.bookmarks.toArray();
  const hasOlderData = false;

  interface BucketInternal {
    yearMonth: string;
    timestamp: number;
    totalBookmarks: number;
    tagCounts: Map<string, number>;
  }

  const bucketMap = new Map<string, BucketInternal>();

  for (const b of bookmarks) {
    const ts = getValidTimestamp(b.createdAt, b.modifiedAt);
    if (ts === null) continue;

    const d = new Date(ts);
    const year = d.getFullYear();
    let periodKey: string;
    let bucketTimestamp: number;

    if (granularity === 'year') {
      periodKey = String(year);
      bucketTimestamp = new Date(year, 0, 1).getTime();
    } else {
      const month = String(d.getMonth() + 1).padStart(2, '0');
      periodKey = `${year}.${month}`;
      bucketTimestamp = new Date(year, d.getMonth(), 1).getTime();
    }

    let bucket = bucketMap.get(periodKey);
    if (!bucket) {
      bucket = {
        yearMonth: periodKey,
        timestamp: bucketTimestamp,
        totalBookmarks: 0,
        tagCounts: new Map<string, number>()
      };
      bucketMap.set(periodKey, bucket);
    }
    bucket.totalBookmarks += 1;

    if (Array.isArray(b.tags) && b.tags.length > 0) {
      const seenTags = new Set<string>();
      for (const rawTag of b.tags) {
        if (!rawTag || typeof rawTag !== 'string') continue;
        const cleanTag = rawTag.trim().replace(/^#/, '');
        if (!cleanTag) continue;
        if (seenTags.has(cleanTag)) continue;
        seenTags.add(cleanTag);
        bucket.tagCounts.set(cleanTag, (bucket.tagCounts.get(cleanTag) || 0) + 1);
      }
    }
  }

  const buckets: MonthlyTagBucket[] = [];

  for (const bucket of bucketMap.values()) {
    if (bucket.tagCounts.size === 0) {
      continue;
    }

    const tags: TagCount[] = Array.from(bucket.tagCounts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => {
        if (b.count !== a.count) {
          return b.count - a.count;
        }
        return a.tag.localeCompare(b.tag);
      });

    buckets.push({
      yearMonth: bucket.yearMonth,
      timestamp: bucket.timestamp,
      totalBookmarks: bucket.totalBookmarks,
      tags
    });
  }

  buckets.sort((a, b) => b.timestamp - a.timestamp);

  return {
    buckets,
    hasOlderData
  };
}
