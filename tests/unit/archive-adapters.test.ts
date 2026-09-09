import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// In-memory settings-based db mock — adapters use db.settings.get/put.
const settingsStore = new Map<string, any>();
vi.mock('../../src/lib/db', () => ({
  default: {
    settings: {
      get: async (key: string) => ({ value: settingsStore.get(key) }),
      put: async (item: { key: string; value: any }) => { settingsStore.set(item.key, item.value); },
      delete: async (key: string) => { settingsStore.delete(key); }
    }
  }
}));

function jsonRes(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
function okRes(status = 200) {
  return new Response('', { status });
}

/** Common: authenticate() passes with OAuth token configuration for each provider */
function seedAuth(prefix: 'gdrive' | 'onedrive' | 'dropbox') {
  settingsStore.set(`${prefix}_client_id`, 'client');
  settingsStore.set(`${prefix}_access_token`, 'token');
  settingsStore.set(`${prefix}_refresh_token`, 'rt');
  settingsStore.set(`${prefix}_token_expiry`, String(Date.now() + 60_000));
}

describe('GoogleDriveAdapter binary I/O', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    settingsStore.clear();
    seedAuth('gdrive');
    fetchMock.mockImplementation(async (url: string, init: any = {}) => {
      const method = (init.method || 'GET').toUpperCase();
      const u = String(url);
      if (method === 'GET') {
        const d = decodeURIComponent(u);
        if (d.includes('vnd.google-apps.folder')) return jsonRes({ files: [] }); // Check folder -> none
        return jsonRes({ files: [] }); // findFileIdInFolder -> none
      }
      if (method === 'POST' && u.includes('/drive/v3/files')) {
        const body = JSON.parse(init.body);
        if (body.mimeType) return jsonRes({ id: 'folder-1' }); // Create folder
        return jsonRes({ id: 'file-1' }); // Create file metadata
      }
      if (method === 'PATCH' && u.includes('uploadType=media')) return okRes();
      if (method === 'DELETE') return okRes();
      return jsonRes({});
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('writeBinaryFile: ensureFolder(폴더 생성) + 파일 메타 생성 + media 업로드', async () => {
    const { GoogleDriveAdapter } = await import('../../src/lib/sync/adapters/google-drive');
    const adapter = new GoogleDriveAdapter();
    const blob = new Blob(['<html>archived</html>'], { type: 'text/html' });
    await adapter.writeBinaryFile('archives/sync-1.html', blob, 'text/html');

    // Verify folderId cache
    expect(settingsStore.get('gdrive_archives_folder_id')).toBe('folder-1');
    // Media upload call exists (PATCH uploadType=media)
    const mediaCall = fetchMock.mock.calls.find((c: any[]) => c[0].includes('uploadType=media'));
    expect(mediaCall).toBeDefined();
    expect(mediaCall[1].method).toBe('PATCH');
    expect(mediaCall[1].headers['Content-Type']).toBe('text/html');
  });

  it('ensureFolder: idempotent — 두 번째 호출 시 생성 API 호출 안 함 (캐시 사용)', async () => {
    settingsStore.set('gdrive_archives_folder_id', 'cached-folder');
    const { GoogleDriveAdapter } = await import('../../src/lib/sync/adapters/google-drive');
    const adapter = new GoogleDriveAdapter();
    await adapter.ensureFolder('archives');
    // If cache exists, no GET/POST lookup or creation
    const posts = fetchMock.mock.calls.filter((c: any[]) => c[1]?.method === 'POST');
    expect(posts).toHaveLength(0);
  });

  it('readBinaryFile: alt=media → blob', async () => {
    fetchMock.mockImplementation(async (url: string, init: any = {}) => {
      const u = String(url);
      if (u.includes('alt=media')) return new Response('<html>data</html>', { status: 200 });
      if (u.includes('vnd.google-apps.folder')) return jsonRes({ files: [] });
      return jsonRes({ files: [{ id: 'file-9' }] }); // findFileIdInFolder -> exists
    });
    const { GoogleDriveAdapter } = await import('../../src/lib/sync/adapters/google-drive');
    const adapter = new GoogleDriveAdapter();
    settingsStore.set('gdrive_archives_folder_id', 'folder-1');
    const blob = await adapter.readBinaryFile('archives/sync-1.html');
    // Realm-safe check: on Node <25, undici Response.blob() yields a node:buffer-realm
    // Blob which fails jsdom-realm `toBeInstanceOf(Blob)`. toString tag is realm-agnostic.
    expect(Object.prototype.toString.call(blob)).toBe('[object Blob]');
    expect(await blob.text()).toBe('<html>data</html>');
  });

  it('deleteFile: DELETE files/{id}, 파일 없으면 no-op (idempotent)', async () => {
    fetchMock.mockImplementation(async (url: string, init: any = {}) => {
      if (String(url).includes('alt=media') || init.method === 'DELETE') return okRes();
      if (String(url).includes('vnd.google-apps.folder')) return jsonRes({ files: [] });
      return jsonRes({ files: [{ id: 'file-7' }] });
    });
    const { GoogleDriveAdapter } = await import('../../src/lib/sync/adapters/google-drive');
    const adapter = new GoogleDriveAdapter();
    settingsStore.set('gdrive_archives_folder_id', 'folder-1');
    await adapter.deleteFile('archives/sync-1.html');
    const del = fetchMock.mock.calls.find((c: any[]) => c[1]?.method === 'DELETE');
    expect(del).toBeDefined();
    expect(String(del[0])).toContain('/files/file-7');

    // No files (files:[]) -> DELETE not called
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init: any = {}) => {
      if (String(url).includes('vnd.google-apps.folder')) return jsonRes({ files: [] });
      return jsonRes({ files: [] }); // findFileIdInFolder -> none
    });
    await adapter.deleteFile('archives/missing.html');
    expect(fetchMock.mock.calls.some((c: any[]) => c[1]?.method === 'DELETE')).toBe(false);
  });

  it('findFileId: orderBy=modifiedTime desc, size > 0 우선 선택 및 중복 파일 백그라운드 삭제', async () => {
    fetchMock.mockImplementation(async (url: string, init: any = {}) => {
      const u = String(url);
      if (u.includes('alt=media')) return new Response('{"bookmarks":[]}', { status: 200 });
      if (init.method === 'DELETE') return okRes();
      if (u.includes('/drive/v3/files?')) {
        // Verify query url
        return jsonRes({
          files: [
            { id: 'file-empty-0', name: 'powerbookmark_sync.json', modifiedTime: '2026-08-29T10:00:00Z', size: '0' },
            { id: 'file-valid-1', name: 'powerbookmark_sync.json', modifiedTime: '2026-08-29T09:00:00Z', size: '1024' },
            { id: 'file-old-2', name: 'powerbookmark_sync.json', modifiedTime: '2026-08-29T08:00:00Z', size: '512' }
          ]
        });
      }
      return jsonRes({});
    });

    const { GoogleDriveAdapter } = await import('../../src/lib/sync/adapters/google-drive');
    const adapter = new GoogleDriveAdapter();
    const content = await adapter.readFile('powerbookmark_sync.json');
    expect(content).toBe('{"bookmarks":[]}');

    // 1. Verify orderBy and fields are included in query url
    const queryCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes('/drive/v3/files?'));
    expect(queryCall).toBeDefined();
    expect(String(queryCall[0])).toContain('orderBy=modifiedTime desc');
    expect(String(queryCall[0])).toContain('fields=files(id,name,modifiedTime,size)');

    // 2. Verify content of file-valid-1 with size > 0 was read
    const readCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes('/files/file-valid-1?alt=media'));
    expect(readCall).toBeDefined();

    // 3. Verify DELETE was called for old duplicate files (file-empty-0, file-old-2)
    const deleteCalls = fetchMock.mock.calls.filter((c: any[]) => c[1]?.method === 'DELETE');
    expect(deleteCalls.length).toBe(2);
    const deletedIds = deleteCalls.map((c: any[]) => String(c[0]));
    expect(deletedIds.some(url => url.includes('/files/file-empty-0'))).toBe(true);
    expect(deletedIds.some(url => url.includes('/files/file-old-2'))).toBe(true);
  });

  it('readBinaryFile: 캐시 없는 상태(클린 재설치)에서 원격 폴더 조회 후 파일 정상 읽기', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      const d = decodeURIComponent(u);
      if (d.includes('vnd.google-apps.folder')) {
        return jsonRes({ files: [{ id: 'remote-archives-folder-id' }] });
      }
      if (d.includes('remote-archives-folder-id') && d.includes('index.json')) {
        return jsonRes({ files: [{ id: 'index-file-id' }] });
      }
      if (u.includes('/files/index-file-id?alt=media')) {
        return new Response('{"version":1,"entries":[]}', { status: 200 });
      }
      return jsonRes({ files: [] });
    });

    const { GoogleDriveAdapter } = await import('../../src/lib/sync/adapters/google-drive');
    const adapter = new GoogleDriveAdapter();
    // settingsStore is empty (clean install)
    expect(settingsStore.get('gdrive_archives_folder_id')).toBeUndefined();

    const blob = await adapter.readBinaryFile('archives/index.json');
    expect(await blob.text()).toBe('{"version":1,"entries":[]}');
    expect(settingsStore.get('gdrive_archives_folder_id')).toBe('remote-archives-folder-id');
  });

  it('listFiles: 폴더 ID를 부모로 하는 파일 목록 정상 조회', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      const d = decodeURIComponent(u);
      if (d.includes('vnd.google-apps.folder')) {
        return jsonRes({ files: [{ id: 'archives-folder-123' }] });
      }
      if (d.includes('archives-folder-123') && d.includes('in parents')) {
        return jsonRes({
          files: [
            { id: 'f-1', name: 'sync-1.html', modifiedTime: '2026-09-01T12:00:00Z', size: '2048' },
            { id: 'f-2', name: 'sync-2.html', modifiedTime: '2026-09-02T12:00:00Z', size: '4096' }
          ]
        });
      }
      return jsonRes({ files: [] });
    });

    const { GoogleDriveAdapter } = await import('../../src/lib/sync/adapters/google-drive');
    const adapter = new GoogleDriveAdapter();
    const files = await adapter.listFiles('archives');

    expect(files).toHaveLength(2);
    expect(files[0].name).toBe('sync-1.html');
    expect(files[0].size).toBe(2048);
    expect(files[1].name).toBe('sync-2.html');
    expect(files[1].size).toBe(4096);
  });
});

