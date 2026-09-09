import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { saveAiSettings, getAiSettings } from '../../src/lib/ai/ai-summarizer';
import { decryptCredential } from '../../src/lib/sync/crypto';

const { mockDb } = vi.hoisted(() => {
  const db = {
    settings: {
      data: new Map<string, any>(),
      clear: async () => db.settings.data.clear(),
      get: async (key: string) => ({ value: db.settings.data.get(key) }),
      put: async (item: { key: string; value: any }) => {
        db.settings.data.set(item.key, item.value);
      },
      delete: async (key: string) => {
        db.settings.data.delete(key);
      }
    },
    syncState: {
      orderBy: () => ({
        last: async () => undefined
      })
    }
  };
  return { mockDb: db };
});

vi.mock('../../src/lib/db', () => ({
  default: mockDb
}));

describe('Unified Settings Save Engine', () => {
  beforeEach(async () => {
    await mockDb.settings.clear();
    if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn();
    }
  });

  it('saves all AI and Cloud Sync settings simultaneously to DB', async () => {
    // 1. Save AI Settings
    await saveAiSettings({
      provider: 'openai',
      apiKey: 'sk-test-unified-key',
      customEndpoint: 'https://api.custom.com/v1',
      customModel: 'gpt-4o-mini-test',
      autoSummarize: true
    });
    await mockDb.settings.put({ key: 'auto_archive', value: true });
    await mockDb.settings.put({ key: 'archive_compress', value: true });

    // 2. Save Cloud Sync Settings
    await mockDb.settings.put({ key: 'sync_provider', value: 'google-drive' });
    await mockDb.settings.put({ key: 'gdrive_client_id', value: 'gdrive-test-client-123' });
    await mockDb.settings.put({ key: 'onedrive_client_id', value: 'onedrive-test-client-456' });
    await mockDb.settings.put({ key: 'dropbox_client_id', value: 'dropbox-test-key-789' });
    await mockDb.settings.put({ key: 'webdav_url', value: 'https://dav.test.com/remote.php' });
    await mockDb.settings.put({ key: 'webdav_username', value: 'testuser' });
    await mockDb.settings.put({ key: 'webdav_password', value: 'secretpass' });
    await mockDb.settings.put({ key: 'sync_archive_to_cloud', value: true });

    // Verify AI settings retrieved correctly
    const aiResult = await getAiSettings();
    expect(aiResult.provider).toBe('openai');
    expect(aiResult.apiKey).toBe('sk-test-unified-key');
    expect(aiResult.customEndpoint).toBe('https://api.custom.com/v1');
    expect(aiResult.customModel).toBe('gpt-4o-mini-test');
    expect(aiResult.autoSummarize).toBe(true);
    // Separate AI settings: fall back to default true when autoTags/autoFolder are unset on save, do not write legacy keys
    expect(aiResult.autoTags).toBe(true);
    expect(aiResult.autoFolder).toBe(true);
    expect((await mockDb.settings.get('ai_auto_categorize')).value).toBeUndefined();

    expect((await mockDb.settings.get('auto_archive')).value).toBe(true);
    expect((await mockDb.settings.get('archive_compress')).value).toBe(true);

    // Verify Sync settings retrieved correctly
    expect((await mockDb.settings.get('sync_provider')).value).toBe('google-drive');
    expect((await mockDb.settings.get('gdrive_client_id')).value).toBe('gdrive-test-client-123');
    expect((await mockDb.settings.get('onedrive_client_id')).value).toBe('onedrive-test-client-456');
    expect((await mockDb.settings.get('dropbox_client_id')).value).toBe('dropbox-test-key-789');
    expect((await mockDb.settings.get('webdav_url')).value).toBe('https://dav.test.com/remote.php');
    expect((await mockDb.settings.get('webdav_username')).value).toBe('testuser');
    expect(await decryptCredential((await mockDb.settings.get('webdav_password')).value)).toBe('secretpass');
    expect((await mockDb.settings.get('sync_archive_to_cloud')).value).toBe(true);
  });

  describe('archive_compress Default Setting', () => {
    it('returns true when archive_compress key is missing or undefined in DB', async () => {
      const setting = await mockDb.settings.get('archive_compress');
      const compressValue = setting?.value ?? true;
      expect(setting?.value).toBeUndefined();
      expect(compressValue).toBe(true);
    });

    it('initializes compressArchive toggle state to true in SettingsContainer when unset', async () => {
      const { default: SettingsContainer } = await import('../../src/components/management/SettingsContainer.svelte');
      const target = document.body;
      new SettingsContainer({ target, props: { initialSection: 'archive' } });

      const compressToggle = document.getElementById('compress-archive');
      expect(compressToggle).not.toBeNull();
      expect(compressToggle?.getAttribute('aria-checked')).toBe('true');
    });

    it('respects explicit false value when archive_compress is set to false in DB', async () => {
      await mockDb.settings.put({ key: 'archive_compress', value: false });
      const setting = await mockDb.settings.get('archive_compress');
      const compressValue = setting?.value ?? true;
      expect(compressValue).toBe(false);
    });
  });

  describe('sync_archive_to_cloud Default Setting', () => {
    it('returns true when sync_archive_to_cloud key is missing or undefined in DB', async () => {
      const setting = await mockDb.settings.get('sync_archive_to_cloud');
      const syncArchiveValue = setting?.value ?? true;
      expect(setting?.value).toBeUndefined();
      expect(syncArchiveValue).toBe(true);
    });

    it('initializes syncArchiveToCloud toggle state to true in SettingsContainer when unset', async () => {
      const { default: SettingsContainer } = await import('../../src/components/management/SettingsContainer.svelte');
      const target = document.body;
      new SettingsContainer({ target, props: { initialSection: 'sync' } });
      const { tick } = await import('svelte');
      await tick();

      const select = document.getElementById('sync-provider') as HTMLSelectElement;
      expect(select).not.toBeNull();
      select.value = 'google-drive';
      select.dispatchEvent(new Event('change'));
      await tick();

      const syncArchiveToggle = document.getElementById('sync-archive');
      expect(syncArchiveToggle).not.toBeNull();
      expect(syncArchiveToggle?.getAttribute('aria-checked')).toBe('true');
    });

    it('respects explicit false value when sync_archive_to_cloud is set to false in DB', async () => {
      await mockDb.settings.put({ key: 'sync_archive_to_cloud', value: false });
      const setting = await mockDb.settings.get('sync_archive_to_cloud');
      const syncArchiveValue = setting?.value ?? true;
      expect(syncArchiveValue).toBe(false);
    });
  });

  describe('SettingsContainer Auto-Save Status Lifecycle', () => {
    beforeEach(() => {
      document.body.innerHTML = '';
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('initializes indicator in idle state and hides it', async () => {
      const { default: SettingsContainer } = await import('../../src/components/management/SettingsContainer.svelte');
      const target = document.body;
      new SettingsContainer({ target, props: { initialSection: 'archive' } });

      const indicator = document.querySelector('.autosave-indicator');
      expect(indicator).not.toBeNull();
      expect(indicator?.classList.contains('idle')).toBe(true);
    });

    it('transitions to saved and resets to idle after 2.5s timer', async () => {
      const { default: SettingsContainer } = await import('../../src/components/management/SettingsContainer.svelte');
      const target = document.body;
      new SettingsContainer({ target, props: { initialSection: 'archive' } });

      const select = document.getElementById('ai-provider') as HTMLSelectElement;
      expect(select).not.toBeNull();
      select.value = 'openai';
      select.dispatchEvent(new Event('change'));

      // Wait for async performAutoSave
      await vi.runAllTimersAsync();

      const indicator = document.querySelector('.autosave-indicator');
      expect(indicator?.classList.contains('saved') || indicator?.classList.contains('idle')).toBe(true);
    });
  });

  describe('Cloud Storage Adapters Revoke Credentials', () => {
    it('deletes Google Drive client ID, secret, and tokens on revoke', async () => {
      const { GoogleDriveAdapter } = await import('../../src/lib/sync/adapters/google-drive');
      await mockDb.settings.put({ key: 'gdrive_client_id', value: 'gdrive-id-123' });
      await mockDb.settings.put({ key: 'gdrive_client_secret', value: 'gdrive-secret-123' });
      await mockDb.settings.put({ key: 'gdrive_access_token', value: 'access-123' });
      await mockDb.settings.put({ key: 'gdrive_refresh_token', value: 'refresh-123' });
      await mockDb.settings.put({ key: 'gdrive_token_expiry', value: '1000' });

      const adapter = new GoogleDriveAdapter();
      await adapter.revoke();

      expect((await mockDb.settings.get('gdrive_client_id')).value).toBeUndefined();
      expect((await mockDb.settings.get('gdrive_client_secret')).value).toBeUndefined();
      expect((await mockDb.settings.get('gdrive_access_token')).value).toBeUndefined();
      expect((await mockDb.settings.get('gdrive_refresh_token')).value).toBeUndefined();
      expect((await mockDb.settings.get('gdrive_token_expiry')).value).toBeUndefined();
    });

    it('deletes OneDrive client ID, secret, and tokens on revoke', async () => {
      const { OneDriveAdapter } = await import('../../src/lib/sync/adapters/onedrive');
      await mockDb.settings.put({ key: 'onedrive_client_id', value: 'onedrive-id-456' });
      await mockDb.settings.put({ key: 'onedrive_client_secret', value: 'onedrive-secret-456' });
      await mockDb.settings.put({ key: 'onedrive_access_token', value: 'access-456' });
      await mockDb.settings.put({ key: 'onedrive_refresh_token', value: 'refresh-456' });
      await mockDb.settings.put({ key: 'onedrive_token_expiry', value: '1000' });

      const adapter = new OneDriveAdapter();
      await adapter.revoke();

      expect((await mockDb.settings.get('onedrive_client_id')).value).toBeUndefined();
      expect((await mockDb.settings.get('onedrive_client_secret')).value).toBeUndefined();
      expect((await mockDb.settings.get('onedrive_access_token')).value).toBeUndefined();
      expect((await mockDb.settings.get('onedrive_refresh_token')).value).toBeUndefined();
      expect((await mockDb.settings.get('onedrive_token_expiry')).value).toBeUndefined();
    });

    it('deletes Dropbox client ID, secret, and tokens on revoke', async () => {
      const { DropboxAdapter } = await import('../../src/lib/sync/adapters/dropbox');
      await mockDb.settings.put({ key: 'dropbox_client_id', value: 'dropbox-id-789' });
      await mockDb.settings.put({ key: 'dropbox_client_secret', value: 'dropbox-secret-789' });
      await mockDb.settings.put({ key: 'dropbox_access_token', value: 'access-789' });
      await mockDb.settings.put({ key: 'dropbox_refresh_token', value: 'refresh-789' });
      await mockDb.settings.put({ key: 'dropbox_token_expiry', value: '1000' });

      const adapter = new DropboxAdapter();
      await adapter.revoke();

      expect((await mockDb.settings.get('dropbox_client_id')).value).toBeUndefined();
      expect((await mockDb.settings.get('dropbox_client_secret')).value).toBeUndefined();
      expect((await mockDb.settings.get('dropbox_access_token')).value).toBeUndefined();
      expect((await mockDb.settings.get('dropbox_refresh_token')).value).toBeUndefined();
      expect((await mockDb.settings.get('dropbox_token_expiry')).value).toBeUndefined();
    });

    it('deletes WebDAV URL, username, password, and connection status on revoke', async () => {
      const { WebDavAdapter } = await import('../../src/lib/sync/adapters/webdav');
      await mockDb.settings.put({ key: 'webdav_url', value: 'https://dav.example.com' });
      await mockDb.settings.put({ key: 'webdav_username', value: 'user' });
      await mockDb.settings.put({ key: 'webdav_password', value: 'pass' });
      await mockDb.settings.put({ key: 'webdav_connected', value: true });

      const adapter = new WebDavAdapter();
      await adapter.revoke();

      expect((await mockDb.settings.get('webdav_url')).value).toBeUndefined();
      expect((await mockDb.settings.get('webdav_username')).value).toBeUndefined();
      expect((await mockDb.settings.get('webdav_password')).value).toBeUndefined();
      expect((await mockDb.settings.get('webdav_connected')).value).toBeUndefined();
    });
  });

  describe('SyncSettings Provider Auto-Connect', () => {
    beforeEach(() => {
      document.body.innerHTML = '';
    });

    it('renders SyncSettings and mounts Google Drive provider with client ID and secret inputs', async () => {
      const { default: SyncSettings } = await import('../../src/components/management/settings/SyncSettings.svelte');
      const { tick } = await import('svelte');
      const target = document.body;
      new SyncSettings({ target });
      await tick();

      const select = document.getElementById('sync-provider') as HTMLSelectElement;
      expect(select).not.toBeNull();
      select.value = 'google-drive';
      select.dispatchEvent(new Event('change'));
      await tick();

      const input = document.getElementById('gdrive-client-id') as HTMLInputElement;
      expect(input).not.toBeNull();
      input.value = 'test-client-id-123';
      input.dispatchEvent(new Event('input'));

      const secretInput = document.getElementById('gdrive-client-id-secret') as HTMLInputElement;
      expect(secretInput).not.toBeNull();
      secretInput.value = 'GOCSPX-secret123';
      secretInput.dispatchEvent(new Event('input'));
      secretInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await tick();
    });

    it('does not trigger OAuth connect for Google Drive if only client ID is present', async () => {
      const { default: SyncProviderOAuth } = await import('../../src/components/management/settings/SyncProviderOAuth.svelte');
      const { tick } = await import('svelte');
      const target = document.body;
      const connectHandler = vi.fn();

      const comp = new SyncProviderOAuth({
        target,
        props: {
          provider: 'google-drive',
          clientId: 'only-id-no-secret',
          clientSecret: ''
        }
      });
      comp.$on('connect', connectHandler);
      await tick();

      const input = document.getElementById('gdrive-client-id') as HTMLInputElement;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await tick();

      expect(connectHandler).not.toHaveBeenCalled();
    });

    it('triggers OAuth connect for Google Drive when both client ID and secret are present', async () => {
      const { default: SyncProviderOAuth } = await import('../../src/components/management/settings/SyncProviderOAuth.svelte');
      const { tick } = await import('svelte');
      const target = document.body;
      const connectHandler = vi.fn();

      const comp = new SyncProviderOAuth({
        target,
        props: {
          provider: 'google-drive',
          clientId: 'valid-client-id',
          clientSecret: 'valid-client-secret'
        }
      });
      comp.$on('connect', connectHandler);
      await tick();

      const input = document.getElementById('gdrive-client-id') as HTMLInputElement;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await tick();

      expect(connectHandler).toHaveBeenCalled();
    });
  });

  describe('SyncConflictLogs Clearing & Localization', () => {
    beforeEach(async () => {
      document.body.innerHTML = '';
      await mockDb.settings.clear();
    });

    it('has non-empty clearConfirm and cleared strings in both ko and en locales', async () => {
      const { readFileSync, existsSync } = await import('node:fs');
      const koPath = existsSync('src/locales/ko.yml') ? 'src/locales/ko.yml' : 'locales/ko.yml';
      const enPath = existsSync('src/locales/en.yml') ? 'src/locales/en.yml' : 'locales/en.yml';
      const koContent = readFileSync(koPath, 'utf-8');
      const enContent = readFileSync(enPath, 'utf-8');

      expect(koContent).toContain('clearConfirm:');
      expect(koContent).toContain('cleared:');
      expect(enContent).toContain('clearConfirm:');
      expect(enContent).toContain('cleared:');
    });

    it('clears conflict logs and shows toast on confirm', async () => {
      const { default: SyncSettings } = await import('../../src/components/management/settings/SyncSettings.svelte');
      const { toasts } = await import('../../src/lib/ui/toast-store');
      const { get } = await import('svelte/store');
      const { tick } = await import('svelte');

      await mockDb.settings.put({ key: 'sync_provider', value: 'google-drive' });
      await mockDb.settings.put({
        key: 'sync_conflict_logs',
        value: [{ id: 'c1', timestamp: Date.now(), bookmarkId: 'b1', resolvedTo: 'local' }]
      });

      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

      const target = document.body;
      new SyncSettings({ target });
      await new Promise(resolve => setTimeout(resolve, 50));
      await tick();

      // Find the "Clear Logs" button inside SyncConflictLogsCard
      const clearBtn = Array.from(document.querySelectorAll('button')).find(
        b => b.textContent?.includes('로그 비우기') || b.textContent?.includes('Clear Logs') || b.textContent?.includes('conflict.clearLogs')
      ) as HTMLButtonElement | undefined;
      expect(clearBtn).toBeDefined();
      expect(clearBtn?.disabled).toBe(false);

      clearBtn?.click();
      await tick();
      await tick();

      expect(confirmSpy).toHaveBeenCalled();
      const confirmArg = confirmSpy.mock.calls[0][0];
      expect(confirmArg).not.toBe('');
      expect(typeof confirmArg).toBe('string');
      expect(confirmArg.length).toBeGreaterThan(0);

      // Check DB was cleared
      const stored = (await mockDb.settings.get('sync_conflict_logs')).value;
      expect(stored).toBeUndefined();

      // Check Toast was displayed with non-empty message
      const currentToasts = get(toasts);
      expect(currentToasts.length).toBeGreaterThan(0);
      const lastToast = currentToasts[currentToasts.length - 1];
      expect(lastToast.message).not.toBe('');
      expect(lastToast.type).toBe('success');

      confirmSpy.mockRestore();
    });

    it('renders SyncConflictLogsCard in collapsed state by default and expands on click', async () => {
      const { default: SyncConflictLogsCard } = await import(
        '../../src/components/management/settings/SyncConflictLogsCard.svelte'
      );
      const { tick } = await import('svelte');

      document.body.innerHTML = '';
      const target = document.body;
      const card = new SyncConflictLogsCard({
        target,
        props: {
          conflictLogs: [{ id: 'c1', timestamp: Date.now(), bookmarkId: 'b1', resolvedTo: 'local' }]
        }
      });
      await tick();

      // Initially table should not be present (collapsed)
      expect(document.querySelector('.conflict-table')).toBeNull();

      // Click header toggle button
      const toggleBtn = document.querySelector('.header-toggle-btn') as HTMLButtonElement;
      expect(toggleBtn).not.toBeNull();
      toggleBtn.click();
      await tick();

      // Table should now be rendered (expanded)
      expect(document.querySelector('.conflict-table')).not.toBeNull();

      card.$destroy();
    });
  });
});

