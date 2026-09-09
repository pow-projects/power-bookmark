import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getPendingConflicts,
  resolveConflict,
  resolveBatchConflicts,
  resolveAllConflicts,
  clearResolvedLogs,
  type ConflictLog
} from '../../src/lib/sync/sync-conflict-store';

// db.settings mock — all conflict-store functions use db.settings('sync_conflict_logs').
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

const CONFLICT_KEY = 'sync_conflict_logs';

function makeLog(partial: Partial<ConflictLog> & { id: string }): ConflictLog {
  return {
    status: 'pending',
    autoResolvedTo: 'cloud',
    localVersion: { title: 'local', url: 'https://local.example', modifiedAt: 1 },
    cloudVersion: { title: 'cloud', url: 'https://cloud.example', modifiedAt: 2 },
    bookmarkId: 'bk-1',
    timestamp: Date.now(),
    ...partial
  } as ConflictLog;
}

beforeEach(async () => {
  await mockDb.settings.clear();
});

describe('getPendingConflicts', () => {
  it('returns only pending logs and excludes resolved ones', async () => {
    const pending = makeLog({ id: '1', status: 'pending' });
    const resolved = makeLog({ id: '2', status: 'resolved' });
    await mockDb.settings.put({ key: CONFLICT_KEY, value: [pending, resolved] });

    const result = await getPendingConflicts();

    expect(result.map((l) => l.id)).toEqual(['1']);
  });

  it('excludes legacy logs without a status field (treated as resolved)', async () => {
    const pending = makeLog({ id: '1', status: 'pending' });
    const legacy = {
      id: '2',
      autoResolvedTo: 'cloud',
      localVersion: { title: 'l', url: 'u', modifiedAt: 1 },
      cloudVersion: { title: 'c', url: 'u', modifiedAt: 2 },
      bookmarkId: 'x',
      timestamp: 1
    };
    await mockDb.settings.put({ key: CONFLICT_KEY, value: [pending, legacy] });

    const result = await getPendingConflicts();

    expect(result.map((l) => l.id)).toEqual(['1']);
  });

  it('returns empty array when no logs exist', async () => {
    expect(await getPendingConflicts()).toEqual([]);
  });
});

describe('resolveConflict', () => {
  it('resolves only the matching id, leaving others untouched', async () => {
    const a = makeLog({ id: 'a', status: 'pending' });
    const b = makeLog({ id: 'b', status: 'pending' });
    await mockDb.settings.put({ key: CONFLICT_KEY, value: [a, b] });

    await resolveConflict('a', 'keep-local');

    const stored = (await mockDb.settings.get(CONFLICT_KEY)).value;
    const logA = stored.find((l: any) => l.id === 'a');
    const logB = stored.find((l: any) => l.id === 'b');
    expect(logA.status).toBe('resolved');
    expect(logA.userAction).toBe('keep-local');
    expect(logB.status).toBe('pending');
  });

  it('does nothing when the id is not found', async () => {
    const a = makeLog({ id: 'a', status: 'pending' });
    await mockDb.settings.put({ key: CONFLICT_KEY, value: [a] });

    await resolveConflict('missing', 'keep-cloud');

    const stored = (await mockDb.settings.get(CONFLICT_KEY)).value;
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe('pending');
    expect(stored[0].userAction).toBeUndefined();
  });
});

describe('resolveAllConflicts', () => {
  it('resolves all pending logs to the given action', async () => {
    const a = makeLog({ id: 'a', status: 'pending' });
    const b = makeLog({ id: 'b', status: 'pending' });
    await mockDb.settings.put({ key: CONFLICT_KEY, value: [a, b] });

    await resolveAllConflicts('keep-cloud');

    const stored = (await mockDb.settings.get(CONFLICT_KEY)).value;
    for (const l of stored) {
      expect(l.status).toBe('resolved');
      expect(l.userAction).toBe('keep-cloud');
    }
  });

  it('leaves already-resolved logs unchanged', async () => {
    const a = makeLog({ id: 'a', status: 'resolved', userAction: 'keep-local' });
    const b = makeLog({ id: 'b', status: 'pending' });
    await mockDb.settings.put({ key: CONFLICT_KEY, value: [a, b] });

    await resolveAllConflicts('keep-cloud');

    const stored = (await mockDb.settings.get(CONFLICT_KEY)).value;
    expect(stored.find((l: any) => l.id === 'a').userAction).toBe('keep-local');
    expect(stored.find((l: any) => l.id === 'b').status).toBe('resolved');
  });

  it('does not corrupt data when there are no pending logs', async () => {
    const a = makeLog({ id: 'a', status: 'resolved', userAction: 'keep-local' });
    await mockDb.settings.put({ key: CONFLICT_KEY, value: [a] });

    await resolveAllConflicts('keep-local');

    const stored = (await mockDb.settings.get(CONFLICT_KEY)).value;
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe('resolved');
  });
});

