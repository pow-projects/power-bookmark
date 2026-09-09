<script lang="ts">
  import { onDestroy } from 'svelte';
  import Icon from '../../shared/Icon.svelte';
  import Spinner from '../../shared/Spinner.svelte';
  import ArchiveViewerModal from '../../shared/ArchiveViewerModal.svelte';
  import { showToast } from '../../../lib/ui/toast-store';
  import { formatDate } from '../../../lib/ui/date-formatter';
  import {
    scanOrphanCloudArchives,
    deleteOrphanCloudArchives,
    fetchOrphanArchiveHtml,
    type ArchiveIndexEntry
  } from '../../../lib/archive/archive-cloud';

  export let provider: 'google-drive' | 'onedrive' | 'dropbox' | 'webdav' | 'none' = 'none';
  export let isSyncing: boolean = false;
  export let syncError: string | null = null;

  let isExpanded = false;
  let isScanning = false;
  let isDeleting = false;
  let hasScanned = false;
  let scanErrorMessage: string | null = null;
  let orphans: ArchiveIndexEntry[] = [];
  let selectedSyncIds: Set<string> = new Set();
  let deleteProgress = { current: 0, total: 0 };
  let previewLoadingSyncId: string | null = null;

  // Viewer Modal State
  let viewerOpen = false;
  let viewerHtml: string | null = null;
  let viewerArchivePage: any = null;

  $: isAllSelected = orphans.length > 0 && selectedSyncIds.size === orphans.length;
  $: isPartiallySelected = selectedSyncIds.size > 0 && !isAllSelected;
  $: totalOrphanSize = orphans.reduce((sum, o) => sum + (o.fileSize || 0), 0);
  $: canScan = !isScanning && !isSyncing && !syncError && provider !== 'none';

  function formatBytes(bytes: number, decimals = 1): string {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  }

  function toggleExpand() {
    isExpanded = !isExpanded;
  }

  async function handleScan() {
    if (!canScan) return;
    isScanning = true;
    scanErrorMessage = null;
    try {
      if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
        const res = (await browser.runtime.sendMessage({ type: 'ARCHIVE_ORPHAN_SCAN' })) as any;
        if (res?.ok) {
          orphans = res.orphans || [];
        } else {
          throw new Error(res?.error || 'Scan failed');
        }
      } else {
        orphans = await scanOrphanCloudArchives();
      }
      hasScanned = true;
      isExpanded = true;
      selectedSyncIds = new Set();
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (msg === 'SYNC_IN_PROGRESS') {
        scanErrorMessage = i18n.t('syncSettings.orphanScanBlockedSyncing');
      } else if (msg === 'SYNC_ERROR_STATE') {
        scanErrorMessage = i18n.t('syncSettings.orphanScanBlockedError');
      } else if (msg === 'SYNC_NOT_SYNCED') {
        scanErrorMessage = i18n.t('syncSettings.orphanScanBlockedNotSynced');
      } else {
        scanErrorMessage = msg;
      }
      showToast(scanErrorMessage || msg, 'error');
    } finally {
      isScanning = false;
    }
  }

  function toggleSelectAll() {
    if (isAllSelected) {
      selectedSyncIds = new Set();
    } else {
      selectedSyncIds = new Set(orphans.map((o) => o.syncId));
    }
  }

  function toggleSelectItem(syncId: string) {
    if (selectedSyncIds.has(syncId)) {
      selectedSyncIds.delete(syncId);
    } else {
      selectedSyncIds.add(syncId);
    }
    selectedSyncIds = new Set(selectedSyncIds);
  }

  async function handleViewArchive(orphan: ArchiveIndexEntry) {
    if (previewLoadingSyncId) return;
    previewLoadingSyncId = orphan.syncId;
    try {
      let html = '';
      if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
        const res = (await browser.runtime.sendMessage({
          type: 'ARCHIVE_ORPHAN_FETCH_HTML',
          syncId: orphan.syncId
        })) as any;
        if (res?.ok) {
          html = res.html || '';
        } else {
          throw new Error(res?.error || 'Failed to fetch HTML');
        }
      } else {
        html = await fetchOrphanArchiveHtml(orphan.syncId);
      }

      viewerHtml = html;
      viewerArchivePage = {
        url: orphan.url,
        title: orphan.title,
        fileSize: orphan.fileSize,
        archivedAt: orphan.archivedAt
      };
      viewerOpen = true;
    } catch (e: any) {
      showToast(i18n.t('syncSettings.orphanFetchFailed', { error: e?.message || e }), 'error');
    } finally {
      previewLoadingSyncId = null;
    }
  }

  async function handleDeleteSelected() {
    if (selectedSyncIds.size === 0 || isDeleting) return;
    const count = selectedSyncIds.size;
    if (!confirm(i18n.t('syncSettings.orphanDeleteConfirm', { count }))) return;

    isDeleting = true;
    deleteProgress = { current: 0, total: count };
    const targets = Array.from(selectedSyncIds);

    try {
      let result;
      if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
        const res = (await browser.runtime.sendMessage({
          type: 'ARCHIVE_ORPHAN_DELETE',
          syncIds: targets
        })) as any;
        if (res?.ok) {
          result = res.result;
        } else {
          throw new Error(res?.error || 'Delete failed');
        }
      } else {
        result = await deleteOrphanCloudArchives(targets, (cur, tot) => {
          deleteProgress = { current: cur, total: tot };
        });
      }

      if (result.successCount > 0) {
        orphans = orphans.filter((o) => !targets.includes(o.syncId));
        selectedSyncIds = new Set();
        if (result.failedCount === 0) {
          showToast(i18n.t('syncSettings.orphanDeleteSuccess', { count: result.successCount }), 'success');
        } else {
          showToast(
            i18n.t('syncSettings.orphanDeletePartial', {
              success: result.successCount,
              failed: result.failedCount
            }),
            'warning'
          );
        }
      } else {
        showToast(
          i18n.t('syncSettings.orphanDeleteFailed', {
            error: result.errors?.[0]?.error || 'Unknown error'
          }),
          'error'
        );
      }
    } catch (e: any) {
      showToast(i18n.t('syncSettings.orphanDeleteFailed', { error: e?.message || e }), 'error');
    } finally {
      isDeleting = false;
    }
  }

  onDestroy(() => {
    viewerOpen = false;
    viewerHtml = null;
    viewerArchivePage = null;
  });