describe('OneDriveAdapter binary I/O', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    settingsStore.clear();
    seedAuth('onedrive');
    fetchMock.mockImplementation(async (url: string, init: any = {}) => {
      const method = (init.method || 'GET').toUpperCase();
      const u = String(url);
      if (method === 'GET' && u.includes(':/archives')) return jsonRes({}, 404); // Check folder existence -> none
      if (method === 'PUT' && u.includes(':/content')) return jsonRes({ id: 'file-1' }); // Upload content
      if (method === 'PUT') return jsonRes({ id: 'folder-1' }); // Create folder
      if (method === 'DELETE') return okRes();
      return jsonRes({});
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('writeBinaryFile: ensureFolder 생성 후 content PUT, body는 Blob', async () => {
    const { OneDriveAdapter } = await import('../../src/lib/sync/adapters/onedrive');
    const adapter = new OneDriveAdapter();
    const blob = new Blob(['<html>od</html>'], { type: 'text/html' });
    await adapter.writeBinaryFile('archives/sync-1.html', blob, 'text/html');
    const contentCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes(':/content'));
    expect(contentCall).toBeDefined();
    expect(contentCall[1].method).toBe('PUT');
    expect(contentCall[1].headers['Content-Type']).toBe('text/html');
    expect(contentCall[1].body).toBeInstanceOf(Blob);
  });

  it('ensureFolder: 폴더 존재(200) 시 생성 API 호출 안 함 (idempotent)', async () => {
    fetchMock.mockImplementation(async (url: string, init: any = {}) => {
      if (String(url).includes(':/archives')) return jsonRes({ id: 'folder-1' }); // Exists
      return jsonRes({});
    });
    const { OneDriveAdapter } = await import('../../src/lib/sync/adapters/onedrive');
    const adapter = new OneDriveAdapter();
    await adapter.ensureFolder('archives');
    const puts = fetchMock.mock.calls.filter((c: any[]) => c[1]?.method === 'PUT');
    expect(puts).toHaveLength(0); // GET (200) only -> no creation
  });

  it('deleteFile: DELETE 호출, 404는 no-op', async () => {
    const { OneDriveAdapter } = await import('../../src/lib/sync/adapters/onedrive');
    const adapter = new OneDriveAdapter();
    await adapter.deleteFile('archives/sync-1.html');
    const del = fetchMock.mock.calls.find((c: any[]) => c[1]?.method === 'DELETE');
    expect(del).toBeDefined();
    // 404 no-op
    fetchMock.mockClear();
    fetchMock.mockImplementation(async (_url: string, init: any = {}) => {
      if (init.method === 'DELETE') return jsonRes({}, 404);
      return jsonRes({});
    });
    await expect(adapter.deleteFile('archives/missing.html')).resolves.toBeUndefined();
  });
});

