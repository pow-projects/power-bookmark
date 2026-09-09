<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Icon from '../../shared/Icon.svelte';

  export let searchQuery: string = '';
  export let selectedFilters: Array<'uncategorized' | 'no-desc' | 'no-tags' | 'broken' | 'dead'> = [];
  export let selectedTags: string[] = [];
  export let selectedFolder: string = '';
  export let selectedFilter: 'all' | 'uncategorized' | 'no-desc' | 'no-tags' | 'broken' | 'dead' = 'all';
  export let selectedTag: string = 'all';
  export let sortBy:
    | 'date-desc'
    | 'date-asc'
    | 'title-asc'
    | 'title-desc'
    | 'folder-asc'
    | 'folder-desc'
    | 'status-asc'
    | 'status-desc' = 'date-desc';
  export let viewMode: 'grid' | 'list' = 'grid';
  export let availableTags: string[] = [];

  const dispatch = createEventDispatcher<{
    change: void;
    clearFilters: void;
  }>();

  let searchInputEl: HTMLInputElement;

  // Single-prop to array sync for legacy test / external callers
  let lastPropFilter = '';
  $: if (selectedFilter !== lastPropFilter) {
    lastPropFilter = selectedFilter;
    if (selectedFilter !== 'all' && !selectedFilters.includes(selectedFilter as any)) {
      selectedFilters = [...selectedFilters, selectedFilter as any];
    }
  }

  let lastPropTag = '';
  $: if (selectedTag !== lastPropTag) {
    lastPropTag = selectedTag;
    if (selectedTag !== 'all' && !selectedTags.includes(selectedTag)) {
      selectedTags = [...selectedTags, selectedTag];
    }
  }

  interface FilterBadge {
    id: string;
    type: 'status' | 'tag';
    value: string;
    label: string;
    icon: string;
    variant: 'status' | 'tag' | 'danger' | 'warning';
  }

  function getStatusLabel(status: string): string {
    switch (status) {
      case 'uncategorized': return i18n.t('bookmarks.filterStatus.uncategorized');
      case 'no-desc': return i18n.t('bookmarks.filterStatus.noDesc');
      case 'no-tags': return i18n.t('bookmarks.filterStatus.noTags');
      case 'broken': return i18n.t('bookmarks.filterStatus.broken');
      case 'dead': return i18n.t('bookmarks.filterStatus.dead');
      default: return status;
    }
  }

  $: activeBadges = [
    ...selectedFilters.map((f): FilterBadge => {
      let icon = 'filter';
      let variant: FilterBadge['variant'] = 'status';
      if (f === 'uncategorized') { icon = 'folder'; variant = 'warning'; }
      else if (f === 'no-desc') { icon = 'file-text'; }
      else if (f === 'no-tags') { icon = 'bookmark'; }
      else if (f === 'broken') { icon = 'alert-triangle'; variant = 'danger'; }
      else if (f === 'dead') { icon = 'alert-circle'; variant = 'danger'; }
      return {
        id: `status:${f}`,
        type: 'status',
        value: f,
        label: getStatusLabel(f),
        icon,
        variant
      };
    }),
    ...selectedTags.map((t): FilterBadge => ({
      id: `tag:${t}`,
      type: 'tag',
      value: t,
      label: `#${t}`,
      icon: 'bookmark',
      variant: 'tag'
    }))
  ];

  $: isFiltered = searchQuery.trim() !== '' || activeBadges.length > 0 || selectedFilter !== 'all' || selectedTag !== 'all';

  function removeBadge(badge: FilterBadge) {
    if (badge.type === 'status') {
      selectedFilters = selectedFilters.filter((f) => f !== badge.value);
      if (selectedFilter === badge.value) {
        selectedFilter = 'all';
        lastPropFilter = 'all';
      }
    } else if (badge.type === 'tag') {
      selectedTags = selectedTags.filter((t) => t !== badge.value);
      if (selectedTag === badge.value) {
        selectedTag = 'all';
        lastPropTag = 'all';
      }
    }
    dispatch('change');
  }

  function handleSearchBoxClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('.chip-remove-btn') || target.closest('.btn-clear')) {
      return;
    }
    if (searchInputEl) {
      searchInputEl.focus();
    }
  }

  function handleSearchKeyDown(e: KeyboardEvent) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Backspace' && searchQuery === '' && activeBadges.length > 0) {
      const lastBadge = activeBadges[activeBadges.length - 1];
      removeBadge(lastBadge);
    }
  }

  function handleStatusChange(e: Event) {
    const target = e.target as HTMLSelectElement;
    const val = target.value;
    if (val !== 'all') {
      if (!selectedFilters.includes(val as any)) {
        selectedFilters = [...selectedFilters, val as any];
      }
      selectedFilter = val as any;
      lastPropFilter = val as any;
      target.value = 'all';
      dispatch('change');
    }
  }

  function handleTagChange(e: Event) {
    const target = e.target as HTMLSelectElement;
    const val = target.value;
    if (val !== 'all') {
      if (!selectedTags.includes(val)) {
        selectedTags = [...selectedTags, val];
      }
      selectedTag = val;
      lastPropTag = val;
      target.value = 'all';
      dispatch('change');
    }
  }

  function clearAll() {
    searchQuery = '';
    selectedFilters = [];
    selectedTags = [];
    selectedFolder = '';
    selectedFilter = 'all';
    selectedTag = 'all';
    lastPropFilter = 'all';
    lastPropTag = 'all';
    dispatch('clearFilters');
    dispatch('change');
  }
