<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Icon from '../../shared/Icon.svelte';
  import Spinner from '../../shared/Spinner.svelte';

  export let selectedCount: number = 0;
  export let totalCount: number = 0;
  export let allSelected: boolean = false;
  export let isScanning: boolean = false;
  export let scanProgress: number = 0;
  export let scanTotal: number = 0;
  export let isAiCategorizing: boolean = false;
  export let isAiSummarizing: boolean = false;
  export let deadSelectedCount: number = 0;
  export let isDeleting: boolean = false;

  let isAiCancelHovered = false;
  $: if (!isAiCategorizing) isAiCancelHovered = false;

  let isAiSummaryCancelHovered = false;
  $: if (!isAiSummarizing) isAiSummaryCancelHovered = false;

  const dispatch = createEventDispatcher<{
    toggleSelectAll: void;
    clearSelection: void;
    categorizeAi: void;
    cancelAi: void;
    summarizeAi: void;
    reviewLinks: void;
    stopScan: void;
    delete404: void;
    deleteSelected: void;
  }>();
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
    <button
      type="button"
      class="btn {isAiCategorizing && isAiCancelHovered ? 'btn-danger' : 'btn-secondary'} btn-sm"
      on:click={() => { if (isAiCategorizing) dispatch('cancelAi'); else dispatch('categorizeAi'); }}
      on:mouseenter={() => { if (isAiCategorizing) isAiCancelHovered = true; }}
      on:mouseleave={() => { isAiCancelHovered = false; }}
      on:focus={() => { if (isAiCategorizing) isAiCancelHovered = true; }}
      on:blur={() => { isAiCancelHovered = false; }}
      disabled={isScanning || isAiSummarizing || (!isAiCategorizing && totalCount === 0)}
      title={isAiCategorizing && isAiCancelHovered ? i18n.t('common.cancel') : isAiCategorizing ? i18n.t('common.loading') : i18n.t('bookmarks.bulk.aiClassify')}
      aria-label={isAiCategorizing && isAiCancelHovered ? i18n.t('common.cancel') : isAiCategorizing ? i18n.t('common.loading') : i18n.t('bookmarks.bulk.aiClassify')}
    >
      {#if isAiCategorizing}
        {#if isAiCancelHovered}
          <Icon name="x" size={13} />
          <span>{i18n.t('common.cancel')}</span>
        {:else}
          <Spinner size={12} variant="inline" />
          <span>{i18n.t('common.loading')}</span>
        {/if}
      {:else}
        <Icon name="sparkles" size={13} />
        <span>{i18n.t('bookmarks.bulk.aiClassify')}</span>
      {/if}
    </button>

    <button
      type="button"
      class="btn {isAiSummarizing && isAiSummaryCancelHovered ? 'btn-danger' : 'btn-secondary'} btn-sm"
      on:click={() => { if (isAiSummarizing) dispatch('cancelAi'); else dispatch('summarizeAi'); }}
      on:mouseenter={() => { if (isAiSummarizing) isAiSummaryCancelHovered = true; }}
      on:mouseleave={() => { isAiSummaryCancelHovered = false; }}
      on:focus={() => { if (isAiSummarizing) isAiSummaryCancelHovered = true; }}
      on:blur={() => { isAiSummaryCancelHovered = false; }}
      disabled={isScanning || isAiCategorizing || (!isAiSummarizing && totalCount === 0)}
      title={isAiSummarizing && isAiSummaryCancelHovered ? i18n.t('common.cancel') : isAiSummarizing ? i18n.t('common.loading') : i18n.t('bookmarks.bulk.aiSummarize')}
      aria-label={isAiSummarizing && isAiSummaryCancelHovered ? i18n.t('common.cancel') : isAiSummarizing ? i18n.t('common.loading') : i18n.t('bookmarks.bulk.aiSummarize')}
    >
      {#if isAiSummarizing}
        {#if isAiSummaryCancelHovered}
          <Icon name="x" size={13} />
          <span>{i18n.t('common.cancel')}</span>
        {:else}
          <Spinner size={12} variant="inline" />
          <span>{i18n.t('common.loading')}</span>
        {/if}
      {:else}
        <Icon name="file-text" size={13} />
        <span>{i18n.t('bookmarks.bulk.aiSummarize')}</span>
      {/if}
    </button>

    <button
      type="button"
      class="btn btn-secondary btn-sm"
      on:click={() => {
        if (isScanning) dispatch('stopScan');
        else dispatch('reviewLinks');
      }}
      disabled={isAiCategorizing || isAiSummarizing || (!isScanning && totalCount === 0)}
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
        disabled={isScanning || isAiCategorizing || isAiSummarizing || isDeleting}
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
      disabled={isScanning || isAiCategorizing || isAiSummarizing || selectedCount === 0 || isDeleting}
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
</style>