describe('DropboxAdapter binary I/O', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    settingsStore.clear();
    seedAuth('dropbox');
    fetchMock.mockImplementation(async (url: string, init: any = {}) => {
      const method = (init.method || 'GET').toUpperCase();
      const u = String(url);
      if (method === 'POST' && u.includes('content.dropboxapi.com/2/files/upload')) return jsonRes({});
      if (method === 'POST' && u.includes('create_folder_v2')) return jsonRes({}, 409); // Already exists
      if (method === 'POST' && u.includes('delete_v2')) return jsonRes({});
      if (method === 'POST' && u.includes('files/download')) return new Response('<html>db</html>', { status: 200 });
      return jsonRes({});
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('writeBinaryFile: ensureFolder(409 허용) 후 files/upload, body는 Blob', async () => {
    const { DropboxAdapter } = await import('../../src/lib/sync/adapters/dropbox');
    const adapter = new DropboxAdapter();
    const blob = new Blob(['<html>db</html>'], { type: 'text/html' });
    await adapter.writeBinaryFile('archives/sync-1.html', blob, 'text/html');
    const uploadCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes('files/upload'));
    expect(uploadCall).toBeDefined();
    expect(uploadCall[1].headers['Dropbox-API-Arg']).toContain('archives/sync-1.html');
    expect(uploadCall[1].body).toBeInstanceOf(Blob);
  });

  it('ensureFolder: 폴더 이미 존재(409) → throw 없음 (idempotent)', async () => {
    const { DropboxAdapter } = await import('../../src/lib/sync/adapters/dropbox');
    const adapter = new DropboxAdapter();
    await expect(adapter.ensureFolder('archives')).resolves.toBeUndefined();
  });

  it('readBinaryFile: files/download → Blob', async () => {
    const { DropboxAdapter } = await import('../../src/lib/sync/adapters/dropbox');
    const adapter = new DropboxAdapter();
    const blob = await adapter.readBinaryFile('archives/sync-1.html');
    // Realm-safe: node:buffer-realm Blob vs jsdom Blob (see GoogleDrive test above)
    expect(Object.prototype.toString.call(blob)).toBe('[object Blob]');
    expect(await blob.text()).toBe('<html>db</html>');
  });

  it('deleteFile: delete_v2 호출, 404/409는 no-op', async () => {
    const { DropboxAdapter } = await import('../../src/lib/sync/adapters/dropbox');
    const adapter = new DropboxAdapter();
    await adapter.deleteFile('archives/sync-1.html');
    const del = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes('delete_v2'));
    expect(del).toBeDefined();

    fetchMock.mockClear();
    fetchMock.mockImplementation(async (_url: string, init: any = {}) => {
      if (init.method === 'POST') return jsonRes({}, 404);
      return jsonRes({});
    });
    await expect(adapter.deleteFile('archives/missing.html')).resolves.toBeUndefined();
  });
});

