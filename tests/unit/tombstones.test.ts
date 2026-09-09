import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  applyTombstonesToMerge,
  mergeTombstones,
  persistTombstones,
  recordTombstone,
  revokeTombstonesForLiveReRegistrations,
  TOMBSTONE_KEY,
  TOMBSTONE_TTL_MS,
  type Tombstone
} from '../../src/lib/sync/tombstones';

// db.settings mock — only persistTombstones() uses db.settings.put, so mock only that table.
const { mockDb } = vi.hoisted(() => {
  const db = {
    settings: {
      data: new Map<string, any>(),
      clear: async () => db.settings.data.clear(),
      get: async (key: string) => ({ value: db.settings.data.get(key) }),
      put: async (item: { key: string; value: any }) => {
        db.settings.data.set(item.key, item.value);
      }
    }
  };
  return { mockDb: db };
});

vi.mock('../../src/lib/db', () => ({
  default: mockDb
}));

describe('applyTombstonesToMerge', () => {
  it('removes a bookmark when deletion is newer than modification (deletedAt > modifiedAt)', () => {
    const map = new Map<string, { syncId: string; modifiedAt: number }>([
      ['a', { syncId: 'a', modifiedAt: 100 }],
      ['b', { syncId: 'b', modifiedAt: 500 }]
    ]);
    const tombstones: Tombstone[] = [
      { syncId: 'a', deletedAt: 200 }, // Deletion newer than modification -> remove
      { syncId: 'b', deletedAt: 100 }  // Deletion older than modification -> retain
    ];

    const removed = applyTombstonesToMerge(map, tombstones);

    expect(removed).toEqual(['a']);
    expect(map.has('a')).toBe(false);
    expect(map.has('b')).toBe(true);
  });

  it('keeps bookmark when deletion is older than modification', () => {
    const map = new Map<string, { syncId: string; modifiedAt: number }>([
      ['x', { syncId: 'x', modifiedAt: 300 }]
    ]);
    const removed = applyTombstonesToMerge(map, [{ syncId: 'x', deletedAt: 100 }]);

    expect(removed).toEqual([]);
    expect(map.has('x')).toBe(true);
  });

  it('keeps bookmark on tie (deletedAt === modifiedAt) since deletion is not strictly newer', () => {
    const map = new Map<string, { syncId: string; modifiedAt: number }>([
      ['t', { syncId: 't', modifiedAt: 1000 }]
    ]);
    const removed = applyTombstonesToMerge(map, [{ syncId: 't', deletedAt: 1000 }]);

    expect(removed).toEqual([]);
    expect(map.has('t')).toBe(true);
  });

  it('uses the latest deletedAt among duplicate tombstones for the same id', () => {
    const map = new Map<string, { syncId: string; modifiedAt: number }>([
      ['dup', { syncId: 'dup', modifiedAt: 100 }]
    ]);
    const tombstones: Tombstone[] = [
      { syncId: 'dup', deletedAt: 50 },  // Old duplicate -> ignore
      { syncId: 'dup', deletedAt: 300 }  // Newer deletedAt (> 100) -> remove
    ];

    const removed = applyTombstonesToMerge(map, tombstones);

    expect(removed).toEqual(['dup']);
    expect(map.has('dup')).toBe(false);
  });

  it('returns empty list when no tombstone matches any bookmark', () => {
    const map = new Map<string, { syncId: string; modifiedAt: number }>([
      ['a', { syncId: 'a', modifiedAt: 100 }]
    ]);
    const removed = applyTombstonesToMerge(map, [{ syncId: 'nope', deletedAt: 999 }]);

    expect(removed).toEqual([]);
    expect(map.has('a')).toBe(true);
  });

  it('map 키는 syncId다: 삭제 이후 편집되지 않은 북마크만 제거한다', () => {
    const map = new Map<string, { syncId: string; modifiedAt: number }>([
      ['sync-1', { syncId: 'sync-1', modifiedAt: 100 }],  // Last modified before deletion (300) -> remove
      ['sync-2', { syncId: 'sync-2', modifiedAt: 500 }]   // Modified after deletion (300) -> retain
    ]);
    const removed = applyTombstonesToMerge(map, [{ syncId: 'sync-1', deletedAt: 300 }]);

    expect(removed).toEqual(['sync-1']);
    expect(map.has('sync-1')).toBe(false);
    expect(map.has('sync-2')).toBe(true);
  });

  it('keeps a bookmark edited AFTER the tombstone (modifiedAt >= deletedAt)', () => {
    // Even with same syncId, bookmark edited after deletion wins via LWW:
    // Item re-edited after deletion while sync is off must not be removed by tombstone.
    const map = new Map<string, { syncId: string; modifiedAt: number }>([
      ['x', { syncId: 'x', modifiedAt: 500 }]  // Modified after deletion (200)
    ]);
    const removed = applyTombstonesToMerge(map, [{ syncId: 'x', deletedAt: 200 }]);

    expect(removed).toEqual([]);
    expect(map.has('x')).toBe(true);
  });
});