describe('resolveBatchConflicts', () => {
  it('배치로 전달된 충돌 ID 목록을 단일 I/O로 일괄 해결 처리한다 (Array 입력)', async () => {
    const a = makeLog({ id: 'a', status: 'pending' });
    const b = makeLog({ id: 'b', status: 'pending' });
    const c = makeLog({ id: 'c', status: 'pending' });
    await mockDb.settings.put({ key: CONFLICT_KEY, value: [a, b, c] });

    await resolveBatchConflicts([
      { id: 'a', action: 'keep-local' },
      { id: 'b', action: 'keep-cloud' }
    ]);

    const stored = (await mockDb.settings.get(CONFLICT_KEY)).value;
    const logA = stored.find((l: any) => l.id === 'a');
    const logB = stored.find((l: any) => l.id === 'b');
    const logC = stored.find((l: any) => l.id === 'c');
    expect(logA.status).toBe('resolved');
    expect(logA.userAction).toBe('keep-local');
    expect(logB.status).toBe('resolved');
    expect(logB.userAction).toBe('keep-cloud');
    expect(logC.status).toBe('pending');
  });

  it('배치로 전달된 Map/Record 형태의 결정을 일괄 적용한다', async () => {
    const a = makeLog({ id: 'a', status: 'pending' });
    const b = makeLog({ id: 'b', status: 'pending' });
    await mockDb.settings.put({ key: CONFLICT_KEY, value: [a, b] });

    await resolveBatchConflicts({
      a: 'keep-cloud',
      b: 'manual-edit'
    });

    const stored = (await mockDb.settings.get(CONFLICT_KEY)).value;
    expect(stored.find((l: any) => l.id === 'a').userAction).toBe('keep-cloud');
    expect(stored.find((l: any) => l.id === 'b').userAction).toBe('manual-edit');
  });
});

describe('clearResolvedLogs', () => {
  it('keeps only pending logs, dropping resolved and legacy logs', async () => {
    const a = makeLog({ id: 'a', status: 'pending' });
    const b = makeLog({ id: 'b', status: 'resolved' });
    const legacy = {
      id: 'c',
      autoResolvedTo: 'cloud',
      localVersion: { title: 'l', url: 'u', modifiedAt: 1 },
      cloudVersion: { title: 'c', url: 'u', modifiedAt: 2 },
      bookmarkId: 'x',
      timestamp: 1
    };
    await mockDb.settings.put({ key: CONFLICT_KEY, value: [a, b, legacy] });

    await clearResolvedLogs();

    const stored = (await mockDb.settings.get(CONFLICT_KEY)).value;
    expect(stored).toEqual([a]);
  });
});

describe('localVersion/cloudVersion tags 보존', () => {
  it('getPendingConflicts가 tags를 그대로 반환한다', async () => {
    const withMeta = makeLog({
      id: '1',
      status: 'pending',
      localVersion: { title: 'l', url: 'u', modifiedAt: 1, tags: ['l-a', 'l-b'] },
      cloudVersion: { title: 'c', url: 'u', modifiedAt: 2, tags: ['c-a'] }
    });
    await mockDb.settings.put({ key: CONFLICT_KEY, value: [withMeta] });

    const result = await getPendingConflicts();

    expect(result).toHaveLength(1);
    expect(result[0].localVersion.tags).toEqual(['l-a', 'l-b']);
    expect(result[0].cloudVersion.tags).toEqual(['c-a']);
  });

  it('resolveConflict 후에도 저장된 로그의 tags가 보존된다', async () => {
    const withMeta = makeLog({
      id: '1',
      status: 'pending',
      localVersion: { title: 'l', url: 'u', modifiedAt: 1, tags: ['l-a'] },
      cloudVersion: { title: 'c', url: 'u', modifiedAt: 2, tags: ['c-a'] }
    });
    await mockDb.settings.put({ key: CONFLICT_KEY, value: [withMeta] });

    await resolveConflict('1', 'keep-local');

    const stored = (await mockDb.settings.get(CONFLICT_KEY)).value;
    const log = stored.find((l: any) => l.id === '1');
    expect(log.status).toBe('resolved');
    expect(log.localVersion.tags).toEqual(['l-a']);
    expect(log.cloudVersion.tags).toEqual(['c-a']);
  });
});

