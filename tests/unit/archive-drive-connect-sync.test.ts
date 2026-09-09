/**
 * QA verification test (t_55742127): Multiple archive items sync scenario on initial Drive connection.
 *
 * Background (Fix in parent task t_e0145080):
 *   - single-flight claim marker (archive_upload_state) remained even after upload 'completion (uploaded)',
 *     blocking next syncId claim for STALE_MS (10 min) in syncPendingArchives sequential loop.
 *     -> Critical defect where only first single item uploaded in a single connect/catch-up.
 *   - Fix: Strengthened claimArchiveUpload to only block in-progress markers with status==='uploading' —
 *     completion/failure markers can be claimed immediately by other syncIds.
 *
 * This test reproduces the 'initial Drive connection' scenario directly:
 *   - Simulate browser.storage.local realistically in-memory (enable single-flight path).
 *   - Seed multiple unuploaded archives in local DB.
 *   - Call syncPendingArchives() once after initial connection (connect completed).
 *   - Expectation: All archives are uploaded without being blocked in sequential loop.
 *
 * Implementation code is not modified (QA only). Report bugs if found.
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

import { syncPendingArchives } from '../../src/lib/archive/archive-cloud';
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

describe('최초 Drive 연결 시 다중 아카이브 항목 동기화 (QA 검증)', () => {
  beforeEach(() => {
    stores.bookmarks = []; stores.archivedPages = []; stores.settings.clear(); stores.nextId = 1;
    storageMap.clear();
    adapter = new MemAdapter();
    // Settings right after initial connection: enable archive cloud sync + return Drive adapter
    stores.settings.set('sync_archive_to_cloud', true);
    stores.settings.set('sync_provider', 'google-drive');
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('미업로드 아카이브 5건이 최초 연결 후 한 번의 syncPendingArchives로 전부 업로드된다', async () => {
    const ids = ['s1', 's2', 's3', 's4', 's5'];
    for (const id of ids) seed(id);

    await syncPendingArchives();

    // 1) All archive HTML files exist in cloud
    for (const id of ids) {
      expect(adapter.files.has(`${ARCHIVES}/${id}.html`)).toBe(true);
    }
    // 2) All 5 items registered in index.json
    const txt = new TextDecoder().decode(adapter.files.get(INDEX)!.data);
    const parsed = JSON.parse(txt);
    const syncIds = parsed.entries.map((e: any) => e.syncId);
    expect(syncIds.sort()).toEqual([...ids].sort());
    // 3) Status map: all 5 items uploaded
    const stateMap = await getUploadStateMap();
    const uploaded = Object.values(stateMap).filter((s: any) => s.status === 'uploaded');
    expect(uploaded).toHaveLength(5);
  });

  it('연결 시 이미 uploaded 상태인 항목은 건너뛰고 미업로드 항목만 업로드한다 (멱등 캐치업)', async () => {
    // Seed already uploaded item (uploaded recorded in status map)
    seed('done1');
    // Unuploaded item
    seed('todo1');
    await syncPendingArchives();
    // done1 recorded with uploaded marker
    await syncPendingArchives(); // Second catch-up — must be idempotent

    const stateMap = await getUploadStateMap();
    expect(stateMap['done1'].status).toBe('uploaded');
    expect(stateMap['todo1'].status).toBe('uploaded');
    expect(adapter.files.has(`${ARCHIVES}/done1.html`)).toBe(true);
    expect(adapter.files.has(`${ARCHIVES}/todo1.html`)).toBe(true);
    // No duplicate registration in index (single entry per syncId)
    const txt = new TextDecoder().decode(adapter.files.get(INDEX)!.data);
    const parsed = JSON.parse(txt);
    const counts = parsed.entries.reduce((acc: any, e: any) => { acc[e.syncId] = (acc[e.syncId] || 0) + 1; return acc; }, {});
    expect(counts['done1']).toBe(1);
    expect(counts['todo1']).toBe(1);
  });
});