describe('mergeTombstones', () => {
  it('merges local and cloud tombstones, keeping the newest deletedAt per id', () => {
    const local: Tombstone[] = [
      { syncId: 'a', deletedAt: 100 },
      { syncId: 'b', deletedAt: 500 }
    ];
    const cloud: Tombstone[] = [
      { syncId: 'a', deletedAt: 300 }, // Cloud is newer -> wins
      { syncId: 'c', deletedAt: 700 }
    ];

    const merged = mergeTombstones(local, cloud);

    expect(merged).toEqual([
      { syncId: 'a', deletedAt: 300 },
      { syncId: 'b', deletedAt: 500 },
      { syncId: 'c', deletedAt: 700 }
    ]);
  });

  it('keeps local newest when local deletedAt is newer than cloud', () => {
    const merged = mergeTombstones(
      [{ syncId: 'x', deletedAt: 900 }],
      [{ syncId: 'x', deletedAt: 100 }]
    );

    expect(merged).toEqual([{ syncId: 'x', deletedAt: 900 }]);
  });

  it('dedupes exact duplicate entries across local and cloud', () => {
    const merged = mergeTombstones(
      [{ syncId: 'y', deletedAt: 50 }],
      [{ syncId: 'y', deletedAt: 50 }]
    );

    expect(merged).toEqual([{ syncId: 'y', deletedAt: 50 }]);
  });

  it('handles empty inputs', () => {
    expect(mergeTombstones([], [])).toEqual([]);
    expect(mergeTombstones([], [{ syncId: 'z', deletedAt: 1 }])).toEqual([
      { syncId: 'z', deletedAt: 1 }
    ]);
  });
});

describe('revokeTombstonesForLiveReRegistrations', () => {
  it('revokes a tombstone whose syncId has a live record registered at/after the deletion (re-import resurrection)', () => {
    const tombstones: Tombstone[] = [{ syncId: 'a', deletedAt: 200 }];
    const survivors = revokeTombstonesForLiveReRegistrations(tombstones, [
      { syncId: 'a', modifiedAt: 500 } // re-imported after deletion
    ]);
    expect(survivors).toEqual([]);
    expect(tombstones).toEqual([]); // mutates in place
  });

  it('revokes on tie (modifiedAt === deletedAt — same-ms re-registration)', () => {
    const tombstones: Tombstone[] = [{ syncId: 't', deletedAt: 1000 }];
    expect(revokeTombstonesForLiveReRegistrations(tombstones, [{ syncId: 't', modifiedAt: 1000 }])).toEqual([]);
  });

  it('keeps a tombstone for deletion recorded AFTER the live record (genuine delete propagation)', () => {
    const tombstones: Tombstone[] = [{ syncId: 'b', deletedAt: 900 }];
    const survivors = revokeTombstonesForLiveReRegistrations(tombstones, [
      { syncId: 'b', modifiedAt: 300 } // live record older than the deletion -> zombie, deletion wins
    ]);
    expect(survivors).toEqual([{ syncId: 'b', deletedAt: 900 }]);
  });

  it('keeps tombstones for syncIds with no live local record', () => {
    const tombstones: Tombstone[] = [{ syncId: 'gone', deletedAt: 200 }];
    const survivors = revokeTombstonesForLiveReRegistrations(tombstones, [
      { syncId: 'other', modifiedAt: 500 }
    ]);
    expect(survivors).toEqual([{ syncId: 'gone', deletedAt: 200 }]);
  });

  it('evaluates per-syncId: revoked and retained coexist', () => {
    const tombstones: Tombstone[] = [
      { syncId: 'revive', deletedAt: 200 },
      { syncId: 'stay-dead', deletedAt: 800 }
    ];
    const survivors = revokeTombstonesForLiveReRegistrations(tombstones, [
      { syncId: 'revive', modifiedAt: 300 },
      { syncId: 'stay-dead', modifiedAt: 400 }
    ]);
    expect(survivors).toEqual([{ syncId: 'stay-dead', deletedAt: 800 }]);
  });

  it('uses the newest modifiedAt when duplicate live records share a syncId', () => {
    const tombstones: Tombstone[] = [{ syncId: 'd', deletedAt: 500 }];
    const survivors = revokeTombstonesForLiveReRegistrations(tombstones, [
      { syncId: 'd', modifiedAt: 100 },
      { syncId: 'd', modifiedAt: 700 }
    ]);
    expect(survivors).toEqual([]);
  });

  it('is a no-op on empty tombstone list', () => {
    expect(revokeTombstonesForLiveReRegistrations([], [{ syncId: 'a', modifiedAt: 1 }])).toEqual([]);
  });
});

