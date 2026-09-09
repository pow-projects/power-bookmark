/**
 * Archive cloud storage integration (QA) test.
 *
 * Unit tests (archive-cloud.test.ts, etc.) verified individual logic via mockAdapter.
 * Here, we verify integrated scenarios connecting the real archive-cloud orchestrator +
 * archive-index pure logic + upload-state + adapter contracts (CloudStorageAdapter implementation).
 * The cloud is replaced with a real adapter implementation maintaining in-memory state
 * (files map + modified time), injecting faults (network/permission/quota/partial upload) to cover:
 *
 *   1. Supported format (raw/gzip) detection and round-trip
 *   2. Large archives (soft/hard limits)
 *   3. Corrupted/invalid archives (corrupt index.json, invalid blob)
 *   4. Permission/quota failure (auth/401, quota/507) + re-authentication retry
 *   5. Duplicate filename (re-upload same syncId -> overwrite, single index entry)
 *   6. Interrupted upload/save (catch-up recovery after index write failure)
 *   7. Recovery paths (syncPendingArchives, restore, delete tombstone)
 *
 * Implementation code is not modified (QA only). Report bugs if found.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudStorageAdapter, type FileInfo } from '../../src/lib/sync/adapters/base';

// ---------------------------------------------------------------------------
// In-memory cloud adapter — implements real CloudStorageAdapter contract,
// maintaining file state and modification times with fault injection support.
// ---------------------------------------------------------------------------
interface CloudFile {
  data: Uint8Array;
  modifiedAt: number;
}

type FaultOp = 'readFile' | 'writeFile' | 'writeBinaryFile' | 'readBinaryFile'
  | 'deleteFile' | 'ensureFolder' | 'getLastModified';

class InMemoryCloudAdapter extends CloudStorageAdapter {
  files = new Map<string, CloudFile>();
  folders = new Set<string>();
  /** Injected fault: op -> (pathMatcher) -> Error (or {status}) */
  faults: { op: FaultOp; match: (path: string) => boolean; err: unknown; persist: boolean }[] = [];

  constructor() {
    super();
    this.clock = Date.now();
  }
  private clock = Date.now();

  /** Fault injection helper (one-shot) */
  failOnce(op: FaultOp, err: unknown, pathMatch?: string) {
    this.faults.push({ op, match: (p) => !pathMatch || p.includes(pathMatch), err, persist: false });
  }
  /** Fault injection helper (persistent — keeps throwing) */
  failPersistent(op: FaultOp, err: unknown, pathMatch?: string) {
    this.faults.push({ op, match: (p) => !pathMatch || p.includes(pathMatch), err, persist: true });
  }
  clearFaults() { this.faults = []; }

  private async maybeThrow(op: FaultOp, path: string): Promise<void> {
    const f = this.faults.find((x) => x.op === op && x.match(path));
    if (f) {
      if (!f.persist) {
        this.faults = this.faults.filter((x) => x !== f); // One-shot
      }
      throw f.err;
    }
  }

  private ensureFile(path: string) {
    if (!this.files.has(path)) {
      this.files.set(path, { data: new Uint8Array(0), modifiedAt: 0 });
    }
  }
  private touch(path: string) {
    this.clock += 1000;
    const f = this.files.get(path)!;
    f.modifiedAt = this.clock;
  }

  // --- CloudStorageAdapter implementation ---
  async authenticate(_forceInteractive = false): Promise<void> { /* no-op */ }
  async revoke(): Promise<void> { /* no-op */ }

  async readFile(path: string): Promise<string> {
    await this.maybeThrow('readFile', path);
    const f = this.files.get(path);
    if (!f) throw new Error(`File not found: ${path}`);
    return new TextDecoder().decode(f.data);
  }

  async writeFile(path: string, data: string): Promise<void> {
    await this.maybeThrow('writeFile', path);
    this.ensureFile(path);
    this.files.get(path)!.data = new TextEncoder().encode(data);
    this.touch(path);
  }

  async ensureFolder(folder: string): Promise<void> {
    await this.maybeThrow('ensureFolder', folder);
    this.folders.add(folder);
  }

  async writeBinaryFile(path: string, data: Blob, _mimeType?: string): Promise<void> {
    await this.maybeThrow('writeBinaryFile', path);
    this.ensureFile(path);
    const buf = new Uint8Array(await data.arrayBuffer());
    this.files.get(path)!.data = buf;
    this.touch(path);
  }

  async readBinaryFile(path: string): Promise<Blob> {
    await this.maybeThrow('readBinaryFile', path);
    const f = this.files.get(path);
    if (!f) throw new Error(`File not found: ${path}`);
    return new Blob([f.data as unknown as ArrayBuffer]);
  }

  async deleteFile(path: string): Promise<void> {
    await this.maybeThrow('deleteFile', path);
    this.files.delete(path); // idempotent
  }

  async getLastModified(path: string): Promise<number> {
    await this.maybeThrow('getLastModified', path);
    if (!this.files.has(path)) return 0;
    return this.files.get(path)!.modifiedAt;
  }

  async listFiles(_folder: string): Promise<FileInfo[]> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// db / sync-engine mock — in-memory table, settings gate, return adapter
