import type { Bookmark } from '../db';
import { normalizeUrl, generateDeterministicSyncId } from '../bookmarks/url-normalizer';
import { isSameFolderLocation, isUncategorizedBookmark } from '../bookmarks/folder-utils';

export { generateDeterministicSyncId };

export interface WinnerResult {
  winner: Bookmark;
  loser: Bookmark;
  isConflict: boolean;
}

/**
 * LWW winner determination (pure function).
 * - Winner = side with larger modifiedAt.
 * - In case of a tie (exactly identical modifiedAt), cloud wins (deterministic fallback — preserves cloud preference intent in merge step 4).
 * - isConflict: true if any of title/URL/description/tags/folderPath differ.
 */
export interface WinnerOptions {
  /** Initial sync flag. If true, treats as conflict ignoring modifiedAt if URL is same but content differs. */
  firstSync?: boolean;
}

/**
 * LWW winner determination (pure function).
 * - Winner = side with larger modifiedAt (regardless of firstSync — winner/loser is always based on LWW).
 * - In case of a tie (exactly identical modifiedAt), cloud wins (deterministic fallback — preserves cloud preference intent in merge step 4).
 * - isConflict (default): Determined by content comparison only when modifiedAt is identical (candidate for concurrent edits).
 *   When modifiedAt differs, winner is determined via LWW and is considered a normal update where content difference
 *   is "because one side modified it" — does not falsely surface unidirectional/sequential edits as conflicts.
 * - isConflict (firstSync=true): Initial sync is when connecting drive for the first time, so bookmarks with same URL
 *   in local existing data and cloud (other devices/legacy backup) may exist with different content.
 *   Rather than quietly resolving via modifiedAt LWW, any same URL with differing content ignores modifiedAt
 *   and unconditionally marks as conflict for user selection (from 2nd sync onwards, conflicts only occur on modifiedAt ties).
 */
export function resolveBookmarkWinner(local: Bookmark, cloud: Bookmark, options?: WinnerOptions): WinnerResult {
  // Auto-resolve fill-gap: When URL and title are identical but one side has completely empty content/folder categorization,
  // do not surface as conflict (without prompting) and choose filled side as winner, deleting empty side. modifiedAt is ignored.
  // (e.g. backup on Drive with only URL/title and no content/categorization vs filled local bookmark)
  if (isFillGapPair(local, cloud)) {
    const filled = isEmptyBookmark(local) ? cloud : local;
    const empty = isEmptyBookmark(local) ? local : cloud;
    return { winner: filled, loser: empty, isConflict: false };
  }
  const localWins = local.modifiedAt > cloud.modifiedAt; // Cloud wins on tie
  const winner = localWins ? local : cloud;
  const loser = localWins ? cloud : local;
  const isConflict = options?.firstSync
    ? normalizeUrl(local.url) === normalizeUrl(cloud.url) && contentDiffers(local, cloud)
    : winner.modifiedAt === loser.modifiedAt && contentDiffers(winner, loser);
  return { winner, loser, isConflict };
}

export function contentDiffers(a: Bookmark, b: Bookmark): boolean {
  const titleA = (a.title || '').trim();
  const titleB = (b.title || '').trim();
  const descA = (a.description || '').trim();
  const descB = (b.description || '').trim();
  const urlA = normalizeUrl(a.url || '');
  const urlB = normalizeUrl(b.url || '');

  return (
    titleA !== titleB ||
    urlA !== urlB ||
    descA !== descB ||
    !isSameFolderLocation(a.folderPath, b.folderPath) ||
    !sameTags(a.tags, b.tags)
  );
}

/** Whether the bookmark has completely empty content (description/tags) and folder categorization (folderPath). */
export function isEmptyBookmark(b: Bookmark): boolean {
  return (
    !b.description &&
    (!b.tags || b.tags.length === 0) &&
    isUncategorizedBookmark(b)
  );
}

/** Whether the pair has identical URL/title but only one side has empty content/folder categorization (and other side is filled). */
export function isFillGapPair(a: Bookmark, b: Bookmark): boolean {
  if (normalizeUrl(a.url) !== normalizeUrl(b.url) || a.title !== b.title) return false;
  return isEmptyBookmark(a) !== isEmptyBookmark(b);
}

