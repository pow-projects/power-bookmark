import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  syncStatus,
  syncProvider,
  lastSyncAt,
  refreshSyncStatus,
  setSyncProvider,
  triggerManualSync,
  initSyncStatusStore,
  getSyncCooldownMs,
  _setSyncCooldownMsForTest,
  _resetSyncCooldownForTest
} from '../../src/lib/sync/sync-status-store';
import { SyncEngine } from '../../src/lib/sync/sync-engine';
import { SYNC_DISCONNECT_KEY } from '../../src/lib/sync/tombstones';
import SyncWidget from '../../src/components/management/SyncWidget.svelte';
import SyncSettings from '../../src/components/management/settings/SyncSettings.svelte';
import { tick } from 'svelte';

const { mockDb } = vi.hoisted(() => {
  let lastSyncRecord: any = null;
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
      },
      toArray: async () => Array.from(db.settings.data.entries()).map(([key, value]) => ({ key, value }))
    },
    syncState: {
      clear: async () => { lastSyncRecord = null; },
      orderBy: () => ({
        last: async () => lastSyncRecord
      }),
      put: async (record: any) => {
        lastSyncRecord = record;
      },
      _setLastRecord: (rec: any) => {
        lastSyncRecord = rec;
      }
    }
  };
  return { mockDb: db };
});

vi.mock('../../src/lib/db', () => ({
  default: mockDb
}));

vi.mock('../../src/lib/sync/sync-engine', () => {
  return {
    SyncEngine: {
      resetAdapter: vi.fn(),
      sync: vi.fn().mockResolvedValue(undefined),
      updateSyncSchedule: vi.fn().mockResolvedValue(undefined),
      getAdapter: vi.fn().mockResolvedValue({
        authenticate: vi.fn().mockResolvedValue(true),
        revoke: vi.fn().mockResolvedValue(undefined)
      })
    }
  };
});

