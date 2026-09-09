import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebDavAdapter } from '../../src/lib/sync/adapters/webdav';

const { mockDb, mockCreateClient, mockClient } = vi.hoisted(() => {
  const settingsData = new Map<string, any>();
  const db = {
    settings: {
      get: async (key: string) => ({ value: settingsData.get(key) }),
      put: async (item: { key: string; value: any }) => {
        settingsData.set(item.key, item.value);
      },
      delete: async (key: string) => {
        settingsData.delete(key);
      },
      clear: async () => settingsData.clear(),
      data: settingsData,
    }
  };

  const clientMock = {
    getDirectoryContents: vi.fn().mockResolvedValue([]),
    getFileContents: vi.fn().mockResolvedValue('test content'),
    putFileContents: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ lastmod: new Date().toISOString() }),
    createDirectory: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
  };

  const createClientFn = vi.fn().mockReturnValue(clientMock);

  return { mockDb: db, mockCreateClient: createClientFn, mockClient: clientMock };
});

vi.mock('../../src/lib/db', () => ({
  default: mockDb
}));

vi.mock('webdav', () => ({
  createClient: mockCreateClient
}));

describe('WebDavAdapter Basic Auth Parsing', () => {
  beforeEach(async () => {
    await mockDb.settings.clear();
    mockCreateClient.mockClear();
  });

  it('should throw error if webdav_url is not configured', async () => {
    const adapter = new WebDavAdapter();
    await expect(adapter.authenticate()).rejects.toThrow('WebDAV 설정(서버 URL)이 필요합니다.');
  });

  it('should parse Basic Auth credentials from webdav_url and pass clean URL to createClient', async () => {
    await mockDb.settings.put({
      key: 'webdav_url',
      value: 'http://myuser:mypassword@example.com:8080/remote.php/dav/files/myuser/'
    });

    const adapter = new WebDavAdapter();
    await adapter.authenticate();

    expect(mockCreateClient).toHaveBeenCalledWith(
      'http://example.com:8080/remote.php/dav/files/myuser/',
      {
        username: 'myuser',
        password: 'mypassword'
      }
    );
  });

  it('should decode URL-encoded special characters in Basic Auth URL', async () => {
    await mockDb.settings.put({
      key: 'webdav_url',
      value: 'https://user%40domain.com:p%40ss%23123@webdav.example.com/dav/'
    });

    const adapter = new WebDavAdapter();
    await adapter.authenticate();

    expect(mockCreateClient).toHaveBeenCalledWith(
      'https://webdav.example.com/dav/',
      {
        username: 'user@domain.com',
        password: 'p@ss#123'
      }
    );
  });

  it('should handle URL without credentials', async () => {
    await mockDb.settings.put({
      key: 'webdav_url',
      value: 'https://example.com/dav/'
    });

    const adapter = new WebDavAdapter();
    await adapter.authenticate();

    expect(mockCreateClient).toHaveBeenCalledWith(
      'https://example.com/dav/',
      {
        username: undefined,
        password: undefined
      }
    );
  });

  it('should use stored credentials if webdav_url does not contain auth info', async () => {
    await mockDb.settings.put({
      key: 'webdav_url',
      value: 'https://example.com/dav/'
    });
    await mockDb.settings.put({
      key: 'webdav_username',
      value: 'storedUser'
    });

    const adapter = new WebDavAdapter();
    await adapter.authenticate();

    expect(mockCreateClient).toHaveBeenCalledWith(
      'https://example.com/dav/',
      {
        username: 'storedUser',
        password: undefined
      }
    );
  });
});