describe('OAuth Adapters authenticate branches', () => {
  beforeEach(() => {
    settingsStore.clear();
  });

  it('GoogleDriveAdapter throws invalidAuth when non-interactive and no valid credentials', async () => {
    const { GoogleDriveAdapter } = await import('../../src/lib/sync/adapters/google-drive');
    settingsStore.set('gdrive_client_id', 'test-client-id');
    const adapter = new GoogleDriveAdapter();
    await expect(adapter.authenticate(false)).rejects.toThrow();
  });

  it('GoogleDriveAdapter passes non-interactive authenticate when valid token exists', async () => {
    const { GoogleDriveAdapter } = await import('../../src/lib/sync/adapters/google-drive');
    seedAuth('gdrive');
    const adapter = new GoogleDriveAdapter();
    await expect(adapter.authenticate(false)).resolves.toBeUndefined();
  });

  it('OneDriveAdapter passes non-interactive authenticate when valid token exists', async () => {
    const { OneDriveAdapter } = await import('../../src/lib/sync/adapters/onedrive');
    seedAuth('onedrive');
    const adapter = new OneDriveAdapter();
    await expect(adapter.authenticate(false)).resolves.toBeUndefined();
  });

  it('DropboxAdapter passes non-interactive authenticate when valid token exists', async () => {
    const { DropboxAdapter } = await import('../../src/lib/sync/adapters/dropbox');
    seedAuth('dropbox');
    const adapter = new DropboxAdapter();
    await expect(adapter.authenticate(false)).resolves.toBeUndefined();
  });

  it('GoogleDriveAdapter includes client_secret in token exchange when set', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: any = {}) => {
      if (String(_url).includes('oauth2.googleapis.com/token')) {
        return jsonRes({ access_token: 'new-acc', expires_in: 3600, refresh_token: 'new-ref' });
      }
      return jsonRes({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const { GoogleDriveAdapter } = await import('../../src/lib/sync/adapters/google-drive');
    settingsStore.set('gdrive_client_id', 'test-client-id');
    settingsStore.set('gdrive_client_secret', 'test-secret');
    const adapter = new GoogleDriveAdapter();
    // @ts-ignore
    await adapter.loadCredentials();
    // @ts-ignore
    await adapter.exchangeCodeForTokens('test-code', 'verifier', 'https://redirect');
    const tokenCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes('token'));
    expect(tokenCall).toBeDefined();
    expect(tokenCall[1].body).toContain('client_secret=test-secret');
    vi.unstubAllGlobals();
  });
});
