/**
 * Pure logic module for archive cloud index.
 *
 * Handles filename generation, format detection, LWW conflict resolution, index merging, and tombstone (30-day TTL) processing.
 * This module contains only pure functions and does not access DB or storage.browser.
 * (Filename helpers reuse export-manager.toSafeAsciiFilename.)
 */

import { toSafeAsciiFilename } from '../bookmarks/export-manager';

export type ArchiveFormat = 'raw' | 'gzip';

export interface ArchiveIndexEntry {
  syncId: string;        // Global immutable key for bookmark (filename/identifier)
  bookmarkId: string;    // Last observed browser bookmark id (informational, differs across devices)
  url: string;
  title: string;         // Display title (A-4 additional info)
  fileName: string;      // "<syncId>.html"
  fileSize: number;      // bytes
  format: ArchiveFormat; // raw | gzip (EC-2 distinction)
  archivedAt: number;    // LWW key
  deleted?: boolean;     // tombstone (G-2 soft-delete, 30-day TTL)
  deletedAt?: number;
}

export interface ArchiveIndex {
  version: 1;
  entries: ArchiveIndexEntry[];
  updatedAt: number;
}

/** Path constants — common to all providers, relative to app-dedicated storage */
export const ARCHIVES_FOLDER = 'archives';
export const ARCHIVE_INDEX_FILE = 'index.json';

/** tombstone (soft-delete) retention TTL (ms) — 30 days */
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Generates archive filename. Pure syncId unique key + ASCII sanitization (defensive no-op).
 * Since syncId is UUID (ASCII-safe, immutable), it ensures identity and stability across reinstallations.
 * Title slugs are not included in the filename and are only stored in index.json title field.
 */
export function buildArchiveFileName(syncId: string): string {
  return `${toSafeAsciiFilename(syncId)}.html`;
}

/**
 * Format detection — reuses the same marker as page-capture.decompressArchiveHtml.
 * Determined by Blob contents without DB schema changes.
 */
export async function detectArchiveFormat(blob: Blob): Promise<ArchiveFormat> {
  const text = await blob.text();
  return text.includes('DecompressionStream') && text.includes('const p=') ? 'gzip' : 'raw';
}

export interface ArchiveConflictResult {
  winner: ArchiveIndexEntry;
  loser: ArchiveIndexEntry;
  isConflict: boolean;
}

/**
 * Single item LWW winner determination (maintaining determinism).
 * - winner: side with larger archivedAt, ties go to cloud (deterministic fallback).
 * - isConflict: identical archivedAt && different fileSize -> true (D-3 manual resolution candidate).
 * Deletion (tombstone) priority is handled during the merge phase.
 */
export function resolveArchiveConflict(
  local: ArchiveIndexEntry,
  cloud: ArchiveIndexEntry
): ArchiveConflictResult {
  if (cloud.archivedAt > local.archivedAt) {
    return { winner: cloud, loser: local, isConflict: false };
  }
  if (local.archivedAt > cloud.archivedAt) {
    return { winner: local, loser: cloud, isConflict: false };
  }
  // Tie -> cloud wins (deterministic fallback)
  const isConflict = local.fileSize !== cloud.fileSize;
  return { winner: cloud, loser: local, isConflict };
}

/**
 * Merges local entries and cloud index entries using LWW.
 * - Places cloud entries first, then iterates over local entries updating with resolveArchiveConflict.
 * - Tombstone (deleted=true) entries remove the corresponding syncId entry only if within 30-day TTL.
 *   Tombstones exceeding TTL are ignored (entry retained).
 * - Retains a single entry per syncId.
 */
export function mergeArchiveIndex(
  localEntries: ArchiveIndexEntry[],
  cloudEntries: ArchiveIndexEntry[],
  now = Date.now()
): ArchiveIndexEntry[] {
  const map = new Map<string, ArchiveIndexEntry>();

  // Place cloud entries first
  for (const ce of cloudEntries) {
    map.set(ce.syncId, { ...ce });
  }

  // Iterate over local entries for LWW merge
  for (const le of localEntries) {
    const existing = map.get(le.syncId);
    if (!existing) {
      map.set(le.syncId, { ...le });
      continue;
    }
    const { winner } = resolveArchiveConflict(le, existing);
    map.set(le.syncId, { ...winner });
  }

  // Apply tombstones — valid (within TTL) tombstones remove the entry, expired ones are retained
  const result: ArchiveIndexEntry[] = [];
  for (const entry of map.values()) {
    if (entry.deleted) {
      const deletedAt = entry.deletedAt ?? 0;
      if (deletedAt > 0 && now - deletedAt < TOMBSTONE_TTL_MS) {
        continue; // Valid tombstone -> remove
      }
      // Tombstone exceeding TTL is ignored -> keep as regular entry
      result.push({ ...entry, deleted: undefined, deletedAt: undefined });
      continue;
    }
    result.push(entry);
  }

  return result;
}

/** Create an empty index. */
export function emptyArchiveIndex(now = Date.now()): ArchiveIndex {
  return { version: 1, entries: [], updatedAt: now };
}
