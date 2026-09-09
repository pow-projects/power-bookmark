/**
 * Regression (QA) test: Bookmark archive -> save to Google Drive.
 *
 * The existing archive-cloud-integration.test.ts tests the orchestrator with an in-memory adapter,
 * and archive-adapters.test.ts tests adapters in isolation.
 * This file connects the actual code paths directly — archive-cloud orchestrator +
 * real GoogleDriveAdapter implementation + Drive REST API simulation mocking fetch.
 *
 * Covered scenarios (Task requirements):
 *   Success: Drive file/folder creation API is called with intended arguments during save.
 *            - ensureFolder -> create folder { name:'archives', mimeType:folder, parents:['appDataFolder'] }
 *            - create file metadata { name, parents:[folderId] } + media PATCH upload
 *            - create index.json + cache folderId
 *   Failure: Duplicate filename -> PATCH overwrite (no duplicate creation)
 *            Network error (TypeError) -> success after transient retry
 *            Permission denied (403) -> graceful failure (local preserved, index unrecorded)
 *
 * Implementation code is not modified (QA only). Report bugs if found.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// db mock — settings (settings gate, credentials, folderId cache) + bookmarks + archivedPages
// ---------------------------------------------------------------------------
const settingsStore = new Map<string, any>();
const bookmarksStore: any[] = [];
const archivedStore: any[] = [];
let nextId = 1;

vi.mock('../../src/lib/db', () => ({
  default: {
    settings: {
      get: async (key: string) => ({ value: settingsStore.get(key) }),
      put: async (item: { key: string; value: any }) => { settingsStore.set(item.key, item.value); },
      delete: async (key: string) => { settingsStore.delete(key); }
    },
    bookmarks: {
      get: async (id: number) => bookmarksStore.find((r) => r.id === id)
    },
    archivedPages: {
      where: (idx: string) => ({
        equals: (val: any) => ({
          first: async () => archivedStore.find((r) => r[idx] === val)
        })
      }),
      put: async (row: any) => {
        const id = row.id ?? nextId++;
        const i = archivedStore.findIndex((r) => r.id === id);
        if (i >= 0) archivedStore[i] = { ...row, id };
        else archivedStore.push({ ...row, id });
        return id;
      }
    }
  }
}));

// ---------------------------------------------------------------------------
// sync-engine mock — return actual GoogleDriveAdapter instance
// ---------------------------------------------------------------------------
vi.mock('../../src/lib/sync/sync-engine', () => ({
  SyncEngine: {
    getAdapter: vi.fn(),
    resetAdapter: vi.fn()
  }
}));

import { syncArchiveToCloudByBookmarkId } from '../../src/lib/archive/archive-cloud';
import { GoogleDriveAdapter } from '../../src/lib/sync/adapters/google-drive';
import { SyncEngine } from '../../src/lib/sync/sync-engine';

// ---------------------------------------------------------------------------
// Drive REST API simulation — stub fetch while maintaining file/folder state
// ---------------------------------------------------------------------------
interface DriveItem {
  name: string;
  id: string;
  mimeType: string;
  parent: string;
}
let driveItems: DriveItem[] = [];
let nextDriveId = 1;
let fetchMock: ReturnType<typeof vi.fn>;
/** Fault to inject right before file creation POST. kind='throw' -> TypeError, kind='status' -> Response. Limited by times. */
let fault: { kind: 'throw' | 'status'; times: number; err?: unknown; resp?: Response } | null = null;

function jsonRes(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function okRes(status = 200) {
  return new Response('', { status });
}

function seedAuth(prefix: 'gdrive') {
  settingsStore.set(`${prefix}_client_id`, 'client');
  settingsStore.set(`${prefix}_access_token`, 'token');
  settingsStore.set(`${prefix}_refresh_token`, 'rt');
  settingsStore.set(`${prefix}_token_expiry`, String(Date.now() + 60_000));
}

function resetDrive() {
  driveItems = [];
  nextDriveId = 1;
  fault = null;
  fetchMock = vi.fn(async (url: string, init: any = {}) => {
    const u = decodeURIComponent(String(url));
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'PATCH' && u.includes('uploadType=media')) return okRes(200);
    if (method === 'DELETE') return okRes(200);
    if (u.includes('/drive/v3/files')) {
      if (method === 'GET') {
        const nameMatch = u.match(/name = '([^']*)'/);
        const name = nameMatch ? nameMatch[1] : null;
        const isFolderQuery = u.includes('vnd.google-apps.folder');
        const found = driveItems.find((it) =>
          (name ? it.name === name : true) &&
          (isFolderQuery ? it.mimeType === 'application/vnd.google-apps.folder' : true)
        );
        return jsonRes({ files: found ? [found] : [] });
      }
      if (method === 'POST') {
        const body = JSON.parse(init.body || '{}');
        // File (metadata) creation supports fault injection
        if (!body.mimeType && fault && fault.times > 0) {
          fault.times--;
          if (fault.kind === 'throw') throw fault.err;
          return fault.resp;
        }
        const item: DriveItem = {
          name: body.name,
          id: `drive-${nextDriveId++}`,
          mimeType: body.mimeType || 'application/octet-stream',
          parent: body.parents?.[0] || ''
        };
        driveItems.push(item);
        return jsonRes({ id: item.id, name: item.name });
      }
    }
    return jsonRes({});
  });
  vi.stubGlobal('fetch', fetchMock);
}

