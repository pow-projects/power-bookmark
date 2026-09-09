/**
 * Shared helper setArchiveSyncEnabled(enabled) verification (TDD).
 *
 * Background (Parent t_db8f4dca root cause analysis [major][remaining]):
 *   - SettingsContainer.svelte legacy toggle only wrote sync_archive_to_cloud setting
 *     without calling syncPendingArchives(), requiring waiting until next alarm even when turned ON.
 *   - Recommendation: Unify SyncSettings.svelte / SettingsContainer.svelte toggles into a shared helper.
 *
 * Helper contract (Integrated verification of actual behavior):
 *   - enabled=true  -> Save sync_archive_to_cloud + immediately call syncPendingArchives()
 *     -> Unuploaded archives are uploaded to cloud.
 *   - enabled=false -> Save sync_archive_to_cloud only, do not trigger upload.
 *
 * Uses actual archive-cloud implementation (helper, syncPendingArchives, adapter) directly,
 * verifying behavior by enabling single-flight path with browser.storage.local simulation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudStorageAdapter, type FileInfo } from '../../src/lib/sync/adapters/base';

// ---- browser.storage.local simulation ----
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

// ---- In-memory cloud adapter ----
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

import { setArchiveSyncEnabled } from '../../src/lib/archive/archive-cloud';

const ARCHIVES = 'archives';

function seed(syncId: string) {
  const b = { id: stores.nextId++, syncId, bookmarkId: `bk-${syncId}`, title: 'T', url: `https://${syncId}.com` };
  stores.bookmarks.push(b);
  const blob = new Blob([`<html>${syncId}</html>`], { type: 'text/html' });
  stores.archivedPages.push({ id: stores.nextId++, bookmarkId: b.id, url: b.url, htmlBlob: blob, fileSize: blob.size, archivedAt: 1000 });
  return b;
}

function uploadedHtmlFiles(): string[] {
  return [...adapter.files.keys()].filter((p) => p.endsWith('.html'));
}

describe('setArchiveSyncEnabled (공용 토글 헬퍼)', () => {
  beforeEach(() => {
    stores.bookmarks = []; stores.archivedPages = []; stores.settings.clear(); stores.nextId = 1;
    storageMap.clear();
    adapter = new MemAdapter();
    stores.settings.set('sync_provider', 'google-drive');
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('true로 켜면 설정을 저장하고 미업로드 아카이브를 즉시 업로드한다', async () => {
    seed('a1'); seed('a2'); seed('a3');
    stores.settings.set('sync_archive_to_cloud', false);

    await setArchiveSyncEnabled(true);

    expect(stores.settings.get('sync_archive_to_cloud')).toBe(true);
    expect(uploadedHtmlFiles()).toHaveLength(3);
  });

  it('false로 끄면 설정만 저장하고 업로드를 트리거하지 않는다', async () => {
    seed('b1');
    stores.settings.set('sync_archive_to_cloud', true);

    await setArchiveSyncEnabled(false);

    expect(stores.settings.get('sync_archive_to_cloud')).toBe(false);
    expect(uploadedHtmlFiles()).toHaveLength(0);
  });
});
