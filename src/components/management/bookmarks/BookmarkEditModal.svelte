<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import type { Bookmark } from '../../../lib/db';
  import type { FolderNode } from '../../../lib/bookmarks/bookmark-manager';
  import { BookmarkManager } from '../../../lib/bookmarks/bookmark-manager';
  import { analyzeContent, isAiConfigured } from '../../../lib/ai/ai-summarizer';
  import { isNoBodyText } from '../../../lib/ai/types';
  import { buildPagePayload } from '../../../lib/ai/ai-bulk-analyzer';
  import { showToast } from '../../../lib/ui/toast-store';
  import { sanitizeTags } from '../../../lib/bookmarks/tag-utils';
  import Modal from '../../shared/Modal.svelte';
  import FolderSelect from '../../shared/FolderSelect.svelte';
  import Icon from '../../shared/Icon.svelte';
  import Spinner from '../../shared/Spinner.svelte';

  export let open: boolean = false;
  export let bookmark: Bookmark | null = null;
  export let folders: FolderNode[] = [];

  const dispatch = createEventDispatcher<{
    saved: { bookmark: Bookmark; folderId?: string; folderPath?: string; tags?: string[] };
    close: void;
  }>();

  let editTitle = '';
  let editUrl = '';
  let editFolderId = '';
  let editDescription = '';
  let editTagsString = '';
  let showNewFolderInput = false;
  let newFolderName = '';
  let isGeneratingSummary = false;
  let isSaving = false;
  let editSummaryAbort: AbortController | null = null;

  onDestroy(() => {
    if (editSummaryAbort) {
      editSummaryAbort.abort();
      editSummaryAbort = null;
    }
  });

  let prevBookmarkId: number | string | undefined = undefined;
  let prevOpen = false;

  $: if (open && bookmark && (bookmark.id !== prevBookmarkId || !prevOpen)) {
    prevBookmarkId = bookmark.id;
    prevOpen = true;
    editTitle = bookmark.title || '';
    editUrl = bookmark.url || '';
    const currentFolder = folders.find((f) => f.path === bookmark.folderPath);
    editFolderId = currentFolder ? currentFolder.id : '';
    editDescription = bookmark.description || '';
    editTagsString = bookmark.tags && bookmark.tags.length > 0 ? bookmark.tags.join(', ') : '';
    showNewFolderInput = false;
    newFolderName = '';
  }

  $: if (!open) {
    prevOpen = false;
  }

  $: parsedTagsPreview = sanitizeTags(editTagsString.split(','));

  function handleClose() {
    if (isSaving) return;
    if (editSummaryAbort) {
      editSummaryAbort.abort();
      editSummaryAbort = null;
    }
    dispatch('close');
  }

  async function handleCreateFolder() {
    if (!newFolderName.trim()) return;
    try {
      const created = await BookmarkManager.createFolder(newFolderName.trim(), editFolderId || undefined);
      newFolderName = '';
      showNewFolderInput = false;
      if (created && !folders.some((f) => f.id === created.id)) {
        folders = [...folders, created];
      }
      editFolderId = created.id;
      showToast(i18n.t('folders.created'), 'success');
      document.dispatchEvent(new CustomEvent('bookmarks-updated'));
    } catch (e: any) {
      showToast(i18n.t('folders.createFailed', { error: e.message }), 'error');
    }
  }

  async function handleGenerateSummary() {
    if (!bookmark || isGeneratingSummary) return;
    if (!(await isAiConfigured())) {
      showToast(i18n.t('ai.configFirst'), 'info');
      return;
    }

    isGeneratingSummary = true;
    const abort = new AbortController();
    editSummaryAbort = abort;
    try {
      showToast(i18n.t('ai.summarizingToast'), 'info');
      const pagePayload = await buildPagePayload({
        ...bookmark,
        title: editTitle || bookmark.title,
        description: editDescription
      });

      const result = await analyzeContent(pagePayload, folders, abort.signal, 'summary');
      if (abort.signal.aborted) return;

      if (result && result.summary && !isNoBodyText(result.summary)) {
        editDescription = result.summary;
        showToast(i18n.t('ai.summarySuccess'), 'success');
      } else {
        showToast(i18n.t('ai.noBodyText'), 'warning');
      }
    } catch (e: any) {
      if (abort.signal.aborted) return;
      showToast(i18n.t('ai.requestFailed', { error: e?.message || 'Unknown error' }), 'error');
    } finally {
      if (editSummaryAbort === abort) editSummaryAbort = null;
      isGeneratingSummary = false;
    }
  }

  function handleSave() {
    if (!bookmark) return;

    const trimmedTitle = editTitle.trim();
    const trimmedUrl = editUrl.trim();

    if (!trimmedTitle) {
      showToast(i18n.t('popup.form.titleRequired'), 'warning');
      return;
    }

    if (trimmedUrl) {
      try {
        new URL(trimmedUrl);
      } catch {
        showToast(i18n.t('popup.form.invalidUrl'), 'warning');
        return;
      }
    }

    isSaving = true;
    const targetFolder = folders.find((f) => f.id === editFolderId);
    const targetFolderPath = targetFolder ? targetFolder.path : '';

    const parsedTags = sanitizeTags(editTagsString.split(','));

    dispatch('saved', {
      bookmark: {
        ...bookmark,
        title: trimmedTitle,
        url: trimmedUrl || bookmark.url,
        description: editDescription,
        tags: parsedTags
      },
      folderId: editFolderId,
      folderPath: targetFolderPath,
      tags: parsedTags
    });
    isSaving = false;
  }
