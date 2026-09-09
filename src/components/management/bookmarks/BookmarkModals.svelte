<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import db, { type Bookmark, type ArchivedPage } from '../../../lib/db';
  import { BookmarkManager, type FolderNode } from '../../../lib/bookmarks/bookmark-manager';
  import { deleteArchiveRecord, performArchiveCapture } from './archive-action-handler';
  import { isBookmarkDead } from '../../../lib/health/health-checker';
  import { showToast } from '../../../lib/ui/toast-store';
  import Modal from '../../shared/Modal.svelte';
  import ConfirmModal from '../../shared/ConfirmModal.svelte';
  import BookmarkEditModal from './BookmarkEditModal.svelte';
  import ArchiveViewerModal from '../../shared/ArchiveViewerModal.svelte';
  import Icon from '../../shared/Icon.svelte';
  import Spinner from '../../shared/Spinner.svelte';
  import { SyncEngine } from '../../../lib/sync/sync-engine';

  export let folders: FolderNode[] = [];
  export let bookmarks: Bookmark[] = [];
  export let selectedIds: Set<number> = new Set();
  export let archiveMap: Map<number, ArchivedPage> = new Map();
  export let healthResults: Map<number, any> = new Map();

  const dispatch = createEventDispatcher<{
    saved: void;
    deleting: { ids: number[] };
    deleteFailed: { ids: number[] };
    deleted: { ids: number[] };
    folderDeleted: { path: string };
    folderCleaned: { deletedPaths: string[] };
    folderRenamed: { folderId: string; oldPath: string; oldTitle: string; newTitle: string };
    archiveClosed: void;
    archiveDeleted: void;
  }>();

  // Edit modal state
  let editingBookmark: Bookmark | null = null;
  let editModalOpen = false;

  // Delete modal state
  let deleteModalOpen = false;
  let isDeletingSingleId: number | null = null;
  let deleteDeadOnly = false;
  let isDeleting = false;
  let isDeletingFolder = false;
  let isCleaningFolders = false;
  let folderDeleteTarget: { path: string; title: string; count: number } | null = null;
  let cleanEmptyFoldersTarget: {
    title: string;
    folderId?: string;
    path?: string;
    emptyFolders: { id: string; title: string; path: string }[];
  } | null = null;

  // Folder rename modal state
  let folderRenameTarget: { id: string; title: string; path: string; parentId?: string } | null = null;
  let renameInputVal = '';
  let renameError = '';
  let renameInputEl: HTMLInputElement | null = null;
  let isRenaming = false;

  // Archive viewer state
  let viewerOpen = false;
  let activeArchive: ArchivedPage | null = null;
  let activeDirectHtml: string | null = null;
  let activeBookmark: Bookmark | null = null;

  $: validSelectedIds = Array.from(selectedIds).filter((id) => bookmarks.some((b) => b.id === id));
  $: archivedSelectedCount = validSelectedIds.filter((id) => archiveMap.has(id)).length;
  $: nonArchivedSelectedCount = validSelectedIds.length - archivedSelectedCount;
  $: deadSelectedCount = validSelectedIds.filter((id) => {
    const res = healthResults.get(id);
    const bm = bookmarks.find((b) => b.id === id);
    return bm && isBookmarkDead(bm, res);
  }).length;

  // ── Public API ──────────────────────────────────────
  export function openEdit(bookmark: Bookmark) {
    editingBookmark = bookmark;
    editModalOpen = true;
  }

  export function openDeleteSingle(bookmarkId: number) {
    if (isDeleting) return;
    isDeletingSingleId = bookmarkId;
    deleteDeadOnly = false;
    deleteModalOpen = false;
  }

  export function openDeleteSelected() {
    if (isDeleting || selectedIds.size === 0) return;
    isDeletingSingleId = null;
    deleteDeadOnly = false;
    deleteModalOpen = true;
  }

  export function openDelete404() {
    if (isDeleting || deadSelectedCount === 0) return;
    isDeletingSingleId = null;
    deleteDeadOnly = true;
    deleteModalOpen = false;
  }

  export function openFolderDeleteModal(target: { path: string; title: string; count: number }) {
    folderDeleteTarget = target;
  }

  export function openCleanEmptyFoldersModal(target: {
    title: string;
    folderId?: string;
    path?: string;
    emptyFolders: { id: string; title: string; path: string }[];
  }) {
    cleanEmptyFoldersTarget = target;
  }

  export function openFolderRenameModal(target: { id?: string; folderId?: string; title: string; path: string; parentId?: string }) {
    const effectiveId = target.id || target.folderId || (target.path ? folders.find(f => f.path === target.path)?.id : '') || '';
    folderRenameTarget = {
      id: effectiveId,
      title: target.title,
      path: target.path,
      parentId: target.parentId
    };
    renameInputVal = target.title;
    renameError = '';
    setTimeout(() => {
      renameInputEl?.focus();
      renameInputEl?.select();
    }, 50);
  }

  export function openArchiveViewer(archive: ArchivedPage | null, directHtml: string | null, bookmark: Bookmark | null = null) {
    activeArchive = archive;
    activeDirectHtml = directHtml;
    activeBookmark = bookmark || (archive?.bookmarkId ? bookmarks.find((b) => b.id === archive.bookmarkId) || null : null);
    viewerOpen = true;
  }

  export function closeArchiveViewer() {
    viewerOpen = false;
    activeArchive = null;
    activeDirectHtml = null;
    activeBookmark = null;
  }

  export function getActiveArchive() {
    return activeArchive;
  }

  // ── Internal Handlers ───────────────────────────────
  async function handleDeleteArchive(archiveId: number) {
    await deleteArchiveRecord(
      archiveId,
      activeArchive?.id ?? activeArchive?.bookmarkId,
      async () => {
        dispatch('archiveDeleted');
      },
      () => {
        closeArchiveViewer();
      },
      {
        syncId: activeBookmark?.syncId,
        url: activeBookmark?.url || activeArchive?.url,
        bookmarkId: activeBookmark?.id ?? activeArchive?.bookmarkId
      }
    );
  }

  async function handleRefreshArchive(bookmarkId: number) {
    const bookmark = activeBookmark || bookmarks.find((b) => b.id === bookmarkId);
    if (!bookmark) return;
    showToast(i18n.t('archive.savingAgain'), 'info');
    const ok = await performArchiveCapture(bookmark);
    if (ok) {
      dispatch('archiveDeleted');
      closeArchiveViewer();
    }
  }

  async function handleSaveEdit(e: CustomEvent<{ bookmark: Bookmark; folderId?: string; folderPath?: string; tags?: string[] }>) {
    try {
      const { bookmark, folderId, folderPath, tags } = e.detail;
      if (!bookmark.id) return;
      await BookmarkManager.updateBookmark(bookmark.id, {
        title: bookmark.title,
        url: bookmark.url,
        description: bookmark.description,
        folderId,
        folderPath: folderPath !== undefined ? folderPath : bookmark.folderPath,
        tags: tags ?? bookmark.tags
      });
      showToast(i18n.t('bookmarks.modals.updated'), 'success');
      editModalOpen = false;
      editingBookmark = null;
      dispatch('saved');
    } catch (err: any) {
      showToast(i18n.t('bookmarks.modals.updateFailed', { error: err.message }), 'error');
    }
  }

  async function executeDelete(excludeArchived: boolean = false) {
    if (isDeleting) return;
    isDeleting = true;
    let targetIds: number[] = [];
    try {
      const deletedIds: number[] = [];
      if (isDeletingSingleId !== null) {
        targetIds = [isDeletingSingleId];
        dispatch('deleting', { ids: targetIds });
        BookmarkManager.setSyncMuted(true);
        try {
          await BookmarkManager.removeBookmark(isDeletingSingleId);
          deletedIds.push(isDeletingSingleId);
        } finally {
          BookmarkManager.setSyncMuted(false);
          SyncEngine.triggerDebouncedSync();
        }
        showToast(i18n.t('bookmarks.modals.deletedSingle'), 'success');
      } else if (deleteDeadOnly) {
        const deadIds = validSelectedIds.filter((id) => {
          const res = healthResults.get(id);
          const bm = bookmarks.find((b) => b.id === id);
          return bm && isBookmarkDead(bm, res);
        });
        targetIds = deadIds;
        dispatch('deleting', { ids: targetIds });
        BookmarkManager.setSyncMuted(true);
        try {
          for (const id of deadIds) {
            await BookmarkManager.removeBookmark(id);
            deletedIds.push(id);
          }
        } finally {
          BookmarkManager.setSyncMuted(false);
          SyncEngine.triggerDebouncedSync();
        }
        showToast(i18n.t('bookmarks.modals.deletedDead', { count: deadIds.length }), 'success');
      } else {
        const ids = validSelectedIds.filter((id) => {
          if (excludeArchived && archiveMap.has(id)) return false;
          return true;
        });
        targetIds = ids;
        dispatch('deleting', { ids: targetIds });
        BookmarkManager.setSyncMuted(true);
        try {
          for (const id of ids) {
            await BookmarkManager.removeBookmark(id);
            deletedIds.push(id);
          }
        } finally {
          BookmarkManager.setSyncMuted(false);
          SyncEngine.triggerDebouncedSync();
        }
        if (excludeArchived) {
          showToast(i18n.t('bookmarks.modals.deletedBulkExcludingArchive', { archiveCount: archivedSelectedCount, count: ids.length }), 'success');
        } else {
          showToast(i18n.t('bookmarks.modals.deletedBulk', { count: ids.length }), 'success');
        }
      }
      deleteModalOpen = false;
      isDeletingSingleId = null;
      deleteDeadOnly = false;
      dispatch('deleted', { ids: deletedIds });
    } catch (e: any) {
      if (targetIds.length > 0) {
        dispatch('deleteFailed', { ids: targetIds });
      }
      showToast(i18n.t('bookmarks.modals.deleteFailed', { error: e.message }), 'error');
    } finally {
      isDeleting = false;
    }
  }

  function bookmarksInFolder(folderPath: string): Bookmark[] {
    return bookmarks.filter(b => {
      const p = b.folderPath || '';
      return p === folderPath || p.startsWith(folderPath + '/');
    });
  }

  async function moveBookmarksToParent(folder: any, inside: Bookmark[]) {
    const slash = folder.path.lastIndexOf('/');
    const parentPath = slash === -1 ? '' : folder.path.slice(0, slash);

    const parentFolder = parentPath ? folders.find(f => f.path === parentPath) : undefined;
    const parentId = parentFolder?.id || '1';

    for (const bm of inside) {
      if (bm.bookmarkId && typeof browser !== 'undefined' && browser.bookmarks?.move) {
        try {
          await browser.bookmarks.move(bm.bookmarkId, { parentId });
        } catch (e) {}
      }
      if (bm.id !== undefined) {
        await BookmarkManager.updateBookmark(bm.id, {
          folderId: parentId,
          folderPath: parentFolder?.path || ''
        });
      }
    }
  }

  async function performFolderDelete(folder: any, inside: Bookmark[], keepBookmarks = false) {
    if (isDeletingFolder) return;
    isDeletingFolder = true;
    try {
      if (keepBookmarks && inside.length > 0) {
        await moveBookmarksToParent(folder, inside);
      } else if (!keepBookmarks && inside.length > 0) {
        BookmarkManager.setSyncMuted(true);
        try {
          for (const bm of inside) {
            if (bm.id !== undefined) {
              await BookmarkManager.removeBookmark(bm.id);
            }
          }
        } finally {
          BookmarkManager.setSyncMuted(false);
          SyncEngine.triggerDebouncedSync();
        }
      }

      if (typeof browser !== 'undefined' && browser.bookmarks?.removeTree) {
        await browser.bookmarks.removeTree(folder.id);
      } else {
        await BookmarkManager.deleteFolder(folder.id);
      }

      showToast(i18n.t('folders.deleted'), 'success');
      dispatch('folderDeleted', { path: folder.path });
    } catch (err: any) {
      console.error('Failed to delete folder:', err);
      showToast(i18n.t('folders.deleteFailed', { error: err.message }), 'error');
    } finally {
      folderDeleteTarget = null;
      isDeletingFolder = false;
    }
  }

  async function confirmFolderDeleteKeep() {
    if (!folderDeleteTarget || isDeletingFolder) return;
    const folder = folders.find(f => f.path === folderDeleteTarget?.path);
    if (!folder) return;
    const inside = bookmarksInFolder(folderDeleteTarget.path);
    await performFolderDelete(folder, inside, true);
  }

  async function confirmFolderDeleteAll() {
    if (!folderDeleteTarget || isDeletingFolder) return;
    const folder = folders.find(f => f.path === folderDeleteTarget?.path);
    if (!folder) return;
    const inside = bookmarksInFolder(folderDeleteTarget.path);
    await performFolderDelete(folder, inside, false);
  }

  function closeFolderDelete() {
    if (isDeletingFolder) return;
    folderDeleteTarget = null;
  }

  async function confirmCleanEmptyFolders() {
    if (!cleanEmptyFoldersTarget || isCleaningFolders) return;
    const target = cleanEmptyFoldersTarget;
    isCleaningFolders = true;
    try {
      const result = await BookmarkManager.cleanEmptyFolders(target.folderId, target.path);
      if (result.count > 0) {
        showToast(i18n.t('folders.cleanEmptyFoldersSuccess', { count: result.count }), 'success');
        dispatch('folderCleaned', { deletedPaths: result.deletedPaths });
      } else {
        showToast(i18n.t('folders.noEmptyFoldersFound'), 'info');
      }
    } catch (err: any) {
      console.error('Failed to clean empty folders:', err);
      showToast(i18n.t('folders.cleanEmptyFoldersFailed', { error: err?.message || '' }), 'error');
    } finally {
      cleanEmptyFoldersTarget = null;
      isCleaningFolders = false;
    }
  }

  function closeCleanEmptyFolders() {
    if (isCleaningFolders) return;
    cleanEmptyFoldersTarget = null;
  }

  function closeFolderRename() {
    if (isRenaming) return;
    folderRenameTarget = null;
    renameInputVal = '';
    renameError = '';
  }

  async function confirmFolderRename() {
    if (!folderRenameTarget || isRenaming) return;
    const targetFolderId = folderRenameTarget.id || (folderRenameTarget.path ? folders.find(f => f.path === folderRenameTarget?.path)?.id : '');
    if (!targetFolderId) {
      renameError = i18n.t('folders.notFound');
      return;
    }
    const trimmed = renameInputVal.trim();
    if (!trimmed) {
      renameError = i18n.t('folders.nameRequired');
      return;
    }
    if (trimmed.includes('/')) {
      renameError = i18n.t('folders.noSlashAllowed');
      return;
    }

    isRenaming = true;
    renameError = '';
    try {
      const result = await BookmarkManager.renameFolder(targetFolderId, trimmed);
      showToast(i18n.t('folders.renameSuccess'), 'success');
      const oldPath = folderRenameTarget.path;
      const oldTitle = folderRenameTarget.title;
      folderRenameTarget = null;
      renameInputVal = '';
      dispatch('folderRenamed', {
        folderId: targetFolderId,
        oldPath,
        oldTitle,
        newTitle: result.newTitle
      });
    } catch (err: any) {
      renameError = err.message || i18n.t('folders.renameFailed', { error: '' });
    } finally {
      isRenaming = false;
    }
  }
