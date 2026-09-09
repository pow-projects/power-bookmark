<script lang="ts">
  import { onMount } from 'svelte';
  import { syncStatus, setSyncProvider, triggerManualSync, refreshSyncStatus } from '../../../lib/sync/sync-status-store';
  import { SyncEngine } from '../../../lib/sync/sync-engine';
  import db from '../../../lib/db';
  import { showToast } from '../../../lib/ui/toast-store';
  import Icon from '../../shared/Icon.svelte';
  import Spinner from '../../shared/Spinner.svelte';
  import ToggleSwitch from '../../shared/ToggleSwitch.svelte';
  import { normalizeWebdavAuth, saveWebdavSettings } from '../../../lib/sync/webdav-settings';
  import SyncProviderOAuth from './SyncProviderOAuth.svelte';
  import SyncProviderWebDav from './SyncProviderWebDav.svelte';
  import SyncConflictLogsCard from './SyncConflictLogsCard.svelte';
  import CloudOrphanArchivesCard from './CloudOrphanArchivesCard.svelte';
  import { setArchiveSyncEnabled } from '../../../lib/archive/archive-cloud';

  let provider: 'google-drive' | 'onedrive' | 'dropbox' | 'webdav' | 'none' = 'none';
  
  // Google Drive settings
  let gdriveClientId = '';
  let gdriveClientSecret = '';
  let isGdriveConnected = false;

  // OneDrive settings
  let onedriveClientId = '';
  let onedriveClientSecret = '';
  let isOnedriveConnected = false;

  // Dropbox settings
  let dropboxClientId = '';
  let dropboxClientSecret = '';
  let isDropboxConnected = false;

  // WebDAV settings
  let webdavUrl = '';
  let webdavUsername = '';
  let webdavPassword = '';
  let isWebdavConnected = false;

  let syncArchiveToCloud = true;
  let syncInterval: number = 5;
  let isProcessing = false;

  // Track last attempted values (prevents duplicate and infinite retry popups)
  let lastAttemptedGdrive = '';
  let lastAttemptedOnedrive = '';
  let lastAttemptedDropbox = '';
  let lastAttemptedWebdav = '';

  // Authorized redirect URI info
  let redirectUri = '';

  // Conflict log list
  let conflictLogs: SyncConflictLogItem[] = [];

  onMount(async () => {
    try {
      if (typeof browser !== 'undefined' && browser.identity?.getRedirectURL) {
        redirectUri = browser.identity.getRedirectURL();
      } else if (typeof chrome !== 'undefined' && chrome.identity?.getRedirectURL) {
        redirectUri = chrome.identity.getRedirectURL();
      }
    } catch (e) {
      console.warn('Failed to get redirect URL:', e);
    }

    await loadSettings();
    // Record existing values on initial load
    lastAttemptedGdrive = `${gdriveClientId.trim()}|${gdriveClientSecret.trim()}`;
    lastAttemptedOnedrive = `${onedriveClientId.trim()}|${onedriveClientSecret.trim()}`;
    lastAttemptedDropbox = `${dropboxClientId.trim()}|${dropboxClientSecret.trim()}`;
    lastAttemptedWebdav = `${normalizeWebdavAuth(webdavUrl, webdavUsername, webdavPassword).url}|${webdavUsername}|${webdavPassword}`;

    const handleSyncUpdate = () => {
      loadSettings();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('sync-resolved', handleSyncUpdate);
      document.addEventListener('bookmarks-updated', handleSyncUpdate);
    }

    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('sync-resolved', handleSyncUpdate);
        document.removeEventListener('bookmarks-updated', handleSyncUpdate);
      }
    };
  });

  async function loadSettings() {
    try {
      if (typeof db !== 'undefined' && db.settings) {
        provider = (await db.settings.get('sync_provider'))?.value || 'none';
        
        // Load Google Drive info
        gdriveClientId = (await db.settings.get('gdrive_client_id'))?.value || '';
        gdriveClientSecret = (await db.settings.get('gdrive_client_secret'))?.value || '';
        isGdriveConnected = !!((await db.settings.get('gdrive_refresh_token'))?.value || (await db.settings.get('gdrive_access_token'))?.value);

        // Load OneDrive info
        onedriveClientId = (await db.settings.get('onedrive_client_id'))?.value || '';
        onedriveClientSecret = (await db.settings.get('onedrive_client_secret'))?.value || '';
        isOnedriveConnected = !!((await db.settings.get('onedrive_refresh_token'))?.value || (await db.settings.get('onedrive_access_token'))?.value);

        // Load Dropbox info
        dropboxClientId = (await db.settings.get('dropbox_client_id'))?.value || '';
        dropboxClientSecret = (await db.settings.get('dropbox_client_secret'))?.value || '';
        isDropboxConnected = !!((await db.settings.get('dropbox_refresh_token'))?.value || (await db.settings.get('dropbox_access_token'))?.value);

        // Load WebDAV info
        webdavUrl = (await db.settings.get('webdav_url'))?.value || '';
        webdavUsername = (await db.settings.get('webdav_username'))?.value || '';
        isWebdavConnected = (await db.settings.get('webdav_connected'))?.value ?? false;
        const hasWebdavPassword = !!(await db.settings.get('webdav_password'))?.value;
        webdavPassword = (isWebdavConnected && hasWebdavPassword) ? '****' : '';

        syncArchiveToCloud = (await db.settings.get('sync_archive_to_cloud'))?.value ?? true;

        const intervalSetting = await db.settings.get('sync_interval_minutes');
        if (intervalSetting && Number.isFinite(Number(intervalSetting.value))) {
          syncInterval = Number(intervalSetting.value);
        } else {
          syncInterval = 5;
        }

        // Load conflict logs
        conflictLogs = (await db.settings.get('sync_conflict_logs'))?.value || [];
      }
    } catch (e) {
      // ignore
    }
  }

  async function handleIntervalChange() {
    const minutes = Number(syncInterval);
    syncInterval = minutes;
    try {
      if (typeof db !== 'undefined' && db.settings) {
        await db.settings.put({ key: 'sync_interval_minutes', value: minutes });
      }
      if (typeof SyncEngine !== 'undefined' && SyncEngine.updateSyncSchedule) {
        await SyncEngine.updateSyncSchedule(minutes);
      }
      showToast(i18n.t('syncSettings.intervalSaved'), 'success');
    } catch (e: any) {
      console.error('Failed to update sync schedule:', e);
    }
  }

  async function handleProviderChange() {
    await setSyncProvider(provider);
    await loadSettings();
    SyncEngine.sync().catch((e) => console.error('Sync after connect failed:', e));
  }

  // Automatic connection verification on Google Drive input completion
  async function autoConnectGdrive() {
    const rawId = gdriveClientId.trim();
    const rawSecret = gdriveClientSecret.trim();
    const currentSig = `${rawId}|${rawSecret}`;

    // If only one is entered, save value to DB and wait to connect until both are entered
    if (rawId) {
      await db.settings.put({ key: 'gdrive_client_id', value: rawId });
    }
    if (rawSecret) {
      await db.settings.put({ key: 'gdrive_client_secret', value: rawSecret });
    }

    if (!rawId || !rawSecret || isProcessing || currentSig === lastAttemptedGdrive) return;
    lastAttemptedGdrive = currentSig;
    isProcessing = true;
    try {
      await db.settings.put({ key: 'gdrive_client_id', value: rawId });
      await db.settings.put({ key: 'gdrive_client_secret', value: rawSecret });
      SyncEngine.resetAdapter();

      const adapter = await SyncEngine.getAdapter();
      if (adapter) {
        await adapter.authenticate(true);
        await loadSettings();
        await refreshSyncStatus();
        SyncEngine.sync().catch((e) => console.error('Sync after connect failed:', e));
        showToast(i18n.t('syncSettings.gdriveConnected'), 'success');
      }
    } catch (e: any) {
      showToast(i18n.t('syncSettings.gdriveFailed', { error: e.message }), 'error');
    } finally {
      isProcessing = false;
    }
  }

  // Automatic connection verification on OneDrive input completion
  async function autoConnectOnedrive() {
    const rawId = onedriveClientId.trim();
    const rawSecret = onedriveClientSecret.trim();
    const currentSig = `${rawId}|${rawSecret}`;
    if (!rawId || isProcessing || currentSig === lastAttemptedOnedrive) return;
    lastAttemptedOnedrive = currentSig;
    isProcessing = true;
    try {
      await db.settings.put({ key: 'onedrive_client_id', value: rawId });
      if (rawSecret) {
        await db.settings.put({ key: 'onedrive_client_secret', value: rawSecret });
      } else {
        await db.settings.delete('onedrive_client_secret');
      }
      SyncEngine.resetAdapter();

      const adapter = await SyncEngine.getAdapter();
      if (adapter) {
        await adapter.authenticate(true);
        await loadSettings();
        await refreshSyncStatus();
        SyncEngine.sync().catch((e) => console.error('Sync after connect failed:', e));
        showToast(i18n.t('syncSettings.onedriveConnected'), 'success');
      }
    } catch (e: any) {
      showToast(i18n.t('syncSettings.onedriveFailed', { error: e.message }), 'error');
    } finally {
      isProcessing = false;
    }
  }

  // Automatic connection verification on Dropbox input completion
  async function autoConnectDropbox() {
    const rawId = dropboxClientId.trim();
    const rawSecret = dropboxClientSecret.trim();
    const currentSig = `${rawId}|${rawSecret}`;
    if (!rawId || isProcessing || currentSig === lastAttemptedDropbox) return;
    lastAttemptedDropbox = currentSig;
    isProcessing = true;
    try {
      await db.settings.put({ key: 'dropbox_client_id', value: rawId });
      if (rawSecret) {
        await db.settings.put({ key: 'dropbox_client_secret', value: rawSecret });
      } else {
        await db.settings.delete('dropbox_client_secret');
      }
      SyncEngine.resetAdapter();

      const adapter = await SyncEngine.getAdapter();
      if (adapter) {
        await adapter.authenticate(true);
        await loadSettings();
        await refreshSyncStatus();
        SyncEngine.sync().catch((e) => console.error('Sync after connect failed:', e));
        showToast(i18n.t('syncSettings.dropboxConnected'), 'success');
      }
    } catch (e: any) {
      showToast(i18n.t('syncSettings.dropboxFailed', { error: e.message }), 'error');
    } finally {
      isProcessing = false;
    }
  }

  // Automatic connection verification on WebDAV input completion
  async function autoConnectWebdav() {
    const normalized = normalizeWebdavAuth(webdavUrl, webdavUsername, webdavPassword);
    const cleanUrl = normalized.url;
    const currentSig = `${cleanUrl}|${normalized.username}|${webdavPassword}`;
    if (!cleanUrl || isProcessing || currentSig === lastAttemptedWebdav) return;

    // If no credentials in URL and username/password/stored password are all missing,
    // save URL only and hold connection attempt to prevent browser 401 auth popup
    const hasStoredPassword = !!(await db.settings.get('webdav_password'))?.value;
    const hasAnyAuth = !!(normalized.username || normalized.password || hasStoredPassword);
    if (!hasAnyAuth) {
      lastAttemptedWebdav = currentSig;
      await saveWebdavSettings({ url: cleanUrl });
      return;
    }

    lastAttemptedWebdav = currentSig;
    isProcessing = true;
    try {
      const passToSave = (normalized.password === '****') ? undefined : normalized.password;
      await saveWebdavSettings({ url: cleanUrl, username: normalized.username, password: passToSave });
      SyncEngine.resetAdapter();

      const adapter = await SyncEngine.getAdapter();
      if (adapter) {
        await adapter.authenticate(true);
        isWebdavConnected = true;
        await db.settings.put({ key: 'webdav_connected', value: true });
        showToast(i18n.t('syncSettings.webdavConnected'), 'success');
      }
      await loadSettings();
      lastAttemptedWebdav = `${normalizeWebdavAuth(webdavUrl, webdavUsername, webdavPassword).url}|${webdavUsername}|${webdavPassword}`;
      await refreshSyncStatus();
      SyncEngine.sync().catch((e) => console.error('Sync after connect failed:', e));
    } catch (e: any) {
      isWebdavConnected = false;
      await db.settings.put({ key: 'webdav_connected', value: false });
      showToast(i18n.t('syncSettings.webdavFailed', { error: e.message }), 'error');
    } finally {
      isProcessing = false;
    }
  }

  // Disconnect (reset settings and tokens)
  async function handleDisconnect() {
    if (!confirm(i18n.t('syncSettings.disconnectConfirm'))) return;
    isProcessing = true;
    try {
      const adapter = await SyncEngine.getAdapter();
      if (adapter) {
        await adapter.revoke();
      }
      await setSyncProvider('none');
      provider = 'none';

      gdriveClientId = '';
      gdriveClientSecret = '';
      onedriveClientId = '';
      onedriveClientSecret = '';
      dropboxClientId = '';
      dropboxClientSecret = '';
      webdavUrl = '';
      webdavUsername = '';
      webdavPassword = '';
      lastAttemptedGdrive = '';
      lastAttemptedOnedrive = '';
      lastAttemptedDropbox = '';
      lastAttemptedWebdav = '';
      isWebdavConnected = false;
      await db.settings.put({ key: 'webdav_connected', value: false });

      await loadSettings();
      showToast(i18n.t('syncSettings.disconnectedToast'), 'success');
    } catch (e: any) {
      showToast(i18n.t('syncSettings.disconnectFailed', { error: e.message }), 'error');
    } finally {
      isProcessing = false;
    }
  }

  // Trigger immediate sync
  async function handleSyncNow() {
    isProcessing = true;
    try {
      const res = await triggerManualSync();
      await loadSettings();
      if (res.success) {
        showToast(res.message || i18n.t('syncSettings.syncSuccess'), 'success');
      } else {
        showToast(res.message || i18n.t('syncSettings.syncFailed'), 'error');
      }
    } catch (e: any) {
      showToast(i18n.t('syncSettings.disconnectFailed', { error: e.message }), 'error');
    } finally {
      isProcessing = false;
    }
  }

  async function handleToggleArchiveSync() {
    try {
      await setArchiveSyncEnabled(syncArchiveToCloud);
    } catch (e: any) {
      console.error('Archive sync trigger after toggle failed:', e);
    }
  }

  // Restore cloud archives
  let isRestoringArchives = false;
  async function handleRestoreArchives() {
    if (isRestoringArchives) return;
    if (!confirm(i18n.t('syncSettings.restoreConfirm'))) return;
    isRestoringArchives = true;
    try {
      const res = await browser.runtime.sendMessage({ type: 'ARCHIVE_RESTORE' });
      if (res?.ok) {
        const msg = res.orphans > 0
          ? i18n.t('syncSettings.restoreSuccessWithOrphans', { count: res.restored, orphans: res.orphans })
          : i18n.t('syncSettings.restoreSuccess', { count: res.restored });
        showToast(msg, 'success');
      } else {
        showToast(i18n.t('syncSettings.restoreFailed', { error: res?.error || 'Unknown error' }), 'error');
      }
    } catch (e: any) {
      showToast(i18n.t('syncSettings.restoreFailed', { error: e?.message || e }), 'error');
    } finally {
      isRestoringArchives = false;
    }
  }

  async function clearConflictLogs() {
    if (!confirm(i18n.t('conflict.clearConfirm'))) return;
    await db.settings.delete('sync_conflict_logs');
    conflictLogs = [];
    showToast(i18n.t('conflict.cleared'), 'success');
  }

  $: lastSyncStr = $syncStatus.lastSyncTime
    ? new Date($syncStatus.lastSyncTime).toLocaleString()
    : i18n.t('syncWidget.never');

  $: currentConnected = 
    provider === 'google-drive' ? isGdriveConnected :
    provider === 'onedrive' ? isOnedriveConnected :
    provider === 'dropbox' ? isDropboxConnected :
    provider === 'webdav' ? isWebdavConnected : false;
