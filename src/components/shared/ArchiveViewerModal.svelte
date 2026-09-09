<script lang="ts">
  import { onDestroy, createEventDispatcher } from 'svelte';
  import { decompressArchiveHtml } from '../../lib/archive/page-capture';
  import { downloadFile } from '../../lib/bookmarks/export-manager';
  import { buildArchiveBannerHtml } from '../../lib/archive/archive-viewer';
  import { BookmarkManager } from '../../lib/bookmarks/bookmark-manager';
  import db, { type Bookmark, type ArchivedPage } from '../../lib/db';
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import Spinner from './Spinner.svelte';

  export let open: boolean = false;
  export let bookmark: Bookmark | null = null;
  export let archivePage: ArchivedPage | null = null;
  export let html: string | null = null;
  export let showDeleteButton: boolean = true;
  export let onDelete: ((archiveId: number) => Promise<void> | void) | null = null;
  export let onRefresh: ((bookmarkId: number) => Promise<void> | void) | null = null;
  export let reloadToken: number = 0;

  const dispatch = createEventDispatcher<{
    close: void;
    delete: { archiveId: number };
    refresh: { bookmarkId: number };
  }>();

  let iframeUrl: string = '';
  let directHtml: string = '';
  let isLoading: boolean = false;
  let currentLoadKey: string | number | null = null;
  let lastReloadToken = 0;
  let isRefreshing = false;
  let isDeleting = false;
  let loadedBookmark: Bookmark | null = null;

  $: effectiveBookmark = bookmark || loadedBookmark;

  $: if (open && !bookmark && archivePage?.bookmarkId) {
    db.bookmarks.get(archivePage.bookmarkId).then((b) => {
      if (b) loadedBookmark = b;
    }).catch(() => {});
  } else if (!open) {
    loadedBookmark = null;
  }

  function extractTitleFromHtml(htmlContent: string): string {
    const match = htmlContent.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    return match ? match[1].trim() : '';
  }

  $: htmlTitle = (directHtml || html) ? extractTitleFromHtml(directHtml || html || '') : '';
  $: displayTitle = effectiveBookmark?.title || (archivePage as any)?.title || htmlTitle || i18n.t('bookmarks.untitled');
  $: effectiveUrl = archivePage?.url || effectiveBookmark?.url || '';

  $: if (open) {
    if (html !== null && html !== undefined && html !== '') {
      directHtml = html;
      cleanupIframeUrl();
      iframeUrl = '';
      currentLoadKey = null;
      isLoading = false;
    } else if (archivePage) {
      directHtml = '';
      const key = archivePage.id ?? archivePage.bookmarkId ?? (effectiveBookmark?.id ? `bm-${effectiveBookmark.id}` : 'archive');
      const reloadChanged = reloadToken !== lastReloadToken;
      lastReloadToken = reloadToken;
      if (currentLoadKey !== key || reloadChanged) {
        loadDecompressedHtml(archivePage);
      }
    } else {
      directHtml = '';
      cleanupIframeUrl();
      iframeUrl = '';
      currentLoadKey = null;
      isLoading = false;
    }
  } else {
    cleanupIframeUrl();
    iframeUrl = '';
    directHtml = '';
    currentLoadKey = null;
    isLoading = false;
    isRefreshing = false;
    isDeleting = false;
  }

  async function loadDecompressedHtml(page: ArchivedPage) {
    const pageId = page.id ?? page.bookmarkId ?? (effectiveBookmark?.id ? `bm-${effectiveBookmark.id}` : 'archive');
    currentLoadKey = pageId;
    isLoading = true;
    cleanupIframeUrl();
    try {
      let targetBlob: any = page.htmlBlob;
      if (!(targetBlob instanceof Blob) && (page.bookmarkId || effectiveBookmark?.id)) {
        const targetId = page.bookmarkId ?? effectiveBookmark?.id;
        const fresh = await db.archivedPages.where('bookmarkId').equals(targetId!).first();
        if (fresh?.htmlBlob instanceof Blob) {
          targetBlob = fresh.htmlBlob;
        }
      }
      if (targetBlob instanceof Blob) {
        const decompressedBlob = await decompressArchiveHtml(targetBlob);
        if (currentLoadKey === pageId) {
          iframeUrl = URL.createObjectURL(decompressedBlob);
        }
      }
    } catch (e) {
      console.error('Failed to decompress archive HTML:', e);
    } finally {
      if (currentLoadKey === pageId) {
        isLoading = false;
      }
    }
  }

  function cleanupIframeUrl() {
    if (iframeUrl) {
      URL.revokeObjectURL(iframeUrl);
      iframeUrl = '';
    }
  }

  function closeViewer() {
    open = false;
    cleanupIframeUrl();
    directHtml = '';
    currentLoadKey = null;
    isLoading = false;
    isRefreshing = false;
    isDeleting = false;
    dispatch('close');
  }

  onDestroy(() => {
    cleanupIframeUrl();
  });

  function openBookmark(url: string) {
    if (!url) return;
    try {
      BookmarkManager.openBookmark(url);
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  async function getHtmlText(): Promise<string> {
    if (directHtml) return directHtml;
    let blob: any = archivePage?.htmlBlob;
    if (!(blob instanceof Blob) && (archivePage?.bookmarkId || effectiveBookmark?.id)) {
      const targetId = archivePage?.bookmarkId ?? effectiveBookmark?.id;
      const fresh = await db.archivedPages.where('bookmarkId').equals(targetId!).first();
      blob = fresh?.htmlBlob;
    }
    if (blob instanceof Blob) {
      const decompressed = await decompressArchiveHtml(blob);
      return await decompressed.text();
    }
    return '';
  }

  async function handleDownload() {
    try {
      const text = await getHtmlText();
      if (!text) return;
      const rawTitle = (displayTitle && displayTitle !== i18n.t('bookmarks.untitled')) ? displayTitle : 'archive';
      const filename = `${rawTitle.replace(/[/\\?%*:|"<>]/g, '_')}.html`;
      await downloadFile(text, filename, 'text/html;charset=utf-8');
    } catch (e) {
      console.error('Failed to download archive file:', e);
    }
  }

  async function handleOpenNewTab() {
    const bannerOpts = {
      archivedAt: archivePage?.archivedAt,
      title: (displayTitle && displayTitle !== i18n.t('bookmarks.untitled')) ? displayTitle : undefined
    };
    try {
      if (directHtml) {
        const blob = new Blob([buildArchiveBannerHtml(directHtml, bannerOpts)], { type: 'text/html;charset=utf-8' });
        const blobUrl = URL.createObjectURL(blob);
        window.open(blobUrl, '_blank');
        return;
      }
      let blob: any = archivePage?.htmlBlob;
      if (!(blob instanceof Blob) && (archivePage?.bookmarkId || effectiveBookmark?.id)) {
        const targetId = archivePage?.bookmarkId ?? effectiveBookmark?.id;
        const fresh = await db.archivedPages.where('bookmarkId').equals(targetId!).first();
        blob = fresh?.htmlBlob;
      }
      if (blob instanceof Blob) {
        const decompressed = await decompressArchiveHtml(blob);
        const text = await decompressed.text();
        const bannerBlob = new Blob([buildArchiveBannerHtml(text, bannerOpts)], { type: 'text/html;charset=utf-8' });
        const blobUrl = URL.createObjectURL(bannerBlob);
        window.open(blobUrl, '_blank');
      }
    } catch (e) {
      console.error('Failed to open archive in new tab:', e);
    }
  }

  async function handleDelete() {
    const id = archivePage?.id ?? archivePage?.bookmarkId ?? effectiveBookmark?.id;
    if (id === undefined || isDeleting) return;
    isDeleting = true;
    try {
      dispatch('delete', { archiveId: id });
      if (onDelete) {
        await onDelete(id);
      }
    } catch (e) {
      console.error('Failed to delete archive:', e);
    } finally {
      if (open) {
        isDeleting = false;
      }
    }
  }

  async function handleRefresh() {
    const id = archivePage?.bookmarkId ?? archivePage?.id ?? effectiveBookmark?.id;
    if (id === undefined || isRefreshing) return;
    isRefreshing = true;
    try {
      if (onRefresh) {
        await onRefresh(id);
      }
      dispatch('refresh', { bookmarkId: id });
    } catch (e) {
      console.error('Failed to refresh archive:', e);
    } finally {
      isRefreshing = false;
    }
  }

  function formatBytes(bytes: number, decimals = 2) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }
</script>

<Modal
  open={open && Boolean(archivePage || directHtml || html)}
  size="xl"
  closable={true}
  on:close={closeViewer}
>
  <div slot="header" class="modal-header-left page-info">
    <div class="modal-icon-badge">
      <Icon name="archive" size={16} />
    </div>
    <div class="page-title-group">
      <h3 class="modal-title">{displayTitle}</h3>
      {#if effectiveUrl}
        <a
          href={effectiveUrl}
          target="_blank"
          rel="noreferrer"
          class="source-link"
          on:click={(e) => { e.preventDefault(); openBookmark(effectiveUrl); }}
        >
          {i18n.t('archiveViewerModal.openOriginal')} ↗
        </a>
      {/if}
    </div>
  </div>

  <div slot="header-actions" class="header-actions">
    <button
      id="archive-modal-new-tab-btn"
      type="button"
      class="btn btn-secondary btn-sm"
      on:click={handleOpenNewTab}
      disabled={isDeleting}
      title={i18n.t('archiveViewerModal.openNewTab')}
    >
      <Icon name="external-link" size={14} />
      <span>{i18n.t('archiveViewerModal.openNewTab')}</span>
    </button>
    <button
      type="button"
      class="btn btn-secondary btn-sm"
      on:click={handleDownload}
      disabled={isDeleting}
      title={i18n.t('archiveViewerModal.downloadHtml')}
    >
      <Icon name="download" size={14} />
      <span>{i18n.t('archiveViewerModal.downloadHtml')}</span>
    </button>
  </div>

  <div class="iframe-container glass-panel">
    {#if isLoading}
      <div class="loading-state">
        <Spinner size={24} />
        <span>{i18n.t('archiveViewerModal.uncompressing')}</span>
      </div>
    {:else if directHtml}
      <iframe
        srcdoc={directHtml}
        title="Archive Viewer"
        sandbox="allow-same-origin allow-popups allow-scripts"
      ></iframe>
    {:else if iframeUrl}
      <iframe
        src={iframeUrl}
        title="Archive Viewer"
        sandbox="allow-same-origin allow-popups allow-scripts"
      ></iframe>
    {:else}
      <div class="loading-state">
        <span>{i18n.t('archive.unavailable')}</span>
      </div>
    {/if}
  </div>

  <div slot="footer" class="viewer-actions">
    <div class="meta-info font-mono">
      {#if archivePage?.fileSize}
        <span>{i18n.t('archiveViewerModal.fileSize')}: {formatBytes(archivePage.fileSize)}</span>
      {/if}
      {#if archivePage?.archivedAt}
        <span>{i18n.t('archiveViewerModal.archivedAt')}: {new Date(archivePage.archivedAt).toLocaleString()}</span>
      {/if}
    </div>
    <div class="viewer-buttons">
      {#if (archivePage || effectiveBookmark) && onRefresh}
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          on:click={handleRefresh}
          disabled={isRefreshing || isDeleting}
          title={i18n.t('archiveViewerModal.refreshArchive')}
        >
          {#if isRefreshing}
            <Spinner size={14} variant="inline" /> <span>{i18n.t('common.loading')}</span>
          {:else}
            <Icon name="refresh-cw" size={14} /> <span>{i18n.t('archiveViewerModal.refreshArchive')}</span>
          {/if}
        </button>
      {/if}
      {#if (archivePage || effectiveBookmark) && showDeleteButton}
        <button
          type="button"
          class="btn btn-danger btn-sm"
          on:click={handleDelete}
          disabled={isDeleting || isRefreshing}
          title={isDeleting ? i18n.t('archiveViewerModal.deletingArchive') : i18n.t('archiveViewerModal.deleteArchive')}
        >
          {#if isDeleting}
            <Spinner size={14} variant="inline" />
            <span>{i18n.t('archiveViewerModal.deletingArchive')}</span>
          {:else}
            <Icon name="trash-2" size={14} />
            <span>{i18n.t('archiveViewerModal.deleteArchive')}</span>
          {/if}
        </button>
      {/if}
    </div>
  </div>
</Modal>

<style>
  .modal-header-left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
    flex-grow: 1;
  }

  .modal-icon-badge {
    color: var(--color-primary);
    background: var(--color-primary-light);
    padding: 0.5rem;
    border-radius: var(--radius-md);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .page-title-group {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
    overflow: hidden;
  }

  .modal-title {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 600;
    font-family: var(--font-accent);
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .source-link {
    font-size: 0.75rem;
    color: var(--color-primary);
    text-decoration: none;
    font-family: var(--font-primary);
  }

  .source-link:hover {
    text-decoration: underline;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .iframe-container {
    flex-grow: 1;
    border-radius: var(--radius-md);
    overflow: hidden;
    min-height: 300px;
    height: 100%;
    background-color: var(--color-on-primary);
    position: relative;
    border: 1px solid var(--border-color);
  }

  .iframe-container iframe {
    width: 100%;
    height: 100%;
    border: none;
  }

  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 0.75rem;
    color: var(--text-muted);
  }

  .viewer-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    gap: 1rem;
  }

  .meta-info {
    display: flex;
    flex-direction: column;
    font-size: 0.75rem;
    color: var(--text-muted);
    align-items: flex-start;
  }

  .font-mono {
    font-family: var(--font-mono);
  }

  .viewer-buttons {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
</style>
