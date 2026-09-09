<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { getPendingConflicts, resolveBatchConflicts, type ConflictLog, type UserAction } from '../../lib/sync/sync-conflict-store';
  import { SyncEngine } from '../../lib/sync/sync-engine';
  import { db, type Bookmark } from '../../lib/db';
  import { BookmarkManager } from '../../lib/bookmarks/bookmark-manager';
  import { normalizeUrl } from '../../lib/bookmarks/url-normalizer';
  import { getRootFolderName, normalizeFolderPath } from '../../lib/bookmarks/folder-utils';
  import { sameTags } from '../../lib/sync/merge';
  import Icon from '../shared/Icon.svelte';
  import Modal from '../shared/Modal.svelte';

  const dispatch = createEventDispatcher();
  let conflicts: ConflictLog[] = [];
  let choices: Record<string, UserAction> = {};
  let isProcessing = false;

  // Edit states
  let editingId: string | null = null;
  let editData = { title: '', url: '', description: '' };
  // Retain baseline tags/categories for manual-edit by log id
  let baselineTags: Record<string, { tags?: string[] }> = {};

  onMount(async () => {
    conflicts = await getPendingConflicts();
    for (const c of conflicts) {
      choices[c.id] = c.autoResolvedTo;
    }
    choices = { ...choices };
  });

  function close() {
    dispatch('close');
  }

  function selectChoice(id: string, action: UserAction) {
    choices[id] = action;
    choices = { ...choices };
  }

  function setAll(action: 'keep-local' | 'keep-cloud') {
    for (const c of conflicts) {
      choices[c.id] = action;
    }
    choices = { ...choices };
  }

  function getSyncId(version?: { syncId?: string; bookmarkId?: string }, fallbackBookmarkId?: string): string {
    if (!version) return fallbackBookmarkId || '-';
    return version.syncId || version.bookmarkId || fallbackBookmarkId || '-';
  }

  function isIdConflict(log: ConflictLog): boolean {
    const localSyncId = log.localVersion.syncId || log.bookmarkId;
    const cloudSyncId = log.cloudVersion.syncId || log.bookmarkId;
    return Boolean(localSyncId && cloudSyncId && localSyncId !== cloudSyncId && log.localVersion.url === log.cloudVersion.url);
  }

  function getTimeRelation(timeA?: number, timeB?: number): 'newer' | 'older' | 'equal' {
    if (!timeA || !timeB || timeA === timeB) return 'equal';
    return timeA > timeB ? 'newer' : 'older';
  }

  function formatDate(timestamp?: number): string {
    if (!timestamp) return '-';
    return new Date(timestamp).toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }

  function areTagsDifferent(tags1?: string[], tags2?: string[]): boolean {
    const t1 = tags1 || [];
    const t2 = tags2 || [];
    if (t1.length !== t2.length) return true;
    return t1.some((t, i) => t !== t2[i]);
  }

  function startEdit(log: ConflictLog) {
    editingId = log.id;
    const version = choices[log.id] === 'keep-local' ? log.localVersion : log.cloudVersion;
    editData = {
      title: version.title,
      url: version.url,
      description: version.description || ''
    };
    baselineTags[log.id] = {
      tags: version.tags
    };
    selectChoice(log.id, 'manual-edit');
  }

  function saveEdit() {
    if (editingId) {
      const log = conflicts.find(c => c.id === editingId);
      if (log) {
        log.localVersion = {
          ...log.localVersion,
          title: editData.title,
          url: editData.url,
          description: editData.description
        };
      }
      editingId = null;
    }
  }

  function cancelEdit() {
    if (editingId) {
      const log = conflicts.find(c => c.id === editingId);
      if (log) {
        selectChoice(editingId, log.autoResolvedTo);
      }
      delete baselineTags[editingId];
      editingId = null;
    }
  }

  async function applyAndSync() {
    isProcessing = true;
    BookmarkManager.setSyncMuted(true);
    try {
      // Phase 1: Pre-fetch local bookmarks and build indexed lookup maps
      const localBookmarks = await db.bookmarks.toArray();
      const bySyncId = new Map<string, Bookmark>();
      const byUrl = new Map<string, Bookmark>();
      for (const b of localBookmarks) {
        if (b.syncId) bySyncId.set(b.syncId, b);
        if (b.url) byUrl.set(normalizeUrl(b.url), b);
      }

      interface TargetUpdate {
        localId: number;
        bookmarkNodeId: string;
        updatePayload: Partial<Bookmark>;
        browserUpdate?: { title?: string; url?: string };
        targetFolderPath?: string;
        currentFolderPath?: string;
      }

      const updates: TargetUpdate[] = [];
      const folderMap = new Map<string, { id: string; path: string } | null>();

      for (const log of conflicts) {
        const action = choices[log.id];
        const targetSyncId = log.bookmarkId || log.localVersion?.syncId || log.cloudVersion?.syncId;
        const normLocalUrl = log.localVersion?.url ? normalizeUrl(log.localVersion.url) : '';
        const local = (targetSyncId ? bySyncId.get(targetSyncId) : null) ||
                      (normLocalUrl ? byUrl.get(normLocalUrl) : null);

        if (local && local.id !== undefined) {
          const unifiedSyncId = log.cloudVersion?.syncId || log.localVersion?.syncId || local.syncId;
          let newTitle = local.title;
          let newUrl = local.url;
          let newDesc = local.description;
          let newFolder = local.folderPath;
          let newTags = local.tags;

          if (action === 'keep-cloud') {
            newTitle = log.cloudVersion.title;
            newUrl = log.cloudVersion.url;
            newDesc = log.cloudVersion.description || '';
            if (log.cloudVersion.folderPath !== undefined) newFolder = log.cloudVersion.folderPath;
            if (log.cloudVersion.tags !== undefined) newTags = log.cloudVersion.tags;
          } else if (action === 'manual-edit') {
            const bt = baselineTags[log.id] || {};
            newTitle = log.localVersion.title;
            newUrl = log.localVersion.url;
            newDesc = log.localVersion.description || '';
            if (log.localVersion.folderPath !== undefined) newFolder = log.localVersion.folderPath;
            if (bt.tags !== undefined) newTags = bt.tags;
          } else {
            newTitle = log.localVersion.title;
            newUrl = log.localVersion.url;
            newDesc = log.localVersion.description || '';
            if (log.localVersion.folderPath !== undefined) newFolder = log.localVersion.folderPath;
            if (log.localVersion.tags !== undefined) newTags = log.localVersion.tags;
          }

          const hasContentChange =
            newTitle !== local.title ||
            newUrl !== local.url ||
            newDesc !== (local.description || '') ||
            (newFolder || '') !== (local.folderPath || '') ||
            !sameTags(newTags, local.tags);

          const resolvedModifiedAt = hasContentChange
            ? Date.now()
            : Math.max(local.modifiedAt || 0, log.cloudVersion?.modifiedAt || 0, Date.now());

          const updatePayload: Partial<Bookmark> = {
            syncId: unifiedSyncId,
            title: newTitle,
            url: newUrl,
            description: newDesc,
            folderPath: newFolder,
            tags: newTags,
            modifiedAt: resolvedModifiedAt
          };

          const browserUpdate: { title?: string; url?: string } = {};
          if (newTitle !== local.title) browserUpdate.title = newTitle;
          if (newUrl !== local.url) browserUpdate.url = newUrl;

          updates.push({
            localId: local.id,
            bookmarkNodeId: local.bookmarkId,
            updatePayload,
            browserUpdate: Object.keys(browserUpdate).length > 0 ? browserUpdate : undefined,
            targetFolderPath: newFolder,
            currentFolderPath: local.folderPath
          });
        }
      }

      // Phase 2: Browser bookmark updates (outside Dexie transaction, with folder cache)
      if (typeof browser !== 'undefined' && browser.bookmarks) {
        for (const item of updates) {
          if (!item.bookmarkNodeId) continue;

          if (item.browserUpdate) {
            try {
              await browser.bookmarks.update(item.bookmarkNodeId, item.browserUpdate);
            } catch (e) {
              console.error('Failed to update browser bookmark in conflict apply:', e);
            }
          }

          if (item.targetFolderPath !== undefined && (item.targetFolderPath || '') !== (item.currentFolderPath || '')) {
            try {
              if (item.targetFolderPath) {
                let targetFolder = folderMap.get(item.targetFolderPath);
                if (targetFolder === undefined) {
                  const rootName = getRootFolderName(item.targetFolderPath);
                  const cleanPath = normalizeFolderPath(item.targetFolderPath);
                  targetFolder = await BookmarkManager.ensureFolderPath(cleanPath, rootName);
                  folderMap.set(item.targetFolderPath, targetFolder);
                }
                if (targetFolder) {
                  const nodes = await browser.bookmarks.get(item.bookmarkNodeId);
                  const curr = nodes?.[0];
                  if (curr && curr.parentId !== targetFolder.id) {
                    await browser.bookmarks.move(item.bookmarkNodeId, { parentId: targetFolder.id });
                  }
                }
              } else {
                let rootFolder = folderMap.get('__root__');
                if (rootFolder === undefined) {
                  const folders = await BookmarkManager.getFolders();
                  const found = folders.find(f => f.title && f.title.toLowerCase() === 'bookmarks bar')
                    ?? folders.find(f => f.parentId === '0' || f.parentId === 'root');
                  rootFolder = found ? { id: found.id, path: '' } : { id: '1', path: '' };
                  folderMap.set('__root__', rootFolder);
                }
                if (rootFolder) {
                  const nodes = await browser.bookmarks.get(item.bookmarkNodeId);
                  const curr = nodes?.[0];
                  if (curr && curr.parentId !== rootFolder.id) {
                    await browser.bookmarks.move(item.bookmarkNodeId, { parentId: rootFolder.id });
                  }
                }
              }
            } catch (moveErr) {
              console.error('Failed to move browser bookmark in conflict apply:', moveErr);
            }
          }
        }
      }

      // Phase 3: Atomic Dexie writes (no non-Dexie async inside)
      await db.transaction('rw', db.bookmarks, async () => {
        for (const item of updates) {
          await db.bookmarks.update(item.localId, item.updatePayload);
        }
      });

      // Phase 4: Batch resolve conflict logs in 1 read + 1 write
      await resolveBatchConflicts(choices);

      // Phase 5: Run cloud sync
      await SyncEngine.sync();

      if (typeof document !== 'undefined') {
        document.dispatchEvent(new CustomEvent('bookmarks-updated'));
        document.dispatchEvent(new CustomEvent('sync-resolved'));
      }
      close();
    } catch (e) {
      console.error('Error applying conflicts:', e);
    } finally {
      BookmarkManager.setSyncMuted(false);
      isProcessing = false;
    }
  }
