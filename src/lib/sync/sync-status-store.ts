import { writable, derived, get, type Readable } from 'svelte/store';
import { liveQuery, type Subscription } from 'dexie';
import db from '../db';
import { SyncEngine } from './sync-engine';
import { clearTombstones, markSyncDisconnected } from './tombstones';
import { SYNC_COOLDOWN_MS } from './sync-config';

export interface SyncStatusState {
  provider: string;
  lastSyncTime: number | null;
  isSyncing: boolean;
  isConnected: boolean;
  error: string | null;
  isCoolingDown: boolean;
}

const initialState: SyncStatusState = {
  provider: 'none',
  lastSyncTime: null,
  isSyncing: false,
  isConnected: false,
  error: null,
  isCoolingDown: false
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

async function checkProviderConnected(provider: string): Promise<boolean> {
  if (typeof db === 'undefined' || !db.settings || !provider || provider === 'none') {
    return false;
  }
  try {
    if (provider === 'webdav') {
      const setting = await db.settings.get('webdav_connected');
      return setting?.value === true;
    }
    if (provider === 'google-drive' || provider === 'google_drive') {
      const token = (await db.settings.get('gdrive_refresh_token'))?.value || (await db.settings.get('gdrive_access_token'))?.value;
      return !!token;
    }
    if (provider === 'onedrive') {
      const token = (await db.settings.get('onedrive_refresh_token'))?.value || (await db.settings.get('onedrive_access_token'))?.value;
      return !!token;
    }
    if (provider === 'dropbox') {
      const token = (await db.settings.get('dropbox_refresh_token'))?.value || (await db.settings.get('dropbox_access_token'))?.value;
      return !!token;
    }
  } catch {
    return false;
  }
  return false;
}

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
        let isConnected = false;
        try {
          if (db.syncState) {
            syncRecord = await db.syncState.orderBy('id').last();
          }
          if (db.settings) {
            providerSetting = await db.settings.get('sync_provider');
            const prov = providerSetting?.value || 'none';
            isConnected = await checkProviderConnected(prov);
          }
        } catch {
          // ignore transient DB errors during close or upgrade
        }
        return { syncRecord, providerSetting, isConnected };
      }).subscribe({
        next: ({ syncRecord, providerSetting, isConnected }) => {
          const provider = providerSetting?.value || 'none';
          let lastSyncTime: number | null = null;
          let isSyncing = false;
          let isError = false;
          if (syncRecord) {
            lastSyncTime = syncRecord.lastSyncAt ? Number(syncRecord.lastSyncAt) : null;
            isSyncing = syncRecord.status === 'syncing';
            isError = syncRecord.status === 'error';
          }
          syncStatus.update((prev) => ({
            ...prev,
            provider,
            lastSyncTime,
            isSyncing,
            isConnected,
            error: isError ? (prev.error || 'Sync error') : null
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
    let isConnected = false;
    if (typeof db !== 'undefined' && db.settings) {
      const providerSetting = await db.settings.get('sync_provider');
      provider = providerSetting?.value || 'none';
      isConnected = await checkProviderConnected(provider);
    }

    let lastSyncTime: number | null = null;
    let isSyncing = false;
    let isError = false;

    if (typeof db !== 'undefined' && db.syncState) {
      const syncRecord = await db.syncState.orderBy('id').last();
      if (syncRecord) {
        lastSyncTime = syncRecord.lastSyncAt ? Number(syncRecord.lastSyncAt) : null;
        isSyncing = syncRecord.status === 'syncing';
        isError = syncRecord.status === 'error';
      }
    }

    let isCoolingDown = false;
    syncStatus.update((prev) => {
      isCoolingDown = prev.isCoolingDown ?? false;
      return {
        ...prev,
        provider,
        lastSyncTime,
        isSyncing,
        isConnected,
        error: isError ? 'Sync error' : null
      };
    });

    const newState: SyncStatusState = {
      provider,
      lastSyncTime,
      isSyncing,
      isConnected,
      error: isError ? 'Sync error' : null,
      isCoolingDown
    };

    return newState;
  } catch (e: any) {
    const errState: SyncStatusState = {
      provider: 'none',
      lastSyncTime: null,
      isSyncing: false,
      isConnected: false,
      error: e?.message || i18n.t('sync.loadStateFailed'),
      isCoolingDown: false
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
        // Record the unlink time BEFORE clearing tombstones: deletions performed while unlinked are
        // confirmed deletion intent and must survive reconnect (see tombstones.markSyncDisconnected —
        // the marker is a settings key because sync-state rows get overwritten by every sync attempt).
        await markSyncDisconnected();
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

let lastManualSyncTime = 0;
let cooldownTimer: any = null;
let testCooldownMs: number | null = null;

export function getSyncCooldownMs(): number {
  return testCooldownMs !== null ? testCooldownMs : SYNC_COOLDOWN_MS;
}

export function _setSyncCooldownMsForTest(ms: number | null): void {
  testCooldownMs = ms;
}

export function _resetSyncCooldownForTest(): void {
  lastManualSyncTime = 0;
  if (cooldownTimer) {
    clearTimeout(cooldownTimer);
    cooldownTimer = null;
  }
  syncStatus.update((s) => ({ ...s, isCoolingDown: false }));
}

export async function triggerManualSync(): Promise<{ success: boolean; message?: string; throttled?: boolean }> {
  const cooldownMs = getSyncCooldownMs();
  const now = Date.now();

  if (now - lastManualSyncTime < cooldownMs) {
    console.log(`[Sync] Manual sync cooldown active (${now - lastManualSyncTime}ms < ${cooldownMs}ms), skipping.`);
    return { success: false, throttled: true, message: i18n.t('syncCooldown') };
  }

  const currentStatus = get(syncStatus);
  if (currentStatus.isSyncing) {
    return { success: false, throttled: true, message: i18n.t('syncSettings.syncing') };
  }

  lastManualSyncTime = Date.now();
  if (cooldownTimer) {
    clearTimeout(cooldownTimer);
    cooldownTimer = null;
  }

  syncStatus.update((s) => ({ ...s, isSyncing: true, isCoolingDown: false, error: null }));
  let syncSuccess = false;
  let syncError: string | null = null;

  try {
    await SyncEngine.sync();
    await refreshSyncStatus();
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('sync-resolved'));
      document.dispatchEvent(new CustomEvent('bookmarks-updated'));
    }
    syncSuccess = true;
  } catch (e: any) {
    syncError = e?.message || i18n.t('syncError');
  } finally {
    lastManualSyncTime = Date.now();
    const effectiveCooldown = getSyncCooldownMs();
    if (effectiveCooldown > 0) {
      syncStatus.update((s) => ({
        ...s,
        isSyncing: false,
        isCoolingDown: true,
        error: syncError ? (s.error || syncError) : s.error
      }));
      cooldownTimer = setTimeout(() => {
        syncStatus.update((s) => ({ ...s, isCoolingDown: false }));
        cooldownTimer = null;
      }, effectiveCooldown);
    } else {
      syncStatus.update((s) => ({
        ...s,
        isSyncing: false,
        isCoolingDown: false,
        error: syncError ? (s.error || syncError) : s.error
      }));
    }
  }

  if (syncSuccess) {
    return { success: true, message: i18n.t('syncSuccess') };
  } else {
    return { success: false, message: syncError || i18n.t('syncError') };
  }
}
