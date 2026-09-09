import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebDavAdapter } from '../../src/lib/sync/adapters/webdav';
import { saveWebdavSettings } from '../../src/lib/sync/webdav-settings';

// ---------------------------------------------------------------------------
// QA reproduction script — manual WebDAV authentication -> bookmark update reflection verification (live server integration test)
//
// Scenario: Connect to host-only URL (http://localhost:8085) -> Enter username/password (admin/password123)
//           -> Sync authentication -> Modify bookmark (write file) -> Confirm server reflection
//
// Prerequisite: Local WebDAV server must be running on 8085.
//   docker compose -f webdav-test/compose.yml up -d
//   (test account: USERNAME=admin / PASSWORD=password123, LOCATION=/)
//
// If server is not running, this file is automatically skipped (safe for npm test).
// For QA verification after starting server:
//   npx vitest run tests/integration/webdav-manual-auth.e2e.test.ts
// ---------------------------------------------------------------------------

const WEBDAV_PROBE = {
  url: process.env.WXT_DEV_WEBDAV_URL || 'http://localhost:8085/',
  username: process.env.WXT_DEV_WEBDAV_USERNAME || 'admin',
  password: process.env.WXT_DEV_WEBDAV_PASSWORD || 'password123',
};

// Does not mock the real webdav library — performs round-trips to the real server (8085).
// db is mocked with an in-memory store, but credential saving/decryption/adapter loading
// follows the exact production code path (saveWebdavSettings -> WebDavAdapter.authenticate -> loadCredentials).
const { mockDb } = vi.hoisted(() => {
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
    },
  };
  return { mockDb: db };
});

vi.mock('../../src/lib/db', () => ({
  default: mockDb,
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

const SYNC_FILE = 'powerbookmark_sync.json';
const BOOKMARK_V1 = JSON.stringify({ version: 1, bookmarks: [{ id: 'b1', title: '첫 북마크', url: 'https://a.com' }] });
const BOOKMARK_V2 = JSON.stringify({ version: 1, bookmarks: [{ id: 'b1', title: '수정된 북마크', url: 'https://a.com' }] });

const live = await serverUp();

describe.skipIf(!live)('수동 WebDAV 인증 → 북마크 수정 서버 반영 (localhost:8085)', () => {
  const adapter = new WebDavAdapter();

  beforeAll(async () => {
    await mockDb.settings.clear();
    // Save host-only URL + separate username/password (not legacy URL userinfo format)
    await saveWebdavSettings({
      url: WEBDAV_PROBE.url,
      username: WEBDAV_PROBE.username,
      password: WEBDAV_PROBE.password,
    });
  });

  afterAll(async () => {
    try {
      await adapter.deleteFile(SYNC_FILE);
    } catch {
      // Ignore cleanup failure
    }
  });

  it('host-only URL + 별도 아이디/비밀번호로 동기화 인증에 성공한다', async () => {
    await expect(adapter.authenticate(true)).resolves.toBeUndefined();
  });

  it('북마크 추가(파일 쓰기)가 서버에 반영되고 재읽기가 일치한다', async () => {
    await adapter.writeFile(SYNC_FILE, BOOKMARK_V1);
    const read = await adapter.readFile(SYNC_FILE);
    expect(read).toBe(BOOKMARK_V1);
  });

  it('북마크 수정 후 서버 재읽기가 수정 내용을 반영한다', async () => {
    await adapter.writeFile(SYNC_FILE, BOOKMARK_V2);
    const read = await adapter.readFile(SYNC_FILE);
    expect(read).toBe(BOOKMARK_V2);
    expect(read).toContain('수정된 북마크');
  });

  it('북마크 삭제(deleteFile)가 서버에 반영된다', async () => {
    await expect(adapter.deleteFile(SYNC_FILE)).resolves.toBeUndefined();
    // Read attempt after deletion returns 404 on server -> verify file disappeared via getDirectoryContents
    const list = await adapter.listFiles('/');
    expect(list.some((f) => f.name === SYNC_FILE)).toBe(false);
  });
});