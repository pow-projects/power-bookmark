<script lang="ts">
  import Icon from '../shared/Icon.svelte';
  import ToggleSwitch from '../shared/ToggleSwitch.svelte';
  import type { SyncStatusState } from '../../lib/sync/sync-status-store';
  import { formatDateTime } from '../../lib/ui/date-formatter';

  export let syncState: SyncStatusState;
  export let aiProvider: string = 'none';
  export let autoSummarize: boolean = false;
  export let autoTags: boolean = true;
  export let autoFolder: boolean = true;
  export let aiConfigured: boolean = true;

  export let onToggleSummarize: (checked: boolean) => void;
  export let onToggleTags: (checked: boolean) => void;
  export let onToggleFolder: (checked: boolean) => void;
  export let onOpenAiSettings: () => void = () => {};
  export let onOpenSyncSettings: () => void = () => {};

  $: hasAiProvider = !!aiProvider && aiProvider !== 'none';

  function formatSyncTime(ts: number | null): string {
    if (!ts) return '';
    return formatDateTime(ts);
  }

  function getProviderDisplayName(provider: string): string {
    switch (provider) {
      case 'google-drive':
      case 'google_drive': return 'Google Drive';
      case 'onedrive': return 'OneDrive';
      case 'dropbox': return 'Dropbox';
      case 'webdav': return 'WebDAV';
      default: return provider;
    }
  }

  $: hasProvider = !!syncState.provider && syncState.provider !== 'none';
  $: isConnected = hasProvider && (syncState.isConnected ?? false) && !syncState.error;
  $: isError = hasProvider && (!isConnected || !!syncState.error);
  $: providerName = getProviderDisplayName(syncState.provider);

  $: syncTooltip = syncState.isSyncing
    ? i18n.t('popup.sync.tooltipSyncing')
    : isConnected
      ? i18n.t('popup.sync.tooltipConnected', { provider: providerName })
      : isError
        ? i18n.t('popup.sync.tooltipDisconnectedProvider', { provider: providerName })
        : i18n.t('popup.sync.tooltipDisconnected');
</script>

