/**
 * Repro test (QA -> regression post-fix): Verify Drive integration archive sync "syncs single item only" bug.
 *
 * Hypothesis (pre-fix): single-flight claim marker (archive_upload_state) remained even after upload 'completion',
 * blocking claim of subsequent syncId in syncPendingArchives sequential loop.
 * -> Only first item uploaded, subsequent items could only be claimed after STALE_MS (10 min).
 *
 * Fix: Changed claimArchiveUpload to only block in-progress markers with status==='uploading' —
 * 'uploaded'/'error' completion markers can be claimed immediately by other syncIds.
 * The test below is a regression test asserting expected behavior post-fix (all 3 items uploaded).
 *
 * Existing archive-cloud*.test.ts did not mock browser.storage.local, so hasStorage()==false ->
 * claimArchiveUpload always returned true -> masking this bug. Here browser.storage.local is
 * simulated realistically to cover the single-flight path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
import { CloudStorageAdapter, type FileInfo } from '../../src/lib/sync/adapters/base';
class MemAdapter extends CloudStorageAdapter {
  files = new Map<string, Uint8Array>();
  folders = new Set<string>();
  async authenticate() {}
  async revoke() {}
  async readFile(p: string): Promise<string> { const f = this.files.get(p); if (!f) throw new Error(`File not found: ${p}`); return new TextDecoder().decode(f); }
  async writeFile(p: string, d: string): Promise<void> { this.files.set(p, new TextEncoder().encode(d)); }
  async ensureFolder(f: string): Promise<void> { this.folders.add(f); }
  async writeBinaryFile(p: string, d: Blob): Promise<void> { this.files.set(p, new Uint8Array(await d.arrayBuffer())); }
  async readBinaryFile(p: string): Promise<Blob> { const f = this.files.get(p); if (!f) throw new Error(`File not found: ${p}`); return new Blob([f as any]); }
  async deleteFile(p: string): Promise<void> { this.files.delete(p); }
  async getLastModified(): Promise<number> { return 0; }
  async listFiles(): Promise<FileInfo[]> { return []; }
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

import { syncPendingArchives, syncArchiveToCloudByBookmarkId } from '../../src/lib/archive/archive-cloud';
import { claimArchiveUpload, markUploaded } from '../../src/lib/archive/archive-upload-state';

const ARCHIVES = 'archives';

function seed(syncId: string) {
  const b = { id: stores.nextId++, syncId, bookmarkId: `bk-${syncId}`, title: 'T', url: `https://${syncId}.com` };
  stores.bookmarks.push(b);
  const blob = new Blob([`<html>${syncId}</html>`], { type: 'text/html' });
  stores.archivedPages.push({ id: stores.nextId++, bookmarkId: b.id, url: b.url, htmlBlob: blob, fileSize: blob.size, archivedAt: 1000 });
  return b;
}

describe('단일 항목만 동기화 버그 재현 (수정 후 회귀)', () => {
  beforeEach(() => {
    stores.bookmarks = []; stores.archivedPages = []; stores.settings.clear(); stores.nextId = 1;
    storageMap.clear();
    adapter = new MemAdapter();
    stores.settings.set('sync_archive_to_cloud', true);
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('진행 중(uploading) 마커만 다른 syncId의 claim을 차단한다', async () => {
    // In-progress claim -> block other syncIds (maintain TOCTOU prevention)
    expect(await claimArchiveUpload('sync-A')).toBe(true);
    expect(await claimArchiveUpload('sync-B')).toBe(false);
    // Update with completion (uploaded) marker -> other syncIds can claim immediately (bug fix)
    await markUploaded('sync-A');
    expect(await claimArchiveUpload('sync-B')).toBe(true);
  });

  it('syncPendingArchives: 아카이브 3건이 있을 때 모두 업로드된다', async () => {
    seed('sync-1'); seed('sync-2'); seed('sync-3');
    await syncPendingArchives();
    // Count of actually saved archive files
    const uploaded = [...adapter.files.keys()].filter((p) => p.endsWith('.html'));
    // Count of syncIds registered in index.json
    let indexCount = 0;
    if (adapter.files.has(`${ARCHIVES}/index.json`)) {
      const txt = new TextDecoder().decode(adapter.files.get(`${ARCHIVES}/index.json`)!);
      indexCount = (txt.match(/syncId/g) || []).length;
    }
    expect(uploaded.length).toBe(3); // Pre-bugfix: 1
    expect(indexCount).toBe(3);
  });
});