describe('SyncStatusStore & Reactive Integration', () => {
  beforeEach(async () => {
    await mockDb.settings.clear();
    mockDb.syncState._setLastRecord(null);
    vi.clearAllMocks();
    _resetSyncCooldownForTest();
    _setSyncCooldownMsForTest(null);
    document.body.innerHTML = '';
    
    // Reset store to initial state
    syncStatus.set({
      provider: 'none',
      lastSyncTime: null,
      isSyncing: false,
      isConnected: false,
      error: null,
      isCoolingDown: false
    });
  });

  it('exports reactive store subscriptions for syncStatus, syncProvider, lastSyncAt', () => {
    expect(get(syncStatus).provider).toBe('none');
    expect(get(syncProvider)).toBe('none');
    expect(get(lastSyncAt)).toBeNull();

    syncStatus.set({
      provider: 'google-drive',
      lastSyncTime: 1700000000000,
      isSyncing: true,
      error: null
    });

    expect(get(syncProvider)).toBe('google-drive');
    expect(get(lastSyncAt)).toBe(1700000000000);
    expect(get(syncStatus).isSyncing).toBe(true);
  });

  it('refreshSyncStatus reads provider and syncState from DB and updates store', async () => {
    await mockDb.settings.put({ key: 'sync_provider', value: 'onedrive' });
    mockDb.syncState._setLastRecord({
      provider: 'onedrive',
      lastSyncAt: 1700000001000,
      status: 'idle'
    });

    const state = await refreshSyncStatus();

    expect(state.provider).toBe('onedrive');
    expect(state.lastSyncTime).toBe(1700000001000);
    expect(state.isSyncing).toBe(false);

    expect(get(syncProvider)).toBe('onedrive');
    expect(get(lastSyncAt)).toBe(1700000001000);
    expect(state.isConnected).toBe(false);
  });

  it('refreshSyncStatus reflects accurate isConnected for WebDAV', async () => {
    await mockDb.settings.put({ key: 'sync_provider', value: 'webdav' });
    await mockDb.settings.put({ key: 'webdav_connected', value: false });
    let state = await refreshSyncStatus();
    expect(state.isConnected).toBe(false);

    await mockDb.settings.put({ key: 'webdav_connected', value: true });
    state = await refreshSyncStatus();
    expect(state.isConnected).toBe(true);
  });

  it('setSyncProvider mutates DB, resets adapter, updates store, and dispatches sync-resolved event', async () => {
    let eventFired = false;
    const handler = () => { eventFired = true; };
    document.addEventListener('sync-resolved', handler);

    const updatedState = await setSyncProvider('dropbox');

    expect(SyncEngine.resetAdapter).toHaveBeenCalled();
    expect((await mockDb.settings.get('sync_provider')).value).toBe('dropbox');
    expect(updatedState.provider).toBe('dropbox');
    expect(get(syncProvider)).toBe('dropbox');
    expect(eventFired).toBe(true);

    document.removeEventListener('sync-resolved', handler);
  });

  it('setSyncProvider("none") resets syncState in DB', async () => {
    mockDb.syncState._setLastRecord({ provider: 'dropbox', lastSyncAt: 1700000000000, status: 'idle' });
    await mockDb.settings.put({ key: 'sync_provider', value: 'dropbox' });

    await setSyncProvider('none');

    expect((await mockDb.settings.get('sync_provider')).value).toBe('none');
    expect(get(syncProvider)).toBe('none');

    // Unlink time is recorded in settings (NOT syncState, whose single id:1 row every sync attempt
    // overwrites) so deletions performed while unlinked keep their intent on reconnect.
    const marker = (await mockDb.settings.get(SYNC_DISCONNECT_KEY)).value;
    expect(typeof marker).toBe('number');
  });

  it('triggerManualSync sets syncing state, runs SyncEngine.sync, and refreshes status on success', async () => {
    await mockDb.settings.put({ key: 'sync_provider', value: 'webdav' });
    mockDb.syncState._setLastRecord({ provider: 'webdav', lastSyncAt: 1700000002000, status: 'idle' });

    const result = await triggerManualSync();

    expect(SyncEngine.sync).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(get(syncProvider)).toBe('webdav');
    expect(get(syncStatus).isSyncing).toBe(false);
  });

  it('triggerManualSync handles sync failure and records error in store', async () => {
    (SyncEngine.sync as any).mockRejectedValueOnce(new Error('Network offline'));

    const result = await triggerManualSync();

    expect(result.success).toBe(false);
    expect(result.message).toBe('Network offline');
    expect(get(syncStatus).isSyncing).toBe(false);
    expect(get(syncStatus).error).toBe('Network offline');
  });

  it('keeps SyncSettings and SyncWidget in sync when provider changes', async () => {
    // 1. Mount SyncWidget in document
    const widgetTarget = document.createElement('div');
    document.body.appendChild(widgetTarget);
    new SyncWidget({ target: widgetTarget });

    // Initially none -> widget is not shown
    await tick();
    expect(widgetTarget.querySelector('.sync-widget')).toBeNull();

    // 2. Change provider via setSyncProvider (as triggered by SyncSettings)
    await setSyncProvider('google-drive');
    mockDb.syncState._setLastRecord({
      provider: 'google-drive',
      lastSyncAt: 1700000000000,
      status: 'idle'
    });
    await refreshSyncStatus();
    await tick();

    // Widget should now be rendered with Google Drive
    const widgetEl = widgetTarget.querySelector('.sync-widget');
    expect(widgetEl).not.toBeNull();
    expect(widgetTarget.textContent).toContain('Google Drive');

    // 3. Mount SyncSettings and verify it reflects google-drive
    const settingsTarget = document.createElement('div');
    document.body.appendChild(settingsTarget);
    new SyncSettings({ target: settingsTarget });
    await new Promise((r) => setTimeout(r, 20));
    await tick();

    const selectEl = settingsTarget.querySelector('#sync-provider') as HTMLSelectElement;
    expect(selectEl).not.toBeNull();
    expect(selectEl.value).toBe('google-drive');

    // 4. Change provider to WebDAV via setSyncProvider
    await setSyncProvider('webdav');
    mockDb.syncState._setLastRecord({
      provider: 'webdav',
      lastSyncAt: 1700000005000,
      status: 'idle'
    });
    await refreshSyncStatus();
    await tick();

    // Widget reflects WebDAV
    expect(widgetTarget.textContent).toContain('WebDAV');
  });

  it('setSyncProvider updates sync schedule when provider changes', async () => {
    vi.clearAllMocks();
    await setSyncProvider('dropbox');
    expect(SyncEngine.updateSyncSchedule).toHaveBeenCalledWith(undefined);

    await setSyncProvider('none');
    expect(SyncEngine.updateSyncSchedule).toHaveBeenCalledWith(0);
  });

  it('SyncSettings loads configured sync_interval_minutes and saves on change', async () => {
    await mockDb.settings.put({ key: 'sync_provider', value: 'google-drive' });
    await mockDb.settings.put({ key: 'sync_interval_minutes', value: 30 });

    const settingsTarget = document.createElement('div');
    document.body.appendChild(settingsTarget);
    new SyncSettings({ target: settingsTarget });
    await new Promise((r) => setTimeout(r, 20));
    await tick();

    const intervalSelect = settingsTarget.querySelector('#sync-interval') as HTMLSelectElement;
    expect(intervalSelect).not.toBeNull();
    expect(intervalSelect.value).toBe('30');

    // Change interval to 60 minutes
    intervalSelect.value = '60';
    intervalSelect.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 20));
    await tick();

    expect((await mockDb.settings.get('sync_interval_minutes')).value).toBe(60);
    expect(SyncEngine.updateSyncSchedule).toHaveBeenCalledWith(60);
  });

  describe('Manual Sync Cooldown Guard', () => {
    it('blocks rapid re-triggering within cooldown window and sets throttled', async () => {
      await mockDb.settings.put({ key: 'sync_provider', value: 'google-drive' });
      mockDb.syncState._setLastRecord({ provider: 'google-drive', lastSyncAt: 1000, status: 'idle' });

      // First sync succeeds
      const firstResult = await triggerManualSync();
      expect(firstResult.success).toBe(true);
      expect(firstResult.throttled).toBeUndefined();
      expect(get(syncStatus).isCoolingDown).toBe(true);

      // Immediate second call should be blocked by cooldown
      const secondResult = await triggerManualSync();
      expect(secondResult.success).toBe(false);
      expect(secondResult.throttled).toBe(true);
      expect(secondResult.message).toBe('잠시 후 다시 시도해주세요.');

      // SyncEngine.sync should only have been called once
      expect(SyncEngine.sync).toHaveBeenCalledTimes(1);
    });

    it('resets isCoolingDown after cooldown duration expires', async () => {
      vi.useFakeTimers();
      _setSyncCooldownMsForTest(500);

      await mockDb.settings.put({ key: 'sync_provider', value: 'google-drive' });
      mockDb.syncState._setLastRecord({ provider: 'google-drive', lastSyncAt: 1000, status: 'idle' });

      await triggerManualSync();
      expect(get(syncStatus).isCoolingDown).toBe(true);

      // Fast forward past 500ms cooldown
      vi.advanceTimersByTime(501);
      expect(get(syncStatus).isCoolingDown).toBe(false);

      // Now a new sync is permitted
      const nextResult = await triggerManualSync();
      expect(nextResult.success).toBe(true);
      expect(SyncEngine.sync).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('disables SyncWidget button when isCoolingDown is true', async () => {
      await mockDb.settings.put({ key: 'sync_provider', value: 'google-drive' });
      mockDb.syncState._setLastRecord({ provider: 'google-drive', lastSyncAt: 1000, status: 'idle' });
      await refreshSyncStatus();

      const target = document.createElement('div');
      document.body.appendChild(target);
      new SyncWidget({ target });
      await tick();

      const btn = target.querySelector('.sync-btn') as HTMLButtonElement;
      expect(btn).not.toBeNull();
      expect(btn.disabled).toBe(false);

      // Trigger sync -> sets isCoolingDown true after finish
      await triggerManualSync();
      await tick();

      expect(btn.disabled).toBe(true);
      expect(btn.classList.contains('cooldown')).toBe(true);
    });

    it('disables SyncSettings button when isCoolingDown is true', async () => {
      await mockDb.settings.put({ key: 'sync_provider', value: 'google-drive' });
      await mockDb.settings.put({ key: 'gdrive_refresh_token', value: 'token-123' });
      mockDb.syncState._setLastRecord({ provider: 'google-drive', lastSyncAt: 1000, status: 'idle' });
      await refreshSyncStatus();

      const target = document.createElement('div');
      document.body.appendChild(target);
      new SyncSettings({ target });
      await new Promise((r) => setTimeout(r, 20));
      await tick();

      const syncBtn = target.querySelector('.btn.btn-primary.btn-sm') as HTMLButtonElement;
      expect(syncBtn).not.toBeNull();
      expect(syncBtn.disabled).toBe(false);

      // Set cooldown state directly
      syncStatus.update((s) => ({ ...s, isCoolingDown: true }));
      await tick();

      expect(syncBtn.disabled).toBe(true);
      expect(syncBtn.title).toBe('잠시 후 다시 시도해주세요.');
    });
  });
});