<div class="options-container">
  <!-- Cloud Sync Status Card -->
  <section class="card-section sync-section" aria-label={i18n.t('popup.sync.title')}>
    <div class="section-header">
      <button
        type="button"
        class="header-title header-title-btn"
        on:click={onOpenSyncSettings}
        title={i18n.t('popup.sync.goToSettings')}
        aria-label={i18n.t('popup.sync.goToSettings')}
      >
        <span class="icon-swap" aria-hidden="true">
          <span class="icon-default"><Icon name="cloud" size={14} /></span>
          <span class="icon-hover"><Icon name="settings" size={14} /></span>
        </span>
        <span>{i18n.t('popup.sync.title')}</span>
      </button>
      {#if isError && !syncState.isSyncing}
        <button
          type="button"
          class="sync-badge is-error btn-badge"
          title={syncTooltip}
          on:click={onOpenSyncSettings}
          aria-label={i18n.t('popup.sync.disconnectedProvider', { provider: providerName })}
        >
          <Icon name="cloud-off" size={11} />
          <span>{i18n.t('popup.sync.disconnectedProvider', { provider: providerName })}</span>
        </button>
      {:else}
        <div
          class="sync-badge {syncState.isSyncing ? 'is-syncing' : isConnected ? 'is-connected' : 'is-disconnected'}"
          title={syncTooltip}
          role="status"
        >
          {#if syncState.isSyncing}
            <span class="spin"><Icon name="refresh-cw" size={11} /></span>
            <span>{i18n.t('popup.sync.syncing')}</span>
          {:else if isConnected}
            <Icon name="check-circle" size={11} />
            <span>{i18n.t('popup.sync.connected', { provider: providerName })}</span>
          {:else}
            <Icon name="cloud-off" size={11} />
            <span>{i18n.t('popup.sync.disconnected')}</span>
          {/if}
        </div>
      {/if}
    </div>
    {#if isConnected && syncState.lastSyncTime}
      <div class="sync-meta" title={syncTooltip}>
        <span class="last-sync-text">
          {i18n.t('popup.sync.lastSync', { time: formatSyncTime(syncState.lastSyncTime) })}
        </span>
      </div>
    {/if}
  </section>

  <!-- AI Automation Options -->
  <section class="card-section ai-options-section" aria-label={i18n.t('popup.aiOptions.title')}>
    <div class="section-header">
      <button
        type="button"
        class="header-title header-title-btn"
        on:click={onOpenAiSettings}
        title={i18n.t('popup.aiOptions.goToSettings')}
        aria-label={i18n.t('popup.aiOptions.goToSettings')}
      >
        <span class="icon-swap" aria-hidden="true">
          <span class="icon-default"><Icon name="sparkles" size={14} /></span>
          <span class="icon-hover"><Icon name="settings" size={14} /></span>
        </span>
        <span>{i18n.t('popup.aiOptions.title')}</span>
      </button>
      {#if !hasAiProvider}
        <span
          class="not-configured-badge"
          title={i18n.t('popup.aiOptions.notConfiguredTooltip')}
        >
          <Icon name="alert-circle" size={11} />
          <span>{i18n.t('popup.aiOptions.noProvider')}</span>
        </span>
      {:else if !aiConfigured}
        <span
          class="not-configured-badge"
          title={i18n.t('popup.aiOptions.notConfiguredTooltip')}
        >
          <Icon name="alert-circle" size={11} />
          <span>{i18n.t('common.error')}</span>
        </span>
      {/if}
    </div>

    <div class="ai-content-area">
      <div class="toggles-list" class:is-disabled={!hasAiProvider}>
        <!-- Auto Summarize -->
        <div
          class="toggle-row"
          class:row-disabled={!hasAiProvider}
          title={hasAiProvider ? i18n.t('popup.aiOptions.autoSummarizeTooltip') : i18n.t('popup.aiOptions.noProvider')}
        >
          <div class="toggle-info">
            <span class="toggle-name">{i18n.t('popup.aiOptions.autoSummarize')}</span>
            <span class="info-icon" aria-hidden="true">
              <Icon name="help-circle" size={12} />
            </span>
          </div>
          <ToggleSwitch
            id="toggle-auto-summarize"
            checked={autoSummarize}
            disabled={!hasAiProvider}
            ariaLabel={i18n.t('popup.aiOptions.autoSummarize')}
            on:change={(e) => onToggleSummarize(e.detail)}
          />
        </div>

        <!-- Auto Tags -->
        <div
          class="toggle-row"
          class:row-disabled={!hasAiProvider}
          title={hasAiProvider ? i18n.t('popup.aiOptions.autoTagsTooltip') : i18n.t('popup.aiOptions.noProvider')}
        >
          <div class="toggle-info">
            <span class="toggle-name">{i18n.t('popup.aiOptions.autoTags')}</span>
            <span class="info-icon" aria-hidden="true">
              <Icon name="help-circle" size={12} />
            </span>
          </div>
          <ToggleSwitch
            id="toggle-auto-tags"
            checked={autoTags}
            disabled={!hasAiProvider}
            ariaLabel={i18n.t('popup.aiOptions.autoTags')}
            on:change={(e) => onToggleTags(e.detail)}
          />
        </div>

        <!-- Auto Folder -->
        <div
          class="toggle-row"
          class:row-disabled={!hasAiProvider}
          title={hasAiProvider ? i18n.t('popup.aiOptions.autoFolderTooltip') : i18n.t('popup.aiOptions.noProvider')}
        >
          <div class="toggle-info">
            <span class="toggle-name">{i18n.t('popup.aiOptions.autoFolder')}</span>
            <span class="info-icon" aria-hidden="true">
              <Icon name="help-circle" size={12} />
            </span>
          </div>
          <ToggleSwitch
            id="toggle-auto-folder"
            checked={autoFolder}
            disabled={!hasAiProvider}
            ariaLabel={i18n.t('popup.aiOptions.autoFolder')}
            on:change={(e) => onToggleFolder(e.detail)}
          />
        </div>
      </div>

      {#if !hasAiProvider}
        <div class="no-provider-overlay">
          <button
            type="button"
            class="btn-open-ai-settings"
            on:click={onOpenAiSettings}
            title={i18n.t('popup.aiOptions.configureProvider')}
          >
            <span class="btn-icon">
              <Icon name="settings" size={15} />
            </span>
            <span class="btn-label">{i18n.t('popup.aiOptions.configureProvider')}</span>
            <span class="btn-arrow">
              <Icon name="chevron-right" size={13} />
            </span>
          </button>
        </div>
      {/if}
    </div>
  </section>
</div>

<style>
  .options-container {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }

  .card-section {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: 0.75rem 0.875rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .header-title {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-secondary);
    font-family: var(--font-primary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  button.header-title-btn {
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    cursor: pointer;
    text-align: left;
    transition: color var(--transition-fast);
  }

  button.header-title-btn:hover,
  button.header-title-btn:focus-visible {
    color: var(--text-primary);
  }

  button.header-title-btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }

  .icon-swap {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    overflow: hidden;
    flex-shrink: 0;
  }

  .icon-swap .icon-default,
  .icon-swap .icon-hover {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.22s ease;
  }

  .icon-swap .icon-default {
    transform: translateY(0);
    opacity: 1;
  }

  .icon-swap .icon-hover {
    transform: translateY(100%);
    opacity: 0;
    color: var(--color-primary);
  }

  button.header-title-btn:hover .icon-swap .icon-default,
  button.header-title-btn:focus-visible .icon-swap .icon-default {
    transform: translateY(-100%);
    opacity: 0;
  }

  button.header-title-btn:hover .icon-swap .icon-hover,
  button.header-title-btn:focus-visible .icon-swap .icon-hover {
    transform: translateY(0);
    opacity: 1;
  }

  /* Cloud Sync Badge */
  .sync-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-family: var(--font-mono);
    font-size: var(--badge-font-size);
    padding: 0.15rem 0.45rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-color);
    cursor: help;
    transition: all var(--transition-fast);
  }
  .sync-badge:focus-visible {
    outline: 2px solid var(--color-primary);
  }

  .sync-badge.is-connected {
    color: var(--color-success);
    border-color: color-mix(in srgb, var(--color-success) 40%, transparent);
    background: color-mix(in srgb, var(--color-success) 8%, transparent);
  }

  .sync-badge.is-disconnected {
    color: var(--text-muted);
    border-color: var(--border-color);
    background: var(--bg-tertiary);
  }

  .sync-badge.is-error {
    color: var(--color-danger);
    border-color: color-mix(in srgb, var(--color-danger) 40%, transparent);
    background: color-mix(in srgb, var(--color-danger) 8%, transparent);
    cursor: pointer;
  }
  .sync-badge.is-error:hover {
    background: color-mix(in srgb, var(--color-danger) 16%, transparent);
    border-color: var(--color-danger);
  }
  button.btn-badge {
    font: inherit;
    font-family: var(--font-mono);
    font-size: var(--badge-font-size);
    line-height: inherit;
    margin: 0;
  }

  .sync-badge.is-syncing {
    color: var(--color-warning);
    border-color: color-mix(in srgb, var(--color-warning) 40%, transparent);
    background: color-mix(in srgb, var(--color-warning) 8%, transparent);
  }

  .sync-badge .spin {
    display: inline-flex;
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .sync-meta {
    font-family: var(--font-mono);
    font-size: 0.65rem;
    color: var(--text-muted);
    text-align: right;
  }

  /* AI Configuration warning badge */
  .not-configured-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-family: var(--font-mono);
    font-size: var(--badge-font-size);
    padding: 0.1rem 0.35rem;
    border-radius: var(--radius-sm);
    color: var(--color-warning);
    background: color-mix(in srgb, var(--color-warning) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-warning) 30%, transparent);
    cursor: help;
  }

  /* AI Content Area with potential Overlay */
  .ai-content-area {
    position: relative;
  }

  /* Toggle rows */
  .toggles-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    transition: opacity var(--transition-fast), filter var(--transition-fast);
  }

  .toggles-list.is-disabled {
    opacity: 0.28;
    pointer-events: none;
    user-select: none;
    filter: grayscale(0.85);
  }

  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.3rem 0;
    border-bottom: 1px dashed color-mix(in srgb, var(--border-color) 60%, transparent);
    cursor: help;
  }
  .toggle-row:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }
  .toggle-row:focus-visible {
    outline: 2px solid var(--color-primary);
    border-radius: var(--radius-sm);
  }
  .toggle-row.row-disabled {
    cursor: not-allowed;
  }

  .toggle-info {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .toggle-name {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-primary);
  }

  .info-icon {
    color: var(--text-muted);
    display: inline-flex;
    align-items: center;
  }

  /* Center Overlay for Missing AI Provider */
  .no-provider-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2;
    padding: 0.5rem;
    background: color-mix(in srgb, var(--bg-secondary) 75%, transparent);
    backdrop-filter: blur(1px);
    border-radius: var(--radius-sm);
  }

  .btn-open-ai-settings {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    padding: 0.45rem 0.85rem;
    background: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    font-family: var(--font-primary);
    font-size: 0.775rem;
    font-weight: 500;
    cursor: pointer;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
    transition: all var(--transition-fast);
  }

  .btn-open-ai-settings:hover {
    background: color-mix(in srgb, var(--color-primary) 8%, var(--bg-primary));
    border-color: color-mix(in srgb, var(--color-primary) 50%, var(--border-color));
    color: var(--color-primary);
    transform: translateY(-1px);
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.12);
  }

  .btn-open-ai-settings:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .btn-icon {
    display: inline-flex;
    align-items: center;
    color: var(--color-primary);
  }

  .btn-label {
    letter-spacing: -0.01em;
  }

  .btn-arrow {
    display: inline-flex;
    align-items: center;
    color: var(--text-muted);
    transition: transform var(--transition-fast);
  }

  .btn-open-ai-settings:hover .btn-arrow {
    transform: translateX(2px);
    color: var(--color-primary);
  }
</style>
