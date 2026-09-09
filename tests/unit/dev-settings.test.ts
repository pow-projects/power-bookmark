import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { seedDevSettings } from '../../src/lib/dev-settings';
import { AI_SETTINGS_KEYS } from '../../src/lib/ai/types';

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

describe('seedDevSettings', () => {
  beforeEach(async () => {
    await mockDb.settings.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('빈 설정에 WebDAV(8085/admin)와 AI(custom/8080/v1) 기본값을 시드한다', async () => {
    await seedDevSettings();

    // Saved as host-only URL + separate username/password (encrypted) — does not leave plain text password in URL.
    const { decryptCredential } = await import('../../src/lib/sync/crypto');
    expect((await mockDb.settings.get('webdav_url')).value).toBe('http://localhost:8085/');
    expect((await mockDb.settings.get('webdav_username')).value).toBe('admin');
    expect(await decryptCredential((await mockDb.settings.get('webdav_password')).value)).toBe('password123');
    expect((await mockDb.settings.get('webdav_connected')).value).toBe(true);
    expect((await mockDb.settings.get('sync_provider')).value).toBe('webdav');
    expect((await mockDb.settings.get(AI_SETTINGS_KEYS.PROVIDER)).value).toBe('custom');
    expect((await mockDb.settings.get(AI_SETTINGS_KEYS.CUSTOM_ENDPOINT)).value).toBe(
      'http://localhost:8080/v1'
    );
    expect((await mockDb.settings.get(AI_SETTINGS_KEYS.MODEL)).value).toBe(
      'gemma-4-E4B-it-Q6_K'
    );
    expect((await mockDb.settings.get(AI_SETTINGS_KEYS.CUSTOM_MODEL)).value).toBe(
      'gemma-4-E4B-it-Q6_K'
    );
  });

  it('사용자가 이미 설정한 WebDAV 값은 덮어쓰지 않는다', async () => {
    await mockDb.settings.put({ key: 'webdav_url', value: 'https://user.example.com/dav/' });
    await seedDevSettings();

    expect((await mockDb.settings.get('webdav_url')).value).toBe('https://user.example.com/dav/');
    expect((await mockDb.settings.get('sync_provider')).value).toBe('webdav');
  });

  it('기존 dev 환경에서 webdav_connected가 누락되어 있으면 true로 보정한다', async () => {
    await mockDb.settings.put({ key: 'sync_provider', value: 'webdav' });
    await mockDb.settings.put({ key: 'webdav_url', value: 'http://localhost:8085/' });
    await seedDevSettings();

    expect((await mockDb.settings.get('webdav_connected')).value).toBe(true);
  });

  it('AI provider가 이미 설정돼 있으면 시드하지 않는다', async () => {
    await mockDb.settings.put({ key: AI_SETTINGS_KEYS.PROVIDER, value: 'openai' });
    await seedDevSettings();

    expect((await mockDb.settings.get(AI_SETTINGS_KEYS.PROVIDER)).value).toBe('openai');
    expect((await mockDb.settings.get(AI_SETTINGS_KEYS.CUSTOM_ENDPOINT)).value).toBeUndefined();
  });

  it('WXT_DEV_* 환경변수가 지정되면 해당 커스텀 값으로 시드한다', async () => {
    vi.stubEnv('WXT_DEV_WEBDAV_URL', 'http://localhost:9000/dav/');
    vi.stubEnv('WXT_DEV_WEBDAV_USERNAME', 'custom_user');
    vi.stubEnv('WXT_DEV_WEBDAV_PASSWORD', 'secret999');
    vi.stubEnv('WXT_DEV_AI_PROVIDER', 'ollama');
    vi.stubEnv('WXT_DEV_AI_ENDPOINT', 'http://localhost:11434/v1');
    vi.stubEnv('WXT_DEV_AI_MODEL', 'llama3.2:3b');
    vi.stubEnv('WXT_DEV_AI_API_KEY', 'sk-test-key-123');

    await seedDevSettings();

    const { decryptCredential } = await import('../../src/lib/sync/crypto');
    expect((await mockDb.settings.get('webdav_url')).value).toBe('http://localhost:9000/dav/');
    expect((await mockDb.settings.get('webdav_username')).value).toBe('custom_user');
    expect(await decryptCredential((await mockDb.settings.get('webdav_password')).value)).toBe('secret999');
    expect((await mockDb.settings.get('webdav_connected')).value).toBe(true);
    expect((await mockDb.settings.get('sync_provider')).value).toBe('webdav');
    expect((await mockDb.settings.get(AI_SETTINGS_KEYS.PROVIDER)).value).toBe('ollama');
    expect((await mockDb.settings.get(AI_SETTINGS_KEYS.CUSTOM_ENDPOINT)).value).toBe(
      'http://localhost:11434/v1'
    );
    expect((await mockDb.settings.get(AI_SETTINGS_KEYS.MODEL)).value).toBe('llama3.2:3b');
    expect((await mockDb.settings.get(AI_SETTINGS_KEYS.CUSTOM_MODEL)).value).toBe('llama3.2:3b');
    expect((await mockDb.settings.get(AI_SETTINGS_KEYS.API_KEY)).value).toBe('sk-test-key-123');
    expect((await mockDb.settings.get(AI_SETTINGS_KEYS.API_KEYS_MAP)).value).toEqual({
      ollama: 'sk-test-key-123'
    });
  });
});