describe('localVersion/cloudVersion bookmarkId 보존 (URL-기반 충돌)', () => {
  it('getPendingConflicts가 양쪽 bookmarkId를 그대로 반환한다', async () => {
    const withId = makeLog({
      id: '1',
      status: 'pending',
      localVersion: { title: 'l', url: 'https://u.example', modifiedAt: 1, bookmarkId: 'bk-X' },
      cloudVersion: { title: 'c', url: 'https://u.example', modifiedAt: 2, bookmarkId: 'bk-Y' }
    });
    await mockDb.settings.put({ key: CONFLICT_KEY, value: [withId] });

    const result = await getPendingConflicts();
    expect(result).toHaveLength(1);
    expect(result[0].localVersion.bookmarkId).toBe('bk-X');
    expect(result[0].cloudVersion.bookmarkId).toBe('bk-Y');
  });

  it('resolveConflict 후에도 저장된 로그의 양쪽 bookmarkId가 보존된다', async () => {
    const withId = makeLog({
      id: '1',
      status: 'pending',
      localVersion: { title: 'l', url: 'https://u.example', modifiedAt: 1, bookmarkId: 'bk-X' },
      cloudVersion: { title: 'c', url: 'https://u.example', modifiedAt: 2, bookmarkId: 'bk-Y' }
    });
    await mockDb.settings.put({ key: CONFLICT_KEY, value: [withId] });

    await resolveConflict('1', 'keep-cloud');
    const stored = (await mockDb.settings.get(CONFLICT_KEY)).value;
    const log = stored.find((l: any) => l.id === '1');
    expect(log.status).toBe('resolved');
    expect(log.localVersion.bookmarkId).toBe('bk-X');
    expect(log.cloudVersion.bookmarkId).toBe('bk-Y');
  });
});

describe('localVersion/cloudVersion folderPath 보존', () => {
  it('getPendingConflicts가 양쪽 folderPath를 그대로 반환한다', async () => {
    const withFolder = makeLog({
      id: '1',
      status: 'pending',
      localVersion: { title: 'l', url: 'https://u.example', modifiedAt: 1, folderPath: '개발/React' },
      cloudVersion: { title: 'c', url: 'https://u.example', modifiedAt: 2, folderPath: '개발/Svelte' }
    });
    await mockDb.settings.put({ key: CONFLICT_KEY, value: [withFolder] });

    const result = await getPendingConflicts();
    expect(result).toHaveLength(1);
    expect(result[0].localVersion.folderPath).toBe('개발/React');
    expect(result[0].cloudVersion.folderPath).toBe('개발/Svelte');
  });

  it('resolveConflict 후에도 저장된 로그의 양쪽 folderPath가 보존된다', async () => {
    const withFolder = makeLog({
      id: '1',
      status: 'pending',
      localVersion: { title: 'l', url: 'https://u.example', modifiedAt: 1, folderPath: '개발/React' },
      cloudVersion: { title: 'c', url: 'https://u.example', modifiedAt: 2, folderPath: '개발/Svelte' }
    });
    await mockDb.settings.put({ key: CONFLICT_KEY, value: [withFolder] });

    await resolveConflict('1', 'keep-cloud');
    const stored = (await mockDb.settings.get(CONFLICT_KEY)).value;
    const log = stored.find((l: any) => l.id === '1');
    expect(log.status).toBe('resolved');
    expect(log.localVersion.folderPath).toBe('개발/React');
    expect(log.cloudVersion.folderPath).toBe('개발/Svelte');
  });
});

describe('동일 bookmarkId(syncId) 중복 방지', () => {
  it('getPendingConflicts는 동일 bookmarkId를 가진 중복 pending 로그 중 1건만 반환한다', async () => {
    const dup1 = makeLog({ id: 'conf-1', bookmarkId: 'sync-same', status: 'pending' });
    const dup2 = makeLog({ id: 'conf-2', bookmarkId: 'sync-same', status: 'pending' });
    const other = makeLog({ id: 'conf-3', bookmarkId: 'sync-other', status: 'pending' });
    await mockDb.settings.put({ key: CONFLICT_KEY, value: [dup1, dup2, other] });

    const pending = await getPendingConflicts();
    expect(pending).toHaveLength(2);
    expect(pending.map(p => p.id)).toEqual(['conf-1', 'conf-3']);
  });
});