</script>

<div class="filter-bar">
  <div class="filter-search-wrapper" role="search">
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="search-input-box" on:click={handleSearchBoxClick}>
      <Icon name="search" size={15} />

      <div class="search-chips-container" role="group" aria-label={i18n.t('bookmarks.filterBadge.appliedFilters')}>
        {#each activeBadges as badge (badge.id)}
          <span class="filter-chip filter-chip--{badge.variant}">
            <Icon name={badge.icon} size={11} />
            <span class="filter-chip-label" title={badge.label}>{badge.label}</span>
            <button
              type="button"
              class="chip-remove-btn"
              on:click|stopPropagation={() => removeBadge(badge)}
              aria-label={i18n.t('bookmarks.filterBadge.remove', { label: badge.label })}
            >
              <Icon name="x" size={10} />
            </button>
          </span>
        {/each}

        <input
          bind:this={searchInputEl}
          type="text"
          class="search-input"
          placeholder={activeBadges.length > 0 ? i18n.t('bookmarks.searchPlaceholderShort') : i18n.t('bookmarks.searchPlaceholder')}
          bind:value={searchQuery}
          on:input={() => dispatch('change')}
          on:keydown={handleSearchKeyDown}
          aria-label={i18n.t('bookmarks.searchAria')}
        />
      </div>

      {#if isFiltered}
        <button
          type="button"
          class="btn-icon btn-clear"
          on:click|stopPropagation={clearAll}
          aria-label={i18n.t('common.close')}
        >
          <Icon name="x" size={14} />
        </button>
      {/if}
    </div>
  </div>

  <div class="filter-controls">
    <select
      class="form-select filter-select"
      value="all"
      on:change={handleStatusChange}
      aria-label={i18n.t('bookmarks.statusFilterAria')}
    >
      <option value="all">{i18n.t('bookmarks.filterStatus.all')}</option>
      <option value="uncategorized">{i18n.t('bookmarks.filterStatus.uncategorized')}</option>
      <option value="no-desc">{i18n.t('bookmarks.filterStatus.noDesc')}</option>
      <option value="no-tags">{i18n.t('bookmarks.filterStatus.noTags')}</option>
      <option value="broken">{i18n.t('bookmarks.filterStatus.broken')}</option>
      <option value="dead">{i18n.t('bookmarks.filterStatus.dead')}</option>
    </select>

    {#if availableTags.length > 0}
      <select
        class="form-select filter-select"
        value="all"
        on:change={handleTagChange}
        aria-label={i18n.t('bookmarks.tagFilterAria')}
      >
        <option value="all">{i18n.t('bookmarks.allTags')}</option>
        {#each availableTags as tag}
          <option value={tag}>#{tag}</option>
        {/each}
      </select>
    {/if}

    <select
      class="form-select filter-select sort-select"
      bind:value={sortBy}
      on:change={() => dispatch('change')}
      aria-label={i18n.t('bookmarks.sortAria')}
    >
      <option value="date-desc">{i18n.t('bookmarks.sort.newest')}</option>
      <option value="date-asc">{i18n.t('bookmarks.sort.oldest')}</option>
      <option value="title-asc">{i18n.t('bookmarks.sort.nameAsc')}</option>
      <option value="title-desc">{i18n.t('bookmarks.sort.nameDesc')}</option>
      <option value="folder-asc">{i18n.t('bookmarks.sort.folderAsc')}</option>
      <option value="folder-desc">{i18n.t('bookmarks.sort.folderDesc')}</option>
      <option value="status-desc">{i18n.t('bookmarks.sort.statusDesc')}</option>
      <option value="status-asc">{i18n.t('bookmarks.sort.statusAsc')}</option>
    </select>

    <div class="view-mode-toggle">
      <button
        type="button"
        class="btn-icon view-btn"
        class:active={viewMode === 'grid'}
        on:click={() => { viewMode = 'grid'; dispatch('change'); }}
        title={i18n.t('bookmarks.viewMode.grid')}
        aria-label={i18n.t('bookmarks.viewMode.grid')}
        aria-pressed={viewMode === 'grid'}
      >
        <Icon name="grid" size={16} />
      </button>
      <button
        type="button"
        class="btn-icon view-btn"
        class:active={viewMode === 'list'}
        on:click={() => { viewMode = 'list'; dispatch('change'); }}
        title={i18n.t('bookmarks.viewMode.list')}
        aria-label={i18n.t('bookmarks.viewMode.list')}
        aria-pressed={viewMode === 'list'}
      >
        <Icon name="list" size={16} />
      </button>
    </div>
  </div>
</div>

<style>
  .filter-bar {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    background: var(--bg-primary);
  }

  .filter-search-wrapper {
    flex-grow: 1;
    min-width: 280px;
  }

  .search-input-box {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: 0.25rem 0.625rem;
    color: var(--text-muted);
    transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
    cursor: text;
    min-height: 32px;
    box-sizing: border-box;
  }

  .search-input-box:focus-within {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px var(--color-primary-light);
    color: var(--color-primary);
  }

  .search-chips-container {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.25rem;
    flex: 1;
    min-width: 0;
  }

  .filter-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-family: var(--font-mono);
    font-size: 0.75rem;
    line-height: 1;
    height: 22px;
    box-sizing: border-box;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    padding: 0 0.4rem;
    color: var(--text-secondary);
    max-width: 220px;
    user-select: none;
    transition: background var(--transition-fast), border-color var(--transition-fast);
  }

  .filter-chip--status {
    color: var(--text-primary);
  }

  .filter-chip--tag {
    color: var(--text-primary);
  }

  .filter-chip--danger {
    color: var(--color-danger);
    background: var(--color-danger-light, rgba(220, 38, 38, 0.08));
  }

  .filter-chip--warning {
    color: var(--text-primary);
  }

  .filter-chip-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.6875rem;
  }

  .chip-remove-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 1px;
    border-radius: 50%;
    margin-left: 1px;
    transition: color var(--transition-fast), background var(--transition-fast);
  }

  .chip-remove-btn:hover {
    color: var(--color-primary);
    background: var(--color-primary-light);
  }

  .search-input {
    border: none;
    background: transparent;
    padding: 0;
    font-size: 0.875rem;
    line-height: 1.25;
    font-family: var(--font-primary);
    color: var(--text-primary);
    flex: 1;
    min-width: 70px;
    outline: none;
  }

  .btn-clear {
    padding: 2px;
    cursor: pointer;
    flex-shrink: 0;
  }

  .filter-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .filter-select {
    width: auto;
    font-size: 0.8125rem;
    padding: 0.375rem 0.625rem;
  }

  .view-mode-toggle {
    display: flex;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--bg-secondary);
    overflow: hidden;
  }

  .view-btn {
    padding: 0.375rem 0.5rem;
    border-radius: 0;
  }

  .view-btn.active {
    background: var(--bg-tertiary);
    color: var(--color-primary);
  }
</style>
