import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebDavAdapter } from '../../src/lib/sync/adapters/webdav';
import { saveWebdavSettings } from '../../src/lib/sync/webdav-settings';

// ---------------------------------------------------------------------------
// Regression E2E — "Cloud archive loss upon resync after full reset" (bug: archive-reset-wipe)
//
// Live operation verification (no mock adapter — real WebDAV server round-trip):
//   1) Seed 1 local archive -> syncPendingArchives() -> verify .html + index.json entry upload on server
//   2) Simulate full reset (local DB 0 bookmarks, no tombstones) -> re-run syncPendingArchives()
//      -> assert **server files and entries preserved** (FIX-1: orphan deletion tombstone gate)
//   3) Confirm deletion intent (tombstone) -> syncPendingArchives() -> assert file deletion + deleted mark (propagation maintained)
//
// Prerequisite: docker compose -f webdav-test/compose.yml up -d (admin/password123 @ localhost:8085)
// If server is absent, automatically skipped (safe for npm test). Manual execution:
//   npx vitest run tests/integration/archive-reset-wipe.e2e.test.ts
// ---------------------------------------------------------------------------

const WEBDAV_PROBE = {
  url: process.env.WXT_DEV_WEBDAV_URL || 'http://localhost:8085/',
  username: process.env.WXT_DEV_WEBDAV_USERNAME || 'admin',
  password: process.env.WXT_DEV_WEBDAV_PASSWORD || 'password123',
};

const SYNC_ID = 'e2e-wipe-0000-0000-000000000001';
const URL_SEED = 'https://example.com/e2e-wipe-regression';

// --- in-memory db mock (bookmarks/archivedPages/settings including tombstone settings) ---
const { mockDb, tombstonesRef } = vi.hoisted(() => {
  const settingsData = new Map<string, any>();
  let bookmarkSeq = 1;
  let archiveSeq = 1;
  const bookmarks: any[] = [];
  const archivedPages: any[] = [];
  const tombstones = { value: [] as Array<{ syncId: string; deletedAt: number }> };

  const db = {
    settings: {
      get: async (key: string) => {
        if (key === 'sync_tombstones') return { value: tombstones.value };
        return settingsData.has(key) ? { value: settingsData.get(key) } : undefined;
      },
      put: async (item: { key: string; value: any }) => {
        if (item.key === 'sync_tombstones') {
          tombstones.value = item.value;
          return;
        }
        settingsData.set(item.key, item.value);
      },
      delete: async (key: string) => {
        settingsData.delete(key);
      },
      clear: async () => settingsData.clear(),
    },
    bookmarks: {
      toArray: async () => [...bookmarks],
      get: async (id: number) => bookmarks.find((b) => b.id === id),
      put: async (row: any) => {
        if (row.id == null) row.id = bookmarkSeq++;
        const i = bookmarks.findIndex((b) => b.id === row.id);
        if (i >= 0) bookmarks[i] = row;
        else bookmarks.push(row);
        return row.id;
      },
      add: async (row: any) => {
        row.id = bookmarkSeq++;
        bookmarks.push(row);
        return row.id;
      },
      update: async (id: number, changes: any) => {
        const b = bookmarks.find((x) => x.id === id);
        if (b) Object.assign(b, changes);
      },
      delete: async (id: number) => {
        const i = bookmarks.findIndex((b) => b.id === id);
        if (i >= 0) bookmarks.splice(i, 1);
      },
      where: (field: string) => ({
        equals: (val: any) => ({
          first: async () => bookmarks.find((b) => b[field] === val),
          toArray: async () => bookmarks.filter((b) => b[field] === val),
        }),
      }),
      count: async () => bookmarks.length,
      clear: async () => {
        bookmarks.length = 0;
      },
      _list: bookmarks,
    },
    archivedPages: {
      toArray: async () => [...archivedPages],
      where: (field: string) => ({
        equals: (val: any) => ({
          first: async () => archivedPages.find((a) => a[field] === val),
          toArray: async () => archivedPages.filter((a) => a[field] === val),
          delete: async () => {
            const hits = archivedPages.filter((a) => a[field] === val);
            hits.forEach((h) => archivedPages.splice(archivedPages.indexOf(h), 1));
            return hits.length;
          },
        }),
      }),
      put: async (row: any) => {
        if (row.id == null) row.id = archiveSeq++;
        const i = archivedPages.findIndex((a) => a.id === row.id);
        if (i >= 0) archivedPages[i] = row;
        else archivedPages.push(row);
        return row.id;
      },
      count: async () => archivedPages.length,
      clear: async () => {
        archivedPages.length = 0;
      },
      _list: archivedPages,
    },
    syncState: {
      count: async () => 0,
      put: async () => {},
      where: () => ({ equals: () => ({ toArray: async () => [], first: async () => undefined }) }),
      clear: async () => {},
    },
  };
  return { mockDb: db, tombstonesRef: tombstones };
});

vi.mock('../../src/lib/db', () => ({ default: mockDb }));

