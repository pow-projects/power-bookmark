<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { Bookmark } from '../../../lib/db';
  import { isBookmarkBroken, type HealthCheckResult } from '../../../lib/health/health-checker';
  import Icon from '../../shared/Icon.svelte';

  export let section: 'header' | 'body' | 'footer';
  export let bookmark: Bookmark;
  export let healthResult: HealthCheckResult | undefined = undefined;
  export let isDead: boolean = false;
  export let isSessionOk: boolean = false;

  const dispatch = createEventDispatcher<{
    openCrossRoot: void;
    retryAi: void;
    clearHealthError: void;
  }>();

  $: statusNum = healthResult?.httpStatus || bookmark.httpStatus;
  $: hasConnectionError = isBookmarkBroken(bookmark, healthResult);

  function parseFolder(path?: string): { parentPath: string; leafName: string; hasParent: boolean } {
    if (!path) return { parentPath: '', leafName: '', hasParent: false };
    const trimmed = path.trim().replace(/\/+$/, '');
    const lastSlash = trimmed.lastIndexOf('/');
    if (lastSlash === -1) {
      return { parentPath: '', leafName: trimmed, hasParent: false };
    }
    return {
      parentPath: trimmed.slice(0, lastSlash),
      leafName: trimmed.slice(lastSlash + 1),
      hasParent: true
    };
  }

  $: folderInfo = parseFolder(bookmark.folderPath);
</script>

{#if section === 'header'}
  {#if bookmark.folderPath}
    <span class="folder-badge" class:has-hierarchy={folderInfo.hasParent} title={bookmark.folderPath}>
      <Icon name="folder" size={11} />
      <span class="folder-badge-content">
        {#if folderInfo.hasParent}
          <span class="folder-path-prefix">{folderInfo.parentPath}/</span>
        {/if}
        <span class="folder-leaf-name">{folderInfo.leafName}</span>
      </span>
    </span>
  {/if}
  {#if bookmark.crossRootReview}
    <button
      type="button"
      class="stamp-badge stamp-badge--cross-root clickable-stamp"
      title={i18n.t('folders.crossRoot.pendingBadge')}
      on:click|stopPropagation={() => dispatch('openCrossRoot')}
    >
      <Icon name="folder-plus" size={10} />
      <span>{i18n.t('folders.crossRoot.pendingBadge')}</span>
    </button>
  {/if}
{:else if section === 'body'}
  {#if hasConnectionError}
    <div class="connection-error-badge" title={statusNum ? i18n.t('bookmarks.connectionError', { status: statusNum }) : i18n.t('bookmarks.connectionErrorShort')}>
      <span class="error-badge-text">
        <Icon name="alert-circle" size={12} />
        {#if statusNum}
          {i18n.t('common.error')}: {statusNum}
        {:else if healthResult?.status === 'timeout'}
          {i18n.t('common.error')}: Timeout
        {:else}
          {i18n.t('common.error')}
        {/if}
      </span>
      <button
        type="button"
        class="error-dismiss-btn"
        title={i18n.t('bookmarks.clearHealthError')}
        aria-label={i18n.t('bookmarks.clearHealthError')}
        on:click|stopPropagation={() => dispatch('clearHealthError')}
      >
        <Icon name="x" size={10} />
      </button>
    </div>
  {/if}

  {#if isSessionOk && !isDead}
    <span class="ok-check" title={i18n.t('common.success')}><Icon name="check" size={14} /></span>
  {/if}

  {#if bookmark.aiStatus === 'error'}
    <button
      type="button"
      class="ai-error-badge retryable"
      title={i18n.t('common.retry')}
      on:click|stopPropagation={() => dispatch('retryAi')}
    >
      <Icon name="alert-circle" size={12} />
      <span>{i18n.t('ai.analysisFailed')} ({i18n.t('common.retry')})</span>
    </button>
  {/if}
{:else if section === 'footer'}
  <div class="footer-badges">
    {#if bookmark.crossRootReview}
      <span class="badge-cross-root">{i18n.t('folders.crossRoot.pendingBadge')}</span>
    {/if}
  </div>
{/if}

<style>
  .folder-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.6875rem;
    color: var(--text-secondary);
    background: var(--bg-tertiary);
    padding: 0.125rem 0.375rem;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    max-width: 140px;
    cursor: default;
    user-select: none;
    transition: max-width var(--transition-normal, 0.25s cubic-bezier(0.4, 0, 0.2, 1)),
                background var(--transition-fast, 0.15s ease),
                border-color var(--transition-fast, 0.15s ease),
                color var(--transition-fast, 0.15s ease),
                box-shadow var(--transition-fast, 0.15s ease);
  }
  .folder-badge-content {
    display: inline-flex;
    align-items: center;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .folder-path-prefix {
    display: inline-block;
    max-width: 0;
    opacity: 0;
    overflow: hidden;
    white-space: nowrap;
    color: var(--text-tertiary, #94a3b8);
    transition: max-width var(--transition-normal, 0.25s cubic-bezier(0.4, 0, 0.2, 1)),
                opacity var(--transition-fast, 0.15s ease);
    pointer-events: none;
  }
  .folder-leaf-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .folder-badge:hover {
    max-width: 320px;
    background: var(--bg-surface-glass, var(--bg-secondary));
    border-color: var(--border-color);
    color: var(--text-primary);
    box-shadow: var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.05));
    z-index: 2;
  }
  .folder-badge:hover .folder-path-prefix {
    max-width: 240px;
    opacity: 0.85;
  }
  .clickable-stamp {
    cursor: pointer;
    border: none;
  }
  .connection-error-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.7rem;
    color: var(--color-danger);
    background: var(--color-primary-light);
    padding: 0.125rem 0.375rem;
    border-radius: var(--radius-sm);
    width: fit-content;
    position: relative;
    user-select: none;
    transition: background var(--transition-fast, 0.15s ease);
  }
  .error-badge-text {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  .error-dismiss-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    color: var(--color-danger);
    cursor: pointer;
    padding: 0.05rem;
    margin-left: 0.125rem;
    border-radius: var(--radius-xs, 2px);
    opacity: 0;
    width: 0;
    max-width: 0;
    overflow: hidden;
    pointer-events: none;
    transition: opacity var(--transition-fast, 0.15s ease),
                max-width var(--transition-fast, 0.15s ease),
                width var(--transition-fast, 0.15s ease),
                background var(--transition-fast, 0.15s ease);
  }
  .connection-error-badge:hover .error-dismiss-btn,
  .error-dismiss-btn:focus-visible {
    opacity: 0.85;
    width: 14px;
    max-width: 14px;
    pointer-events: auto;
  }
  .error-dismiss-btn:hover {
    opacity: 1;
    background: rgba(214, 69, 61, 0.15);
  }
  .ok-check {
    position: absolute;
    top: 0.5rem;
    right: 2.25rem;
    color: var(--color-success);
  }
  .ai-error-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.7rem;
    color: var(--color-danger);
    background: var(--color-primary-light);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-sm);
    padding: 0.25rem 0.5rem;
    cursor: pointer;
    text-align: left;
  }
  .footer-badges {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }
</style>
