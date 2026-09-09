<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import Icon from './Icon.svelte';

  export let folders: { id: string; title: string; path: string; depth?: number }[] = [];
  export let value: string = '';
  export let placeholder: string = '';
  export let isFilterMode: boolean = false; // Whether filter mode for management page (value is path-based)
  export let filterAllLabel: string = '';
  export let allowRoot: boolean = false;
  export let rootLabel: string = '';
  export let id: string = '';

  const dispatch = createEventDispatcher<{ change: { value: string } }>();

  let isOpen = false;
  let selectContainer: HTMLDivElement;

  $: effectivePlaceholder = placeholder || i18n.t('popup.form.folderSelect');
  $: effectiveFilterAllLabel = filterAllLabel || i18n.t('folders.allFolders');
  $: effectiveRootLabel = rootLabel || i18n.t('folders.rootFolder');

  $: selectedFolder = folders.find(f => isFilterMode ? f.path === value : f.id === value);
  $: selectedTitle = selectedFolder 
    ? selectedFolder.title 
    : (value === '' && isFilterMode ? effectiveFilterAllLabel : (value === '' && allowRoot ? effectiveRootLabel : effectivePlaceholder));

  function toggleDropdown() {
    isOpen = !isOpen;
  }

  function selectOption(folderId: string, folderPath: string) {
    value = isFilterMode ? folderPath : folderId;
    isOpen = false;
    dispatch('change', { value });
  }

  function handleOutsideClick(event: MouseEvent) {
    if (selectContainer && !selectContainer.contains(event.target as Node)) {
      isOpen = false;
    }
  }

  onMount(() => {
    window.addEventListener('click', handleOutsideClick);
  });

  onDestroy(() => {
    window.removeEventListener('click', handleOutsideClick);
  });
</script>

<div class="folder-select-custom" bind:this={selectContainer} {id}>
  <button 
    type="button" 
    class="select-trigger" 
    class:open={isOpen} 
    on:click={toggleDropdown}
    aria-haspopup="listbox"
    aria-expanded={isOpen}
  >
    <div class="selected-content">
      <Icon name="folder" size={14} />
      <span class="selected-text">{selectedTitle}</span>
    </div>
    <span class="chevron-icon">
      <Icon name="chevron-down" size={14} />
    </span>
  </button>

  {#if isOpen}
    <div class="dropdown-menu glass-panel" role="listbox">
      {#if isFilterMode}
        <button 
          type="button" 
          class="option-item" 
          class:selected={value === ''} 
          on:click={() => selectOption('', '')}
          role="option"
          aria-selected={value === ''}
        >
          <Icon name="folder" size={13} />
          <span>{effectiveFilterAllLabel}</span>
        </button>
      {:else if allowRoot}
        <button 
          type="button" 
          class="option-item" 
          class:selected={value === ''} 
          on:click={() => selectOption('', '')}
          role="option"
          aria-selected={value === ''}
        >
          <Icon name="folder" size={13} />
          <span>{effectiveRootLabel}</span>
        </button>
      {/if}

      {#each folders as f}
        {@const depth = f.depth ?? 0}
        <button 
          type="button" 
          class="option-item" 
          class:selected={isFilterMode ? value === f.path : value === f.id} 
          style="padding-left: {10 + depth * 10}px"
          on:click={() => selectOption(f.id, f.path)}
          role="option"
          aria-selected={isFilterMode ? value === f.path : value === f.id}
        >
          <Icon name="folder" size={13} />
          <span class="item-title">{f.title}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .folder-select-custom {
    position: relative;
    width: 100%;
    font-family: var(--font-primary), sans-serif;
  }

  .select-trigger {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    height: 40px;
    padding: 0.5rem 0.875rem;
    box-sizing: border-box;
    background-color: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    font-size: 0.875rem;
    cursor: pointer;
    transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
    text-align: left;
  }

  .select-trigger:hover, .select-trigger.open {
    border-color: var(--border-focus);
    background-color: var(--bg-primary);
  }

  .selected-content {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    overflow: hidden;
  }

  .selected-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 500;
  }

  .chevron-icon {
    flex-shrink: 0;
    color: var(--text-muted);
    transition: transform var(--transition-fast);
  }

  .select-trigger.open .chevron-icon {
    transform: rotate(180deg);
  }

  .dropdown-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    max-height: 220px;
    overflow-y: auto;
    background-color: var(--bg-surface-elevated, var(--bg-secondary));
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    z-index: 1000;
    padding: 0.25rem 0;
  }

  .option-item {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    padding: 0.375rem 0.75rem;
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: 0.825rem;
    text-align: left;
    cursor: pointer;
    transition: background-color var(--transition-fast), color var(--transition-fast);
  }

  .option-item:hover {
    background-color: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .option-item.selected {
    background-color: rgba(186, 24, 27, 0.1);
    color: var(--color-primary);
    font-weight: 600;
  }

  .item-title {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
