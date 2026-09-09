<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Icon from '../shared/Icon.svelte';
  import FolderSelect from '../shared/FolderSelect.svelte';

  export let title = '';
  export let description = '';
  export let folderId = '';
  export let folders: { id: string; title: string; path: string; parentId?: string; depth?: number; displayName?: string }[] = [];
  export let foldersError = false;
  // v2: autosave indicator — mono "SAVING…" to the right of title input (no completed state display)
  export let saveState: 'idle' | 'saving' = 'idle';

  const dispatch = createEventDispatcher();

  let isCreatingFolder = false;
  let newFolderName = '';

  function toggleCreateFolder() {
    isCreatingFolder = !isCreatingFolder;
    if (!isCreatingFolder) {
      newFolderName = '';
    }
  }

  function cancelCreateFolder() {
    newFolderName = '';
    isCreatingFolder = false;
  }

  function handleCreateFolder() {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    dispatch('createFolder', { title: trimmed, parentId: folderId });
    newFolderName = '';
    isCreatingFolder = false;
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCreateFolder();
    } else if (e.key === 'Escape') {
      cancelCreateFolder();
    }
  }

  function focus(node: HTMLInputElement) {
    node.focus();
  }
</script>

<div class="form-container">
  <!-- Title input + autosave indicator -->
  <label for="title">{i18n.t('popup.form.title')}</label>
  <div class="title-input-wrap">
    <input type="text" id="title" bind:value={title} />
    {#if saveState === 'saving'}
      <span class="save-indicator" aria-live="polite">
        <span>{i18n.t('popup.saving')}</span>
      </span>
    {/if}
  </div>

  <!-- Folder selection (displayed as dropdown) -->
  <div class="folder-header">
    <label for="folder">{i18n.t('popup.form.folder')}</label>
  </div>
  <div class="folder-select-group">
    <FolderSelect id="folder" {folders} bind:value={folderId} />
    <button 
      type="button" 
      class="btn-icon" 
      on:click={toggleCreateFolder} 
      title={i18n.t('popup.form.newFolder')} 
      aria-label={i18n.t('popup.form.newFolder')}
    >
      <Icon name="folder-plus" size={16} />
    </button>
  </div>

  {#if folders.length === 0}
    <div class="folder-empty-hint" role="status">
      {#if foldersError}
        <Icon name="alert-triangle" size={13} />
        <span>{i18n.t('popup.form.foldersLoadRetry')}</span>
      {:else}
        <Icon name="folder" size={13} />
        <span>{i18n.t('popup.form.foldersEmpty')}</span>
      {/if}
    </div>
  {/if}

  {#if isCreatingFolder}
    <div class="new-folder-box">
      <input
        type="text"
        class="new-folder-input"
        placeholder={i18n.t('popup.form.newFolderPlaceholder')}
        bind:value={newFolderName}
        on:keydown={handleKeyDown}
        use:focus
      />
      <div class="new-folder-actions">
        <button type="button" class="btn btn-xs btn-primary" on:click={handleCreateFolder}>
          {i18n.t('popup.form.create')}
        </button>
        <button type="button" class="btn btn-xs btn-secondary" on:click={cancelCreateFolder}>
          {i18n.t('popup.form.cancel')}
        </button>
      </div>
    </div>
  {/if}

  <!-- Description and AI summary -->
  <label for="description" class="description-label">{i18n.t('popup.form.description')}</label>
  <textarea id="description" rows="2" bind:value={description} placeholder={i18n.t('popup.form.descriptionPlaceholder')}></textarea>
</div>

<style>
  .form-container {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 0.5rem;
    row-gap: 0.5rem;
    align-items: center;
    margin-bottom: 1rem;
  }

  label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .folder-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .folder-empty-hint {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.625rem;
    font-size: 0.75rem;
    color: var(--text-muted, var(--text-secondary));
    background-color: var(--bg-tertiary, rgba(127,127,127,0.08));
    border: 1px dashed var(--border-color);
    border-radius: var(--radius-md);
  }

  input, textarea {
    width: 100%;
    box-sizing: border-box;
  }

  .folder-select-group {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    width: 100%;
  }

  .new-folder-box {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.5rem;
    background-color: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
  }

  .new-folder-input {
    flex: 1;
    min-width: 0;
    padding: 0.375rem 0.625rem;
    font-size: 0.8rem;
  }

  /* Autosave indicator to the right of title input (mono, 1.5s fadeout on save success) */
  .title-input-wrap {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    min-width: 0;
  }
  .title-input-wrap input {
    flex: 1;
    min-width: 0;
  }
  .save-indicator {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 0.625rem;
    letter-spacing: 0.08em;
    color: var(--text-muted, var(--text-secondary));
    white-space: nowrap;
    animation: save-in 0.15s ease-out;
  }
  @keyframes save-in {
    from { opacity: 0; transform: translateX(-4px); }
    to   { opacity: 1; transform: none; }
  }

  .new-folder-actions {
    display: flex;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .description-label {
    align-self: flex-start;
    margin-top: 0.5rem;
  }

  textarea {
    resize: vertical;
  }

</style>
