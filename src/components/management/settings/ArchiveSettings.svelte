<script lang="ts">
  import { onMount } from 'svelte';
  import db from '../../../lib/db';
  import { showToast } from '../../../lib/ui/toast-store';
  import ToggleSwitch from '../../shared/ToggleSwitch.svelte';
  import Icon from '../../shared/Icon.svelte';

  let autoArchive = false;
  let compressArchive = true;
  let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let isSaving = false;

  onMount(async () => {
    try {
      if (typeof db !== 'undefined' && db.settings) {
        const autoSetting = await db.settings.get('auto_archive');
        autoArchive = autoSetting ? autoSetting.value === 'true' || autoSetting.value === true : false;

        const compressSetting = await db.settings.get('archive_compress');
        compressArchive = compressSetting?.value !== undefined ? (compressSetting.value === 'true' || compressSetting.value === true) : true;
      }
    } catch (e) {
      // ignore
    }
  });

  async function saveSettings() {
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
  </div>

  <div class="settings-card">
    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-title">{i18n.t('archiveSettings.autoArchiveTitle')}</span>
        <span class="setting-description">{i18n.t('archiveSettings.autoArchiveDesc')}</span>
      </div>
      <ToggleSwitch id="auto-archive" bind:checked={autoArchive} on:change={handleToggleChange} />
    </div>

    <div class="setting-divider"></div>

    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-title">{i18n.t('archiveSettings.compressTitle')}</span>
        <span class="setting-description">{i18n.t('archiveSettings.compressDesc')}</span>
      </div>
      <ToggleSwitch id="compress-archive" bind:checked={compressArchive} on:change={handleToggleChange} />
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
</style>
