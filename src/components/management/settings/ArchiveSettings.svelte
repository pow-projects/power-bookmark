<script lang="ts">
  import { onMount } from 'svelte';
  import db from '../../../lib/db';
  import { showToast } from '../../../lib/ui/toast-store';
  import ToggleSwitch from '../../shared/ToggleSwitch.svelte';
  import Icon from '../../shared/Icon.svelte';
  import Spinner from '../../shared/Spinner.svelte';

  let autoArchive = false;
  let compressArchive = true;
  let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let isSaving = false;
  let isLoaded = false;
  let isLoading = true;
  let loadError: string | null = null;

  async function loadSettings() {
    isLoading = true;
    loadError = null;
    try {
      if (typeof db !== 'undefined' && db.settings) {
        const autoSetting = await db.settings.get('auto_archive');
        autoArchive = autoSetting ? autoSetting.value === 'true' || autoSetting.value === true : false;

        const compressSetting = await db.settings.get('archive_compress');
        compressArchive = compressSetting?.value !== undefined ? (compressSetting.value === 'true' || compressSetting.value === true) : true;
      }
      isLoaded = true;
    } catch (e: any) {
      console.error('Failed to load archive settings:', e);
      loadError = e?.message || 'Failed to load archive settings';
    } finally {
      isLoading = false;
    }
  }

  onMount(async () => {
    await loadSettings();
  });

  async function saveSettings() {
    if (!isLoaded || isSaving) return;
    isSaving = true;
    try {
      await db.settings.put({ key: 'auto_archive', value: autoArchive });
      await db.settings.put({ key: 'archive_compress', value: compressArchive });
      showToast(i18n.t('archiveSettings.saved'), 'success');
    } catch (e: any) {
      showToast(i18n.t('archive.saveFailed'), 'error');
    } finally {
      isSaving = false;
    }
  }

  function handleToggleChange() {
    if (!isLoaded) return;
    if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(saveSettings, 300);
  }
</script>

<div class="settings-section" id="archive-settings-section">
  <div class="section-header">
    <div class="section-header-left">
      <div class="section-icon">
        <Icon name="archive" size={18} />
      </div>
      <div>
        <h3 class="section-title">{i18n.t('archiveSettings.title')}</h3>
      </div>
    </div>
    {#if isLoading}
      <div class="section-loading-indicator">
        <Spinner size={14} variant="default" />
        <span>{i18n.t('settings.loadingSettings')}</span>
      </div>
    {/if}
  </div>

  {#if loadError}
    <div class="section-error-banner">
      <Icon name="alert-triangle" size={16} />
      <span>{i18n.t('settings.loadFailed')}</span>
      <button type="button" class="btn-retry-sm" on:click={loadSettings}>
        <Icon name="refresh-cw" size={12} />
        <span>{i18n.t('settings.retry')}</span>
      </button>
    </div>
  {/if}

  <div class="settings-card">
    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-title">{i18n.t('archiveSettings.autoArchiveTitle')}</span>
        <span class="setting-description">{i18n.t('archiveSettings.autoArchiveDesc')}</span>
      </div>
      <ToggleSwitch id="auto-archive" bind:checked={autoArchive} disabled={!isLoaded} on:change={handleToggleChange} />
    </div>

    <div class="setting-divider"></div>

    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-title">{i18n.t('archiveSettings.compressTitle')}</span>
        <span class="setting-description">{i18n.t('archiveSettings.compressDesc')}</span>
      </div>
      <ToggleSwitch id="compress-archive" bind:checked={compressArchive} disabled={!isLoaded} on:change={handleToggleChange} />
    </div>
  </div>
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
  }

  .setting-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1.5rem;
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
    margin: 1rem 0;
  }

  .section-loading-indicator {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    font-family: var(--font-mono);
    color: var(--text-muted);
  }

  .section-error-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem 1rem;
    background: var(--bg-secondary);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-md);
    color: var(--color-danger);
    font-size: 0.8125rem;
  }

  .btn-retry-sm {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
    margin-left: auto;
    background: transparent;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.75rem;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .btn-retry-sm:hover {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
</style>
