import db from '../db';
import { normalizeUrl } from '../bookmarks/url-normalizer';
import type { ArchiveIndexEntry } from './archive-index';

export interface ArchiveTombstone {
  syncId: string;
  url?: string;
  deletedAt: number;
}

export const ARCHIVE_TOMBSTONE_KEY = 'archive_tombstones';
export const ARCHIVE_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function getArchiveTombstones(): Promise<ArchiveTombstone[]> {
  try {
    const rec = await db.settings.get(ARCHIVE_TOMBSTONE_KEY);
    return Array.isArray(rec?.value) ? (rec!.value as ArchiveTombstone[]) : [];
  } catch {
    return [];
  }
}

export async function recordArchiveTombstone(
  syncId: string,
  url?: string,
  deletedAt: number = Date.now()
): Promise<void> {
  if (!syncId && !url) return;
  try {
    const tombstones = await getArchiveTombstones();
    const normUrl = url ? normalizeUrl(url) : '';
    const existing = tombstones.find((t) => {
      if (syncId && t.syncId === syncId) return true;
      if (url && t.url === url) return true;
      if (normUrl && t.url && normalizeUrl(t.url) === normUrl) return true;
      return false;
    });

    if (existing) {
      if (existing.deletedAt < deletedAt) existing.deletedAt = deletedAt;
      if (url && !existing.url) existing.url = url;
      if (syncId && !existing.syncId) existing.syncId = syncId;
    } else {
      tombstones.push({ syncId, url, deletedAt });
    }
    await db.settings.put({ key: ARCHIVE_TOMBSTONE_KEY, value: tombstones });
  } catch (e) {
    console.warn('[archive-tombstone] Failed to record tombstone:', e);
  }
}

export async function removeArchiveTombstone(syncId?: string, url?: string): Promise<void> {
  if (!syncId && !url) return;
  try {
    const tombstones = await getArchiveTombstones();
    const normUrl = url ? normalizeUrl(url) : '';
    const filtered = tombstones.filter((t) => {
      if (syncId && t.syncId === syncId) return false;
      if (url && t.url === url) return false;
      if (normUrl && t.url && normalizeUrl(t.url) === normUrl) return false;
      return true;
    });
    if (filtered.length !== tombstones.length) {
      await db.settings.put({ key: ARCHIVE_TOMBSTONE_KEY, value: filtered });
    }
  } catch (e) {
    console.warn('[archive-tombstone] Failed to remove tombstone:', e);
  }
}

export function isArchiveTombstoned(
  entry: ArchiveIndexEntry,
  tombstones: ArchiveTombstone[],
  normalizeFn: (url: string) => string = normalizeUrl
): boolean {
  if (entry.deleted) return true;
  if (!tombstones || tombstones.length === 0) return false;
  const normEntryUrl = entry.url ? normalizeFn(entry.url) : '';
  for (const t of tombstones) {
    const isSameSyncId = Boolean(t.syncId && entry.syncId && entry.syncId === t.syncId);
    const isSameUrl = Boolean(
      t.url &&
      entry.url &&
      (entry.url === t.url || (normEntryUrl && normalizeFn(t.url) === normEntryUrl))
    );
    if (isSameSyncId || isSameUrl) {
      // If the entry was archived after the deletion tombstone, it represents a newer re-archive
      if (entry.archivedAt && t.deletedAt && entry.archivedAt > t.deletedAt) {
        continue;
      }
      return true;
    }
  }
  return false;
}