</script>

<Modal {open} title={i18n.t('bookmarkEditModal.title')} size="md" on:close={handleClose}>
  <div slot="header" class="modal-header-left">
    <div class="modal-icon-badge">
      <Icon name="edit" size={16} />
    </div>
    <h4 class="modal-title">{i18n.t('bookmarkEditModal.title')}</h4>
  </div>

  <div class="edit-modal edit-modal-form">
    <div class="form-group">
      <label for="edit-title">{i18n.t('bookmarkEditModal.titleLabel')} <span class="required-mark">*</span></label>
      <input
        type="text"
        id="edit-title"
        class="form-control form-input"
        bind:value={editTitle}
        placeholder={i18n.t('bookmarkEditModal.titlePlaceholder')}
        required
      />
    </div>

    <div class="form-group">
      <label for="edit-url">URL</label>
      <input
        type="url"
        id="edit-url"
        class="form-control form-input font-mono"
        bind:value={editUrl}
        placeholder={i18n.t('bookmarkEditModal.urlPlaceholder')}
      />
    </div>

    <div class="form-group">
      <div class="folder-label-row">
        <label for="folder-select">{i18n.t('bookmarkEditModal.folderLabel')}</label>
        <button
          type="button"
          class="btn-text"
          on:click={() => (showNewFolderInput = !showNewFolderInput)}
        >
          {showNewFolderInput ? i18n.t('common.cancel') : i18n.t('bookmarkEditModal.newFolderBtn')}
        </button>
      </div>

      {#if showNewFolderInput}
        <div class="new-folder-input-row">
          <input
            type="text"
            class="form-control form-input"
            bind:value={newFolderName}
            placeholder={i18n.t('bookmarkEditModal.newFolderPlaceholder')}
            on:keydown={(e) => e.key === 'Enter' && handleCreateFolder()}
          />
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            on:click={handleCreateFolder}
            disabled={!newFolderName.trim()}
          >
            {i18n.t('common.create')}
          </button>
        </div>
      {/if}

      <FolderSelect
        {folders}
        bind:value={editFolderId}
        allowRoot={true}
        rootLabel={i18n.t('folders.rootFolder')}
        placeholder={i18n.t('popup.form.folderSelect')}
      />
    </div>

    <div class="form-group">
      <label for="edit-tags">{i18n.t('bookmarkEditModal.tagsLabel')}</label>
      <input
        type="text"
        id="edit-tags"
        class="form-control form-input"
        bind:value={editTagsString}
        placeholder={i18n.t('bookmarkEditModal.tagsPlaceholder')}
      />
      {#if parsedTagsPreview.length > 0}
        <div class="tags-preview">
          {#each parsedTagsPreview as tag}
            <span class="tag-badge">#{tag}</span>
          {/each}
        </div>
      {/if}
    </div>

    <div class="form-group">
      <div class="desc-label-row">
        <label for="edit-desc">{i18n.t('bookmarkEditModal.descLabel')}</label>
        <button
          type="button"
          class="btn btn-secondary btn-xs btn-outline-ai"
          on:click={handleGenerateSummary}
          disabled={isGeneratingSummary}
          title={i18n.t('bookmarkEditModal.generateAiSummary')}
        >
          {#if isGeneratingSummary}
            <Spinner size={12} variant="inline" />
            <span>{i18n.t('common.loading')}</span>
          {:else}
            <Icon name="sparkles" size={12} />
            <span>{i18n.t('bookmarkEditModal.generateAiSummary')}</span>
          {/if}
        </button>
      </div>
      <textarea
        id="edit-desc"
        class="form-control form-textarea font-mono"
        rows="4"
        bind:value={editDescription}
        placeholder={i18n.t('bookmarkEditModal.descPlaceholder')}
      ></textarea>
    </div>
  </div>

  <div slot="footer" class="modal-actions">
    <button type="button" class="btn btn-secondary" on:click={handleClose} disabled={isSaving}>
      {i18n.t('common.cancel')}
    </button>
    <button type="button" class="btn btn-primary" on:click={handleSave} disabled={isSaving}>
      {#if isSaving}
        <Spinner size={14} variant="inline" />
        <span>{i18n.t('common.loading')}</span>
      {:else}
        <span>{i18n.t('common.save')}</span>
      {/if}
    </button>
  </div>
</Modal>

<style>
  .modal-header-left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .modal-icon-badge {
    color: var(--color-primary);
    background: var(--color-primary-light);
    padding: 0.5rem;
    border-radius: var(--radius-md);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .modal-title {
    margin: 0;
    font-family: var(--font-accent);
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .edit-modal-form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .form-group label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .form-input,
  .form-control,
  .form-textarea {
    width: 100%;
    box-sizing: border-box;
    background-color: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: 0.625rem 0.875rem;
    font-size: 0.875rem;
    font-family: var(--font-primary);
    outline: none;
    transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  }

  .form-input:focus,
  .form-control:focus,
  .form-textarea:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px var(--color-primary-light);
  }

  .form-input::placeholder,
  .form-control::placeholder,
  .form-textarea::placeholder {
    color: var(--text-muted);
  }

  .form-textarea {
    font-family: var(--font-primary);
    resize: vertical;
    min-height: 5.5rem;
    line-height: 1.5;
  }

  .font-mono {
    font-family: var(--font-mono) !important;
  }

  .required-mark {
    color: var(--color-primary);
    font-weight: bold;
    margin-left: 0.2rem;
  }

  .folder-label-row,
  .desc-label-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .new-folder-input-row {
    display: flex;
    align-items: stretch;
    gap: 0.5rem;
    margin-bottom: 0.375rem;
  }

  .new-folder-input-row .form-input,
  .new-folder-input-row .form-control {
    flex-grow: 1;
  }

  .tags-preview {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin-top: 0.25rem;
  }

  .tag-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.125rem 0.5rem;
    background-color: var(--bg-tertiary);
    color: var(--color-primary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    font-family: var(--font-mono);
    font-weight: 500;
  }

  .btn-outline-ai {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.25rem 0.625rem;
    border-radius: var(--radius-sm);
    background: var(--color-primary-light);
    color: var(--color-primary);
    border: 1px solid rgba(214, 69, 61, 0.25);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .btn-outline-ai:hover:not(:disabled) {
    background: var(--color-primary);
    color: var(--color-on-primary);
  }

  .btn-outline-ai:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-text {
    background: none;
    border: none;
    padding: 0;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-primary);
    cursor: pointer;
    transition: color var(--transition-fast);
  }

  .btn-text:hover {
    color: var(--color-primary-hover);
    text-decoration: underline;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
  }
</style>
