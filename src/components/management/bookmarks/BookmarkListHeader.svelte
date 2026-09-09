<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { Bookmark } from '../../../lib/db';
  import { exportAsHtml, exportAsJson, exportAsCsv, downloadFile } from '../../../lib/bookmarks/export-manager';
  import { importFromHtml, importFromJson, importFromCsv } from '../../../lib/bookmarks/import-manager';
  import { showToast } from '../../../lib/ui/toast-store';
  import Icon from '../../shared/Icon.svelte';
  import Dropdown from '../../shared/Dropdown.svelte';
  import SyncWidget from '../SyncWidget.svelte';

  export let bookmarks: Bookmark[] = [];
  export let totalCount: number = 0;
  export let filteredCount: number = 0;
  export let isFiltered: boolean = false;
  export let hasConflict: boolean = false;
  export let conflictCount: number = 0;

  const dispatch = createEventDispatcher<{
    imported: void;
    openConflictModal: void;
  }>();

  let exportDropdownOpen = false;
  let fileInputEl: HTMLInputElement;

  async function handleExportHtml() {
    try {
      const html = await exportAsHtml(bookmarks);
      await downloadFile(html, `powerbookmark_export_${Date.now()}.html`, 'text/html');
      showToast(i18n.t('bookmarkImportExport.exportedHtml'), 'success');
    } catch (err: any) {
      showToast(i18n.t('bookmarkImportExport.exportHtmlFailed', { error: err?.message || err }), 'error');
    }
  }

  async function handleExportJson() {
    try {
      const json = await exportAsJson(bookmarks);
      await downloadFile(json, `powerbookmark_export_${Date.now()}.json`, 'application/json');
      showToast(i18n.t('bookmarkImportExport.exportedJson'), 'success');
    } catch (err: any) {
      showToast(i18n.t('bookmarkImportExport.exportJsonFailed', { error: err?.message || err }), 'error');
    }
  }

  async function handleExportCsv() {
    try {
      const csv = await exportAsCsv(bookmarks);
      await downloadFile(csv, `powerbookmark_export_${Date.now()}.csv`, 'text/csv');
      showToast(i18n.t('bookmarkImportExport.exportedCsv'), 'success');
    } catch (err: any) {
      showToast(i18n.t('bookmarkImportExport.exportCsvFailed', { error: err?.message || err }), 'error');
    }
  }

  function handleTriggerImport() {
    if (fileInputEl) fileInputEl.click();
  }

  async function handleFileSelected(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const ext = file.name.split('.').pop()?.toLowerCase();
      const isCsv = ext === 'csv' || file.type === 'text/csv' || file.type === 'application/vnd.ms-excel';
      const isJson = ext === 'json' || file.type === 'application/json';

      let result;
      if (isCsv) {
        result = await importFromCsv(text);
      } else if (isJson) {
        result = await importFromJson(text);
      } else {
        result = await importFromHtml(text);
      }

      const msg = result.skipped > 0
        ? i18n.t('bookmarkImportExport.importSuccessWithSkipped', { count: result.imported, skipped: result.skipped })
        : i18n.t('bookmarkImportExport.importSuccess', { count: result.imported });
      showToast(msg, 'success');
      dispatch('imported');
    } catch (err: any) {
      showToast(i18n.t('bookmarkImportExport.importFailed', { error: err?.message || err }), 'error');
    } finally {
      if (fileInputEl) fileInputEl.value = '';
    }
  }
</script>

<input
  type="file"
  accept=".html,.htm,.json,.csv,text/csv,application/vnd.ms-excel"
  bind:this={fileInputEl}
  on:change={handleFileSelected}
  style="display: none;"
/>

<div class="bookmark-list-header">
  <div class="header-title-area">
    <h2 class="section-title"><Icon name="bookmark" size={22} /> {i18n.t('bookmarks.title')}</h2>
    <span class="count-badge font-mono">
      {#if isFiltered}
        {filteredCount} / {totalCount}
      {:else}
        {totalCount}
      {/if}
    </span>

    {#if hasConflict}
      <button
        type="button"
        class="sync-conflict-badge"
        on:click={() => dispatch('openConflictModal')}
        title={i18n.t('conflict.title')}
      >
        <Icon name="alert-triangle" size={12} />
        <span>{i18n.t('conflict.title')} ({conflictCount})</span>
      </button>
    {/if}
  </div>

  <div class="header-actions">
    <SyncWidget />

    <button
      type="button"
      class="btn btn-secondary btn-sm"
      on:click={handleTriggerImport}
      title={i18n.t('bookmarkImportExport.importTitle')}
    >
      <Icon name="upload" size={14} />
      <span>{i18n.t('bookmarkImportExport.importTitle')}</span>
    </button>

    <Dropdown bind:open={exportDropdownOpen} align="right">
      <button
        slot="trigger"
        type="button"
        class="btn btn-secondary btn-sm"
        title={i18n.t('bookmarkImportExport.exportTitle')}
      >
        <Icon name="download" size={14} />
        <span>{i18n.t('bookmarkImportExport.exportTitle')}</span>
        <Icon name="chevron-down" size={12} />
      </button>

      <div slot="default" let:close>
        <button
          type="button"
          class="dropdown-item"
          on:click={() => { handleExportHtml(); close(); }}
        >
          <Icon name="file-text" size={14} />
          <span>HTML (.html)</span>
        </button>
        <button
          type="button"
          class="dropdown-item"
          on:click={() => { handleExportJson(); close(); }}
        >
          <Icon name="file-text" size={14} />
          <span>JSON (.json)</span>
        </button>
        <button
          type="button"
          class="dropdown-item"
          on:click={() => { handleExportCsv(); close(); }}
        >
          <Icon name="file-text" size={14} />
          <span>CSV (.csv)</span>
        </button>
      </div>
    </Dropdown>
  </div>
</div>

<style>
  .bookmark-list-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border-color);
  }

  .header-title-area {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .section-title {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    font-family: var(--font-accent);
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--text-primary);
  }

  .count-badge {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-secondary);
    background: var(--bg-tertiary);
    padding: 0.125rem 0.5rem;
    border-radius: 9999px;
  }

  .sync-conflict-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    background: var(--color-primary-light);
    color: var(--color-danger);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-sm);
    padding: 0.125rem 0.375rem;
    font-size: 0.7rem;
    font-weight: 600;
    cursor: pointer;
    animation: pulse 2s infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .btn-sm {
    font-size: 0.8125rem;
    padding: 0.375rem 0.75rem;
  }

  .btn-secondary {
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
  }

  .btn-secondary:hover {
    background: var(--bg-tertiary);
    border-color: var(--border-focus);
  }
</style>