</script>

<div class="settings-section" id="cloud-sync-section">
  <div class="section-header">
    <div class="section-header-left">
      <div class="section-icon">
        <Icon name="cloud" size={18} />
      </div>
      <div>
        <h3 class="section-title">{i18n.t('syncSettings.title')}</h3>
      </div>
    </div>
  </div>

  <!-- Card 1: Provider settings and connection status -->
  <div class="settings-card">
    <div class="form-group">
      <label for="sync-provider">{i18n.t('syncSettings.providerLabel')}</label>
      <select id="sync-provider" class="form-select" bind:value={provider} on:change={handleProviderChange}>
        <option value="none">{i18n.t('syncSettings.providerNone')}</option>
        <option value="google-drive">{i18n.t('syncSettings.providerGoogleDrive')}</option>
        <option value="onedrive">{i18n.t('syncSettings.providerOneDrive')}</option>
        <option value="dropbox">{i18n.t('syncSettings.providerDropbox')}</option>
        <option value="webdav">{i18n.t('syncSettings.providerWebDav')}</option>
      </select>
    </div>

    {#if provider !== 'none'}
      {#if provider === 'google-drive'}
        <SyncProviderOAuth
          provider="google-drive"
          bind:clientId={gdriveClientId}
          bind:clientSecret={gdriveClientSecret}
          {isProcessing}
          {redirectUri}
          on:connect={autoConnectGdrive}
        />
      {:else if provider === 'onedrive'}
        <SyncProviderOAuth
          provider="onedrive"
          bind:clientId={onedriveClientId}
          bind:clientSecret={onedriveClientSecret}
          {isProcessing}
          {redirectUri}
          on:connect={autoConnectOnedrive}
        />
      {:else if provider === 'dropbox'}
        <SyncProviderOAuth
          provider="dropbox"
          bind:clientId={dropboxClientId}
          bind:clientSecret={dropboxClientSecret}
          {isProcessing}
          {redirectUri}
          on:connect={autoConnectDropbox}
        />
      {:else if provider === 'webdav'}
        <SyncProviderWebDav
          bind:webdavUrl
          bind:webdavUsername
          bind:webdavPassword
          {isProcessing}
          on:connect={autoConnectWebdav}
        />
      {/if}

      <div class="setting-row">
        <div class="setting-info">
          <label for="sync-interval" class="setting-title">{i18n.t('syncSettings.intervalTitle')}</label>
          <span class="setting-description">{i18n.t('syncSettings.intervalDesc')}</span>
        </div>
        <select
          id="sync-interval"
          class="form-select schedule-select"
          bind:value={syncInterval}
          on:change={handleIntervalChange}
        >
          <option value={5}>{i18n.t('syncSettings.interval5m')}</option>
          <option value={15}>{i18n.t('syncSettings.interval15m')}</option>
          <option value={30}>{i18n.t('syncSettings.interval30m')}</option>
          <option value={60}>{i18n.t('syncSettings.interval60m')}</option>
          <option value={360}>{i18n.t('syncSettings.interval360m')}</option>
          <option value={1440}>{i18n.t('syncSettings.interval1440m')}</option>
          <option value={0}>{i18n.t('syncSettings.intervalManual')}</option>
        </select>
      </div>

      <!-- Common connection status summary and actions -->
      <div class="connection-status">
        <div class="status-item">
          <span class="status-label">{i18n.t('syncSettings.statusLabel')}</span>
          {#if $syncStatus.isSyncing}
            <span class="badge badge-syncing"><Spinner size={10} variant="small" /> {i18n.t('syncSettings.syncing')}</span>
          {:else if currentConnected}
            <span class="badge badge-success">{i18n.t('syncSettings.connected')}</span>
          {:else}
            <span class="badge badge-danger">{i18n.t('syncSettings.disconnected')}</span>
          {/if}
        </div>
        <div class="status-item">
          <span class="status-label">{i18n.t('syncSettings.lastSyncLabel')}</span>
          <span class="status-value">{lastSyncStr}</span>
        </div>
        {#if $syncStatus.isSyncing}
          <div class="syncing-indicator">
            <Spinner size={12} variant="small" /> {i18n.t('syncSettings.syncingMessage')}
          </div>
        {/if}

        {#if currentConnected}
          <div class="status-actions">
            <button type="button" class="btn btn-primary btn-sm" on:click={handleSyncNow} disabled={isProcessing || $syncStatus.isSyncing}>
              {#if isProcessing || $syncStatus.isSyncing}
                <Spinner size={12} variant="small" /> {i18n.t('syncSettings.syncing')}...
              {:else}
                <Icon name="refresh-cw" size={14} /> {i18n.t('syncSettings.syncNow')}
              {/if}
            </button>
            <button type="button" class="btn btn-danger btn-sm" on:click={handleDisconnect} disabled={isProcessing}>
              {i18n.t('syncSettings.disconnect')}
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  {#if provider !== 'none'}
    <!-- Card 2: Snapshot archive cloud sync and restore -->
    <div class="settings-card">
      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-title">{i18n.t('syncSettings.archiveSyncTitle')}</span>
          <span class="setting-description">{i18n.t('syncSettings.archiveSyncDesc')}</span>
        </div>
        <ToggleSwitch id="sync-archive" bind:checked={syncArchiveToCloud} on:change={handleToggleArchiveSync} ariaLabel={i18n.t('syncSettings.archiveSyncTitle')} />
      </div>

      <div class="setting-divider"></div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-title">{i18n.t('syncSettings.restoreTitle')}</span>
          <span class="setting-description">{i18n.t('syncSettings.restoreDesc')}</span>
        </div>
        <button type="button" class="btn btn-secondary btn-sm" on:click={handleRestoreArchives} disabled={isRestoringArchives}>
          <Icon name="download" size={14} />
          <span>{isRestoringArchives ? i18n.t('syncSettings.restoring') : i18n.t('syncSettings.restoreButton')}</span>
        </button>
      </div>
    </div>

    <!-- Card 2.5: Cloud Orphan Archive Cleanup -->
    <CloudOrphanArchivesCard
      {provider}
      isSyncing={$syncStatus.isSyncing}
      syncError={$syncStatus.error}
    />

    <!-- Card 3: Sync conflict log history -->
    <SyncConflictLogsCard
      {conflictLogs}
      on:clear={clearConflictLogs}
    />
  {/if}
</div>

<style>
  .settings-section {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .section-header-left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .section-icon {
    color: var(--color-primary);
    background: var(--color-primary-light);
    padding: 0.5rem;
    border-radius: var(--radius-md);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .section-title {
    margin: 0;
    font-family: var(--font-accent);
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .settings-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    padding: 1.25rem 1.5rem;
    box-shadow: var(--shadow-sm);
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .form-group label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .form-select {
    width: 100%;
    box-sizing: border-box;
    background-color: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: 0.625rem 0.875rem;
    font-size: 0.875rem;
    font-family: var(--font-primary);
    outline: none;
    transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  }

  .form-select:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px var(--color-primary-light);
  }

  .connection-status {
    background-color: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: 0.875rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    font-size: 0.8125rem;
  }

  .status-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .status-label {
    font-weight: 600;
    color: var(--text-secondary);
    font-size: 0.8125rem;
  }

  .status-value {
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 0.8125rem;
  }

  .syncing-indicator {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--color-primary);
    font-size: 0.8125rem;
    font-weight: 600;
    padding-top: 0.375rem;
    border-top: 1px dashed var(--border-color);
  }

  .badge {
    font-family: var(--font-mono);
    font-size: var(--badge-font-size, 0.625rem);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border-radius: var(--badge-radius, var(--radius-sm));
    padding: var(--badge-padding, 0.125rem 0.375rem);
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }

  .badge-success {
    background-color: var(--color-success);
    color: var(--color-on-primary);
  }

  .badge-danger {
    background-color: var(--color-danger);
    color: var(--color-on-primary);
  }

  .badge-syncing {
    background-color: var(--color-primary);
    color: var(--color-on-primary);
  }

  .status-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.25rem;
    padding-top: 0.625rem;
    border-top: 1px solid var(--border-color);
  }

  .setting-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1.5rem;
  }

  .schedule-select {
    width: auto;
    min-width: 180px;
  }

  .setting-info {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .setting-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .setting-description {
    font-size: 0.75rem;
    color: var(--text-secondary);
    line-height: 1.4;
  }

  .setting-divider {
    height: 1px;
    background-color: var(--border-color);
    margin: 0.25rem 0;
  }

  .btn-sm {
    font-size: 0.8125rem;
    padding: 0.375rem 0.75rem;
    white-space: nowrap;
  }
</style>
