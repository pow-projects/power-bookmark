<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Icon from '../shared/Icon.svelte';
  import Modal from '../shared/Modal.svelte';

  export interface CrossRootItem {
    bookmarkId: number;
    browserBookmarkId?: string;
    title: string;
    url: string;
    currentFolderPath: string;
    currentRoot: string;
    suggestedFolderId?: string;
    suggestedFolderPath?: string;
    suggestedRoot: string;
    cleanPath: string;
  }

  export let isOpen: boolean = false;
  export let open: boolean = false;
  export let items: CrossRootItem[] = [];

  $: isVisible = isOpen || open;

  const dispatch = createEventDispatcher<{
    close: void;
    apply: {
      results: Array<{
        bookmarkId: number;
        action: 'create-here' | 'move-recommended' | 'skip';
        cleanPath: string;
        targetFolderId?: string;
        targetRoot: string;
        currentRoot: string;
      }>;
    };
  }>();

  let choices: Record<number, 'create-here' | 'move-recommended' | 'skip'> = {};

  // Initialize default value ('move-recommended') when items change or modal opens
  $: {
    if (items && items.length > 0) {
      let updated = false;
      for (const item of items) {
        if (!choices[item.bookmarkId]) {
          choices[item.bookmarkId] = 'move-recommended';
          updated = true;
        }
      }
      if (updated) {
        choices = { ...choices };
      }
    }
  }

  function setAll(action: 'create-here' | 'move-recommended' | 'skip') {
    for (const item of items) {
      choices[item.bookmarkId] = action;
    }
    choices = { ...choices };
  }

  function selectChoice(bookmarkId: number, action: 'create-here' | 'move-recommended' | 'skip') {
    choices[bookmarkId] = action;
    choices = { ...choices };
  }

  function handleClose() {
    dispatch('close');
  }

  function handleApply() {
    const results = items.map(item => ({
      bookmarkId: item.bookmarkId,
      action: choices[item.bookmarkId] || 'move-recommended',
      cleanPath: item.cleanPath,
      targetFolderId: item.suggestedFolderId,
      targetRoot: item.suggestedRoot,
      currentRoot: item.currentRoot
    }));
    dispatch('apply', { results });
  }

  function formatRootBadge(root?: string): string {
    if (!root) return i18n.t('folders.rootFolder');
    const lower = root.toLowerCase();
    if (lower.includes('bar')) return i18n.t('folders.crossRoot.roots.bar');
    if (lower.includes('other')) return i18n.t('folders.crossRoot.roots.other');
    if (lower.includes('mobile')) return i18n.t('folders.crossRoot.roots.mobile');
    return `[${root}]`;
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && isVisible) {
      handleClose();
    }
  }
</script>