</script>

<div class="settings-card orphan-archives-card">
  <!-- Card Header with expand/collapse and scan trigger -->
  <div class="card-header">
    <button
      type="button"
      class="header-toggle-btn"
      on:click={toggleExpand}
      aria-expanded={isExpanded}
    >
      <span class="collapse-icon">
        <Icon name={isExpanded ? 'chevron-up' : 'chevron-down'} size={18} />
      </span>
      <div class="header-info">
        <div class="header-title-row">
          <span class="header-icon">
            <Icon name="archive" size={16} />
          </span>
          <h4 class="header-title">{i18n.t('syncSettings.orphanCardTitle')}</h4>
          {#if hasScanned}
            <span class="stamp-badge {orphans.length > 0 ? 'badge-warning' : 'badge-success'}">
              {orphans.length}
            </span>
          {/if}
        </div>
        <p class="header-description">{i18n.t('syncSettings.orphanCardDesc')}</p>
      </div>
    </button>

    <div class="header-actions">
      <button
        type="button"
        class="btn btn-secondary btn-sm scan-btn"
        on:click={handleScan}
        disabled={!canScan}
      >
        {#if isScanning}
          <Spinner size={14} variant="inline" />
          <span>{i18n.t('syncSettings.orphanScanning')}</span>
        {:else}
          <Icon name="search" size={14} />
          <span>{i18n.t('syncSettings.orphanScanButton')}</span>
        {/if}
      </button>
    </div>
  </div>

  <!-- Collapsible Body -->
  {#if isExpanded}
    <div class="setting-divider"></div>

    <!-- Safety State Warning Banners -->
    {#if isSyncing}
      <div class="alert-banner alert-warning">
        <Icon name="alert-triangle" size={16} />
        <span>{i18n.t('syncSettings.orphanScanBlockedSyncing')}</span>
      </div>
    {:else if syncError}
      <div class="alert-banner alert-danger">
        <Icon name="alert-circle" size={16} />
        <span>{i18n.t('syncSettings.orphanScanBlockedError')}</span>
      </div>
    {:else if scanErrorMessage}
      <div class="alert-banner alert-warning">
        <Icon name="alert-triangle" size={16} />
        <span>{scanErrorMessage}</span>
      </div>
    {/if}

    {#if !hasScanned}
      <div class="empty-state">
        <Icon name="search" size={24} />
        <p>{i18n.t('syncSettings.orphanPromptScan')}</p>
      </div>
    {:else if orphans.length === 0}
      <div class="empty-state clean-state">
        <Icon name="check-circle" size={24} />
        <p>{i18n.t('syncSettings.orphanEmpty')}</p>
      </div>
    {:else}
      <!-- Action Toolbar -->
      <div class="table-toolbar">
        <div class="toolbar-summary">
          <span class="summary-total font-mono">
            {i18n.t('syncSettings.orphanTotalCount', {
              count: orphans.length,
              size: formatBytes(totalOrphanSize)
            })}
          </span>
          {#if selectedSyncIds.size > 0}
            <span class="summary-selected font-mono">
              {i18n.t('syncSettings.orphanSelectedCount', { count: selectedSyncIds.size })}
            </span>
          {/if}
        </div>

        <button
          type="button"
          class="btn btn-danger btn-sm"
          on:click={handleDeleteSelected}
          disabled={selectedSyncIds.size === 0 || isDeleting}
        >
          {#if isDeleting}
            <Spinner size={14} variant="inline" />
            <span>
              {i18n.t('syncSettings.orphanDeleting', {
                current: deleteProgress.current,
                total: deleteProgress.total
              })}
            </span>
          {:else}
            <Icon name="trash-2" size={14} />
            <span>{i18n.t('syncSettings.orphanDeleteSelected')}</span>
          {/if}
        </button>
      </div>

      <!-- Orphan Archives Table -->
      <div class="table-container">
        <table class="orphan-table">
          <thead>
            <tr>
              <th class="checkbox-col">
                <input
                  type="checkbox"
                  checked={isAllSelected}
                  indeterminate={isPartiallySelected}
                  on:change={toggleSelectAll}
                  aria-label={i18n.t('syncSettings.orphanSelectAll')}
                />
              </th>
              <th>{i18n.t('syncSettings.orphanColTitle')}</th>
              <th class="size-col">{i18n.t('syncSettings.orphanColSize')}</th>
              <th class="date-col">{i18n.t('syncSettings.orphanColDate')}</th>
              <th class="action-col">{i18n.t('syncSettings.orphanColActions')}</th>
            </tr>
          </thead>
          <tbody>
            {#each orphans as orphan (orphan.syncId)}
              <tr class:selected-row={selectedSyncIds.has(orphan.syncId)}>
                <td class="checkbox-col">
                  <input
                    type="checkbox"
                    checked={selectedSyncIds.has(orphan.syncId)}
                    on:change={() => toggleSelectItem(orphan.syncId)}
                  />
                </td>
                <td class="title-cell" title={orphan.title || orphan.url}>
                  <div class="title-text">{orphan.title || orphan.url || orphan.syncId}</div>
                  {#if orphan.url}
                    <a
                      href={orphan.url}
                      target="_blank"
                      rel="noreferrer"
                      class="url-subtext font-mono"
                      title={orphan.url}
                    >
                      {orphan.url}
                    </a>
                  {/if}
                </td>
                <td class="size-col font-mono">{formatBytes(orphan.fileSize || 0)}</td>
                <td class="date-col font-mono">{formatDate(orphan.archivedAt)}</td>
                <td class="action-col">
                  <button
                    type="button"
                    class="btn btn-secondary btn-xs"
                    on:click={() => handleViewArchive(orphan)}
                    disabled={previewLoadingSyncId === orphan.syncId}
                    title={i18n.t('syncSettings.orphanViewArchive')}
                  >
                    {#if previewLoadingSyncId === orphan.syncId}
                      <Spinner size={12} variant="inline" />
                    {:else}
                      <Icon name="eye" size={12} />
                    {/if}
                    <span>{i18n.t('syncSettings.orphanViewArchive')}</span>
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>

<!-- Preview Archive Viewer Modal -->
<ArchiveViewerModal
  bind:open={viewerOpen}
  html={viewerHtml}
  archivePage={viewerArchivePage}
  bookmark={null}
  showDeleteButton={false}
  onRefresh={null}
  on:close={() => {
    viewerOpen = false;
    viewerHtml = null;
    viewerArchivePage = null;
  }}
/>

<style>
  .orphan-archives-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    padding: 1.25rem 1.5rem;
    box-shadow: var(--shadow-sm);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
  }

  .header-toggle-btn {
    background: transparent;
    border: none;
    padding: 0;
    margin: 0;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    text-align: left;
    flex: 1;
    color: inherit;
  }

  .header-toggle-btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }

  .collapse-icon {
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.2s ease;
  }

  .header-info {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .header-title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .header-icon {
    color: var(--color-primary);
    display: flex;
    align-items: center;
  }

  .header-title {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .header-description {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-secondary);
    line-height: 1.4;
  }

  .stamp-badge {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    padding: 0.125rem 0.375rem;
    border-radius: 9999px;
    font-weight: 600;
    border: 1px solid currentColor;
  }

  .badge-warning {
    color: var(--color-warning);
    background: var(--color-warning-light);
  }

  .badge-success {
    color: var(--color-success);
    background: var(--color-success-light);
  }

  .header-actions {
    display: flex;
    align-items: center;
  }

  .setting-divider {
    height: 1px;
    background-color: var(--border-color);
    margin: 0.25rem 0;
  }

  .alert-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem 0.875rem;
    border-radius: var(--radius-md);
    font-size: 0.8125rem;
  }

  .alert-warning {
    color: var(--color-warning);
    background: var(--color-warning-light);
    border: 1px solid var(--color-warning);
  }

  .alert-danger {
    color: var(--color-danger);
    background: var(--color-danger-light);
    border: 1px solid var(--color-danger);
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 2rem 1rem;
    color: var(--text-secondary);
    font-size: 0.875rem;
  }

  .clean-state {
    color: var(--color-success);
  }

  .clean-state p {
    color: var(--text-secondary);
  }

  .table-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    padding: 0.25rem 0;
  }

  .toolbar-summary {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.8125rem;
  }

  .summary-total {
    color: var(--text-secondary);
  }

  .summary-selected {
    color: var(--color-primary);
    font-weight: 600;
  }

  .table-container {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    overflow-x: auto;
    max-height: 380px;
    overflow-y: auto;
  }

  .orphan-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
    text-align: left;
  }

  .orphan-table thead {
    background: var(--bg-tertiary);
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .orphan-table th {
    padding: 0.625rem 0.75rem;
    font-weight: 600;
    color: var(--text-secondary);
    border-bottom: 1px solid var(--border-color);
    white-space: nowrap;
  }

  .orphan-table td {
    padding: 0.625rem 0.75rem;
    border-bottom: 1px solid var(--border-color);
    vertical-align: middle;
  }

  .orphan-table tr:last-child td {
    border-bottom: none;
  }

  .orphan-table tbody tr:hover {
    background: var(--bg-secondary);
  }

  .selected-row {
    background: var(--color-primary-light) !important;
  }

  .checkbox-col {
    width: 36px;
    text-align: center;
    padding-left: 0.5rem;
    padding-right: 0.5rem;
  }

  .title-cell {
    max-width: 320px;
  }

  .title-text {
    font-weight: 500;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .url-subtext {
    display: block;
    font-size: 0.6875rem;
    color: var(--text-muted, var(--text-secondary));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-decoration: none;
  }

  .url-subtext:hover {
    text-decoration: underline;
    color: var(--color-primary);
  }

  .size-col {
    width: 90px;
    white-space: nowrap;
    color: var(--text-secondary);
  }

  .date-col {
    width: 100px;
    white-space: nowrap;
    color: var(--text-secondary);
  }

  .action-col {
    width: 80px;
    white-space: nowrap;
    text-align: right;
  }

  .font-mono {
    font-family: var(--font-mono);
  }
</style>