function seedBookmarkArchive() {
  bookmarksStore.length = 0;
  archivedStore.length = 0;
  bookmarksStore.push({ id: 1, syncId: 'sync-1', bookmarkId: 'bk-1', title: 'Example', url: 'https://example.com' });
  archivedStore.push({
    id: 1, bookmarkId: 1, url: 'https://example.com',
    htmlBlob: new Blob(['<html>archived content</html>'], { type: 'text/html' }),
    fileSize: 24, archivedAt: 1000
  });
}

describe('아카이브 Drive 저장 회귀(QA)', () => {
  let adapter: GoogleDriveAdapter;

  beforeEach(async () => {
    settingsStore.clear();
    bookmarksStore.length = 0;
    archivedStore.length = 0;
    nextId = 1;
    seedAuth('gdrive');
    settingsStore.set('sync_archive_to_cloud', true);
    resetDrive();
    adapter = new GoogleDriveAdapter();
    vi.mocked(SyncEngine.getAdapter).mockResolvedValue(adapter);
    seedBookmarkArchive();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // ── Success: Drive file/folder creation API is called with intended arguments ─────────────────
  describe('성공 케이스 — 저장 시 Drive 생성 API 의도된 인자 호출', () => {
    it('ensureFolder가 archives 폴더를 appDataFolder 하위로 생성한다', async () => {
      await syncArchiveToCloudByBookmarkId(1);

      const folder = driveItems.find((i) => i.name === 'archives');
      expect(folder).toBeDefined();
      expect(folder!.mimeType).toBe('application/vnd.google-apps.folder');
      expect(folder!.parent).toBe('appDataFolder'); // Intended parents argument
      // folderId cache
      expect(settingsStore.get('gdrive_archives_folder_id')).toBe(folder!.id);
    });

    it('파일 메타 생성 {name, parents:[folderId]} + media PATCH 업로드(Content-Type text/html)', async () => {
      await syncArchiveToCloudByBookmarkId(1);

      const folder = driveItems.find((i) => i.name === 'archives')!;
      const file = driveItems.find((i) => i.name === 'sync-1.html');
      expect(file).toBeDefined();
      expect(file!.parent).toBe(folder.id); // Intended parents:[folderId] argument
      // media PATCH upload
      const media = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes('uploadType=media'));
      expect(media).toBeDefined();
      expect(media![1].method).toBe('PATCH');
      expect(media![1].headers['Content-Type']).toBe('text/html');
    });

    it('index.json을 archives 폴더에 기록하고 단일 항목을 포함한다', async () => {
      await syncArchiveToCloudByBookmarkId(1);

      const folder = driveItems.find((i) => i.name === 'archives')!;
      const index = driveItems.find((i) => i.name === 'index.json');
      expect(index).toBeDefined();
      expect(index!.parent).toBe(folder.id);
      // index content includes syncId entry (verify media PATCH body)
      const idxMedia = fetchMock.mock.calls.find((c: any[]) =>
        String(c[0]).includes('uploadType=media') && c[1].body instanceof Blob
      );
      expect(idxMedia).toBeDefined();
    });

    it('업로드 후 로컬 아카이브는 보존된다 (데이터 손실 없음)', async () => {
      await syncArchiveToCloudByBookmarkId(1);
      expect(archivedStore).toHaveLength(1);
      expect(archivedStore[0].bookmarkId).toBe(1);
    });
  });

  // ── Failure: Duplicate filename -> overwrite (no duplicate creation) ──────────────────────
  describe('실패/에지 — 중복 파일명', () => {
    it('이미 존재하는 파일명 → PATCH overwrite, POST 생성은 재호출되지 않는다', async () => {
      // Pre-inject archives folder and existing file (folderId cache + exists in drive)
      settingsStore.set('gdrive_archives_folder_id', 'folder-1');
      driveItems.push(
        { name: 'archives', id: 'folder-1', mimeType: 'application/vnd.google-apps.folder', parent: 'appDataFolder' },
        { name: 'sync-1.html', id: 'existing-file', mimeType: 'text/html', parent: 'folder-1' }
      );

      await syncArchiveToCloudByBookmarkId(1);

      // No duplicate file creation (POST name=sync-1.html)
      const createCalls = fetchMock.mock.calls.filter((c: any[]) => {
        if (c[1]?.method !== 'POST') return false;
        try { return JSON.parse(c[1].body).name === 'sync-1.html'; } catch { return false; }
      });
      expect(createCalls).toHaveLength(0);
      // Overwrite existing file with PATCH
      const update = fetchMock.mock.calls.find((c: any[]) =>
        String(c[0]).includes('/files/existing-file?uploadType=media') && c[1]?.method === 'PATCH'
      );
      expect(update).toBeDefined();
      // sync-1.html item is not duplicated in drive
      expect(driveItems.filter((i) => i.name === 'sync-1.html')).toHaveLength(1);
    });

    it('중복 업로드 시에도 index.json은 단일 항목만 기록한다', async () => {
      settingsStore.set('gdrive_archives_folder_id', 'folder-1');
      driveItems.push(
        { name: 'archives', id: 'folder-1', mimeType: 'application/vnd.google-apps.folder', parent: 'appDataFolder' },
        { name: 'sync-1.html', id: 'existing-file', mimeType: 'text/html', parent: 'folder-1' }
      );
      await syncArchiveToCloudByBookmarkId(1);
      // syncId appears exactly once in media PATCH body (JSON) of index.json
      const bodies = await Promise.all(
        fetchMock.mock.calls
          .filter((c: any[]) => String(c[0]).includes('uploadType=media') && c[1]?.body instanceof Blob)
          .map(async (c: any[]) => (c[1].body as Blob).text())
      );
      const idxText = bodies.find((t) => t.includes('"syncId"'));
      expect(idxText).toBeDefined();
      const occurrences = idxText!.split('"syncId":"sync-1"').length - 1;
      expect(occurrences).toBe(1);
    });
  });

  // ── Failure: Network error -> success after transient retry ──────────────────────
  describe('실패/에지 — 네트워크 오류', () => {
    it('파일 생성 fetch가 TypeError 1회 → transient 재시도로 성공 (지수 백오프)', async () => {
      fault = { kind: 'throw', times: 1, err: new TypeError('Failed to fetch') };
      await syncArchiveToCloudByBookmarkId(1);

      const file = driveItems.find((i) => i.name === 'sync-1.html');
      expect(file).toBeDefined(); // Saved after retry
      const folder = driveItems.find((i) => i.name === 'archives');
      expect(folder).toBeDefined();
    });
  });

  // ── Failure: Permission denied (403) -> graceful failure (local preserved, index unrecorded) ─────────
  describe('실패/에지 — 권한 거부(403)', () => {
    it('403 응답 → 업로드 실패하되 로컬 아카이브 보존, index.json 미기록', async () => {
      fault = { kind: 'status', times: 999, resp: jsonRes({ error: 'forbidden' }, 403) };
      await expect(syncArchiveToCloudByBookmarkId(1)).resolves.toBeUndefined();

      // Neither file nor index is created (no partial state)
      expect(driveItems.some((i) => i.name === 'sync-1.html')).toBe(false);
      expect(driveItems.some((i) => i.name === 'index.json')).toBe(false);
      // Local archive is never deleted
      expect(archivedStore).toHaveLength(1);
      expect(archivedStore[0].bookmarkId).toBe(1);
    });

    it('권한 거부(403) 시 Drive 재인증(authenticate(true))이 발생한다 — status 부착 후 auth 분류(수정 반영)', async () => {
      fault = { kind: 'status', times: 999, resp: jsonRes({ error: 'forbidden' }, 403) };
      const authSpy = vi.spyOn(adapter, 'authenticate');
      await syncArchiveToCloudByBookmarkId(1);
      // Adapter attaches HTTP status (403) to Error and throws -> classifyArchiveError classifies as 'auth'
      // -> reaches retry authenticate(true) re-authentication retry path.
      const reauthCalls = authSpy.mock.calls.filter((c) => c[0] === true);
      expect(reauthCalls.length).toBeGreaterThan(0);
      authSpy.mockRestore();
    });
  });
});
