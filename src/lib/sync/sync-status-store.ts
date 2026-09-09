import { writable, derived, type Readable } from 'svelte/store';
import { liveQuery, type Subscription } from 'dexie';
import db from '../db';
import { SyncEngine } from './sync-engine';
import { clearTombstones } from './tombstones';

export interface SyncStatusState {
  provider: string;
  lastSyncTime: number | null;
  isSyncing: boolean;
  error: string | null;
}

const initialState: SyncStatusState = {
  provider: 'none',
  lastSyncTime: null,
  isSyncing: false,
  error: null
};

export const syncStatus = writable<SyncStatusState>(initialState);

export const syncProvider: Readable<string> = derived(
  syncStatus,
  ($status) => $status.provider
);

export const lastSyncAt: Readable<number | null> = derived(
  syncStatus,
  ($status) => $status.lastSyncTime
);

let liveSub: Subscription | null = null;

export function initSyncStatusStore(): () => void {
  if (liveSub) {
    try {
      liveSub.unsubscribe();
    } catch {
      // ignore
    }
    liveSub = null;
  }

  if (typeof db !== 'undefined' && db.syncState) {
    try {
      liveSub = liveQuery(async () => {
        let syncRecord: any = null;
        let providerSetting: any = null;
        try {
          if (db.syncState) {
            syncRecord = await db.syncState.orderBy('id').last();
          }
          if (db.settings) {
            providerSetting = await db.settings.get('sync_provider');
          }
        } catch {
          // ignore transient DB errors during close or upgrade
        }
        return { syncRecord, providerSetting };
      }).subscribe({
        next: ({ syncRecord, providerSetting }) => {
          const provider = providerSetting?.value || 'none';
          let lastSyncTime: number | null = null;
          let isSyncing = false;
          if (syncRecord) {
            lastSyncTime = syncRecord.lastSyncAt ? Number(syncRecord.lastSyncAt) : null;
            isSyncing = syncRecord.status === 'syncing';
          }
          syncStatus.update((prev) => ({
            ...prev,
            provider,
            lastSyncTime,
            isSyncing,
            error: null
          }));
        },
        error: (e) => {
          console.warn('SyncStatusStore liveQuery subscription error:', e);
        }
      });
    } catch (e) {
      console.warn('SyncStatusStore liveQuery initialization failed:', e);
    }
  }

  refreshSyncStatus().catch(() => {});

  return () => {
    if (liveSub) {
      try {
        liveSub.unsubscribe();
      } catch {
        // ignore
      }
      liveSub = null;
    }
  };
}

// Auto-initialize in live environment
if (typeof db !== 'undefined' && db.syncState) {
  initSyncStatusStore();
}

export async function refreshSyncStatus(): Promise<SyncStatusState> {
  try {
    let provider = 'none';
    if (typeof db !== 'undefined' && db.settings) {
      const providerSetting = await db.settings.get('sync_provider');
      provider = providerSetting?.value || 'none';
    }

    let lastSyncTime: number | null = null;
    let isSyncing = false;

    if (typeof db !== 'undefined' && db.syncState) {
      const syncRecord = await db.syncState.orderBy('id').last();
      if (syncRecord) {
        lastSyncTime = syncRecord.lastSyncAt ? Number(syncRecord.lastSyncAt) : null;
        isSyncing = syncRecord.status === 'syncing';
      }
    }

    const newState: SyncStatusState = {
      provider,
      lastSyncTime,
      isSyncing,
      error: null
    };

    syncStatus.set(newState);
    return newState;
  } catch (e: any) {
    const errState: SyncStatusState = {
      provider: 'none',
      lastSyncTime: null,
      isSyncing: false,
      error: e?.message || i18n.t('sync.loadStateFailed')
    };
    syncStatus.set(errState);
    return errState;
  }
}

export async function setSyncProvider(newProvider: string): Promise<SyncStatusState> {
  try {
    if (typeof db !== 'undefined' && db.settings) {
      await db.settings.put({ key: 'sync_provider', value: newProvider });
      if (newProvider === 'none') {
        if (db.syncState) {
          await db.syncState.clear();
          await db.syncState.put({ id: 1, provider: 'none', lastSyncAt: Date.now(), status: 'idle' });
        }
        const allSettings = await db.settings.toArray();
        for (const s of allSettings) {
          if (s.key.startsWith('initial_sync_completed_')) {
            await db.settings.delete(s.key);
          }
        }
        await clearTombstones();
      }
    }

    if (typeof SyncEngine !== 'undefined' && SyncEngine.resetAdapter) {
      SyncEngine.resetAdapter();
    }

    if (typeof SyncEngine !== 'undefined' && SyncEngine.updateSyncSchedule) {
      await SyncEngine.updateSyncSchedule(newProvider === 'none' ? 0 : undefined);
    }

    const state = await refreshSyncStatus();

    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('sync-resolved'));
    }

    return state;
  } catch (e: any) {
    const state = await refreshSyncStatus();
    return state;
  }
}

export async function triggerManualSync(): Promise<{ success: boolean; message?: string }> {
  syncStatus.update((s) => ({ ...s, isSyncing: true, error: null }));
  try {
    await SyncEngine.sync();
    await refreshSyncStatus();
    return { success: true, message: i18n.t('syncSuccess') };
  } catch (e: any) {
    syncStatus.update((s) => ({ ...s, isSyncing: false, error: e?.message || i18n.t('syncError') }));
    return { success: false, message: e?.message || i18n.t('syncError') };
  }
}
