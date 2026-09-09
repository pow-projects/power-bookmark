import db from '../db';

export interface Tombstone {
  syncId: string;
  deletedAt: number;
}

export const TOMBSTONE_KEY = 'sync_tombstones';
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function getTombstones(): Promise<Tombstone[]> {
  const rec = await db.settings.get(TOMBSTONE_KEY);
  return Array.isArray(rec?.value) ? (rec!.value as Tombstone[]) : [];
}

// INVARIANT: Tombstones are recorded permanently without TTL (see persistTombstones) — false recording
//   permanently revokes archives/bookmarks for that syncId. Only recordTombstone after deletion intent is confirmed at call site.
//   (regression: archive-reset-wipe-regression S2 — presence/absence of tombstone is the only gate for deletion propagation)
export async function recordTombstone(syncId: string, deletedAt: number): Promise<void> {
  const tombstones = await getTombstones();
  // m-4: If already exists, update with latest deletedAt (reflects more recent deletion — conservative direction)
  const existing = tombstones.find((t) => t.syncId === syncId);
  if (existing) {
    if (existing.deletedAt < deletedAt) existing.deletedAt = deletedAt;
  } else {
    tombstones.push({ syncId, deletedAt });
  }
  await db.settings.put({ key: TOMBSTONE_KEY, value: tombstones });
}

export async function removeTombstone(syncId: string): Promise<void> {
  const tombstones = await getTombstones();
  const filtered = tombstones.filter((t) => t.syncId !== syncId);
  if (filtered.length !== tombstones.length) {
    await db.settings.put({ key: TOMBSTONE_KEY, value: filtered });
  }
}

export async function clearTombstones(): Promise<void> {
  if (typeof db !== 'undefined' && db.settings) {
    if (typeof db.settings.delete === 'function') {
      await db.settings.delete(TOMBSTONE_KEY);
    } else {
      await db.settings.put({ key: TOMBSTONE_KEY, value: [] });
    }
  }
}

/**
 * Applies tombstones to a merge map using LWW between the deletion time and
 * the bookmark's modifiedAt. A tombstone removes a bookmark only when the
 * deletion is newer than its last modification (deletedAt > modifiedAt); a
 * bookmark edited after the tombstone (modifiedAt >= deletedAt) survives
 * because the later edit wins. syncId is a globally-unique immutable UUID, so
 * a tombstone keyed by syncId can never wrongly match a different bookmark —
 * unlike a URL/createdAt-based guard, no creation-time proxy is needed.
 * Returns the removed syncIds.
 */
export function applyTombstonesToMerge(
  mergedMap: Map<string, { syncId: string; modifiedAt: number }>,
  tombstones: Tombstone[]
): string[] {
  const tombstoneMap = new Map<string, number>();
  for (const t of tombstones) {
    const existing = tombstoneMap.get(t.syncId);
    if (existing === undefined || t.deletedAt > existing) {
      tombstoneMap.set(t.syncId, t.deletedAt);
    }
  }

  const removed: string[] = [];
  for (const [id, bm] of mergedMap.entries()) {
    const deletedAt = tombstoneMap.get(id);
    if (deletedAt !== undefined && deletedAt > bm.modifiedAt) {
      mergedMap.delete(id);
      removed.push(id);
    }
  }
  return removed;
}

export function mergeTombstones(local: Tombstone[], cloud: Tombstone[]): Tombstone[] {
  const map = new Map<string, number>();
  for (const t of [...local, ...cloud]) {
    const existing = map.get(t.syncId);
    if (existing === undefined || t.deletedAt > existing) {
      map.set(t.syncId, t.deletedAt);
    }
  }
  return Array.from(map.entries()).map(([syncId, deletedAt]) => ({
    syncId,
    deletedAt
  }));
}

/**
 * Revoke tombstones for bookmarks that have been legitimately re-registered AFTER deletion.
 *
 * INVARIANT (re-registration revokes deletion intent): A live local record whose syncId carries a
 *   tombstone AND whose modifiedAt >= deletedAt is a deliberate re-registration (import/re-add), not
 *   a zombie — it survives LWW (strict `>`) anyway, but the cloud tombstone would remain permanently
 *   parked in the payload (removeTombstone only clears the LOCAL copy; mergeTombstones re-absorbs the
 *   cloud one at every sync). Any later event that rolls modifiedAt back below that parked deletedAt
 *   (pre-merge cloud adoption on identical content, restored stale backups, clock skew) then re-kills
 *   the bookmark AND its browser node (regression: delete-all -> re-import -> auto-kill). Revoking at
 *   sync time drops it from the uploaded payload so the revocation propagates to all devices.
 *   Deletions recorded AFTER registration (deletedAt > modifiedAt) are NOT revoked here, so genuine
 *   delete propagation (incl. re-delete after re-import) still wins.
 * Mutates `tombstones` in place; returns the survivors for payload persistence.
 */
export function revokeTombstonesForLiveReRegistrations(
  tombstones: Tombstone[],
  liveRecords: Array<{ syncId: string; modifiedAt: number }>
): Tombstone[] {
  if (tombstones.length === 0) return tombstones;
  const newestLive = new Map<string, number>();
  for (const r of liveRecords) {
    const cur = newestLive.get(r.syncId);
    if (cur === undefined || r.modifiedAt > cur) {
      newestLive.set(r.syncId, r.modifiedAt);
    }
  }
  const survivors = tombstones.filter((t) => {
    const modifiedAt = newestLive.get(t.syncId);
    return !(modifiedAt !== undefined && modifiedAt >= t.deletedAt);
  });
  survivors.length > 0
    ? tombstones.splice(0, tombstones.length, ...survivors)
    : tombstones.splice(0, tombstones.length);
  return tombstones;
}

export async function persistTombstones(tombstones: Tombstone[]): Promise<Tombstone[]> {
  // Retain all without TTL — deletions must be permanent. (If deleted after 30-day TTL, subsequent
  // delayed syncs / stale copies from other devices would resurrect bookmarks on cloud resync without tombstone protection.)
  // Tombstones are only {syncId, deletedAt} with very small footprint,
  // syncId is globally unique (UUID) without reissue/cross-device collisions,
  // and applyTombstonesToMerge modifiedAt LWW guard (retaining bookmarks edited after deletion) protects against unintended deletions.
  await db.settings.put({ key: TOMBSTONE_KEY, value: tombstones });
  return tombstones;
}