// SyncEngine.getAdapter -> real WebDavAdapter instance (globalThis relay, adapter logic uses production code)
vi.mock('../../src/lib/sync/sync-engine', () => ({
  SyncEngine: {
    getAdapter: async () => (globalThis as any).__E2E_WIPE_ADAPTER__ ?? null,
  },
}));

const serverUp = async (): Promise<boolean> => {
  try {
    const token = btoa(`${WEBDAV_PROBE.username}:${WEBDAV_PROBE.password}`);
    const res = await fetch(WEBDAV_PROBE.url, { method: 'PROPFIND', headers: { Authorization: `Basic ${token}` } });
    return res.ok;
  } catch {
    return false;
  }
};

const live = await serverUp();

describe.skipIf(!live)('초기화→재동기화 아카이브 소실 회귀 E2E (실 WebDAV localhost:8085)', () => {
  const adapter = new WebDavAdapter();
  let idxPath = '';
  let htmlPath = '';
  let originalIndexJson: string | null = null;

  const readIndexText = async (): Promise<string | null> => {
    try {
      return await adapter.readFile(idxPath);
    } catch {
      return null;
    }
  };
  const serverHasHtml = async (): Promise<boolean> => {
    const list = await adapter.listFiles('archives');
    return list.some((f) => f.name === `${SYNC_ID}.html`);
  };
  const indexEntry = async (): Promise<any | undefined> => {
    const text = await readIndexText();
    if (!text) return undefined;
    return JSON.parse(text).entries.find((e: any) => e.syncId === SYNC_ID);
  };

  const seedLocalArchive = async () => {
    const html = '<!doctype html><html><body><h1>e2e-wipe</h1></body></html>';
    const blob = new Blob([html], { type: 'text/html' });
    const bm = {
      id: 901, syncId: SYNC_ID, bookmarkId: 'bm-e2e-1', url: URL_SEED,
      title: 'E2E 와이프 회귀', description: '', folderPath: '북마크바',
      createdAt: Date.now(), modifiedAt: Date.now(), visitCount: 0,
    };
    await mockDb.bookmarks.put(bm);
    await mockDb.archivedPages.put({
      id: 801, bookmarkId: bm.id, url: URL_SEED, htmlBlob: blob,
      fileSize: blob.size, archivedAt: Date.now(),
    });
  };

  beforeAll(async () => {
    await mockDb.settings.clear();
    await saveWebdavSettings({ url: WEBDAV_PROBE.url, username: WEBDAV_PROBE.username, password: WEBDAV_PROBE.password });
    await adapter.authenticate(true);
    (globalThis as any).__E2E_WIPE_ADAPTER__ = adapter;
    idxPath = 'archives/index.json';
    htmlPath = `archives/${SYNC_ID}.html`;
    // Snapshot for preserving existing user test data
    originalIndexJson = await readIndexText();
    // Initialization to verify re-upload idempotency in upload status map no-op environment (no browser)
    tombstonesRef.value = [];
  });

  afterAll(async () => {
    try {
      await adapter.deleteFile(htmlPath);
    } catch { /* none */ }
    try {
      if (originalIndexJson != null) {
        await adapter.writeFile(idxPath, originalIndexJson);
      } else {
        await adapter.deleteFile(idxPath);
      }
    } catch { /* ignore cleanup failure */ }
    delete (globalThis as any).__E2E_WIPE_ADAPTER__;
  });

  it('단계1: 로컬 아카이브가 syncPendingArchives로 서버에 업로드된다', async () => {
    const { syncPendingArchives } = await import('../../src/lib/archive/archive-cloud');
    await seedLocalArchive();
    await syncPendingArchives();
    expect(await serverHasHtml()).toBe(true);
    const entry = await indexEntry();
    expect(entry).toBeTruthy();
    expect(entry.deleted).toBeFalsy();
    expect(entry.fileName).toBe(`${SYNC_ID}.html`);
  });

  it('단계2(회귀 핵심): 완전 초기화 후 syncPendingArchives 재실행해도 클라우드 아카이브는 보존된다', async () => {
    const { syncPendingArchives } = await import('../../src/lib/archive/archive-cloud');
    // Simulate full reset: clear entire DB, no tombstones (no deletion intent)
    await mockDb.bookmarks.clear();
    await mockDb.archivedPages.clear();
    tombstonesRef.value = [];

    await syncPendingArchives();
    await syncPendingArchives(); // Reproduce up to 2 alarm catch-up runs

    expect(await serverHasHtml()).toBe(true);
    const entry = await indexEntry();
    expect(entry).toBeTruthy();
    expect(entry.deleted).toBeFalsy();
  });

  it('단계3: 삭제 의도(tombstone)가 있으면 삭제 전파가 유지된다', async () => {
    const { syncPendingArchives } = await import('../../src/lib/archive/archive-cloud');
    tombstonesRef.value = [{ syncId: SYNC_ID, deletedAt: Date.now() }];
    await syncPendingArchives();

    expect(await serverHasHtml()).toBe(false);
    const entry = await indexEntry();
    expect(entry?.deleted).toBe(true);
    expect(typeof entry?.deletedAt).toBe('number');
  });
});
