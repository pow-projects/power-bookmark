<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Icon from '../../shared/Icon.svelte';

  export type SortOption =
    | 'date-desc'
    | 'date-asc'
    | 'title-asc'
    | 'title-desc'
    | 'folder-asc'
    | 'folder-desc'
    | 'status-asc'
    | 'status-desc';

  export let allSelected: boolean = false;
  export let sortBy: SortOption = 'date-desc';

  const dispatch = createEventDispatcher<{
    toggleSelectAll: void;
    sort: { sortBy: SortOption };
  }>();

  function toggleTitleSort() {
    const next = sortBy === 'title-asc' ? 'title-desc' : 'title-asc';
    dispatch('sort', { sortBy: next });
  }

  function toggleDateSort() {
    const next = sortBy === 'date-desc' ? 'date-asc' : 'date-desc';
    dispatch('sort', { sortBy: next });
  }

  function toggleFolderSort() {
    const next = sortBy === 'folder-asc' ? 'folder-desc' : 'folder-asc';
    dispatch('sort', { sortBy: next });
  }

  function toggleStatusSort() {
    const next = sortBy === 'status-desc' ? 'status-asc' : 'status-desc';
    dispatch('sort', { sortBy: next });
  }
</script>

<div class="table-header" role="row">
  <div class="col-checkbox">
    <input
      type="checkbox"
      class="header-checkbox"
      checked={allSelected}
      on:change={() => dispatch('toggleSelectAll')}
      aria-label={i18n.t('bookmarks.selectAll')}
    />
  </div>

  <div class="col-icon" aria-hidden="true"></div>

  <div class="col-title">
    <button type="button" class="header-sort-btn" on:click={toggleTitleSort} aria-label={i18n.t('bookmarks.sort.nameAsc')}>
      <span>{i18n.t('bookmarks.table.title')}</span>
      {#if sortBy === 'title-asc'}
        <Icon name="chevron-up" size={13} />
      {:else if sortBy === 'title-desc'}
        <Icon name="chevron-down" size={13} />
      {/if}
    </button>
  </div>

  <div class="col-folder">
    <button type="button" class="header-sort-btn" on:click={toggleFolderSort} aria-label={i18n.t('bookmarks.sort.folderAsc')}>
      <span>{i18n.t('bookmarks.table.folder')}</span>
      {#if sortBy === 'folder-asc'}
        <Icon name="chevron-up" size={13} />
      {:else if sortBy === 'folder-desc'}
        <Icon name="chevron-down" size={13} />
      {/if}
    </button>
  </div>

  <div class="col-tags">
    <span class="header-label">{i18n.t('bookmarks.table.tags')}</span>
  </div>

  <div class="col-status">
    <button type="button" class="header-sort-btn" on:click={toggleStatusSort} aria-label={i18n.t('bookmarks.sort.statusDesc')}>
      <span>{i18n.t('bookmarks.table.archive')}</span>
      {#if sortBy === 'status-desc'}
        <Icon name="chevron-down" size={13} />
      {:else if sortBy === 'status-asc'}
        <Icon name="chevron-up" size={13} />
      {/if}
    </button>
  </div>

  <div class="col-date">
    <button type="button" class="header-sort-btn" on:click={toggleDateSort} aria-label={i18n.t('bookmarks.sort.newest')}>
      <span>{i18n.t('bookmarks.table.created')}</span>
      {#if sortBy === 'date-desc'}
        <Icon name="chevron-down" size={13} />
      {:else if sortBy === 'date-asc'}
        <Icon name="chevron-up" size={13} />
      {/if}
    </button>
  </div>

  <div class="col-actions">
    <span class="header-label">{i18n.t('bookmarks.table.actions')}</span>
  </div>
</div>

<style>
  .table-header {
    display: grid;
    grid-template-columns: 32px 24px minmax(200px, 3fr) minmax(110px, 1.2fr) minmax(100px, 1fr) 110px 85px 96px;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.75rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    font-family: var(--font-mono);
    font-size: 0.725rem;
    color: var(--text-secondary);
    font-weight: 600;
    user-select: none;
    box-sizing: border-box;
  }

  .col-checkbox { display: flex; align-items: center; justify-content: center; }
  .header-checkbox { cursor: pointer; margin: 0; }
  .col-icon { width: 24px; }
  .header-label { font-size: 0.725rem; color: var(--text-secondary); }
  .header-sort-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    background: none;
    border: none;
    padding: 0;
    font-family: var(--font-mono);
    font-size: 0.725rem;
    font-weight: 600;
    color: var(--text-secondary);
    cursor: pointer;
    transition: color var(--transition-fast);
  }
  .header-sort-btn:hover { color: var(--color-primary); }

  .col-title { min-width: 0; }
  .col-folder { min-width: 0; }
  .col-tags { min-width: 0; }
  .col-status { text-align: left; }
  .col-date { text-align: right; }
  .col-actions { text-align: center; }

  @media (max-width: 900px) {
    .table-header {
      grid-template-columns: 32px 24px minmax(160px, 2fr) minmax(90px, 1fr) 90px 80px;
    }
    .col-tags, .col-date { display: none; }
  }
</style>