describe('WebDavAdapter binary I/O', () => {
  beforeEach(async () => {
    await mockDb.settings.clear();
    await mockDb.settings.put({ key: 'webdav_url', value: 'https://example.com/dav/' });
    mockCreateClient.mockClear();
    mockClient.getFileContents.mockClear();
    mockClient.putFileContents.mockClear();
    mockClient.createDirectory.mockClear();
    mockClient.deleteFile.mockClear();
    mockClient.getFileContents.mockResolvedValue('test content');
    mockClient.putFileContents.mockResolvedValue(undefined);
    mockClient.createDirectory.mockResolvedValue(undefined);
    mockClient.deleteFile.mockResolvedValue(undefined);
  });

  it('writeBinaryFile: ensureFolder 호출 후 putFileContents(ArrayBuffer)로 업로드', async () => {
    const adapter = new WebDavAdapter();
    const blob = new Blob(['<html>hi</html>'], { type: 'text/html' });
    await adapter.writeBinaryFile('archives/sync-1.html', blob, 'text/html');

    expect(mockClient.createDirectory).toHaveBeenCalledWith('archives', { recursive: true });
    expect(mockClient.putFileContents).toHaveBeenCalledWith('archives/sync-1.html', expect.any(ArrayBuffer));
  });

  it('writeBinaryFile: putFileContents 인자는 원본 Blob 바이트를 담은 ArrayBuffer', async () => {
    const adapter = new WebDavAdapter();
    const text = '<html>hello archive</html>';
    await adapter.writeBinaryFile('archives/x.html', new Blob([text], { type: 'text/html' }));
    const arg = mockClient.putFileContents.mock.calls[0][1] as ArrayBuffer;
    const decoded = new TextDecoder().decode(arg);
    expect(decoded).toBe(text);
  });

  it('readBinaryFile: getFileContents({format:binary}) 결과를 Blob으로 반환', async () => {
    const adapter = new WebDavAdapter();
    mockClient.getFileContents.mockResolvedValue(new Uint8Array([104, 105]));
    const result = await adapter.readBinaryFile('archives/sync-1.html');
    expect(mockClient.getFileContents).toHaveBeenCalledWith('archives/sync-1.html', { format: 'binary' });
    expect(result).toBeInstanceOf(Blob);
    expect(await result.text()).toBe('hi');
  });

  it('deleteFile: deleteFile 호출 (404는 no-op)', async () => {
    const adapter = new WebDavAdapter();
    await adapter.deleteFile('archives/sync-1.html');
    expect(mockClient.deleteFile).toHaveBeenCalledWith('archives/sync-1.html');

    mockClient.deleteFile.mockRejectedValueOnce({ status: 404 });
    await expect(adapter.deleteFile('archives/nope.html')).resolves.toBeUndefined();
  });

  it('ensureFolder: createDirectory(recursive) 호출, 이미 존재(예외) 시 no-op (idempotent)', async () => {
    const adapter = new WebDavAdapter();
    await adapter.ensureFolder('archives');
    expect(mockClient.createDirectory).toHaveBeenCalledWith('archives', { recursive: true });

    // Second call (exception thrown) -> quietly succeeds
    mockClient.createDirectory.mockRejectedValueOnce(new Error('already exists'));
    await expect(adapter.ensureFolder('archives')).resolves.toBeUndefined();
  });
});

describe('WebDavAdapter connection status lifecycle', () => {
  beforeEach(async () => {
    await mockDb.settings.clear();
    mockCreateClient.mockClear();
    mockClient.getDirectoryContents.mockClear();
    mockClient.getDirectoryContents.mockResolvedValue([]);
  });

  it('authenticate 성공 시 webdav_connected를 true로 저장한다', async () => {
    await mockDb.settings.put({ key: 'webdav_url', value: 'http://localhost:8085/' });
    const adapter = new WebDavAdapter();
    await adapter.authenticate();

    expect((await mockDb.settings.get('webdav_connected')).value).toBe(true);
  });

  it('authenticate 실패 (401) 시 webdav_connected를 false로 저장한다', async () => {
    await mockDb.settings.put({ key: 'webdav_url', value: 'http://localhost:8085/' });
    mockClient.getDirectoryContents.mockRejectedValueOnce({ status: 401, message: 'Unauthorized' });
    const adapter = new WebDavAdapter();

    await expect(adapter.authenticate()).rejects.toThrow();
    expect((await mockDb.settings.get('webdav_connected')).value).toBe(false);
  });

  it('revoke 시 webdav_connected 키를 삭제한다', async () => {
    await mockDb.settings.put({ key: 'webdav_url', value: 'http://localhost:8085/' });
    await mockDb.settings.put({ key: 'webdav_connected', value: true });
    const adapter = new WebDavAdapter();
    await adapter.revoke();

    expect((await mockDb.settings.get('webdav_connected')).value).toBeUndefined();
  });
});
