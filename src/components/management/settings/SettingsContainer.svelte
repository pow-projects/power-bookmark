<script lang="ts">
  import { onMount, tick } from 'svelte';
  import ArchiveSettings from './ArchiveSettings.svelte';
  import SyncSettings from './SyncSettings.svelte';
  import AiSettings from './AiSettings.svelte';
  import Icon from '../../shared/Icon.svelte';

  export let initialSection: 'archive' | 'sync' | 'ai' = 'archive';

  let activeSection: 'archive' | 'sync' | 'ai' = initialSection;
  let autoSaveStatus: 'idle' | 'saving' | 'saved' = 'idle';
  let autoSaveResetTimer: ReturnType<typeof setTimeout> | null = null;

  onMount(async () => {
    if (initialSection && initialSection !== 'archive') {
      await tick();
      scrollToSection(initialSection);
    }
  });

  export function triggerAutoSaveStatus(status: 'saving' | 'saved' | 'idle') {
    autoSaveStatus = status;
    if (status === 'saved') {
      if (autoSaveResetTimer) clearTimeout(autoSaveResetTimer);
      autoSaveResetTimer = setTimeout(() => {
        autoSaveStatus = 'idle';
      }, 2500);
    }
  }

  function scrollToSection(sec: 'archive' | 'sync' | 'ai') {
    activeSection = sec;
    const targetId = sec === 'archive'
      ? 'archive-settings-section'
      : sec === 'sync'
      ? 'cloud-sync-section'
      : 'ai-settings-section';

    const el = document.getElementById(targetId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    const url = new URL(window.location.href);
    url.searchParams.set('tab', 'settings');
    url.searchParams.set('section', sec);
    window.history.replaceState({}, '', url.toString());
  }
</script>

<div class="settings-container">
  <div class="settings-header-row">
    <div class="settings-nav">
      <button
        type="button"
        class="nav-tab {activeSection === 'archive' ? 'active' : ''}"
        on:click={() => scrollToSection('archive')}
      >
        <Icon name="archive" size={16} />
        <span>{i18n.t('settings.nav.archive')}</span>
      </button>

      <button
        type="button"
        class="nav-tab {activeSection === 'sync' ? 'active' : ''}"
        on:click={() => scrollToSection('sync')}
      >
        <Icon name="cloud" size={16} />
        <span>{i18n.t('settings.nav.sync')}</span>
      </button>

      <button
        type="button"
        class="nav-tab {activeSection === 'ai' ? 'active' : ''}"
        on:click={() => scrollToSection('ai')}
      >
        <Icon name="sparkles" size={16} />
        <span>{i18n.t('settings.nav.ai')}</span>
      </button>
    </div>

    <div class="autosave-indicator {autoSaveStatus}">
      {#if autoSaveStatus === 'saving'}
        <span>{i18n.t('common.loading')}</span>
      {:else if autoSaveStatus === 'saved'}
        <Icon name="check" size={14} />
        <span>{i18n.t('settings.autoSaved')}</span>
      {/if}
    </div>
  </div>

  <div class="settings-content">
    <ArchiveSettings />
    <div class="section-divider"></div>
    <SyncSettings />
    <div class="section-divider"></div>
    <AiSettings />
  </div>
</div>

<style>
  .settings-container {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    width: 100%;
    max-width: 840px;
    margin: 0 auto;
  }

  .settings-header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border-color);
    padding-bottom: 0.5rem;
    position: sticky;
    top: 0;
    background: var(--bg-primary);
    z-index: 10;
  }

  .settings-nav {
    display: flex;
    gap: 0.5rem;
    overflow-x: auto;
  }

  .autosave-indicator {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .autosave-indicator.saved {
    color: var(--color-success);
  }

  .autosave-indicator.saving {
    color: var(--color-primary);
  }

  .nav-tab {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    font-family: var(--font-primary);
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text-secondary);
    background: transparent;
    border: none;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }

  .nav-tab:hover {
    color: var(--text-primary);
    background: var(--bg-tertiary);
  }

  .nav-tab.active {
    color: var(--color-primary);
    background: var(--color-primary-light);
  }

  .settings-content {
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .section-divider {
    height: 1px;
    background-color: var(--border-color);
    margin: 0.5rem 0;
  }
</style>
