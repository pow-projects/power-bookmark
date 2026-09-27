<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import Icon from '../../shared/Icon.svelte';
  import Spinner from '../../shared/Spinner.svelte';
  import { getAiSettings } from '../../../lib/ai/ai-summarizer';

  export let selectedCount: number = 0;
  export let totalCount: number = 0;
  export let allSelected: boolean = false;
  export let isScanning: boolean = false;
  export let scanProgress: number = 0;
  export let scanTotal: number = 0;
  export let isAiRunning: boolean = false;
  export let isAiCategorizing: boolean = false;
  export let isAiSummarizing: boolean = false;
  export let deadSelectedCount: number = 0;
  export let isDeleting: boolean = false;

  export let autoSummarize: boolean = false;
  export let autoTags: boolean = true;
  export let autoFolder: boolean = true;

  let isDropdownOpen: boolean = false;
  let dropdownContainer: HTMLElement | null = null;
  let toggleBtn: HTMLButtonElement | null = null;
  let isAiCancelHovered = false;

  $: aiActive = isAiRunning || isAiCategorizing || isAiSummarizing;
  $: if (!aiActive) isAiCancelHovered = false;
  $: hasAnyAiOption = autoSummarize || autoTags || autoFolder;

  const dispatch = createEventDispatcher<{
    toggleSelectAll: void;
    clearSelection: void;
    runAi: { autoSummarize: boolean; autoTags: boolean; autoFolder: boolean };
    categorizeAi: void;
    summarizeAi: void;
    cancelAi: void;
    reviewLinks: void;
    stopScan: void;
    delete404: void;
    deleteSelected: void;
  }>();

  onMount(async () => {
    try {
      if (typeof getAiSettings === 'function') {
        const s = await getAiSettings();
        if (s) {
          autoSummarize = s.autoSummarize ?? false;
          autoTags = s.autoTags ?? true;
          autoFolder = s.autoFolder ?? true;
        }
      }
    } catch {
      // ignore
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('click', handleOutsideClick);
      window.addEventListener('keydown', handleKeydown);
    }
  });

  onDestroy(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('click', handleOutsideClick);
      window.removeEventListener('keydown', handleKeydown);
    }
  });

  function handleOutsideClick(e: MouseEvent) {
    if (dropdownContainer && !dropdownContainer.contains(e.target as Node)) {
      isDropdownOpen = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && isDropdownOpen) {
      isDropdownOpen = false;
      toggleBtn?.focus();
    }
  }

  function handleMainAction() {
    if (aiActive) {
      dispatch('cancelAi');
    } else if (hasAnyAiOption) {
      isDropdownOpen = false;
      dispatch('runAi', { autoSummarize, autoTags, autoFolder });
    }
  }
</script>

