import { describe, it, expect, beforeEach, vi } from 'vitest';
import { normalizeWebdavAuth, saveWebdavSettings } from '../../src/lib/sync/webdav-settings';
import { decryptCredential } from '../../src/lib/sync/crypto';

const { mockDb } = vi.hoisted(() => {
  const settingsData = new Map<string, any>();
  const db = {
    settings: {
      get: async (key: string) => ({ value: settingsData.get(key) }),
      put: async (item: { key: string; value: any }) => {
        settingsData.set(item.key, item.value);
      },
      clear: async () => settingsData.clear(),
      data: settingsData,
    }
  };
  return { mockDb: db };
});

vi.mock('../../src/lib/db', () => ({
  default: mockDb
}));

describe('normalizeWebdavAuth', () => {
  it('host-only URL과 별도 아이디/비밀번호를 그대로 유지한다', () => {
    const r = normalizeWebdavAuth('http://localhost:8085/', 'admin', 'password123');
    expect(r.url).toBe('http://localhost:8085/');
    expect(r.username).toBe('admin');
    expect(r.password).toBe('password123');
  });

  it('URL userinfo를 우선 적용하고 userinfo는 제거해 반환한다 (기존 방식 호환)', () => {
    const r = normalizeWebdavAuth(
      'http://admin:password123@localhost:8085/',
      'ignoredUser',
      'ignoredPass'
    );
    expect(r.url).toBe('http://localhost:8085/');
    expect(r.username).toBe('admin');
    expect(r.password).toBe('password123');
  });

  it('퍼센트 인코딩된 userinfo를 디코딩한다', () => {
    const r = normalizeWebdavAuth('http://my%20user:p%40ss@localhost:8085/');
    expect(r.username).toBe('my user');
    expect(r.password).toBe('p@ss');
    expect(r.url).toBe('http://localhost:8085/');
  });

  it('프로토콜 생략 시 루프백 호스트에는 http://를 자동으로 붙인다', () => {
    const r1 = normalizeWebdavAuth('localhost:8085', 'admin', 'pass');
    expect(r1.url).toBe('http://localhost:8085/');
    expect(r1.username).toBe('admin');
    expect(r1.password).toBe('pass');

    const r2 = normalizeWebdavAuth('127.0.0.1:8085/webdav', 'admin', 'pass');
    expect(r2.url).toBe('http://127.0.0.1:8085/webdav');

    const r3 = normalizeWebdavAuth('admin:pass@localhost:8085');
    expect(r3.url).toBe('http://localhost:8085/');
    expect(r3.username).toBe('admin');
    expect(r3.password).toBe('pass');
  });

  it('프로토콜 생략 시 비-루프백 호스트에는 https://를 자동으로 붙인다', () => {
    const r1 = normalizeWebdavAuth('dav.box.com/dav', 'admin', 'pass');
    expect(r1.url).toBe('https://dav.box.com/dav');

    const r2 = normalizeWebdavAuth('my-nas.synology.me:5001/remote.php/webdav', 'user', 'pass');
    expect(r2.url).toBe('https://my-nas.synology.me:5001/remote.php/webdav');
  });
});

describe('saveWebdavSettings', () => {
  beforeEach(async () => {
    await mockDb.settings.clear();
  });

  it('host-only URL + 별도 아이디/비밀번호를 저장한다 (비밀번호는 암호화)', async () => {
    await saveWebdavSettings({ url: 'http://localhost:8085/', username: 'admin', password: 'password123' });

    expect((await mockDb.settings.get('webdav_url')).value).toBe('http://localhost:8085/');
    expect((await mockDb.settings.get('webdav_username')).value).toBe('admin');
    const stored = (await mockDb.settings.get('webdav_password')).value;
    // Plain text must not be stored as-is — must be an encrypted object.
    expect(typeof stored).toBe('object');
    expect(stored.__encrypted).toBe(true);
    expect(await decryptCredential(stored)).toBe('password123');
  });

  it('URL userinfo가 있어도 저장되는 URL은 항상 clean URL이다 (평문 비밀번호 미노출)', async () => {
    await saveWebdavSettings({ url: 'http://admin:password123@localhost:8085/' });
    expect((await mockDb.settings.get('webdav_url')).value).toBe('http://localhost:8085/');
    expect((await mockDb.settings.get('webdav_username')).value).toBe('admin');
    expect(await decryptCredential((await mockDb.settings.get('webdav_password')).value)).toBe('password123');
  });

  it('비밀번호 미입력 시 기존 저장된 비밀번호를 유지한다', async () => {
    await saveWebdavSettings({ url: 'http://localhost:8085/', username: 'admin', password: 'secret' });
    // Update URL only without entering password
    await saveWebdavSettings({ url: 'http://localhost:8085/base/' });
    expect((await mockDb.settings.get('webdav_url')).value).toBe('http://localhost:8085/base/');
    expect(await decryptCredential((await mockDb.settings.get('webdav_password')).value)).toBe('secret');
  });

  it('마스킹된 비밀번호("****") 전달 시 기존 저장된 비밀번호를 덮어쓰지 않고 유지한다', async () => {
    await saveWebdavSettings({ url: 'http://localhost:8085/', username: 'admin', password: 'secret' });
    // Attempt update with masked string
    await saveWebdavSettings({ url: 'http://localhost:8085/', username: 'admin', password: '****' });
    expect(await decryptCredential((await mockDb.settings.get('webdav_password')).value)).toBe('secret');
  });
});