</script>

<Modal open={true} size="lg" closable={!isProcessing} on:close={close}>
  <div slot="header" class="modal-header-left">
    <div class="modal-icon-badge warning">
      <Icon name="alert-triangle" size={18} />
    </div>
    <h3 id="modal-title" class="modal-title">
      {i18n.t('conflict.titleWithCount', { title: i18n.t('conflict.title'), count: conflicts.length })}
    </h3>
  </div>

  <div class="modal-actions-top">
    <div class="bulk-actions">
      <button class="btn btn-secondary btn-sm" on:click={() => setAll('keep-local')}>
        <Icon name="monitor" size={14} /> {i18n.t('conflict.allKeepLocal')}
      </button>
      <button class="btn btn-secondary btn-sm" on:click={() => setAll('keep-cloud')}>
        <Icon name="cloud" size={14} /> {i18n.t('conflict.allKeepCloud')}
      </button>
    </div>
  </div>

  <div class="conflicts-list">
    {#each conflicts as log (log.id)}
      <div class="conflict-card">
        {#if editingId === log.id}
          <!-- Manual Edit Form -->
          <div class="edit-form">
            <div class="edit-form-header">
              <h3><Icon name="edit" size={16} /> {i18n.t('conflict.manualEdit')}</h3>
              <span class="edit-sync-id font-mono">syncId: {getSyncId(log.localVersion, log.bookmarkId)}</span>
            </div>
            <div class="form-group">
              <label for="edit-title-{log.id}">{i18n.t('conflict.fieldTitle')}</label>
              <input id="edit-title-{log.id}" type="text" class="form-input" bind:value={editData.title} />
            </div>
            <div class="form-group">
              <label for="edit-url-{log.id}">URL</label>
              <input id="edit-url-{log.id}" type="text" class="form-input font-mono" bind:value={editData.url} />
            </div>
            <div class="form-group">
              <label for="edit-desc-{log.id}">{i18n.t('conflict.fieldDesc')}</label>
              <input id="edit-desc-{log.id}" type="text" class="form-input" bind:value={editData.description} />
            </div>
            <div class="edit-actions">
              <button class="btn btn-primary btn-sm" on:click={saveEdit}>{i18n.t('common.save')}</button>
              <button class="btn btn-secondary btn-sm" on:click={cancelEdit}>{i18n.t('common.cancel')}</button>
            </div>
          </div>
        {:else}
          <!-- Card Header: Conflict Badge & Manual Edit Action -->
          <div class="card-header-bar">
            <span class="stamp-badge badge-conflict-type {isIdConflict(log) ? 'warning' : 'info'}">
              {#if isIdConflict(log)}
                <Icon name="link" size={12} /> {i18n.t('conflict.idConflict')}
              {:else}
                <Icon name="file-text" size={12} /> {i18n.t('conflict.metaMismatch')}
              {/if}
            </span>
            
            <button class="btn btn-secondary btn-xs" on:click={() => startEdit(log)}>
              <Icon name="edit" size={12} /> {i18n.t('conflict.manualEdit')}
            </button>
          </div>

          <!-- Side-by-Side 2-Column Comparison Layout -->
          <div class="comparison-grid">
            <!-- Left Column: Local Version -->
            <div
              class="version-column local-column {choices[log.id] === 'keep-local' ? 'active' : ''}"
              on:click={() => selectChoice(log.id, 'keep-local')}
              role="button"
              tabindex="0"
              on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && selectChoice(log.id, 'keep-local')}
            >
              <div class="column-header">
                <div class="column-title">
                  <Icon name="monitor" size={16} />
                  <span>{i18n.t('conflict.localDevice')}</span>
                  {#if choices[log.id] === 'keep-local'}
                    <span class="active-icon"><Icon name="check" size={14} /></span>
                  {/if}
                </div>
              </div>

              <div class="version-meta">
                <div class="version-time font-mono {getTimeRelation(log.localVersion.modifiedAt, log.cloudVersion.modifiedAt)}">
                  {i18n.t('conflict.modified')}: {formatDate(log.localVersion.modifiedAt)}
                </div>
                <div class="version-id font-mono" title={getSyncId(log.localVersion, log.bookmarkId)}>
                  {getSyncId(log.localVersion, log.bookmarkId)}
                </div>
              </div>

              <div class="field-list">
                <div class="field-item {log.localVersion.title !== log.cloudVersion.title ? 'is-diff' : ''}">
                  <span class="field-label">{i18n.t('conflict.fieldTitle')}</span>
                  <div class="field-value">{log.localVersion.title}</div>
                </div>

                <div class="field-item {log.localVersion.url !== log.cloudVersion.url ? 'is-diff' : ''}">
                  <span class="field-label">{i18n.t('conflict.fieldUrl')}</span>
                  <div class="field-value font-mono url-text">{log.localVersion.url}</div>
                </div>

                {#if log.localVersion.description || log.cloudVersion.description}
                  <div class="field-item {log.localVersion.description !== log.cloudVersion.description ? 'is-diff' : ''}">
                    <span class="field-label">{i18n.t('conflict.fieldDesc')}</span>
                    <div class="field-value">{log.localVersion.description || `(${i18n.t('common.empty')})`}</div>
                  </div>
                {/if}

                {#if log.localVersion.folderPath || log.cloudVersion.folderPath}
                  <div class="field-item {log.localVersion.folderPath !== log.cloudVersion.folderPath ? 'is-diff' : ''}">
                    <span class="field-label">{i18n.t('conflict.fieldFolder')}</span>
                    <div class="field-value">{log.localVersion.folderPath || `(${i18n.t('folders.rootFolder')})`}</div>
                  </div>
                {/if}

                {#if (log.localVersion.tags && log.localVersion.tags.length > 0) || (log.cloudVersion.tags && log.cloudVersion.tags.length > 0)}
                  <div class="field-item {areTagsDifferent(log.localVersion.tags, log.cloudVersion.tags) ? 'is-diff' : ''}">
                    <span class="field-label">{i18n.t('conflict.fieldTags')}</span>
                    <div class="field-value tags-group">
                      {#if log.localVersion.tags && log.localVersion.tags.length > 0}
                        {#each log.localVersion.tags as tag}
                          <span class="badge badge-secondary">{tag}</span>
                        {/each}
                      {:else}
                        <span class="text-muted">({i18n.t('common.empty')})</span>
                      {/if}
                    </div>
                  </div>
                {/if}
              </div>
            </div>

            <!-- Right Column: Cloud Version -->
            <div
              class="version-column cloud-column {choices[log.id] === 'keep-cloud' ? 'active' : ''}"
              on:click={() => selectChoice(log.id, 'keep-cloud')}
              role="button"
              tabindex="0"
              on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && selectChoice(log.id, 'keep-cloud')}
            >
              <div class="column-header">
                <div class="column-title">
                  <Icon name="cloud" size={16} />
                  <span>{i18n.t('conflict.cloudStorage')}</span>
                  {#if choices[log.id] === 'keep-cloud'}
                    <span class="active-icon"><Icon name="check" size={14} /></span>
                  {/if}
                </div>
              </div>

              <div class="version-meta">
                <div class="version-time font-mono {getTimeRelation(log.cloudVersion.modifiedAt, log.localVersion.modifiedAt)}">
                  {i18n.t('conflict.modified')}: {formatDate(log.cloudVersion.modifiedAt)}
                </div>
                <div class="version-id font-mono" title={getSyncId(log.cloudVersion, log.bookmarkId)}>
                  {getSyncId(log.cloudVersion, log.bookmarkId)}
                </div>
              </div>

              <div class="field-list">
                <div class="field-item {log.localVersion.title !== log.cloudVersion.title ? 'is-diff' : ''}">
                  <span class="field-label">{i18n.t('conflict.fieldTitle')}</span>
                  <div class="field-value">{log.cloudVersion.title}</div>
                </div>

                <div class="field-item {log.localVersion.url !== log.cloudVersion.url ? 'is-diff' : ''}">
                  <span class="field-label">{i18n.t('conflict.fieldUrl')}</span>
                  <div class="field-value font-mono url-text">{log.cloudVersion.url}</div>
                </div>

                {#if log.localVersion.description || log.cloudVersion.description}
                  <div class="field-item {log.localVersion.description !== log.cloudVersion.description ? 'is-diff' : ''}">
                    <span class="field-label">{i18n.t('conflict.fieldDesc')}</span>
                    <div class="field-value">{log.cloudVersion.description || `(${i18n.t('common.empty')})`}</div>
                  </div>
                {/if}

                {#if log.localVersion.folderPath || log.cloudVersion.folderPath}
                  <div class="field-item {log.localVersion.folderPath !== log.cloudVersion.folderPath ? 'is-diff' : ''}">
                    <span class="field-label">{i18n.t('conflict.fieldFolder')}</span>
                    <div class="field-value">{log.cloudVersion.folderPath || `(${i18n.t('folders.rootFolder')})`}</div>
                  </div>
                {/if}

                {#if (log.localVersion.tags && log.localVersion.tags.length > 0) || (log.cloudVersion.tags && log.cloudVersion.tags.length > 0)}
                  <div class="field-item {areTagsDifferent(log.localVersion.tags, log.cloudVersion.tags) ? 'is-diff' : ''}">
                    <span class="field-label">{i18n.t('conflict.fieldTags')}</span>
                    <div class="field-value tags-group">
                      {#if log.cloudVersion.tags && log.cloudVersion.tags.length > 0}
                        {#each log.cloudVersion.tags as tag}
                          <span class="badge badge-secondary">{tag}</span>
                        {/each}
                      {:else}
                        <span class="text-muted">({i18n.t('common.empty')})</span>
                      {/if}
                    </div>
                  </div>
                {/if}
              </div>
            </div>
          </div>

          <!-- Card Footer Controls -->
          <div class="card-footer-controls">
            <label class="selection-radio">
              <input
                type="radio"
                name="choice-{log.id}"
                value="keep-local"
                checked={choices[log.id] === 'keep-local'}
                on:change={() => selectChoice(log.id, 'keep-local')}
              />
              <span>{i18n.t('conflict.keepLocal')}</span>
            </label>

            <label class="selection-radio">
              <input
                type="radio"
                name="choice-{log.id}"
                value="keep-cloud"
                checked={choices[log.id] === 'keep-cloud'}
                on:change={() => selectChoice(log.id, 'keep-cloud')}
              />
              <span>{i18n.t('conflict.keepCloud')}</span>
            </label>

            {#if choices[log.id] === 'manual-edit'}
              <span class="stamp-badge badge-manual-active">
                <Icon name="edit" size={11} /> {i18n.t('conflict.manualEditApplied')}
              </span>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <div slot="footer" class="modal-footer-actions">
    <button type="button" class="btn btn-secondary" on:click={close} disabled={isProcessing}>
      {i18n.t('common.cancel')}
    </button>
    <button type="button" class="btn btn-primary" on:click={applyAndSync} disabled={isProcessing || editingId !== null}>
      {#if isProcessing}
        <Icon name="refresh-cw" size={14} /> {i18n.t('common.loading')}
      {:else}
        <Icon name="check" size={14} /> {i18n.t('conflict.applyAndSync')}
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

  .modal-icon-badge.warning {
    color: var(--color-warning);
    background: rgba(180, 83, 9, 0.12);
    border: 1px solid rgba(180, 83, 9, 0.25);
  }

  .modal-title {
    margin: 0;
    font-family: var(--font-accent);
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text-primary);
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

  .form-input {
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

  .form-input:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px var(--color-primary-light);
  }

  .form-input::placeholder {
    color: var(--text-muted);
  }

  .modal-actions-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.65rem 0.85rem;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--bg-primary);
    flex-shrink: 0;
    margin-bottom: 0.5rem;
  }

  .bulk-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .conflicts-list {
    flex: 1 1 auto;
    overflow-y: auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding-right: 0.25rem;
  }

  .conflict-card {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: 1rem;
    background: var(--bg-secondary);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    box-shadow: var(--shadow-sm);
  }

  .card-header-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .header-badges {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .badge-conflict-type {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.7rem;
    padding: 0.2rem 0.5rem;
    border-radius: var(--radius-sm);
  }

  .badge-conflict-type.warning {
    color: var(--color-warning);
    border-color: var(--color-warning);
    background-color: rgba(180, 83, 9, 0.08);
  }

  .badge-conflict-type.info {
    color: var(--color-info);
    border-color: var(--color-info);
    background-color: rgba(15, 118, 110, 0.08);
  }

  .comparison-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  @media (max-width: 640px) {
    .comparison-grid {
      grid-template-columns: 1fr;
    }
  }

  .version-column {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: 0.875rem;
    background: var(--bg-primary);
    cursor: pointer;
    position: relative;
    transition: border-color var(--transition-fast), background-color var(--transition-fast);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .version-column:hover {
    border-color: var(--text-muted);
  }

  .version-column.active {
    border-color: var(--color-primary);
    background: var(--color-primary-light);
  }

  .version-column.active::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 3px;
    background-color: var(--color-primary);
    border-radius: var(--radius-md) var(--radius-md) 0 0;
  }

  .column-header {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .column-title {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-weight: 700;
    font-size: 0.875rem;
    color: var(--text-primary);
  }

  .active-icon {
    color: var(--color-primary);
    margin-left: auto;
    display: flex;
    align-items: center;
  }

  .version-meta {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding-bottom: 0.35rem;
    border-bottom: 1px dashed var(--border-color);
  }

  .version-time {
    font-family: var(--font-mono);
    font-size: 0.725rem;
    color: var(--text-muted);
    font-weight: 500;
  }

  .version-time.newer {
    color: var(--color-success);
    font-weight: 600;
  }

  .version-time.older {
    color: var(--text-muted);
  }

  .version-id {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--text-secondary);
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    padding: 0.12rem 0.4rem;
    border-radius: var(--radius-sm);
    word-break: break-all;
    width: fit-content;
    max-width: 100%;
    user-select: all;
  }

  .field-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }

  .field-item {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.35rem 0.5rem;
    border-radius: var(--radius-sm);
    transition: background-color var(--transition-fast);
  }

  .field-item.is-diff {
    background-color: rgba(214, 69, 61, 0.08);
    border-left: 2px solid var(--color-primary);
  }

  .field-label {
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .field-value {
    font-size: 0.825rem;
    color: var(--text-primary);
    word-break: break-all;
  }

  .url-text {
    font-family: var(--font-mono);
    font-size: 0.75rem;
  }

  .tags-group {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .text-muted {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .font-mono {
    font-family: var(--font-mono);
  }

  .card-footer-controls {
    display: flex;
    align-items: center;
    gap: 1.25rem;
    padding-top: 0.5rem;
    border-top: 1px dashed var(--border-color);
    font-size: 0.825rem;
  }

  .selection-radio {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    cursor: pointer;
    color: var(--text-primary);
  }

  .selection-radio input[type="radio"] {
    cursor: pointer;
    accent-color: var(--color-primary);
  }

  .badge-manual-active {
    color: var(--color-warning);
    border-color: var(--color-warning);
    background-color: rgba(180, 83, 9, 0.1);
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    margin-left: auto;
  }

  .edit-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.5rem;
  }

  .edit-form-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .edit-form-header h3 {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.95rem;
    color: var(--text-primary);
  }

  .edit-sync-id {
    font-size: 0.725rem;
    color: var(--text-muted);
    word-break: break-all;
  }

  .edit-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }

  .modal-footer-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 0.6rem;
  }
</style>