<Modal open={isVisible} size="lg" on:close={handleClose}>
  <div slot="header" class="modal-header-info">
    <div class="modal-icon-badge">
      <Icon name="folder-plus" size={18} />
    </div>
    <div>
      <h2 id="cross-root-modal-title">{i18n.t('folders.crossRoot.modalTitle')}</h2>
      <span class="header-count-tag font-mono">{i18n.t('folders.crossRoot.pendingCount', { count: items.length })}</span>
    </div>
  </div>

      <!-- Description Banner -->
      <div class="modal-intro">
        <p>
          {i18n.t('folders.crossRoot.intro')}
        </p>
      </div>

      <!-- Quick Global Batch Selection -->
      <div class="modal-actions-top">
        <span class="quick-select-label">{i18n.t('folders.crossRoot.quickSelect')}:</span>
        <div class="bulk-actions">
          <button type="button" class="btn btn-secondary btn-xs" on:click={() => setAll('create-here')}>
            <Icon name="folder-plus" size={12} /> {i18n.t('folders.crossRoot.allCreateHere')}
          </button>
          <button type="button" class="btn btn-secondary btn-xs" on:click={() => setAll('move-recommended')}>
            <Icon name="folder" size={12} /> {i18n.t('folders.crossRoot.allMoveRecommended')}
          </button>
          <button type="button" class="btn btn-secondary btn-xs" on:click={() => setAll('skip')}>
            <Icon name="x" size={12} /> {i18n.t('folders.crossRoot.allSkip')}
          </button>
        </div>
      </div>

      <!-- Item List -->
      <div class="items-list">
        {#each items as item (item.bookmarkId)}
          <div class="review-card">
            <div class="card-top-row">
              <div class="card-bookmark-meta">
                <h4 class="item-title" title={item.title}>{item.title}</h4>
                <a href={item.url} target="_blank" rel="noreferrer" class="item-url font-mono" title={item.url}>
                  {item.url}
                </a>
              </div>
            </div>

            <!-- Path Comparison Badges -->
            <div class="path-comparison">
              <div class="path-box current">
                <span class="path-label">{i18n.t('folders.crossRoot.currentLocation')}</span>
                <div class="path-badges">
                  <span class="stamp-badge badge-root">{formatRootBadge(item.currentRoot)}</span>
                  <span class="path-text font-mono">{item.currentFolderPath || i18n.t('folders.crossRoot.directRoot')}</span>
                </div>
              </div>

              <div class="path-arrow">
                <Icon name="chevron-right" size={16} />
              </div>

              <div class="path-box suggested">
                <span class="path-label">{i18n.t('folders.crossRoot.suggestedLocation')}</span>
                <div class="path-badges">
                  <span class="stamp-badge badge-root suggested">{formatRootBadge(item.suggestedRoot)}</span>
                  <span class="path-text font-mono highlight">{item.suggestedFolderPath || item.cleanPath}</span>
                </div>
              </div>
            </div>

            <!-- 3-Choice Selection -->
            <div class="choice-group">
              <!-- Choice 1: create-here -->
              <label class="choice-option {choices[item.bookmarkId] === 'create-here' ? 'selected' : ''}">
                <input
                  type="radio"
                  name="choice-{item.bookmarkId}"
                  value="create-here"
                  checked={choices[item.bookmarkId] === 'create-here'}
                  on:change={() => selectChoice(item.bookmarkId, 'create-here')}
                />
                <div class="choice-content">
                  <div class="choice-title">
                    <Icon name="folder-plus" size={14} />
                    <span>{i18n.t('folders.crossRoot.choiceCreateHere')}</span>
                  </div>
                  <div class="choice-desc">
                    {i18n.t('folders.crossRoot.choiceCreateHereDesc', { root: formatRootBadge(item.currentRoot), path: item.cleanPath })}
                  </div>
                </div>
              </label>

              <!-- Choice 2: move-recommended -->
              <label class="choice-option {choices[item.bookmarkId] === 'move-recommended' ? 'selected' : ''}">
                <input
                  type="radio"
                  name="choice-{item.bookmarkId}"
                  value="move-recommended"
                  checked={choices[item.bookmarkId] === 'move-recommended'}
                  on:change={() => selectChoice(item.bookmarkId, 'move-recommended')}
                />
                <div class="choice-content">
                  <div class="choice-title">
                    <Icon name="folder" size={14} />
                    <span>{i18n.t('folders.crossRoot.choiceMoveRecommended')}</span>
                    {#if choices[item.bookmarkId] === 'move-recommended'}
                      <span class="badge-default font-mono">{i18n.t('folders.crossRoot.defaultBadge')}</span>
                    {/if}
                  </div>
                  <div class="choice-desc">
                    {i18n.t('folders.crossRoot.choiceMoveRecommendedDesc', { root: formatRootBadge(item.suggestedRoot), path: item.suggestedFolderPath || item.cleanPath })}
                  </div>
                </div>
              </label>

              <!-- Choice 3: skip -->
              <label class="choice-option {choices[item.bookmarkId] === 'skip' ? 'selected' : ''}">
                <input
                  type="radio"
                  name="choice-{item.bookmarkId}"
                  value="skip"
                  checked={choices[item.bookmarkId] === 'skip'}
                  on:change={() => selectChoice(item.bookmarkId, 'skip')}
                />
                <div class="choice-content">
                  <div class="choice-title">
                    <Icon name="x" size={14} />
                    <span>{i18n.t('folders.crossRoot.choiceSkip')}</span>
                  </div>
                  <div class="choice-desc">
                    {i18n.t('folders.crossRoot.choiceSkipDesc')}
                  </div>
                </div>
              </label>
            </div>
          </div>
        {/each}
      </div>

      <!-- Modal Footer -->
      <div slot="footer" class="modal-actions">
        <button type="button" class="btn btn-secondary" on:click={handleClose}>
          {i18n.t('common.cancel')}
        </button>
        <button type="button" class="btn btn-primary" on:click={handleApply}>
          <Icon name="check" size={14} /> {i18n.t('folders.crossRoot.apply')}
        </button>
      </div>
</Modal>

<style>
  .modal-header-info {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .modal-icon-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.5rem;
    border-radius: var(--radius-md);
    background: var(--color-primary-light);
    color: var(--color-primary);
    flex-shrink: 0;
  }

  .modal-header-info h2 {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
    font-family: var(--font-accent);
    color: var(--text-primary);
  }

  .header-count-tag {
    font-size: 0.7rem;
    color: var(--text-secondary);
  }

  .modal-intro {
    padding: 0.85rem 1.5rem;
    background: var(--bg-primary);
    border-bottom: 1px solid var(--border-color);
  }

  .modal-intro p {
    margin: 0;
    font-size: 0.825rem;
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .modal-actions-top {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.65rem 1.5rem;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-secondary);
    flex-wrap: wrap;
  }

  .quick-select-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .bulk-actions {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .items-list {
    flex: 1;
    overflow-y: auto;
    padding: 1.25rem 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    background: var(--bg-primary);
  }

  .review-card {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: 1.1rem;
    background: var(--bg-secondary);
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    box-shadow: var(--shadow-sm);
  }

  .card-top-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .card-bookmark-meta {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
    flex: 1;
  }

  .item-title {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-url {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-url:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .path-comparison {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 0.85rem;
    border-radius: var(--radius-md);
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
  }

  .path-box {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .path-label {
    font-size: 0.68rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .path-badges {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .badge-root {
    font-size: 0.65rem;
    padding: 0.15rem 0.4rem;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
  }

  .badge-root.suggested {
    color: var(--color-primary);
    background: var(--color-primary-light);
    border-color: rgba(214, 69, 61, 0.3);
  }

  .path-text {
    font-size: 0.775rem;
    color: var(--text-primary);
    word-break: break-all;
  }

  .path-text.highlight {
    font-weight: 600;
    color: var(--color-primary);
  }

  .path-arrow {
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .choice-group {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }

  .choice-option {
    display: flex;
    align-items: flex-start;
    gap: 0.65rem;
    padding: 0.65rem 0.85rem;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--bg-secondary);
    cursor: pointer;
    transition: border-color var(--transition-fast), background-color var(--transition-fast);
  }

  .choice-option:hover {
    border-color: var(--text-muted);
  }

  .choice-option.selected {
    border-color: var(--color-primary);
    background: var(--color-primary-light);
  }

  .choice-option input[type="radio"] {
    margin-top: 0.2rem;
    cursor: pointer;
    accent-color: var(--color-primary);
  }

  .choice-content {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    flex: 1;
  }

  .choice-title {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.825rem;
    font-weight: 700;
    color: var(--text-primary);
  }

  .badge-default {
    font-size: 0.6rem;
    padding: 0.1rem 0.35rem;
    border-radius: var(--radius-sm);
    background: var(--color-primary);
    color: var(--color-on-primary);
    font-weight: 600;
  }

  .choice-desc {
    font-size: 0.75rem;
    color: var(--text-secondary);
    line-height: 1.35;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
  }

  .font-mono {
    font-family: var(--font-mono);
  }
</style>
