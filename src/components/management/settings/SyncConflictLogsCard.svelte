<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Icon from '../../shared/Icon.svelte';

  export let conflictLogs: any[] = [];

  const dispatch = createEventDispatcher<{
    clear: void;
  }>();

  let isExpanded = false;

  function toggleExpand() {
    isExpanded = !isExpanded;
  }

  function handleClear() {
    dispatch('clear');
  }
</script>

<div class="settings-card conflict-logs-card">
  <div class="logs-header">
    <button
      type="button"
      class="header-toggle-btn"
      on:click={toggleExpand}
      aria-expanded={isExpanded}
    >
      <span class="collapse-icon">
        <Icon name={isExpanded ? 'chevron-up' : 'chevron-down'} size={18} />
      </span>
      <div class="logs-header-info">
        <div class="logs-title-group">
          <span class="logs-icon"><Icon name="shield" size={16} /></span>
          <h3 class="logs-title">{i18n.t('conflict.historyTitle')}</h3>
          {#if conflictLogs.length > 0}
            <span class="stamp-badge">{conflictLogs.length}</span>
          {/if}
        </div>
        <p class="logs-description">{i18n.t('conflict.historyDesc')}</p>
      </div>
    </button>
    <button type="button" class="btn btn-secondary btn-xs" on:click={handleClear} disabled={conflictLogs.length === 0}>
      {i18n.t('conflict.clearLogs')}
    </button>
  </div>

  {#if isExpanded}
    <div class="setting-divider"></div>

    {#if conflictLogs.length === 0}
      <p class="empty-text">{i18n.t('conflict.emptyLogs')}</p>
    {:else}
    <div class="table-container">
      <table class="conflict-table">
        <thead>
          <tr>
            <th>{i18n.t('conflict.tableDate')}</th>
            <th>{i18n.t('conflict.tableTitle')}</th>
            <th>{i18n.t('conflict.tableResult')}</th>
            <th>{i18n.t('conflict.tableLocal')}</th>
            <th>{i18n.t('conflict.tableCloud')}</th>
          </tr>
        </thead>
        <tbody>
          {#each conflictLogs as log}
            <tr>
              <td class="date-cell">{new Date(log.timestamp).toLocaleString()}</td>
              <td class="title-cell" title={log.title || log.localVersion?.title || log.cloudVersion?.title}>
                <a href={log.url || log.localVersion?.url || log.cloudVersion?.url} target="_blank" rel="noreferrer">
                  {log.title || log.localVersion?.title || log.cloudVersion?.title || `(${i18n.t('common.empty')})`}
                </a>
                {#if log.bookmarkId || log.localVersion?.syncId || log.cloudVersion?.syncId}
                  <div class="sync-id-subtext font-mono" title={log.localVersion?.syncId || log.cloudVersion?.syncId || log.bookmarkId}>
                    syncId: {log.localVersion?.syncId || log.cloudVersion?.syncId || log.bookmarkId}
                  </div>
                {/if}
              </td>
              <td>
                <span class="badge {log.resolvedTo === 'local' || log.userAction === 'keep-local' ? 'badge-primary' : 'badge-accent'}">
                  {log.userAction === 'keep-local' || log.resolvedTo === 'local' ? i18n.t('conflict.resultLocal') : log.userAction === 'manual-edit' ? i18n.t('conflict.manualEdit') : i18n.t('conflict.resultCloud')}
                </span>
              </td>
              <td class="time-cell">{new Date(log.localTime || log.localVersion?.modifiedAt || log.timestamp).toLocaleTimeString()}</td>
              <td class="time-cell">{new Date(log.cloudTime || log.cloudVersion?.modifiedAt || log.timestamp).toLocaleTimeString()}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
  {/if}
</div>

<style>
  .conflict-logs-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    padding: 1.25rem 1.5rem;
    box-shadow: var(--shadow-sm);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .logs-header {
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

  .logs-header-info {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .logs-title-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .logs-icon {
    color: var(--color-primary);
    display: flex;
    align-items: center;
  }

  .logs-title {
    margin: 0;
    font-family: var(--font-accent);
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .logs-description {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-secondary);
    line-height: 1.4;
  }

  .setting-divider {
    height: 1px;
    background-color: var(--border-color);
    margin: 0.25rem 0;
  }

  .empty-text {
    font-size: 0.8125rem;
    color: var(--text-muted);
    text-align: center;
    padding: 1.5rem 0;
    margin: 0;
  }

  .table-container {
    overflow-x: auto;
    border-radius: var(--radius-md);
    border: 1px solid var(--border-color);
    background: var(--bg-primary);
  }

  .conflict-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
    text-align: left;
  }

  .conflict-table th, .conflict-table td {
    padding: 0.625rem 0.875rem;
    border-bottom: 1px solid var(--border-color);
  }

  .conflict-table th {
    background-color: var(--bg-tertiary);
    font-weight: 600;
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  .conflict-table tr:last-child td {
    border-bottom: none;
  }

  .date-cell {
    white-space: nowrap;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 0.75rem;
  }

  .title-cell {
    max-width: 200px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .title-cell a {
    color: var(--text-primary);
    text-decoration: none;
    font-weight: 500;
  }

  .title-cell a:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .sync-id-subtext {
    font-size: 0.6875rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-top: 0.15rem;
  }

  .time-cell {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 0.75rem;
  }

  .badge {
    font-family: var(--font-mono);
    font-size: var(--badge-font-size, 0.625rem);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border-radius: var(--badge-radius, var(--radius-sm));
    padding: var(--badge-padding, 0.125rem 0.375rem);
    display: inline-block;
  }

  .badge-primary {
    background-color: var(--color-primary);
    color: var(--color-on-primary);
  }

  .badge-accent {
    background-color: var(--color-accent);
    color: var(--color-on-primary);
  }

  .btn-xs {
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
  }
</style>
