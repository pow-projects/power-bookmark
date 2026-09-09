/**
 * QA verification test (t_55742127) Scenario 2: Execute sync when "archive sync" is enabled after connect.
 *
 * The [major] fix target of parent task (t_db8f4dca/t_e0145080) is "execute immediate catch-up when toggle is ON".
 * The intention reflected in code is common helper `setArchiveSyncEnabled(enabled)` (lib/archive-cloud.ts:50-55):
 *   - ON (true) : Save setting + immediately call `syncPendingArchives()`
 *   - OFF (false): Save setting only (no sync trigger)
 *
 * This test connects that common helper with the actual archive-cloud path (real adapter + browser.storage.local
 * single-flight simulation) to verify "enable archive sync after connect -> execute sync":
 *   1) Enabled (true) -> Save setting + immediately upload all pending archives + status uploaded
 *   2) Disabled (false) -> Save setting only, no sync execution (no upload)
 *   3) syncPendingArchives is a no-op when directly called while disabled due to gate (setting)
 * Implementation code is not modified (QA only).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudStorageAdapter, type FileInfo } from '../../src/lib/sync/adapters/base';

// ---- browser.storage.local simulation (single-flight marker behaves like real storage) ----
const storageMap = new Map<string, any>();
const storageLocal = {
  get: async (keys: string | string[]) => {
    if (typeof keys === 'string') return { [keys]: storageMap.get(keys) };
    const out: Record<string, any> = {};
    for (const k of keys) if (storageMap.has(k)) out[k] = storageMap.get(k);
    return out;
  },
  set: async (items: Record<string, any>) => { for (const [k, v] of Object.entries(items)) storageMap.set(k, v); },
  remove: async (keys: string | string[]) => { for (const k of Array.isArray(keys) ? keys : [keys]) storageMap.delete(k); }
};
(globalThis as any).browser = { storage: { local: storageLocal } };

// ---- In-memory cloud adapter (real CloudStorageAdapter contract) ----
interface CloudFile { data: Uint8Array; modifiedAt: number; }
class MemAdapter extends CloudStorageAdapter {
  files = new Map<string, CloudFile>();
  folders = new Set<string>();
  private clock = Date.now();
  async authenticate() {}
  async revoke() {}
  async readFile(p: string): Promise<string> { const f = this.files.get(p); if (!f) throw new Error(`File not found: ${p}`); return new TextDecoder().decode(f.data); }
  async writeFile(p: string, d: string): Promise<void> { this.touch(p, new TextEncoder().encode(d)); }
  async ensureFolder(f: string): Promise<void> { this.folders.add(f); }
  async writeBinaryFile(p: string, d: Blob): Promise<void> { this.touch(p, new Uint8Array(await d.arrayBuffer())); }
  async readBinaryFile(p: string): Promise<Blob> { const f = this.files.get(p); if (!f) throw new Error(`File not found: ${p}`); return new Blob([f.data as unknown as ArrayBuffer]); }
  async deleteFile(p: string): Promise<void> { this.files.delete(p); }
  async getLastModified(p: string): Promise<number> { return this.files.get(p)?.modifiedAt ?? 0; }
  async listFiles(): Promise<FileInfo[]> { return []; }
  private touch(p: string, data: Uint8Array) {
    this.clock += 1000;
    this.files.set(p, { data, modifiedAt: this.clock });
  }
}

// ---- db mock ----
const stores = { bookmarks: [] as any[], archivedPages: [] as any[], settings: new Map<string, any>(), nextId: 1 };
function makeTable(key: 'bookmarks' | 'archivedPages') {
  const arr = () => stores[key];
  const t: any = {
    where: (idx: string) => ({ equals: (v: any) => ({ first: async () => arr().find((r: any) => r[idx] === v) }) }),
    first: async () => arr()[0],
    toArray: async () => [...arr()],
    get: async (id: number) => arr().find((r: any) => r.id === id),
    put: async (row: any) => {
      const id = row.id ?? stores.nextId++;
      const i = arr().findIndex((r: any) => r.id === id);
      if (i >= 0) arr()[i] = { ...row, id }; else arr().push({ ...row, id });
      return id;
    },
    add: async (row: any) => { const id = stores.nextId++; arr().push({ ...row, id }); return id; },
    delete: async (id: number) => { const i = arr().findIndex((r: any) => r.id === id); if (i >= 0) { arr().splice(i, 1); return 1; } return 0; }
  };
  return t;
}
vi.mock('../../src/lib/db', () => ({
  default: {
    bookmarks: makeTable('bookmarks'),
    archivedPages: makeTable('archivedPages'),
    syncState: { put: vi.fn() },
    settings: {
      get: async (key: string) => ({ value: stores.settings.get(key) }),
      put: async (it: { key: string; value: any }) => { stores.settings.set(it.key, it.value); },
      delete: async (key: string) => { stores.settings.delete(key); }
    },
    transaction: async (_m: string, _t: any, fn: () => Promise<void>) => { await fn(); }
  }
}));

let adapter = new MemAdapter();
vi.mock('../../src/lib/sync/sync-engine', () => ({ SyncEngine: { getAdapter: vi.fn().mockImplementation(async () => adapter) } }));

import { setArchiveSyncEnabled, syncPendingArchives } from '../../src/lib/archive/archive-cloud';
import { getUploadStateMap } from '../../src/lib/archive/archive-upload-state';

const ARCHIVES = 'archives';
const INDEX = `${ARCHIVES}/index.json`;

function seed(syncId: string) {
  const b = { id: stores.nextId++, syncId, bookmarkId: `bk-${syncId}`, title: 'T', url: `https://${syncId}.com` };
  stores.bookmarks.push(b);
  const blob = new Blob([`<html>${syncId}</html>`], { type: 'text/html' });
  stores.archivedPages.push({ id: stores.nextId++, bookmarkId: b.id, url: b.url, htmlBlob: blob, fileSize: blob.size, archivedAt: 1000 });
  return b;
}
function indexEntries(): string[] {
  const txt = new TextDecoder().decode(adapter.files.get(INDEX)!.data);
  return JSON.parse(txt).entries.map((e: any) => e.syncId);
}
function htmlUploadedCount(): number {
  return [...adapter.files.keys()].filter((p) => p.endsWith('.html')).length;
}

describe('연동 후 아카이브 동기화 활성화 → 동기화 실행 (QA 검증, setArchiveSyncEnabled 경로)', () => {
  beforeEach(() => {
    stores.bookmarks = []; stores.archivedPages = []; stores.settings.clear(); stores.nextId = 1;
    storageMap.clear();
    adapter = new MemAdapter();
    // "After connect" state: Drive provider connected, but archive sync still disabled.
    stores.settings.set('sync_provider', 'google-drive');
    stores.settings.set('sync_archive_to_cloud', false);
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('활성화(true) → 설정 저장 + 보류 아카이브 4건 즉시 전부 업로드 + 상태 uploaded', async () => {
    const ids = ['a1', 'a2', 'a3', 'a4'];
    for (const id of ids) seed(id);

    await setArchiveSyncEnabled(true);

    // 1) Save setting
    expect(stores.settings.get('sync_archive_to_cloud')).toBe(true);
    // 2) All archive HTML exists in cloud
    for (const id of ids) {
      expect(adapter.files.has(`${ARCHIVES}/${id}.html`)).toBe(true);
    }
    // 3) All 4 items registered in index.json
    expect(indexEntries().sort()).toEqual([...ids].sort());
    // 4) Status map: all 4 items uploaded
    const stateMap = await getUploadStateMap();
    const uploaded = Object.values(stateMap).filter((s: any) => s.status === 'uploaded');
    expect(uploaded).toHaveLength(4);
  });

  it('비활성화(false) → 설정 저장만, 동기화 미실행(업로드 없음)', async () => {
    seed('x1'); seed('x2');

    await setArchiveSyncEnabled(false);

    expect(stores.settings.get('sync_archive_to_cloud')).toBe(false);
    expect(htmlUploadedCount()).toBe(0);
    expect(adapter.files.has(INDEX)).toBe(false); // index.json is also not created
  });

  it('비활성 상태에서 syncPendingArchives를 직접 호출해도 no-op (활성화 게이트)', async () => {
    seed('y1');

    await syncPendingArchives();

    expect(htmlUploadedCount()).toBe(0);
    expect(adapter.files.has(INDEX)).toBe(false);
    expect(stores.settings.get('sync_archive_to_cloud')).toBe(false);
  });

  it('이미 uploaded된 항목은 활성화 시 재업로드하지 않는다 (멱등)', async () => {
    // Enable first to upload a1
    seed('a1');
    await setArchiveSyncEnabled(true);
    // Next, add new archive a2, call enable again with setting retained (toggle re-ON scenario)
    seed('a2');
    await setArchiveSyncEnabled(true);

    // No duplicate syncId in index
    const entries = indexEntries();
    expect(entries.filter((s) => s === 'a1')).toHaveLength(1);
    expect(entries.filter((s) => s === 'a2')).toHaveLength(1);
    // Both items uploaded
    const stateMap = await getUploadStateMap();
    expect(stateMap['a1'].status).toBe('uploaded');
    expect(stateMap['a2'].status).toBe('uploaded');
  });
});