/** Compares tag arrays after sorting (ignores order, treats duplicates/undefined identically). */
export function sameTags(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = [...(a ?? [])].sort();
  const y = [...(b ?? [])].sort();
  return x.length === y.length && x.every((t, i) => t === y[i]);
}

/**
 * URL-based duplicate deduplication (pure function).
 * - If the same url exists under multiple syncIds (bookmarks), keeps the single one with greatest modifiedAt
 *   and returns remaining (duplicate) items. On ties (identical modifiedAt), treats the earlier item in array as winner (deterministic).
 * - Returns items to keep in [0] (keep) and items to remove (duplicates) in [1] (duplicates).
 * - Purpose: Prevents createJobs from redundantly creating duplicates via browser.bookmarks.create()
 *   when duplicate bookmarks of the same URL exist in cloud/merge results, and identifies already existing duplicates
 *   for cleanup in browser/DB.
 */
export function dedupeByUrl(bookmarks: Bookmark[]): { keep: Bookmark[]; duplicates: Bookmark[] } {
  const keep: Bookmark[] = [];
  const duplicates: Bookmark[] = [];
  const byUrl = new Map<string, number>(); // norm url -> keep array index

  for (const b of bookmarks) {
    const normUrl = normalizeUrl(b.url);
    const idx = byUrl.get(normUrl);
    if (idx === undefined) {
      byUrl.set(normUrl, keep.length);
      keep.push(b);
      continue;
    }
    // Same URL already exists — side with larger modifiedAt wins
    const existing = keep[idx];
    if (b.modifiedAt > existing.modifiedAt) {
      // New item is newer → mark existing item as duplicate
      duplicates.push(existing);
      keep[idx] = b;
    } else {
      duplicates.push(b);
    }
  }
  return { keep, duplicates };
}

/**
 * Cross-device concurrent write determination (pure function).
 * - If baseModified (server modifiedTime immediately after cloud read) and currentModified (revalidation just before write)
 *   are equal, no other device has written → false (safe, proceed with write).
 * - If different, another device wrote concurrently → true (abort write to prevent lost-update).
 */
export function isConcurrentWrite(baseModified: number, currentModified: number): boolean {
  return baseModified !== currentModified;
}
/**
 * Local/cloud item pair with same URL but different bookmarkId (pure function result).
 * - local: Local DB item (not matched with cloud by syncId)
 * - cloud: Cloud item with same url (different syncId)
 */
export interface UrlIdConflict {
  local: Bookmark;
  cloud: Bookmark;
}

/**
 * URL-based conflict detection (pure function).
 * - When bookmarkId of local item (lb) does not match any cloud item,
 *   but a cloud item with the same url exists (which can be viewed as separate bookmarks with different url and bookmarkId),
 *   returns this pair as a conflict. (Risk of duplicates when bookmarks with same URL are created independently on local/cloud
 *   without sync, resulting in different bookmarkIds — prevents silent dedupe deletion and lets user choose.)
 * - If multiple cloud items exist with same url, uses only the first one (deterministic).
 * - Operates regardless of firstSync (risk of duplicate exists for same URL / different ID regardless of sync status).
 * - However, even with same URL and different ID, if user-facing content (title/description/tags) is completely identical,
 *   **not treated as conflict**. As a pure duplicate where only ID is duplicated without content changes,
 *   it is quietly cleaned up via dedupeByUrl rather than displaying conflict.
 */
export function findUrlIdConflicts(
  localBookmarks: Bookmark[],
  cloudBookmarks: Bookmark[]
): UrlIdConflict[] {
  const cloudByUrl = new Map<string, Bookmark>();
  for (const cb of cloudBookmarks) {
    const norm = normalizeUrl(cb.url);
    if (!cloudByUrl.has(norm)) cloudByUrl.set(norm, cb);
  }
  const conflicts: UrlIdConflict[] = [];
  for (const lb of localBookmarks) {
    const norm = normalizeUrl(lb.url);
    const cloud = cloudByUrl.get(norm);
    // Conflict requires same URL, different syncId, AND differing user-facing content. Identical content is pure duplicate → not a conflict.
    if (cloud && cloud.syncId !== lb.syncId && contentDiffers(lb, cloud)) {
      conflicts.push({ local: lb, cloud });
    }
  }
  return conflicts;
}

