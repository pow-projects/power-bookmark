<script lang="ts">
  import { onMount } from 'svelte';
  import { syncStatus, refreshSyncStatus, triggerManualSync } from '../../lib/sync/sync-status-store';
  import { showToast } from '../../lib/ui/toast-store';
  import Icon from '../shared/Icon.svelte';

  onMount(() => {
    refreshSyncStatus();
  });

  async function handleSync() {
    if ($syncStatus.isSyncing) return;
    const res = await triggerManualSync();
    if (res.success) {
      showToast(res.message || i18n.t('syncSuccess'), 'success');
      document.dispatchEvent(new CustomEvent('sync-resolved'));
    } else {
      showToast(res.message || i18n.t('syncError'), 'error');
    }
  }

  function formatTime(timestamp: number | null): string {
    if (!timestamp) return i18n.t('sync.noRecord');
    const date = new Date(timestamp);
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  }

  function getProviderLabel(provider: string): string {
    switch (provider) {
      case 'google-drive': return 'Google Drive';
      case 'onedrive': return 'OneDrive';
      case 'dropbox': return 'Dropbox';
      case 'webdav': return 'WebDAV';
      default: return i18n.t('sync.notConfigured');
    }
  }
</script>

{#if $syncStatus.provider !== 'none'}
  <div class="sync-widget">
    <div class="sync-info" title="{i18n.t('sync.lastSyncTime')}: {formatTime($syncStatus.lastSyncTime)}">
      <span class="sync-provider">{getProviderLabel($syncStatus.provider)}</span>
      <span class="sync-time">{formatTime($syncStatus.lastSyncTime)}</span>
    </div>
    <button
      type="button"
      class="btn-icon sync-btn"
      class:syncing={$syncStatus.isSyncing}
      on:click={handleSync}
      disabled={$syncStatus.isSyncing}
      aria-label={i18n.t('sync.syncNow')}
      title={i18n.t('sync.syncNow')}
    >
      <Icon name="refresh-cw" size={14} />
    </button>
  </div>
{/if}

<style>
  .sync-widget {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.625rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    font-size: 0.75rem;
  }

  .sync-info {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-family: var(--font-mono);
  }

  .sync-provider {
    font-weight: 600;
    color: var(--text-primary);
  }

  .sync-time {
    color: var(--text-muted);
  }

  .sync-btn {
    padding: 2px;
    color: var(--text-secondary);
  }

  .sync-btn:hover:not(:disabled) {
    color: var(--color-primary);
  }

  .syncing {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
</style>