</script>

<!-- Bookmark Edit Modal -->
<BookmarkEditModal
  open={editModalOpen}
  bookmark={editingBookmark}
  {folders}
  on:saved={handleSaveEdit}
  on:close={() => { editModalOpen = false; editingBookmark = null; }}
/>

<!-- Single Bookmark Delete Confirmation Modal -->
<ConfirmModal
  open={isDeletingSingleId !== null}
  title={i18n.t('bookmarks.modals.deleteSingleTitle')}
  message={i18n.t('bookmarks.modals.deleteSingleMessage')}
  confirmText={i18n.t('common.delete')}
  cancelText={i18n.t('common.cancel')}
  danger={true}
  loading={isDeleting}
  on:confirm={() => executeDelete(false)}
  on:close={() => { if (!isDeleting) isDeletingSingleId = null; }}
/>

<!-- 404 Dead Link Bookmark Bulk Delete Confirmation Modal -->
<ConfirmModal
  open={deleteDeadOnly}
  title={i18n.t('bookmarks.modals.delete404Title')}
  message={i18n.t('bookmarks.modals.delete404Message', { count: deadSelectedCount })}
  confirmText={i18n.t('common.delete')}
  cancelText={i18n.t('common.cancel')}
  danger={true}
  loading={isDeleting}
  on:confirm={() => executeDelete(false)}
  on:close={() => { if (!isDeleting) deleteDeadOnly = false; }}