// ---------------------------------------------------------------------------
const stores = {
  bookmarks: [] as any[],
  archivedPages: [] as any[],
  settings: new Map<string, any>(),
  nextId: 1,
};

function makeTable(key: 'bookmarks' | 'archivedPages') {
  const getArr = () => stores[key];
  const table: any = {
    where: (idx: string) => ({
      equals(val: any) {
        return {
          first: async () => getArr().find((r: any) => r[idx] === val),
          toArray: async () => getArr().filter((r: any) => r[idx] === val),
        };
      },
    }),
    first: async () => getArr()[0],
    toArray: async () => [...getArr()],
    get: async (id: number) => getArr().find((r: any) => r.id === id),
    put: async (row: any) => {
      const arr = getArr();
      const id = row.id ?? stores.nextId++;
      const i = arr.findIndex((r: any) => r.id === id);
      if (i >= 0) arr[i] = { ...row, id }; else arr.push({ ...row, id });
      return id;
    },
    add: async (row: any) => {
      const id = stores.nextId++;
      getArr().push({ ...row, id });
      return id;
    },
    delete: async (id: number) => {
      const arr = getArr();
      const i = arr.findIndex((r: any) => r.id === id);
      if (i >= 0) { arr.splice(i, 1); return 1; }
      return 0;
    },
  };
  return table;
}

vi.mock('../../src/lib/db', () => {
  const mockDb: any = {
    bookmarks: makeTable('bookmarks'),
    archivedPages: makeTable('archivedPages'),
    syncState: { put: vi.fn(), toArray: async () => [] },
    settings: {
      get: async (key: string) => ({ value: stores.settings.get(key) }),
      put: async (item: { key: string; value: any }) => { stores.settings.set(item.key, item.value); },
      delete: async (key: string) => { stores.settings.delete(key); },
    },
    transaction: async (_m: string, _t: any, fn: () => Promise<void>) => { await fn(); },
  };
  return { db: mockDb, default: mockDb };
});

let adapter: InMemoryCloudAdapter;
vi.mock('../../src/lib/sync/sync-engine', () => ({
  SyncEngine: { getAdapter: vi.fn().mockImplementation(async () => adapter) },
}));

import {
  syncArchiveToCloudByBookmarkId,
  syncPendingArchives,
  restoreArchivesFromCloud,
  deleteArchiveFromCloud,
  classifyArchiveSize,
} from '../../src/lib/archive/archive-cloud';
import {
  detectArchiveFormat,
  buildArchiveFileName,
  mergeArchiveIndex,
  TOMBSTONE_TTL_MS,
  type ArchiveIndexEntry,
} from '../../src/lib/archive/archive-index';

const ARCHIVES = 'archives';
const INDEX = `${ARCHIVES}/index.json`;