<div class="bulk-action-bar bulk-actions">
  <div class="bulk-left">
    <label class="select-all-label">
      <input
        type="checkbox"
        checked={allSelected}
        disabled={totalCount === 0}
        on:change={() => dispatch('toggleSelectAll')}
        aria-label={i18n.t('bookmarks.selectAll')}
      />
      <span class="selection-text {selectedCount > 0 ? 'font-mono' : ''}">
        {#if selectedCount > 0}
          {i18n.t('bookmarks.selectedCount', { count: selectedCount })}
        {:else}
          {i18n.t('bookmarks.selectAll')}
        {/if}
      </span>
    </label>

    {#if selectedCount > 0}
      <button
        type="button"
        class="btn-text-muted"
        on:click={() => dispatch('clearSelection')}
      >
        {i18n.t('bookmarks.deselectAll')}
      </button>
    {/if}
  </div>

  <div class="bulk-right">
    <!-- Split Button with Dropdown -->
    <div class="split-btn-group" bind:this={dropdownContainer}>
      <button
        type="button"
        class="btn {aiActive && isAiCancelHovered ? 'btn-danger' : 'btn-secondary'} btn-sm split-btn-main"
        on:click={handleMainAction}
        on:mouseenter={() => { if (aiActive) isAiCancelHovered = true; }}
        on:mouseleave={() => { isAiCancelHovered = false; }}
        on:focus={() => { if (aiActive) isAiCancelHovered = true; }}
        on:blur={() => { isAiCancelHovered = false; }}
        disabled={isScanning || (!aiActive && (totalCount === 0 || !hasAnyAiOption))}
        title={aiActive && isAiCancelHovered
          ? i18n.t('common.cancel')
          : aiActive
            ? i18n.t('common.loading')
            : !hasAnyAiOption
              ? i18n.t('bookmarks.bulk.aiSelectAtLeastOne')
              : i18n.t('bookmarks.bulk.aiProcess')}
        aria-label={aiActive && isAiCancelHovered ? i18n.t('common.cancel') : i18n.t('bookmarks.bulk.aiProcess')}
      >
        {#if aiActive}
          {#if isAiCancelHovered}
            <Icon name="x" size={13} />
            <span>{i18n.t('common.cancel')}</span>
          {:else}
            <Spinner size={12} variant="inline" />
            <span>{i18n.t('common.loading')}</span>
          {/if}
        {:else}
          <Icon name="sparkles" size={13} />
          <span>{i18n.t('bookmarks.bulk.aiProcess')}</span>
        {/if}
      </button>

      <button
        type="button"
        bind:this={toggleBtn}
        class="btn btn-secondary btn-sm split-btn-toggle"
        class:open={isDropdownOpen}
        on:click|stopPropagation={() => { isDropdownOpen = !isDropdownOpen; }}
        disabled={isScanning || aiActive || totalCount === 0}
        aria-haspopup="dialog"
        aria-expanded={isDropdownOpen}
        aria-label={i18n.t('bookmarks.bulk.aiOptions')}
        title={i18n.t('bookmarks.bulk.aiOptions')}
      >
        <span class="chevron-wrapper" class:rotated={isDropdownOpen}>
          <Icon name="chevron-down" size={12} />
        </span>
      </button>

      {#if isDropdownOpen}
        <div class="ai-dropdown-menu glass-panel" role="region" aria-label={i18n.t('bookmarks.bulk.aiOptions')}>
          <div class="dropdown-header">
            <span class="dropdown-title">{i18n.t('bookmarks.bulk.aiOptions')}</span>
          </div>
          <div class="dropdown-divider"></div>
          <label class="dropdown-item">
            <input type="checkbox" bind:checked={autoSummarize} />
            <Icon name="file-text" size={13} />
            <span>{i18n.t('bookmarks.bulk.aiOptionSummarize')}</span>
          </label>
          <label class="dropdown-item">
            <input type="checkbox" bind:checked={autoTags} />
            <Icon name="tag" size={13} />
            <span>{i18n.t('bookmarks.bulk.aiOptionTags')}</span>
          </label>
          <label class="dropdown-item">
            <input type="checkbox" bind:checked={autoFolder} />
            <Icon name="folder" size={13} />
            <span>{i18n.t('bookmarks.bulk.aiOptionFolder')}</span>
          </label>
          {#if !hasAnyAiOption}
            <div class="dropdown-warning font-mono">
              {i18n.t('bookmarks.bulk.aiSelectAtLeastOne')}
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <button
      type="button"
      class="btn btn-secondary btn-sm"
      on:click={() => {
        if (isScanning) dispatch('stopScan');
        else dispatch('reviewLinks');
      }}
      disabled={aiActive || (!isScanning && totalCount === 0)}
    >
      {#if isScanning}
        <Spinner size={12} variant="inline" />
        <span>{i18n.t('common.cancel')} ({scanProgress}/{scanTotal})</span>
      {:else}
        <Icon name="activity" size={13} />
        <span>{i18n.t('bookmarks.bulk.checkLinks')}</span>
      {/if}
    </button>

    {#if deadSelectedCount > 0}
      <button
        type="button"
        class="btn btn-danger-outline btn-sm"
        on:click={() => dispatch('delete404')}
        disabled={isScanning || aiActive || isDeleting}
      >
        {#if isDeleting}
          <Spinner size={12} variant="inline" />
        {:else}
          <Icon name="trash-2" size={13} />
        {/if}
        <span>{i18n.t('bookmarks.bulk.delete404')} ({deadSelectedCount})</span>
      </button>
    {/if}

    <button
      type="button"
      class="btn btn-danger btn-sm"
      on:click={() => dispatch('deleteSelected')}
      disabled={isScanning || aiActive || selectedCount === 0 || isDeleting}
    >
      {#if isDeleting}
        <Spinner size={12} variant="inline" />
      {:else}
        <Icon name="trash-2" size={13} />
      {/if}
      <span>{i18n.t('bookmarks.bulk.deleteSelected')} ({selectedCount})</span>
    </button>
  </div>
</div>

<style>
  .bulk-action-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    padding: 0.625rem 1rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    flex-wrap: wrap;
  }

  .bulk-left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .select-all-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-size: 0.875rem;
  }

  .selection-text {
    color: var(--text-primary);
  }

  .btn-text-muted {
    background: none;
    border: none;
    font-size: 0.75rem;
    color: var(--text-muted);
    cursor: pointer;
    text-decoration: underline;
    padding: 0;
  }

  .btn-text-muted:hover {
    color: var(--text-primary);
  }

  .bulk-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .btn-sm {
    font-size: 0.8125rem;
    padding: 0.375rem 0.75rem;
  }

  .btn-secondary {
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--bg-tertiary);
  }

  .btn-danger {
    background: var(--color-danger);
    color: var(--color-on-primary);
    border: none;
  }

  .btn-danger:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }

  .btn-danger-outline {
    background: var(--color-primary-light);
    color: var(--color-danger);
    border: 1px solid var(--color-danger);
  }

  .btn-danger-outline:hover:not(:disabled) {
    background: var(--color-danger);
    color: var(--color-on-primary);
  }

  /* Split Button & Dropdown Styles */
  .split-btn-group {
    position: relative;
    display: inline-flex;
    vertical-align: middle;
  }

  .split-btn-main {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }

  .split-btn-toggle {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    border-left: none;
    padding: 0.375rem 0.4375rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .split-btn-toggle.open {
    background: var(--bg-tertiary);
  }

  .chevron-wrapper {
    display: inline-flex;
    transition: transform 0.15s ease;
  }

  .chevron-wrapper.rotated {
    transform: rotate(180deg);
  }

  .ai-dropdown-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    min-width: 190px;
    z-index: 100;
    padding: 0.5rem;
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    box-shadow: var(--shadow-lg);
  }

  .dropdown-header {
    padding: 0.25rem 0.375rem;
  }

  .dropdown-title {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .dropdown-divider {
    height: 1px;
    background: var(--border-color);
    margin: 0.125rem 0;
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 0.8125rem;
    color: var(--text-primary);
    transition: background var(--transition-fast);
    user-select: none;
  }

  .dropdown-item:hover {
    background: var(--bg-tertiary);
  }

  .dropdown-item input[type="checkbox"] {
    cursor: pointer;
    margin: 0;
  }

  .dropdown-warning {
    margin-top: 0.25rem;
    padding: 0.25rem 0.375rem;
    font-size: 0.6875rem;
    color: var(--color-warning);
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
  }
</style>