/>

<!-- Selected Bookmarks Bulk Delete Confirmation Modal -->
<Modal
  open={deleteModalOpen && isDeletingSingleId === null && !deleteDeadOnly}
  closable={!isDeleting}
  on:close={() => { if (!isDeleting) deleteModalOpen = false; }}
>
  <div slot="header" class="modal-header-left">
    <div class="modal-icon-badge danger">
      <Icon name="trash-2" size={16} />
    </div>
    <h4 id="delete-modal-title">{i18n.t('bookmarks.modals.deleteBulkTitle')}</h4>
  </div>
  <div class="edit-modal">
    {#if archivedSelectedCount > 0}
      <div class="archive-delete-notice">
        <p>• <strong>{i18n.t('bookmarks.modals.deleteExcludingArchive')}</strong>: {i18n.t('bookmarks.modals.deleteExcludingArchiveDesc', { archiveCount: archivedSelectedCount, nonArchiveCount: nonArchivedSelectedCount })}</p>
        <p>• <strong>{i18n.t('bookmarks.modals.deleteAll')}</strong>: {i18n.t('bookmarks.modals.deleteAllDesc', { count: validSelectedIds.length })}</p>
      </div>
    {:else}
      <p class="delete-confirm-message">{i18n.t('bookmarks.modals.deleteBulkConfirm', { count: validSelectedIds.length })}</p>
    {/if}
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" disabled={isDeleting} on:click={() => { if (!isDeleting) deleteModalOpen = false; }}>{i18n.t('common.cancel')}</button>
      {#if archivedSelectedCount > 0}
        <button type="button" class="btn btn-secondary" disabled={isDeleting} on:click={() => executeDelete(true)}>
          {#if isDeleting}
            <Spinner size={14} variant="inline" />
          {/if}
          <span>{i18n.t('bookmarks.modals.deleteExcludingArchive')}</span>
        </button>
      {/if}
      <button type="button" class="btn btn-danger" disabled={isDeleting} on:click={() => executeDelete(false)}>
        {#if isDeleting}
          <Spinner size={14} variant="inline" />
        {/if}
        <span>{i18n.t('bookmarks.modals.deleteAll')}</span>
      </button>
    </div>
  </div>
</Modal>

<!-- Folder Delete Confirmation Modal (FolderTree right X) -->
<Modal
  open={!!folderDeleteTarget}
  closable={!isDeletingFolder}
  on:close={closeFolderDelete}
>
  <div slot="header" class="modal-header-left">
    <div class="modal-icon-badge danger">
      <Icon name="folder" size={16} />
    </div>
    <h4 id="folder-delete-modal-title">{i18n.t('folders.deleteModal.title')}</h4>
  </div>
  <div class="folder-delete-body">
    {#if folderDeleteTarget}
      <p class="delete-confirm-message">{i18n.t('folders.deleteModal.message', { name: folderDeleteTarget.title, count: folderDeleteTarget.count })}</p>
      <div class="archive-delete-notice">
        <p>• <strong>{i18n.t('folders.deleteModal.keepOption')}</strong>: {i18n.t('folders.deleteModal.keepOptionDesc')}</p>
        <p>• <strong>{i18n.t('folders.deleteModal.deleteAllOption')}</strong>: {i18n.t('folders.deleteModal.deleteAllOptionDesc')}</p>
      </div>
    {/if}
  </div>
  <div slot="footer" class="modal-actions">
    <button type="button" class="btn btn-secondary" disabled={isDeletingFolder} on:click={closeFolderDelete}>{i18n.t('common.cancel')}</button>
    <button type="button" class="btn btn-secondary" disabled={isDeletingFolder} on:click={confirmFolderDeleteKeep}>
      {#if isDeletingFolder}
        <Spinner size={14} variant="inline" />
      {/if}
      <span>{i18n.t('folders.deleteModal.keepOption')}</span>
    </button>
    <button type="button" class="btn btn-danger" disabled={isDeletingFolder} on:click={confirmFolderDeleteAll}>
      {#if isDeletingFolder}
        <Spinner size={14} variant="inline" />
      {/if}
      <span>{i18n.t('folders.deleteModal.deleteAllOption')} ({folderDeleteTarget?.count || 0})</span>
    </button>
  </div>
</Modal>

<!-- Clean Empty Folders Confirmation Modal -->
<Modal
  open={!!cleanEmptyFoldersTarget}
  closable={!isCleaningFolders}
  on:close={closeCleanEmptyFolders}
>
  <div slot="header" class="modal-header-left">
    <div class="modal-icon-badge danger">
      <Icon name="trash-2" size={16} />
    </div>
    <h4 id="clean-empty-folders-modal-title">{i18n.t('folders.cleanEmptyModal.title')}</h4>
  </div>
  <div class="clean-empty-folders-body">
    {#if cleanEmptyFoldersTarget}
      <p class="delete-confirm-message">
        {i18n.t('folders.cleanEmptyModal.message', { count: cleanEmptyFoldersTarget.emptyFolders.length })}
      </p>
      <div class="empty-folder-list-container">
        <ul class="empty-folder-list">
          {#each cleanEmptyFoldersTarget.emptyFolders as f}
            <li class="empty-folder-item">
              <span class="folder-icon"><Icon name="folder" size={14} /></span>
              <span class="folder-path">{f.path || f.title}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
  <div slot="footer" class="modal-actions">
    <button type="button" class="btn btn-secondary" disabled={isCleaningFolders} on:click={closeCleanEmptyFolders}>
      {i18n.t('common.cancel')}
    </button>
    <button type="button" class="btn btn-danger" disabled={isCleaningFolders} on:click={confirmCleanEmptyFolders}>
      {#if isCleaningFolders}
        <Spinner size={14} variant="inline" />
      {/if}
      <span>{i18n.t('folders.cleanEmptyModal.confirm', { count: cleanEmptyFoldersTarget?.emptyFolders.length || 0 })}</span>
    </button>
  </div>
</Modal>

<!-- Folder Rename Modal -->
<Modal
  open={!!folderRenameTarget}
  on:close={closeFolderRename}
>
  <div slot="header" class="modal-header-left">
    <div class="modal-icon-badge">
      <Icon name="edit" size={16} />
    </div>
    <h4 id="folder-rename-modal-title">{i18n.t('folders.renameModal.title')}</h4>
  </div>
  <div class="folder-rename-body">
    {#if folderRenameTarget}
      {#if renameError}
        <div class="error-banner" role="alert">
          <Icon name="alert-triangle" size={14} />
          <span>{renameError}</span>
        </div>
      {/if}
      <div class="form-group">
        <label for="rename-folder-location">{i18n.t('folders.renameModal.locationLabel')}</label>
        <div id="rename-folder-location" class="folder-location-preview font-mono">
          {folderRenameTarget.path}
        </div>
      </div>
      <div class="form-group">
        <label for="rename-folder-input">{i18n.t('folders.renameModal.inputLabel')}</label>
        <input
          id="rename-folder-input"
          type="text"
          class="form-control form-input"
          bind:this={renameInputEl}
          bind:value={renameInputVal}
          placeholder={i18n.t('folders.renameModal.placeholder')}
          disabled={isRenaming}
          on:keydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              confirmFolderRename();
            }
          }}
        />
      </div>
    {/if}
  </div>
  <div slot="footer" class="modal-actions">
    <button
      type="button"
      class="btn btn-secondary"
      on:click={closeFolderRename}
      disabled={isRenaming}
    >
      {i18n.t('common.cancel')}
    </button>
    <button
      type="button"
      class="btn btn-primary"
      on:click={confirmFolderRename}
      disabled={isRenaming || !renameInputVal.trim()}
    >
      {i18n.t('folders.renameModal.submit')}
    </button>
  </div>
</Modal>

<!-- Snapshot Archive Viewer Modal -->
<ArchiveViewerModal
  open={viewerOpen}
  archivePage={activeArchive}
  bookmark={activeBookmark}
  html={activeDirectHtml}
  on:close={() => { closeArchiveViewer(); dispatch('archiveClosed'); }}
  onDelete={handleDeleteArchive}
  onRefresh={handleRefreshArchive}
/>

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
  .modal-icon-badge.danger {
    color: var(--color-danger);
    background: rgba(185, 58, 51, 0.12);
    border: 1px solid rgba(185, 58, 51, 0.25);
  }
  .edit-modal,
  .folder-delete-body,
  .clean-empty-folders-body,
  .folder-rename-body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .folder-location-preview {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    padding: 0.375rem 0.625rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .error-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: color-mix(in srgb, var(--color-danger) 6%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-danger) 35%, transparent);
    border-top: 2px solid var(--color-danger);
    border-radius: var(--radius-sm);
    color: var(--color-danger);
    font-size: 0.8rem;
  }
  .error-banner :global(svg) {
    flex-shrink: 0;
  }
  .empty-folder-list-container {
    max-height: 200px;
    overflow-y: auto;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: 0.5rem;
  }
  .empty-folder-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .empty-folder-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.8125rem;
    font-family: var(--font-mono);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    background: var(--bg-secondary);
  }
  .empty-folder-item .folder-icon {
    display: flex;
    align-items: center;
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .empty-folder-item .folder-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .delete-confirm-message {
    margin: 0;
    font-size: 0.875rem;
    line-height: 1.5;
    color: var(--text-primary);
  }
  .archive-delete-notice {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    line-height: 1.5;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: 0.75rem 1rem;
  }
  .archive-delete-notice p {
    margin: 0.25rem 0;
  }
  .archive-delete-notice p:first-child {
    margin-top: 0;
  }
  .archive-delete-notice p:last-child {
    margin-bottom: 0;
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
  }
</style>
