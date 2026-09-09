<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { Bookmark } from '../../../lib/db';
  import { isBookmarkBroken, type HealthCheckResult } from '../../../lib/health/health-checker';
  import Icon from '../../shared/Icon.svelte';
  import Spinner from '../../shared/Spinner.svelte';
  import Badge from '../../shared/Badge.svelte';
  import AiTaskBadge from '../AiTaskBadge.svelte';
  import { formatDate } from '../../../lib/ui/date-formatter';
  import { setBookmarkDragImage } from '../../../lib/bookmarks/drag-helper';

  export let bookmark: Bookmark;
  export let selected: boolean = false;
  export let hasArchive: boolean = false;
  export let isArchivedLocally: boolean = false;
  export let isArchivedInCloud: boolean = false;
  export let healthResult: HealthCheckResult | undefined = undefined;
  export let isDead: boolean = false;
  export let isScanning: boolean = false;
  export let isSessionOk: boolean = false;
  export let openingArchive: boolean = false;
  export let isDownloadingArchive: boolean = false;
  export let savingArchive: boolean = false;
  export let selectedIds: Set<number> | undefined = undefined;
  export let isDeleting: boolean = false;

  let isDraggingThis = false;

  const dispatch = createEventDispatcher<{
    toggleSelect: { bookmarkId: number; event: MouseEvent | KeyboardEvent };
    openUrl: { url: string };
    openArchive: { bookmark: Bookmark };
    saveArchive: { bookmark: Bookmark };
    edit: { bookmark: Bookmark };
    delete: { bookmarkId: number };
    retryAi: { bookmark: Bookmark };
    cancelAi: { bookmarkId: number };
    clearHealthError: { bookmark: Bookmark };
    openCrossRoot: { bookmark: Bookmark };
    stopScan: void;
    selectTag: { tag: string };
    selectFolder: { folderPath: string };
  }>();

  $: domain = (() => {
    try {
      if (!bookmark.url) return '';
      const u = new URL(bookmark.url);
      return u.hostname;
    } catch {
      return '';
    }
  })();

  $: statusNum = healthResult?.httpStatus || bookmark.httpStatus;
  $: hasConnectionError = isBookmarkBroken(bookmark, healthResult);
  $: formattedDate = formatDate(bookmark.createdAt);

  function handleDragStart(e: DragEvent) {
    if (!bookmark.id || !e.dataTransfer) return;
    if (typeof window !== 'undefined' && (window.getSelection()?.toString().length ?? 0) > 0) {
      e.preventDefault();
      return;
    }

    const isMulti = selected && selectedIds && selectedIds.has(bookmark.id) && selectedIds.size > 1;
    const ids = isMulti ? Array.from(selectedIds!) : [bookmark.id];

    e.dataTransfer.setData('application/x-powerbookmark-ids', JSON.stringify(ids));
    e.dataTransfer.setData('text/plain', bookmark.url || bookmark.title || String(bookmark.id));
    e.dataTransfer.effectAllowed = 'move';
    isDraggingThis = true;

    setBookmarkDragImage(e, bookmark.title || bookmark.url || i18n.t('common.bookmark'), ids.length);
  }

  function handleDragEnd() {
    isDraggingThis = false;
  }

  function handleRowClick(e: MouseEvent) {
    if (typeof window !== 'undefined' && (window.getSelection()?.toString().length ?? 0) > 0) return;
    const target = e.target as HTMLElement;
    if (target.tagName !== 'A' && target.tagName !== 'BUTTON' && target.tagName !== 'INPUT' && !target.closest('button') && !target.closest('a')) {
      if (bookmark.id !== undefined) dispatch('toggleSelect', { bookmarkId: bookmark.id, event: e });
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === ' ' || e.key === 'Enter') {
      const target = e.target as HTMLElement;
      if (target.tagName !== 'A' && target.tagName !== 'BUTTON' && target.tagName !== 'INPUT' && !target.closest('button') && !target.closest('a')) {
        e.preventDefault();
        if (bookmark.id !== undefined) dispatch('toggleSelect', { bookmarkId: bookmark.id, event: e });
      }
    }
  }
</script>

<div
  class="bookmark-row {selected ? 'selected' : ''} {isDead ? 'dead-bookmark' : ''} {isDraggingThis ? 'is-dragging' : ''}"
  class:selected
  class:is-dragging={isDraggingThis}
  class:deleting={isDeleting}
  draggable="true"
  on:dragstart={handleDragStart}
  on:dragend={handleDragEnd}
  on:click={handleRowClick}
  on:keydown={handleKeyDown}
  role="row"
  tabindex="-1"
