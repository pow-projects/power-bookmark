<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { Bookmark } from '../../../lib/db';
  import type { HealthCheckResult } from '../../../lib/health/health-checker';
  import Icon from '../../shared/Icon.svelte';
  import Spinner from '../../shared/Spinner.svelte';
  import AiTaskBadge from '../AiTaskBadge.svelte';
  import CardBadges from './CardBadges.svelte';
  import { setBookmarkDragImage } from '../../../lib/bookmarks/drag-helper';
  import { formatDate } from '../../../lib/ui/date-formatter';

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
  }>();

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

  function handleCardClick(e: MouseEvent) {
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

  $: formattedDate = formatDate(bookmark.createdAt);
</script>

<div
  class="bookmark-card {selected ? 'selected' : ''} {isDead ? 'dead-bookmark' : ''} {isDraggingThis ? 'is-dragging' : ''}"
  class:selected
  class:is-dragging={isDraggingThis}
  class:deleting={isDeleting}
  draggable="true"
  on:dragstart={handleDragStart}
  on:dragend={handleDragEnd}
  on:click={handleCardClick}
  on:keydown={handleKeyDown}
  role="presentation"
>
  <div class="card-header">
    <div class="card-header-left">
      <input
        type="checkbox"
        class="card-checkbox"
        checked={selected}
        on:change={(e) => { if (bookmark.id !== undefined) dispatch('toggleSelect', { bookmarkId: bookmark.id, event: e }); }}
        on:click|stopPropagation
        aria-label={i18n.t('bookmarks.selectAria', { title: bookmark.title || i18n.t('common.bookmark') })}
      />
      <CardBadges section="header" {bookmark} on:openCrossRoot={() => dispatch('openCrossRoot', { bookmark })} />
    </div>

    {#if isScanning}
      <button type="button" class="btn-icon scan-spinner" title={i18n.t('bookmarks.scanStopTooltip')} on:click|stopPropagation={() => dispatch('stopScan')}>
        <Spinner size={16} variant="inline" />
      </button>
    {:else}
      <div class="card-header-actions">
        {#if bookmark.aiStatus === 'running' || bookmark.aiStatus === 'pending'}
          <AiTaskBadge bookmarkId={bookmark.id} on:cancel={() => { if (bookmark.id !== undefined) dispatch('cancelAi', { bookmarkId: bookmark.id }); }} />
        {:else}
          <button
            type="button"
            class="btn-icon btn-icon-danger"
            title={i18n.t('bookmarks.card.delete')}
            on:click|stopPropagation={() => { if (!isDeleting && bookmark.id !== undefined) dispatch('delete', { bookmarkId: bookmark.id }); }}
            disabled={isDeleting}
            aria-label={i18n.t('bookmarks.card.delete')}
          >
            {#if isDeleting}
              <Spinner size={13} variant="inline" />
            {:else}
              <Icon name="trash-2" size={15} />
            {/if}
          </button>
        {/if}
      </div>
    {/if}
  </div>

  <h4 class="bookmark-title" title={bookmark.title}>{bookmark.title}</h4>

  <a
    href={bookmark.url}
    target="_blank"
    rel="noreferrer"
    class="bookmark-link {isDead ? 'dead-link' : ''}"
    on:click|stopPropagation={(e) => { e.preventDefault(); dispatch('openUrl', { url: bookmark.url }); }}
  >
    {bookmark.url}
  </a>

  <CardBadges
    section="body"
    {bookmark}
    {healthResult}
    {isDead}
    {isSessionOk}
    on:retryAi={() => dispatch('retryAi', { bookmark })}
    on:clearHealthError={() => dispatch('clearHealthError', { bookmark })}
  />

  <p class="bookmark-desc">{bookmark.description || i18n.t('bookmarks.card.noDescription')}</p>

  {#if bookmark.tags && bookmark.tags.length > 0}
    <div class="card-tags">
      {#each bookmark.tags as tag}
        <button
          type="button"
          class="tag-chip"
          on:click|stopPropagation={() => dispatch('selectTag', { tag })}
          aria-label={`#${tag}`}
        >
          #{tag}
        </button>
      {/each}
    </div>
  {/if}

  <div class="card-footer">
    <div class="card-footer-left">
      {#if formattedDate}
        <span class="card-date font-mono" title={i18n.t('bookmarks.card.createdDate')}>{formattedDate}</span>
      {/if}
      <CardBadges section="footer" {bookmark} />
    </div>

    <div class="card-actions footer-actions">
      {#if hasArchive}
        <button
          type="button"
          class="btn btn-accent btn-sm card-action-btn"
          title={isArchivedInCloud && !isArchivedLocally ? i18n.t('bookmarks.card.cloudArchiveTooltip') : i18n.t('bookmarks.card.viewArchive')}
          on:click|stopPropagation={() => dispatch('openArchive', { bookmark })}
          disabled={openingArchive || isDownloadingArchive}
        >
          {#if openingArchive || isDownloadingArchive}
            <Spinner size={12} variant="inline" />
          {:else if isArchivedInCloud && !isArchivedLocally}
            <Icon name="cloud" size={13} />
          {:else}
            <Icon name="archive" size={13} />
          {/if}
          <span>{i18n.t('bookmarks.card.viewArchive')}</span>
        </button>
      {:else}
        <button
          type="button"
          class="btn btn-secondary btn-sm card-action-btn"
          title={i18n.t('bookmarks.card.saveArchive')}
          on:click|stopPropagation={() => dispatch('saveArchive', { bookmark })}
          disabled={savingArchive}
        >
          {#if savingArchive}
            <Spinner size={12} variant="inline" />
            <span>{i18n.t('archive.saving')}</span>
          {:else}
            <Icon name="download" size={13} />
            <span>{i18n.t('bookmarks.card.saveArchive')}</span>
          {/if}
        </button>
      {/if}

      <button type="button" class="btn btn-secondary btn-sm card-action-btn" title={i18n.t('bookmarks.card.edit')} on:click|stopPropagation={() => dispatch('edit', { bookmark })}>
        <Icon name="edit-2" size={13} />
        <span>{i18n.t('bookmarks.card.edit')}</span>
      </button>
    </div>
  </div>
</div>

<style>
  .bookmark-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    padding: var(--card-padding-md);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    position: relative;
    cursor: pointer;
    transition: transform var(--transition-fast), box-shadow var(--transition-fast), border-color var(--transition-fast);
    box-sizing: border-box;
  }
  .bookmark-card:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-md);
    border-color: var(--color-primary-light);
  }
  .bookmark-card.selected {
    border-color: var(--color-primary);
    background: var(--bg-surface-glass);
    box-shadow: 0 0 0 2px var(--color-primary-light);
  }
  .bookmark-card.is-dragging {
    opacity: 0.45;
    border-style: dashed;
    border-color: var(--color-primary);
  }
  .bookmark-card.deleting {
    opacity: 0.6;
    pointer-events: none;
  }
  .bookmark-card.dead-bookmark {
    opacity: 0.85;
    border-color: rgba(214, 69, 61, 0.4);
  }
  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
  }
  .card-header-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    overflow: hidden;
  }
  .card-checkbox { cursor: pointer; margin: 0; }
  .bookmark-title {
    margin: 0;
    font-family: var(--font-primary);
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text-primary);
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .bookmark-link {
    font-size: 0.75rem;
    font-family: var(--font-mono);
    color: var(--color-primary);
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: block;
  }
  .bookmark-link:hover { text-decoration: underline; }
  .bookmark-link.dead-link { color: var(--color-danger); text-decoration: line-through; }
  .bookmark-desc {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    line-height: 1.45;
    flex-grow: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
  }
  .card-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.25rem;
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
    transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
  }
  .tag-chip:hover {
    color: var(--color-primary);
    background: var(--bg-secondary);
    border-color: var(--color-primary-light);
  }
  .card-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border-color);
  }
  .card-footer-left {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
  }
  .card-date {
    font-size: 0.75rem;
    font-family: var(--font-mono);
    color: var(--text-muted);
    white-space: nowrap;
    user-select: none;
    line-height: 1.2;
  }
  .footer-actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
</style>