describe('persistTombstones (no TTL — permanent deletion)', () => {
  beforeEach(async () => {
    await mockDb.settings.clear();
  });

  it('keeps all tombstones, including very old deletions', async () => {
    const now = Date.now();
    const recent: Tombstone = { syncId: 'recent', deletedAt: now - 1000 };
    const old: Tombstone = { syncId: 'old', deletedAt: now - TOMBSTONE_TTL_MS - 5 * 24 * 60 * 60 * 1000 };

    const result = await persistTombstones([recent, old]);

    expect(result).toEqual([recent, old]);
    const persisted = await mockDb.settings.get(TOMBSTONE_KEY);
    expect(persisted.value).toEqual([recent, old]);
  });

  it('persists an empty array when there are no tombstones', async () => {
    const result = await persistTombstones([]);

    expect(result).toEqual([]);
    const persisted = await mockDb.settings.get(TOMBSTONE_KEY);
    expect(persisted.value).toEqual([]);
  });

  it('keeps a tombstone exactly at the former TTL boundary', async () => {
    const now = Date.now();
    const boundary: Tombstone = { syncId: 'edge', deletedAt: now - TOMBSTONE_TTL_MS };

    const result = await persistTombstones([boundary]);

    expect(result).toEqual([boundary]);
  });
});

describe('recordTombstone', () => {
  beforeEach(async () => {
    await mockDb.settings.clear();
  });

  it('adds a new tombstone when the id is not recorded yet', async () => {
    await recordTombstone('a', 100);

    const persisted = await mockDb.settings.get(TOMBSTONE_KEY);
    expect(persisted.value).toEqual([{ syncId: 'a', deletedAt: 100 }]);
  });

  it('updates deletedAt to the latest value on duplicate id (m-4)', async () => {
    await recordTombstone('dup', 100);
    await recordTombstone('dup', 300); // More recent deletion -> update deletedAt

    const persisted = await mockDb.settings.get(TOMBSTONE_KEY);
    expect(persisted.value).toEqual([{ syncId: 'dup', deletedAt: 300 }]);
  });

  it('keeps the newest deletedAt when a duplicate id is recorded with an older value', async () => {
    await recordTombstone('dup', 500);
    await recordTombstone('dup', 100); // Older deletion -> ignore

    const persisted = await mockDb.settings.get(TOMBSTONE_KEY);
    expect(persisted.value).toEqual([{ syncId: 'dup', deletedAt: 500 }]);
  });

  it('persists multiple distinct ids as separate entries', async () => {
    await recordTombstone('a', 100);
    await recordTombstone('b', 200);

    const persisted = await mockDb.settings.get(TOMBSTONE_KEY);
    expect(persisted.value).toEqual([
      { syncId: 'a', deletedAt: 100 },
      { syncId: 'b', deletedAt: 200 }
    ]);
  });

  it('syncId를 전역 키로 사용한다: 같은 syncId면 bookmarkId가 달라도 중복 갱신', async () => {
    // Since syncId is sync identity key, re-recording with same syncId updates only deletedAt without duplicates.
    await recordTombstone('sync-dup', 100);
    await recordTombstone('sync-dup', 250);

    const persisted = await mockDb.settings.get(TOMBSTONE_KEY);
    expect(persisted.value).toEqual([{ syncId: 'sync-dup', deletedAt: 250 }]);
  });
});