>
  <!-- Col 1: Checkbox -->
  <div class="col-checkbox">
    <input
      type="checkbox"
      class="row-checkbox"
      checked={selected}
      on:change={(e) => { if (bookmark.id !== undefined) dispatch('toggleSelect', { bookmarkId: bookmark.id, event: e }); }}
      on:click|stopPropagation
      aria-label={i18n.t('bookmarks.selectAria', { title: bookmark.title || i18n.t('common.bookmark') })}
    />
  </div>

  <!-- Col 2: Favicon -->
  <div class="col-icon">
    {#if domain}
      <img
        src={`https://www.google.com/s2/favicons?domain=${domain}&sz=32`}
        alt=""
        class="row-favicon"
        on:error={(e) => {
          const el = e.currentTarget;
          if (el) el.style.display = 'none';
        }}
      />
    {:else}
      <Icon name="bookmark" size={14} />
    {/if}
  </div>

  <!-- Col 3: Title & Domain/URL -->
  <div class="col-title">
    <div class="title-line">
      <a
        href={bookmark.url}
        target="_blank"
        rel="noreferrer"
        class="row-title {isDead ? 'dead-link' : ''}"
        title={bookmark.title}
        on:click|stopPropagation={(e) => { e.preventDefault(); dispatch('openUrl', { url: bookmark.url }); }}
      >
        {bookmark.title || bookmark.url}
      </a>
      {#if hasConnectionError}
        <span class="inline-error" title={statusNum ? i18n.t('bookmarks.connectionError', { status: statusNum }) : i18n.t('bookmarks.connectionErrorShort')}>
          <Icon name="alert-circle" size={11} />
          <span>{statusNum || '!'}</span>
          <button
            type="button"
            class="row-error-dismiss-btn"
            title={i18n.t('bookmarks.clearHealthError')}
            aria-label={i18n.t('bookmarks.clearHealthError')}
            on:click|stopPropagation={() => dispatch('clearHealthError', { bookmark })}
          >
            <Icon name="x" size={9} />
          </button>
        </span>
      {/if}
      {#if isSessionOk && !isDead}
        <span class="inline-ok" title={i18n.t('bookmarks.connectionOk')}>
          <Icon name="check" size={11} />
        </span>
      {/if}
    </div>
    <span class="row-url font-mono" title={bookmark.url}>{domain || bookmark.url}</span>
  </div>

  <!-- Col 4: Folder -->
  <div class="col-folder">
    {#if bookmark.folderPath}
      <button
        type="button"
        class="folder-chip"
        title={i18n.t('bookmarks.folderTooltip', { folder: bookmark.folderPath })}
        on:click|stopPropagation={() => dispatch('selectFolder', { folderPath: bookmark.folderPath })}
      >
        <Icon name="folder" size={11} />
        <span class="folder-chip-text">{bookmark.folderPath}</span>
      </button>
    {:else}
      <span class="empty-cell">-</span>
    {/if}
    {#if bookmark.crossRootReview}
      <button
        type="button"
        class="cross-root-stamp"
        title={i18n.t('bookmarks.crossRootTooltip')}
        on:click|stopPropagation={() => dispatch('openCrossRoot', { bookmark })}
      >
        <Icon name="folder-plus" size={10} />
      </button>
    {/if}
  </div>

  <!-- Col 5: Tags -->
  <div class="col-tags">
    {#if bookmark.tags && bookmark.tags.length > 0}
      {#each bookmark.tags.slice(0, 2) as tag}
        <button
          type="button"
          class="tag-chip"
          on:click|stopPropagation={() => dispatch('selectTag', { tag })}
          aria-label={i18n.t('bookmarks.tagFilterChipAria', { tag })}
        >
          #{tag}
        </button>
      {/each}
      {#if bookmark.tags.length > 2}
        <span class="tag-more" title={bookmark.tags.slice(2).map(t => `#${t}`).join(', ')}>
          +{bookmark.tags.length - 2}
        </span>
      {/if}
    {:else}
      <span class="empty-cell">-</span>
    {/if}
  </div>

  <!-- Col 6: Status / Archive / AI -->
  <div class="col-status">
    {#if isScanning}
      <button type="button" class="btn-icon-xs scan-spinner" title={i18n.t('bookmarks.scanStopTooltip')} on:click|stopPropagation={() => dispatch('stopScan')}>
        <Spinner size={13} variant="inline" />
      </button>
    {:else if bookmark.aiStatus === 'running' || bookmark.aiStatus === 'pending'}
      <AiTaskBadge bookmarkId={bookmark.id} on:cancel={() => { if (bookmark.id !== undefined) dispatch('cancelAi', { bookmarkId: bookmark.id }); }} />
    {:else if bookmark.aiStatus === 'error'}
      <button
        type="button"
        class="ai-error-btn"
        title={i18n.t('common.retry')}
        on:click|stopPropagation={() => dispatch('retryAi', { bookmark })}
      >
        <Icon name="alert-circle" size={11} />
        <span>{i18n.t('common.retry')}</span>
      </button>
    {:else if hasArchive}
      <Badge variant="success" size="sm">
        <Icon name="archive" size={10} />
        {isArchivedInCloud && !isArchivedLocally ? 'Cloud' : 'Archive'}
      </Badge>
    {/if}
  </div>

  <!-- Col 7: Date -->
  <div class="col-date font-mono">
    <span>{formattedDate || '-'}</span>
  </div>

  <!-- Col 8: Actions -->
  <div class="col-actions">
    <div class="action-buttons">
      {#if hasArchive}
        <button
          type="button"
          class="btn-icon-xs"
          title={isArchivedInCloud && !isArchivedLocally ? i18n.t('bookmarks.card.cloudArchiveTooltip') : i18n.t('bookmarks.card.viewArchive')}
          on:click|stopPropagation={() => dispatch('openArchive', { bookmark })}
          disabled={openingArchive || isDownloadingArchive}
          aria-label={i18n.t('bookmarks.card.viewArchive')}
        >
          {#if openingArchive || isDownloadingArchive}
            <Spinner size={12} variant="inline" />
          {:else if isArchivedInCloud && !isArchivedLocally}
            <Icon name="cloud" size={13} />
          {:else}
            <Icon name="archive" size={13} />
          {/if}
        </button>
      {:else}
        <button
          type="button"
          class="btn-icon-xs"
          title={i18n.t('bookmarks.card.saveArchive')}
          on:click|stopPropagation={() => dispatch('saveArchive', { bookmark })}
          disabled={savingArchive}
          aria-label={i18n.t('bookmarks.card.saveArchive')}
        >
          {#if savingArchive}
            <Spinner size={12} variant="inline" />
          {:else}
            <Icon name="download" size={13} />
          {/if}
        </button>
      {/if}

      <button
        type="button"
        class="btn-icon-xs"
        title={i18n.t('bookmarks.card.edit')}
        on:click|stopPropagation={() => dispatch('edit', { bookmark })}
        aria-label={i18n.t('bookmarks.card.edit')}
      >
        <Icon name="edit-2" size={13} />
      </button>

      <button
        type="button"
        class="btn-icon-xs btn-icon-danger"
        title={i18n.t('bookmarks.card.delete')}
        on:click|stopPropagation={() => { if (!isDeleting && bookmark.id !== undefined) dispatch('delete', { bookmarkId: bookmark.id }); }}
        disabled={isDeleting}
        aria-label={i18n.t('bookmarks.card.delete')}
      >
        {#if isDeleting}
          <Spinner size={12} variant="inline" />
        {:else}
          <Icon name="trash-2" size={13} />
        {/if}
      </button>
    </div>
  </div>
</div>

<style>
  .bookmark-row {
    display: grid;
    grid-template-columns: 32px 24px minmax(200px, 3fr) minmax(110px, 1.2fr) minmax(100px, 1fr) 110px 85px 96px;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.75rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    box-sizing: border-box;
    min-height: 48px;
    cursor: pointer;
    transition: background-color var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast);
    position: relative;
  }

  .bookmark-row:hover {
    background: var(--bg-tertiary);
    border-color: var(--color-primary-light);
  }

  .bookmark-row.selected {
    background: var(--bg-surface-glass);
    border-color: var(--color-primary);
    box-shadow: inset 3px 0 0 var(--color-primary);
  }

  .bookmark-row.is-dragging {
    opacity: 0.45;
    border-style: dashed;
    border-color: var(--color-primary);
  }

  .bookmark-row.deleting {
    opacity: 0.6;
    pointer-events: none;
  }

  .bookmark-row.dead-bookmark {
    opacity: 0.85;
    border-color: rgba(214, 69, 61, 0.4);
  }

  .col-checkbox { display: flex; align-items: center; justify-content: center; }
  .row-checkbox { cursor: pointer; margin: 0; }

  .col-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
  }
  .row-favicon {
    width: 16px;
    height: 16px;
    border-radius: 2px;
    object-fit: contain;
  }

  .col-title {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }

  .title-line {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
  }

  .row-title {
    font-family: var(--font-primary);
    font-size: 0.84375rem;
    font-weight: 600;
    color: var(--text-primary);
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 1.25;
  }
  .row-title:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }
  .row-title.dead-link {
    color: var(--color-danger);
    text-decoration: line-through;
  }

  .row-url {
    font-size: 0.6875rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 1.2;
  }

  .inline-error {
    display: inline-flex;
    align-items: center;
    gap: 0.15rem;
    font-size: 0.625rem;
    font-family: var(--font-mono);
    color: var(--color-danger);
    background: var(--color-primary-light);
    padding: 0 0.25rem;
    border-radius: var(--radius-sm);
    flex-shrink: 0;
    user-select: none;
    transition: background var(--transition-fast, 0.15s ease);
  }

  .row-error-dismiss-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    color: var(--color-danger);
    cursor: pointer;
    padding: 0;
    margin-left: 0.1rem;
    border-radius: var(--radius-xs, 2px);
    opacity: 0;
    width: 0;
    max-width: 0;
    overflow: hidden;
    pointer-events: none;
    transition: opacity var(--transition-fast, 0.15s ease),
                max-width var(--transition-fast, 0.15s ease),
                width var(--transition-fast, 0.15s ease);
  }

  .inline-error:hover .row-error-dismiss-btn,
  .row-error-dismiss-btn:focus-visible {
    opacity: 0.85;
    width: 12px;
    max-width: 12px;
    pointer-events: auto;
  }

  .row-error-dismiss-btn:hover {
    opacity: 1;
  }

  .inline-ok {
    display: inline-flex;
    align-items: center;
    color: var(--color-success);
    flex-shrink: 0;
  }

  .col-folder {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
  }

  .folder-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.6875rem;
    color: var(--text-secondary);
    background: var(--bg-tertiary);
    border: 1px solid transparent;
    padding: 0.125rem 0.375rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    max-width: 100%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    transition: color var(--transition-fast), border-color var(--transition-fast);
  }
  .folder-chip:hover {
    color: var(--color-primary);
    border-color: var(--color-primary-light);
  }
  .folder-chip-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cross-root-stamp {
    display: inline-flex;
    align-items: center;
    background: none;
    border: none;
    color: var(--color-warning);
    cursor: pointer;
    padding: 0;
  }

  .col-tags {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
    overflow: hidden;
  }

  .tag-chip {
    font-size: 0.6875rem;
    font-family: var(--font-mono);
    color: var(--text-muted);
    background: var(--bg-tertiary);
    padding: 0.125rem 0.375rem;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    cursor: pointer;
    line-height: 1.2;
    white-space: nowrap;
    flex-shrink: 0;
    transition: background-color var(--transition-fast), color var(--transition-fast);
  }
  .tag-chip:hover {
    color: var(--color-primary);
    background: var(--bg-secondary);
    border-color: var(--color-primary-light);
  }

  .tag-more {
    font-size: 0.625rem;
    font-family: var(--font-mono);
    color: var(--text-muted);
    padding: 0 0.2rem;
  }

  .col-status {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
  }

  .ai-error-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    font-size: 0.625rem;
    font-family: var(--font-mono);
    color: var(--color-danger);
    background: var(--color-primary-light);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-sm);
    padding: 0.1rem 0.3rem;
    cursor: pointer;
  }

  .col-date {
    font-size: 0.6875rem;
    color: var(--text-muted);
    text-align: right;
    white-space: nowrap;
  }

  .col-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
  }

  .action-buttons {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    opacity: 0.7;
    transition: opacity var(--transition-fast);
  }
  .bookmark-row:hover .action-buttons {
    opacity: 1;
  }

  .btn-icon-xs {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    cursor: pointer;
    transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
  }
  .btn-icon-xs:hover:not(:disabled) {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border-color: var(--border-focus);
  }
  .btn-icon-danger:hover:not(:disabled) {
    color: var(--color-danger);
    border-color: var(--color-danger);
    background: var(--color-primary-light);
  }

  .empty-cell {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  @media (max-width: 900px) {
    .bookmark-row {
      grid-template-columns: 32px 24px minmax(160px, 2fr) minmax(90px, 1fr) 90px 80px;
    }
    .col-tags, .col-date { display: none; }
  }
</style>
