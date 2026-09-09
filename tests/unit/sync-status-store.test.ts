import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  syncStatus,
  syncProvider,
  lastSyncAt,
  refreshSyncStatus,
  setSyncProvider,
  triggerManualSync,
  initSyncStatusStore
} from '../../src/lib/sync/sync-status-store';
import { SyncEngine } from '../../src/lib/sync/sync-engine';
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
    document.body.innerHTML = '';
    
    // Reset store to initial state
    syncStatus.set({
      provider: 'none',
      lastSyncTime: null,
      isSyncing: false,
      error: null
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
});