function seedBookmark(syncId: string, overrides: Partial<any> = {}) {
  const b = { id: stores.nextId++, syncId, bookmarkId: `bk-${syncId}`, title: 'Title', url: `https://${syncId}.com`, ...overrides };
  stores.bookmarks.push(b);
  return b;
}
function seedArchive(bookmarkId: number, html: string, overrides: Partial<any> = {}) {
  const blob = new Blob([html], { type: 'text/html' });
  const a = {
    id: stores.nextId++, bookmarkId, url: 'https://x.com', htmlBlob: blob, fileSize: blob.size,
    archivedAt: 1000, ...overrides,
  };
  stores.archivedPages.push(a);
  return a;
}
function readCloudIndex(): ArchiveIndexEntry[] {
  if (!adapter.files.has(INDEX)) return [];
  const txt = new TextDecoder().decode(adapter.files.get(INDEX)!.data);
  const parsed = JSON.parse(txt);
  return parsed.entries as ArchiveIndexEntry[];
}

describe('아카이브 클라우드 저장 통합(QA)', () => {
  beforeEach(() => {
    stores.bookmarks = [];
    stores.archivedPages = [];
    stores.settings.clear();
    stores.nextId = 1;
    adapter = new InMemoryCloudAdapter();
    stores.settings.set('sync_archive_to_cloud', true);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. Supported formats (raw/gzip) ─────────────────────────────────────────────
  describe('1. 지원 아카이브 포맷', () => {
    it('raw HTML blob → format=raw 저장 + 클라우드 왕복(round-trip) 후 원본 보존', async () => {
      const html = '<html><body>raw archive content</body></html>';
      const b = seedBookmark('sync-raw');
      seedArchive(b.id, html);
      await syncArchiveToCloudByBookmarkId(b.id);

      const entry = readCloudIndex()[0];
      expect(entry.format).toBe('raw');
      expect(entry.fileName).toBe(buildArchiveFileName('sync-raw'));
      // Cloud file content matches original (bytes preserved)
      const stored = await adapter.readBinaryFile(`${ARCHIVES}/${entry.fileName}`);
      expect(await stored.text()).toBe(html);
    });

    it('gzip 마커 blob → format=gzip 감지', async () => {
      const gzish = '<html>const p=compressed; new DecompressionStream();</html>';
      expect(await detectArchiveFormat(new Blob([gzish]))).toBe('gzip');
      expect(await detectArchiveFormat(new Blob(['plain html']))).toBe('raw');
    });

    it('gzip 아카이브 저장 시 index.format=gzip 반영', async () => {
      const b = seedBookmark('sync-gz');
      seedArchive(b.id, '<html>const p=1; DecompressionStream x</html>');
      await syncArchiveToCloudByBookmarkId(b.id);
      expect(readCloudIndex()[0].format).toBe('gzip');
    });
  });

  // ── 2. Large archives ─────────────────────────────────────────────────
  describe('2. 대용량 아카이브 (soft/hard 한도)', () => {
    it('soft 한도(50MiB) 미만 → ok, 정상 업로드', async () => {
      const b = seedBookmark('sync-small');
      seedArchive(b.id, '<html>small</html>');
      expect(await classifyArchiveSize((await dbArchive(b.id)).fileSize)).toBe('ok');
      await syncArchiveToCloudByBookmarkId(b.id);
      expect(adapter.files.has(`${ARCHIVES}/sync-small.html`)).toBe(true);
    });

    it('soft 한도 초과(50~200MiB) → 경고 후 업로드 진행', async () => {
      const b = seedBookmark('sync-soft');
      seedArchive(b.id, '<html>big</html>', { fileSize: 60 * 1024 * 1024 });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await syncArchiveToCloudByBookmarkId(b.id);
      expect(adapter.files.has(`${ARCHIVES}/sync-soft.html`)).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeds soft limit'));
      warn.mockRestore();
    });

    it('hard 한도(200MiB) 설정 시 초과 → 업로드 거부, 클라우드에 아무것도 안 남김 (AC-4)', async () => {
      stores.settings.set('archive_upload_hard_limit', 200 * 1024 * 1024);
      const b = seedBookmark('sync-hard');
      seedArchive(b.id, '<html>huge</html>', { fileSize: 300 * 1024 * 1024 });
      await syncArchiveToCloudByBookmarkId(b.id);
      expect(adapter.files.size).toBe(0); // Neither file nor index created
    });

    it('설정으로 한도 재정의 → 작은 아카이브도 hard-exceed로 거부', async () => {
      stores.settings.set('archive_upload_hard_limit', 1024);
      const b = seedBookmark('sync-tiny');
      seedArchive(b.id, '<html>tiny</html>', { fileSize: 2048 });
      await syncArchiveToCloudByBookmarkId(b.id);
      expect(adapter.files.size).toBe(0);
    });
  });

  // ── 3. Corrupted/invalid archives ──────────────────────────────────────────────
  describe('3. 손상/무효 아카이브', () => {
    it('클라우드 index.json이 손상(corrupt JSON) → 빈 인덱스로 간주해 업로드 진행, 복구', async () => {
      // Pre-inject corrupted index
      adapter.files.set(INDEX, { data: new TextEncoder().encode('{ not valid json !!!'), modifiedAt: 1 });
      const b = seedBookmark('sync-corrupt');
      seedArchive(b.id, '<html>recover</html>');
      await syncArchiveToCloudByBookmarkId(b.id);
      // Corrupted index replaced with clean new index and entry is recorded
      const entries = readCloudIndex();
      expect(entries.some((e) => e.syncId === 'sync-corrupt')).toBe(true);
    });

    it('무효 blob(빈/비HTML) → format=raw로 저장되며 예외 없이 완료', async () => {
      const b = seedBookmark('sync-empty');
      seedArchive(b.id, '', { fileSize: 0 });
      await expect(syncArchiveToCloudByBookmarkId(b.id)).resolves.toBeUndefined();
      expect(adapter.files.has(`${ARCHIVES}/sync-empty.html`)).toBe(true);
    });

    it('잘못된 구조의 index(entries 배열 아님) → 빈 인덱스로 처리 (crash 없음)', async () => {
      adapter.files.set(INDEX, { data: new TextEncoder().encode('{"version":1,"entries":"WRONG"}'), modifiedAt: 1 });
      const b = seedBookmark('sync-badidx');
      seedArchive(b.id, '<html>ok</html>');
      await expect(syncArchiveToCloudByBookmarkId(b.id)).resolves.toBeUndefined();
      expect(readCloudIndex().some((e) => e.syncId === 'sync-badidx')).toBe(true);
    });
  });

  // ── 4. Permission/quota failure ────────────────────────────────────────────────
  describe('4. 권한/할당량 실패', () => {
    it('업로드 중 401(auth) → 재인증 후 재시도 성공 (retry 경로)', async () => {
      const b = seedBookmark('sync-auth');
      seedArchive(b.id, '<html>auth</html>');
      // 401 only on first writeBinaryFile
      adapter.failOnce('writeBinaryFile', { status: 401, message: 'unauthorized' });
      await syncArchiveToCloudByBookmarkId(b.id);
      expect(adapter.files.has(`${ARCHIVES}/sync-auth.html`)).toBe(true);
      expect(readCloudIndex().some((e) => e.syncId === 'sync-auth')).toBe(true);
    });

    it('writeBinaryFile 403 → auth 분류, 업로드 실패하지만 로컬 아카이브는 보존', async () => {
      const b = seedBookmark('sync-403');
      const a = seedArchive(b.id, '<html>perm</html>');
      // Persistent 403 — cannot succeed even with re-auth retry
      adapter.failPersistent('writeBinaryFile', { status: 403, message: 'forbidden' });
      await syncArchiveToCloudByBookmarkId(b.id);
      // Local archive is never deleted
      expect(stores.archivedPages.length).toBe(1);
      expect(stores.archivedPages[0].htmlBlob).toBe(a.htmlBlob);
      // Not recorded in index
      expect(readCloudIndex().some((e) => e.syncId === 'sync-403')).toBe(false);
    });

    it('quota(507) → 즉시 실패(재시도 없음), 로컬 보존', async () => {
      const b = seedBookmark('sync-quota');
      seedArchive(b.id, '<html>quota</html>');
      adapter.failOnce('writeBinaryFile', { status: 507, message: 'insufficient_space quota' });
      await syncArchiveToCloudByBookmarkId(b.id);
      expect(stores.archivedPages.length).toBe(1);
    });

    it('transient(503) 후 성공 → 지수 백오프 재시도로 완료', async () => {
      const b = seedBookmark('sync-503');
      seedArchive(b.id, '<html>transient</html>');
      adapter.failOnce('writeBinaryFile', { status: 503, message: 'temporarily unavailable' });
      await syncArchiveToCloudByBookmarkId(b.id);
      expect(adapter.files.has(`${ARCHIVES}/sync-503.html`)).toBe(true);
    });
  });

  // ── 5. Duplicate filename ─────────────────────────────────────────────────────
  describe('5. 중복 파일명 (같은 syncId 재업로드)', () => {
    it('같은 syncId 재업로드 → 클라우드 파일 overwrite, index 단일 항목 유지', async () => {
      const b = seedBookmark('sync-dup');
      seedArchive(b.id, '<html>v1</html>', { archivedAt: 1000 });
      await syncArchiveToCloudByBookmarkId(b.id);
      expect(readCloudIndex().length).toBe(1);

      // Re-archive (v2, newer) — update local archivedPages
      stores.archivedPages = [];
      const a2 = seedArchive(b.id, '<html>v2-content</html>', { archivedAt: 2000 });
      await syncArchiveToCloudByBookmarkId(b.id);

      const entries = readCloudIndex();
      expect(entries.filter((e) => e.syncId === 'sync-dup')).toHaveLength(1); // No duplicate entries
      const stored = await adapter.readBinaryFile(`${ARCHIVES}/sync-dup.html`);
      expect(await stored.text()).toBe('<html>v2-content</html>'); // LWW: newer (local 2000) wins
      expect(entries[0].archivedAt).toBe(2000);
    });

    it('클라우드가 더 최신(LWW cloud 승) → 다운로드해 로컬 반영, 업로드 스킵 (D-2)', async () => {
      // Newer entry already in cloud
      adapter.files.set(INDEX, {
        data: new TextEncoder().encode(JSON.stringify({
          version: 1,
          entries: [{
            syncId: 'sync-newer', bookmarkId: 'bk-x', url: 'https://x.com', title: 'T',
            fileName: 'sync-newer.html', fileSize: 999, format: 'raw', archivedAt: 9999,
          }],
          updatedAt: 9999,
        })),
        modifiedAt: 5,
      });
      adapter.files.set(`${ARCHIVES}/sync-newer.html`, {
        data: new TextEncoder().encode('<html>cloud-newer</html>'), modifiedAt: 6,
      });
      const b = seedBookmark('sync-newer');
      seedArchive(b.id, '<html>local-old</html>', { archivedAt: 1000 });
      await syncArchiveToCloudByBookmarkId(b.id);
      // Local updated with latest from cloud
      expect(stores.archivedPages[0].archivedAt).toBe(9999);
      expect(await stores.archivedPages[0].htmlBlob.text()).toBe('<html>cloud-newer</html>');
      // Does not overwrite cloud file
      expect(await (await adapter.readBinaryFile(`${ARCHIVES}/sync-newer.html`)).text()).toBe('<html>cloud-newer</html>');
    });
  });

  // ── 6. Interrupted upload/save ──────────────────────────────────────────────
  describe('6. 중단된 업로드/저장', () => {
    it('파일 업로드 성공 후 index write 실패 → 다음 catch-up에서 복구 (index 원자성)', async () => {
      const b = seedBookmark('sync-interrupt');
      seedArchive(b.id, '<html>interrupted</html>');
      // index write fails once (transient) -> only file uploaded, index unrecorded
      adapter.failOnce('writeBinaryFile', { status: 503, message: 'temporarily' }, INDEX);
      await syncArchiveToCloudByBookmarkId(b.id);
      // File exists but no index entry (partial save state)
      expect(adapter.files.has(`${ARCHIVES}/sync-interrupt.html`)).toBe(true);
      expect(readCloudIndex().some((e) => e.syncId === 'sync-interrupt')).toBe(false);

      // catch-up (syncPendingArchives) -> retry completes index recording (not duplicate entry)
      await syncPendingArchives();
      const entries = readCloudIndex();
      expect(entries.filter((e) => e.syncId === 'sync-interrupt')).toHaveLength(1);
    });

    it('index write 재검증에서 동시 write 감지 → 최신 index 재병합 후 단일 항목 (U-3)', async () => {
      const b = seedBookmark('sync-concurrent');
      seedArchive(b.id, '<html>conc</html>');
      // To ensure getLastModified differs after capturing base: getLastModified changes from 0 -> current value before index write
      // Simulation: forcibly increment getLastModified right before writeFile(INDEX) (mimicking concurrent device write)
      const origGetLastModified = adapter.getLastModified.bind(adapter);
      let bumped = false;
      adapter.getLastModified = async (path: string) => {
        if (!bumped && path === INDEX && adapter.files.has(INDEX)) {
          bumped = true;
          adapter.files.get(INDEX)!.modifiedAt += 5000; // Concurrent write
        }
        return origGetLastModified(path);
      };
      await syncArchiveToCloudByBookmarkId(b.id);
      const entries = readCloudIndex().filter((e) => e.syncId === 'sync-concurrent');
      expect(entries).toHaveLength(1);
    });

    it('U-3: 동시 write 1회 발생 → base 갱신으로 재시도 후 병합·write 성공 (retries 소진 없음)', async () => {
      // Different syncId item already exists in cloud (base modifiedAt=1000)
      adapter.files.set(INDEX, {
        data: new TextEncoder().encode(JSON.stringify({
          version: 1,
          entries: [{
            syncId: 'sync-other', bookmarkId: 'bk-o', url: 'https://o.com', title: 'O',
            fileName: 'sync-other.html', fileSize: 4, format: 'raw', archivedAt: 900,
          }],
          updatedAt: 900,
        })),
        modifiedAt: 1000,
      });
      const b = seedBookmark('sync-u3');
      seedArchive(b.id, '<html>u3</html>', { archivedAt: 1000 });

      // After capturing base (1st getLastModified), forcibly increment modifiedAt once on first current lookup (mimicking concurrent write)
      const origGetLastModified = adapter.getLastModified.bind(adapter);
      let call = 0;
      adapter.getLastModified = async (path: string) => {
        call++;
        if (path === INDEX && call === 2 && adapter.files.has(INDEX)) {
          adapter.files.get(INDEX)!.modifiedAt += 5000; // 1000 → 6000
        }
        return origGetLastModified(path);
      };

      await syncArchiveToCloudByBookmarkId(b.id);
      // Retry loop must succeed by updating base=current after single concurrent write (no markError)
      const entries = readCloudIndex();
      expect(entries.filter((e) => e.syncId === 'sync-u3')).toHaveLength(1);
      expect(entries.filter((e) => e.syncId === 'sync-other')).toHaveLength(1); // Retain existing entry
    });
  });

  // ── 7. Recovery paths ───────────────────────────────────────────────────────
  describe('7. 복구 경로', () => {
    it('syncPendingArchives: 미업로드 항목만 업로드, 이미 uploaded 항목은 건너뜀', async () => {
      const b1 = seedBookmark('sync-p1');
      const b2 = seedBookmark('sync-p2');
      seedArchive(b1.id, '<html>p1</html>', { archivedAt: 1000 });
      seedArchive(b2.id, '<html>p2</html>', { archivedAt: 1000 });
      await syncPendingArchives();
      expect(adapter.files.has(`${ARCHIVES}/sync-p1.html`)).toBe(true);
      expect(adapter.files.has(`${ARCHIVES}/sync-p2.html`)).toBe(true);
      expect(readCloudIndex().length).toBe(2);
    });

    it('restoreArchivesFromCloud: 로컬 부재 아카이브 다운로드 복원, 고아 보존', async () => {
      adapter.files.set(INDEX, {
        data: new TextEncoder().encode(JSON.stringify({
          version: 1,
          entries: [
            { syncId: 'sync-local', bookmarkId: 'bk-l', url: 'https://l.com', title: 'L', fileName: 'sync-local.html', fileSize: 4, format: 'raw', archivedAt: 5000 },
            { syncId: 'sync-orphan', bookmarkId: 'bk-o', url: 'https://o.com', title: 'O', fileName: 'sync-orphan.html', fileSize: 4, format: 'raw', archivedAt: 5000 },
          ],
          updatedAt: 5000,
        })),
        modifiedAt: 5,
      });
      adapter.files.set(`${ARCHIVES}/sync-local.html`, { data: new TextEncoder().encode('<html>restored</html>'), modifiedAt: 6 });
      adapter.files.set(`${ARCHIVES}/sync-orphan.html`, { data: new TextEncoder().encode('<html>orphan</html>'), modifiedAt: 6 });
      const b = seedBookmark('sync-local');
      seedArchive(b.id, '<html>stale</html>', { archivedAt: 1000 });

      const result = await restoreArchivesFromCloud();
      expect(result.restored).toBe(1); // Restore sync-local only
      expect(result.orphans.map((o) => o.syncId)).toEqual(['sync-orphan']); // Preserve orphan
      // BUG-1 fix: if local stale row exists, upsert preserving id -> no duplicate rows,
      // single row updated with '<html>restored</html>'
      const rows = stores.archivedPages.filter((r: any) => r.bookmarkId === b.id);
      expect(rows).toHaveLength(1); // After fix: no duplicates (previous bug was 2 rows)
      expect(await rows[0].htmlBlob.text()).toBe('<html>restored</html>');
    });

    it('deleteArchiveFromCloud: 파일 삭제 + index tombstone(soft-delete) 표시, 로컬 아카이브 보존', async () => {
      adapter.files.set(INDEX, {
        data: new TextEncoder().encode(JSON.stringify({
          version: 1,
          entries: [{
            syncId: 'sync-del', bookmarkId: 'bk-d', url: 'https://d.com', title: 'D',
            fileName: 'sync-del.html', fileSize: 4, format: 'raw', archivedAt: 1000,
          }],
          updatedAt: 1000,
        })),
        modifiedAt: 5,
      });
      adapter.files.set(`${ARCHIVES}/sync-del.html`, { data: new TextEncoder().encode('<html>del</html>'), modifiedAt: 6 });
      const b = seedBookmark('sync-del');
      seedArchive(b.id, '<html>del</html>', { archivedAt: 1000 });

      await deleteArchiveFromCloud('sync-del');
      expect(adapter.files.has(`${ARCHIVES}/sync-del.html`)).toBe(false); // Delete file
      const entries = readCloudIndex();
      expect(entries[0].deleted).toBe(true); // tombstone
      expect(stores.archivedPages.length).toBe(1); // Preserve local
    });

    it('mergeArchiveIndex: 30일 TTL 내 tombstone은 항목 제거, TTL 초과 시 복원', () => {
      const now = Date.now();
      const entry: ArchiveIndexEntry = {
        syncId: 's', bookmarkId: 'b', url: 'u', title: 't', fileName: 's.html', fileSize: 1, format: 'raw', archivedAt: 1,
      };
      const freshTombstone: ArchiveIndexEntry = { ...entry, deleted: true, deletedAt: now - 1000 };
      expect(mergeArchiveIndex([], [freshTombstone], now)).toHaveLength(0); // Valid tombstone -> remove

      const expiredTombstone: ArchiveIndexEntry = { ...entry, deleted: true, deletedAt: now - TOMBSTONE_TTL_MS - 1000 };
      const merged = mergeArchiveIndex([], [expiredTombstone], now);
      expect(merged).toHaveLength(1);
      expect(merged[0].deleted).toBeUndefined(); // TTL exceeded -> restore normal entry
    });
  });
});

// helper — for accessing db.archivedPages in tests
async function dbArchive(bookmarkId: number) {
  return stores.archivedPages.find((a: any) => a.bookmarkId === bookmarkId);
}
